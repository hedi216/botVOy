// Tests SIMULES de la fonctionnalite "Nettoyer l'historique des bots"
// (suppression de lignes agent_commands terminees uniquement). Comme
// test-agent-bot-status-simulated.ts: aucun vrai runtime agent, aucun
// Chrome - tout agent est un socket.io-client fantome (auth "pair" reelle,
// reponses COMMAND_ACK/BOT_STATUS/COMMAND_COMPLETED/COMMAND_FAILED
// simulees a la main). Peut donc tourner sans risque sur la VM.
//
// Usage: npx tsx scripts/test-agent-delete-history-simulated.ts
//    ou: npm run test:agent:delete-history:simulated

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

// --- Cycle de vie serveur (meme convention que les autres tests agent) ---

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
  const agencyName = `Test DeleteHistory ${labelSuffix} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = agencyResult.body.agency.id;
  const managerLogin = `test-delhist-${labelSuffix.toLowerCase()}-${RUN_SUFFIX}`;
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

// --- Agent fantome (identique a test-agent-bot-status-simulated.ts) ---

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
      socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
      resolve({ agentId: payload.agentId, token: payload.token, socket });
    });
    socket.connect();
  });
};

const openUiSocket = (baseUrl: string, cookie: string): Promise<Socket> => new Promise((resolve, reject) => {
  const s = ioClient(baseUrl, { autoConnect: false, reconnection: false, extraHeaders: { Cookie: cookie } });
  const t = setTimeout(() => reject(new Error("timeout ui socket")), 8_000);
  s.on("connect", () => { clearTimeout(t); resolve(s); });
  s.connect();
});

const waitUntilValue = async <T>(getter: () => T | undefined, timeoutMs = 8_000): Promise<T | undefined> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = getter();
    if (value) return value;
    await sleep(100);
  }
  return getter();
};

// Demarre un bot SANS Playwright (comme le scenario "stress" de
// test-agent-bot-status-simulated.ts): plus rapide, suffisant pour des
// verifications purement API/DB comme celles-ci.
const startBotViaSocket = async (uiSocket: Socket, agent: FakeAgentHandle, botName: string): Promise<{ commandId: string; botId: string }> => {
  const commandPromise = new Promise<{ commandId: string; botId: string }>((resolve) => {
    agent.socket.once("AGENT_COMMAND", (command: any) => resolve({ commandId: command.commandId, botId: command.botId }));
  });
  uiSocket.emit("start-bot", { botName, clientRequestId: `${botName}-${Date.now()}` });
  return commandPromise;
};

// ===================== Scenario A: suppression d'une commande FAILED =====================
// Le bot n'a jamais recu le moindre BOT_STATUS (Chrome n'a jamais pu
// demarrer): la ligne doit rester supprimable malgre le pre-enregistrement
// optimiste du bot au dispatch de START_BOT (registerAgentBot, botStatus=null).

const runFailedDeletionScenario = async (baseUrl: string, fixture: { agencyId: number; managerLogin: string; managerPassword: string }): Promise<void> => {
  log("SCENARIO-A", "=== Suppression d'une commande FAILED (Chrome jamais demarre) ===");
  const managerCookie = await loginWithRetry(baseUrl, fixture.managerLogin, fixture.managerPassword);
  const agent = await pairFakeAgent(baseUrl, managerCookie, "DELHIST-A-PC");
  const uiSocket = await openUiSocket(baseUrl, managerCookie);

  const { commandId, botId } = await startBotViaSocket(uiSocket, agent, "Bot Failed Case");
  agent.socket.emit("COMMAND_FAILED", { commandId, errorCode: "BROWSER_LAUNCH_FAILED", message: "Chrome introuvable." });

  const failed = await waitUntil(async () => {
    const res = await requestJson(baseUrl, "GET", `/api/agent-commands/${commandId}`, managerCookie);
    return res.body?.command?.status === "FAILED";
  });
  assert(failed, "A1) La commande START_BOT passe bien a FAILED");

  const del = await requestJson(baseUrl, "DELETE", `/api/agent-commands/${commandId}`, managerCookie);
  assert(del.status === 200 && del.body?.ok === true, "A2) Suppression d'une commande FAILED acceptee (200)");

  const after = await requestJson(baseUrl, "GET", `/api/agent-commands/${commandId}`, managerCookie);
  assert(after.status === 404, "A3) La commande FAILED supprimee n'est plus consultable (404)");

  agent.socket.disconnect();
  uiSocket.disconnect();
  void botId;
};

// ===================== Scenario B: refus d'une commande active, puis suppression une fois STOPPED =====================

const runActiveThenStoppedScenario = async (baseUrl: string, fixture: { agencyId: number; managerLogin: string; managerPassword: string }): Promise<void> => {
  log("SCENARIO-B", "=== Refus d'une commande active, puis suppression d'une commande COMPLETED+STOPPED ===");
  const managerCookie = await loginWithRetry(baseUrl, fixture.managerLogin, fixture.managerPassword);
  const agent = await pairFakeAgent(baseUrl, managerCookie, "DELHIST-B-PC");
  const uiSocket = await openUiSocket(baseUrl, managerCookie);

  const { commandId, botId } = await startBotViaSocket(uiSocket, agent, "Bot Active Then Stopped");
  agent.socket.emit("COMMAND_ACK", { commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("BOT_STATUS", { commandId, botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
  agent.socket.emit("COMMAND_COMPLETED", { commandId, completedAt: new Date().toISOString(), result: { botId, status: "WAITING_FOR_USER", started: true } });

  const completedButActive = await waitUntil(async () => {
    const res = await requestJson(baseUrl, "GET", `/api/agent-commands/${commandId}`, managerCookie);
    return res.body?.command?.status === "COMPLETED" && res.body?.command?.botStatus === "WAITING_FOR_USER";
  });
  assert(completedButActive, "B1) START_BOT COMPLETED, bot toujours WAITING_FOR_USER");

  const refused = await requestJson(baseUrl, "DELETE", `/api/agent-commands/${commandId}`, managerCookie);
  assert(refused.status === 409, "B2) Suppression refusee tant que le bot est actif (409), meme si la commande est COMPLETED");

  const stillThere = await requestJson(baseUrl, "GET", `/api/agent-commands/${commandId}`, managerCookie);
  assert(stillThere.status === 200, "B3) La ligne refusee est toujours presente apres le refus");

  // Reutilise le commandId du START_BOT pour le BOT_STATUS STOPPED (meme
  // pattern deja etabli cote agent: cf. wireUnexpectedClosure) - aucun
  // besoin de faire transiter un vrai STOP_BOT pour ce test cible.
  agent.socket.emit("BOT_STATUS", { commandId, botId, status: "STOPPED", timestamp: new Date().toISOString() });
  const nowStopped = await waitUntil(async () => {
    const res = await requestJson(baseUrl, "GET", `/api/agent-commands/${commandId}`, managerCookie);
    return res.body?.command?.botStatus === "STOPPED";
  });
  assert(nowStopped, "B4) botStatus passe bien a STOPPED");

  const del = await requestJson(baseUrl, "DELETE", `/api/agent-commands/${commandId}`, managerCookie);
  assert(del.status === 200 && del.body?.ok === true, "B5) Suppression acceptee une fois le bot STOPPED (commande COMPLETED)");

  const afterDelete = await requestJson(baseUrl, "GET", `/api/agent-commands/${commandId}`, managerCookie);
  assert(afterDelete.status === 404, "B6) La commande COMPLETED+STOPPED supprimee n'est plus consultable");

  agent.socket.disconnect();
  uiSocket.disconnect();
};

// ===================== Scenario C: refus inter-agence =====================

const runCrossAgencyRefusalScenario = async (
  baseUrl: string,
  fixtureA: { agencyId: number; managerLogin: string; managerPassword: string },
  fixtureB: { agencyId: number; managerLogin: string; managerPassword: string }
): Promise<void> => {
  log("SCENARIO-C", "=== Refus inter-agence ===");
  const managerCookieA = await loginWithRetry(baseUrl, fixtureA.managerLogin, fixtureA.managerPassword);
  const agentA = await pairFakeAgent(baseUrl, managerCookieA, "DELHIST-C-PC");
  const uiSocketA = await openUiSocket(baseUrl, managerCookieA);

  const { commandId, botId } = await startBotViaSocket(uiSocketA, agentA, "Bot CrossAgency Delete");
  agentA.socket.emit("COMMAND_FAILED", { commandId, errorCode: "BROWSER_LAUNCH_FAILED", message: "Chrome introuvable." });
  const failed = await waitUntil(async () => {
    const res = await requestJson(baseUrl, "GET", `/api/agent-commands/${commandId}`, managerCookieA);
    return res.body?.command?.status === "FAILED";
  });
  assert(failed, "C1) Commande FAILED preparee dans l'agence A");

  const managerCookieB = await loginWithRetry(baseUrl, fixtureB.managerLogin, fixtureB.managerPassword);
  const crossDelete = await requestJson(baseUrl, "DELETE", `/api/agent-commands/${commandId}`, managerCookieB);
  assert(crossDelete.status === 404, "C2) Le manager de l'agence B ne peut pas supprimer une commande de l'agence A (404, jamais 200)");

  const crossClear = await requestJson(baseUrl, "DELETE", "/api/agent-commands", managerCookieB);
  assert(crossClear.status === 200 && crossClear.body?.deletedCount === 0, "C3) Le nettoyage global de l'agence B ne supprime rien dans l'agence A (deletedCount=0)");

  const stillThereForA = await requestJson(baseUrl, "GET", `/api/agent-commands/${commandId}`, managerCookieA);
  assert(stillThereForA.status === 200, "C4) La commande de l'agence A est toujours presente apres les deux tentatives depuis l'agence B");

  void botId;
  agentA.socket.disconnect();
  uiSocketA.disconnect();
};

// ===================== Scenario D: nettoyage global limite aux statuts terminaux =====================

const runBulkClearScenario = async (baseUrl: string, fixture: { agencyId: number; managerLogin: string; managerPassword: string }): Promise<void> => {
  log("SCENARIO-D", "=== Nettoyage global limite aux statuts terminaux ===");
  const managerCookie = await loginWithRetry(baseUrl, fixture.managerLogin, fixture.managerPassword);
  const agent = await pairFakeAgent(baseUrl, managerCookie, "DELHIST-D-PC");
  const uiSocket = await openUiSocket(baseUrl, managerCookie);

  // Un bot terminal (FAILED, jamais demarre).
  const terminal = await startBotViaSocket(uiSocket, agent, "Bot Bulk Terminal");
  agent.socket.emit("COMMAND_FAILED", { commandId: terminal.commandId, errorCode: "BROWSER_LAUNCH_FAILED", message: "Chrome introuvable." });
  await waitUntil(async () => {
    const res = await requestJson(baseUrl, "GET", `/api/agent-commands/${terminal.commandId}`, managerCookie);
    return res.body?.command?.status === "FAILED";
  });

  // Un bot encore actif (COMPLETED mais WAITING_FOR_USER).
  const active = await startBotViaSocket(uiSocket, agent, "Bot Bulk Active");
  agent.socket.emit("COMMAND_ACK", { commandId: active.commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("BOT_STATUS", { commandId: active.commandId, botId: active.botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: active.commandId, completedAt: new Date().toISOString(), result: { botId: active.botId, status: "WAITING_FOR_USER", started: true } });
  await waitUntil(async () => {
    const res = await requestJson(baseUrl, "GET", `/api/agent-commands/${active.commandId}`, managerCookie);
    return res.body?.command?.status === "COMPLETED" && res.body?.command?.botStatus === "WAITING_FOR_USER";
  });

  const clear = await requestJson(baseUrl, "DELETE", "/api/agent-commands", managerCookie);
  assert(clear.status === 200, "D1) DELETE /api/agent-commands (nettoyage global) repond 200");
  assert(clear.body?.deletedCount === 1, `D2) Exactement 1 ligne supprimee (trouve: ${clear.body?.deletedCount})`);

  const terminalAfter = await requestJson(baseUrl, "GET", `/api/agent-commands/${terminal.commandId}`, managerCookie);
  assert(terminalAfter.status === 404, "D3) La ligne terminale (FAILED) a bien disparu");

  const activeAfter = await requestJson(baseUrl, "GET", `/api/agent-commands/${active.commandId}`, managerCookie);
  assert(activeAfter.status === 200, "D4) La ligne active (WAITING_FOR_USER) est toujours presente apres le nettoyage global");

  agent.socket.disconnect();
  uiSocket.disconnect();
};

// ===================== Scenario E: interface reelle (bouton Supprimer / Nettoyer l'historique) =====================

const rowFor = (page: Page, botNameText: string) => page.locator("#agentCommandsTableBody tr", { hasText: botNameText });
const deleteButtonFor = (page: Page, botNameText: string) => rowFor(page, botNameText).locator("button", { hasText: "Supprimer" });
const stopButtonFor = (page: Page, botNameText: string) => rowFor(page, botNameText).locator("button", { hasText: "Arreter" });

const loginViaUi = async (page: Page, baseUrl: string, loginName: string, password: string): Promise<void> => {
  await page.goto(baseUrl);
  await page.fill("#loginInput", loginName);
  await page.fill("#passwordInput", password);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
};

const runUiScenario = async (browser: Browser, baseUrl: string, fixture: { managerLogin: string; managerPassword: string }): Promise<void> => {
  log("SCENARIO-E", "=== Interface reelle: bouton Supprimer / Nettoyer l'historique ===");
  const managerCookie = await loginWithRetry(baseUrl, fixture.managerLogin, fixture.managerPassword);
  const agent = await pairFakeAgent(baseUrl, managerCookie, "DELHIST-E-PC");
  const uiSocket = await openUiSocket(baseUrl, managerCookie);

  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("dialog", (dialog) => { void dialog.accept(); });

  await loginViaUi(page, baseUrl, fixture.managerLogin, fixture.managerPassword);
  await page.click('#agentSetupSkip').catch(() => undefined);
  await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
  await page.click('[data-page-target="bot"]');
  await page.waitForSelector("#page-bot.active");

  // Bot encore actif: pas de bouton Supprimer.
  const active = await startBotViaSocket(uiSocket, agent, "Bot UI Active");
  agent.socket.emit("COMMAND_ACK", { commandId: active.commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("BOT_STATUS", { commandId: active.commandId, botId: active.botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: active.commandId, completedAt: new Date().toISOString(), result: { botId: active.botId, status: "WAITING_FOR_USER", started: true } });
  await waitUntil(async () => (await stopButtonFor(page, "Bot UI Active").count()) === 1, 5_000);
  assert((await deleteButtonFor(page, "Bot UI Active").count()) === 0, "E1) Aucun bouton Supprimer sur une ligne encore active (WAITING_FOR_USER)");

  // Bot terminal (FAILED): bouton Supprimer visible et fonctionnel.
  const terminal = await startBotViaSocket(uiSocket, agent, "Bot UI Terminal");
  agent.socket.emit("COMMAND_FAILED", { commandId: terminal.commandId, errorCode: "BROWSER_LAUNCH_FAILED", message: "Chrome introuvable." });
  await waitUntil(async () => (await deleteButtonFor(page, "Bot UI Terminal").count()) === 1, 5_000);
  assert(true, "E2) Bouton Supprimer visible sur une ligne FAILED");

  await deleteButtonFor(page, "Bot UI Terminal").click();
  await waitUntil(async () => (await rowFor(page, "Bot UI Terminal").count()) === 0, 5_000);
  assert((await rowFor(page, "Bot UI Terminal").count()) === 0, "E3) Clic sur Supprimer retire bien la ligne de l'interface");
  const messageAfterDelete = await page.locator("#agentCommandsMessage").innerText().catch(() => "");
  assert(messageAfterDelete.includes("Historique supprime"), "E4) Message de confirmation apres suppression d'une ligne");

  // Bouton "Nettoyer l'historique": ne doit retirer que la ligne terminale
  // restante eventuelle, jamais la ligne active toujours affichee.
  const terminal2 = await startBotViaSocket(uiSocket, agent, "Bot UI Terminal 2");
  agent.socket.emit("COMMAND_FAILED", { commandId: terminal2.commandId, errorCode: "BROWSER_LAUNCH_FAILED", message: "Chrome introuvable." });
  await waitUntil(async () => (await deleteButtonFor(page, "Bot UI Terminal 2").count()) === 1, 5_000);

  await page.click("#clearAgentCommands");
  await waitUntil(async () => (await rowFor(page, "Bot UI Terminal 2").count()) === 0, 5_000);
  assert((await rowFor(page, "Bot UI Terminal 2").count()) === 0, "E5) 'Nettoyer l'historique' retire la ligne terminale");
  assert((await rowFor(page, "Bot UI Active").count()) === 1, "E6) 'Nettoyer l'historique' ne retire jamais une ligne encore active");

  agent.socket.disconnect();
  uiSocket.disconnect();
  await context.close();
};

const main = async (): Promise<void> => {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });

    const server = await startServer(3282, {
      AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent",
      AGENT_COMMAND_ACK_TIMEOUT_MS: "8000", AGENT_COMMAND_TTL_MS: "20000"
    });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    const fixtureA = await createAgencyAndManager(server.baseUrl, adminCookie, "A");
    await runFailedDeletionScenario(server.baseUrl, fixtureA);

    const fixtureB = await createAgencyAndManager(server.baseUrl, adminCookie, "B");
    await runActiveThenStoppedScenario(server.baseUrl, fixtureB);

    const fixtureCrossA = await createAgencyAndManager(server.baseUrl, adminCookie, "CrossA");
    const fixtureCrossB = await createAgencyAndManager(server.baseUrl, adminCookie, "CrossB");
    await runCrossAgencyRefusalScenario(server.baseUrl, fixtureCrossA, fixtureCrossB);

    const fixtureD = await createAgencyAndManager(server.baseUrl, adminCookie, "D");
    await runBulkClearScenario(server.baseUrl, fixtureD);

    const fixtureE = await createAgencyAndManager(server.baseUrl, adminCookie, "E");
    await runUiScenario(browser, server.baseUrl, fixtureE);
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
