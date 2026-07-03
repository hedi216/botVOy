import { Locator, Page } from "playwright";
import { AppointmentAvailabilityResult, CandidateElementResult } from "./types.js";

const availabilityPatterns = [
  /available/i,
  /appointment available/i,
  /select appointment/i,
  /choose a slot/i,
  /time slot/i,
  /slot available/i,
  /creneau disponible/i,
  /créneau disponible/i,
  /rendez-vous disponible/i,
  /selectionner un rendez-vous/i,
  /sélectionner un rendez-vous/i,
  /choisir un creneau/i,
  /choisir un créneau/i,
  /reservez votre rendez-vous/i,
  /réservez votre rendez-vous/i
];

const noAvailabilityPatterns = [
  /nous n'avons actuellement plus de creneaux/i,
  /nous n'avons actuellement plus de créneaux/i,
  /aucun creneau/i,
  /aucun créneau/i,
  /no appointment slots/i,
  /no slots/i,
  /not available/i
];

const buttonPatterns = [
  /select/i,
  /choose/i,
  /book/i,
  /selectionner/i,
  /sélectionner/i,
  /choisir/i,
  /reservez/i,
  /réservez/i
];

const dateTimePattern = /(\b\d{1,2}[:h]\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre)\b)/i;

const isActionable = async (locator: Locator): Promise<boolean> => {
  if (!(await locator.isVisible().catch(() => false))) {
    return false;
  }

  if (!(await locator.isEnabled().catch(() => true))) {
    return false;
  }

  return await locator.evaluate((node) => {
    const element = node as HTMLElement;
    const ariaDisabled = element.getAttribute("aria-disabled") === "true";
    const disabled = element.hasAttribute("disabled");
    const classes = element.getAttribute("class") ?? "";
    const style = window.getComputedStyle(element);

    return !ariaDisabled
      && !disabled
      && !/disabled|inactive|grey|gray/i.test(classes)
      && style.pointerEvents !== "none"
      && Number(style.opacity || "1") > 0.45;
  }).catch(() => false);
};

const firstActionable = async (locator: Locator): Promise<Locator | null> => {
  const count = await locator.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await isActionable(item)) {
      return item;
    }
  }

  return null;
};

export const detectAppointmentAvailability = async (
  page: Page
): Promise<AppointmentAvailabilityResult> => {
  const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
  const hasNegativeMessage = noAvailabilityPatterns.some((pattern) => pattern.test(bodyText));
  const matchedText = availabilityPatterns.find((pattern) => pattern.test(bodyText));
  const dateTimeHint = bodyText.match(dateTimePattern)?.[0];

  const buttonRegex = new RegExp(buttonPatterns.map((pattern) => pattern.source).join("|"), "i");
  const button = await firstActionable(page.getByRole("button").filter({ hasText: buttonRegex }));

  if (button) {
    return {
      detected: true,
      textFound: await button.innerText().catch(() => "Bouton candidat"),
      dateTimeHint
    };
  }

  if (matchedText && !hasNegativeMessage) {
    return {
      detected: true,
      textFound: matchedText.source,
      dateTimeHint
    };
  }

  return { detected: false };
};

export const findBestCandidateElement = async (
  page: Page
): Promise<CandidateElementResult | null> => {
  const buttonRegex = new RegExp(buttonPatterns.map((pattern) => pattern.source).join("|"), "i");

  const candidates = [
    page.getByRole("button").filter({ hasText: buttonRegex }),
    page.getByRole("link").filter({ hasText: buttonRegex }),
    page.locator("[role='button']").filter({ hasText: buttonRegex }),
    page.locator("button:not([disabled])")
  ];

  for (const candidate of candidates) {
    const visible = await firstActionable(candidate);
    if (visible) {
      return {
        locator: visible,
        text: (await visible.innerText().catch(() => "")).trim()
      };
    }
  }

  return null;
};
