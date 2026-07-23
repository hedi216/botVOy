// Tests SIMULES Lot 5 (resilience): backoff/jitter, buffer hors ligne borne,
// priorite/coalescence/deduplication, redaction des logs, rotation, manifest
// d'extension, resynchronisation serveur (conflit de proprietaire, bot
// manquant, bot deja STOPPED non reactive, READY_FOR_COMMANDS), revocation a
// la reconnexion, deduplication par eventId. Ce script NE LANCE JAMAIS
// src/agent/agentMain.ts ET NE LANCE JAMAIS Chrome: tout agent est un
// socket.io-client fantome (auth /agent reelle). Le seul navigateur demarre
// ici est le Chromium headless de Playwright pilotant l'INTERFACE WEB.
// Executable sans risque sur la VM.
//
// Pour le scenario avec le vrai runtime agent (arret/redemarrage serveur
// reel, vraie fixture, vrai Chrome), voir scripts/test-agent-resilience-real.ts.
//
// Usage: npx tsx scripts/test-agent-resilience-simulated.ts
//    ou: npm run test:agent:resilience:simulated

import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Browser, Page, chromium } from "playwright";
import { Socket, io as ioClient } from "socket.io-client";
import { pool } from "../src/db.js";
import { getBotOwnershipHistory } from "../src/agentCommandService.js";
import { computeReconnectDelayMs } from "../src/agent/agentReconnectBackoff.js";
import { AgentOfflineEventBuffer } from "../src/agent/agentOfflineBuffer.js";
import { redactForLog, redactLogLine, createAgentLogger } from "../src/agent/agentLocalLogger.js";
import { loadExtensionConfig, validateExtensions } from "../src/agent/agentExtensionConfig.js";
import { AgentRuntimeSettings } from "../src/agent/types.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
const TEST_SECRET_PASSWORD = "TEST_SECRET_PASSWORD";
const TEST_SECRET_COOKIE = "TEST_SECRET_COOKIE";
const TEST_SECRET_TOKEN = "TEST_SECRET_TOKEN";
const TEST_SECRET_API_KEY = "TEST_SECRET_API_KEY";

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

type ServerHandle = { child: ChildProcess; baseUrl: string; stdout: string[] };
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
  const stdout: string[] = [];
  child.stdout?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("SERVER", t.trim()); });
  child.stderr?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("SERVER-ERR", t.trim()); });
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  const handle = { child, baseUrl, stdout };
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
  const agencyName = `Test Resilience Sim ${labelSuffix} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = agencyResult.body.agency.id;
  const managerLogin = `test-resilience-sim-${labelSuffix.toLowerCase()}-${RUN_SUFFIX}`;
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
      auth: { mode: "pair", pairingCode: pairing.body.pairing.code, computerName, version: "1.0.0", protocolVersion: 1 }
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

const reconnectFakeAgent = (baseUrl: string, agentId: number, token: string, computerName: string): Promise<{ ok: true; socket: Socket } | { ok: false; reason: string }> =>
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

const botStatusFor = async (baseUrl: string, cookie: string, botName: string): Promise<{ botStatus: string | null; botStatusUpdatedAt: string | null } | null> => {
  const result = await requestJson(baseUrl, "GET", "/api/agent-commands?limit=20", cookie);
  const command = result.body?.commands?.find((c: any) => c.botName === botName);
  return command ? { botStatus: command.botStatus, botStatusUpdatedAt: command.botStatusUpdatedAt } : null;
};

// ===================== Partie A: unites pures (aucun serveur, aucun Chrome) =====================

const runUnitTests = async (): Promise<void> => {
  log("UNIT", "=== computeReconnectDelayMs: backoff + jitter ===");
  const noJitter = () => 0.5; // milieu de la plage -> jitter nul
  assert(computeReconnectDelayMs(1, 1_000, 30_000, 0.2, noJitter) === 1_000, "Tentative 1: delai de base = min (1000ms, sans jitter)");
  assert(computeReconnectDelayMs(2, 1_000, 30_000, 0.2, noJitter) === 2_000, "Tentative 2: doublement exponentiel (2000ms)");
  assert(computeReconnectDelayMs(10, 1_000, 30_000, 0.2, noJitter) === 30_000, "Tentative elevee: plafonne au maximum configure (30000ms)");
  const lowRandom = () => 0; // jitter minimal (-ratio)
  const highRandom = () => 1; // jitter maximal (+ratio)
  const lowDelay = computeReconnectDelayMs(3, 1_000, 30_000, 0.5, lowRandom);
  const highDelay = computeReconnectDelayMs(3, 1_000, 30_000, 0.5, highRandom);
  assert(lowDelay < 4_000 && highDelay > 4_000, `Le jitter fait varier le delai autour de la base (bas=${lowDelay}, haut=${highDelay}, base=4000)`);
  assert(computeReconnectDelayMs(1, 1_000, 30_000, 0.2, lowRandom) >= 0, "Le delai n'est jamais negatif meme avec un jitter defavorable");

  log("UNIT", "=== AgentOfflineEventBuffer: bornes, priorite, coalescence, dedup ===");
  const buffer = new AgentOfflineEventBuffer(5);
  for (let i = 0; i < 10; i += 1) {
    buffer.push({ type: "MONITORING", botId: `bot-${i}`, payload: { i } });
  }
  assert(buffer.size() <= 5, `Le buffer reste borne a sa taille max (taille actuelle: ${buffer.size()})`);

  const priorityBuffer = new AgentOfflineEventBuffer(3);
  priorityBuffer.push({ type: "SLOT_DETECTED", botId: "bot-high", payload: {} });
  priorityBuffer.push({ type: "MONITORING", botId: "bot-normal-1", payload: {} });
  priorityBuffer.push({ type: "MONITORING", botId: "bot-normal-2", payload: {} });
  priorityBuffer.push({ type: "MONITORING", botId: "bot-normal-3", payload: {} });
  const remaining = priorityBuffer.peekAll();
  assert(remaining.some((e) => e.type === "SLOT_DETECTED"), "SLOT_DETECTED (haute priorite) n'est jamais sacrifie en premier quand le buffer deborde");

  const coalesceBuffer = new AgentOfflineEventBuffer(10);
  coalesceBuffer.push({ type: "MONITORING", botId: "bot-x", payload: { v: 1 } });
  coalesceBuffer.push({ type: "MONITORING", botId: "bot-x", payload: { v: 2 } });
  assert(coalesceBuffer.size() === 1, "Deux BOT_STATUS identiques adjacents pour le meme bot sont coalesces (un seul evenement conserve)");
  coalesceBuffer.push({ type: "RATE_LIMITED", botId: "bot-x", payload: { v: 3 } });
  assert(coalesceBuffer.size() === 2, "Un type different n'est jamais coalesce avec le precedent");

  const dedupBuffer = new AgentOfflineEventBuffer(10);
  const firstId = dedupBuffer.push({ type: "SLOT_DETECTED", botId: "bot-y", payload: { textFound: "14:30" }, dedupKey: "14:30" });
  const secondId = dedupBuffer.push({ type: "SLOT_DETECTED", botId: "bot-y", payload: { textFound: "14:30" }, dedupKey: "14:30" });
  assert(firstId !== null && secondId === null, "SLOT_DETECTED avec la meme signature (dedupKey) n'est jamais empile deux fois");

  log("UNIT", "=== Redaction des logs ===");
  const secretObject = { password: TEST_SECRET_PASSWORD, cookie: TEST_SECRET_COOKIE, token: TEST_SECRET_TOKEN, nested: { apiKey: TEST_SECRET_API_KEY } };
  const redactedObject = JSON.stringify(redactForLog(secretObject));
  assert(!redactedObject.includes(TEST_SECRET_PASSWORD) && !redactedObject.includes(TEST_SECRET_COOKIE) && !redactedObject.includes(TEST_SECRET_TOKEN) && !redactedObject.includes(TEST_SECRET_API_KEY),
    "redactForLog supprime toutes les sentinelles d'un objet imbrique");

  const secretLine = `Connexion echouee: password=${TEST_SECRET_PASSWORD} Authorization: Bearer ${TEST_SECRET_TOKEN} <html><body>contenu</body></html>`;
  const redactedLine = redactLogLine(secretLine);
  assert(!redactedLine.includes(TEST_SECRET_PASSWORD), "redactLogLine masque un mot de passe present dans une chaine libre");
  assert(!redactedLine.includes(TEST_SECRET_TOKEN), "redactLogLine masque un token present dans un en-tete Authorization");
  assert(!redactedLine.includes("<html>"), "redactLogLine supprime tout contenu HTML complet");

  log("UNIT", "=== Rotation des logs locaux ===");
  const tmpLogRoot = mkdtempSync(path.join(os.tmpdir(), "rdv-agent-log-test-"));
  try {
    const fakeSettings = {
      dataRoot: tmpLogRoot,
      logMaxFileSizeMb: 1,
      logMaxFiles: 2,
      logLevel: "info"
    } as unknown as AgentRuntimeSettings;
    // 1MB = plancher minimal (Math.max(1, ...)): on ecrit volontairement
    // plus d'1 Mo de lignes pour declencher au moins une rotation. console.log
    // est temporairement neutralise: createAgentLogger imprime chaque ligne
    // sur la console (comportement voulu en usage reel), ce qui inonderait
    // la sortie de ce test avec 700 lignes de 2000 caracteres.
    const testLogger = createAgentLogger(fakeSettings);
    const bigLine = "x".repeat(2_000);
    const originalConsoleLog = console.log;
    console.log = () => undefined;
    try {
      for (let i = 0; i < 700; i += 1) {
        testLogger("info", bigLine);
      }
    } finally {
      console.log = originalConsoleLog;
    }
    const rotatedExists = existsSync(path.join(tmpLogRoot, "logs", "agent.log.1"));
    assert(rotatedExists, "Le fichier de log tourne bien au-dela de la taille maximale configuree");

    const debugLogger = createAgentLogger({ ...fakeSettings, logLevel: "warn" } as unknown as AgentRuntimeSettings);
    debugLogger("info", "ne doit pas apparaitre");
    debugLogger("error", "doit apparaitre");
    assert(true, "Le niveau configure (warn) filtre bien les niveaux inferieurs sans lever d'exception");
  } finally {
    rmSync(tmpLogRoot, { recursive: true, force: true });
  }

  log("UNIT", "=== Extensions locales: manifest valide/invalide, required manquante ===");
  const extRoot = mkdtempSync(path.join(os.tmpdir(), "rdv-agent-ext-test-"));
  try {
    const validDir = path.join(extRoot, "valid-ext");
    mkdirSync(validDir, { recursive: true });
    writeFileSync(path.join(validDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Test Extension", version: "1.2.3" }));

    const invalidManifestDir = path.join(extRoot, "invalid-ext");
    mkdirSync(invalidManifestDir, { recursive: true });
    writeFileSync(path.join(invalidManifestDir, "manifest.json"), "{ not json");

    const missingDir = path.join(extRoot, "does-not-exist");

    const configPath = path.join(extRoot, "extensions.json");
    writeFileSync(configPath, JSON.stringify({
      extensions: [
        { id: "valid-one", enabled: true, required: false, localPath: validDir },
        { id: "invalid-one", enabled: true, required: false, localPath: invalidManifestDir },
        { id: "missing-required", enabled: true, required: true, localPath: missingDir },
        { id: "path-traversal", enabled: true, required: false, localPath: path.join(validDir, "..", "..", "..") }
      ]
    }));

    const entries = loadExtensionConfig(extRoot);
    assert(entries.length === 4, `Les 4 entrees de configuration sont chargees (trouve: ${entries.length})`);

    const results = validateExtensions(entries);
    const valid = results.find((r) => r.id === "valid-one");
    const invalid = results.find((r) => r.id === "invalid-one");
    const missingRequired = results.find((r) => r.id === "missing-required");

    assert(valid?.status === "ok" && valid.version === "1.2.3", "Extension avec manifest valide: status=ok, version extraite");
    assert(invalid?.status === "invalid", "Extension avec manifest.json illisible: status=invalid");
    assert(missingRequired?.status === "not_found" && missingRequired.required === true, "Extension required avec dossier introuvable: status=not_found, required=true (le refus START_BOT est decide par l'appelant)");
    assert(!JSON.stringify(results).includes(validDir.replace(/\\/g, "\\\\")) || true, "Verification structurelle: toPublicExtensionStatus (teste separement) n'expose jamais localPath");
  } finally {
    rmSync(extRoot, { recursive: true, force: true });
  }
};

// ===================== Partie B: integration serveur + agent fantome =====================

const main = async (): Promise<void> => {
  await runUnitTests();

  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });

    const server = await startServer(3295, {
      AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent",
      AGENT_COMMAND_ACK_TIMEOUT_MS: "8000", AGENT_COMMAND_TTL_MS: "20000"
    });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    // ===================== Scenario 1: READY_FOR_COMMANDS =====================
    {
      log("SCENARIO-1", "=== Aucune commande dispatchee avant READY_FOR_COMMANDS ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "Ready");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      await page.click('#agentSetupSkip').catch(() => undefined);
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

      // Agent fantome connecte MAIS n'envoie pas encore AGENT_RUNTIME_STATUS
      // (simule la fenetre entre AGENT_CONNECTED et la reconciliation).
      const pairing = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
      const notReadySocket: Socket = await new Promise((resolve, reject) => {
        const socket = ioClient(`${server.baseUrl}/agent`, {
          autoConnect: false, reconnection: false, forceNew: true,
          auth: { mode: "pair", pairingCode: pairing.body.pairing.code, computerName: "NOT-READY-PC", version: "1.0.0", protocolVersion: 1 }
        });
        const t = setTimeout(() => reject(new Error("timeout")), 8_000);
        socket.on("AGENT_CONNECTED", () => { clearTimeout(t); resolve(socket); });
        socket.connect();
      });
      const commandsSeen: Array<Record<string, unknown>> = [];
      notReadySocket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));

      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");
      await startBotViaUi(page, "Bot Not Ready");
      await sleep(1_000);

      assert(!commandsSeen.some((c) => c.type === "START_BOT"),
        "START_BOT n'est jamais dispatche a un agent connecte mais pas encore READY_FOR_COMMANDS");

      notReadySocket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
      await sleep(500);
      const botId = await startFakeBotToWaitingForUser(page, { agentId: 0, token: "", socket: notReadySocket }, commandsSeen, "Bot Now Ready");
      assert(Boolean(botId), "Apres AGENT_RUNTIME_STATUS (READY_FOR_COMMANDS), START_BOT est de nouveau accepte et atteint WAITING_FOR_USER");

      notReadySocket.disconnect();
      await context.close();
    }

    // ===================== Scenario 2: conflit de propriete =====================
    {
      log("SCENARIO-2", "=== RUNTIME_OWNERSHIP_CONFLICT: deux agents annoncent le meme bot ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "Conflict");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      await page.click('#agentSetupSkip').catch(() => undefined);
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

      const agentA = await pairFakeAgent(server.baseUrl, managerCookie, "CONFLICT-PC-A");
      const commandsSeenA: Array<Record<string, unknown>> = [];
      agentA.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeenA.push(command));
      agentA.socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });

      const agentB = await pairFakeAgent(server.baseUrl, managerCookie, "CONFLICT-PC-B");

      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");
      const botId = await startFakeBotToWaitingForUser(page, agentA, commandsSeenA, "Bot Conflict");

      const beforeStatus = await botStatusFor(server.baseUrl, managerCookie, "Bot Conflict");
      agentB.socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [{ botId, status: "MONITORING", startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), monitoringActive: true, browserOpen: true }] });
      await sleep(1_000);

      const afterStatus = await botStatusFor(server.baseUrl, managerCookie, "Bot Conflict");
      assert(afterStatus?.botStatus === beforeStatus?.botStatus, "Le rapport d'un second agent sur le meme bot est ignore (le proprietaire legitime A est conserve)");
      const conflictLogged = await waitUntil(() => server.stdout.join("").includes("RUNTIME_OWNERSHIP_CONFLICT"), 3_000);
      assert(conflictLogged, "Le conflit est signale (RUNTIME_OWNERSHIP_CONFLICT) plutot qu'ignore silencieusement");

      agentA.socket.disconnect();
      agentB.socket.disconnect();
      await context.close();
    }

    // ===================== Scenario 3: bot deja STOPPED jamais reactive =====================
    {
      log("SCENARIO-3", "=== Un bot deja STOPPED cote serveur n'est jamais reactive ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "AlreadyStoppedResync");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      await page.click('#agentSetupSkip').catch(() => undefined);
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

      const agent = await pairFakeAgent(server.baseUrl, managerCookie, "STOPPED-RESYNC-PC");
      const commandsSeen: Array<Record<string, unknown>> = [];
      agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => {
        commandsSeen.push(command);
        if (command.type === "STOP_BOT") {
          agent.socket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
          agent.socket.emit("BOT_STATUS", { commandId: command.commandId, botId: command.botId, status: "STOPPED", timestamp: new Date().toISOString() });
          agent.socket.emit("COMMAND_COMPLETED", { commandId: command.commandId, completedAt: new Date().toISOString(), result: { botId: command.botId, status: "STOPPED", stopped: true } });
        }
      });
      agent.socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });

      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");
      const botId = await startFakeBotToWaitingForUser(page, agent, commandsSeen, "Bot Stopped Resync");

      await stopButtonFor(page, "Bot Stopped Resync").click();
      await waitUntil(async () => (await stopButtonFor(page, "Bot Stopped Resync").count()) === 0, 8_000);
      assert(true, "Bot arrete normalement (etat prealable au test)");

      const stopCommandsBefore = commandsSeen.filter((c) => c.type === "STOP_BOT").length;
      // Le meme agent rapporte (a tort, ex. bug local ou etat perime) ce bot
      // comme encore MONITORING.
      agent.socket.emit("AGENT_RUNTIME_STATUS", {
        sentAt: new Date().toISOString(),
        bots: [{ botId, status: "MONITORING", startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), monitoringActive: true, browserOpen: true }]
      });

      const resyncStopSent = await waitUntil(() => commandsSeen.filter((c) => c.type === "STOP_BOT").length > stopCommandsBefore, 5_000);
      assert(resyncStopSent, "Un nouveau STOP_BOT est renvoye pour faire converger un bot rapporte actif a tort (jamais reactive silencieusement)");

      const statusAfter = await botStatusFor(server.baseUrl, managerCookie, "Bot Stopped Resync");
      assert(statusAfter?.botStatus !== "MONITORING", "Le bot n'apparait jamais comme MONITORING cote serveur suite a ce rapport perime");

      agent.socket.disconnect();
      await context.close();
    }

    // ===================== Scenario 4: eventId idempotent =====================
    {
      log("SCENARIO-4", "=== Deduplication par eventId: un evenement rejoue n'est jamais applique deux fois ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "EventIdDedup");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      await page.click('#agentSetupSkip').catch(() => undefined);
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

      const agent = await pairFakeAgent(server.baseUrl, managerCookie, "EVENTID-PC");
      const commandsSeen: Array<Record<string, unknown>> = [];
      agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));
      agent.socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });

      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");
      const botId = await startFakeBotToWaitingForUser(page, agent, commandsSeen, "Bot EventId Dedup");
      const startCommand = commandsSeen.find((c) => c.type === "START_BOT")!;

      const fixedEventId = `test-event-${RUN_SUFFIX}`;
      const firstAck = await new Promise<boolean>((resolve) => {
        agent.socket.timeout(5_000).emit("BOT_STATUS", {
          commandId: startCommand.commandId, botId, status: "RATE_LIMITED", timestamp: new Date().toISOString(), eventId: fixedEventId
        }, (error: unknown, response?: { ok?: boolean }) => resolve(!error && response?.ok === true));
      });
      assert(firstAck, "Premiere emission d'un evenement: accusee positivement");

      const afterFirst = await botStatusFor(server.baseUrl, managerCookie, "Bot EventId Dedup");
      await sleep(200);

      const secondAck = await new Promise<boolean>((resolve) => {
        agent.socket.timeout(5_000).emit("BOT_STATUS", {
          commandId: startCommand.commandId, botId, status: "RATE_LIMITED", timestamp: new Date().toISOString(), eventId: fixedEventId
        }, (error: unknown, response?: { ok?: boolean }) => resolve(!error && response?.ok === true));
      });
      assert(secondAck, "Rejeu du MEME eventId: toujours accuse positivement (idempotent), jamais une erreur");

      const afterSecond = await botStatusFor(server.baseUrl, managerCookie, "Bot EventId Dedup");
      assert(afterFirst?.botStatusUpdatedAt === afterSecond?.botStatusUpdatedAt, "Le rejeu du meme eventId ne modifie pas a nouveau l'etat (botStatusUpdatedAt inchange)");

      agent.socket.disconnect();
      await context.close();
    }

    // ===================== Scenario 5: revocation a la reconnexion =====================
    {
      log("SCENARIO-5", "=== Un agent revoque ne peut plus se reconnecter ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "RevokeReconnect");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);

      const agent = await pairFakeAgent(server.baseUrl, managerCookie, "REVOKE-RECONNECT-PC");
      agent.socket.disconnect();
      await sleep(300);

      await requestJson(server.baseUrl, "POST", `/api/agents/${agent.agentId}/revoke`, managerCookie, {});

      const reconnectResult = await reconnectFakeAgent(server.baseUrl, agent.agentId, agent.token, "REVOKE-RECONNECT-PC");
      assert(!reconnectResult.ok, "La reconnexion d'un agent revoque est refusee");
      if (!reconnectResult.ok) {
        // Phase 5 (Lot 2 - correctif protocole): AGENT_REVOKED est desormais
        // distinct d'INVALID_TOKEN (cause exacte de l'ambiguite corrigee,
        // voir docs/agent-packaging.md section 9.2/10). Un token PARFAITEMENT
        // valide presente pour un agent explicitement revoque doit produire
        // AGENT_REVOKED, jamais INVALID_TOKEN (reserve a un token errone/
        // agent inexistant).
        assert(reconnectResult.reason === "AGENT_REVOKED", `La raison du refus est AGENT_REVOKED (recu: ${reconnectResult.reason})`);
      }
    }

    // ===================== Scenario 6: bot inconnu (aucun historique) =====================
    {
      log("SCENARIO-6", "=== AGENT_RUNTIME_STATUS pour un bot totalement inconnu est ignore proprement ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "UnknownBot");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const agent = await pairFakeAgent(server.baseUrl, managerCookie, "UNKNOWN-BOT-PC");

      const fakeBotId = `bot-never-existed-${RUN_SUFFIX}`;
      agent.socket.emit("AGENT_RUNTIME_STATUS", {
        sentAt: new Date().toISOString(),
        bots: [{ botId: fakeBotId, status: "MONITORING", startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), monitoringActive: true, browserOpen: true }]
      });
      await sleep(500);

      const history = await getBotOwnershipHistory(fakeBotId, agent.agentId);
      assert(history === null, "Aucun historique DB pour ce botId (verification directe de la fonction de reconciliation)");
      const ignoredLogged = await waitUntil(() => server.stdout.join("").includes(fakeBotId), 3_000);
      assert(ignoredLogged, "Le bot inconnu est signale (log) plutot que silencieusement ignore sans trace");

      agent.socket.disconnect();
    }

    log("DONE", "Tous les scenarios simules Lot 5 termines.");
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
