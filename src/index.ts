import { loadConfig } from "./config.js";
import { launchBrowser } from "./browser.js";
import { logger } from "./logger.js";
import { monitorAppointments, waitForUserToStart } from "./monitor.js";
import { takeTimestampedScreenshot } from "./screenshot.js";

const main = async (): Promise<void> => {
  const config = loadConfig();
  const { browser, page } = await launchBrowser(config);

  try {
    await waitForUserToStart();
    await monitorAppointments(page, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Erreur: ${message}`);
    await takeTimestampedScreenshot(page, "error").catch(() => undefined);
    throw error;
  } finally {
    if (config.debugKeepBrowserOpen) {
      logger.info("DEBUG_KEEP_BROWSER_OPEN=true, navigateur garde ouvert.");
      return;
    }

    logger.info("Fermeture du navigateur.");
    await browser.close();
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`Arret du bot: ${message}`);
  process.exitCode = 1;
});
