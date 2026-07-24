# Appairer RendezBot Agent

Ce guide suppose que RendezBot Agent est deja installe (voir [agent-user-installation.md](agent-user-installation.md)).

## 1. Generer un code d'appairage

Sur RendezBot (dans votre navigateur), depuis la page "Agent local" ou l'ecran de configuration, cliquez sur "Generer un code d'appairage". Un code a 8 caracteres s'affiche, valable 10 minutes et utilisable une seule fois.

## 2. Saisir le code dans l'agent

Dans la fenetre de RendezBot Agent (ouverte automatiquement au premier lancement, ou accessible via le raccourci si vous l'avez ferme) :

1. Saisissez le code dans le champ "Code d'appairage".
2. Cliquez sur "Appairer".

## 3. Verifier la connexion

- Le statut passe de "Non appaire" a "Connecte" en quelques secondes.
- Depuis RendezBot, l'agent apparait desormais dans la liste des ordinateurs autorises, avec le statut "Connecte".

## 4. Que se passe-t-il ensuite ?

- Vos identifiants sont stockes de maniere protegee sur cet ordinateur (jamais en clair). Les prochains lancements de l'agent se reconnectent automatiquement, sans nouveau code.
- Un seul agent peut etre actif a la fois sur cet ordinateur pour ce compte.

## 5. Code refuse ou expire

- **"Code invalide"** : verifiez qu'il n'a pas ete deja utilise, ni mal recopie.
- **"Code expire"** : generez-en un nouveau (etape 1) - un code n'est valable que 10 minutes.
- **Trop de tentatives** : redemarrez l'agent puis reessayez avec un nouveau code.

## 6. Dissocier ou changer de compte

Depuis la fenetre de l'agent, le bouton "Dissocier cet ordinateur" efface les identifiants locaux (jamais vos logs ni vos profils Chrome) et fait revenir a l'ecran d'appairage - utile si vous voulez reappairer avec un autre compte/une autre agence.

Un administrateur peut aussi revoquer l'acces d'un agent depuis RendezBot ("Agent local" > Revoquer) : l'agent detecte la revocation automatiquement et repasse a l'ecran d'appairage.

---

*Validation : ce parcours complet (appairage, reconnexion automatique via DPAPI apres redemarrage, revocation puis retour a "Non appaire") a ete confirme reellement sur une VM Windows de test, via le vrai domaine de production `https://app.rendezbot.xyz` - voir [phase5-release-candidate.md](phase5-release-candidate.md) section 5.2.*
