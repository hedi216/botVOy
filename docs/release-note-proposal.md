# Proposition de note de version (a valider — Phase 4 cloturee)

Ce document est une **proposition** de note de version technique pour la prochaine version publiee. Le numero de version commercial (`package.json`, actuellement `0.1.0`) n'a pas ete modifie par ce lot — tout changement de version reste soumis a validation explicite avant publication.

## Contenu propose

### Ajoute / disponible

- **Agent Windows local** : execution reelle de Chrome/Playwright deplacee sur un PC d'agence, connecte au serveur via Socket.IO (protocole d'appairage, heartbeat, commandes `START_BOT`/`STOP_BOT`/`VALIDATE_BOT`).
- **Validation manuelle** de la page de rendez-vous avant le demarrage de la surveillance (bouton dedie), coherente avec le mode historique.
- **Surveillance locale reelle** : cycles de detection, navigation entre mois, rafraichissement periodique, gestion de rate-limit avec reprise automatique, detection de creneau avec deduplication.
- **Reconnexion progressive** de l'agent au serveur en cas de coupure (delai croissant avec gigue), avec buffer local borne des evenements en attente et resynchronisation complete au retour (reconstruction de l'etat des bots cote serveur).
- **Extensions locales par agence** : configuration et utilisation de profils Chrome persistants avec extension d'enregistrement d'ecran, installation manuelle.
- **Securite** : redaction systematique des secrets dans les logs (serveur et agent), reponses publiques strictement filtrees par liste blanche, isolation stricte entre agences.
- **Stockage protege des identifiants** (Phase 5, Lot 2) : chiffrement DPAPI (Windows, `CurrentUser`) en mode packaged, migration automatique et non destructive depuis l'ancien stockage en clair.
- **Premier appairage sans PowerShell** (Phase 5, Lot 2) : interface locale (loopback) pour saisir le code d'appairage et diagnostiquer l'agent (etat, logs, dossier de configuration).
- **Verrou mono-instance** (Phase 5, Lot 2) : un seul agent actif par poste/dossier de donnees.
- **Limites connues** : voir [phase4-known-limitations.md](phase4-known-limitations.md) (mis a jour Phase 5).

### PAS encore annonce (reserve au Lot 3, non implemente)

- Aucun installeur (`RendezBotAgentSetup.exe`).
- Aucun service Windows ni demarrage automatique de l'agent au demarrage de Windows (un launcher candidat sans console existe, limites explicites — pas la solution finale).
- Aucune mise a jour automatique.
- Aucune signature de code.
- Aucune distribution automatique des extensions Chrome.
- L'agent necessite encore Node.js installe separement (build compile disponible, pas encore un executable unique).

## Ton et perimetre de communication recommandes

- Presenter le changement comme une **migration technique d'execution** (VM -> PC local), pas comme une nouvelle fonctionnalite metier pour l'utilisateur final : le comportement de surveillance/validation reste identique de son point de vue.
- Rappeler explicitement que la validation humaine reste obligatoire et qu'aucun contournement de controle du site cible n'est ajoute.
- Ne pas mentionner d'installeur ou de service Windows tant qu'ils ne sont pas reellement livres (voir [phase5-packaging-plan.md](phase5-packaging-plan.md)).

## Preuves associees

Phase 4 (Lot 6) : regression complete (simulee + reelle), tests de securite dedies, test de stabilite courte, compatibilite `legacy_vm` verifiee. Phase 5 (Lots 1-2) : build compile autonome valide (25/25 simule, 9/9 reel), credential store DPAPI/appairage local/mono-instance valides (45/45 simule, 20/20 reel, 10/10 hors depot), aucune regression Phase 4 (283/283 simule, 102/102 reel).
