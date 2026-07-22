// Test REEL du cycle de vie botStatus: lance le VRAI runtime
// src/agent/agentMain.ts, qui ouvre un VRAI Chrome visible sur CETTE
// machine. A executer UNIQUEMENT sur un PC Windows personnel avec une
// session interactive et Google Chrome installe — JAMAIS sur la VM/serveur
// de production (l'agent doit toujours tourner sur le poste de l'agence,
// jamais a cote du serveur, cf. Phase 4).
//
// Pour les scenarios sans Chrome reel (course COMMAND_ACK/BOT_STATUS/
// COMMAND_COMPLETED, sequence complete avec agent simule, isolation
// inter-agence), voir scripts/test-agent-bot-status-simulated.ts — celui-la
// peut tourner sans risque sur la VM.
//
// Usage: npx tsx scripts/test-agent-bot-status-real.ts
//    ou: npm run test:agent:bot-status:real

import { ChildProcess, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
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

// waitUntil() renvoie explicitement un booleau (jamais une exception avalee):
// un appelant qui ignore la valeur de retour et enchaine quand meme sur une
// assertion directe du DOM obtient de toute facon un [FAIL] fidele si le
// delai est depasse. Aucune branche de ce script ne doit jamais transformer
// un depassement de delai en succes.
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

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL: vrai agent (src/agent/agentMain.ts) + vrai Chrome ===");
  log("BOOT", "A executer sur un PC Windows personnel avec session interactive. JAMAIS sur la VM.");

  let browser: Browser | undefined;
  let server: ServerHandle | undefined;
  let realAgent: ChildProcess | undefined;
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  const credPath = path.join(process.cwd(), `.test-botstatus-real-creds-${RUN_SUFFIX}.json`);
  const dataRoot = path.join(process.cwd(), `.test-botstatus-real-data-${RUN_SUFFIX}`);

  try {
    browser = await chromium.launch({ headless: true });
    server = await startServer(3272, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });

    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyName = `Test BotStatus Real ${RUN_SUFFIX}`;
    agencyNames.push(agencyName);
    const agencyId = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
    const managerLogin = `test-botstatus-real-${RUN_SUFFIX}`;
    managerLogins.push(managerLogin);
    const userRes = await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, {
      agencyId, login: managerLogin, name: "Real Manager", email: `${managerLogin}@example.test`, role: 1
    });
    const managerPassword = userRes.body.temporaryPassword;
    const managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);
    const pairing = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const code = pairing.body.pairing.code;

    const chromeBaseline = (await listChromeProcs()).map((p) => p.pid);

    realAgent = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "src/agent/agentMain.ts", "pair", code], {
      env: {
        ...process.env,
        AGENT_SERVER_URL: server.baseUrl,
        AGENT_CREDENTIALS_PATH: credPath,
        AGENT_DATA_DIR: dataRoot,
        AGENT_COMPUTER_NAME: "REAL-BOTSTATUS-PC",
        AGENT_TARGET_MODE: "fixture",
        AGENT_FIXTURE_URL: "about:blank"
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
    realAgent.stdout?.on("data", (c: Buffer) => log("REAL-AGENT", c.toString().trim()));
    realAgent.stderr?.on("data", (c: Buffer) => log("REAL-AGENT-ERR", c.toString().trim()));
    await sleep(2_000);

    // Sequence reelle demandee, entierement encapsulee: toute exception
    // (y compris un TimeoutError Playwright) est capturee et transformee en
    // echec explicite plutot que de faire planter le script silencieusement
    // ou de laisser une impression de succes.
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await loginViaUi(page, server.baseUrl, managerLogin, managerPassword);
      await page.click('#agentSetupSkip').catch(() => undefined);
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");

      log("TEST", "Emission reelle de START_BOT...");
      await startBotViaUi(page, "Bot Reel");

      const reachedCompleted = await waitUntil(async () => (await rowFor(page, "Bot Reel").innerText()).includes("COMPLETED"), 20_000);
      if (!reachedCompleted) {
        throw new Error("TimeoutError: START_BOT n'a jamais atteint COMPLETED dans le delai imparti (verifier que Chrome/Google Chrome est installe et qu'un vrai agent a bien pu se lancer).");
      }
      assert(true, "START_BOT reel atteint COMPLETED (Chrome reellement ouvert sur ce PC)");

      const rowText = await rowFor(page, "Bot Reel").innerText();
      assert(rowText.includes("COMPLETED"), "status === COMPLETED");

      const chromeAfterStart = await listChromeProcs();
      const newRoots = rootPids(chromeAfterStart).filter((pid) => !chromeBaseline.includes(pid));
      assert(newRoots.length === 1, `Un seul navigateur reel ouvert par l'agent (trouve: ${newRoots.length})`);

      const hasStop = await waitUntil(async () => (await stopButtonFor(page, "Bot Reel").count()) === 1, 8_000);
      if (!hasStop) {
        throw new Error("TimeoutError: le bouton Arreter n'est jamais apparu (botStatus=WAITING_FOR_USER non recu/affiche).");
      }
      assert(true, "botStatus=WAITING_FOR_USER apres COMPLETED: bouton Arreter visible");
      assert((await validateButtonFor(page, "Bot Reel").count()) === 1, "bouton Valider visible");

      const commandId = (await requestJson(server.baseUrl, "GET", "/api/agent-commands?limit=5", managerCookie))
        .body.commands.find((c: any) => c.botName === "Bot Reel")?.commandId;
      const restDetail = await requestJson(server.baseUrl, "GET", `/api/agent-commands/${commandId}`, managerCookie);
      assert(restDetail.body.command?.botStatus === "WAITING_FOR_USER", "GET /api/agent-commands/:id confirme botStatus=WAITING_FOR_USER");

      log("TEST", "Rechargement de la page...");
      await page.reload();
      await page.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
      await page.click('[data-page-target="bot"]');
      await page.waitForSelector("#page-bot.active");
      const stillThereAfterReload = await waitUntil(async () => (await stopButtonFor(page, "Bot Reel").count()) === 1, 8_000);
      if (!stillThereAfterReload) {
        throw new Error("TimeoutError: apres rechargement de la page, le bouton Arreter n'est pas revenu.");
      }
      assert(true, "Apres rechargement de la page, le bouton Arreter est toujours present");
      assert((await validateButtonFor(page, "Bot Reel").count()) === 1, "Apres rechargement de la page, le bouton Valider est toujours present");

      log("TEST", "Clic reel sur Arreter...");
      await stopButtonFor(page, "Bot Reel").click({ timeout: 5_000 });
      const buttonGone = await waitUntil(async () => (await stopButtonFor(page, "Bot Reel").count()) === 0, 15_000);
      if (!buttonGone) {
        throw new Error("TimeoutError: le bouton Arreter n'a jamais disparu apres le clic (STOP_BOT jamais complete).");
      }
      assert(true, "Apres clic reel sur Arreter, le bouton disparait (bot STOPPED)");

      let stillAlive = newRoots;
      const orphanDeadline = Date.now() + 8_000;
      while (Date.now() < orphanDeadline) {
        const chromeNow = await listChromeProcs();
        stillAlive = newRoots.filter((pid) => chromeNow.some((c) => c.pid === pid));
        if (stillAlive.length === 0) break;
        await sleep(300);
      }
      if (stillAlive.length > 0) {
        throw new Error(`TimeoutError: le chrome.exe reel n'a jamais disparu apres STOP_BOT (pids residuels: ${stillAlive.join(",")}).`);
      }
      assert(true, "Le vrai Chrome est bien ferme apres le clic reel sur Arreter, aucun orphelin");

      await context.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert(false, `Sequence reelle interrompue (jamais presentee comme un succes): ${message}`);
    }
  } finally {
    // Nettoyage robuste: doit s'executer meme apres un TimeoutError ou toute
    // autre exception plus haut. Chaque etape est independante des autres:
    // l'echec d'une etape de nettoyage ne doit jamais empecher les suivantes.
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    await killTree(realAgent?.pid).catch(() => undefined);
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
