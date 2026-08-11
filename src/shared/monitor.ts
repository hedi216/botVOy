import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Page } from "playwright";
import { detectAppointmentAvailability, findBestCandidateElement, findReserveAppointmentButton, isAppointmentPageReady } from "./detectors.js";
import { detectHumanValidation } from "./humanValidation.js";
import { highlightElement } from "./highlight.js";
import { appointmentBookingPathPattern, isTlsLoggedOutLandingPage } from "./loginFlow.js";
import { logger } from "../logger.js";
import {
  applyRateLimitCooldown,
  broadcastAppointmentSignal,
  clearAppointmentSignal,
  isAppointmentSignalActive,
  releaseScanTurn,
  scheduleReservationHoldRecheck,
  waitForScanTurn,
  waitRandomDelay
} from "./orchestrator.js";
import { takeTimestampedScreenshot } from "./screenshot.js";
import { AppConfig, CandidateElementResult, MonitorEventLevel, MonitorRuntime, SlotDetectedInfo } from "./types.js";

type ResolvedMonitorRuntime = {
  botName?: string;
  category?: string;
  log: (level: MonitorEventLevel, message: string) => void;
  waitForUser: (message: string) => Promise<void>;
  recoverPage: (preferredUrl?: string) => Promise<Page | null>;
  recoverWorkflow: (reason?: string) => Promise<Page | null>;
  waitWhileNotPaused: () => Promise<void>;
  signal?: AbortSignal;
  onRateLimited?: (cooldownMinutes: number) => void;
  onSlotDetected?: (info: SlotDetectedInfo) => void;
  onRefreshFailed?: () => void;
  onRefreshSucceeded?: () => void;
  onWorkflowRecoveryFailed?: () => void;
};

const defaultRuntime: ResolvedMonitorRuntime = {
  log: (level: MonitorEventLevel, message: string) => logger[level](message),
  waitForUser: async (message: string) => askEnter(message),
  recoverPage: async () => null,
  recoverWorkflow: async () => null,
  waitWhileNotPaused: async () => undefined
};

const askEnter = async (message: string): Promise<void> => {
  const readline = createInterface({ input, output });
  try {
    await readline.question(`${message}\n> `);
  } finally {
    readline.close();
  }
};

const resolveRuntime = (runtime?: MonitorRuntime): ResolvedMonitorRuntime => ({
  botName: runtime?.botName,
  category: runtime?.category,
  log: runtime?.log ?? defaultRuntime.log,
  waitForUser: runtime?.waitForUser ?? defaultRuntime.waitForUser,
  recoverPage: runtime?.recoverPage ?? defaultRuntime.recoverPage,
  recoverWorkflow: runtime?.recoverWorkflow ?? defaultRuntime.recoverWorkflow,
  waitWhileNotPaused: runtime?.waitWhileNotPaused ?? defaultRuntime.waitWhileNotPaused,
  signal: runtime?.signal,
  onRateLimited: runtime?.onRateLimited,
  onSlotDetected: runtime?.onSlotDetected,
  onRefreshFailed: runtime?.onRefreshFailed,
  onRefreshSucceeded: runtime?.onRefreshSucceeded,
  onWorkflowRecoveryFailed: runtime?.onWorkflowRecoveryFailed
});

export const waitForUserToStart = async (runtime?: MonitorRuntime): Promise<void> => {
  const resolved = resolveRuntime(runtime);
  resolved.log("info", "User Connecte manuellement.");
  resolved.log("info", "Validez les controles humains si necessaire.");
  resolved.log("info", "Quand la page de rendez-vous est prete, validez dans l'application.");
  await resolved.waitForUser("Validez quand la page de rendez-vous est prete.");
};

// HOTFIX 0.2.3 (correctif Cloudflare/validation humaine pendant le recovery):
// exportes pour reutilisation par agentMonitoringRuntime.ts - LA MEME fenetre
// humaine "deja prevue par l'application" (jamais une seconde constante
// divergente), pour qu'un challenge Cloudflare rencontre PENDANT le recovery
// workflow n'ait jamais a inventer sa propre notion de patience.
export const HUMAN_BLOCK_GRACE_MS = 4 * 60 * 1000;
const HUMAN_RECHECK_INTERVAL_MS = 15_000;

// La plupart des blocages (captcha, transition de session...) se resolvent seuls
// en quelques dizaines de secondes. On sonde silencieusement pendant la fenetre
// de grace: si la condition qui a declenche la pause disparait d'elle-meme, on
// reprend sans jamais afficher de prompt ni solliciter l'humain.
export const waitForConditionToClear = async (
  page: Page,
  isStillBlocked: () => Promise<boolean>,
  signal?: AbortSignal,
  // Override TEST UNIQUEMENT (jamais en production sans configuration
  // explicite, cf. agentMonitoringRuntime.ts) - defaut inchange sinon.
  graceMs: number = HUMAN_BLOCK_GRACE_MS
): Promise<boolean> => {
  const deadline = Date.now() + graceMs;

  while (Date.now() < deadline) {
    // Lot 4: un STOP_BOT ne doit jamais rester coince jusqu'a 4 minutes dans
    // cette attente silencieuse. On sort immediatement (traite comme
    // "resolu") pour laisser l'appelant constater l'annulation a la
    // prochaine verification en tete de boucle.
    if (signal?.aborted) {
      return true;
    }

    if (page.isClosed()) {
      return true;
    }

    if (!(await isStillBlocked().catch(() => false))) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, HUMAN_RECHECK_INTERVAL_MS));
  }

  return false;
};

export const pauseForHuman = async (
  reason: string,
  runtime?: MonitorRuntime,
  page?: Page,
  isStillBlocked?: () => Promise<boolean>
): Promise<void> => {
  const resolved = resolveRuntime(runtime);
  resolved.log("warn", `Intervention humaine potentiellement requise: ${reason}`);

  if (resolved.signal?.aborted) {
    return;
  }

  if (page && isStillBlocked) {
    const cleared = await waitForConditionToClear(page, isStillBlocked, resolved.signal);
    if (resolved.signal?.aborted) {
      return;
    }
    if (cleared) {
      resolved.log("success", "Situation resolue automatiquement, reprise de la surveillance sans intervention.");
      return;
    }

    resolved.log("warn", `Toujours bloque apres ${HUMAN_BLOCK_GRACE_MS / 60_000} min: ${reason}`);
  }

  await resolved.waitForUser("Validez pour reprendre la surveillance.");
};

const alertAndPause = async (
  reason: string,
  runtime: ResolvedMonitorRuntime,
  page?: Page,
  isStillBlocked?: () => Promise<boolean>
): Promise<void> => {
  runtime.log("error", "ALERTE_UTILISATEUR");
  runtime.log("error", reason);
  process.stdout.write("\u0007");
  await pauseForHuman(reason, runtime, page, isStillBlocked);
};

const isTargetClosedError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /target page, context or browser has been closed|browser has been closed|context has been closed|page has been closed/i.test(message);
};

const recoverAfterTargetClosed = async (
  runtime: ResolvedMonitorRuntime,
  preferredUrl?: string
): Promise<Page | null> => {
  runtime.log("warn", "Connexion a l'onglet perdue. Tentative de recuperation dans le Chrome client.");
  const recoveredPage = await runtime.recoverPage(preferredUrl);

  if (!recoveredPage) {
    runtime.log("warn", "Navigateur du bot ferme ou deconnecte. Redemarrez le bot depuis l'interface.");
    return null;
  }

  runtime.log("success", "Onglet du bot recupere. Surveillance reprise.");
  return recoveredPage;
};

const safeScreenshot = async (page: Page, prefix: string): Promise<void> => {
  if (page.isClosed()) {
    return;
  }

  await takeTimestampedScreenshot(page, prefix).catch((error) => {
    if (isTargetClosedError(error)) {
      return;
    }

    logger.warn(`Screenshot impossible: ${error instanceof Error ? error.message : String(error)}`);
  });
};

const pageDomain = (page: Page): string => {
  try {
    const hostname = new URL(page.url()).hostname;
    return hostname || "local";
  } catch {
    return "local";
  }
};

const readVisibleText = async (page: Page, selector: string): Promise<string | null> => {
  const locator = page.locator(selector).first();

  if (!(await locator.isVisible().catch(() => false))) {
    return null;
  }

  return (await locator.innerText().catch(() => "")).trim() || null;
};

const normalizePageText = (text: string): string => text
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[’']/g, "'")
  .toLowerCase();

const detectOnCurrentMonth = async (
  page: Page,
  runtime: ResolvedMonitorRuntime
): Promise<Awaited<ReturnType<typeof detectAppointmentAvailability>>> => {
  const currentMonth = await readVisibleText(
    page,
    '[data-testid="btn-current-month-available"], [data-testid="btn-current-month-unavailable"]'
  );

  runtime.log("info", `Mois analyse: ${currentMonth ?? "mois courant visible"}`);
  const availableSlotCount = await page.locator('button[data-testid="btn-available-slot"], button[class*="AppointmentHour_appointment-hour"]:not([disabled])')
    .count()
    .catch(() => 0);
  if (availableSlotCount > 0) {
    runtime.log("success", `Slots disponibles DOM: ${availableSlotCount}`);
  }
  return detectAppointmentAvailability(page);
};

const detectUnexpectedPageReason = async (page: Page): Promise<string | null> => {
  const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
  const url = page.url();
  const text = normalizePageText(bodyText);
  const normalizedUrl = url.toLowerCase();

  if (
    /error\s*1015/i.test(bodyText)
    || /rate limited|temporarily banned/i.test(bodyText)
    || /error\s*1015|rate-limited/i.test(normalizedUrl)
  ) {
    return `Blocage TLS/Cloudflare detecte: erreur 1015 / rate limit. Arretez les recherches sur ce site et laissez le cooldown avant de reprendre. URL: ${url}`;
  }

  if (
    text.includes("verification de securite en cours")
    || text.includes("verifiez que vous etes humain")
    || text.includes("checking if the site connection is secure")
    || text.includes("verify you are human")
    || normalizedUrl.includes("__cf_chl_tk")
  ) {
    return `Validation humaine TLS/Cloudflare detectee. Terminez la verification dans le navigateur du bot, revenez sur la page de rendez-vous, puis cliquez Valider/continuer. URL: ${url}`;
  }

  if (
    /\/i2-auth\/|\/login/i.test(normalizedUrl)
    || (text.includes("connectez-vous") && text.includes("mot de passe"))
    || (text.includes("adresse electronique") && text.includes("mot de passe"))
  ) {
    return `Session TLS expiree: page de connexion detectee. Reconnectez-vous manuellement, retournez sur la page de rendez-vous, puis cliquez Valider/continuer. URL: ${url}`;
  }

  if (
    /visas-fr\.tlscontact\.com\/fr-fr\/?$/i.test(normalizedUrl)
    || (text.includes("bienvenue sur tlscontact") && text.includes("prendre un rendez-vous"))
  ) {
    return `Session TLS sortie du workflow: le navigateur est revenu a l'accueil TLScontact. Retournez manuellement sur la page Prise de rendez-vous, puis cliquez Valider/continuer. URL: ${url}`;
  }

  // HOTFIX 0.2.3 (cas reel observe): exception cote client Next.js/React -
  // TLScontact affiche une page d'erreur applicative generique au lieu du
  // contenu attendu, alors qu'un simple refresh manuel restaure immediatement
  // la vraie page (confirme en reel). Classification DISTINCTE des motifs
  // generiques ci-dessous (isClientSideExceptionReason la reconnait
  // explicitement) car elle declenche une strategie differente: un refresh
  // simple d'abord, jamais un goto/reload agressif comme pour Cloudflare/1015.
  // Volontairement etroit (uniquement cette formulation precise et sa
  // variante courte) - jamais un motif "erreur" generique qui capturerait
  // trop de cas differents.
  if (/application error:?\s*a client-side exception has occurred|client-side exception has occurred/i.test(bodyText)) {
    return `Erreur applicative TLS (exception cote client) detectee: application instable, page inexploitable. URL: ${url}`;
  }

  const patterns = [
    /bad gateway/i,
    /error code 502/i,
    /service unavailable/i,
    /gateway timeout/i,
    /error code 503/i,
    /error code 504/i,
    /error 1015/i,
    /rate limited/i,
    /temporarily banned/i,
    /host error/i,
    /page not found/i,
    /session expired/i,
    /session expirée/i,
    /this site can.?t be reached/i,
    /err_connection/i,
    /err_timed_out/i,
    /err_network/i
  ];
  const match = patterns.find((pattern) => pattern.test(bodyText) || pattern.test(url));

  if (match) {
    return `Page inattendue detectee: ${match.source}. Verifiez le navigateur du bot, remettez la page de rendez-vous si necessaire, puis cliquez Valider/continuer. URL: ${url}`;
  }

  return null;
};

const isRateLimitReason = (reason: string): boolean =>
  /1015|rate limited|temporarily banned/i.test(reason);

const isClientSideExceptionReason = (reason: string): boolean =>
  /exception cote client|client-side exception/i.test(reason);

const isReloadableWorkflowUrl = (rawUrl: string): boolean => {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

// HOTFIX 0.2.3 (niveau 1 de recovery - refresh simple): un simple
// page.reload() de la MEME page (jamais un goto() vers une autre URL) a
// suffi en reel a restaurer la page apres une exception cote client - donc
// on l'essaie EN PREMIER, avant le recovery workflow complet (niveau 2,
// beaucoup plus couteux). Section 3 du hotfix: jamais plus d'un reload
// "normal" + un seul reload supplementaire, UNIQUEMENT si le premier a
// echoue pour une raison technique (reseau/timeout) - jamais une boucle de
// reload agressive.
const CLIENT_SIDE_EXCEPTION_RELOAD_TIMEOUT_MS = 20_000;
const CLIENT_SIDE_EXCEPTION_READY_WAIT_MS = 18_000;

const attemptQuickRefresh = async (
  page: Page,
  runtime: ResolvedMonitorRuntime
): Promise<boolean> => {
  const tryReloadOnce = async (): Promise<boolean> => {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: CLIENT_SIDE_EXCEPTION_RELOAD_TIMEOUT_MS });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      runtime.log("warn", `Refresh simple: tentative de reload en echec technique (${message}).`);
      return false;
    }
  };

  runtime.log("info", "Refresh simple (erreur applicative TLS): tentative de restauration sans repartir vers l'URL cible.");
  let reloaded = await tryReloadOnce();
  if (!reloaded && !page.isClosed()) {
    runtime.log("warn", "Premier refresh en echec technique: un second refresh est tente (jamais davantage pour cet episode).");
    reloaded = await tryReloadOnce();
  }
  if (!reloaded || page.isClosed()) {
    return false;
  }

  const deadline = Date.now() + CLIENT_SIDE_EXCEPTION_READY_WAIT_MS;
  while (Date.now() < deadline) {
    if (page.isClosed()) {
      return false;
    }
    if (await isAppointmentPageReady(page)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return isAppointmentPageReady(page);
};

const hasMovedPastAppointmentPage = async (page: Page): Promise<boolean> => {
  const url = page.url();
  if (!/\/workflow\/appointment-booking\//i.test(url)) {
    return true;
  }

  const bodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  return /assurance voyage|recapitulatif|récapitulatif|paiement|services additionnels|payment|review/i.test(bodyText)
    && !/selectionnez un creneau|sélectionnez un créneau/i.test(bodyText);
};

const hasReservationConfirmation = async (page: Page): Promise<boolean> => {
  if (/\/workflow\/order-summary\//i.test(page.url())) {
    return true;
  }

  const bodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  const text = normalizePageText(bodyText);
  return text.includes("resume de la commande")
    || text.includes("recapitulatif de la commande")
    || text.includes("rendez-vous au centre de visas")
    || text.includes("rendez-vous reserve pour");
};

const detectSlotUnavailableAfterReserve = async (page: Page): Promise<boolean> => {
  if (!/\/workflow\/appointment-booking\//i.test(page.url())) {
    return false;
  }

  const bodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  const text = normalizePageText(bodyText);
  return text.includes("creneau n'est plus disponible")
    || text.includes("creneau nest plus disponible")
    || text.includes("creneau plus disponible")
    || text.includes("creneau indisponible")
    || text.includes("rendez-vous n'est plus disponible")
    || text.includes("rendez-vous nest plus disponible")
    || text.includes("slot is no longer available")
    || text.includes("appointment is no longer available")
    || text.includes("no longer available");
};

const hasNoSlotsMessage = async (page: Page): Promise<boolean> => {
  const bodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  const text = normalizePageText(bodyText);
  return text.includes("nous n'avons actuellement plus de creneaux de rendez-vous disponibles")
    || text.includes("nous navons actuellement plus de creneaux de rendez-vous disponibles")
    || text.includes("plus de creneaux de rendez-vous disponibles")
    || text.includes("aucun creneau n'est disponible")
    || text.includes("aucun creneau nest disponible")
    || text.includes("no appointment slots")
    || text.includes("no appointments available")
    || text.includes("currently no appointment");
};

const markCandidateAsTried = async (candidate: CandidateElementResult): Promise<void> => {
  await candidate.locator.evaluate((node) => {
    (node as HTMLElement).setAttribute("data-rdv-agent-tried", "true");
  }).catch(() => undefined);
};

const tryReserveAvailableSlots = async (
  page: Page,
  initialCandidate: CandidateElementResult,
  runtime: ResolvedMonitorRuntime
): Promise<"reserved" | "manual-needed" | "exhausted"> => {
  let candidate: CandidateElementResult | null = initialCandidate;

  for (let attempt = 1; attempt <= 12 && candidate; attempt += 1) {
    runtime.log("warn", `Tentative reservation slot ${attempt}/12: ${candidate.text || "horaire candidat"}.`);
    await markCandidateAsTried(candidate);
    await candidate.locator.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
    await candidate.locator.click({ timeout: 5_000 });
    runtime.log("info", "Slot selectionne automatiquement. Recherche du bouton 'Reservez votre rendez-vous'.");
    await page.waitForTimeout(800);

    const reserveButton = await findReserveAppointmentButton(page);
    if (!reserveButton) {
      runtime.log("warn", "Horaire clique, mais bouton 'Reservez votre rendez-vous' introuvable ou inactif.");
      candidate = await findBestCandidateElement(page);
      continue;
    }

    await reserveButton.locator.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
    await highlightElement(page, reserveButton.locator);

    runtime.log("warn", "Slot deja selectionne. Tentative de clic sur 'Reservez votre rendez-vous'.");
    await reserveButton.locator.click({ timeout: 5_000 });

    const confirmedByUrl = await page.waitForURL(/\/workflow\/order-summary\//i, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_000);

    if (confirmedByUrl || await hasReservationConfirmation(page)) {
      runtime.log("success", "Reservation confirmee par URL ou contenu order-summary.");
      return "reserved";
    }

    if (await detectSlotUnavailableAfterReserve(page)) {
      runtime.log("warn", "Slot refuse par TLS: creneau plus disponible. Essai rapide du prochain slot.");
      candidate = await findBestCandidateElement(page);
      continue;
    }

    if (await hasMovedPastAppointmentPage(page)) {
      runtime.log("warn", `Le site a quitte appointment-booking sans order-summary confirme. URL actuelle: ${page.url()}`);
      return "manual-needed";
    }

    runtime.log("warn", "Clic reservation envoye, mais TLS reste sur appointment-booking. Essai du prochain slot disponible.");
    candidate = await findBestCandidateElement(page);
  }

  return "exhausted";
};

const waitForPageReadyAfterRefresh = async (
  page: Page,
  runtime: ResolvedMonitorRuntime
): Promise<boolean> => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (page.isClosed()) {
      return false;
    }

    runtime.log("info", `Attente post-refresh ${attempt}/3: 10000ms.`);
    await page.waitForTimeout(10_000);

    if (await isAppointmentPageReady(page)) {
      runtime.log("info", "Page prete apres refresh.");
      return true;
    }
  }

  return false;
};

const waitForReloadToSettle = async (
  page: Page,
  runtime: ResolvedMonitorRuntime
): Promise<{ settled: boolean; error?: unknown }> => {
  let settled = false;
  let reloadError: unknown;

  const reload = page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 })
    .catch((error) => {
      reloadError = error;
    })
    .finally(() => {
      settled = true;
    });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.waitForTimeout(10_000);

    if (settled) {
      if (reloadError) {
        runtime.log("warn", `Refresh termine avec avertissement apres attente ${attempt}/3.`);
      } else {
        runtime.log("info", `Refresh termine apres attente ${attempt}/3.`);
      }
      await reload;
      return { settled: true, error: reloadError };
    }

    runtime.log("warn", `Refresh encore en cours apres ${attempt * 10}s.`);
  }

  return { settled: false };
};

const waitMonthClickDelay = async (
  config: AppConfig,
  runtime: ResolvedMonitorRuntime
): Promise<void> => {
  await waitRandomDelay(
    config.monthClickMinDelayMs,
    config.monthClickMaxDelayMs,
    runtime.log,
    "Attente entre changements de mois",
    undefined,
    undefined,
    runtime.signal
  );
};

const returnToFirstAccessibleMonth = async (
  page: Page,
  config: AppConfig,
  runtime: ResolvedMonitorRuntime
): Promise<void> => {
  for (let index = 0; index < 24; index += 1) {
    const prevAvailable = page.locator('[data-testid="btn-prev-month-available"]').first();
    if (!(await prevAvailable.isVisible().catch(() => false))) {
      return;
    }

    if (!(await prevAvailable.isEnabled().catch(() => true))) {
      return;
    }

    const prevMonth = (await prevAvailable.innerText().catch(() => "")).trim();
    runtime.log("info", `Retour au mois precedent activable: ${prevMonth || `-${index + 1}`}`);
    await prevAvailable.click();
    await waitMonthClickDelay(config, runtime);
  }
};

const refreshAndWaitForReady = async (
  page: Page,
  runtime: ResolvedMonitorRuntime
): Promise<void> => {
  const reloadResult = await waitForReloadToSettle(page, runtime);

  if (page.isClosed()) {
    throw new Error("Page fermee pendant le refresh.");
  }

  const reloadErrorMessage = reloadResult.error instanceof Error ? reloadResult.error.message : String(reloadResult.error ?? "");
  const reloadTimedOut = /timeout/i.test(reloadErrorMessage);
  if (reloadResult.error && !reloadTimedOut) {
    const unexpectedReason = await detectUnexpectedPageReason(page);
    if (unexpectedReason) {
      throw new Error(unexpectedReason);
    }
    runtime.log("warn", `Refresh a signale une erreur reseau, verification de la page: ${reloadErrorMessage}`);
  }

  if (!reloadResult.settled) {
    const alreadyReady = await isAppointmentPageReady(page);
    if (alreadyReady) {
      runtime.log("warn", "Refresh long, mais la page de rendez-vous est exploitable.");
      return;
    }

    throw new Error(`Refresh toujours en cours apres 30000ms. URL: ${page.url()}`);
  }

  if (reloadTimedOut) {
    runtime.log("warn", "Refresh plus lent que prevu. Verification de la page apres timeout.");
  }

  const ready = await waitForPageReadyAfterRefresh(page, runtime);
  if (!ready) {
    const reason = await detectUnexpectedPageReason(page)
      ?? `La page souhaitee n'est pas revenue apres refresh. URL: ${page.url()}`;
    throw new Error(reason);
  }
};

const detectOnAccessibleMonths = async (
  page: Page,
  config: AppConfig,
  runtime: ResolvedMonitorRuntime
): Promise<Awaited<ReturnType<typeof detectAppointmentAvailability>>> => {
  const maxMonthClicks = config.scanMonthCount === 0 ? 24 : config.scanMonthCount - 1;
  let availability = await detectOnCurrentMonth(page, runtime);
  if (availability.detected) {
    return availability;
  }

  for (let index = 1; index <= maxMonthClicks; index += 1) {
    const unavailableMonth = await readVisibleText(page, '[data-testid="btn-next-month-unavailable"]');
    const nextAvailable = page.locator('[data-testid="btn-next-month-available"]').first();

    if (!(await nextAvailable.isVisible().catch(() => false))) {
      runtime.log("info", `Aucun mois suivant activable. Mois suivant bloque: ${unavailableMonth ?? "non affiche"}`);
      return { detected: false };
    }

    if (!(await nextAvailable.isEnabled().catch(() => true))) {
      runtime.log("info", `Mois suivant visible mais desactive: ${unavailableMonth ?? "non determine"}`);
      return { detected: false };
    }

    const nextMonth = (await nextAvailable.innerText().catch(() => "")).trim();
    runtime.log("info", `Passage au mois suivant activable: ${nextMonth || `+${index}`}`);
    await nextAvailable.click();
    await waitMonthClickDelay(config, runtime);

    availability = await detectOnCurrentMonth(page, runtime);
    if (availability.detected) {
      return availability;
    }
  }

  if (config.scanMonthCount === 0) {
    runtime.log("warn", "Limite de securite atteinte apres 24 mois activables. Verification manuelle recommandee.");
  }

  return { detected: false };
};

// CORRECTIF CIBLE (refresh temporel securise toutes les 20 minutes): quand
// config.controlRefreshIntervalMs est fourni (agent uniquement - absent pour
// legacy_vm/CLI autonome, qui gardent refreshEveryCycles inchange), le refresh
// planifie est du au TEMPS REEL ecoule plutot qu'a un nombre de cycles.
// nextControlRefreshAt est une simple valeur numerique comparee a Date.now()
// a CHAQUE iteration (jamais un setTimeout/setInterval independant): rien a
// annuler, rien ne peut survivre a l'arret de la boucle (STOP_BOT/signal
// aborted, deja verifie en tete de boucle ci-dessous) - et puisqu'elle vit
// dans la fermeture de CET appel de monitorAppointments(), chaque bot a
// necessairement son propre timer (jamais partage entre bots, section
// "MULTI-BOTS" du correctif).
const resolveControlRefreshIntervalMs = (config: AppConfig): number | null => {
  const value = config.controlRefreshIntervalMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
};

export const monitorAppointments = async (
  page: Page,
  config: AppConfig,
  runtime?: MonitorRuntime
): Promise<void> => {
  const resolved = resolveRuntime(runtime);
  let activePage = page;
  let lastKnownUrl = page.url();
  let attempts = 0;

  const controlRefreshIntervalMs = resolveControlRefreshIntervalMs(config);
  // "Quand monitoring commence reellement sur appointment-booking": initialise
  // ici, au tout debut de la boucle (le point d'entree de monitorAppointments
  // est deja, par contrat existant, la page de rendez-vous reelle - agent et
  // legacy_vm n'appellent tous deux cette fonction qu'apres l'avoir atteinte).
  let nextControlRefreshAt = controlRefreshIntervalMs !== null ? Date.now() + controlRefreshIntervalMs : null;
  const scheduleNextControlRefresh = (): void => {
    if (controlRefreshIntervalMs !== null) {
      nextControlRefreshAt = Date.now() + controlRefreshIntervalMs;
    }
  };

  while (config.maxRefreshAttempts === 0 || attempts < config.maxRefreshAttempts) {
    if (resolved.signal?.aborted) {
      resolved.log("info", "Surveillance interrompue (arret demande).");
      return;
    }
    await resolved.waitWhileNotPaused();
    attempts += 1;
    lastKnownUrl = activePage.isClosed() ? lastKnownUrl : activePage.url();
    resolved.log("info", `Surveillance tentative ${attempts}.`);

    const validation = await detectHumanValidation(activePage);
    if (validation.detected) {
      await takeTimestampedScreenshot(activePage, "human-validation");
      await pauseForHuman(
        validation.reason ?? "Validation humaine ou blocage detecte.",
        resolved,
        activePage,
        () => detectHumanValidation(activePage).then((result) => result.detected)
      );
      continue;
    }

    let unexpectedReason = await detectUnexpectedPageReason(activePage);
    // BUG CIBLE 0.2.4 (URL arbitraire pendant le monitoring): apres les
    // controles Cloudflare/CAPTCHA (detectHumanValidation ci-dessus) et les
    // motifs specifiques deja connus (detectUnexpectedPageReason), une page
    // devenue normale mais QUELCONQUE (ex. l'utilisateur remplace
    // volontairement l'URL de Chrome par https://example.com/) ne matchait
    // encore aucun des deux -> le cycle continuait a scanner cette page comme
    // si elle etait appointment-booking. isAppointmentPageReady() (deja la
    // reference partagee pour "cette page est exploitable comme page de
    // rendez-vous", utilisee par VALIDATE_BOT et le refresh planifie) est
    // donc consultee ici aussi: si elle repond non-prete ET qu'aucun motif
    // specifique n'a deja ete detecte, la page est traitee comme "hors
    // workflow" et reinjectee dans EXACTEMENT le meme chemin de recovery que
    // les autres pages inattendues ci-dessous (recoverWorkflow ->
    // classifyRecoveryState -> "unknown" si non reconnue -> retour borne vers
    // recoveryTargetUrl) - jamais une deuxieme architecture de detection/recovery.
    if (!unexpectedReason && !(await isAppointmentPageReady(activePage).catch(() => false))) {
      unexpectedReason = `Page hors workflow detectee: ce n'est plus la page de rendez-vous appointment-booking exploitable. URL: ${activePage.url()}`;
    }
    if (unexpectedReason) {
      const rateLimited = isRateLimitReason(unexpectedReason);
      if (rateLimited) {
        // Section 8 du hotfix 0.2.3: le cooldown existant est le vrai
        // mecanisme de reprise ici (onRateLimited programme deja un retour
        // automatique a MONITORING) - jamais de refresh simple ni d'echec
        // terminal WORKFLOW_RECOVERY_FAILED pour ce cas, comportement
        // historique conserve tel quel ci-dessous.
        applyRateLimitCooldown(pageDomain(activePage), config.rateLimitCooldownMinutes, resolved.log);
        resolved.onRateLimited?.(config.rateLimitCooldownMinutes);
      } else if (isClientSideExceptionReason(unexpectedReason) && isReloadableWorkflowUrl(activePage.url())) {
        // Niveau 1 (section 2 du hotfix 0.2.3): refresh simple de la MEME
        // page, jamais un goto() vers TARGET_URL - un refresh manuel a
        // suffi en reel, donc on l'essaie avant le recovery complet
        // (beaucoup plus couteux et jamais necessaire si ce refresh suffit).
        const refreshed = await attemptQuickRefresh(activePage, resolved);
        if (refreshed) {
          resolved.log("success", "Page de rendez-vous retablie apres refresh. Surveillance reprise.");
          continue;
        }
        resolved.log("warn", "Refresh simple insuffisant: lancement du recovery workflow complet.");
      }

      const recoveredPage = await resolved.recoverWorkflow(unexpectedReason);
      if (recoveredPage) {
        activePage = recoveredPage;
        lastKnownUrl = activePage.url();
        // "Apres un recovery complet reussi qui ramene a appointment-booking":
        // repart pour un cycle complet de 20 min (agent) - sans effet si le
        // refresh de controle temporel n'est pas configure (legacy_vm/CLI).
        scheduleNextControlRefresh();
        resolved.log("success", "Page de rendez-vous retrouvee automatiquement. Surveillance reprise.");
        continue;
      }

      if (rateLimited) {
        await safeScreenshot(activePage, "unexpected-page");
        await alertAndPause(
          unexpectedReason,
          resolved,
          activePage,
          () => detectUnexpectedPageReason(activePage).then((result) => result !== null)
        );
        continue;
      }

      // Section 9/10 du hotfix 0.2.3: echec terminal apres refresh + recovery
      // complet (toutes tentatives bornees) - jamais une nouvelle boucle
      // silencieuse ici (l'ancienne 4e minute de grace supplementaire de
      // alertAndPause est explicitement retiree pour ce cas precis, deja
      // alertable directement). Le Chrome/la page restent ouverts (aucune
      // fermeture ici); seule la boucle de surveillance s'arrete.
      await safeScreenshot(activePage, "unexpected-page");
      resolved.log("error", "Recuperation automatique impossible apres refresh simple et recovery workflow complet (WORKFLOW_RECOVERY_FAILED).");
      resolved.onWorkflowRecoveryFailed?.();
      return;
    }

    const domain = pageDomain(activePage);
    const groupKey = resolved.category ? `${domain}::${resolved.category}` : domain;
    await waitForScanTurn({
      botName: resolved.botName,
      domain: groupKey,
      settings: config,
      log: resolved.log,
      signal: resolved.signal
    });
    if (resolved.signal?.aborted) {
      resolved.log("info", "Surveillance interrompue (arret demande).");
      return;
    }

    let availability: Awaited<ReturnType<typeof detectAppointmentAvailability>>;
    try {
      availability = await detectOnAccessibleMonths(activePage, config, resolved);
      if (!availability.detected) {
        await returnToFirstAccessibleMonth(activePage, config, resolved);
      }
    } finally {
      releaseScanTurn(groupKey, resolved.log);
    }

    if (availability.detected) {
      const candidate = await findBestCandidateElement(activePage);
      if (!candidate) {
        resolved.log("warn", "Signal de disponibilite ignore: aucun horaire ou bouton cliquable fiable trouve.");
        resolved.log("info", "AUCUN_CRENEAU_DETECTE");

        if (isAppointmentSignalActive(groupKey)) {
          resolved.log("warn", "Mode creneau actif: aucun element cliquable fiable. Refresh rapide et nouvelle recherche.");
          try {
            await refreshAndWaitForReady(activePage, resolved);
          } catch (error) {
            const reason = `Refresh rapide impossible en mode creneau: ${error instanceof Error ? error.message : String(error)}`;
            await safeScreenshot(activePage, "reload-error");
            await alertAndPause(reason, resolved);
          }
          continue;
        }

        await waitRandomDelay(
          config.botCycleCooldownMinMs,
          config.botCycleCooldownMaxMs,
          resolved.log,
          "Attente avant nouveau cycle",
          groupKey,
          resolved.botName,
          resolved.signal
        );
        continue;
      }

      resolved.log("success", "CRENEAU_POTENTIEL_DETECTE");
      resolved.log("info", `Date/heure: ${availability.dateTimeHint ?? candidate.text ?? "non determinee"}`);
      resolved.log("info", `Texte trouve: ${availability.textFound ?? candidate.text ?? "non determine"}`);
      resolved.onSlotDetected?.({
        textFound: availability.textFound ?? candidate.text,
        dateTimeHint: availability.dateTimeHint ?? candidate.text
      });
      broadcastAppointmentSignal(groupKey, resolved.botName, resolved.log);
      await takeTimestampedScreenshot(activePage, "appointment-detected");
      await highlightElement(activePage, candidate.locator);
      process.stdout.write("\u0007");
      resolved.log("warn", "Creneau potentiel detecte. Tentative de selection automatique du slot surligne.");
      try {
        const reserveResult = await tryReserveAvailableSlots(activePage, candidate, resolved);

        if (reserveResult === "reserved") {
          resolved.log("success", "RENDEZ_VOUS_RESERVE_TEMPORAIRE");
          resolved.log("info", "Reservation confirmee: URL/contenu order-summary detecte.");
          scheduleReservationHoldRecheck(groupKey, resolved.botName, resolved.log);
          await resolved.waitForUser("Rendez-vous reserve temporairement. Continuez manuellement les etapes suivantes, puis validez si vous voulez reprendre.");
          return;
        }

        if (reserveResult === "manual-needed") {
          resolved.log("warn", "Etat inattendu apres clic reservation. Verification humaine demandee avant d'envoyer une alerte de reservation.");
          await resolved.waitForUser("Le bot a clique un creneau, mais order-summary n'est pas confirme. Verifiez la page, puis validez si vous voulez reprendre.");
          return;
        }

        resolved.log("warn", "Mode creneau actif: aucun slot reserve apres plusieurs essais. Refresh rapide et nouvelle recherche.");
        await refreshAndWaitForReady(activePage, resolved);
        continue;
      } catch (error) {
        resolved.log("warn", `Creneau detecte, mais tentative automatique incomplete: ${error instanceof Error ? error.message : String(error)}`);
        await refreshAndWaitForReady(activePage, resolved);
        continue;
      }
    }

    resolved.log("info", "AUCUN_CRENEAU_DETECTE");

    if (isAppointmentSignalActive(groupKey)) {
      if (await hasNoSlotsMessage(activePage)) {
        clearAppointmentSignal(groupKey, "message officiel aucun creneau disponible", resolved.log);
      } else {
        resolved.log("warn", "Mode creneau actif: aucun creneau confirme. Refresh rapide et nouveau balayage.");
        try {
          await refreshAndWaitForReady(activePage, resolved);
        } catch (error) {
          const reason = `Refresh rapide impossible en mode creneau: ${error instanceof Error ? error.message : String(error)}`;
          await safeScreenshot(activePage, "reload-error");
          await alertAndPause(reason, resolved);
        }
        continue;
      }
    }

    // CORRECTIF CIBLE (refresh temporel securise toutes les 20 minutes):
    // point d'entree UNIQUE du refresh planifie, atteint UNIQUEMENT depuis un
    // "point sur" deja garanti par tout ce qui precede dans cette iteration:
    // ni validation humaine/Cloudflare (deja gere plus haut, `continue` avant
    // d'arriver ici), ni page inattendue/rate-limit (idem), ni creneau
    // detecte/en cours de reservation (return/continue avant ce point, jamais
    // atteint pendant un tryReserveAvailableSlots en cours), ni mode creneau
    // actif (branche ci-dessus, deja `continue`e). Le refresh planifie ne
    // peut donc jamais interrompre une operation critique - il n'est meme
    // jamais evalue pendant qu'une telle operation est en cours.
    //
    // Deux cadences mutuellement exclusives (jamais combinees): si
    // controlRefreshIntervalMs est configure (agent), le declencheur est le
    // TEMPS REEL ecoule (nextControlRefreshAt) - refreshEveryCycles est alors
    // ignore pour ce declenchement. Sinon (legacy_vm/CLI autonome, champ
    // absent), comportement 0.2.3 inchange: cycle-count via refreshEveryCycles.
    const controlRefreshDue = controlRefreshIntervalMs !== null
      && nextControlRefreshAt !== null
      && Date.now() >= nextControlRefreshAt;
    const cycleRefreshDue = controlRefreshIntervalMs === null
      && config.refreshEveryCycles > 0
      && attempts % config.refreshEveryCycles === 0;

    if (controlRefreshDue || cycleRefreshDue) {
      // CORRECTIF CIBLE (retour vers TARGET_URL apres expiration session TLS):
      // si la page est DEJA sur l'accueil TLS deconnecte juste avant ce
      // refresh planifie, un reload() de /fr-fr ne servirait a rien (TLS y
      // reste) - on declenche directement le recovery pilote par etat
      // (goto(targetUrl) via classifyRecoveryState/recoverWorkflowOnce), sans
      // jamais compter cela comme un echec de refresh. Comportement inchange
      // pour toute autre page.
      if (!activePage.isClosed() && isTlsLoggedOutLandingPage(activePage.url())) {
        resolved.log(
          "warn",
          "Accueil TLS deconnecte detecte juste avant le refresh planifie: recovery direct vers targetUrl (aucun reload de /fr-fr)."
        );
        const recoveredPage = await resolved.recoverWorkflow("Accueil TLS deconnecte detecte avant refresh planifie.");
        if (recoveredPage) {
          activePage = recoveredPage;
          lastKnownUrl = activePage.url();
          resolved.onRefreshSucceeded?.();
          scheduleNextControlRefresh();
          resolved.log("success", "Page de rendez-vous retrouvee automatiquement (recovery avant refresh planifie). Surveillance reprise.");
          continue;
        }

        // Ni echec de refresh comptabilise, ni nouveau timer programme ici:
        // le refresh de controle reste "du" (pending) et sera retente au
        // prochain point sur, jamais un rattrapage en rafale (section
        // "DEMARRAGE DU TIMER" du correctif: un seul refresh, jamais plusieurs
        // accumules).
        resolved.log(
          "warn",
          "Recovery avant refresh planifie non abouti pour cette tentative: nouvel essai au prochain cycle (aucun echec de refresh comptabilise)."
        );
        continue;
      }

      resolved.log(
        "info",
        controlRefreshIntervalMs !== null
          ? `Refresh de controle planifie (${Math.round(controlRefreshIntervalMs / 60_000)} min ecoulees).`
          : `Refresh planifie apres ${config.refreshEveryCycles} cycle(s) sans creneau.`
      );
      try {
        if (activePage.isClosed()) {
          const recovered = await recoverAfterTargetClosed(resolved, lastKnownUrl);
          if (!recovered) {
            return;
          }
          activePage = recovered;
          lastKnownUrl = activePage.url();
        }

        lastKnownUrl = activePage.url();
        await refreshAndWaitForReady(activePage, resolved);
        resolved.onRefreshSucceeded?.();
        // CAS A du correctif (refresh reussi, toujours sur appointment-booking):
        // aucune notification speciale, le timer repart simplement pour un
        // cycle complet - sans effet si le refresh de controle n'est pas
        // configure (legacy_vm/CLI).
        scheduleNextControlRefresh();
      } catch (error) {
        if (isTargetClosedError(error)) {
          const recovered = await recoverAfterTargetClosed(resolved, lastKnownUrl);
          if (!recovered) {
            return;
          }
          activePage = recovered;
          lastKnownUrl = activePage.url();
          continue;
        }

        const reason = `Refresh impossible ou page instable: ${error instanceof Error ? error.message : String(error)}`;
        const rateLimited = isRateLimitReason(reason);

        if (rateLimited) {
          // RATE LIMIT (comportement existant strictement conserve): le
          // cooldown deja en place est le seul mecanisme de reprise - jamais
          // de recovery/goto declenche ici "pour tester" si le blocage a leve.
          applyRateLimitCooldown(pageDomain(activePage), config.rateLimitCooldownMinutes, resolved.log);
          resolved.onRateLimited?.(config.rateLimitCooldownMinutes);
        } else if (!activePage.isClosed()) {
          // CAS B/C/D du correctif: le refresh planifie ne s'est PAS termine
          // sur une page prete - plutot que d'alerter directement, on tente
          // d'abord le recovery pilote par etat DEJA EXISTANT
          // (classifyRecoveryState/recoverWorkflowOnce, agentMonitoringRuntime.ts) -
          // couvre logged-out-landing, tout etat intermediaire deja reconnu
          // (home/auth/travel-groups/application-summary/service-level), et
          // desormais aussi un etat "unknown" (tentative bornee de retour vers
          // targetUrl). Jamais une seconde architecture de navigation/recovery
          // ici: exactement le meme recoverWorkflow() deja utilise plus haut
          // pour les pages inattendues detectees en tete de cycle.
          const recoveredPage = await resolved.recoverWorkflow(reason);
          if (recoveredPage) {
            activePage = recoveredPage;
            lastKnownUrl = activePage.url();
            resolved.onRefreshSucceeded?.();
            scheduleNextControlRefresh();
            resolved.log("success", "Page de rendez-vous retrouvee automatiquement (recovery apres refresh planifie). Surveillance reprise.");
            continue;
          }
        }

        resolved.onRefreshFailed?.();
        if (resolved.signal?.aborted) {
          return;
        }
        await safeScreenshot(activePage, "reload-error");
        await alertAndPause(reason, resolved);
      }
    } else if (controlRefreshIntervalMs !== null && nextControlRefreshAt !== null) {
      const remainingMs = Math.max(0, nextControlRefreshAt - Date.now());
      resolved.log("info", `Refresh de controle non du (prochain dans ${Math.ceil(remainingMs / 1_000)}s).`);
    } else {
      resolved.log("info", `Refresh ignore ce cycle. Prochain refresh planifie tous les ${config.refreshEveryCycles || 0} cycle(s).`);
    }

    // BUG CIBLE 0.2.4 (recovery plus reactif - point 1/2): la cadence de scan
    // elle-meme reste EXACTEMENT inchangee (memes bornes min/max) - seule
    // cette pause IDLE devient interruptible. recoverWorkflow n'est JAMAIS
    // appele ici: une seule source de recovery reste en tete de boucle
    // (ci-dessus), cette pause se contente de rendre la main plus tot pour
    // que cette meme logique s'execute plus vite au prochain tour.
    //
    // AUDIT CIBLE 0.2.4 (suite - cas reel signale: URL INCHANGEE mais contenu
    // devenu CAPTCHA/Cloudflare/session expiree/appointment-booking non
    // exploitable): une verification d'URL seule ne peut jamais detecter ce
    // cas (TLS peut afficher un overlay ou remplacer le contenu SANS jamais
    // naviguer). lastContentCheckAt/isCooldownInterrupted() ci-dessous
    // ajoutent une inspection DOM LOCALE (aucune navigation/reload/clic/
    // requete TLS supplementaire - reutilise exactement detectHumanValidation
    // et isAppointmentPageReady, deja les detecteurs de reference partages,
    // jamais une logique de detection dupliquee ici ou dans orchestrator.ts).
    // Cette inspection est plus couteuse qu'une simple lecture d'URL: elle
    // n'est donc rejouee qu'au rythme de HUMAN_RECHECK_INTERVAL_MS (la meme
    // fenetre de sondage silencieux deja utilisee par waitForConditionToClear
    // ci-dessus - jamais une seconde cadence divergente), alors que la
    // verification d'URL/page fermee, elle, reste sondee a chaque tick
    // (INTERRUPT_CHECK_INTERVAL_MS, orchestrator.ts) comme avant.
    let lastCooldownContentCheckAt = 0;
    const isCooldownInterrupted = async (): Promise<boolean> => {
      if (activePage.isClosed() || !appointmentBookingPathPattern.test(activePage.url())) {
        return true;
      }

      const now = Date.now();
      if (now - lastCooldownContentCheckAt < HUMAN_RECHECK_INTERVAL_MS) {
        return false;
      }
      lastCooldownContentCheckAt = now;

      const validation = await detectHumanValidation(activePage).catch(() => ({ detected: false }) as const);
      if (validation.detected) {
        return true;
      }

      return !(await isAppointmentPageReady(activePage).catch(() => true));
    };

    const cooldownResult = await waitRandomDelay(
      config.botCycleCooldownMinMs,
      config.botCycleCooldownMaxMs,
      resolved.log,
      "Attente avant nouveau cycle",
      groupKey,
      resolved.botName,
      resolved.signal,
      isCooldownInterrupted
    );
    if (cooldownResult.interrupted) {
      // Message distinct pour le cas AUDIT (URL identique, contenu devenu
      // inexploitable) - le message historique "la page a quitte
      // appointment-booking" est conserve A L'IDENTIQUE pour le cas ou l'URL
      // a reellement change (deja teste par les Scenarios U/V existants).
      const stillOnAppointmentUrl = !activePage.isClosed() && appointmentBookingPathPattern.test(activePage.url());
      resolved.log(
        "warn",
        stillOnAppointmentUrl
          ? "Attente entre cycles interrompue: contenu appointment-booking devenu inexploitable (CAPTCHA/Cloudflare/session/erreur) sans changement d'URL."
          : "Attente entre cycles interrompue: la page a quitte appointment-booking."
      );
    }
  }

  resolved.log("warn", "Nombre maximum de tentatives atteint.");
};
