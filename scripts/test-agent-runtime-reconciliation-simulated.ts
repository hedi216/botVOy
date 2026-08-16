// HOTFIX CIBLE - Coherence du runtime bot apres STOP_BOT / reboot Agent.
//
// Deux causes racines corrigees ici:
//   1) STOP_BOT sur un botId inconnu de l'agent (deja arrete/redemarre) ne
//      completait JUSQU'ICI que la COMMANDE (COMMAND_COMPLETED), sans jamais
//      emettre le BOT_STATUS STOPPED correspondant - AgentBotRecord.botStatus/
//      active ne convergeaient donc jamais serveur-side (src/agent/agentBotManager.ts).
//   2) AGENT_RUNTIME_STATUS ne reconciliait que les bots PRESENTS dans
//      l'inventaire recu (mise a jour/reconstruction/conflit) - jamais
//      l'inverse: un AgentBotRecord actif appartenant a CET agentId mais
//      ABSENT de l'inventaire (Chrome/bot disparu, agent redemarre) restait
//      actif indefiniment cote serveur (src/agentGateway.ts).
//
// Teste UNIQUEMENT la logique de ce hotfix (serveur reel + registre agentBots
// existant) - jamais src/agent/** (aucun vrai Chrome/Playwright): un "agent"
// ici est un simple socket.io-client qui simule l'API deja existante
// (AGENT_COMMAND -> COMMAND_ACK, BOT_STATUS, AGENT_RUNTIME_STATUS), meme
// architecture que scripts/test-agency-bot-quota.ts et
// scripts/test-agent-resilience-simulated.ts (reutilisee ici).
//
// Usage: npx tsx scripts/test-agent-runtime-reconciliation-simulated.ts

import { ChildProcess, spawn } from "node:child_process";
import { Socket, io as ioClient } from "socket.io-client";
import { ADMIN_LOGIN, ADMIN_PASSWORD, pool } from "../src/db.js";

const RUN_SUFFIX = Date.now();

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntilAsync = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};

// ===================== Serveur reel (memes helpers que test-agency-bot-quota.ts) =====================

type ServerHandle = { child: ChildProcess; baseUrl: string; stdout: string[] };

const waitForServerReady = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`${baseUrl}/api/me`); if (res.status === 401 || res.status === 200) return; } catch { /* pas encore pret */ }
    await sleep(500);
  }
  throw new Error(`Le serveur de test n'a jamais repondu sur ${baseUrl}/api/me.`);
};

const startServer = async (port: number): Promise<ServerHandle> => {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(command, ["tsx", "src/server.ts"], {
    env: { ...process.env, WEB_PORT: String(port), BOT_EXECUTION_MODE: "agent" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  const stdout: string[] = [];
  child.stdout?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); });
  child.stderr?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); });
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  return { child, baseUrl, stdout };
};

const stopServer = async (handle: ServerHandle): Promise<void> => {
  if (!handle.child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(handle.child.pid), "/T", "/F"]);
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  handle.child.kill("SIGTERM");
};

type HttpResult = { status: number; body: unknown; cookie: string | undefined };

const requestJson = async (baseUrl: string, method: string, pathName: string, cookie: string | undefined, json?: unknown): Promise<HttpResult> => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(json ?? {}) } : {})
  });
  const rawText = await res.text();
  let body: unknown = null;
  try { body = rawText ? JSON.parse(rawText) : null; } catch { body = rawText; }
  return { status: res.status, body, cookie: res.headers.get("set-cookie")?.split(";")[0] };
};

const login = async (baseUrl: string, loginName: string, password: string): Promise<{ cookie: string }> => {
  const result = await requestJson(baseUrl, "POST", "/api/login", undefined, { login: loginName, password });
  if (result.status !== 200 || !result.cookie) throw new Error(`Login ${loginName} a echoue: ${JSON.stringify(result.body)}`);
  return { cookie: result.cookie };
};

const loginWithRetry = async (baseUrl: string, loginName: string, password: string, attempts = 5): Promise<{ cookie: string }> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await login(baseUrl, loginName, password); } catch (error) { lastError = error; await sleep(1_000); }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

// ===================== Agent fantome (socket.io-client brut) =====================

type FakeAgentHandle = { agentId: number; token: string; socket: Socket };

const pairFakeAgent = (baseUrl: string, managerCookie: string, computerName: string): Promise<FakeAgentHandle> =>
  requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {}).then((pairing) => new Promise((resolve, reject) => {
    const pairingCode = (pairing.body as { pairing: { code: string } }).pairing.code;
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "pair", pairingCode, computerName, version: "1.0.0", protocolVersion: 1 }
    });
    const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout agent fantome.")); }, 8_000);
    socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
    socket.on("AGENT_CONNECTED", (payload: { agentId: number; token: string | null }) => {
      clearTimeout(t);
      if (!payload.token) { reject(new Error("Aucun jeton.")); return; }
      resolve({ agentId: payload.agentId, token: payload.token, socket });
    });
    socket.connect();
  }));

// Reconnexion sur le MEME agentId/token, simulant un redemarrage reel de
// l'agent (nouveau process, nouveau socket, mais meme identite d'agent) -
// jamais une nouvelle paire (jamais un nouvel agentId).
const reconnectFakeAgent = (baseUrl: string, agentId: number, token: string, computerName: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "reconnect", agentId, token, computerName, version: "1.0.0", protocolVersion: 1 }
    });
    const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout reconnexion agent fantome.")); }, 8_000);
    socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
    socket.on("AGENT_CONNECTED", () => { clearTimeout(t); resolve(socket); });
    socket.connect();
  });

type ReadyAgent = FakeAgentHandle & { commandsSeen: Array<Record<string, unknown>> };

// Agent fantome qui ACK automatiquement toute commande recue (comme le ferait
// n'importe quel vrai agent) et devient READY_FOR_COMMANDS avec un inventaire
// runtime initial vide (aucun bot au moment de l'appairage) - la reconciliation
// AGENT_RUNTIME_STATUS elle-meme est ensuite pilotee EXPLICITEMENT par chaque
// test (jamais automatique), via reconnectFakeAgent + un nouvel emit.
const setupReadyAgent = async (baseUrl: string, managerCookie: string, computerName: string): Promise<ReadyAgent> => {
  const agent = await pairFakeAgent(baseUrl, managerCookie, computerName);
  const commandsSeen: Array<Record<string, unknown>> = [];
  agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => {
    commandsSeen.push(command);
    agent.socket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
  });
  agent.socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
  await sleep(300);
  return { ...agent, commandsSeen };
};

const wireAutoAck = (socket: Socket, commandsSeen: Array<Record<string, unknown>>): void => {
  socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => {
    commandsSeen.push(command);
    socket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
  });
};

const connectUiSocket = (baseUrl: string, cookie: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { autoConnect: false, reconnection: false, forceNew: true, extraHeaders: { Cookie: cookie } });
    const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion socket UI.")); }, 8_000);
    socket.on("connect", () => { clearTimeout(t); resolve(socket); });
    socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
    socket.connect();
  });

type CommandSnapshot = {
  commandId: string;
  botId: string;
  botName: string | null;
  status: string;
  botStatus: string | null;
  botStatusUpdatedAt: string | null;
  botActive: boolean;
};

const trackUiSocket = (socket: Socket): {
  maintenance: { agencyActiveCount: number; agencyMaxClients: number } | null;
  commandsByBotId: Map<string, CommandSnapshot>;
  commandsByBotName: Map<string, CommandSnapshot>;
} => {
  const state = {
    maintenance: null as { agencyActiveCount: number; agencyMaxClients: number } | null,
    commandsByBotId: new Map<string, CommandSnapshot>(),
    commandsByBotName: new Map<string, CommandSnapshot>()
  };
  socket.on("maintenance", (payload: { agencyActiveCount: number; agencyMaxClients: number }) => { state.maintenance = payload; });
  socket.on("agent-command-status", (payload: CommandSnapshot) => {
    state.commandsByBotId.set(payload.botId, payload);
    if (payload.botName) state.commandsByBotName.set(payload.botName, payload);
  });
  return state;
};

type Ui = ReturnType<typeof trackUiSocket>;

const setupAgencyWithAgent = async (
  baseUrl: string,
  adminCookie: string,
  label: string
): Promise<{ agencyId: number; managerCookie: string; agent: ReadyAgent; ui: Ui; uiSocket: Socket }> => {
  const agencyName = `Test Reconcil ${label} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;

  const managerLogin = `test-reconcil-mgr-${label.toLowerCase()}-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const managerResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: `Manager ${label}`, email: `${managerLogin}@example.test`, role: 1
  });
  const managerPassword = (managerResult.body as { temporaryPassword: string }).temporaryPassword;
  const managerCookie = (await loginWithRetry(baseUrl, managerLogin, managerPassword)).cookie;

  const agent = await setupReadyAgent(baseUrl, managerCookie, `PW-RECONCIL-${label}-${RUN_SUFFIX}`);
  const uiSocket = await connectUiSocket(baseUrl, managerCookie);
  const ui = trackUiSocket(uiSocket);
  await waitUntilAsync(() => ui.maintenance !== null);

  return { agencyId, managerCookie, agent, ui, uiSocket };
};

// Demarre un bot via le socket UI (chemin reel server.ts, registerAgentBot
// inclus) et attend la commande START_BOT correspondante - jamais un botId
// fabrique a la main.
const startBotAndCapture = async (ui: Ui, uiSocket: Socket, agentId: number, botName: string): Promise<CommandSnapshot> => {
  uiSocket.emit("start-bot", { botName, category: "", agentId, clientRequestId: `tc-reconcil-${botName.replace(/\s+/g, "-")}-${RUN_SUFFIX}` });
  const gotCommand = await waitUntilAsync(() => ui.commandsByBotName.has(botName), 8_000);
  if (!gotCommand) throw new Error(`START_BOT jamais recu pour ${botName}.`);
  return ui.commandsByBotName.get(botName)!;
};

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  if (createdAgencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
};

// ===================== TEST A: STOP_BOT normal =====================

const runTestA = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-A", "=== STOP_BOT normal: bot MONITORING -> STOPPED, active=false, compteur decremente ===");
  const { agent, ui, uiSocket } = await setupAgencyWithAgent(baseUrl, adminCookie, "A");

  const cmd = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Stop Normal");
  agent.socket.emit("BOT_STATUS", { commandId: cmd.commandId, botId: cmd.botId, status: "MONITORING" });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmd.botId)?.botStatus === "MONITORING");
  const countBefore = ui.maintenance?.agencyActiveCount ?? -1;

  const stopBefore = agent.commandsSeen.filter((c) => c.type === "STOP_BOT").length;
  uiSocket.emit("stop-bot", { botId: cmd.botId, clientRequestId: `tc-reconcil-stop-a-${RUN_SUFFIX}` });
  await waitUntilAsync(() => agent.commandsSeen.filter((c) => c.type === "STOP_BOT").length > stopBefore);
  const stopCommand = agent.commandsSeen.filter((c) => c.type === "STOP_BOT").pop()!;

  // Reproduit exactement stopHandle() (agentBotManager.ts): BOT_STATUS
  // STOPPED puis COMMAND_COMPLETED, jamais le seul COMPLETED.
  agent.socket.emit("BOT_STATUS", { commandId: stopCommand.commandId, botId: cmd.botId, status: "STOPPED" });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: stopCommand.commandId, completedAt: new Date().toISOString(), result: { botId: cmd.botId, status: "STOPPED", stopped: true } });

  await waitUntilAsync(() => ui.commandsByBotId.get(cmd.botId)?.status === "COMPLETED");
  const final = ui.commandsByBotId.get(cmd.botId);
  assert(final?.botStatus === "STOPPED", `A) botStatus serveur converge vers STOPPED (recu: ${final?.botStatus})`);
  assert(final?.botActive === false, `A) active passe a false (recu: ${final?.botActive})`);
  assert(final?.status === "COMPLETED", `A) la commande STOP_BOT est bien terminee (recu: ${final?.status})`);
  await waitUntilAsync(() => ui.maintenance?.agencyActiveCount === countBefore - 1);
  assert(ui.maintenance?.agencyActiveCount === countBefore - 1, `A) le compteur d'agence est decremente (avant: ${countBefore}, apres: ${ui.maintenance?.agencyActiveCount})`);

  agent.socket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST B: STOP_BOT idempotent, bot deja absent localement =====================

const runTestB = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-B", "=== STOP_BOT idempotent (bot deja absent localement): CORRECTIF - converge quand meme vers STOPPED/active=false ===");
  const { agent, ui, uiSocket } = await setupAgencyWithAgent(baseUrl, adminCookie, "B");

  const cmd = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Stop Idempotent");
  agent.socket.emit("BOT_STATUS", { commandId: cmd.commandId, botId: cmd.botId, status: "WAITING_FOR_USER" });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmd.botId)?.botStatus === "WAITING_FOR_USER");

  const stopBefore = agent.commandsSeen.filter((c) => c.type === "STOP_BOT").length;
  uiSocket.emit("stop-bot", { botId: cmd.botId, clientRequestId: `tc-reconcil-stop-b-${RUN_SUFFIX}` });
  await waitUntilAsync(() => agent.commandsSeen.filter((c) => c.type === "STOP_BOT").length > stopBefore);
  const stopCommand = agent.commandsSeen.filter((c) => c.type === "STOP_BOT").pop()!;

  // Reproduit EXACTEMENT le nouveau comportement de agentBotManager.ts pour
  // un botId inconnu de cette instance d'agent (correctif cible): BOT_STATUS
  // STOPPED {alreadyStopped:true} PUIS COMMAND_COMPLETED {alreadyStopped:true}
  // - jamais le seul COMPLETED comme avant ce correctif.
  agent.socket.emit("BOT_STATUS", { commandId: stopCommand.commandId, botId: cmd.botId, status: "STOPPED", details: { alreadyStopped: true } });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: stopCommand.commandId, completedAt: new Date().toISOString(), result: { botId: cmd.botId, status: "STOPPED", stopped: true, alreadyStopped: true } });

  await waitUntilAsync(() => ui.commandsByBotId.get(cmd.botId)?.status === "COMPLETED");
  const final = ui.commandsByBotId.get(cmd.botId);
  assert(final?.botStatus === "STOPPED", `B) botStatus serveur converge vers STOPPED meme pour un STOP_BOT idempotent (recu: ${final?.botStatus})`);
  assert(final?.botActive === false, `B) active passe a false (recu: ${final?.botActive})`);
  assert(final?.status === "COMPLETED", `B) la commande est bien terminee (jamais bloquee/en erreur) (recu: ${final?.status})`);

  agent.socket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST C: inventaire apres reboot avec un bot manquant =====================

const runTestC = async (baseUrl: string, adminCookie: string, server: ServerHandle): Promise<void> => {
  log("TEST-C", "=== Reboot Agent: inventaire runtime avec UN bot manquant -> celui-ci devient STOPPED, l'autre est preserve ===");
  const { agencyId: _agencyId, agent, ui, uiSocket, managerCookie: _managerCookie } = await setupAgencyWithAgent(baseUrl, adminCookie, "C");

  const cmdA = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Reboot A");
  agent.socket.emit("BOT_STATUS", { commandId: cmdA.commandId, botId: cmdA.botId, status: "MONITORING" });
  const cmdB = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Reboot B");
  agent.socket.emit("BOT_STATUS", { commandId: cmdB.commandId, botId: cmdB.botId, status: "WAITING_FOR_USER" });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmdA.botId)?.botStatus === "MONITORING" && ui.commandsByBotId.get(cmdB.botId)?.botStatus === "WAITING_FOR_USER");

  // "Reboot": l'agent se deconnecte puis se reconnecte (meme agentId/token) et
  // envoie un inventaire runtime authentique qui ne contient plus QUE A.
  agent.socket.disconnect();
  await sleep(300);
  const newSocket = await reconnectFakeAgent(baseUrl, agent.agentId, agent.token, `PW-RECONCIL-C-${RUN_SUFFIX}`);
  const commandsSeenAfterReboot: Array<Record<string, unknown>> = [];
  wireAutoAck(newSocket, commandsSeenAfterReboot);
  newSocket.emit("AGENT_RUNTIME_STATUS", {
    sentAt: new Date().toISOString(),
    bots: [{ botId: cmdA.botId, status: "MONITORING", startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), monitoringActive: true, browserOpen: true }]
  });

  await waitUntilAsync(() => ui.commandsByBotId.get(cmdB.botId)?.botStatus === "STOPPED");
  const finalA = ui.commandsByBotId.get(cmdA.botId);
  const finalB = ui.commandsByBotId.get(cmdB.botId);
  assert(finalA?.botStatus === "MONITORING", `C) Le bot present dans l'inventaire (A) conserve son statut reel rapporte (recu: ${finalA?.botStatus})`);
  assert(finalB?.botStatus === "STOPPED", `C) Le bot absent de l'inventaire (B) converge vers STOPPED (recu: ${finalB?.botStatus})`);
  assert(finalB?.botActive === false, `C) B a bien active=false (recu: ${finalB?.botActive})`);
  const reconciliationLogged = await waitUntilAsync(() => server.stdout.join("").includes(cmdB.botId) && server.stdout.join("").toLowerCase().includes("reconciliation"), 3_000);
  assert(reconciliationLogged, "C) La reconciliation du bot absent est journalisee de maniere exploitable (sobre, pas de donnee sensible)");

  newSocket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST D: inventaire vide =====================

const runTestD = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-D", "=== Reboot Agent: inventaire runtime VIDE ([]) -> TOUS les bots de cet agent deviennent STOPPED ===");
  const { agent, ui, uiSocket } = await setupAgencyWithAgent(baseUrl, adminCookie, "D");

  const cmdA = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Empty A");
  agent.socket.emit("BOT_STATUS", { commandId: cmdA.commandId, botId: cmdA.botId, status: "MONITORING" });
  const cmdB = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Empty B");
  agent.socket.emit("BOT_STATUS", { commandId: cmdB.commandId, botId: cmdB.botId, status: "ERROR" });
  const cmdC = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Empty C");
  agent.socket.emit("BOT_STATUS", { commandId: cmdC.commandId, botId: cmdC.botId, status: "RATE_LIMITED" });
  await waitUntilAsync(() =>
    ui.commandsByBotId.get(cmdA.botId)?.botStatus === "MONITORING"
    && ui.commandsByBotId.get(cmdB.botId)?.botStatus === "ERROR"
    && ui.commandsByBotId.get(cmdC.botId)?.botStatus === "RATE_LIMITED");

  agent.socket.disconnect();
  await sleep(300);
  const newSocket = await reconnectFakeAgent(baseUrl, agent.agentId, agent.token, `PW-RECONCIL-D-${RUN_SUFFIX}`);
  wireAutoAck(newSocket, []);
  newSocket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });

  await waitUntilAsync(() =>
    ui.commandsByBotId.get(cmdA.botId)?.botStatus === "STOPPED"
    && ui.commandsByBotId.get(cmdB.botId)?.botStatus === "STOPPED"
    && ui.commandsByBotId.get(cmdC.botId)?.botStatus === "STOPPED");

  for (const [label, cmd] of [["A (etait MONITORING)", cmdA], ["B (etait ERROR)", cmdB], ["C (etait RATE_LIMITED)", cmdC]] as const) {
    const final = ui.commandsByBotId.get(cmd.botId);
    assert(final?.botStatus === "STOPPED", `D) Bot ${label} converge vers STOPPED avec un inventaire vide (recu: ${final?.botStatus})`);
    assert(final?.botActive === false, `D) Bot ${label} a bien active=false (recu: ${final?.botActive})`);
  }

  newSocket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST E: isolation entre deux Agents =====================

const runTestE = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-E", "=== Isolation stricte: l'inventaire vide de l'Agent 1 ne touche JAMAIS les bots de l'Agent 2 ===");
  const agencyName = `Test Reconcil E ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;
  const managerLogin = `test-reconcil-mgr-e-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const managerResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: "Manager E", email: `${managerLogin}@example.test`, role: 1
  });
  const managerPassword = (managerResult.body as { temporaryPassword: string }).temporaryPassword;
  const managerCookie = (await loginWithRetry(baseUrl, managerLogin, managerPassword)).cookie;

  const agent1 = await setupReadyAgent(baseUrl, managerCookie, `PW-RECONCIL-E1-${RUN_SUFFIX}`);
  const agent2 = await setupReadyAgent(baseUrl, managerCookie, `PW-RECONCIL-E2-${RUN_SUFFIX}`);
  const uiSocket = await connectUiSocket(baseUrl, managerCookie);
  const ui = trackUiSocket(uiSocket);
  await waitUntilAsync(() => ui.maintenance !== null);

  const cmdA = await startBotAndCapture(ui, uiSocket, agent1.agentId, "Bot Isol A");
  agent1.socket.emit("BOT_STATUS", { commandId: cmdA.commandId, botId: cmdA.botId, status: "MONITORING" });
  const cmdB = await startBotAndCapture(ui, uiSocket, agent1.agentId, "Bot Isol B");
  agent1.socket.emit("BOT_STATUS", { commandId: cmdB.commandId, botId: cmdB.botId, status: "WAITING_FOR_USER" });
  const cmdC = await startBotAndCapture(ui, uiSocket, agent2.agentId, "Bot Isol C");
  agent2.socket.emit("BOT_STATUS", { commandId: cmdC.commandId, botId: cmdC.botId, status: "MONITORING" });
  await waitUntilAsync(() =>
    ui.commandsByBotId.get(cmdA.botId)?.botStatus === "MONITORING"
    && ui.commandsByBotId.get(cmdB.botId)?.botStatus === "WAITING_FOR_USER"
    && ui.commandsByBotId.get(cmdC.botId)?.botStatus === "MONITORING");

  // Seul l'Agent 1 "reboote" avec un inventaire vide - l'Agent 2 reste connecte
  // et n'envoie rien de nouveau.
  agent1.socket.disconnect();
  await sleep(300);
  const newSocket1 = await reconnectFakeAgent(baseUrl, agent1.agentId, agent1.token, `PW-RECONCIL-E1-${RUN_SUFFIX}`);
  wireAutoAck(newSocket1, []);
  newSocket1.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });

  await waitUntilAsync(() => ui.commandsByBotId.get(cmdA.botId)?.botStatus === "STOPPED" && ui.commandsByBotId.get(cmdB.botId)?.botStatus === "STOPPED");
  assert(ui.commandsByBotId.get(cmdA.botId)?.botStatus === "STOPPED", "E) Bot A (Agent 1) converge vers STOPPED");
  assert(ui.commandsByBotId.get(cmdB.botId)?.botStatus === "STOPPED", "E) Bot B (Agent 1) converge vers STOPPED");

  // Fenetre d'observation supplementaire: le bot de l'Agent 2 ne doit JAMAIS
  // etre touche, ni immediatement ni apres un court delai.
  await sleep(1_000);
  const finalC = ui.commandsByBotId.get(cmdC.botId);
  assert(finalC?.botStatus === "MONITORING", `E) Bot C (Agent 2, jamais reboote) reste totalement inchange (recu: ${finalC?.botStatus})`);
  assert(finalC?.botActive === true, `E) Bot C reste actif (recu: ${finalC?.botActive})`);

  newSocket1.disconnect();
  agent2.socket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST F: simple deconnexion reseau, jamais de STOPPED =====================

const runTestF = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-F", "=== Simple coupure reseau (sans reboot ni inventaire) -> le bot NE devient PAS STOPPED ===");
  const { agent, ui, uiSocket } = await setupAgencyWithAgent(baseUrl, adminCookie, "F");

  const cmd = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Disconnect Only");
  agent.socket.emit("BOT_STATUS", { commandId: cmd.commandId, botId: cmd.botId, status: "MONITORING" });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmd.botId)?.botStatus === "MONITORING");

  agent.socket.disconnect();
  await sleep(1_500);
  assert(ui.commandsByBotId.get(cmd.botId)?.botStatus === "MONITORING", "F) Une simple deconnexion socket ne fait PAS passer le bot a STOPPED (le runtime peut continuer sans l'agent connecte)");

  // Reconnexion avec un inventaire qui contient TOUJOURS ce bot: le statut
  // rapporte est conserve, jamais reinitialise par la seule reconnexion.
  const newSocket = await reconnectFakeAgent(baseUrl, agent.agentId, agent.token, `PW-RECONCIL-F-${RUN_SUFFIX}`);
  wireAutoAck(newSocket, []);
  newSocket.emit("AGENT_RUNTIME_STATUS", {
    sentAt: new Date().toISOString(),
    bots: [{ botId: cmd.botId, status: "MONITORING", startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), monitoringActive: true, browserOpen: true }]
  });
  await sleep(500);
  assert(ui.commandsByBotId.get(cmd.botId)?.botStatus === "MONITORING", "F) Apres reconnexion avec le bot toujours present dans l'inventaire, MONITORING est conserve");

  newSocket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST G: deconnexion puis inventaire vide =====================

const runTestG = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-G", "=== Deconnexion PUIS inventaire vide au reconnect -> STOPPED seulement APRES l'inventaire, jamais avant ===");
  const { agent, ui, uiSocket } = await setupAgencyWithAgent(baseUrl, adminCookie, "G");

  const cmd = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Disconnect Then Empty");
  agent.socket.emit("BOT_STATUS", { commandId: cmd.commandId, botId: cmd.botId, status: "MONITORING" });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmd.botId)?.botStatus === "MONITORING");

  agent.socket.disconnect();
  await sleep(1_000);
  assert(ui.commandsByBotId.get(cmd.botId)?.botStatus === "MONITORING", "G) Pendant la coupure, le bot reste MONITORING (pas de changement premature)");

  const newSocket = await reconnectFakeAgent(baseUrl, agent.agentId, agent.token, `PW-RECONCIL-G-${RUN_SUFFIX}`);
  wireAutoAck(newSocket, []);
  newSocket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });

  await waitUntilAsync(() => ui.commandsByBotId.get(cmd.botId)?.botStatus === "STOPPED");
  assert(ui.commandsByBotId.get(cmd.botId)?.botStatus === "STOPPED", "G) Seulement APRES l'inventaire vide recu a la reconnexion, le bot devient STOPPED");
  assert(ui.commandsByBotId.get(cmd.botId)?.botActive === false, "G) active=false une fois STOPPED");

  newSocket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST H: historique command FAILED + runtime stale =====================

const runTestH = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-H", "=== command.status=FAILED (START_BOT) + bot toujours actif -> reconciliation: botStatus STOPPED, command.status JAMAIS reecrit ===");
  const { agent, ui, uiSocket } = await setupAgencyWithAgent(baseUrl, adminCookie, "H");

  const cmd = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Failed History");
  agent.socket.emit("BOT_STATUS", { commandId: cmd.commandId, botId: cmd.botId, status: "STARTING" });
  agent.socket.emit("BOT_STATUS", { commandId: cmd.commandId, botId: cmd.botId, status: "WAITING_FOR_USER" });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmd.botId)?.botStatus === "WAITING_FOR_USER");

  // L'agent signale un echec APRES avoir deja rapporte le bot actif (exemple
  // reel documente dans agentCommandService.ts: command.status=FAILED alors
  // que botStatus=WAITING_FOR_USER, le bot est toujours vivant) - jamais
  // COMMAND_COMPLETED ici, uniquement COMMAND_FAILED.
  agent.socket.emit("COMMAND_FAILED", { commandId: cmd.commandId, errorCode: "TEST_INDUCED_FAILURE", message: "Echec simule pour ce test (histoire de commande volontairement divergente du runtime)." });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmd.botId)?.status === "FAILED");
  assert(ui.commandsByBotId.get(cmd.botId)?.status === "FAILED", "H) La commande START_BOT est bien FAILED (etat prealable au test)");
  assert(ui.commandsByBotId.get(cmd.botId)?.botStatus === "WAITING_FOR_USER", "H) Le bot reste WAITING_FOR_USER malgre la commande FAILED (deux concepts distincts)");

  agent.socket.disconnect();
  await sleep(300);
  const newSocket = await reconnectFakeAgent(baseUrl, agent.agentId, agent.token, `PW-RECONCIL-H-${RUN_SUFFIX}`);
  wireAutoAck(newSocket, []);
  newSocket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });

  await waitUntilAsync(() => ui.commandsByBotId.get(cmd.botId)?.botStatus === "STOPPED");
  const final = ui.commandsByBotId.get(cmd.botId);
  assert(final?.botStatus === "STOPPED", `H) Le runtime converge vers STOPPED apres reconciliation (recu: ${final?.botStatus})`);
  assert(final?.botActive === false, `H) active=false apres reconciliation (recu: ${final?.botActive})`);
  assert(final?.status === "FAILED", `H) command.status reste FAILED, jamais reecrit artificiellement en COMPLETED (recu: ${final?.status})`);

  newSocket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST I: botStatusUpdatedAt avance proprement =====================

const runTestI = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-I", "=== botStatusUpdatedAt avance proprement lors d'une transition par reconciliation ===");
  const { agent, ui, uiSocket } = await setupAgencyWithAgent(baseUrl, adminCookie, "I");

  const cmd = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Timestamp");
  agent.socket.emit("BOT_STATUS", { commandId: cmd.commandId, botId: cmd.botId, status: "MONITORING" });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmd.botId)?.botStatus === "MONITORING");
  const updatedAtBefore = ui.commandsByBotId.get(cmd.botId)?.botStatusUpdatedAt ?? null;
  assert(updatedAtBefore !== null, "I) botStatusUpdatedAt est bien renseigne avant reconciliation");

  await sleep(50);
  agent.socket.disconnect();
  await sleep(300);
  const newSocket = await reconnectFakeAgent(baseUrl, agent.agentId, agent.token, `PW-RECONCIL-I-${RUN_SUFFIX}`);
  wireAutoAck(newSocket, []);
  newSocket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });

  await waitUntilAsync(() => ui.commandsByBotId.get(cmd.botId)?.botStatus === "STOPPED");
  const updatedAtAfter = ui.commandsByBotId.get(cmd.botId)?.botStatusUpdatedAt ?? null;
  assert(updatedAtAfter !== null, "I) botStatusUpdatedAt reste renseigne apres la transition par reconciliation");
  assert(
    Boolean(updatedAtBefore && updatedAtAfter && updatedAtAfter > updatedAtBefore),
    `I) botStatusUpdatedAt avance strictement lors de la transition STOPPED par reconciliation (avant: ${updatedAtBefore}, apres: ${updatedAtAfter})`
  );

  newSocket.disconnect();
  uiSocket.disconnect();
};

// ===================== main =====================

const run = async (): Promise<void> => {
  let server: ServerHandle | undefined;
  try {
    server = await startServer(3399);
    const admin = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    await runTestA(server.baseUrl, admin.cookie);
    await runTestB(server.baseUrl, admin.cookie);
    await runTestC(server.baseUrl, admin.cookie, server);
    await runTestD(server.baseUrl, admin.cookie);
    await runTestE(server.baseUrl, admin.cookie);
    await runTestF(server.baseUrl, admin.cookie);
    await runTestG(server.baseUrl, admin.cookie);
    await runTestH(server.baseUrl, admin.cookie);
    await runTestI(server.baseUrl, admin.cookie);
  } finally {
    if (server) await stopServer(server);
    await cleanupTestData().catch((error) => log("CLEANUP_ERROR", String(error)));
    await pool.end().catch(() => undefined);
  }
};

run()
  .then(() => {
    console.log(`\n${passCount} succes, ${failCount} echec(s).`);
    process.exitCode = failCount > 0 ? 1 : 0;
  })
  .catch((error) => {
    console.error("[FATAL]", error);
    process.exitCode = 1;
  });
