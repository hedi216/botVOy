# Tests Agent (Phase 4)

## 1. Classification des tests

| Categorie | Definition | Execution possible sur la VM ? | Fichiers |
|---|---|---|---|
| **A — unitaire pur** | Aucune dependance PostgreSQL, serveur, navigateur | Oui | `scripts/test-agent-serialization.ts` (analyse statique + mock), tests de modules purs inclus dans les suites simulees (`agentOfflineBuffer.ts`, `agentReconnectBackoff.ts`, `agentSlotDedup.ts` testes via `test-agent-resilience-simulated.ts`/`test-agent-monitoring-simulated.ts`) |
| **B — backend/integration** | PostgreSQL + serveur Socket.IO reels + agent SIMULE (socket.io-client rejouant le protocole), jamais de Chrome bot | Oui | `test-phase2-backend.ts`, `test-phase3-backend.ts`, `test-agent-revoke.ts`, `test-agent-patch-pairing.ts`, `test-agent-bot-status-simulated.ts`, `test-agent-validate-simulated.ts`, `test-agent-monitoring-simulated.ts`, `test-agent-resilience-simulated.ts`, `test-agent-security-simulated.ts` |
| **C — frontend** | Navigateur Playwright propre au test (interface web), pas d'agent reel, jamais de Chrome bot | Oui | `test-phase2-frontend.ts`, `test-phase3-frontend.ts` |
| **D — reel Windows** | VRAI agent (`src/agent/agentMain.ts`), VRAI Chrome visible, fixture locale UNIQUEMENT | **Non** — PC Windows personnel avec session interactive uniquement | `test-agent-phase4-lot2.ts` (suite B), `test-agent-bot-status-real.ts`, `test-agent-validate-real.ts`, `test-agent-monitoring-real.ts`, `test-agent-resilience-real.ts`, `test-agent-soak-real.ts` |
| **E — legacy_vm** | Chemin historique, aucune dependance au runtime agent | Oui (c'est son usage normal) | Scenarios `TC-legacy` dans `test-phase3-backend.ts` (execution en `BOT_EXECUTION_MODE=legacy_vm` dans le meme fichier que les scenarios agent, aucun test separe requis) |

**Outils manuels (hors classification A-E, jamais dans un runner automatise)** : `test-agent-phase1.ts` et `test-agent-phase3.ts` sont des scripts de debogage interactifs (necessitent un code d'appairage fourni en argument de ligne de commande) conserves pour le diagnostic manuel du protocole bas niveau. Ils ne sont pas redondants avec les suites B automatisees (`test-phase2-backend.ts`/`test-phase3-backend.ts`), qui couvrent les memes scenarios de bout en bout sans intervention humaine — a ce titre, aucune suppression n'a ete faite (regle : ne jamais supprimer un test au seul motif qu'il est long ou ancien, seulement si sa couverture est prouvee redondante).

Aucun script n'a ete supprime dans ce Lot : chaque script audite a une couverture propre et non redondante, verifiee ci-dessus.

## 2. Fixture locale unique

Tous les tests des categories B/C/D utilisent exclusivement `scripts/fixtures/fake-appointment-site/appointment.html`, servie en `file://` (jamais de reseau, jamais d'URL TLScontact). Elle reutilise EXACTEMENT les memes `data-testid`/motifs de texte que `src/shared/detectors.ts`, jamais une logique de detection parallele.

### Scenarios disponibles (`?scenario=...`)

| Scenario | Couvre |
|---|---|
| `no-slots` (defaut) | Page prete, aucun creneau |
| `slot-available` | Un creneau disponible, reservation aboutissant (SLOT_DETECTED) |
| `multi-slot` | Plusieurs creneaux simultanes |
| `month-change` | Mois courant indisponible, mois suivant disponible |
| `rate-limited` | Texte "Error 1015", se dissipe apres `clearAfterMs` (defaut 30000) |
| `refresh-required` | Page "non prete" jusqu'a un `reload()` reel |
| `refresh-failed` | Reste "non prete" meme apres `reload()` (-> `REFRESH_FAILED`/`ERROR`) |
| `invalid` | Page fixture reconnue mais contenu ne correspondant a aucun etat connu |
| `incomplete` | DOM partiel (mois suivant absent, pas seulement desactive) |
| `unavailable-style` | Bouton present mais rendu non-actionable par CSS (jamais `disabled`) |

Parametres additionnels : `clearAfterMs` (rate-limited), `monthDelayMs` (navigation lente).

### Ajouter un nouveau scenario de fixture

1. Ajouter une fonction `renderXxx()` dans `appointment.html` qui peuple `#fixture-root` avec les **memes** `data-testid`/motifs de texte que la production — jamais une logique de detection simplifiee ou parallele.
2. Ajouter un cas dans le `switch (scenario)` en bas du fichier.
3. Documenter le scenario dans le commentaire d'en-tete du fichier ET dans le tableau ci-dessus.
4. Si le scenario doit rester deterministe entre deux executions, utiliser `sessionStorage`/un parametre de requete explicite plutot qu'un etat global — la fixture doit rester reinitialisable simplement en changeant l'URL (nouvelle query string), sans redemarrage de process.

Exigences non negociables de la fixture : zero acces Internet, aucune URL TLScontact, comportement deterministe piloté uniquement par la query string, aucune donnee sensible, aucun chemin absolu dependant de la machine de developpement (toujours resolue via `path.resolve(process.cwd(), ...)` + `pathToFileURL`).

## 3. Runners de regression finale

| Commande | Contenu | Environnement |
|---|---|---|
| `npm run test:phase4:final:simulated` | `tsc --noEmit`, Phase 1 (serialisation, revocation, appairage), Phase 2 backend/frontend, Phase 3 backend/frontend, Lot 3/4/5 simules, securite finale (Lot 6), bot-status simule | VM ou poste Windows, jamais de Chrome bot |
| `npm run test:phase4:final:real` | `test-agent-phase4-lot2.ts`, bot-status/VALIDATE_BOT/monitoring/resilience reels, executes **sequentiellement** (jamais en parallele) | PC Windows personnel avec session interactive uniquement |
| `npm run test:phase4:smoke` | `tsc --noEmit`, serialisation, bot-status simule (verification courte post-deploiement) | VM ou poste Windows |
| `npm run test:agent:soak:real` | Test de stabilite courte (section 9), duree via `AGENT_SOAK_TEST_DURATION_MINUTES` (defaut 10) | PC Windows personnel uniquement, jamais dans le smoke test (trop long) |

Chaque runner final ecrit un rapport JSON sanitise dans `artifacts/test-results/` (`phase4-final-simulated.json`, `phase4-final-real.json`, `phase4-smoke.json`), avec le nom de chaque suite, son statut, sa duree, et un total — jamais de secret, cookie, jeton, chemin sensible ou contenu HTML. Un depassement de delai (`TimeoutError`) n'est **jamais** converti en succes : le runner marque la suite en echec et continue vers les suivantes (le code de sortie final reste non-nul si au moins une suite a echoue).

`test-agent-phase4-lot2.ts` est deliberement EXCLU de `test:phase4:final:simulated` : ses deux suites ouvrent un vrai Chrome — il est execute uniquement via `test:phase4:final:real`, en categorie D.

## 4. Stabilite (flakiness)

Le runner `test:phase4:final:simulated` a ete execute **trois fois consecutives** dans le cadre du Lot 6, avec un baseline de processus propre (0 `node.exe`/`chrome.exe` residuel) verifie avant et apres chaque execution :

- Execution 1 : 283 succes, 0 echec
- Execution 2 : 283 succes, 0 echec
- Execution 3 : 283 succes, 0 echec

Un echec isole avait ete observe une fois pendant l'investigation (timeout de connexion socket dans `test-agent-bot-status-simulated.ts`), trace a des process `node.exe` orphelins issus d'une execution precedente interrompue manuellement pendant la session de travail — jamais reproduit apres nettoyage du baseline de processus, ni pendant les 3 executions consecutives retenues comme preuve de stabilite.

Bonnes pratiques deja en place et verifiees dans l'ensemble des scripts `test-agent-*-real.ts` :
- Diff de PID de reference (capture AVANT le test, filtrage strict) plutot qu'un "tuer tout ce qui s'appelle chrome.exe/node.exe".
- Attente par evenement/polling borne (`waitUntil`) plutot que des `sleep()` fixes utilises comme synchronisation.
- Ports de serveur de test dedies et distincts par script (3241-3298) pour eviter toute collision entre executions paralleles accidentelles.
- Nettoyage systematique en `finally` (serveur, agent, navigateur, fichiers temporaires, lignes DB identifiees par suffixe unique `Date.now()`).

## 5. Securite (voir aussi [agent-security.md](agent-security.md))

`scripts/test-agent-security-simulated.ts` (categorie B) verifie l'absence de sentinelles (`TEST_SECRET_*`) dans PostgreSQL/REST/Socket.IO/logs, la robustesse face a des payloads malformes/demesures, et l'absence de traversee de chemin dans la configuration d'extensions locales.

## 6. Cas particulier legacy_vm (categorie E)

`test-phase3-backend.ts` demarre un serveur separe avec `BOT_EXECUTION_MODE=legacy_vm` explicite (jamais omis, car le `.env` reel du poste peut definir `agent`) et verifie que Chrome se lance toujours normalement sur la VM, sans aucun garde-fou d'agent — dans le meme fichier que les scenarios `agent`, qui verifient l'inverse (aucun Chrome sur la VM). Aucun test separe n'est necessaire : les deux modes sont verifies cote a cote avec des serveurs distincts.
