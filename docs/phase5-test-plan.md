# Plan de test Phase 5 (Lots 1-3)

Ce document consolide la strategie de test de packaging/installation a travers les Lots 1-3 et fournit la checklist de test manuel controle pour le Lot 3 (installateur reel). Pour les resultats detailles de chaque lot, voir [agent-packaging.md](agent-packaging.md).

## 1. Vue d'ensemble des suites automatisees

| Suite | Portee | Environnement | Resultat Lot 3 |
|---|---|---|---|
| `test:agent:packaging:simulated` | Lot 1 : dependances, chemins, version | VM, aucun Chrome | 25/25 |
| `test:agent:packaging:real` | Lot 1 : build reel | PC Windows personnel | 9/9 |
| `test:agent:packaging-lot2:simulated` | Lot 2 : DPAPI, migration, verrou, interface locale | VM, aucun Chrome de bot | 45/45 |
| `test:agent:packaging-lot2:real` | Lot 2 : cycle appairage/DPAPI/mono-instance/revocation reel | PC Windows personnel | 20/20 |
| `test:agent:protocol-auth:real` | Protocole INVALID_TOKEN/AGENT_REVOKED/VERSION_INCOMPATIBLE | PC Windows personnel | 43/43 |
| `test:agent:packaging-lot3:simulated` | Lot 3 : runtime embarque, script Inno Setup, manifeste, hashes | VM, aucune installation reelle | 37/37 |
| `test:agent:packaging-lot3:real` | Lot 3 : installateur reel, cycle complet | PC Windows personnel avec Chrome | 29/29 |
| `test:phase4:final:simulated` | Non-regression complete Phase 4 | VM | 283/283 |
| `test:phase4:final:real` | Non-regression complete Phase 4 | PC Windows personnel | 102/102 |

Executer `npx tsc --noEmit` avant toute suite reelle : aucune suite ne doit etre lancee sur un etat qui ne compile pas.

## 2. Scenarios explicitement NON couverts par l'automatisation (Lot 3)

**Suppression complete du dataRoot** (`/DELETEALLDATA=1`, voir agent-uninstallation.md section 3) : la logique Pascal cible `%LOCALAPPDATA%\RendezBot` de maniere fixe, sans isolation possible au niveau installateur. Executer ce scenario automatiquement sur le poste de developpement partage risquerait de supprimer de vraies donnees (credentials, profils Chrome reels accumules) — il reste donc hors de `test:agent:packaging-lot3:real` de facon permanente, pas seulement le temps de ce lot.

**Valide reellement** : ce scenario a ete execute manuellement sur une VM Windows dediee et jetable (checklist ci-dessous, etapes 12-14) et confirme reussi : dataRoot supprime, dossier programme supprime, fichier temoin place en dehors de ces deux dossiers conserve, aucun processus `RendezBotAgent.exe`/`unins000.exe` residuel, raccourci de demarrage (`Startup`) supprime. Voir aussi [agent-packaging.md](agent-packaging.md) section 11.4.

## 3. Checklist de test manuel controle (VM ou compte Windows dedie et jetable)

**Prealable obligatoire** : cette checklist suppose un environnement JETABLE (VM ou compte Windows secondaire dont la perte de donnees est sans consequence). **Ne jamais executer les etapes 12-14 sur le poste de developpement principal ou un poste client.**

1. Verifier qu'aucune installation de "RendezBot Agent" n'existe deja (Applications installees + `%LOCALAPPDATA%\Programs\RendezBot Agent` absent).
2. Copier `RendezBotAgentSetup-<version>.exe` sur la machine de test (jamais executer directement depuis un partage reseau pour ce test).
3. Executer l'installateur en mode interactif. Confirmer : aucune invite UAC, dossier par defaut `%LOCALAPPDATA%\Programs\RendezBot Agent`, ecran de taches (bureau/demarrage automatique) presente correctement.
4. Terminer l'installation avec "Lancer maintenant" coche. Confirmer : aucune fenetre de console persistante, l'interface locale s'ouvre dans le navigateur par defaut sur l'ecran d'appairage.
5. Effectuer un appairage reel via cette interface (code genere par un compte manager de test cote serveur). Confirmer l'etat "Connecte".
6. Redemarrer la session Windows (ou se deconnecter/reconnecter). Si "demarrage automatique" etait coche : confirmer que l'agent redemarre seul et se reconnecte sans nouveau code.
7. Depuis l'interface serveur, demarrer un bot de test (fixture locale). Confirmer qu'un Chrome VISIBLE s'ouvre reellement sur le poste de test.
8. Arreter ce bot depuis l'interface serveur. Confirmer que ce Chrome se ferme.
9. Tenter de lancer une seconde fois `RendezBotAgent.exe` manuellement. Confirmer que l'interface de l'instance existante reprend le focus, sans erreur technique visible.
10. Desinstaller via "Applications installees" (desinstallation standard, sans suppression complete). Confirmer : fichiers programme supprimes, `%LOCALAPPDATA%\RendezBot\` toujours present avec ses sous-dossiers, aucun raccourci de demarrage residuel.
11. Reinstaller la meme version. Confirmer la reconnexion automatique sans nouveau code d'appairage (identifiants preserves de l'etape 10).
12. **[Environnement jetable uniquement] EXECUTE ET VALIDE** sur une VM Windows dediee et jetable : desinstaller a nouveau avec `/DELETEALLDATA=1` (suppression complete). Confirme : le dataRoot (`%LOCALAPPDATA%\RendezBot`) est integralement supprime ; le dossier programme est integralement supprime.
13. **[Environnement jetable uniquement] EXECUTE ET VALIDE** : un fichier temoin place en dehors du dataRoot et du dossier programme (avant l'etape 12) est toujours present apres la suppression complete — preuve que celle-ci reste strictement scopee, jamais un dossier parent ou un chemin voisin.
14. **[Environnement jetable uniquement] EXECUTE ET VALIDE** : aucun processus (`RendezBotAgent.exe`, `unins000.exe`) residuel, et le raccourci de demarrage automatique (dossier `Startup`) est bien supprime apres la suppression complete.
15. Tenter d'installer une version anterieure par-dessus la version courante (si un installateur de version anterieure est disponible). Confirmer le refus explicite (message clair, aucune corruption des donnees existantes).
16. **[Environnement jetable uniquement, reste a confirmer]** Reinstaller apres la suppression complete de l'etape 12. Confirmer qu'un NOUVEL appairage est desormais necessaire (les identifiants ont bien ete definitivement supprimes, pas seulement le dataRoot au niveau fichiers).

## 4. Limites connues documentees

Aucune signature de code (voir [agent-signing.md](agent-signing.md)) : un avertissement SmartScreen est attendu a chaque etape d'execution de l'installateur sur une machine neuve — ne jamais le contourner ni le desactiver pendant ce test.
