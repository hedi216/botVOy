import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Page } from "playwright";
import { detectAppointmentAvailability, findBestCandidateElement, findReserveAppointmentButton } from "./detectors.js";
import { detectHumanValidation } from "./humanValidation.js";
import { highlightElement } from "./highlight.js";
import { logger } from "./logger.js";
import { applyRateLimitCooldown, releaseScanTurn, waitForScanTurn, waitRandomDelay } from "./orchestrator.js";
import { takeTimestampedScreenshot } from "./screenshot.js";
import { AppConfig, MonitorEventLevel, MonitorRuntime } from "./types.js";

type ResolvedMonitorRuntime = {
  log: (level: MonitorEventLevel, message: string) => void;
  waitForUser: (message: string) => Promise<void>;
  recoverPage: (preferredUrl?: string) => Promise<Page | null>;
};

const defaultRuntime: ResolvedMonitorRuntime = {
  log: (level: MonitorEventLevel, message: string) => logger[level](message),
  waitForUser: async (message: string) => askEnter(message),
  recoverPage: async () => null
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
  log: runtime?.log ?? defaultRuntime.log,
  waitForUser: runtime?.waitForUser ?? defaultRuntime.waitForUser,
  recoverPage: runtime?.recoverPage ?? defaultRuntime.recoverPage
});

export const waitForUserToStart = async (runtime?: MonitorRuntime): Promise<void> => {
  const resolved = resolveRuntime(runtime);
  resolved.log("info", "User Connecte manuellement.");
  resolved.log("info", "Validez les controles humains si necessaire.");
  resolved.log("info", "Quand la page de rendez-vous est prete, validez dans l'application.");
  await resolved.waitForUser("Validez quand la page de rendez-vous est prete.");
};

export const pauseForHuman = async (reason: string, runtime?: MonitorRuntime): Promise<void> => {
  const resolved = resolveRuntime(runtime);
  resolved.log("warn", `Intervention humaine requise: ${reason}`);
  await resolved.waitForUser("Validez pour reprendre la surveillance.");
};

const alertAndPause = async (reason: string, runtime: ResolvedMonitorRuntime): Promise<void> => {
  runtime.log("error", "ALERTE_UTILISATEUR");
  runtime.log("error", reason);
  process.stdout.write("\u0007");
  await pauseForHuman(reason, runtime);
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

const isAppointmentPageReady = async (page: Page): Promise<boolean> => {
  const currentMonth = page.locator(
    '[data-testid="btn-current-month-available"], [data-testid="btn-current-month-unavailable"]'
  ).first();
  const nextMonth = page.locator(
    '[data-testid="btn-next-month-available"], [data-testid="btn-next-month-unavailable"]'
  ).first();
  const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");

  return (await currentMonth.isVisible().catch(() => false))
    || (await nextMonth.isVisible().catch(() => false))
    || /réservez votre rendez-vous|reservez votre rendez-vous|sélectionnez un créneau|selectionnez un creneau/i.test(bodyText);
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

const hasMovedPastAppointmentPage = async (page: Page): Promise<boolean> => {
  const url = page.url();
  if (!/\/workflow\/appointment-booking\//i.test(url)) {
    return true;
  }

  const bodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  return /assurance voyage|recapitulatif|récapitulatif|paiement|services additionnels|payment|review/i.test(bodyText)
    && !/selectionnez un creneau|sélectionnez un créneau/i.test(bodyText);
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
    "Attente entre changements de mois"
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

export const monitorAppointments = async (
  page: Page,
  config: AppConfig,
  runtime?: MonitorRuntime
): Promise<void> => {
  const resolved = resolveRuntime(runtime);
  let activePage = page;
  let lastKnownUrl = page.url();
  let attempts = 0;

  while (config.maxRefreshAttempts === 0 || attempts < config.maxRefreshAttempts) {
    attempts += 1;
    lastKnownUrl = activePage.isClosed() ? lastKnownUrl : activePage.url();
    resolved.log("info", `Surveillance tentative ${attempts}.`);

    const validation = await detectHumanValidation(activePage);
    if (validation.detected) {
      await takeTimestampedScreenshot(activePage, "human-validation");
      await pauseForHuman(validation.reason ?? "Validation humaine ou blocage detecte.", resolved);
      continue;
    }

    const unexpectedReason = await detectUnexpectedPageReason(activePage);
    if (unexpectedReason) {
      if (isRateLimitReason(unexpectedReason)) {
        applyRateLimitCooldown(pageDomain(activePage), config.rateLimitCooldownMinutes, resolved.log);
      }
      await safeScreenshot(activePage, "unexpected-page");
      await alertAndPause(unexpectedReason, resolved);
      continue;
    }

    const domain = pageDomain(activePage);
    await waitForScanTurn({
      botName: undefined,
      domain,
      settings: config,
      log: resolved.log
    });

    let availability: Awaited<ReturnType<typeof detectAppointmentAvailability>>;
    try {
      availability = await detectOnAccessibleMonths(activePage, config, resolved);
      if (!availability.detected) {
        await returnToFirstAccessibleMonth(activePage, config, resolved);
      }
    } finally {
      releaseScanTurn(domain, resolved.log);
    }

    if (availability.detected) {
      const candidate = await findBestCandidateElement(activePage);
      if (!candidate) {
        resolved.log("warn", "Signal de disponibilite ignore: aucun horaire ou bouton cliquable fiable trouve.");
        resolved.log("info", "AUCUN_CRENEAU_DETECTE");
        await waitRandomDelay(
          config.botCycleCooldownMinMs,
          config.botCycleCooldownMaxMs,
          resolved.log,
          "Attente avant nouveau cycle"
        );
        continue;
      }

      resolved.log("success", "CRENEAU_POTENTIEL_DETECTE");
      resolved.log("info", `Date/heure: ${availability.dateTimeHint ?? candidate.text ?? "non determinee"}`);
      resolved.log("info", `Texte trouve: ${availability.textFound ?? candidate.text ?? "non determine"}`);
      await takeTimestampedScreenshot(activePage, "appointment-detected");
      await highlightElement(activePage, candidate.locator);
      process.stdout.write("\u0007");
      resolved.log("warn", "Creneau potentiel detecte. Tentative de selection automatique du slot surligne.");
      try {
        await candidate.locator.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
        await candidate.locator.click({ timeout: 5_000 });
        resolved.log("info", "Slot selectionne automatiquement. Recherche du bouton 'Reservez votre rendez-vous'.");
        await activePage.waitForTimeout(800);

        const reserveButton = await findReserveAppointmentButton(activePage);
        if (!reserveButton) {
          resolved.log("warn", "Horaire clique, mais bouton 'Reservez votre rendez-vous' introuvable ou inactif.");
          await resolved.waitForUser("Slot selectionne. Cliquez manuellement sur 'Reservez votre rendez-vous', puis validez si vous voulez reprendre.");
          return;
        }

        await reserveButton.locator.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
        await highlightElement(activePage, reserveButton.locator);
        resolved.log("warn", "Slot deja selectionne. Tentative de clic sur 'Reservez votre rendez-vous'.");
        await reserveButton.locator.click({ timeout: 5_000 });
        await activePage.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
        await activePage.waitForTimeout(1_500);

        if (!(await hasMovedPastAppointmentPage(activePage))) {
          resolved.log("warn", "Clic reservation envoye, mais la page n'a pas confirme le passage a l'etape suivante.");
          await resolved.waitForUser("Slot selectionne, mais reservation non confirmee. Cliquez manuellement sur 'Reservez votre rendez-vous', puis validez si vous voulez reprendre.");
          return;
        }

        resolved.log("success", "RENDEZ_VOUS_RESERVE_TEMPORAIRE");
        resolved.log("info", "Slot selectionne puis bouton 'Reservez votre rendez-vous' clique avec confirmation de passage a l'etape suivante.");
        await resolved.waitForUser("Rendez-vous reserve temporairement. Continuez manuellement les etapes suivantes, puis validez si vous voulez reprendre.");
      } catch {
        resolved.log("warn", "Creneau detecte, mais le clic automatique n'a pas pu etre confirme. Cliquez manuellement sur l'element surligne.");
        await resolved.waitForUser("Creneau detecte. Cliquez manuellement sur l'element surligne, puis validez si vous voulez reprendre.");
      }
      return;
    }

    resolved.log("info", "AUCUN_CRENEAU_DETECTE");

    if (config.refreshEveryCycles > 0 && attempts % config.refreshEveryCycles === 0) {
      resolved.log("info", `Refresh planifie apres ${config.refreshEveryCycles} cycle(s) sans creneau.`);
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
        if (isRateLimitReason(reason)) {
          applyRateLimitCooldown(pageDomain(activePage), config.rateLimitCooldownMinutes, resolved.log);
        }
        await safeScreenshot(activePage, "reload-error");
        await alertAndPause(reason, resolved);
      }
    } else {
      resolved.log("info", `Refresh ignore ce cycle. Prochain refresh planifie tous les ${config.refreshEveryCycles || 0} cycle(s).`);
    }

    await waitRandomDelay(
      config.botCycleCooldownMinMs,
      config.botCycleCooldownMaxMs,
      resolved.log,
      "Attente avant nouveau cycle"
    );
  }

  resolved.log("warn", "Nombre maximum de tentatives atteint.");
};
