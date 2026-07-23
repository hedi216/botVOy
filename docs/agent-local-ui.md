# Interface locale Agent — Phase 5 (Lot 2)

## 1. Objectif

Permettre le premier appairage et le diagnostic de l'agent **sans PowerShell ni ligne de commande**. Implémentée en HTTP natif Node (`node:http`, aucune dépendance supplémentaire — l'agent conserve exactement les 3 dépendances runtime auditées au Lot 1 : `playwright`, `socket.io-client`, `dotenv`).

## 2. Sécurité

- **Bind strict sur `127.0.0.1`**, jamais `0.0.0.0` — inaccessible depuis une autre machine du réseau.
- **Port dynamique** (`0` = attribution OS), affiché dans les logs locaux au démarrage.
- **Nonce de session** aléatoire (24 octets), obtenu uniquement via `GET /local/status`, requis sur toute action `POST /local/*`. Mitigation d'un CSRF local (une page web malveillante ouverte dans le navigateur de l'utilisateur ne peut pas connaître ce nonce à l'avance).
- **Vérification d'origine** : une requête portant un en-tête `Origin` différent de `http://127.0.0.1:<port>` est refusée (403).
- **Content-Type strict** : seul `application/json` est accepté sur les routes `POST` ; tout autre type -> 400.
- **Limite de taille de corps** : 16 Ko, dépassement -> 413 (réponse envoyée *avant* la fermeture de la connexion, pour rester un code HTTP propre plutôt qu'une simple coupure).
- **Aucune route ne lit un chemin fourni par la requête** : `open-logs`/`open-config` ouvrent toujours un dossier **fixe**, déjà connu de l'agent (`AgentPaths`), jamais une valeur de query/body.
- **Aucune stack trace, aucun token, aucun blob DPAPI, aucun `profilePath`/`debugPort`** dans une réponse publique.

## 3. Routes

| Route | Méthode | Effet |
|---|---|---|
| `/` | GET | Page HTML/CSS/JS embarquée (une seule chaîne, aucune ressource externe) |
| `/local/status` | GET | État courant + nonce de session |
| `/local/pair` | POST | Tente un appairage avec le code fourni (jamais journalisé, jamais renvoyé, jamais conservé après la tentative) |
| `/local/retry` | POST | Relance une tentative de connexion |
| `/local/unpair` | POST | "Dissocier cet ordinateur" (section 12) |
| `/local/quit` | POST | Arrête l'agent proprement |
| `/local/open-logs` | POST | Ouvre le dossier de logs dans l'Explorateur |
| `/local/open-config` | POST | Ouvre le dossier de configuration dans l'Explorateur |

Limite anti-brute-force locale sur `/local/pair` (10 tentatives par session de process) — le serveur distant conserve son propre anti-brute-force sur le code d'appairage lui-même (Phase 4).

## 4. États affichés

`NOT_PAIRED`, `CONNECTING`, `CONNECTED`, `SYNCING`, `OFFLINE`, `REVOKED`, `VERSION_INCOMPATIBLE` — jamais un détail de protocole brut, toujours une phrase française actionnable en cas d'erreur (`message`).

Champs affichés : nom de l'ordinateur, version agent, version de protocole, serveur (host:port assaini, jamais l'URL complète), nombre de bots actifs, statut des extensions locales (id/valide/version — jamais `localPath`).

## 5. Cycle de vie

- Démarrée **avant** toute tentative de connexion, dès le lancement de l'agent — reste active pendant toute la durée de vie du process (diagnostic permanent, pas seulement pour le premier appairage).
- Au premier lancement sans identifiants, l'agent **ouvre automatiquement** un navigateur sur `http://127.0.0.1:<port>/` (une seule fois, jamais à chaque redémarrage d'un agent déjà appairé).
- Un second lancement (verrou mono-instance déjà pris) ouvre l'interface de l'instance **existante** plutôt que d'afficher une erreur technique.

## 6. Limites (Lot 3)

Pas encore d'authentification supplémentaire au-delà du nonce de session (suffisant en l'état car strictement loopback + origine vérifiée). Pas de HTTPS local (non nécessaire pour du loopback pur). Pas de réduction automatique de la fenêtre du navigateur après appairage (contrat non tranché).
