import { randomUUID } from "node:crypto";
import { io as ioClient, Socket } from "socket.io-client";
import { loadStoredCredentials, saveStoredCredentials } from "./agentStorage.js";
import { AgentLogFn, redactForLog } from "./agentLocalLogger.js";
import { AgentOfflineEventBuffer } from "./agentOfflineBuffer.js";
import { computeReconnectDelayMs } from "./agentReconnectBackoff.js";
import { AgentCommandEnvelope, AgentExtensionPublicStatus, AgentRuntimeSettings, RuntimeStatusBotSnapshot, StoredAgentCredentials } from "./types.js";

// Reprend le protocole reel de src/agentGateway.ts (namespace /agent, formes
// d'auth "pair"/"reconnect", evenements AGENT_CONNECTED/AGENT_HEARTBEAT/
// AGENT_COMMAND/COMMAND_ACK/COMMAND_COMPLETED/COMMAND_FAILED/BOT_STATUS),
// deja valide par scripts/test-agent-phase1.ts et scripts/test-agent-phase3.ts.
// Lot 5 (Phase 4): reconnexion entierement manuelle (backoff+jitter,
// distinction transitoire/definitif) et buffer d'evenements hors ligne -
// contrairement a scripts/test-agent-*.ts qui simulent un agent, ce client
// est le runtime reel, jamais de faux succes simule.
export type AgentClientCallbacks = {
  onCommand: (command: AgentCommandEnvelope) => void;
  onConnectionChange?: (connected: boolean) => void;
  // Distinct de onConnectionChange(true): signale que la reconciliation
  // (AGENT_RUNTIME_STATUS envoye + buffer hors ligne vide) est terminee.
  onSyncReady?: () => void;
  // Erreur d'authentification DEFINITIVE (section 2): la reconnexion
  // s'arrete completement, sans toucher aux bots deja actifs localement.
  onPermanentFailure?: (reason: string) => void;
};

// Raisons connues comme definitives (jamais retentees indefiniment): toute
// autre raison de connect_error (reseau, timeout, TOO_MANY_ATTEMPTS...) reste
// transitoire et suit le backoff normal (section 2: "nombre de tentatives
// non limite pour une coupure reseau normale").
const PERMANENT_FAILURE_REASONS = new Set([
  "INVALID_TOKEN",
  "INVALID_AUTH_MODE",
  "AGENT_REVOKED",
  "VERSION_INCOMPATIBLE"
]);

const ACK_TIMEOUT_MS = 8_000;

export class AgentClient {
  private socket: Socket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private activeBotCountProvider: () => number = () => 0;
  private runtimeStatusProvider: () => RuntimeStatusBotSnapshot[] = () => [];
  private extensionStatusProvider: () => AgentExtensionPublicStatus[] = () => [];
  private lastAuth: Record<string, unknown> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private permanentFailure = false;
  private ready = false;
  private readonly offlineBuffer: AgentOfflineEventBuffer;

  constructor(
    private readonly settings: AgentRuntimeSettings,
    private readonly log: AgentLogFn,
    private readonly callbacks: AgentClientCallbacks
  ) {
    this.offlineBuffer = new AgentOfflineEventBuffer(settings.offlineEventBufferMax);
  }

  setActiveBotCountProvider(provider: () => number): void {
    this.activeBotCountProvider = provider;
  }

  // Lot 5: fournit le snapshot des bots locaux actifs, envoye via
  // AGENT_RUNTIME_STATUS a chaque connexion/reconnexion (section 6).
  setRuntimeStatusProvider(provider: () => RuntimeStatusBotSnapshot[]): void {
    this.runtimeStatusProvider = provider;
  }

  // Lot 5 (section 14): inventaire public des extensions locales, envoye
  // avec AGENT_RUNTIME_STATUS - jamais localPath (agentExtensionConfig.ts
  // garantit deja que toPublicExtensionStatus() ne l'inclut pas).
  setExtensionStatusProvider(provider: () => AgentExtensionPublicStatus[]): void {
    this.extensionStatusProvider = provider;
  }

  // READY_FOR_COMMANDS local (section 9): vrai seulement une fois
  // AGENT_RUNTIME_STATUS envoye pour cette connexion. Informatif ici (le
  // serveur applique sa propre porte independamment); utile pour les logs/
  // tests.
  isReadyForCommands(): boolean {
    return this.ready;
  }

  async start(pairingCode?: string): Promise<void> {
    if (pairingCode) {
      this.lastAuth = {
        mode: "pair",
        pairingCode,
        computerName: this.settings.computerName,
        version: this.settings.version
      };
      this.connectWithAuth(this.lastAuth);
      return;
    }

    const stored = loadStoredCredentials(this.settings);
    if (!stored) {
      throw new Error(
        `Aucun agent appaire (${this.settings.credentialsPath} introuvable). ` +
        "Lancez d'abord: npm run agent:dev -- pair <CODE_APPARIEMENT>"
      );
    }

    this.lastAuth = {
      mode: "reconnect",
      agentId: stored.agentId,
      token: stored.token,
      computerName: stored.computerName,
      version: stored.version
    };
    this.connectWithAuth(this.lastAuth);
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.disconnect();
    this.socket = null;
  }

  // Jamais bufferise (section 4, liste explicite d'exclusion): un ACK non
  // recu par le serveur pendant une coupure est deja gere par le TTL/
  // disconnect existant cote serveur (failNonTerminalOnDisconnect), jamais
  // rejoue plus tard - rejouer un ACK ancien apres coup n'aurait de toute
  // facon aucun effet (la commande serait deja marquee en echec).
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

  // Seul canal bufferise hors ligne (section 4): BOT_STATUS porte tous les
  // evenements runtime eligibles (MONITORING/RATE_LIMITED/SLOT_DETECTED/
  // STOPPED/ERROR...). Deja connecte ET synchronise -> envoi direct avec
  // accuse de reception; sinon -> buffer local borne.
  sendBotStatus(commandId: string, botId: string, status: string, details?: unknown): void {
    const payload = {
      commandId,
      botId,
      status,
      timestamp: new Date().toISOString(),
      details: details ? redactForLog(details) : undefined
    };

    if (this.socket?.connected && this.ready) {
      this.emitBotStatusWithAck(payload);
      return;
    }

    const dedupKey = status === "SLOT_DETECTED" ? JSON.stringify(payload.details) : undefined;
    this.offlineBuffer.push({ type: status, botId, payload, dedupKey });
  }

  private emitBotStatusWithAck(payload: Record<string, unknown>, eventId: string = randomUUID()): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    socket.timeout(ACK_TIMEOUT_MS).emit("BOT_STATUS", { ...payload, eventId }, () => {
      // Envoi "en direct" (pas depuis le buffer): rien a confirmer ici, un
      // eventuel echec sera simplement invisible (comportement historique).
      // Le rejeu fiable ne s'applique qu'aux evenements passes par le
      // buffer (flushOfflineBuffer), jamais a l'emission live.
    });
  }

  // Section 5: vidage dans l'ordre FIFO, un eventId par evenement (dedup
  // serveur), jamais de perte silencieuse - un evenement dont l'accuse de
  // reception echoue (timeout/erreur) reste dans le buffer pour la
  // prochaine connexion reussie.
  private flushOfflineBuffer(): void {
    const socket = this.socket;
    if (!socket?.connected) {
      return;
    }

    for (const envelope of this.offlineBuffer.peekAll()) {
      socket.timeout(ACK_TIMEOUT_MS).emit(
        "BOT_STATUS",
        { ...(envelope.payload as Record<string, unknown>), eventId: envelope.eventId },
        (error: unknown, response?: { ok?: boolean }) => {
          if (!error && response?.ok !== false) {
            this.offlineBuffer.acknowledge(envelope.eventId);
          }
        }
      );
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.permanentFailure) {
      return;
    }

    this.reconnectAttempt += 1;
    const delay = computeReconnectDelayMs(
      this.reconnectAttempt,
      this.settings.reconnectMinDelayMs,
      this.settings.reconnectMaxDelayMs,
      this.settings.reconnectJitterRatio
    );

    this.log("info", `Reconnexion prevue dans ${delay}ms (tentative ${this.reconnectAttempt}).`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || this.permanentFailure || !this.lastAuth) {
        return;
      }
      this.connectWithAuth(this.lastAuth);
    }, delay);
  }

  private connectWithAuth(auth: Record<string, unknown>): void {
    // Reconnexion entierement manuelle (section 2): la reconnexion native de
    // socket.io-client ne distingue jamais une erreur d'authentification
    // definitive d'une coupure reseau transitoire et n'offre pas de
    // backoff+jitter parametrable. reconnection:false la desactive
    // totalement; scheduleReconnect() la remplace integralement.
    const socket = ioClient(`${this.settings.serverUrl}/agent`, {
      autoConnect: false,
      reconnection: false,
      auth
    });
    this.socket = socket;
    this.ready = false;

    socket.on("connect", () => {
      this.log("success", `Connecte a ${this.settings.serverUrl}/agent.`);
    });

    socket.on("connect_error", (error: Error) => {
      this.log("error", `Connexion refusee: ${error.message}`);

      if (PERMANENT_FAILURE_REASONS.has(error.message)) {
        this.permanentFailure = true;
        this.log("error", `Echec definitif d'authentification (${error.message}): arret des tentatives de reconnexion. Les bots deja actifs localement continuent (aucune commande distante ne sera plus recue).`);
        this.callbacks.onPermanentFailure?.(error.message);
        return;
      }

      this.scheduleReconnect();
    });

    socket.on("disconnect", (reason: string) => {
      this.log("warn", `Deconnecte du serveur: ${reason}. Les bots locaux continuent, les evenements sont mis en buffer.`);
      this.ready = false;
      this.callbacks.onConnectionChange?.(false);
      this.scheduleReconnect();
    });

    socket.on("AGENT_CONNECTED", (payload: {
      agentId: number;
      agencyId: number;
      token: string | null;
      heartbeatIntervalMs: number;
      offlineTimeoutMs: number;
    }) => {
      this.log("success", `AGENT_CONNECTED (agentId=${payload.agentId}, agencyId=${payload.agencyId}).`);
      this.reconnectAttempt = 0;

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
        // Une fois appaire, les reconnexions suivantes doivent utiliser ces
        // identifiants (jamais retenter "pair" avec un code deja consomme).
        this.lastAuth = {
          mode: "reconnect",
          agentId: payload.agentId,
          token: payload.token,
          computerName: this.settings.computerName,
          version: this.settings.version
        };
      }

      this.callbacks.onConnectionChange?.(true);
      this.startHeartbeat(socket, payload.heartbeatIntervalMs);

      // Section 5: AGENT_RUNTIME_STATUS immediatement, puis vidage du
      // buffer une fois le socket etabli (deja garanti ici: ce handler ne
      // se declenche qu'une fois la connexion pleinement operationnelle).
      socket.emit("AGENT_RUNTIME_STATUS", {
        sentAt: new Date().toISOString(),
        bots: this.runtimeStatusProvider()
      });
      socket.emit("AGENT_EXTENSION_STATUS", {
        extensions: this.extensionStatusProvider()
      });
      this.ready = true;
      this.callbacks.onSyncReady?.();
      this.flushOfflineBuffer();
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
