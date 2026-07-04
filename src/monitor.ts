import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Page } from "playwright";
import { detectAppointmentAvailability, findBestCandidateElement, findReserveAppointmentButton } from "./detectors.js";
import { detectHumanValidation } from "./humanValidation.js";
import { highlightElement } from "./highlight.js";
import { logger } from "./logger.js";
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

const alertAndStop = (reason: string, runtime: ResolvedMonitorRuntime): never => {
  runtime.log("error", "ALERTE_UTILISATEUR");
  runtime.log("error", reason);
  process.stdout.write("\u0007");
  throw new Error(reason);
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

const readVisibleText = async (page: Page, selector: string): Promise<string | null> => {
  const locator = page.locator(selector).first();

  if (!(await locator.isVisible().catch(() => false))) {
    return null;
  }

  return (await locator.innerText().catch(() => "")).trim() || null;
};

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
  const patterns = [
    /bad gateway/i,
    /error code 502/i,
    /service unavailable/i,
    /gateway timeout/i,
    /error code 503/i,
    /error code 504/i,
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
    return `Page inattendue apres refresh: ${match.source}. URL: ${url}`;
  }

  return null;
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
    await page.waitForTimeout(1_000);

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

    const availability = await detectOnAccessibleMonths(activePage, config, resolved);
    if (availability.detected) {
      const candidate = await findBestCandidateElement(activePage);
      if (!candidate) {
        resolved.log("warn", "Signal de disponibilite ignore: aucun horaire ou bouton cliquable fiable trouve.");
        resolved.log("info", "AUCUN_CRENEAU_DETECTE");
        resolved.log("info", "Refresh immediat de la page.");
        try {
          await activePage.reload({ waitUntil: "domcontentloaded" });
          const ready = await waitForPageReadyAfterRefresh(activePage, resolved);
          if (!ready) {
            const reason = await detectUnexpectedPageReason(activePage)
              ?? `La page souhaitee n'est pas revenue apres refresh. URL: ${activePage.url()}`;
            await safeScreenshot(activePage, "page-not-ready-after-refresh");
            alertAndStop(reason, resolved);
          }
        } catch (error) {
          if (isTargetClosedError(error)) {
            const recovered = await recoverAfterTargetClosed(resolved, lastKnownUrl);
            if (!recovered) {
              return;
            }
            activePage = recovered;
          } else {
            const reason = `Refresh impossible ou page instable: ${error instanceof Error ? error.message : String(error)}`;
            await safeScreenshot(activePage, "reload-error");
            alertAndStop(reason, resolved);
          }
        }
        continue;
      }

      resolved.log("success", "CRENEAU_POTENTIEL_DETECTE");
      resolved.log("info", `Date/heure: ${availability.dateTimeHint ?? candidate.text ?? "non determinee"}`);
      resolved.log("info", `Texte trouve: ${availability.textFound ?? candidate.text ?? "non determine"}`);
      await takeTimestampedScreenshot(activePage, "appointment-detected");
      await highlightElement(activePage, candidate.locator);
      process.stdout.write("\u0007");
      resolved.log("warn", "Creneau potentiel detecte. Tentative de clic automatique sur l'element surligne.");
      try {
        await candidate.locator.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
        await candidate.locator.click({ timeout: 5_000 });
        resolved.log("info", "Horaire clique automatiquement. Recherche du bouton de reservation.");
        await activePage.waitForTimeout(800);

        const reserveButton = await findReserveAppointmentButton(activePage);
        if (!reserveButton) {
          resolved.log("warn", "Horaire clique, mais bouton 'Reservez votre rendez-vous' introuvable ou inactif.");
          await resolved.waitForUser("Horaire clique. Cliquez manuellement sur 'Reservez votre rendez-vous', puis validez si vous voulez reprendre.");
          return;
        }

        await reserveButton.locator.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
        await highlightElement(activePage, reserveButton.locator);
        resolved.log("warn", "Bouton 'Reservez votre rendez-vous' detecte. Tentative de clic automatique.");
        await reserveButton.locator.click({ timeout: 5_000 });
        resolved.log("info", "Bouton 'Reservez votre rendez-vous' clique automatiquement. Continuez manuellement les etapes suivantes.");
        await resolved.waitForUser("Rendez-vous reserve temporairement. Continuez manuellement les etapes suivantes, puis validez si vous voulez reprendre.");
      } catch {
        resolved.log("warn", "Creneau detecte, mais le clic automatique n'a pas pu etre confirme. Cliquez manuellement sur l'element surligne.");
        await resolved.waitForUser("Creneau detecte. Cliquez manuellement sur l'element surligne, puis validez si vous voulez reprendre.");
      }
      return;
    }

    resolved.log("info", "AUCUN_CRENEAU_DETECTE");
    resolved.log("info", "Refresh immediat de la page.");
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
      await activePage.reload({ waitUntil: "domcontentloaded" });
      const ready = await waitForPageReadyAfterRefresh(activePage, resolved);
      if (!ready) {
        if (activePage.isClosed()) {
          const recovered = await recoverAfterTargetClosed(resolved, lastKnownUrl);
          if (!recovered) {
            return;
          }
          activePage = recovered;
          lastKnownUrl = activePage.url();
          continue;
        }

        const reason = await detectUnexpectedPageReason(activePage)
          ?? `La page souhaitee n'est pas revenue apres refresh. URL: ${activePage.url()}`;
        await safeScreenshot(activePage, "page-not-ready-after-refresh");
        alertAndStop(reason, resolved);
      }
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
      await safeScreenshot(activePage, "reload-error");
      alertAndStop(reason, resolved);
    }

    resolved.log("info", "Relance immediate de la recherche apres refresh.");
  }

  resolved.log("warn", "Nombre maximum de tentatives atteint.");
};
