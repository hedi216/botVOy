# Plan de transition Phase 5 — Packaging de l'Agent

## 0. Statut

- **Lot 1 (audit, choix de technologie, resolution des chemins, version centralisee, build compile minimal) : termine.** Voir [agent-packaging.md](agent-packaging.md) section 1-8 pour le detail complet.
- **Lot 2 (credential store DPAPI, migration, appairage local sans PowerShell, interface locale, verrou mono-instance, launcher candidat sans console) : termine.** Voir [agent-packaging.md](agent-packaging.md) section 9, [agent-credential-store.md](agent-credential-store.md) et [agent-local-ui.md](agent-local-ui.md) pour le detail complet. Resume : `AgentCredentialStore` (Dev/Dpapi/Test) selectionne explicitement via `AGENT_RUNTIME_MODE` ; migration idempotente et non destructive ; interface HTTP loopback (node:http natif, toujours 3 dependances runtime) ; verrou mono-instance par fichier+PID ; politique de revocation/token invalide/version incompatible ; six defauts reels trouves et corriges (voir agent-packaging.md section 9.2) ; 45/45 simule, 20/20 reel, 10/10 hors depot, aucune regression Phase 4 (283/283 simule, 102/102 reel).
- **Lots 3-5 : non commences.** La section 18 ci-dessous precise le plan du Lot 3 tel qu'issu des conclusions du Lot 2.

Ce document definit le perimetre envisage pour la suite de Phase 5 **sans rien implementer au-dela des Lots 1 et 2**. Il presente les decisions ouvertes avec leurs compromis, pour validation avant chaque nouveau lot.

## 1. Format cible

`RendezBotAgentSetup.exe` : un installeur Windows unique, execute par l'operateur sur chaque PC destine a heberger un agent.

## 2. Choix de l'outil de packaging

| Option | Avantages | Inconvenients |
|---|---|---|
| **Electron-builder / NSIS** | Ecosysteme Node.js deja utilise par le projet, generation `.exe` NSIS mature | Ajoute une dependance de build significative pour un simple agent CLI (pas d'UI Electron necessaire aujourd'hui) |
| **pkg / nexe (binaire Node autonome) + NSIS/Inno Setup pour l'installeur** | Garde le runtime agent en Node.js pur (code actuel reutilisable tel quel), installeur separe et simple | Deux outils a maintenir plutot qu'un seul |
| **Inno Setup seul, autour d'un Node.js embarque** | Tres controle, largement documente pour Windows | Necessite d'embarquer/verifier une version de Node.js correcte sur la machine cible |

**Mise a jour post-Lot 1** : comparaison complete (incluant Node SEA, rejete pour pkg/nexe) dans [agent-packaging.md](agent-packaging.md) section 2. Decision retenue pour le Lot 1 : `tsc` seul (pas encore de binaire unique). Candidate pour le Lot 2/3 : **Node SEA** (support officiel Node.js, prefere a pkg/nexe dont le projet de reference est archive) pour produire l'executable unique, puis **Inno Setup** pour l'installateur (per-user, sans droits admin).

## 3. Contenu de l'installeur (a definir)

- Binaire agent (ou runtime Node.js + sources compilees).
- Configuration par defaut (`.env` agent minimal, sans secret).
- Emplacement d'installation : `%ProgramFiles%\RendezBot Agent\` (standard) vs `%LOCALAPPDATA%\RendezBot\Agent\` (pas de droits admin requis) — **decision ouverte**, impacte directement le choix service Windows vs application demarrage utilisateur (section 5).
- Raccourci (menu Demarrer / bureau) — a confirmer si necessaire pour un usage "toujours actif en arriere-plan" sans raccourci visible.

## 4. Lancement automatique

Options ouvertes, non tranchees :
- Raccourci dans le dossier "Demarrage" Windows (simple, pas de droits admin, mais rien ne relance l'agent s'il crashe).
- Tache planifiee Windows au logon (relance possible sur echec, toujours pas de droits admin necessaires).
- **Service Windows** (section 5) : le plus robuste (survit sans session utilisateur ouverte), mais necessite des droits admin a l'installation et complique l'acces a un Chrome visible piloté par l'agent (un service Windows ne peut normalement pas afficher de fenetre interactive sur le bureau de l'utilisateur connecte — contrainte forte a verifier avant de trancher, car le modele actuel repose sur un Chrome VISIBLE pour permettre la validation humaine).

## 5. Service Windows vs application de demarrage

| Option | Avantages | Inconvenients |
|---|---|---|
| Service Windows | Survit a la deconnexion, redemarrage automatique en cas de crash (config native Windows) | Session non interactive par defaut : incompatible en l'etat avec un Chrome visible pour validation humaine (contrainte bloquante a lever ou a documenter comme limite acceptee) |
| Application demarrage utilisateur (raccourci/tache planifiee) | Compatible nativement avec un Chrome visible dans la session de l'utilisateur connecte | Ne tourne que si une session utilisateur est ouverte ; pas de redemarrage automatique natif en cas de crash sans logique supplementaire |

*Etant donne que l'agent doit ouvrir un Chrome visible pour la validation humaine (contrainte du produit, non negociable)*, l'option "application demarrage utilisateur" est probablement la plus coherente — **decision a valider explicitement avant implementation**, car elle ecarte le service Windows par defaut.

## 6. Stockage des identifiants (DPAPI)

**Termine au Lot 2.** Voir [agent-credential-store.md](agent-credential-store.md) pour l'implementation complete (`AgentCredentialStore`, `WindowsDpapiCredentialStore`, format versionne, migration idempotente depuis le fichier en clair).

## 7. Desinstallation

Doit retirer : binaire/runtime, raccourcis/taches planifiees, mais **jamais automatiquement** les profils Chrome persistants ni les logs locaux sans confirmation explicite (ils peuvent contenir un historique utile au support). Decision ouverte : proposer un choix a la desinstallation ("conserver les donnees locales" par defaut) plutot qu'une suppression silencieuse.

## 8. Mise a jour

Options ouvertes, non tranchees : verification manuelle (l'operateur re-telecharge et relance l'installeur) vs verification automatique au demarrage de l'agent (contacter le serveur pour connaitre la derniere version compatible) avec telechargement manuel obligatoire (jamais d'auto-update silencieux sans confirmation, pour rester coherent avec l'absence de signature de code en Phase 4).

## 9. Signature de code

Non couvert par Phase 4. Necessaire avant toute distribution large pour eviter les alertes SmartScreen/antivirus. Necessite un certificat de signature (cout/processus a definir avec l'organisation).

## 10. Gestion de version

**Mise a jour post-Lot 1** : source unique creee (`src/agent/agentVersionInfo.json`, `{ agentVersion, protocolVersion }`), consommee par `src/agent/agentSettings.ts` et par `version.json` genere a chaque build. Version actuelle NON changee (`0.1.0`) — recommandation proposee (non appliquee) : `0.5.0` pour cette etape pre-installateur, `1.0.0` reserve a la fin du Lot 3. Decision a valider explicitement avant tout changement reel.

## 11. Telechargement depuis l'interface web

`AGENT_DOWNLOAD_URL` existe deja comme variable de configuration serveur (Phase 2), actuellement vide/non utilisee activement. Phase 5 pourrait l'alimenter avec un lien vers le dernier `RendezBotAgentSetup.exe` publie. Decision ouverte : hebergement du fichier (serveur applicatif lui-meme vs stockage externe).

## 12. Verification d'integrite / rollback

- Verification d'integrite : checksum (SHA-256) publie a cote du lien de telechargement, verifie manuellement ou par l'installeur avant execution.
- Rollback : conserver la derniere version fonctionnelle connue (l'installeur ne doit jamais desinstaller la version precedente avant confirmation que la nouvelle version demarre correctement) — mecanisme precis a definir.

## 13. Migration depuis `agent:dev`

Les agents actuellement lances via `npm run agent:dev` (Phase 4) doivent pouvoir migrer vers l'agent installe sans re-appairage : reutiliser le meme `AGENT_CREDENTIALS_PATH`/format de fichier, ou fournir une procedure de migration explicite documentee au moment de la sortie de Phase 5.

## 14. Configuration des extensions locales

Reste manuelle (voir [agent-operations.md](agent-operations.md)) : Phase 5 ne prevoit pas de distribution automatique d'extensions Chrome (contrainte Chrome Web Store non contournee, cf. README).

## 15. Strategie de support

A definir : niveau de log par defaut en production (actuellement `AGENT_LOG_LEVEL=info`), procedure de collecte de logs pour un ticket de support (rappel : les logs sont deja rediges de tout secret, donc partageables en securite), canal de remontee des problemes d'installation.

## 16. Ce que Phase 5 n'annoncera PAS avant validation

Aucun installeur, aucun service Windows, aucune mise a jour automatique ne doit etre presente comme livre avant que l'implementation correspondante soit reellement terminee et validee — voir [phase4-known-limitations.md](phase4-known-limitations.md). Le stockage DPAPI (Lot 2) EST desormais reellement implemente et valide (voir [agent-credential-store.md](agent-credential-store.md)) ; le launcher sans console (Lot 2) reste un candidat transitoire explicitement documente comme tel, pas la solution finale.

## 17. Plan du Lot 2 — termine

Voir [agent-packaging.md](agent-packaging.md) section 9 pour le bilan complet (perimetre livre, defauts corriges, resultats de test). Les six points du plan initial (credential store, migration, ecran d'appairage local, verrou mono-instance, mode sans console, tests) ont ete livres — l'ecran d'appairage local est une interface HTTP loopback plutot qu'une invite console, choix documente dans [agent-local-ui.md](agent-local-ui.md).

## 18. Plan precis du Lot 3

Objectif : installateur Inno Setup, demarrage automatique Windows, desinstallation, mise a niveau par installateur.

1. **Executable unique** : evaluer Node SEA (candidat retenu au Lot 1) pour fusionner le runtime compile + dependances en un seul `RendezBotAgent.exe`, avec sous-systeme Windows natif (remplace le launcher `.vbs` transitoire du Lot 2). Point d'attention : compatibilite des dependances a bindings natifs optionnels (`ws`) avec l'embarquement SEA — a valider concretement.
2. **Installateur Inno Setup** : `RendezBotAgentSetup.exe`, installation per-user par defaut (`PrivilegesRequired=lowest`, coherent avec la decision de la section 5), cree les dossiers `%LOCALAPPDATA%\RendezBot\*` necessaires, raccourci menu Demarrer, option raccourci bureau.
3. **Demarrage automatique** : raccourci dans le dossier "Demarrage" Windows (decision de la section 4/5 — pas de service Windows, incompatible avec un Chrome visible).
4. **Desinstallation** : retire binaire/raccourcis ; conserve par defaut credentials/logs/profils/extensions (option explicite "supprimer toutes les donnees locales").
5. **Mise a niveau** : installation par-dessus une version existante, arret propre de l'ancienne instance (verrou mono-instance deja disponible depuis le Lot 2) avant remplacement, conservation credentials/config/profils.
6. **Signature de code** : preparer les commandes de signature sans cle reelle (voir section 9), documenter l'avertissement SmartScreen attendu sans certificat.
7. **Tests** : `npm run test:agent:packaging-lot3:simulated` (structure installateur, chemins, matrice premiere-installation/reinstallation/mise-a-niveau/reparation/desinstallation) et `npm run test:agent:packaging-lot3:real` (installation/desinstallation reelles dans un dossier de test, jamais l'installation reelle du poste).

Criteres d'acceptation proposes (a confirmer avant de commencer) : l'installateur fonctionne sans droits administrateur ; une mise a niveau conserve l'identite de l'agent (credentials DPAPI) ; une desinstallation standard ne supprime jamais les donnees utilisateur sans confirmation explicite ; non-regression Phase 4 et Lots 1-2 maintenue ; aucune signature de code reelle n'est prealablement annoncee sans certificat obtenu.
