// Agent simule pour la Phase 3 (protocole de commandes serveur-agent).
// Reprend les identifiants deja sauvegardes par
// scripts/test-agent-phase1.ts (mode "pair") plutot que d'en creer un
// deuxieme mecanisme d'appairage: lance d'abord
//   npx tsx scripts/test-agent-phase1.ts pair <CODE>
// puis ce script.
//
// Ce script SIMULE des reponses (succes, echec, absence d'accuse de
// reception, deconnexions...): le vrai agent de production ne doit JAMAIS
// simuler un succes tant que le moteur Chrome/Playwright n'existe pas cote
// agent (Phase 4). C'est pourquoi, sans argument, ce script choisit le mode
// "failure" plutot qu'un faux succes silencieux.
//
// Usage:
//   npx tsx scripts/test-agent-phase3.ts success
//   npx tsx scripts/test-agent-phase3.ts failure
//   npx tsx scripts/test-agent-phase3.ts no-ack
//   npx tsx scripts/test-agent-phase3.ts disconnect-before-ack
//   npx tsx scripts/test-agent-phase3.ts disconnect-after-ack
//   npx tsx scripts/test-agent-phase3.ts duplicate-ack
//   npx tsx scripts/test-agent-phase3.ts wrong-command

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { io as ioClient } from "socket.io-client";

const CREDENTIALS_PATH = path.join(process.cwd(), ".agent-test-credentials.json");
const SERVER_URL = process.env.TEST_AGENT_SERVER_URL?.trim() || `http://localhost:${process.env.WEB_PORT || 3000}`;

const VALID_MODES = [
  "success",
  "failure",
  "no-ack",
  "disconnect-before-ack",
  "disconnect-after-ack",
  "duplicate-ack",
  "wrong-command"
] as const;

type Mode = typeof VALID_MODES[number];

type StoredCredentials = {
  agentId: number;
  token: string;
  computerName: string;
  version: string;
};

type AgentCommandPayload = {
  commandId: string;
  type: string;
  agentId: number;
  botId: string;
  createdAt: string;
  expiresAt: string | null;
  payload: unknown;
};

const log = (label: string, message: string): void => {
  console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
};

const loadCredentials = (): StoredCredentials => {
  if (!existsSync(CREDENTIALS_PATH)) {
    console.error(`Aucun fichier ${CREDENTIALS_PATH} trouve.`);
    console.error("Lance d'abord: npx tsx scripts/test-agent-phase1.ts pair <CODE_APPARIEMENT>");
    process.exit(1);
  }
  return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as StoredCredentials;
};

const parseMode = (): Mode => {
  const raw = process.argv[2];
  if (!raw) {
    log("MODE", "Aucun mode fourni: utilisation de \"failure\" par defaut (jamais un faux succes silencieux).");
    return "failure";
  }
  if (!(VALID_MODES as readonly string[]).includes(raw)) {
    console.error(`Mode inconnu "${raw}". Modes valides: ${VALID_MODES.join(", ")}`);
    process.exit(1);
  }
  return raw as Mode;
};

// N'affiche jamais autre chose que commandId/type/botId: le payload d'un
// START_BOT en mode agent (Phase 3) ne contient de toute facon aucun
// identifiant TLScontact (solution A, section 5) mais on evite par principe
// d'imprimer le payload complet sans discernement.
const describeCommand = (command: AgentCommandPayload): string =>
  `commandId=${command.commandId} type=${command.type} botId=${command.botId}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const run = async (): Promise<void> => {
  const mode = parseMode();
  const credentials = loadCredentials();

  log("BOOT", `Connexion en mode "${mode}" (agentId=${credentials.agentId}).`);

  const socket = ioClient(`${SERVER_URL}/agent`, {
    autoConnect: false,
    reconnection: false,
    auth: {
      mode: "reconnect",
      agentId: credentials.agentId,
      token: credentials.token,
      computerName: credentials.computerName,
      version: credentials.version,
      protocolVersion: 1
    }
  });

  socket.on("connect", () => log("CONNECT", `Connecte a ${SERVER_URL}/agent.`));
  socket.on("connect_error", (error: Error) => log("CONNECT_ERROR", error.message));
  socket.on("disconnect", (reason: string) => log("DISCONNECT", reason));

  socket.on("AGENT_CONNECTED", (payload: { heartbeatIntervalMs: number }) => {
    log("AGENT_CONNECTED", `heartbeatIntervalMs=${payload.heartbeatIntervalMs}`);
    setInterval(() => socket.emit("AGENT_HEARTBEAT", { version: credentials.version, activeBotCount: 0 }), payload.heartbeatIntervalMs);
    // Lot 5: sans AGENT_RUNTIME_STATUS, l'agent reste READY_FOR_COMMANDS=false
    // et le serveur refuse de dispatcher toute nouvelle commande (AGENT_SYNCING).
    socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
  });

  socket.on("AGENT_COMMAND", (command: AgentCommandPayload) => {
    log("AGENT_COMMAND", describeCommand(command));
    void handleCommand(socket, mode, command);
  });

  socket.connect();
};

const handleCommand = async (
  socket: ReturnType<typeof ioClient>,
  mode: Mode,
  command: AgentCommandPayload
): Promise<void> => {
  switch (mode) {
    case "success": {
      socket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
      log("SIMULATE", "COMMAND_ACK envoye.");
      await sleep(200);

      socket.emit("BOT_STATUS", { commandId: command.commandId, botId: command.botId, status: "STARTING", timestamp: new Date().toISOString() });
      log("SIMULATE", "BOT_STATUS STARTING envoye.");
      await sleep(200);

      socket.emit("BOT_STATUS", { commandId: command.commandId, botId: command.botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
      log("SIMULATE", "BOT_STATUS WAITING_FOR_USER envoye.");
      await sleep(200);

      socket.emit("COMMAND_COMPLETED", {
        commandId: command.commandId,
        completedAt: new Date().toISOString(),
        result: { simulated: true }
      });
      log("SIMULATE", "COMMAND_COMPLETED envoye (succes uniquement simule par ce script de test).");
      return;
    }

    case "failure": {
      socket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
      log("SIMULATE", "COMMAND_ACK envoye.");
      await sleep(200);

      socket.emit("COMMAND_FAILED", {
        commandId: command.commandId,
        failedAt: new Date().toISOString(),
        errorCode: "ENGINE_NOT_IMPLEMENTED",
        message: "Le moteur Chrome/Playwright n'est pas encore implemente cote agent (Phase 4)."
      });
      log("SIMULATE", "COMMAND_FAILED envoye (ENGINE_NOT_IMPLEMENTED).");
      return;
    }

    case "no-ack": {
      log("SIMULATE", "Aucun accuse de reception envoye (test du timeout serveur).");
      return;
    }

    case "disconnect-before-ack": {
      log("SIMULATE", "Deconnexion immediate, avant tout accuse de reception.");
      socket.disconnect();
      return;
    }

    case "disconnect-after-ack": {
      socket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
      log("SIMULATE", "COMMAND_ACK envoye, deconnexion avant toute suite.");
      await sleep(100);
      socket.disconnect();
      return;
    }

    case "duplicate-ack": {
      const ackPayload = { commandId: command.commandId, receivedAt: new Date().toISOString() };
      socket.emit("COMMAND_ACK", ackPayload);
      log("SIMULATE", "COMMAND_ACK envoye une premiere fois.");
      await sleep(200);
      socket.emit("COMMAND_ACK", ackPayload);
      log("SIMULATE", "COMMAND_ACK envoye une seconde fois (doublon volontaire).");
      return;
    }

    case "wrong-command": {
      const fabricatedCommandId = randomUUID();
      log("SIMULATE", `Envoi d'un COMMAND_ACK pour un commandId fabrique (${fabricatedCommandId}), different de celui recu.`);
      socket.emit("COMMAND_ACK", { commandId: fabricatedCommandId, receivedAt: new Date().toISOString() });
      return;
    }

    default:
      return;
  }
};

void run();
