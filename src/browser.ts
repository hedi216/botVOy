import { chromium, Browser, Page } from "playwright";
import { AppConfig } from "./types.js";
import { logger } from "./logger.js";

export type BrowserSession = {
  browser: Browser;
  page: Page;
};

export const launchBrowser = async (config: AppConfig): Promise<BrowserSession> => {
  if (config.connectToExistingChrome) {
    logger.info(`Connexion au Chrome deja ouvert: ${config.chromeDebugUrl}`);

    const browser = await chromium.connectOverCDP(config.chromeDebugUrl);
    const context = browser.contexts()[0] ?? await browser.newContext();
    const usablePages = context.pages().filter((candidate) => {
      const url = candidate.url();
      return !url.startsWith("devtools://")
        && !url.startsWith("chrome://")
        && !url.startsWith("chrome-extension://");
    });
    const page = [...usablePages].reverse().find((candidate) => candidate.url() !== "about:blank")
      ?? usablePages[0]
      ?? await context.newPage();

    page.setDefaultTimeout(8_000);
    await page.bringToFront().catch(() => undefined);

    if (config.targetUrl !== "about:blank" && page.url() === "about:blank") {
      await page.goto(config.targetUrl, { waitUntil: "domcontentloaded" });
    }

    return { browser, page };
  }

  logger.info(`Lancement Chromium visible=${!config.headless}, slowMo=${config.slowMoMs}ms`);

  const browser = await chromium.launch({
    headless: config.headless,
    slowMo: config.slowMoMs
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(8_000);

  if (config.targetUrl !== "about:blank") {
    await page.goto(config.targetUrl, { waitUntil: "domcontentloaded" });
  }

  return { browser, page };
};
