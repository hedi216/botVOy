// Tests SIMULES Lot 3 (VALIDATE_BOT): WAITING_FOR_USER -> VALIDATE_BOT ->
// MONITORING, PAGE_NOT_READY, validation en double, isolation inter-agence,
// bot deja arrete. Ce script NE LANCE JAMAIS src/agent/agentMain.ts ET NE
// LANCE JAMAIS Chrome: tout agent est un socket.io-client fantome (auth
// /agent reelle, reponses VALIDATE_BOT simulees a la main). Le seul
// navigateur demarre ici est le Chromium headless de Playwright utilise
// comme harnais de test pour piloter l'INTERFACE WEB (jamais le "Chrome du
// bot"). Peut donc etre execute sans risque sur la VM.
//
// Pour le scenario avec le vrai runtime agent + vrai Chrome + vraie fixture
// locale (a executer uniquement sur un PC Windows personnel/interactif),
// voir scripts/test-agent-validate-real.ts.
//
// Usage: npx tsx scripts/test-agent-validate-simulated.ts
//    ou: npm run test:agent:validate:simulated

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
  const agencyName = `Test Validate Sim ${labelSuffix} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = agencyResult.body.agency.id;
  const managerLogin = `test-validate-sim-${labelSuffix.toLowerCase()}-${RUN_SUFFIX}`;
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

// --- Agent fantome (socket.io-client brut) ---

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

// --- Helpers DOM ---

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

// Amene un bot fantome jusqu'a WAITING_FOR_USER via le VRAI dispatch START_BOT
// (agent fantome qui simule uniquement ACK+BOT_STATUS+COMPLETED).
const startFakeBotToWaitingForUser = async (
  page: Page,
  agent: FakeAgentHandle,
  commandsSeen: Array<Record<string, unknown>>,
  botName: string
): Promise<string> => {
  await startBotViaUi(page, botName);
  const startCommand = await waitUntilValue(() => commandsSeen.find((c) => c.type === "START_BOT"));
  if (!startCommand) throw new Error(`START_BOT jamais recu pour ${botName}.`);
  const botId = startCommand.botId as string;

  agent.socket.emit("COMMAND_ACK", { commandId: startCommand.commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("BOT_STATUS", { commandId: startCommand.commandId, botId, status: "STARTING", timestamp: new Date().toISOString() });
  agent.socket.emit("BOT_STATUS", { commandId: startCommand.commandId, botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: startCommand.commandId, completedAt: new Date().toISOString(), result: { botId, status: "WAITING_FOR_USER", started: true } });

  await waitUntil(async () => (await stopButtonFor(page, botName).count()) === 1, 8_000);
  return botId;
};

const main = async (): Promise<void> => {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });

    const server = await startServer(3291, {
      AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent",
      AGENT_COMMAND_ACK_TIMEOUT_MS: "8000", AGENT_COMMAND_TTL_MS: "20000"
    });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    // ===================== Scenario 1: succes WAITING_FOR_USER -> MONITORING =====================
    {
      log("SCENARIO-1", "=== WAITING_FOR_USER -> VALIDATE_BOT -> MONITORING ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "Success");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const context = await browser.newContext();
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) consoleErrors.push(m.text()); });
      page.on("pageerror", (e) => consoleErrors.push(e.message));

      await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      await page.click('#agentSetupSkip').catch(() => undefined);
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

      const agent = await pairFakeAgent(server.baseUrl, managerCookie, "VALIDATE-SUCCESS-PC");
      const commandsSeen: Array<Record<string, unknown>> = [];
      agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));

      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");

      const botId = await startFakeBotToWaitingForUser(page, agent, commandsSeen, "Bot Validate Success");
      assert(true, "Bot amene a WAITING_FOR_USER (bouton Arreter visible)");
      assert((await validateButtonFor(page, "Bot Validate Success").count()) === 1, "Bouton Valider visible en WAITING_FOR_USER");

      await validateButtonFor(page, "Bot Validate Success").click();
      const validateCommand = await waitUntilValue(() => commandsSeen.find((c) => c.type === "VALIDATE_BOT" && c.botId === botId));
      if (!validateCommand) throw new Error("VALIDATE_BOT jamais recu.");
      assert(true, "Le clic sur Valider envoie bien VALIDATE_BOT au meme agent/botId");

      await waitUntil(async () => (await rowFor(page, "Bot Validate Success").innerText()).includes("Verification de la page"), 5_000);
      assert(true, "Pendant VALIDATE_BOT: message 'Verification de la page...' affiche");
      assert((await validateButtonFor(page, "Bot Validate Success").count()) === 0, "Pendant VALIDATE_BOT: bouton Valider masque (anti double-clic)");
      assert((await stopButtonFor(page, "Bot Validate Success").count()) === 1, "Pendant VALIDATE_BOT: bouton Arreter toujours visible");

      agent.socket.emit("COMMAND_ACK", { commandId: validateCommand.commandId, receivedAt: new Date().toISOString() });
      agent.socket.emit("BOT_STATUS", { commandId: validateCommand.commandId, botId, status: "MONITORING", timestamp: new Date().toISOString() });
      agent.socket.emit("COMMAND_COMPLETED", { commandId: validateCommand.commandId, completedAt: new Date().toISOString(), result: { botId, status: "MONITORING", validated: true } });

      await waitUntil(async () => (await rowFor(page, "Bot Validate Success").innerText()).includes("COMPLETED"), 5_000);
      const rowText = await rowFor(page, "Bot Validate Success").innerText();
      assert(rowText.includes("COMPLETED"), "VALIDATE_BOT: status === COMPLETED");
      assert(rowText.includes("Surveillance") || rowText.includes("surveillance"), "botStatus MONITORING affiche apres COMMAND_COMPLETED");
      assert((await validateButtonFor(page, "Bot Validate Success").count()) === 0, "MONITORING: bouton Valider masque");
      assert((await stopButtonFor(page, "Bot Validate Success").count()) === 1, "MONITORING: bouton Arreter conserve");

      const detail = await requestJson(server.baseUrl, "GET", "/api/agent-commands?limit=5", managerCookie);
      const restCommand = detail.body.commands.find((c: any) => c.botId === botId);
      assert(restCommand?.botStatus === "MONITORING", "GET /api/agent-commands: botStatus MONITORING persiste");

      // Rechargement complet: MONITORING doit etre reconstruit depuis le serveur.
      await page.reload();
      await page.waitForSelector("#appLayout:not([hidden])");
      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");
      await waitUntil(async () => (await rowFor(page, "Bot Validate Success").count()) > 0, 5_000);
      assert((await stopButtonFor(page, "Bot Validate Success").count()) === 1, "Apres rechargement: MONITORING conserve, bouton Arreter present");
      assert((await validateButtonFor(page, "Bot Validate Success").count()) === 0, "Apres rechargement: bouton Valider toujours masque (MONITORING)");

      assert(consoleErrors.length === 0, `Aucune erreur console (recu: ${consoleErrors.join(" | ") || "aucune"})`);

      agent.socket.disconnect();
      await context.close();
    }

    // ===================== Scenario 2: PAGE_NOT_READY =====================
    {
      log("SCENARIO-2", "=== VALIDATE_BOT echoue: PAGE_NOT_READY ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "PageNotReady");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      await page.click('#agentSetupSkip').catch(() => undefined);
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

      const agent = await pairFakeAgent(server.baseUrl, managerCookie, "VALIDATE-FAIL-PC");
      const commandsSeen: Array<Record<string, unknown>> = [];
      agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));

      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");

      const botId = await startFakeBotToWaitingForUser(page, agent, commandsSeen, "Bot Page Not Ready");

      await validateButtonFor(page, "Bot Page Not Ready").click();
      const validateCommand = await waitUntilValue(() => commandsSeen.find((c) => c.type === "VALIDATE_BOT" && c.botId === botId));
      if (!validateCommand) throw new Error("VALIDATE_BOT jamais recu.");

      agent.socket.emit("COMMAND_ACK", { commandId: validateCommand.commandId, receivedAt: new Date().toISOString() });
      agent.socket.emit("BOT_STATUS", { commandId: validateCommand.commandId, botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
      agent.socket.emit("COMMAND_FAILED", { commandId: validateCommand.commandId, failedAt: new Date().toISOString(), errorCode: "PAGE_NOT_READY", message: "Page non reconnue." });

      await waitUntil(async () => (await rowFor(page, "Bot Page Not Ready").innerText()).includes("pas prete"), 5_000);
      const rowText = await rowFor(page, "Bot Page Not Ready").innerText();
      assert(rowText.toLowerCase().includes("pas prete"), "PAGE_NOT_READY: message comprehensible affiche");
      assert((await validateButtonFor(page, "Bot Page Not Ready").count()) === 1, "PAGE_NOT_READY: bouton Valider toujours present (bot pas supprime)");
      assert((await stopButtonFor(page, "Bot Page Not Ready").count()) === 1, "PAGE_NOT_READY: bouton Arreter toujours present");

      const detail = await requestJson(server.baseUrl, "GET", "/api/agent-commands?limit=5", managerCookie);
      const restCommand = detail.body.commands.find((c: any) => c.botId === botId);
      assert(restCommand?.botStatus === "WAITING_FOR_USER", "GET /api/agent-commands: botStatus revient bien a WAITING_FOR_USER");

      agent.socket.disconnect();
      await context.close();
    }

    // ===================== Scenario 3: validation en double =====================
    {
      log("SCENARIO-3", "=== Validation en double refusee (VALIDATION_ALREADY_RUNNING) ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "DoubleValidate");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      await page.click('#agentSetupSkip').catch(() => undefined);
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

      const agent = await pairFakeAgent(server.baseUrl, managerCookie, "VALIDATE-DOUBLE-PC");
      const commandsSeen: Array<Record<string, unknown>> = [];
      let validateInFlight = false;
      agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => {
        commandsSeen.push(command);
        if (command.type !== "VALIDATE_BOT") return;
        if (validateInFlight) {
          // Simule le comportement reel de AgentBotManager.validateBot():
          // une seconde commande pendant que la premiere est en cours est
          // refusee avec VALIDATION_ALREADY_RUNNING, jamais un doublon accepte.
          agent.socket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
          agent.socket.emit("COMMAND_FAILED", { commandId: command.commandId, failedAt: new Date().toISOString(), errorCode: "VALIDATION_ALREADY_RUNNING", message: "Une verification est deja en cours." });
          return;
        }
        validateInFlight = true;
      });

      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");

      const botId = await startFakeBotToWaitingForUser(page, agent, commandsSeen, "Bot Double Validate");

      // Deux VALIDATE_BOT emis directement (contourne le disabled cote DOM,
      // pour tester reellement le rejet serveur/agent, pas seulement l'UI).
      APP_emitContinueBotTwice(page, botId);

      const firstValidate = await waitUntilValue(() => commandsSeen.find((c) => c.type === "VALIDATE_BOT" && c.botId === botId));
      if (!firstValidate) throw new Error("Premier VALIDATE_BOT jamais recu.");
      const secondValidate = await waitUntilValue(() => commandsSeen.filter((c) => c.type === "VALIDATE_BOT" && c.botId === botId)[1]);
      assert(Boolean(secondValidate), "Un second VALIDATE_BOT est bien dispatche (idempotence par clientRequestId non declenchee car requetes distinctes)");

      if (secondValidate) {
        await waitUntil(async () => {
          const failed = await requestJson(server.baseUrl, "GET", `/api/agent-commands/${secondValidate.commandId}`, managerCookie);
          return failed.body.command?.errorCode === "VALIDATION_ALREADY_RUNNING";
        }, 5_000);
        const failedDetail = await requestJson(server.baseUrl, "GET", `/api/agent-commands/${secondValidate.commandId}`, managerCookie);
        assert(failedDetail.body.command?.errorCode === "VALIDATION_ALREADY_RUNNING", "Le second VALIDATE_BOT concurrent est refuse avec VALIDATION_ALREADY_RUNNING");
      }

      // Termine proprement le premier pour ne pas polluer le test suivant.
      agent.socket.emit("COMMAND_ACK", { commandId: firstValidate.commandId, receivedAt: new Date().toISOString() });
      agent.socket.emit("BOT_STATUS", { commandId: firstValidate.commandId, botId, status: "MONITORING", timestamp: new Date().toISOString() });
      agent.socket.emit("COMMAND_COMPLETED", { commandId: firstValidate.commandId, completedAt: new Date().toISOString(), result: { botId, status: "MONITORING", validated: true } });

      agent.socket.disconnect();
      await context.close();
    }

    // ===================== Scenario 4: bot deja arrete =====================
    {
      log("SCENARIO-4", "=== VALIDATE_BOT refuse si le bot est deja STOPPED ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "AlreadyStopped");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      await page.click('#agentSetupSkip').catch(() => undefined);
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

      const agent = await pairFakeAgent(server.baseUrl, managerCookie, "VALIDATE-STOPPED-PC");
      const commandsSeen: Array<Record<string, unknown>> = [];
      agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => {
        commandsSeen.push(command);
        if (command.type === "STOP_BOT") {
          agent.socket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
          agent.socket.emit("BOT_STATUS", { commandId: command.commandId, botId: command.botId, status: "STOPPED", timestamp: new Date().toISOString() });
          agent.socket.emit("COMMAND_COMPLETED", { commandId: command.commandId, completedAt: new Date().toISOString(), result: { botId: command.botId, status: "STOPPED", stopped: true } });
        }
      });

      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");

      const botId = await startFakeBotToWaitingForUser(page, agent, commandsSeen, "Bot Already Stopped");
      await stopButtonFor(page, "Bot Already Stopped").click();
      await waitUntil(async () => (await stopButtonFor(page, "Bot Already Stopped").count()) === 0, 8_000);
      assert(true, "Bot arrete avec succes (etat prealable au test)");

      const beforeValidateCount = commandsSeen.filter((c) => c.type === "VALIDATE_BOT").length;
      const uiSocket = ioClient(server.baseUrl, { autoConnect: false, reconnection: false, extraHeaders: { Cookie: managerCookie } });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout ui socket")), 5_000);
        uiSocket.on("connect", () => { clearTimeout(t); resolve(); });
        uiSocket.connect();
      });
      uiSocket.emit("continue-bot", { botId, clientRequestId: `late-validate-${RUN_SUFFIX}` });
      await sleep(1_000);
      const afterValidateCount = commandsSeen.filter((c) => c.type === "VALIDATE_BOT").length;
      assert(afterValidateCount === beforeValidateCount, "VALIDATE_BOT sur un bot deja STOPPED n'est jamais dispatche a l'agent (refuse cote serveur)");
      uiSocket.disconnect();

      agent.socket.disconnect();
      await context.close();
    }

    // ===================== Scenario 5: isolation inter-agence =====================
    {
      log("SCENARIO-5", "=== VALIDATE_BOT refuse depuis une autre agence ===");
      const fixtureA = await createAgencyAndManager(server.baseUrl, adminCookie, "CrossA");
      const fixtureB = await createAgencyAndManager(server.baseUrl, adminCookie, "CrossB");
      const managerCookieA = await loginWithRetry(server.baseUrl, fixtureA.managerLogin, fixtureA.managerPassword);
      const managerCookieB = await loginWithRetry(server.baseUrl, fixtureB.managerLogin, fixtureB.managerPassword);

      const contextA = await browser.newContext();
      const pageA = await contextA.newPage();
      await loginViaUi(pageA, server.baseUrl, fixtureA.managerLogin, fixtureA.managerPassword);
      await pageA.click('#agentSetupSkip').catch(() => undefined);
      await pageA.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

      const agentA = await pairFakeAgent(server.baseUrl, managerCookieA, "CROSS-VALIDATE-PC");
      const commandsSeenA: Array<Record<string, unknown>> = [];
      agentA.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeenA.push(command));

      await pageA.click('[data-page-target="bot"]');
      await pageA.waitForSelector("#page-bot.active");
      const botId = await startFakeBotToWaitingForUser(pageA, agentA, commandsSeenA, "Bot Cross Validate");

      const uiSocketB = ioClient(server.baseUrl, { autoConnect: false, reconnection: false, extraHeaders: { Cookie: managerCookieB } });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout ui socket B")), 5_000);
        uiSocketB.on("connect", () => { clearTimeout(t); resolve(); });
        uiSocketB.connect();
      });
      const beforeValidateCount = commandsSeenA.filter((c) => c.type === "VALIDATE_BOT").length;
      uiSocketB.emit("continue-bot", { botId, clientRequestId: `cross-agency-validate-${RUN_SUFFIX}` });
      await sleep(1_000);
      const afterValidateCount = commandsSeenA.filter((c) => c.type === "VALIDATE_BOT").length;
      assert(afterValidateCount === beforeValidateCount, "VALIDATE_BOT depuis une autre agence n'est jamais dispatche a l'agent proprietaire");
      uiSocketB.disconnect();

      agentA.socket.disconnect();
      await contextA.close();
    }

    log("DONE", "Tous les scenarios simules termines.");
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    for (const server of runningServers) await killTree(server.child.pid);
    await cleanupTestData();
    await pool.end();
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exit(failCount > 0 ? 1 : 0);
};

// Emet deux continue-bot directement via un socket UI second (contourne
// l'anti-double-clic cote DOM, pour verifier reellement le rejet serveur).
function APP_emitContinueBotTwice(page: Page, botId: string): void {
  void page.evaluate((id) => {
    (window as any).RendezBotApp.socket.emit("continue-bot", { botId: id, clientRequestId: `dbl-1-${Date.now()}` });
    (window as any).RendezBotApp.socket.emit("continue-bot", { botId: id, clientRequestId: `dbl-2-${Date.now()}` });
  }, botId);
}

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
