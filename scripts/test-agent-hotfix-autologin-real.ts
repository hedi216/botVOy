// Test REEL cible - Hotfix Agent 0.1.1/0.1.2 (restauration du demarrage
// metier + correction "Invalid URL" depuis about:blank).
// Verifie, avec un FAUX site TLS local (jamais le vrai TLScontact) et un vrai
// agent + vrai Chrome :
// - Chrome demarre reellement sur about:blank (comme en production sans
//   configuration prealable), puis quitte about:blank grace a l'URL TLS de
//   depart (startUrl) transmise par le serveur via START_BOT ;
// - START_BOT (sans extension) ouvre reellement le faux login, remplit
//   identifiant/mot de passe automatiquement, atteint une fausse page
//   appointment-booking - sans jamais passer par WAITING_FOR_USER ;
// - aucun secret (login/mot de passe) n'apparait dans public_payload/
//   public_result en base, ni dans les logs serveur/agent ;
// - (regression 0.1.2) sans URL TLS de depart configuree cote serveur ET sans
//   extension locale, START_BOT est refuse immediatement (TLS_START_URL_INVALID,
//   jamais un Chrome ouvert pour rien) et "Invalid URL" n'apparait JAMAIS.
//
// A executer sur un PC Windows personnel avec une session interactive et
// Google Chrome installe - JAMAIS sur la VM/serveur de production.
//
// Usage: npx tsx scripts/test-agent-hotfix-autologin-real.ts
//    ou: npm run test:agent:hotfix-autologin:real

import { ChildProcess, spawn } from "node:child_process";
import http, { Server } from "node:http";
import { AddressInfo } from "node:net";
import { Browser, chromium } from "playwright";
import { Socket, io as ioClient } from "socket.io-client";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
const SERVER_PORT = 3330;
const FAKE_LOGIN = "TEST_SECRET_FAKE_LOGIN";
const FAKE_PASSWORD = "TEST_SECRET_FAKE_PASSWORD_123";

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 15_000, intervalMs = 300): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};
const requireWithin = async (predicate: () => Promise<boolean> | boolean, timeoutMs: number, description: string): Promise<void> => {
  if (!(await waitUntil(predicate, timeoutMs))) throw new Error(`TimeoutError: ${description}`);
};

// ===================== Faux site TLS local (jamais TLScontact reel) =====================
const HOME_HTML = `<!DOCTYPE html><html><body><h1>Faux site TLS (test uniquement)</h1></body></html>`;
// Soumission via un vrai POST HTML natif (jamais de JS cote client): retire
// toute incertitude liee au timing d'un ecouteur 'submit' - le navigateur
// gere lui-meme la navigation, de maniere fiable et deja bien testee, comme
// pour n'importe quel vrai formulaire. Les identifiants restent dans le
// corps POST (jamais dans l'URL), et ce serveur de test ne les lit/n'echo
// jamais nulle part - la reponse est identique quel que soit le contenu.
const LOGIN_HTML = `<!DOCTYPE html><html><body>
<form id="loginForm" action="/appointment-booking" method="post">
  <input id="username" type="text" />
  <input id="password" type="password" />
  <button id="btn-login" type="submit">Se connecter</button>
</form>
</body></html>`;
// Playwright isVisible() exige une boite englobante non vide: une div vide
// sans contenu s'effondre a une hauteur de 0px et serait consideree comme
// invisible (piege constate empiriquement - le marqueur etait bien present
// dans le DOM mais jamais "visible"). Un texte reel donne une hauteur non nulle.
const APPOINTMENT_HTML = `<!DOCTYPE html><html><body>
<div data-testid="fixture-appointment-page">Fausse page de rendez-vous (test uniquement)</div>
</body></html>`;

const startFakeTlsSite = (): Promise<{ server: Server; baseUrl: string }> => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url === "/" || url === "") { res.end(HOME_HTML); return; }
    if (url.startsWith("/fr-fr/login")) { res.end(LOGIN_HTML); return; }
    if (url.startsWith("/appointment-booking")) { res.end(APPOINTMENT_HTML); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/` });
  });
});

// ===================== Helpers serveur/HTTP (memes conventions que les autres tests reels) =====================
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
const killTree = (pid: number | undefined): Promise<void> => new Promise((resolve) => {
  if (!pid) { resolve(); return; }
  const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
  k.once("exit", () => resolve());
  k.once("error", () => resolve());
});
const requestJson = async (baseUrl: string, method: string, pathName: string, cookie: string | undefined, json?: unknown): Promise<any> => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(json ?? {}) } : {})
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, cookie: res.headers.get("set-cookie")?.split(";")[0] };
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
const spawnRealAgent = (serverUrl: string, dataRoot: string, computerName: string): RealAgentHandle => {
  const child = spawn("npx.cmd", ["tsx", "src/agent/agentMain.ts"], {
    env: {
      ...process.env,
      AGENT_SERVER_URL: serverUrl,
      AGENT_DATA_DIR: dataRoot,
      AGENT_COMPUTER_NAME: computerName,
      // Hotfix 0.1.2 (point 7): Chrome doit reellement demarrer sur
      // about:blank (comme en production sans configuration prealable) -
      // c'est desormais startUrl, transmis par le SERVEUR via START_BOT
      // (TARGET_URL cote serveur), qui doit faire quitter about:blank a
      // l'agent, jamais AGENT_FIXTURE_URL. Mode fixture conserve uniquement
      // pour que findAppointmentPage() utilise le detecteur fixture
      // (marqueur data-testid="fixture-appointment-page").
      AGENT_TARGET_MODE: "fixture",
      AGENT_FIXTURE_URL: "about:blank",
      AGENT_MAX_ACTIVE_BOTS: "5"
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true
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

const runPrimaryScenario = async (): Promise<void> => {
  log("BOOT", "=== Scenario 1: auto-connexion START_BOT reelle (Chrome quitte about:blank via startUrl) ===");

  let fakeSite: { server: Server; baseUrl: string } | undefined;
  let server: ServerHandle | undefined;
  let agent: RealAgentHandle | undefined;
  let browser: Browser | undefined;
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  const dataRoot = `.test-hotfix-autologin-data-${RUN_SUFFIX}`;

  try {
    fakeSite = await startFakeTlsSite();
    log("FIXTURE", `Faux site TLS local demarre: ${fakeSite.baseUrl}`);

    // Hotfix 0.1.2 (points 1-3): TARGET_URL cote serveur est la source de
    // l'URL TLS de depart (startUrl) transmise a START_BOT - jamais
    // AGENT_FIXTURE_URL cote agent pour cet usage desormais.
    server = await startServer(SERVER_PORT, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent", TARGET_URL: fakeSite.baseUrl });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyName = `Test Hotfix Autologin ${RUN_SUFFIX}`;
    agencyNames.push(agencyName);
    const agencyId = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
    const managerLogin = `test-hotfix-autologin-${RUN_SUFFIX}`;
    managerLogins.push(managerLogin);
    const userRes = await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, {
      agencyId, login: managerLogin, name: "Hotfix Manager", email: `${managerLogin}@example.test`, role: 1
    });
    const managerPassword = userRes.body.temporaryPassword;
    const managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);

    // ===================== Agent reel, appaire via l'interface locale =====================
    agent = spawnRealAgent(server.baseUrl, dataRoot, "REAL-HOTFIX-AUTOLOGIN-PC");
    await requireWithin(() => extractLocalUiPort(agent!.stdout) !== null, 10_000, "interface locale jamais demarree");
    const port = extractLocalUiPort(agent.stdout)!;
    const status1 = await localUiStatus(port);
    const pairing = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const pairResult = await localUiPost(port, "/local/pair", status1.nonce, { code: pairing.body.pairing.code });
    assert(pairResult.status === 200 && pairResult.body.ok === true, "Agent appaire reellement via l'interface locale");
    await requireWithin(async () => (await localUiStatus(port)).state === "CONNECTED", 10_000, "agent jamais CONNECTED");

    // ===================== START_BOT via le vrai formulaire web (login/mot de passe/categorie) =====================
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(server.baseUrl);
    await page.fill("#loginInput", managerLogin);
    await page.fill("#passwordInput", managerPassword);
    await page.click('#loginForm button[type="submit"]');
    await page.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
    await page.click("#agentSetupSkip").catch(() => undefined);
    await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
    await page.click('[data-page-target="bot"]');
    await page.waitForSelector("#page-bot.active");

    await page.fill("#botFormName", "Bot Hotfix Autologin");
    await page.selectOption("#botFormCategory", { index: 1 });
    await page.fill("#botFormLogin", FAKE_LOGIN);
    await page.fill("#botFormPassword", FAKE_PASSWORD);
    await page.click("#startBot");

    // ===================== Assertions metier =====================
    const rowFor = (text: string) => page.locator("#agentCommandsTableBody tr", { hasText: text });
    // Ne doit JAMAIS afficher le bouton "Valider" (= WAITING_FOR_USER) dans ce
    // scenario: la connexion automatique doit reussir seule sur le faux site.
    await requireWithin(
      async () => (await rowFor("Bot Hotfix Autologin").innerText().catch(() => "")).toLowerCase().includes("surveillance") || (await rowFor("Bot Hotfix Autologin").locator("button", { hasText: "Arreter" }).count()) === 1,
      60_000,
      "le bot n'a jamais atteint un etat de surveillance/actif apres START_BOT"
    );
    const rowText = await rowFor("Bot Hotfix Autologin").innerText();
    assert(!/valider/i.test(rowText) || (await rowFor("Bot Hotfix Autologin").locator("button", { hasText: "Valider" }).count()) === 0, "Aucun bouton 'Valider' necessaire: la connexion automatique a reussi seule (jamais de WAITING_FOR_USER abusif)");

    // ===================== Hotfix 0.1.2: Chrome a reellement quitte about:blank =====================
    const agentLogSoFar = agent.stdout.join("");
    assert(agentLogSoFar.includes("Navigation initiale vers l'URL TLS de depart reussie"), "Chrome a reellement quitte about:blank grace a l'URL TLS de depart (startUrl) transmise par le serveur");
    assert(!agentLogSoFar.includes("Invalid URL"), "Aucune erreur 'Invalid URL' (defaut 0.1.1 corrige): la navigation relative depuis about:blank n'est jamais tentee");

    const commandsRes = await requestJson(server.baseUrl, "GET", "/api/agent-commands", managerCookie);
    const startCommandVisible = Array.isArray(commandsRes.body.commands) && commandsRes.body.commands.some((c: any) => c.type === "START_BOT");
    assert(startCommandVisible, "La commande START_BOT est visible via l'API (jamais bloquee par le canal transient)");

    // ===================== Aucun secret en base (public_payload/public_result) =====================
    const { pool } = await import("../src/db.js");
    const dbRows = await pool.query(
      "SELECT public_payload, public_result FROM agent_commands WHERE agency_id = (SELECT id FROM agencies WHERE name = $1)",
      [agencyName]
    );
    const dbText = JSON.stringify(dbRows.rows);
    assert(!dbText.includes(FAKE_LOGIN) && !dbText.includes(FAKE_PASSWORD), "Aucun secret (login/mot de passe) dans public_payload/public_result en base");

    // ===================== Aucun secret dans les logs serveur/agent =====================
    const serverLogText = server.stdout.join("");
    const agentLogText = agent.stdout.join("");
    assert(!serverLogText.includes(FAKE_PASSWORD) && !agentLogText.includes(FAKE_PASSWORD), "Aucun secret (mot de passe) dans les logs serveur/agent");
    assert(!serverLogText.includes(FAKE_LOGIN) && !agentLogText.includes(FAKE_LOGIN), "Aucun secret (login) dans les logs serveur/agent");
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await killTree(agent?.child.pid).catch(() => undefined);
    if (server) await killTree(server.child.pid).catch(() => undefined);
    if (fakeSite) await new Promise<void>((resolve) => fakeSite!.server.close(() => resolve()));
    try {
      const { pool } = await import("../src/db.js");
      if (managerLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [managerLogins]);
      if (agencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [agencyNames]);
    } catch (error) {
      log("CLEANUP-ERR", `Nettoyage base de donnees incomplet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
};

// ===================== Scenario 2 (regression 0.1.2): aucune URL TLS de =====================
// depart configuree cote serveur (TARGET_URL absent) ET aucune extension
// locale - START_BOT doit etre refuse IMMEDIATEMENT (TLS_START_URL_INVALID),
// jamais un Chrome ouvert pour rien, et jamais la moindre trace de
// "Invalid URL" (point 8 du cahier des charges du hotfix 0.1.2: la
// regression explicite new URL("/fr-fr/login", "about:blank") ne doit jamais
// s'executer).
const REGRESSION_SERVER_PORT = 3331;

const openUiSocket = (baseUrl: string, cookie: string): Promise<Socket> => new Promise((resolve, reject) => {
  const s = ioClient(baseUrl, { autoConnect: false, reconnection: false, extraHeaders: { Cookie: cookie } });
  const t = setTimeout(() => reject(new Error("timeout ui socket")), 8_000);
  s.on("connect", () => { clearTimeout(t); resolve(s); });
  s.connect();
});

const runNoStartUrlRegressionScenario = async (): Promise<void> => {
  log("BOOT", "=== Scenario 2 (regression 0.1.2): sans startUrl ni extension, START_BOT refuse immediatement ===");

  let server: ServerHandle | undefined;
  let agent: RealAgentHandle | undefined;
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  const dataRoot = `.test-hotfix-noStartUrl-data-${RUN_SUFFIX}`;

  try {
    // TARGET_URL explicitement vide: force l'absence de configuration,
    // independamment de tout TARGET_URL ambiant deja present sur la machine
    // qui execute ce test (jamais un heritage accidentel de process.env).
    server = await startServer(REGRESSION_SERVER_PORT, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent", TARGET_URL: "" });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyName = `Test Hotfix NoStartUrl ${RUN_SUFFIX}`;
    agencyNames.push(agencyName);
    const agencyId = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
    const managerLogin = `test-hotfix-nostarturl-${RUN_SUFFIX}`;
    managerLogins.push(managerLogin);
    const userRes = await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, {
      agencyId, login: managerLogin, name: "NoStartUrl Manager", email: `${managerLogin}@example.test`, role: 1
    });
    const managerPassword = userRes.body.temporaryPassword;
    const managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);

    agent = spawnRealAgent(server.baseUrl, dataRoot, "REAL-HOTFIX-NOSTARTURL-PC");
    await requireWithin(() => extractLocalUiPort(agent!.stdout) !== null, 10_000, "interface locale jamais demarree");
    const port = extractLocalUiPort(agent.stdout)!;
    const status1 = await localUiStatus(port);
    const pairing = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const pairResult = await localUiPost(port, "/local/pair", status1.nonce, { code: pairing.body.pairing.code });
    assert(pairResult.status === 200 && pairResult.body.ok === true, "(regression) Agent appaire reellement via l'interface locale");
    await requireWithin(async () => (await localUiStatus(port)).state === "CONNECTED", 10_000, "(regression) agent jamais CONNECTED");

    const uiSocket = await openUiSocket(server.baseUrl, managerCookie);
    uiSocket.emit("start-bot", { botName: "Bot NoStartUrl", clientRequestId: `nostarturl-${RUN_SUFFIX}` });

    const failedFast = await waitUntil(async () => {
      const res = await requestJson(server.baseUrl, "GET", "/api/agent-commands?limit=5", managerCookie);
      const command = res.body?.commands?.find((c: any) => c.botName === "Bot NoStartUrl");
      return command?.status === "FAILED" && command?.errorCode === "TLS_START_URL_INVALID";
    }, 15_000);
    assert(failedFast, "(regression) START_BOT echoue immediatement avec TLS_START_URL_INVALID (jamais une boucle de plusieurs minutes)");

    const agentLogText = agent.stdout.join("");
    assert(!agentLogText.includes("demarre (Chrome visible"), "(regression) Chrome n'est jamais ouvert quand aucune URL TLS de depart n'est disponible");
    assert(!agentLogText.includes("Invalid URL"), "(regression) 'Invalid URL' n'apparait jamais, meme sans configuration TLS (garde defensive de navigateToLogin)");

    uiSocket.disconnect();
  } finally {
    await killTree(agent?.child.pid).catch(() => undefined);
    if (server) await killTree(server.child.pid).catch(() => undefined);
    try {
      const { pool } = await import("../src/db.js");
      if (managerLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [managerLogins]);
      if (agencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [agencyNames]);
    } catch (error) {
      log("CLEANUP-ERR", `Nettoyage base de donnees incomplet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
};

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL cible - Hotfix Agent 0.1.2 (correction 'Invalid URL' depuis about:blank) ===");

  if (process.platform !== "win32") {
    console.log("Plateforme non-Windows: ce test necessite Windows + Chrome. Ignore, 0 succes / 0 echec.");
    process.exit(0);
    return;
  }

  try {
    await runPrimaryScenario();
    await runNoStartUrlRegressionScenario();
  } finally {
    try {
      const { pool } = await import("../src/db.js");
      await pool.end();
    } catch (error) {
      log("CLEANUP-ERR", `Fermeture du pool DB incomplete: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
