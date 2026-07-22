import { io as ioClient, Socket } from "socket.io-client";
import { loadStoredCredentials, saveStoredCredentials } from "./agentStorage.js";
import { AgentLogFn, redactForLog } from "./agentLocalLogger.js";
import { AgentCommandEnvelope, AgentRuntimeSettings, StoredAgentCredentials } from "./types.js";

// Reprend exactement le protocole reel de src/agentGateway.ts (namespace
// /agent, formes d'auth "pair"/"reconnect", evenements AGENT_CONNECTED /
// AGENT_HEARTBEAT / AGENT_COMMAND / COMMAND_ACK / COMMAND_COMPLETED /
// COMMAND_FAILED / BOT_STATUS), deja valide par scripts/test-agent-phase1.ts
// et scripts/test-agent-phase3.ts. Contrairement a ces scripts de simulation,
// ce client est le runtime reel: reconnection automatique activee, et jamais
// de faux succes simule.
export type AgentClientCallbacks = {
  onCommand: (command: AgentCommandEnvelope) => void;
  onConnectionChange?: (connected: boolean) => void;
};

export class AgentClient {
  private socket: Socket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private activeBotCountProvider: () => number = () => 0;

  constructor(
    private readonly settings: AgentRuntimeSettings,
    private readonly log: AgentLogFn,
    private readonly callbacks: AgentClientCallbacks
  ) {}

  setActiveBotCountProvider(provider: () => number): void {
    this.activeBotCountProvider = provider;
  }

  // pairingCode fourni -> premier appairage. Sinon, reprend les credentials
  // deja stockes (mode reconnect). Ne cree jamais un second mecanisme
  // d'appairage: meme fichier, meme forme que scripts/test-agent-phase1.ts.
  async start(pairingCode?: string): Promise<void> {
    if (pairingCode) {
      this.connectWithAuth({
        mode: "pair",
        pairingCode,
        computerName: this.settings.computerName,
        version: this.settings.version
      });
      return;
    }

    const stored = loadStoredCredentials(this.settings);
    if (!stored) {
      throw new Error(
        `Aucun agent appaire (${this.settings.credentialsPath} introuvable). ` +
        "Lancez d'abord: npm run agent:dev -- pair <CODE_APPARIEMENT>"
      );
    }

    this.connectWithAuth({
      mode: "reconnect",
      agentId: stored.agentId,
      token: stored.token,
      computerName: stored.computerName,
      version: stored.version
    });
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.socket?.disconnect();
    this.socket = null;
  }

  sendAck(commandId: string): void {
    this.socket?.emit("COMMAND_ACK", { commandId, receivedAt: new Date().toISOString() });
  }

  sendCompleted(commandId: string, result: unknown): void {
    this.socket?.emit("COMMAND_COMPLETED", {
      commandId,
      completedAt: new Date().toISOString(),
      result: redactForLog(result)
    });
  }

  sendFailed(commandId: string, errorCode: string, message: string): void {
    this.socket?.emit("COMMAND_FAILED", {
      commandId,
      failedAt: new Date().toISOString(),
      errorCode,
      message
    });
  }

  sendBotStatus(commandId: string, botId: string, status: string, details?: unknown): void {
    this.socket?.emit("BOT_STATUS", {
      commandId,
      botId,
      status,
      timestamp: new Date().toISOString(),
      details: details ? redactForLog(details) : undefined
    });
  }

  private connectWithAuth(auth: Record<string, unknown>): void {
    const socket = ioClient(`${this.settings.serverUrl}/agent`, {
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 2_000,
      reconnectionDelayMax: 30_000,
      auth
    });
    this.socket = socket;

    socket.on("connect", () => {
      this.log("success", `Connecte a ${this.settings.serverUrl}/agent.`);
    });

    socket.on("connect_error", (error: Error) => {
      this.log("error", `Connexion refusee: ${error.message}`);
    });

    socket.on("disconnect", (reason: string) => {
      this.log("warn", `Deconnecte du serveur: ${reason}`);
      this.callbacks.onConnectionChange?.(false);
    });

    socket.io.on("reconnect_attempt", (attempt: number) => {
      this.log("info", `Tentative de reconnexion n°${attempt}...`);
    });

    socket.on("AGENT_CONNECTED", (payload: {
      agentId: number;
      agencyId: number;
      token: string | null;
      heartbeatIntervalMs: number;
      offlineTimeoutMs: number;
    }) => {
      this.log("success", `AGENT_CONNECTED (agentId=${payload.agentId}, agencyId=${payload.agencyId}).`);

      if (payload.token) {
        const stored: StoredAgentCredentials = {
          agentId: payload.agentId,
          token: payload.token,
          agencyId: payload.agencyId,
          computerName: this.settings.computerName,
          displayName: this.settings.computerName,
          version: this.settings.version,
          pairedAt: new Date().toISOString()
        };
        saveStoredCredentials(this.settings, stored);
        this.log("success", `Appairage reussi. Identifiants sauvegardes dans ${this.settings.credentialsPath}.`);
      }

      this.callbacks.onConnectionChange?.(true);
      this.startHeartbeat(socket, payload.heartbeatIntervalMs);
    });

    socket.on("AGENT_COMMAND", (command: AgentCommandEnvelope) => {
      this.log("info", `AGENT_COMMAND recue: type=${command.type} botId=${command.botId} commandId=${command.commandId}`);
      this.callbacks.onCommand(command);
    });

    socket.connect();
  }

  private startHeartbeat(socket: Socket, intervalMs: number): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      socket.emit("AGENT_HEARTBEAT", {
        version: this.settings.version,
        activeBotCount: this.activeBotCountProvider()
      });
    }, intervalMs);
  }
}
