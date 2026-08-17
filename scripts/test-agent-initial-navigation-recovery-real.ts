// Test REEL cible - Recuperation de navigation INITIALE (AgentBotManager.
// runAutoNavigation) lorsque Chrome se retrouve sur une page inconnue/externe
// AVANT que beginMonitoring() ait demarre.
//
// Contexte du correctif: le recovery du MONITORING (agentMonitoringRuntime.ts,
// navigateToRecoveryTargetUrl/classifyRecoveryState) fonctionnait deja - ce
// correctif porte UNIQUEMENT sur runAutoNavigation(), avant beginMonitoring().
// Auparavant, une page non reconnue (etat "H" dans dispatchOnState, ou un
// echec de clickSeConnecter en etat "F" - meme symptome: cette page n'est en
// realite ni une etape TLS connue ni une vraie page d'accueil) consommait
// simplement des tentatives sans jamais revenir vers l'URL TLS de depart
// (handle.recoveryTargetUrl, deja validee - jamais page.url(), jamais une URL
// reconstruite). Desormais, au plus UNE recuperation (goto vers cette URL
// UNIQUEMENT) par TENTATIVE globale (meme budget que AUTO_NAV_FINAL_ATTEMPT,
// jamais un compteur independant) est tentee avant d'abandonner la tentative.
//
// Utilise le meme harnais "leger" que scripts/test-agent-service-level-hotfix-
// real.ts (Partie B): instanciation directe d'AgentBotManager (vrai Chrome
// pilote via CDP, sans serveur/socket/UI) - plus rapide et deterministe que le
// harnais complet pour tester precisement runAutoNavigation().
//
// A executer sur un PC Windows personnel avec une session interactive et
// Google Chrome installe - JAMAIS sur la VM/serveur de production.
//
// Usage: npx tsx scripts/test-agent-initial-navigation-recovery-real.ts
//    ou: npm run test:agent:initial-navigation-recovery:real

import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http, { Server } from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";
import { AgentBotManager } from "../src/agent/agentBotManager.js";
import { AgentEventReporter } from "../src/agent/agentEventReporter.js";
import { AgentLogLevel } from "../src/agent/agentLocalLogger.js";
import { AgentRuntimeSettings } from "../src/agent/types.js";

const FAKE_LOGIN = "TEST_SECRET_FAKE_LOGIN_INITNAV";
const FAKE_PASSWORD = "TEST_SECRET_FAKE_PASSWORD_INITNAV_123";

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
const requireWithin = async (predicate: () => Promise<boolean> | boolean, timeoutMs: number, description: string): Promise<void> => {
  if (!(await waitUntil(predicate, timeoutMs))) throw new Error(`TimeoutError: ${description}`);
};

// ===================== Harnais leger (memes conventions que test-agent-service-level-hotfix-real.ts, Partie B) =====================

const makeFakeReporter = (): { reporter: AgentEventReporter; botStatuses: Array<{ botId: string; status: string }> } => {
  const botStatuses: Array<{ botId: string; status: string }> = [];
  const reporter: AgentEventReporter = {
    ack: () => undefined,
    completed: () => undefined,
    failed: () => undefined,
    botStatus: (botId, _commandId, status) => { botStatuses.push({ botId, status }); }
  };
  return { reporter, botStatuses };
};

type CapturedLog = { level: AgentLogLevel; message: string };
const makeLogCapture = (): { entries: CapturedLog[]; log: (level: AgentLogLevel, message: string) => void } => {
  const entries: CapturedLog[] = [];
  return { entries, log: (level, message) => entries.push({ level, message }) };
};
const countLogs = (entries: CapturedLog[], needle: string): number => entries.filter((e) => e.message.includes(needle)).length;
const hasLog = (entries: CapturedLog[], needle: string): boolean => countLogs(entries, needle) > 0;

const FORBIDDEN_LOG_SUBSTRINGS = ["password", "login=", "cookie:", "authorization:", "token="];
const assertNoSecretsInLogs = (entries: CapturedLog[], description: string): void => {
  const offending = entries.filter((entry) => FORBIDDEN_LOG_SUBSTRINGS.some((needle) => entry.message.toLowerCase().includes(needle)));
  assert(offending.length === 0, `${description} (recu: ${offending.length} ligne(s) suspecte(s))`);
};

const RUN_SUFFIX = Date.now();
const dataRoots: string[] = [];
const makeSettings = (label: string, overrides: Partial<AgentRuntimeSettings> = {}): AgentRuntimeSettings => {
  const dataRoot = path.resolve(`.test-initnav-recovery-${label}-${RUN_SUFFIX}`);
  dataRoots.push(dataRoot);
  return {
    serverUrl: "http://localhost:0",
    credentialsPath: path.join(dataRoot, "credentials", "agent-credentials.json"),
    computerName: `TEST-INITNAV-${label}`,
    version: "0.0.0",
    protocolVersion: 1,
    runtimeMode: "test",
    targetMode: "fixture",
    fixtureUrl: "about:blank",
    targetUrl: "about:blank",
    maxActiveBots: 5,
    dataRoot,
    reconnectMinDelayMs: 1_000,
    reconnectMaxDelayMs: 30_000,
    reconnectJitterRatio: 0.2,
    offlineEventBufferMax: 500,
    logMaxFileSizeMb: 5,
    logMaxFiles: 5,
    logLevel: "info",
    // Cadence acceleree pour ce test uniquement (meme convention que les
    // autres tests reels de ce depot) - jamais les delais de production.
    autoNavRetryIntervalMs: 500,
    autoNavLongWaitMs: 1_000,
    ...overrides
  };
};

const removeDataRootsWithRetry = async (): Promise<void> => {
  for (const dataRoot of dataRoots) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try { rmSync(dataRoot, { recursive: true, force: true }); break; } catch { if (attempt < 5) await sleep(300); }
    }
  }
};

type FixtureSite = { server: Server; baseUrl: string; requestLog: string[] };
const startFixtureSite = (handler: (url: string, req: http.IncomingMessage, res: http.ServerResponse, requestLog: string[]) => void): Promise<FixtureSite> =>
  new Promise((resolve, reject) => {
    const requestLog: string[] = [];
    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      requestLog.push(url);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      handler(url, req, res, requestLog);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, requestLog });
    });
  });

// ===================== Fragments HTML reutilisables =====================

// Page d'accueil TLS reelle: lien "Se connecter" reconnu par clickSeConnecter().
const REAL_HOME_HTML = `<!DOCTYPE html><html><body>
<a href="/fr-fr/login"><div id="login">SE CONNECTER</div></a>
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
// Page totalement etrangere au parcours TLS: aucun element que clickSeConnecter()
// puisse trouver (ni lien direct, ni menu deroulant), aucun mot-cle TLS.
const EXTERNAL_LOOKALIKE_HTML = `<!DOCTYPE html><html><head><title>Example Domain</title></head><body>
<h1>Example Domain</h1><p>This domain is for use in illustrative examples (test uniquement).</p>
</body></html>`;

// ===================== Scenario A + J: page externe (autre origine) au tout debut =====================
// Simule une page restauree/externe au demarrage: la toute premiere requete
// vers l'URL TLS de depart redirige vers un site COMPLETEMENT DIFFERENT
// (autre serveur HTTP, autre origine) - les requetes suivantes servent la
// vraie page d'accueil. ASSERT (test A): aucun clic sur la page externe,
// retour vers safeRecoveryUrl (jamais une reconstruction depuis la page
// externe), reprise du parcours, appointment atteint, MONITORING.
// ASSERT (test J): la SEULE destination de goto creee par la recuperation est
// bien startUrl (jamais la page externe) - verifie ici en comptant les
// requetes recues par le site externe (doit rester a 1: seulement le premier
// hit du a la redirection, jamais une navigation supplementaire dedans).
const runExternalPageScenario = async (): Promise<void> => {
  log("SCENARIO-A-J", "=== Page externe (autre origine) au demarrage: recuperation vers startUrl uniquement ===");
  let externalSite: FixtureSite | undefined;
  let tlsSite: FixtureSite | undefined;
  let manager: AgentBotManager | undefined;

  try {
    externalSite = await startFixtureSite((_url, _req, res) => res.end(EXTERNAL_LOOKALIKE_HTML));

    let homeRequestCount = 0;
    tlsSite = await startFixtureSite((url, _req, res) => {
      if (url === "/" || url === "") {
        homeRequestCount += 1;
        if (homeRequestCount === 1) {
          res.statusCode = 302;
          res.setHeader("Location", externalSite!.baseUrl);
          res.end();
          return;
        }
        res.end(REAL_HOME_HTML);
        return;
      }
      if (url.startsWith("/fr-fr/login")) { res.end(LOGIN_HTML); return; }
      if (url.startsWith("/appointment-booking")) { res.end(APPOINTMENT_HTML); return; }
      res.statusCode = 404;
      res.end("Not found (fixture).");
    });

    const settings = makeSettings("extpage");
    const { reporter, botStatuses } = makeFakeReporter();
    const capture = makeLogCapture();
    manager = new AgentBotManager(settings, capture.log, reporter);
    const botId = `bot-extpage-${RUN_SUFFIX}`;

    await manager.startBot({
      commandId: `cmd-${botId}`,
      botId,
      botName: botId,
      login: FAKE_LOGIN,
      password: FAKE_PASSWORD,
      rawMonitoringSettings: undefined,
      startUrl: tlsSite.baseUrl
    });

    await requireWithin(
      () => botStatuses.some((s) => s.botId === botId && s.status === "MONITORING"),
      45_000,
      "A) Le bot n'a jamais atteint MONITORING apres etre parti d'une page externe"
    );
    assert(true, "A) appointment-booking/MONITORING atteint apres depart sur une page externe");

    assert(
      hasLog(capture.entries, "Page non confirmee comme contexte d'accueil TLS sur"),
      "A) La page externe n'est jamais confondue avec la page d'accueil - clickSeConnecter() non tente dessus"
    );
    assert(
      !hasLog(capture.entries, "clickSeConnecter() execute avec succes") || countLogs(capture.entries, "clickSeConnecter() execute avec succes") === 1,
      "A) clickSeConnecter() n'est jamais invoque sur la page externe (au plus 1 succes, sur la VRAIE page d'accueil apres recuperation)"
    );
    assert(
      hasLog(capture.entries, "Retour vers l'URL TLS de depart effectue"),
      "A) La recuperation a bien navigue vers l'URL TLS de depart (safeRecoveryUrl)"
    );
    assert(
      countLogs(capture.entries, "Retour vers l'URL TLS de depart effectue") === 1,
      `A) Une seule recuperation reussie a ete necessaire (recu: ${countLogs(capture.entries, "Retour vers l'URL TLS de depart effectue")})`
    );

    // ----- Test J: la SEULE destination de goto creee par CE HOTFIX (F et H)
    // est startUrl, jamais la page externe - verifie au niveau des
    // NAVIGATIONS PRODUITES (pas seulement des logs). Le site externe ne doit
    // recevoir QUE le hit initial de la redirection (jamais une requete
    // supplementaire, en particulier jamais "/fr-fr/login": clickSeConnecter()/
    // navigateToLogin() n'est plus jamais invoque sur une page dont l'origine
    // ne correspond pas a handle.recoveryTargetUrl).
    const realExternalRequests = externalSite.requestLog.filter((u) => u !== "/favicon.ico");
    assert(
      realExternalRequests.length === 1 && realExternalRequests[0] === "/",
      `J) Le site externe ne recoit strictement AUCUNE requete au-dela du hit initial de la redirection (recu hors favicon: ${JSON.stringify(realExternalRequests)})`
    );
    assert(
      !externalSite.requestLog.some((u) => u.startsWith("/fr-fr/login")),
      "J) Aucun goto vers .../fr-fr/login n'est jamais tente sur l'origine externe"
    );
    const recoveryLogLinesJ = capture.entries.filter((e) => e.message.includes("Retour vers l'URL TLS de depart"));
    assert(recoveryLogLinesJ.length > 0, "J) Au moins un log de recuperation est present");
    assert(
      recoveryLogLinesJ.every((e) => !e.message.includes(new URL(externalSite!.baseUrl).port)),
      "J) La recuperation elle-meme ne cible jamais l'origine du site externe (uniquement l'URL TLS de depart deja validee)"
    );

    assertNoSecretsInLogs(capture.entries, "A/J) Aucun secret dans les logs");
  } finally {
    if (manager) { try { await manager.stopBot({ commandId: "cmd-cleanup", botId: `bot-extpage-${RUN_SUFFIX}` }); } catch { /* best effort */ } }
    if (tlsSite) await new Promise<void>((resolve) => tlsSite!.server.close(() => resolve()));
    if (externalSite) await new Promise<void>((resolve) => externalSite!.server.close(() => resolve()));
  }
};

// ===================== Scenario B: URL TLS inconnue (meme origine, aucun pattern reconnu) =====================
// Meme principe que le scenario A, mais SANS changer d'origine: la toute
// premiere requete vers l'URL de depart redirige vers un chemin de la MEME
// origine ne correspondant a AUCUN etat connu. clickSeConnecter() tente
// TOUJOURS, en repli, un acces direct a "/fr-fr/login" (comportement
// PRE-EXISTANT, hotfix 0.1.9, jamais modifie ici) - MAIS n'est desormais plus
// jamais invoque tant que la page courante n'a pas ete confirmee comme
// contexte d'accueil TLS sur (isPlausibleTlsHomeContext: meme origine ET meme
// chemin que handle.recoveryTargetUrl, ou motif reconnu homeCountryPagePattern)
// - un chemin inconnu de la MEME origine que startUrl ne suffit plus a passer
// ce garde. Les requetes suivantes (apres recuperation vers startUrl) servent
// le vrai contenu. ASSERT: aucun clickSeConnecter() aveugle sur le chemin
// decoy, recuperation vers safeRecoveryUrl (la MEME origine que startUrl,
// jamais une reconstruction), puis reprise normale.
const runUnknownSameOriginScenario = async (): Promise<void> => {
  log("SCENARIO-B", "=== URL TLS inconnue (meme origine, chemin inconnu): pas de clickSeConnecter aveugle, recuperation puis reprise ===");
  let tlsSite: FixtureSite | undefined;
  let manager: AgentBotManager | undefined;

  try {
    let homeRequestCount = 0;
    tlsSite = await startFixtureSite((url, _req, res) => {
      if (url === "/" || url === "") {
        homeRequestCount += 1;
        if (homeRequestCount === 1) {
          res.statusCode = 302;
          res.setHeader("Location", "/decoy-unknown-page-a");
          res.end();
          return;
        }
        res.end(REAL_HOME_HTML);
        return;
      }
      if (url.startsWith("/decoy-unknown-page")) { res.end(EXTERNAL_LOOKALIKE_HTML); return; }
      if (url.startsWith("/fr-fr/login")) { res.end(LOGIN_HTML); return; }
      if (url.startsWith("/appointment-booking")) { res.end(APPOINTMENT_HTML); return; }
      res.statusCode = 404;
      res.end("Not found (fixture).");
    });

    const settings = makeSettings("unknowntls");
    const { reporter, botStatuses } = makeFakeReporter();
    const capture = makeLogCapture();
    manager = new AgentBotManager(settings, capture.log, reporter);
    const botId = `bot-unknowntls-${RUN_SUFFIX}`;

    await manager.startBot({
      commandId: `cmd-${botId}`,
      botId,
      botName: botId,
      login: FAKE_LOGIN,
      password: FAKE_PASSWORD,
      rawMonitoringSettings: undefined,
      startUrl: tlsSite.baseUrl
    });

    await requireWithin(
      () => botStatuses.some((s) => s.botId === botId && s.status === "MONITORING"),
      45_000,
      "B) Le bot n'a jamais atteint MONITORING apres une premiere reponse non reconnue"
    );
    assert(true, "B) appointment-booking/MONITORING atteint apres un etat TLS non reconnu initial (chemin different de startUrl)");
    assert(
      hasLog(capture.entries, "Page non confirmee comme contexte d'accueil TLS sur"),
      "B) Le chemin decoy (meme origine, chemin inconnu) n'est jamais confondu avec la page d'accueil - clickSeConnecter() non tente dessus"
    );
    assert(
      tlsSite.requestLog.some((u) => u.startsWith("/decoy-unknown-page-a")),
      "B) (sanity) le chemin decoy a bien ete atteint pendant ce scenario"
    );
    assert(hasLog(capture.entries, "Retour vers l'URL TLS de depart effectue"), "B) La recuperation a bien ete tentee vers safeRecoveryUrl");
    assertNoSecretsInLogs(capture.entries, "B) Aucun secret dans les logs");
  } finally {
    if (manager) { try { await manager.stopBot({ commandId: "cmd-cleanup", botId: `bot-unknowntls-${RUN_SUFFIX}` }); } catch { /* best effort */ } }
    if (tlsSite) await new Promise<void>((resolve) => tlsSite!.server.close(() => resolve()));
  }
};

// ===================== Scenario C: etat transitoire, jamais un reset premature =====================
// Apres un clic 'Se connecter' reellement execute, la page passe par un etat
// intermediaire NON reconnu (ni login/auth/travel-groups/service-level...)
// pendant environ 1s, avant de se stabiliser sur l'etape login reconnue -
// largement a l'interieur des fenetres d'attente existantes
// (RECOGNIZED_STATE_WAIT_MS=12s). ASSERT: aucune recuperation (goto) n'est
// jamais declenchee - l'attente existante suffit.
const INTERIM_UNKNOWN_HTML = `<!DOCTYPE html><html><body><h1>Chargement en cours (etat transitoire, test uniquement)</h1>
<script>setTimeout(function(){ location.href = "/fr-fr/login"; }, 900);</script>
</body></html>`;
const runTransitionalStateScenario = async (): Promise<void> => {
  log("SCENARIO-C", "=== Etat transitoire apres un clic connu: jamais de recuperation forcee ===");
  let tlsSite: FixtureSite | undefined;
  let manager: AgentBotManager | undefined;

  try {
    // clickSeConnecter() navigue directement vers /fr-fr/login (goto direct) -
    // sert le fragment transitoire uniquement a la PREMIERE requete, pour
    // reproduire un etat intermediaire APRES le clic, jamais au premier
    // chargement de la page d'accueil elle-meme.
    let loginRequestCount = 0;
    tlsSite = await startFixtureSite((url, _req, res) => {
      if (url === "/" || url === "") { res.end(REAL_HOME_HTML); return; }
      if (url.startsWith("/fr-fr/login")) {
        loginRequestCount += 1;
        res.end(loginRequestCount === 1 ? INTERIM_UNKNOWN_HTML : LOGIN_HTML);
        return;
      }
      if (url.startsWith("/appointment-booking")) { res.end(APPOINTMENT_HTML); return; }
      res.statusCode = 404;
      res.end("Not found (fixture).");
    });

    const settings = makeSettings("transitional");
    const { reporter, botStatuses } = makeFakeReporter();
    const capture = makeLogCapture();
    manager = new AgentBotManager(settings, capture.log, reporter);
    const botId = `bot-transitional-${RUN_SUFFIX}`;

    await manager.startBot({
      commandId: `cmd-${botId}`,
      botId,
      botName: botId,
      login: FAKE_LOGIN,
      password: FAKE_PASSWORD,
      rawMonitoringSettings: undefined,
      startUrl: tlsSite.baseUrl
    });

    await requireWithin(
      () => botStatuses.some((s) => s.botId === botId && s.status === "MONITORING"),
      45_000,
      "C) Le bot n'a jamais atteint MONITORING malgre un etat transitoire benin"
    );
    assert(true, "C) L'etat transitoire se resout seul, MONITORING atteint normalement");
    assertNoSecretsInLogs(capture.entries, "C) Aucun secret dans les logs");
    assert(
      !hasLog(capture.entries, "Retour vers l'URL TLS de depart effectue") && !hasLog(capture.entries, "Etat de navigation initiale non reconnu"),
      "C) Aucune recuperation (goto) n'a ete declenchee pour un etat purement transitoire"
    );
  } finally {
    if (manager) { try { await manager.stopBot({ commandId: "cmd-cleanup", botId: `bot-transitional-${RUN_SUFFIX}` }); } catch { /* best effort */ } }
    if (tlsSite) await new Promise<void>((resolve) => tlsSite!.server.close(() => resolve()));
  }
};

// ===================== Scenario D: safeRecoveryUrl reste toujours inconnu =====================
// L'URL de depart ne sert JAMAIS un etat reconnu, quel que soit le nombre de
// requetes. ASSERT: le nombre de recuperations (goto) reste borne (au plus
// une par tentative globale, jamais un compteur independant), pas de boucle
// infinie, fin en WAITING_FOR_USER (jamais ERROR/STOPPED).
const runAlwaysUnknownScenario = async (): Promise<void> => {
  log("SCENARIO-D", "=== safeRecoveryUrl reste toujours inconnu: recuperation bornee, fin WAITING_FOR_USER ===");
  let tlsSite: FixtureSite | undefined;
  let manager: AgentBotManager | undefined;

  try {
    tlsSite = await startFixtureSite((_url, _req, res) => res.end(EXTERNAL_LOOKALIKE_HTML));

    const settings = makeSettings("alwaysunknown");
    const { reporter, botStatuses } = makeFakeReporter();
    const capture = makeLogCapture();
    manager = new AgentBotManager(settings, capture.log, reporter);
    const botId = `bot-alwaysunknown-${RUN_SUFFIX}`;

    const startedAt = Date.now();
    await manager.startBot({
      commandId: `cmd-${botId}`,
      botId,
      botName: botId,
      login: undefined,
      password: undefined,
      rawMonitoringSettings: undefined,
      startUrl: tlsSite.baseUrl
    });

    await requireWithin(
      () => botStatuses.some((s) => s.botId === botId && s.status === "WAITING_FOR_USER"),
      // 4 tentatives completes, chacune traversant le cycle F (succes de
      // pattern sur "/fr-fr/login") + waitForAppointmentPageOrTimeout(8s) +
      // deux passages par l'etat H (1.5s chacun) avant abandon: budget large
      // pour absorber cette cascade complete sans faux echec de timeout.
      90_000,
      "D) Le bot n'a jamais atteint WAITING_FOR_USER malgre un site toujours inconnu"
    );
    const elapsedMs = Date.now() - startedAt;
    assert(true, `D) Escalade finale vers WAITING_FOR_USER (jamais ERROR/STOPPED) apres ${elapsedMs}ms`);
    assert(
      !botStatuses.some((s) => s.botId === botId && (s.status === "ERROR" || s.status === "STOPPED")),
      "D) Jamais d'escalade vers ERROR/STOPPED simplement parce que le parcours automatique n'a rien reconnu"
    );

    const recoveryCount = countLogs(capture.entries, "Retour vers l'URL TLS de depart effectue");
    // AUTO_NAV_FINAL_ATTEMPT = 4 tentatives globales, au plus UNE recuperation
    // par tentative (jamais un compteur independant, cf. spec) => au plus 4.
    assert(recoveryCount >= 1 && recoveryCount <= 4, `D) Nombre borne de recuperations (recu: ${recoveryCount}, attendu entre 1 et 4)`);
    assert(
      hasLog(capture.entries, "Etat toujours non reconnu apres une premiere recuperation dans cette tentative"),
      "D) Une deuxieme recuperation dans la MEME tentative est bien refusee (budget respecte)"
    );
    assert(
      manager!.isActive(botId),
      "D) Chrome reste ouvert en WAITING_FOR_USER (jamais ferme automatiquement) pour permettre l'intervention manuelle"
    );

    // Aucune boucle de goto sans delai: le temps total doit refleter la
    // cascade (3 tentatives rapprochees + une longue attente), jamais une
    // rafale immediate de requetes.
    assert(elapsedMs >= 1_000, `D) Le temps ecoule reflete la cascade de tentatives/attentes existante, pas une rafale immediate (recu: ${elapsedMs}ms)`);
  } finally {
    if (manager) { try { await manager.stopBot({ commandId: "cmd-cleanup", botId: `bot-alwaysunknown-${RUN_SUFFIX}` }); } catch { /* best effort */ } }
    if (tlsSite) await new Promise<void>((resolve) => tlsSite!.server.close(() => resolve()));
  }
};

// ===================== Scenario E: Cloudflare - jamais confondu avec "unknown" =====================
const CLOUDFLARE_BLOCK_HTML = `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>
<h1>Sorry, you have been blocked</h1><p>You are unable to access this site.</p>
</body></html>`;
const runCloudflareScenario = async (): Promise<void> => {
  log("SCENARIO-E", "=== Cloudflare: jamais confondu avec un etat inconnu, jamais de recuperation par-dessus ===");
  let tlsSite: FixtureSite | undefined;
  let manager: AgentBotManager | undefined;

  try {
    tlsSite = await startFixtureSite((_url, _req, res) => res.end(CLOUDFLARE_BLOCK_HTML));

    const settings = makeSettings("cloudflare");
    const { reporter, botStatuses } = makeFakeReporter();
    const capture = makeLogCapture();
    manager = new AgentBotManager(settings, capture.log, reporter);
    const botId = `bot-cloudflare-${RUN_SUFFIX}`;

    const startedAt = Date.now();
    await manager.startBot({
      commandId: `cmd-${botId}`,
      botId,
      botName: botId,
      login: undefined,
      password: undefined,
      rawMonitoringSettings: undefined,
      startUrl: tlsSite.baseUrl
    });

    await requireWithin(
      () => botStatuses.some((s) => s.botId === botId && s.status === "WAITING_FOR_USER"),
      20_000,
      "E) Le bot bloque par Cloudflare n'a jamais atteint WAITING_FOR_USER"
    );
    const elapsedMs = Date.now() - startedAt;
    assert(elapsedMs < 15_000, `E) WAITING_FOR_USER atteint rapidement (arret immediat des tentatives sur blocage Cloudflare, recu: ${elapsedMs}ms)`);
    assert(
      !hasLog(capture.entries, "Retour vers l'URL TLS de depart effectue") && !hasLog(capture.entries, "Etat de navigation initiale non reconnu"),
      "E) Le nouveau fallback 'unknown' n'intervient jamais sur un blocage Cloudflare (traitement existant preserve)"
    );
  } finally {
    if (manager) { try { await manager.stopBot({ commandId: "cmd-cleanup", botId: `bot-cloudflare-${RUN_SUFFIX}` }); } catch { /* best effort */ } }
    if (tlsSite) await new Promise<void>((resolve) => tlsSite!.server.close(() => resolve()));
  }
};

// ===================== Scenario F: CAPTCHA/auth - verification STATIQUE =====================
// Une page d'authentification (isAuthPage) est verifiee AVANT les etats F/H
// dans dispatchOnState (priorite figee dans le code, cf. audit) - la logique
// CAPTCHA (waitForRecaptchaResolution/fillLoginForm, src/shared/loginFlow.ts)
// n'est jamais executee en conditions reelles pendant plus de quelques
// secondes ici que si un vrai CAPTCHA bloquant est simule (jusqu'a plusieurs
// minutes d'attente reelle, hors budget d'un test cible). Verifie ici de
// maniere STATIQUE (meme principe que checkServiceLevelClickLogicUnaffected
// dans test-agent-hotfix-home-login-real.ts) que ce hotfix ne touche NI la
// position de la verification isAuthPage (avant les etats F/H) NI la logique
// CAPTCHA elle-meme (src/shared/loginFlow.ts, jamais modifie par ce hotfix).
const checkAuthCaptchaLogicUnaffected = (): void => {
  let diffAgent = "";
  let diffLoginFlow = "";
  try {
    diffAgent = execSync("git diff --unified=0 -- src/agent/agentBotManager.ts", { encoding: "utf8" });
    diffLoginFlow = execSync("git diff --unified=0 -- src/shared/loginFlow.ts", { encoding: "utf8" });
  } catch (error) {
    log("GIT-DIFF-ERR", `git diff indisponible: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert(diffLoginFlow.trim() === "", "F) src/shared/loginFlow.ts (CAPTCHA/fillLoginForm/waitForRecaptchaResolution) n'est pas modifie par ce hotfix");

  const changedAgentLines = diffAgent.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-")).join("\n");
  assert(
    !/if \(await isAuthPage\(page\)\)/.test(changedAgentLines),
    "F) La verification isAuthPage() (priorite sur les etats F/H, jamais contournee par le nouveau fallback) n'est pas modifiee"
  );
  assert(
    !changedAgentLines.includes("fillLoginForm(page, login, password"),
    "F) L'appel a fillLoginForm() (seul point d'entree du traitement CAPTCHA) n'est pas modifie"
  );
};

// ===================== Scenario G: extension locale - contrat preserve =====================
// hasLocalExtension=true: runAutoNavigation() ne doit JAMAIS piloter le
// formulaire ni tenter de recuperation - seule l'attente/reprise du contexte
// est reeditee (contrat existant, verifie ici non casse). La page d'accueil
// est deliberement "inconnue" selon le classifieur standard (aucun lien de
// connexion) - un <script> simule ici le comportement de l'extension
// (navigue seule vers la page de rendez-vous apres un court delai), jamais
// pilote par l'agent.
const EXTENSION_HOME_HTML = `<!DOCTYPE html><html><body><h1>Page d'accueil (test uniquement, extension locale)</h1>
<script>setTimeout(function(){ location.href = "/appointment-booking"; }, 1200);</script>
</body></html>`;
const runLocalExtensionScenario = async (): Promise<void> => {
  log("SCENARIO-G", "=== Extension locale configuree: contrat existant preserve (aucune recuperation forcee) ===");
  let tlsSite: FixtureSite | undefined;
  let manager: AgentBotManager | undefined;
  const settings = makeSettings("extension");
  const extensionDir = path.join(settings.dataRoot, "fake-extension");

  try {
    tlsSite = await startFixtureSite((url, _req, res) => {
      if (url === "/" || url === "") { res.end(EXTENSION_HOME_HTML); return; }
      if (url.startsWith("/appointment-booking")) { res.end(APPOINTMENT_HTML); return; }
      res.statusCode = 404;
      res.end("Not found (fixture).");
    });

    // Enregistre une extension locale minimale valide (contrat verifie par
    // agentExtensionConfig.ts: dossier existant + manifest.json avec
    // manifest_version/name) pour forcer hasLocalExtension=true.
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(path.join(extensionDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Fake Test Extension", version: "1.0" }), "utf8");
    const configDir = path.join(settings.dataRoot, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "extensions.json"),
      JSON.stringify({ extensions: [{ id: "fake-test-extension", localPath: extensionDir, enabled: true, required: false }] }),
      "utf8"
    );

    const { reporter, botStatuses } = makeFakeReporter();
    const capture = makeLogCapture();
    manager = new AgentBotManager(settings, capture.log, reporter);
    const botId = `bot-extension-${RUN_SUFFIX}`;

    await manager.startBot({
      commandId: `cmd-${botId}`,
      botId,
      botName: botId,
      login: undefined,
      password: undefined,
      rawMonitoringSettings: undefined,
      startUrl: tlsSite.baseUrl
    });

    await requireWithin(
      () => botStatuses.some((s) => s.botId === botId && s.status === "MONITORING"),
      45_000,
      "G) Le bot n'a jamais atteint MONITORING alors que 'l'extension' a bien amene la page de rendez-vous"
    );
    assert(true, "G) Avec extension locale: la page de rendez-vous amenee par l'extension conduit bien a MONITORING");
    assert(
      !hasLog(capture.entries, "Etat de navigation initiale non reconnu")
      && !hasLog(capture.entries, "Retour vers l'URL TLS de depart effectue")
      && !hasLog(capture.entries, "clickSeConnecter() a echoue reellement")
      && !hasLog(capture.entries, "clickSeConnecter() sans effet reel"),
      "G) Aucune recuperation/pilotage force n'est tente en mode extension locale (page laissee a l'extension)"
    );
  } finally {
    if (manager) { try { await manager.stopBot({ commandId: "cmd-cleanup", botId: `bot-extension-${RUN_SUFFIX}` }); } catch { /* best effort */ } }
    if (tlsSite) await new Promise<void>((resolve) => tlsSite!.server.close(() => resolve()));
  }
};

// ===================== Scenario H: about:blank apparait pendant une tentative =====================
// La page d'accueil se navigue ELLE-MEME vers about:blank juste apres son
// chargement (simulateur d'anomalie), avant de laisser le vrai parcours
// reprendre au deuxieme chargement. ASSERT: recuperation vers safeRecoveryUrl
// (jamais une navigation relative depuis about:blank - l'ancien bug "Invalid
// URL" du hotfix 0.1.2 ne doit jamais reapparaitre), reprise normale.
const BLANKING_HOME_HTML = `<!DOCTYPE html><html><body><h1>Page d'accueil (test uniquement, disparait vers about:blank)</h1>
<script>setTimeout(function(){ location.href = "about:blank"; }, 200);</script>
</body></html>`;
const runAboutBlankMidRunScenario = async (): Promise<void> => {
  log("SCENARIO-H", "=== about:blank apparait pendant une tentative: recuperation vers safeRecoveryUrl (jamais goto relatif) ===");
  let tlsSite: FixtureSite | undefined;
  let manager: AgentBotManager | undefined;

  try {
    let homeRequestCount = 0;
    tlsSite = await startFixtureSite((url, _req, res) => {
      if (url === "/" || url === "") {
        homeRequestCount += 1;
        res.end(homeRequestCount === 1 ? BLANKING_HOME_HTML : REAL_HOME_HTML);
        return;
      }
      if (url.startsWith("/fr-fr/login")) { res.end(LOGIN_HTML); return; }
      if (url.startsWith("/appointment-booking")) { res.end(APPOINTMENT_HTML); return; }
      res.statusCode = 404;
      res.end("Not found (fixture).");
    });

    const settings = makeSettings("aboutblank");
    const { reporter, botStatuses } = makeFakeReporter();
    const capture = makeLogCapture();
    manager = new AgentBotManager(settings, capture.log, reporter);
    const botId = `bot-aboutblank-${RUN_SUFFIX}`;

    await manager.startBot({
      commandId: `cmd-${botId}`,
      botId,
      botName: botId,
      login: FAKE_LOGIN,
      password: FAKE_PASSWORD,
      rawMonitoringSettings: undefined,
      startUrl: tlsSite.baseUrl
    });

    await requireWithin(
      () => botStatuses.some((s) => s.botId === botId && s.status === "MONITORING"),
      45_000,
      "H) Le bot n'a jamais atteint MONITORING apres l'apparition d'un about:blank en cours de tentative"
    );
    assert(true, "H) Recuperation reussie apres apparition d'un about:blank en cours de tentative");
    assertNoSecretsInLogs(capture.entries, "H) Aucun secret dans les logs");
    assert(
      !capture.entries.some((e) => /invalid url/i.test(e.message)),
      "H) Aucune erreur 'Invalid URL' (regression de l'ancien bug 0.1.2: jamais de navigation relative depuis about:blank)"
    );
    assert(
      !capture.entries.some((e) => /clickSeConnecter\(\) (execute avec succes|a echoue reellement).*avant=about:blank/.test(e.message)),
      "H) clickSeConnecter() n'est jamais invoque alors que la page courante est about:blank"
    );
  } finally {
    if (manager) { try { await manager.stopBot({ commandId: "cmd-cleanup", botId: `bot-aboutblank-${RUN_SUFFIX}` }); } catch { /* best effort */ } }
    if (tlsSite) await new Promise<void>((resolve) => tlsSite!.server.close(() => resolve()));
  }
};

// ===================== Scenario I: STOP_BOT pendant la recuperation =====================
// Un STOP_BOT declenche PENDANT l'attente/recuperation de l'etat inconnu ne
// doit jamais provoquer de goto tardif ni de WAITING_FOR_USER tardif - Chrome
// doit fermer par le chemin STOP existant.
const STUCK_AFTER_CLICK_HTML = `<!DOCTYPE html><html><body><h1>Etat non reconnu apres clic (test uniquement, jamais resolu)</h1></body></html>`;
const runStopDuringRecoveryScenario = async (): Promise<void> => {
  log("SCENARIO-I", "=== STOP_BOT pendant la recuperation d'un etat inconnu: aucun goto tardif ===");
  let tlsSite: FixtureSite | undefined;
  let manager: AgentBotManager | undefined;

  try {
    tlsSite = await startFixtureSite((url, _req, res) => {
      if (url === "/" || url === "") { res.end(REAL_HOME_HTML); return; }
      // Le clic 'Se connecter' navigue vers /fr-fr/login, qui reste ici
      // deliberement non reconnu (etat H atteint sur le pas SUIVANT, jamais
      // via l'echec de clickSeConnecter lui-meme).
      if (url.startsWith("/fr-fr/login")) { res.end(STUCK_AFTER_CLICK_HTML); return; }
      res.statusCode = 404;
      res.end("Not found (fixture).");
    });

    const settings = makeSettings("stopduring");
    const { reporter, botStatuses } = makeFakeReporter();
    const capture = makeLogCapture();
    manager = new AgentBotManager(settings, capture.log, reporter);
    const botId = `bot-stopduring-${RUN_SUFFIX}`;

    await manager.startBot({
      commandId: `cmd-${botId}`,
      botId,
      botName: botId,
      login: undefined,
      password: undefined,
      rawMonitoringSettings: undefined,
      startUrl: tlsSite.baseUrl
    });

    // Interception au plus tot possible: des que l'etat H journalise son
    // avertissement (juste avant l'attente de 1.5s puis la decision de
    // recuperation), STOP_BOT est envoye - avant tout goto de recuperation.
    await requireWithin(
      () => hasLog(capture.entries, "Etat de page non reconnu"),
      30_000,
      "I) L'etat non reconnu (H) n'a jamais ete atteint apres le clic 'Se connecter'"
    );
    await manager.stopBot({ commandId: `cmd-stop-${botId}`, botId });

    assert(
      botStatuses.some((s) => s.botId === botId && s.status === "STOPPED"),
      "I) Le bot converge bien vers STOPPED via le chemin STOP_BOT existant"
    );
    assert(
      !botStatuses.some((s) => s.botId === botId && s.status === "WAITING_FOR_USER"),
      "I) Aucun WAITING_FOR_USER tardif apres un STOP_BOT pendant la recuperation"
    );
    assert(
      !hasLog(capture.entries, "Retour vers l'URL TLS de depart effectue"),
      "I) Aucun goto de recuperation n'a ete effectue apres le signal STOP_BOT (interruption avant le goto)"
    );
    assert(!manager.isActive(botId), "I) Le bot n'est plus actif dans le registre de l'agent apres STOP_BOT");
  } finally {
    if (manager) { try { await manager.stopBot({ commandId: "cmd-cleanup", botId: `bot-stopduring-${RUN_SUFFIX}` }); } catch { /* best effort */ } }
    if (tlsSite) await new Promise<void>((resolve) => tlsSite!.server.close(() => resolve()));
  }
};

// ===================== Scenario K: parcours normal - aucune recuperation superflue =====================
const runHappyPathNonRegressionScenario = async (): Promise<void> => {
  log("SCENARIO-K", "=== Parcours normal (home->login->appointment): aucune recuperation superflue ===");
  let tlsSite: FixtureSite | undefined;
  let manager: AgentBotManager | undefined;

  try {
    tlsSite = await startFixtureSite((url, _req, res) => {
      if (url === "/" || url === "") { res.end(REAL_HOME_HTML); return; }
      if (url.startsWith("/fr-fr/login")) { res.end(LOGIN_HTML); return; }
      if (url.startsWith("/appointment-booking")) { res.end(APPOINTMENT_HTML); return; }
      res.statusCode = 404;
      res.end("Not found (fixture).");
    });

    const settings = makeSettings("happypath");
    const { reporter, botStatuses } = makeFakeReporter();
    const capture = makeLogCapture();
    manager = new AgentBotManager(settings, capture.log, reporter);
    const botId = `bot-happypath-${RUN_SUFFIX}`;

    await manager.startBot({
      commandId: `cmd-${botId}`,
      botId,
      botName: botId,
      login: FAKE_LOGIN,
      password: FAKE_PASSWORD,
      rawMonitoringSettings: undefined,
      startUrl: tlsSite.baseUrl
    });

    await requireWithin(
      () => botStatuses.some((s) => s.botId === botId && s.status === "MONITORING"),
      30_000,
      "K) Regression: le parcours normal n'atteint plus MONITORING"
    );
    assert(true, "K) Le parcours normal (deja fonctionnel) atteint toujours MONITORING sans changement");
    assertNoSecretsInLogs(capture.entries, "K) Aucun secret dans les logs");
    assert(
      !hasLog(capture.entries, "Etat de navigation initiale non reconnu") && !hasLog(capture.entries, "Retour vers l'URL TLS de depart effectue"),
      "K) Aucune recuperation superflue n'est jamais declenchee sur un parcours deja fonctionnel"
    );
    assert(
      hasLog(capture.entries, "clickSeConnecter() execute avec succes") && !hasLog(capture.entries, "Page non confirmee comme contexte d'accueil TLS sur"),
      "K) La VRAIE page d'accueil TLS (meme origine/chemin que startUrl) continue bien a utiliser clickSeConnecter() comme avant"
    );
  } finally {
    if (manager) { try { await manager.stopBot({ commandId: "cmd-cleanup", botId: `bot-happypath-${RUN_SUFFIX}` }); } catch { /* best effort */ } }
    if (tlsSite) await new Promise<void>((resolve) => tlsSite!.server.close(() => resolve()));
  }
};

// ===================== Scenario L: monitoring non touche - verification STATIQUE =====================
const checkMonitoringRuntimeUntouched = (): void => {
  let diff = "";
  try {
    diff = execSync("git diff --unified=0 -- src/agent/agentMonitoringRuntime.ts", { encoding: "utf8" });
  } catch (error) {
    log("GIT-DIFF-ERR", `git diff indisponible: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert(diff.trim() === "", "L) src/agent/agentMonitoringRuntime.ts (recovery du MONITORING) n'est pas modifie par ce hotfix");
};

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL cible - Recuperation de navigation initiale (runAutoNavigation) ===");

  if (process.platform !== "win32") {
    console.log("Plateforme non-Windows: ce test necessite Windows + Chrome. Ignore, 0 succes / 0 echec.");
    process.exit(0);
    return;
  }

  try {
    checkMonitoringRuntimeUntouched();
    checkAuthCaptchaLogicUnaffected();
    await runExternalPageScenario();
    await runUnknownSameOriginScenario();
    await runTransitionalStateScenario();
    await runAlwaysUnknownScenario();
    await runCloudflareScenario();
    await runLocalExtensionScenario();
    await runAboutBlankMidRunScenario();
    await runStopDuringRecoveryScenario();
    await runHappyPathNonRegressionScenario();
  } finally {
    await removeDataRootsWithRetry();
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
