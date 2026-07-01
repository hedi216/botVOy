import { mkdir } from "node:fs/promises";
import { Page } from "playwright";
import { loadConfig } from "./config.js";
import { launchBrowser } from "./browser.js";
import { logger } from "./logger.js";
import { acceptCookiesIfPresent, takeScreenshot } from "./actions.js";
import { detectHumanValidation, pauseForHuman } from "./humanValidation.js";
import { MissionConfig } from "./types.js";
import { analyzePageWithAi } from "./aiAssistant.js";
import { sendNotificationEmail } from "./email.js";
import {
  bookFirstAvailableAppointment,
  continueServices,
  fillApplicantDetails,
  fillAppointmentDetails,
  loginToVfs,
  logoutFromVfs,
  reviewAndGoToPayment,
  startNewBooking
} from "./vfsWorkflow.js";

const ensureArtifacts = async (): Promise<void> => {
  await mkdir("artifacts/screenshots", { recursive: true });
};

const handleHumanValidation = async (page: Page, config: MissionConfig): Promise<void> => {
  const validation = await detectHumanValidation(page);

  if (validation.detected) {
    await pauseForHuman(
      page,
      validation.reason ?? "Validation humaine detectee.",
      config.humanPauseTimeoutMinutes
    );
  }
};

const runStep = async <T>(
  page: Page,
  config: MissionConfig,
  goal: string,
  action: () => Promise<T>
): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    const analysis = await analyzePageWithAi(page, config, goal, error).catch((aiError) => {
      logger.error(`Analyse IA impossible: ${aiError instanceof Error ? aiError.message : String(aiError)}`);
      return null;
    });

    if (analysis) {
      const reason = [
        `Etape non comprise automatiquement: ${goal}`,
        `Diagnostic IA: ${analysis.summary}`,
        analysis.suggestedAction ? `Suggestion: ${analysis.suggestedAction}` : undefined,
        analysis.risk ? `Risque: ${analysis.risk}` : undefined
      ].filter(Boolean).join(" | ");

      await pauseForHuman(page, reason, config.humanPauseTimeoutMinutes);
      return await action();
    }

    throw error;
  }
};

const runBookingAttempt = async (
  page: Page,
  config: MissionConfig
): Promise<"payment-reached" | "no-slot"> => {
  logger.info(`Navigation vers ${config.targetUrl}`);
  await page.goto(config.targetUrl, { waitUntil: "domcontentloaded" });

  await runStep(page, config, "Accepter la banniere cookies si elle existe.", () =>
    acceptCookiesIfPresent(page)
  );
  await handleHumanValidation(page, config);

  await runStep(page, config, "Connexion VFS.", () => loginToVfs(page, config));
  await handleHumanValidation(page, config);

  await runStep(page, config, "Cliquer sur Start New Booking.", () => startNewBooking(page));
  await handleHumanValidation(page, config);

  const slotResult = await runStep(
    page,
    config,
    "Remplir les details du rendez-vous et verifier la disponibilite.",
    () => fillAppointmentDetails(page, config)
  );

  if (slotResult === "no-slot") {
    return "no-slot";
  }

  await handleHumanValidation(page, config);

  await runStep(page, config, "Remplir les informations candidat.", () =>
    fillApplicantDetails(page, config)
  );
  await handleHumanValidation(page, config);

  await runStep(page, config, "Choisir la premiere date et le premier horaire disponible.", () =>
    bookFirstAvailableAppointment(page, config)
  );
  await handleHumanValidation(page, config);

  await runStep(page, config, "Continuer depuis la page Services.", () =>
    continueServices(page, config)
  );
  await handleHumanValidation(page, config);

  await runStep(page, config, "Accepter les conditions et atteindre la page paiement.", () =>
    reviewAndGoToPayment(page)
  );

  return "payment-reached";
};

const main = async (): Promise<void> => {
  await ensureArtifacts();

  const config = loadConfig();
  const { browser, page } = await launchBrowser(config);
  let paymentReached = false;

  try {
    while (!paymentReached) {
      const result = await runBookingAttempt(page, config);

      if (result === "payment-reached") {
        paymentReached = true;
        break;
      }

      await logoutFromVfs(page).catch((error) => {
        logger.warn(`Deconnexion impossible apres absence de slot: ${error instanceof Error ? error.message : String(error)}`);
      });

      logger.info(`Aucun slot. Nouvel essai dans ${config.checkIntervalMinutes} minutes.`);
      await page.waitForTimeout(config.checkIntervalMinutes * 60_000);
    }

    await sendNotificationEmail(
      config,
      "Rendez-vous VFS trouve - paiement requis",
      `Un rendez-vous a ete trouve et la page de paiement est ouverte. Connectez-vous rapidement pour finaliser le paiement. URL actuelle: ${page.url()}`
    );

    logger.success("MVP termine : page de paiement atteinte, email envoye ou simule.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Erreur pendant le workflow: ${message}`);
    await takeScreenshot(page, "error").catch((screenshotError) => {
      logger.error("Impossible de prendre une capture ecran d'erreur.", screenshotError);
    });
    throw error;
  } finally {
    if (paymentReached && !config.headless) {
      logger.info("Le navigateur reste ouvert sur la page de paiement visible.");
      return;
    }

    logger.info("Fermeture propre du navigateur.");
    await browser.close();
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`Arret du bot: ${message}`);
  process.exitCode = 1;
});
