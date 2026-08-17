// Test REEL cible - Hotfix Agent 0.1.9 (agent bloque sur la page d'accueil
// TLS malgre un lien "Se connecter" reel et cliquable, confirme par DevTools
// en conditions reelles).
//
// Cause reelle identifiee (analyse de code, confirmee ici par un faux site
// local reproduisant fidelement le symptome):
//
//   1. src/shared/loginFlow.ts (navigateToLogin, dans clickSeConnecter):
//      declarait un succes des que page.goto("/fr-fr/login") ne levait
//      aucune exception - sans jamais verifier que la navigation avait
//      REELLEMENT atteint une page de connexion. Or une navigation DIRECTE
//      (page.goto, sans Referer - jamais envoye par un goto() programmatique,
//      toujours envoye par un vrai clic sur un lien) peut tres bien
//      "reussir" techniquement tout en etant silencieusement renvoyee vers la
//      page d'origine par le site (garde anti-bot/SPA cote serveur) -
//      Playwright suit cette redirection sans jamais la signaler comme une
//      erreur. clickSeConnecter() se croyait donc deja reussi via ce seul
//      chemin et n'essayait JAMAIS le clic direct sur le vrai lien (pourtant
//      present et fonctionnel d'apres DevTools).
//   2. src/agent/agentBotManager.ts (dispatchOnState): le resultat de
//      clickSeConnecter() etait de toute facon ignore
//      (.catch(() => false) puis jamais lu) - meme un echec reel aurait ete
//      rapporte comme "attempted" au meme titre qu'un succes, sans jamais
//      journaliser la vraie cause, et sans jamais attendre autre chose que
//      la page de rendez-vous finale.
//
// Corrige ici (aucune modification du mapping profils/comptes, HMAC/DPAPI,
// monitoring, ou serveur):
//   - navigateToLogin() verifie desormais l'etat REELLEMENT atteint apres le
//     goto avant de declarer un succes ;
//   - dispatchOnState() lit et journalise le resultat reel de
//     clickSeConnecter() (URL avant/apres, connected=true/false), n'accepte
//     jamais un succes suppose, et attend explicitement une etape TLS
//     reconnue (login/auth/travel-groups/service-level/application-summary/
//     appointment-booking) apres un clic reellement execute - jamais
//     uniquement l'arrivee finale sur la page de rendez-vous ;
//   - un diagnostic non sensible (nombre d'onglets, URL masquees,
//     page.isClosed(), quel onglet est handle.page) est journalise avant la
//     toute premiere action de chaque tentative.
//
// Scenario A (reproduction fidele du defaut confirme en reel): la page
// d'accueil expose exactement le lien confirme par DevTools
// (<a href="/fr-fr/login"><div id="login">SE CONNECTER</div></a>).
// /fr-fr/login renvoie silencieusement vers "/" pour toute requete SANS
// en-tete Referer (simulation realiste d'une garde anti-bot: un
// page.goto() programmatique n'envoie jamais de Referer, un vrai clic sur un
// lien en envoie toujours un) mais sert le vrai formulaire de connexion des
// qu'un Referer est present - exactement ce qui distingue un goto() direct
// d'un vrai clic. Verifie que l'agent recupere via le clic direct (jamais
// via une fausse victoire de navigateToLogin) et atteint appointment-booking.
//
// Scenario B (complementaire): AUCUN element cliquable disponible sur la
// page d'accueil (defaillance totale - cf. ticket: "ne pars pas du principe
// que le selecteur manque", teste ici uniquement pour verifier que le
// diagnostic reste honnete meme dans ce cas de figure different). Verifie
// que clickSeConnecter() echoue reellement (connected=false), que la vraie
// cause apparait dans les logs locaux de l'agent, que le workflow ne pretend
// jamais un succes, et que l'agent finit par WAITING_FOR_USER sans boucle
// agressive (nombre borne de tentatives).
//
// A executer sur un PC Windows personnel avec une session interactive et
// Google Chrome installe - JAMAIS sur la VM/serveur de production.
//
// Usage: npx tsx scripts/test-agent-hotfix-home-login-real.ts
//    ou: npm run test:agent:hotfix-home-login:real

import { ChildProcess, execSync, spawn } from "node:child_process";
import http, { Server, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { Browser, chromium } from "playwright";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
const FAKE_LOGIN = "TEST_SECRET_FAKE_LOGIN_HOMELOGIN";
const FAKE_PASSWORD = "TEST_SECRET_FAKE_PASSWORD_HOMELOGIN_123";

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
// Reprend EXACTEMENT le balisage confirme par DevTools en reel (cf. ticket).
// HOTFIX CIBLE 0.2.0 (deuxieme defaut trouve en reel via ce meme scenario):
// reproduit le header/nav PERSISTANT reel de TLScontact (visible sur la
// capture d'ecran fournie), qui contient litteralement le libelle "Services
// additionnels" en tant qu'item de menu - sur TOUTES les pages du site, y
// compris la page d'accueil elle-meme. isServiceLevelPage() (repli par
// contenu) testait alors TOUT <body> et confondait ce nav avec une vraie
// etape "services additionnels", empechant clickSeConnecter d'etre jamais
// tente (defaut confirme en reel: bot bloque, Chrome ne bouge plus).
const HOME_HTML_WITH_REAL_LINK = `<!DOCTYPE html><html><body>
<nav>
  <a href="/">Accueil</a>
  <a href="/fr-fr/demarches">Demarches a suivre</a>
  <a href="/fr-fr/services-additionnels">Services additionnels</a>
  <a href="/fr-fr/faq">FAQ</a>
</nav>
<a href="/fr-fr/login">
    <div id="login">SE CONNECTER</div>
</a>
</body></html>`;
// Scenario B: aucun element cliquable correspondant a l'un des selecteurs de
// clickSeConnecter (lien direct, menu deroulant, repli par role/texte).
const HOME_HTML_NO_CLICKABLE_ELEMENT = `<!DOCTYPE html><html><body>
<h1>Page d'accueil (test) - aucun element de connexion disponible</h1>
</body></html>`;
const LOGIN_HTML = `<!DOCTYPE html><html><body>
<form id="loginForm" action="/appointment-booking" method="post">
  <input id="username" type="text" />
  <input id="password" type="password" />
  <button id="btn-login" type="submit">Se connecter</button>
</form>
</body></html>`;
const APPOINTMENT_HTML = `<!DOCTYPE html><html><body>
<div data-testid="fixture-appointment-page">Fausse page de rendez-vous (test uniquement)</div>
</body></html>`;

type LoginRouteBehavior = "bounce-without-referer" | "always-bounce";

const startFakeTlsSite = (
  homeHtml: string,
  loginBehavior: LoginRouteBehavior
): Promise<{ server: Server; baseUrl: string; loginRequestCount: () => number }> => new Promise((resolve, reject) => {
  let loginRequests = 0;
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url === "/" || url === "") { res.end(homeHtml); return; }
    if (url.startsWith("/fr-fr/login")) {
      loginRequests += 1;
      const hasReferer = Boolean(req.headers.referer);
      const mustBounce = loginBehavior === "always-bounce" || (loginBehavior === "bounce-without-referer" && !hasReferer);
      if (mustBounce) {
        // Simule une garde anti-bot reelle: une navigation SANS Referer
        // (page.goto() programmatique) est renvoyee silencieusement vers la
        // page d'origine, jamais signalee comme une erreur HTTP.
        res.statusCode = 302;
        res.setHeader("Location", "/");
        res.end();
        return;
      }
      res.end(LOGIN_HTML);
      return;
    }
    if (url.startsWith("/appointment-booking")) { res.end(APPOINTMENT_HTML); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/`, loginRequestCount: () => loginRequests });
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
      AGENT_TARGET_MODE: "fixture",
      AGENT_FIXTURE_URL: "about:blank",
      AGENT_MAX_ACTIVE_BOTS: "5",
      // Cadence acceleree pour ce test uniquement (meme convention que les
      // autres tests reels de ce depot) - jamais les delais de production
      // (plusieurs minutes) qui rendraient ce test cible ingerable.
      AGENT_AUTO_NAV_RETRY_INTERVAL_MS: "500",
      AGENT_AUTO_NAV_LONG_WAIT_MS: "500"
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

type SetupResult = {
  fakeSite: { server: Server; baseUrl: string; loginRequestCount: () => number };
  server: ServerHandle;
  agent: RealAgentHandle;
  port: number;
  managerLogin: string;
  managerPassword: string;
  managerCookie: string;
  agencyName: string;
  dataRoot: string;
};

const setupServerAndAgent = async (
  serverPort: number,
  homeHtml: string,
  loginBehavior: LoginRouteBehavior,
  namePrefix: string,
  managerLogins: string[],
  agencyNames: string[]
): Promise<SetupResult> => {
  const fakeSite = await startFakeTlsSite(homeHtml, loginBehavior);
  log("FIXTURE", `Faux site TLS local demarre (${namePrefix}): ${fakeSite.baseUrl}`);

  const server = await startServer(serverPort, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent", TARGET_URL: fakeSite.baseUrl });
  const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const agencyName = `Test ${namePrefix} ${RUN_SUFFIX}`;
  agencyNames.push(agencyName);
  const agencyId = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
  const managerLogin = `test-${namePrefix.toLowerCase()}-${RUN_SUFFIX}`;
  managerLogins.push(managerLogin);
  const userRes = await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: `${namePrefix} Manager`, email: `${managerLogin}@example.test`, role: 1
  });
  const managerPassword = userRes.body.temporaryPassword;
  const managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);

  const dataRoot = `.test-hotfix-homelogin-${namePrefix}-${RUN_SUFFIX}`;
  const agent = spawnRealAgent(server.baseUrl, dataRoot, `REAL-HOTFIX-HOMELOGIN-${namePrefix}-PC`);
  await requireWithin(() => extractLocalUiPort(agent.stdout) !== null, 10_000, "interface locale jamais demarree");
  const port = extractLocalUiPort(agent.stdout)!;
  const status1 = await localUiStatus(port);
  const pairing = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
  const pairResult = await localUiPost(port, "/local/pair", status1.nonce, { code: pairing.body.pairing.code });
  assert(pairResult.status === 200 && pairResult.body.ok === true, `(${namePrefix}) Agent appaire reellement via l'interface locale`);
  await requireWithin(async () => (await localUiStatus(port)).state === "CONNECTED", 10_000, `(${namePrefix}) agent jamais CONNECTED`);

  return { fakeSite, server, agent, port, managerLogin, managerPassword, managerCookie, agencyName, dataRoot };
};

const removeDataRootWithRetry = async (dataRoot: string): Promise<void> => {
  const { rmSync } = await import("node:fs");
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try { rmSync(dataRoot, { recursive: true, force: true }); return; } catch { if (attempt < 5) await sleep(300); }
  }
};

const startBotViaWebUi = async (browser: Browser, serverBaseUrl: string, managerLogin: string, managerPassword: string, botName: string): Promise<import("playwright").Page> => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(serverBaseUrl);
  await page.fill("#loginInput", managerLogin);
  await page.fill("#passwordInput", managerPassword);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
  await page.click("#agentSetupSkip").catch(() => undefined);
  await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
  await page.click('[data-page-target="bot"]');
  await page.waitForSelector("#page-bot.active");

  await page.fill("#botFormName", botName);
  await page.selectOption("#botFormCategory", { index: 1 });
  await page.fill("#botFormLogin", FAKE_LOGIN);
  await page.fill("#botFormPassword", FAKE_PASSWORD);
  await page.click("#startBot");
  return page;
};

const cleanupAgencyAndUsers = async (managerLogins: string[], agencyNames: string[]): Promise<void> => {
  try {
    const { pool } = await import("../src/db.js");
    if (managerLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [managerLogins]);
    if (agencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [agencyNames]);
  } catch (error) {
    log("CLEANUP-ERR", `Nettoyage base de donnees incomplet: ${error instanceof Error ? error.message : String(error)}`);
  }
};

// ===================== Scenario A: reproduction fidele du defaut confirme en reel =====================
// Home (lien reel confirme par DevTools) -> goto direct bloque silencieusement
// (sans Referer, defaut reel) -> repli sur le clic reel (avec Referer) ->
// /fr-fr/login -> formulaire rempli -> appointment-booking.
const SCENARIO_A_PORT = 3340;
const BOT_NAME_A = "Bot HomeLogin A";

const runScenarioA = async (): Promise<void> => {
  log("BOOT", "=== Scenario A: home -> login (repli sur le clic reel apres un goto direct bloque) -> appointment-booking ===");

  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  let setup: SetupResult | undefined;
  let browser: Browser | undefined;

  try {
    setup = await setupServerAndAgent(SCENARIO_A_PORT, HOME_HTML_WITH_REAL_LINK, "bounce-without-referer", "HomeLoginA", managerLogins, agencyNames);

    browser = await chromium.launch({ headless: true });
    const uiPage = await startBotViaWebUi(browser, setup.server.baseUrl, setup.managerLogin, setup.managerPassword, BOT_NAME_A);
    const rowFor = (text: string) => uiPage.locator("#agentCommandsTableBody tr", { hasText: text });

    // ----- Test 1/6: la page d'accueil est bien atteinte, puis 6: le bot atteint appointment-booking (surveillance), jamais WAITING_FOR_USER -----
    await requireWithin(
      async () => (await rowFor(BOT_NAME_A).innerText().catch(() => "")).toLowerCase().includes("surveillance"),
      60_000,
      "1/6) le bot n'a jamais atteint la surveillance (appointment-booking) apres START_BOT"
    );
    const rowText = await rowFor(BOT_NAME_A).innerText();
    assert(!/valider/i.test(rowText), "6) Aucun 'Valider' (WAITING_FOR_USER) necessaire: la recuperation home->login->appointment-booking a reussi seule");

    const agentLogText = setup.agent.stdout.join("");

    // ----- Test 1: home atteinte -----
    assert(agentLogText.includes("Diagnostic pages pilotees avant premiere action"), "1) Diagnostic de la page pilotee journalise avant la premiere action (home atteinte, contexte inspecte)");

    // ----- Test 1bis (regression, defaut trouve en reel apres deploiement du
    // premier correctif): le nav persistant de la page d'accueil contient
    // litteralement "Services additionnels" (menu du vrai site) - isServiceLevelPage()
    // ne doit JAMAIS confondre ce nav avec une vraie etape service-level, sous
    // peine de ne jamais atteindre la branche clickSeConnecter (defaut confirme
    // en reel via les logs de production: bot bloque des la page d'accueil). -----
    assert(
      !agentLogText.includes("Etape services additionnels detectee"),
      "1bis) Le nav de la page d'accueil ('Services additionnels') n'est jamais confondu avec une vraie etape service-level"
    );

    // ----- Test 2/3: clickSeConnecter reellement execute, resultat pas avale -----
    assert(
      agentLogText.includes("Navigation directe vers /fr-fr/login sans effet reel"),
      "2/3) Le goto direct (sans Referer) est detecte comme un echec REEL (bounce vers la page d'origine), jamais un faux succes"
    );
    assert(
      agentLogText.includes("Bouton 'Se connecter' clique directement (fenetre large).") || agentLogText.includes("Bouton 'Se connecter' clique via"),
      "2/3) clickSeConnecter() s'est reellement rabattu sur le clic direct du lien (jamais reste bloque sur le seul goto)"
    );
    assert(
      agentLogText.includes("clickSeConnecter() execute avec succes (connected=true"),
      "3) Le resultat reel de clickSeConnecter() est lu et journalise (connected=true), jamais ignore"
    );

    // ----- Test 4: /fr-fr/login (etape login/auth) reellement atteint -----
    assert(
      agentLogText.includes("Progression confirmee apres clickSeConnecter(): etape 'login' atteinte"),
      "4) Progression confirmee explicitement vers l'etape 'login' apres le clic (jamais uniquement appointment-booking attendu)"
    );

    // ----- Test 5: formulaire rempli -----
    assert(agentLogText.includes("Formulaire de connexion rempli et soumis automatiquement."), "5) Le formulaire de connexion a ete rempli et soumis automatiquement");

    // ----- Test 6 (deja verifie ci-dessus via 'surveillance'/pas de Valider) -----

    // ----- Test 7: aucune boucle agressive -----
    const loginAttemptLogCount = (agentLogText.match(/clickSeConnecter\(\) execute avec succes/g) ?? []).length;
    assert(loginAttemptLogCount === 1, `7) Un seul clic 'Se connecter' reellement execute au total (aucune boucle agressive) (recu: ${loginAttemptLogCount})`);
    assert(setup.fakeSite.loginRequestCount() <= 3, `7) Nombre borne de requetes vers /fr-fr/login sur le faux site (recu: ${setup.fakeSite.loginRequestCount()})`);

    // ----- Test 8: aucune modification service-level/profile mapping (verification statique) -----
    // (verifiee globalement dans main(), une seule fois pour les deux scenarios)

    assert(!agentLogText.includes(FAKE_LOGIN) && !agentLogText.includes(FAKE_PASSWORD), "Aucun secret (login/mot de passe) dans les logs locaux de l'agent");
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await killTree(setup?.agent.child.pid).catch(() => undefined);
    if (setup?.server) await killTree(setup.server.child.pid).catch(() => undefined);
    if (setup?.fakeSite) await new Promise<void>((resolve) => setup!.fakeSite.server.close(() => resolve()));
    await cleanupAgencyAndUsers(managerLogins, agencyNames);
    if (setup?.dataRoot) await removeDataRootWithRetry(setup.dataRoot);
  }
};

// ===================== Scenario B (complementaire): aucun element cliquable =====================
// clickSeConnecter() echoue reellement (connected=false): verifie que la
// vraie cause apparait dans les logs et que le workflow ne pretend jamais un
// succes, avec un nombre borne de tentatives (jamais de boucle agressive).
const SCENARIO_B_PORT = 3341;
const BOT_NAME_B = "Bot HomeLogin B";

const runScenarioB = async (): Promise<void> => {
  log("BOOT", "=== Scenario B (complementaire): clickSeConnecter() echoue reellement, cause visible dans les logs ===");

  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  let setup: SetupResult | undefined;
  let browser: Browser | undefined;

  try {
    setup = await setupServerAndAgent(SCENARIO_B_PORT, HOME_HTML_NO_CLICKABLE_ELEMENT, "always-bounce", "HomeLoginB", managerLogins, agencyNames);

    browser = await chromium.launch({ headless: true });
    const uiPage = await startBotViaWebUi(browser, setup.server.baseUrl, setup.managerLogin, setup.managerPassword, BOT_NAME_B);
    const rowFor = (text: string) => uiPage.locator("#agentCommandsTableBody tr", { hasText: text });

    // Aucun element cliquable + /fr-fr/login toujours bloque: l'agent doit
    // finir par WAITING_FOR_USER (bouton 'Valider'), jamais une fausse
    // 'surveillance', et jamais indefiniment bloque.
    //
    // HOTFIX CIBLE (navigation initiale bloquee sur page inconnue/externe):
    // budget elargi (60s -> 100s). Consequence ATTENDUE et bornee du nouveau
    // hotfix: un echec reel de clickSeConnecter() declenche desormais une
    // recuperation bornee (retour vers l'URL TLS de depart, meme si celle-ci
    // s'avere ici etre la MEME page deja essayee) avant d'abandonner la
    // tentative - l'issue de cette recuperation devient "attempted" plutot
    // que "none", ce qui ajoute l'attente de reglage existante
    // (AUTO_NAV_STEP_SETTLE_MS ~8s) a CHAQUE tentative (jamais une boucle
    // supplementaire ni un nombre de tentatives different: toujours au plus
    // AUTO_NAV_FINAL_ATTEMPT=4 tentatives globales, toujours WAITING_FOR_USER
    // au final).
    await requireWithin(
      async () => (await rowFor(BOT_NAME_B).locator("button", { hasText: "Valider" }).count()) === 1,
      100_000,
      "l'agent n'a jamais escalade vers WAITING_FOR_USER (bouton 'Valider') apres l'echec reel de clickSeConnecter()"
    );
    const rowText = await rowFor(BOT_NAME_B).innerText();
    assert(!/surveillance/i.test(rowText), "Le bot n'a jamais pretendu atteindre la surveillance (appointment-booking) alors qu'aucune action n'a reellement progresse");

    const agentLogText = setup.agent.stdout.join("");

    assert(
      agentLogText.includes("clickSeConnecter() a echoue reellement (connected=false"),
      "La vraie cause (connected=false) est journalisee explicitement, jamais un succes suppose"
    );
    assert(
      /URL avant=.+, URL apres=.+\)/.test(agentLogText) || agentLogText.includes("URL avant=") ,
      "L'URL avant/apres le clic est journalisee (masquee), permettant de diagnostiquer l'echec reel"
    );
    assert(!agentLogText.includes("clickSeConnecter() execute avec succes"), "Jamais de faux succes journalise pour clickSeConnecter() dans ce scenario");

    // ----- Aucune boucle agressive: le nombre de tentatives est borne (AUTO_NAV_FINAL_ATTEMPT = 4) -----
    const failureLogCount = (agentLogText.match(/clickSeConnecter\(\) a echoue reellement/g) ?? []).length;
    assert(failureLogCount >= 1 && failureLogCount <= 4, `Nombre borne de tentatives de clickSeConnecter() (recu: ${failureLogCount}, attendu entre 1 et 4)`);

    assert(!agentLogText.includes(FAKE_LOGIN) && !agentLogText.includes(FAKE_PASSWORD), "Aucun secret (login/mot de passe) dans les logs locaux de l'agent (scenario B)");
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await killTree(setup?.agent.child.pid).catch(() => undefined);
    if (setup?.server) await killTree(setup.server.child.pid).catch(() => undefined);
    if (setup?.fakeSite) await new Promise<void>((resolve) => setup!.fakeSite.server.close(() => resolve()));
    await cleanupAgencyAndUsers(managerLogins, agencyNames);
    if (setup?.dataRoot) await removeDataRootWithRetry(setup.dataRoot);
  }
};

// ===================== Test 8 (statique, une seule fois): perimetre service-level =====================
// "Service-level" au sens strict du hotfix precedent, c'est le CLIC/la
// NAVIGATION vers appointment-booking une fois l'etape reconnue
// (clickContinueServiceLevel/performClickContinueServiceLevel/
// resolveContinueLinkTarget): cette logique-la reste intacte.
//
// isServiceLevelPage() elle-meme EST deliberement modifiee par ce hotfix-ci
// (0.2.0): son repli par contenu confondait le nav PERSISTANT du vrai site
// (libelle de menu "Services additionnels", present sur la page d'accueil
// elle-meme - defaut confirme en reel via les logs de production) avec une
// vraie etape service-level, empechant clickSeConnecter d'etre jamais tente.
// Seule la SOURCE du texte analyse change (nav/header/footer exclus); le
// motif de detection et le comportement sur une vraie page service-level
// restent inchanges (cf. test:agent:service-level-hotfix:real, non affecte).
const checkServiceLevelClickLogicUnaffected = (): void => {
  let diff = "";
  try {
    diff = execSync("git diff --unified=0 -- src/shared/loginFlow.ts", { encoding: "utf8" });
  } catch (error) {
    log("GIT-DIFF-ERR", `git diff indisponible: ${error instanceof Error ? error.message : String(error)}`);
  }
  const changedLines = diff.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-")).join("\n");
  const touchesServiceLevelClickLogic = /performClickContinueServiceLevel|clickContinueServiceLevel|resolveContinueLinkTarget/.test(changedLines);
  assert(
    !touchesServiceLevelClickLogic,
    "8) La logique de clic/navigation service-level (clickContinueServiceLevel/performClickContinueServiceLevel/resolveContinueLinkTarget, hotfix precedent) n'est pas modifiee par ce hotfix (isServiceLevelPage() est deliberement corrigee, cf. commentaire)"
  );
};

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL cible - Hotfix Agent 0.1.9 (home -> login) ===");

  if (process.platform !== "win32") {
    console.log("Plateforme non-Windows: ce test necessite Windows + Chrome. Ignore, 0 succes / 0 echec.");
    process.exit(0);
    return;
  }

  try {
    checkServiceLevelClickLogicUnaffected();
    await runScenarioA();
    await runScenarioB();
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
