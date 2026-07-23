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
- **Limites connues** : voir [phase4-known-limitations.md](phase4-known-limitations.md).

### PAS encore annonce (reserve a Phase 5, non implemente)

- Aucun installeur (`RendezBotAgentSetup.exe`).
- Aucun service Windows ni demarrage automatique de l'agent.
- Aucune mise a jour automatique.
- Aucun stockage DPAPI definitif des identifiants d'agent (stockage fichier local actuel uniquement).
- Aucune signature de code.
- Aucune distribution automatique des extensions Chrome.

## Ton et perimetre de communication recommandes

- Presenter le changement comme une **migration technique d'execution** (VM -> PC local), pas comme une nouvelle fonctionnalite metier pour l'utilisateur final : le comportement de surveillance/validation reste identique de son point de vue.
- Rappeler explicitement que la validation humaine reste obligatoire et qu'aucun contournement de controle du site cible n'est ajoute.
- Ne pas mentionner d'installeur ou de service Windows tant qu'ils ne sont pas reellement livres (voir [phase5-packaging-plan.md](phase5-packaging-plan.md)).

## Preuves associees (voir rapport final Lot 6)

Regression complete (simulee + reelle), tests de securite dedies, test de stabilite courte, compatibilite `legacy_vm` verifiee, documentation technique a jour.
