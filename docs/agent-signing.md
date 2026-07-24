# Signature de code — RendezBot Agent (Phase 5)

## 1. Etat actuel : Lot 3 reste explicitement NON signe

`RendezBotAgentSetup-<version>.exe` (et `RendezBotAgent.exe` a l'interieur) ne sont signes par **aucun** certificat de signature de code, a ce jour. C'est un choix delibere de perimetre pour ce lot, pas un oubli.

Preuves verifiables :
- Aucune directive `SignTool` dans `scripts/agent-installer.iss` (son absence signifie explicitement "non signe" pour Inno Setup — une valeur vide serait d'ailleurs rejetee a la compilation).
- `build-manifest.json` porte `"signed": false` de maniere explicite (jamais omis).
- Verifie automatiquement par `npm run test:agent:packaging-lot3:simulated`.

## 2. Consequence attendue : avertissement SmartScreen

A l'execution de l'installateur non signe, Windows SmartScreen affichera tres probablement un avertissement ("Windows a protege votre ordinateur" / "Éditeur inconnu"). C'est un comportement Windows NORMAL et ATTENDU pour tout executable non signe, pas un dysfonctionnement de l'installateur.

**Regles absolues pour ce lot et les suivants** :
- **Ne jamais contourner SmartScreen** au nom de la commodite (ex. republier avec un nom de fichier different pour "reinitialiser" la reputation).
- **Ne jamais desactiver** les protections Windows (SmartScreen, Defender) sur un poste de test ou de client pour faire disparaitre l'avertissement.
- **Ne jamais utiliser de certificat auto-signe** pour simuler une fiabilite de distribution commerciale — un certificat auto-signe ne supprime pas l'avertissement SmartScreen de toute facon (seule une reputation de certificat etablie, ou un certificat EV, le permet), et pretendre le contraire serait trompeur pour un client.
- **Ne jamais annoncer cet installateur comme "signe"** ou "verifie" dans une communication, documentation ou interface tant qu'une vraie signature n'est pas en place.

## 3. Preparation pour une signature future (Lot 4+, non implementee)

Ce qui est deja en place pour faciliter une future integration, sans qu'aucune cle reelle n'existe :

- Ordre de build correct deja respecte par `scripts/agent-package-win.ps1` : compilation -> packaging -> **(future etape de signature ici)** -> calcul des hashes SHA-256 -> manifeste -> publication. Inserer la signature APRES le build et AVANT le calcul des hashes (signer un fichier change son contenu binaire, donc son hash) serait l'ordre correct a implementer.
- Variable d'environnement candidate pour un futur certificat : `AGENT_CODE_SIGNING_CERT_PATH` (chemin vers un `.pfx`, jamais commite) + `AGENT_CODE_SIGNING_CERT_PASSWORD` (jamais en clair dans un fichier commite, uniquement via une variable d'environnement CI protegee). Ces variables ne sont **pas encore lues** par le script actuel — leur nom est reserve ici pour eviter une divergence de nommage future.
- Commande Windows typique pour une signature Authenticode future (a titre de reference, non executee) : `signtool sign /f <cert.pfx> /p <password> /fd SHA256 /tr <horodateur> /td SHA256 RendezBotAgentSetup-<version>.exe`.
- Une fois un certificat obtenu, la directive `SignTool=` dans `agent-installer.iss` (ou une signature post-compilation separee du `.exe` de sortie) devra etre ajoutee explicitement, et `"signed": false` dans le manifeste devra devenir conditionnel a la reussite reelle de cette etape — jamais mis a `true` par defaut.

## 4. Ce que ce lot NE fait PAS

Obtenir un certificat de signature de code (cout, processus d'identite verifiee aupres d'une autorite, a definir avec l'organisation), signer reellement un artefact, ou modifier le comportement de build pour inserer une etape de signature meme optionnelle. Ces points restent explicitement hors perimetre tant qu'un certificat reel n'est pas disponible.
