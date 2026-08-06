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
import { Browser, chromium } from "playwright";
import { Socket, io as ioClient } from "socket.io-client";
import { startMonitoring } from "../src/agent/agentMonitoringRuntime.js";
import { AgentEventReporter } from "../src/agent/agentEventReporter.js";
import { AgentLogLevel } from "../src/agent/agentLocalLogger.js";
import { AgentMonitoringSettings, DEFAULT_AGENT_MONITORING_SETTINGS } from "../src/agent/agentMonitoringSettings.js";

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
  agencyNames: string[]
): Promise<ServerAgentSetup> => {
  const server = await startServer(port, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent", TARGET_URL: targetUrl });
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
    setup = await setupServerAgentAndUi(3361, fixture.baseUrl, "RecoveryF", managerLogins, agencyNames);

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
    assert(emailAttemptCount === 1, `F) Exactement UNE tentative de notification reelle (chemin applicatif complet jusqu'a sendAlertEmail, transport stub via BREVO_API_KEY vide) - jamais de spam (recu: ${emailAttemptCount})`);
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
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  await runScenarioH();
  await runScenarioF();

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
