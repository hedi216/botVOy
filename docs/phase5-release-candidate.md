# Phase 5, Lot 4 — Candidat de livraison interne

## 0. Statut

**Termine.** Ce document consolide le resultat du Lot 4 : publication versionnee de l'installateur, telechargement depuis l'ecran RendezBot, affichage version/hash/statut de signature, validation reelle du telechargement et de l'installation (y compris sur l'infrastructure de production reelle, `https://app.rendezbot.xyz` - voir section 5.2), documentation utilisateur/operationnelle.

Perimetre explicitement EXCLU de ce lot (voir section 6) : auto-update automatique, installation silencieuse distante, signature reelle, publication publique GitHub Releases, deploiement client final, suppression du mode `legacy_vm`, infrastructure CDN.

## 1. Architecture retenue

- Dossier serveur configurable (`AGENT_RELEASES_DIR`/`AGENT_RELEASE_VERSION`/`AGENT_RELEASE_CHANNEL`), jamais suivi par Git, jamais de selection automatique de version.
- `src/agentReleaseService.ts` : validation stricte (manifeste, hash reel recalcule et compare, taille, signed=false) avant toute annonce de disponibilite - jamais un artefact absent/invalide ne fait planter le serveur ni n'est servi.
- Deux routes HTTP protegees par l'authentification RendezBot existante (`requireAuth`) : `GET /api/agent/releases/latest` (metadonnees publiques assainies) et `GET /api/agent/releases/:version/download` (streaming, jamais un chargement complet en memoire).
- `AGENT_DOWNLOAD_URL` conserve comme override administratif (jamais lu directement par le frontend desormais - uniquement par le service de release), validé HTTPS-obligatoire pour un hote distant.
- Frontend (`/agent/setup`) : version, taille approximative, hash SHA-256 (consultable), mention explicite "non signe", avertissement SmartScreen, etapes numerotees - le bouton utilise toujours l'URL retournee par le backend, jamais une valeur codee en dur.

Voir [agent-download-release.md](agent-download-release.md) pour le detail complet et la procedure operationnelle.

## 2. Release activee pour ce candidat

Copie reellement effectuee vers `C:\RendezBotReleases\agent\0.1.0\` sur ce poste (stand-in local pour la VM serveur - voir section 5 pour la limite associee) :

- `RendezBotAgentSetup-0.1.0.exe`
- `SHA256SUMS.txt`
- `build-manifest.json`

Verifie avant activation : hash `48a72d142a0652cbdbce8b6c148c29cb76b46f7bd6c7b507149d8db8928a1695` (identique au dernier hash connu du Lot 3), taille 27065390 octets, `agentVersion=0.1.0`, `protocolVersion=1`, `signed=false`, nom de fichier exact.

## 3. Resultats des tests

| Suite | Resultat |
|---|---|
| `npx tsc --noEmit` | clean |
| `test:agent:release:simulated` | 50/50 |
| `test:agent:release:integration` | 14/14 |
| `test:agent:packaging-lot3:simulated` | 55/55 |
| `test:agent:packaging-lot3:real` | 31/31 |
| `test:agent:packaging-lot2:simulated` | 45/45 |
| `test:agent:protocol-auth:real` | 43/43 |
| `test:phase4:final:simulated` | 283/283 |
| `test:phase4:final:real` | 102/102 |

## 4. Regressions (section 20 du cahier des charges)

Toutes les suites listees en section 3 sont vertes apres deux corrections reelles, trouvees par ces memes regressions (jamais supposees a priori) :

1. **Frontend** : le bouton de telechargement ne s'activait plus quand seul `AGENT_DOWNLOAD_URL` etait configure (sans `AGENT_RELEASES_DIR`/`AGENT_RELEASE_VERSION`) - `getAgentReleaseMetadata()` corrige pour honorer un override administratif pur (section 8), sans jamais inventer de fausses metadonnees de fichier (sha256/taille restent `null` dans ce cas precis).
2. **Regression reelle (non transitoire, reproduite deux fois)** : `scripts/test-agent-phase4-lot2.ts` utilisait un placeholder `AGENT_DOWNLOAD_URL=http://example.test` (HTTP, hote distant) pour son serveur de test - desormais rejete des le demarrage par la validation stricte HTTPS-obligatoire (section 8/config.ts). Corrige en changeant le placeholder vers `https://example.test` (aucune assertion de ce test ne dependait de la valeur exacte).

Un echec isole non reproductible (`TransportError`/`ECONNRESET` sur une connexion socket.io) a egalement ete rencontre une fois pendant cette campagne - reproduit non-reproductible au re-run standalone (meme categorie que les incidents similaires deja documentes aux Lots precedents), pas une regression de ce lot.

## 5. Validation reelle

### 5.1 Validation locale (ce poste, pendant le developpement du lot)

**Effectue reellement, sur le poste de developpement** (stand-in local, avant la validation sur l'infrastructure reelle en 5.2) :
- Connexion au serveur local reellement active avec la release configuree.
- Lecture de `/api/agent/releases/latest` (authentifie) - metadonnees correctes.
- Telechargement complet via HTTP du VRAI installateur du Lot 3 (`Content-Disposition`/`Content-Length`/`nosniff`/`Cache-Control` verifies).
- Hash SHA-256 du fichier telecharge identique octet pour octet au hash du Lot 3.
- Installation reelle de ce fichier telecharge (per-user, sans droits admin) dans un dossier isole.
- Appairage reel via l'interface locale, DPAPI, etat CONNECTED, `readyForCommands`.
- Verrou mono-instance reel.
- Cycle START_BOT / VALIDATE_BOT / surveillance / STOP_BOT reel sur la fixture locale (jamais TLScontact).
- Revocation de l'agent de test et nettoyage complet (aucune donnee de test conservee, aucun process residuel).

### 5.2 Validation reelle sur l'infrastructure de production (`https://app.rendezbot.xyz`)

**Confirmee** sur une VM Windows de test, via le vrai domaine de production (et non plus un equivalent local) :

- Page `/agent/setup` accessible via le domaine reel `https://app.rendezbot.xyz`.
- Release `0.1.0` (channel `candidate`) affichee correctement.
- Hash affiche a l'ecran : `48a72d142a0652cbdbce8b6c148c29cb76b46f7bd6c7b507149d8db8928a1695`.
- Telechargement reel effectue via le bouton de l'interface.
- Hash du fichier telecharge identique au hash affiche (verification manuelle post-telechargement).
- Installation reelle sans droits administrateur.
- Agent lance avec le serveur `app.rendezbot.xyz` (confirmation qu'aucun fallback vers un serveur local/de developpement ne s'est jamais produit - voir le correctif du Lot 3 sur la resolution du serveur par defaut).
- Appairage reel reussi depuis cette installation.
- Statut "Connecte" et `READY_FOR_COMMANDS` confirmes cote serveur.
- Reconnexion automatique apres redemarrage de l'agent, via les identifiants proteges DPAPI (aucun nouveau code d'appairage necessaire).
- Verrou mono-instance valide sur ce poste.
- Revocation depuis le serveur validee : l'agent detecte la revocation et repasse a l'etat "Non appaire".

Cette validation couvre desormais reellement les sections 14-16 du cahier des charges (telechargement/installation/appairage via le vrai domaine) sur un second environnement Windows distinct du poste de developpement. Reste hors de portee de cette validation : la copie de l'artefact directement sur la VM serveur de production suivant la procedure documentee en detail (section 3 de [agent-download-release.md](agent-download-release.md)) n'a pas ete decrite pas-a-pas ici - seul le resultat cote client (telechargement/installation/appairage reels via le domaine reel) est consigne dans cette section.

## 6. Ce que ce lot n'inclut PAS

Auto-update automatique, installation silencieuse distante, signature de code reelle (voir [agent-signing.md](agent-signing.md)), publication publique (GitHub Releases ou equivalent), deploiement chez un client final, suppression du mode `legacy_vm`, infrastructure CDN complexe. Le champ `channel` reste une enum simple (`candidate`/`stable`/`deprecated`/`blocked`) - aucun systeme de canaux plus complexe n'a ete construit.

## 7. Documentation livree

- [agent-user-installation.md](agent-user-installation.md) - guide utilisateur final.
- [agent-pairing-guide.md](agent-pairing-guide.md) - guide d'appairage.
- [agent-download-release.md](agent-download-release.md) - architecture et procedure operationnelle de publication.
- [agent-support-checklist.md](agent-support-checklist.md) - checklist de support.
- Ce document.

## 8. Prochaines etapes possibles (hors perimetre de ce lot, a valider explicitement avant tout debut)

Signature de code reelle une fois un certificat obtenu ; publication publique de l'artefact ; auto-update avec confirmation explicite obligatoire ; premier deploiement chez un client reel, uniquement apres les points precedents. La validation sur la vraie infrastructure de production (telechargement/installation/appairage via `https://app.rendezbot.xyz`) est desormais confirmee - voir section 5.2.
