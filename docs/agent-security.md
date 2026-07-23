# Securite Agent (Phase 4)

## 1. Principes

- Aucune donnee sensible (jeton, mot de passe, cookie, chemin de profil, port de debogage Chrome, en-tete `Authorization`, cle API) ne doit jamais atteindre : PostgreSQL en clair au-dela du strict necessaire (`token_hash` reste hache), une reponse REST publique, un evenement Socket.IO web, un log serveur ou agent, un rapport de test, ou une extension publique.
- Toute sortie publique (REST, Socket.IO, logs) passe par une fonction de serialisation explicite avec liste blanche (`toPublicAgent()`, `publicCommandFor()`, `toPublicExtensionStatus()`) — jamais un objet DB brut.
- Les erreurs cote client restent generiques (jamais de trace de pile, jamais un message brut de driver PostgreSQL).

## 2. Sanitisation des cles sensibles

Deux listes noires independantes, qui doivent rester alignees :

- Cote serveur (`src/agentGateway.ts`, `FORBIDDEN_KEY_SUBSTRINGS`) : `token`, `secret`, `password`, `code_hash`, `codehash`, `cookie`, `authorization`, `profilepath`, `debugport`, `apikey`, `api_key`.
- Cote agent (`src/agent/agentLocalLogger.ts`, `FORBIDDEN_SUBSTRINGS`) : liste equivalente, appliquee a la redaction des logs locaux avant ecriture sur disque.

**Trouve et corrige au Lot 6** : la liste serveur omettait `cookie`/`profilePath`/`debugPort`/`Authorization`/`apiKey`, permettant a ces champs de survivre dans `agent_commands.public_result` s'ils etaient presents dans le `result` d'une commande completee. Corrige par alignement des deux listes (voir [architecture-agent.md](architecture-agent.md), defaut #3 du tableau d'audit).

## 3. Sentinelles de test

`scripts/test-agent-security-simulated.ts` injecte les sentinelles suivantes dans un cycle complet START_BOT -> WAITING_FOR_USER -> COMMAND_COMPLETED, puis verifie leur absence dans PostgreSQL (ligne brute), REST (liste et detail), et stdout serveur :

`TEST_SECRET_PASSWORD`, `TEST_SECRET_COOKIE`, `TEST_SECRET_TOKEN`, `TEST_SECRET_API_KEY`, `TEST_SECRET_AUTHORIZATION`, `TEST_SECRET_PROFILE_PATH`, `TEST_SECRET_DEBUG_PORT`.

## 4. Surface d'attaque couverte (tests automatises)

| Categorie | Verification | Test |
|---|---|---|
| Fuite de secret | Sweep de sentinelles (DB, REST, logs) | `test-agent-security-simulated.ts` scenario 1 |
| Corps JSON malformes/vides | `POST /api/agents/pairing-codes` (JSON invalide), `PATCH /api/monitoring-settings` (corps vide), `POST /api/agents/:id/revoke` (ID non numerique), `GET /api/agent-commands/:id` (UUID malforme) | scenario 2 — jamais de 5xx, jamais de texte SQL brut dans le corps JSON |
| UUID bien forme mais inexistant | `GET /api/agent-commands/00000000-0000-0000-0000-000000000000` | scenario 2 — doit repondre exactement 404 |
| Valeur de statut/evenement inconnue | `BOT_STATUS="TOTALLY_MADE_UP_STATUS"`, evenement Socket.IO inconnu emis par un agent simule | scenario 3 — le serveur reste reactif (`GET /api/me` toujours 200 apres) |
| Payload demesure | `start-bot` avec un `botName` de 500 000 caracteres | scenario 4 — le serveur reste reactif |
| Traversee de chemin (extension) | `localPath` pointant hors de la racine attendue via `../../..` | scenario 5 — jamais `status: "ok"` |
| Manifest d'extension malforme | JSON invalide en tant que `manifest.json` | scenario 5 — `status: "invalid"` |
| Isolation cross-agence | Acces a un agent/bot d'une autre agence | `test-phase2-backend.ts`, `test-phase3-backend.ts` |
| Agent revoque / non synchronise / hors ligne | Commandes refusees, pas de reactivation silencieuse d'un bot STOPPED | `test-phase3-backend.ts`, `test-agent-resilience-simulated.ts`/`-real.ts` |
| Rejeu d'`eventId` / commande dupliquee | Idempotence verifiee | `test-phase3-backend.ts` |

## 5. Ce que l'agent ne fait jamais (rappel de perimetre)

L'agent n'automatise et ne doit jamais automatiser : la connexion TLScontact, la saisie d'identifiants/mots de passe candidat, la resolution de CAPTCHA, le contournement de controle humain ou Cloudflare, la rotation d'IP/proxy, ni le contournement de rate-limit. Toute tentative d'ajouter une telle capacite doit etre refusee au niveau de la revue de code, pas seulement au niveau des tests.

## 6. Limites connues

Voir [phase4-known-limitations.md](phase4-known-limitations.md) pour les limites de securite deja identifiees et deliberement hors perimetre de ce lot (DPAPI definitif, signature de code, distribution automatique d'extensions).
