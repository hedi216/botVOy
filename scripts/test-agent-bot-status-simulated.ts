// Tests SIMULES du cycle de vie botStatus (course COMMAND_ACK/BOT_STATUS/
// COMMAND_COMPLETED, persistance apres COMPLETED, gating Valider/Arreter,
// isolation inter-agence). Ce script NE LANCE JAMAIS src/agent/agentMain.ts
// ET NE LANCE JAMAIS Chrome: tout agent est un socket.io-client fantome
// (auth "pair" reelle, mais reponses simulees), et le seul navigateur
// demarre ici est le Chromium headless de Playwright utilise comme harnais
// de test pour piloter l'INTERFACE WEB elle-meme (jamais le "Chrome du bot").
// Peut donc etre execute sans risque sur la VM.
//
// Pour le scenario avec le vrai runtime agent + vrai Chrome visible (a
// executer uniquement sur un PC Windows personnel/interactif), voir
// scripts/test-agent-bot-status-real.ts.
//
// Usage: npx tsx scripts/test-agent-bot-status-simulated.ts
//    ou: npm run test:agent:bot-status:simulated

import { ChildProcess, spawn } from "node:child_process";
import { Browser, Page, chromium } from "playwright";
import { Socket, io as ioClient } from "socket.io-client";
import { pool } from "../src/db.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000, intervalMs = 150): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};

// --- Cycle de vie serveur ---

type ServerHandle = { child: ChildProcess; baseUrl: string };
const runningServers: ServerHandle[] = [];

const waitForServerReady = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`${baseUrl}/api/me`); if (res.status === 401 || res.status === 200) return; } catch { /* pas encore pret */ }
    await sleep(500);
  }
  throw new Error("Le serveur de test n'a jamais repondu.");
};

const startServer = async (port: number, env: Record<string, string>): Promise<ServerHandle> => {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(command, ["tsx", "src/server.ts"], {
    env: { ...process.env, WEB_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  child.stdout?.on("data", (c: Buffer) => log("SERVER", c.toString().trim()));
  child.stderr?.on("data", (c: Buffer) => log("SERVER-ERR", c.toString().trim()));
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  const handle = { child, baseUrl };
  runningServers.push(handle);
  return handle;
};

const killTree = (pid: number | undefined): Promise<void> => new Promise((resolve) => {
  if (!pid) { resolve(); return; }
  if (process.platform === "win32") {
    const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
    k.once("exit", () => resolve());
    k.once("error", () => resolve());
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* deja mort */ }
  resolve();
});

// --- HTTP / auth ---

const requestJson = async (baseUrl: string, method: string, pathName: string, cookie: string | undefined, json?: unknown): Promise<any> => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(json ?? {}) } : {})
  });
  const text = await res.text();
  const setCookie = res.headers.get("set-cookie");
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, cookie: setCookie?.split(";")[0] };
};

const login = async (baseUrl: string, loginName: string, password: string): Promise<string> => {
  const result = await requestJson(baseUrl, "POST", "/api/login", undefined, { login: loginName, password });
  if (result.status !== 200 || !result.cookie) throw new Error(`Login ${loginName} echoue: ${JSON.stringify(result.body)}`);
  return result.cookie;
};

const loginWithRetry = async (baseUrl: string, loginName: string, password: string, attempts = 5): Promise<string> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await login(baseUrl, loginName, password); } catch (error) { lastError = error; await sleep(1_000); }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

const createAgencyAndManager = async (baseUrl: string, adminCookie: string, labelSuffix: string) => {
  const agencyName = `Test BotStatus Sim ${labelSuffix} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = agencyResult.body.agency.id;
  const managerLogin = `test-botstatus-sim-${labelSuffix.toLowerCase()}-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const userResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: `Manager ${labelSuffix}`, email: `${managerLogin}@example.test`, role: 1
  });
  return { agencyId, managerLogin, managerPassword: userResult.body.temporaryPassword as string };
};

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  if (createdAgencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
};

// --- Agent fantome (socket.io-client brut: authentification /agent reelle,
// mais reponses COMMAND_ACK/BOT_STATUS/COMMAND_COMPLETED simulees a la main.
// AUCUN process src/agent/agentMain.ts, AUCUN Chrome.) ---

type FakeAgentHandle = { agentId: number; token: string; socket: Socket };

const pairFakeAgent = async (baseUrl: string, managerCookie: string, computerName: string): Promise<FakeAgentHandle> => {
  const pairing = await requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
  return new Promise((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "pair", pairingCode: pairing.body.pairing.code, computerName, version: "1.0.0", protocolVersion: 1 }
    });
    const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout agent fantome.")); }, 8_000);
    socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
    socket.on("AGENT_CONNECTED", (payload: { agentId: number; token: string | null }) => {
      clearTimeout(t);
      if (!payload.token) { reject(new Error("Aucun jeton.")); return; }
      // Lot 5: sans AGENT_RUNTIME_STATUS, l'agent reste READY_FOR_COMMANDS=
      // false et le serveur refuse de dispatcher START_BOT (AGENT_SYNCING).
      socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
      resolve({ agentId: payload.agentId, token: payload.token, socket });
    });
    socket.connect();
  });
};

const waitUntilValue = async <T>(getter: () => T | undefined, timeoutMs = 8_000): Promise<T | undefined> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = getter();
    if (value) return value;
    await sleep(100);
  }
  return getter();
};

// --- Helpers DOM (page web pilotee par le Chromium headless du harnais de test) ---

const rowFor = (page: Page, botNameText: string) => page.locator("#agentCommandsTableBody tr", { hasText: botNameText });
const stopButtonFor = (page: Page, botNameText: string) => rowFor(page, botNameText).locator("button", { hasText: "Arreter" });
const validateButtonFor = (page: Page, botNameText: string) => rowFor(page, botNameText).locator("button", { hasText: "Valider" });

const loginViaUi = async (page: Page, baseUrl: string, loginName: string, password: string): Promise<void> => {
  await page.goto(baseUrl);
  await page.fill("#loginInput", loginName);
  await page.fill("#passwordInput", password);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
};

const startBotViaUi = async (page: Page, botName: string): Promise<void> => {
  await page.fill("#botFormName", botName);
  await page.selectOption("#botFormCategory", { index: 1 });
  await page.fill("#botFormLogin", "x");
  await page.fill("#botFormPassword", "y");
  await page.click("#startBot");
};

// ===================== Scenario 1: preuve de la race (stress, sans Playwright) =====================
// Reproduit la timing exacte d'AgentBotManager.startBot() reel: ACK, BOT_STATUS
// STARTING, BOT_STATUS WAITING_FOR_USER et COMMAND_COMPLETED emis en
// succession la plus rapide possible (zero delai), sur N commandes
// concurrentes. Avant le correctif de serialisation par commandId
// (src/agentGateway.ts), ~17% des commandes finissaient dans un etat
// incoherent; ce scenario doit rester a 0/N.

const runStressScenario = async (baseUrl: string, managerCookie: string, iterations: number): Promise<void> => {
  log("SCENARIO-1", `=== Course COMMAND_ACK/BOT_STATUS/COMMAND_COMPLETED (${iterations} iterations) ===`);
  const pairing = await requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
  const agentSocket: Socket = await new Promise((resolve, reject) => {
    const s = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "pair", pairingCode: pairing.body.pairing.code, computerName: "STRESS-PC", version: "1.0.0", protocolVersion: 1 }
    });
    const t = setTimeout(() => reject(new Error("timeout agent")), 8_000);
    s.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
    s.on("AGENT_CONNECTED", () => {
      clearTimeout(t);
      s.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
      resolve(s);
    });
    s.connect();
  });

  const uiSocket: Socket = await new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { autoConnect: false, reconnection: false, extraHeaders: { Cookie: managerCookie } });
    const t = setTimeout(() => reject(new Error("timeout ui")), 8_000);
    s.on("connect", () => { clearTimeout(t); resolve(s); });
    s.connect();
  });

  const finalStates = new Map<string, { status: string; botStatus: string | null }>();
  uiSocket.on("agent-command-status", (payload: any) => {
    finalStates.set(payload.botId, { status: payload.status, botStatus: payload.botStatus });
  });

  agentSocket.on("AGENT_COMMAND", (command: any) => {
    agentSocket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
    agentSocket.emit("BOT_STATUS", { commandId: command.commandId, botId: command.botId, status: "STARTING", timestamp: new Date().toISOString() });
    agentSocket.emit("BOT_STATUS", { commandId: command.commandId, botId: command.botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
    agentSocket.emit("COMMAND_COMPLETED", { commandId: command.commandId, completedAt: new Date().toISOString(), result: { botId: command.botId, status: "WAITING_FOR_USER", started: true } });
  });

  for (let i = 0; i < iterations; i += 1) {
    uiSocket.emit("start-bot", { botName: `Stress ${i}`, clientRequestId: `stress-${RUN_SUFFIX}-${i}` });
    await sleep(120);
  }
  await sleep(1_500);

  let incoherent = 0;
  for (const [botId, state] of finalStates) {
    const ok = state.status === "COMPLETED" && state.botStatus === "WAITING_FOR_USER";
    if (!ok) {
      incoherent += 1;
      log("RACE", `botId=${botId} etat final incoherent: ${JSON.stringify(state)}`);
    }
  }
  assert(finalStates.size === iterations, `${iterations} commandes emises, ${finalStates.size} etats finaux observes`);
  assert(incoherent === 0, `Aucune commande sur ${iterations} ne finit avec un etat COMPLETED/botStatus incoherent (trouve: ${incoherent})`);

  agentSocket.disconnect();
  uiSocket.disconnect();
};

// ===================== Scenario 2: sequence exacte, Playwright + agent fantome =====================

const runSequenceScenario = async (browser: Browser, baseUrl: string, fixture: { managerLogin: string; managerPassword: string }): Promise<void> => {
  log("SCENARIO-2", "=== Sequence PENDING->SENT->ACKNOWLEDGED->STARTING->WAITING_FOR_USER->COMPLETED->GET->reload->STOP ===");
  const managerCookie = await loginWithRetry(baseUrl, fixture.managerLogin, fixture.managerPassword);
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(e.message));

  await loginViaUi(page, baseUrl, fixture.managerLogin, fixture.managerPassword);
  await page.click('#agentSetupSkip').catch(() => undefined);
  await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

  const agent = await pairFakeAgent(baseUrl, managerCookie, "SEQ-PC");
  const commandsSeen: Array<Record<string, unknown>> = [];
  agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));

  await page.click('[data-page-target="bot"]');
  await page.waitForSelector("#page-bot.active");

  await startBotViaUi(page, "Bot Sequence");
  const startCommand = await waitUntilValue(() => commandsSeen.find((c) => c.type === "START_BOT"));
  if (!startCommand) throw new Error("START_BOT jamais recu.");
  assert(true, "1) START_BOT cree et recu par l'agent fantome");

  await waitUntil(async () => (await rowFor(page, "Bot Sequence").innerText()).includes("SENT"), 5_000);
  assert(true, "2) La commande transite par SENT");
  agent.socket.emit("COMMAND_ACK", { commandId: startCommand.commandId, receivedAt: new Date().toISOString() });
  await waitUntil(async () => (await rowFor(page, "Bot Sequence").innerText()).includes("ACKNOWLEDGED"), 5_000);
  assert(true, "3) La commande transite par ACKNOWLEDGED");

  agent.socket.emit("BOT_STATUS", { commandId: startCommand.commandId, botId: startCommand.botId, status: "STARTING", timestamp: new Date().toISOString() });
  await waitUntil(async () => (await rowFor(page, "Bot Sequence").innerText()).includes("Demarrage"), 5_000);
  assert(true, "4) BOT_STATUS STARTING relaye et affiche");

  agent.socket.emit("BOT_STATUS", { commandId: startCommand.commandId, botId: startCommand.botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
  await waitUntil(async () => (await stopButtonFor(page, "Bot Sequence").count()) === 1, 5_000);
  assert(true, "5) BOT_STATUS WAITING_FOR_USER relaye, bouton Arreter deja visible avant COMPLETED");

  agent.socket.emit("COMMAND_COMPLETED", {
    commandId: startCommand.commandId, completedAt: new Date().toISOString(),
    result: { botId: startCommand.botId, status: "WAITING_FOR_USER", started: true, computerName: "SEQ-PC" }
  });
  await waitUntil(async () => (await rowFor(page, "Bot Sequence").innerText()).includes("COMPLETED"), 5_000);

  const rowText = await rowFor(page, "Bot Sequence").innerText();
  assert(rowText.includes("COMPLETED"), "6) status === COMPLETED apres COMMAND_COMPLETED");
  assert((await stopButtonFor(page, "Bot Sequence").count()) === 1, "6) botStatus reste WAITING_FOR_USER: bouton Arreter toujours visible");
  assert((await validateButtonFor(page, "Bot Sequence").count()) === 1, "6) bouton Valider toujours visible apres COMMAND_COMPLETED");
  assert(!rowText.includes("Commande terminee par l'agent"), "6) Jamais \"Commande terminee par l'agent\" tant qu'un botStatus actif existe");

  const detail = await requestJson(baseUrl, "GET", "/api/agent-commands?limit=5", managerCookie);
  const restCommand = detail.body.commands.find((c: any) => c.botId === startCommand.botId);
  assert(restCommand?.status === "COMPLETED", "7) GET /api/agent-commands: status === COMPLETED");
  assert(restCommand?.botStatus === "WAITING_FOR_USER", "7) GET /api/agent-commands: botStatus toujours WAITING_FOR_USER");
  assert(typeof restCommand?.botStatusUpdatedAt === "string", "7) GET /api/agent-commands: botStatusUpdatedAt present");

  await page.click('[data-page-target="dashboard"]');
  await page.waitForSelector("#page-dashboard.active");
  await page.click('[data-page-target="bot"]');
  await page.waitForSelector("#page-bot.active");
  await waitUntil(async () => (await rowFor(page, "Bot Sequence").count()) > 0, 5_000);
  assert((await stopButtonFor(page, "Bot Sequence").count()) === 1, "Un refresh REST (navigation bot->dashboard->bot) ne fait pas disparaitre le bouton Arreter");

  await page.reload();
  await page.waitForSelector("#appLayout:not([hidden])");
  await page.click('[data-page-target="bot"]');
  await page.waitForSelector("#page-bot.active");
  await waitUntil(async () => (await rowFor(page, "Bot Sequence").count()) > 0, 5_000);
  assert((await stopButtonFor(page, "Bot Sequence").count()) === 1, "8) Apres rechargement complet, le bouton Arreter est toujours present");
  assert((await validateButtonFor(page, "Bot Sequence").count()) === 1, "8) Apres rechargement complet, le bouton Valider est toujours present");

  await stopButtonFor(page, "Bot Sequence").click();
  const stopCommand = await waitUntilValue(() => commandsSeen.find((c) => c.type === "STOP_BOT"));
  if (!stopCommand) throw new Error("STOP_BOT jamais recu.");
  agent.socket.emit("COMMAND_ACK", { commandId: stopCommand.commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("BOT_STATUS", { commandId: stopCommand.commandId, botId: startCommand.botId, status: "STOPPING", timestamp: new Date().toISOString() });
  await waitUntil(async () => (await stopButtonFor(page, "Bot Sequence").count()) === 0, 5_000);
  assert((await stopButtonFor(page, "Bot Sequence").count()) === 0, "STOPPING masque le bouton Arreter");

  agent.socket.emit("BOT_STATUS", { commandId: stopCommand.commandId, botId: startCommand.botId, status: "STOPPED", timestamp: new Date().toISOString() });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: stopCommand.commandId, completedAt: new Date().toISOString(), result: { botId: startCommand.botId, status: "STOPPED", stopped: true } });
  await waitUntil(async () => (await rowFor(page, "Bot Sequence").innerText()).includes("COMPLETED"), 5_000);
  assert((await stopButtonFor(page, "Bot Sequence").count()) === 0, "STOPPED masque definitivement le bouton Arreter");
  assert((await validateButtonFor(page, "Bot Sequence").count()) === 0, "STOPPED masque definitivement le bouton Valider");

  assert(consoleErrors.length === 0, `Aucune erreur console (recu: ${consoleErrors.join(" | ") || "aucune"})`);

  agent.socket.disconnect();
  await context.close();
};

// ===================== Scenario 3: isolation inter-agence =====================

const runCrossAgencyScenario = async (
  browser: Browser,
  baseUrl: string,
  fixtureA: { managerLogin: string; managerPassword: string },
  fixtureB: { managerLogin: string; managerPassword: string }
): Promise<void> => {
  log("SCENARIO-3", "=== Isolation inter-agence ===");
  const managerCookieA = await loginWithRetry(baseUrl, fixtureA.managerLogin, fixtureA.managerPassword);
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await loginViaUi(pageA, baseUrl, fixtureA.managerLogin, fixtureA.managerPassword);
  await pageA.click('#agentSetupSkip').catch(() => undefined);
  await pageA.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

  const agentA = await pairFakeAgent(baseUrl, managerCookieA, "CROSS-A-PC");
  const commandsSeenA: Array<Record<string, unknown>> = [];
  agentA.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeenA.push(command));

  await pageA.click('[data-page-target="bot"]');
  await pageA.waitForSelector("#page-bot.active");
  await startBotViaUi(pageA, "Bot CrossAgency");
  const startCommand = await waitUntilValue(() => commandsSeenA.find((c) => c.type === "START_BOT"));
  if (!startCommand) throw new Error("START_BOT jamais recu (cross-agency).");

  agentA.socket.emit("COMMAND_ACK", { commandId: startCommand.commandId, receivedAt: new Date().toISOString() });
  agentA.socket.emit("BOT_STATUS", { commandId: startCommand.commandId, botId: startCommand.botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
  agentA.socket.emit("COMMAND_COMPLETED", { commandId: startCommand.commandId, completedAt: new Date().toISOString(), result: { botId: startCommand.botId, status: "WAITING_FOR_USER", started: true } });
  await waitUntil(async () => (await stopButtonFor(pageA, "Bot CrossAgency").count()) === 1, 5_000);

  const managerCookieB = await loginWithRetry(baseUrl, fixtureB.managerLogin, fixtureB.managerPassword);
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await loginViaUi(pageB, baseUrl, fixtureB.managerLogin, fixtureB.managerPassword);
  await pageB.click('#agentSetupSkip').catch(() => undefined);
  await pageB.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
  await pageB.click('[data-page-target="bot"]');
  await pageB.waitForSelector("#page-bot.active");
  assert((await rowFor(pageB, "Bot CrossAgency").count()) === 0, "Le manager d'une autre agence ne voit meme pas le bot dans son tableau de commandes");

  const socketB = ioClient(baseUrl, { autoConnect: false, reconnection: false, extraHeaders: { Cookie: managerCookieB } });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout socket B")), 5_000);
    socketB.on("connect", () => { clearTimeout(t); resolve(); });
    socketB.connect();
  });
  let crossAgencyEventReceived = false;
  socketB.on("agent-command-status", () => { crossAgencyEventReceived = true; });
  socketB.emit("stop-bot", { botId: startCommand.botId as string, clientRequestId: `cross-agency-${RUN_SUFFIX}` });
  await sleep(1_000);
  assert(!crossAgencyEventReceived, "Une tentative stop-bot depuis une autre agence sur ce botId n'a aucun effet observable");

  socketB.disconnect();
  agentA.socket.disconnect();
  await contextA.close();
  await contextB.close();
};

const main = async (): Promise<void> => {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });

    const server = await startServer(3281, {
      AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent",
      AGENT_COMMAND_ACK_TIMEOUT_MS: "8000", AGENT_COMMAND_TTL_MS: "20000"
    });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    const fixtureStress = await createAgencyAndManager(server.baseUrl, adminCookie, "Stress");
    const stressCookie = await loginWithRetry(server.baseUrl, fixtureStress.managerLogin, fixtureStress.managerPassword);
    await runStressScenario(server.baseUrl, stressCookie, 30);

    const fixtureSeq = await createAgencyAndManager(server.baseUrl, adminCookie, "Seq");
    await runSequenceScenario(browser, server.baseUrl, fixtureSeq);

    const fixtureCrossA = await createAgencyAndManager(server.baseUrl, adminCookie, "CrossA");
    const fixtureCrossB = await createAgencyAndManager(server.baseUrl, adminCookie, "CrossB");
    await runCrossAgencyScenario(browser, server.baseUrl, fixtureCrossA, fixtureCrossB);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    for (const server of runningServers) await killTree(server.child.pid);
    await cleanupTestData();
    await pool.end();
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exit(failCount > 0 ? 1 : 0);
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
