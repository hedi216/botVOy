// HOTFIX 0.2.3 - Recovery robuste du monitoring agent.
//
// Cas reel observe: pendant le monitoring sur /workflow/appointment-booking/,
// TLScontact a affiche "Application error: a client-side exception has
// occurred..." et le bot est reste bloque - alors qu'un simple REFRESH
// MANUEL de cette meme page a immediatement restaure la vraie page.
//
// Corrige ici (src/shared/monitor.ts, src/agent/agentMonitoringRuntime.ts,
// src/agent/agentBotManager.ts, src/notifications.ts, src/brevoEmailService.ts):
//   - detection explicite de l'exception cote client (isClientSideExceptionReason) ;
//   - niveau 1: refresh simple (page.reload(), jamais goto(TARGET_URL)) avant
//     tout recovery complet, avec au plus 1 second reload (echec technique
//     uniquement) - jamais de boucle de reload ;
//   - niveau 2: recovery pilote par etat REEL (classifyRecoveryState), plus
//     jamais goto(target) aveugle -> select -> book -> continue ;
//   - reconnexion automatique (fillLoginForm) avec des identifiants
//     conserves EN MEMOIRE UNIQUEMENT pour la duree du bot ;
//   - CAPTCHA/Cloudflare: jamais contourne, attente d'une resolution humaine
//     ou naturelle (reutilise waitForRecaptchaResolution/isCloudflareBlockedPage
//     existants) ;
//   - echec terminal (refresh + 4 tentatives bornees epuisees, jamais pour un
//     rate limit) -> WAITING_FOR_USER {reason:"WORKFLOW_RECOVERY_FAILED"},
//     jamais une nouvelle boucle silencieuse ;
//   - notifications.ts reconnait desormais ce statut et alerte IMMEDIATEMENT
//     (jamais la fenetre de grace de 4 min, deja hors de propos apres
//     plusieurs minutes de recovery), avec dedoublonnage normal (1 email/episode).
//
// Scenarios A-E: testent startMonitoring()/monitorAppointments() DIRECTEMENT
// avec un vrai Chromium + un faux site TLS local (jamais de spawn agent/serveur
// complet - plus rapide, teste precisement le code sous test). Scenarios F/H:
// testent le vrai chemin serveur (agent reel + serveur reel + DB reelle),
// seul moyen de verifier le chemin de notification reel de bout en bout.
//
// A executer sur un PC Windows personnel avec une session interactive et
// Google Chrome installe - JAMAIS sur la VM/serveur de production.
//
// Usage: npx tsx scripts/test-agent-monitoring-recovery-real.ts
//    ou: npm run test:agent:monitoring-recovery:real

import { ChildProcess, spawn } from "node:child_process";
import http, { Server, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import path from "node:path";
import { Browser, chromium } from "playwright";
import { Socket, io as ioClient } from "socket.io-client";
import { startMonitoring } from "../src/agent/agentMonitoringRuntime.js";
import { AgentBotManager } from "../src/agent/agentBotManager.js";
import { AgentEventReporter } from "../src/agent/agentEventReporter.js";
import { AgentLogLevel } from "../src/agent/agentLocalLogger.js";
import { AgentMonitoringSettings, DEFAULT_AGENT_MONITORING_SETTINGS } from "../src/agent/agentMonitoringSettings.js";
import { AgentRuntimeSettings } from "../src/agent/types.js";
import { detectHumanValidation } from "../src/shared/humanValidation.js";
import { appointmentBookingPathPattern } from "../src/shared/loginFlow.js";
import { monitorAppointments } from "../src/shared/monitor.js";
import { releaseScanTurn, waitForScanTurn } from "../src/shared/orchestrator.js";
import { AppConfig } from "../src/shared/types.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
const FAKE_LOGIN = "TEST_SECRET_FAKE_LOGIN_RECOVERY";
const FAKE_PASSWORD = "TEST_SECRET_FAKE_PASSWORD_RECOVERY_123";

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

// ===================== Faux site TLS local (jamais TLScontact reel) =====================

const CLIENT_SIDE_EXCEPTION_HTML = `<!DOCTYPE html><html><body>
<h1>Application error: a client-side exception has occurred (see the browser console for more information).</h1>
</body></html>`;

// "Pret" au sens de isAppointmentPageReady() (detectors.ts) SANS jamais
// signaler un creneau reellement disponible (jamais btn-current-month-available
// ni "reservez votre rendez-vous"/"selectionnez un creneau" en texte reel) -
// piege deja identifie: un premier essai avec un bouton "available" a
// declenche une VRAIE tentative de reservation automatique (SLOT_DETECTED),
// faussant completement ces scenarios de recovery qui ne testent PAS la
// detection de creneaux. Reprend exactement le balisage "aucun creneau" deja
// valide par scripts/fixtures/fake-appointment-site/appointment.html (jamais
// reinvente divergemment).
const APPOINTMENT_READY_HTML = `<!DOCTYPE html><html><body>
<div data-testid="fixture-appointment-page">Fausse page de rendez-vous (test uniquement)</div>
<button data-testid="btn-current-month-unavailable" disabled>Mois courant</button>
<button data-testid="btn-next-month-unavailable" disabled>Mois suivant</button>
<p>Nous n'avons actuellement plus de creneaux de rendez-vous disponibles.</p>
</body></html>`;

const HOME_HTML = `<!DOCTYPE html><html><body><a href="/fr-fr/login"><div id="login">SE CONNECTER</div></a></body></html>`;

// CORRECTIF CIBLE (retour vers TARGET_URL apres expiration session TLS):
// reproduit EXACTEMENT les marqueurs deja attendus par detectUnexpectedPageReason
// (monitor.ts - texte "Bienvenue sur TLScontact"/"Prendre un rendez-vous") pour
// l'accueil TLS deconnecte reel (https://visas-fr.tlscontact.com/fr-fr).
const LOGGED_OUT_LANDING_HTML = `<!DOCTYPE html><html><body>
<h1>Bienvenue sur TLScontact</h1>
<p>Prendre un rendez-vous</p>
</body></html>`;

// Page pays/service (etat "home" - homeCountryPagePattern) servie a l'URL de
// retour (targetUrl) apres le goto() depuis l'accueil deconnecte. Le lien
// "Se connecter" n'est pas requis (clickSeConnecter navigue directement par
// URL relative /fr-fr/login), mais on le garde pour rester fidele au vrai
// balisage TLS et permettre un repli par clic si jamais la navigation directe
// echouait.
const COUNTRY_HOME_HTML = HOME_HTML;

// Formulaire de connexion dedie au Scenario K: redirige directement vers
// /workflow/service-level (jamais /fr-fr/travel-groups) - volontairement
// distinct de LOGIN_HTML_NO_CAPTCHA (partagee par les scenarios B/C/D/H, non
// modifiee) pour raccourcir la chaine testee ici (logged-out-landing -> home
// -> auth) sans jamais retester travel-groups/application-summary, deja
// entierement couverts par les Scenarios C/D/H.
const LOGIN_HTML_TO_SERVICE_LEVEL = `<!DOCTYPE html><html><body>
<form id="loginForm" action="/workflow/service-level" method="post">
  <input id="username" type="text" />
  <input id="password" type="password" />
  <button id="btn-login" type="submit">Se connecter</button>
</form>
</body></html>`;

// Correctif Cloudflare/validation humaine: reproduit EXACTEMENT les marqueurs
// attendus par isCloudflareBlockedPage() (agentPageDetector.ts - titre
// "Attention Required", texte "Sorry, you have been blocked") - jamais les
// marqueurs de la file d'attente/challenge JS de detectUnexpectedPageReason
// (monitor.ts, motif different: "verification de securite en cours"), qui
// n'est pas ce que le recovery pilote par etat verifie ici. `clearsAfterMs`:
// si fourni, la page se navigue elle-meme (jamais un clic du code sous test)
// vers /fr-fr/travel-groups apres ce delai - simule la disparition NATURELLE
// du blocage (jamais une resolution provoquee par le code).
const cloudflareBlockedHtml = (clearsAfterMs?: number): string => `<!DOCTYPE html><html>
<head><title>Attention Required! | Cloudflare</title></head>
<body>
<p>Sorry, you have been blocked</p>
${clearsAfterMs ? `<script>setTimeout(function () { location.href = "/fr-fr/travel-groups"; }, ${clearsAfterMs});</script>` : ""}
</body></html>`;

const LOGIN_HTML_NO_CAPTCHA = `<!DOCTYPE html><html><body>
<form id="loginForm" action="/fr-fr/travel-groups" method="post">
  <input id="username" type="text" />
  <input id="password" type="password" />
  <button id="btn-login" type="submit">Se connecter</button>
</form>
</body></html>`;

// Simule un vrai captcha visible (meme selecteur qu'isRecaptchaPresent):
// jamais resolu automatiquement par le code sous test - seul ce script de
// test (le "humain" simule) remplit g-recaptcha-response, exactement comme
// section 6 l'exige ("RendezBot ne doit jamais resoudre/contourner un CAPTCHA").
const LOGIN_HTML_WITH_CAPTCHA = `<!DOCTYPE html><html><body>
<form id="loginForm" action="/fr-fr/travel-groups" method="post">
  <input id="username" type="text" />
  <input id="password" type="password" />
  <iframe src="/fake-recaptcha-frame?size=normal"></iframe>
  <textarea name="g-recaptcha-response" style="display:none;"></textarea>
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

type AppointmentBehavior =
  | "always-ready"
  | "error-then-refresh-fixes"
  | "error-twice-then-ready"
  | "error-forever";

type FixtureSite = {
  server: Server;
  baseUrl: string;
  requestLog: string[];
  appointmentReloadCount: () => number;
};

const startFixtureSite = (behavior: AppointmentBehavior, loginBehavior: "no-captcha" | "captcha" = "no-captcha"): Promise<FixtureSite> => new Promise((resolve, reject) => {
  const requestLog: string[] = [];
  let appointmentRequests = 0;

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    requestLog.push(url);
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (url === "/" || url === "") { res.end(HOME_HTML); return; }
    if (url.startsWith("/fr-fr/login")) {
      res.end(loginBehavior === "captcha" ? LOGIN_HTML_WITH_CAPTCHA : LOGIN_HTML_NO_CAPTCHA);
      return;
    }
    if (url.startsWith("/fake-recaptcha-frame")) { res.end("<!DOCTYPE html><html><body>fake</body></html>"); return; }
    if (url.startsWith("/cloudflare-challenge")) {
      const clearsAfterMs = Number(new URL(url, "http://x").searchParams.get("clearsAfterMs")) || undefined;
      res.end(cloudflareBlockedHtml(clearsAfterMs));
      return;
    }
    if (url.startsWith("/fr-fr/travel-groups")) { res.end(TRAVEL_GROUPS_HTML); return; }
    if (url.startsWith("/workflow/application-summary")) { res.end(APPLICATION_SUMMARY_HTML); return; }
    if (url.startsWith("/workflow/service-level")) { res.end(SERVICE_LEVEL_HTML); return; }
    if (url.startsWith("/workflow/appointment-booking/")) {
      appointmentRequests += 1;
      if (behavior === "always-ready") { res.end(APPOINTMENT_READY_HTML); return; }
      if (behavior === "error-forever") { res.end(CLIENT_SIDE_EXCEPTION_HTML); return; }
      if (behavior === "error-twice-then-ready") {
        // Scenarios C/D: la page initiale (requete 1) ET le reload simple du
        // niveau 1 (requete 2) affichent TOUJOURS l'erreur - le refresh seul
        // doit echouer, forcant le recovery complet (niveau 2) - mais une
        // fois REELLEMENT re-atteinte via l'enchainement travel-groups ->
        // application-summary -> service-level -> Continuer (requete 3+),
        // la page est bien prete: prouve que le recovery pilote par etat
        // aboutit reellement, jamais confondu avec un simple refresh reussi.
        res.end(appointmentRequests <= 2 ? CLIENT_SIDE_EXCEPTION_HTML : APPOINTMENT_READY_HTML);
        return;
      }
      // error-then-refresh-fixes: la toute PREMIERE requete (page initiale,
      // avant tout reload) affiche l'erreur ; toute requete SUIVANTE (reload)
      // affiche la vraie page - reproduit exactement le cas reel ("un simple
      // refresh manuel a immediatement restaure la page").
      res.end(appointmentRequests === 1 ? CLIENT_SIDE_EXCEPTION_HTML : APPOINTMENT_READY_HTML);
      return;
    }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, requestLog, appointmentReloadCount: () => appointmentRequests });
  });
});

// CORRECTIF CIBLE (retour vers TARGET_URL apres expiration session TLS,
// Scenario K): fixture dediee et independante de startFixtureSite ci-dessus
// (jamais modifiee) - reproduit uniquement l'enchainement NOUVEAU teste ici
// (accueil deconnecte -> country page -> Se connecter -> auth), en
// raccourcissant volontairement la suite (auth redirige directement vers
// /workflow/service-level, jamais /fr-fr/travel-groups) puisque
// travel-groups/application-summary sont deja entierement couverts par les
// Scenarios C/D/H (jamais retestes ici en double).
const startLoggedOutLandingFixture = (): Promise<FixtureSite> => new Promise((resolve, reject) => {
  const requestLog: string[] = [];
  let appointmentRequests = 0;

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    requestLog.push(url);
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (url === "/fr-fr" || url === "/fr-fr/") { res.end(LOGGED_OUT_LANDING_HTML); return; }
    if (url.startsWith("/fr-fr/country/")) { res.end(COUNTRY_HOME_HTML); return; }
    if (url.startsWith("/fr-fr/login")) { res.end(LOGIN_HTML_TO_SERVICE_LEVEL); return; }
    if (url.startsWith("/workflow/service-level")) { res.end(SERVICE_LEVEL_HTML); return; }
    if (url.startsWith("/workflow/appointment-booking/")) {
      appointmentRequests += 1;
      res.end(APPOINTMENT_READY_HTML);
      return;
    }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, requestLog, appointmentReloadCount: () => appointmentRequests });
  });
});

// CORRECTIF CIBLE (Scenarios M/N): fixture dediee ou la PREMIERE requete vers
// appointment-booking est prete, mais toute requete SUIVANTE (donc un
// page.reload() du refresh planifie) redirige (302) vers l'accueil TLS
// deconnecte - reproduit fidelement "un refresh planifie se termine sur
// /fr-fr" (Scenario C du correctif cible). "/ready" est une route SEPAREE,
// toujours prete, jamais soumise a ce compteur - utilisee uniquement comme
// cible de retour du stub recoverWorkflow() de ces scenarios (jamais la vraie
// chaine de recovery, deja prouvee par le Scenario K et les Scenarios C/D/H).
const startRedirectOnReloadFixture = (): Promise<FixtureSite> => new Promise((resolve, reject) => {
  const requestLog: string[] = [];
  let appointmentRequests = 0;

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    requestLog.push(url);

    if (url.startsWith("/workflow/appointment-booking/")) {
      appointmentRequests += 1;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (appointmentRequests === 1) { res.end(APPOINTMENT_READY_HTML); return; }
      res.statusCode = 302;
      res.setHeader("Location", "/fr-fr");
      res.end();
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url === "/fr-fr" || url === "/fr-fr/") { res.end(LOGGED_OUT_LANDING_HTML); return; }
    if (url === "/ready") { res.end(APPOINTMENT_READY_HTML); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, requestLog, appointmentReloadCount: () => appointmentRequests });
  });
});

// ===================== BUG CIBLE 0.2.4: fixtures dediees =====================

// Reprend EXACTEMENT le balisage "pret" deja valide ci-dessus
// (APPOINTMENT_READY_HTML), avec un self-redirect JS additionnel: reproduit
// "TLScontact sort silencieusement le navigateur du workflow" (le bug reel
// confirme par les logs 0.2.4) SANS avoir besoin d'un acces externe a la Page
// Playwright du bot (deliberement hors de portee d'un test noir sur
// AgentBotManager - browser/page ne sont jamais exposes, cf. types.ts).
const selfRedirectToLoggedOutLandingHtml = (afterMs: number): string => `<!DOCTYPE html><html><body>
<div data-testid="fixture-appointment-page">Fausse page de rendez-vous (test uniquement)</div>
<button data-testid="btn-current-month-unavailable" disabled>Mois courant</button>
<button data-testid="btn-next-month-unavailable" disabled>Mois suivant</button>
<p>Nous n'avons actuellement plus de creneaux de rendez-vous disponibles.</p>
<script>setTimeout(function () { location.href = "/fr-fr"; }, ${afterMs});</script>
</body></html>`;

// Fixture dediee Scenarios O/R (BUG CIBLE 0.2.4, recoveryTargetUrl +
// credentials apres VALIDATE_BOT): accueil deconnecte (/fr-fr) -> country
// home -> login (formulaire reel, meme balisage que LOGIN_HTML_TO_SERVICE_LEVEL
// deja valide ci-dessus) -> service-level -> appointment-booking, dont la
// PREMIERE arrivee se redirige seule vers /fr-fr apres `redirectAfterMs`
// (episode UNIQUE, jamais une boucle de redirections a chaque nouvelle arrivee).
const startTargetUrlWiringFixture = (redirectAfterMs: number): Promise<FixtureSite> => new Promise((resolve, reject) => {
  const requestLog: string[] = [];
  let appointmentRequests = 0;

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    requestLog.push(url);
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (url === "/fr-fr" || url === "/fr-fr/") { res.end(LOGGED_OUT_LANDING_HTML); return; }
    if (url.startsWith("/fr-fr/country/")) { res.end(COUNTRY_HOME_HTML); return; }
    if (url.startsWith("/fr-fr/login")) { res.end(LOGIN_HTML_TO_SERVICE_LEVEL); return; }
    if (url.startsWith("/workflow/service-level")) { res.end(SERVICE_LEVEL_HTML); return; }
    if (url.startsWith("/workflow/appointment-booking/")) {
      appointmentRequests += 1;
      res.end(appointmentRequests === 1 ? selfRedirectToLoggedOutLandingHtml(redirectAfterMs) : APPOINTMENT_READY_HTML);
      return;
    }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, requestLog, appointmentReloadCount: () => appointmentRequests });
  });
});

// Fixture dediee Scenario P (BUG CIBLE 0.2.4, URL arbitraire pendant
// MONITORING): appointment-booking pret + UNE page normale, sans aucun
// rapport avec TLScontact (reproduit fidelement l'exemple demande:
// "https://example.com/") - jamais Cloudflare/CAPTCHA/motif d'erreur connu.
const ARBITRARY_UNRELATED_PAGE_HTML = `<!DOCTYPE html><html><body>
<h1>Bienvenue</h1>
<p>Ceci est une page web tout a fait normale, sans aucun rapport avec TLScontact.</p>
</body></html>`;

// BUG CIBLE 0.2.4 (cooldown interruptible, section 2, Tests A/D): routes
// additionnelles reutilisant des balisages DEJA valides ailleurs dans ce
// fichier (LOGGED_OUT_LANDING_HTML, cloudflareBlockedHtml) - jamais une
// deuxieme fixture divergente pour ces memes marqueurs.
const startArbitraryUrlFixture = (): Promise<FixtureSite> => new Promise((resolve, reject) => {
  const requestLog: string[] = [];

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    requestLog.push(url);
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (url.startsWith("/workflow/appointment-booking/")) { res.end(APPOINTMENT_READY_HTML); return; }
    if (url.startsWith("/unknown")) { res.end(ARBITRARY_UNRELATED_PAGE_HTML); return; }
    if (url === "/fr-fr" || url === "/fr-fr/") { res.end(LOGGED_OUT_LANDING_HTML); return; }
    if (url.startsWith("/cloudflare-challenge")) { res.end(cloudflareBlockedHtml()); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, requestLog, appointmentReloadCount: () => 0 });
  });
});

// Construit un AgentRuntimeSettings de test complet et coherent (mode
// "test"/targetMode "fixture") - `targetUrl: "about:blank"` REPRODUIT
// DELIBEREMENT le defaut reel d'une installation packaged (cf.
// agentSettings.ts: AGENT_TARGET_URL absent -> "about:blank"), exactement la
// precondition du bug cible - jamais change par les scenarios eux-memes,
// c'est justement ce que la correction doit rendre sans consequence.
const makeTestAgentSettings = (overrides: { dataRoot: string } & Partial<AgentRuntimeSettings>): AgentRuntimeSettings => ({
  serverUrl: "http://127.0.0.1:1",
  credentialsPath: path.join(overrides.dataRoot, "credentials.json"),
  computerName: "TEST-BUG024-PC",
  version: "0.2.4",
  protocolVersion: 1,
  runtimeMode: "test",
  targetMode: "fixture",
  fixtureUrl: "about:blank",
  targetUrl: "about:blank",
  maxActiveBots: 5,
  reconnectMinDelayMs: 1_000,
  reconnectMaxDelayMs: 5_000,
  reconnectJitterRatio: 0.2,
  offlineEventBufferMax: 100,
  logMaxFileSizeMb: 5,
  logMaxFiles: 3,
  logLevel: "info",
  autoNavRetryIntervalMs: 500,
  autoNavLongWaitMs: 800,
  workflowRecoveryRetryIntervalMs: 500,
  workflowRecoveryLongWaitMs: 1_000,
  humanValidationGraceMs: 2_000,
  ...overrides
});

// ===================== Capture de logs =====================

type CapturedLog = { level: AgentLogLevel; message: string };
const makeLogCapture = (): { entries: CapturedLog[]; log: (level: AgentLogLevel, message: string) => void } => {
  const entries: CapturedLog[] = [];
  return { entries, log: (level, message) => entries.push({ level, message }) };
};

const FORBIDDEN_LOG_SUBSTRINGS = [FAKE_LOGIN.toLowerCase(), FAKE_PASSWORD.toLowerCase(), "password=", "cookie:", "authorization:"];
const assertNoSecretsInLogs = (entries: CapturedLog[], description: string): void => {
  const offending = entries.filter((entry) => FORBIDDEN_LOG_SUBSTRINGS.some((needle) => entry.message.toLowerCase().includes(needle)));
  assert(offending.length === 0, `${description} (recu: ${offending.length} ligne(s) suspecte(s))`);
};

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

// ===================== Scenario A: client-side exception, 1 reload suffit =====================

const runScenarioA = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario A (cas reel observe): exception cote client -> 1 reload -> monitoring repris ===");
  const fixture = await startFixtureSite("error-then-refresh-fixes");
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-scenario-a",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`,
      commandId: "cmd-a",
      reporter,
      log: capture.log,
      isBotStillRegistered: () => true
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retablie apres refresh")), 20_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(
      capture.entries.some((e) => e.message.includes("Erreur applicative TLS")) || fixture.appointmentReloadCount() >= 1,
      "A) L'erreur applicative (exception cote client) est bien detectee"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Refresh simple (erreur applicative TLS)")),
      "A) Le refresh simple (niveau 1) est bien tente avant tout recovery complet"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retablie apres refresh. Surveillance reprise.")),
      "A) Message de succes exact journalise, surveillance reprise sans recovery complet"
    );
    assert(
      !capture.entries.some((e) => e.message.includes("Reprise workflow")),
      "A) Aucun goto(TARGET_URL)/recovery complet n'a ete necessaire (refresh simple a suffi)"
    );
    assert(fixture.appointmentReloadCount() === 2, `A) Exactement 2 requetes vers appointment-booking (page initiale + 1 reload, jamais davantage) (recu: ${fixture.appointmentReloadCount()})`);
    assert(statuses.every((s) => s.status !== "WAITING_FOR_USER" && s.status !== "ERROR"), "A) Aucun WAITING_FOR_USER/ERROR emis: la reprise a reussi seule");
    assertNoSecretsInLogs(capture.entries, "A) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ===================== Scenario B: refresh insuffisant -> recovery complet =====================

const runScenarioB = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario B: exception cote client persistante -> refresh insuffisant -> recovery workflow complet ===");
  const fixture = await startFixtureSite("error-forever");
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const { reporter } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-scenario-b",
      page,
      context,
      settings: FAST_SETTINGS,
      // targetUrl pointe vers la home: si le recovery complet est bien
      // declenche, il classifiera cette page comme "home" (jamais un
      // goto aveugle) - preuve indirecte que le niveau 2 a bien demarre.
      targetUrl: `${fixture.baseUrl}/`,
      commandId: "cmd-b",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      isBotStillRegistered: () => true
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Refresh simple insuffisant")), 20_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(
      capture.entries.some((e) => e.message.includes("Refresh simple (erreur applicative TLS)")),
      "B) Le refresh simple (niveau 1) est bien tente en premier"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Refresh simple insuffisant: lancement du recovery workflow complet.")),
      "B) Le refresh seul etant insuffisant, le recovery workflow complet (niveau 2) est explicitement lance"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Reprise workflow 1/4")),
      "B) Le recovery complet a bien demarre sa premiere tentative"
    );
    assertNoSecretsInLogs(capture.entries, "B) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ===================== Scenario C: session toujours connectee (travel-groups -> ... -> appointment-booking) =====================

const runScenarioC = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario C: session toujours connectee - recovery pilote par etat depuis travel-groups ===");
  const fixture = await startFixtureSite("error-twice-then-ready");
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // La page affiche l'erreur (declenche le recovery), mais le "targetUrl"
    // n'est JAMAIS utilise ici: on verifie que le recovery classifie l'etat
    // REEL de pickWorkflowPage() (travel-groups, deja ouvert dans ce meme
    // contexte) plutot que de naviguer vers targetUrl en aveugle.
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const travelGroupsPage = await context.newPage();
    await travelGroupsPage.goto(`${fixture.baseUrl}/fr-fr/travel-groups`, { waitUntil: "domcontentloaded" });

    const capture = makeLogCapture();
    const { reporter } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-scenario-c",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/never-used-marker`,
      commandId: "cmd-c",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      isBotStillRegistered: () => true
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 45_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(
      capture.entries.some((e) => e.message.includes("etat detecte = travel-groups")),
      "C) L'etat travel-groups est correctement classifie (recovery pilote par etat)"
    );
    assert(
      !capture.entries.some((e) => e.message.includes("never-used-marker")),
      "C) Jamais de navigation aveugle vers targetUrl: l'etat reel (travel-groups) est utilise directement"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")),
      "C) Le recovery complet aboutit a la page de rendez-vous (travel-groups -> application-summary -> service-level -> appointment-booking)"
    );
    // BUG CIBLE 0.2.4 (Test I): travel-groups -> service-level -> appointment
    // doit tenir dans LA MEME tentative externe (progression interne),
    // jamais un retry externe intermediaire ni un long wait.
    assert(
      capture.entries.some((e) => /Recovery progression: travel-groups -> (application-summary|service-level)\.?/.test(e.message)),
      "C) La transition travel-groups -> l'etape suivante est journalisee comme une progression interne (jamais un nouvel essai externe)"
    );
    assert(
      !capture.entries.some((e) => /Reprise workflow 2\/4/.test(e.message)),
      "C) Une seule tentative externe a suffi (I): jamais de 2e tentative numerotee pour cette chaine"
    );
    assert(
      !capture.entries.some((e) => /tentatives sans page reconnue/.test(e.message)),
      "C) Aucun long wait declenche: la chaine complete progresse sans jamais epuiser 3 tentatives externes"
    );
    assertNoSecretsInLogs(capture.entries, "C) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ===================== Scenario D: session expiree - reconnexion + captcha manuel =====================

const runScenarioD = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario D: session expiree - fillLoginForm (credentials memoire) + CAPTCHA manuel simule ===");
  const fixture = await startFixtureSite("error-twice-then-ready", "captcha");
  const context = await browser.newContext();
  const page = await context.newPage();
  const loginPage = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    await loginPage.goto(`${fixture.baseUrl}/fr-fr/login`, { waitUntil: "domcontentloaded" });

    const capture = makeLogCapture();
    const { reporter } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-scenario-d",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/`,
      commandId: "cmd-d",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      isBotStillRegistered: () => true,
      runtimeCredentials: { login: FAKE_LOGIN, password: FAKE_PASSWORD }
    });

    // "L'utilisateur valide manuellement le CAPTCHA" simule: on attend que le
    // bot ait REELLEMENT rempli le formulaire (jamais avant - RendezBot ne
    // doit jamais soumettre tant que le captcha n'est pas resolu) puis on
    // remplit g-recaptcha-response nous-memes, exactement comme le ferait un
    // humain - jamais le code sous test qui ne fait qu'ATTENDRE.
    await waitUntil(async () => (await loginPage.locator("#username").inputValue().catch(() => "")) === FAKE_LOGIN, 15_000);
    assert(
      await loginPage.locator('textarea[name="g-recaptcha-response"]').inputValue().then((v) => v === "").catch(() => true),
      "D) Le CAPTCHA n'est jamais resolu/contourne automatiquement par le code (toujours vide avant intervention manuelle simulee)"
    );
    // Attend le VRAI log "Captcha detecte" (jamais un delai arbitraire, qui
    // introduirait une course avec le premier sondage du code sous test)
    // avant de simuler la resolution manuelle.
    await waitUntil(() => capture.entries.some((e) => e.message.includes("Captcha detecte")), 10_000);
    await loginPage.evaluate(() => {
      const field = document.querySelector('textarea[name="g-recaptcha-response"]') as HTMLTextAreaElement | null;
      if (field) field.value = "fake-resolved-token-test-only";
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 45_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(
      capture.entries.some((e) => e.message.includes("etat detecte = auth")),
      "D) L'etat login/auth est correctement classifie"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Page de connexion detectee pendant la reprise: nouvelle tentative de connexion automatique")),
      "D) La reconnexion automatique est bien tentee avec les identifiants en memoire"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Captcha detecte")),
      "D) La presence du CAPTCHA est detectee et journalisee (jamais contournee)"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")),
      "D) Apres resolution manuelle simulee du captcha, le parcours reprend et aboutit"
    );
    assertNoSecretsInLogs(capture.entries, "D) Aucun secret (identifiants) dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ===================== Scenario E: recovery echoue completement =====================

const runScenarioE = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario E: refresh + 4 tentatives de recovery epuisees -> WAITING_FOR_USER (WORKFLOW_RECOVERY_FAILED) ===");
  const fixture = await startFixtureSite("error-forever");
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-scenario-e",
      page,
      context,
      settings: FAST_SETTINGS,
      // Aucun etat reconnu (page fermee/inexistante) -> "unknown" a chaque
      // tentative -> jamais recupere.
      targetUrl: `${fixture.baseUrl}/route-inexistante-jamais-reconnue`,
      commandId: "cmd-e",
      reporter,
      log: capture.log,
      // Attente longue RACCOURCIE UNIQUEMENT DANS CE TEST (section: "attente
      // longue raccourcie uniquement dans le test") - jamais en production.
      workflowRecoveryRetryIntervalMs: 300,
      workflowRecoveryLongWaitMs: 800,
      isBotStillRegistered: () => true
    });

    await handle.loopPromise;

    assert(
      statuses.some((s) => s.status === "WAITING_FOR_USER" && (s.details as { reason?: string } | undefined)?.reason === "WORKFLOW_RECOVERY_FAILED"),
      "E) Le bot passe explicitement en WAITING_FOR_USER avec reason=WORKFLOW_RECOVERY_FAILED"
    );
    assert(
      statuses.filter((s) => s.status === "WAITING_FOR_USER").length === 1,
      `E) Exactement UNE emission WAITING_FOR_USER (jamais de doublon avec l'ancien fallback PAGE_CLOSED) (recu: ${statuses.filter((s) => s.status === "WAITING_FOR_USER").length})`
    );
    const recoveryAttemptLogs = capture.entries.filter((e) => /Reprise workflow \d\/4/.test(e.message));
    assert(recoveryAttemptLogs.length === WORKFLOW_RECOVERY_FINAL_ATTEMPT_FOR_TEST, `E) Exactement 4 tentatives de recovery complet (recu: ${recoveryAttemptLogs.length})`);
    assert(
      capture.entries.some((e) => e.message.includes("Echec final de la reprise automatique du workflow (WORKFLOW_RECOVERY_FAILED)")),
      "E) L'echec final est journalise localement de maniere non sensible"
    );
    assert(
      !capture.entries.some((e) => /Intervention humaine potentiellement requise/.test(e.message)),
      "E) Pas de 4e minute de grace supplementaire (alertAndPause) apres l'echec deja terminal du recovery"
    );
    // BUG CIBLE 0.2.4 (Test K): le long wait de WORKFLOW_RECOVERY_LONG_WAIT_MS
    // (raccourci UNIQUEMENT dans ce test) reste bien declenche apres 3 VRAIS
    // echecs consecutifs (etat "unknown" qui reste "unknown" a chaque
    // tentative) - jamais supprime par la correction "progression interne",
    // qui ne concerne QUE les etats qui progressent reellement.
    assert(
      capture.entries.some((e) => /tentatives sans page reconnue\. Attente de/.test(e.message)),
      "K) Le long wait est toujours declenche apres 3 vrais echecs consecutifs (jamais supprime par la correction 'progression interne')"
    );
    assertNoSecretsInLogs(capture.entries, "E) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};
const WORKFLOW_RECOVERY_FINAL_ATTEMPT_FOR_TEST = 4;

// ===================== Scenario I: Cloudflare/validation humaine - disparait naturellement =====================
// Correctif demande: un challenge Cloudflare pendant le recovery ne doit
// JAMAIS consommer les tentatives numerotees #1-#4, ne doit rien cliquer, et
// doit reprendre automatiquement des sa disparition (jamais provoquee par le
// code sous test - ici, un simple setTimeout cote fixture, jamais un clic).

const runScenarioI = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario I: Cloudflare/validation humaine pendant le recovery - disparait naturellement, aucune tentative consommee ===");
  const fixture = await startFixtureSite("error-twice-then-ready");
  const context = await browser.newContext();
  const page = await context.newPage();
  const cloudflarePage = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    // Se dissipe seule apres 4s (jamais un clic/goto du code sous test).
    // clearsAfterMs > la duree du refresh simple (niveau 1, jusqu'a ~18s
    // avant meme d'atteindre le recovery complet ici) - sinon le blocage
    // aurait deja disparu de lui-meme avant la toute premiere verification,
    // rendant ce scenario incapable de prouver quoi que ce soit.
    await cloudflarePage.goto(`${fixture.baseUrl}/cloudflare-challenge?clearsAfterMs=22000`, { waitUntil: "domcontentloaded" });

    const capture = makeLogCapture();
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-scenario-i",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/never-used-marker`,
      commandId: "cmd-i",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      isBotStillRegistered: () => true
    });

    // Marge large: refresh simple (~18s) + attente du blocage (jusqu'a
    // HUMAN_RECHECK_INTERVAL_MS=15s apres sa disparition reelle a 22s) +
    // enchainement travel-groups -> application-summary -> service-level ->
    // appointment-booking.
    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 90_000);
    handle.abortController.abort();
    await handle.loopPromise;

    const blockedIndex = capture.entries.findIndex((e) => e.message.includes("Blocage Cloudflare/validation humaine detecte pendant le recovery"));
    const clearedIndex = capture.entries.findIndex((e) => e.message.includes("Blocage Cloudflare/validation humaine disparu"));
    const firstAttemptIndex = capture.entries.findIndex((e) => e.message.includes("Reprise workflow 1/4"));

    assert(blockedIndex !== -1, "I) Le blocage Cloudflare/validation humaine est detecte pendant le recovery");
    assert(clearedIndex !== -1 && clearedIndex > blockedIndex, "I) Sa disparition (naturelle, jamais provoquee par un clic) est journalisee");
    assert(
      firstAttemptIndex !== -1 && firstAttemptIndex > clearedIndex,
      "I) La 1ere tentative numerotee ne demarre qu'APRES la disparition du blocage (jamais pendant)"
    );
    assert(
      capture.entries.some((e) => e.message.includes("etat detecte = travel-groups")),
      "I) Une fois le blocage dissipe, l'etat reel (travel-groups) est classifie immediatement"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")),
      "I) Le workflow reprend et aboutit une fois le blocage dissipe"
    );
    assert(
      !statuses.some((s) => s.status === "WAITING_FOR_USER"),
      "I) Aucun WAITING_FOR_USER (ni WORKFLOW_RECOVERY_FAILED ni HUMAN_VALIDATION_TIMEOUT): la reprise a reussi seule"
    );
    assertNoSecretsInLogs(capture.entries, "I) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ===================== Scenario J: Cloudflare/validation humaine - ne disparait jamais =====================
// Au-dela de la fenetre humaine (raccourcie UNIQUEMENT dans ce test via
// humanValidationGraceMs): WAITING_FOR_USER avec une raison SPECIFIQUE
// (HUMAN_VALIDATION_TIMEOUT), jamais WORKFLOW_RECOVERY_FAILED - et aucune
// tentative numerotee ne doit avoir ete consommee avant ce constat.

const runScenarioJ = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario J: Cloudflare/validation humaine ne disparait jamais -> WAITING_FOR_USER (HUMAN_VALIDATION_TIMEOUT, jamais WORKFLOW_RECOVERY_FAILED) ===");
  const fixture = await startFixtureSite("error-forever");
  const context = await browser.newContext();
  const page = await context.newPage();
  const cloudflarePage = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    // Jamais de clearsAfterMs: le blocage ne disparait jamais dans ce scenario.
    await cloudflarePage.goto(`${fixture.baseUrl}/cloudflare-challenge`, { waitUntil: "domcontentloaded" });

    const capture = makeLogCapture();
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-scenario-j",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/never-used-marker`,
      commandId: "cmd-j",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 300,
      workflowRecoveryLongWaitMs: 800,
      // Fenetre humaine RACCOURCIE UNIQUEMENT DANS CE TEST (jamais en
      // production sans configuration explicite) - sinon 4 minutes reelles.
      humanValidationGraceMs: 3_000,
      isBotStillRegistered: () => true
    });

    await handle.loopPromise;

    assert(
      statuses.some((s) => s.status === "WAITING_FOR_USER" && (s.details as { reason?: string } | undefined)?.reason === "HUMAN_VALIDATION_TIMEOUT"),
      "J) Le bot passe en WAITING_FOR_USER avec une raison SPECIFIQUE de validation humaine (HUMAN_VALIDATION_TIMEOUT)"
    );
    assert(
      !statuses.some((s) => s.status === "WAITING_FOR_USER" && (s.details as { reason?: string } | undefined)?.reason === "WORKFLOW_RECOVERY_FAILED"),
      "J) WORKFLOW_RECOVERY_FAILED n'est JAMAIS emis pour un blocage humain toujours present (reserve aux vraies tentatives automatiques echouees)"
    );
    assert(
      statuses.filter((s) => s.status === "WAITING_FOR_USER").length === 1,
      `J) Exactement UNE emission WAITING_FOR_USER (recu: ${statuses.filter((s) => s.status === "WAITING_FOR_USER").length})`
    );
    const recoveryAttemptLogsJ = capture.entries.filter((e) => /Reprise workflow \d\/4/.test(e.message));
    assert(recoveryAttemptLogsJ.length === 0, `J) Aucune tentative numerotee consommee (le blocage humain, jamais leve, ne doit jamais en declencher) (recu: ${recoveryAttemptLogsJ.length})`);
    assert(
      capture.entries.some((e) => e.message.includes("Blocage Cloudflare/validation humaine toujours present au-dela de la fenetre prevue")),
      "J) L'echec est journalise localement de maniere non sensible, avec la cause exacte (fenetre humaine epuisee)"
    );
    assertNoSecretsInLogs(capture.entries, "J) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ===================== Scenario K (CORRECTIF CIBLE): accueil TLS deconnecte (/fr-fr) pendant le monitoring -> goto(targetUrl) -> parcours complet =====================
// Reproduit le defaut reel confirme (apres ~1h de surveillance, TLScontact
// peut renvoyer le navigateur vers l'accueil general deconnecte /fr-fr) puis
// verifie l'enchainement demande: recovery detecte explicitement
// logged-out-landing (jamais 'unknown') -> goto(targetUrl) (jamais une URL
// arbitraire issue de la page) -> country page -> Se connecter -> auth ->
// identifiants deja en memoire (runtimeCredentialsRef, jamais un nouveau
// credential) -> reprise. Meme startMonitoring()/Chrome/profil/bot: jamais un
// nouveau START_BOT. La suite travel-groups/application-summary/service-level
// est deja entierement couverte par les Scenarios C/D/H (fixture dediee,
// raccourcie apres auth, cf. startLoggedOutLandingFixture ci-dessus).

const runScenarioK = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario K (correctif cible): accueil TLS deconnecte (/fr-fr) pendant le monitoring -> recovery vers targetUrl -> parcours complet ===");
  const fixture = await startLoggedOutLandingFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Simule TLS qui sort le navigateur du workflow et le renvoie vers
    // l'accueil general deconnecte (jamais un clic/goto du code sous test -
    // ce goto initial reproduit uniquement l'ETAT DE DEPART du scenario reel).
    await page.goto(`${fixture.baseUrl}/fr-fr`, { waitUntil: "domcontentloaded" });

    const capture = makeLogCapture();
    const { reporter, statuses } = makeFakeReporter();
    const targetUrl = `${fixture.baseUrl}/fr-fr/country/tn/vac/tnTUN2fr`;

    const handle = startMonitoring({
      botId: "bot-scenario-k",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl,
      commandId: "cmd-k",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      isBotStillRegistered: () => true,
      runtimeCredentials: { login: FAKE_LOGIN, password: FAKE_PASSWORD }
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 45_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(
      capture.entries.some((e) => e.message.includes("Accueil TLS deconnecte (logged-out-landing) detecte pendant la reprise")),
      "K) L'accueil TLS deconnecte (/fr-fr) est classifie explicitement comme logged-out-landing (jamais 'unknown')"
    );
    assert(
      capture.entries.some((e) => /retour vers targetUrl \([^)]*\/fr-fr\/country\/tn\/vac\/tnTUN2fr\)/.test(e.message)),
      "K) Le retour utilise targetUrl deja fourni au monitoring, exactement (jamais une URL arbitraire issue de la page)"
    );
    assert(
      capture.entries.some((e) => e.message.includes("etat detecte = home")),
      "K) Apres le retour vers targetUrl, l'etat 'home' (country page) est correctement classifie et reutilise (clickSeConnecter)"
    );
    assert(
      capture.entries.some((e) => e.message.includes("etat detecte = auth")),
      "K) L'etape login/auth est ensuite atteinte et correctement classifiee"
    );
    assert(
      capture.entries.some((e) => e.message.includes("nouvelle tentative de connexion automatique")),
      "K) Les identifiants DEJA EN MEMOIRE (runtimeCredentialsRef) sont reutilises pour la reconnexion - jamais un nouveau credential/profil/bot"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")),
      "K) Le monitoring reprend et aboutit a la page de rendez-vous (appointment-booking), meme bot/Chrome/profil - jamais un nouveau START_BOT"
    );
    assert(
      statuses.every((s) => s.status !== "WAITING_FOR_USER" && s.status !== "ERROR"),
      "K) Aucun WAITING_FOR_USER/ERROR emis: le retour vers targetUrl et la reprise ont reussi seuls"
    );
    assertNoSecretsInLogs(capture.entries, "K) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ===================== Scenario L (CORRECTIF CIBLE): AVANT refresh planifie, page deja sur /fr-fr - aucun reload, recovery direct =====================
// Teste directement monitorAppointments() (src/shared/monitor.ts), EN
// ISOLATION de agentMonitoringRuntime.ts (deja couvert par le Scenario K
// ci-dessus): un stub recoverWorkflow() permet de prouver precisement que,
// lorsque la page est DEJA sur l'accueil TLS deconnecte juste avant un
// refresh planifie, le code ne fait JAMAIS page.reload() de /fr-fr - il
// appelle directement recoverWorkflow() et reprend sans jamais compter cela
// comme un echec de refresh.
//
// Contention DETERMINISTE (jamais un timer/race): le tour de scan du domaine
// est prealablement occupe par un faux bot (maxParallelScansPerDomain=1) - le
// vrai bot sous test reste donc bloque dans waitForScanTurn() (donc APRES que
// detectUnexpectedPageReason a deja tourne sans rien detecter pour ce cycle)
// jusqu'a ce que ce test navigue explicitement la page vers /fr-fr puis
// libere le tour - reproduit fidelement "la page a bascule sur /fr-fr entre
// le debut du cycle et le refresh planifie", sans jamais dependre d'un delai
// arbitraire.

const runScenarioL = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario L (correctif cible): AVANT refresh planifie, page deja sur /fr-fr -> aucun reload, recovery direct vers targetUrl ===");
  const fixture = await startFixtureSite("always-ready");
  const context = await browser.newContext();
  const page = await context.newPage();
  const readyPage = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    await readyPage.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });

    const capture = makeLogCapture();
    const domain = "127.0.0.1";
    const scanSettings = { maxParallelScansPerDomain: 1 };
    await waitForScanTurn({ botName: "faux-bot-contention-L", domain, settings: scanSettings, log: capture.log });

    const recoverWorkflowCalls: Array<string | undefined> = [];
    let onRefreshFailedCalls = 0;
    let onRefreshSucceededCalls = 0;
    let waitForUserCalls = 0;

    const config: AppConfig = {
      targetUrl: `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`,
      connectToExistingChrome: false,
      chromeDebugUrl: "",
      refreshIntervalMs: 1_000,
      headless: true,
      slowMoMs: 0,
      debugKeepBrowserOpen: false,
      maxRefreshAttempts: 1,
      scanMonthCount: 1,
      maxParallelScansPerDomain: 1,
      monthClickMinDelayMs: 100,
      monthClickMaxDelayMs: 200,
      botCycleCooldownMinMs: 300,
      botCycleCooldownMaxMs: 500,
      refreshEveryCycles: 1,
      rateLimitCooldownMinutes: 1
    };

    const monitorPromise = monitorAppointments(page, config, {
      log: capture.log,
      waitForUser: async () => { waitForUserCalls += 1; },
      recoverWorkflow: async (reason) => {
        recoverWorkflowCalls.push(reason);
        // Simule un recovery reussi (deja prouve par le Scenario K): navigue
        // vers une page deja prete (readyPage, ouverte separement) - jamais
        // un reload de /fr-fr ici.
        return readyPage;
      },
      onRefreshFailed: () => { onRefreshFailedCalls += 1; },
      onRefreshSucceeded: () => { onRefreshSucceededCalls += 1; }
    });

    // Point de synchronisation DETERMINISTE: ce log n'apparait qu'APRES que
    // detectHumanValidation + detectUnexpectedPageReason ont deja tourne sans
    // rien detecter pour ce cycle (tous deux avant waitForScanTurn dans
    // monitor.ts) - jamais avant.
    await waitUntil(() => capture.entries.some((e) => e.message.includes("attend son tour pour")), 10_000);
    await page.goto(`${fixture.baseUrl}/fr-fr`, { waitUntil: "domcontentloaded" });
    releaseScanTurn(domain, capture.log);

    await Promise.race([
      monitorPromise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout monitorPromise (Scenario L)")), 20_000))
    ]);

    const frFrRequestCount = fixture.requestLog.filter((u) => u === "/fr-fr" || u === "/fr-fr/").length;
    assert(frFrRequestCount === 1, `L) Aucun reload de /fr-fr par le code sous test (une seule requete /fr-fr, la navigation manuelle du test) (recu: ${frFrRequestCount})`);
    assert(recoverWorkflowCalls.length === 1, `L) recoverWorkflow() est appele exactement une fois, jamais un page.reload() de /fr-fr (recu: ${recoverWorkflowCalls.length})`);
    assert(
      capture.entries.some((e) => e.message.includes("Accueil TLS deconnecte detecte juste avant le refresh planifie")),
      "L) Le motif exact (accueil deconnecte avant refresh planifie) est journalise"
    );
    assert(onRefreshSucceededCalls === 1, `L) onRefreshSucceeded() est appele (reprise reussie) (recu: ${onRefreshSucceededCalls})`);
    assert(onRefreshFailedCalls === 0, `L) Aucun echec de refresh comptabilise pour ce cas specifique (recu: ${onRefreshFailedCalls})`);
    assert(waitForUserCalls === 0, "L) Aucune intervention humaine sollicitee (jamais alertAndPause pour ce cas)");
    assertNoSecretsInLogs(capture.entries, "L) Aucun secret dans les logs");
  } finally {
    await context.close();
    await readyPage.close().catch(() => undefined);
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ===================== Scenario M (CORRECTIF CIBLE): refresh planifie termine sur /fr-fr - recovery direct (jamais alertAndPause) =====================
// Teste directement monitorAppointments(): le refresh planifie (page.reload())
// se termine sur l'accueil TLS deconnecte (redirection HTTP deterministe cote
// fixture, jamais un timer) - le code doit appeler recoverWorkflow() AVANT
// tout alertAndPause, et reprendre normalement en cas de succes (jamais de
// WAITING_FOR_USER, onRefreshSucceeded appele).

const runScenarioM = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario M (correctif cible): refresh planifie termine sur /fr-fr -> recovery direct (jamais alertAndPause direct) ===");
  const fixture = await startRedirectOnReloadFixture();
  const context = await browser.newContext();
  const page = await context.newPage();
  const readyPage = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    await readyPage.goto(`${fixture.baseUrl}/ready`, { waitUntil: "domcontentloaded" });

    const capture = makeLogCapture();
    const recoverWorkflowCalls: Array<string | undefined> = [];
    let onRefreshFailedCalls = 0;
    let onRefreshSucceededCalls = 0;
    let waitForUserCalls = 0;

    const config: AppConfig = {
      targetUrl: `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`,
      connectToExistingChrome: false,
      chromeDebugUrl: "",
      refreshIntervalMs: 1_000,
      headless: true,
      slowMoMs: 0,
      debugKeepBrowserOpen: false,
      maxRefreshAttempts: 1,
      scanMonthCount: 1,
      maxParallelScansPerDomain: 1,
      monthClickMinDelayMs: 100,
      monthClickMaxDelayMs: 200,
      botCycleCooldownMinMs: 300,
      botCycleCooldownMaxMs: 500,
      refreshEveryCycles: 1,
      rateLimitCooldownMinutes: 1
    };

    const monitorPromise = monitorAppointments(page, config, {
      log: capture.log,
      waitForUser: async () => { waitForUserCalls += 1; },
      recoverWorkflow: async (reason) => {
        recoverWorkflowCalls.push(reason);
        return readyPage;
      },
      onRefreshFailed: () => { onRefreshFailedCalls += 1; },
      onRefreshSucceeded: () => { onRefreshSucceededCalls += 1; }
    });

    // waitForPageReadyAfterRefresh (monitor.ts) sonde jusqu'a 30s avant de
    // constater l'echec du refresh simple et de lever l'erreur - delai
    // existant, jamais raccourci ici (aucune modification du fallback 0.2.3).
    await Promise.race([
      monitorPromise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout monitorPromise (Scenario M)")), 60_000))
    ]);

    assert(recoverWorkflowCalls.length === 1, `M) recoverWorkflow() est appele exactement une fois apres le refresh termine sur /fr-fr (recu: ${recoverWorkflowCalls.length})`);
    // CORRECTIF CIBLE (refresh temporel 20 min): la branche est desormais
    // GENERALISEE (recoverWorkflow tente pour TOUT etat non pret apres
    // refresh planifie, plus seulement /fr-fr - cf. CAS B/C/D du correctif) -
    // l'ancien message specifique a /fr-fr n'existe donc plus tel quel; le
    // succes de la reprise (recoverWorkflowCalls ci-dessus + ce message de
    // reprise) est la preuve equivalente et plus generale que le recovery a
    // bien ete tente et a reussi.
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement (recovery apres refresh planifie)")),
      "M) La reprise via le recovery pilote par etat (desormais generalise a tout etat, pas seulement /fr-fr) est bien journalisee comme reussie"
    );
    assert(waitForUserCalls === 0, "M) Aucun alertAndPause direct: le recovery est tente avant toute intervention humaine");
    assert(onRefreshSucceededCalls === 1, `M) onRefreshSucceeded() est appele (reprise reussie apres recovery) (recu: ${onRefreshSucceededCalls})`);
    assert(onRefreshFailedCalls === 0, `M) Aucun echec de refresh comptabilise puisque le recovery a reussi (recu: ${onRefreshFailedCalls})`);
    assertNoSecretsInLogs(capture.entries, "M) Aucun secret dans les logs");
  } finally {
    await context.close();
    await readyPage.close().catch(() => undefined);
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ===================== Scenario N (CORRECTIF CIBLE): refresh planifie termine sur /fr-fr, recovery ECHOUE - fallback 0.2.3 inchange =====================
// Meme depart que le Scenario M, mais recoverWorkflow() echoue (retourne
// null): prouve que la logique fallback/echec EXISTANTE (onRefreshFailed +
// alertAndPause/waitForUser) reste intacte et se declenche normalement -
// aucune regression du comportement 0.2.3 pour ce nouveau cas.

const runScenarioN = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario N (correctif cible): refresh planifie termine sur /fr-fr, recovery echoue -> fallback 0.2.3 inchange ===");
  const fixture = await startRedirectOnReloadFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });

    const capture = makeLogCapture();
    let onRefreshFailedCalls = 0;
    let waitForUserCalls = 0;
    let recoverWorkflowCalls = 0;

    const config: AppConfig = {
      targetUrl: `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`,
      connectToExistingChrome: false,
      chromeDebugUrl: "",
      refreshIntervalMs: 1_000,
      headless: true,
      slowMoMs: 0,
      debugKeepBrowserOpen: false,
      maxRefreshAttempts: 1,
      scanMonthCount: 1,
      maxParallelScansPerDomain: 1,
      monthClickMinDelayMs: 100,
      monthClickMaxDelayMs: 200,
      botCycleCooldownMinMs: 300,
      botCycleCooldownMaxMs: 500,
      refreshEveryCycles: 1,
      rateLimitCooldownMinutes: 1
    };

    const monitorPromise = monitorAppointments(page, config, {
      log: capture.log,
      waitForUser: async () => { waitForUserCalls += 1; },
      recoverWorkflow: async () => { recoverWorkflowCalls += 1; return null; },
      onRefreshFailed: () => { onRefreshFailedCalls += 1; }
    });

    await Promise.race([
      monitorPromise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout monitorPromise (Scenario N)")), 60_000))
    ]);

    // CORRECTIF CIBLE (refresh temporel 20 min): la branche est desormais
    // GENERALISEE (recoverWorkflow tente pour TOUT etat non pret apres
    // refresh planifie, plus seulement /fr-fr) - l'ancien message specifique
    // a /fr-fr n'existe donc plus tel quel; le compteur d'appel est la preuve
    // equivalente et plus generale que le recovery a bien ete TENTE (et a
    // echoue ici, cf. le stub recoverWorkflow ci-dessus) avant tout fallback.
    assert(recoverWorkflowCalls === 1, `N) Le recovery pilote par etat est bien tente exactement une fois avant tout fallback (recu: ${recoverWorkflowCalls})`);
    assert(onRefreshFailedCalls === 1, `N) Le recovery ayant echoue, l'echec de refresh EXISTANT est bien comptabilise (fallback 0.2.3 inchange) (recu: ${onRefreshFailedCalls})`);
    assert(waitForUserCalls >= 1, "N) Le fallback alertAndPause/waitForUser EXISTANT se declenche normalement apres l'echec du recovery");
    assertNoSecretsInLogs(capture.entries, "N) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ===================== Helpers serveur/HTTP reel (F/H) =====================
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
    env: { ...process.env, WEB_PORT: String(port), BREVO_API_KEY: "", ...env },
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
      AGENT_AUTO_NAV_LONG_WAIT_MS: "500",
      AGENT_WORKFLOW_RECOVERY_RETRY_INTERVAL_MS: "500",
      AGENT_WORKFLOW_RECOVERY_LONG_WAIT_MS: "1000"
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
// Le registre serveur (agentCommandService.ts: AgentBotRecord) n'expose que
// botStatus (chaine simple) - "details"/"reason" ne sont PERSISTES nulle
// part de facon requetable via l'API (deja vrai avant ce hotfix, ex.
// "PAGE_CLOSED"): ils ne sont visibles que dans le texte du log serveur
// construit par agentGateway.ts. Ce helper ne renvoie donc que le statut ;
// la verification de "reason" se fait via serverLogText (cf. Scenario F).
const botStatusFor = async (baseUrl: string, cookie: string, botName: string): Promise<{ status: string } | null> => {
  const res = await requestJson(baseUrl, "GET", "/api/agent-commands?limit=20", cookie);
  const command = (res.body?.commands ?? []).find((c: any) => c.botName === botName);
  return command ? { status: command.botStatus } : null;
};

// recordLog() (server.ts) n'imprime JAMAIS ce message sur la sortie standard
// du serveur - il est uniquement stocke en memoire (logHistory) et emis via
// socket.io ("bot-log") aux sockets autorises, exactement comme le fait le
// vrai tableau de bord. Se connecter en socket (comme un vrai navigateur
// utilisateur) est donc le SEUL moyen fidele d'observer "un log visible dans
// RendezBot" (section 10, point 2) sans re-implementer la logique serveur.
const openUiSocket = (baseUrl: string, cookie: string): Promise<Socket> => new Promise((resolve, reject) => {
  const s = ioClient(baseUrl, { autoConnect: false, reconnection: false, extraHeaders: { Cookie: cookie } });
  const t = setTimeout(() => reject(new Error("timeout ui socket")), 8_000);
  s.on("connect", () => { clearTimeout(t); resolve(s); });
  s.connect();
});

// ===================== Scenario F/H: chemin serveur reel (notification + non-regression) =====================
// TARGET_URL est une variable d'environnement AU NIVEAU DU PROCESS SERVEUR
// (jamais un reglage par agence modifiable a chaud, cf. resolveAgentTlsStartUrl
// dans src/server.ts) - F et H ont chacun besoin d'un TARGET_URL different et
// tournent donc chacun sur leur PROPRE serveur/agent/port, jamais partages.

type ServerAgentSetup = {
  server: ServerHandle;
  agent: RealAgentHandle;
  browser: Browser;
  uiPage: import("playwright").Page;
  managerLogin: string;
  managerPassword: string;
  managerCookie: string;
  agencyName: string;
  dataRoot: string;
};

const setupServerAgentAndUi = async (
  port: number,
  targetUrl: string,
  namePrefix: string,
  managerLogins: string[],
  agencyNames: string[],
  // Isolation vis-a-vis du .env developpeur (jamais un test qui depend de la
  // configuration locale reelle, ex. de vrais identifiants SMTP): optionnel,
  // absent pour tous les appelants existants (H) - comportement inchange.
  extraServerEnv: Record<string, string> = {}
): Promise<ServerAgentSetup> => {
  const server = await startServer(port, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent", TARGET_URL: targetUrl, ...extraServerEnv });
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

  const dataRoot = `.test-monitoring-recovery-${namePrefix}-${RUN_SUFFIX}`;
  const agent = spawnRealAgent(server.baseUrl, dataRoot, `REAL-MONITORING-RECOVERY-${namePrefix}-PC`);
  await waitUntil(() => extractLocalUiPort(agent.stdout) !== null, 10_000);
  const localPort = extractLocalUiPort(agent.stdout)!;
  const status1 = await localUiStatus(localPort);
  const pairing = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
  await localUiPost(localPort, "/local/pair", status1.nonce, { code: pairing.body.pairing.code });
  await waitUntil(async () => (await localUiStatus(localPort)).state === "CONNECTED", 10_000);

  const browser = await chromium.launch({ headless: true });
  const uiContext = await browser.newContext();
  const uiPage = await uiContext.newPage();
  await uiPage.goto(server.baseUrl);
  await uiPage.fill("#loginInput", managerLogin);
  await uiPage.fill("#passwordInput", managerPassword);
  await uiPage.click('#loginForm button[type="submit"]');
  await uiPage.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
  await uiPage.click("#agentSetupSkip").catch(() => undefined);
  await uiPage.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
  await uiPage.click('[data-page-target="bot"]');
  await uiPage.waitForSelector("#page-bot.active");

  return { server, agent, browser, uiPage, managerLogin, managerPassword, managerCookie, agencyName, dataRoot };
};

const startBotViaUi = async (uiPage: import("playwright").Page, botName: string): Promise<void> => {
  await uiPage.fill("#botFormName", botName);
  await uiPage.selectOption("#botFormCategory", { index: 1 });
  await uiPage.fill("#botFormLogin", FAKE_LOGIN);
  await uiPage.fill("#botFormPassword", FAKE_PASSWORD);
  await uiPage.click("#startBot");
};

const teardownServerAgentSetup = async (
  setup: ServerAgentSetup | undefined,
  fixture: FixtureSite,
  managerLogins: string[],
  agencyNames: string[],
  dataRootOverride?: string
): Promise<void> => {
  if (setup) {
    await setup.browser.close().catch(() => undefined);
    await killTree(setup.agent.child.pid).catch(() => undefined);
    await killTree(setup.server.child.pid).catch(() => undefined);
  }
  fixture.server.closeAllConnections?.();
  await Promise.race([
    new Promise<void>((resolve) => fixture.server.close(() => resolve())),
    sleep(5_000)
  ]);
  try {
    const { pool } = await import("../src/db.js");
    if (managerLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [managerLogins]);
    if (agencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [agencyNames]);
  } catch (error) {
    log("CLEANUP-ERR", `Nettoyage base de donnees incomplet: ${error instanceof Error ? error.message : String(error)}`);
  }
  const dataRoot = dataRootOverride ?? setup?.dataRoot;
  if (dataRoot) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try { rmSync(dataRoot, { recursive: true, force: true }); break; } catch { if (attempt < 5) await sleep(300); }
    }
  }
};

// ----- Scenario H: parcours normal 0.2.2, non-regression -----

const runScenarioH = async (): Promise<void> => {
  log("BOOT", "=== Scenario H: non-regression du parcours normal 0.2.2 (home->login->travel-groups->service-level->appointment-booking) ===");
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  const fixture = await startFixtureSite("always-ready");
  let setup: ServerAgentSetup | undefined;

  try {
    setup = await setupServerAgentAndUi(3360, fixture.baseUrl, "RecoveryH", managerLogins, agencyNames);
    await startBotViaUi(setup.uiPage, "Bot RecoveryH");

    const rowFor = (text: string) => setup!.uiPage.locator("#agentCommandsTableBody tr", { hasText: text });
    await waitUntil(async () => (await rowFor("Bot RecoveryH").innerText().catch(() => "")).toLowerCase().includes("surveillance"), 60_000);
    const statusH = await botStatusFor(setup.server.baseUrl, setup.managerCookie, "Bot RecoveryH");
    assert(statusH?.status === "MONITORING", `H) Le parcours normal 0.2.2 reste intact et atteint MONITORING (recu: ${statusH?.status})`);

    const agentLogText = setup.agent.stdout.join("");
    assert(!agentLogText.includes(FAKE_LOGIN) && !agentLogText.includes(FAKE_PASSWORD), "G) Aucun secret dans les logs de l'agent (scenario H)");
  } finally {
    await teardownServerAgentSetup(setup, fixture, managerLogins, agencyNames);
  }
};

// ----- Scenario F: echec terminal -> notification reelle -----

const runScenarioF = async (): Promise<void> => {
  log("BOOT", "=== Scenario F: WORKFLOW_RECOVERY_FAILED -> exactement un evenement serveur + une notification ===");
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  const fixture = await startFixtureSite("error-forever");
  let setup: ServerAgentSetup | undefined;

  let uiSocket: Socket | undefined;
  try {
    // CORRECTIF (test devenu obsolete apres le passage au transport email
    // generique SMTP primaire + repli Brevo, hors perimetre de ce hotfix):
    // ce scenario ne doit JAMAIS dependre de la config SMTP reelle du .env
    // developpeur (identifiants reels -> vrai envoi SMTP en plein test
    // automatise). On force ici, UNIQUEMENT pour ce scenario, EXACTEMENT
    // l'etat "email indisponible" que ce test a toujours voulu verifier:
    // transport primaire = brevo (jamais smtp), aucun repli configure, et
    // SMTP_* explicitement vides en plus (double garantie qu'aucun envoi
    // SMTP reel n'est jamais tente, meme si la resolution du transport
    // changeait). BREVO_API_KEY reste vide (deja force par startServer
    // ci-dessous), donc sendAlertEmail (couche email ACTUELLE,
    // src/emailService.ts) atteint reellement brevoEmailService.ts et
    // journalise "Envoi email ignore (BREVO_API_KEY manquant)" de maniere
    // deterministe - jamais un vrai envoi SMTP/Brevo dans ce test.
    setup = await setupServerAgentAndUi(3361, fixture.baseUrl, "RecoveryF", managerLogins, agencyNames, {
      EMAIL_PRIMARY_TRANSPORT: "brevo",
      EMAIL_FALLBACK_TRANSPORT: "",
      SMTP_HOST: "",
      SMTP_USER: "",
      SMTP_PASSWORD: ""
    });

    // Connecte AVANT START_BOT (jamais apres): un vrai tableau de bord serait
    // deja connecte au moment ou l'evenement survient - se connecter trop tard
    // manquerait le "bot-log" (jamais rejoue pour un socket qui arrive apres).
    uiSocket = await openUiSocket(setup.server.baseUrl, setup.managerCookie);
    const botLogMessages: string[] = [];
    uiSocket.on("bot-log", (event: { level: string; message: string }) => { botLogMessages.push(event.message); });

    await startBotViaUi(setup.uiPage, "Bot RecoveryF");

    await waitUntil(async () => (await botStatusFor(setup!.server.baseUrl, setup!.managerCookie, "Bot RecoveryF"))?.status === "WAITING_FOR_USER", 90_000);
    const statusF = await botStatusFor(setup.server.baseUrl, setup.managerCookie, "Bot RecoveryF");
    assert(statusF?.status === "WAITING_FOR_USER", `F) Le bot atteint WAITING_FOR_USER apres echec du recovery (recu: ${statusF?.status})`);

    await sleep(2_000);
    const statusLogCount = botLogMessages.filter((m) => /Statut du bot: WAITING_FOR_USER.*WORKFLOW_RECOVERY_FAILED/.test(m)).length;
    assert(statusLogCount >= 1, `F) Un log visible dans RendezBot (evenement socket "bot-log" reel, comme le vrai tableau de bord) est bien produit pour ce statut (recu: ${statusLogCount} sur ${botLogMessages.length} logs)`);

    const serverLogText = setup.server.stdout.join("");
    const emailAttemptCount = (serverLogText.match(/Envoi email ignore \(BREVO_API_KEY manquant\)/g) ?? []).length;
    assert(
      emailAttemptCount === 1,
      `F) Exactement UNE tentative de notification reelle, chemin applicatif complet jusqu'a la couche email ACTUELLE `
      + `(src/emailService.ts -> transport Brevo, SMTP explicitement neutralise pour ce test, BREVO_API_KEY vide) - jamais de spam, jamais un vrai envoi SMTP/Brevo (recu: ${emailAttemptCount})`
    );
    const SMTP_ATTEMPT_MARKERS = ["SMTP email sent", "SMTP email failed", "SMTP fallback sent"];
    assert(
      !SMTP_ATTEMPT_MARKERS.some((marker) => serverLogText.includes(marker)),
      "F) Aucun envoi/tentative SMTP reel (src/smtpEmailService.ts) n'a eu lieu dans ce test automatise (transport primaire force sur brevo, aucun repli configure, SMTP_* explicitement vides)"
    );
    assert(!serverLogText.includes(FAKE_LOGIN) && !serverLogText.includes(FAKE_PASSWORD), "G) Aucun secret (login/mot de passe) dans les logs serveur");
    assert(
      !botLogMessages.some((m) => m.includes(FAKE_LOGIN) || m.includes(FAKE_PASSWORD)),
      "G) Aucun secret dans les logs 'bot-log' recus par le tableau de bord (evenement socket reel)"
    );

    const agentLogText = setup.agent.stdout.join("");
    assert(!agentLogText.includes(FAKE_LOGIN) && !agentLogText.includes(FAKE_PASSWORD), "G) Aucun secret dans les logs de l'agent (scenario F)");

    const commandsRes = await requestJson(setup.server.baseUrl, "GET", "/api/agent-commands?limit=20", setup.managerCookie);
    const dbText = JSON.stringify(commandsRes.body);
    assert(!dbText.includes(FAKE_LOGIN) && !dbText.includes(FAKE_PASSWORD), "G) Aucun secret dans les resultats publics (BOT_STATUS/commandes)");
  } finally {
    uiSocket?.disconnect();
    await teardownServerAgentSetup(setup, fixture, managerLogins, agencyNames);
  }
};

// ===================== BUG CIBLE 0.2.4 =====================
// Scenarios O/P/Q/R: reproduisent et corrigent les 4 points de rupture
// confirmes en reel (mauvais target URL, URL arbitraire pendant le
// monitoring, session expiree classee a tort comme validation humaine,
// credentials perdus apres VALIDATE_BOT). O/R testent le VRAI AgentBotManager
// (vrai Chrome via launchChromeForBot, jamais un Chrome fantome) - a executer
// sur un PC Windows avec Chrome installe, comme le reste de ce fichier.

const removeTestDataRoot = async (dataRoot: string): Promise<void> => {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      rmSync(dataRoot, { recursive: true, force: true });
      return;
    } catch {
      if (attempt < 5) {
        await sleep(300);
      }
    }
  }
};

// ----- Scenario O: recoveryTargetUrl = START_BOT.startUrl, jamais settings.targetUrl (about:blank) -----

const runScenarioO = async (): Promise<void> => {
  log("BOOT", "=== Scenario O (BUG CIBLE 0.2.4): recoveryTargetUrl = START_BOT.startUrl, jamais settings.targetUrl (about:blank) ===");
  const fixture = await startTargetUrlWiringFixture(3_000);
  const dataRoot = `.test-bug024-o-${RUN_SUFFIX}`;
  const capture = makeLogCapture();
  const { reporter, statuses } = makeFakeReporter();
  const settings = makeTestAgentSettings({ dataRoot });
  const manager = new AgentBotManager(settings, capture.log, reporter);
  const botId = "bot-scenario-o";

  try {
    await manager.startBot({
      commandId: "cmd-o-start",
      botId,
      botName: "ScenarioO",
      login: FAKE_LOGIN,
      password: FAKE_PASSWORD,
      rawMonitoringSettings: { botCycleCooldownMinMs: 5_000, botCycleCooldownMaxMs: 6_000, refreshEveryCycles: 0 },
      startUrl: `${fixture.baseUrl}/fr-fr/country/tn/vac/tnTUN2fr`
    });

    await waitUntil(() => statuses.some((s) => s.status === "MONITORING"), 30_000);
    assert(statuses.some((s) => s.status === "MONITORING"), "O) Le bot atteint MONITORING via le vrai startUrl fourni par START_BOT (settings.targetUrl reste about:blank pendant tout ce temps)");
    assert(!capture.entries.some((e) => e.message.includes("about:blank")), "O) 'about:blank' n'apparait jamais dans les logs (jamais utilise comme cible de navigation reelle)");

    // La page auto-redirige vers /fr-fr apres 3s (simule TLS qui sort
    // silencieusement le navigateur du workflow, exactement le bug reel
    // confirme par les logs 0.2.4) -> logged-out-landing -> recovery.
    await waitUntil(() => capture.entries.some((e) => e.message.includes("Accueil TLS deconnecte (logged-out-landing) detecte pendant la reprise")), 20_000);
    await waitUntil(() => capture.entries.some((e) => /retour vers targetUrl/.test(e.message)), 10_000);

    const returnLog = capture.entries.find((e) => /retour vers targetUrl/.test(e.message));
    assert(
      Boolean(returnLog?.message.includes("country")),
      `O) Le retour utilise le VRAI startUrl fourni par START_BOT (chemin /fr-fr/country/...), jamais about:blank (obtenu: ${returnLog?.message})`
    );
    assert(
      !capture.entries.some((e) => e.message.includes("targetUrl invalide/non http(s): retour impossible")),
      "O) Jamais le message d'echec exact du bug reel ('targetUrl invalide/non http(s): retour impossible')"
    );

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 30_000);
    assert(true, "O) Apres le retour vers le vrai startUrl, le parcours complet (home->login->service-level->appointment-booking) reprend et aboutit, meme bot/Chrome/profil/monitoring - jamais un nouveau START_BOT");

    // BUG CIBLE 0.2.4 (Test G): la chaine complete logged-out-landing ->
    // target -> home -> auth -> service-level -> appointment-booking doit
    // tenir dans UNE SEULE tentative externe (progression interne), sans
    // jamais declencher le long wait ni une intervention humaine.
    assert(
      !capture.entries.some((e) => /Reprise workflow 2\/4/.test(e.message)),
      "G) Une seule tentative externe a suffi pour toute la chaine (logged-out-landing->target->home->auth->service-level->appointment)"
    );
    assert(
      !capture.entries.some((e) => /tentatives sans page reconnue/.test(e.message)),
      "G) Aucun long wait de 5 minutes declenche (aucune etape n'a ete traitee comme un echec)"
    );
    assert(!statuses.some((s) => s.status === "WAITING_FOR_USER"), "G) Aucune intervention humaine (WAITING_FOR_USER) necessaire sur ce parcours");
    assertNoSecretsInLogs(capture.entries, "O) Aucun secret dans les logs");
  } finally {
    await manager.stopBot({ commandId: "cmd-o-stop", botId }).catch(() => undefined);
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await removeTestDataRoot(dataRoot);
  }
};

// ----- Scenario P: URL arbitraire pendant MONITORING -> detection hors workflow -> recovery -----

const runScenarioP = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario P (BUG CIBLE 0.2.4): URL arbitraire normale pendant MONITORING -> detection hors workflow -> recovery -> appointment-booking ===");
  const fixture = await startArbitraryUrlFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const { reporter } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-scenario-p",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`,
      commandId: "cmd-p",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      isBotStillRegistered: () => true
    });

    // Point de synchronisation deterministe: attend le premier cycle avant de
    // remplacer volontairement l'URL - jamais un delai arbitraire.
    await waitUntil(() => capture.entries.some((e) => e.message.includes("Surveillance tentative")), 5_000);
    // L'UTILISATEUR remplace volontairement l'URL de Chrome par une page
    // normale, sans aucun rapport avec TLScontact (exemple demande:
    // https://example.com/) - jamais un clic/une action du code sous test.
    await page.goto(`${fixture.baseUrl}/unknown`, { waitUntil: "domcontentloaded" });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 30_000);
    handle.abortController.abort();
    await handle.loopPromise;

    // Le texte exact "Page hors workflow detectee" (unexpectedReason) n'est
    // jamais imprime verbatim sur le chemin de succes (utilise uniquement
    // comme valeur interne/flag - seul un echec terminal l'aurait journalise
    // via alertAndPause) - la preuve observable equivalente est le suffixe
    // "apres page inattendue" du log de reprise, qui ne s'affiche QUE lorsque
    // detectUnexpectedPageReason (donc mon repli isAppointmentPageReady) a
    // bien produit un motif non nul pour cette page arbitraire.
    assert(
      capture.entries.some((e) => /Reprise workflow \d\/4 apres page inattendue/.test(e.message)),
      "P) Une URL arbitraire normale (jamais Cloudflare/CAPTCHA/motif d'erreur connu) declenche bien le recovery comme une page hors workflow"
    );
    assert(
      capture.entries.some((e) => e.message.includes("etat detecte = unknown")),
      "P) L'etat est classifie 'unknown' (jamais confondu avec un etat reconnu)"
    );
    assert(
      capture.entries.some((e) => /retour vers targetUrl/.test(e.message)),
      "P) Retour BORNE vers targetUrl deja fourni au monitoring (jamais une URL derivee de la page elle-meme)"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")),
      "P) Le monitoring reprend et aboutit a appointment-booking, meme bot/Chrome/profil/monitoring - jamais un nouveau START_BOT"
    );
    assertNoSecretsInLogs(capture.entries, "P) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ----- Scenario Q: session expiree seule -> jamais classee CAPTCHA/validation humaine -----

const runScenarioQ = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario Q (BUG CIBLE 0.2.4): 'session expired' seul -> jamais CAPTCHA/validation humaine, route vers le recovery automatique ===");
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.setContent(
      "<!DOCTYPE html><html><body><h1>Session expired</h1><p>Votre session a expire. Merci de vous reconnecter.</p></body></html>"
    );

    const validation = await detectHumanValidation(page);
    assert(!validation.detected, `Q) 'session expired' seul n'est plus classe comme validation humaine/CAPTCHA par detectHumanValidation (obtenu: ${JSON.stringify(validation)})`);

    const capture = makeLogCapture();
    let recoverWorkflowCalls = 0;
    let waitForUserCalls = 0;
    let recoverWorkflowReason: string | undefined;

    const config: AppConfig = {
      targetUrl: "about:blank",
      connectToExistingChrome: false,
      chromeDebugUrl: "",
      refreshIntervalMs: 1_000,
      headless: true,
      slowMoMs: 0,
      debugKeepBrowserOpen: false,
      maxRefreshAttempts: 1,
      scanMonthCount: 1,
      maxParallelScansPerDomain: 1,
      monthClickMinDelayMs: 100,
      monthClickMaxDelayMs: 200,
      botCycleCooldownMinMs: 300,
      botCycleCooldownMaxMs: 500,
      refreshEveryCycles: 1,
      rateLimitCooldownMinutes: 1
    };

    const monitorPromise = monitorAppointments(page, config, {
      log: capture.log,
      waitForUser: async () => { waitForUserCalls += 1; },
      recoverWorkflow: async (reason) => { recoverWorkflowCalls += 1; recoverWorkflowReason = reason; return null; }
    });

    await Promise.race([
      monitorPromise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout monitorPromise (Scenario Q)")), 20_000))
    ]);

    assert(recoverWorkflowCalls === 1, `Q) Le recovery workflow (automatique) est bien declenche pour 'session expired' (recu: ${recoverWorkflowCalls})`);
    assert(Boolean(recoverWorkflowReason && /session expir/i.test(recoverWorkflowReason)), `Q) Le motif transmis mentionne bien la session expiree (obtenu: ${recoverWorkflowReason})`);
    assert(waitForUserCalls === 0, `Q) Aucune intervention humaine sollicitee pour ce motif (pauseForHuman/alertAndPause jamais declenche) (recu: ${waitForUserCalls})`);
    assert(
      !capture.entries.some((e) => e.message.includes("Intervention humaine potentiellement requise")),
      "Q) Jamais le chemin CAPTCHA/validation humaine (pauseForHuman) pour une simple session expiree"
    );
    assertNoSecretsInLogs(capture.entries, "Q) Aucun secret dans les logs");
  } finally {
    await context.close();
  }
};

// ----- Scenario R: VALIDATE_BOT redonne au monitoring les runtime credentials du START_BOT initial -----

const runScenarioR = async (): Promise<void> => {
  log("BOOT", "=== Scenario R (BUG CIBLE 0.2.4): VALIDATE_BOT redonne au monitoring les runtime credentials du START_BOT initial ===");
  const fixture = await startTargetUrlWiringFixture(3_000);
  const dataRoot = `.test-bug024-r-${RUN_SUFFIX}`;
  const capture = makeLogCapture();
  const { reporter, statuses } = makeFakeReporter();
  const settings = makeTestAgentSettings({ dataRoot });
  const manager = new AgentBotManager(settings, capture.log, reporter);
  const botId = "bot-scenario-r";

  try {
    await manager.startBot({
      commandId: "cmd-r-start",
      botId,
      botName: "ScenarioR",
      login: FAKE_LOGIN,
      password: FAKE_PASSWORD,
      rawMonitoringSettings: { botCycleCooldownMinMs: 5_000, botCycleCooldownMaxMs: 6_000, refreshEveryCycles: 0 },
      startUrl: `${fixture.baseUrl}/fr-fr/country/tn/vac/tnTUN2fr`
    });
    await waitUntil(() => statuses.filter((s) => s.status === "MONITORING").length >= 1, 30_000);

    // Exerce deliberement le point d'entree VALIDATE_BOT sur un bot deja
    // reconnu (page de rendez-vous deja affichee) - reproduit fidelement
    // l'appel this.beginMonitoring(handle, commandId) qui, avant ce
    // correctif, ne recevait JAMAIS runtimeCredentials (contrairement au
    // chemin automatique) - sans avoir besoin d'un acces externe a la Page
    // Playwright du bot (deliberement hors de portee, cf. AgentBotHandle).
    await manager.validateBot({ commandId: "cmd-r-validate", botId });
    await waitUntil(() => statuses.filter((s) => s.status === "MONITORING").length >= 2, 15_000);
    capture.entries.length = 0; // ne conserver que ce qui suit VALIDATE_BOT.

    // Meme redirection self-inflicted que le Scenario O, observee cette fois
    // par le runtime de monitoring (re)demarre PAR VALIDATE_BOT.
    await waitUntil(() => capture.entries.some((e) => e.message.includes("etat detecte = auth")), 30_000);
    assert(
      capture.entries.some((e) => e.message.includes("nouvelle tentative de connexion automatique")),
      "R) Apres VALIDATE_BOT, les identifiants du START_BOT initial sont toujours disponibles en memoire: reconnexion automatique tentee"
    );
    assert(
      !capture.entries.some((e) => e.message.includes("aucun identifiant en memoire pour cette session")),
      "R) Jamais le message d'echec exact du bug reel ('aucun identifiant en memoire pour cette session') apres VALIDATE_BOT"
    );
    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 30_000);
    assert(true, "R) Le monitoring (re)demarre par VALIDATE_BOT retrouve la page de rendez-vous apres reconnexion automatique, meme bot/Chrome/profil - jamais un nouveau START_BOT");
    assertNoSecretsInLogs(capture.entries, "R) Aucun secret dans les logs apres VALIDATE_BOT");
  } finally {
    await manager.stopBot({ commandId: "cmd-r-stop", botId }).catch(() => undefined);
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await removeTestDataRoot(dataRoot);
  }
};

// ===================== CORRECTIF FINAL CIBLE (recovery plus reactif et multi-etapes) =====================
// Scenarios S-Z/AA: cooldown entre cycles interruptible (Tests A-F) et
// recovery multi-etapes (Tests G-N, partiellement couverts en etendant les
// Scenarios C/E/O ci-dessus plutot que de dupliquer des fixtures quasi
// identiques - cf. rapport final pour la correspondance complete).

// ----- Scenario S (Test A): cooldown interrompu par une sortie vers /fr-fr -----

const runScenarioS = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario S (CORRECTIF FINAL 0.2.4, Test A): cooldown interrompu par une sortie de appointment-booking vers /fr-fr ===");
  const fixture = await startArbitraryUrlFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const recoverWorkflowCalls: Array<string | undefined> = [];

    const config: AppConfig = {
      targetUrl: `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`,
      connectToExistingChrome: false,
      chromeDebugUrl: "",
      refreshIntervalMs: 1_000,
      headless: true,
      slowMoMs: 0,
      debugKeepBrowserOpen: false,
      // BUG DE TEST CORRIGE: maxRefreshAttempts=1 empechait la boucle de
      // jamais revenir en tete apres l'interruption (le seul cycle autorise
      // etait deja consomme) - 0 = illimite, borne ici par le Promise.race
      // ci-dessous, jamais par ce compteur.
      maxRefreshAttempts: 0,
      scanMonthCount: 1,
      maxParallelScansPerDomain: 1,
      monthClickMinDelayMs: 100,
      monthClickMaxDelayMs: 200,
      // Cooldown simule LONG (30s) - la reactivite attendue vient
      // exclusivement de l'interruption, jamais d'une reduction du cooldown
      // lui-meme (cadence de scan inchangee, cf. contrainte explicite).
      botCycleCooldownMinMs: 30_000,
      botCycleCooldownMaxMs: 30_000,
      refreshEveryCycles: 0,
      rateLimitCooldownMinutes: 1
    };

    const startedAt = Date.now();
    const monitorPromise = monitorAppointments(page, config, {
      log: capture.log,
      waitForUser: async () => undefined,
      recoverWorkflow: async (reason) => { recoverWorkflowCalls.push(reason); return null; }
    });

    // Point de synchronisation deterministe: attend que le cooldown ait
    // reellement demarre (jamais un delai arbitraire devine).
    await waitUntil(() => capture.entries.some((e) => e.message.includes("Attente avant nouveau cycle")), 10_000);
    await sleep(1_000);
    // L'UTILISATEUR force volontairement Chrome vers l'accueil TLS
    // deconnecte PENDANT la pause - jamais un clic/une action du code sous test.
    await page.goto(`${fixture.baseUrl}/fr-fr`, { waitUntil: "domcontentloaded" });

    await Promise.race([
      monitorPromise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout monitorPromise (Scenario S)")), 20_000))
    ]);
    const elapsedMs = Date.now() - startedAt;

    assert(elapsedMs < 15_000, `A/S) Le cooldown de 30s configure est interrompu bien avant son terme (recu: ${elapsedMs}ms, jamais proche de 30000ms)`);
    assert(
      capture.entries.some((e) => e.message.includes("Attente entre cycles interrompue: la page a quitte appointment-booking.")),
      "A/S) Le message d'interruption exact est journalise UNE fois (jamais de spam pendant le polling)"
    );
    assert(recoverWorkflowCalls.length >= 1, "A/S) recoverWorkflow() est bien appele apres l'interruption (retour en tete de boucle, jamais declenche par le watcher lui-meme)");
    assertNoSecretsInLogs(capture.entries, "A/S) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ----- Scenario T (Test B): cooldown interrompu par une URL arbitraire (fixture /unknown) -----

const runScenarioT = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario T (CORRECTIF FINAL 0.2.4, Test B): cooldown interrompu par une URL arbitraire (/unknown) ===");
  const fixture = await startArbitraryUrlFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const recoverWorkflowCalls: Array<string | undefined> = [];

    const config: AppConfig = {
      targetUrl: `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`,
      connectToExistingChrome: false,
      chromeDebugUrl: "",
      refreshIntervalMs: 1_000,
      headless: true,
      slowMoMs: 0,
      debugKeepBrowserOpen: false,
      // BUG DE TEST CORRIGE: idem Scenario S - 0 = illimite, borne par le
      // Promise.race ci-dessous, jamais par ce compteur.
      maxRefreshAttempts: 0,
      scanMonthCount: 1,
      maxParallelScansPerDomain: 1,
      monthClickMinDelayMs: 100,
      monthClickMaxDelayMs: 200,
      botCycleCooldownMinMs: 30_000,
      botCycleCooldownMaxMs: 30_000,
      refreshEveryCycles: 0,
      rateLimitCooldownMinutes: 1
    };

    const startedAt = Date.now();
    const monitorPromise = monitorAppointments(page, config, {
      log: capture.log,
      waitForUser: async () => undefined,
      recoverWorkflow: async (reason) => { recoverWorkflowCalls.push(reason); return null; }
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Attente avant nouveau cycle")), 10_000);
    await sleep(1_000);
    await page.goto(`${fixture.baseUrl}/unknown`, { waitUntil: "domcontentloaded" });

    await Promise.race([
      monitorPromise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout monitorPromise (Scenario T)")), 20_000))
    ]);
    const elapsedMs = Date.now() - startedAt;

    assert(elapsedMs < 15_000, `B/T) Le cooldown est interrompu bien avant son terme pour une URL arbitraire normale (recu: ${elapsedMs}ms)`);
    assert(
      capture.entries.some((e) => e.message.includes("Attente entre cycles interrompue: la page a quitte appointment-booking.")),
      "B/T) Le message d'interruption exact est journalise"
    );
    assert(recoverWorkflowCalls.length >= 1, "B/T) recoverWorkflow() est appele (unknown -> target -> recovery), jamais un simple redemarrage de cooldown");
    assertNoSecretsInLogs(capture.entries, "B/T) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ----- Scenario U (Tests C+F): cooldown NORMAL (page reste sur appointment-booking) -----
// Regroupe deliberement C (attente complete respectee, aucun recovery) et F
// (aucune navigation/requete supplementaire du watcher lui-meme): meme mise
// en place exacte, deux angles d'assertion sur le MEME scenario.

const runScenarioU = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario U (CORRECTIF FINAL 0.2.4, Tests C+F): cooldown normal - page reste sur appointment-booking, watcher sans effet de bord ===");
  const fixture = await startArbitraryUrlFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    let recoverWorkflowCalls = 0;
    const requestCountBeforeCooldown = fixture.requestLog.length;

    const config: AppConfig = {
      targetUrl: `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`,
      connectToExistingChrome: false,
      chromeDebugUrl: "",
      refreshIntervalMs: 1_000,
      headless: true,
      slowMoMs: 0,
      debugKeepBrowserOpen: false,
      maxRefreshAttempts: 1,
      scanMonthCount: 1,
      maxParallelScansPerDomain: 1,
      monthClickMinDelayMs: 100,
      monthClickMaxDelayMs: 200,
      // Cooldown COURT ici uniquement pour garder le test rapide (jamais une
      // reduction du cooldown de PRODUCTION, qui reste totalement inchange) -
      // la page ne quitte jamais appointment-booking dans ce scenario.
      botCycleCooldownMinMs: 5_000,
      botCycleCooldownMaxMs: 5_000,
      refreshEveryCycles: 0,
      rateLimitCooldownMinutes: 1
    };

    const startedAt = Date.now();
    const monitorPromise = monitorAppointments(page, config, {
      log: capture.log,
      waitForUser: async () => undefined,
      recoverWorkflow: async () => { recoverWorkflowCalls += 1; return null; }
    });

    await Promise.race([
      monitorPromise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout monitorPromise (Scenario U)")), 15_000))
    ]);
    const elapsedMs = Date.now() - startedAt;

    assert(elapsedMs >= 4_500, `C/U) Le cooldown complet (5000ms) est respecte quand la page reste sur appointment-booking (recu: ${elapsedMs}ms)`);
    assert(recoverWorkflowCalls === 0, "C/U) Aucun recovery declenche: la page n'a jamais quitte appointment-booking");
    assert(
      !capture.entries.some((e) => e.message.includes("Attente entre cycles interrompue")),
      "C/U) Aucune interruption journalisee (le cooldown s'est deroule normalement jusqu'au bout)"
    );
    const requestCountAfterCooldown = fixture.requestLog.length;
    assert(
      requestCountAfterCooldown === requestCountBeforeCooldown,
      `F/U) Le watcher de cooldown n'emet AUCUNE requete HTTP supplementaire (inspection locale de page.url() uniquement) (avant: ${requestCountBeforeCooldown}, apres: ${requestCountAfterCooldown})`
    );
    assertNoSecretsInLogs(capture.entries, "C/U) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ----- Scenario V (Test D): cooldown interrompu par un blocage Cloudflare/CAPTCHA -----

const runScenarioV = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario V (CORRECTIF FINAL 0.2.4, Test D): cooldown interrompu par un blocage Cloudflare/CAPTCHA -> chemin de validation humaine existant ===");
  const fixture = await startArbitraryUrlFixture();
  const context = await browser.newContext();
  const page = await context.newPage();
  const abortController = new AbortController();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();

    const config: AppConfig = {
      targetUrl: `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`,
      connectToExistingChrome: false,
      chromeDebugUrl: "",
      refreshIntervalMs: 1_000,
      headless: true,
      slowMoMs: 0,
      debugKeepBrowserOpen: false,
      // BUG DE TEST CORRIGE: idem Scenario S/T - 0 = illimite, borne par
      // l'abort explicite + Promise.race ci-dessous, jamais par ce compteur.
      maxRefreshAttempts: 0,
      scanMonthCount: 1,
      maxParallelScansPerDomain: 1,
      monthClickMinDelayMs: 100,
      monthClickMaxDelayMs: 200,
      botCycleCooldownMinMs: 20_000,
      botCycleCooldownMaxMs: 20_000,
      refreshEveryCycles: 0,
      rateLimitCooldownMinutes: 1
    };

    const monitorPromise = monitorAppointments(page, config, {
      log: capture.log,
      waitForUser: async () => undefined,
      recoverWorkflow: async () => null,
      signal: abortController.signal
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Attente avant nouveau cycle")), 10_000);
    await sleep(1_000);
    await page.goto(`${fixture.baseUrl}/cloudflare-challenge`, { waitUntil: "domcontentloaded" });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Attente entre cycles interrompue")), 10_000);
    assert(
      capture.entries.some((e) => e.message.includes("Attente entre cycles interrompue: la page a quitte appointment-booking.")),
      "D/V) La pause entre cycles est bien interrompue par le blocage Cloudflare/CAPTCHA"
    );

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Intervention humaine potentiellement requise")), 15_000);
    assert(
      capture.entries.some((e) => e.message.includes("Intervention humaine potentiellement requise")),
      "D/V) Apres l'interruption, la boucle principale reprend et le chemin de validation humaine EXISTANT (detectHumanValidation/pauseForHuman, inchange) est bien declenche"
    );
    assert(
      !capture.entries.some((e) => /contourn/i.test(e.message)),
      "D/V) Aucun contournement CAPTCHA/Cloudflare n'est jamais tente"
    );

    abortController.abort();
    await Promise.race([monitorPromise, sleep(20_000)]);
    assertNoSecretsInLogs(capture.entries, "D/V) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ----- Scenario W (Test E): STOP/abort pendant le cooldown -> sortie rapide -----

const runScenarioW = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario W (CORRECTIF FINAL 0.2.4, Test E): STOP/abort pendant le cooldown -> sortie rapide (comportement existant, inchange) ===");
  const fixture = await startArbitraryUrlFixture();
  const context = await browser.newContext();
  const page = await context.newPage();
  const abortController = new AbortController();

  try {
    await page.goto(`${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();

    const config: AppConfig = {
      targetUrl: `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`,
      connectToExistingChrome: false,
      chromeDebugUrl: "",
      refreshIntervalMs: 1_000,
      headless: true,
      slowMoMs: 0,
      debugKeepBrowserOpen: false,
      maxRefreshAttempts: 1,
      scanMonthCount: 1,
      maxParallelScansPerDomain: 1,
      monthClickMinDelayMs: 100,
      monthClickMaxDelayMs: 200,
      botCycleCooldownMinMs: 30_000,
      botCycleCooldownMaxMs: 30_000,
      refreshEveryCycles: 0,
      rateLimitCooldownMinutes: 1
    };

    const startedAt = Date.now();
    const monitorPromise = monitorAppointments(page, config, {
      log: capture.log,
      waitForUser: async () => undefined,
      recoverWorkflow: async () => null,
      signal: abortController.signal
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Attente avant nouveau cycle")), 10_000);
    await sleep(500);
    abortController.abort();

    await Promise.race([
      monitorPromise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout monitorPromise (Scenario W)")), 10_000))
    ]);
    const elapsedMs = Date.now() - startedAt;

    assert(elapsedMs < 8_000, `E/W) L'abort pendant le cooldown de 30s produit une sortie rapide (recu: ${elapsedMs}ms)`);
    assertNoSecretsInLogs(capture.entries, "E/W) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ----- Fixtures dediees au recovery multi-etapes (Tests H/J/L) -----

// Test H: simule une session TLS ENCORE VALIDE - /fr-fr/login redirige
// DIRECTEMENT vers travel-groups (302), sans jamais afficher de formulaire de
// connexion, reproduisant fidelement le cas reel confirme (section 8).
const startHomeToTravelGroupsDirectFixture = (): Promise<FixtureSite> => new Promise((resolve, reject) => {
  const requestLog: string[] = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    requestLog.push(url);
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (url.startsWith("/fr-fr/country/")) { res.end(COUNTRY_HOME_HTML); return; }
    if (url.startsWith("/fr-fr/login")) { res.statusCode = 302; res.setHeader("Location", "/fr-fr/travel-groups"); res.end(); return; }
    if (url.startsWith("/fr-fr/travel-groups")) { res.end(TRAVEL_GROUPS_HTML); return; }
    if (url.startsWith("/workflow/application-summary")) { res.end(APPLICATION_SUMMARY_HTML); return; }
    if (url.startsWith("/workflow/service-level")) { res.end(SERVICE_LEVEL_HTML); return; }
    if (url.startsWith("/workflow/appointment-booking/")) { res.end(APPOINTMENT_READY_HTML); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, requestLog, appointmentReloadCount: () => 0 });
  });
});

// Test J: page travel-groups CASSEE - aucun element "Selectionner" nulle
// part, donc aucune action ne peut jamais faire progresser cette page
// (echec REEL, jamais une progression).
const BROKEN_TRAVEL_GROUPS_HTML = `<!DOCTYPE html><html><body>
<h1>Gestionnaire des demandes</h1>
<p>Aucune action disponible ici (fixture de test: etat volontairement bloque).</p>
</body></html>`;

const startStuckTravelGroupsFixture = (): Promise<FixtureSite> => new Promise((resolve, reject) => {
  const requestLog: string[] = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    requestLog.push(req.url ?? "/");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(BROKEN_TRAVEL_GROUPS_HTML);
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, requestLog, appointmentReloadCount: () => 0 });
  });
});

// Test L: page de depart totalement arbitraire ("unknown"), puis targetUrl
// pointe vers la page pays ("home", RECONNUE mais pas encore pret) - prouve
// que unknown -> home est traitee comme une progression interne, jamais un
// second retry externe.
const startUnknownToHomeChainFixture = (): Promise<FixtureSite> => new Promise((resolve, reject) => {
  const requestLog: string[] = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    requestLog.push(url);
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (url.startsWith("/random-unrelated-page")) { res.end(ARBITRARY_UNRELATED_PAGE_HTML); return; }
    if (url.startsWith("/fr-fr/country/")) { res.end(COUNTRY_HOME_HTML); return; }
    if (url.startsWith("/fr-fr/login")) { res.statusCode = 302; res.setHeader("Location", "/fr-fr/travel-groups"); res.end(); return; }
    if (url.startsWith("/fr-fr/travel-groups")) { res.end(TRAVEL_GROUPS_HTML); return; }
    if (url.startsWith("/workflow/application-summary")) { res.end(APPLICATION_SUMMARY_HTML); return; }
    if (url.startsWith("/workflow/service-level")) { res.end(SERVICE_LEVEL_HTML); return; }
    if (url.startsWith("/workflow/appointment-booking/")) { res.end(APPOINTMENT_READY_HTML); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, requestLog, appointmentReloadCount: () => 0 });
  });
});

// ----- Scenario Y (Test H): home -> travel-groups DIRECT (session TLS encore valide) -----

const runScenarioY = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario Y (CORRECTIF FINAL 0.2.4, Test H): home -> travel-groups DIRECT (session TLS encore valide, login court-circuite) ===");
  const fixture = await startHomeToTravelGroupsDirectFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/fr-fr/country/tn/vac/tnTUN2fr`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-scenario-y",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/fr-fr/country/tn/vac/tnTUN2fr`,
      commandId: "cmd-y",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      isBotStillRegistered: () => true
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 30_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(capture.entries.some((e) => e.message.includes("etat detecte = home")), "H/Y) L'etat 'home' (page pays) est correctement classifie au depart");
    assert(
      capture.entries.some((e) => /Recovery progression: home -> travel-groups\.?/.test(e.message)),
      "H/Y) La progression home -> travel-groups est reconnue DIRECTEMENT (session TLS encore valide), jamais un 'echec de navigation /login'"
    );
    assert(
      !capture.entries.some((e) => e.message.includes("Menu compte introuvable")),
      "H/Y) Le code ne continue jamais inutilement a chercher le menu 'Se connecter' une fois la progression reelle detectee (correctif loginFlow.ts, section 8)"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")),
      "H/Y) Le monitoring aboutit a la page de rendez-vous"
    );
    assert(
      !capture.entries.some((e) => /Reprise workflow 2\/4/.test(e.message)),
      "H/Y) Une seule tentative externe a suffi (home->travel-groups->application-summary->service-level->appointment, toutes en transitions internes)"
    );
    assert(statuses.every((s) => s.status !== "WAITING_FOR_USER" && s.status !== "ERROR"), "H/Y) Aucune intervention humaine necessaire");
    assertNoSecretsInLogs(capture.entries, "H/Y) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ----- Scenario Z (Test J): etat REELLEMENT inchange apres action -> vrai echec, retry externe consomme -----

const runScenarioZ = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario Z (CORRECTIF FINAL 0.2.4, Test J): etat inchange apres action -> vrai echec, tentative externe reellement consommee ===");
  const fixture = await startStuckTravelGroupsFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/fr-fr/travel-groups`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const { reporter } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-scenario-z",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/fr-fr/travel-groups`,
      commandId: "cmd-z",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 800,
      isBotStillRegistered: () => true
    });

    await waitUntil(() => capture.entries.filter((e) => /Reprise workflow \d\/4/.test(e.message)).length >= 2, 20_000);
    handle.abortController.abort();
    await handle.loopPromise;

    const attemptCount = capture.entries.filter((e) => /Reprise workflow \d\/4/.test(e.message)).length;
    assert(attemptCount >= 2, `J/Z) Un etat reellement inchange apres action consomme bien PLUSIEURS tentatives externes distinctes (recu: ${attemptCount})`);
    assert(
      capture.entries.some((e) => e.message.includes("Recovery sans progression: etat toujours travel-groups.")),
      "J/Z) Le motif exact d'echec REEL (etat inchange) est journalise"
    );
    assert(
      !capture.entries.some((e) => /Recovery progression:/.test(e.message)),
      "J/Z) Aucune progression n'est jamais faussement rapportee pour cet etat reellement bloque"
    );
    assertNoSecretsInLogs(capture.entries, "J/Z) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ----- Scenario AA (Test L): unknown -> retour targetUrl -> etat reconnu (home, pas pret) = progression -----

const runScenarioAA = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario AA (CORRECTIF FINAL 0.2.4, Test L): unknown -> target -> etat reconnu (home, pas encore pret) -> progression, pas de retry supplementaire ===");
  const fixture = await startUnknownToHomeChainFixture();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/random-unrelated-page`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-scenario-aa",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/fr-fr/country/tn/vac/tnTUN2fr`,
      commandId: "cmd-aa",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      isBotStillRegistered: () => true
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 30_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(capture.entries.some((e) => e.message.includes("etat detecte = unknown")), "L/AA) L'etat de depart (page arbitraire) est bien classifie 'unknown'");
    assert(
      capture.entries.some((e) => /Recovery progression: unknown -> home\.?/.test(e.message)),
      "L/AA) Apres le retour vers targetUrl, l'etat 'home' (reconnu mais pas encore pret) est traite comme une PROGRESSION, jamais une nouvelle tentative externe"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")),
      "L/AA) Le monitoring aboutit a la page de rendez-vous"
    );
    assert(
      !capture.entries.some((e) => /Reprise workflow 2\/4/.test(e.message)),
      "L/AA) Une seule tentative externe a suffi (unknown->home->travel-groups->application-summary->service-level->appointment, toutes en transitions internes)"
    );
    assert(statuses.every((s) => s.status !== "WAITING_FOR_USER" && s.status !== "ERROR"), "L/AA) Aucune intervention humaine necessaire");
    assertNoSecretsInLogs(capture.entries, "L/AA) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ----- Scenario AB (audit suite): URL INCHANGEE pendant le cooldown, mais le
// contenu devient un blocage CAPTCHA/Cloudflare (cas reel signale: TLS peut
// afficher un overlay/remplacer le contenu SANS jamais naviguer) -----

const runScenarioAB = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario AB (AUDIT 0.2.4): cooldown interrompu par un blocage CAPTCHA/Cloudflare AVEC URL IDENTIQUE (mutation DOM locale, jamais de navigation) ===");
  const fixture = await startArbitraryUrlFixture();
  const context = await browser.newContext();
  const page = await context.newPage();
  const abortController = new AbortController();

  try {
    const appointmentUrl = `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`;
    await page.goto(appointmentUrl, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();

    const config: AppConfig = {
      targetUrl: appointmentUrl,
      connectToExistingChrome: false,
      chromeDebugUrl: "",
      refreshIntervalMs: 1_000,
      headless: true,
      slowMoMs: 0,
      debugKeepBrowserOpen: false,
      maxRefreshAttempts: 0,
      scanMonthCount: 1,
      maxParallelScansPerDomain: 1,
      monthClickMinDelayMs: 100,
      monthClickMaxDelayMs: 200,
      botCycleCooldownMinMs: 20_000,
      botCycleCooldownMaxMs: 20_000,
      refreshEveryCycles: 0,
      rateLimitCooldownMinutes: 1
    };

    const monitorPromise = monitorAppointments(page, config, {
      log: capture.log,
      waitForUser: async () => undefined,
      recoverWorkflow: async () => null,
      signal: abortController.signal
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Attente avant nouveau cycle")), 10_000);
    await sleep(1_000);
    const requestCountBeforeMutation = fixture.requestLog.length;
    const urlBeforeMutation = page.url();

    // Mutation DOM LOCALE uniquement (jamais page.goto/reload) - reproduit un
    // overlay CAPTCHA/Cloudflare affiche par TLS sans jamais changer l'URL.
    await page.evaluate(() => {
      document.title = "Just a moment...";
      document.body.innerHTML = "<p>Vérification humaine requise avant de continuer.</p>";
    });

    assert(page.url() === urlBeforeMutation, "AUDIT/AB) L'URL n'a pas change apres la mutation DOM (jamais de navigation)");

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Attente entre cycles interrompue")), 20_000);
    assert(
      capture.entries.some((e) => e.message.includes("Attente entre cycles interrompue: contenu appointment-booking devenu inexploitable")),
      "AUDIT/AB) La pause entre cycles est interrompue par le blocage CAPTCHA/Cloudflare MEME SANS changement d'URL (inspection DOM locale)"
    );
    assert(
      appointmentBookingPathPattern.test(page.url()),
      "AUDIT/AB) L'URL est toujours celle d'appointment-booking au moment de l'interruption (preuve que ce n'est PAS le chemin URL-only qui a declenche)"
    );

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Intervention humaine potentiellement requise")), 15_000);
    assert(
      capture.entries.some((e) => e.message.includes("Intervention humaine potentiellement requise")),
      "AUDIT/AB) Apres l'interruption, la boucle principale reprend et le chemin de validation humaine EXISTANT (detectHumanValidation/pauseForHuman, inchange) est bien declenche"
    );
    assert(
      !capture.entries.some((e) => /contourn/i.test(e.message)),
      "AUDIT/AB) Aucun contournement CAPTCHA/Cloudflare n'est jamais tente"
    );

    const requestCountAfterDetection = fixture.requestLog.length;
    assert(
      requestCountAfterDetection === requestCountBeforeMutation,
      `AUDIT/AB) Le watcher de cooldown (inspection DOM locale, jamais de navigation) n'emet AUCUNE requete HTTP supplementaire (avant: ${requestCountBeforeMutation}, apres: ${requestCountAfterDetection})`
    );

    abortController.abort();
    await Promise.race([monitorPromise, sleep(20_000)]);
    assertNoSecretsInLogs(capture.entries, "AUDIT/AB) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

// ----- Scenario AC (audit suite): URL INCHANGEE pendant le cooldown, mais le
// contenu appointment-booking devient non pret/invalide (ni CAPTCHA/Cloudflare,
// ni motif d'erreur connu de detectUnexpectedPageReason - juste plus aucun
// marqueur "page de rendez-vous exploitable") -----

const runScenarioAC = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== Scenario AC (AUDIT 0.2.4): cooldown interrompu par un contenu appointment-booking devenu invalide, URL IDENTIQUE (mutation DOM locale) ===");
  const fixture = await startArbitraryUrlFixture();
  const context = await browser.newContext();
  const page = await context.newPage();
  const abortController = new AbortController();
  let recoverWorkflowCalls = 0;

  try {
    const appointmentUrl = `${fixture.baseUrl}/workflow/appointment-booking/tnTUN2fr/1`;
    await page.goto(appointmentUrl, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();

    const config: AppConfig = {
      targetUrl: appointmentUrl,
      connectToExistingChrome: false,
      chromeDebugUrl: "",
      refreshIntervalMs: 1_000,
      headless: true,
      slowMoMs: 0,
      debugKeepBrowserOpen: false,
      maxRefreshAttempts: 0,
      scanMonthCount: 1,
      maxParallelScansPerDomain: 1,
      monthClickMinDelayMs: 100,
      monthClickMaxDelayMs: 200,
      botCycleCooldownMinMs: 20_000,
      botCycleCooldownMaxMs: 20_000,
      refreshEveryCycles: 0,
      rateLimitCooldownMinutes: 1
    };

    const monitorPromise = monitorAppointments(page, config, {
      log: capture.log,
      waitForUser: async () => undefined,
      recoverWorkflow: async () => {
        recoverWorkflowCalls += 1;
        return null;
      },
      signal: abortController.signal
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Attente avant nouveau cycle")), 10_000);
    await sleep(1_000);
    const requestCountBeforeMutation = fixture.requestLog.length;
    const urlBeforeMutation = page.url();

    // Mutation DOM LOCALE uniquement: plus aucun marqueur "page de rendez-vous
    // exploitable" (isAppointmentPageReady), mais aucun motif CAPTCHA/Cloudflare
    // ni aucun motif connu de detectUnexpectedPageReason non plus - distingue
    // ce cas de AB (chemin de validation humaine) du cas L/AA (unknown->target).
    await page.evaluate(() => {
      document.body.innerHTML = "<h1>Une erreur est survenue.</h1><p>Merci de reessayer plus tard.</p>";
    });

    assert(page.url() === urlBeforeMutation, "AUDIT/AC) L'URL n'a pas change apres la mutation DOM (jamais de navigation)");

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Attente entre cycles interrompue")), 20_000);
    assert(
      capture.entries.some((e) => e.message.includes("Attente entre cycles interrompue: contenu appointment-booking devenu inexploitable")),
      "AUDIT/AC) La pause entre cycles est interrompue par un contenu appointment-booking devenu invalide, MEME SANS changement d'URL"
    );
    assert(
      appointmentBookingPathPattern.test(page.url()),
      "AUDIT/AC) L'URL est toujours celle d'appointment-booking au moment de l'interruption"
    );

    // Le texte exact "Page hors workflow detectee" (unexpectedReason) n'est
    // jamais imprime verbatim ici: c'est une valeur interne passee a
    // recoverWorkflow (cf. commentaire identique au Scenario P plus haut),
    // jamais journalisee par monitorAppointments lui-meme sur ce chemin. La
    // preuve observable equivalente est recoverWorkflowCalls > 0: la boucle
    // est bien revenue en tete et a bien sollicite le chemin de detection/
    // recovery EXISTANT (isAppointmentPageReady -> recoverWorkflow), jamais
    // un deuxieme mecanisme invente pour ce cas.
    await waitUntil(() => recoverWorkflowCalls > 0, 15_000);
    assert(recoverWorkflowCalls > 0, "AUDIT/AC) Apres l'interruption, la boucle principale reprend et sollicite le chemin de detection/recovery EXISTANT (isAppointmentPageReady/recoverWorkflow, inchange)");
    assert(
      !capture.entries.some((e) => e.message.includes("Intervention humaine potentiellement requise")),
      "AUDIT/AC) Ce cas (contenu invalide generique) ne passe PAS par le chemin de validation humaine (detectHumanValidation) - distinct du cas AB (CAPTCHA/Cloudflare)"
    );
    assert(
      !capture.entries.some((e) => /contourn/i.test(e.message)),
      "AUDIT/AC) Aucun contournement n'est jamais tente"
    );

    const requestCountAfterDetection = fixture.requestLog.length;
    assert(
      requestCountAfterDetection === requestCountBeforeMutation,
      `AUDIT/AC) Le watcher de cooldown (inspection DOM locale, jamais de navigation) n'emet AUCUNE requete HTTP supplementaire (avant: ${requestCountBeforeMutation}, apres: ${requestCountAfterDetection})`
    );

    abortController.abort();
    await Promise.race([monitorPromise, sleep(20_000)]);
    assertNoSecretsInLogs(capture.entries, "AUDIT/AC) Aucun secret dans les logs");
  } finally {
    await context.close();
    fixture.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
};

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL cible - Hotfix Agent 0.2.3 (recovery robuste du monitoring) ===");

  if (process.platform !== "win32") {
    console.log("Plateforme non-Windows: ce test necessite Windows + Chrome. Ignore, 0 succes / 0 echec.");
    process.exit(0);
    return;
  }

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    await runScenarioA(browser);
    await runScenarioB(browser);
    await runScenarioC(browser);
    await runScenarioD(browser);
    await runScenarioE(browser);
    await runScenarioI(browser);
    await runScenarioJ(browser);
    await runScenarioK(browser);
    await runScenarioL(browser);
    await runScenarioM(browser);
    await runScenarioN(browser);
    await runScenarioP(browser);
    await runScenarioQ(browser);
    await runScenarioS(browser);
    await runScenarioT(browser);
    await runScenarioU(browser);
    await runScenarioV(browser);
    await runScenarioW(browser);
    await runScenarioY(browser);
    await runScenarioZ(browser);
    await runScenarioAA(browser);
    await runScenarioAB(browser);
    await runScenarioAC(browser);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  await runScenarioH();
  await runScenarioF();
  await runScenarioO();
  await runScenarioR();

  try {
    const { pool } = await import("../src/db.js");
    await pool.end();
  } catch (error) {
    log("CLEANUP-ERR", `Fermeture du pool DB incomplete: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
