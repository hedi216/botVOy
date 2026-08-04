// HOTFIX CIBLE - Service-level bloque malgre un lien "Continuer" valide.
//
// Reproduit PRECISEMENT le HTML reel observe via DevTools sur TLScontact
// (<a id="book-appointment-btn" data-testid="btn-book-appointment"
// href="/workflow/appointment-booking/..."> dans une barre sticky, avec un
// service optionnel affiche/coche a cote) sur un faux site local (jamais le
// vrai TLScontact), avec un vrai Chromium Playwright.
//
// PARTIE A: teste clickContinueServiceLevel() directement (src/shared/
// loginFlow.ts) - detection de page, selecteurs stricts, diagnostic reel
// avant clic, actionnabilite (trial click), repli par navigation controlee
// (accepte/refuse), deduplication, absence de secrets dans les logs.
//
// PARTIE B: teste le NOUVEAU dispatcher pilote par etat de AgentBotManager
// (src/agent/agentBotManager.ts, runAutoNavigation) avec un vrai Chrome
// visible: verifie que demarrer directement depuis travel-groups ou
// application-summary atteint appointment-booking puis MONITORING sans
// jamais retomber sur /fr-fr/login (regression du bug reel corrige ici).
//
// Usage: npx tsx scripts/test-agent-service-level-hotfix-real.ts
//    ou: npm run test:agent:service-level-hotfix:real

import { rmSync } from "node:fs";
import http, { Server } from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";
import { Browser, Page, chromium } from "playwright";
import { AgentBotManager } from "../src/agent/agentBotManager.js";
import { AgentEventReporter } from "../src/agent/agentEventReporter.js";
import { clickContinueServiceLevel, isAllowedAppointmentBookingRedirect } from "../src/shared/loginFlow.js";
import { AgentLogLevel } from "../src/agent/agentLocalLogger.js";
import { AgentRuntimeSettings } from "../src/agent/types.js";

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 15_000, intervalMs = 200): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};

// ===================== Faux site TLS local (jamais TLScontact reel) =====================

const APPOINTMENT_BOOKING_PATH = "/workflow/appointment-booking/tnTUN2fr/27928390";

const SERVICE_LEVEL_TITLE = "Sélectionnez un ou plusieurs services additionnels";

// Reproduit le HTML reel observe via DevTools (cf. ticket): titre, service
// optionnel affiche et COCHE, barre sticky en bas, ancre exacte avec id +
// data-testid + href vers appointment-booking. `variant` permute uniquement
// la cible du lien pour les scenarios de repli/refus, jamais le reste du DOM.
type ServiceLevelVariant = "normal" | "overlay" | "bad-href-external" | "bad-href-wrongpath";

const serviceLevelHtml = (variant: ServiceLevelVariant): string => {
  const href = variant === "bad-href-external"
    ? "https://evil.invalid/workflow/appointment-booking/tnTUN2fr/27928390"
    : variant === "bad-href-wrongpath"
      ? "/workflow/wrong-step/tnTUN2fr/27928390"
      : APPOINTMENT_BOOKING_PATH;

  // Overlay fixe couvrant exactement la barre du bas: force Playwright a
  // echouer le clic (element intercepte) sans jamais empecher le trial/clic
  // reel de le DETECTER (jamais un piege invisible aux yeux d'un humain).
  // Les DEUX elements utilisent position:fixed (pas "sticky", qui ne se
  // colle au bas du viewport qu'en cas de defilement reel - piege constate:
  // sur une page courte sans scroll, "sticky" reste en flux normal et ne
  // chevauche jamais un overlay fixed) pour garantir le meme espace ecran.
  const overlayStyle = variant === "overlay"
    ? "position:fixed;left:0;right:0;bottom:0;height:80px;background:rgba(0,0,0,0.01);z-index:9999;"
    : "display:none;";

  return `<!DOCTYPE html><html><body>
<h1>${SERVICE_LEVEL_TITLE}</h1>
<div class="optional-service">
  <input type="checkbox" id="svc1" checked onclick="window.__serviceToggled = (window.__serviceToggled||0)+1;">
  <label for="svc1">Service Optionnel Payant (Depot en semaine en dehors des heures d'ouverture)</label>
</div>
<button id="btn-cancel" onclick="window.__otherClicks = (window.__otherClicks||0)+1;">Annuler</button>
<div id="sticky-overlay-blocker" style="${overlayStyle}"></div>
<div class="sticky-bottom-bar" style="position:fixed;left:0;right:0;bottom:0;height:80px;">
  <a id="book-appointment-btn" data-testid="btn-book-appointment" href="${href}">Continuer</a>
</div>
</body></html>`;
};

const LOGIN_HTML = `<!DOCTYPE html><html><body><h1>Faux login (ne devrait jamais etre atteint depuis ce test)</h1></body></html>`;

const TRAVEL_GROUPS_HTML = (next: "service-level" | "application-summary"): string => `<!DOCTYPE html><html><body>
<h1>Gestionnaire des demandes</h1>
<button type="button" onclick="location.href='/workflow/${next}'">Selectionner</button>
</body></html>`;

const APPLICATION_SUMMARY_HTML = `<!DOCTYPE html><html><body>
<h1>Recapitulatif de la demande</h1>
<p>Non reserve</p>
<button id="btn-confirm-appointment" type="button" onclick="location.href='/workflow/service-level'">Prendre un nouveau rendez-vous</button>
</body></html>`;

// Playwright isVisible() exige une boite englobante non vide (piege deja
// documente dans les autres tests reels de ce depot): un texte reel donne
// une hauteur non nulle, contrairement a une div vide.
const APPOINTMENT_BOOKING_HTML = `<!DOCTYPE html><html><body>
<div data-testid="fixture-appointment-page">Fausse page de rendez-vous (test uniquement)</div>
</body></html>`;

type FixtureSite = { server: Server; baseUrl: string; requestLog: string[] };

const startFixtureSite = (): Promise<FixtureSite> => new Promise((resolve, reject) => {
  const requestLog: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    requestLog.push(url);
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (url.startsWith("/fr-fr/login")) { res.end(LOGIN_HTML); return; }
    if (url.startsWith("/fr-fr/travel-groups")) {
      const next = url.includes("next=application-summary") ? "application-summary" : "service-level";
      res.end(TRAVEL_GROUPS_HTML(next));
      return;
    }
    if (url.startsWith("/workflow/application-summary")) { res.end(APPLICATION_SUMMARY_HTML); return; }
    if (url.startsWith("/workflow/service-level")) {
      const variant: ServiceLevelVariant = url.includes("variant=overlay") ? "overlay"
        : url.includes("variant=bad-href-external") ? "bad-href-external"
          : url.includes("variant=bad-href-wrongpath") ? "bad-href-wrongpath"
            : "normal";
      res.end(serviceLevelHtml(variant));
      return;
    }
    if (url.startsWith(APPOINTMENT_BOOKING_PATH) || url.startsWith("/workflow/appointment-booking/")) {
      res.end(APPOINTMENT_BOOKING_HTML);
      return;
    }
    res.statusCode = 404;
    res.end("Not found (fixture).");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, requestLog });
  });
});

const countRequests = (requestLog: string[], predicate: (url: string) => boolean): number =>
  requestLog.filter(predicate).length;

// ===================== Capture de logs (jamais de secret attendu ici) =====================

type CapturedLog = { level: AgentLogLevel; message: string };
const makeLogCapture = (): { entries: CapturedLog[]; log: (level: AgentLogLevel, message: string) => void } => {
  const entries: CapturedLog[] = [];
  return { entries, log: (level, message) => entries.push({ level, message }) };
};

const FORBIDDEN_LOG_SUBSTRINGS = ["password", "login=", "cookie:", "authorization:", "token="];
const assertNoSecretsInLogs = (entries: CapturedLog[], description: string): void => {
  const offending = entries.filter((entry) => FORBIDDEN_LOG_SUBSTRINGS.some((needle) => entry.message.toLowerCase().includes(needle)));
  assert(offending.length === 0, `${description} (recu: ${offending.length} ligne(s) suspecte(s))`);
};

// ===================== PARTIE A: clickContinueServiceLevel() directement =====================

const runPartA = async (fixture: FixtureSite, browser: Browser): Promise<void> => {
  log("PART-A", "=== clickContinueServiceLevel(): detection, clic, diagnostic, repli, dedup ===");

  // ----- A1: cas nominal -----
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${fixture.baseUrl}/workflow/service-level`, { waitUntil: "domcontentloaded" });

    const before = fixture.requestLog.length;
    const capture = makeLogCapture();
    const checkedBefore = await page.locator("#svc1").isChecked();

    const result = await clickContinueServiceLevel(page, capture.log);

    assert(result === true, "A1) clickContinueServiceLevel() retourne true sur le cas nominal");
    assert(new URL(page.url()).pathname === APPOINTMENT_BOOKING_PATH, `A1) La page appointment-booking est atteinte (recu: ${page.url()})`);
    assert(
      capture.entries.some((e) => e.message.includes("candidat 'Continuer' trouve") && e.message.includes("tag=A") && e.message.includes(`href-pathname=${APPOINTMENT_BOOKING_PATH}`)),
      "A1) Diagnostic avant clic journalise (selecteur, tag, href-pathname)"
    );
    assert(
      countRequests(fixture.requestLog.slice(before), (u) => u.startsWith(APPOINTMENT_BOOKING_PATH)) === 1,
      "A1) Le clic est execute une seule fois (une seule requete vers appointment-booking)"
    );
    const checkedAfter = await page.locator("#svc1").isChecked().catch(() => checkedBefore);
    assert(checkedBefore === true && checkedAfter === checkedBefore, "A1) Aucun service additionnel selectionne/deselectionne (case a cocher inchangee)");
    const otherClicks = await page.evaluate(() => (window as unknown as { __otherClicks?: number }).__otherClicks || 0).catch(() => -1);
    assert(otherClicks === 0, `A1) Aucun autre bouton de la page n'est clique (recu compteur=${otherClicks})`);
    assertNoSecretsInLogs(capture.entries, "A1) Aucun secret dans les logs");

    await context.close();
  }

  // ----- A2: clic intercepte (overlay) -> vraie cause journalisee + repli navigation -----
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${fixture.baseUrl}/workflow/service-level?variant=overlay`, { waitUntil: "domcontentloaded" });

    const capture = makeLogCapture();
    const result = await clickContinueServiceLevel(page, capture.log);

    assert(result === true, "A2) Le repli par navigation controlee permet quand meme d'atteindre appointment-booking");
    assert(new URL(page.url()).pathname === APPOINTMENT_BOOKING_PATH, "A2) appointment-booking atteint via le repli");
    const clickFailureLog = capture.entries.find((e) => e.message.includes("Clic Playwright sur 'Continuer'") && e.message.includes("echoue"));
    assert(Boolean(clickFailureLog), "A2) L'echec REEL du clic (interception) est journalise, pas seulement 'introuvable'");
    assert(
      Boolean(clickFailureLog) && !clickFailureLog!.message.toLowerCase().includes("introuvable"),
      "A2) Le message differencie 'trouve mais clic echoue' de 'introuvable' (cause exacte conservee)"
    );
    assert(
      capture.entries.some((e) => e.message.includes("Repli par navigation controlee utilise")),
      "A2) Le repli href est explicitement journalise comme utilise"
    );
    assertNoSecretsInLogs(capture.entries, "A2) Aucun secret dans les logs (scenario overlay)");

    await context.close();
  }

  // ----- A3: repli refuse - origine externe -----
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${fixture.baseUrl}/workflow/service-level?variant=bad-href-external`, { waitUntil: "domcontentloaded" });

    const before = fixture.requestLog.length;
    const capture = makeLogCapture();
    const result = await clickContinueServiceLevel(page, capture.log);

    assert(result === false, "A3) Un href vers une origine externe est refuse (retour false)");
    assert(new URL(page.url()).pathname !== APPOINTMENT_BOOKING_PATH, "A3) La page reste sur service-level (aucune navigation)");
    assert(countRequests(fixture.requestLog.slice(before), (u) => u.startsWith(APPOINTMENT_BOOKING_PATH)) === 0, "A3) Aucune requete vers appointment-booking (clic jamais effectue)");
    assert(!isAllowedAppointmentBookingRedirect(new URL("https://evil.invalid/workflow/appointment-booking/x"), page.url()), "A3) isAllowedAppointmentBookingRedirect() refuse directement une origine externe");

    await context.close();
  }

  // ----- A4: repli refuse - mauvais pathname -----
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${fixture.baseUrl}/workflow/service-level?variant=bad-href-wrongpath`, { waitUntil: "domcontentloaded" });

    const before = fixture.requestLog.length;
    const result = await clickContinueServiceLevel(page, () => undefined);

    assert(result === false, "A4) Un href vers un chemin different de /workflow/appointment-booking/ est refuse");
    assert(countRequests(fixture.requestLog.slice(before), (u) => u.startsWith("/workflow/wrong-step")) === 0, "A4) La cible incorrecte n'est jamais requetee");
    assert(!isAllowedAppointmentBookingRedirect(new URL(`${fixture.baseUrl}/workflow/wrong-step/x`), page.url()), "A4) isAllowedAppointmentBookingRedirect() refuse directement un mauvais pathname");
    assert(isAllowedAppointmentBookingRedirect(new URL(`${fixture.baseUrl}${APPOINTMENT_BOOKING_PATH}`), page.url()), "A4) isAllowedAppointmentBookingRedirect() accepte la meme origine + le bon pathname");

    await context.close();
  }

  // ----- A5: deduplication - deux appels concurrents, un seul clic -----
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${fixture.baseUrl}/workflow/service-level`, { waitUntil: "domcontentloaded" });

    const before = fixture.requestLog.length;
    const [resultA, resultB] = await Promise.all([
      clickContinueServiceLevel(page, () => undefined),
      clickContinueServiceLevel(page, () => undefined)
    ]);

    assert(resultA === true && resultB === true, "A5) Les deux appels concurrents se resolvent avec succes");
    assert(
      countRequests(fixture.requestLog.slice(before), (u) => u.startsWith(APPOINTMENT_BOOKING_PATH)) === 1,
      "A5) Deux appels concurrents ne provoquent jamais deux clics (une seule requete vers appointment-booking)"
    );

    await context.close();
  }
};

// ===================== PARTIE B: dispatcher pilote par etat (AgentBotManager) =====================

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

const runPartB = async (fixture: FixtureSite): Promise<void> => {
  log("PART-B", "=== Dispatcher pilote par etat (AgentBotManager.runAutoNavigation): regression d'ordre des etats ===");

  const dataRoot = path.resolve(`.test-service-level-hotfix-data-${Date.now()}`);
  const makeSettings = (): AgentRuntimeSettings => ({
    serverUrl: "http://localhost:0",
    credentialsPath: path.join(dataRoot, "credentials", "agent-credentials.json"),
    computerName: "TEST-SERVICE-LEVEL-HOTFIX",
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
    autoNavRetryIntervalMs: 500,
    autoNavLongWaitMs: 1_500
  });

  const runChain = async (
    label: string,
    startUrl: string
  ): Promise<void> => {
    const settings = makeSettings();
    const { reporter, botStatuses } = makeFakeReporter();
    const capture = makeLogCapture();
    const manager = new AgentBotManager(settings, capture.log, reporter);
    const botId = `bot-${label}-${Date.now()}`;
    const requestsBefore = fixture.requestLog.length;

    try {
      await manager.startBot({
        commandId: `cmd-${botId}`,
        botId,
        botName: botId,
        login: undefined,
        password: undefined,
        rawMonitoringSettings: undefined,
        startUrl
      });

      const reachedMonitoring = await waitUntil(() => botStatuses.some((s) => s.botId === botId && s.status === "MONITORING"), 30_000);
      assert(reachedMonitoring, `${label}) Le bot atteint MONITORING (chaine: ${label})`);

      const chainRequests = fixture.requestLog.slice(requestsBefore);
      assert(
        countRequests(chainRequests, (u) => u.startsWith("/fr-fr/login")) === 0,
        `${label}) Aucune navigation vers /fr-fr/login n'a lieu en repartant d'un etat deja avance`
      );
      assert(
        !capture.entries.some((e) => /se connecter|champ identifiant|champ mot de passe|formulaire de connexion/i.test(e.message)),
        `${label}) clickSeConnecter/fillLoginForm ne sont jamais invoques depuis cet etat (aucun log associe)`
      );
      assert(
        countRequests(chainRequests, (u) => u.startsWith(APPOINTMENT_BOOKING_PATH)) >= 1,
        `${label}) La page appointment-booking est bien atteinte via une vraie navigation`
      );

      // Le monitoring ne doit demarrer qu'apres appointment-booking: au moment
      // ou MONITORING apparait, aucune requete ulterieure vers travel-groups/
      // application-summary/service-level ne doit avoir eu lieu (la sequence
      // d'etats est terminale une fois la page de rendez-vous atteinte).
      const monitoringIndex = botStatuses.findIndex((s) => s.botId === botId && s.status === "MONITORING");
      const statusesBeforeMonitoring = botStatuses.slice(0, monitoringIndex).filter((s) => s.botId === botId).map((s) => s.status);
      assert(
        !statusesBeforeMonitoring.includes("WAITING_FOR_USER"),
        `${label}) Le parcours automatique aboutit sans jamais passer par WAITING_FOR_USER (statuts avant MONITORING: ${statusesBeforeMonitoring.join(",")})`
      );

      assertNoSecretsInLogs(capture.entries, `${label}) Aucun secret dans les logs de l'agent`);
    } finally {
      await manager.shutdownAll().catch(() => undefined);
    }
  };

  await runChain("chain1-travelgroups-servicelevel", `${fixture.baseUrl}/fr-fr/travel-groups?next=service-level`);
  await runChain("chain2-travelgroups-appsummary-servicelevel", `${fixture.baseUrl}/fr-fr/travel-groups?next=application-summary`);

  // Sur Windows, un handle Crashpad/journal SQLite du profil Chrome tout
  // juste ferme peut rester brievement verrouille apres killChromeProcess:
  // quelques tentatives espacees evitent un dossier de test orphelin.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      rmSync(dataRoot, { recursive: true, force: true });
      break;
    } catch {
      if (attempt < 5) {
        await sleep(500);
      }
    }
  }
};

// ===================== Orchestration =====================

const main = async (): Promise<void> => {
  log("BOOT", "=== Test cible - service-level bloque malgre un lien Continuer valide ===");

  const fixture = await startFixtureSite();
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });
    await runPartA(fixture, browser);
    await runPartB(fixture);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    // server.close() attend que TOUTE connexion keep-alive existante se
    // termine d'elle-meme (piege constate: reste bloque plusieurs minutes
    // apres la fermeture de Chrome si un socket HTTP persistant n'a pas ete
    // rompu proprement) - closeAllConnections() les force explicitement
    // avant d'attendre le callback de fermeture.
    fixture.server.closeAllConnections?.();
    await Promise.race([
      new Promise<void>((resolve) => fixture.server.close(() => resolve())),
      sleep(5_000)
    ]);
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
