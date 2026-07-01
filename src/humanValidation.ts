import { Page } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { HumanValidationResult } from "./types.js";
import { logger } from "./logger.js";
import { takeScreenshot } from "./actions.js";

const visibleTextPatterns = [
  /captcha/i,
  /robot/i,
  /human/i,
  /verification/i,
  /security check/i,
  /vérification/i,
  /sécurité/i
];

const elementPattern = /recaptcha|hcaptcha|captcha|challenge|cloudflare/i;

export const detectHumanValidation = async (page: Page): Promise<HumanValidationResult> => {
  const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
  const matchedText = visibleTextPatterns.find((pattern) => pattern.test(bodyText));

  if (matchedText) {
    return {
      detected: true,
      reason: `Texte visible détecté: ${matchedText.source}`
    };
  }

  const suspiciousElements = page.locator(
    [
      "iframe[src]",
      "iframe[title]",
      "[id]",
      "[class]",
      "[src]",
      "[title]"
    ].join(", ")
  );

  const count = await suspiciousElements.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const element = suspiciousElements.nth(index);
    const attributes = await element.evaluate((node) => ({
      src: node.getAttribute("src"),
      title: node.getAttribute("title"),
      id: node.getAttribute("id"),
      className: node.getAttribute("class")
    })).catch(() => null);

    if (!attributes) {
      continue;
    }

    const value = Object.values(attributes).filter(Boolean).join(" ");
    if (elementPattern.test(value)) {
      return {
        detected: true,
        reason: `Élément de validation humaine détecté: ${value}`
      };
    }
  }

  return { detected: false };
};

export const pauseForHuman = async (
  page: Page,
  reason: string,
  timeoutMinutes = 15
): Promise<void> => {
  logger.warn(`Intervention humaine requise: ${reason}`);
  await takeScreenshot(page, "human-validation");

  const timeoutMs = timeoutMinutes * 60_000;
  const startedAt = Date.now();
  let reminder5Sent = false;
  let reminder1Sent = false;

  logger.warn(
    "Notification email MVP: une vraie notification SMTP sera ajoutée quand les paramètres mail seront fournis."
  );
  logger.info("Appuyez sur Entrée dans ce terminal après intervention humaine pour continuer.");

  const keepAliveInterval = setInterval(async () => {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    const remainingMinutes = Math.ceil(Math.max(remainingMs, 0) / 60_000);

    if (!reminder5Sent && remainingMs <= 5 * 60_000) {
      reminder5Sent = true;
      logger.warn("Reminder email MVP: arrêt automatique dans moins de 5 minutes.");
    }

    if (!reminder1Sent && remainingMs <= 60_000) {
      reminder1Sent = true;
      logger.warn("Reminder email MVP: arrêt automatique dans moins de 1 minute.");
    }

    logger.info(`Keep-alive navigateur, temps restant environ ${remainingMinutes} min.`);
    await page.locator("body").click({ position: { x: 1, y: 1 }, timeout: 2_000 }).catch(() => undefined);
  }, 60_000);

  const readline = createInterface({ input, output });

  try {
    const humanDone = readline.question("> ");
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Temps d'intervention humaine dépassé.")), timeoutMs);
    });

    await Promise.race([humanDone, timeout]);
    logger.success("Intervention humaine terminée, reprise du workflow.");
  } finally {
    clearInterval(keepAliveInterval);
    readline.close();
  }
};
