// CORRECTIF CIBLE - Login/CAPTCHA bloque trop longtemps apres recovery.
//
// Defaut reel confirme: quand la session TLS expire pendant la surveillance
// et que le recovery retombe sur la page login/auth avec un CAPTCHA present,
// waitForRecaptchaResolution() (src/shared/loginFlow.ts) attendait jusqu'a 15
// minutes, ET soumettait quand meme le formulaire apres ce timeout (le
// timeout etait traite comme une fin normale) - un nouveau CAPTCHA
// apparaissait alors immediatement apres la soumission avortee.
//
// Corrige ici (src/shared/loginFlow.ts, src/agent/agentMonitoringRuntime.ts,
// src/notifications.ts):
//   - waitForRecaptchaResolution() retourne desormais un resultat explicite
//     ("resolved"/"timed-out"/"aborted"/"page-changed"), jamais un simple
//     void qui masquait pourquoi l'attente s'est terminee ;
//   - fillLoginForm() ne clique JAMAIS submit si le captcha reste non
//     resolu (regle absolue, quelle que soit la raison de fin d'attente) ;
//   - agentMonitoringRuntime.ts orchestre desormais une strategie bornee:
//     premiere fenetre (3 min) -> UN SEUL reload de la page login/auth ->
//     reclassification reelle -> seconde fenetre (3 min) si toujours "auth"
//     -> WAITING_FOR_USER {reason:"LOGIN_CAPTCHA_STUCK"} si toujours bloquant ;
//   - notifications.ts classe LOGIN_CAPTCHA_STUCK a part de "human-blocked"
//     (jamais la fenetre de grace HUMAN_BLOCK_GRACE_MS supplementaire - la
//     strategie bornee a deja consomme l'attente), toujours soumis au
//     dedoublonnage normal.
//
// AUCUN contournement/solver CAPTCHA: seule la duree/strategie de l'attente
// automatique change, jamais la resolution elle-meme (toujours humaine).
//
// Architecture des scenarios A/B/C/E/F/G: DEUX pages, meme principe que
// Scenario D (test-agent-monitoring-recovery-real.ts) - `page` (surveillee
// par monitorAppointments/detectHumanValidation) reste sur un simple marqueur
// "hors workflow" SANS aucun element captcha, tandis que `loginPage` (un
// second onglet, jamais examine par detectHumanValidation) porte la vraie
// page login/captcha, decouverte par pickWorkflowPage() pendant le recovery.
// Un captcha visible directement sur la page SURVEILLEE serait a tort
// classe comme un blocage Cloudflare/humain generique par monitor.ts
// (detectHumanValidation, mecanisme distinct et deja existant) AVANT meme
// d'atteindre le recovery pilote par etat que ce correctif modifie.
//
// A executer sur un PC Windows personnel avec une session interactive et
// Google Chrome installe - JAMAIS sur la VM/serveur de production.
// Test H necessite une base de donnees de developpement accessible (memes
// variables d'environnement que les autres scripts scripts/test-agent-*.ts).
//
// Usage: npx tsx scripts/test-agent-login-captcha-stuck-real.ts

import http, { Server, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { Browser, chromium, Page } from "playwright";
import { startMonitoring } from "../src/agent/agentMonitoringRuntime.js";
import { AgentEventReporter } from "../src/agent/agentEventReporter.js";
import { AgentMonitoringSettings, DEFAULT_AGENT_MONITORING_SETTINGS } from "../src/agent/agentMonitoringSettings.js";
import { fillLoginForm } from "../src/shared/loginFlow.js";
import { MonitorEventLevel } from "../src/shared/types.js";

const FAKE_LOGIN = "TEST_SECRET_FAKE_LOGIN_CAPTCHASTUCK";
const FAKE_PASSWORD = "TEST_SECRET_FAKE_PASSWORD_CAPTCHASTUCK_123";

// Reference DIRECTE et STABLE vers les console.* d'origine: le TEST H
// (plus bas) remplace temporairement console.log/console.warn pour capturer
// la sortie du logger applicatif (src/logger.ts) - le framework de test
// LUI-MEME (log/assert ci-dessous) doit toujours rester visible, quelle que
// soit cette substitution temporaire.
const REAL_CONSOLE_LOG = console.log.bind(console);
const REAL_CONSOLE_ERROR = console.error.bind(console);

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => REAL_CONSOLE_LOG(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; REAL_CONSOLE_LOG(`[PASS] ${description}`); }
  else { failCount += 1; REAL_CONSOLE_ERROR(`[FAIL] ${description}`); }
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

// Page "hors workflow" generique pour l'onglet SURVEILLE (`page`): aucun
// element captcha/Cloudflare, jamais confondue avec un blocage humain par
// detectHumanValidation (monitor.ts) - seulement "pas la page de rendez-vous".
const NOT_READY_MARKER_HTML = `<!DOCTYPE html><html><body><p>Chargement en cours...</p></body></html>`;

const READY_NO_SLOTS_HTML = `<!DOCTYPE html><html><body>
<div data-testid="fixture-appointment-page">Fixture rendez-vous (test)</div>
<button data-testid="btn-current-month-unavailable" disabled>Mois courant</button>
<button data-testid="btn-next-month-unavailable" disabled>Mois suivant</button>
<p>Nous n'avons actuellement plus de creneaux de rendez-vous disponibles.</p>
</body></html>`;

const SERVICE_LEVEL_HTML = `<!DOCTYPE html><html><body>
<h1>Selectionnez un ou plusieurs services additionnels</h1>
<div class="sticky-bottom-bar" style="position:fixed;left:0;right:0;bottom:0;height:80px;">
  <a id="book-appointment-btn" data-testid="btn-book-appointment" href="/workflow/appointment-booking/tnTUN2fr/1">Continuer</a>
</div>
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

// Formulaire de connexion AVEC captcha visible (meme selecteur qu'isRecaptchaPresent,
// src/shared/loginFlow.ts: iframe[src*="recaptcha"] hors size=invisible) - jamais
// resolu automatiquement par le code sous test, seul ce script de test (le
// "humain" simule) remplit g-recaptcha-response le cas echeant.
const loginWithCaptchaHtml = (formAction: string, redirectAfterMs?: number, redirectTo?: string): string => `<!DOCTYPE html><html><body>
<form id="loginForm" action="${formAction}" method="post">
  <input id="username" type="text" />
  <input id="password" type="password" />
  <iframe src="/fake-recaptcha-frame?size=normal"></iframe>
  <textarea name="g-recaptcha-response" style="display:none;"></textarea>
  <button id="btn-login" type="submit">Se connecter</button>
</form>
${redirectAfterMs && redirectTo ? `<script>setTimeout(function () { location.href = ${JSON.stringify(redirectTo)}; }, ${redirectAfterMs});</script>` : ""}
</body></html>`;

// ===================== Fixture HTTP local =====================

type FixtureSite = {
  server: Server;
  baseUrl: string;
  loginRequestCount: () => number;
  submitHitCount: () => number;
};

// `loginResponder(requestNumber)` decide du HTML servi pour la Ne requete
// vers /fr-fr/login (1-indexe) - permet de simuler un reload qui redonne un
// captcha vierge, ou qui redirige vers une autre etape reconnue.
const startCaptchaFixture = (
  loginResponder: (requestNumber: number, res: ServerResponse) => void
): Promise<FixtureSite> => new Promise((resolve, reject) => {
  let loginRequests = 0;
  let submitHits = 0;

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (url.startsWith("/misc/not-ready")) { res.end(NOT_READY_MARKER_HTML); return; }
    // Toujours prete: seul `loginPage` (jamais `page`) y navigue reellement
    // une fois le parcours login->service-level termine - la detection de
    // succes (recoverCurrentPage/findReadyAppointmentPage) porte sur le
    // CONTENU actuellement charge dans chaque onglet, jamais sur un
    // compteur de requetes.
    if (url.startsWith("/workflow/appointment-booking/")) { res.end(READY_NO_SLOTS_HTML); return; }
    if (url.startsWith("/fr-fr/login")) {
      loginRequests += 1;
      loginResponder(loginRequests, res);
      return;
    }
    if (url.startsWith("/fake-recaptcha-frame")) { res.end("<!DOCTYPE html><html><body>fake</body></html>"); return; }
    if (url.startsWith("/workflow/service-level")) {
      submitHits += 1;
      res.end(SERVICE_LEVEL_HTML);
      return;
    }
    if (url.startsWith("/fr-fr/travel-groups")) { res.end(TRAVEL_GROUPS_HTML); return; }
    if (url.startsWith("/workflow/application-summary")) { res.end(APPLICATION_SUMMARY_HTML); return; }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({
      server,
      baseUrl: `http://127.0.0.1:${address.port}`,
      loginRequestCount: () => loginRequests,
      submitHitCount: () => submitHits
    });
  });
});

const closeFixture = async (fixture: FixtureSite): Promise<void> => {
  fixture.server.closeAllConnections?.();
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
};

const resolveCaptchaOn = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const field = document.querySelector('textarea[name="g-recaptcha-response"]') as HTMLTextAreaElement | null;
    if (field) field.value = "fake-resolved-token-test-only";
  });
};

// ===================== Capture de logs =====================

type CapturedLog = { level: MonitorEventLevel; message: string; atMs: number };
const makeLogCapture = (): { entries: CapturedLog[]; log: (level: MonitorEventLevel, message: string) => void } => {
  const startedAt = Date.now();
  const entries: CapturedLog[] = [];
  return { entries, log: (level, message) => entries.push({ level, message, atMs: Date.now() - startedAt }) };
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

const FORBIDDEN_LOG_SUBSTRINGS = [FAKE_LOGIN.toLowerCase(), FAKE_PASSWORD.toLowerCase(), "password=", "cookie:", "authorization:"];
const assertNoSecretsInLogs = (entries: CapturedLog[], description: string): void => {
  const offending = entries.filter((entry) => FORBIDDEN_LOG_SUBSTRINGS.some((needle) => entry.message.toLowerCase().includes(needle)));
  assert(offending.length === 0, `${description} (recu: ${offending.length} ligne(s) suspecte(s))`);
};

const FAST_SETTINGS: AgentMonitoringSettings = {
  ...DEFAULT_AGENT_MONITORING_SETTINGS,
  botCycleCooldownMinMs: 300,
  botCycleCooldownMaxMs: 500,
  monthClickMinDelayMs: 50,
  monthClickMaxDelayMs: 100,
  refreshEveryCycles: 0
};

// ===================== TEST A: captcha resolu avant la premiere fenetre =====================

const runTestA = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== TEST A: CAPTCHA resolu avant l'expiration de la premiere fenetre -> aucun reload, workflow continue ===");
  const fixture = await startCaptchaFixture((_n, res) => res.end(loginWithCaptchaHtml("/workflow/service-level")));
  const context = await browser.newContext();
  const page = await context.newPage();
  const loginPage = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/misc/not-ready`, { waitUntil: "domcontentloaded" });
    await loginPage.goto(`${fixture.baseUrl}/fr-fr/login`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-captcha-a",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/never-used-marker`,
      commandId: "cmd-captcha-a",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      loginCaptchaFirstWaitMs: 8_000,
      loginCaptchaSecondWaitMs: 8_000,
      isBotStillRegistered: () => true,
      runtimeCredentials: { login: FAKE_LOGIN, password: FAKE_PASSWORD }
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Captcha bloquant detecte")), 10_000);
    await resolveCaptchaOn(loginPage);

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 20_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(
      capture.entries.some((e) => /Captcha resolu apres \d+s\. Reprise de la connexion\./.test(e.message)),
      "A) Le captcha resolu est bien detecte et journalise avec la duree ecoulee"
    );
    assert(fixture.loginRequestCount() === 1, `A) Aucun reload de la page login (une seule requete) (recu: ${fixture.loginRequestCount()})`);
    assert(fixture.submitHitCount() === 1, `A) Le formulaire est soumis exactement une fois, apres resolution (recu: ${fixture.submitHitCount()})`);
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")),
      "A) Le workflow continue et aboutit a appointment-booking"
    );
    assert(statuses.every((s) => s.status !== "WAITING_FOR_USER"), "A) Aucun WAITING_FOR_USER (ni LOGIN_CAPTCHA_STUCK ni autre)");
    assertNoSecretsInLogs(capture.entries, "A) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== TEST B: captcha toujours present apres la 1ere fenetre, resolu pendant la 2e =====================

const runTestB = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== TEST B: CAPTCHA toujours present apres la 1ere fenetre -> UN reload -> resolu pendant la 2e fenetre ===");
  // Chaque requete vers /fr-fr/login (initiale + reload) sert un captcha
  // vierge - reproduit fidelement un reload reel (jeton jamais conserve).
  const fixture = await startCaptchaFixture((_n, res) => res.end(loginWithCaptchaHtml("/workflow/service-level")));
  const context = await browser.newContext();
  const page = await context.newPage();
  const loginPage = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/misc/not-ready`, { waitUntil: "domcontentloaded" });
    await loginPage.goto(`${fixture.baseUrl}/fr-fr/login`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-captcha-b",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/never-used-marker`,
      commandId: "cmd-captcha-b",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      loginCaptchaFirstWaitMs: 800,
      loginCaptchaSecondWaitMs: 8_000,
      isBotStillRegistered: () => true,
      runtimeCredentials: { login: FAKE_LOGIN, password: FAKE_PASSWORD }
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Refresh unique de la page de connexion")), 10_000);
    // Attend la SECONDE fenetre (apres le reload) avant de resoudre - jamais
    // avant, sinon on prouverait seulement le chemin du TEST A. Le reload
    // remplace le CONTENU de `loginPage` (meme onglet, meme page.reload()).
    await waitUntil(
      () => capture.entries.filter((e) => e.message.includes("Captcha bloquant detecte")).length >= 2,
      10_000
    );
    await resolveCaptchaOn(loginPage);

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 20_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(fixture.loginRequestCount() === 2, `B) Exactement UN reload de la page login (2 requetes: initiale + reload) (recu: ${fixture.loginRequestCount()})`);
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")),
      "B) La connexion reprend et le workflow aboutit apres resolution pendant la 2e fenetre"
    );
    assert(statuses.every((s) => s.status !== "WAITING_FOR_USER"), "B) Aucun WAITING_FOR_USER (donc aucun email final)");
    assertNoSecretsInLogs(capture.entries, "B) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== TEST C: captcha bloquant pendant les deux fenetres =====================

const runTestC = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== TEST C: CAPTCHA bloquant pendant les DEUX fenetres -> UN reload, jamais de submit, WAITING_FOR_USER (LOGIN_CAPTCHA_STUCK) ===");
  const fixture = await startCaptchaFixture((_n, res) => res.end(loginWithCaptchaHtml("/workflow/service-level")));
  const context = await browser.newContext();
  const page = await context.newPage();
  const loginPage = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/misc/not-ready`, { waitUntil: "domcontentloaded" });
    await loginPage.goto(`${fixture.baseUrl}/fr-fr/login`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-captcha-c",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/never-used-marker`,
      commandId: "cmd-captcha-c",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      loginCaptchaFirstWaitMs: 700,
      loginCaptchaSecondWaitMs: 700,
      isBotStillRegistered: () => true,
      runtimeCredentials: { login: FAKE_LOGIN, password: FAKE_PASSWORD }
    });

    await waitUntil(
      () => statuses.some((s) => s.status === "WAITING_FOR_USER"),
      15_000
    );
    handle.abortController.abort();
    await handle.loopPromise;

    assert(fixture.loginRequestCount() === 2, `C) Exactement UN reload de la page login (2 requetes: initiale + reload, jamais une boucle) (recu: ${fixture.loginRequestCount()})`);
    assert(fixture.submitHitCount() === 0, `C) Le formulaire n'est JAMAIS soumis tant que le captcha reste non resolu (recu: ${fixture.submitHitCount()} soumission(s))`);
    assert(
      statuses.some((s) => s.status === "WAITING_FOR_USER" && (s.details as { reason?: string } | undefined)?.reason === "LOGIN_CAPTCHA_STUCK"),
      "C) Le bot passe en WAITING_FOR_USER avec la raison specifique LOGIN_CAPTCHA_STUCK"
    );
    assert(
      statuses.filter((s) => s.status === "WAITING_FOR_USER").length === 1,
      `C) Exactement UNE emission WAITING_FOR_USER (recu: ${statuses.filter((s) => s.status === "WAITING_FOR_USER").length})`
    );
    assert(!loginPage.isClosed(), "C) Le Chrome/la page reste ouvert (jamais ferme)");
    assert(
      capture.entries.some((e) => e.message.includes("Intervention utilisateur requise (LOGIN_CAPTCHA_STUCK)")),
      "C) L'echec final est journalise localement de maniere exploitable"
    );
    assertNoSecretsInLogs(capture.entries, "C) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== TEST D: bug de regression - jamais de submit apres timeout (fillLoginForm direct) =====================
//
// Test UNITAIRE direct de fillLoginForm() (jamais via tout l'appareil de
// recovery): reproduit precisement l'ancien defaut ("le timeout est traite
// comme une fin normale, le clic submit part quand meme"). Ce test doit
// echouer sur l'ancien comportement (submitted: true malgre le captcha non
// resolu).

const runTestD = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== TEST D (regression): fillLoginForm() direct, captcha jamais resolu -> submit JAMAIS clique ===");
  const fixture = await startCaptchaFixture((_n, res) => res.end(loginWithCaptchaHtml("/workflow/service-level")));
  const context = await browser.newContext();
  const page = await context.newPage();
  const entries: CapturedLog[] = [];
  const logFn = (level: MonitorEventLevel, message: string): void => { entries.push({ level, message, atMs: 0 }); };

  try {
    await page.goto(`${fixture.baseUrl}/fr-fr/login`, { waitUntil: "domcontentloaded" });

    const result = await fillLoginForm(page, FAKE_LOGIN, FAKE_PASSWORD, logFn, { maxCaptchaWaitMs: 500 });

    assert(result.submitted === false, `D) fillLoginForm() rapporte explicitement submitted=false quand le captcha n'est jamais resolu (recu: ${result.submitted})`);
    assert(result.captchaOutcome === "timed-out", `D) captchaOutcome vaut explicitement 'timed-out' (jamais confondu avec un succes silencieux) (recu: ${result.captchaOutcome})`);
    assert(fixture.submitHitCount() === 0, `D) Le bouton submit n'est JAMAIS clique (aucune requete vers l'action du formulaire) (recu: ${fixture.submitHitCount()})`);
    assert(
      await page.locator('textarea[name="g-recaptcha-response"]').inputValue().then((v) => v === "").catch(() => true),
      "D) Le captcha n'a jamais ete resolu/contourne par le code lui-meme"
    );
    assertNoSecretsInLogs(entries, "D) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== TEST E: progression pendant la premiere fenetre =====================

const runTestE = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== TEST E: la page progresse vers travel-groups PENDANT la premiere fenetre -> attente interrompue, aucun reload ===");
  // La page login elle-meme se navigue (jamais un clic du code sous test)
  // vers /fr-fr/travel-groups apres 800ms - simule une progression reelle
  // du workflow survenue autrement pendant l'attente captcha.
  const fixture = await startCaptchaFixture((_n, res) => res.end(loginWithCaptchaHtml("/workflow/service-level", 800, "/fr-fr/travel-groups")));
  const context = await browser.newContext();
  const page = await context.newPage();
  const loginPage = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/misc/not-ready`, { waitUntil: "domcontentloaded" });
    await loginPage.goto(`${fixture.baseUrl}/fr-fr/login`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-captcha-e",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/never-used-marker`,
      commandId: "cmd-captcha-e",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      // Fenetre volontairement longue: la progression (800ms) doit
      // survenir tres largement AVANT toute expiration de fenetre.
      loginCaptchaFirstWaitMs: 8_000,
      loginCaptchaSecondWaitMs: 8_000,
      isBotStillRegistered: () => true,
      runtimeCredentials: { login: FAKE_LOGIN, password: FAKE_PASSWORD }
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 20_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(fixture.loginRequestCount() === 1, `E) Aucun reload de la page login (une seule requete) (recu: ${fixture.loginRequestCount()})`);
    assert(!capture.entries.some((e) => e.message.includes("Refresh unique de la page de connexion")), "E) Aucun reload declenche (la progression a deja interrompu l'attente)");
    assert(
      capture.entries.some((e) => e.message.includes("etat detecte = travel-groups")),
      "E) L'etat travel-groups est correctement classifie apres la progression"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")),
      "E) Le workflow normal reprend et aboutit"
    );
    assert(statuses.every((s) => s.status !== "WAITING_FOR_USER"), "E) Aucun WAITING_FOR_USER");
    assertNoSecretsInLogs(capture.entries, "E) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== TEST F: progression apres le reload (jamais de 2e fenetre inutile) =====================

const runTestF = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== TEST F: apres le reload unique, TLS redirige directement vers service-level -> jamais de 2e fenetre captcha inutile ===");
  const fixture = await startCaptchaFixture((requestNumber, res) => {
    if (requestNumber === 1) {
      // 1ere requete (page initiale): captcha jamais resolu, force
      // l'expiration de la 1ere fenetre.
      res.end(loginWithCaptchaHtml("/workflow/service-level"));
      return;
    }
    // 2e requete (le reload declenche par le correctif): TLS redirige
    // directement vers une etape plus avancee (session en realite valide).
    res.statusCode = 302;
    res.setHeader("Location", "/workflow/service-level");
    res.end();
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const loginPage = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/misc/not-ready`, { waitUntil: "domcontentloaded" });
    await loginPage.goto(`${fixture.baseUrl}/fr-fr/login`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-captcha-f",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/never-used-marker`,
      commandId: "cmd-captcha-f",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      loginCaptchaFirstWaitMs: 700,
      loginCaptchaSecondWaitMs: 8_000,
      isBotStillRegistered: () => true,
      runtimeCredentials: { login: FAKE_LOGIN, password: FAKE_PASSWORD }
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")), 20_000);
    handle.abortController.abort();
    await handle.loopPromise;

    assert(fixture.loginRequestCount() === 2, `F) Exactement UN reload de la page login (recu: ${fixture.loginRequestCount()})`);
    const captchaDetectedCount = capture.entries.filter((e) => e.message.includes("Captcha bloquant detecte")).length;
    assert(captchaDetectedCount === 1, `F) Une seule fenetre d'attente captcha demarree (jamais une 2e inutile apres progression) (recu: ${captchaDetectedCount})`);
    assert(
      capture.entries.some((e) => e.message.includes("etat detecte = service-level")),
      "F) L'etat service-level (apres reload) est correctement classifie"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Page de rendez-vous retrouvee automatiquement")),
      "F) Le workflow reprend et aboutit apres le reload"
    );
    assert(statuses.every((s) => s.status !== "WAITING_FOR_USER"), "F) Aucun WAITING_FOR_USER");
    assertNoSecretsInLogs(capture.entries, "F) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== TEST G: STOP_BOT pendant l'attente captcha =====================

const runTestG = async (browser: Browser): Promise<void> => {
  log("BOOT", "=== TEST G: STOP_BOT pendant la 1ere fenetre captcha -> arret immediat, aucun reload, aucun LOGIN_CAPTCHA_STUCK ===");
  const fixture = await startCaptchaFixture((_n, res) => res.end(loginWithCaptchaHtml("/workflow/service-level")));
  const context = await browser.newContext();
  const page = await context.newPage();
  const loginPage = await context.newPage();

  try {
    await page.goto(`${fixture.baseUrl}/misc/not-ready`, { waitUntil: "domcontentloaded" });
    await loginPage.goto(`${fixture.baseUrl}/fr-fr/login`, { waitUntil: "domcontentloaded" });
    const capture = makeLogCapture();
    const { reporter, statuses } = makeFakeReporter();

    const handle = startMonitoring({
      botId: "bot-captcha-g",
      page,
      context,
      settings: FAST_SETTINGS,
      targetUrl: `${fixture.baseUrl}/never-used-marker`,
      commandId: "cmd-captcha-g",
      reporter,
      log: capture.log,
      workflowRecoveryRetryIntervalMs: 500,
      workflowRecoveryLongWaitMs: 1_000,
      // Fenetre volontairement longue: l'abort doit interrompre BIEN avant
      // toute expiration naturelle.
      loginCaptchaFirstWaitMs: 8_000,
      loginCaptchaSecondWaitMs: 8_000,
      isBotStillRegistered: () => true,
      runtimeCredentials: { login: FAKE_LOGIN, password: FAKE_PASSWORD }
    });

    await waitUntil(() => capture.entries.some((e) => e.message.includes("Captcha bloquant detecte")), 10_000);

    const abortedAt = Date.now();
    handle.abortController.abort();
    await handle.loopPromise;
    const stopDurationMs = Date.now() - abortedAt;

    assert(stopDurationMs < 3_000, `G) L'arret (STOP_BOT) est immediat, jamais bloque par l'attente captcha restante (recu: ${stopDurationMs}ms)`);
    assert(fixture.loginRequestCount() === 1, `G) Aucun reload declenche apres l'arret (recu: ${fixture.loginRequestCount()})`);
    assert(fixture.submitHitCount() === 0, "G) Aucune soumission apres l'arret");
    // Assertion alignee precisement sur la consigne (STOP_BOT: "aucun
    // LOGIN_CAPTCHA_STUCK", pas "aucun WAITING_FOR_USER" generique) - un
    // abort pendant un recovery deja en cours peut, comme pour tout autre
    // etat (Cloudflare, unknown...), aboutir a WORKFLOW_RECOVERY_FAILED cote
    // monitor.ts (comportement general pre-existant, hors perimetre de ce
    // correctif captcha). Seule l'ABSENCE de LOGIN_CAPTCHA_STUCK est garantie
    // ici: aucune notification tardive specifique au captcha apres l'arret.
    assert(
      !statuses.some((s) => (s.details as { reason?: string } | undefined)?.reason === "LOGIN_CAPTCHA_STUCK"),
      "G) Aucun LOGIN_CAPTCHA_STUCK declenche par l'arret (aucune notification tardive specifique au captcha)"
    );
    assertNoSecretsInLogs(capture.entries, "G) Aucun secret dans les logs");
  } finally {
    await context.close();
    await closeFixture(fixture);
  }
};

// ===================== TEST H: notification LOGIN_CAPTCHA_STUCK - immediatement eligible, dedup actif =====================
//
// Test DIRECT de src/notifications.ts (jamais un vrai envoi Brevo/SMTP: meme
// technique deterministe que les autres scripts de ce projet - transport
// primaire force sur brevo, BREVO_API_KEY vide -> sendAlertEmail journalise
// "Envoi email ignore (BREVO_API_KEY manquant)" sans jamais faire de vraie
// requete reseau). Necessite une base de donnees de developpement (un seul
// utilisateur jetable est cree puis supprime, jamais de spawn agent/serveur).

const RUN_SUFFIX_H = Date.now();

const runTestH = async (): Promise<void> => {
  log("BOOT", "=== TEST H: notifyUserIfNeeded(LOGIN_CAPTCHA_STUCK) - immediatement eligible (jamais de grace de 4 min), dedup actif ===");

  // Jamais un vrai envoi SMTP/Brevo dans ce test automatise (meme technique
  // que les scenarios existants de test-agent-monitoring-recovery-real.ts).
  process.env.EMAIL_PRIMARY_TRANSPORT = "brevo";
  process.env.EMAIL_FALLBACK_TRANSPORT = "";
  process.env.BREVO_API_KEY = "";
  process.env.SMTP_HOST = "";
  process.env.SMTP_USER = "";
  process.env.SMTP_PASSWORD = "";

  const { pool } = await import("../src/db.js");
  const { hashPassword } = await import("../src/password.js");
  const { classifyNotification, notifyUserIfNeeded } = await import("../src/notifications.js");

  const suffix = RUN_SUFFIX_H;
  const login = `test-logincaptcha-${suffix}`;
  const email = `${login}@example.test`;
  let userId: number | null = null;

  // Capture UNIQUEMENT le logger applicatif (src/logger.ts, qui ecrit via
  // console.log/console.warn) - jamais le framework de test ci-dessus (qui
  // utilise REAL_CONSOLE_LOG/REAL_CONSOLE_ERROR, references figees avant
  // cette substitution et donc jamais affectees par elle).
  const consoleLogs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => { consoleLogs.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { consoleLogs.push(args.map(String).join(" ")); };

  try {
    const inserted = await pool.query<{ id: number }>(
      `INSERT INTO users (agency_id, login, password_hash, name, email, role, is_active)
       VALUES (NULL, $1, $2, 'Test LoginCaptchaStuck', $3, 1, TRUE) RETURNING id`,
      [login, await hashPassword("Test-LoginCaptcha-P@ss1"), email]
    );
    userId = inserted.rows[0].id;

    // ----- Classification: distincte de "human-blocked" generique -----
    const genericCaptchaCategory = classifyNotification("Captcha bloquant detecte sur la page de connexion. Attente de resolution humaine (jusqu'a 180s).");
    assert(genericCaptchaCategory === "human-blocked", `H) Un log captcha generique (mi-surveillance) reste classe "human-blocked" (soumis a la grace normale) (recu: ${genericCaptchaCategory})`);

    const stuckCategory = classifyNotification('[Agent] Statut du bot: WAITING_FOR_USER {"reason":"LOGIN_CAPTCHA_STUCK"}');
    assert(stuckCategory === "login-captcha-stuck", `H) Le statut final LOGIN_CAPTCHA_STUCK est classe distinctement (jamais "human-blocked") (recu: ${stuckCategory})`);

    // ----- Immediatement eligible: aucune grace HUMAN_BLOCK_GRACE_MS supplementaire -----
    const sessionId = `session-login-captcha-stuck-${suffix}`;
    const message = `[Agent] Statut du bot: WAITING_FOR_USER {"reason":"LOGIN_CAPTCHA_STUCK"}`;

    consoleLogs.length = 0;
    await notifyUserIfNeeded({ userId, level: "error", message, sessionId, botName: "Bot Test LoginCaptchaStuck" });

    const emailAttempt = consoleLogs.filter((l) => l.includes("Envoi email ignore (BREVO_API_KEY manquant)") && l.includes("CAPTCHA en attente"));
    assert(
      emailAttempt.length === 1,
      `H) La notification LOGIN_CAPTCHA_STUCK declenche IMMEDIATEMENT une tentative d'envoi (jamais de grace de 4 min supplementaire, deja consommee cote agent) (recu: ${emailAttempt.length})`
    );
    assert(
      !consoleLogs.some((l) => l.includes("aucune adresse")),
      "H) La notification est bien envoyee au proprietaire correct (email resolu avec succes pour cet userId)"
    );

    // ----- Dedup normal toujours actif: meme evenement rejoue immediatement -----
    consoleLogs.length = 0;
    await notifyUserIfNeeded({ userId, level: "error", message, sessionId, botName: "Bot Test LoginCaptchaStuck" });
    const secondAttempt = consoleLogs.filter((l) => l.includes("Envoi email ignore (BREVO_API_KEY manquant)"));
    assert(secondAttempt.length === 0, `H) Le dedoublonnage normal (DEDUPE_MS) empeche un second envoi immediat pour le meme evenement (recu: ${secondAttempt.length})`);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    if (userId !== null) {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => undefined);
    }
  }
};

// ===================== main =====================

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL cible - Login/CAPTCHA bloque trop longtemps apres recovery ===");

  if (process.platform !== "win32") {
    REAL_CONSOLE_LOG("Plateforme non-Windows: ce test necessite Windows + Chrome. Ignore, 0 succes / 0 echec.");
    process.exit(0);
    return;
  }

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    await runTestA(browser);
    await runTestB(browser);
    await runTestC(browser);
    await runTestD(browser);
    await runTestE(browser);
    await runTestF(browser);
    await runTestG(browser);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  try {
    await runTestH();
  } catch (error) {
    failCount += 1;
    REAL_CONSOLE_ERROR(`[FAIL] Test H a leve une exception (base de donnees de developpement accessible ?): ${error instanceof Error ? error.message : String(error)}`);
  }

  REAL_CONSOLE_LOG(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  REAL_CONSOLE_ERROR("[FATAL]", error);
  process.exitCode = 1;
});
