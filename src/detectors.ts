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
  /selectionner un rendez-vous/i,
  /choisir un creneau/i
];

const noAvailabilityPatterns = [
  /nous n'avons actuellement plus de creneaux/i,
  /plus de creneaux de rendez-vous disponibles/i,
  /aucun creneau n'est disponible/i,
  /aucun rendez-vous/i,
  /aucun creneau/i,
  /no appointment slots/i,
  /no appointments available/i,
  /currently no appointment/i,
  /no slots/i,
  /not available/i
];

const buttonPatterns = [
  /select/i,
  /choose/i,
  /book/i,
  /selectionner/i,
  /choisir/i,
  /reservez/i
];

const dateTimePattern = /(\b\d{1,2}[:h]\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\b)/i;
const containsTimeSlotPattern = /\b\d{1,2}[:h]\d{2}\b/i;
const timeSlotPattern = /^\s*\d{1,2}[:h]\d{2}\s*$/i;
const excludedCandidatePattern = /close|menu|language|langue|account|compte|cart|panier|legend|legende|next|prev|suivant|precedent|header|footer|indisponible|unavailable/i;
const reserveButtonPattern = /r[eé]servez|reserve|book/i;

const normalizeText = (text: string): string => text
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[’']/g, "'")
  .toLowerCase();

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
    const ariaLabel = element.getAttribute("aria-label") ?? "";
    const disabled = element.hasAttribute("disabled");
    const classes = element.getAttribute("class") ?? "";
    const testId = element.getAttribute("data-testid") ?? "";
    const text = element.innerText ?? element.textContent ?? "";
    const style = window.getComputedStyle(element);
    const isTlsAvailableSlot = testId === "btn-available-slot"
      || (/AppointmentHour_appointment-hour/i.test(classes)
        && !/AppointmentHour_appointment-hour_disabled|disabled/i.test(classes)
        && !disabled
        && !ariaDisabled);

    if (testId === "btn-unavailable-slot") {
      return false;
    }

    if (isTlsAvailableSlot) {
      return style.pointerEvents !== "none"
        && Number(style.opacity || "1") > 0.35;
    }

    return !ariaDisabled
      && !disabled
      && !/disabled|unavailable|indisponible/i.test(`${classes} ${testId}`)
      && !/close|menu|language|langue|account|compte|cart|panier|legend|legende|next|prev|suivant|precedent|header|footer|indisponible|unavailable/i.test(`${ariaLabel} ${classes} ${text}`)
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

const firstActionableTimeButton = async (page: Page): Promise<Locator | null> => {
  const candidates = [
    page.locator('button[data-testid="btn-available-slot"]'),
    page.locator('button[class*="AppointmentHour_appointment-hour"]:not([disabled])'),
    page.locator("button:not([disabled])").filter({ hasText: containsTimeSlotPattern }),
    page.locator("[role='button']:not([aria-disabled='true'])").filter({ hasText: containsTimeSlotPattern }),
    page.locator("[tabindex]:not([aria-disabled='true'])").filter({ hasText: containsTimeSlotPattern })
  ];

  for (const candidate of candidates) {
    const visible = await firstActionable(candidate);
    if (visible) {
      return visible;
    }
  }

  return null;
};

const findDomTimeSlotCandidate = async (page: Page): Promise<CandidateElementResult | null> => {
  const marker = `slot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await page.evaluate((candidateMarker) => {
    const timePattern = /^\s*\d{1,2}[:h]\d{2}\s*$/i;
    const badPattern = /disabled|unavailable|indisponible|close|menu|language|langue|account|compte|cart|panier|legend|legende|next|prev|suivant|precedent|header|footer/i;

    const isVisible = (element: Element): boolean => {
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      const rect = htmlElement.getBoundingClientRect();
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") > 0.35;
    };

    const elementText = (element: Element): string =>
      ((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim();

    const isDisabled = (element: Element): boolean => {
      const htmlElement = element as HTMLElement;
      const details = [
        htmlElement.getAttribute("class") ?? "",
        htmlElement.getAttribute("aria-label") ?? "",
        htmlElement.getAttribute("data-testid") ?? "",
        htmlElement.getAttribute("disabled") ?? "",
        htmlElement.getAttribute("aria-disabled") ?? "",
        elementText(htmlElement)
      ].join(" ");
      const style = window.getComputedStyle(htmlElement);

      return htmlElement.hasAttribute("disabled")
        || htmlElement.getAttribute("aria-disabled") === "true"
        || badPattern.test(details)
        || style.pointerEvents === "none";
    };

    const clickableAncestor = (element: Element): HTMLElement => {
      return (element.closest("button, [role='button'], a, [tabindex]") as HTMLElement | null)
        ?? element as HTMLElement;
    };

    const scoreCandidate = (element: HTMLElement): number => {
      const style = window.getComputedStyle(element);
      const tagName = element.tagName.toLowerCase();
      const role = element.getAttribute("role") ?? "";
      const colors = `${style.color} ${style.borderColor} ${style.backgroundColor}`;
      let score = 0;

      if (tagName === "button" || role === "button") score += 40;
      if (element.hasAttribute("tabindex")) score += 20;
      if (style.cursor === "pointer") score += 20;
      if (/rgb\((0|1?[0-9]{1,2}),\s*(4[0-9]|5[0-9]|6[0-9]|7[0-9]|8[0-9]|9[0-9]|1[0-9]{2}),\s*(1[0-9]{2}|2[0-5]{2})\)/i.test(colors)) score += 15;
      return score;
    };

    const matches = [...document.querySelectorAll("button, [role='button'], [tabindex], div, span, p")]
      .filter((element) => isVisible(element) && timePattern.test(elementText(element)))
      .map((element) => {
        const target = clickableAncestor(element);
        return {
          target,
          text: elementText(element),
          score: scoreCandidate(target)
        };
      })
      .filter(({ target }) => isVisible(target) && !isDisabled(target))
      .sort((a, b) => b.score - a.score);

    const best = matches[0];
    if (!best) {
      return null;
    }

    best.target.setAttribute("data-rdv-agent-candidate", candidateMarker);
    return { marker: candidateMarker, text: best.text };
  }, marker).catch(() => null);

  if (!result) {
    return null;
  }

  return {
    locator: page.locator(`[data-rdv-agent-candidate="${result.marker}"]`).first(),
    text: result.text
  };
};

export const detectAppointmentAvailability = async (
  page: Page
): Promise<AppointmentAvailabilityResult> => {
  const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
  const normalizedBodyText = normalizeText(bodyText);
  const hasNegativeMessage = noAvailabilityPatterns.some((pattern) => pattern.test(normalizedBodyText));
  const dateTimeHint = bodyText.match(dateTimePattern)?.[0];

  const timeButton = await firstActionableTimeButton(page);
  if (timeButton) {
    const text = await timeButton.innerText().catch(() => "Creneau horaire");
    const time = text.match(containsTimeSlotPattern)?.[0] ?? text;
    return {
      detected: true,
      textFound: time,
      dateTimeHint: time || dateTimeHint
    };
  }

  const domTimeSlot = await findDomTimeSlotCandidate(page);
  if (domTimeSlot) {
    return {
      detected: true,
      textFound: domTimeSlot.text,
      dateTimeHint: domTimeSlot.text
    };
  }

  if (hasNegativeMessage) {
    return { detected: false };
  }

  const matchedText = availabilityPatterns.find((pattern) => pattern.test(normalizedBodyText));
  const buttonRegex = new RegExp(buttonPatterns.map((pattern) => pattern.source).join("|"), "i");
  const button = await firstActionable(page.getByRole("button").filter({ hasText: buttonRegex }));

  if (button) {
    return {
      detected: true,
      textFound: await button.innerText().catch(() => "Bouton candidat"),
      dateTimeHint
    };
  }

  if (matchedText && dateTimeHint) {
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
  const timeButton = await firstActionableTimeButton(page);

  if (timeButton) {
    const text = (await timeButton.innerText().catch(() => "")).trim();
    return {
      locator: timeButton,
      text: text.match(containsTimeSlotPattern)?.[0] ?? text
    };
  }

  const domTimeSlot = await findDomTimeSlotCandidate(page);

  if (domTimeSlot) {
    return domTimeSlot;
  }

  const candidates = [
    page.locator("button, [role='button'], [tabindex]").filter({ hasText: timeSlotPattern }),
    page.getByRole("button").filter({ hasText: timeSlotPattern }),
    page.locator("button").filter({ hasText: timeSlotPattern }),
    page.locator("[role='button']").filter({ hasText: timeSlotPattern }),
    page.getByRole("button").filter({ hasText: buttonRegex }),
    page.locator("button").filter({ hasText: buttonRegex }),
    page.getByRole("link").filter({ hasText: buttonRegex }),
    page.locator("[role='button']").filter({ hasText: buttonRegex })
  ];

  for (const candidate of candidates) {
    const visible = await firstActionable(candidate);
    if (visible) {
      const text = (await visible.innerText().catch(() => "")).trim();
      const ariaLabel = await visible.getAttribute("aria-label").catch(() => "") ?? "";
      const className = await visible.getAttribute("class").catch(() => "") ?? "";
      if (excludedCandidatePattern.test(`${text} ${ariaLabel} ${className}`)) {
        continue;
      }

      return {
        locator: visible,
        text
      };
    }
  }

  return null;
};

export const findReserveAppointmentButton = async (
  page: Page
): Promise<CandidateElementResult | null> => {
  const candidates = [
    page.getByRole("button").filter({ hasText: reserveButtonPattern }),
    page.locator("[role='button']").filter({ hasText: reserveButtonPattern })
  ];

  for (const candidate of candidates) {
    const visible = await firstActionable(candidate);
    if (!visible) {
      continue;
    }

    const text = (await visible.innerText().catch(() => "")).trim();
    const ariaLabel = await visible.getAttribute("aria-label").catch(() => "") ?? "";
    const className = await visible.getAttribute("class").catch(() => "") ?? "";
    const testId = await visible.getAttribute("data-testid").catch(() => "") ?? "";
    const fullText = normalizeText(`${text} ${ariaLabel} ${className} ${testId}`);

    if (/appointmenthour|btn-available-slot|btn-unavailable-slot/i.test(fullText)) {
      continue;
    }

    if (!/reservez|reserve|book/i.test(fullText)) {
      continue;
    }

    return {
      locator: visible,
      text
    };
  }

  return null;
};
