// Correctif de la persistance de botStatus apres COMMAND_COMPLETED.
//
// CAUSE EXACTE: COMMAND_ACK, BOT_STATUS (repete) et COMMAND_COMPLETED/FAILED
// d'une MEME commande etaient traites par des gestionnaires socket.io
// independants, chacun avec son propre aller-retour PostgreSQL (getCommandForAgent
// / markAcknowledged / markCompleted). Un agent reel emet BOT_STATUS
// WAITING_FOR_USER puis COMMAND_COMPLETED sans le moindre delai (deux
// socket.emit synchrones consecutifs dans AgentBotManager.startBot()). Rien
// ne garantissait que la requete SELECT de BOT_STATUS se termine avant la
// requete UPDATE de COMMAND_COMPLETED lancee juste apres: si COMPLETED
// gagnait la course, sa diffusion (et la ligne servie par la suite) portait
// un botStatus perime (ex. "STARTING") voire la commande restait bloquee a
// ACKNOWLEDGED si COMMAND_COMPLETED arrivait avant que COMMAND_ACK n'ait fini
// d'etre applique. Confirme empiriquement: ~17% des commandes (5/30) dans un
// scenario de stress avant correctif.
//
// CORRECTIF:
// - src/agentGateway.ts: une file FIFO par commandId (enqueueCommandEvent)
//   serialise desormais COMMAND_ACK/BOT_STATUS/COMMAND_COMPLETED/COMMAND_FAILED:
//   le traitement complet (DB + diffusion) d'un evenement se termine
//   TOUJOURS avant que le suivant, pour le meme commandId, ne commence.
// - src/agentCommandService.ts: AgentBotRecord/PublicAgentCommand exposent
//   desormais botStatusUpdatedAt et botActive, une source d'autorite
//   explicite et separee du cycle de vie de la commande.
// - public/agentUi.js: fusion (jamais un remplacement aveugle) entre l'etat
//   deja connu et tout nouvel objet recu (socket ou REST), en comparant
//   botStatusUpdatedAt independamment de command.updatedAt.
//
// Usage: npx tsx scripts/test-agent-botstatus-persistence.ts

import { ChildProcess, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
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

const waitForServerReady = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`${baseUrl}/api/me`); if (res.status === 401 || res.status === 200) return; } catch { /* */ }
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
  return { child, baseUrl };
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
  const agencyName = `Test BotStatus ${labelSuffix} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = agencyResult.body.agency.id;
  const managerLogin = `test-botstatus-${labelSuffix.toLowerCase()}-${RUN_SUFFIX}`;
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

// ===================== Partie A: preuve de la race (stress) =====================
// Reproduit exactement la timing reelle d'AgentBotManager.startBot(): ACK,
// BOT_STATUS STARTING, BOT_STATUS WAITING_FOR_USER et COMMAND_COMPLETED
// emis en succession la plus rapide possible (zero delai), sur de
// nombreuses commandes concurrentes, pour maximiser la probabilite de
// declencher la course. AVANT le correctif, environ 15-20% des commandes se
// terminaient dans un etat incoherent; APRES, 0/N de facon repetee.

const runStressPartA = async (baseUrl: string, managerCookie: string, iterations: number): Promise<void> => {
  const pairing = await requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
  const agentSocket: Socket = await new Promise((resolve, reject) => {
    const s = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "pair", pairingCode: pairing.body.pairing.code, computerName: "STRESS-PC", version: "1.0.0" }
    });
    const t = setTimeout(() => reject(new Error("timeout agent")), 8_000);
    s.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
    s.on("AGENT_CONNECTED", () => { clearTimeout(t); resolve(s); });
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

// --- Helpers DOM (Partie B/C) ---

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

type FakeAgentHandle = { agentId: number; token: string; socket: Socket };

const pairFakeAgent = async (baseUrl: string, managerCookie: string, computerName: string): Promise<FakeAgentHandle> => {
  const pairing = await requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
  return new Promise((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "pair", pairingCode: pairing.body.pairing.code, computerName, version: "1.0.0" }
    });
    const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout agent fantome.")); }, 8_000);
    socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
    socket.on("AGENT_CONNECTED", (payload: { agentId: number; token: string | null }) => {
      clearTimeout(t);
      if (!payload.token) { reject(new Error("Aucun jeton.")); return; }
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

// ===================== Partie B: sequence exacte, agent fantome, Playwright =====================

const runSequencePartB = async (browser: Browser, baseUrl: string, fixture: { managerLogin: string; managerPassword: string }): Promise<void> => {
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

  // 1) creation START_BOT
  await startBotViaUi(page, "Bot Sequence");
  const startCommand = await waitUntilValue(() => commandsSeen.find((c) => c.type === "START_BOT"));
  if (!startCommand) throw new Error("START_BOT jamais recu.");
  assert(true, "1) START_BOT cree et recu par l'agent");

  // 2) SENT / 3) ACKNOWLEDGED
  await waitUntil(async () => (await rowFor(page, "Bot Sequence").innerText()).includes("SENT"), 5_000);
  assert(true, "2) La commande transite par SENT");
  agent.socket.emit("COMMAND_ACK", { commandId: startCommand.commandId, receivedAt: new Date().toISOString() });
  await waitUntil(async () => (await rowFor(page, "Bot Sequence").innerText()).includes("ACKNOWLEDGED"), 5_000);
  assert(true, "3) La commande transite par ACKNOWLEDGED");

  // 4) BOT_STATUS STARTING
  agent.socket.emit("BOT_STATUS", { commandId: startCommand.commandId, botId: startCommand.botId, status: "STARTING", timestamp: new Date().toISOString() });
  await waitUntil(async () => (await rowFor(page, "Bot Sequence").innerText()).includes("Demarrage"), 5_000);
  assert(true, "4) BOT_STATUS STARTING relaye et affiche");

  // 5) BOT_STATUS WAITING_FOR_USER
  agent.socket.emit("BOT_STATUS", { commandId: startCommand.commandId, botId: startCommand.botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
  await waitUntil(async () => (await stopButtonFor(page, "Bot Sequence").count()) === 1, 5_000);
  assert(true, "5) BOT_STATUS WAITING_FOR_USER relaye, bouton Arreter deja visible avant meme COMPLETED");

  // 6) COMMAND_COMPLETED
  agent.socket.emit("COMMAND_COMPLETED", {
    commandId: startCommand.commandId, completedAt: new Date().toISOString(),
    result: { botId: startCommand.botId, status: "WAITING_FOR_USER", started: true, computerName: "SEQ-PC" }
  });
  await waitUntil(async () => (await rowFor(page, "Bot Sequence").innerText()).includes("COMPLETED"), 5_000);

  const rowText = await rowFor(page, "Bot Sequence").innerText();
  assert(rowText.includes("COMPLETED"), "6) status === COMPLETED apres COMMAND_COMPLETED");
  assert(
    (await stopButtonFor(page, "Bot Sequence").count()) === 1,
    "6) botStatus reste WAITING_FOR_USER apres COMMAND_COMPLETED: bouton Arreter toujours visible (BUG CORRIGE)"
  );
  assert(
    (await validateButtonFor(page, "Bot Sequence").count()) === 1,
    "6) bouton Valider toujours visible apres COMMAND_COMPLETED"
  );
  assert(
    !rowText.includes("Commande terminee par l'agent"),
    "6) Le message \"Commande terminee par l'agent\" n'est jamais affiche tant qu'un botStatus actif existe"
  );

  // 7) GET /api/agent-commands
  const detail = await requestJson(baseUrl, "GET", "/api/agent-commands?limit=5", managerCookie);
  const restCommand = detail.body.commands.find((c: any) => c.botId === startCommand.botId);
  assert(restCommand?.status === "COMPLETED", "7) GET /api/agent-commands: status === COMPLETED");
  assert(restCommand?.botStatus === "WAITING_FOR_USER", "7) GET /api/agent-commands: botStatus toujours WAITING_FOR_USER (jamais efface)");
  assert(typeof restCommand?.botStatusUpdatedAt === "string", "7) GET /api/agent-commands: botStatusUpdatedAt present");

  // Refresh REST sans rechargement complet (navigation dashboard -> bot):
  // verifie qu'un refresh REST declenche APRES l'etat socket ne fait pas
  // disparaitre les boutons.
  await page.click('[data-page-target="dashboard"]');
  await page.waitForSelector("#page-dashboard.active");
  await page.click('[data-page-target="bot"]');
  await page.waitForSelector("#page-bot.active");
  await waitUntil(async () => (await rowFor(page, "Bot Sequence").count()) > 0, 5_000);
  assert(
    (await stopButtonFor(page, "Bot Sequence").count()) === 1,
    "Un refresh REST (navigation bot -> dashboard -> bot) ne fait pas disparaitre le bouton Arreter"
  );

  // 8) rechargement complet de la page
  await page.reload();
  await page.waitForSelector("#appLayout:not([hidden])");
  await page.click('[data-page-target="bot"]');
  await page.waitForSelector("#page-bot.active");
  await waitUntil(async () => (await rowFor(page, "Bot Sequence").count()) > 0, 5_000);
  assert(
    (await stopButtonFor(page, "Bot Sequence").count()) === 1,
    "8) Apres rechargement complet de la page, le bouton Arreter est toujours present"
  );
  assert(
    (await validateButtonFor(page, "Bot Sequence").count()) === 1,
    "8) Apres rechargement complet de la page, le bouton Valider est toujours present"
  );

  // STOP_BOT -> STOPPING masque -> STOPPED masque definitivement
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

// ===================== Partie C: vrai agent, vrai Chrome =====================

const runRealAgentPartC = async (browser: Browser, port: number): Promise<void> => {
  const server = await startServer(port, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });
  try {
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "Real");
    const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
    const pairing = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const code = pairing.body.pairing.code;

    const credPath = path.join(process.cwd(), `.test-botstatus-real-creds-${RUN_SUFFIX}.json`);
    const dataRoot = path.join(process.cwd(), `.test-botstatus-real-data-${RUN_SUFFIX}`);

    const realAgent: ChildProcess = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "src/agent/agentMain.ts", "pair", code], {
      env: {
        ...process.env,
        AGENT_SERVER_URL: server.baseUrl,
        AGENT_CREDENTIALS_PATH: credPath,
        AGENT_DATA_DIR: dataRoot,
        AGENT_COMPUTER_NAME: "REAL-BOTSTATUS-PC",
        AGENT_TARGET_MODE: "fixture",
        AGENT_FIXTURE_URL: "about:blank"
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    realAgent.stdout?.on("data", (c: Buffer) => log("REAL-AGENT", c.toString().trim()));
    realAgent.stderr?.on("data", (c: Buffer) => log("REAL-AGENT-ERR", c.toString().trim()));
    await sleep(2_000);

    const context = await browser.newContext();
    const page = await context.newPage();
    await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);
    await page.click('#agentSetupSkip').catch(() => undefined);
    await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
    await page.click('[data-page-target="bot"]');
    await page.waitForSelector("#page-bot.active");

    await startBotViaUi(page, "Bot Reel Sequence");
    await waitUntil(async () => (await rowFor(page, "Bot Reel Sequence").innerText()).includes("COMPLETED"), 15_000);

    const rowText = await rowFor(page, "Bot Reel Sequence").innerText();
    assert(rowText.includes("COMPLETED"), "Vrai agent: START_BOT reel atteint COMPLETED (Chrome reellement ouvert)");
    assert(
      (await stopButtonFor(page, "Bot Reel Sequence").count()) === 1,
      "Vrai agent, vrai ordre d'evenements (zero delai WAITING_FOR_USER->COMPLETED): bouton Arreter bien visible"
    );

    const commandId = (await requestJson(server.baseUrl, "GET", "/api/agent-commands?limit=5", managerCookie))
      .body.commands.find((c: any) => c.botName === "Bot Reel Sequence")?.commandId;
    const restDetail = await requestJson(server.baseUrl, "GET", `/api/agent-commands/${commandId}`, managerCookie);
    assert(restDetail.body.command.botStatus === "WAITING_FOR_USER", "Vrai agent: GET /api/agent-commands/:id confirme botStatus=WAITING_FOR_USER apres COMPLETED");

    await stopButtonFor(page, "Bot Reel Sequence").click();
    await waitUntil(async () => (await stopButtonFor(page, "Bot Reel Sequence").count()) === 0, 15_000);
    assert((await stopButtonFor(page, "Bot Reel Sequence").count()) === 0, "Vrai agent: apres clic reel sur Arreter, le bouton disparait (bot STOPPED)");

    await context.close();
    await killTree(realAgent.pid);
    if (existsSync(credPath)) rmSync(credPath);
    if (existsSync(dataRoot)) rmSync(dataRoot, { recursive: true, force: true });
  } finally {
    await killTree(server.child.pid);
  }
};

const main = async (): Promise<void> => {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });

    const server = await startServer(3271, {
      AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent",
      AGENT_COMMAND_ACK_TIMEOUT_MS: "8000", AGENT_COMMAND_TTL_MS: "20000"
    });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const fixtureStress = await createAgencyAndManager(server.baseUrl, adminCookie, "Stress");
    const stressCookie = await loginWithRetry(server.baseUrl, fixtureStress.managerLogin, fixtureStress.managerPassword);

    log("PART-A", "=== Preuve de la race (30 iterations rapides, timing reel) ===");
    await runStressPartA(server.baseUrl, stressCookie, 30);

    log("PART-B", "=== Sequence exacte PENDING->SENT->ACKNOWLEDGED->STARTING->WAITING_FOR_USER->COMPLETED->GET->reload ===");
    const fixtureSeq = await createAgencyAndManager(server.baseUrl, adminCookie, "Seq");
    await runSequencePartB(browser, server.baseUrl, fixtureSeq);

    await killTree(server.child.pid);

    log("PART-C", "=== Vrai agent, vrai Chrome ===");
    await runRealAgentPartC(browser, 3272);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
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
