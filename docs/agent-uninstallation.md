# Desinstallation de RendezBot Agent (Phase 5, Lot 3)

Deux niveaux de desinstallation existent, et il est important de les distinguer clairement avant d'agir — l'un est reversible dans ses consequences (les donnees restent recuperables), l'autre ne l'est pas.

## 1. Desinstallation standard (par defaut)

Via "Applications installees" de Windows, ou `unins000.exe` dans le dossier d'installation.

**Ce qui est supprime** : `RendezBotAgent.exe`, `node_modules\`, `agent\`, `shared\`, les raccourcis (Menu Demarrer, Bureau si cree, Demarrage si active), l'entree de registre d'installation.

**Ce qui est TOUJOURS conserve par defaut** : `%LOCALAPPDATA%\RendezBot\` en integralite — `credentials\` (identifiants DPAPI), `config\`, `logs\`, `profiles\` (profils Chrome, historique de connexion aux sites de rendez-vous), `extensions\`, `state\`. Ce choix est deliberement conservateur : ces donnees peuvent etre utiles pour un support ulterieur ou une reinstallation sans nouvel appairage (voir [agent-upgrade.md](agent-upgrade.md)).

Sequence executee avant la suppression des fichiers programme :
1. L'agent en cours d'execution est arrete gracieusement (`agent\agentStopHelper.js`, via l'interface locale — jamais un `taskkill` par nom d'image).
2. Attente bornee (5 secondes) de la disparition du verrou mono-instance.
3. Repli : si le verrou persiste, arret cible du PID precis lu dans le verrou (`taskkill /PID <pid> /T /F`) — **jamais** `taskkill /IM chrome.exe` ni `/IM node.exe` : seul le process de l'agent concerne est vise, jamais tous les Chrome de la machine.

## 2. Suppression complete (optionnelle, jamais par defaut)

Supprime en plus l'integralite de `%LOCALAPPDATA%\RendezBot\` — **destructif et irreversible** (identifiants, historique de connexion, profils Chrome perdus definitivement ; un futur appairage repartira de zero).

- **En desinstallation interactive** : une boite de dialogue de confirmation apparait, avec le bouton "Non" (conserver les donnees) preselectionne par defaut. Aucune suppression n'a lieu sans un clic explicite sur "Oui".
- **En desinstallation silencieuse** (`/VERYSILENT`) : **aucune boite de dialogue n'est jamais affichee** (une tentative aurait bloque indefiniment un script automatise — defaut reel rencontre et corrige pendant ce lot, voir agent-packaging.md section 11.3). Le comportement par defaut en silencieux est de **conserver les donnees**. Pour supprimer explicitement en silencieux (usage : tests automatises uniquement) :
  ```
  unins000.exe /VERYSILENT /SUPPRESSMSGBOXES /DELETEALLDATA=1
  ```
  Sans ce parametre explicite, une desinstallation silencieuse ne supprime jamais les donnees, quelle que soit la version de Windows ou le contexte.

Validation stricte avant toute suppression (Pascal Script, `CurUninstallStepChanged`) : le chemin cible est recalcule depuis la constante Inno Setup `{localappdata}` (jamais une valeur fournie par un parametre de ligne de commande ou une entree utilisateur), verifie non vide, verifie strictement plus long que `{localappdata}` seul (jamais le dossier racine `%LOCALAPPDATA%` lui-meme), et son existence est confirmee avant l'appel a `DelTree`. Un seul appel `DelTree` existe dans tout le script d'installation (verifie automatiquement par `test:agent:packaging-lot3:simulated`).

## 3. Limite connue de ce lot

La suppression complete cible **exclusivement** le dataRoot de production reel (`%LOCALAPPDATA%\RendezBot`) — il n'existe aucun mecanisme d'isolation de ce chemin au niveau de l'installateur pour les tests (contrairement au runtime agent, qui respecte `AGENT_DATA_DIR`). Consequence directe : ce scenario n'est **pas** couvert par un test automatise reel sur un poste de developpement partage dans ce lot (risque de suppression de vraies donnees). Il est valide par revue de code stricte (voir agent-packaging.md 11.3/11.4) et doit etre teste manuellement sur une VM ou un compte Windows dedie et jetable avant toute distribution large — voir la procedure dans [phase5-test-plan.md](phase5-test-plan.md).

## 4. Verification post-desinstallation

Apres une desinstallation standard : le dossier d'installation ne doit plus exister ; `%LOCALAPPDATA%\RendezBot\` (et son contenu) doit toujours exister ; aucun raccourci de demarrage automatique ne doit subsister dans le dossier "Demarrage" de l'utilisateur ; aucun process `RendezBotAgent.exe` ni `unins000.exe` ne doit rester actif.
