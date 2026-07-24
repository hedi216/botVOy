# Mise a niveau de RendezBot Agent (Phase 5, Lot 3)

Ce lot couvre uniquement la **mise a niveau manuelle** : un operateur telecharge et execute un nouvel installateur sur un poste ou une version anterieure est deja presente. Aucun mecanisme d'auto-update distant n'existe (voir agent-packaging.md section 11.7 — hors perimetre).

## 1. Comportement attendu

Executer `RendezBotAgentSetup-<version N+1>.exe` sur un poste ou la version N est installee :

1. **Detection automatique** de l'installation existante, via l'identifiant Inno Setup stable (`AppId`, une constante fixe qui ne change jamais entre versions — voir agent-packaging.md 11.2). Aucune installation cote a cote ne doit se produire : une seule entree "RendezBot Agent" doit exister dans les Applications installees, avec la version mise a jour.
2. **Arret gracieux de l'instance en cours** avant tout remplacement de fichiers (`PrepareToInstall` -> `StopRunningAgentGracefully`, meme mecanisme que la desinstallation standard).
3. **Remplacement des fichiers programme** (`RendezBotAgent.exe`, `node_modules\`, `agent\`, `shared\`) — **jamais** les donnees sous `%LOCALAPPDATA%\RendezBot\` : ce dossier est physiquement distinct du dossier programme (`{app}`), donc structurellement jamais touche par le remplacement de fichiers d'une mise a niveau, independamment de toute logique Pascal specifique.
4. **Preservation garantie** (consequence directe du point 3, verifiee reellement par `test:agent:packaging-lot3:real` scenarios P/Q/R) : identifiants DPAPI, configuration, logs, profils Chrome (historique de connexion), extensions.
5. **Redemarrage** : si la tache "demarrage automatique" est active, le nouveau raccourci pointe vers le nouvel executable des le prochain lancement. Un lancement manuel se reconnecte automatiquement via les identifiants DPAPI preserves — **aucun nouveau code d'appairage n'est jamais demande** lors d'une mise a niveau.

## 2. Refus explicite de downgrade

Installer une version **strictement inferieure** a celle deja presente est **refuse**, en mode interactif comme en mode silencieux :

```
Une version plus recente de RendezBot Agent (X.Y.Z) est deja installee. Cet installateur (A.B.C)
ne peut pas retrograder l'installation. Desinstallez d'abord la version actuelle si vous
souhaitez reellement revenir a une version anterieure.
```

- Comparaison **numerique** composant par composant (`CompareVersions`, agent-installer.iss) — jamais une comparaison lexicale de chaines (qui traiterait a tort `"0.10.0"` comme inferieur a `"0.9.0"`).
- L'installation s'arrete avec un code de sortie non-zero (7, observe empiriquement), sans jamais corrompre l'installation existante ni ses donnees.
- Pour revenir reellement a une version anterieure : desinstaller explicitement la version courante d'abord (voir [agent-uninstallation.md](agent-uninstallation.md), desinstallation standard — les donnees restent preservees par defaut), puis installer la version voulue.

## 3. Reinstallation a l'identique (meme version)

Reinstaller exactement la meme version reecrit les fichiers programme (reparation), sans effet sur `%LOCALAPPDATA%\RendezBot\`. Verifie reellement (`test:agent:packaging-lot3:real` scenario U) : apres une desinstallation standard suivie d'une reinstallation, l'agent se reconnecte via les identifiants DPAPI preserves, sans nouveau code d'appairage.

## 4. Verification d'une mise a niveau

Comparer, avant et apres : la version affichee par "Applications installees", `%LOCALAPPDATA%\Programs\RendezBot Agent\version.json`, et l'etat de connexion affiche par l'interface locale de l'agent. Confirmer que `%LOCALAPPDATA%\RendezBot\credentials\` et `%LOCALAPPDATA%\RendezBot\profiles\` n'ont pas ete modifies en date de derniere ecriture au-dela de ce que l'agent ecrit lui-meme normalement.
