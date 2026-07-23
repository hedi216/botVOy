# Architecture Agent (Phase 4)

Ce document decrit l'architecture issue de la migration Phase 4 (execution Chrome/Playwright deplacee de la VM serveur vers un Agent Windows local), et sert de reference pour l'audit final du Lot 6.

## 1. Vue d'ensemble

```
                    PostgreSQL (VM uniquement)
                          |
   Navigateur web  <-->  src/server.ts (Express + Socket.IO, VM)
   (utilisateur)          |         \
                          |          \  namespace io.of("/agent")
                          |           \
                  src/shared/*   src/agentGateway.ts, agentService.ts,
                  (moteur partage)    agentCommandService.ts (VM)
                          |                    |
                          |            Socket.IO (agent <-> serveur)
                          |                    |
                (mode legacy_vm       PC Windows local (Agent)
                 uniquement:                   |
                 Playwright tourne      src/agent/agentMain.ts
                 directement sur         + src/shared/* (reutilise)
                 la VM, jamais un                |
                 vrai Chrome)              VRAI Chrome/Playwright local
```

Deux modes d'execution du bot coexistent, pilotes par `BOT_EXECUTION_MODE` (jamais actifs simultanement pour le meme bot, cf. section 5):

- **legacy_vm** : chemin historique, Playwright tourne directement sur la VM/serveur. Conserve tel quel pour compatibilite descendante pendant la migration.
- **agent** : le serveur n'ouvre plus jamais de Chrome lui-meme ; il envoie des commandes (`START_BOT`, `STOP_BOT`, `VALIDATE_BOT`, ...) a un Agent Windows connecte et pret (`READY_FOR_COMMANDS`), qui execute reellement Chrome/Playwright localement et rapporte son etat.

## 2. Dependances entre couches

| Couche | Peut importer | Ne doit JAMAIS importer |
|---|---|---|
| `src/shared/*` | rien de `src/agent` ni `src/server`/services serveur | `src/agent/*`, `pg`, `src/db.ts`, `src/server.ts`, tout service cote serveur |
| `src/agent/*` | `src/shared/*`, `src/agent/types.ts` | `pg`, `src/db.ts`, `src/server.ts`, `src/sessionManager.ts`, `src/userService.ts`, `src/browserProfileService.ts`, `src/auth.ts` |
| `src/*.ts` (serveur) | `src/shared/*`, `src/agent/types.ts` (types uniquement, jamais le runtime agent) | ouvrir Chrome/Playwright quand `BOT_EXECUTION_MODE=agent` |

**Verifie par grep exhaustif (Lot 6)** : aucun fichier de `src/agent/*.ts` n'importe `pg`, `../db.js`, `../server.js`, ni aucun service serveur (`agentGateway`, `sessionManager`, `userService`, `browserProfileService`, `auth`). Aucun fichier de `src/shared/*.ts` n'importe quoi que ce soit depuis `src/agent` ou `src/server.ts`. Aucune dependance circulaire detectee.

## 3. Modules cles

### Moteur partage (`src/shared/`)
`monitor.ts` (boucle de surveillance), `orchestrator.ts`, `detectors.ts` (detection generique, memes selecteurs/motifs en legacy_vm et en agent), `humanValidation.ts`, `highlight.ts`, `screenshot.ts`, `loginFlow.ts`, `browser.ts`, `types.ts`.

### Runtime Agent (`src/agent/`)
`agentMain.ts` (point d'entree), `agentClient.ts` (connexion Socket.IO, heartbeat, reconnexion progressive avec jitter, buffer hors ligne), `agentBotManager.ts`, `agentBrowserManager.ts` (lancement Chrome reel), `agentMonitoringRuntime.ts`, `agentPageDetector.ts` (VALIDATE_BOT), `agentProfileManager.ts` (profils Chrome persistants + extensions locales), `agentExtensionConfig.ts`, `agentOfflineBuffer.ts` (buffer borne, coalescence, priorites), `agentReconnectBackoff.ts`, `agentSlotDedup.ts`, `agentEventReporter.ts`, `agentLocalLogger.ts` (redaction locale), `agentSettings.ts`, `agentStorage.ts`, `agentErrors.ts`.

### Cote serveur (`src/`)
`agentGateway.ts` (namespace Socket.IO `/agent`, appairage, heartbeat, sweep offline, sweep de commandes), `agentService.ts` (`toPublicAgent`, revocation, renommage), `agentCommandService.ts` (protocole de commandes, ACK/TTL), `config.ts` (chargement/validation de configuration), `envValidation.ts` (Lot 6 : validation stricte des ports/entiers), `db.ts`, `server.ts` (routes REST, Socket.IO web), `auth.ts`, `sessionManager.ts`, `userService.ts`, `browserProfileService.ts`.

## 4. Tableau d'audit final (Lot 6, section 1)

Perimetre : dependances/imports, etat global, timers, listeners, processus enfants, fichiers temporaires, profils de test, migrations DB, coherence legacy_vm/agent, variables d'environnement, controle d'acces routes/evenements, objets publics.

Principe applique : correction uniquement des defauts demontres ou clairement reproductibles (aucune reecriture preventive).

| # | Element audite | Constat | Risque | Correctif necessaire | Fichier(s) concerne(s) | Test couvrant |
|---|---|---|---|---|---|---|
| 1 | Nettoyage Chrome dans le script de test Lot 2 | `cleanupChromeAndDir()` tuait TOUS les `chrome.exe` du poste (aucun filtrage par PID de reference), y compris un Chrome personnel ouvert pendant le test | **Eleve** (destructif, hors perimetre du test) | Capturer les PID `chrome.exe` de reference AVANT le test, ne tuer que les PID absents de cette liste | `scripts/test-agent-phase4-lot2.ts` | Suite A/B de `test-agent-phase4-lot2.ts` (reexecutee, 41/41) |
| 2 | Nettoyage en cas d'echec d'assertion (suites A et B, Lot 2) | Absence de `try/finally` : une assertion en echec sautait le nettoyage (process serveur/agent, Chrome reel, lignes DB, fichiers temporaires laisses) | Moyen (fuite de ressources, pas de risque de securite) | Englober le corps des deux suites dans `try { ... } finally { nettoyage }`, avec variables hissees en `let` pour eviter un piege de zone morte temporelle (TDZ) si l'exception survient avant leur affectation | `scripts/test-agent-phase4-lot2.ts` | idem |
| 3 | Liste noire de cles sensibles cote serveur (`agentGateway.ts`) | `FORBIDDEN_KEY_SUBSTRINGS` omettait `cookie`, `profilePath`, `debugPort`, `Authorization`, `apiKey` : un `result` de commande contenant ces champs survivait en base/REST | **Eleve** (fuite potentielle de secret) | Aligner la liste noire serveur sur celle de l'agent (`agentLocalLogger.ts`), l'elargir en consequence | `src/agentGateway.ts` | `scripts/test-agent-security-simulated.ts` (scenario 1, sweep de sentinelles) |
| 4 | Gestionnaire d'erreur Express generique | Une erreur brute du driver `pg` (ex. `invalid input syntax for type uuid`) remontait telle quelle au client via `error.message`, pour toute route utilisant un identifiant type UUID invalide | Moyen (fuite d'un detail d'implementation, jamais de donnee metier) | Detecter le code SQLSTATE `pg` (5 caracteres) et substituer un message generique uniquement dans ce cas (les erreurs metier `Error` francaises legitimes restent inchangees) | `src/server.ts` | `scripts/test-agent-security-simulated.ts` (scenario 2) |
| 5 | Validation des variables d'environnement numeriques serveur | `PGPORT`, `WEB_PORT`, `MAX_CLIENTS_PER_VM` utilisaient `Number(raw \|\| defaut)` sans garde : une valeur non numerique produisait un `NaN` silencieux, echouant plus tard avec une erreur bas niveau illisible | Faible/Moyen (message d'erreur peu clair au demarrage, jamais un comportement incorrect en production reelle) | Ajouter une validation explicite (`requireValidPort`/`requirePositiveInt`) levant une erreur claire au demarrage | `src/db.ts`, `src/server.ts`, `src/envValidation.ts` (nouveau) | verification manuelle (valeur invalide -> erreur explicite au demarrage) + `npx tsc --noEmit` + `test:phase4:final:simulated` (non-regression) |
| 6 | Delais de reconnexion agent inverses (`AGENT_RECONNECT_MIN/MAX_DELAY_MS`) | Deja valide (leve une erreur si min > max) | - | Aucun (deja correct) | `src/agent/agentSettings.ts` | verification manuelle |
| 7 | Delais de config bot inverses (`MONTH_CLICK_MIN/MAX`, `BOT_CYCLE_COOLDOWN_MIN/MAX`) | Cas min > max deja gere de maniere defensive a l'usage (`randomBetween()` clampe), mais sans avertissement | Faible | Avertissement explicite (`console.warn`) sans bloquer le demarrage | `src/config.ts` | verification manuelle |
| 8 | Cle blanche `toPublicAgent()` (test de non-regression) | `ALLOWED_KEYS` du test n'incluait pas `readyForCommands`/`extensions` (ajoutes en Lot 5), provoquant un faux positif `[FAIL]` | Aucun (defaut du test, pas du produit ; champs deja assainis a la source) | Ajouter les deux cles a la liste blanche du test | `scripts/test-agent-serialization.ts` | lui-meme |
| 9 | Dependances `src/agent` -> serveur/PostgreSQL | Aucune trouvee (grep exhaustif) | - | Aucun | - | verification manuelle (grep), section 2 ci-dessus |
| 10 | Dependances `src/shared` -> agent/serveur | Aucune trouvee (grep exhaustif) | - | Aucun | - | idem |
| 11 | Migrations de schema DB | Pattern `ALTER TABLE agent_commands DROP CONSTRAINT IF EXISTS ...` suivi de `ADD CONSTRAINT` (elargissement d'enum) : idempotent, non destructif | - | Aucun | `src/db.ts` | `db:init` (execution manuelle sans erreur) |
| 12 | Timers globaux non cancellables (`setInterval` dans `agentGateway.ts` : sweep offline, sweep de commandes) | Jamais `clearInterval()` explicitement, mais portee = duree de vie du process serveur (pas de cycle setup/teardown repete dans le meme process) ; le heartbeat cote agent (`agentClient.ts`) est lui bien nettoye via `clearInterval` a la deconnexion | Aucun risque demontre (chaque test de la suite lance un NOUVEAU process serveur, tue integralement entre deux tests) | Aucun correctif necessaire (rien a reproduire) | `src/agentGateway.ts`, `src/agent/agentClient.ts` | ensemble de la suite `test:phase4:final:simulated` (283 executions de process serveur/agent sans fuite observee) |
| 13 | Promesses non attendues | Pattern etabli et respecte partout : `void (async () => {...})().catch(logAsyncError(...))` pour tout travail asynchrone volontairement non bloquant | Aucun | Aucun | `src/agentGateway.ts` et alentours | revue manuelle (grep du pattern) |
| 14 | Listeners Socket.IO | Handlers attaches une fois par connexion (`io.of("/agent").on("connection", ...)`), retires implicitement a la deconnexion du socket ; aucun listener attache en boucle observe | Aucun | Aucun | `src/agentGateway.ts` | idem |
| 15 | Processus enfants Chrome/agent laisses ouverts par les tests | Deja gere par le pattern "diff de PID de reference" dans tous les scripts `*-real.ts` (Lot 3-5) et desormais aussi dans le script Lot 2 (defaut #1 ci-dessus) | - | Aucun (au-dela du defaut #1 deja corrige) | `scripts/test-agent-*-real.ts` | executions reelles (13/13, 18/18 soak) |
| 16 | Fichiers temporaires de test (credentials, dataRoot, extensions) | Nettoyes en `finally` avec suffixe `Date.now()` unique par execution, jamais de chemin absolu partage entre executions | - | Aucun | tous les scripts `test-agent-*-real.ts` | executions reelles |
| 17 | Profils utilisateur reels touches par les tests | Tous les tests utilisent `AGENT_DATA_DIR`/`AGENT_CREDENTIALS_PATH` explicites pointant vers un dossier de test unique, jamais le profil Windows reel (`%LOCALAPPDATA%\RendezBot` par defaut n'est utilise qu'en l'absence de ces overrides) | - | Aucun | `src/agent/agentSettings.ts` | idem |
| 18 | Routes/evenements sans controle d'agence | Verifie via les tests d'isolation cross-agence existants (Phase 2/3) + nouveau scenario de securite (agent d'une autre agence, agent revoque, agent non synchronise) | - | Aucun nouveau defaut trouve | `src/server.ts`, `src/agentGateway.ts` | `test-phase2-backend.ts`, `test-phase3-backend.ts`, `test-agent-security-simulated.ts` |
| 19 | Objets publics exposant des donnees internes (`toPublicAgent`, `publicCommandFor`, extensions) | Deja assainis a la source (whitelisting explicite), confirme par sweep de sentinelles (defaut #3 mis a part) | - | Aucun au-dela du defaut #3 | `src/agentService.ts`, `src/agentCommandService.ts`, `src/agent/agentExtensionConfig.ts` | `test-agent-serialization.ts`, `test-agent-security-simulated.ts` |
| 20 | Coherence legacy_vm / agent (jamais actifs simultanement pour le meme bot) | Deja verifie explicitement : en `agent`, aucun Chrome ne se lance sur la VM ; en `legacy_vm`, aucun garde-fou agent ne bloque `start-bot` et Chrome se lance comme avant | - | Aucun | `src/server.ts` | `test-phase3-backend.ts` (scenarios `TC-legacy`, section 10) |

## 5. legacy_vm vs agent : regle absolue

`BOT_EXECUTION_MODE` (serveur uniquement, jamais lu par l'agent) determine le mode pour l'ensemble du serveur au demarrage. Les deux mode ne sont **jamais** actifs simultanement pour un meme bot : le mode est une propriete du process serveur, pas du bot individuel. Changer de mode necessite un redemarrage du serveur avec la variable modifiee.

- `agent` (production cible) : aucun Chrome ne s'ouvre jamais sur la VM ; le serveur refuse `start-bot` si aucun agent n'est `READY_FOR_COMMANDS` pour l'agence (codes `AGENT_NOT_CONNECTED`, `AGENT_EXECUTION_NOT_READY`, `AGENT_VERSION_INCOMPATIBLE`), et ne bascule jamais silencieusement vers `legacy_vm`.
- `legacy_vm` (chemin historique, conserve pour compatibilite) : comportement inchange, Playwright tourne directement sur la VM, aucune dependance a un agent connecte.

## 6. Limites de perimetre (rappel Lot 6)

Ce lot n'ajoute aucune fonctionnalite metier. Voir [phase4-known-limitations.md](phase4-known-limitations.md) pour la liste complete des limites assumees et [phase5-packaging-plan.md](phase5-packaging-plan.md) pour ce qui reste hors perimetre (installeur, service Windows, DPAPI definitif, etc.).
