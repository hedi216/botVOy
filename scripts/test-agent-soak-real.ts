// Test REEL Lot 6 (section 9, stabilite courte): lance le VRAI runtime
// src/agent/agentMain.ts, un VRAI Chrome visible, la fixture locale
// UNIQUEMENT (jamais TLScontact) pendant une duree configurable
// (AGENT_SOAK_TEST_DURATION_MINUTES, defaut 10 minutes), avec deux bots
// fixture, plusieurs cycles reels, un refresh periodique, UNE reconnexion
// serveur controlee et UNE mise en rate limit courte. A executer
// UNIQUEMENT sur un PC Windows personnel avec une session interactive et
// Google Chrome installe — JAMAIS sur la VM/serveur de production.
//
// Ce test n'est PAS inclus dans test:phase4:smoke (trop long pour un smoke
// test) ni dans test:phase4:final:real (duree variable, execution isolee
// et volontaire). Il verifie des indices de stabilite, pas une preuve
// formelle d'absence de fuite memoire: les seuils sont volontairement
// larges pour ne detecter qu'une derive grossiere ("croissance visiblement
// continue"), jamais une fluctuation normale.
//
// Usage: npx tsx scripts/test-agent-soak-real.ts
//    ou: npm run test:agent:soak:real
//    ou (duree reduite pour verification rapide):
//        set AGENT_SOAK_TEST_DURATION_MINUTES=2 && npm run test:agent:soak:real

import { ChildProcess, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Browser, Page, chromium } from "playwright";
import { pool } from "../src/db.js";
import { requirePositiveInt } from "../src/envValidation.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
const SERVER_PORT = 3298;
const DURATION_MINUTES = requirePositiveInt("AGENT_SOAK_TEST_DURATION_MINUTES", process.env.AGENT_SOAK_TEST_DURATION_MINUTES, 10);
const SAMPLE_INTERVAL_MS = 30_000;
const SAMPLE_COUNT = Math.max(4, Math.round((DURATION_MINUTES * 60_000) / SAMPLE_INTERVAL_MS));
const RESTART_AT_SAMPLE = Math.floor(SAMPLE_COUNT / 2);

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

const botStatusFor = async (baseUrl: string, cookie: string, botName: string): Promise<string | undefined> => {
  const result = await requestJson(baseUrl, "GET", "/api/agent-commands?limit=20", cookie);
  return result.body?.commands?.find((c: any) => c.botName === botName)?.botStatus;
};

const extractAllDebugPorts = (agentStdout: string[]): number[] => {
  const joined = agentStdout.join("");
  const matches = [...joined.matchAll(/Connexion au Chrome deja ouvert: http:\/\/127\.0\.0\.1:(\d+)/g)];
  return matches.map((m) => Number(m[1]));
};

const navigateRealAgentBrowserTo = async (debugPort: number, targetUrl: string): Promise<void> => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0];
  const pages = context.pages().filter((p) => !p.isClosed() && !p.url().startsWith("devtools://"));
  const targetPage = pages[0] ?? await context.newPage();
  await targetPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
};

type RealAgentHandle = { child: ChildProcess; stdout: string[] };

const spawnRealAgent = (
  serverUrl: string,
  code: string,
  credPath: string,
  dataRoot: string,
  computerName: string
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

type ChromeProcInfo = { pid: string; parentPid: string; commandLine: string };

const listWinProcs = (name: "chrome.exe" | "node.exe"): Promise<ChromeProcInfo[]> => new Promise((resolve) => {
  if (process.platform !== "win32") { resolve([]); return; }
  const script = `Get-CimInstance Win32_Process -Filter "Name='${name}'" `
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

const isPidAlive = async (pid: string): Promise<boolean> => (await listWinProcs("chrome.exe")).some((p) => p.pid === pid);

const waitUntilPidGone = async (pid: string, timeoutMs = 20_000): Promise<boolean> =>
  waitUntil(async () => !(await isPidAlive(pid)), timeoutMs, 300);

const rootPidForDebugPort = (procs: ChromeProcInfo[], debugPort: number): string | null => {
  const match = rootPids(procs).find((p) => p.commandLine.includes(`--remote-debugging-port=${debugPort}`));
  return match?.pid ?? null;
};

// Working set (RSS) en Mo du node.exe qui execute reellement agentMain.ts
// (npx.cmd sur Windows lance un node.exe distinct, jamais le meme PID que
// le process spawn() retourne ici) - identifie par la presence de
// "agentMain" dans sa ligne de commande, seul agent reel actif pendant ce
// test.
const sampleAgentMemoryMb = (): Promise<number | null> => new Promise((resolve) => {
  if (process.platform !== "win32") { resolve(null); return; }
  const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" "
    + "| Where-Object { $_.CommandLine -like '*agentMain*' } "
    + "| Select-Object WorkingSetSize | ConvertTo-Json -Compress";
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  let output = "";
  child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
  child.on("exit", () => {
    try {
      const trimmed = output.trim();
      if (!trimmed) { resolve(null); return; }
      const parsed = JSON.parse(trimmed);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const total = rows.reduce((sum, row) => sum + Number(row.WorkingSetSize ?? 0), 0);
      resolve(total > 0 ? total / (1024 * 1024) : null);
    } catch {
      resolve(null);
    }
  });
  child.on("error", () => resolve(null));
});

const countOccurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

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
  log("BOOT", `=== Test REEL Lot 6: stabilite courte (${DURATION_MINUTES} min, ${SAMPLE_COUNT} echantillons) ===`);
  log("BOOT", "A executer sur un PC Windows personnel avec session interactive. JAMAIS sur la VM.");

  let browser: Browser | undefined;
  let server: ServerHandle | undefined;
  let realAgent: RealAgentHandle | undefined;
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  const credPath = path.join(process.cwd(), `.test-soak-real-creds-${RUN_SUFFIX}.json`);
  const dataRoot = path.join(process.cwd(), `.test-soak-real-data-${RUN_SUFFIX}`);
  const chromeBaselinePids = (await listWinProcs("chrome.exe")).map((p) => p.pid);

  try {
    browser = await chromium.launch({ headless: true });
    server = await startServer(SERVER_PORT, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });

    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyName = `Test Soak Real ${RUN_SUFFIX}`;
    agencyNames.push(agencyName);
    const agencyId = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
    const managerLogin = `test-soak-real-${RUN_SUFFIX}`;
    managerLogins.push(managerLogin);
    const userRes = await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, {
      agencyId, login: managerLogin, name: "Real Soak Manager", email: `${managerLogin}@example.test`, role: 1
    });
    const managerPassword = userRes.body.temporaryPassword;
    let managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);

    await setShortMonitoringSettings(server.baseUrl, managerCookie, {
      maxParallelScansPerDomain: 2, monthClickMinDelaySeconds: 1, monthClickMaxDelaySeconds: 2,
      botCycleCooldownMinSeconds: 5, botCycleCooldownMaxSeconds: 6, rateLimitCooldownSeconds: 60
    });

    const pairing = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const code = pairing.body.pairing.code;

    realAgent = spawnRealAgent(server.baseUrl, code, credPath, dataRoot, "REAL-SOAK-PC");
    await sleep(2_000);

    let context = await browser.newContext();
    let page = await context.newPage();
    await loginViaUi(page, server.baseUrl, managerLogin, managerPassword);
    await page.click('#agentSetupSkip').catch(() => undefined);
    await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
    await openBotPage(page);

    // ===================== Demarrage des deux bots fixture =====================
    await startBotViaUi(page, "Bot Soak A");
    const waitingA = await waitUntil(async () => (await stopButtonFor(page, "Bot Soak A").count()) === 1, 20_000);
    if (!waitingA) throw new Error("TimeoutError: Bot Soak A n'a jamais atteint WAITING_FOR_USER.");
    const debugPortA = extractAllDebugPorts(realAgent.stdout)[0];
    if (!debugPortA) throw new Error("TimeoutError: port de debogage Chrome introuvable (bot A).");
    await navigateRealAgentBrowserTo(debugPortA, fixtureUrl("scenario=no-slots"));
    await sleep(500);
    await validateButtonFor(page, "Bot Soak A").click();
    const monitoringA = await waitUntil(async () => (await rowFor(page, "Bot Soak A").innerText()).toLowerCase().includes("surveillance active"), 15_000);
    if (!monitoringA) throw new Error("TimeoutError: Bot Soak A jamais MONITORING.");
    assert(true, "Bot Soak A: MONITORING reel atteint (scenario no-slots)");

    const portsBeforeB = extractAllDebugPorts(realAgent.stdout).length;
    await startBotViaUi(page, "Bot Soak B");
    const waitingB = await waitUntil(async () => (await stopButtonFor(page, "Bot Soak B").count()) === 1, 20_000);
    if (!waitingB) throw new Error("TimeoutError: Bot Soak B n'a jamais atteint WAITING_FOR_USER.");
    const gotPortB = await waitUntil(() => extractAllDebugPorts(realAgent!.stdout).length > portsBeforeB, 5_000);
    if (!gotPortB) throw new Error("TimeoutError: port de debogage Chrome introuvable (bot B).");
    const debugPortB = extractAllDebugPorts(realAgent.stdout)[portsBeforeB];
    // clearAfterMs court: bot B passe par RATE_LIMITED puis revient en
    // MONITORING tot dans la fenetre de stabilite (section 9: "une mise en
    // rate limit courte"), sans bloquer le reste du scenario.
    await navigateRealAgentBrowserTo(debugPortB, fixtureUrl("scenario=rate-limited&clearAfterMs=15000"));
    await sleep(500);
    await validateButtonFor(page, "Bot Soak B").click();
    const waitingOrMonitoringB = await waitUntil(async () => (await stopButtonFor(page, "Bot Soak B").count()) === 1, 15_000);
    if (!waitingOrMonitoringB) throw new Error("TimeoutError: Bot Soak B jamais valide.");
    assert(true, "Bot Soak B: valide (scenario rate-limited court)");

    const rateLimitedB = await waitUntil(async () => (await botStatusFor(server!.baseUrl, managerCookie, "Bot Soak B")) === "RATE_LIMITED", 20_000);
    assert(rateLimitedB, "Bot Soak B: RATE_LIMITED reellement atteint");
    const resumedB = await waitUntil(async () => (await botStatusFor(server!.baseUrl, managerCookie, "Bot Soak B")) === "MONITORING", 90_000, 1_000);
    assert(resumedB, "Bot Soak B: reprise MONITORING apres le cooldown de rate limit");

    // ===================== Fenetre de stabilite: echantillonnage regulier =====================
    const memorySamplesMb: number[] = [];
    const chromeRootCounts: number[] = [];
    let restartDone = false;

    for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
      if (!restartDone && sampleIndex === RESTART_AT_SAMPLE) {
        log("SOAK", "Redemarrage reel controle du serveur (une seule fois, milieu de la fenetre)...");
        const connectedBefore = countOccurrences(realAgent.stdout.join(""), "AGENT_CONNECTED");
        await killTree(server.child.pid);
        await sleep(1_000);
        server = await startServer(SERVER_PORT, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });
        const reconnected = await waitUntil(() => /Synchronisation terminee/.test(realAgent!.stdout.join("")) && countOccurrences(realAgent!.stdout.join(""), "AGENT_CONNECTED") > connectedBefore, 20_000, 500);
        assert(reconnected, "Soak: l'agent se reconnecte reellement apres le redemarrage controle du serveur");

        managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);
        await context.close();
        context = await browser.newContext();
        page = await context.newPage();
        await loginViaUi(page, server.baseUrl, managerLogin, managerPassword);
        await page.click('#agentSetupSkip').catch(() => undefined);
        await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
        await openBotPage(page);

        const bothReconciled = await waitUntil(async () =>
          (await botStatusFor(server!.baseUrl, managerCookie, "Bot Soak A")) === "MONITORING"
          && (await botStatusFor(server!.baseUrl, managerCookie, "Bot Soak B")) === "MONITORING", 20_000);
        assert(bothReconciled, "Soak: les deux bots reconvergent vers MONITORING apres reconnexion (buffer rejoue sans blocage)");

        const connectedAfter = countOccurrences(realAgent.stdout.join(""), "AGENT_CONNECTED");
        assert(connectedAfter === connectedBefore + 1, `Soak: exactement une reconnexion enregistree cote agent (avant=${connectedBefore}, apres=${connectedAfter}), pas de boucle de reconnexion`);
        restartDone = true;
      }

      const chromeProcs = await listWinProcs("chrome.exe");
      const newRoots = rootPids(chromeProcs).filter((p) => !chromeBaselinePids.includes(p.pid));
      chromeRootCounts.push(newRoots.length);

      const memMb = await sampleAgentMemoryMb();
      if (memMb !== null) memorySamplesMb.push(memMb);

      log("SOAK", `Echantillon ${sampleIndex + 1}/${SAMPLE_COUNT}: chrome.exe(nouveaux racine)=${newRoots.length}, memoire agent~=${memMb ? memMb.toFixed(1) : "?"} Mo`);
      await sleep(SAMPLE_INTERVAL_MS);
    }

    // ===================== Verifications post-fenetre =====================
    const cyclesTotal = countOccurrences(realAgent.stdout.join(""), "Surveillance tentative");
    assert(cyclesTotal >= 4, `Soak: plusieurs cycles de surveillance reellement executes sur la duree (${cyclesTotal} occurrences de "Surveillance tentative")`);

    const refreshSeen = /[Rr]efresh|reload/.test(realAgent.stdout.join(""));
    assert(refreshSeen, "Soak: au moins un refresh periodique reellement declenche pendant la fenetre");

    const maxChromeRoots = Math.max(...chromeRootCounts);
    const minChromeRoots = Math.min(...chromeRootCounts.filter((_, i) => i > 0));
    assert(maxChromeRoots <= 2, `Soak: jamais plus de 2 processus Chrome racine nouveaux simultanes (observe: ${maxChromeRoots})`);
    assert(minChromeRoots >= 2, `Soak: les 2 Chrome des bots restent presents en continu (minimum observe apres demarrage: ${minChromeRoots})`);

    if (memorySamplesMb.length >= 2) {
      const warmupSkip = Math.min(1, memorySamplesMb.length - 1);
      const earlySample = memorySamplesMb[warmupSkip];
      const lastSample = memorySamplesMb[memorySamplesMb.length - 1];
      const growthRatio = lastSample / Math.max(earlySample, 1);
      log("SOAK", `Memoire agent: premier echantillon (post-demarrage)=${earlySample.toFixed(1)} Mo, dernier=${lastSample.toFixed(1)} Mo, ratio=${growthRatio.toFixed(2)}`);
      // Seuil volontairement large (section 9: "pas de croissance visiblement
      // continue", pas une preuve stricte d'absence de fuite): ne detecte
      // qu'une derive grossiere, jamais une fluctuation normale du GC V8.
      assert(growthRatio < 3, `Soak: la memoire de l'agent ne croit pas de maniere flagrante sur la duree (ratio ${growthRatio.toFixed(2)} < 3)`);
    } else {
      log("SOAK", "Echantillonnage memoire indisponible (hors Windows ou PowerShell inaccessible) - verification memoire ignoree, pas comptee en echec.");
    }

    const slotDetectedCount = countOccurrences(realAgent.stdout.join(""), "SLOT_DETECTED");
    assert(slotDetectedCount === 0, "Soak: aucun SLOT_DETECTED inattendu (scenarios no-slots/rate-limited uniquement)");

    // ===================== Arret propre final =====================
    log("SOAK", "Arret propre final des deux bots...");
    await stopButtonFor(page, "Bot Soak A").click({ timeout: 5_000 });
    const stoppedA = await waitUntil(async () => (await stopButtonFor(page, "Bot Soak A").count()) === 0, 15_000);
    assert(stoppedA, "Soak: STOP_BOT confirme pour Bot Soak A");
    await stopButtonFor(page, "Bot Soak B").click({ timeout: 5_000 });
    const stoppedB = await waitUntil(async () => (await stopButtonFor(page, "Bot Soak B").count()) === 0, 15_000);
    assert(stoppedB, "Soak: STOP_BOT confirme pour Bot Soak B");

    const rootA = rootPidForDebugPort(await listWinProcs("chrome.exe"), debugPortA);
    const closedA = rootA ? await waitUntilPidGone(rootA, 20_000) : true;
    assert(closedA, "Soak: Chrome du bot A ferme proprement, aucun orphelin");
    const rootB = rootPidForDebugPort(await listWinProcs("chrome.exe"), debugPortB);
    const closedB = rootB ? await waitUntilPidGone(rootB, 20_000) : true;
    assert(closedB, "Soak: Chrome du bot B ferme proprement, aucun orphelin");

    const finalChromeProcs = await listWinProcs("chrome.exe");
    const residualChrome = rootPids(finalChromeProcs).filter((p) => !chromeBaselinePids.includes(p.pid));
    assert(residualChrome.length === 0, `Soak: aucun processus Chrome residuel apres l'arret final (residuels: ${residualChrome.length})`);

    await context.close();
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    await killTree(realAgent?.child.pid).catch(() => undefined);
    if (server) {
      await killTree(server.child.pid).catch(() => undefined);
    }
    if (existsSync(credPath)) { try { rmSync(credPath); } catch { /* best effort */ } }
    if (existsSync(dataRoot)) { try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* best effort */ } }
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
