# Limites connues — Fin de Phase 4 (Lot 6)

Ce document liste explicitement ce que Phase 4 ne fait PAS, par choix deliberer ou par report vers Phase 5. Aucun de ces points n'est un defaut a corriger dans ce lot.

## 1. Distribution et installation

- Aucun installeur (`RendezBotAgentSetup.exe` ou equivalent) : l'agent se lance via `npm run agent:dev`, poste par poste, manuellement.
- Aucun service Windows ni application de demarrage automatique : l'agent doit etre relance manuellement apres redemarrage du PC.
- Aucune mise a jour automatique de l'agent.
- Aucune signature de code des binaires/scripts.
- Aucune distribution automatique des extensions Chrome par agence : chaque profil doit etre prepare manuellement (voir README, procedure d'installation d'extension).

## 2. Stockage local

- Les identifiants d'agent sont stockes localement (`AGENT_CREDENTIALS_PATH`) sans chiffrement DPAPI definitif — protection de niveau systeme de fichiers uniquement.

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
