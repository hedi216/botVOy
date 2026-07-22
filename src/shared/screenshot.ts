import { mkdir } from "node:fs/promises";
import { Page } from "playwright";
import { logger } from "../logger.js";

export const takeTimestampedScreenshot = async (
  page: Page,
  prefix: string
): Promise<string> => {
  await mkdir("artifacts/screenshots", { recursive: true });

  const safePrefix = prefix.replace(/[^a-z0-9-_]/gi, "-").toLowerCase();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `artifacts/screenshots/${safePrefix}-${timestamp}.png`;

  await page.screenshot({ path, fullPage: true });
  logger.info(`Screenshot: ${path}`);

  return path;
};
