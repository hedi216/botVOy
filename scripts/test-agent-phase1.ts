// Script de test manuel pour la Phase 1 (appairage + heartbeat + statut agent).
// Ne modifie aucune logique metier: il se contente de jouer le role d'un agent
// distant via socket.io-client, en reprenant EXACTEMENT le protocole reel defini
// dans src/agentGateway.ts (namespace, champs d'auth, evenements) et
// src/agentService.ts (format des jetons/agentId issus de l'appairage).
//
// Rappel du protocole reel (voir src/agentGateway.ts):
// - namespace: io.of("/agent")
// - handshake.auth en mode pairing:   { mode: "pair", pairingCode, computerName, version }
// - handshake.auth en mode reconnect: { mode: "reconnect", agentId, token, computerName?, version }
// - le serveur emet "AGENT_CONNECTED" avec { agentId, agencyId, token, heartbeatIntervalMs, offlineTimeoutMs }
//   (token non-nul uniquement lors du premier appairage)
// - l'agent doit emettre "AGENT_HEARTBEAT" avec { version?, activeBotCount? }
// - l'agent peut emettre "AGENT_STATUS" (aucun payload lu cote serveur actuellement)
//
// Important: il n'existe PAS de champ "name" separe dans le handshake reel. A la
// creation, le serveur (redeemPairingCode dans agentService.ts) affecte
// `name = computerName` ET `computer_name = computerName`. Un nom affichable
// distinct ne peut etre defini qu'apres coup via PATCH /api/agents/:id.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { io as ioClient, Socket } from "socket.io-client";

type AgentConnectedPayload = {
  agentId: number;
  agencyId: number;
  token: string | null;
  heartbeatIntervalMs: number;
  offlineTimeoutMs: number;
};

type StoredCredentials = {
  agentId: number;
  token: string;
  agencyId: number;
  computerName: string;
  displayName: string;
  version: string;
  pairedAt: string;
};

const CREDENTIALS_PATH = path.join(process.cwd(), ".agent-test-credentials.json");
const SERVER_URL = process.env.TEST_AGENT_SERVER_URL?.trim() || `http://localhost:${process.env.WEB_PORT || 3000}`;
const STATUS_PING_INTERVAL_MS = 30_000;

// Valeurs demandees pour ce test manuel. TEST_DISPLAY_NAME n'est jamais envoye
// dans le handshake (le protocole reel ne le supporte pas) : il est uniquement
// conserve localement pour documentation/renommage ulterieur via l'API REST.
const TEST_COMPUTER_NAME = "TEST-PC";
const TEST_DISPLAY_NAME = "PC Test Phase 1";
const TEST_VERSION = "1.0.0";

const log = (label: string, message: string): void => {
  console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
};

// Ne jamais afficher le jeton complet: seuls les 4 premiers/derniers caracteres
// et la longueur sont logges, pour pouvoir verifier visuellement qu'un jeton a
// bien ete recu/charge sans jamais l'exposer entierement dans un terminal/CI.
const maskToken = (token: string): string =>
  token.length <= 8 ? "***" : `${token.slice(0, 4)}...${token.slice(-4)} (${token.length} caracteres)`;

const usageAndExit = (): never => {
  console.error("Usage:");
  console.error("  npx tsx scripts/test-agent-phase1.ts pair <CODE_APPARIEMENT>");
  console.error("  npx tsx scripts/test-agent-phase1.ts reconnect");
  process.exit(1);
};

const loadCredentials = (): StoredCredentials => {
  if (!existsSync(CREDENTIALS_PATH)) {
    log("ERROR", `Aucun fichier ${CREDENTIALS_PATH} trouve.`);
    log("ERROR", "Lance d'abord: npx tsx scripts/test-agent-phase1.ts pair <CODE_APPARIEMENT>");
    process.exit(1);
  }

  return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as StoredCredentials;
};

const saveCredentials = (credentials: StoredCredentials): void => {
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
  log("CREDENTIALS", `Identifiants sauvegardes dans ${CREDENTIALS_PATH} (jeton: ${maskToken(credentials.token)}).`);
};

const startHeartbeatLoop = (socket: Socket, intervalMs: number): NodeJS.Timeout => {
  log("HEARTBEAT", `Demarrage de la boucle AGENT_HEARTBEAT toutes les ${intervalMs}ms (valeur recue du serveur).`);
  return setInterval(() => {
    socket.emit("AGENT_HEARTBEAT", { version: TEST_VERSION, activeBotCount: 0 });
    log("HEARTBEAT", "AGENT_HEARTBEAT envoye.");
  }, intervalMs);
};

const startStatusPing = (socket: Socket): NodeJS.Timeout =>
  setInterval(() => {
    socket.emit("AGENT_STATUS");
    log("STATUS", "AGENT_STATUS envoye (ping volontaire, sans payload attendu par le serveur).");
  }, STATUS_PING_INTERVAL_MS);

const keepAliveUntilCtrlC = (socket: Socket, timers: NodeJS.Timeout[]): void => {
  const shutdown = (signal: string): void => {
    log("SHUTDOWN", `${signal} recu, fermeture propre du socket de test.`);
    timers.forEach(clearInterval);
    socket.disconnect();
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT (Ctrl+C)"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
};

const attachCommonHandlers = (
  socket: Socket,
  onAgentConnected: (payload: AgentConnectedPayload) => void
): void => {
  socket.on("connect", () => {
    log("CONNECT", `Socket.IO connecte sur ${SERVER_URL}/agent (id=${socket.id}).`);
  });

  socket.on("connect_error", (error: Error) => {
    log("CONNECT_ERROR", `Connexion rejetee par le middleware d'auth /agent: ${error.message}`);
    log("CONNECT_ERROR", "Raisons possibles: INVALID_AUTH_MODE, INVALID_OR_EXPIRED, TOO_MANY_ATTEMPTS, INVALID_TOKEN.");
  });

  socket.on("disconnect", (reason: string) => {
    log("DISCONNECT", `Socket deconnecte: ${reason}`);
  });

  socket.on("AGENT_CONNECTED", (payload: AgentConnectedPayload) => {
    log(
      "AGENT_CONNECTED",
      `agentId=${payload.agentId}, agencyId=${payload.agencyId}, ` +
      `heartbeatIntervalMs=${payload.heartbeatIntervalMs}, offlineTimeoutMs=${payload.offlineTimeoutMs}`
    );
    onAgentConnected(payload);
  });

  socket.io.on("error", (error: Error) => {
    log("SOCKET_IO_ERROR", error.message);
  });

  socket.io.on("reconnect_attempt", (attempt: number) => {
    log("RECONNECT_ATTEMPT", `Tentative de reconnexion Socket.IO n°${attempt}.`);
  });
};

const runPairMode = (pairingCode: string): void => {
  log("PAIR", `Connexion a ${SERVER_URL}/agent en mode "pair" avec le code ${pairingCode}.`);
  log("PAIR", `computerName=${TEST_COMPUTER_NAME}, version=${TEST_VERSION}`);
  log(
    "PAIR",
    `Note: "${TEST_DISPLAY_NAME}" n'est pas envoye au serveur (pas de champ "name" dans le handshake reel). ` +
    "Renommable ensuite via PATCH /api/agents/:id."
  );

  const socket = ioClient(`${SERVER_URL}/agent`, {
    autoConnect: false,
    reconnection: false, // un code d'appairage est a usage unique: pas de retry automatique en cas d'echec
    auth: {
      mode: "pair",
      pairingCode,
      computerName: TEST_COMPUTER_NAME,
      version: TEST_VERSION
    }
  });

  const timers: NodeJS.Timeout[] = [];

  attachCommonHandlers(socket, (payload) => {
    if (!payload.token) {
      log("AGENT_CONNECTED", "Aucun jeton recu: le serveur n'a pas traite cette connexion comme un premier appairage.");
      return;
    }

    log("AGENT_CONNECTED", `Jeton d'agent delivre: ${maskToken(payload.token)}`);

    saveCredentials({
      agentId: payload.agentId,
      token: payload.token,
      agencyId: payload.agencyId,
      computerName: TEST_COMPUTER_NAME,
      displayName: TEST_DISPLAY_NAME,
      version: TEST_VERSION,
      pairedAt: new Date().toISOString()
    });

    timers.push(startHeartbeatLoop(socket, payload.heartbeatIntervalMs));
    timers.push(startStatusPing(socket));
    keepAliveUntilCtrlC(socket, timers);
  });

  socket.connect();
};

const runReconnectMode = (): void => {
  const credentials = loadCredentials();
  log(
    "RECONNECT",
    `Reconnexion a ${SERVER_URL}/agent avec agentId=${credentials.agentId}, jeton=${maskToken(credentials.token)}.`
  );

  const socket = ioClient(`${SERVER_URL}/agent`, {
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 2_000,
    auth: {
      mode: "reconnect",
      agentId: credentials.agentId,
      token: credentials.token,
      computerName: credentials.computerName,
      version: credentials.version
    }
  });

  const timers: NodeJS.Timeout[] = [];

  attachCommonHandlers(socket, (payload) => {
    if (payload.token) {
      log("AGENT_CONNECTED", "Jeton renvoye de facon inattendue en mode reconnect (ne devrait arriver qu'en mode pair).");
    }

    if (timers.length === 0) {
      timers.push(startHeartbeatLoop(socket, payload.heartbeatIntervalMs));
      timers.push(startStatusPing(socket));
      keepAliveUntilCtrlC(socket, timers);
    }
  });

  socket.connect();
};

const [, , mode, arg] = process.argv;

if (mode === "pair") {
  if (!arg || !arg.trim()) {
    usageAndExit();
  }

  runPairMode(arg.trim());
} else if (mode === "reconnect") {
  runReconnectMode();
} else {
  usageAndExit();
}
