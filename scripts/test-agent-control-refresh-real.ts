// CORRECTIF CIBLE - Refresh temporel securise toutes les 20 minutes.
//
// Nouveau besoin: le refresh periodique de l'agent doit etre base sur le
// TEMPS REEL ecoule (20 * 60 * 1000 ms), jamais sur un nombre de cycles
// (refreshEveryCycles, qui reste inchange pour legacy_vm/CLI autonome), et ne
// doit JAMAIS interrompre une operation critique (scan/reservation/creneau/
// notification, validation humaine, Cloudflare, rate-limit, recovery deja en
// cours). Corrige ici (src/shared/types.ts, src/shared/monitor.ts,
// src/agent/agentMonitoringSettings.ts, src/agent/agentMonitoringRuntime.ts):
//   - AppConfig.controlRefreshIntervalMs (optionnel, absent = comportement
//     0.2.3 inchange via refreshEveryCycles - legacy_vm/CLI autonome jamais
//     affectes) ;
//   - monitorAppointments(): nextControlRefreshAt, simple valeur numerique
//     comparee a Date.now() au SEUL point sur existant (apres disponibilite/
//     reservation/mode creneau, jamais pendant) - jamais un setInterval
//     independant, jamais de rattrapage en rafale (un seul refresh, puis
//     nouveau delai complet) ;
//   - refresh planifie qui echoue (autre qu'un rate limit): tente desormais
//     TOUJOURS le recovery pilote par etat existant (recoverWorkflow) avant
//     tout alertAndPause - couvre logged-out-landing, tout etat intermediaire
//     connu, et desormais aussi "unknown" (retour borne vers targetUrl) ;
//   - agentMonitoringRuntime.ts: "unknown" tente maintenant UNE reprise bornee
//     vers targetUrl (attemptReturnToTargetUrl, factorisee avec
//     logged-out-landing - jamais une deuxieme architecture de navigation),
//     bornee par le meme plafond WORKFLOW_RECOVERY_FINAL_ATTEMPT que tout le
//     reste du recovery (jamais une boucle infinie).
//
// Scenarios CR-A a CR-P: certains testent monitorAppointments() DIRECTEMENT
// (monitor.ts, avec un recoverWorkflow/runtime stub - rapide, precis, teste
// exactement la logique de gating temporel) ; d'autres testent startMonitoring()
// (agentMonitoringRuntime.ts, avec de vrais Chromium + fixtures HTTP locales -
// pour prouver que le recovery pilote par etat REEL, deja existant, est bien
// reutilise, jamais une architecture parallele).
//
// A executer sur un PC Windows personnel avec une session interactive et
// Google Chrome installe - JAMAIS sur la VM/serveur de production.
//
// Usage: npx tsx scripts/test-agent-control-refresh-real.ts

import http, { Server, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { Browser, chromium } from "playwright";
import { monitorAppointments } from "../src/shared/monitor.js";
import { AppConfig, MonitorEventLevel, MonitorRuntime } from "../src/shared/types.js";
import { startMonitoring } from "../src/agent/agentMonitoringRuntime.js";
import { AgentEventReporter } from "../src/agent/agentEventReporter.js";
import { AgentMonitoringSettings, DEFAULT_AGENT_MONITORING_SETTINGS } from "../src/agent/agentMonitoringSettings.js";

const FAKE_LOGIN = "TEST_SECRET_FAKE_LOGIN_CTRLREFRESH";
const FAKE_PASSWORD = "TEST_SECRET_FAKE_PASSWORD_CTRLREFRESH_123";

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 15_000, intervalMs = 150): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};

// ===================== Fixtures HTML (jamais TLScontact reel) =====================

const READY_NO_SLOTS_HTML = `<!DOCTYPE html><html><body>
<div data-testid="fixture-appointment-page">Fixture rendez-vous (test)</div>
<button data-testid="btn-current-month-unavailable" disabled>Mois courant</button>
<button data-testid="btn-next-month-unavailable" disabled>Mois suivant</button>
<p>Nous n'avons actuellement plus de creneaux de rendez-vous disponibles.</p>
</body></html>`;

const SLOT_AVAILABLE_HTML = `<!DOCTYPE html><html><body>
<div data-testid="fixture-appointment-page">Fixture rendez-vous (test)</div>
<button data-testid="btn-current-month-available">Mois courant</button>
<button data-testid="btn-available-slot">14:30</button>
<button id="fixture-reserve-btn">Reservez votre rendez-vous</button>
<script>
document.getElementById("fixture-reserve-btn").addEventListener("click", function () {
  location.href = "/workflow/order-summary/tnTUN2fr/1";
});
</script>
</body></html>`;

const ORDER_SUMMARY_HTML = `<!DOCTYPE html><html><body>
<h1>Recapitulatif de la commande</h1>
<p>Rendez-vous reserve pour le creneau selectionne.</p>
</body></html>`;

const blockedHtml = (marker: string, clearsAfterMs?: number, clearTo?: string): string => `<!DOCTYPE html><html><body>
<p>${marker}</p>
${clearsAfterMs && clearTo ? `<script>setTimeout(function () { location.href = ${JSON.stringify(clearTo)}; }, ${clearsAfterMs});</script>` : ""}
</body></html>`;

const CLIENT_SIDE_EXCEPTION_HTML = `<!DOCTYPE html><html><body>
<h1>Application error: a client-side exception has occurred (see the browser console for more information).</h1>
</body></html>`;

const BLANK_UNKNOWN_HTML = `<!DOCTYPE html><html><body><p>Chargement en cours...</p></body></html>`;

const COUNTRY_HOME_HTML = `<!DOCTYPE html><html><body><a href="/fr-fr/login"><div id="login">SE CONNECTER</div></a></body></html>`;
const LOGGED_OUT_LANDING_HTML = `<!DOCTYPE html><html><body><h1>Bienvenue sur TLScontact</h1><p>Prendre un rendez-vous</p></body></html>`;
const LOGIN_HTML_TO_SERVICE_LEVEL = `<!DOCTYPE html><html><body>
<form id="loginForm" action="/workflow/service-level" method="post">
  <input id="username" type="text" />
  <input id="password" type="password" />
  <button id="btn-login" type="submit">Se connecter</button>
</form>
</body></html>`;
const TRAVEL_GROUPS_HTML = `<!DOCTYPE html><html><body>
<h1>Gestionnaire des demandes</h1>
<button type="button" onclick="location.href='/workflow/application-summary'">Selectionner</button>
</body></html>`;
const APPLICATION_SUMMARY_HTML = `<!DOCTYPE html><html><body>
<h1>Recapitulatif de la demande</h1>
<p>Non reserve</p>
<button id="btn-confirm-appointment" type="button" onclick="location.href='/workflow/service-level'">Prendre un nouveau rendez-vous</button>
</body></html>`;
const SERVICE_LEVEL_HTML = `<!DOCTYPE html><html><body>
<h1>Selectionnez un ou plusieurs services additionnels</h1>
<div class="sticky-bottom-bar" style="position:fixed;left:0;right:0;bottom:0;height:80px;">
  <a id="book-appointment-btn" data-testid="btn-book-appointment" href="/workflow/appointment-booking/tnTUN2fr/1">Continuer</a>
</div>
</body></html>`;

type FixtureSite = {
  server: Server;
  baseUrl: string;
  requestLog: string[];
  appointmentReloadCount: () => number;
};

const listenFixture = (handler: (req: IncomingMessage, res: ServerResponse) => void, requestLog: string[]): Promise<{ server: Server; baseUrl: string }> =>
  new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      requestLog.push(req.url ?? "/");
      handler(req, res);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });

// Fixture simple: appointment-booking toujours pret (aucun creneau) - pour
// les scenarios qui testent uniquement le GATING temporel (monitor.ts direct),
// jamais le recovery pilote par etat.
const startAlwaysReadyFixture = async (): Promise<FixtureSite> => {
  const requestLog: string[] = [];
  let appointmentRequests = 0;
  const { server, baseUrl } = await listenFixture((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.startsWith("/workflow/appointment-booking/")) {
      appointmentRequests += 1;
      res.end(READY_NO_SLOTS_HTML);
      return;
    }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  }, requestLog);
  return { server, baseUrl, requestLog, appointmentReloadCount: () => appointmentRequests };
};

// Fixture avec un creneau disponible qui aboutit a une reservation confirmee
// (order-summary) - pour CR-B/C/D (priorite reservation sur le timer).
const startSlotAvailableFixture = async (): Promise<FixtureSite> => {
  const requestLog: string[] = [];
  let appointmentRequests = 0;
  const { server, baseUrl } = await listenFixture((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.startsWith("/workflow/order-summary/")) { res.end(ORDER_SUMMARY_HTML); return; }
    if (url.startsWith("/workflow/appointment-booking/")) {
      appointmentRequests += 1;
      res.end(SLOT_AVAILABLE_HTML);
      return;
    }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  }, requestLog);
  return { server, baseUrl, requestLog, appointmentReloadCount: () => appointmentRequests };
};

// Fixture bloquee (validation humaine/Cloudflare OU rate-limit, selon `marker`)
// qui se dissipe seule apres `clearsAfterMs` (0 = ne se dissipe jamais) - pour
// CR-K/L/O.
const startBlockedFixture = async (marker: string, clearsAfterMs: number): Promise<FixtureSite> => {
  const requestLog: string[] = [];
  let appointmentRequests = 0;
  const { server, baseUrl } = await listenFixture((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.startsWith("/workflow/appointment-booking/")) {
      appointmentRequests += 1;
      // Seule la PREMIERE requete est bloquee (avec script de dissipation
      // cote client si clearsAfterMs>0) - toute requete SUIVANTE (la
      // navigation client-side elle-meme, ou un reload ulterieur) doit
      // trouver la page REELLEMENT prete, sinon la "dissipation" bouclerait
      // indefiniment sur elle-meme (le blocage se re-affichant a chaque
      // requete au lieu de se lever une fois pour toutes).
      if (appointmentRequests === 1) {
        if (clearsAfterMs > 0) {
          res.end(blockedHtml(marker, clearsAfterMs, "/workflow/appointment-booking/tnTUN2fr/1?cleared=1"));
        } else {
          res.end(blockedHtml(marker));
        }
        return;
      }
      res.end(READY_NO_SLOTS_HTML);
      return;
    }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  }, requestLog);
  return { server, baseUrl, requestLog, appointmentReloadCount: () => appointmentRequests };
};

// Fixture "exception cote client -> refresh simple suffit" (reprise du
// scenario A de test-agent-monitoring-recovery-real.ts) - pour CR-P.
const startClientExceptionFixture = async (): Promise<FixtureSite> => {
  const requestLog: string[] = [];
  let appointmentRequests = 0;
  const { server, baseUrl } = await listenFixture((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.startsWith("/workflow/appointment-booking/")) {
      appointmentRequests += 1;
      res.end(appointmentRequests === 1 ? CLIENT_SIDE_EXCEPTION_HTML : READY_NO_SLOTS_HTML);
      return;
    }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  }, requestLog);
  return { server, baseUrl, requestLog, appointmentReloadCount: () => appointmentRequests };
};

// Fixture "refresh planifie -> redirige vers /fr-fr -> logged-out-landing ->
// targetUrl (country page) -> home -> auth (raccourci vers service-level) ->
// appointment-booking" - pour CR-E.
const startRedirectToLoggedOutLandingFixture = async (): Promise<FixtureSite> => {
  const requestLog: string[] = [];
  let appointmentRequests = 0;
  const { server, baseUrl } = await listenFixture((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.startsWith("/workflow/appointment-booking/")) {
      appointmentRequests += 1;
      // Seule la 2e requete (le reload declenche par le refresh de controle)
      // redirige - la 3e+ (arrivee via la chaine de recovery, session de
      // nouveau valide) doit trouver la page REELLEMENT prete, sinon la
      // chaine de recovery ne pourrait jamais aboutir (elle re-tomberait sur
      // le meme etat inattendu indefiniment).
      if (appointmentRequests !== 2) { res.end(READY_NO_SLOTS_HTML); return; }
      res.statusCode = 302;
      res.setHeader("Location", "/fr-fr");
      res.end();
      return;
    }
    if (url === "/fr-fr" || url === "/fr-fr/") { res.end(LOGGED_OUT_LANDING_HTML); return; }
    if (url.startsWith("/fr-fr/country/")) { res.end(COUNTRY_HOME_HTML); return; }
    if (url.startsWith("/fr-fr/login")) { res.end(LOGIN_HTML_TO_SERVICE_LEVEL); return; }
    if (url.startsWith("/workflow/service-level")) { res.end(SERVICE_LEVEL_HTML); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  }, requestLog);
  return { server, baseUrl, requestLog, appointmentReloadCount: () => appointmentRequests };
};

// Fixture "refresh planifie -> redirige vers travel-groups -> application-
// summary -> service-level -> appointment-booking" - pour CR-F.
const startRedirectToTravelGroupsFixture = async (): Promise<FixtureSite> => {
  const requestLog: string[] = [];
  let appointmentRequests = 0;
  const { server, baseUrl } = await listenFixture((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.startsWith("/workflow/appointment-booking/")) {
      appointmentRequests += 1;
      if (appointmentRequests !== 2) { res.end(READY_NO_SLOTS_HTML); return; }
      res.statusCode = 302;
      res.setHeader("Location", "/fr-fr/travel-groups");
      res.end();
      return;
    }
    if (url.startsWith("/fr-fr/travel-groups")) { res.end(TRAVEL_GROUPS_HTML); return; }
    if (url.startsWith("/workflow/application-summary")) { res.end(APPLICATION_SUMMARY_HTML); return; }
    if (url.startsWith("/workflow/service-level")) { res.end(SERVICE_LEVEL_HTML); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  }, requestLog);
  return { server, baseUrl, requestLog, appointmentReloadCount: () => appointmentRequests };
};

// Fixture "refresh planifie -> redirige directement vers service-level ->
// Continuer -> appointment-booking" - pour CR-G.
const startRedirectToServiceLevelFixture = async (): Promise<FixtureSite> => {
  const requestLog: string[] = [];
  let appointmentRequests = 0;
  const { server, baseUrl } = await listenFixture((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.startsWith("/workflow/appointment-booking/")) {
      appointmentRequests += 1;
      if (appointmentRequests !== 2) { res.end(READY_NO_SLOTS_HTML); return; }
      res.statusCode = 302;
      res.setHeader("Location", "/workflow/service-level");
      res.end();
      return;
    }
    if (url.startsWith("/workflow/service-level")) { res.end(SERVICE_LEVEL_HTML); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  }, requestLog);
  return { server, baseUrl, requestLog, appointmentReloadCount: () => appointmentRequests };
};

// Fixture "refresh planifie -> redirige vers login/auth (raccourci vers
// service-level) -> Continuer -> appointment-booking" - pour CR-H.
const startRedirectToAuthFixture = async (): Promise<FixtureSite> => {
  const requestLog: string[] = [];
  let appointmentRequests = 0;
  const { server, baseUrl } = await listenFixture((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.startsWith("/workflow/appointment-booking/")) {
      appointmentRequests += 1;
      if (appointmentRequests !== 2) { res.end(READY_NO_SLOTS_HTML); return; }
      res.statusCode = 302;
      res.setHeader("Location", "/fr-fr/login");
      res.end();
      return;
    }
    if (url.startsWith("/fr-fr/login")) { res.end(LOGIN_HTML_TO_SERVICE_LEVEL); return; }
    if (url.startsWith("/workflow/service-level")) { res.end(SERVICE_LEVEL_HTML); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  }, requestLog);
  return { server, baseUrl, requestLog, appointmentReloadCount: () => appointmentRequests };
};

// Fixture "refresh planifie -> redirige vers une page reellement inconnue
// (jamais un motif reconnu) -> unknown -> targetUrl (country page) -> home ->
// auth (raccourci vers service-level) -> appointment-booking" - pour CR-I
// (preuve du CAS D: retour borne vers targetUrl depuis un etat inconnu).
const startRedirectToUnknownThenRecoverableFixture = async (): Promise<FixtureSite> => {
  const requestLog: string[] = [];
  let appointmentRequests = 0;
  const { server, baseUrl } = await listenFixture((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.startsWith("/workflow/appointment-booking/")) {
      appointmentRequests += 1;
      if (appointmentRequests !== 2) { res.end(READY_NO_SLOTS_HTML); return; }
      res.statusCode = 302;
      res.setHeader("Location", "/misc/blank");
      res.end();
      return;
    }
    if (url.startsWith("/misc/blank")) { res.end(BLANK_UNKNOWN_HTML); return; }
    if (url.startsWith("/fr-fr/country/")) { res.end(COUNTRY_HOME_HTML); return; }
    if (url.startsWith("/fr-fr/login")) { res.end(LOGIN_HTML_TO_SERVICE_LEVEL); return; }
    if (url.startsWith("/workflow/service-level")) { res.end(SERVICE_LEVEL_HTML); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  }, requestLog);
  return { server, baseUrl, requestLog, appointmentReloadCount: () => appointmentRequests };
};

// Fixture "refresh planifie -> redirige vers une page inconnue, et targetUrl
// ne mene NULLE PART de reconnu non plus" - pour CR-J (echec borne, jamais une
// boucle infinie).
const startUnrecoverableUnknownFixture = async (): Promise<FixtureSite> => {
  const requestLog: string[] = [];
  let appointmentRequests = 0;
  const { server, baseUrl } = await listenFixture((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.startsWith("/workflow/appointment-booking/")) {
      appointmentRequests += 1;
      if (appointmentRequests === 1) { res.end(READY_NO_SLOTS_HTML); return; }
      res.statusCode = 302;
      res.setHeader("Location", "/misc/blank");
      res.end();
      return;
    }
    if (url.startsWith("/misc/blank") || url.startsWith("/misc/also-blank")) { res.end(BLANK_UNKNOWN_HTML); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  }, requestLog);
  return { server, baseUrl, requestLog, appointmentReloadCount: () => appointmentRequests };
};

const closeFixture = async (fixture: FixtureSite): Promise<void> => {
  fixture.server.closeAllConnections?.();
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
};

// ===================== Capture de logs =====================

type CapturedLog = { level: MonitorEventLevel; message: string; atMs: number };
const makeLogCapture = (startedAt: number): { entries: CapturedLog[]; log: (level: MonitorEventLevel, message: string) => void } => {
  const entries: CapturedLog[] = [];
  return { entries, log: (level, message) => entries.push({ level, message, atMs: Date.now() - startedAt }) };
};

const FORBIDDEN_LOG_SUBSTRINGS = [FAKE_LOGIN.toLowerCase(), FAKE_PASSWORD.toLowerCase(), "password=", "cookie:", "authorization:"];
const assertNoSecretsInLogs = (entries: CapturedLog[], description: string): void => {
  const offending = entries.filter((entry) => FORBIDDEN_LOG_SUBSTRINGS.some((needle) => entry.message.toLowerCase().includes(needle)));
  assert(offending.length === 0, `${description} (recu: ${offending.length} ligne(s) suspecte(s))`);
};

const CONTROL_REFRESH_LOG_MARKER = "Refresh de controle planifie";

// ===================== Config AppConfig minimal (monitor.ts direct) =====================

const BASE_DIRECT_CONFIG: Omit<AppConfig, "targetUrl" | "controlRefreshIntervalMs"> = {
  connectToExistingChrome: false,
  chromeDebugUrl: "",
  refreshIntervalMs: 1_000,
  headless: true,
  slowMoMs: 0,
  debugKeepBrowserOpen: false,
  maxRefreshAttempts: 0,
  scanMonthCount: 1,
  maxParallelScansPerDomain: 5,
  monthClickMinDelayMs: 50,
  monthClickMaxDelayMs: 100,
  botCycleCooldownMinMs: 150,
  botCycleCooldownMaxMs: 300,
  refreshEveryCycles: 0,
  // 0 (jamais un vrai cooldown qui persiste): orchestrator.ts (domainStates)
  // est un singleton AU NIVEAU DU MODULE, partage par TOUS les scenarios de
  // ce fichier (tous sur 127.0.0.1) - un cooldown non-nul appliquerait un
  // vrai delai qui survivrait au-dela du scenario qui l'a declenche
  // (ex. CR-L) et polluerait les scenarios suivants (ex. CR-N). Chaque
  // scenario verifie onRateLimited (le fait que le cooldown a ete demande),
  // jamais sa duree exacte - aucune assertion n'est affaiblie par ce choix.
  rateLimitCooldownMinutes: 0
};

const makeDirectConfig = (targetUrl: string, controlRefreshIntervalMs: number): AppConfig => ({
  ...BASE_DIRECT_CONFIG,
  targetUrl,
  controlRefreshIntervalMs
});

type DirectRunHandle = { promise: Promise<void>; abort: () => void; signal: AbortSignal };

const startDirectMonitoring = (
  page: import("playwright").Page,
  config: AppConfig,
  capture: { entries: CapturedLog[]; log: (level: MonitorEventLevel, message: string) => void },
  extraRuntime: Partial<MonitorRuntime> = {}
): DirectRunHandle => {
  const controller = new AbortController();
  const promise = monitorAppointments(page, config, {
    log: capture.log,
    signal: controller.signal,
    recoverWorkflow: async () => null,
    ...extraRuntime
  });
  return { promise, abort: () => controller.abort(), signal: controller.signal };
};

// ===================== CR-A: appointment-booking stable - 1 refresh, timer repart =====================

const runScenarioCRA = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-A: appointment-booking stable -> refresh de controle du -> 1 refresh -> surveillance continue (timer repart pour un cycle complet) ===");
  const fixture = await startAlwaysReadyFixture();
  const context = await browser.newContext();
  const page = await context.newPage();
  const startedAt = Date.now();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(startedAt);
    let refreshSucceededCalls = 0;

    const config = makeDirectConfig(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, 700);
    const handle = startDirectMonitoring(page, config, capture, {
      onRefreshSucceeded: () => { refreshSucceededCalls += 1; }
    });

    await waitUntil(() => refreshSucceededCalls >= 1, 15_000);
    // Fenetre < 2x l'intervalle (700ms): si le timer ne repartait pas
    // correctement pour un cycle COMPLET apres le succes, un second refresh
    // apparaitrait ici alors qu'il ne devrait pas encore etre du.
    await sleep(900);
    handle.abort();
    await handle.promise;

    assert(refreshSucceededCalls === 1, `CR-A) Exactement 1 refresh de controle reussi dans la fenetre observee (recu: ${refreshSucceededCalls})`);
    assert(fixture.appointmentReloadCount() === 2, `CR-A) Exactement 2 requetes vers appointment-booking (page initiale + 1 reload de controle, jamais davantage) (recu: ${fixture.appointmentReloadCount()})`);
    assert(
      capture.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)),
      "CR-A) Le refresh de controle temporel (jamais base sur un nombre de cycles) est bien journalise"
    );
    assertNoSecretsInLogs(capture.entries, "CR-A) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-B/C/D: reservation prioritaire, jamais interrompue par le timer =====================

const runScenarioCRBCD = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-B/C/D: creneau detecte + reservation en cours/confirmee -> AUCUN refresh de controle, meme deja du depuis le debut ===");
  const fixture = await startSlotAvailableFixture();
  const context = await browser.newContext();
  const page = await context.newPage();
  const startedAt = Date.now();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(startedAt);
    let waitForUserCalls = 0;
    let slotDetected = false;

    // Deja "du" depuis AVANT meme le premier cycle (1ms): si le refresh de
    // controle avait la moindre priorite sur la reservation, il se
    // declencherait immediatement au lieu de traiter le creneau.
    const config = makeDirectConfig(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, 1);
    const handle = startDirectMonitoring(page, config, capture, {
      waitForUser: async () => { waitForUserCalls += 1; },
      onSlotDetected: () => { slotDetected = true; }
    });

    await waitUntil(() => waitForUserCalls >= 1, 20_000);
    handle.abort();
    await handle.promise;

    assert(slotDetected, "CR-B/C/D) Le creneau est bien detecte et notifie (onSlotDetected) - aucune regression du chemin creneau/notification (Q)");
    assert(
      capture.entries.some((e) => e.message.includes("RENDEZ_VOUS_RESERVE_TEMPORAIRE")),
      "CR-B/C/D) La reservation est confirmee normalement (order-summary), comportement 0.2.3 inchange"
    );
    assert(waitForUserCalls === 1, `CR-B/C/D) La surveillance s'arrete pour attendre l'utilisateur apres reservation, une seule fois (recu: ${waitForUserCalls})`);
    assert(
      !capture.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)),
      "CR-B/C/D) Aucun refresh de controle n'a jamais ete declenche pendant le scan/la selection/la reservation, ni apres confirmation (priorite reservation/securite du workflow > timer)"
    );
    assert(page.url().includes("/workflow/order-summary/"), "CR-B/C/D) order-summary est conserve (jamais reload/navigation parasite apres confirmation)");
    assertNoSecretsInLogs(capture.entries, "CR-B/C/D) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-E: refresh -> /fr-fr -> logged-out-landing -> targetUrl -> appointment-booking (agent) =====================

const runScenarioCRE = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-E: refresh de controle -> /fr-fr -> logged-out-landing -> goto(targetUrl) -> home -> auth -> appointment-booking ===");
  const fixture = await startRedirectToLoggedOutLandingFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(Date.now());
    const { reporter, statuses } = makeFakeReporter();
    const targetUrl = `${fixture.baseUrl}/fr-fr/country/tn/vac/tnTUN2fr`;

    const handle = startMonitoring({
      botId: "bot-cr-e",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl,
      commandId: "cmd-cr-e",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      controlRefreshIntervalMs: 500,
      isBotStillRegistered: () => true,
      runtimeCredentials: { login: FAKE_LOGIN, password: FAKE_PASSWORD }
    });

    // Fenetre large: waitForPageReadyAfterRefresh (monitor.ts) sonde ~30s
    // avant de constater l'echec du reload, PUIS le recovery pilote par etat
    // enchaine jusqu'a 4 tentatives bornees (home->auth->service-level,
    // chacune avec son propre delai de reglage) - jamais raccourci ici
    // (aucune modification des delais de production).
    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 110_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(
      capture.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)),
      "CR-E) Le refresh est bien declenche par le timer de controle (temps reel), pas par un nombre de cycles"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Accueil TLS deconnecte (logged-out-landing) detecte pendant la reprise")),
      "CR-E) L'accueil deconnecte (/fr-fr) est classifie explicitement comme logged-out-landing"
    );
    assert(
      capture.entries.some((e) => /retour vers targetUrl \([^)]*\/fr-fr\/country\/tn\/vac\/tnTUN2fr\)/.test(e.message)),
      "CR-E) Le retour utilise targetUrl deja fourni au monitoring, exactement (meme mecanisme reutilise, jamais une deuxieme architecture)"
    );
    assert(capture.entries.some((e) => e.message.includes("etat detecte = home")), "CR-E) L'etat home (country page) est ensuite classifie");
    assert(capture.entries.some((e) => e.message.includes("etat detecte = auth")), "CR-E) L'etape auth est ensuite atteinte");
    assert(
      capture.entries.some((e) => e.message.includes("nouvelle tentative de connexion automatique")),
      "CR-E) Les identifiants deja en memoire sont reutilises (jamais un nouveau credential)"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")),
      "CR-E) Le monitoring reprend et aboutit a appointment-booking"
    );
    assert(statuses.every((s) => s.status !== "WAITING_FOR_USER" && s.status !== "ERROR"), "CR-E) Aucun WAITING_FOR_USER/ERROR emis");
    assertNoSecretsInLogs(capture.entries, "CR-E) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-F: refresh -> travel-groups -> recovery pilote par etat -> appointment-booking (agent) =====================

const runScenarioCRF = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-F: refresh de controle -> travel-groups -> recovery pilote par etat -> application-summary -> service-level -> appointment-booking ===");
  const fixture = await startRedirectToTravelGroupsFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(Date.now());
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-cr-f",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/never-used-marker`,
      commandId: "cmd-cr-f",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      controlRefreshIntervalMs: 500,
      isBotStillRegistered: () => true
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 90_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(capture.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)), "CR-F) Le refresh de controle temporel a bien declenche la reprise");
    assert(capture.entries.some((e) => e.message.includes("etat detecte = travel-groups")), "CR-F) L'etat intermediaire connu (travel-groups) est classifie, jamais un goto(targetUrl) aveugle");
    assert(!capture.entries.some((e) => e.message.includes("never-used-marker")), "CR-F) targetUrl n'est jamais utilise: l'etat reel connu suffit");
    assert(capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), "CR-F) Le monitoring reprend et aboutit a appointment-booking");
    assert(statuses.every((s) => s.status !== "WAITING_FOR_USER" && s.status !== "ERROR"), "CR-F) Aucun WAITING_FOR_USER/ERROR emis");
    assertNoSecretsInLogs(capture.entries, "CR-F) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-G: refresh -> service-level -> Continuer -> appointment-booking (agent) =====================

const runScenarioCRG = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-G: refresh de controle -> service-level -> Continuer -> appointment-booking ===");
  const fixture = await startRedirectToServiceLevelFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(Date.now());
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-cr-g",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/never-used-marker`,
      commandId: "cmd-cr-g",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      controlRefreshIntervalMs: 500,
      isBotStillRegistered: () => true
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 70_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(capture.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)), "CR-G) Le refresh de controle temporel a bien declenche la reprise");
    assert(capture.entries.some((e) => e.message.includes("etat detecte = service-level")), "CR-G) L'etat service-level est classifie et le clic 'Continuer' reutilise");
    assert(capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), "CR-G) Le monitoring reprend et aboutit a appointment-booking");
    assert(statuses.every((s) => s.status !== "WAITING_FOR_USER" && s.status !== "ERROR"), "CR-G) Aucun WAITING_FOR_USER/ERROR emis");
    assertNoSecretsInLogs(capture.entries, "CR-G) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-H: refresh -> auth -> credentials runtime -> appointment-booking (agent) =====================

const runScenarioCRH = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-H: refresh de controle -> auth/login -> credentials runtime (fillLoginForm) -> service-level -> appointment-booking ===");
  const fixture = await startRedirectToAuthFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(Date.now());
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-cr-h",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/never-used-marker`,
      commandId: "cmd-cr-h",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      controlRefreshIntervalMs: 500,
      isBotStillRegistered: () => true,
      runtimeCredentials: { login: FAKE_LOGIN, password: FAKE_PASSWORD }
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 80_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(capture.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)), "CR-H) Le refresh de controle temporel a bien declenche la reprise");
    assert(capture.entries.some((e) => e.message.includes("etat detecte = auth")), "CR-H) L'etat auth/login est classifie");
    assert(
      capture.entries.some((e) => e.message.includes("nouvelle tentative de connexion automatique")),
      "CR-H) Les identifiants runtime deja en memoire sont reutilises pour la reconnexion"
    );
    assert(capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), "CR-H) Le monitoring reprend et aboutit a appointment-booking");
    assert(statuses.every((s) => s.status !== "WAITING_FOR_USER" && s.status !== "ERROR"), "CR-H) Aucun WAITING_FOR_USER/ERROR emis");
    assertNoSecretsInLogs(capture.entries, "CR-H) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-I: refresh -> unknown -> goto(targetUrl) -> etat connu -> appointment-booking (agent, CAS D) =====================

const runScenarioCRI = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-I (CAS D): refresh de controle -> etat reellement inconnu -> retour borne vers targetUrl -> home -> auth -> appointment-booking ===");
  const fixture = await startRedirectToUnknownThenRecoverableFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(Date.now());
    const { reporter, statuses } = makeFakeReporter();
    const targetUrl = `${fixture.baseUrl}/fr-fr/country/tn/vac/tnTUN2fr`;

    const handle = startMonitoring({
      botId: "bot-cr-i",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl,
      commandId: "cmd-cr-i",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      controlRefreshIntervalMs: 500,
      isBotStillRegistered: () => true,
      runtimeCredentials: { login: FAKE_LOGIN, password: FAKE_PASSWORD }
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 110_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(capture.entries.some((e) => e.message.includes("etat detecte = unknown")), "CR-I) L'etat reellement inconnu est classifie 'unknown' (jamais confondu avec un autre etat)");
    assert(
      capture.entries.some((e) => e.message.includes("tentative bornee de retour vers targetUrl")),
      "CR-I) Depuis 'unknown', une tentative BORNEE de retour vers targetUrl est declenchee (CAS D) - jamais un clic au hasard sur la page inconnue"
    );
    assert(
      capture.entries.some((e) => /retour vers targetUrl \([^)]*\/fr-fr\/country\/tn\/vac\/tnTUN2fr\)/.test(e.message)),
      "CR-I) Le retour utilise targetUrl deja fourni au monitoring, exactement (meme helper que logged-out-landing, jamais une deuxieme architecture)"
    );
    assert(capture.entries.some((e) => e.message.includes("etat detecte = home")), "CR-I) Une fois revenu sur targetUrl, l'etat reel (home) est correctement reclassifie");
    assert(capture.entries.some((e) => e.message.includes("etat detecte = auth")), "CR-I) Puis l'etape auth est atteinte et classifiee");
    assert(capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), "CR-I) Le monitoring aboutit finalement a appointment-booking");
    assert(statuses.every((s) => s.status !== "WAITING_FOR_USER" && s.status !== "ERROR"), "CR-I) Aucun WAITING_FOR_USER/ERROR emis: la reprise depuis 'unknown' a reussi seule");
    assertNoSecretsInLogs(capture.entries, "CR-I) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-J: unknown + targetUrl inexploitable -> fallback borne, jamais une boucle infinie (agent) =====================
//
// Important (comportement 0.2.3 PREEXISTANT, inchange ici): un refresh
// planifie qui echoue (hors rate-limit) alerte via alertAndPause() puis
// REPREND la surveillance (jamais un arret terminal comme pour la page
// inattendue detectee en tete de cycle) - ce n'est donc PAS le meme
// mecanisme que WORKFLOW_RECOVERY_FAILED (reserve a detectUnexpectedPageReason).
// Ce test verifie donc precisement ce qui est explicitement demande: CHAQUE
// tentative de recovery reste bornee a exactement 4 essais (jamais une boucle
// infinie a l'INTERIEUR d'une tentative), et le fallback existant
// (alertAndPause/intervention humaine) se declenche bien apres cet echec -
// jamais une modification du fallback 0.2.3 lui-meme.

const runScenarioCRJ = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-J: 'unknown' + targetUrl inexploitable -> chaque tentative de recovery reste BORNEE a 4 essais, jamais une boucle infinie ===");
  const fixture = await startUnrecoverableUnknownFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(Date.now());
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-cr-j",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/misc/also-blank`,
      commandId: "cmd-cr-j",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 300,
      workflowRecoveryLongWaitMs: 800,
      controlRefreshIntervalMs: 500,
      isBotStillRegistered: () => true
    });

    // Fenetre large: ~30s de waitForPageReadyAfterRefresh (monitor.ts) avant
    // meme que le recovery ne demarre, puis jusqu'a 4 tentatives bornees.
    // On s'arrete des que le fallback (alertAndPause) se declenche - APRES
    // cet appel, l'agent attend 15s (AGENT_HUMAN_POLL_MS, annulable) avant de
    // retenter un nouveau round complet: fenetre sure pour observer
    // exactement UN round de 4 tentatives, jamais plus, avant d'annuler.
    await waitUntil(
      () => capture.entries.some((e) => e.message.includes("Intervention humaine potentiellement requise")),
      90_000
    );
    handle.abortController.abort();
    await handle.loopPromise;

    const recoveryAttemptLogs = capture.entries.filter((e) => /Reprise workflow \d\/4/.test(e.message));
    assert(recoveryAttemptLogs.length === 4, `CR-J) Exactement 4 tentatives BORNEES pour ce round (jamais une boucle infinie malgre "unknown" a chaque fois) (recu: ${recoveryAttemptLogs.length})`);
    assert(
      recoveryAttemptLogs.every((e) => e.message.includes("etat detecte = unknown")),
      "CR-J) Chaque tentative reclassifie bien 'unknown' (la page reste reellement non reconnue, meme apres retour vers targetUrl)"
    );
    assert(
      capture.entries.some((e) => e.message.includes("ALERTE_UTILISATEUR")) && capture.entries.some((e) => e.message.includes("Intervention humaine potentiellement requise")),
      "CR-J) Le fallback existant (alertAndPause/intervention humaine) se declenche bien apres l'echec du recovery - comportement 0.2.3 inchange"
    );
    assert(statuses.every((s) => s.status !== "WAITING_FOR_USER"), "CR-J) WORKFLOW_RECOVERY_FAILED reste reserve a detectUnexpectedPageReason (jamais emis ici, comportement 0.2.3 inchange pour ce chemin)");
    assertNoSecretsInLogs(capture.entries, "CR-J) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-K: Cloudflare/validation humaine present a l'echeance -> aucun refresh =====================

const runScenarioCRK = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-K: validation humaine/Cloudflare presente pendant toute l'attente -> le refresh de controle n'est JAMAIS evalue ===");
  const fixture = await startBlockedFixture("Access denied - verification requise (test).", 0);
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(Date.now());

    // Deja "du" depuis le tout debut (1ms): si detectHumanValidation ne
    // bloquait pas l'acces au point sur, un refresh apparaitrait
    // immediatement.
    const config = makeDirectConfig(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, 1);
    const handle = startDirectMonitoring(page, config, capture, {
      waitForUser: async () => undefined
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Intervention humaine potentiellement requise")), 10_000);
    await sleep(500);
    handle.abort();
    await handle.promise;

    assert(
      capture.entries.some((e) => e.message.includes("Intervention humaine potentiellement requise")),
      "CR-K) Le blocage de validation humaine/Cloudflare est bien detecte"
    );
    assert(
      !capture.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)),
      "CR-K) Aucun refresh de controle n'est jamais declenche pendant que le blocage humain/Cloudflare est present"
    );
    assert(fixture.appointmentReloadCount() === 1, `CR-K) Aucun reload de la page bloquee (une seule requete initiale) (recu: ${fixture.appointmentReloadCount()})`);
    assertNoSecretsInLogs(capture.entries, "CR-K) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-L: rate-limit present a l'echeance -> aucun refresh =====================

const runScenarioCRL = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-L: rate-limit (Error 1015) present pendant toute l'attente -> le refresh de controle n'est JAMAIS evalue, cooldown existant seul mecanisme ===");
  const fixture = await startBlockedFixture("Error 1015 - Acces temporairement limite (test).", 0);
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(Date.now());
    let rateLimitedCalls = 0;

    const config = makeDirectConfig(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, 1);
    const handle = startDirectMonitoring(page, config, capture, {
      waitForUser: async () => undefined,
      onRateLimited: () => { rateLimitedCalls += 1; }
    });

    await waitUntil(() => rateLimitedCalls >= 1, 10_000);
    await sleep(500);
    handle.abort();
    await handle.promise;

    assert(rateLimitedCalls >= 1, "CR-L) Le rate limit est detecte et le cooldown existant applique (onRateLimited)");
    assert(
      !capture.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)),
      "CR-L) Aucun refresh de controle declenche pendant le rate-limit/cooldown (jamais un reload 'pour tester' si le blocage a leve)"
    );
    assertNoSecretsInLogs(capture.entries, "CR-L) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-M: STOP_BOT pendant l'attente du timer -> arret immediat, aucun refresh apres =====================

const runScenarioCRM = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-M: STOP_BOT (signal aborted) pendant l'attente du refresh de controle -> arret immediat, aucun timer orphelin, aucun refresh apres ===");
  const fixture = await startAlwaysReadyFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(Date.now());

    // Intervalle deliberement plus long que le delai avant STOP_BOT: le
    // refresh ne doit jamais avoir l'occasion de se declencher.
    const config = makeDirectConfig(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, 10_000);
    const handle = startDirectMonitoring(page, config, capture);

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Surveillance tentative 1")), 5_000);
    const stoppedAt = Date.now();
    handle.abort();
    await handle.promise;
    const stopDurationMs = Date.now() - stoppedAt;

    assert(stopDurationMs < 3_000, `CR-M) L'arret (STOP_BOT) est immediat, jamais bloque par l'attente du timer de controle (recu: ${stopDurationMs}ms)`);
    assert(
      capture.entries.some((e) => e.message.includes("Surveillance interrompue (arret demande)")),
      "CR-M) L'arret demande est bien journalise"
    );
    assert(
      !capture.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)),
      "CR-M) Aucun refresh de controle n'a eu lieu avant NI apres l'arret (aucun timer orphelin ne survit a STOP_BOT)"
    );
    assertNoSecretsInLogs(capture.entries, "CR-M) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-N: deux bots, heures de depart differentes -> timers independants =====================

const runScenarioCRN = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-N: deux bots demarres a des heures differentes -> chacun son propre timer de refresh de controle, jamais partage/synchronise ===");
  const fixtureA = await startAlwaysReadyFixture();
  const fixtureB = await startAlwaysReadyFixture();
  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();

  try {
    await pageA.goto(`${fixtureA.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const startedAtA = Date.now();
    const captureA = makeLogCapture(startedAtA);
    const configA = makeDirectConfig(`${fixtureA.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, 900);
    const handleA = startDirectMonitoring(pageA, configA, captureA);

    // Bot B demarre 500ms plus tard que bot A - jamais le meme instant.
    const staggerMs = 500;
    await sleep(staggerMs);
    await pageB.goto(`${fixtureB.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const startedAtB = Date.now();
    const captureB = makeLogCapture(startedAtB);
    const configB = makeDirectConfig(`${fixtureB.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, 900);
    const handleB = startDirectMonitoring(pageB, configB, captureB);

    await waitUntil(() => captureA.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)), 15_000);
    await waitUntil(() => captureB.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)), 15_000);
    handleA.abort();
    handleB.abort();
    await Promise.all([handleA.promise, handleB.promise]);

    const firstRefreshAtA = captureA.entries.find((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER))?.atMs ?? -1;
    const firstRefreshAtB = captureB.entries.find((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER))?.atMs ?? -1;

    assert(firstRefreshAtA >= 0 && firstRefreshAtB >= 0, "CR-N) Chaque bot declenche bien son propre refresh de controle");
    // Chaque timer est relatif au DEMARRAGE de CE bot (~900ms apres SON
    // propre debut), jamais a une horloge globale partagee - la difference
    // absolue entre les deux instants de demarrage (staggerMs) doit rester
    // visible sur l'horloge absolue du process, pas annulee par un timer
    // commun.
    assert(
      firstRefreshAtA >= 700 && firstRefreshAtA <= 1_600,
      `CR-N) Bot A refresh ~900ms apres SON propre debut (recu: ${firstRefreshAtA}ms)`
    );
    assert(
      firstRefreshAtB >= 700 && firstRefreshAtB <= 1_600,
      `CR-N) Bot B refresh ~900ms apres SON PROPRE debut (decale de ${staggerMs}ms par rapport a A), jamais synchronise sur le timer de A (recu: ${firstRefreshAtB}ms)`
    );
    assertNoSecretsInLogs(captureA.entries, "CR-N) Aucun secret dans les logs (bot A)");
    assertNoSecretsInLogs(captureB.entries, "CR-N) Aucun secret dans les logs (bot B)");
  } finally {
    await context.close();
    await closeFixture(fixtureA);
    await closeFixture(fixtureB);
  }
};

// ===================== CR-O: timer en retard pendant un etat non sur -> UN SEUL refresh au retour a un point sur =====================

const runScenarioCRO = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-O: refresh de controle deja tres en retard pendant un blocage -> UN SEUL refresh une fois le point sur retrouve (jamais un rattrapage en rafale) ===");
  const fixture = await startBlockedFixture("Access denied - verification requise (test).", 1_500);
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(Date.now());
    let refreshSucceededCalls = 0;

    // Deja tres en retard (200ms) alors que le blocage dure 1500ms: au
    // moment ou la page redevient exploitable, le refresh de controle est
    // deja "du" depuis longtemps.
    const config = makeDirectConfig(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, 200);
    const handle = startDirectMonitoring(page, config, capture, {
      onRefreshSucceeded: () => { refreshSucceededCalls += 1; }
    });

    await waitUntil(() => refreshSucceededCalls >= 1, 20_000);
    // Fenetre d'observation apres le premier refresh, mais TOUJOURS
    // inferieure au prochain intervalle complet (200ms): si un rattrapage en
    // rafale avait lieu, plusieurs refresh apparaitraient ici.
    await sleep(150);
    handle.abort();
    await handle.promise;

    assert(refreshSucceededCalls === 1, `CR-O) Exactement UN refresh de controle malgre le retard accumule pendant le blocage (recu: ${refreshSucceededCalls})`);
    const controlRefreshLogs = capture.entries.filter((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER));
    assert(controlRefreshLogs.length === 1, `CR-O) Exactement UNE tentative de refresh de controle journalisee (jamais plusieurs accumulees) (recu: ${controlRefreshLogs.length})`);
    assertNoSecretsInLogs(capture.entries, "CR-O) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-P: exception cote client - quick refresh 0.2.3 inchange, jamais affecte par le refresh de controle =====================

const runScenarioCRP = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-P: exception cote client -> quick refresh (0.2.3) toujours prioritaire et inchange, meme avec le refresh de controle configure ===");
  const fixture = await startClientExceptionFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(Date.now());
    let refreshFailedCalls = 0;

    // Intervalle long (jamais du pendant ce test): prouve que c'est bien le
    // quick refresh (niveau 1, section 2 du hotfix 0.2.3) qui agit ici,
    // jamais le refresh de controle temporel.
    const config = makeDirectConfig(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, 60_000);
    const handle = startDirectMonitoring(page, config, capture, {
      onRefreshFailed: () => { refreshFailedCalls += 1; }
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retablie apres refresh. Surveillance reprise.")), 20_000);
    handle.abort();
    await handle.promise;

    assert(
      capture.entries.some((e) => e.message.includes("Refresh simple (erreur applicative TLS)")),
      "CR-P) Le quick refresh (niveau 1, 0.2.3) est toujours tente en premier pour une exception cote client"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retablie apres refresh. Surveillance reprise.")),
      "CR-P) La restauration via quick refresh fonctionne exactement comme en 0.2.3"
    );
    assert(
      !capture.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)),
      "CR-P) Le refresh de controle temporel n'interfere jamais avec le quick refresh existant (jamais du dans cette fenetre)"
    );
    assert(refreshFailedCalls === 0, "CR-P) Aucun echec de refresh comptabilise: le quick refresh a suffi, comme en 0.2.3");
    assertNoSecretsInLogs(capture.entries, "CR-P) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-Q: recovery normal AVANT l'echeance -> echeance jamais repoussee =====================
//
// BUG CIBLE (refresh de controle 20 min repousse par un recovery normal):
// reproduit ici SANS le refresh planifie (`unexpectedReason` generique
// declenche en tete de cycle - la page devient hors workflow AVANT
// l'echeance, jamais parce que le refresh planifie etait du). Avant
// correctif: le recovery reussi appelait scheduleNextControlRefresh() sans
// condition, ce qui repoussait l'echeance d'un intervalle complet supplementaire.

const runScenarioCRQ = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-Q: recovery normal (page hors workflow) AVANT l'echeance -> l'echeance n'est PAS repoussee ===");
  const fixture = await startAlwaysReadyFixture();
  const context = await browser.newContext();
  const page = await context.newPage();
  const readyUrl = `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`;

  try {
    await page.goto(readyUrl, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(Date.now());
    let recoverWorkflowCalls = 0;

    const config = makeDirectConfig(readyUrl, 2_500);
    const handle = startDirectMonitoring(page, config, capture, {
      recoverWorkflow: async () => {
        recoverWorkflowCalls += 1;
        await sleep(300);
        if (!page.isClosed()) {
          await page.goto(readyUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
        }
        return page;
      }
    });

    // Page hors workflow declenchee bien AVANT l'echeance (700ms << 2500ms),
    // recovery termine ~1000ms - toujours avant l'echeance.
    await sleep(700);
    await page.goto("about:blank").catch(() => undefined);

    await waitUntil(() => recoverWorkflowCalls >= 1, 10_000);
    await waitUntil(() => capture.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)), 15_000);
    handle.abort();
    await handle.promise;

    const refreshAtMs = capture.entries.find((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER))?.atMs ?? -1;

    assert(recoverWorkflowCalls === 1, `CR-Q) Le recovery normal a bien ete declenche une fois (recu: ${recoverWorkflowCalls})`);
    assert(
      capture.entries.some((e) => e.message === "Page de rendez-vous retrouvee automatiquement. Surveillance reprise."),
      "CR-Q) Le recovery normal (page hors workflow) a bien reussi"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Echeance du refresh de controle inchangee par ce recovery normal")),
      "CR-Q) Le log confirme explicitement que l'echeance n'a pas ete modifiee par ce recovery normal"
    );
    assert(
      refreshAtMs >= 2_200 && refreshAtMs <= 3_200,
      `CR-Q) Le refresh de controle survient bien autour de l'echeance ORIGINALE (~2500ms), jamais repoussee d'un intervalle complet supplementaire par le recovery normal (recu: ${refreshAtMs}ms)`
    );
    assertNoSecretsInLogs(capture.entries, "CR-Q) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-R: recovery normal qui traverse l'echeance -> refresh reste DU =====================
//
// Le recovery normal COMMENCE avant l'echeance et se TERMINE apres - le
// refresh de controle doit rester du et etre traite au prochain point sur
// (immediatement apres le recovery), jamais reporte d'un intervalle complet
// supplementaire a partir de la fin du recovery.

const runScenarioCRR = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-R: recovery normal qui commence AVANT l'echeance et se termine APRES -> le refresh reste DU, traite au prochain point sur ===");
  const fixture = await startAlwaysReadyFixture();
  const context = await browser.newContext();
  const page = await context.newPage();
  const readyUrl = `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`;

  try {
    await page.goto(readyUrl, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(Date.now());
    let recoverWorkflowCalls = 0;
    let refreshSucceededCalls = 0;

    const config = makeDirectConfig(readyUrl, 1_200);
    const handle = startDirectMonitoring(page, config, capture, {
      recoverWorkflow: async () => {
        recoverWorkflowCalls += 1;
        // Recovery volontairement lent: declenche avant l'echeance (1200ms),
        // termine bien APRES (l'echeance est deja depassee a son retour).
        await sleep(700);
        if (!page.isClosed()) {
          await page.goto(readyUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
        }
        return page;
      },
      onRefreshSucceeded: () => { refreshSucceededCalls += 1; }
    });

    // Declenche a 900ms (< 1200ms), termine ~1600ms (> 1200ms).
    await sleep(900);
    await page.goto("about:blank").catch(() => undefined);

    await waitUntil(() => recoverWorkflowCalls >= 1, 10_000);
    await waitUntil(() => refreshSucceededCalls >= 1, 10_000);
    await sleep(300);
    handle.abort();
    await handle.promise;

    const recoverAtMs = capture.entries.find((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement. Surveillance reprise."))?.atMs ?? -1;
    const refreshAtMs = capture.entries.find((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER))?.atMs ?? -1;

    assert(recoverWorkflowCalls === 1, `CR-R) Le recovery normal a bien ete declenche une fois avant l'echeance (recu: ${recoverWorkflowCalls})`);
    assert(recoverAtMs >= 1_400, `CR-R) Le recovery se termine bien APRES l'echeance initiale de 1200ms (recu: ${recoverAtMs}ms)`);
    assert(
      capture.entries.some((e) => e.message.includes("Refresh de controle deja du: ce recovery normal ne repousse pas l'echeance")),
      "CR-R) Le log confirme que le refresh etait deja du au moment du recovery et que l'echeance n'a pas ete repoussee"
    );
    assert(refreshSucceededCalls === 1, `CR-R) Exactement UN refresh de controle execute (recu: ${refreshSucceededCalls})`);
    assert(
      refreshAtMs >= recoverAtMs - 50 && refreshAtMs <= recoverAtMs + 700,
      `CR-R) Le refresh de controle (deja du depuis avant le recovery) s'execute au prochain point sur juste apres le recovery, jamais reporte d'un intervalle complet supplementaire (recovery termine a ${recoverAtMs}ms, refresh a ${refreshAtMs}ms)`
    );
    assertNoSecretsInLogs(capture.entries, "CR-R) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== CR-S/CR-T: HOTFIX parametres de surveillance en
// secondes - controlRefreshIntervalSeconds pilote reellement le refresh,
// SANS l'override de test controlRefreshIntervalMs (toutes les scenarios
// CR-A a CR-R ci-dessus utilisent get override explicite ou monitor.ts
// directement - aucun ne prouve que la resolution EN PRODUCTION, via le
// snapshot de parametres, fonctionne reellement) =====================

const makeFakeReporterForSnapshot = (): AgentEventReporter => ({
  ack: () => undefined,
  completed: () => undefined,
  failed: () => undefined,
  botStatus: () => undefined
});

// CR-S: controlRefreshIntervalSeconds (snapshot) pilote le refresh reel,
// jamais AGENT_CONTROL_REFRESH_INTERVAL_MS (20 min) - aucun override de test
// controlRefreshIntervalMs n'est passe a startMonitoring() ici.
const runScenarioCRS = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-S: controlRefreshIntervalSeconds (snapshot, sans override de test) pilote reellement le refresh ===");
  const fixture = await startAlwaysReadyFixture();
  const context = await browser.newContext();
  const page = await context.newPage();
  const readyUrl = `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`;

  try {
    await page.goto(readyUrl, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture(Date.now());

    const handle = startMonitoring({
      botId: "bot-cr-s",
      page,
      context,
      settings: { ...FAST_SETTINGS, controlRefreshIntervalSeconds: 1 },
      targetUrl: readyUrl,
      commandId: "cmd-cr-s",
      reporter: makeFakeReporterForSnapshot(),
      log: capture.log,
      isBotStillRegistered: () => true
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)), 15_000);
    handle.abortController.abort();
    await handle.loopPromise;

    const refreshAtMs = capture.entries.find((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER))?.atMs ?? -1;
    assert(
      refreshAtMs >= 700 && refreshAtMs <= 5_000,
      `CR-S) Le refresh survient bien autour de l'echeance configuree via le snapshot (1s), jamais apres 20 minutes (recu: ${refreshAtMs}ms)`
    );
    assertNoSecretsInLogs(capture.entries, "CR-S) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// CR-T: deux bots avec des controlRefreshIntervalSeconds DIFFERENTS (deux
// agences distinctes en production) -> chacun applique reellement SA PROPRE
// valeur, jamais celle de l'autre bot/agence.
const runScenarioCRT = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== CR-T: deux bots, deux controlRefreshIntervalSeconds differents -> chacun applique reellement sa propre valeur ===");
  const fixtureA = await startAlwaysReadyFixture();
  const fixtureB = await startAlwaysReadyFixture();
  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();

  try {
    const readyUrlA = `${fixtureA.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`;
    const readyUrlB = `${fixtureB.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`;
    await pageA.goto(readyUrlA, { waitUntil: "domcontentloaded" });
    await pageB.goto(readyUrlB, { waitUntil: "domcontentloaded" });

    const captureA = makeLogCapture(Date.now());
    const captureB = makeLogCapture(Date.now());

    const handleA = startMonitoring({
      botId: "bot-cr-t-a", page: pageA, context, settings: { ...FAST_SETTINGS, controlRefreshIntervalSeconds: 1 },
      targetUrl: readyUrlA, commandId: "cmd-cr-t-a", reporter: makeFakeReporterForSnapshot(), log: captureA.log,
      isBotStillRegistered: () => true
    });
    const handleB = startMonitoring({
      botId: "bot-cr-t-b", page: pageB, context, settings: { ...FAST_SETTINGS, controlRefreshIntervalSeconds: 3 },
      targetUrl: readyUrlB, commandId: "cmd-cr-t-b", reporter: makeFakeReporterForSnapshot(), log: captureB.log,
      isBotStillRegistered: () => true
    });

    await waitUntil(() => captureA.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)), 15_000);
    await waitUntil(() => captureB.entries.some((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER)), 15_000);
    handleA.abortController.abort();
    handleB.abortController.abort();
    await Promise.all([handleA.loopPromise, handleB.loopPromise]);

    const refreshAtA = captureA.entries.find((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER))?.atMs ?? -1;
    const refreshAtB = captureB.entries.find((e) => e.message.includes(CONTROL_REFRESH_LOG_MARKER))?.atMs ?? -1;

    assert(refreshAtA >= 700 && refreshAtA <= 5_000, `CR-T) Bot A (1s) refresh bien autour de SA propre echeance (recu: ${refreshAtA}ms)`);
    assert(refreshAtB >= 2_500 && refreshAtB <= 8_000, `CR-T) Bot B (3s) refresh bien autour de SA propre echeance, distincte de A (recu: ${refreshAtB}ms)`);
    assertNoSecretsInLogs(captureA.entries, "CR-T) Aucun secret dans les logs (bot A)");
    assertNoSecretsInLogs(captureB.entries, "CR-T) Aucun secret dans les logs (bot B)");
  } finally {
    await context.close();
    await closeFixture(fixtureA);
    await closeFixture(fixtureB);
  }
};

// ===================== Helpers partages (agent layer) =====================

const makeFakeReporter = (): { reporter: AgentEventReporter; statuses: Array<{ status: string; details?: unknown }> } => {
  const statuses: Array<{ status: string; details?: unknown }> = [];
  const reporter: AgentEventReporter = {
    ack: () => undefined,
    completed: () => undefined,
    failed: () => undefined,
    botStatus: (_botId, _commandId, status, details) => { statuses.push({ status, details }); }
  };
  return { reporter, statuses };
};

const FAST_SETTINGS: AgentMonitoringSettings = {
  ...DEFAULT_AGENT_MONITORING_SETTINGS,
  botCycleCooldownMinMs: 500,
  botCycleCooldownMaxMs: 800,
  monthClickMinDelayMs: 100,
  monthClickMaxDelayMs: 200,
  refreshEveryCycles: 0
};

// ===================== main =====================

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL cible - Refresh temporel securise toutes les 20 minutes (agent) ===");

  if (process.platform !== "win32") {
    console.log("Plateforme non-Windows: ce test necessite Windows + Chrome. Ignore, 0 succes / 0 echec.");
    process.exit(0);
    return;
  }

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    await runScenarioCRA(browser);
    await runScenarioCRBCD(browser);
    await runScenarioCRE(browser);
    await runScenarioCRF(browser);
    await runScenarioCRG(browser);
    await runScenarioCRH(browser);
    await runScenarioCRI(browser);
    await runScenarioCRJ(browser);
    await runScenarioCRK(browser);
    await runScenarioCRL(browser);
    await runScenarioCRM(browser);
    await runScenarioCRN(browser);
    await runScenarioCRO(browser);
    await runScenarioCRP(browser);
    await runScenarioCRQ(browser);
    await runScenarioCRR(browser);
    await runScenarioCRS(browser);
    await runScenarioCRT(browser);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
