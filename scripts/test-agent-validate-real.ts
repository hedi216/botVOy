// Test REEL Lot 3 (VALIDATE_BOT): lance le VRAI runtime src/agent/agentMain.ts,
// qui ouvre un VRAI Chrome visible sur CETTE machine, navigue reellement vers
// la fixture locale (jamais TLScontact), envoie une vraie commande
// VALIDATE_BOT et verifie le passage reel a MONITORING. A executer
// UNIQUEMENT sur un PC Windows personnel avec une session interactive et
// Google Chrome installe — JAMAIS sur la VM/serveur de production.
//
// Pour les scenarios sans Chrome reel (succes, PAGE_NOT_READY, doublon,
// isolation inter-agence, bot deja arrete), voir
// scripts/test-agent-validate-simulated.ts — celui-la peut tourner sans
// risque sur la VM.
//
// Usage: npx tsx scripts/test-agent-validate-real.ts
//    ou: npm run test:agent:validate:real

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

// Jamais un succes silencieux sur un depassement de delai (constraint 3 du
// Lot 3, deja appliquee au Lot 2): toute etape critique passe par ce helper,
// qui renvoie explicitement un booleau, jamais une exception avalee.
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

// Extrait le port CDP du vrai Chrome depuis les logs stdout du vrai agent
// (ligne "Connexion au Chrome deja ouvert: http://127.0.0.1:PORT", deja
// emise par src/shared/browser.ts): seul moyen, pour ce script de TEST
// uniquement, de retrouver un port choisi aleatoirement en interne par
// l'agent, sans exposer ce detail dans un quelconque contrat public.
const extractDebugPort = (agentStdout: string[]): number | null => {
  const joined = agentStdout.join("");
  const match = joined.match(/Connexion au Chrome deja ouvert: http:\/\/127\.0\.0\.1:(\d+)/);
  return match ? Number(match[1]) : null;
};

// Simule "l'utilisateur navigue manuellement" en se connectant una seconde
// fois (CDP supporte plusieurs clients) au MEME Chrome reel que l'agent
// pilote deja, et en navigant la page deja ouverte vers la fixture locale.
// Ne ferme JAMAIS ce second Browser (cf. Lot 2: browser.close() sur une
// connexion CDP ne fait que se deconnecter, mais par prudence on ne l'appelle
// meme pas ici pour ne jamais risquer de perturber la connexion de l'agent).
const navigateRealAgentBrowserTo = async (debugPort: number, targetUrl: string): Promise<void> => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  try {
    const context = browser.contexts()[0];
    const pages = context.pages().filter((p) => !p.isClosed() && !p.url().startsWith("devtools://"));
    const page = pages[0] ?? await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
  } finally {
    // Pas de browser.close(): deconnexion passive uniquement, jamais de
    // fermeture du Chrome reel partage avec l'agent.
  }
};

type RealAgentHandle = { child: ChildProcess; stdout: string[] };

const spawnRealAgent = (baseUrl: string, code: string, credPath: string, dataRoot: string, computerName: string): RealAgentHandle => {
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "src/agent/agentMain.ts", "pair", code], {
    env: {
      ...process.env,
      AGENT_SERVER_URL: baseUrl,
      AGENT_CREDENTIALS_PATH: credPath,
      AGENT_DATA_DIR: dataRoot,
      AGENT_COMPUTER_NAME: computerName,
      AGENT_TARGET_MODE: "fixture",
      AGENT_FIXTURE_URL: "about:blank"
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  const stdout: string[] = [];
  child.stdout?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("REAL-AGENT", t.trim()); });
  child.stderr?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("REAL-AGENT-ERR", t.trim()); });
  return { child, stdout };
};

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

const FIXTURE_APPOINTMENT_URL = pathToFileURL(
  path.resolve(process.cwd(), "scripts/fixtures/fake-appointment-site/appointment.html")
).toString();

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL Lot 3: VALIDATE_BOT avec vrai agent + vrai Chrome + fixture locale ===");
  log("BOOT", "A executer sur un PC Windows personnel avec session interactive. JAMAIS sur la VM.");

  let browser: Browser | undefined;
  let server: ServerHandle | undefined;
  let realAgent: RealAgentHandle | undefined;
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  const credPath = path.join(process.cwd(), `.test-validate-real-creds-${RUN_SUFFIX}.json`);
  const dataRoot = path.join(process.cwd(), `.test-validate-real-data-${RUN_SUFFIX}`);

  try {
    browser = await chromium.launch({ headless: true });
    server = await startServer(3273, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });

    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyName = `Test Validate Real ${RUN_SUFFIX}`;
    agencyNames.push(agencyName);
    const agencyId = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
    const managerLogin = `test-validate-real-${RUN_SUFFIX}`;
    managerLogins.push(managerLogin);
    const userRes = await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, {
      agencyId, login: managerLogin, name: "Real Manager", email: `${managerLogin}@example.test`, role: 1
    });
    const managerPassword = userRes.body.temporaryPassword;
    const managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);
    const pairing = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const code = pairing.body.pairing.code;

    const chromeBaseline = (await listChromeProcs()).map((p) => p.pid);

    realAgent = spawnRealAgent(server.baseUrl, code, credPath, dataRoot, "REAL-VALIDATE-PC");
    await sleep(2_000);

    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginViaUi(page, server.baseUrl, managerLogin, managerPassword);
      await page.click('#agentSetupSkip').catch(() => undefined);
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");

      // --- 1) START_BOT reel jusqu'a WAITING_FOR_USER ---
      log("TEST", "Emission reelle de START_BOT...");
      await startBotViaUi(page, "Bot Validate Real");
      const reachedWaiting = await waitUntil(async () => (await stopButtonFor(page, "Bot Validate Real").count()) === 1, 20_000);
      if (!reachedWaiting) throw new Error("TimeoutError: le bot n'a jamais atteint WAITING_FOR_USER (bouton Arreter jamais apparu).");
      assert(true, "START_BOT reel: Chrome ouvert, WAITING_FOR_USER atteint");

      const debugPort = await waitUntil(() => extractDebugPort(realAgent!.stdout) !== null, 5_000)
        ? extractDebugPort(realAgent.stdout)
        : null;
      if (!debugPort) throw new Error("TimeoutError: port de debogage Chrome introuvable dans les logs de l'agent.");
      assert(true, `Port de debogage Chrome identifie (${debugPort})`);

      // --- 2) navigation reelle vers la fixture locale (jamais TLScontact) ---
      log("TEST", `Navigation reelle du Chrome de l'agent vers la fixture locale (${FIXTURE_APPOINTMENT_URL})...`);
      await navigateRealAgentBrowserTo(debugPort, FIXTURE_APPOINTMENT_URL);
      await sleep(500);

      // --- 3) VALIDATE_BOT reel ---
      const validateButton = validateButtonFor(page, "Bot Validate Real");
      const hasValidate = await waitUntil(async () => (await validateButton.count()) === 1, 5_000);
      if (!hasValidate) throw new Error("TimeoutError: bouton Valider jamais visible avant l'envoi de VALIDATE_BOT.");
      await validateButton.click();

      const reachedMonitoring = await waitUntil(async () => {
        const text = await rowFor(page, "Bot Validate Real").innerText();
        return text.includes("COMPLETED") && text.toLowerCase().includes("surveillance");
      }, 15_000);
      if (!reachedMonitoring) throw new Error("TimeoutError: VALIDATE_BOT n'a jamais atteint MONITORING (page fixture non reconnue ?).");
      assert(true, "VALIDATE_BOT reel: MONITORING atteint (page fixture reconnue)");

      const rowText = await rowFor(page, "Bot Validate Real").innerText();
      assert(rowText.includes("COMPLETED"), "VALIDATE_BOT reel: status === COMPLETED");
      assert((await validateButtonFor(page, "Bot Validate Real").count()) === 0, "MONITORING: bouton Valider masque");
      assert((await stopButtonFor(page, "Bot Validate Real").count()) === 1, "MONITORING: bouton Arreter present");

      const commandId = (await requestJson(server.baseUrl, "GET", "/api/agent-commands?limit=10", managerCookie))
        .body.commands.find((c: any) => c.botName === "Bot Validate Real" && c.type === "VALIDATE_BOT")?.commandId;
      const restDetail = await requestJson(server.baseUrl, "GET", `/api/agent-commands/${commandId}`, managerCookie);
      assert(restDetail.body.command?.botStatus === "MONITORING", "GET /api/agent-commands/:id confirme botStatus=MONITORING");

      // --- 4) rechargement de l'interface ---
      log("TEST", "Rechargement de la page...");
      await page.reload();
      await page.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");
      const stillMonitoring = await waitUntil(async () => (await stopButtonFor(page, "Bot Validate Real").count()) === 1, 8_000);
      if (!stillMonitoring) throw new Error("TimeoutError: apres rechargement, MONITORING/Arreter non reconstruits.");
      assert(true, "Apres rechargement: MONITORING et bouton Arreter reconstruits depuis le serveur");
      assert((await validateButtonFor(page, "Bot Validate Real").count()) === 0, "Apres rechargement: bouton Valider toujours masque");

      // --- 5) STOP_BOT reel, verification fermeture Chrome ---
      log("TEST", "Clic reel sur Arreter...");
      await stopButtonFor(page, "Bot Validate Real").click({ timeout: 5_000 });
      const stopped = await waitUntil(async () => (await stopButtonFor(page, "Bot Validate Real").count()) === 0, 15_000);
      if (!stopped) throw new Error("TimeoutError: le bouton Arreter n'a jamais disparu apres STOP_BOT.");
      assert(true, "STOP_BOT reel: bouton Arreter disparu");

      const chromeAfterStart = await listChromeProcs();
      const newRoots = rootPids(chromeAfterStart).filter((pid) => !chromeBaseline.includes(pid));
      let stillAlive = newRoots;
      const orphanDeadline = Date.now() + 8_000;
      while (Date.now() < orphanDeadline) {
        const chromeNow = await listChromeProcs();
        stillAlive = newRoots.filter((pid) => chromeNow.some((c) => c.pid === pid));
        if (stillAlive.length === 0) break;
        await sleep(300);
      }
      assert(stillAlive.length === 0, "Le vrai Chrome est bien ferme apres STOP_BOT reel, aucun orphelin");

      await context.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert(false, `Sequence VALIDATE_BOT reelle interrompue (jamais presentee comme un succes): ${message}`);
    }

    // ===================== Scenario PAGE_NOT_READY reel =====================
    try {
      const context2 = await browser.newContext();
      const page2 = await context2.newPage();
      await loginViaUi(page2, server.baseUrl, managerLogin, managerPassword);
      await page2.click('#agentSetupSkip').catch(() => undefined);
      await page2.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
      await page2.click('[data-page-target="bot"]');
      await page2.waitForSelector("#page-bot.active");

      log("TEST", "Emission reelle de START_BOT (scenario PAGE_NOT_READY, Chrome reste sur about:blank)...");
      await startBotViaUi(page2, "Bot Page Not Ready Real");
      const reachedWaiting2 = await waitUntil(async () => (await stopButtonFor(page2, "Bot Page Not Ready Real").count()) === 1, 20_000);
      if (!reachedWaiting2) throw new Error("TimeoutError: le second bot n'a jamais atteint WAITING_FOR_USER.");
      assert(true, "Second bot reel: WAITING_FOR_USER atteint (Chrome reste sur about:blank, jamais navigue)");

      const validateButton2 = validateButtonFor(page2, "Bot Page Not Ready Real");
      await validateButton2.click();

      const failed = await waitUntil(async () => (await rowFor(page2, "Bot Page Not Ready Real").innerText()).toLowerCase().includes("pas prete"), 15_000);
      if (!failed) throw new Error("TimeoutError: VALIDATE_BOT n'a jamais echoue avec PAGE_NOT_READY sur about:blank.");
      assert(true, "VALIDATE_BOT reel sur about:blank echoue bien avec PAGE_NOT_READY");
      assert((await validateButtonFor(page2, "Bot Page Not Ready Real").count()) === 1, "PAGE_NOT_READY reel: bouton Valider toujours present");
      assert((await stopButtonFor(page2, "Bot Page Not Ready Real").count()) === 1, "PAGE_NOT_READY reel: bouton Arreter toujours present (Chrome reste ouvert)");

      // Nettoyage de ce second bot.
      await stopButtonFor(page2, "Bot Page Not Ready Real").click({ timeout: 5_000 });
      await waitUntil(async () => (await stopButtonFor(page2, "Bot Page Not Ready Real").count()) === 0, 15_000);

      await context2.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert(false, `Sequence PAGE_NOT_READY reelle interrompue (jamais presentee comme un succes): ${message}`);
    }
  } finally {
    // Nettoyage robuste (constraint 4): s'execute meme apres un TimeoutError.
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
