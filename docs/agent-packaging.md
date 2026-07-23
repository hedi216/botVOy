# Packaging Agent — Phase 5

Ce document couvre le **Lot 1** de la Phase 5 (audit, choix de technologie, resolution des chemins, version centralisee, build compile minimal). Les lots suivants (credential store DPAPI, interface tray, installateur, demarrage automatique, signature, auto-update) sont hors perimetre ici — voir la section 8.

## 1. Audit prealable

### 1.1 Dependances reellement necessaires a l'agent

Grep exhaustif des imports de `src/agent/*.ts` et `src/shared/*.ts` (ce dernier reutilise par l'agent) :

| Package | Utilise par l'agent ? | Ou |
|---|---|---|
| `playwright` | Oui — mais uniquement `chromium.connectOverCDP()`, jamais `chromium.launch()` (voir 1.2) | `src/shared/browser.ts`, `src/agent/agentBrowserManager.ts` |
| `socket.io-client` | Oui, directement | `src/agent/agentClient.ts` |
| `dotenv` | Oui (`dotenv/config`) | `src/agent/agentSettings.ts` |
| `express`, `pg`, `cookie-parser`, `socket.io` | **Non, jamais** | serveur uniquement |

**Defaut trouve et corrige** : `socket.io-client` etait classe en `devDependencies` dans `package.json` alors qu'il est importe directement par le runtime agent en production. Un `npm ci --omit=dev` (utilise par le pattern existant `package-win.ps1` pour le serveur) aurait fait echouer l'agent au demarrage (`MODULE_NOT_FOUND`). Corrige : deplace vers `dependencies`, lockfile regenere.

### 1.2 Chrome/Playwright — confirmation cle pour la taille du package

`agentBrowserManager.ts` lance TOUJOURS un vrai `chrome.exe` systeme via `child_process.spawn()` (jamais via Playwright), puis se connecte dessus par CDP (`chromium.connectOverCDP`, `src/shared/browser.ts`). **Playwright n'a donc jamais besoin de ses navigateurs telecharges** (`playwright install` / cache `ms-playwright`, ~690 Mo mesures sur ce poste) pour le runtime agent — uniquement le module `playwright` lui-meme (client CDP + types), soit quelques Mo. Confirme experimentalement : le build Lot 1 (voir section 5) fonctionne de bout en bout (appairage, START_BOT, VALIDATE_BOT, surveillance, STOP_BOT, vrai Chrome) sans jamais avoir execute `playwright install`, avec `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` force pendant l'installation des dependances.

### 1.3 Chemins relatifs / `process.cwd()` / imports dynamiques

- Grep exhaustif de `process.cwd()`, `__dirname`, `import.meta.url` et des chemins litteraux vers `src/`/`public/` dans `src/agent/*` et `src/shared/*` : une seule occurrence trouvee, **`agentSettings.ts`** (defaut de `AGENT_CREDENTIALS_PATH` non fourni).
- **Defaut trouve et corrige** : ce defaut utilisait `path.join(process.cwd(), ".agent-test-credentials.json")` — en execution packagee, `process.cwd()` peut pointer vers le dossier d'installation (potentiellement non inscriptible, ex. Program Files). Corrige : le defaut derive maintenant de `dataRoot` (`%LOCALAPPDATA%\RendezBot\config\credentials.json`), via une fonction centrale `getDefaultCredentialsPath()` (`src/agent/agentStorage.ts`), coherente avec `getProfilesDir`/`getLogsDir`/`getConfigDir`.
- **Second defaut trouve et corrige (via le test reel packaging)** : `saveStoredCredentials()` ecrivait directement sans jamais garantir l'existence du dossier parent. Cela ne posait jamais probleme avec le defaut (qui appelle `ensureDir`), mais provoquait une erreur `ENOENT` des le premier appairage reussi des qu'`AGENT_CREDENTIALS_PATH` est fourni explicitement vers un dossier pas encore cree — exactement ce qu'un installateur reel fera (voir section 3). Corrige : `ensureDir(path.dirname(...))` avant l'ecriture, dans tous les cas.
- Aucun import dynamique reel trouve (`import("playwright")`/`import("node:child_process")` dans `types.ts` sont des imports TypeScript **de type uniquement**, dans des positions de type, effaces a la compilation — jamais un `import()` d'execution).

### 1.4 Fichiers necessaires vs a exclure

Fermeture de dependance complete de l'agent (verifiee par grep, aucun autre fichier requis) : `src/agent/*.ts`, `src/shared/*.ts`, `src/logger.ts` (seule dependance hors agent/shared, un logger console pur sans etat). **Jamais** : `src/server.ts`, `src/db.ts`, `src/agentGateway.ts`, `src/sessionManager.ts`, `src/userService.ts`, `src/browserProfileService.ts`, `src/auth.ts`, ni aucun fichier `scripts/fixtures/**` (utilise uniquement par les tests, jamais embarque dans un build de distribution).

### 1.5 Taille attendue

Build Lot 1 mesure : **~21 Mo** (compile JS + `node_modules` trimmes : `playwright`, `playwright-core`, `socket.io-client` et leurs dependances transitives — `engine.io-client`, `ws`, `debug`, etc.). Une future embarcation d'un runtime Node (Lot 2/3) ajouterait environ 50-90 Mo (taille typique d'une distribution Node portable) au total livre.

### 1.6 Compatibilite Windows / architecture

- Windows 10/11 x64 : cible principale, aucune API Windows-specifique utilisee au-dela de `%LOCALAPPDATA%` et `taskkill` (deja utilise par le code existant pour la fermeture de Chrome).
- Windows Server : non teste dans ce lot ; le runtime n'a pas de dependance connue qui l'exclurait, mais un Chrome visible sur un serveur sans session interactive n'a pas de sens pour ce produit (rappel : Chrome doit rester visible pour la validation humaine).
- Architecture : x64 uniquement envisagee (coherent avec Chrome 64 bits standard et Node.js LTS x64).

### 1.7 Antivirus / SmartScreen

Aucun executable/installateur n'est encore produit dans ce lot — rien a signaler pour l'instant. Voir [phase4-known-limitations.md](phase4-known-limitations.md) et la section 15 du plan Phase 5 initial pour l'avertissement SmartScreen attendu sans signature de code (Lot 3+).

### 1.8 Droits administrateur

Aucune operation du Lot 1 ne necessite de droits administrateur (compilation, copie de fichiers, `npm install` local). Les lots suivants (installation dans Program Files vs per-user, demarrage automatique) devront trancher explicitement — voir section 8 et `phase5-packaging-plan.md`.

### 1.9 Comportement multi-utilisateur Windows

Non applicable a ce lot (aucune installation reelle). A adresser au Lot 2/3 : `%LOCALAPPDATA%` est deja par construction propre a chaque utilisateur Windows, donc deux utilisateurs sur la meme machine auraient deja des `dataRoot` distincts sans changement supplementaire.

### 1.10 Migration depuis `agent:dev`

`npm run agent:dev` (tsx) et le build compile (`node agent/agentMain.js`) partagent EXACTEMENT le meme code source, la meme resolution de chemins et le meme format de credentials — aucune migration de donnees n'est necessaire entre les deux : un agent deja appaire via `agent:dev` (avec le meme `AGENT_DATA_DIR`) continue de fonctionner tel quel avec le build compile.

## 2. Choix de la technologie de packaging

### 2.1 Comparaison

| Option | Avantages | Inconvenients | Retenue ? |
|---|---|---|---|
| **Node SEA** (Single Executable Applications, natif Node ≥ 20) | Supporte officiellement par l'equipe Node.js, pas de dependance tierce | Necessite un bundle CJS unique en amont (donc un bundler quand meme) ; gestion des assets/`node_modules` moins mature ; comportement encore recent avec des dependances a bindings natifs optionnels (ex. `bufferutil`/`utf-8-validate` de `ws`, avec fallback JS pur — a revalider en Lot 2) | Candidate pour la fusion finale en un seul `.exe` (Lot 2/3), pas necessaire au Lot 1 |
| **pkg / @yao-pkg/pkg** | Historiquement le plus utilise pour ce cas d'usage, snapshot de `node_modules` automatique | Le projet original (`vercel/pkg`) est archive/non maintenu ; le fork communautaire est plus recent et moins eprouve a grande echelle | Rejetee au profit de SEA (support officiel a privilegier pour un produit distribue a des clients) |
| **esbuild + Node embarque** | Controle total, bundling simple et rapide (deja utilise implicitement via `tsc` pour ce lot), pas de dependance a la maintenance d'un outil tiers de "compilation en exe" | Necessite d'embarquer/gerer soi-meme un binaire Node portable | Approche retenue pour le Lot 1 (sans l'embarcation Node, voir 2.2), et probable base du Lot 2/3 |
| **Electron** | Interface riche disponible immediatement | Duplique un Chromium complet (~150-200 Mo) alors que l'agent utilise deja Chrome systeme ; aucun besoin d'interface web-complexe demontre | Rejetee (aucun besoin d'UI complexe demontre, cf. section 5 du cahier des charges initial) |
| **Tauri** | Leger comparé a Electron | Necessite un toolchain Rust supplementaire, disproportionne pour une interface tray minimale a venir | Rejetee (aucune justification suffisante) |

### 2.2 Decision retenue pour le Lot 1

**tsc (compilation TypeScript -> CommonJS) + copie du sous-arbre agent/shared + installation isolee des 3 dependances runtime reelles**, sans encore embarquer de runtime Node ni produire d'executable unique. Raisons :

- Le projet compile deja proprement en CommonJS (`tsconfig.json`: `module: NodeNext`, pas de `"type": "module"` dans `package.json`) : `tsc` seul suffit a produire un runtime executable par `node` nu, sans `tsx`/`ts-node`.
- La fermeture de dependances de l'agent est petite et bien identifiee (section 1.1) : une installation `npm install --omit=dev` isolee dans un dossier dedie est simple, reproductible (versions figees depuis `package-lock.json`) et evite d'investir immediatement dans un bundler/SEA avant d'avoir valide les fondations (chemins, version, secrets).
- Cette approche EST directement l'etape 1 et 2 de l'"option cible probable" du cahier des charges ("compiler/bundler le runtime TypeScript en JavaScript" + copie des dependances) — les etapes 3 et 4 (executable unique, installateur Inno Setup/NSIS) sont les prochains lots, une fois ces fondations validees.

### 2.3 Limites de cette decision (Lot 1)

- Le client final doit encore avoir Node.js installe pour cette etape (`node agent/agentMain.js`) — **ce n'est PAS encore le livrable final** ("fonctionner sans Node.js installe separement" est un objectif de Phase 5 globale, adresse au Lot 2/3 via SEA ou equivalent, pas au Lot 1).
- Aucun executable unique, aucun installateur : uniquement un dossier `app/` autonome et testable.

### 2.4 Outil d'installateur (decision differee au Lot 3, presentee ici pour continuite)

| Option | Avantages | Inconvenients |
|---|---|---|
| **Inno Setup** | Simple, tres documente, supporte nativement une installation per-user sans droits admin (`PrivilegesRequired=lowest`) | Scripting Pascal-like propre a l'outil |
| **NSIS** | Comparable, tres repandu | Scripting plus bas niveau |
| **WiX (MSI)** | Standard entreprise/GPO | Nettement plus complexe (XML), oriente deploiement machine-wide gere — disproportionne pour une premiere version per-user |

Recommandation (a valider explicitement au Lot 3, non appliquee ici) : **Inno Setup**, coherent avec une installation per-user sans droits administrateur (voir `phase5-packaging-plan.md` section 4-5 pour la discussion demarrage automatique/service Windows).

## 3. Architecture des fichiers (etat Lot 1 vs cible finale)

### Etat actuel (Lot 1, produit par `npm run agent:package:win`)

```
release/agent-win/
  version.json            (agentVersion, protocolVersion, gitCommit, buildDate)
  build-manifest.json      (recapitulatif, jamais de secret/chemin utilisateur)
  SHA256SUMS.txt
  app/
    agent/                 (dist/agent/*.js compile)
    shared/                (dist/shared/*.js compile)
    logger.js
    node_modules/           (playwright, socket.io-client, dotenv + transitifs)
    package.json            (minimal, versions figees)
```

Execution : `node agent/agentMain.js` (ou `... pair <CODE>`) depuis `app/`. Verifie fonctionnel copie hors du depot (voir section 6).

### Cible finale (Lot 2/3, non implementee)

```
%ProgramFiles%\RendezBot Agent\   (ou %LocalAppData%\Programs\RendezBot Agent\ si per-user, decision Lot 3)
  RendezBotAgent.exe
  runtime\ ou resources\
  version.json
  uninstall.exe

%LOCALAPPDATA%\RendezBot\
  config\        (dont credentials/ si separe pour DPAPI, Lot 2)
  logs\
  profiles\
  extensions\
  updates\
  state\
```

`getDefaultCredentialsPath()`/`getProfilesDir()`/`getLogsDir()`/`getConfigDir()` (deja centralisees dans `src/agent/agentStorage.ts`) restent la SEULE source de verite pour ces emplacements — aucun autre module ne doit construire un chemin `dataRoot`-relatif directement.

## 4. Version centralisee

`src/agent/agentVersionInfo.json` est la source UNIQUE (`{ agentVersion, protocolVersion }`), importee par `src/agent/agentSettings.ts` (`AGENT_VERSION`, `AGENT_PROTOCOL_VERSION`). `tsc` copie automatiquement ce fichier a cote du `.js` compile (verifie dans `dist/agent/` et dans le build final), donc toujours resolu par un chemin relatif stable, y compris packagee. `AGENT_VERSION` reste surchargeable via la variable d'environnement `AGENT_VERSION` (dev/test uniquement).

**Version actuelle non modifiee dans ce lot** : `0.1.0`. Recommandation a valider explicitement avant application (jamais applique unilateralement ici) : passer a `0.5.0` pour marquer cette etape de packaging pre-installateur, en reservant `1.0.0` a la fin du Lot 3 (installateur + demarrage automatique + DPAPI complets).

**Mise a jour (correctif protocole)** : `protocolVersion: 1` est desormais reellement valide au handshake (`src/agentGateway.ts`, contre `config.minProtocolVersion`, variable serveur `AGENT_MIN_PROTOCOL_VERSION`) — voir section 10.

## 5. Build reproductible

Script : `scripts/agent-package-win.ps1`, commande : `npm run agent:package:win`.

Etapes : nettoyage -> `tsc --noEmit` -> tests de non-regression Phase 4 simules (sautable via `-SkipTests`, jamais pour un build destine a distribution/tests reels) -> `tsc` (compilation) -> copie de la fermeture de dependance agent/shared/logger -> generation d'un `package.json` minimal avec versions figees (depuis `package-lock.json`) -> `npm install --omit=dev` isole (avec `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`) -> verification anti-secret (grep de chaines interdites connues) -> generation de `version.json`/`build-manifest.json`/`SHA256SUMS.txt`.

**Defaut trouve et corrige pendant la validation de ce script** : `Set-Content -Encoding UTF8` (PowerShell 5.1) ecrit toujours un BOM, ce qui cassait un `JSON.parse()` strict sur `version.json`/`build-manifest.json`. Corrige via une fonction `Write-Utf8NoBom` (`[System.IO.File]::WriteAllText` avec un `UTF8Encoding(false)`).

## 6. Tests de packaging

### `npm run test:agent:packaging:simulated` (VM, aucun Chrome de bot)

Verifie : resolution des chemins (jamais `process.cwd()`), source unique de version (avec/sans surcharge), classification des dependances (garde-fou anti-regression), redaction, puis lance reellement le build (`-SkipTests`) et verifie sa structure/manifeste/absence de secret. **25/25** au dernier passage.

### `npm run test:agent:packaging:real` (PC Windows personnel uniquement)

Construit le build, le copie **entierement hors du depot** (dossier temporaire), lance `node agent/agentMain.js` (jamais `tsx`) depuis ce dossier copie, verifie un cycle complet reel (appairage, START_BOT, VALIDATE_BOT, surveillance fixture, STOP_BOT, fermeture Chrome), verifie qu'AUCUNE ecriture n'a eu lieu dans le dossier programme copie pendant tout le cycle (instantane de dates de modification avant/apres), et que toutes les donnees sont isolees dans le dossier de donnees dedie. **9/9** au dernier passage sur ce PC Windows, 0 processus residuel.

## 7. Non-regression Phase 4

`test:phase4:final:simulated` : 283/283 (avant et apres les changements du Lot 1). `test:phase4:final:real` : 102/102 (avant et apres). Aucune regression introduite par les corrections de ce lot.

## 8. Explicitement HORS PERIMETRE du Lot 1

Aucun installateur, aucun executable unique, aucun credential store DPAPI, aucune interface locale, aucun demarrage automatique, aucun verrou mono-instance, aucune signature de code, aucune mise a jour automatique. Le Lot 2 (section 9) a leve les elements credential store/interface locale/mono-instance/launcher candidat ; le reste demeure au Lot 3 — voir [phase5-packaging-plan.md](phase5-packaging-plan.md).

## 9. Lot 2 — credential store DPAPI, appairage local, mono-instance

### 9.1 Perimetre livre

- **`AgentCredentialStore`** (interface, `src/agent/agentCredentialStore.ts`) avec 3 implementations (`DevFileCredentialStore`, `WindowsDpapiCredentialStore`, `TestCredentialStore`), selectionnees explicitement via `AGENT_RUNTIME_MODE` (`development` par defaut, `packaged`, `test`). Detail complet, matrice DPAPI et format de fichier : [agent-credential-store.md](agent-credential-store.md).
- **Migration** du fichier en clair (Lot 1) vers le store protege, idempotente, jamais destructive en cas d'echec.
- **Interface locale HTTP** (loopback, `node:http`, aucune nouvelle dependance) pour l'appairage et le diagnostic sans PowerShell : [agent-local-ui.md](agent-local-ui.md).
- **Verrou mono-instance** (`src/agent/agentSingleInstanceLock.ts`) : fichier de verrou + PID + verification de vivacite (jamais un mutex/named pipe natif — meme raisonnement anti-dependance-native que le choix DPAPI). Un second lancement ouvre l'interface de l'instance existante et se termine avec le code 0.
- **Launcher candidat sans console** (`scripts/agent-launch-no-console.vbs`, copie dans le build a cote de `agent/agentMain.js`) : WScript avec fenetre masquee. **Limite explicite, jamais presentee comme definitive** : solution transitoire (necessite encore Node.js installe separement), remplacee au Lot 3 par un executable Node SEA avec sous-systeme Windows natif. Ne masque jamais une erreur : les logs et l'etat de l'interface locale restent la source de verite.
- **Politique de revocation/token invalide/version incompatible** (`src/agent/agentMain.ts`) : `AGENT_REVOKED`/`INVALID_TOKEN`/`INVALID_AUTH_MODE`/`INVALID_OR_EXPIRED`/`TOO_MANY_ATTEMPTS` effacent l'identite locale (credentials + retour a l'ecran d'appairage) ; `VERSION_INCOMPATIBLE` conserve les credentials et bloque sans detruire l'identite.
- **Dissociation locale** ("Dissocier cet ordinateur") : arrete les bots, ferme Chrome, deconnecte le socket, efface le credential store — conserve logs/profils/extensions par defaut (reserve a la desinstallation, Lot 3).

### 9.2 Defauts reels trouves et corriges pendant ce lot

| # | Defaut | Preuve | Correction |
|---|---|---|---|
| 1 | `saveStoredCredentials()` n'assurait pas l'existence du dossier parent (deja note au Lot 1 pour le cas par defaut, mais le meme risque existe pour tout chemin explicite) | Confirme par le test reel packaging | `ensureDir` avant ecriture (deja corrige au Lot 1, reconfirme) |
| 2 | Le protocole reel collapse **revocation** et **token corrompu/errone** dans la MEME raison `INVALID_TOKEN` (verifie par lecture de `verifyAgentToken()`) ; `AGENT_REVOKED`/`VERSION_INCOMPATIBLE` ne sont **jamais** emis comme raison de `connect_error` par le serveur actuel | Audit du code serveur (`agentService.ts`, `agentGateway.ts`) | Documente honnetement (voir 9.3) ; politique locale traite `INVALID_TOKEN` comme "identite invalide, quelle qu'en soit la cause exacte" |
| 3 | `INVALID_OR_EXPIRED`/`TOO_MANY_ATTEMPTS` (code d'appairage invalide/expire/trop de tentatives) etaient traites comme des erreurs TRANSITOIRES par `agentClient.ts` (retry infini silencieux sur un code deja rejete) | Lecture du code + lien direct avec le nouveau besoin d'appairage interactif (Lot 2, section 6) | Ajoutes a `PERMANENT_FAILURE_REASONS` (specifiques au chemin "pair", jamais emis en mode "reconnect" — sans risque de traiter a tort une coupure reseau comme definitive) |
| 4 | `permanentFailure`/`stopped` (AgentClient) n'etaient jamais reinitialises entre deux appels a `start()` | Consequence directe de l'appairage interactif repete (Réessayer/nouvel appairage apres dissociation), jamais rencontre avant (un seul `start()` par process avant le Lot 2) | `start()` reinitialise les deux drapeaux en debut d'appel |
| 5 | Migration : la suppression de l'ancien fichier en clair s'executait meme quand son chemin coincidait avec celui du nouveau store (cas courant), effacant les identifiants venant d'etre migres | Trouve par le test simule Lot 2 (assertion "identifiants migres corrects" en echec) | Suppression sautee quand `candidatePath === targetStore.describeSecurity().path` |
| 6 | `exists()` du store cible ne suffit pas a determiner "deja migre" (un fichier en clair au meme chemin par defaut rend aussi `exists()` vrai) | Trouve par le test simule Lot 2 | Remplace par un `load()` reussi (non-null) comme critere de "deja protege" |

### 9.3 (Historique) Limite initialement documentee, RESOLUE depuis — voir section 10

A la cloture initiale du Lot 2, le protocole reel n'emettait **jamais** `AGENT_REVOKED` ni `VERSION_INCOMPATIBLE` comme raison de `connect_error` — uniquement `INVALID_TOKEN` (revocation ET token errone confondus), `INVALID_AUTH_MODE`, `INVALID_OR_EXPIRED`, `TOO_MANY_ATTEMPTS`. Corrige par le correctif protocole decrit en section 10 : les trois raisons sont desormais reellement distinctes et testees contre le vrai serveur.

### 9.4 Tests (etat a la cloture initiale du Lot 2, avant correctif — voir section 10 pour l'etat a jour)

- `npm run test:agent:packaging-lot2:simulated` : **45/45**, VM-safe, aucun Chrome de bot (store DPAPI reel exerce si Windows ; selection de store, migration, chemins Unicode/espaces, mono-instance via vrais process distincts, interface locale complete, redaction).
- `npm run test:agent:packaging-lot2:real` : **20/20** sur ce PC Windows (scenarios A-M du cahier des charges ; N/VERSION_INCOMPATIBLE omis a l'epoque, desormais couvert — voir section 10).
- Variante "hors depot" (build compile copie hors du depot, premier appairage local, redemarrage+reconnexion DPAPI, mono-instance, aucune ecriture programme) : **10/10**.
- Non-regression : `test:agent:packaging:simulated` 25/25, `test:agent:packaging:real` 9/9, `test:phase4:final:simulated` 283/283, `test:phase4:final:real` 102/102 (une premiere execution a rencontre un echec isole de demarrage serveur dans la suite resilience-real — reproduit non reproductible : rerun standalone 13/13, puis rerun complet du runner 102/102 — diagnostique comme transitoire/environnemental, meme categorie que le precedent deja documente au Lot 6, pas une regression du Lot 2).

### 9.5 Hors perimetre du Lot 2 (reste au Lot 3)

Installateur Inno Setup, demarrage automatique Windows (tache planifiee/raccourci Demarrage), desinstallation, mise a niveau par installateur, auto-update, signature de code, publication de l'artefact, frontend de telechargement final, executable Node SEA unique (le launcher `.vbs` reste un candidat transitoire).

## 10. Correctif protocole post-Lot 2 : INVALID_TOKEN / AGENT_REVOKED / VERSION_INCOMPATIBLE reellement distincts

### 10.1 Cause exacte de l'ambiguite

`verifyAgentToken()` (devenu `authenticateAgent()`) renvoyait `null` pour TROIS cas distincts : agent inexistant, token errone, agent revoque — tous trois produisaient donc la meme reponse `INVALID_TOKEN`. Un agent reellement revoque n'avait aucun moyen de l'apprendre et rejouait indefiniment le meme cycle de reconnexion/backoff. Par ailleurs `VERSION_INCOMPATIBLE` n'etait jamais emis par le handshake (seulement calcule cote serveur comme statut d'affichage `computeLiveStatus()`), et `protocolVersion` n'etait ni envoye par l'agent ni valide par le serveur.

### 10.2 Protocole corrige

- `src/agentService.ts` : `authenticateAgent(agentId, token)` renvoie desormais `{ ok: true, agent } | { ok: false, reason: "INVALID_TOKEN" } | { ok: false, reason: "AGENT_REVOKED" }`. Le statut `revoked` est verifie **avant** la comparaison du token (etat definitif, jamais dependant de la validite du token presente). Un agent inexistant et un token errone pour un agent existant-non-revoque partagent volontairement la meme reponse `INVALID_TOKEN` (jamais d'enumeration d'agentId possible).
- `src/config.ts` : nouveau `AgentGatewayConfig.minProtocolVersion` (`AGENT_MIN_PROTOCOL_VERSION`, defaut `1`) — plancher de PROTOCOLE cote serveur, distinct de `minAgentVersion` (version applicative), jamais importe depuis `src/agent` (pas de duplication de source, deux plancher independants par conception).
- `src/agentGateway.ts` : le handshake valide `protocolVersion` **avant** toute authentification/redemption de code (pour les deux modes pair/reconnect) — absent, non numerique, ou inferieur au plancher -> `VERSION_INCOMPATIBLE`, rejete avant `redeemPairingCode` (un code d'appairage rejete pour incompatibilite reste utilisable par un agent compatible).
- `src/agent/agentClient.ts` : envoie `protocolVersion: this.settings.protocolVersion` (source unique `agentVersionInfo.json`) dans les DEUX modes, **y compris** la reassignation interne de `lastAuth` apres un premier appairage reussi (voir 10.3, defaut #1).

### 10.3 Defauts reels trouves par les nouveaux tests (avant meme d'etre livres)

| # | Defaut | Preuve | Correction |
|---|---|---|---|
| 1 | `agentClient.ts` reassigne `this.lastAuth` (mode reconnect) apres un appairage reussi SANS `protocolVersion` — un troisieme site de construction du payload d'auth, distinct des deux dans `start()` | Trouve par `test-agent-protocol-auth-real.ts` (scenario G) : un agent fraichement appaire se faisait rejeter `VERSION_INCOMPATIBLE` des sa premiere reconnexion automatique | `protocolVersion` ajoute a cette troisieme reassignation |
| 2 | Un credential local illisible/corrompu (echec de dechiffrement DPAPI) faisait CRASHER tout le process agent (`credentialStore.load()` levait avant meme la tentative reseau, jamais rattrape) | Trouve par le meme test (scenario H) : `[agentMain] Arret: ...`, process termine au lieu de proposer un nouvel appairage | `client.start()` (chemin reconnect sans code CLI) enveloppe desormais d'un `try/catch` : identifiants effaces, etat NOT_PAIRED, interface locale ouverte |

### 10.4 Tests ajoutes

`scripts/test-agent-protocol-auth-real.ts` (`npm run test:agent:protocol-auth:real`), **29/29**, scenarios A-J complets (agent valide, token invalide avec non-enumeration, agent revoque, protocolVersion incompatible en pair ET reconnect avec code d'appairage reutilisable, aucune commande pour un agent revoque/incompatible, suppression DPAPI reelle sur AGENT_REVOKED, suppression sur credential corrompu localement, conservation stricte du fichier de credentials sur VERSION_INCOMPATIBLE avec contenu octet-pour-octet identique, absence de fuite de token/token_hash/Authorization dans les logs). Stable sur 2 executions consecutives.

### 10.5 Regressions

`npx tsc --noEmit` clean. `test-agent-resilience-simulated.ts` : une assertion mise a jour (`INVALID_TOKEN` -> `AGENT_REVOKED` pour son scenario "agent revoque ne peut plus se reconnecter", qui testait deja exactement ce cas). Tous les scripts simules construisant un handshake manuel (11 fichiers) mis a jour avec `protocolVersion`. `test:agent:packaging-lot2:simulated` 45/45, `test:agent:packaging-lot2:real` 20/20 (log desormais correctement `AGENT_REVOKED`), `test:phase4:final:simulated` 283/283, `test:phase4:final:real` **102/102 x2 executions consecutives** (un echec isole standalone de `test-agent-bot-status-simulated.ts` rencontre pendant la validation, memes symptomes que le precedent Lot 6 (process node.exe residuels d'une execution anterieure dans cette meme session tres longue) — reproduit non reproductible apres nettoyage, rerun complet 283/283 confirme).
