import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Page } from "playwright";
import { detectAppointmentAvailability, findBestCandidateElement } from "./detectors.js";
import { detectHumanValidation } from "./humanValidation.js";
import { highlightElement } from "./highlight.js";
import { logger } from "./logger.js";
import { takeTimestampedScreenshot } from "./screenshot.js";
import { AppConfig, MonitorEventLevel, MonitorRuntime } from "./types.js";

const defaultRuntime: Required<MonitorRuntime> = {
  log: (level: MonitorEventLevel, message: string) => logger[level](message),
  waitForUser: async (message: string) => askEnter(message)
};

const askEnter = async (message: string): Promise<void> => {
  const readline = createInterface({ input, output });
  try {
    await readline.question(`${message}\n> `);
  } finally {
    readline.close();
  }
};

const resolveRuntime = (runtime?: MonitorRuntime): Required<MonitorRuntime> => ({
  log: runtime?.log ?? defaultRuntime.log,
  waitForUser: runtime?.waitForUser ?? defaultRuntime.waitForUser
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

const alertAndStop = (reason: string, runtime: Required<MonitorRuntime>): never => {
  runtime.log("error", "ALERTE_UTILISATEUR");
  runtime.log("error", reason);
  process.stdout.write("\u0007");
  throw new Error(reason);
};

const safeScreenshot = async (page: Page, prefix: string): Promise<void> => {
  await takeTimestampedScreenshot(page, prefix).catch((error) => {
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
  runtime: Required<MonitorRuntime>
): Promise<Awaited<ReturnType<typeof detectAppointmentAvailability>>> => {
  const currentMonth = await readVisibleText(
    page,
    '[data-testid="btn-current-month-available"], [data-testid="btn-current-month-unavailable"]'
  );

  runtime.log("info", `Mois analyse: ${currentMonth ?? "mois courant visible"}`);
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
  runtime: Required<MonitorRuntime>
): Promise<boolean> => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
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
  runtime: Required<MonitorRuntime>
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
  let attempts = 0;

  while (config.maxRefreshAttempts === 0 || attempts < config.maxRefreshAttempts) {
    attempts += 1;
    resolved.log("info", `Surveillance tentative ${attempts}.`);

    const validation = await detectHumanValidation(page);
    if (validation.detected) {
      await takeTimestampedScreenshot(page, "human-validation");
      await pauseForHuman(validation.reason ?? "Validation humaine ou blocage detecte.", resolved);
      continue;
    }

    const availability = await detectOnAccessibleMonths(page, config, resolved);
    if (availability.detected) {
      resolved.log("success", "CRENEAU_POTENTIEL_DETECTE");
      resolved.log("info", `Date/heure: ${availability.dateTimeHint ?? "non determinee"}`);
      resolved.log("info", `Texte trouve: ${availability.textFound ?? "non determine"}`);
      await takeTimestampedScreenshot(page, "appointment-detected");

      const candidate = await findBestCandidateElement(page);
      if (!candidate) {
        await pauseForHuman("Creneau potentiel detecte, mais aucun element cliquable fiable trouve.", resolved);
        return;
      }

      await highlightElement(page, candidate.locator);
      process.stdout.write("\u0007");
      resolved.log("warn", "Creneau potentiel detecte. Le bot clique l'element surligne puis s'arrete.");
      await candidate.locator.click();
      await pauseForHuman("Element de creneau clique automatiquement. Continuez manuellement les etapes suivantes.", resolved);
      return;
    }

    resolved.log("info", "AUCUN_CRENEAU_DETECTE");
    resolved.log("info", "Refresh immediat de la page.");
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      const ready = await waitForPageReadyAfterRefresh(page, resolved);
      if (!ready) {
        const reason = await detectUnexpectedPageReason(page)
          ?? `La page souhaitee n'est pas revenue apres refresh. URL: ${page.url()}`;
        await safeScreenshot(page, "page-not-ready-after-refresh");
        alertAndStop(reason, resolved);
      }
    } catch (error) {
      const reason = `Refresh impossible ou page instable: ${error instanceof Error ? error.message : String(error)}`;
      await safeScreenshot(page, "reload-error");
      alertAndStop(reason, resolved);
    }

    resolved.log("info", "Relance immediate de la recherche apres refresh.");
  }

  resolved.log("warn", "Nombre maximum de tentatives atteint.");
};
