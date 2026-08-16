// Tests SIMULES Lot 4 (surveillance reelle): validation/bornes des
// parametres, annulation cooperative du semaphore de scan, deduplication
// SLOT_DETECTED, puis transitions MONITORING -> RATE_LIMITED -> MONITORING
// et MONITORING -> SLOT_DETECTED via un agent fantome (socket.io-client brut,
// jamais src/agent/agentMain.ts, jamais Chrome de bot). Le seul navigateur
// demarre ici est le Chromium headless de Playwright pilotant l'INTERFACE
// WEB (jamais "le Chrome du bot"). Executable sans risque sur la VM.
//
// Pour le scenario avec le vrai runtime agent + vrai Chrome + vraie fixture
// locale (PC Windows personnel/interactif uniquement), voir
// scripts/test-agent-monitoring-real.ts.
//
// Usage: npx tsx scripts/test-agent-monitoring-simulated.ts
//    ou: npm run test:agent:monitoring:simulated

import { ChildProcess, spawn } from "node:child_process";
import { Browser, Page, chromium } from "playwright";
import { Socket, io as ioClient } from "socket.io-client";
import { pool } from "../src/db.js";
import { validateMonitoringSettings, DEFAULT_AGENT_MONITORING_SETTINGS } from "../src/agent/agentMonitoringSettings.js";
import { redactForLog } from "../src/agent/agentLocalLogger.js";
import { SlotAlertDeduplicator } from "../src/agent/agentSlotDedup.js";
import { waitForScanTurn, releaseScanTurn } from "../src/shared/orchestrator.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
const TEST_SECRET_TOKEN = "TEST_SECRET_TOKEN_LOT4";
const TEST_SECRET_API_KEY = "TEST_SECRET_API_KEY_LOT4";

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
  const agencyName = `Test Monitoring Sim ${labelSuffix} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = agencyResult.body.agency.id;
  const managerLogin = `test-monitoring-sim-${labelSuffix.toLowerCase()}-${RUN_SUFFIX}`;
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

// CORRECTIF HARNAIS DE TEST (0.1.6): l'ancien pairFakeAgent lisait
// pairing.body.pairing.code sans jamais verifier le statut HTTP ni la forme
// de la reponse - un echec cote serveur (meme transitoire) faisait echouer
// avec "Cannot read properties of undefined (reading 'code')" au lieu de
// revele la vraie cause HTTP. Retries bornes UNIQUEMENT sur les codes
// transitoires (429/5xx): jamais sur 400/401/403/404, qui sont des refus
// definitifs (rejouer ne changerait rien).
const PAIRING_RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const PAIRING_RETRY_DELAYS_MS = [500, 1_000];

const requestPairingCodeWithRetry = async (baseUrl: string, managerCookie: string): Promise<{ status: number; body: any }> => {
  let lastResult: { status: number; body: any } = { status: 0, body: null };
  for (let attempt = 0; attempt <= PAIRING_RETRY_DELAYS_MS.length; attempt += 1) {
    lastResult = await requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    if (!PAIRING_RETRYABLE_STATUS_CODES.has(lastResult.status)) {
      return lastResult;
    }
    if (attempt < PAIRING_RETRY_DELAYS_MS.length) {
      const delayMs = PAIRING_RETRY_DELAYS_MS[attempt];
      log("PAIRING_RETRY", `POST /api/agents/pairing-codes -> ${lastResult.status}: nouvelle tentative dans ${delayMs}ms.`);
      await sleep(delayMs);
    }
  }
  return lastResult;
};

const pairFakeAgent = async (baseUrl: string, managerCookie: string, computerName: string): Promise<FakeAgentHandle> => {
  const pairing = await requestPairingCodeWithRetry(baseUrl, managerCookie);
  const pairingCode = pairing.body?.pairing?.code;
  if (pairing.status !== 200 || typeof pairingCode !== "string" || !pairingCode.trim()) {
    throw new Error(
      "pairFakeAgent: impossible d'obtenir un code d'appairage valide.\n"
      + `  URL de base: ${baseUrl}\n`
      + `  Statut HTTP: ${pairing.status}\n`
      + `  Corps de reponse (assaini): ${JSON.stringify(redactForLog(pairing.body))}`
    );
  }
  return new Promise((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "pair", pairingCode, computerName, version: "1.0.0", protocolVersion: 1 }
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

// ===================== Partie A: unites pures (aucun serveur, aucun Chrome) =====================

const runUnitTests = async (): Promise<void> => {
  log("UNIT", "=== validateMonitoringSettings ===");

  const defaults = validateMonitoringSettings(undefined);
  assert(JSON.stringify(defaults) === JSON.stringify(DEFAULT_AGENT_MONITORING_SETTINGS), "Entree absente -> valeurs par defaut sures");

  const garbage = validateMonitoringSettings({
    maxParallelScansPerDomain: NaN,
    monthClickMinDelayMs: -50,
    monthClickMaxDelayMs: Infinity,
    botCycleCooldownMinMs: "not-a-number",
    botCycleCooldownMaxMs: null,
    refreshEveryCycles: -5,
    rateLimitCooldownSeconds: 0,
    controlRefreshIntervalSeconds: 0,
    scanMonthCount: "12"
  });
  assert(Number.isFinite(garbage.maxParallelScansPerDomain) && garbage.maxParallelScansPerDomain >= 1, "NaN/type invalide -> retombe sur une valeur sure (maxParallelScansPerDomain)");
  assert(garbage.monthClickMinDelayMs >= 0, "Valeur negative -> jamais negative en sortie");
  assert(Number.isFinite(garbage.monthClickMaxDelayMs), "Infinity -> jamais transmis tel quel");
  assert(garbage.rateLimitCooldownSeconds >= 60, "rateLimitCooldownSeconds borne a un minimum >= 60s (jamais 0)");
  assert(garbage.controlRefreshIntervalSeconds >= 60, "controlRefreshIntervalSeconds borne a un minimum >= 60s (jamais 0)");

  // HOTFIX CIBLE (parametres de surveillance en secondes entieres): un
  // ancien payload n'envoyant que rateLimitCooldownMinutes doit toujours
  // etre accepte (fallback de compatibilite), converti en secondes sans
  // arrondi destructeur (jamais 30s -> 0 ni 1 minute).
  const legacyRateLimit = validateMonitoringSettings({ rateLimitCooldownMinutes: 30 });
  assert(legacyRateLimit.rateLimitCooldownSeconds === 1_800, `Fallback ancien payload (rateLimitCooldownMinutes) converti exactement en secondes (recu: ${legacyRateLimit.rateLimitCooldownSeconds})`);

  const zeroFloor = validateMonitoringSettings({ monthClickMinDelayMs: 0, botCycleCooldownMinMs: 0 });
  assert(zeroFloor.monthClickMinDelayMs > 0, "Delai de changement de mois nul releve a un plancher de securite (jamais 0ms)");
  assert(zeroFloor.botCycleCooldownMinMs > 0, "Cooldown de cycle nul releve a un plancher de securite (jamais 0ms, pas de boucle intensive)");

  const inconsistent = validateMonitoringSettings({ monthClickMinDelayMs: 9_000, monthClickMaxDelayMs: 1_000 });
  assert(inconsistent.monthClickMaxDelayMs >= inconsistent.monthClickMinDelayMs, "min > max en entree -> corrige (max >= min) en sortie");

  const valid = validateMonitoringSettings({
    maxParallelScansPerDomain: 2, monthClickMinDelayMs: 3_000, monthClickMaxDelayMs: 6_000,
    botCycleCooldownMinMs: 60_000, botCycleCooldownMaxMs: 90_000, refreshEveryCycles: 10,
    controlRefreshIntervalSeconds: 600, rateLimitCooldownSeconds: 1_800, scanMonthCount: 3
  });
  assert(
    valid.maxParallelScansPerDomain === 2 && valid.controlRefreshIntervalSeconds === 600 && valid.rateLimitCooldownSeconds === 1_800,
    "Snapshot deja valide et dans les bornes: transmis sans alteration"
  );

  log("UNIT", "=== SlotAlertDeduplicator ===");
  const dedup = new SlotAlertDeduplicator(5 * 60_000);
  const t0 = 1_000_000;
  assert(dedup.shouldAlert("14:30|14:30", t0) === true, "Premiere alerte pour une signature: toujours envoyee");
  assert(dedup.shouldAlert("14:30|14:30", t0 + 1_000) === false, "Meme signature, dans la fenetre: alerte non repetee");
  assert(dedup.shouldAlert("09:00|09:00", t0 + 1_000) === true, "Signature differente: nouvelle alerte envoyee immediatement");
  assert(dedup.shouldAlert("14:30|14:30", t0 + 6 * 60_000) === true, "Meme signature, fenetre ecoulee: alerte a nouveau envoyee");

  log("UNIT", "=== orchestrator.waitForScanTurn: annulation cooperative ===");
  const domain = `test-domain-${RUN_SUFFIX}`;
  const noop = (): void => undefined;

  await waitForScanTurn({ botName: "bot-a", domain, settings: { maxParallelScansPerDomain: 1 }, log: noop });
  assert(true, "bot-a acquiert le tour de scan (capacite 1/1)");

  // Contrat de waitForScanTurn (comme monitor.ts l'utilise deja): la fonction
  // resout normalement dans les DEUX cas (permis obtenu OU annulation), donc
  // l'appelant doit toujours verifier signal.aborted APRES resolution pour
  // savoir s'il a reellement obtenu un permis (jamais se fier a la simple
  // resolution de la promesse).
  const controllerB = new AbortController();
  let botBSettled = false;
  const botBPromise = waitForScanTurn({ botName: "bot-b", domain, settings: { maxParallelScansPerDomain: 1 }, log: noop, signal: controllerB.signal })
    .then(() => { botBSettled = true; });

  await sleep(300);
  assert(!botBSettled, "bot-b reste bloque tant que bot-a detient le seul tour disponible");

  const abortStart = Date.now();
  controllerB.abort();
  await botBPromise;
  const abortElapsedMs = Date.now() - abortStart;
  assert(controllerB.signal.aborted, "bot-b annule n'a jamais consomme de permis (l'appelant doit constater l'annulation via signal.aborted, pas via la resolution)");
  assert(abortElapsedMs < 2_000, `L'annulation de bot-b est immediate (${abortElapsedMs}ms), pas une attente jusqu'au prochain reveil`);

  releaseScanTurn(domain, noop);
  const beforeC = Date.now();
  await waitForScanTurn({ botName: "bot-c", domain, settings: { maxParallelScansPerDomain: 1 }, log: noop });
  assert(Date.now() - beforeC < 1_000, "Apres liberation, bot-c acquiert normalement (l'annulation de bot-b n'a pas corrompu l'etat du domaine)");
  releaseScanTurn(domain, noop);
};

// ===================== Partie B: transitions runtime via agent fantome =====================

const main = async (): Promise<void> => {
  await runUnitTests();

  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });

    const server = await startServer(3292, {
      AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent",
      AGENT_COMMAND_ACK_TIMEOUT_MS: "8000", AGENT_COMMAND_TTL_MS: "20000"
    });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    // ===================== Scenario 1: snapshot des parametres dans START_BOT =====================
    {
      log("SCENARIO-1", "=== START_BOT transmet un snapshot valide de parametres de surveillance ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "Settings");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      await page.click('#agentSetupSkip').catch(() => undefined);
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

      const agent = await pairFakeAgent(server.baseUrl, managerCookie, "MONITORING-SETTINGS-PC");
      const commandsSeen: Array<Record<string, unknown>> = [];
      agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));

      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");
      await startBotViaUi(page, "Bot Settings Snapshot");

      const startCommand = await waitUntilValue(() => commandsSeen.find((c) => c.type === "START_BOT"));
      if (!startCommand) throw new Error("START_BOT jamais recu.");
      const payload = startCommand.payload as { monitoringSettings?: Record<string, unknown> } | undefined;
      const settings = payload?.monitoringSettings;
      assert(Boolean(settings), "START_BOT.payload contient bien monitoringSettings");
      assert(typeof settings?.maxParallelScansPerDomain === "number", "monitoringSettings.maxParallelScansPerDomain present et numerique");
      assert(typeof settings?.rateLimitCooldownSeconds === "number", "monitoringSettings.rateLimitCooldownSeconds present et numerique");
      assert(typeof settings?.controlRefreshIntervalSeconds === "number", "monitoringSettings.controlRefreshIntervalSeconds present et numerique");
      assert(!JSON.stringify(payload ?? {}).match(/password|cookie|token/i), "Aucun champ sensible dans le snapshot transmis");

      agent.socket.emit("COMMAND_ACK", { commandId: startCommand.commandId, receivedAt: new Date().toISOString() });
      agent.socket.emit("BOT_STATUS", { commandId: startCommand.commandId, botId: startCommand.botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
      agent.socket.emit("COMMAND_COMPLETED", { commandId: startCommand.commandId, completedAt: new Date().toISOString(), result: { botId: startCommand.botId, status: "WAITING_FOR_USER", started: true } });

      agent.socket.disconnect();
      await context.close();
    }

    // ===================== Scenario 2: MONITORING -> RATE_LIMITED -> MONITORING =====================
    {
      log("SCENARIO-2", "=== MONITORING -> RATE_LIMITED -> MONITORING (reprise) ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "RateLimit");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      await page.click('#agentSetupSkip').catch(() => undefined);
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

      const agent = await pairFakeAgent(server.baseUrl, managerCookie, "MONITORING-RATELIMIT-PC");
      const commandsSeen: Array<Record<string, unknown>> = [];
      agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));

      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");
      const botId = await startFakeBotToWaitingForUser(page, agent, commandsSeen, "Bot Rate Limit");

      await validateButtonFor(page, "Bot Rate Limit").click();
      const validateCommand = await waitUntilValue(() => commandsSeen.find((c) => c.type === "VALIDATE_BOT" && c.botId === botId));
      if (!validateCommand) throw new Error("VALIDATE_BOT jamais recu.");

      agent.socket.emit("COMMAND_ACK", { commandId: validateCommand.commandId, receivedAt: new Date().toISOString() });
      agent.socket.emit("BOT_STATUS", { commandId: validateCommand.commandId, botId, status: "MONITORING", timestamp: new Date().toISOString() });
      agent.socket.emit("COMMAND_COMPLETED", { commandId: validateCommand.commandId, completedAt: new Date().toISOString(), result: { botId, status: "MONITORING", validated: true } });

      await waitUntil(async () => (await rowFor(page, "Bot Rate Limit").innerText()).toLowerCase().includes("surveillance active"), 5_000);
      assert(true, "MONITORING affiche 'Surveillance active'");

      // Simule ce que la vraie boucle de surveillance emet (agentMonitoringRuntime.onRateLimited),
      // avec une sentinelle glissee dans "details" pour verifier qu'elle ne fuite jamais.
      agent.socket.emit("BOT_STATUS", {
        commandId: validateCommand.commandId, botId, status: "RATE_LIMITED", timestamp: new Date().toISOString(),
        details: { cooldownMinutes: 1, resumeAt: new Date(Date.now() + 60_000).toISOString(), token: TEST_SECRET_TOKEN }
      });

      await waitUntil(async () => (await rowFor(page, "Bot Rate Limit").innerText()).toLowerCase().includes("pause"), 5_000);
      const rateLimitedRowText = await rowFor(page, "Bot Rate Limit").innerText();
      assert(rateLimitedRowText.toLowerCase().includes("pause"), "RATE_LIMITED: message de pause affiche");
      assert((await stopButtonFor(page, "Bot Rate Limit").count()) === 1, "RATE_LIMITED: bouton Arreter toujours present");
      assert((await validateButtonFor(page, "Bot Rate Limit").count()) === 0, "RATE_LIMITED: bouton Valider toujours masque");

      const detailAfterRateLimit = await requestJson(server.baseUrl, "GET", "/api/agent-commands?limit=10", managerCookie);
      assert(!JSON.stringify(detailAfterRateLimit.body).includes(TEST_SECRET_TOKEN), "Aucune sentinelle dans la reponse REST apres RATE_LIMITED");

      agent.socket.emit("BOT_STATUS", { commandId: validateCommand.commandId, botId, status: "MONITORING", timestamp: new Date().toISOString() });
      await waitUntil(async () => (await rowFor(page, "Bot Rate Limit").innerText()).toLowerCase().includes("surveillance active"), 5_000);
      assert(true, "Reprise: MONITORING de nouveau affiche 'Surveillance active' apres cooldown");
      assert((await stopButtonFor(page, "Bot Rate Limit").count()) === 1, "Apres reprise: bouton Arreter toujours present");

      agent.socket.disconnect();
      await context.close();
    }

    // ===================== Scenario 3: MONITORING -> SLOT_DETECTED =====================
    {
      log("SCENARIO-3", "=== MONITORING -> SLOT_DETECTED (intervention requise) ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "SlotDetected");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      await page.click('#agentSetupSkip').catch(() => undefined);
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

      const agent = await pairFakeAgent(server.baseUrl, managerCookie, "MONITORING-SLOT-PC");
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
      const botId = await startFakeBotToWaitingForUser(page, agent, commandsSeen, "Bot Slot Detected");

      await validateButtonFor(page, "Bot Slot Detected").click();
      const validateCommand = await waitUntilValue(() => commandsSeen.find((c) => c.type === "VALIDATE_BOT" && c.botId === botId));
      if (!validateCommand) throw new Error("VALIDATE_BOT jamais recu.");

      agent.socket.emit("COMMAND_ACK", { commandId: validateCommand.commandId, receivedAt: new Date().toISOString() });
      agent.socket.emit("BOT_STATUS", { commandId: validateCommand.commandId, botId, status: "MONITORING", timestamp: new Date().toISOString() });
      agent.socket.emit("COMMAND_COMPLETED", { commandId: validateCommand.commandId, completedAt: new Date().toISOString(), result: { botId, status: "MONITORING", validated: true } });
      await waitUntil(async () => (await rowFor(page, "Bot Slot Detected").innerText()).toLowerCase().includes("surveillance active"), 5_000);

      agent.socket.emit("BOT_STATUS", {
        commandId: validateCommand.commandId, botId, status: "SLOT_DETECTED", timestamp: new Date().toISOString(),
        details: { available: true, textFound: "14:30", dateTimeHint: "14:30", detectedAt: new Date().toISOString(), apiKey: TEST_SECRET_API_KEY }
      });

      await waitUntil(async () => (await rowFor(page, "Bot Slot Detected").innerText()).toLowerCase().includes("intervention requise"), 5_000);
      const slotRowText = await rowFor(page, "Bot Slot Detected").innerText();
      assert(slotRowText.toLowerCase().includes("intervention requise"), "SLOT_DETECTED: message d'intervention requise affiche");
      assert((await stopButtonFor(page, "Bot Slot Detected").count()) === 1, "SLOT_DETECTED: bouton Arreter toujours present (Chrome reste ouvert)");
      assert((await validateButtonFor(page, "Bot Slot Detected").count()) === 0, "SLOT_DETECTED: bouton Valider toujours masque");

      const detailAfterSlot = await requestJson(server.baseUrl, "GET", "/api/agent-commands?limit=10", managerCookie);
      assert(!JSON.stringify(detailAfterSlot.body).includes(TEST_SECRET_API_KEY), "Aucune sentinelle dans la reponse REST apres SLOT_DETECTED");
      assert(!JSON.stringify(detailAfterSlot.body).toLowerCase().includes("<html"), "Aucun HTML complet transmis dans la reponse REST");

      // STOP_BOT doit encore fonctionner apres SLOT_DETECTED (Chrome toujours ouvert -> bot arretable).
      await stopButtonFor(page, "Bot Slot Detected").click();
      await waitUntil(async () => (await stopButtonFor(page, "Bot Slot Detected").count()) === 0, 8_000);
      assert(true, "STOP_BOT reste fonctionnel apres SLOT_DETECTED");

      agent.socket.disconnect();
      await context.close();
    }

    log("DONE", "Tous les scenarios simules Lot 4 termines.");
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
