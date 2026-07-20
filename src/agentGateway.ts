import { Server, Socket } from "socket.io";
import { AgentGatewayConfig } from "./config.js";
import { DbAgent } from "./db.js";
import {
  computeLiveStatus,
  getAgentById,
  redeemPairingCode,
  touchAgentSeen,
  toPublicAgent,
  verifyAgentToken,
  PublicAgent
} from "./agentService.js";
import { logger } from "./logger.js";

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

export const getSnapshotForAgent = async (
  agentId: number,
  config: AgentGatewayConfig
): Promise<AgentSnapshot | null> => {
  const agent = await getAgentById(agentId);
  return agent ? snapshotFromAgent(agent, config) : null;
};

export type AgentStatusListener = (agencyId: number, snapshot: AgentSnapshot) => void;

export const registerAgentNamespace = (
  io: Server,
  config: AgentGatewayConfig,
  onStatusChange: AgentStatusListener
): void => {
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
    })();

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
      })();
    });

    socket.on("AGENT_STATUS", () => {
      void (async () => {
        const agent = await getAgentById(agentId);
        if (agent) {
          onStatusChange(agencyId, snapshotFromAgent(agent, config));
        }
      })();
    });

    socket.on("disconnect", () => {
      connectedAgents.delete(agentId);
      logger.info(`Agent deconnecte: agentId=${agentId}, agencyId=${agencyId}`);
      void (async () => {
        const agent = await getAgentById(agentId);
        if (agent) {
          onStatusChange(agencyId, snapshotFromAgent(agent, config));
        }
      })();
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
    })();
  }, Math.max(5_000, Math.floor(config.offlineTimeoutMs / 2)));
};
