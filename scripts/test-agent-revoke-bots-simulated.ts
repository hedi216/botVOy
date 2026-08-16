// HOTFIX CIBLE - Revoke Agent doit terminer tous ses bots.
//
// Cause racine corrigee ici: POST /api/agents/:id/revoke revoquait bien
// l'Agent en DB, faisait echouer ses commandes non terminales (AGENT_REVOKED)
// et coupait son socket - mais ne touchait JAMAIS AgentBotRecord. Les bots
// qui lui appartenaient pouvaient donc rester MONITORING/WAITING_FOR_USER/
// ERROR/RATE_LIMITED, active=true, comptes dans le quota, indefiniment (y
// compris si l'Agent etait deja hors ligne au moment du revoke, cas ou
// aucun evenement runtime ulterieur ne serait jamais venu les corriger).
//
// Corrige dans src/server.ts (route revoke, ordre precis) et
// src/agentCommandService.ts (stopAllBotsForAgent, reutilise
// listAgentBotsForAgent/updateAgentBotStatus deja existants - meme
// mecanisme que la reconciliation AGENT_RUNTIME_STATUS). Protection
// complementaire dans src/agentGateway.ts (BOT_STATUS): un rapport runtime
// tardif ne peut plus jamais reactiver un bot deja STOPPED, quelle qu'en
// soit la cause (STOP_BOT, revoke, ou reconciliation AGENT_RUNTIME_STATUS).
//
// Teste UNIQUEMENT la convergence SERVEUR (meme architecture que
// scripts/test-agent-runtime-reconciliation-simulated.ts: serveur reel +
// agents fantomes socket.io-client, jamais de vrai Chrome/agentMain.ts ici).
// L'arret physique reel des Chrome locaux (stopAllBotsForIdentityReset(),
// cote AgentBotManager) est deja couvert par
// scripts/test-agent-revoke-repair-real.ts (Scenario 1 + verification
// statique qu'applyPermanentFailurePolicy() appelle bien cette methode,
// jamais shutdownAll()) - non duplique ici.
//
// Usage: npx tsx scripts/test-agent-revoke-bots-simulated.ts

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

// ===================== Serveur reel =====================

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
  child.stdout?.on("data", (c: Buffer) => { stdout.push(c.toString()); });
  child.stderr?.on("data", (c: Buffer) => { stdout.push(c.toString()); });
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

const revokeAgentViaApi = (baseUrl: string, managerCookie: string, agentId: number): Promise<HttpResult> =>
  requestJson(baseUrl, "POST", `/api/agents/${agentId}/revoke`, managerCookie, {});

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

// Tentative de reconnexion sur le MEME agentId/token - jamais resolue en
// succes pour un agent revoque (utilise pour prouver TC7-like: le socket
// n'est plus autorise apres revoke).
const attemptReconnectFakeAgent = (baseUrl: string, agentId: number, token: string, computerName: string): Promise<{ ok: true; socket: Socket } | { ok: false; reason: string }> =>
  new Promise((resolve) => {
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "reconnect", agentId, token, computerName, version: "1.0.0", protocolVersion: 1 }
    });
    const t = setTimeout(() => { socket.disconnect(); resolve({ ok: false, reason: "TIMEOUT" }); }, 8_000);
    socket.on("connect_error", (e: Error) => { clearTimeout(t); resolve({ ok: false, reason: e.message }); });
    socket.on("AGENT_CONNECTED", () => { clearTimeout(t); resolve({ ok: true, socket }); });
    socket.connect();
  });

type ReadyAgent = FakeAgentHandle & { commandsSeen: Array<Record<string, unknown>> };

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
  errorCode: string | null;
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

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

const setupAgencyWithAgent = async (
  baseUrl: string,
  adminCookie: string,
  label: string
): Promise<{ agencyId: number; managerCookie: string; agent: ReadyAgent; ui: Ui; uiSocket: Socket }> => {
  const agencyName = `Test Revoke Bots ${label} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;

  const managerLogin = `test-revoke-bots-mgr-${label.toLowerCase()}-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const managerResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: `Manager ${label}`, email: `${managerLogin}@example.test`, role: 1
  });
  const managerPassword = (managerResult.body as { temporaryPassword: string }).temporaryPassword;
  const managerCookie = (await loginWithRetry(baseUrl, managerLogin, managerPassword)).cookie;

  const agent = await setupReadyAgent(baseUrl, managerCookie, `PW-REVOKEBOTS-${label}-${RUN_SUFFIX}`);
  const uiSocket = await connectUiSocket(baseUrl, managerCookie);
  const ui = trackUiSocket(uiSocket);
  await waitUntilAsync(() => ui.maintenance !== null);

  return { agencyId, managerCookie, agent, ui, uiSocket };
};

const startBotAndCapture = async (ui: Ui, uiSocket: Socket, agentId: number, botName: string): Promise<CommandSnapshot> => {
  uiSocket.emit("start-bot", { botName, category: "", agentId, clientRequestId: `tc-revokebots-${botName.replace(/\s+/g, "-")}-${RUN_SUFFIX}` });
  const gotCommand = await waitUntilAsync(() => ui.commandsByBotName.has(botName), 8_000);
  if (!gotCommand) throw new Error(`START_BOT jamais recu pour ${botName}.`);
  return ui.commandsByBotName.get(botName)!;
};

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  if (createdAgencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
};

// ===================== TEST A: revoke avec plusieurs bots actifs =====================

const runTestA = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-A", "=== Revoke Agent avec plusieurs bots (MONITORING/WAITING_FOR_USER/ERROR) -> tous STOPPED/active=false ===");
  const { agent, ui, uiSocket, managerCookie } = await setupAgencyWithAgent(baseUrl, adminCookie, "A");

  const cmdA = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Revoke A");
  agent.socket.emit("BOT_STATUS", { commandId: cmdA.commandId, botId: cmdA.botId, status: "MONITORING" });
  const cmdB = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Revoke B");
  agent.socket.emit("BOT_STATUS", { commandId: cmdB.commandId, botId: cmdB.botId, status: "WAITING_FOR_USER" });
  const cmdC = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Revoke C");
  agent.socket.emit("BOT_STATUS", { commandId: cmdC.commandId, botId: cmdC.botId, status: "ERROR" });
  await waitUntilAsync(() =>
    ui.commandsByBotId.get(cmdA.botId)?.botStatus === "MONITORING"
    && ui.commandsByBotId.get(cmdB.botId)?.botStatus === "WAITING_FOR_USER"
    && ui.commandsByBotId.get(cmdC.botId)?.botStatus === "ERROR");

  // ERROR est deja active=false par conception PRE-EXISTANTE (jamais compte
  // dans le quota, cf. agentCommandService.ts: bot.active = status !==
  // "STOPPED" && status !== "ERROR") - inchange par ce correctif. Seuls A et
  // B sont donc reellement actifs avant le revoke.
  assert(ui.commandsByBotId.get(cmdC.botId)?.botActive === false, "A) (rappel comportement preexistant) ERROR est deja active=false avant tout revoke");
  const countBefore = ui.maintenance?.agencyActiveCount ?? -1;

  const revokeResult = await revokeAgentViaApi(baseUrl, managerCookie, agent.agentId);
  assert(revokeResult.status === 200, `A) La revocation reussit (recu: ${revokeResult.status})`);
  assert((revokeResult.body as { agent?: { status?: string } } | null)?.agent?.status === "REVOKED", "A) L'agent est bien REVOKED dans la reponse");

  await waitUntilAsync(() =>
    ui.commandsByBotId.get(cmdA.botId)?.botStatus === "STOPPED"
    && ui.commandsByBotId.get(cmdB.botId)?.botStatus === "STOPPED"
    && ui.commandsByBotId.get(cmdC.botId)?.botStatus === "STOPPED");

  for (const [label, cmd] of [["A (etait MONITORING)", cmdA], ["B (etait WAITING_FOR_USER)", cmdB], ["C (etait ERROR)", cmdC]] as const) {
    const final = ui.commandsByBotId.get(cmd.botId);
    assert(final?.botStatus === "STOPPED", `A) Bot ${label} devient STOPPED apres revoke (recu: ${final?.botStatus})`);
    assert(final?.botActive === false, `A) Bot ${label} a bien active=false apres revoke (recu: ${final?.botActive})`);
  }

  await waitUntilAsync(() => ui.maintenance?.agencyActiveCount === countBefore - 2);
  assert(
    ui.maintenance?.agencyActiveCount === countBefore - 2,
    `A) Le quota diminue exactement du nombre de bots reellement actifs avant revoke (A+B=2, C deja exclu) (avant: ${countBefore}, apres: ${ui.maintenance?.agencyActiveCount})`
  );

  agent.socket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST B: bot deja STOPPED =====================

const runTestB = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-B", "=== Revoke avec un bot deja STOPPED -> reste STOPPED, l'autre devient STOPPED, aucune erreur ===");
  const { agent, ui, uiSocket, managerCookie } = await setupAgencyWithAgent(baseUrl, adminCookie, "B");

  const cmdA = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Revoke Already Stopped A");
  agent.socket.emit("BOT_STATUS", { commandId: cmdA.commandId, botId: cmdA.botId, status: "WAITING_FOR_USER" });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmdA.botId)?.botStatus === "WAITING_FOR_USER");
  // Arret normal (STOP_BOT), independant du revoke qui suit.
  uiSocket.emit("stop-bot", { botId: cmdA.botId, clientRequestId: `tc-revokebots-stop-a-${RUN_SUFFIX}` });
  await waitUntilAsync(() => agent.commandsSeen.some((c) => c.type === "STOP_BOT" && c.botId === cmdA.botId));
  const stopCmd = agent.commandsSeen.find((c) => c.type === "STOP_BOT" && c.botId === cmdA.botId)!;
  agent.socket.emit("BOT_STATUS", { commandId: stopCmd.commandId, botId: cmdA.botId, status: "STOPPED" });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: stopCmd.commandId, completedAt: new Date().toISOString(), result: { botId: cmdA.botId, status: "STOPPED", stopped: true } });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmdA.botId)?.botStatus === "STOPPED");
  const updatedAtBeforeRevoke = ui.commandsByBotId.get(cmdA.botId)?.botStatusUpdatedAt ?? null;

  const cmdB = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Revoke Already Stopped B");
  agent.socket.emit("BOT_STATUS", { commandId: cmdB.commandId, botId: cmdB.botId, status: "MONITORING" });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmdB.botId)?.botStatus === "MONITORING");

  const revokeResult = await revokeAgentViaApi(baseUrl, managerCookie, agent.agentId);
  assert(revokeResult.status === 200, `B) La revocation reussit malgre un bot deja STOPPED (recu: ${revokeResult.status})`);

  await waitUntilAsync(() => ui.commandsByBotId.get(cmdB.botId)?.botStatus === "STOPPED");
  assert(ui.commandsByBotId.get(cmdA.botId)?.botStatus === "STOPPED", "B) Le bot deja STOPPED reste STOPPED (aucune reactivation/erreur)");
  assert(ui.commandsByBotId.get(cmdB.botId)?.botStatus === "STOPPED", "B) Le bot encore actif devient STOPPED");
  assert(ui.commandsByBotId.get(cmdB.botId)?.botActive === false, "B) active=false pour le bot nouvellement stoppe");
  const updatedAtAfterRevoke = ui.commandsByBotId.get(cmdA.botId)?.botStatusUpdatedAt ?? null;
  assert(
    updatedAtBeforeRevoke === updatedAtAfterRevoke,
    `B) Le bot deja STOPPED n'est pas re-touche par le revoke (botStatusUpdatedAt inchange: avant=${updatedAtBeforeRevoke}, apres=${updatedAtAfterRevoke})`
  );

  agent.socket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST C: isolation entre Agents (meme agence) =====================

const runTestC = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-C", "=== Isolation stricte: revoke Agent 1 ne touche JAMAIS les bots de l'Agent 2 (meme agence) ===");
  const agencyName = `Test Revoke Bots C ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;
  const managerLogin = `test-revoke-bots-mgr-c-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const managerResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: "Manager C", email: `${managerLogin}@example.test`, role: 1
  });
  const managerPassword = (managerResult.body as { temporaryPassword: string }).temporaryPassword;
  const managerCookie = (await loginWithRetry(baseUrl, managerLogin, managerPassword)).cookie;

  const agent1 = await setupReadyAgent(baseUrl, managerCookie, `PW-REVOKEBOTS-C1-${RUN_SUFFIX}`);
  const agent2 = await setupReadyAgent(baseUrl, managerCookie, `PW-REVOKEBOTS-C2-${RUN_SUFFIX}`);
  const uiSocket = await connectUiSocket(baseUrl, managerCookie);
  const ui = trackUiSocket(uiSocket);
  await waitUntilAsync(() => ui.maintenance !== null);

  const cmdA = await startBotAndCapture(ui, uiSocket, agent1.agentId, "Bot Isol Revoke A");
  agent1.socket.emit("BOT_STATUS", { commandId: cmdA.commandId, botId: cmdA.botId, status: "MONITORING" });
  const cmdB = await startBotAndCapture(ui, uiSocket, agent1.agentId, "Bot Isol Revoke B");
  agent1.socket.emit("BOT_STATUS", { commandId: cmdB.commandId, botId: cmdB.botId, status: "WAITING_FOR_USER" });
  const cmdC = await startBotAndCapture(ui, uiSocket, agent2.agentId, "Bot Isol Revoke C");
  agent2.socket.emit("BOT_STATUS", { commandId: cmdC.commandId, botId: cmdC.botId, status: "MONITORING" });
  const cmdD = await startBotAndCapture(ui, uiSocket, agent2.agentId, "Bot Isol Revoke D");
  agent2.socket.emit("BOT_STATUS", { commandId: cmdD.commandId, botId: cmdD.botId, status: "RATE_LIMITED" });
  await waitUntilAsync(() =>
    ui.commandsByBotId.get(cmdA.botId)?.botStatus === "MONITORING"
    && ui.commandsByBotId.get(cmdB.botId)?.botStatus === "WAITING_FOR_USER"
    && ui.commandsByBotId.get(cmdC.botId)?.botStatus === "MONITORING"
    && ui.commandsByBotId.get(cmdD.botId)?.botStatus === "RATE_LIMITED");

  const revokeResult = await revokeAgentViaApi(baseUrl, managerCookie, agent1.agentId);
  assert(revokeResult.status === 200, `C) Revoke Agent 1 reussit (recu: ${revokeResult.status})`);

  await waitUntilAsync(() => ui.commandsByBotId.get(cmdA.botId)?.botStatus === "STOPPED" && ui.commandsByBotId.get(cmdB.botId)?.botStatus === "STOPPED");
  assert(ui.commandsByBotId.get(cmdA.botId)?.botStatus === "STOPPED", "C) Bot A (Agent 1) -> STOPPED");
  assert(ui.commandsByBotId.get(cmdB.botId)?.botStatus === "STOPPED", "C) Bot B (Agent 1) -> STOPPED");

  await sleep(1_000);
  assert(ui.commandsByBotId.get(cmdC.botId)?.botStatus === "MONITORING", `C) Bot C (Agent 2) totalement inchange (recu: ${ui.commandsByBotId.get(cmdC.botId)?.botStatus})`);
  assert(ui.commandsByBotId.get(cmdC.botId)?.botActive === true, "C) Bot C (Agent 2) reste actif");
  assert(ui.commandsByBotId.get(cmdD.botId)?.botStatus === "RATE_LIMITED", `C) Bot D (Agent 2) totalement inchange (recu: ${ui.commandsByBotId.get(cmdD.botId)?.botStatus})`);
  assert(ui.commandsByBotId.get(cmdD.botId)?.botActive === true, "C) Bot D (Agent 2) reste actif");

  agent1.socket.disconnect();
  agent2.socket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST D: Agent hors ligne au moment du revoke =====================

const runTestD = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-D", "=== Agent hors ligne (bots actifs cote serveur, aucun socket connecte) -> revoke libere quand meme immediatement le quota ===");
  const { agent, ui, uiSocket, managerCookie } = await setupAgencyWithAgent(baseUrl, adminCookie, "D");

  const cmdA = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Offline Revoke A");
  agent.socket.emit("BOT_STATUS", { commandId: cmdA.commandId, botId: cmdA.botId, status: "MONITORING" });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmdA.botId)?.botStatus === "MONITORING");
  const countBefore = ui.maintenance?.agencyActiveCount ?? -1;

  // "PC Agent hors ligne": deconnexion PURE, jamais de revoke pour l'instant -
  // le bot doit rester actif (non-regression deja verifiee par
  // test-agent-runtime-reconciliation-simulated.ts, Test F) - ici on verifie
  // seulement que le revoke QUI SUIT fonctionne bien SANS aucun socket connecte.
  agent.socket.disconnect();
  await sleep(500);

  const revokeResult = await revokeAgentViaApi(baseUrl, managerCookie, agent.agentId);
  assert(revokeResult.status === 200, `D) Revoke reussit alors que l'Agent est hors ligne (recu: ${revokeResult.status})`);
  assert((revokeResult.body as { agent?: { status?: string } } | null)?.agent?.status === "REVOKED", "D) L'agent est REVOKED cote serveur malgre l'absence de socket");

  await waitUntilAsync(() => ui.commandsByBotId.get(cmdA.botId)?.botStatus === "STOPPED");
  assert(ui.commandsByBotId.get(cmdA.botId)?.botStatus === "STOPPED", "D) Le bot devient STOPPED immediatement, sans avoir besoin d'un socket connecte");
  assert(ui.commandsByBotId.get(cmdA.botId)?.botActive === false, "D) active=false immediatement");
  await waitUntilAsync(() => ui.maintenance?.agencyActiveCount === countBefore - 1);
  assert(ui.maintenance?.agencyActiveCount === countBefore - 1, `D) Le quota est libere sans qu'aucun socket agent ne soit necessaire (avant: ${countBefore}, apres: ${ui.maintenance?.agencyActiveCount})`);

  uiSocket.disconnect();
};

// ===================== TEST E: Agent connecte - REVOKED + socket refuse =====================

const runTestE = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-E", "=== Agent connecte au moment du revoke -> devient REVOKED, reconnexion definitivement refusee (AGENT_REVOKED) ===");
  // NOTE: l'arret physique reel des Chrome locaux (stopAllBotsForIdentityReset,
  // registre local vide, credentials effaces) est deja couvert par
  // scripts/test-agent-revoke-repair-real.ts (AgentBotManager reel, vrai
  // Chrome) - non duplique ici, ce test verifie uniquement le contrat serveur
  // observable via un agent fantome (aucun vrai Chrome/agentMain.ts).
  const { agent, ui, uiSocket, managerCookie } = await setupAgencyWithAgent(baseUrl, adminCookie, "E");

  const cmdA = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Connected Revoke A");
  agent.socket.emit("BOT_STATUS", { commandId: cmdA.commandId, botId: cmdA.botId, status: "MONITORING" });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmdA.botId)?.botStatus === "MONITORING");
  assert(agent.socket.connected, "E) L'agent est bien connecte avant le revoke (etat prealable au test)");

  const revokeResult = await revokeAgentViaApi(baseUrl, managerCookie, agent.agentId);
  assert(revokeResult.status === 200, `E) Revoke reussit pour un agent connecte (recu: ${revokeResult.status})`);
  assert((revokeResult.body as { agent?: { status?: string } } | null)?.agent?.status === "REVOKED", "E) L'agent devient REVOKED");

  await waitUntilAsync(() => !agent.socket.connected, 5_000);
  assert(!agent.socket.connected, "E) Le socket de l'agent est bien coupe par le serveur (disconnectAgentSocket)");

  const reconnectResult = await attemptReconnectFakeAgent(baseUrl, agent.agentId, agent.token, `PW-REVOKEBOTS-E-${RUN_SUFFIX}`);
  assert(!reconnectResult.ok, "E) Une nouvelle tentative de connexion (meme agentId/token) est refusee apres revoke");
  if (!reconnectResult.ok) {
    assert(reconnectResult.reason === "AGENT_REVOKED", `E) La raison exacte est AGENT_REVOKED (recu: ${reconnectResult.reason})`);
  }

  await waitUntilAsync(() => ui.commandsByBotId.get(cmdA.botId)?.botStatus === "STOPPED");
  assert(ui.commandsByBotId.get(cmdA.botId)?.botStatus === "STOPPED", "E) Le bot local (rapporte MONITORING) converge vers STOPPED cote serveur");

  uiSocket.disconnect();
};

// ===================== TEST F: commandes non terminales -> AGENT_REVOKED =====================

const runTestF = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-F", "=== Commande non terminale (START_BOT acknowledged) au moment du revoke -> FAILED/AGENT_REVOKED, jamais reecrite en COMPLETED ===");
  const { agent, ui, uiSocket, managerCookie } = await setupAgencyWithAgent(baseUrl, adminCookie, "F");

  // startBotAndCapture ACK deja automatiquement (setupReadyAgent) mais ne
  // complete JAMAIS: la commande START_BOT reste "acknowledged" (non
  // terminale) au moment du revoke - etat prealable volontaire.
  const cmd = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot NonTerminal Revoke");
  await waitUntilAsync(() => ui.commandsByBotId.get(cmd.botId)?.status === "ACKNOWLEDGED");
  assert(ui.commandsByBotId.get(cmd.botId)?.status === "ACKNOWLEDGED", "F) La commande START_BOT est bien non terminale avant le revoke (etat prealable au test)");

  const revokeResult = await revokeAgentViaApi(baseUrl, managerCookie, agent.agentId);
  assert(revokeResult.status === 200, `F) Revoke reussit (recu: ${revokeResult.status})`);

  await waitUntilAsync(() => ui.commandsByBotId.get(cmd.botId)?.status === "FAILED");
  const final = ui.commandsByBotId.get(cmd.botId);
  assert(final?.status === "FAILED", `F) La commande START_BOT non terminale devient FAILED (recu: ${final?.status})`);
  assert(final?.errorCode === "AGENT_REVOKED", `F) errorCode = AGENT_REVOKED, jamais reecrite en COMPLETED (recu: ${final?.errorCode})`);
  assert(final?.botStatus === "STOPPED", "F) Le runtime du bot converge quand meme vers STOPPED (deux concepts distincts)");

  agent.socket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST G: protection contre un evenement runtime tardif =====================

const runTestG = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-G", "=== Un bot STOPPED (par revoke OU par STOP_BOT normal) ne peut plus jamais etre reactive par un rapport runtime tardif ===");
  const { agent, ui, uiSocket, managerCookie } = await setupAgencyWithAgent(baseUrl, adminCookie, "G");

  // ----- Volet 1: apres revoke, le canal lui-meme est coupe (aucun nouvel
  // evenement ne peut plus jamais atteindre le serveur pour cette identite). -----
  const cmdA = await startBotAndCapture(ui, uiSocket, agent.agentId, "Bot Late Event Revoke");
  agent.socket.emit("BOT_STATUS", { commandId: cmdA.commandId, botId: cmdA.botId, status: "MONITORING" });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmdA.botId)?.botStatus === "MONITORING");
  await revokeAgentViaApi(baseUrl, managerCookie, agent.agentId);
  await waitUntilAsync(() => ui.commandsByBotId.get(cmdA.botId)?.botStatus === "STOPPED");
  await waitUntilAsync(() => !agent.socket.connected, 5_000);
  assert(!agent.socket.connected, "G) Apres revoke, le socket de l'agent est coupe: plus aucun BOT_STATUS ne peut physiquement etre emis pour cette identite");

  // ----- Volet 2: preuve directe du GARDE-FOU lui-meme (agentGateway.ts,
  // BOT_STATUS) - meme mecanisme de convergence que le revoke
  // (updateAgentBotStatus), teste ici via un STOP_BOT normal (le SEUL moyen
  // de garder un socket valide pour rejouer un evenement tardif sur le MEME
  // botId, un agent revoque ne pouvant plus jamais se reconnecter du tout). -----
  const agent2 = await setupReadyAgent(baseUrl, managerCookie, `PW-REVOKEBOTS-G2-${RUN_SUFFIX}`);
  const cmdB = await startBotAndCapture(ui, uiSocket, agent2.agentId, "Bot Late Event StopBot");
  agent2.socket.emit("BOT_STATUS", { commandId: cmdB.commandId, botId: cmdB.botId, status: "WAITING_FOR_USER" });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmdB.botId)?.botStatus === "WAITING_FOR_USER");

  uiSocket.emit("stop-bot", { botId: cmdB.botId, clientRequestId: `tc-revokebots-late-${RUN_SUFFIX}` });
  await waitUntilAsync(() => agent2.commandsSeen.some((c) => c.type === "STOP_BOT" && c.botId === cmdB.botId));
  const stopCmd = agent2.commandsSeen.find((c) => c.type === "STOP_BOT" && c.botId === cmdB.botId)!;
  agent2.socket.emit("BOT_STATUS", { commandId: stopCmd.commandId, botId: cmdB.botId, status: "STOPPED" });
  agent2.socket.emit("COMMAND_COMPLETED", { commandId: stopCmd.commandId, completedAt: new Date().toISOString(), result: { botId: cmdB.botId, status: "STOPPED", stopped: true } });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmdB.botId)?.botStatus === "STOPPED");

  // Rapport tardif REJOUE sur le MEME commandId d'origine (startCommandId,
  // reutilise par l'agent reel pour tout BOT_STATUS de la vie du bot,
  // cf. agentBotManager.ts) - simule un evenement en vol depuis avant l'arret.
  agent2.socket.emit("BOT_STATUS", { commandId: cmdB.commandId, botId: cmdB.botId, status: "MONITORING" });
  await sleep(700);
  const afterLateEvent = ui.commandsByBotId.get(cmdB.botId);
  assert(afterLateEvent?.botStatus === "STOPPED", `G) Le rapport tardif MONITORING est refuse: le bot reste STOPPED (recu: ${afterLateEvent?.botStatus})`);
  assert(afterLateEvent?.botActive === false, `G) active reste false apres le rapport tardif (recu: ${afterLateEvent?.botActive})`);
  const lateEventIgnored = await waitUntilAsync(() => server.stdout.join("").includes("tardif") || server.stdout.join("").includes(cmdB.botId), 2_000);
  assert(lateEventIgnored, "G) Le rejet du rapport tardif est journalise");

  agent2.socket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST H: quota apres revoke partiel =====================

const runTestH = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-H", "=== Quota d'agence: 8 actifs (5 de l'Agent revoque, 3 d'un autre) -> 3 apres revoke ===");
  const agencyName = `Test Revoke Bots H ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;
  const managerLogin = `test-revoke-bots-mgr-h-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const managerResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: "Manager H", email: `${managerLogin}@example.test`, role: 1
  });
  const managerPassword = (managerResult.body as { temporaryPassword: string }).temporaryPassword;
  const managerCookie = (await loginWithRetry(baseUrl, managerLogin, managerPassword)).cookie;

  const revokedAgent = await setupReadyAgent(baseUrl, managerCookie, `PW-REVOKEBOTS-H-REVOKED-${RUN_SUFFIX}`);
  const otherAgent = await setupReadyAgent(baseUrl, managerCookie, `PW-REVOKEBOTS-H-OTHER-${RUN_SUFFIX}`);
  const uiSocket = await connectUiSocket(baseUrl, managerCookie);
  const ui = trackUiSocket(uiSocket);
  await waitUntilAsync(() => ui.maintenance !== null);

  for (let i = 1; i <= 5; i += 1) {
    const cmd = await startBotAndCapture(ui, uiSocket, revokedAgent.agentId, `Bot H Revoked ${i}`);
    revokedAgent.socket.emit("BOT_STATUS", { commandId: cmd.commandId, botId: cmd.botId, status: "MONITORING" });
  }
  for (let i = 1; i <= 3; i += 1) {
    const cmd = await startBotAndCapture(ui, uiSocket, otherAgent.agentId, `Bot H Other ${i}`);
    otherAgent.socket.emit("BOT_STATUS", { commandId: cmd.commandId, botId: cmd.botId, status: "MONITORING" });
  }
  await waitUntilAsync(() => ui.maintenance?.agencyActiveCount === 8);
  assert(ui.maintenance?.agencyActiveCount === 8, `H) 8 bots actifs avant revoke (recu: ${ui.maintenance?.agencyActiveCount})`);

  await revokeAgentViaApi(baseUrl, managerCookie, revokedAgent.agentId);
  await waitUntilAsync(() => ui.maintenance?.agencyActiveCount === 3);
  assert(ui.maintenance?.agencyActiveCount === 3, `H) countActiveAgentBotsForAgency() = 3 apres revoke des 5 bots d'un seul Agent (recu: ${ui.maintenance?.agencyActiveCount})`);

  revokedAgent.socket.disconnect();
  otherAgent.socket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST I: aucun impact sur un autre Agent (commandes normales) =====================

const runTestI = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-I", "=== Un autre Agent connecte continue de recevoir/executer ses commandes normalement apres le revoke du premier ===");
  const { agencyId: _agencyId, agent: revokedAgent, ui, uiSocket, managerCookie } = await setupAgencyWithAgent(baseUrl, adminCookie, "I");
  const otherAgent = await setupReadyAgent(baseUrl, managerCookie, `PW-REVOKEBOTS-I-OTHER-${RUN_SUFFIX}`);

  const cmdRevoked = await startBotAndCapture(ui, uiSocket, revokedAgent.agentId, "Bot I Revoked");
  revokedAgent.socket.emit("BOT_STATUS", { commandId: cmdRevoked.commandId, botId: cmdRevoked.botId, status: "MONITORING" });
  const cmdOther = await startBotAndCapture(ui, uiSocket, otherAgent.agentId, "Bot I Other");
  otherAgent.socket.emit("BOT_STATUS", { commandId: cmdOther.commandId, botId: cmdOther.botId, status: "MONITORING" });
  await waitUntilAsync(() => ui.commandsByBotId.get(cmdRevoked.botId)?.botStatus === "MONITORING" && ui.commandsByBotId.get(cmdOther.botId)?.botStatus === "MONITORING");

  await revokeAgentViaApi(baseUrl, managerCookie, revokedAgent.agentId);
  await waitUntilAsync(() => ui.commandsByBotId.get(cmdRevoked.botId)?.botStatus === "STOPPED");

  // L'autre Agent recoit et execute une commande STOP_BOT normale, comme si
  // de rien n'etait.
  uiSocket.emit("stop-bot", { botId: cmdOther.botId, clientRequestId: `tc-revokebots-other-${RUN_SUFFIX}` });
  await waitUntilAsync(() => otherAgent.commandsSeen.some((c) => c.type === "STOP_BOT" && c.botId === cmdOther.botId));
  const stopCmd = otherAgent.commandsSeen.find((c) => c.type === "STOP_BOT" && c.botId === cmdOther.botId)!;
  assert(Boolean(stopCmd), "I) L'autre Agent recoit bien la commande STOP_BOT apres le revoke du premier");
  otherAgent.socket.emit("BOT_STATUS", { commandId: stopCmd.commandId, botId: cmdOther.botId, status: "STOPPED" });
  otherAgent.socket.emit("COMMAND_COMPLETED", { commandId: stopCmd.commandId, completedAt: new Date().toISOString(), result: { botId: cmdOther.botId, status: "STOPPED", stopped: true } });

  await waitUntilAsync(() => ui.commandsByBotId.get(cmdOther.botId)?.status === "COMPLETED");
  assert(ui.commandsByBotId.get(cmdOther.botId)?.status === "COMPLETED", "I) La commande de l'autre Agent se termine normalement (COMPLETED)");
  assert(ui.commandsByBotId.get(cmdOther.botId)?.botStatus === "STOPPED", "I) Le bot de l'autre Agent converge normalement vers STOPPED (via son propre STOP_BOT, pas via le revoke)");

  otherAgent.socket.disconnect();
  uiSocket.disconnect();
};

// ===================== main =====================

let server: ServerHandle;

const run = async (): Promise<void> => {
  try {
    server = await startServer(3403);
    const admin = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    await runTestA(server.baseUrl, admin.cookie);
    await runTestB(server.baseUrl, admin.cookie);
    await runTestC(server.baseUrl, admin.cookie);
    await runTestD(server.baseUrl, admin.cookie);
    await runTestE(server.baseUrl, admin.cookie);
    await runTestF(server.baseUrl, admin.cookie);
    await runTestG(server.baseUrl, admin.cookie);
    await runTestH(server.baseUrl, admin.cookie);
    await runTestI(server.baseUrl, admin.cookie);
  } finally {
    if (server!) await stopServer(server);
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
