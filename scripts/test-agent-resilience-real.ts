// Test REEL Lot 5 (resilience): lance le VRAI runtime src/agent/agentMain.ts,
// un VRAI Chrome visible, la fixture locale etendue (jamais TLScontact), PUIS
// tue et redemarre le VRAI process serveur pendant que le bot est MONITORING
// pour verifier la reconnexion reelle, la resynchronisation
// (AGENT_RUNTIME_STATUS) et la reconstruction de l'interface. A executer
// UNIQUEMENT sur un PC Windows personnel avec une session interactive et
// Google Chrome installe — JAMAIS sur la VM/serveur de production.
//
// Pour les scenarios sans Chrome reel (backoff/jitter, buffer, conflits de
// reconciliation, revocation, redaction, extensions), voir
// scripts/test-agent-resilience-simulated.ts — celui-la peut tourner sans
// risque sur la VM.
//
// Usage: npx tsx scripts/test-agent-resilience-real.ts
//    ou: npm run test:agent:resilience:real

import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Browser, Page, chromium } from "playwright";
import { pool } from "../src/db.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
const SERVER_PORT = 3296;

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 15_000, intervalMs = 200): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};

type ServerHandle = { child: ChildProcess; baseUrl: string; stdout: string[] };

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
  return { child, baseUrl, stdout };
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

const loginWithRetry = async (baseUrl: string, loginName: string, password: string, attempts = 8): Promise<string> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await requestJson(baseUrl, "POST", "/api/login", undefined, { login: loginName, password });
    if (result.status === 200 && result.cookie) return result.cookie;
    lastError = new Error(`Login ${loginName} echoue: ${JSON.stringify(result.body)}`);
    await sleep(1_000);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

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

const openBotPage = async (page: Page): Promise<void> => {
  await page.click('[data-page-target="bot"]');
  await page.waitForSelector("#page-bot.active");
};

const startBotViaUi = async (page: Page, botName: string): Promise<void> => {
  await page.fill("#botFormName", botName);
  await page.selectOption("#botFormCategory", { index: 1 });
  await page.fill("#botFormLogin", "x");
  await page.fill("#botFormPassword", "y");
  await page.click("#startBot");
};

const extractAllDebugPorts = (agentStdout: string[]): number[] => {
  const joined = agentStdout.join("");
  const matches = [...joined.matchAll(/Connexion au Chrome deja ouvert: http:\/\/127\.0\.0\.1:(\d+)/g)];
  return matches.map((m) => Number(m[1]));
};

const navigateRealAgentBrowserTo = async (debugPort: number, targetUrl: string): Promise<void> => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  try {
    const context = browser.contexts()[0];
    const pages = context.pages().filter((p) => !p.isClosed() && !p.url().startsWith("devtools://"));
    const targetPage = pages[0] ?? await context.newPage();
    await targetPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
  } finally {
    // Deconnexion passive uniquement, jamais de fermeture du Chrome reel.
  }
};

type RealAgentHandle = { child: ChildProcess; stdout: string[] };

const spawnRealAgent = (
  serverUrl: string,
  code: string,
  credPath: string,
  dataRoot: string,
  computerName: string,
  extraEnv: Record<string, string> = {}
): RealAgentHandle => {
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "src/agent/agentMain.ts", "pair", code], {
    env: {
      ...process.env,
      AGENT_SERVER_URL: serverUrl,
      AGENT_CREDENTIALS_PATH: credPath,
      AGENT_DATA_DIR: dataRoot,
      AGENT_COMPUTER_NAME: computerName,
      AGENT_TARGET_MODE: "fixture",
      AGENT_FIXTURE_URL: "about:blank",
      AGENT_MAX_ACTIVE_BOTS: "5",
      AGENT_RECONNECT_MIN_DELAY_MS: "500",
      AGENT_RECONNECT_MAX_DELAY_MS: "3000",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  const stdout: string[] = [];
  child.stdout?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("REAL-AGENT", t.trim()); });
  child.stderr?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("REAL-AGENT-ERR", t.trim()); });
  return { child, stdout };
};

// Relance l'agent en mode "reconnect" (sans code d'appairage), en reprenant
// les identifiants deja stockes dans credPath par un pairage precedent -
// seul moyen reel de tester le chemin "reconnect" (agentClient.ts) plutot
// que de re-pairer, ce qui testerait un chemin d'authentification different.
const spawnRealAgentReconnect = (
  serverUrl: string,
  credPath: string,
  dataRoot: string,
  computerName: string
): RealAgentHandle => {
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "src/agent/agentMain.ts"], {
    env: {
      ...process.env,
      AGENT_SERVER_URL: serverUrl,
      AGENT_CREDENTIALS_PATH: credPath,
      AGENT_DATA_DIR: dataRoot,
      AGENT_COMPUTER_NAME: computerName,
      AGENT_TARGET_MODE: "fixture",
      AGENT_FIXTURE_URL: "about:blank",
      AGENT_MAX_ACTIVE_BOTS: "5",
      AGENT_RECONNECT_MIN_DELAY_MS: "500",
      AGENT_RECONNECT_MAX_DELAY_MS: "3000"
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  const stdout: string[] = [];
  child.stdout?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("REAL-AGENT", t.trim()); });
  child.stderr?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("REAL-AGENT-ERR", t.trim()); });
  return { child, stdout };
};

// Reconnecte le MEME process agent (deja lance) a un NOUVEAU process
// serveur redemarre sur le meme port: n'existe pas comme fonction separee,
// l'agent gere cela lui-meme via sa boucle de reconnexion manuelle
// (Lot 5) - ce test n'a qu'a attendre.

type ChromeProcInfo = { pid: string; parentPid: string; commandLine: string };

const listChromeProcs = (): Promise<ChromeProcInfo[]> => new Promise((resolve) => {
  if (process.platform !== "win32") { resolve([]); return; }
  const script = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" "
    + "| Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  let output = "";
  child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
  child.on("exit", () => {
    const trimmed = output.trim();
    if (!trimmed) { resolve([]); return; }
    try {
      const parsed = JSON.parse(trimmed);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      resolve(rows.map((row) => ({
        pid: String(row.ProcessId ?? ""),
        parentPid: String(row.ParentProcessId ?? ""),
        commandLine: String(row.CommandLine ?? "")
      })).filter((p) => /^\d+$/.test(p.pid)));
    } catch {
      resolve([]);
    }
  });
  child.on("error", () => resolve([]));
});

const rootPids = (procs: ChromeProcInfo[]): ChromeProcInfo[] => {
  const all = new Set(procs.map((p) => p.pid));
  return procs.filter((p) => !all.has(p.parentPid));
};

const rootPidForDebugPort = (procs: ChromeProcInfo[], debugPort: number): string | null => {
  const match = rootPids(procs).find((p) => p.commandLine.includes(`--remote-debugging-port=${debugPort}`));
  return match?.pid ?? null;
};

const isPidAlive = async (pid: string): Promise<boolean> => {
  const procs = await listChromeProcs();
  return procs.some((p) => p.pid === pid);
};

const waitUntilPidGone = async (pid: string, timeoutMs = 20_000): Promise<boolean> =>
  waitUntil(async () => !(await isPidAlive(pid)), timeoutMs, 300);

const FIXTURE_BASE_URL = pathToFileURL(
  path.resolve(process.cwd(), "scripts/fixtures/fake-appointment-site/appointment.html")
).toString();
const fixtureUrl = (query: string): string => `${FIXTURE_BASE_URL}?${query}`;

const setShortMonitoringSettings = async (baseUrl: string, managerCookie: string, patch: Record<string, number>): Promise<void> => {
  const result = await requestJson(baseUrl, "PATCH", "/api/monitoring-settings", managerCookie, patch);
  if (result.status !== 200) {
    throw new Error(`Impossible de configurer les parametres de surveillance de test: ${JSON.stringify(result.body)}`);
  }
};

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL Lot 5: resilience (reconnexion, buffer, resync, extensions) ===");
  log("BOOT", "A executer sur un PC Windows personnel avec session interactive. JAMAIS sur la VM.");

  let browser: Browser | undefined;
  let server: ServerHandle | undefined;
  let realAgent: RealAgentHandle | undefined;
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  const credPath = path.join(process.cwd(), `.test-resilience-real-creds-${RUN_SUFFIX}.json`);
  const dataRoot = path.join(process.cwd(), `.test-resilience-real-data-${RUN_SUFFIX}`);
  const extRoot = path.join(process.cwd(), `.test-resilience-real-ext-${RUN_SUFFIX}`);

  try {
    browser = await chromium.launch({ headless: true });
    server = await startServer(SERVER_PORT, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });

    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyName = `Test Resilience Real ${RUN_SUFFIX}`;
    agencyNames.push(agencyName);
    const agencyId = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
    const managerLogin = `test-resilience-real-${RUN_SUFFIX}`;
    managerLogins.push(managerLogin);
    const userRes = await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, {
      agencyId, login: managerLogin, name: "Real Resilience Manager", email: `${managerLogin}@example.test`, role: 1
    });
    const managerPassword = userRes.body.temporaryPassword;
    let managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);

    await setShortMonitoringSettings(server.baseUrl, managerCookie, {
      maxParallelScansPerDomain: 2, monthClickMinDelayMs: 500, monthClickMaxDelayMs: 800,
      botCycleCooldownMinMs: 5_000, botCycleCooldownMaxMs: 6_000, refreshEveryCycles: 0, rateLimitCooldownMinutes: 1
    });

    const pairing = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const code = pairing.body.pairing.code;

    realAgent = spawnRealAgent(server.baseUrl, code, credPath, dataRoot, "REAL-RESILIENCE-PC");
    await sleep(2_000);

    let context = await browser.newContext();
    let page = await context.newPage();
    await loginViaUi(page, server.baseUrl, managerLogin, managerPassword);
    await page.click('#agentSetupSkip').catch(() => undefined);
    await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
    await openBotPage(page);

    // ===================== Scenario A: MONITORING actif + arret/redemarrage du serveur =====================
    let debugPortA: number | undefined;
    try {
      log("SCENARIO-A", "=== MONITORING actif, arret reel du serveur, reconnexion et resynchronisation ===");
      await startBotViaUi(page, "Bot Resilience A");
      const reachedWaiting = await waitUntil(async () => (await stopButtonFor(page, "Bot Resilience A").count()) === 1, 20_000);
      if (!reachedWaiting) throw new Error("TimeoutError: le bot n'a jamais atteint WAITING_FOR_USER.");

      debugPortA = extractAllDebugPorts(realAgent.stdout)[0];
      if (!debugPortA) throw new Error("TimeoutError: port de debogage Chrome introuvable.");
      await navigateRealAgentBrowserTo(debugPortA, fixtureUrl("scenario=no-slots"));
      await sleep(500);

      await validateButtonFor(page, "Bot Resilience A").click();
      const reachedMonitoring = await waitUntil(async () => (await rowFor(page, "Bot Resilience A").innerText()).toLowerCase().includes("surveillance active"), 15_000);
      if (!reachedMonitoring) throw new Error("TimeoutError: MONITORING jamais atteint.");
      assert(true, "Scenario A: MONITORING reel atteint avant la coupure");

      const cyclesBeforeOutage = (realAgent.stdout.join("").match(/Surveillance tentative/g) ?? []).length;

      log("SCENARIO-A", "Arret reel du process serveur (simule redemarrage/coupure)...");
      await killTree(server.child.pid);
      await sleep(1_000);

      const sawReconnectAttempt = await waitUntil(
        () => /Reconnexion prevue dans/.test(realAgent!.stdout.join("")), 10_000, 300
      );
      assert(sawReconnectAttempt, "Scenario A: l'agent planifie reellement des tentatives de reconnexion (backoff) pendant la coupure");

      const cyclesDuringOutage = await waitUntil(
        () => (realAgent!.stdout.join("").match(/Surveillance tentative/g) ?? []).length > cyclesBeforeOutage,
        15_000, 500
      );
      assert(cyclesDuringOutage, "Scenario A: la boucle de surveillance locale continue reellement pendant que le serveur est injoignable");

      log("SCENARIO-A", "Redemarrage reel du serveur (meme port, meme base de donnees)...");
      server = await startServer(SERVER_PORT, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });

      const reconnected = await waitUntil(
        () => /Synchronisation terminee/.test(realAgent!.stdout.join("")), 20_000, 500
      );
      assert(reconnected, "Scenario A: l'agent se reconnecte reellement au serveur redemarre et termine sa synchronisation");

      managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);
      await context.close();
      context = await browser.newContext();
      page = await context.newPage();
      await loginViaUi(page, server.baseUrl, managerLogin, managerPassword);
      await page.click('#agentSetupSkip').catch(() => undefined);
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
      await openBotPage(page);

      const reconstructed = await waitUntil(async () => (await stopButtonFor(page, "Bot Resilience A").count()) === 1, 15_000);
      assert(reconstructed, "Scenario A: apres redemarrage serveur, l'interface reconstruit bien le bot avec le bouton Arreter (Map en memoire perdue, reconstruite via AGENT_RUNTIME_STATUS)");
      const stillMonitoringText = await rowFor(page, "Bot Resilience A").innerText();
      assert(stillMonitoringText.toLowerCase().includes("surveillance active"), "Scenario A: le bot reapparait bien comme MONITORING (pas WAITING_FOR_USER ni ERROR)");

      const restCheck = await requestJson(server.baseUrl, "GET", "/api/agent-commands?limit=10", managerCookie);
      const restBot = restCheck.body.commands.find((c: any) => c.botName === "Bot Resilience A");
      assert(restBot?.botStatus === "MONITORING", "Scenario A: GET /api/agent-commands confirme botStatus=MONITORING apres resynchronisation");

      await stopButtonFor(page, "Bot Resilience A").click({ timeout: 5_000 });
      const stoppedA = await waitUntil(async () => (await stopButtonFor(page, "Bot Resilience A").count()) === 0, 15_000);
      if (!stoppedA) throw new Error("TimeoutError: STOP_BOT (scenario A) jamais confirme apres reconnexion.");
      const rootA = rootPidForDebugPort(await listChromeProcs(), debugPortA);
      const closedA = rootA ? await waitUntilPidGone(rootA, 20_000) : true;
      assert(closedA, "Scenario A: Chrome ferme apres STOP_BOT reel post-reconnexion, aucun orphelin");
    } catch (error) {
      assert(false, `Scenario A interrompu (jamais presente comme un succes): ${error instanceof Error ? error.message : String(error)}`);
    }

    // ===================== Scenario B: extension locale valide =====================
    try {
      log("SCENARIO-B", "=== Extension locale valide: Chrome se lance avec elle ===");
      const validExtDir = path.join(extRoot, "valid-ext");
      mkdirSync(validExtDir, { recursive: true });
      writeFileSync(path.join(validExtDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Test Extension Reelle", version: "1.0.0" }));
      const configDir = path.join(dataRoot, "config");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(path.join(configDir, "extensions.json"), JSON.stringify({
        extensions: [{ id: "test-valid-extension", enabled: true, required: false, localPath: validExtDir }]
      }));

      const portsBefore = extractAllDebugPorts(realAgent.stdout).length;
      await startBotViaUi(page, "Bot Extension Valid");
      const reachedWaitingB = await waitUntil(async () => (await stopButtonFor(page, "Bot Extension Valid").count()) === 1, 20_000);
      if (!reachedWaitingB) throw new Error("TimeoutError: le bot n'a jamais atteint WAITING_FOR_USER (extension valide).");
      assert(true, "Scenario B: START_BOT reussit avec une extension locale valide (optionnelle), Chrome s'ouvre normalement");

      const gotPortB = await waitUntil(() => extractAllDebugPorts(realAgent!.stdout).length > portsBefore, 5_000);
      const debugPortB = gotPortB ? extractAllDebugPorts(realAgent.stdout)[portsBefore] : undefined;

      await stopButtonFor(page, "Bot Extension Valid").click({ timeout: 5_000 });
      await waitUntil(async () => (await stopButtonFor(page, "Bot Extension Valid").count()) === 0, 15_000);
      const rootB = debugPortB ? rootPidForDebugPort(await listChromeProcs(), debugPortB) : null;
      const closedB = rootB ? await waitUntilPidGone(rootB, 20_000) : true;
      assert(closedB, "Scenario B: Chrome ferme normalement apres STOP_BOT");
    } catch (error) {
      assert(false, `Scenario B interrompu (jamais presente comme un succes): ${error instanceof Error ? error.message : String(error)}`);
    }

    // ===================== Scenario C: extension "required" absente =====================
    try {
      log("SCENARIO-C", "=== Extension obligatoire absente: START_BOT echoue proprement, aucun Chrome ===");
      const configDir = path.join(dataRoot, "config");
      writeFileSync(path.join(configDir, "extensions.json"), JSON.stringify({
        extensions: [{ id: "missing-required-extension", enabled: true, required: true, localPath: path.join(extRoot, "does-not-exist") }]
      }));

      const chromeBefore = await listChromeProcs();
      await startBotViaUi(page, "Bot Extension Required Missing");

      const failed = await waitUntil(async () =>
        (await rowFor(page, "Bot Extension Required Missing").innerText()).toLowerCase().includes("extension"), 15_000);
      if (!failed) throw new Error("TimeoutError: START_BOT n'a jamais echoue avec un message lie a l'extension manquante.");
      assert(true, "Scenario C: START_BOT echoue avec un message mentionnant l'extension manquante");
      // Note: le botStatus final est ERROR, et ERROR affiche un bouton
      // Arreter par choix deliberer (Lot 4, section 14: un REFRESH_FAILED
      // en cours de MONITORING laisse reellement Chrome ouvert et doit
      // rester arretable). Ce bot-ci n'a jamais existe cote agent
      // (this.bots ne l'a jamais contenu, l'echec survient avant tout
      // acquireProfileLock/launchChromeForBot): cliquer Arreter resterait
      // sans danger (STOP_BOT sur un botId inconnu de l'agent est deja
      // idempotent, Lot 2), seul le comportement reellement critique -
      // aucun Chrome lance - est verifie ci-dessous.

      await sleep(1_000);
      const chromeAfter = await listChromeProcs();
      assert(rootPids(chromeAfter).length <= rootPids(chromeBefore).length, "Scenario C: aucun nouveau processus Chrome racine n'a ete lance");

      // Nettoyage: retire la config d'extension pour ne pas affecter la suite.
      rmSync(path.join(configDir, "extensions.json"), { force: true });
    } catch (error) {
      assert(false, `Scenario C interrompu (jamais presente comme un succes): ${error instanceof Error ? error.message : String(error)}`);
    }

    // ===================== Scenario D: revocation pendant une coupure =====================
    try {
      log("SCENARIO-D", "=== Revocation pendant une coupure: reconnexion refusee, pas de reprise ===");
      await killTree(realAgent.child.pid);
      await sleep(1_000);

      const agentsList = await requestJson(server.baseUrl, "GET", "/api/agents", managerCookie);
      const agentEntry = agentsList.body.agents.find((a: any) => a.computerName === "REAL-RESILIENCE-PC");
      if (!agentEntry) throw new Error("Agent REAL-RESILIENCE-PC introuvable pour la revocation.");
      await requestJson(server.baseUrl, "POST", `/api/agents/${agentEntry.agentId}/revoke`, managerCookie, {});

      // Reprend les identifiants DEJA stockes (credPath) en mode "reconnect"
      // reel: c'est le seul moyen de tester le chemin reconnect+revoque
      // (re-pairer testerait un chemin d'authentification different).
      const revokedAgent = spawnRealAgentReconnect(server.baseUrl, credPath, dataRoot, "REAL-RESILIENCE-PC");
      const sawPermanentFailure = await waitUntil(
        () => /Echec definitif d'authentification/.test(revokedAgent.stdout.join("")), 10_000, 300
      );
      assert(sawPermanentFailure, "Scenario D: l'agent detecte reellement la revocation et arrete ses tentatives (pas de boucle infinie)");
      await killTree(revokedAgent.child.pid);
    } catch (error) {
      assert(false, `Scenario D interrompu (jamais presente comme un succes): ${error instanceof Error ? error.message : String(error)}`);
    }

    await context.close();
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    await killTree(realAgent?.child.pid).catch(() => undefined);
    if (server) {
      await killTree(server.child.pid).catch(() => undefined);
    }
    for (const p of [credPath]) {
      if (existsSync(p)) { try { rmSync(p); } catch { /* best effort */ } }
    }
    for (const d of [dataRoot, extRoot]) {
      if (existsSync(d)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
    try {
      if (managerLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [managerLogins]);
      if (agencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [agencyNames]);
    } catch (error) {
      log("CLEANUP-ERR", `Nettoyage base de donnees incomplet: ${error instanceof Error ? error.message : String(error)}`);
    }
    await pool.end().catch(() => undefined);
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exit(failCount > 0 ? 1 : 0);
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
