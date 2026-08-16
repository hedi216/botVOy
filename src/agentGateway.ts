import { Server, Socket } from "socket.io";
import { AgentCommandConfig, AgentGatewayConfig } from "./config.js";
import { DbAgent, DbAgentCommand } from "./db.js";
import {
  authenticateAgent,
  computeLiveStatus,
  getAgentById,
  redeemPairingCode,
  touchAgentSeen,
  toPublicAgent,
  PublicAgent,
  PublicAgentExtension
} from "./agentService.js";
import {
  AgentBotRecord,
  BotStatusValue,
  PublicAgentCommand,
  clearAckTimer,
  dispatchAgentCommand,
  failNonTerminalOnDisconnect,
  getAgentBot,
  getBotOwnershipHistory,
  getCommandForAgent,
  getLatestCommandForBot,
  isValidBotStatus,
  listAgentBotsForAgent,
  markAcknowledged,
  markCompleted,
  markFailedByAgent,
  registerAgentBot,
  sweepAgentCommands,
  toPublicAgentCommand,
  updateAgentBotStatus
} from "./agentCommandService.js";
import { logger } from "./logger.js";

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_ERROR_CODE_LENGTH = 64;

const clampString = (value: unknown, maxLength: number): string => {
  if (typeof value !== "string") {
    return "";
  }
  return value.slice(0, maxLength);
};

// Defense en profondeur: meme si un agent legitime ne devrait jamais envoyer
// de tel champ, un resultat/details ne doit jamais pouvoir vehiculer un
// secret vers la base ou vers l'interface web (cf. section 5 et 16).
//
// Lot 6 (audit final, section 7): CORRECTIF - cette liste ne couvrait que
// token/secret/password/code_hash/codehash. Un test de securite dedie a
// demontre qu'un champ nomme "cookie", "profilePath", "debugPort",
// "Authorization" ou "apiKey" glisse dans public_result/public_payload
// passait au travers SANS ETRE FILTRE (verifie present en base PostgreSQL
// et dans les reponses REST). Alignee desormais sur la liste (deja plus
// large) cote agent (agentLocalLogger.ts).
const FORBIDDEN_KEY_SUBSTRINGS = [
  "token", "secret", "password", "code_hash", "codehash",
  "cookie", "authorization", "profilepath", "debugport", "apikey", "api_key"
];

const sanitizePublicRecord = (value: unknown, depth = 0): unknown => {
  if (depth > 4 || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizePublicRecord(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_SUBSTRINGS.some((forbidden) => key.toLowerCase().includes(forbidden))) {
      continue;
    }
    result[key] = sanitizePublicRecord(nested, depth + 1);
  }
  return result;
};

// protocolVersion (Phase 5, Lot 2 - correctif protocole): obligatoire des
// deux cotes du handshake, jamais suppose implicitement egal a une valeur
// par defaut - un agent qui ne l'envoie pas est traite comme incompatible
// (voir middleware ci-dessous), jamais silencieusement accepte.
type PairAuth = { mode: "pair"; pairingCode: string; computerName: string; version: string; protocolVersion: number };
type ReconnectAuth = { mode: "reconnect"; agentId: number; token: string; computerName?: string; version: string; protocolVersion: number };
type AgentHandshakeAuth = PairAuth | ReconnectAuth;

// Alias conserve pour les modules qui importaient deja ce nom: la forme reelle
// (liste blanche stricte, jamais de token/token_hash) vient de toPublicAgent
// dans agentService.ts, source unique de verite pour toute sortie publique.
export type AgentSnapshot = PublicAgent;

type ConnectedAgent = {
  socket: Socket;
  activeBotCount: number;
  // Lot 5 (section 9): vrai seulement une fois AGENT_RUNTIME_STATUS traite
  // pour cette connexion. Aucune nouvelle commande ne doit etre dispatchee
  // avant (READY_FOR_COMMANDS), meme si le socket est deja techniquement
  // connecte.
  ready: boolean;
  // Lot 5 (section 14): dernier inventaire recu via AGENT_EXTENSION_STATUS.
  extensions: PublicAgentExtension[];
};

const connectedAgents = new Map<number, ConnectedAgent>();

// Frein anti brute-force sur l'appairage, independant du compteur par code deja
// applique dans redeemPairingCode: limite le nombre de tentatives par adresse IP
// source, quel que soit le code essaye.
const pairingAttemptsByIp = new Map<string, { count: number; windowStartedAt: number }>();
const PAIRING_IP_WINDOW_MS = 15 * 60 * 1000;
const PAIRING_IP_MAX_ATTEMPTS = 20;

const isIpRateLimited = (ip: string): boolean => {
  const entry = pairingAttemptsByIp.get(ip);
  const now = Date.now();

  if (!entry || now - entry.windowStartedAt > PAIRING_IP_WINDOW_MS) {
    pairingAttemptsByIp.set(ip, { count: 1, windowStartedAt: now });
    return false;
  }

  entry.count += 1;
  return entry.count > PAIRING_IP_MAX_ATTEMPTS;
};

const snapshotFromAgent = (agent: DbAgent, config: AgentGatewayConfig): AgentSnapshot =>
  toPublicAgent(
    agent,
    computeLiveStatus(agent, connectedAgents.has(agent.id), config),
    connectedAgents.get(agent.id)?.activeBotCount ?? 0,
    connectedAgents.get(agent.id)?.ready ?? false,
    connectedAgents.get(agent.id)?.extensions ?? []
  );

export const isAgentConnected = (agentId: number): boolean => connectedAgents.has(agentId);

export const getConnectedAgentSocket = (agentId: number): Socket | undefined =>
  connectedAgents.get(agentId)?.socket;

// Lot 5 (section 9): distinct de isAgentConnected - un agent peut etre
// techniquement connecte (socket ouvert) mais pas encore synchronise
// (AGENT_RUNTIME_STATUS pas encore traite). Les appelants (server.ts)
// doivent verifier ceci avant de dispatcher une NOUVELLE commande.
export const isAgentReadyForCommands = (agentId: number): boolean =>
  connectedAgents.get(agentId)?.ready ?? false;

// Utilise par la revocation (server.ts): coupe le socket actif d'un agent.
// Le handler "disconnect" existant (plus bas) se declenche normalement a la
// suite et nettoie l'etat en memoire; les commandes non terminales doivent
// deja avoir ete marquees AGENT_REVOKED par l'appelant avant ce coup de coupe,
// pour porter ce code d'erreur precis plutot que AGENT_DISCONNECTED.
export const disconnectAgentSocket = (agentId: number): void => {
  connectedAgents.get(agentId)?.socket.disconnect(true);
};

export const getSnapshotForAgent = async (
  agentId: number,
  config: AgentGatewayConfig
): Promise<AgentSnapshot | null> => {
  const agent = await getAgentById(agentId);
  return agent ? snapshotFromAgent(agent, config) : null;
};

export type AgentStatusListener = (agencyId: number, snapshot: AgentSnapshot) => void;
export type AgentCommandChangeListener = (agencyId: number, publicCommand: PublicAgentCommand) => void;
export type BotLogListener = (
  agencyId: number,
  botId: string,
  botName: string,
  level: "info" | "warn" | "error" | "success",
  message: string
) => void;

export type AgentNamespaceCallbacks = {
  onStatusChange: AgentStatusListener;
  onCommandChange: AgentCommandChangeListener;
  onBotLog: BotLogListener;
};

const publicCommandFor = (command: DbAgentCommand): PublicAgentCommand => toPublicAgentCommand(command);

// Une erreur (DB, reseau...) dans l'un de ces gestionnaires asynchrones ne
// doit jamais devenir une rejection de promesse non geree: Node arreterait
// alors tout le process serveur pour un seul message malforme ou un blip DB
// passager, ce qui affecterait TOUTES les agences, pas seulement celle en
// cause. Chaque chaine async ci-dessous est donc systematiquement terminee
// par ce filet de securite.
const logAsyncError = (context: string) => (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`agentGateway (${context}): ${message}`);
};

// COMMAND_ACK, BOT_STATUS (repete plusieurs fois) et COMMAND_COMPLETED/FAILED
// d'une MEME commande sont chacun geres par un handler independant, chacun
// avec son propre aller-retour DB. Un agent reel les emet en succession quasi
// immediate (ex. BOT_STATUS WAITING_FOR_USER puis COMMAND_COMPLETED sans le
// moindre delai): rien ne garantit qu'une requete SELECT (BOT_STATUS) se
// termine avant une requete UPDATE (COMMAND_COMPLETED) lancee juste apres,
// meme si l'evenement a ete RECU en premier. Sans serialisation, la diffusion
// la plus recente peut alors porter un botStatus perime, voire une commande
// peut rester bloquee (COMPLETED reçu avant que ACK n'ait fini d'etre
// applique). Confirme empiriquement: sur 30 iterations rapprochees, ~17%
// finissaient avec un etat incoherent avant ce correctif.
//
// Chaque commandId a donc sa propre file FIFO: le traitement complet d'un
// evenement (DB + diffusion) doit se terminer avant que le traitement du
// suivant, pour LE MEME commandId, ne commence — quel que soit le temps que
// prend chaque requete DB individuellement.
const commandEventQueues = new Map<string, Promise<void>>();

// Retourne desormais la promesse de fin de traitement (Lot 5): permet a
// BOT_STATUS d'accuser reception aupres du CLIENT uniquement une fois le
// traitement (DB + diffusion) reellement termine, pour que le buffer hors
// ligne de l'agent ne retire un evenement qu'apres confirmation reelle
// (section 5, etape 5).
const enqueueCommandEvent = (commandId: string, task: () => Promise<void>): Promise<void> => {
  const previous = commandEventQueues.get(commandId) ?? Promise.resolve();
  const next = previous.then(task, task).catch(logAsyncError("command-event-queue")).finally(() => {
    if (commandEventQueues.get(commandId) === next) {
      commandEventQueues.delete(commandId);
    }
  });
  commandEventQueues.set(commandId, next);
  return next;
};

// Lot 5 (section 5): dedup par eventId, bornee (les eventId sont ephemeres,
// perdus au redemarrage serveur comme le reste de l'etat en memoire de ce
// module - coherent avec le choix deja fait pour agentBots).
const MAX_PROCESSED_EVENT_IDS = 2_000;
const processedBotStatusEventIds = new Set<string>();
const processedEventIdOrder: string[] = [];

const rememberProcessedEventId = (eventId: string): void => {
  processedBotStatusEventIds.add(eventId);
  processedEventIdOrder.push(eventId);
  if (processedEventIdOrder.length > MAX_PROCESSED_EVENT_IDS) {
    const oldest = processedEventIdOrder.shift();
    if (oldest) {
      processedBotStatusEventIds.delete(oldest);
    }
  }
};

export const registerAgentNamespace = (
  io: Server,
  config: AgentGatewayConfig,
  commandConfig: AgentCommandConfig,
  callbacks: AgentNamespaceCallbacks
): void => {
  const { onStatusChange, onCommandChange, onBotLog } = callbacks;
  const namespace = io.of("/agent");

  namespace.use(async (socket, next) => {
    const auth = socket.handshake.auth as Partial<AgentHandshakeAuth> | undefined;
    const remoteIp = socket.handshake.address;

    if (!auth?.mode) {
      next(new Error("INVALID_AUTH_MODE"));
      return;
    }

    // Phase 5 (Lot 2 - correctif protocole, plage bornee): negociation de
    // protocole AVANT toute authentification, pour les deux modes. Rejette
    // explicitement: absence, type non numerique (string/objet/booleen),
    // decimal, NaN, Infinity, negatif, trop ancien (< minProtocolVersion) ET
    // trop recent (> maxProtocolVersion) - un plancher seul acceptait
    // implicitement toute version future, jamais une intention explicite
    // pour un champ de compatibilite. Jamais de dependance a src/agent (le
    // serveur declare sa propre plage, independamment de
    // agentVersionInfo.json cote agent). Rejete avant redeemPairingCode: un
    // agent incompatible ne consomme jamais un code d'appairage valide.
    const protocolVersion = (auth as Partial<AgentHandshakeAuth>).protocolVersion;
    const protocolVersionValid = typeof protocolVersion === "number"
      && Number.isInteger(protocolVersion)
      && protocolVersion >= 0
      && protocolVersion >= config.minProtocolVersion
      && protocolVersion <= config.maxProtocolVersion;
    if (!protocolVersionValid) {
      next(new Error("VERSION_INCOMPATIBLE"));
      return;
    }

    if (auth.mode === "pair") {
      if (isIpRateLimited(remoteIp)) {
        next(new Error("TOO_MANY_ATTEMPTS"));
        return;
      }

      const { pairingCode, computerName, version } = auth as PairAuth;
      if (!pairingCode || !computerName || !version) {
        next(new Error("INVALID_AUTH_MODE"));
        return;
      }

      const result = await redeemPairingCode(pairingCode, computerName, version, config);
      if (!result.ok) {
        next(new Error(result.reason));
        return;
      }

      socket.data.agentId = result.agentId;
      socket.data.agencyId = result.agencyId;
      socket.data.issuedToken = result.token;
      next();
      return;
    }

    if (auth.mode === "reconnect") {
      const { agentId, token, version } = auth as ReconnectAuth;
      if (!agentId || !token || !version) {
        next(new Error("INVALID_AUTH_MODE"));
        return;
      }

      const authResult = await authenticateAgent(agentId, token);
      if (!authResult.ok) {
        next(new Error(authResult.reason));
        return;
      }

      socket.data.agentId = authResult.agent.id;
      socket.data.agencyId = authResult.agent.agency_id;
      next();
      return;
    }

    next(new Error("INVALID_AUTH_MODE"));
  });

  // Section 7: reponse commune aux deux cas ou un bot deja STOPPED cote
  // serveur (registre en memoire encore present, ou historique DB) est
  // rapporte actif par un agent - jamais reactive silencieusement, toujours
  // reconvergence via un nouveau STOP_BOT (au cas ou le precedent n'aurait
  // jamais atteint l'agent, ex. deconnexion juste avant reception).
  // clientRequestId groupe par heure: reessaie automatiquement d'heure en
  // heure si la premiere tentative echoue, sans spammer l'agent entre-temps.
  const forceStopForReconciliation = async (
    agencyId: number,
    agentId: number,
    botId: string,
    ownerUserId: number
  ): Promise<void> => {
    logger.warn(`Bot ${botId} rapporte actif par l'agent mais deja STOPPED cote serveur: renvoi de STOP_BOT pour reconciliation.`);
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    await dispatchAgentCommand(
      {
        agencyId,
        agentId,
        botId,
        type: "STOP_BOT",
        publicPayload: {},
        createdByUserId: ownerUserId,
        clientRequestId: `resync-stop-${botId}-${hourBucket}`
      },
      {
        config: commandConfig,
        getAgentSocket: getConnectedAgentSocket,
        onChange: (updatedCommand) => onCommandChange(updatedCommand.agency_id, publicCommandFor(updatedCommand))
      }
    ).catch(logAsyncError("resync-stop"));
  };

  namespace.on("connection", (socket) => {
    const agentId = socket.data.agentId as number;
    const agencyId = socket.data.agencyId as number;
    const issuedToken = socket.data.issuedToken as string | undefined;

    connectedAgents.set(agentId, { socket, activeBotCount: 0, ready: false, extensions: [] });
    logger.info(`Agent connecte: agentId=${agentId}, agencyId=${agencyId}`);

    void (async () => {
      const auth = socket.handshake.auth as AgentHandshakeAuth;
      await touchAgentSeen(agentId, auth.version);
      const agent = await getAgentById(agentId);
      if (agent) {
        onStatusChange(agencyId, snapshotFromAgent(agent, config));
      }
    })().catch(logAsyncError("connection"));

    socket.emit("AGENT_CONNECTED", {
      agentId,
      agencyId,
      token: issuedToken ?? null,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      offlineTimeoutMs: config.offlineTimeoutMs
    });

    socket.on("AGENT_HEARTBEAT", (payload?: { version?: string; activeBotCount?: number }) => {
      void (async () => {
        await touchAgentSeen(agentId, payload?.version);
        const entry = connectedAgents.get(agentId);
        if (entry && typeof payload?.activeBotCount === "number") {
          entry.activeBotCount = Math.max(0, Math.trunc(payload.activeBotCount));
        }

        const agent = await getAgentById(agentId);
        if (agent) {
          onStatusChange(agencyId, snapshotFromAgent(agent, config));
        }
      })().catch(logAsyncError("AGENT_HEARTBEAT"));
    });

    socket.on("AGENT_STATUS", () => {
      void (async () => {
        const agent = await getAgentById(agentId);
        if (agent) {
          onStatusChange(agencyId, snapshotFromAgent(agent, config));
        }
      })().catch(logAsyncError("AGENT_STATUS"));
    });

    // ---- Section 9: accuses de reception. L'identite de l'agent vient
    // exclusivement de socket.data.agentId (issu de l'authentification de la
    // connexion), jamais d'un champ agentId qui serait fourni dans le payload:
    // getCommandForAgent()/markXxx() exigent toujours agentId en parametre
    // separe et le verifient en base (agent_id = $2 dans la clause WHERE). ----

    socket.on("COMMAND_ACK", (payload?: { commandId?: unknown }) => {
      const commandId = clampString(payload?.commandId, 100);
      if (!commandId) {
        return;
      }

      enqueueCommandEvent(commandId, async () => {
        const { command } = await markAcknowledged(commandId, agentId);
        if (command) {
          clearAckTimer(command.command_id);
          onCommandChange(command.agency_id, publicCommandFor(command));
        }
      });
    });

    socket.on("COMMAND_COMPLETED", (payload?: { commandId?: unknown; result?: unknown }) => {
      const commandId = clampString(payload?.commandId, 100);
      if (!commandId) {
        return;
      }

      const safeResult = sanitizePublicRecord(payload?.result ?? {});
      enqueueCommandEvent(commandId, async () => {
        const { command } = await markCompleted(commandId, agentId, safeResult);
        if (command) {
          onCommandChange(command.agency_id, publicCommandFor(command));
        }
      });
    });

    socket.on("COMMAND_FAILED", (payload?: { commandId?: unknown; errorCode?: unknown; message?: unknown }) => {
      const commandId = clampString(payload?.commandId, 100);
      if (!commandId) {
        return;
      }

      const errorCode = clampString(payload?.errorCode, MAX_ERROR_CODE_LENGTH) || "ENGINE_ERROR";
      const message = clampString(payload?.message, MAX_MESSAGE_LENGTH) || "Commande echouee cote agent.";
      enqueueCommandEvent(commandId, async () => {
        const { command } = await markFailedByAgent(commandId, agentId, errorCode, message);
        if (command) {
          onCommandChange(command.agency_id, publicCommandFor(command));
        }
      });
    });

    // ---- Section 11: statuts de bot. La commande sert de preuve
    // d'appartenance: on ne met a jour un botId que s'il correspond bien au
    // bot_id enregistre sur la commande possedee par CET agent. ----

    socket.on("BOT_STATUS", (
      payload?: { commandId?: unknown; botId?: unknown; status?: unknown; details?: unknown; eventId?: unknown },
      ackCallback?: (response: { ok: boolean }) => void
    ) => {
      const commandId = clampString(payload?.commandId, 100);
      const botId = clampString(payload?.botId, 100);
      const eventId = clampString(payload?.eventId, 100);
      if (!commandId || !botId || !isValidBotStatus(payload?.status)) {
        ackCallback?.({ ok: false });
        return;
      }

      // Lot 5 (section 5): un evenement deja traite (rejeu depuis le buffer
      // hors ligne apres une reconnexion, ex. accuse de reception perdu en
      // cours de route) est confirme sans etre re-applique - jamais deux
      // logs/diffusions pour le meme eventId.
      if (eventId && processedBotStatusEventIds.has(eventId)) {
        ackCallback?.({ ok: true });
        return;
      }

      enqueueCommandEvent(commandId, async () => {
        const command = await getCommandForAgent(commandId, agentId);
        if (!command || command.bot_id !== botId) {
          return;
        }

        const bot = updateAgentBotStatus(botId, payload!.status as BotStatusValue);
        if (!bot) {
          return;
        }

        onCommandChange(command.agency_id, publicCommandFor(command));

        const detailsText = payload?.details && typeof payload.details === "object"
          ? ` ${JSON.stringify(sanitizePublicRecord(payload.details)).slice(0, 300)}`
          : "";
        onBotLog(command.agency_id, botId, bot.botName, "info", `[Agent] Statut du bot: ${bot.botStatus}${detailsText}`);

        if (eventId) {
          rememberProcessedEventId(eventId);
        }
      }).then(
        () => ackCallback?.({ ok: true }),
        () => ackCallback?.({ ok: false })
      );
    });

    // ---- Lot 5 (section 6/7/8/9): resynchronisation. Envoye par l'agent
    // immediatement apres chaque (re)connexion authentifiee, avec le
    // snapshot de ses bots locaux actifs. Reconstruit agentBots quand ce
    // process serveur l'a perdu (redemarrage), sans jamais faire confiance
    // au payload pour l'appartenance (agencyId/ownerUserId/botName/category
    // viennent toujours de l'historique DB, jamais de l'agent). Marque
    // ensuite l'agent READY_FOR_COMMANDS. ----
    socket.on("AGENT_RUNTIME_STATUS", (payload?: { sentAt?: unknown; bots?: unknown }) => {
      void (async () => {
        const rawBots = Array.isArray(payload?.bots) ? payload.bots : [];
        const touchedBotIds = new Set<string>();

        for (const rawBot of rawBots) {
          if (!rawBot || typeof rawBot !== "object") {
            continue;
          }
          const botId = clampString((rawBot as Record<string, unknown>).botId, 100);
          const status = (rawBot as Record<string, unknown>).status;
          if (!botId || !isValidBotStatus(status)) {
            continue;
          }

          const existing = getAgentBot(botId);

          if (existing) {
            if (existing.agentId !== agentId) {
              // Section 8: deux agents annoncent le meme bot. Conserver le
              // proprietaire legitime deja enregistre, ignorer ce rapport,
              // signaler le conflit (jamais un choix silencieux du dernier
              // evenement recu).
              logger.warn(`RUNTIME_OWNERSHIP_CONFLICT: bot ${botId} deja possede par agentId=${existing.agentId}, egalement rapporte par agentId=${agentId}.`);
              onBotLog(agencyId, botId, existing.botName, "warn", "Conflit de propriete detecte pour ce bot (RUNTIME_OWNERSHIP_CONFLICT): rapport ignore.");
              continue;
            }

            if (existing.botStatus === "STOPPED") {
              // Section 7: le registre en memoire n'est JAMAIS purge apres un
              // STOP_BOT reussi (l'entree reste, active=false) - sans cette
              // verification explicite, la branche "meme agent -> autorite"
              // ci-dessous accepterait aveuglement un rapport ulterieur
              // pretendant ce bot de nouveau MONITORING, le reactivant a
              // tort. Un bot deja STOPPED ne doit jamais l'etre "un peu
              // moins": on redemande sa fermeture reelle pour converger.
              await forceStopForReconciliation(existing.agencyId, agentId, botId, existing.ownerUserId);
              continue;
            }

            // Section 8: l'agent est l'autorite pour son etat runtime
            // courant (navigateur reellement ouvert, boucle active).
            updateAgentBotStatus(botId, status as BotStatusValue);
            touchedBotIds.add(botId);
            continue;
          }

          // Bot inconnu du registre en memoire de CE process serveur
          // (redemarrage serveur, ou premiere fois qu'il voit ce bot):
          // reconstruction a partir de l'historique DB uniquement.
          const history = await getBotOwnershipHistory(botId, agentId);
          if (!history) {
            // Jamais vu par ce serveur pour cet agent: rien a reconstruire,
            // signale proprement plutot qu'ignore silencieusement.
            logger.warn(`AGENT_RUNTIME_STATUS: bot ${botId} inconnu (aucun START_BOT trouve pour agentId=${agentId}). Ignore.`);
            continue;
          }

          if (history.everStopped) {
            // Section 7: ne jamais reactiver un bot deja explicitement
            // arrete cote serveur. Un botId n'est jamais reutilise: "deja
            // arrete un jour" signifie "arrete pour toujours".
            await forceStopForReconciliation(history.agencyId, agentId, botId, history.ownerUserId);
            continue;
          }

          const record: AgentBotRecord = {
            botId,
            agentId,
            agencyId: history.agencyId,
            ownerUserId: history.ownerUserId,
            botName: history.botName,
            category: history.category,
            latestCommandId: "",
            botStatus: null,
            botStatusUpdatedAt: null,
            active: true,
            updatedAt: new Date().toISOString()
          };
          registerAgentBot(record);
          updateAgentBotStatus(botId, status as BotStatusValue);
          touchedBotIds.add(botId);
          onBotLog(history.agencyId, botId, history.botName, "info", `Bot resynchronise apres reconnexion/redemarrage serveur (statut: ${status}).`);
        }

        // CORRECTIF CIBLE (bots fantomes apres reboot/coupure Agent):
        // reconciliation INVERSE - la boucle ci-dessus ne traite que les bots
        // PRESENTS dans l'inventaire recu (mise a jour/reconstruction/
        // conflit). Un AgentBotRecord pas encore STOPPED mais appartenant
        // EXACTEMENT a CET agentId (jamais un autre agent de la meme agence)
        // et ABSENT de cet inventaire n'a plus de runtime reel: cet agent
        // vient de fournir un inventaire FAISANT AUTORITE pour lui-meme (y
        // compris un inventaire VIDE, qui est une information valide - "cet
        // agent n'a actuellement aucun bot runtime" - jamais interprete comme
        // une absence d'information). Reutilise updateAgentBotStatus() /
        // touchedBotIds existants: meme mecanisme de diffusion que le reste
        // de ce handler, jamais un nouveau STOP_BOT dispatche (rien ne reste
        // a arreter cote agent, qui a deja perdu ce runtime).
        const reportedBotIds = new Set(
          rawBots
            .filter((rawBot): rawBot is Record<string, unknown> => Boolean(rawBot) && typeof rawBot === "object")
            .map((rawBot) => clampString(rawBot.botId, 100))
            .filter((botId) => botId.length > 0)
        );
        for (const bot of listAgentBotsForAgent(agentId)) {
          if (bot.botStatus === "STOPPED" || reportedBotIds.has(bot.botId)) {
            continue;
          }
          updateAgentBotStatus(bot.botId, "STOPPED");
          touchedBotIds.add(bot.botId);
          logger.warn(`Reconciliation Agent ${agentId}: bot ${bot.botId} absent de l'inventaire runtime actuel -> STOPPED.`);
        }

        // Diffuse l'objet public a jour de chaque bot touche, pour que
        // l'interface web reconstruise ses boutons sans attendre un futur
        // evenement (section 7: "un bot reellement MONITORING doit
        // reapparaitre comme MONITORING dans l'interface").
        for (const botId of touchedBotIds) {
          const latest = await getLatestCommandForBot(botId);
          if (latest) {
            onCommandChange(latest.agency_id, publicCommandFor(latest));
          }
        }

        // Section 9: READY_FOR_COMMANDS seulement maintenant que la
        // reconciliation est terminee.
        const entry = connectedAgents.get(agentId);
        if (entry) {
          entry.ready = true;
        }
        const agent = await getAgentById(agentId);
        if (agent) {
          onStatusChange(agencyId, snapshotFromAgent(agent, config));
        }
      })().catch(logAsyncError("AGENT_RUNTIME_STATUS"));
    });

    // Lot 5 (section 14): inventaire public des extensions locales - jamais
    // de chemin ni de raison detaillee (deja garanti cote agent), seulement
    // id/configured/valid/version. Stocke en memoire (perdu a la
    // deconnexion, comme le reste du registre connectedAgents).
    socket.on("AGENT_EXTENSION_STATUS", (payload?: { extensions?: unknown }) => {
      const entry = connectedAgents.get(agentId);
      if (!entry) {
        return;
      }
      const rawExtensions = Array.isArray(payload?.extensions) ? payload.extensions : [];
      entry.extensions = rawExtensions
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .slice(0, 50)
        .map((item) => ({
          id: clampString(item.id, 100),
          configured: item.configured === true,
          valid: item.valid === true,
          version: typeof item.version === "string" ? item.version.slice(0, 50) : null
        }))
        .filter((item) => item.id.length > 0);

      void (async () => {
        const agent = await getAgentById(agentId);
        if (agent) {
          onStatusChange(agencyId, snapshotFromAgent(agent, config));
        }
      })().catch(logAsyncError("AGENT_EXTENSION_STATUS"));
    });

    socket.on("disconnect", () => {
      connectedAgents.delete(agentId);
      logger.info(`Agent deconnecte: agentId=${agentId}, agencyId=${agencyId}`);
      void (async () => {
        const agent = await getAgentById(agentId);
        if (agent) {
          onStatusChange(agencyId, snapshotFromAgent(agent, config));
        }

        // Une commande START_BOT/STOP_BOT/VALIDATE_BOT en cours ne doit jamais
        // rester bloquee indefiniment parce que son agent a disparu: on la
        // fait echouer avec un code distinct selon qu'elle avait deja ete
        // accusee reception ou non (cf. section 10). Si l'agent a ete
        // explicitement revoque, failNonTerminalOnRevoke() a deja marque ces
        // commandes plus tot (server.ts): les clauses WHERE status=... ici ne
        // trouvent alors plus rien a modifier, sans ecraser AGENT_REVOKED.
        const failedCommands = await failNonTerminalOnDisconnect(agentId);
        for (const command of failedCommands) {
          clearAckTimer(command.command_id);
          onCommandChange(command.agency_id, publicCommandFor(command));
        }
      })().catch(logAsyncError("disconnect"));
    });
  });

  // Balayage periodique: meme sans evenement recu, un agent dont le heartbeat a
  // expire doit passer OFFLINE aux yeux des clients web sans attendre sa prochaine
  // action. Le socket peut rester techniquement ouvert (perte reseau partielle).
  setInterval(() => {
    void (async () => {
      for (const [agentId] of connectedAgents) {
        const agent = await getAgentById(agentId);
        if (!agent) {
          continue;
        }

        const snapshot = snapshotFromAgent(agent, config);
        if (snapshot.status === "OFFLINE") {
          onStatusChange(agent.agency_id, snapshot);
        }
      }
    })().catch(logAsyncError("offline-sweep"));
  }, Math.max(5_000, Math.floor(config.offlineTimeoutMs / 2)));

  // Filet de securite pour l'expiration/l'accuse de reception, y compris a
  // travers un redemarrage serveur (cf. section 10): base sur les colonnes en
  // base (sent_at, expires_at), independant des minuteurs en memoire.
  setInterval(() => {
    sweepAgentCommands(commandConfig, (command) => {
      onCommandChange(command.agency_id, publicCommandFor(command));
    }).catch(logAsyncError("command-sweep"));
  }, commandConfig.sweepIntervalMs);
};
