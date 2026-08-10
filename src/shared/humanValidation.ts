import { Page } from "playwright";
import { HumanValidationResult } from "./types.js";

// BUG CIBLE 0.2.4 (session expiree classee a tort comme validation humaine):
// "session expired"/"session expiree"/"session expirée" ont ete retires de
// cette liste - une session expiree n'est PAS un CAPTCHA/Cloudflare/controle
// de securite et ne doit jamais mettre le bot en pause humaine
// (pauseForHuman/WAITING_FOR_USER) quand une reconnexion automatique est
// possible. Ce texte reste neanmoins detecte ailleurs (detectUnexpectedPageReason,
// src/shared/monitor.ts) qui route deja vers le recovery workflow automatique
// (classifyRecoveryState -> "auth" -> fillLoginForm si des credentials sont
// en memoire). Les vraies detections CAPTCHA/Cloudflare/security check/human
// verification ci-dessous restent strictement inchangees.
const blockingTextPatterns = [
  /i'?m not a robot/i,
  /je ne suis pas un robot/i,
  /human verification/i,
  /verification humaine/i,
  /vérification humaine/i,
  /security check/i,
  /controle de securite/i,
  /contrôle de sécurité/i,
  /blocked/i,
  /too many requests/i,
  /access denied/i,
  /acces refuse/i,
  /accès refusé/i
];

const challengeElementPattern = /hcaptcha|captcha|challenge|cloudflare/i;
const passiveCaptchaPattern = /grecaptcha-badge|grecaptcha-logo|grecaptcha-privacy|recaptcha__|api\.js|enterprise\.js|recaptcha\/api2\/anchor|size=invisible/i;

const hasMeaningfulBox = (rect: DOMRect): boolean => rect.width > 60 && rect.height > 40;

export const detectHumanValidation = async (page: Page): Promise<HumanValidationResult> => {
  const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
  const matchedText = blockingTextPatterns.find((pattern) => pattern.test(bodyText));

  if (matchedText) {
    return {
      detected: true,
      reason: `Texte de blocage detecte: ${matchedText.source}`
    };
  }

  const suspiciousElements = page.locator("iframe[src], iframe[title], [title], [id], [class]");
  const count = await suspiciousElements.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const element = suspiciousElements.nth(index);

    if (!(await element.isVisible().catch(() => false))) {
      continue;
    }

    const details = await element.evaluate((node) => {
      const element = node as HTMLElement;
      const rect = element.getBoundingClientRect();
      const value = [
        element.tagName.toLowerCase(),
        element.getAttribute("src"),
        element.getAttribute("title"),
        element.getAttribute("id"),
        element.getAttribute("class")
      ].filter(Boolean).join(" ");

      return {
        value,
        rect: {
          width: rect.width,
          height: rect.height
        }
      };
    }).catch(() => null);

    if (!details || passiveCaptchaPattern.test(details.value)) {
      continue;
    }

    if (challengeElementPattern.test(details.value) && hasMeaningfulBox(details.rect as DOMRect)) {
      return {
        detected: true,
        reason: `Element de validation detecte: ${details.value}`
      };
    }
  }

  return { detected: false };
};
