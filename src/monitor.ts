import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Page } from "playwright";
import { detectAppointmentAvailability, findBestCandidateElement } from "./detectors.js";
import { detectHumanValidation } from "./humanValidation.js";
import { highlightElement } from "./highlight.js";
import { logger } from "./logger.js";
import { takeTimestampedScreenshot } from "./screenshot.js";
import { AppConfig } from "./types.js";

const askEnter = async (message: string): Promise<void> => {
  const readline = createInterface({ input, output });
  try {
    await readline.question(`${message}\n> `);
  } finally {
    readline.close();
  }
};

export const waitForUserToStart = async (): Promise<void> => {
  logger.info("User Connecte manuellement.");
  logger.info("Validez les controles humains si necessaire.");
  logger.info("Quand la page de rendez-vous est prete, appuyez sur Entree dans le terminal.");
  await askEnter("Appuyez sur Entree pour demarrer la surveillance.");
};

export const pauseForHuman = async (reason: string): Promise<void> => {
  logger.warn(`Intervention humaine requise: ${reason}`);
  await askEnter("Appuyez sur Entree pour reprendre la surveillance.");
};

const readVisibleText = async (page: Page, selector: string): Promise<string | null> => {
  const locator = page.locator(selector).first();

  if (!(await locator.isVisible().catch(() => false))) {
    return null;
  }

  return (await locator.innerText().catch(() => "")).trim() || null;
};

const detectOnCurrentMonth = async (
  page: Page
): Promise<Awaited<ReturnType<typeof detectAppointmentAvailability>>> => {
  const currentMonth = await readVisibleText(
    page,
    '[data-testid="btn-current-month-available"], [data-testid="btn-current-month-unavailable"]'
  );

  logger.info(`Mois analyse: ${currentMonth ?? "mois courant visible"}`);
  return detectAppointmentAvailability(page);
};

const detectOnAccessibleMonths = async (
  page: Page,
  config: AppConfig
): Promise<Awaited<ReturnType<typeof detectAppointmentAvailability>>> => {
  const maxMonthClicks = config.scanMonthCount === 0 ? 24 : config.scanMonthCount - 1;
  let availability = await detectOnCurrentMonth(page);
  if (availability.detected) {
    return availability;
  }

  for (let index = 1; index <= maxMonthClicks; index += 1) {
    const unavailableMonth = await readVisibleText(page, '[data-testid="btn-next-month-unavailable"]');
    const nextAvailable = page.locator('[data-testid="btn-next-month-available"]').first();

    if (!(await nextAvailable.isVisible().catch(() => false))) {
      logger.info(`Aucun mois suivant activable. Mois suivant bloque: ${unavailableMonth ?? "non affiche"}`);
      return { detected: false };
    }

    if (!(await nextAvailable.isEnabled().catch(() => true))) {
      logger.info(`Mois suivant visible mais desactive: ${unavailableMonth ?? "non determine"}`);
      return { detected: false };
    }

    const nextMonth = (await nextAvailable.innerText().catch(() => "")).trim();
    logger.info(`Passage au mois suivant activable: ${nextMonth || `+${index}`}`);
    await nextAvailable.click();
    await page.waitForTimeout(1_000);

    availability = await detectOnCurrentMonth(page);
    if (availability.detected) {
      return availability;
    }
  }

  if (config.scanMonthCount === 0) {
    logger.warn("Limite de securite atteinte apres 24 mois activables. Verification manuelle recommandee.");
  }

  return { detected: false };
};

export const monitorAppointments = async (page: Page, config: AppConfig): Promise<void> => {
  let attempts = 0;

  while (config.maxRefreshAttempts === 0 || attempts < config.maxRefreshAttempts) {
    attempts += 1;
    logger.info(`Surveillance tentative ${attempts}.`);

    const validation = await detectHumanValidation(page);
    if (validation.detected) {
      await takeTimestampedScreenshot(page, "human-validation");
      await pauseForHuman(validation.reason ?? "Validation humaine ou blocage detecte.");
      continue;
    }

    const availability = await detectOnAccessibleMonths(page, config);
    if (availability.detected) {
      logger.success("CRENEAU_POTENTIEL_DETECTE");
      logger.info(`Date/heure: ${availability.dateTimeHint ?? "non determinee"}`);
      logger.info(`Texte trouve: ${availability.textFound ?? "non determine"}`);
      await takeTimestampedScreenshot(page, "appointment-detected");

      const candidate = await findBestCandidateElement(page);
      if (!candidate) {
        await pauseForHuman("Creneau potentiel detecte, mais aucun element cliquable fiable trouve.");
        return;
      }

      await highlightElement(page, candidate.locator);
      process.stdout.write("\u0007");
      logger.warn("Creneau potentiel detecte. Le bot clique l'element surligne puis s'arrete.");
      await candidate.locator.click();
      await pauseForHuman("Element de creneau clique automatiquement. Continuez manuellement les etapes suivantes.");
      return;
    }

    logger.info("AUCUN_CRENEAU_DETECTE");
    await page.waitForTimeout(config.refreshIntervalMs);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(async (error) => {
      await takeTimestampedScreenshot(page, "reload-error");
      await pauseForHuman(`Reload impossible: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  logger.warn("Nombre maximum de tentatives atteint.");
};
