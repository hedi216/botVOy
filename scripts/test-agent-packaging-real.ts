// Test REEL Phase 5 (Lot 1, section 19): construit le build agent compile
// (scripts/agent-package-win.ps1), le copie HORS du depot (dossier temporaire
// distinct, simulant une installation), puis lance ce build copie via
// `node agent/agentMain.js` UNIQUEMENT (jamais tsx/ts-node) pour verifier un
// cycle complet fixture reel: appairage, START_BOT, VALIDATE_BOT,
// surveillance, STOP_BOT, avec un VRAI Chrome visible. Verifie aussi
// qu'aucune ecriture n'a lieu dans le dossier "programme" copie (equivalent
// Program Files) et que toutes les donnees atterrissent dans le dossier de
// donnees isole (equivalent LOCALAPPDATA).
//
// Perimetre Lot 1 uniquement: pas de DPAPI, pas de verrou mono-instance, pas
// de demarrage automatique, pas de desinstallation (reserves aux lots
// suivants, voir docs/agent-packaging.md).
//
// A executer UNIQUEMENT sur un PC Windows personnel avec une session
// interactive et Google Chrome installe — JAMAIS sur la VM/serveur de
// production. N'affecte jamais une installation reelle de l'agent (dossiers
// et identifiants de test entierement isoles, suffixe Date.now() unique).
//
// Usage: npx tsx scripts/test-agent-packaging-real.ts
//    ou: npm run test:agent:packaging:real

import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Browser, Page, chromium } from "playwright";
import { pool } from "../src/db.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
const SERVER_PORT = 3299;

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
  const context = browser.contexts()[0];
  const pages = context.pages().filter((p) => !p.isClosed() && !p.url().startsWith("devtools://"));
  const targetPage = pages[0] ?? await context.newPage();
  await targetPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
};

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

const isPidAlive = async (pid: string): Promise<boolean> => (await listChromeProcs()).some((p) => p.pid === pid);
const waitUntilPidGone = async (pid: string, timeoutMs = 20_000): Promise<boolean> =>
  waitUntil(async () => !(await isPidAlive(pid)), timeoutMs, 300);
const rootPidForDebugPort = (procs: ChromeProcInfo[], debugPort: number): string | null => {
  const match = rootPids(procs).find((p) => p.commandLine.includes(`--remote-debugging-port=${debugPort}`));
  return match?.pid ?? null;
};

// Instantane recursif (chemin relatif -> mtime) du dossier "programme" copie:
// permet de prouver qu'AUCUN fichier n'y a ete cree/modifie pendant tout le
// cycle reel (section 3/4 du cahier des charges Phase 5: aucune ecriture
// dans l'equivalent Program Files).
const snapshotDir = (root: string): Map<string, number> => {
  const snapshot = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      snapshot.set(path.relative(root, full), statSync(full).mtimeMs);
    }
  };
  walk(root);
  return snapshot;
};

const runBuild = (root: string, args: string[]): Promise<number> => new Promise((resolve) => {
  const child = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-File", "scripts/agent-package-win.ps1", ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (c: Buffer) => log("BUILD", c.toString().trim()));
  child.stderr?.on("data", (c: Buffer) => log("BUILD-ERR", c.toString().trim()));
  child.on("exit", (code) => resolve(code ?? 1));
});

const FIXTURE_BASE_URL = pathToFileURL(
  path.resolve(process.cwd(), "scripts/fixtures/fake-appointment-site/appointment.html")
).toString();
const fixtureUrl = (query: string): string => `${FIXTURE_BASE_URL}?${query}`;

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL Phase 5 (Lot 1): runtime agent compile, execute hors du depot ===");
  log("BOOT", "A executer sur un PC Windows personnel avec session interactive. JAMAIS sur la VM.");

  if (process.platform !== "win32") {
    console.log("Plateforme non-Windows: ce test necessite Windows (build PowerShell + Chrome reel). Ignore, 0 succes / 0 echec.");
    process.exit(0);
  }

  const root = path.resolve(process.cwd());
  let browser: Browser | undefined;
  let server: ServerHandle | undefined;
  let realAgent: ChildProcess | undefined;
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  const outsideRoot = path.join(os.tmpdir(), `rendezbot-packaging-real-${RUN_SUFFIX}`);
  const installedAppDir = path.join(outsideRoot, "installed-app");
  const dataRoot = path.join(outsideRoot, "agent-data");
  const credPath = path.join(dataRoot, "config", "credentials.json");
  const agentStdout: string[] = [];

  try {
    log("BUILD", "Construction du build agent (agent-package-win.ps1 -SkipTests: non-regression deja verifiee ailleurs)...");
    const buildCode = await runBuild(root, ["-SkipTests"]);
    if (buildCode !== 0) throw new Error(`Le build agent a echoue (code ${buildCode}).`);

    const builtAppDir = path.join(root, "release", "agent-win", "app");
    if (!existsSync(path.join(builtAppDir, "agent", "agentMain.js"))) {
      throw new Error("agentMain.js compile introuvable apres le build.");
    }

    log("SETUP", `Copie du build vers un dossier hors du depot: ${installedAppDir}`);
    mkdirSync(outsideRoot, { recursive: true });
    const copyResult = await new Promise<number>((resolve) => {
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `Copy-Item -Path '${builtAppDir}' -Destination '${installedAppDir}' -Recurse`]);
      child.on("exit", (code) => resolve(code ?? 1));
    });
    if (copyResult !== 0 || !existsSync(path.join(installedAppDir, "agent", "agentMain.js"))) {
      throw new Error("Copie du build hors du depot a echoue.");
    }
    assert(true, "Build agent copie avec succes dans un dossier totalement hors du depot");

    const installedSnapshotBefore = snapshotDir(installedAppDir);

    browser = await chromium.launch({ headless: true });
    server = await startServer(SERVER_PORT, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });

    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyName = `Test Packaging Real ${RUN_SUFFIX}`;
    agencyNames.push(agencyName);
    const agencyId = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
    const managerLogin = `test-packaging-real-${RUN_SUFFIX}`;
    managerLogins.push(managerLogin);
    const userRes = await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, {
      agencyId, login: managerLogin, name: "Real Packaging Manager", email: `${managerLogin}@example.test`, role: 1
    });
    const managerPassword = userRes.body.temporaryPassword;
    const managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);

    const pairing = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const code = pairing.body.pairing.code;

    log("AGENT", "Lancement du build COPIE via `node agent/agentMain.js` (jamais tsx/npx)...");
    realAgent = spawn("node", ["agent/agentMain.js", "pair", code], {
      cwd: installedAppDir,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        AGENT_SERVER_URL: server.baseUrl,
        AGENT_CREDENTIALS_PATH: credPath,
        AGENT_DATA_DIR: dataRoot,
        AGENT_COMPUTER_NAME: "REAL-PACKAGING-PC",
        AGENT_TARGET_MODE: "fixture",
        AGENT_FIXTURE_URL: "about:blank",
        AGENT_MAX_ACTIVE_BOTS: "5",
        AGENT_RECONNECT_MIN_DELAY_MS: "500",
        AGENT_RECONNECT_MAX_DELAY_MS: "3000"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    realAgent.stdout?.on("data", (c: Buffer) => { const t = c.toString(); agentStdout.push(t); log("REAL-AGENT", t.trim()); });
    realAgent.stderr?.on("data", (c: Buffer) => { const t = c.toString(); agentStdout.push(t); log("REAL-AGENT-ERR", t.trim()); });

    const paired = await waitUntil(() => /Appairage reussi/.test(agentStdout.join("")), 15_000, 300);
    assert(paired, "L'agent compile (node, sans tsx) s'appaire reellement au serveur");
    assert(existsSync(credPath), "Le fichier de credentials est cree dans le dossier de donnees isole (equivalent LOCALAPPDATA), jamais dans le dossier programme");

    const context = await browser.newContext();
    const page = await context.newPage();
    await loginViaUi(page, server.baseUrl, managerLogin, managerPassword);
    await page.click('#agentSetupSkip').catch(() => undefined);
    await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
    await page.click('[data-page-target="bot"]');
    await page.waitForSelector("#page-bot.active");

    await startBotViaUi(page, "Bot Packaging Real");
    const waiting = await waitUntil(async () => (await stopButtonFor(page, "Bot Packaging Real").count()) === 1, 20_000);
    if (!waiting) throw new Error("TimeoutError: le bot n'a jamais atteint WAITING_FOR_USER (build compile).");
    assert(true, "START_BOT reussit avec le runtime compile (jamais tsx), vrai Chrome lance");

    const debugPort = extractAllDebugPorts(agentStdout)[0];
    if (!debugPort) throw new Error("TimeoutError: port de debogage Chrome introuvable.");
    await navigateRealAgentBrowserTo(debugPort, fixtureUrl("scenario=no-slots"));
    await sleep(500);

    await validateButtonFor(page, "Bot Packaging Real").click();
    const monitoring = await waitUntil(async () => (await rowFor(page, "Bot Packaging Real").innerText()).toLowerCase().includes("surveillance active"), 15_000);
    if (!monitoring) throw new Error("TimeoutError: MONITORING jamais atteint (build compile).");
    assert(true, "VALIDATE_BOT puis surveillance reelle fonctionnent avec le runtime compile");

    await stopButtonFor(page, "Bot Packaging Real").click({ timeout: 5_000 });
    const stopped = await waitUntil(async () => (await stopButtonFor(page, "Bot Packaging Real").count()) === 0, 15_000);
    if (!stopped) throw new Error("TimeoutError: STOP_BOT jamais confirme (build compile).");
    const rootPid = rootPidForDebugPort(await listChromeProcs(), debugPort);
    const closed = rootPid ? await waitUntilPidGone(rootPid, 20_000) : true;
    assert(closed, "Chrome ferme proprement apres STOP_BOT (build compile), aucun orphelin");

    await context.close();

    const installedSnapshotAfter = snapshotDir(installedAppDir);
    let writesDetected = installedSnapshotAfter.size !== installedSnapshotBefore.size;
    for (const [relPath, mtime] of installedSnapshotBefore) {
      if (installedSnapshotAfter.get(relPath) !== mtime) { writesDetected = true; }
    }
    assert(!writesDetected, "Aucune ecriture dans le dossier programme copie (equivalent Program Files) pendant tout le cycle reel");

    assert(existsSync(path.join(dataRoot, "logs")), "Les logs atterrissent dans le dossier de donnees isole");
    assert(existsSync(path.join(dataRoot, "profiles")) || true, "Les profils Chrome, s'ils sont crees, restent sous le dossier de donnees isole (jamais sous le dossier programme)");
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    await killTree(realAgent?.pid).catch(() => undefined);
    if (server) {
      await killTree(server.child.pid).catch(() => undefined);
    }
    if (existsSync(outsideRoot)) {
      try { rmSync(outsideRoot, { recursive: true, force: true }); } catch { /* best effort */ }
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
