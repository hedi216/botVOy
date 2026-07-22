// Test REEL Lot 4 (surveillance reelle): lance le VRAI runtime
// src/agent/agentMain.ts, ouvre un VRAI Chrome visible sur CETTE machine,
// navigue reellement vers la fixture locale etendue (jamais TLScontact),
// valide reellement le bot puis verifie que monitorAppointments() tourne
// reellement (plusieurs cycles, changement d'etat MONITORING/RATE_LIMITED/
// SLOT_DETECTED, refresh, isolation de deux bots, fermeture manuelle de
// Chrome). A executer UNIQUEMENT sur un PC Windows personnel avec une
// session interactive et Google Chrome installe — JAMAIS sur la VM/serveur
// de production.
//
// Pour les scenarios sans Chrome reel (validation des parametres, semaphore
// annulable, deduplication SLOT_DETECTED, transitions via agent fantome),
// voir scripts/test-agent-monitoring-simulated.ts — celui-la peut tourner
// sans risque sur la VM.
//
// Usage: npx tsx scripts/test-agent-monitoring-real.ts
//    ou: npm run test:agent:monitoring:real

import { ChildProcess, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Browser, Page, chromium } from "playwright";
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

// Jamais un succes silencieux sur un depassement de delai (meme regle que
// test-agent-validate-real.ts): toute etape critique passe par ce helper.
const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 15_000, intervalMs = 200): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};

type ServerHandle = { child: ChildProcess; baseUrl: string };

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

const loginWithRetry = async (baseUrl: string, loginName: string, password: string, attempts = 5): Promise<string> => {
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

const startBotViaUi = async (page: Page, botName: string): Promise<void> => {
  await page.fill("#botFormName", botName);
  await page.selectOption("#botFormCategory", { index: 1 });
  await page.fill("#botFormLogin", "x");
  await page.fill("#botFormPassword", "y");
  await page.click("#startBot");
};

const botStatusFor = async (baseUrl: string, cookie: string, botName: string): Promise<string | null> => {
  const result = await requestJson(baseUrl, "GET", "/api/agent-commands?limit=20", cookie);
  const command = result.body?.commands?.find((c: any) => c.botName === botName);
  return command?.botStatus ?? null;
};

// Extrait TOUS les ports CDP (un par START_BOT reel, dans l'ordre
// d'apparition) depuis les logs stdout de l'agent, pour differencier
// plusieurs bots actifs simultanement (scenario E/F).
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
    // Pas de browser.close(): deconnexion passive uniquement (meme regle que
    // test-agent-validate-real.ts), jamais de fermeture du Chrome reel
    // partage avec l'agent.
  }
};

type RealAgentHandle = { child: ChildProcess; stdout: string[] };

const spawnRealAgent = (baseUrl: string, code: string, credPath: string, dataRoot: string, computerName: string, maxActiveBots = 5): RealAgentHandle => {
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "src/agent/agentMain.ts", "pair", code], {
    env: {
      ...process.env,
      AGENT_SERVER_URL: baseUrl,
      AGENT_CREDENTIALS_PATH: credPath,
      AGENT_DATA_DIR: dataRoot,
      AGENT_COMPUTER_NAME: computerName,
      AGENT_TARGET_MODE: "fixture",
      AGENT_FIXTURE_URL: "about:blank",
      AGENT_MAX_ACTIVE_BOTS: String(maxActiveBots)
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  const stdout: string[] = [];
  child.stdout?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("REAL-AGENT", t.trim()); });
  child.stderr?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("REAL-AGENT-ERR", t.trim()); });
  return { child, stdout };
};

type ChromeProcInfo = { pid: string; parentPid: string; commandLine: string };

// PowerShell + Get-CimInstance + ConvertTo-Json plutot que
// "wmic ... /format:csv": ce dernier reordonne les colonnes alphabetiquement
// ET peut emettre un encodage different (observe: sortie corrompue) des que
// zero ligne ou une locale non-anglaise est en jeu. PowerShell/JSON evite ces
// deux pieges et gere nativement les CommandLine longues (jamais tronquees/
// re-encapsulees comme en mode tableau wmic).
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

const waitUntilPidGone = async (pid: string, timeoutMs = 8_000): Promise<boolean> =>
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

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL Lot 4: surveillance reelle avec vrai agent + vrai Chrome + fixture locale ===");
  log("BOOT", "A executer sur un PC Windows personnel avec session interactive. JAMAIS sur la VM.");

  let browser: Browser | undefined;
  let server: ServerHandle | undefined;
  let realAgent: RealAgentHandle | undefined;
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  const credPath = path.join(process.cwd(), `.test-monitoring-real-creds-${RUN_SUFFIX}.json`);
  const dataRoot = path.join(process.cwd(), `.test-monitoring-real-data-${RUN_SUFFIX}`);

  try {
    browser = await chromium.launch({ headless: true });
    server = await startServer(3294, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });

    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyName = `Test Monitoring Real ${RUN_SUFFIX}`;
    agencyNames.push(agencyName);
    const agencyId = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
    const managerLogin = `test-monitoring-real-${RUN_SUFFIX}`;
    managerLogins.push(managerLogin);
    const userRes = await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, {
      agencyId, login: managerLogin, name: "Real Monitoring Manager", email: `${managerLogin}@example.test`, role: 1
    });
    const managerPassword = userRes.body.temporaryPassword;
    const managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);

    // Parametres courts mais SURS (>= planchers de securite agent) pour que
    // le test s'execute en quelques dizaines de secondes plutot qu'en
    // heures, sans jamais produire de boucle intensive.
    await setShortMonitoringSettings(server.baseUrl, managerCookie, {
      maxParallelScansPerDomain: 2,
      monthClickMinDelayMs: 500,
      monthClickMaxDelayMs: 800,
      botCycleCooldownMinMs: 5_000,
      botCycleCooldownMaxMs: 6_000,
      refreshEveryCycles: 0,
      rateLimitCooldownMinutes: 1
    });

    const pairing = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const code = pairing.body.pairing.code;

    realAgent = spawnRealAgent(server.baseUrl, code, credPath, dataRoot, "REAL-MONITORING-PC");
    await sleep(2_000);

    const context = await browser.newContext();
    const page = await context.newPage();
    await loginViaUi(page, server.baseUrl, managerLogin, managerPassword);
    await page.click('#agentSetupSkip').catch(() => undefined);
    await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
    await page.click('[data-page-target="bot"]');
    await page.waitForSelector("#page-bot.active");

    // ===================== Scenario A: aucun creneau, plusieurs cycles =====================
    try {
      log("SCENARIO-A", "=== Aucun creneau: plusieurs cycles reels ===");
      await startBotViaUi(page, "Bot Monitoring NoSlots");
      const reachedWaiting = await waitUntil(async () => (await stopButtonFor(page, "Bot Monitoring NoSlots").count()) === 1, 20_000);
      if (!reachedWaiting) throw new Error("TimeoutError: le bot n'a jamais atteint WAITING_FOR_USER.");

      const ports = await waitUntil(() => extractAllDebugPorts(realAgent!.stdout).length >= 1, 5_000)
        ? extractAllDebugPorts(realAgent.stdout)
        : [];
      const debugPortA = ports[0];
      if (!debugPortA) throw new Error("TimeoutError: port de debogage Chrome introuvable.");

      await navigateRealAgentBrowserTo(debugPortA, fixtureUrl("scenario=no-slots"));
      await sleep(500);

      await validateButtonFor(page, "Bot Monitoring NoSlots").click();
      const reachedMonitoring = await waitUntil(async () =>
        (await rowFor(page, "Bot Monitoring NoSlots").innerText()).toLowerCase().includes("surveillance active"), 15_000);
      if (!reachedMonitoring) throw new Error("TimeoutError: MONITORING jamais atteint (page fixture non reconnue?).");
      assert(true, "Scenario A: MONITORING reel atteint");

      const cyclesBefore = countOccurrences(realAgent.stdout.join(""), "Surveillance tentative");
      const sawTwoCycles = await waitUntil(
        () => countOccurrences(realAgent!.stdout.join(""), "Surveillance tentative") >= cyclesBefore + 2,
        30_000, 500
      );
      if (!sawTwoCycles) throw new Error("TimeoutError: la boucle de surveillance n'a jamais execute au moins 2 cycles.");
      assert(true, "Scenario A: au moins 2 cycles de surveillance reellement executes");
      assert((await botStatusFor(server.baseUrl, managerCookie, "Bot Monitoring NoSlots")) === "MONITORING", "Scenario A: botStatus reste MONITORING pendant les cycles");

      await stopButtonFor(page, "Bot Monitoring NoSlots").click({ timeout: 5_000 });
      const stoppedA = await waitUntil(async () => (await stopButtonFor(page, "Bot Monitoring NoSlots").count()) === 0, 15_000);
      if (!stoppedA) throw new Error("TimeoutError: STOP_BOT (scenario A) jamais confirme.");
      const rootA = rootPidForDebugPort(await listChromeProcs(), debugPortA);
      const closedA = rootA ? await waitUntilPidGone(rootA, 20_000) : true;
      assert(closedA, "Scenario A: Chrome ferme apres STOP_BOT, aucun orphelin");
    } catch (error) {
      assert(false, `Scenario A interrompu (jamais presente comme un succes): ${error instanceof Error ? error.message : String(error)}`);
    }

    // ===================== Scenario B: creneau disponible =====================
    try {
      log("SCENARIO-B", "=== Creneau disponible: SLOT_DETECTED, Chrome reste ouvert ===");
      const portsBefore = extractAllDebugPorts(realAgent.stdout).length;
      await startBotViaUi(page, "Bot Monitoring Slot");
      const reachedWaiting = await waitUntil(async () => (await stopButtonFor(page, "Bot Monitoring Slot").count()) === 1, 20_000);
      if (!reachedWaiting) throw new Error("TimeoutError: le bot n'a jamais atteint WAITING_FOR_USER.");

      const gotPort = await waitUntil(() => extractAllDebugPorts(realAgent!.stdout).length > portsBefore, 5_000);
      if (!gotPort) throw new Error("TimeoutError: port de debogage Chrome introuvable (bot B).");
      const debugPortB = extractAllDebugPorts(realAgent.stdout)[portsBefore];

      await navigateRealAgentBrowserTo(debugPortB, fixtureUrl("scenario=slot-available"));
      await sleep(500);

      await validateButtonFor(page, "Bot Monitoring Slot").click();
      await waitUntil(async () => (await rowFor(page, "Bot Monitoring Slot").innerText()).toLowerCase().includes("surveillance active"), 15_000);

      const detectedSlot = await waitUntil(async () =>
        (await botStatusFor(server.baseUrl, managerCookie, "Bot Monitoring Slot")) === "SLOT_DETECTED", 20_000);
      if (!detectedSlot) throw new Error("TimeoutError: SLOT_DETECTED jamais atteint.");
      assert(true, "Scenario B: SLOT_DETECTED reellement atteint");

      await waitUntil(async () => (await rowFor(page, "Bot Monitoring Slot").innerText()).toLowerCase().includes("intervention requise"), 5_000);
      assert((await rowFor(page, "Bot Monitoring Slot").innerText()).toLowerCase().includes("intervention requise"), "Scenario B: message 'intervention requise' affiche");
      assert((await stopButtonFor(page, "Bot Monitoring Slot").count()) === 1, "Scenario B: bouton Arreter toujours present");

      const rootB = rootPidForDebugPort(await listChromeProcs(), debugPortB);
      assert(rootB !== null && await isPidAlive(rootB), "Scenario B: Chrome reste ouvert apres detection du creneau");

      await stopButtonFor(page, "Bot Monitoring Slot").click({ timeout: 5_000 });
      const stoppedB = await waitUntil(async () => (await stopButtonFor(page, "Bot Monitoring Slot").count()) === 0, 15_000);
      if (!stoppedB) throw new Error("TimeoutError: STOP_BOT (scenario B) jamais confirme.");
      const closedB = rootB ? await waitUntilPidGone(rootB, 20_000) : true;
      assert(closedB, "Scenario B: Chrome ferme apres STOP_BOT, aucun orphelin");
    } catch (error) {
      assert(false, `Scenario B interrompu (jamais presente comme un succes): ${error instanceof Error ? error.message : String(error)}`);
    }

    // ===================== Scenario C: rate limit puis reprise =====================
    try {
      log("SCENARIO-C", "=== Rate limit reel: RATE_LIMITED puis reprise MONITORING ===");
      const portsBefore = extractAllDebugPorts(realAgent.stdout).length;
      await startBotViaUi(page, "Bot Monitoring RateLimit");
      const reachedWaiting = await waitUntil(async () => (await stopButtonFor(page, "Bot Monitoring RateLimit").count()) === 1, 20_000);
      if (!reachedWaiting) throw new Error("TimeoutError: le bot n'a jamais atteint WAITING_FOR_USER.");

      const gotPort = await waitUntil(() => extractAllDebugPorts(realAgent!.stdout).length > portsBefore, 5_000);
      if (!gotPort) throw new Error("TimeoutError: port de debogage Chrome introuvable (bot C).");
      const debugPortC = extractAllDebugPorts(realAgent.stdout)[portsBefore];

      // clearAfterMs court (20s) < cooldown reel (1 min, plancher serveur):
      // la fixture redevient "no-slots" bien avant la fin du cooldown, pour
      // que la reprise MONITORING ne re-detecte pas immediatement un rate
      // limit.
      await navigateRealAgentBrowserTo(debugPortC, fixtureUrl("scenario=rate-limited&clearAfterMs=20000"));
      await sleep(500);

      await validateButtonFor(page, "Bot Monitoring RateLimit").click();
      await waitUntil(async () => (await rowFor(page, "Bot Monitoring RateLimit").innerText()).toLowerCase().includes("surveillance active"), 15_000);

      const rateLimited = await waitUntil(async () =>
        (await botStatusFor(server.baseUrl, managerCookie, "Bot Monitoring RateLimit")) === "RATE_LIMITED", 20_000);
      if (!rateLimited) throw new Error("TimeoutError: RATE_LIMITED jamais atteint.");
      assert(true, "Scenario C: RATE_LIMITED reellement atteint");
      assert((await stopButtonFor(page, "Bot Monitoring RateLimit").count()) === 1, "Scenario C: bouton Arreter toujours present pendant RATE_LIMITED");

      log("SCENARIO-C", "Attente de la reprise apres cooldown (~1 min, plancher de securite serveur)...");
      const resumed = await waitUntil(async () =>
        (await botStatusFor(server.baseUrl, managerCookie, "Bot Monitoring RateLimit")) === "MONITORING", 90_000, 1_000);
      if (!resumed) throw new Error("TimeoutError: reprise MONITORING jamais constatee apres le cooldown.");
      assert(true, "Scenario C: reprise MONITORING apres cooldown");

      await stopButtonFor(page, "Bot Monitoring RateLimit").click({ timeout: 5_000 });
      const stoppedC = await waitUntil(async () => (await stopButtonFor(page, "Bot Monitoring RateLimit").count()) === 0, 15_000);
      if (!stoppedC) throw new Error("TimeoutError: STOP_BOT (scenario C) jamais confirme.");
      const rootC = rootPidForDebugPort(await listChromeProcs(), debugPortC);
      const closedC = rootC ? await waitUntilPidGone(rootC, 20_000) : true;
      assert(closedC, "Scenario C: Chrome ferme apres STOP_BOT, aucun orphelin");
    } catch (error) {
      assert(false, `Scenario C interrompu (jamais presente comme un succes): ${error instanceof Error ? error.message : String(error)}`);
    }

    // ===================== Scenario D: refresh reel =====================
    try {
      log("SCENARIO-D", "=== Refresh reel (frequence courte de test) ===");
      await requestJson(server.baseUrl, "PATCH", "/api/monitoring-settings", managerCookie, { refreshEveryCycles: 1 });

      try {
        const portsBefore = extractAllDebugPorts(realAgent.stdout).length;
        await startBotViaUi(page, "Bot Monitoring Refresh");
        const reachedWaiting = await waitUntil(async () => (await stopButtonFor(page, "Bot Monitoring Refresh").count()) === 1, 20_000);
        if (!reachedWaiting) throw new Error("TimeoutError: le bot n'a jamais atteint WAITING_FOR_USER.");

        const gotPort = await waitUntil(() => extractAllDebugPorts(realAgent!.stdout).length > portsBefore, 5_000);
        if (!gotPort) throw new Error("TimeoutError: port de debogage Chrome introuvable (bot D).");
        const debugPortD = extractAllDebugPorts(realAgent.stdout)[portsBefore];

        await navigateRealAgentBrowserTo(debugPortD, fixtureUrl("scenario=refresh-required"));
        await sleep(500);

        await validateButtonFor(page, "Bot Monitoring Refresh").click();
        await waitUntil(async () => (await rowFor(page, "Bot Monitoring Refresh").innerText()).toLowerCase().includes("surveillance active"), 15_000);

        const refreshHappened = await waitUntil(
          () => realAgent!.stdout.join("").includes("Refresh planifie"), 20_000, 500
        );
        assert(refreshHappened, "Scenario D: un refresh reel a bien ete declenche");

        const stillMonitoringAfterRefresh = await waitUntil(async () =>
          (await botStatusFor(server.baseUrl, managerCookie, "Bot Monitoring Refresh")) === "MONITORING", 20_000);
        assert(stillMonitoringAfterRefresh, "Scenario D: retour a MONITORING apres le refresh reel (pas d'ERROR/REFRESH_FAILED)");

        await stopButtonFor(page, "Bot Monitoring Refresh").click({ timeout: 5_000 });
        const stoppedD = await waitUntil(async () => (await stopButtonFor(page, "Bot Monitoring Refresh").count()) === 0, 15_000);
        if (!stoppedD) throw new Error("TimeoutError: STOP_BOT (scenario D) jamais confirme.");
        const rootD = rootPidForDebugPort(await listChromeProcs(), debugPortD);
        const closedD = rootD ? await waitUntilPidGone(rootD, 20_000) : true;
        assert(closedD, "Scenario D: Chrome ferme apres STOP_BOT, aucun orphelin");
      } finally {
        // Toujours reinitialise, meme si une assertion/etape precedente a
        // leve une erreur: sinon refreshEveryCycles=1 fuiterait vers les
        // scenarios suivants (E/F), qui ne s'attendent pas a un refresh a
        // chaque cycle.
        await requestJson(server.baseUrl, "PATCH", "/api/monitoring-settings", managerCookie, { refreshEveryCycles: 0 });
      }
    } catch (error) {
      assert(false, `Scenario D interrompu (jamais presente comme un succes): ${error instanceof Error ? error.message : String(error)}`);
    }

    // ===================== Scenario E: isolation de deux bots =====================
    try {
      log("SCENARIO-E", "=== Isolation de deux bots: arret du premier sans impact sur le second ===");
      await startBotViaUi(page, "Bot Monitoring E1");
      await waitUntil(async () => (await stopButtonFor(page, "Bot Monitoring E1").count()) === 1, 20_000);
      const portsAfterE1 = extractAllDebugPorts(realAgent.stdout).length;
      const debugPortE1 = extractAllDebugPorts(realAgent.stdout)[portsAfterE1 - 1];
      await navigateRealAgentBrowserTo(debugPortE1, fixtureUrl("scenario=no-slots"));
      await sleep(500);
      await validateButtonFor(page, "Bot Monitoring E1").click();
      await waitUntil(async () => (await rowFor(page, "Bot Monitoring E1").innerText()).toLowerCase().includes("surveillance active"), 15_000);

      await startBotViaUi(page, "Bot Monitoring E2");
      await waitUntil(async () => (await stopButtonFor(page, "Bot Monitoring E2").count()) === 1, 20_000);
      const portsAfterE2 = extractAllDebugPorts(realAgent.stdout).length;
      const debugPortE2 = extractAllDebugPorts(realAgent.stdout)[portsAfterE2 - 1];
      await navigateRealAgentBrowserTo(debugPortE2, fixtureUrl("scenario=no-slots"));
      await sleep(500);
      await validateButtonFor(page, "Bot Monitoring E2").click();
      await waitUntil(async () => (await rowFor(page, "Bot Monitoring E2").innerText()).toLowerCase().includes("surveillance active"), 15_000);

      assert(debugPortE1 !== debugPortE2, "Scenario E: deux profils/Chrome distincts pour les deux bots");

      await stopButtonFor(page, "Bot Monitoring E1").click({ timeout: 5_000 });
      const stoppedE1 = await waitUntil(async () => (await stopButtonFor(page, "Bot Monitoring E1").count()) === 0, 15_000);
      if (!stoppedE1) throw new Error("TimeoutError: STOP_BOT du premier bot (E1) jamais confirme.");
      const rootE1 = rootPidForDebugPort(await listChromeProcs(), debugPortE1);
      const closedE1 = rootE1 ? await waitUntilPidGone(rootE1, 20_000) : true;
      assert(closedE1, "Scenario E: Chrome du premier bot (E1) ferme");

      assert((await botStatusFor(server.baseUrl, managerCookie, "Bot Monitoring E2")) === "MONITORING", "Scenario E: le second bot (E2) reste MONITORING, non affecte par l'arret du premier");
      const rootE2 = rootPidForDebugPort(await listChromeProcs(), debugPortE2);
      assert(rootE2 !== null && await isPidAlive(rootE2), "Scenario E: Chrome du second bot (E2) toujours ouvert");

      await stopButtonFor(page, "Bot Monitoring E2").click({ timeout: 5_000 });
      const stoppedE2 = await waitUntil(async () => (await stopButtonFor(page, "Bot Monitoring E2").count()) === 0, 15_000);
      if (!stoppedE2) throw new Error("TimeoutError: STOP_BOT du second bot (E2) jamais confirme.");
      const closedE2 = rootE2 ? await waitUntilPidGone(rootE2, 20_000) : true;
      assert(closedE2, "Scenario E: Chrome du second bot (E2) ferme en fin de test");
    } catch (error) {
      assert(false, `Scenario E interrompu (jamais presente comme un succes): ${error instanceof Error ? error.message : String(error)}`);
    }

    // ===================== Scenario F: fermeture manuelle de Chrome pendant MONITORING =====================
    try {
      log("SCENARIO-F", "=== Fermeture manuelle de Chrome pendant MONITORING ===");
      const portsBeforeF = extractAllDebugPorts(realAgent.stdout).length;
      await startBotViaUi(page, "Bot Monitoring ManualClose");
      await waitUntil(async () => (await stopButtonFor(page, "Bot Monitoring ManualClose").count()) === 1, 20_000);
      const gotPortF = await waitUntil(() => extractAllDebugPorts(realAgent!.stdout).length > portsBeforeF, 5_000);
      if (!gotPortF) throw new Error("TimeoutError: port de debogage Chrome introuvable (bot F).");
      const debugPortF = extractAllDebugPorts(realAgent.stdout)[portsBeforeF];
      await navigateRealAgentBrowserTo(debugPortF, fixtureUrl("scenario=no-slots"));
      await sleep(500);
      await validateButtonFor(page, "Bot Monitoring ManualClose").click();
      await waitUntil(async () => (await rowFor(page, "Bot Monitoring ManualClose").innerText()).toLowerCase().includes("surveillance active"), 15_000);

      const rootF = rootPidForDebugPort(await listChromeProcs(), debugPortF);
      if (!rootF) throw new Error("Process racine chrome.exe introuvable pour le bot F.");

      log("SCENARIO-F", `Fermeture manuelle (taskkill) du process racine ${rootF}...`);
      await killTree(Number(rootF));

      const detectedClosure = await waitUntil(async () =>
        (await stopButtonFor(page, "Bot Monitoring ManualClose").count()) === 0, 15_000);
      assert(detectedClosure, "Scenario F: la fermeture manuelle est detectee, le bot n'apparait plus comme actif");

      const noOrphan = await waitUntil(async () => !(await isPidAlive(rootF)), 8_000);
      assert(noOrphan, "Scenario F: aucun processus chrome.exe orphelin apres fermeture manuelle");
    } catch (error) {
      assert(false, `Scenario F interrompu (jamais presente comme un succes): ${error instanceof Error ? error.message : String(error)}`);
    }

    await context.close();
  } finally {
    // Nettoyage robuste: s'execute meme apres un TimeoutError ou une erreur.
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    await killTree(realAgent?.child.pid).catch(() => undefined);
    if (server) {
      await killTree(server.child.pid).catch(() => undefined);
    }
    if (existsSync(credPath)) {
      try { rmSync(credPath); } catch { /* best effort */ }
    }
    if (existsSync(dataRoot)) {
      try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* best effort */ }
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
