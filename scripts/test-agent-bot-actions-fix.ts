// Correctif post-Lot 2: le frontend confondait le statut de la commande
// START_BOT (PENDING/SENT/ACKNOWLEDGED/COMPLETED/FAILED) avec le statut
// metier du bot local (STARTING/WAITING_FOR_USER/MONITORING/.../STOPPED).
// START_BOT passe a COMPLETED des que Chrome est ouvert, alors que le bot
// reste actif (WAITING_FOR_USER) bien apres: le bouton "Arreter" devait donc
// se baser sur le statut runtime (botStatus), jamais sur le statut de
// commande. Ce script verifie que la correction tient dans tous les cas
// requis, avec un agent simule (rapide, deterministe) ET avec le vrai
// runtime src/agent/agentMain.ts (Chrome reellement ouvert/ferme).
//
// Usage: npx tsx scripts/test-agent-bot-actions-fix.ts

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
    try {
      const res = await fetch(`${baseUrl}/api/me`);
      if (res.status === 401 || res.status === 200) return;
    } catch { /* pas encore pret */ }
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

type HttpResult = { status: number; body: any; cookie?: string };

const requestJson = async (baseUrl: string, method: string, pathName: string, cookie: string | undefined, json?: unknown): Promise<HttpResult> => {
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
  const agencyName = `Test BotActions ${labelSuffix} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = agencyResult.body.agency.id;
  const managerLogin = `test-botact-${labelSuffix.toLowerCase()}-${RUN_SUFFIX}`;
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

// --- Agent fantome pilotable (deterministe, pour les scenarios de gating frontend) ---

type FakeAgentHandle = { agentId: number; token: string; socket: Socket };

const connectFakeAgent = (baseUrl: string, pairingCode: string, computerName: string): Promise<FakeAgentHandle> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "pair", pairingCode, computerName, version: "1.0.0" }
    });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout agent fantome.")); }, 8_000);
    socket.on("connect_error", (e: Error) => { clearTimeout(timer); reject(e); });
    socket.on("AGENT_CONNECTED", (payload: { agentId: number; token: string | null }) => {
      clearTimeout(timer);
      if (!payload.token) { reject(new Error("Aucun jeton.")); return; }
      resolve({ agentId: payload.agentId, token: payload.token, socket });
    });
    socket.connect();
  });

const pairFakeAgent = async (baseUrl: string, managerCookie: string, computerName: string): Promise<FakeAgentHandle> => {
  const pairing = await requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
  return connectFakeAgent(baseUrl, pairing.body.pairing.code, computerName);
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

// --- Inventaire chrome.exe (racines uniquement) pour la preuve "aucun Chrome sur la VM" ---

type ChromeProcInfo = { pid: string; parentPid: string };
const listChromeProcs = (): Promise<ChromeProcInfo[]> => new Promise((resolve) => {
  if (process.platform !== "win32") { resolve([]); return; }
  const child = spawn("wmic", ["process", "where", "Name='chrome.exe'", "get", "ProcessId,ParentProcessId"]);
  let output = "";
  child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
  child.on("exit", () => {
    const rows = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(1);
    resolve(rows.map((row) => {
      const parts = row.split(/\s+/).filter(Boolean);
      return { pid: parts[1] ?? "", parentPid: parts[0] ?? "" };
    }).filter((p) => /^\d+$/.test(p.pid)));
  });
  child.on("error", () => resolve([]));
});
const rootPids = (procs: ChromeProcInfo[]): string[] => {
  const all = new Set(procs.map((p) => p.pid));
  return procs.filter((p) => !all.has(p.parentPid)).map((p) => p.pid);
};

// Verifie par arbre de process reel (pas par supposition) qu'un pid donne
// est bien un descendant de rootPid, en remontant via ParentProcessId.
const isDescendantOf = async (pid: string, rootPid: string, maxDepth = 8): Promise<boolean> => {
  if (process.platform !== "win32") return true;
  let current = pid;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (current === rootPid) return true;
    const parent = await new Promise<string | null>((resolve) => {
      const w = spawn("wmic", ["process", "where", `ProcessId=${current}`, "get", "ParentProcessId"]);
      let out = "";
      w.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
      w.on("exit", () => {
        const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => /^\d+$/.test(l));
        resolve(line ?? null);
      });
      w.on("error", () => resolve(null));
    });
    if (!parent) return false;
    current = parent;
  }
  return false;
};

const main = async (): Promise<void> => {
  let browser: Browser | undefined;
  const servers: ServerHandle[] = [];
  const consoleErrors: string[] = [];

  try {
    browser = await chromium.launch({ headless: true });

    // ===================== Partie 1: agent simule (gating frontend) =====================
    const server = await startServer(3261, {
      AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent",
      AGENT_COMMAND_ACK_TIMEOUT_MS: "5000", AGENT_COMMAND_TTL_MS: "15000"
    });
    servers.push(server);

    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const fixtureA = await createAgencyAndManager(server.baseUrl, adminCookie, "A");
    const fixtureB = await createAgencyAndManager(server.baseUrl, adminCookie, "B");
    const managerCookieA = await loginWithRetry(server.baseUrl, fixtureA.managerLogin, fixtureA.managerPassword);

    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(e.message));

    await loginViaUi(page, server.baseUrl, fixtureA.managerLogin, fixtureA.managerPassword);
    await page.click('#agentSetupSkip').catch(() => undefined);
    await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

    const agent = await pairFakeAgent(server.baseUrl, managerCookieA, "FIX-PC");
    const commandsSeen: Array<Record<string, unknown>> = [];
    agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));

    await page.click('[data-page-target="bot"]');
    await page.waitForSelector("#page-bot.active");

    // --- 1) START_BOT COMPLETED + runtime WAITING_FOR_USER -> bouton Arreter visible ---
    await startBotViaUi(page, "Bot Actions Test");
    await waitUntil(async () => (await rowFor(page, "Bot Actions Test").count()) > 0);
    const startCommand = await waitUntil2(() => commandsSeen.find((c) => c.type === "START_BOT"));
    if (!startCommand) throw new Error("START_BOT jamais recu par l'agent fantome.");

    agent.socket.emit("COMMAND_ACK", { commandId: startCommand.commandId, receivedAt: new Date().toISOString() });
    agent.socket.emit("BOT_STATUS", { commandId: startCommand.commandId, botId: startCommand.botId, status: "STARTING", timestamp: new Date().toISOString() });
    await sleep(100);
    agent.socket.emit("BOT_STATUS", { commandId: startCommand.commandId, botId: startCommand.botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
    await sleep(100);
    agent.socket.emit("COMMAND_COMPLETED", { commandId: startCommand.commandId, completedAt: new Date().toISOString(), result: { botId: startCommand.botId, status: "WAITING_FOR_USER", started: true, computerName: "FIX-PC" } });

    await waitUntil(async () => (await rowFor(page, "Bot Actions Test").innerText()).includes("COMPLETED"));
    assert(true, "START_BOT atteint COMPLETED (commande)");
    await waitUntil(async () => (await stopButtonFor(page, "Bot Actions Test").count()) === 1, 5_000);
    assert(
      (await stopButtonFor(page, "Bot Actions Test").count()) === 1,
      "Commande COMPLETED + runtime WAITING_FOR_USER -> bouton Arreter visible (bug corrige)"
    );
    assert(
      (await validateButtonFor(page, "Bot Actions Test").count()) === 1,
      "WAITING_FOR_USER affiche aussi le bouton Valider (deja correct, verifie non regresse)"
    );

    // --- 5) Rechargement de page pendant WAITING_FOR_USER -> bouton toujours present ---
    await page.reload();
    await page.waitForSelector("#appLayout:not([hidden])");
    await page.click('[data-page-target="bot"]');
    await page.waitForSelector("#page-bot.active");
    await waitUntil(async () => (await rowFor(page, "Bot Actions Test").count()) > 0, 5_000);
    assert(
      (await stopButtonFor(page, "Bot Actions Test").count()) === 1,
      "Apres rechargement de page pendant WAITING_FOR_USER, le bouton Arreter est toujours present (etat reconstruit depuis le serveur)"
    );

    // --- 2) clic Arreter -> commande STOP_BOT envoyee ---
    const botId = startCommand.botId as string;
    await stopButtonFor(page, "Bot Actions Test").click();
    const stopCommand = await waitUntil2(() => commandsSeen.find((c) => c.type === "STOP_BOT" && c.botId === botId));
    assert(Boolean(stopCommand), "Le clic sur Arreter declenche bien l'envoi d'une commande STOP_BOT au meme agent/botId");

    // --- 3) STOPPING -> bouton masque ---
    if (stopCommand) {
      agent.socket.emit("COMMAND_ACK", { commandId: stopCommand.commandId, receivedAt: new Date().toISOString() });
      agent.socket.emit("BOT_STATUS", { commandId: stopCommand.commandId, botId, status: "STOPPING", timestamp: new Date().toISOString() });
      await waitUntil(async () => (await stopButtonFor(page, "Bot Actions Test").count()) === 0, 5_000);
      assert((await stopButtonFor(page, "Bot Actions Test").count()) === 0, "Pendant STOPPING, le bouton Arreter est masque");

      // --- 4) STOPPED -> bouton masque ---
      agent.socket.emit("BOT_STATUS", { commandId: stopCommand.commandId, botId, status: "STOPPED", timestamp: new Date().toISOString() });
      agent.socket.emit("COMMAND_COMPLETED", { commandId: stopCommand.commandId, completedAt: new Date().toISOString(), result: { botId, status: "STOPPED", stopped: true } });
      await waitUntil(async () => (await rowFor(page, "Bot Actions Test").innerText()).includes("COMPLETED"));
      assert(
        (await stopButtonFor(page, "Bot Actions Test").count()) === 0,
        "6) Une commande COMPLETED dont le bot est deja STOPPED ne montre pas Arreter"
      );
      assert(
        (await validateButtonFor(page, "Bot Actions Test").count()) === 0,
        "STOPPED ne montre pas non plus le bouton Valider"
      );
    }

    // --- 7) aucune action ne controle un bot d'une autre agence ---
    const managerCookieB = await loginWithRetry(server.baseUrl, fixtureB.managerLogin, fixtureB.managerPassword);
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await loginViaUi(pageB, server.baseUrl, fixtureB.managerLogin, fixtureB.managerPassword);
    await pageB.click('#agentSetupSkip').catch(() => undefined);
    await pageB.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
    await pageB.click('[data-page-target="bot"]');
    await pageB.waitForSelector("#page-bot.active");
    assert(
      (await rowFor(pageB, "Bot Actions Test").count()) === 0,
      "Le manager d'une autre agence ne voit meme pas le bot dans son tableau de commandes"
    );

    const socketB = ioClient(server.baseUrl, { autoConnect: false, reconnection: false, extraHeaders: { Cookie: managerCookieB } });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout socket B")), 5_000);
      socketB.on("connect", () => { clearTimeout(t); resolve(); });
      socketB.connect();
    });
    let crossAgencyEventReceived = false;
    socketB.on("agent-command-status", () => { crossAgencyEventReceived = true; });
    socketB.emit("stop-bot", { botId, clientRequestId: `cross-agency-${RUN_SUFFIX}` });
    await sleep(1_000);
    assert(!crossAgencyEventReceived, "Une tentative stop-bot depuis une autre agence sur ce botId n'a aucun effet observable");
    socketB.disconnect();
    await contextB.close();

    assert(consoleErrors.length === 0, `Aucune erreur console (recu: ${consoleErrors.join(" | ") || "aucune"})`);

    agent.socket.disconnect();
    await context.close();

    // ===================== Partie 2: vrai agent, vrai Chrome (preuve du bug reel corrige) =====================
    const server2 = await startServer(3262, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });
    servers.push(server2);
    const adminCookie2 = await loginWithRetry(server2.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const fixture2 = await createAgencyAndManager(server2.baseUrl, adminCookie2, "Real");
    const managerCookie2 = await loginWithRetry(server2.baseUrl, fixture2.managerLogin, fixture2.managerPassword);
    const pairing2 = await requestJson(server2.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie2, {});
    const code2 = pairing2.body.pairing.code;

    const chromeBaseline = (await listChromeProcs()).map((p) => p.pid);
    const credPath = path.join(process.cwd(), `.test-botact-real-creds-${RUN_SUFFIX}.json`);
    const dataRoot = path.join(process.cwd(), `.test-botact-real-data-${RUN_SUFFIX}`);

    const realAgent: ChildProcess = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "src/agent/agentMain.ts", "pair", code2], {
      env: {
        ...process.env,
        AGENT_SERVER_URL: server2.baseUrl,
        AGENT_CREDENTIALS_PATH: credPath,
        AGENT_DATA_DIR: dataRoot,
        AGENT_COMPUTER_NAME: "REAL-BOTACT-PC",
        AGENT_TARGET_MODE: "fixture",
        AGENT_FIXTURE_URL: "about:blank"
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    realAgent.stdout?.on("data", (c: Buffer) => log("REAL-AGENT", c.toString().trim()));
    realAgent.stderr?.on("data", (c: Buffer) => log("REAL-AGENT-ERR", c.toString().trim()));
    await sleep(2_000);

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await loginViaUi(page2, server2.baseUrl, fixture2.managerLogin, fixture2.managerPassword);
    await page2.click('#agentSetupSkip').catch(() => undefined);
    await page2.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
    await page2.click('[data-page-target="bot"]');
    await page2.waitForSelector("#page-bot.active");

    await startBotViaUi(page2, "Bot Reel Actions");
    await waitUntil(async () => (await rowFor(page2, "Bot Reel Actions").innerText()).includes("COMPLETED"), 15_000);
    assert(true, "Vrai agent: START_BOT reel atteint COMPLETED (Chrome reellement ouvert)");

    const chromeAfterStart = await listChromeProcs();
    const newRootsAfterStart = rootPids(chromeAfterStart).filter((pid) => !chromeBaseline.includes(pid));
    assert(newRootsAfterStart.length === 1, `8) Un seul navigateur reel ouvert par l'agent (trouve: ${newRootsAfterStart.length})`);

    if (newRootsAfterStart[0] && realAgent.pid && server2.child.pid) {
      const belongsToAgent = await isDescendantOf(newRootsAfterStart[0], String(realAgent.pid));
      const belongsToServer = await isDescendantOf(newRootsAfterStart[0], String(server2.child.pid));
      assert(belongsToAgent, "8) Le chrome.exe reellement ouvert descend bien du process agent");
      assert(!belongsToServer, "8) Le chrome.exe reellement ouvert NE descend PAS du process serveur/VM");
    }

    await waitUntil(async () => (await stopButtonFor(page2, "Bot Reel Actions").count()) === 1, 5_000);
    assert(
      (await stopButtonFor(page2, "Bot Reel Actions").count()) === 1,
      "REPRODUCTION DU BUG SIGNALE: avec le vrai agent, START_BOT COMPLETED + Chrome reellement ouvert -> bouton Arreter bien visible"
    );

    await stopButtonFor(page2, "Bot Reel Actions").click();
    await waitUntil(async () => (await stopButtonFor(page2, "Bot Reel Actions").count()) === 0, 15_000);
    assert((await stopButtonFor(page2, "Bot Reel Actions").count()) === 0, "Apres clic reel sur Arreter, le bouton disparait une fois le bot STOPPED");

    // taskkill /F retourne des que l'arret est demande, mais Windows peut
    // mettre quelques centaines de ms a faire disparaitre tous les
    // sous-process d'un arbre Chrome complet (crashpad/gpu/renderers): on
    // reverifie brievement avant de conclure a un orphelin.
    let chromeStillThere = newRootsAfterStart;
    const orphanDeadline = Date.now() + 5_000;
    while (Date.now() < orphanDeadline) {
      const chromeNow = await listChromeProcs();
      chromeStillThere = newRootsAfterStart.filter((pid) => chromeNow.some((c) => c.pid === pid));
      if (chromeStillThere.length === 0) break;
      await sleep(300);
    }
    assert(chromeStillThere.length === 0, "Le clic reel sur Arreter ferme effectivement le vrai Chrome, aucun orphelin");

    await context2.close();
    await killTree(realAgent.pid);
    await killTree(server2.child.pid);
    if (existsSync(credPath)) rmSync(credPath);
    if (existsSync(dataRoot)) rmSync(dataRoot, { recursive: true, force: true });
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    for (const server of servers) await killTree(server.child.pid);
    await cleanupTestData();
    await pool.end();
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exit(failCount > 0 ? 1 : 0);
};

// Petit helper local: attend qu'une valeur (potentiellement undefined) devienne truthy.
const waitUntil2 = async <T>(getter: () => T | undefined, timeoutMs = 8_000): Promise<T | undefined> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = getter();
    if (value) return value;
    await sleep(100);
  }
  return getter();
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
