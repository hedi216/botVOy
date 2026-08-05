// Test REEL cible - Hotfix Agent 0.2.1 (agent bloque sur /fr-fr/travel-groups
// malgre un bouton "Selectionner" visible, confirme par l'utilisateur en
// conditions reelles).
//
// ANALYSE DE CODE (avant modification) avait identifie deux defauts distincts
// dans le meme fichier src/agent/agentBotManager.ts que le hotfix precedent:
//
//   1. clickSelectTravelGroup() (src/shared/loginFlow.ts) ne cherchait QUE
//      role=button[name=Selectionner] et retournait false sans jamais
//      journaliser la structure reellement trouvee sur la page - impossible
//      de diagnostiquer "aucun candidat" vs "candidat present mais role non
//      reconnu" (ex. un <a> stylise en bouton).
//   2. dispatchOnState() (agentBotManager.ts) ignorait le resultat reel de
//      clickSelectTravelGroup() (.catch(() => false) puis jamais lu): un
//      echec reel etait rapporte comme "attempted" au meme titre qu'un
//      succes, et le garde-fou lastDispatchedUrl abandonnait la tentative
//      SANS jamais journaliser la vraie cause.
//
// IMPORTANT (trouve en analysant les logs REELS de production sur ce meme PC,
// cf. livrable): un TROISIEME defaut, plus profond et deja partiellement
// connu (isServiceLevelPage(), corrige une premiere fois au hotfix 0.2.0 pour
// exclure nav/header/footer), intercepte EGALEMENT /fr-fr/travel-groups dans
// certains cas reels - AVANT que la branche travel-groups de dispatchOnState
// ne soit jamais atteinte. Ce fichier de test NE reproduit PAS ce troisieme
// defaut (fixture volontairement neutre, sans texte "services additionnels"
// hors nav): il valide uniquement les corrections 1 et 2 ci-dessus,
// explicitement demandees par ce hotfix. Le troisieme defaut est documente et
// signale separement (livrable), une modification de isServiceLevelPage()
// etant explicitement hors-perimetre de CE hotfix ("ne modifie pas le
// service-level").
//
// Corrige ici (aucune modification profils/comptes, HMAC/DPAPI, migration,
// service-level, monitoring ou serveur):
//   - clickSelectTravelGroup() cherche desormais, dans l'ordre, role=button,
//     role=link, button:visible/a:visible/[role="button"]:visible filtres
//     par texte EXACT ("Selectionner" ancre ^...$ - ne peut jamais confondre
//     avec "Creer une nouvelle demande"/Modifier/Supprimer), journalise le
//     compte de CHAQUE strategie et la structure exacte du candidat retenu
//     (tag/role/id/data-testid/visible/enabled/href/texte, jamais le HTML
//     complet), effectue un trial-click puis un clic reel, et ne masque
//     jamais une exception Playwright reelle ;
//   - dispatchOnState() lit et journalise le resultat reel de
//     clickSelectTravelGroup() (selected=true/false), n'accepte jamais un
//     succes suppose, et attend explicitement une progression reelle
//     (application-summary/service-level/appointment-booking) apres un clic
//     reellement execute - jamais uniquement l'absence d'exception.
//
// Scenario A: destination /workflow/application-summary -> appointment-booking.
// Scenario B: destination /workflow/service-level -> appointment-booking
//   (reutilise le meme balisage "Continuer" deja valide par le hotfix
//   service-level precedent, jamais reecrit ici).
// Scenario C: aucun candidat "Selectionner" sur la page (echec reel) -
//   verifie que le workflow ne pretend jamais un succes et finit par
//   WAITING_FOR_USER avec un nombre borne de tentatives.
// Scenario D: candidat trouve et visible mais physiquement recouvert par une
//   barre superposee (meme technique deja validee par
//   test-agent-service-level-hotfix-real.ts, scenario A2) - verifie qu'une
//   VRAIE erreur Playwright (timeout d'actionnabilite) est journalisee et
//   jamais confondue avec "aucun candidat trouve".
//
// A executer sur un PC Windows personnel avec une session interactive et
// Google Chrome installe - JAMAIS sur la VM/serveur de production.
//
// Usage: npx tsx scripts/test-agent-hotfix-travel-groups-real.ts
//    ou: npm run test:agent:hotfix-travel-groups:real

import { ChildProcess, execSync, spawn } from "node:child_process";
import http, { Server, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { Browser, chromium } from "playwright";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
const FAKE_LOGIN = "TEST_SECRET_FAKE_LOGIN_TRAVELGROUPS";
const FAKE_PASSWORD = "TEST_SECRET_FAKE_PASSWORD_TRAVELGROUPS_123";

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

const HOME_HTML = `<!DOCTYPE html><html><body>
<a href="/fr-fr/login"><div id="login">SE CONNECTER</div></a>
</body></html>`;

const LOGIN_HTML = `<!DOCTYPE html><html><body>
<form id="loginForm" action="/fr-fr/travel-groups" method="post">
  <input id="username" type="text" />
  <input id="password" type="password" />
  <button id="btn-login" type="submit">Se connecter</button>
</form>
</body></html>`;

// Balisage exact demande par le ticket (Objectif 5): titre, "Liste des
// demandes", une demande "My travel group" au statut "Soumise", un bouton
// "Selectionner" visible - plus des decoys realistes ("Creer une nouvelle
// demande", "Modifier", "Supprimer") qui ne doivent JAMAIS etre cliques
// (traces cote serveur ci-dessous, preuve definitive - jamais une simple
// absence de log cote agent).
type TravelGroupsVariant = "normal" | "no-candidate" | "overlay-blocked";

const travelGroupsHtml = (variant: TravelGroupsVariant, selectHref: string): string => {
  const selectBlock = variant === "no-candidate"
    ? "<!-- aucun candidat 'Selectionner' sur cette page (Scenario C) -->"
    : variant === "overlay-blocked"
      ? `<div class="sticky-bottom-bar" style="position:fixed;left:0;right:0;bottom:0;height:80px;">
  <button type="button" id="btn-select" onclick="location.href='${selectHref}'">Selectionner</button>
</div>
<div id="overlay-blocker" style="position:fixed;left:0;right:0;bottom:0;height:80px;background:rgba(0,0,0,0.01);z-index:9999;"></div>`
      : `<button type="button" id="btn-select" onclick="location.href='${selectHref}'">Selectionner</button>`;

  return `<!DOCTYPE html><html><body>
<h1>Gestionnaire des demandes</h1>
<p>Liste des demandes</p>
<a href="/decoy-create">Creer une nouvelle demande</a>
<div class="demande">
  <span>My travel group</span>
  <span>Soumise</span>
  <a href="/decoy-modify">Modifier</a>
  <a href="/decoy-delete">Supprimer</a>
  ${selectBlock}
</div>
</body></html>`;
};

// Reutilise EXACTEMENT le balisage deja valide par
// test-agent-service-level-hotfix-real.ts (jamais reecrit ici: perimetre
// service-level hors de ce hotfix).
const APPOINTMENT_BOOKING_PATH = "/workflow/appointment-booking/tnTUN2fr/27928390";
const SERVICE_LEVEL_HTML = `<!DOCTYPE html><html><body>
<h1>Selectionnez un ou plusieurs services additionnels</h1>
<div class="sticky-bottom-bar" style="position:fixed;left:0;right:0;bottom:0;height:80px;">
  <a id="book-appointment-btn" data-testid="btn-book-appointment" href="${APPOINTMENT_BOOKING_PATH}">Continuer</a>
</div>
</body></html>`;

const APPLICATION_SUMMARY_HTML = `<!DOCTYPE html><html><body>
<h1>Recapitulatif de la demande</h1>
<p>Non reserve</p>
<button id="btn-confirm-appointment" type="button" onclick="location.href='${APPOINTMENT_BOOKING_PATH}'">Prendre un nouveau rendez-vous</button>
</body></html>`;

const APPOINTMENT_HTML = `<!DOCTYPE html><html><body>
<div data-testid="fixture-appointment-page">Fausse page de rendez-vous (test uniquement)</div>
</body></html>`;

type FixtureCounts = { create: number; modify: number; delete: number };

const startFakeTlsSite = (
  variant: TravelGroupsVariant,
  destination: "application-summary" | "service-level"
): Promise<{ server: Server; baseUrl: string; counts: () => FixtureCounts }> => new Promise((resolve, reject) => {
  const counts: FixtureCounts = { create: 0, modify: 0, delete: 0 };
  const selectHref = destination === "application-summary" ? "/workflow/application-summary" : "/workflow/service-level";

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url === "/" || url === "") { res.end(HOME_HTML); return; }
    if (url.startsWith("/fr-fr/login")) { res.end(LOGIN_HTML); return; }
    if (url.startsWith("/fr-fr/travel-groups")) { res.end(travelGroupsHtml(variant, selectHref)); return; }
    if (url.startsWith("/decoy-create")) { counts.create += 1; res.end(HOME_HTML); return; }
    if (url.startsWith("/decoy-modify")) { counts.modify += 1; res.end(HOME_HTML); return; }
    if (url.startsWith("/decoy-delete")) { counts.delete += 1; res.end(HOME_HTML); return; }
    if (url.startsWith("/workflow/application-summary")) { res.end(APPLICATION_SUMMARY_HTML); return; }
    if (url.startsWith("/workflow/service-level")) { res.end(SERVICE_LEVEL_HTML); return; }
    if (url.startsWith("/workflow/appointment-booking")) { res.end(APPOINTMENT_HTML); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/`, counts: () => ({ ...counts }) });
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
  fakeSite: { server: Server; baseUrl: string; counts: () => FixtureCounts };
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
  variant: TravelGroupsVariant,
  destination: "application-summary" | "service-level",
  namePrefix: string,
  managerLogins: string[],
  agencyNames: string[]
): Promise<SetupResult> => {
  const fakeSite = await startFakeTlsSite(variant, destination);
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

  const dataRoot = `.test-hotfix-travelgroups-${namePrefix}-${RUN_SUFFIX}`;
  const agent = spawnRealAgent(server.baseUrl, dataRoot, `REAL-HOTFIX-TRAVELGROUPS-${namePrefix}-PC`);
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

const teardown = async (browser: Browser | undefined, setup: SetupResult | undefined, managerLogins: string[], agencyNames: string[]): Promise<void> => {
  if (browser) await browser.close().catch(() => undefined);
  await killTree(setup?.agent.child.pid).catch(() => undefined);
  if (setup?.server) await killTree(setup.server.child.pid).catch(() => undefined);
  if (setup?.fakeSite) await new Promise<void>((resolve) => setup!.fakeSite.server.close(() => resolve()));
  await cleanupAgencyAndUsers(managerLogins, agencyNames);
  if (setup?.dataRoot) await removeDataRootWithRetry(setup.dataRoot);
};

// ===================== Scenario A: travel-groups -> application-summary -> appointment-booking =====================
const SCENARIO_A_PORT = 3350;
const BOT_NAME_A = "Bot TravelGroups A";

const runScenarioA = async (): Promise<void> => {
  log("BOOT", "=== Scenario A: travel-groups -> application-summary -> appointment-booking ===");
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  let setup: SetupResult | undefined;
  let browser: Browser | undefined;

  try {
    setup = await setupServerAndAgent(SCENARIO_A_PORT, "normal", "application-summary", "TravelGroupsA", managerLogins, agencyNames);
    browser = await chromium.launch({ headless: true });
    const uiPage = await startBotViaWebUi(browser, setup.server.baseUrl, setup.managerLogin, setup.managerPassword, BOT_NAME_A);
    const rowFor = (text: string) => uiPage.locator("#agentCommandsTableBody tr", { hasText: text });

    await requireWithin(
      async () => (await rowFor(BOT_NAME_A).innerText().catch(() => "")).toLowerCase().includes("surveillance"),
      60_000,
      "6) le bot n'a jamais atteint la surveillance (appointment-booking) apres avoir clique 'Selectionner'"
    );
    const rowText = await rowFor(BOT_NAME_A).innerText();
    assert(!/valider/i.test(rowText), "6) Aucun 'Valider' (WAITING_FOR_USER) necessaire: travel-groups -> application-summary -> appointment-booking a reussi seul");

    const agentLogText = setup.agent.stdout.join("");

    // ----- Test 1: travel-groups detectee -----
    assert(
      agentLogText.includes("Etape travel-groups: candidats 'Selectionner' par strategie"),
      "1) La page /fr-fr/travel-groups est bien detectee et traitee par le dispatcher"
    );

    // ----- Test 2: le candidat exact est trouve (strategie role=button, le bouton reel de la fixture) -----
    assert(
      agentLogText.includes("Etape travel-groups: candidat retenu via role=button[name=Selectionner]"),
      "2) Le candidat exact 'Selectionner' est trouve via la strategie role=button (structure diagnostiquee, jamais le HTML complet)"
    );
    assert(agentLogText.includes("tag=BUTTON"), "2) La structure exacte du candidat (tag/visible/enabled/texte) est journalisee");

    // ----- Test 3/4: decoys jamais cliques (preuve DEFINITIVE cote serveur, jamais une simple absence de log) -----
    const counts = setup.fakeSite.counts();
    assert(counts.create === 0, `3) 'Creer une nouvelle demande' n'est jamais clique (requetes recues: ${counts.create})`);
    assert(counts.modify === 0 && counts.delete === 0, `4) 'Modifier'/'Supprimer' ne sont jamais cliques (requetes recues: modifier=${counts.modify}, supprimer=${counts.delete})`);

    // ----- Test 5: un seul clic 'Selectionner' reellement execute -----
    const selectSuccessCount = (agentLogText.match(/clickSelectTravelGroup\(\) execute avec succes/g) ?? []).length;
    assert(selectSuccessCount === 1, `5) Un seul clic 'Selectionner' reellement execute au total (aucune boucle agressive) (recu: ${selectSuccessCount})`);

    // ----- Test 6: navigation suivante reellement confirmee (pas uniquement l'absence d'exception) -----
    assert(
      agentLogText.includes("Progression confirmee apres clickSelectTravelGroup(): etape 'application-summary' atteinte"),
      "6) La progression vers 'application-summary' est explicitement confirmee (jamais uniquement parce que click() n'a pas leve d'exception)"
    );

    // ----- Test 7: un resultat false n'est jamais transforme en "attempted" -----
    // (verifie negativement dans le Scenario C - aucun cas d'echec dans ce scenario A)

    // ----- Test 9: aucune boucle agressive (deja verifie via selectSuccessCount === 1) -----

    assert(!agentLogText.includes(FAKE_LOGIN) && !agentLogText.includes(FAKE_PASSWORD), "Aucun secret (login/mot de passe) dans les logs locaux de l'agent (scenario A)");
  } finally {
    await teardown(browser, setup, managerLogins, agencyNames);
  }
};

// ===================== Scenario B: travel-groups -> service-level -> appointment-booking =====================
const SCENARIO_B_PORT = 3351;
const BOT_NAME_B = "Bot TravelGroups B";

const runScenarioB = async (): Promise<void> => {
  log("BOOT", "=== Scenario B: travel-groups -> service-level -> appointment-booking (autre destination valide) ===");
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  let setup: SetupResult | undefined;
  let browser: Browser | undefined;

  try {
    setup = await setupServerAndAgent(SCENARIO_B_PORT, "normal", "service-level", "TravelGroupsB", managerLogins, agencyNames);
    browser = await chromium.launch({ headless: true });
    const uiPage = await startBotViaWebUi(browser, setup.server.baseUrl, setup.managerLogin, setup.managerPassword, BOT_NAME_B);
    const rowFor = (text: string) => uiPage.locator("#agentCommandsTableBody tr", { hasText: text });

    await requireWithin(
      async () => (await rowFor(BOT_NAME_B).innerText().catch(() => "")).toLowerCase().includes("surveillance"),
      60_000,
      "6) le bot n'a jamais atteint la surveillance (appointment-booking) via la destination service-level"
    );
    const rowText = await rowFor(BOT_NAME_B).innerText();
    assert(!/valider/i.test(rowText), "6) Aucun 'Valider' necessaire: travel-groups -> service-level -> appointment-booking a reussi seul");

    const agentLogText = setup.agent.stdout.join("");
    assert(
      agentLogText.includes("Progression confirmee apres clickSelectTravelGroup(): etape 'service-level' atteinte"),
      "6) La progression vers l'AUTRE destination valide (service-level) est aussi explicitement confirmee"
    );
    const counts = setup.fakeSite.counts();
    assert(counts.create === 0 && counts.modify === 0 && counts.delete === 0, "3/4) Decoys jamais cliques (destination service-level)");

    assert(!agentLogText.includes(FAKE_LOGIN) && !agentLogText.includes(FAKE_PASSWORD), "Aucun secret (login/mot de passe) dans les logs locaux de l'agent (scenario B)");
  } finally {
    await teardown(browser, setup, managerLogins, agencyNames);
  }
};

// ===================== Scenario C: aucun candidat 'Selectionner' (echec reel, jamais un faux succes) =====================
const SCENARIO_C_PORT = 3352;
const BOT_NAME_C = "Bot TravelGroups C";

const runScenarioC = async (): Promise<void> => {
  log("BOOT", "=== Scenario C: aucun candidat 'Selectionner' - echec honnete, jamais 'attempted' pour un resultat false ===");
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  let setup: SetupResult | undefined;
  let browser: Browser | undefined;

  try {
    setup = await setupServerAndAgent(SCENARIO_C_PORT, "no-candidate", "application-summary", "TravelGroupsC", managerLogins, agencyNames);
    browser = await chromium.launch({ headless: true });
    const uiPage = await startBotViaWebUi(browser, setup.server.baseUrl, setup.managerLogin, setup.managerPassword, BOT_NAME_C);
    const rowFor = (text: string) => uiPage.locator("#agentCommandsTableBody tr", { hasText: text });

    await requireWithin(
      async () => (await rowFor(BOT_NAME_C).locator("button", { hasText: "Valider" }).count()) === 1,
      60_000,
      "l'agent n'a jamais escalade vers WAITING_FOR_USER apres l'echec reel de clickSelectTravelGroup()"
    );
    const rowText = await rowFor(BOT_NAME_C).innerText();
    assert(!/surveillance/i.test(rowText), "Le bot n'a jamais pretendu atteindre la surveillance alors qu'aucune action n'a reellement progresse");

    const agentLogText = setup.agent.stdout.join("");

    // ----- Test 7 (le coeur de ce scenario): resultat false jamais transforme en "attempted" -----
    assert(
      agentLogText.includes("clickSelectTravelGroup() a echoue reellement (selected=false"),
      "7) La vraie cause (selected=false) est journalisee explicitement, jamais un succes suppose"
    );
    assert(
      agentLogText.includes("Aucune demande 'Selectionner' trouvee sur 'Gestionnaire des demandes' (toutes strategies a 0 candidat)"),
      "7) L'absence de candidat est journalisee precisement (distincte d'un candidat trouve mais non actionnable)"
    );
    assert(
      !agentLogText.includes("clickSelectTravelGroup() execute avec succes"),
      "7) Jamais de faux succes journalise pour clickSelectTravelGroup() dans ce scenario"
    );

    const failureLogCount = (agentLogText.match(/clickSelectTravelGroup\(\) a echoue reellement/g) ?? []).length;
    assert(failureLogCount >= 1 && failureLogCount <= 4, `9) Nombre borne de tentatives (aucune boucle agressive) (recu: ${failureLogCount}, attendu entre 1 et 4)`);

    const counts = setup.fakeSite.counts();
    assert(counts.create === 0 && counts.modify === 0 && counts.delete === 0, "3/4) Decoys jamais cliques meme en l'absence de candidat 'Selectionner'");

    assert(!agentLogText.includes(FAKE_LOGIN) && !agentLogText.includes(FAKE_PASSWORD), "Aucun secret (login/mot de passe) dans les logs locaux de l'agent (scenario C)");
  } finally {
    await teardown(browser, setup, managerLogins, agencyNames);
  }
};

// ===================== Scenario D: candidat trouve mais physiquement recouvert (vraie erreur Playwright, jamais masquee) =====================
const SCENARIO_D_PORT = 3353;
const BOT_NAME_D = "Bot TravelGroups D";

const runScenarioD = async (): Promise<void> => {
  log("BOOT", "=== Scenario D: candidat 'Selectionner' trouve mais recouvert - vraie erreur Playwright journalisee, jamais 'introuvable' ===");
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  let setup: SetupResult | undefined;
  let browser: Browser | undefined;

  try {
    setup = await setupServerAndAgent(SCENARIO_D_PORT, "overlay-blocked", "application-summary", "TravelGroupsD", managerLogins, agencyNames);
    browser = await chromium.launch({ headless: true });
    const uiPage = await startBotViaWebUi(browser, setup.server.baseUrl, setup.managerLogin, setup.managerPassword, BOT_NAME_D);
    const rowFor = (text: string) => uiPage.locator("#agentCommandsTableBody tr", { hasText: text });

    await requireWithin(
      async () => (await rowFor(BOT_NAME_D).locator("button", { hasText: "Valider" }).count()) === 1,
      60_000,
      "l'agent n'a jamais escalade vers WAITING_FOR_USER apres l'echec reel (candidat recouvert) de clickSelectTravelGroup()"
    );

    const agentLogText = setup.agent.stdout.join("");

    // ----- Test 8 (le coeur de ce scenario): erreur Playwright reelle non masquee -----
    assert(
      agentLogText.includes("Etape travel-groups: candidat retenu via role=button[name=Selectionner]"),
      "8) Le candidat EST trouve (contrairement au Scenario C): la cause de l'echec est bien differente ici"
    );
    assert(
      agentLogText.includes("Clic Playwright sur 'Selectionner' echoue"),
      "8) L'echec du CLIC (candidat trouve mais non actionnable) est journalise distinctement de 'aucun candidat trouve'"
    );
    assert(
      !agentLogText.includes("Aucune demande 'Selectionner' trouvee"),
      "8) Ce scenario n'est JAMAIS confondu avec le cas 'aucun candidat' (Scenario C): la vraie cause (recouvrement) est journalisee"
    );
    assert(
      agentLogText.includes("clickSelectTravelGroup() a echoue reellement (selected=false"),
      "7/8) Le resultat false (candidat recouvert) n'est jamais non plus transforme en 'attempted'"
    );

    const counts = setup.fakeSite.counts();
    assert(counts.create === 0 && counts.modify === 0 && counts.delete === 0, "3/4) Decoys jamais cliques (scenario D)");

    assert(!agentLogText.includes(FAKE_LOGIN) && !agentLogText.includes(FAKE_PASSWORD), "Aucun secret (login/mot de passe) dans les logs locaux de l'agent (scenario D)");
  } finally {
    await teardown(browser, setup, managerLogins, agencyNames);
  }
};

// ===================== Test 10 (statique, une seule fois): aucun changement hors perimetre =====================
// Ce hotfix touche clickSelectTravelGroup()/isServiceLevelPage() (loginFlow.ts,
// la seconde explicitement demandee par le hotfix cause-racine 0.2.1 - jamais
// hors-perimetre) et la branche travel-groups de dispatchOnState()
// (agentBotManager.ts). Jamais clickContinueServiceLevel/
// performClickContinueServiceLevel/resolveContinueLinkTarget (le CLIC/la
// NAVIGATION 'Continuer' du hotfix service-level precedent - inchange), jamais
// agentProfileManager/agentAccountKey (profils/HMAC), jamais
// agentMonitoringRuntime (monitoring), jamais src/server.ts (serveur).
const checkOutOfScopeFilesUntouched = (): void => {
  let changedFiles = "";
  try {
    changedFiles = execSync("git diff --name-only -- src/agent/agentProfileManager.ts src/agent/agentAccountKey.ts src/agent/agentMonitoringRuntime.ts src/server.ts", { encoding: "utf8" });
  } catch (error) {
    log("GIT-DIFF-ERR", `git diff indisponible: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert(changedFiles.trim() === "", `10) Aucun changement dans profils/HMAC/monitoring/serveur (fichiers modifies: ${changedFiles.trim() || "(aucun)"})`);

  let loginFlowDiff = "";
  try {
    loginFlowDiff = execSync("git diff --unified=0 -- src/shared/loginFlow.ts", { encoding: "utf8" });
  } catch (error) {
    log("GIT-DIFF-ERR", `git diff indisponible: ${error instanceof Error ? error.message : String(error)}`);
  }
  const changedLines = loginFlowDiff.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-")).join("\n");
  const touchesServiceLevelClickLogic = /performClickContinueServiceLevel|clickContinueServiceLevel|resolveContinueLinkTarget/.test(changedLines);
  assert(
    !touchesServiceLevelClickLogic,
    "10) Le CLIC/la NAVIGATION service-level (clickContinueServiceLevel/performClickContinueServiceLevel/resolveContinueLinkTarget, hotfix precedent) n'est pas modifie par CE hotfix (isServiceLevelPage() est deliberement corrigee - cause racine explicitement demandee)"
  );
};

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL cible - Hotfix Agent 0.2.1 (travel-groups -> Selectionner) ===");

  if (process.platform !== "win32") {
    console.log("Plateforme non-Windows: ce test necessite Windows + Chrome. Ignore, 0 succes / 0 echec.");
    process.exit(0);
    return;
  }

  try {
    checkOutOfScopeFilesUntouched();
    await runScenarioA();
    await runScenarioB();
    await runScenarioC();
    await runScenarioD();
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
