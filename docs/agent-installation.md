# Installation de RendezBot Agent (Phase 5, Lot 3)

Ce document decrit l'installation de `RendezBotAgentSetup-<version>.exe` sur un poste Windows. Pour la construction de cet installateur, voir [agent-packaging.md](agent-packaging.md). Pour la desinstallation, voir [agent-uninstallation.md](agent-uninstallation.md). Pour la mise a niveau, voir [agent-upgrade.md](agent-upgrade.md).

**Important — perimetre de ce lot** : cet installateur n'est **pas signe** (voir [agent-signing.md](agent-signing.md)) et **n'a pas encore ete deploye chez un client reel**. Il est destine aux tests internes sur un poste Windows personnel ou une VM controlee.

## 1. Prerequis

- Windows 10/11, architecture x64.
- Google Chrome installe (l'agent pilote le Chrome deja present sur le poste — il n'en installe pas).
- **Aucune installation prealable de Node.js, npm, tsx ou TypeScript n'est necessaire.** `RendezBotAgent.exe` est une copie autonome du runtime Node embarquant le code de l'agent — voir [agent-packaging.md](agent-packaging.md) section 11 pour le detail technique de cette decision.
- Aucun droit administrateur requis.

## 2. Execution de l'installateur

Double-cliquer sur `RendezBotAgentSetup-<version>.exe`. L'installateur s'execute **entierement dans le contexte de l'utilisateur courant** (`PrivilegesRequired=lowest`) — aucune invite de controle de compte utilisateur (UAC) ne doit apparaitre.

Ecrans presentes :
1. Langue (francais).
2. Dossier d'installation — par defaut `%LOCALAPPDATA%\Programs\RendezBot Agent`. Ne jamais choisir un dossier necessitant une elevation (ex. `Program Files`) : l'installateur ne demande jamais les droits admin, un tel choix provoquerait un echec d'ecriture.
3. Taches optionnelles :
   - **Creer un raccourci sur le Bureau** — decoche par defaut.
   - **Demarrer RendezBot Agent automatiquement a l'ouverture de session** — coche par defaut a la premiere installation (raccourci dans le dossier "Demarrage" de l'utilisateur courant, jamais une cle de registre `Run` ni une tache planifiee — voir 11.2 de agent-packaging.md pour la justification de ce choix).
4. Installation (quelques secondes — les fichiers sont deja compresses dans l'installateur, aucun telechargement reseau).
5. Fin — case "Lancer RendezBot Agent maintenant" cochee par defaut.

## 3. Installation silencieuse (tests automatises)

```
RendezBotAgentSetup-<version>.exe /VERYSILENT /SUPPRESSMSGBOXES /DIR="<dossier>" /MERGETASKS="!desktopicon,!autostart" /LOG="<fichier log>"
```

- `/MERGETASKS="!desktopicon,!autostart"` desactive explicitement les deux taches optionnelles. **Ne jamais s'appuyer sur `/TASKS=""` seul** : la tache `autostart` porte le flag Inno Setup `checkedonce` (coche par defaut a la premiere installation) et reste active si elle n'est pas explicitement exclue avec le prefixe `!`.
- Le flag `skipifsilent` sur l'action "lancer maintenant" n'empeche pas systematiquement ce lancement en mode tres silencieux dans nos observations — un test automatise doit toujours prevoir de retrouver et arreter le process `RendezBotAgent.exe` qui en resulterait, plutot que de supposer son absence.
- Voir `scripts/test-agent-packaging-lot3-real.ts` pour un exemple complet et fonctionnel (installation, verification de fichiers, nettoyage).

## 4. Premier lancement

1. L'agent acquiert le verrou mono-instance (`%LOCALAPPDATA%\RendezBot\state\agent.lock`) et initialise les dossiers necessaires (`credentials/`, `config/`, `logs/`, `profiles/`, `extensions/`, `state/`).
2. **Aucun jeton d'agent n'est demande a l'installation.** En l'absence d'identifiants locaux, l'agent ouvre une interface locale HTTP (loopback, `127.0.0.1`) et son navigateur par defaut sur l'ecran d'appairage.
3. Saisir le code d'appairage (genere cote serveur par un gestionnaire d'agence) dans cette interface locale — jamais via PowerShell ni ligne de commande.
4. Une fois appaire, les identifiants sont stockes proteges par DPAPI (`CurrentUser`) — voir [agent-credential-store.md](agent-credential-store.md). Les lancements suivants se reconnectent automatiquement, sans nouveau code.

## 5. Verification post-installation

Fichiers attendus dans `%LOCALAPPDATA%\Programs\RendezBot Agent\` : `RendezBotAgent.exe`, `agent\`, `shared\`, `node_modules\`, `package.json`, `version.json`, `agent-launch-no-console.vbs`, `unins000.exe`. Aucun `src\`, `.env`, fichier de test ou credential ne doit s'y trouver (verifie automatiquement par `npm run test:agent:packaging-lot3:simulated`).

En cas de doute sur la version installee : comparer `%LOCALAPPDATA%\Programs\RendezBot Agent\version.json`, l'entree "Applications installees" de Windows, et l'etat affiche par l'interface locale de l'agent — les quatre doivent toujours correspondre (source unique : `src/agent/agentVersionInfo.json`, voir agent-packaging.md section 12/13).

## 6. En cas de probleme

- Aucune fenetre de console ne doit rester ouverte en permanence (l'agent est lance via `agent-launch-no-console.vbs`, un lanceur transitoire documente comme tel — voir agent-packaging.md 11.2).
- Un crash est toujours journalise dans `%LOCALAPPDATA%\RendezBot\logs\`. L'interface locale de l'agent expose ces logs (bouton "Ouvrir les logs").
- Un avertissement Windows SmartScreen est attendu (installateur non signe) — voir [agent-signing.md](agent-signing.md). Ne jamais desactiver la protection Windows pour le contourner ; ne jamais demander a un client de le faire.
