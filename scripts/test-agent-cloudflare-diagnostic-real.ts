// Test REEL cible - Diagnostic Cloudflare (pool de profils persistants +
// sequence de navigation "une seule soumission par page/etat" + arret
// definitif sur blocage Cloudflare constate). Verifie, avec un FAUX site TLS
// local (jamais le vrai TLScontact) et un vrai agent + vrai Chrome :
// 1) deux lancements successifs reutilisent le meme profil persistant ;
// 2) deux bots simultanes utilisent deux profils differents ;
// 3) aucun secret (login/mot de passe) n'est ecrit dans les fichiers de
//    profil ni dans les logs ;
// 4) une meme page de login ne declenche jamais deux soumissions
//    automatiques ;
// 5) une page de blocage Cloudflare entraine WAITING_FOR_USER sans nouvel
//    essai automatique ;
// 6) le parcours normal conserve l'auto-login et peut atteindre
//    appointment-booking.
//
// A executer sur un PC Windows personnel avec une session interactive et
// Google Chrome installe - JAMAIS sur la VM/serveur de production.
//
// Usage: npx tsx scripts/test-agent-cloudflare-diagnostic-real.ts
//    ou: npm run test:agent:cloudflare-diagnostic:real

import { ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http, { Server } from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";
import { Socket, io as ioClient } from "socket.io-client";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
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

// ===================== Helpers serveur/HTTP/agent (memes conventions que test-agent-hotfix-autologin-real.ts) =====================

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
const spawnRealAgent = (serverUrl: string, dataRoot: string, computerName: string, extraEnv: Record<string, string> = {}): RealAgentHandle => {
  const child = spawn("npx.cmd", ["tsx", "src/agent/agentMain.ts"], {
    env: {
      ...process.env,
      AGENT_SERVER_URL: serverUrl,
      AGENT_DATA_DIR: dataRoot,
      AGENT_COMPUTER_NAME: computerName,
      AGENT_TARGET_MODE: "fixture",
      AGENT_FIXTURE_URL: "about:blank",
      AGENT_MAX_ACTIVE_BOTS: "5",
      ...extraEnv
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
const pairAgent = async (serverBaseUrl: string, managerCookie: string, agent: RealAgentHandle): Promise<number> => {
  await requireWithin(() => extractLocalUiPort(agent.stdout) !== null, 10_000, "interface locale jamais demarree");
  const port = extractLocalUiPort(agent.stdout)!;
  const status1 = await localUiStatus(port);
  const pairing = await requestJson(serverBaseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
  const pairResult = await localUiPost(port, "/local/pair", status1.nonce, { code: pairing.body.pairing.code });
  assert(pairResult.status === 200 && pairResult.body.ok === true, "Agent appaire reellement via l'interface locale");
  await requireWithin(async () => (await localUiStatus(port)).state === "CONNECTED", 10_000, "agent jamais CONNECTED");
  return port;
};

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];
const createAgencyAndManager = async (baseUrl: string, adminCookie: string, labelSuffix: string) => {
  const agencyName = `Test CloudflareDiag ${labelSuffix} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = agencyResult.body.agency.id;
  const managerLogin = `test-cfdiag-${labelSuffix.toLowerCase()}-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const userResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: `Manager ${labelSuffix}`, email: `${managerLogin}@example.test`, role: 1
  });
  return { agencyId, managerLogin, managerPassword: userResult.body.temporaryPassword as string };
};

// Demarre un bot via socket brut (comme le scenario "stress" de
// test-agent-bot-status-simulated.ts): pas besoin d'un vrai navigateur pour
// piloter le tableau de bord, seulement pour le bot lui-meme.
const openUiSocket = (baseUrl: string, cookie: string): Promise<Socket> => new Promise((resolve, reject) => {
  const s = ioClient(baseUrl, { autoConnect: false, reconnection: false, extraHeaders: { Cookie: cookie } });
  const t = setTimeout(() => reject(new Error("timeout ui socket")), 8_000);
  s.on("connect", () => { clearTimeout(t); resolve(s); });
  s.connect();
});
const startBot = async (uiSocket: Socket, botName: string): Promise<void> => {
  uiSocket.emit("start-bot", { botName, category: "test", login: FAKE_LOGIN, password: FAKE_PASSWORD, clientRequestId: `${botName}-${Date.now()}` });
};
const stopBotByName = async (baseUrl: string, managerCookie: string, uiSocket: Socket, botName: string): Promise<void> => {
  const res = await requestJson(baseUrl, "GET", "/api/agent-commands?limit=20", managerCookie);
  const command = res.body.commands.find((c: any) => c.botName === botName);
  if (!command) return;
  uiSocket.emit("stop-bot", { botId: command.botId, clientRequestId: `stop-${botName}-${Date.now()}` });
};
const botStatusFor = async (baseUrl: string, managerCookie: string, botName: string): Promise<string | null> => {
  const res = await requestJson(baseUrl, "GET", "/api/agent-commands?limit=20", managerCookie);
  const command = res.body.commands?.find((c: any) => c.botName === botName);
  return command?.botStatus ?? null;
};

// ===================== Fixture 1: site normal (login + appointment-booking) =====================

const NORMAL_HOME_HTML = `<!DOCTYPE html><html><body><h1>Faux site TLS (test uniquement)</h1></body></html>`;
const NORMAL_LOGIN_HTML = `<!DOCTYPE html><html><body>
<form id="loginForm" action="/appointment-booking" method="post">
  <input id="username" type="text" />
  <input id="password" type="password" />
  <button id="btn-login" type="submit">Se connecter</button>
</form>
</body></html>`;
const NORMAL_APPOINTMENT_HTML = `<!DOCTYPE html><html><body>
<div data-testid="fixture-appointment-page">Fausse page de rendez-vous (test uniquement)</div>
</body></html>`;

// Cookie explicite (jamais un secret - juste un marqueur de test greppable):
// permet de verifier concretement que les cookies survivent bien a la
// reutilisation d'un profil persistant (correctif final avant release,
// point 3: "les cookies du profil persistent toujours entre deux lancements").
const FIXTURE_COOKIE_NAME = "rendezbot_fixture_session";
const FIXTURE_COOKIE_VALUE = `fixture-cookie-${RUN_SUFFIX}`;

// Verification FONCTIONNELLE de la persistance (plutot qu'une inspection du
// fichier SQLite Cookies sur disque, dont le moment exact de vidage vers le
// disque par Chrome s'est revele opaque et peu fiable a observer depuis
// l'exterieur pendant ce diagnostic): ce qui compte reellement pour la
// confiance Cloudflare est que le cookie soit bien RENVOYE par le navigateur
// lors d'une requete ULTERIEURE - y compris apres un redemarrage complet de
// Chrome sur le meme profil. On enregistre donc chaque en-tete Cookie recu.
const receivedCookieHeaders: string[] = [];

const startNormalFakeSite = (): Promise<{ server: Server; baseUrl: string }> => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    receivedCookieHeaders.push(req.headers.cookie ?? "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Set-Cookie", `${FIXTURE_COOKIE_NAME}=${FIXTURE_COOKIE_VALUE}; Path=/; Max-Age=86400`);
    if (url === "/" || url === "") { res.end(NORMAL_HOME_HTML); return; }
    if (url.startsWith("/fr-fr/login")) { res.end(NORMAL_LOGIN_HTML); return; }
    if (url.startsWith("/appointment-booking")) { res.end(NORMAL_APPOINTMENT_HTML); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/` });
  });
});

// ===================== Fixture 2: page de login "coincee" (reste sur elle-meme apres soumission) =====================
// Simule une soumission qui n'aboutit jamais (site lent/casse): permet de
// verifier qu'une SEULE soumission automatique a bien lieu, jamais deux,
// meme apres plusieurs cycles de nouvelle tentative.

const STUCK_HOME_HTML = `<!DOCTYPE html><html><body><h1>Faux site TLS coince (test uniquement)</h1></body></html>`;
const STUCK_LOGIN_HTML = `<!DOCTYPE html><html><body>
<form id="loginForm" action="/fr-fr/login" method="post">
  <input id="username" type="text" />
  <input id="password" type="password" />
  <button id="btn-login" type="submit">Se connecter</button>
</form>
</body></html>`;

const startStuckFakeSite = (): Promise<{ server: Server; baseUrl: string; submissionCount: () => number }> => new Promise((resolve, reject) => {
  let submissionCount = 0;
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url === "/" || url === "") { res.end(STUCK_HOME_HTML); return; }
    if (url.startsWith("/fr-fr/login")) {
      if (req.method === "POST") { submissionCount += 1; }
      res.end(STUCK_LOGIN_HTML);
      return;
    }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/`, submissionCount: () => submissionCount });
  });
});

// ===================== Fixture 3: page de blocage Cloudflare =====================

const CLOUDFLARE_BLOCK_HTML = `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>
<h1>Sorry, you have been blocked</h1><p>You are unable to access this site.</p>
</body></html>`;

const startBlockedFakeSite = (): Promise<{ server: Server; baseUrl: string }> => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(CLOUDFLARE_BLOCK_HTML);
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/` });
  });
});

// ===================== Helper: aucun secret dans les fichiers de profil =====================

const findProfileDirs = (dataRoot: string): string[] => {
  const profilesRoot = path.join(dataRoot, "profiles");
  if (!existsSync(profilesRoot)) return [];
  return readdirSync(profilesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^profile-\d{2,}$/.test(entry.name))
    .map((entry) => path.join(profilesRoot, entry.name));
};

const grepDirForSecrets = (dirPath: string, secrets: string[]): string[] => {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      try {
        const content = readFileSync(full);
        const text = content.toString("latin1");
        for (const secret of secrets) {
          if (text.includes(secret)) found.push(`${full} contient "${secret}"`);
        }
      } catch { /* fichier illisible/verrouille: ignore */ }
    }
  };
  walk(dirPath);
  return found;
};

// ===================== Scenario A: reutilisation de profil + concurrence + parcours normal (tests 1, 2, 3, 6) =====================

const runProfileScenario = async (): Promise<void> => {
  log("SCENARIO-A", "=== Reutilisation de profil, deux bots simultanes, parcours normal ===");
  let fakeSite: { server: Server; baseUrl: string } | undefined;
  let server: ServerHandle | undefined;
  let agent: RealAgentHandle | undefined;
  const dataRoot = path.resolve(`.test-cfdiag-profile-data-${RUN_SUFFIX}`);

  try {
    fakeSite = await startNormalFakeSite();
    server = await startServer(3340, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent", TARGET_URL: fakeSite.baseUrl });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "A");
    const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);

    agent = spawnRealAgent(server.baseUrl, dataRoot, "REAL-CFDIAG-A-PC");
    await pairAgent(server.baseUrl, managerCookie, agent);
    const uiSocket = await openUiSocket(server.baseUrl, managerCookie);

    // ----- Bot 1: parcours normal (test 6) -----
    const cookieHeadersBeforeBot1 = receivedCookieHeaders.length;
    await startBot(uiSocket, "Bot CFDiag One");
    await requireWithin(
      async () => (await botStatusFor(server!.baseUrl, managerCookie, "Bot CFDiag One")) === "MONITORING",
      60_000,
      "Bot 1 n'a jamais atteint MONITORING (parcours normal/auto-login)"
    );
    assert(true, "6) Le parcours normal conserve l'auto-login et atteint appointment-booking/MONITORING");
    assert(receivedCookieHeaders.length > cookieHeadersBeforeBot1, "Bot 1 a bien envoye au moins une requete au faux site TLS (Set-Cookie recu)");

    const profilesAfterBot1 = findProfileDirs(dataRoot);
    assert(profilesAfterBot1.length === 1, `Un seul profil cree apres le premier bot (trouve: ${profilesAfterBot1.length})`);
    const profileUsedByBot1 = profilesAfterBot1[0];

    await stopBotByName(server.baseUrl, managerCookie, uiSocket, "Bot CFDiag One");
    await requireWithin(
      async () => (await botStatusFor(server!.baseUrl, managerCookie, "Bot CFDiag One")) === "STOPPED",
      15_000,
      "Bot 1 jamais STOPPED"
    );

    // ----- Bot 2: doit reutiliser le MEME profil (test 1) -----
    const cookieHeadersBeforeBot2 = receivedCookieHeaders.length;
    await startBot(uiSocket, "Bot CFDiag Two");
    await requireWithin(
      async () => (await botStatusFor(server!.baseUrl, managerCookie, "Bot CFDiag Two")) === "MONITORING",
      60_000,
      "Bot 2 n'a jamais atteint MONITORING"
    );
    const profilesAfterBot2 = findProfileDirs(dataRoot);
    assert(profilesAfterBot2.length === 1, `1) Toujours un seul profil apres le second bot (reutilisation, trouve: ${profilesAfterBot2.length})`);
    assert(profilesAfterBot2[0] === profileUsedByBot1, `1) Le second lancement reutilise exactement le meme profil persistant (${profileUsedByBot1})`);

    // Correctif final avant release (point 3): verification FONCTIONNELLE de
    // la persistance - Bot 2 (nouveau process Chrome, MEME profil reutilise)
    // doit RENVOYER le cookie fixe par Bot 1 des sa toute premiere requete.
    // Plus fiable qu'une inspection du fichier SQLite "Cookies" sur disque:
    // le moment exact ou Chrome y ecrit reellement s'est revele opaque et
    // peu fiable a observer depuis l'exterieur pendant ce diagnostic (ni une
    // fermeture propre - browser.close(), taskkill sans /F - ni une longue
    // attente ne garantissent d'y voir quoi que ce soit de facon fiable) -
    // alors que ce qui compte reellement pour la confiance Cloudflare est ce
    // comportement observable et fonctionnel, verifie ici directement.
    const bot2Requests = receivedCookieHeaders.slice(cookieHeadersBeforeBot2);
    const bot2SentFixtureCookie = bot2Requests.some((header) => header.includes(FIXTURE_COOKIE_NAME));
    assert(bot2SentFixtureCookie, "Correctif final: le cookie du faux site TLS est bien renvoye par Bot 2 (meme profil reutilise) - persistance confirmee fonctionnellement");

    await stopBotByName(server.baseUrl, managerCookie, uiSocket, "Bot CFDiag Two");
    await requireWithin(
      async () => (await botStatusFor(server!.baseUrl, managerCookie, "Bot CFDiag Two")) === "STOPPED",
      15_000,
      "Bot 2 jamais STOPPED"
    );

    // ----- Bot 3 + Bot 4 simultanes: deux profils distincts (test 2), avec de VRAIS Chrome -----
    await Promise.all([startBot(uiSocket, "Bot CFDiag Three"), startBot(uiSocket, "Bot CFDiag Four")]);
    await requireWithin(
      async () => (await botStatusFor(server!.baseUrl, managerCookie, "Bot CFDiag Three")) === "MONITORING"
        && (await botStatusFor(server!.baseUrl, managerCookie, "Bot CFDiag Four")) === "MONITORING",
      60_000,
      "Bots 3 et 4 n'ont jamais tous les deux atteint MONITORING simultanement"
    );
    const profilesAfterConcurrent = findProfileDirs(dataRoot);
    assert(profilesAfterConcurrent.length === 2, `2) Exactement deux profils distincts pour deux bots simultanes (trouve: ${profilesAfterConcurrent.length})`);

    await stopBotByName(server.baseUrl, managerCookie, uiSocket, "Bot CFDiag Three");
    await stopBotByName(server.baseUrl, managerCookie, uiSocket, "Bot CFDiag Four");
    await requireWithin(
      async () => (await botStatusFor(server!.baseUrl, managerCookie, "Bot CFDiag Three")) === "STOPPED"
        && (await botStatusFor(server!.baseUrl, managerCookie, "Bot CFDiag Four")) === "STOPPED",
      15_000,
      "Bots 3/4 jamais STOPPED"
    );

    // ----- Test 3 (partiel): aucun secret dans les fichiers de profil -----
    const secretsInProfiles = grepDirForSecrets(dataRoot, [FAKE_LOGIN, FAKE_PASSWORD]);
    assert(secretsInProfiles.length === 0, `3) Aucun secret trouve dans les fichiers de profil (trouve: ${secretsInProfiles.join(" | ") || "aucun"})`);
    const agentLogText = agent.stdout.join("");
    const serverLogText = server.stdout.join("");
    assert(!agentLogText.includes(FAKE_LOGIN) && !agentLogText.includes(FAKE_PASSWORD), "3) Aucun secret dans les logs agent");
    assert(!serverLogText.includes(FAKE_LOGIN) && !serverLogText.includes(FAKE_PASSWORD), "3) Aucun secret dans les logs serveur");

    uiSocket.disconnect();
  } finally {
    await killTree(agent?.child.pid).catch(() => undefined);
    if (server) await killTree(server.child.pid).catch(() => undefined);
    if (fakeSite) await new Promise<void>((resolve) => fakeSite!.server.close(() => resolve()));
    try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
};

// ===================== Scenario B: une seule soumission par page/etat (test 4) =====================

const runStuckSubmissionScenario = async (): Promise<void> => {
  log("SCENARIO-B", "=== Une meme page de login ne declenche jamais deux soumissions automatiques ===");
  let fakeSite: { server: Server; baseUrl: string; submissionCount: () => number } | undefined;
  let server: ServerHandle | undefined;
  let agent: RealAgentHandle | undefined;
  const dataRoot = path.resolve(`.test-cfdiag-stuck-data-${RUN_SUFFIX}`);

  try {
    fakeSite = await startStuckFakeSite();
    server = await startServer(3341, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent", TARGET_URL: fakeSite.baseUrl });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "B");
    const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);

    // Cadence acceleree: seul le comportement "une soumission par page" est
    // teste ici, jamais la duree reelle de production.
    agent = spawnRealAgent(server.baseUrl, dataRoot, "REAL-CFDIAG-B-PC", {
      AGENT_AUTO_NAV_RETRY_INTERVAL_MS: "1000",
      AGENT_AUTO_NAV_LONG_WAIT_MS: "1000"
    });
    await pairAgent(server.baseUrl, managerCookie, agent);
    const uiSocket = await openUiSocket(server.baseUrl, managerCookie);

    await startBot(uiSocket, "Bot CFDiag Stuck");
    // La toute premiere tentative traverse quand meme la sequence complete
    // de reglages (waitForAppointmentPageOrTimeout apres chaque etape:
    // ~8s+8s + jusqu'a 10s d'attente interne de clickBookNewAppointment +
    // 8s ~= 34s) avant que la garde "une seule soumission" ne rende les
    // tentatives suivantes quasi instantanees - delai large pour absorber
    // cette premiere tentative en toute fiabilite.
    await requireWithin(
      async () => (await botStatusFor(server!.baseUrl, managerCookie, "Bot CFDiag Stuck")) === "WAITING_FOR_USER",
      75_000,
      "Bot bloque sur la meme page n'a jamais atteint WAITING_FOR_USER apres epuisement des tentatives"
    );

    assert(fakeSite.submissionCount() === 1, `4) Le formulaire de connexion n'est soumis qu'une seule fois malgre plusieurs tentatives (trouve: ${fakeSite.submissionCount()} soumission(s))`);

    uiSocket.disconnect();
  } finally {
    await killTree(agent?.child.pid).catch(() => undefined);
    if (server) await killTree(server.child.pid).catch(() => undefined);
    if (fakeSite) await new Promise<void>((resolve) => fakeSite!.server.close(() => resolve()));
    try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
};

// ===================== Scenario C: blocage Cloudflare -> WAITING_FOR_USER sans retry (test 5) =====================

const runCloudflareBlockedScenario = async (): Promise<void> => {
  log("SCENARIO-C", "=== Page de blocage Cloudflare: WAITING_FOR_USER sans nouvel essai automatique ===");
  let fakeSite: { server: Server; baseUrl: string } | undefined;
  let server: ServerHandle | undefined;
  let agent: RealAgentHandle | undefined;
  const dataRoot = path.resolve(`.test-cfdiag-blocked-data-${RUN_SUFFIX}`);

  try {
    fakeSite = await startBlockedFakeSite();
    server = await startServer(3342, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent", TARGET_URL: fakeSite.baseUrl });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "C");
    const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);

    agent = spawnRealAgent(server.baseUrl, dataRoot, "REAL-CFDIAG-C-PC");
    await pairAgent(server.baseUrl, managerCookie, agent);
    const uiSocket = await openUiSocket(server.baseUrl, managerCookie);

    const startedAt = Date.now();
    await startBot(uiSocket, "Bot CFDiag Blocked");
    await requireWithin(
      async () => (await botStatusFor(server!.baseUrl, managerCookie, "Bot CFDiag Blocked")) === "WAITING_FOR_USER",
      30_000,
      "Bot bloque par Cloudflare n'a jamais atteint WAITING_FOR_USER"
    );
    const elapsedMs = Date.now() - startedAt;

    // Sans le correctif, l'escalade passerait par 3 tentatives + une longue
    // attente (AGENT_AUTO_NAV_LONG_WAIT_MS, plusieurs minutes par defaut)
    // avant WAITING_FOR_USER. Un blocage Cloudflare doit au contraire
    // interrompre les tentatives des le premier constat - bien avant cette
    // longue attente.
    assert(elapsedMs < 20_000, `5) WAITING_FOR_USER atteint rapidement apres un blocage Cloudflare, sans attendre la longue pause de nouvel essai (${elapsedMs}ms)`);

    const agentLogText = agent.stdout.join("");
    assert(agentLogText.includes("Blocage Cloudflare constate") || agentLogText.includes("blocage Cloudflare detectee"), "5) Le blocage Cloudflare est bien detecte et journalise");
    assert(!/tentatives sans page de rendez-vous. Attente de/.test(agentLogText), "5) Aucune longue attente de nouvel essai n'est jamais entamee apres un blocage Cloudflare");

    uiSocket.disconnect();
  } finally {
    await killTree(agent?.child.pid).catch(() => undefined);
    if (server) await killTree(server.child.pid).catch(() => undefined);
    if (fakeSite) await new Promise<void>((resolve) => fakeSite!.server.close(() => resolve()));
    try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
};

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL cible - Diagnostic Cloudflare (profils + sequence de navigation) ===");

  if (process.platform !== "win32") {
    console.log("Plateforme non-Windows: ce test necessite Windows + Chrome. Ignore, 0 succes / 0 echec.");
    process.exit(0);
    return;
  }

  try {
    await runProfileScenario();
    await runStuckSubmissionScenario();
    await runCloudflareBlockedScenario();
  } finally {
    try {
      const { pool } = await import("../src/db.js");
      if (createdUserLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
      if (createdAgencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
      await pool.end();
    } catch (error) {
      log("CLEANUP-ERR", `Nettoyage base de donnees incomplet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
