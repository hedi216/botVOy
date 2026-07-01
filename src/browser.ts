import { chromium, Browser, BrowserContext, Page } from "playwright";
import { MissionConfig } from "./types.js";
import { logger } from "./logger.js";

export type BrowserSession = {
  browser: Browser | BrowserContext;
  page: Page;
};

export const launchBrowser = async (config: MissionConfig): Promise<BrowserSession> => {
  const channelText = config.browserChannel ? ` channel=${config.browserChannel}` : "";
  logger.info(`Lancement navigateur headless=${config.headless}, slowMo=${config.slowMoMs}ms${channelText}`);

  if (config.userDataDir) {
    logger.info(`Profil navigateur persistant: ${config.userDataDir}`);

    const context = await chromium.launchPersistentContext(config.userDataDir, {
      channel: config.browserChannel,
      headless: config.headless,
      slowMo: config.slowMoMs,
      viewport: { width: 1366, height: 768 }
    });

    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(10_000);

    return { browser: context, page };
  }

  const browser = await chromium.launch({
    channel: config.browserChannel,
    headless: config.headless,
    slowMo: config.slowMoMs
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(10_000);

  return { browser, page };
};
