# Limites connues — Fin de Phase 4 (Lot 6)

Ce document liste explicitement ce que Phase 4 ne fait PAS, par choix deliberer ou par report vers Phase 5. Aucun de ces points n'est un defaut a corriger dans ce lot.

**Mise a jour Phase 5 (Lots 1-2)** : les sections 1 et 2 ci-dessous ont partiellement evolue depuis la redaction initiale de ce document (fin Phase 4). Voir [phase5-packaging-plan.md](phase5-packaging-plan.md) et [agent-packaging.md](agent-packaging.md) pour l'etat exact et a jour.

## 1. Distribution et installation

- Aucun installeur (`RendezBotAgentSetup.exe` ou equivalent) : reste vrai (Lot 3, non commence). L'agent dispose desormais d'un **build compile autonome** (`npm run agent:package:win`, Phase 5 Lot 1) et d'une **interface locale d'appairage** (Lot 2), mais Node.js doit encore etre installe separement — pas encore le contrat final "fonctionner sans Node.js installe".
- Aucun service Windows : reste vrai. Un **launcher candidat sans console** existe (Lot 2, `.vbs`, limites explicites documentees) mais aucun demarrage automatique au demarrage de Windows n'est encore configure (Lot 3).
- Aucune mise a jour automatique de l'agent.
- Aucune signature de code des binaires/scripts.
- Aucune distribution automatique des extensions Chrome par agence : chaque profil doit etre prepare manuellement (voir README, procedure d'installation d'extension).

## 2. Stockage local

- **Resolu au Lot 2** : les identifiants d'agent sont desormais proteges par DPAPI (Windows, `CurrentUser`) en mode `AGENT_RUNTIME_MODE=packaged`, avec migration automatique depuis l'ancien stockage en clair — voir [agent-credential-store.md](agent-credential-store.md). Le mode `development` (`npm run agent:dev` sans configuration explicite) continue d'utiliser un stockage en clair par defaut, deliberement, pour ne pas changer le comportement historique sans configuration explicite.

## 3. Automatisation metier (hors perimetre, volontairement)

- Aucune automatisation de la connexion TLScontact, de la saisie d'identifiants/mots de passe candidat, de la resolution de CAPTCHA, du contournement de controle humain ou Cloudflare, de rotation d'IP/proxy, ou de contournement de rate-limit. La validation humaine reste obligatoire a chaque etape sensible (connexion, CAPTCHA, clic final de reservation).
- Aucune finalisation de reservation ni paiement automatise.

## 4. Robustesse / echelle

- Un seul agent par agence peut etre actif de maniere pratique pour un volume important de bots (`AGENT_MAX_ACTIVE_BOTS`) ; aucune repartition de charge entre plusieurs agents pour une meme agence.
- Le test de stabilite (`test:agent:soak:real`) couvre une fenetre courte (quelques minutes a quelques dizaines de minutes) avec des seuils de detection larges (derive memoire grossiere uniquement) — ce n'est pas une preuve formelle d'absence de fuite sur plusieurs jours/semaines d'utilisation continue.
- Les timers globaux du serveur (sweep offline, sweep de commandes) sont lies a la duree de vie du process serveur : un redemarrage du process serveur reinitialise ces cycles (comportement attendu, pas un defaut).

## 5. Environnement de test

- Tous les tests automatises n'utilisent que la fixture locale (`scripts/fixtures/fake-appointment-site/`) : aucune garantie formelle de comportement identique face a une evolution future du site reel TLScontact (les detecteurs partages sont generiques, cf. README).
- Les tests reels (categorie D, y compris le soak test) ne peuvent s'executer que sur un PC Windows avec session interactive et Google Chrome installe — jamais sur la VM de production, donc jamais en integration continue automatique.

## 6. Modes d'execution

- `legacy_vm` et `agent` sont mutuellement exclusifs pour l'ensemble d'un process serveur (pas une bascule par bot). Faire cohabiter les deux modes necessiterait une refonte non prevue dans ce lot.

Voir [phase5-packaging-plan.md](phase5-packaging-plan.md) pour la feuille de route qui adresse la section 1-2 ci-dessus.
