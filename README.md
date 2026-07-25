# RDV Agent

Application de surveillance de rendez-vous : un serveur web (VM) partage par toutes les agences, et un moteur de detection de creneaux reutilise soit directement sur la VM (mode historique), soit par un **Agent Windows local** installe sur un PC d'agence (mode cible, Phase 4).

Le bot ne gere jamais le login, les mots de passe, les CAPTCHAs ni les controles anti-bot. Un humain se connecte, valide les controles, puis le bot surveille la disponibilite, clique le creneau probable s'il en trouve un, et s'arrete pour laisser la suite a l'humain. **La validation humaine reste obligatoire a chaque etape sensible** ; RendezBot ne contient et ne doit jamais contenir de mecanisme de contournement des controles du site cible (CAPTCHA, anti-bot, rate-limit).

## Architecture

```
PostgreSQL (VM, serveur uniquement)
        |
src/server.ts (Express + Socket.IO, VM)  <---->  navigateur web (utilisateurs)
        |
        +-- BOT_EXECUTION_MODE=legacy_vm : Playwright tourne directement sur la VM (mode historique)
        |
        +-- BOT_EXECUTION_MODE=agent : commandes envoyees a un Agent Windows local connecte
                     |
              PC Windows d'agence : src/agent/agentMain.ts + VRAI Google Chrome visible
```

- **PostgreSQL** : uniquement necessaire cote serveur (VM). Un Agent Windows n'a besoin d'aucune base de donnees.
- **`legacy_vm`** (historique) : comportement inchange, Playwright/Chrome tourne sur la VM.
- **`agent`** (cible Phase 4) : aucun Chrome ne s'ouvre jamais sur la VM ; **Google Chrome doit etre installe sur chaque PC agent**, ou l'agent s'execute avec une session Windows interactive (Chrome doit rester visible pour permettre la validation humaine).
- Les deux modes ne sont jamais actifs simultanement pour un meme bot — le mode est une propriete du process serveur entier (voir [docs/architecture-agent.md](docs/architecture-agent.md)).

Documentation detaillee : [architecture-agent.md](docs/architecture-agent.md) (architecture complete) · [agent-development.md](docs/agent-development.md) (mise en place dev) · [agent-testing.md](docs/agent-testing.md) (tests) · [agent-security.md](docs/agent-security.md) (securite) · [agent-operations.md](docs/agent-operations.md) (exploitation) · [phase4-known-limitations.md](docs/phase4-known-limitations.md) (limites assumees) · [phase5-packaging-plan.md](docs/phase5-packaging-plan.md) (feuille de route packaging, non implementee).

## Installation (serveur, VM)

```cmd
npm.cmd install
npm.cmd run playwright:install
npm.cmd run db:init
```

PostgreSQL doit etre installe et lance (serveur uniquement) :

```env
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=SMART
PGDATABASE=vrdv
```

`db:init` cree la base, les tables, et l'admin initial (`admin` / `HtlsH2030*`). Voir `scripts/install-postgres-admin.ps1` pour une installation PostgreSQL native Windows guidee.

## Configuration

```cmd
copy .env.example .env
```

`.env.example` est organise en trois sections : **serveur (VM) uniquement**, **agent (PC local) uniquement**, **tests uniquement**. Ne jamais placer de secret reel dans le fichier `.env.example` versionne — seulement dans le `.env` local, jamais committe.

## Commandes essentielles

| Commande | Usage |
|---|---|
| `npm run web:dev` | Lance le serveur web (VM) |
| `npm run agent:dev -- pair <CODE>` | Lance un Agent local et l'appaire au serveur |
| `npm run agent:dev` | Relance un Agent deja appaire (reconnexion) |
| `npm run build` / `npm run web:start` | Build puis lancement production du serveur |
| `npx tsc --noEmit` | Verification de types |
| `npm run test:phase4:final:simulated` | Regression complete simulee (PostgreSQL + serveur, sans Chrome bot) |
| `npm run test:phase4:final:real` | Regression complete reelle (Chrome bot reel, fixture locale) — **PC Windows personnel uniquement, jamais sur la VM** |
| `npm run test:phase4:smoke` | Verification courte post-deploiement |
| `npm run test:agent:soak:real` | Test de stabilite courte (PC Windows personnel uniquement) |

Details complets des suites de test : [agent-testing.md](docs/agent-testing.md).

## Notifications email (Brevo)

L'envoi d'emails utilise l'API HTTP Brevo (`POST https://api.brevo.com/v3/smtp/email`), cote serveur uniquement (`BREVO_API_KEY` ne doit jamais apparaitre cote frontend).

Chaque alerte est envoyee exclusivement a l'adresse email du proprietaire du bot (`users.email`), jamais a une autre adresse d'agence. Si aucun email n'est renseigne, la notification est ignoree (avec avertissement dans les logs serveur) plutot qu'envoyee ailleurs.

Evenements notifies : intervention humaine requise, validation/blocage detecte, creneau potentiel detecte, alerte utilisateur, erreur/page inattendue. Les logs de routine (`AUCUN_CRENEAU_DETECTE`) ne sont pas envoyes par email (activable via `EMAIL_NOTIFY_NO_SLOT=true`).

`BREVO_SANDBOX=true` (defaut) simule l'envoi sans livrer de vrai email. Passer a `false` pour un envoi reel.

## Extensions d'enregistrement d'ecran par agence

Chaque agence peut configurer des liens d'extension depuis l'ecran **Extensions**. Les liens fournis doivent etre `http://`/`https://` uniquement (jamais `file:`/`javascript:`/`data:`). Au lancement d'un bot, RendezBot ouvre ces liens dans le Chrome du bot pour que l'utilisateur installe ou verifie manuellement les extensions, puis valide le bot comme d'habitude. RendezBot ne clique jamais sur "Ajouter a Chrome" et ne contourne aucune confirmation Chrome Web Store.

En mode `agent`, les liens d'installation sont transmis au PC agent uniquement en memoire au demarrage du bot. Les extensions deja installees restent conservees dans les profils Chrome persistants de l'agent. La configuration locale `<AGENT_DATA_DIR>/config/extensions.json` reste reservee aux extensions unpacked chargees par dossier local, pas aux liens Chrome Web Store.

## Workflow de surveillance (moteur partage, identique en legacy_vm et en agent)

1. Chrome/Chromium s'ouvre visible.
2. L'humain se connecte, valide tout CAPTCHA/controle, va jusqu'a la page de rendez-vous.
3. Validation humaine explicite que la page est prete (bouton "Valider" en mode agent ; touche Entree en mode legacy_vm).
4. Le moteur partage (`src/shared/monitor.ts`) surveille le mois courant et les mois suivants activables.
5. Blocage humain detecte -> capture d'ecran, attente d'intervention.
6. Creneau potentiel detecte -> capture d'ecran, surlignage, clic, alerte, puis attente d'intervention humaine pour la suite (jamais de finalisation automatique de reservation, jamais de paiement).
7. Aucun creneau -> rafraichissement periodique puis reprise de la surveillance.
8. Page inattendue/erreur reseau persistante -> alerte utilisateur, arret.

## Limites (rappel)

Pas de contournement CAPTCHA/anti-bot, pas de finalisation de reservation, pas de paiement, pas de donnees personnelles dans `.env`. Liste complete et a jour : [phase4-known-limitations.md](docs/phase4-known-limitations.md).
