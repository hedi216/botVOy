import { Server, Socket } from "socket.io";
import { AgentCommandConfig, AgentGatewayConfig } from "./config.js";
import { DbAgent, DbAgentCommand } from "./db.js";
import {
  computeLiveStatus,
  getAgentById,
  redeemPairingCode,
  touchAgentSeen,
  toPublicAgent,
  verifyAgentToken,
  PublicAgent
} from "./agentService.js";
import {
  BotStatusValue,
  PublicAgentCommand,
  clearAckTimer,
  failNonTerminalOnDisconnect,
  getCommandForAgent,
  isValidBotStatus,
  markAcknowledged,
  markCompleted,
  markFailedByAgent,
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
const FORBIDDEN_KEY_SUBSTRINGS = ["token", "secret", "password", "code_hash", "codehash"];

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

type PairAuth = { mode: "pair"; pairingCode: string; computerName: string; version: string };
type ReconnectAuth = { mode: "reconnect"; agentId: number; token: string; computerName?: string; version: string };
type AgentHandshakeAuth = PairAuth | ReconnectAuth;

// Alias conserve pour les modules qui importaient deja ce nom: la forme reelle
// (liste blanche stricte, jamais de token/token_hash) vient de toPublicAgent
// dans agentService.ts, source unique de verite pour toute sortie publique.
export type AgentSnapshot = PublicAgent;

type ConnectedAgent = {
  socket: Socket;
  activeBotCount: number;
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
    connectedAgents.get(agent.id)?.activeBotCount ?? 0
  );

export const isAgentConnected = (agentId: number): boolean => connectedAgents.has(agentId);

export const getConnectedAgentSocket = (agentId: number): Socket | undefined =>
  connectedAgents.get(agentId)?.socket;

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

      const agent = await verifyAgentToken(agentId, token);
      if (!agent) {
        next(new Error("INVALID_TOKEN"));
        return;
      }

      socket.data.agentId = agent.id;
      socket.data.agencyId = agent.agency_id;
      next();
      return;
    }

    next(new Error("INVALID_AUTH_MODE"));
  });

  namespace.on("connection", (socket) => {
    const agentId = socket.data.agentId as number;
    const agencyId = socket.data.agencyId as number;
    const issuedToken = socket.data.issuedToken as string | undefined;

    connectedAgents.set(agentId, { socket, activeBotCount: 0 });
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

      markAcknowledged(commandId, agentId).then(({ command }) => {
        if (command) {
          clearAckTimer(command.command_id);
          onCommandChange(command.agency_id, publicCommandFor(command));
        }
      }).catch(logAsyncError("COMMAND_ACK"));
    });

    socket.on("COMMAND_COMPLETED", (payload?: { commandId?: unknown; result?: unknown }) => {
      const commandId = clampString(payload?.commandId, 100);
      if (!commandId) {
        return;
      }

      const safeResult = sanitizePublicRecord(payload?.result ?? {});
      markCompleted(commandId, agentId, safeResult).then(({ command }) => {
        if (command) {
          onCommandChange(command.agency_id, publicCommandFor(command));
        }
      }).catch(logAsyncError("COMMAND_COMPLETED"));
    });

    socket.on("COMMAND_FAILED", (payload?: { commandId?: unknown; errorCode?: unknown; message?: unknown }) => {
      const commandId = clampString(payload?.commandId, 100);
      if (!commandId) {
        return;
      }

      const errorCode = clampString(payload?.errorCode, MAX_ERROR_CODE_LENGTH) || "ENGINE_ERROR";
      const message = clampString(payload?.message, MAX_MESSAGE_LENGTH) || "Commande echouee cote agent.";
      markFailedByAgent(commandId, agentId, errorCode, message).then(({ command }) => {
        if (command) {
          onCommandChange(command.agency_id, publicCommandFor(command));
        }
      }).catch(logAsyncError("COMMAND_FAILED"));
    });

    // ---- Section 11: statuts de bot. La commande sert de preuve
    // d'appartenance: on ne met a jour un botId que s'il correspond bien au
    // bot_id enregistre sur la commande possedee par CET agent. ----

    socket.on("BOT_STATUS", (payload?: { commandId?: unknown; botId?: unknown; status?: unknown; details?: unknown }) => {
      const commandId = clampString(payload?.commandId, 100);
      const botId = clampString(payload?.botId, 100);
      if (!commandId || !botId || !isValidBotStatus(payload?.status)) {
        return;
      }

      getCommandForAgent(commandId, agentId).then((command) => {
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
      }).catch(logAsyncError("BOT_STATUS"));
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
