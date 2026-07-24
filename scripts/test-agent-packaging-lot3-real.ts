// Test REEL Phase 5 (Lot 3, section 19): construit le runtime autonome et le
// VRAI installateur Inno Setup, puis verifie sur CE PC Windows, dans un
// environnement isole (dossier temporaire dedie, serveur de test local,
// fixture locale): installation reelle sans droits admin, demarrage de
// l'agent EMBARQUE (RendezBotAgent.exe, jamais `node`), appairage via
// l'interface locale, DPAPI, redemarrage/reconnexion, verrou mono-instance,
// demarrage automatique (raccourci), START_BOT/STOP_BOT avec un vrai Chrome
// visible sur une fixture locale, mise a niveau N -> N+1 (identifiants et
// profils preserves), desinstallation standard (dataRoot preserve), et
// reinstallation.
//
// Scenarios V/W (suppression complete + suppression reelle du dataRoot) sont
// INTENTIONNELLEMENT NON couverts ici: la logique Pascal de suppression
// complete cible {localappdata}\RendezBot, le VRAI dossier de production,
// sans mecanisme d'isolation au niveau de l'installateur (contrairement au
// runtime agent qui, lui, respecte AGENT_DATA_DIR). Executer ce scenario
// automatiquement sur un poste de developpement risquerait de supprimer de
// vraies donnees. Ce scenario reste couvert par revue de code (voir
// docs/agent-packaging.md) et doit etre valide manuellement sur une VM/un
// compte Windows dedie et jetable (voir docs/phase5-test-plan.md).
//
// GARDE-FOU: ce test refuse de s'executer si une installation reelle de
// RendezBot Agent (meme AppId, cle de registre partagee quel que soit le
// chemin d'installation) est deja presente sur cette machine - jamais
// d'installation/desinstallation de la vraie application du developpeur.
//
// A executer UNIQUEMENT sur un PC Windows personnel avec une session
// interactive et Google Chrome installe - JAMAIS sur la VM/serveur de
// production.
//
// Usage: npx tsx scripts/test-agent-packaging-lot3-real.ts
//    ou: npm run test:agent:packaging-lot3:real

import { ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Browser, Page, chromium } from "playwright";
import { pool } from "../src/db.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
const SERVER_PORT = 3305;
const APP_ID = "{137428DC-78FA-414F-BF17-F9CC0FD444C6}";
const UNINSTALL_KEY = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}_is1`;

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Constrainte section 19: tout depassement de delai critique doit faire
// echouer le test, jamais un succes silencieux.
const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 15_000, intervalMs = 300): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};
const requireWithin = async (predicate: () => Promise<boolean> | boolean, timeoutMs: number, description: string): Promise<void> => {
  const ok = await waitUntil(predicate, timeoutMs);
  if (!ok) throw new Error(`TimeoutError: ${description}`);
};

const runPowerShell = (args: string[], cwd = path.resolve(process.cwd())): Promise<{ code: number; output: string }> => new Promise((resolve) => {
  const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (c: Buffer) => { output += c.toString(); log("PS", c.toString().trim()); });
  child.stderr?.on("data", (c: Buffer) => { output += c.toString(); log("PS-ERR", c.toString().trim()); });
  child.on("exit", (code) => resolve({ code: code ?? 1, output }));
  child.on("error", () => resolve({ code: 1, output }));
});

const findIsccPath = (): string | null => {
  const override = process.env.INNO_SETUP_COMPILER_PATH;
  if (override && existsSync(override)) return override;
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe"),
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe"
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
};

const regQueryString = async (keyPath: string, valueName: string): Promise<string | null> => {
  const result = await runPowerShell(["-Command", `try { (Get-ItemProperty -Path 'HKCU:\\${keyPath}' -ErrorAction Stop).${valueName} } catch { '__ABSENT__' }`]);
  const trimmed = result.output.trim();
  return trimmed === "__ABSENT__" || trimmed === "" ? null : trimmed;
};

const killTree = (pid: number | undefined): Promise<void> => new Promise((resolve) => {
  if (!pid) { resolve(); return; }
  const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
  k.once("exit", () => resolve());
  k.once("error", () => resolve());
});

type ServerHandle = { child: ChildProcess; baseUrl: string; stdout: string[] };
const waitForServerReady = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`${baseUrl}/api/me`); if (res.status === 401 || res.status === 200) return; } catch { /* pas encore pret */ }
    await sleep(500);
  }
  throw new Error("TimeoutError: le serveur de test n'a jamais repondu.");
};
const startServer = async (port: number, env: Record<string, string>): Promise<ServerHandle> => {
  const child = spawn("npx.cmd", ["tsx", "src/server.ts"], {
    env: { ...process.env, WEB_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true
  });
  const stdout: string[] = [];
  child.stdout?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("SERVER", t.trim()); });
  child.stderr?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("SERVER-ERR", t.trim()); });
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  return { child, baseUrl, stdout };
};

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

type RealAgentHandle = { child: ChildProcess; stdout: string[] };
const spawnPackagedAgent = (exeDir: string, serverUrl: string, dataRoot: string, extraEnv: Record<string, string> = {}, extraArgs: string[] = []): RealAgentHandle => {
  const child = spawn(path.join(exeDir, "RendezBotAgent.exe"), ["agent\\agentMain.js", ...extraArgs], {
    cwd: exeDir,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      AGENT_SERVER_URL: serverUrl,
      AGENT_DATA_DIR: dataRoot,
      AGENT_COMPUTER_NAME: "REAL-LOT3-PC",
      AGENT_RUNTIME_MODE: "packaged",
      AGENT_TARGET_MODE: "fixture",
      AGENT_FIXTURE_URL: "about:blank",
      AGENT_MAX_ACTIVE_BOTS: "5",
      AGENT_RECONNECT_MIN_DELAY_MS: "500",
      AGENT_RECONNECT_MAX_DELAY_MS: "3000",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout: string[] = [];
  child.stdout?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("AGENT", t.trim()); });
  child.stderr?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("AGENT-ERR", t.trim()); });
  return { child, stdout };
};
const extractLocalUiPort = (stdout: string[]): number | null => {
  const match = stdout.join("").match(/Interface locale disponible: http:\/\/127\.0\.0\.1:(\d+)\//);
  return match ? Number(match[1]) : null;
};
const localUiStatus = async (port: number): Promise<any> => (await fetch(`http://127.0.0.1:${port}/local/status`)).json();
const localUiPost = async (port: number, route: string, nonce: string, extra?: Record<string, unknown>): Promise<{ status: number; body: any }> => {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce, ...extra }) });
  return { status: res.status, body: await res.json() };
};

const runInstaller = (installerPath: string, args: string[]): Promise<number> => new Promise((resolve) => {
  const child = spawn(installerPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (c: Buffer) => log("SETUP", c.toString().trim()));
  child.stderr?.on("data", (c: Buffer) => log("SETUP-ERR", c.toString().trim()));
  const timeout = setTimeout(() => { child.kill(); resolve(124); }, 60_000);
  child.on("exit", (code) => { clearTimeout(timeout); resolve(code ?? 1); });
  child.on("error", () => { clearTimeout(timeout); resolve(1); });
});

const listChromeProcs = (): Promise<string[]> => new Promise((resolve) => {
  const child = spawn("wmic", ["process", "where", "Name='chrome.exe'", "get", "ProcessId"]);
  let output = "";
  child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
  child.on("exit", () => resolve(output.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l))));
  child.on("error", () => resolve([]));
});

const rowFor = (page: Page, botNameText: string) => page.locator("#agentCommandsTableBody tr", { hasText: botNameText });
const stopButtonFor = (page: Page, botNameText: string) => rowFor(page, botNameText).locator("button", { hasText: "Arreter" });
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

const FIXTURE_URL = pathToFileURL(path.resolve(process.cwd(), "scripts/fixtures/fake-appointment-site/appointment.html")).toString();
const startupShortcutPath = (): string => path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "RendezBot Agent.lnk");

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL Phase 5 (Lot 3): installateur, runtime embarque, cycle install/pairing/upgrade/uninstall ===");
  log("BOOT", "A executer sur un PC Windows personnel avec session interactive et Chrome installe. JAMAIS sur la VM.");

  if (process.platform !== "win32") {
    console.log("Plateforme non-Windows: ce test necessite Windows. Ignore, 0 succes / 0 echec.");
    process.exit(0);
    return;
  }

  // ===================== GARDE-FOU: jamais toucher une vraie installation =====================
  const existingKey = await regQueryString(UNINSTALL_KEY.replace(/^Software/, "Software"), "DisplayVersion");
  const realInstallDir = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "RendezBot Agent");
  if (existingKey || existsSync(realInstallDir)) {
    console.error(`[ABORT] Une installation reelle de RendezBot Agent est deja presente sur cette machine (cle registre: ${existingKey ?? "absente"}, dossier: ${existsSync(realInstallDir)}). Ce test refuse de continuer pour ne jamais toucher une vraie installation.`);
    process.exitCode = 1;
    return;
  }
  assert(true, "Garde-fou: aucune installation reelle preexistante detectee, le test peut continuer en securite");

  const root = path.resolve(process.cwd());
  let server: ServerHandle | undefined;
  let agent: RealAgentHandle | undefined;
  let agentSecond: RealAgentHandle | undefined;
  let browser: Browser | undefined;
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  const testDir = path.join(os.tmpdir(), `rendezbot-lot3-real-install-${RUN_SUFFIX}`);
  const dataRoot = path.join(os.tmpdir(), `rendezbot-lot3-real-data-${RUN_SUFFIX}`);
  const upgradeBuildDir = path.join(os.tmpdir(), `rendezbot-lot3-real-upgrade-build-${RUN_SUFFIX}`);
  let installerPath: string | null = null;
  let autostartCreated = false;

  try {
    // ===================== A. Build (runtime + installateur reel) =====================
    log("BUILD", "Construction du build complet (runtime + installateur, -SkipTests: regressions couvertes separement section 21)...");
    const build = await runPowerShell(["-File", "scripts/agent-package-win.ps1", "-SkipTests"]);
    if (build.code !== 0) throw new Error(`Le build agent a echoue (code ${build.code}).`);
    const appDir = path.join(root, "release", "agent-win", "app");
    const versionInfo = JSON.parse(readFileSync(path.join(root, "src", "agent", "agentVersionInfo.json"), "utf8"));
    installerPath = path.join(root, "release", "windows", `RendezBotAgentSetup-${versionInfo.agentVersion}.exe`);
    assert(existsSync(installerPath), "Scenario A: le VRAI installateur Inno Setup a bien ete produit par le build officiel");

    // ===================== B. Lancement sans Node sur le PATH (deja verifie au build, revalide ici sur l'artefact final) =====================
    const noNodeCheck = await new Promise<boolean>((resolve) => {
      const child = spawn(path.join(appDir, "RendezBotAgent.exe"), ["agent\\agentMain.js"], {
        cwd: appDir,
        env: { PATH: "", SystemRoot: process.env.SystemRoot ?? "", AGENT_DATA_DIR: path.join(os.tmpdir(), `rendezbot-lot3-nonode-${RUN_SUFFIX}`), AGENT_SERVER_URL: "http://127.0.0.1:1" },
        stdio: ["ignore", "ignore", "ignore"]
      });
      setTimeout(() => { const alive = child.exitCode === null; if (alive) child.kill(); resolve(alive); }, 2_500);
    });
    assert(noNodeCheck, "Scenario B: RendezBotAgent.exe demarre avec PATH vide (aucune dependance a un Node.js systeme)");

    // ===================== C/D. Premiere installation reelle (per-user, sans admin, autostart active) =====================
    const installCode = await runInstaller(installerPath, ["/VERYSILENT", "/SUPPRESSMSGBOXES", `/DIR=${testDir}`, "/MERGETASKS=!desktopicon,autostart", `/LOG=${path.join(os.tmpdir(), `rendezbot-lot3-install-log-${RUN_SUFFIX}.txt`)}`]);
    assert(installCode === 0, `Scenario C: premiere installation reelle reussie (code ${installCode})`);
    assert(existsSync(path.join(testDir, "RendezBotAgent.exe")), "Scenario D: RendezBotAgent.exe present dans le dossier installe");
    assert(!existsSync(path.join(testDir, "src")) && !existsSync(path.join(testDir, ".env")), "Scenario D: aucun fichier source/.env dans le dossier installe");
    autostartCreated = existsSync(startupShortcutPath());
    assert(autostartCreated, "Scenario L: la tache 'autostart' cree bien un raccourci dans le dossier Demarrage de l'utilisateur");

    // ===================== Serveur de test + agence/manager =====================
    server = await startServer(SERVER_PORT, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyName = `Test Lot3 Real ${RUN_SUFFIX}`;
    agencyNames.push(agencyName);
    const agencyId = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
    const managerLogin = `test-lot3-real-${RUN_SUFFIX}`;
    managerLogins.push(managerLogin);
    const userRes = await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, { agencyId, login: managerLogin, name: "Real Lot3 Manager", email: `${managerLogin}@example.test`, role: 1 });
    const managerPassword = userRes.body.temporaryPassword;
    const managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);

    // ===================== E/F. Demarrage de l'agent installe (jamais `node`), interface de pairing =====================
    agent = spawnPackagedAgent(testDir, server.baseUrl, dataRoot);
    await requireWithin(() => extractLocalUiPort(agent!.stdout) !== null, 10_000, "l'interface locale n'a jamais demarre (agent installe)");
    const port = extractLocalUiPort(agent.stdout)!;
    const status1 = await localUiStatus(port);
    assert(status1.state === "NOT_PAIRED", "Scenario E/F: premier lancement de l'agent installe -> NOT_PAIRED, interface de pairing disponible");

    // ===================== G/H. Appairage reel via l'interface locale + DPAPI =====================
    const pairing1 = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const pairResult = await localUiPost(port, "/local/pair", status1.nonce, { code: pairing1.body.pairing.code });
    assert(pairResult.status === 200 && pairResult.body.ok === true, "Scenario G: appairage reussi via l'interface locale (agent installe)");
    const credPath = path.join(dataRoot, "credentials", "agent-credentials.json");
    await requireWithin(() => existsSync(credPath), 5_000, "le fichier de credentials n'a jamais ete cree");
    const envelope = JSON.parse(readFileSync(credPath, "utf8"));
    assert(envelope.protection === "windows-dpapi-current-user" && !("token" in envelope), "Scenario H: credentials proteges par DPAPI, aucun token en clair");
    await requireWithin(async () => (await localUiStatus(port)).state === "CONNECTED", 10_000, "l'agent installe n'a jamais atteint CONNECTED apres appairage");

    // ===================== I/J. Redemarrage + reconnexion =====================
    await killTree(agent.child.pid);
    await sleep(1_000);
    agent = spawnPackagedAgent(testDir, server.baseUrl, dataRoot);
    await requireWithin(() => /Synchronisation terminee/.test(agent!.stdout.join("")), 15_000, "reconnexion automatique jamais atteinte apres redemarrage");
    assert(true, "Scenario I/J: redemarrage puis reconnexion automatique via DPAPI (agent installe)");
    const portAfterRestart = (await waitUntil(() => extractLocalUiPort(agent!.stdout) !== null, 5_000)) ? extractLocalUiPort(agent.stdout)! : port;

    // ===================== K. Mono-instance =====================
    agentSecond = spawnPackagedAgent(testDir, server.baseUrl, dataRoot);
    const secondExit = await new Promise<number | null>((resolve) => agentSecond!.child.on("exit", resolve));
    assert(secondExit === 0, "Scenario K: second lancement (meme dataRoot, agent installe) se termine avec le code 0");
    assert(/deja active/.test(agentSecond.stdout.join("")), "Scenario K: instance existante detectee (agent installe)");

    // ===================== M/N/O. START_BOT reel avec fixture locale, Chrome visible, STOP_BOT =====================
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginViaUi(page, server.baseUrl, managerLogin, managerPassword);
    await page.click("#agentSetupSkip").catch(() => undefined);
    await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
    await page.click('[data-page-target="bot"]');
    await page.waitForSelector("#page-bot.active");

    const chromeBaseline = await listChromeProcs();
    await startBotViaUi(page, "Bot Lot3 Real");
    await requireWithin(async () => (await stopButtonFor(page, "Bot Lot3 Real").count()) === 1, 20_000, "le bot n'a jamais atteint WAITING_FOR_USER (agent installe)");
    const chromeAfterStart = await listChromeProcs();
    assert(chromeAfterStart.length > chromeBaseline.length, "Scenario M/N: START_BOT reel lance un vrai Chrome visible depuis l'agent installe");

    await stopButtonFor(page, "Bot Lot3 Real").click();
    await requireWithin(async () => (await stopButtonFor(page, "Bot Lot3 Real").count()) === 0, 15_000, "STOP_BOT jamais confirme cote UI");
    const chromeAfterStop = await waitUntil(async () => (await listChromeProcs()).length <= chromeBaseline.length, 10_000);
    assert(chromeAfterStop, "Scenario O: STOP_BOT ferme reellement le Chrome ouvert par l'agent installe");

    await killTree(agent.child.pid);
    await sleep(500);

    // ===================== P/Q/R. Mise a niveau N -> N+1: identifiants et profils preserves =====================
    const isccPath = findIsccPath();
    if (!isccPath) {
      log("SKIP", "ISCC.exe introuvable: scenario de mise a niveau (P/Q/R) ignore sur cette machine (journalise, jamais un faux succes).");
    } else {
      const upgradeVersion = "9.9.9";
      const compileUpgrade = await runPowerShell(["-Command", `& '${isccPath}' '/DMyAppVersion=${upgradeVersion}' '/DSourceDir=${appDir}' '/O${upgradeBuildDir}' '/FUpgradeTest' 'scripts/agent-installer.iss'`]);
      if (compileUpgrade.code !== 0) throw new Error("Compilation de l'installateur de test (mise a niveau) a echoue.");
      const upgradeInstallerPath = path.join(upgradeBuildDir, "UpgradeTest.exe");

      const upgradeCode = await runInstaller(upgradeInstallerPath, ["/VERYSILENT", "/SUPPRESSMSGBOXES", `/DIR=${testDir}`, "/MERGETASKS=!desktopicon,autostart", `/LOG=${path.join(os.tmpdir(), `rendezbot-lot3-upgrade-log-${RUN_SUFFIX}.txt`)}`]);
      assert(upgradeCode === 0, `Scenario P: mise a niveau reelle reussie (code ${upgradeCode})`);
      const installedVersionAfterUpgrade = await regQueryString(UNINSTALL_KEY, "DisplayVersion");
      assert(installedVersionAfterUpgrade === upgradeVersion, `Scenario P: le registre reflete la nouvelle version apres mise a niveau (obtenu: ${installedVersionAfterUpgrade})`);
      assert(existsSync(credPath), "Scenario Q: le fichier de credentials DPAPI survit a la mise a niveau (dataRoot jamais touche par le remplacement des fichiers programme)");

      agent = spawnPackagedAgent(testDir, server.baseUrl, dataRoot);
      await requireWithin(() => /Synchronisation terminee/.test(agent!.stdout.join("")), 15_000, "reconnexion apres mise a niveau jamais atteinte (identifiants non preserves ?)");
      assert(true, "Scenario Q (suite): l'agent se reconnecte apres mise a niveau SANS nouveau code d'appairage");
      await killTree(agent.child.pid);
      await sleep(500);
      assert(existsSync(path.join(dataRoot, "profiles")), "Scenario R: le dossier de profils Chrome persiste apres mise a niveau");
    }

    // ===================== S/T. Desinstallation standard: dataRoot preserve =====================
    const uninstallLogPath = path.join(os.tmpdir(), `rendezbot-lot3-uninstall-log-${RUN_SUFFIX}.txt`);
    const uninstallerPath = path.join(testDir, "unins000.exe");
    const uninstallCode = await runInstaller(uninstallerPath, ["/VERYSILENT", "/SUPPRESSMSGBOXES", `/LOG=${uninstallLogPath}`]);
    assert(uninstallCode === 0, `Scenario S: desinstallation standard reussie sans blocage (code ${uninstallCode})`);
    await sleep(1_000);
    assert(!existsSync(testDir) || !existsSync(path.join(testDir, "RendezBotAgent.exe")), "Scenario S: les fichiers programme sont bien supprimes");
    assert(existsSync(dataRoot) && existsSync(credPath), "Scenario T: le dataRoot de test (isole) est intact apres desinstallation standard");
    const uninstallLog = existsSync(uninstallLogPath) ? readFileSync(uninstallLogPath, "utf8") : "";
    assert(!/RendezBot\\(credentials|config|logs|profiles|state)/.test(uninstallLog), "Scenario T: le journal de desinstallation standard ne mentionne JAMAIS le dossier de donnees RendezBot (jamais de DelTree hors suppression complete explicite)");
    assert(!existsSync(startupShortcutPath()), "Scenario Y (partiel): le raccourci de demarrage automatique est retire par la desinstallation standard");
    autostartCreated = false;

    // ===================== U. Reinstallation =====================
    const reinstallCode = await runInstaller(installerPath, ["/VERYSILENT", "/SUPPRESSMSGBOXES", `/DIR=${testDir}`, "/MERGETASKS=!desktopicon,!autostart", `/LOG=${path.join(os.tmpdir(), `rendezbot-lot3-reinstall-log-${RUN_SUFFIX}.txt`)}`]);
    assert(reinstallCode === 0, `Scenario U: reinstallation reussie (code ${reinstallCode})`);
    agent = spawnPackagedAgent(testDir, server.baseUrl, dataRoot);
    await requireWithin(() => /Synchronisation terminee/.test(agent!.stdout.join("")), 15_000, "reconnexion apres reinstallation jamais atteinte");
    assert(true, "Scenario U (suite): apres reinstallation, l'agent se reconnecte via les identifiants DPAPI preserves, sans nouveau code");

    log("INFO", "Scenarios V/W (suppression complete + suppression reelle du dataRoot) INTENTIONNELLEMENT ignores - voir commentaire d'en-tete: aucune isolation du dataRoot au niveau installateur, deferes a un test manuel sur VM/compte dedie (docs/phase5-test-plan.md).");
  } finally {
    // ===================== X/Y. Nettoyage complet: aucun process residuel, aucune entree de demarrage residuelle =====================
    await killTree(agent?.child.pid).catch(() => undefined);
    await killTree(agentSecond?.child.pid).catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    if (server) await killTree(server.child.pid).catch(() => undefined);

    if (existsSync(path.join(testDir, "unins000.exe"))) {
      await runInstaller(path.join(testDir, "unins000.exe"), ["/VERYSILENT", "/SUPPRESSMSGBOXES"]).catch(() => undefined);
      await sleep(1_000);
    }
    if (autostartCreated && existsSync(startupShortcutPath())) {
      try { rmSync(startupShortcutPath(), { force: true }); } catch { /* best effort */ }
    }
    for (const dir of [testDir, dataRoot, upgradeBuildDir]) {
      if (existsSync(dir)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    }

    const residualKey = await regQueryString(UNINSTALL_KEY, "DisplayVersion").catch(() => null);
    assert(!residualKey, "Scenario X (nettoyage): aucune cle de registre residuelle apres nettoyage final");
    assert(!existsSync(startupShortcutPath()), "Scenario Y (nettoyage): aucun raccourci de demarrage automatique residuel apres nettoyage final");

    try {
      if (managerLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [managerLogins]);
      if (agencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [agencyNames]);
    } catch (error) {
      log("CLEANUP-ERR", `Nettoyage base de donnees incomplet: ${error instanceof Error ? error.message : String(error)}`);
    }
    await pool.end().catch(() => undefined);
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
