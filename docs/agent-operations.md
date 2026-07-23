# Operations Agent (Phase 4)

Procedures pour l'exploitation quotidienne d'un Agent Windows en mode `BOT_EXECUTION_MODE=agent`, destinees a un operateur (pas necessairement developpeur).

## 1. Appairer un nouvel agent

1. Depuis l'interface web, page **Agents**, generer un code d'appairage (duree de vie limitee, voir `AGENT_PAIRING_CODE_TTL_MINUTES`).
2. Sur le PC Windows cible, avec Google Chrome installe : `npm run agent:dev -- pair <CODE>` (ou l'executable equivalent une fois la Phase 5 livree — non disponible dans ce lot).
3. Verifier dans l'interface que l'agent apparait `CONNECTED` puis `READY_FOR_COMMANDS` (icone/etat dans la page Agents).

## 2. Etats d'un agent

| Statut | Signification | Action operateur |
|---|---|---|
| `CONNECTED` (pas encore pret) | Socket etabli, synchronisation en cours | Attendre quelques secondes |
| `READY_FOR_COMMANDS` | Pret a recevoir `START_BOT`/`STOP_BOT`/`VALIDATE_BOT` | Aucune |
| `OFFLINE` | Heartbeat expire (perte reseau, PC eteint/veille, agent ferme) | Verifier que le PC et le processus agent sont bien actifs |
| Revoque | Agent retire manuellement, ne peut plus se reconnecter | Re-appairer si le PC doit reprendre du service |

## 3. Revoquer un agent

Depuis la page Agents, action "Revoquer". Un agent revoque qui tente de se reconnecter recoit un echec d'authentification definitif (jamais de boucle de reconnexion infinie cote agent) et doit etre re-appaire depuis zero pour reprendre du service.

## 4. Panne serveur / redemarrage

L'agent detecte la coupure, continue de faire tourner localement les bots deja `MONITORING` (ils ne s'arretent jamais a cause d'une simple coupure reseau), et tente une reconnexion avec un delai croissant (backoff progressif avec gigue). Au retour du serveur : synchronisation automatique (`AGENT_RUNTIME_STATUS`), reconstruction de l'etat des bots dans l'interface, et rejeu des evenements mis en attente localement (buffer borne, jamais illimite).

Aucune action operateur necessaire au-dela d'un rafraichissement de la page si l'interface ne se met pas a jour d'elle-meme apres quelques secondes.

## 5. Extensions locales par agence

Voir le README (section "Extensions d'enregistrement par agence") pour la procedure complete de preparation d'un profil Chrome avec extension. Cote agent, la configuration se trouve dans `<AGENT_DATA_DIR>/config/extensions.json` (jamais distribuee automatiquement — installation manuelle requise, y compris la confirmation Chrome Web Store).

## 6. Logs

- Logs agent : locaux au PC (`AGENT_DATA_DIR`), redaction automatique de tout champ sensible avant ecriture (voir [agent-security.md](agent-security.md)), rotation par taille (`AGENT_LOG_MAX_FILE_SIZE_MB`/`AGENT_LOG_MAX_FILES`).
- Logs serveur : console du process serveur (VM), jamais de secret grace au meme principe de redaction cote serveur.

## 7. Arret propre

- Arreter un bot individuel : bouton "Arreter" dans l'interface (`STOP_BOT`), ferme reellement le Chrome correspondant sur le poste agent.
- Arreter l'agent lui-meme : fermer le processus (`Ctrl+C` en mode `agent:dev`) — les bots en cours perdent leur supervision locale ; ils redeviennent visibles comme `OFFLINE` cote serveur jusqu'a reconnexion ou intervention manuelle.
- Arreter le serveur : bouton "Arreter le serveur" dans la section Maintenance de l'interface (voir README).

## 8. Diagnostic rapide

| Symptome | Verification |
|---|---|
| Un bot reste bloque en `WAITING_FOR_USER` | Verifier que la page cible est reellement prete cote agent (le bouton "Valider" ne doit etre clique qu'apres verification humaine complete, y compris CAPTCHA/connexion) |
| Agent jamais `READY_FOR_COMMANDS` | Verifier `AGENT_SERVER_URL` accessible depuis le PC agent, version agent compatible (`AGENT_MIN_VERSION` cote serveur) |
| Chrome ne se lance pas | Verifier `CHROME_EXECUTABLE_PATH` si Chrome n'est pas installe a l'emplacement standard, verifier qu'aucun profil n'est deja verrouille par un autre processus Chrome |
| Extension obligatoire manquante | Le demarrage du bot est refuse explicitement avec un message mentionnant l'extension — preparer l'extension avant de relancer |

## 9. Perimetre non couvert par ce lot

Aucun installeur, aucun service Windows, aucune mise a jour automatique. Voir [phase5-packaging-plan.md](phase5-packaging-plan.md) pour la suite prevue.
