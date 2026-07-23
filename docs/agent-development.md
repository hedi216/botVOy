# Developpement Agent (Phase 4 + Phase 5)

## 1. Prerequis

- Node.js + npm (voir `package.json` pour les versions de `typescript`/`tsx`).
- Google Chrome installe localement (le runtime agent reel necessite un vrai Chrome, jamais Chromium teleharge par Playwright pour l'execution de bots — seuls les tests utilisent `chromium.launch()` de Playwright pour piloter leur propre navigateur de test).
- PostgreSQL, uniquement necessaire pour lancer le serveur (`src/server.ts`) — l'agent seul (`src/agent/agentMain.ts`) n'a besoin d'aucune base de donnees.
- Windows pour tout developpement/execution reelle de l'agent (`AGENT_DATA_DIR` par defaut cible `%LOCALAPPDATA%\RendezBot`) ; le serveur et les tests simules restent multi-plateformes.

## 2. Lancer le serveur et l'agent en developpement

```cmd
npm run db:init
npm run web:dev
```

Dans un second terminal, apres avoir recupere un code d'appairage depuis l'interface (page Agents) :

```cmd
npm run agent:dev -- pair <CODE>
```

Relance suivante (reconnexion avec les identifiants deja stockes) :

```cmd
npm run agent:dev
```

Variables agent utiles en developpement (voir `.env.example`, section "AGENT (PC LOCAL) UNIQUEMENT") :
- `AGENT_SERVER_URL` : URL du serveur (defaut `http://localhost:<WEB_PORT>`).
- `AGENT_CREDENTIALS_PATH` / `AGENT_DATA_DIR` : isoler un agent de developpement du profil Windows reel.
- `AGENT_TARGET_MODE=fixture` + `AGENT_FIXTURE_URL=<file://...>` : faire pointer l'agent vers la fixture locale plutot que la production, sans toucher au code.
- `AGENT_RUNTIME_MODE` (Phase 5, Lot 2) : `development` (defaut, store credentials en clair, comportement historique) / `packaged` (DPAPI obligatoire, Windows uniquement) / `test` (store en memoire). Ne jamais forcer `packaged` en developpement courant sauf pour tester specifiquement le credential store DPAPI.

Sans identifiants stockes et sans code passe en argument CLI, l'agent demarre desormais une **interface locale** (`http://127.0.0.1:<port>/`, port affiche dans les logs) pour saisir un code d'appairage — voir [agent-local-ui.md](agent-local-ui.md). Un seul agent peut tourner a la fois par dossier de donnees (`AGENT_DATA_DIR`) : un second lancement avec le meme `AGENT_DATA_DIR` ouvre l'interface de l'instance existante et se termine (voir verrou mono-instance, [agent-packaging.md](agent-packaging.md) section 9).

## 3. Ou modifier quoi

| Besoin | Fichier(s) |
|---|---|
| Nouvelle detection de contenu de page (creneau, blocage...) | `src/shared/detectors.ts` — **jamais** une logique dupliquee cote agent ou cote fixture |
| Nouvelle etape de la boucle de surveillance | `src/shared/monitor.ts`, `src/shared/orchestrator.ts` |
| Nouveau comportement de connexion/reconnexion agent<->serveur | `src/agent/agentClient.ts`, `src/agent/agentReconnectBackoff.ts` |
| Nouveau type de commande serveur->agent | `src/agentCommandService.ts` (serveur) + `src/agent/agentBotManager.ts` (agent) — garder le protocole symetrique |
| Nouveau champ expose au frontend pour un agent/bot | Passer par `toPublicAgent()`/`publicCommandFor()` (jamais un objet DB brut), puis mettre a jour la liste blanche de `scripts/test-agent-serialization.ts` |
| Nouveau scenario de test | Voir [agent-testing.md](agent-testing.md) section 2 |
| Stockage de credentials (Phase 5) | `src/agent/agentCredentialStore.ts`/`agentDpapiCredentialStore.ts` — jamais lire/ecrire `settings.credentialsPath` directement ailleurs, toujours via `AgentCredentialStore` |
| Interface locale (Phase 5) | `src/agent/agentLocalUi.ts` (routes) + `agentLocalUiPage.ts` (page embarquee) — jamais une nouvelle dependance HTTP, `node:http` suffit |

## 4. Regles de conception a respecter

- **Aucune fonctionnalite metier nouvelle sans revue explicite** : Phase 4/Lot 6 ferme la migration technique, elle n'etend pas le perimetre metier (pas de login TLScontact automatise, pas de CAPTCHA, pas de contournement anti-bot/rate-limit).
- **`src/shared/*` reste totalement independant** de `src/agent` et de `src/server.ts` — verifie par grep dans l'audit (voir [architecture-agent.md](architecture-agent.md) section 2). Toute nouvelle dependance dans un sens interdit doit etre consideree comme un defaut bloquant.
- **Jamais de nouvel objet DB brut expose** au frontend ou via Socket.IO : toujours passer par une fonction `toPublicXxx()` explicite avec liste blanche de cles.
- **Toute nouvelle variable d'environnement numerique** doit etre validee au demarrage (voir `src/envValidation.ts`, `src/config.ts`, `src/agent/agentSettings.ts`) — jamais un `Number(x)` nu sans garde contre `NaN`.
- **Tout timer/`setInterval` nouveau** doit soit etre nettoye explicitement (`clearInterval`) a la fin de son cycle de vie logique (ex. deconnexion), soit rester documente comme lie a la duree de vie complete du process (comme les sweeps de `agentGateway.ts`, jamais recree plusieurs fois dans le meme process).
- **Toute promesse volontairement non attendue** doit suivre le pattern existant `void (async () => {...})().catch(logAsyncError("label"))`, jamais un simple appel async sans gestion d'erreur.

## 5. Avant de committer

```cmd
npx tsc --noEmit
npm run test:phase4:final:simulated
npm run test:agent:packaging:simulated
npm run test:agent:packaging-lot2:simulated
```

Pour toute modification touchant reellement Chrome/l'agent (profils, extensions, reconnexion, surveillance), executer aussi la suite reelle correspondante sur un PC Windows personnel (voir [agent-testing.md](agent-testing.md)), jamais sur la VM.
