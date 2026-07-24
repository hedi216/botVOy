# Checklist de support - RendezBot Agent (Phase 5, Lot 4)

Checklist pour diagnostiquer un probleme signale par un utilisateur de RendezBot Agent, sans exposer d'information interne (comptes admin, chemins serveur, secrets) a la personne assistee.

## 1. L'installateur ne se telecharge pas / bouton desactive

- Verifier `GET /api/agent/releases/latest` (authentifie) - `available` doit etre `true`.
- Si `false` : verifier cote serveur que `AGENT_RELEASES_DIR`/`AGENT_RELEASE_VERSION` sont bien configures et que les 3 fichiers de la release existent, avec un hash coherent (voir [agent-download-release.md](agent-download-release.md)).
- Ne jamais communiquer le chemin disque du dossier de releases a l'utilisateur - inutile pour son diagnostic.

## 2. SmartScreen bloque l'installation

Comportement attendu (installateur non signe, voir [agent-signing.md](agent-signing.md)). Rassurer l'utilisateur : "Informations complementaires" > "Executer quand meme", uniquement s'il a bien telecharge depuis RendezBot lui-meme. Ne jamais suggerer de desactiver l'antivirus/SmartScreen.

## 3. L'agent ne demarre pas / se ferme immediatement

- Demander a l'utilisateur d'ouvrir le dossier de logs (bouton "Ouvrir les logs" dans la fenetre de l'agent) et de partager `agent.log` (deja purge de tout secret - jamais de token/mot de passe en clair dedans, verifiable directement).
- Verifier la version Windows (10/11 x64 attendu) et la presence de Chrome.

## 4. Code d'appairage refuse

- Verifier qu'un nouveau code a bien ete regenere (expire au bout de 10 minutes, usage unique).
- Verifier que l'utilisateur ne l'a pas deja utilise pour un autre poste.
- Cote serveur : verifier que l'agent n'a pas ete precedemment revoque pour cette agence.

## 5. Agent "Connecte" mais aucun bot ne demarre

- Verifier le statut `readyForCommands` de l'agent (`GET /api/agents`, authentifie).
- Verifier que Chrome est bien installe et accessible sur le poste de l'utilisateur.
- Consulter `agent.log` pour une erreur de lancement Chrome.

## 6. Desinstallation / donnees

- Rappeler que la desinstallation standard (via "Applications installees") **conserve** les identifiants/logs/profils par defaut.
- Une suppression complete existe separement (voir [agent-uninstallation.md](agent-uninstallation.md)) - a proposer uniquement si l'utilisateur souhaite explicitement tout effacer (ex. changement d'ordinateur definitif).

## 7. Ce qu'il ne faut jamais faire en support

- Ne jamais demander a l'utilisateur son mot de passe RendezBot par un canal autre que l'application elle-meme.
- Ne jamais partager un chemin serveur, une variable d'environnement, ou un extrait de base de donnees avec l'utilisateur.
- Ne jamais suggerer de desactiver une protection Windows (SmartScreen, antivirus) au-dela du simple "Executer quand meme" ponctuel deja documente.
- Ne jamais promettre une mise a jour automatique - la mise a niveau reste manuelle a ce lot (voir [agent-upgrade.md](agent-upgrade.md)).

## 8. Escalade

Si le probleme persiste au-dela de cette checklist : collecter `agent.log`, la version affichee par l'agent, la version de Windows, et transmettre a l'equipe technique - jamais de capture d'ecran contenant un cookie de session ou un jeton.
