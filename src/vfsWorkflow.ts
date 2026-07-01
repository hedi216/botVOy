import { Page } from "playwright";
import {
  clickByRoleOrText,
  fillFieldByLabelOrPlaceholder,
  fillLoginFields,
  firstVisible,
  selectOptionByLabelOrText,
  waitSeconds
} from "./actions.js";
import { logger } from "./logger.js";
import { MissionConfig } from "./types.js";

export type SlotSearchResult = "slot-found" | "no-slot";

const noSlotPattern = /no appointment slots are currently available|try again later/i;
const slotAvailablePattern = /earliest available slot|available/i;

const clickContinue = async (page: Page): Promise<void> => {
  await clickByRoleOrText(page, "Continue");
};

export const loginToVfs = async (page: Page, config: MissionConfig): Promise<void> => {
  await fillLoginFields(page, config.loginEmail, config.loginPassword);
  await clickByRoleOrText(page, "Sign In").catch(() => clickByRoleOrText(page, "Login"));
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
};

export const logoutFromVfs = async (page: Page): Promise<void> => {
  logger.info("Deconnexion du compte VFS.");
  await clickByRoleOrText(page, "My Account").catch(() => undefined);
  await clickByRoleOrText(page, "Logout").catch(() => clickByRoleOrText(page, "Sign Out"));
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
};

export const startNewBooking = async (page: Page): Promise<void> => {
  await clickByRoleOrText(page, "Start New Booking");
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
};

export const fillAppointmentDetails = async (
  page: Page,
  config: MissionConfig
): Promise<SlotSearchResult> => {
  await selectOptionByLabelOrText(page, "Choose your Application Centre", config.applicationCentre);
  await selectOptionByLabelOrText(page, "Choose your appointment category", config.appointmentCategory);
  await selectOptionByLabelOrText(page, "Choose your sub-category", config.subCategory);
  await page.waitForTimeout(2_000);

  const text = await page.locator("body").innerText().catch(() => "");

  if (noSlotPattern.test(text)) {
    logger.warn("Aucun rendez-vous disponible pour cette combinaison.");
    return "no-slot";
  }

  if (!slotAvailablePattern.test(text)) {
    logger.warn("Disponibilite non confirmee clairement, le workflow continue prudemment.");
  }

  await clickContinue(page);
  return "slot-found";
};

export const fillApplicantDetails = async (
  page: Page,
  config: MissionConfig
): Promise<void> => {
  await fillFieldByLabelOrPlaceholder(page, "First Name", config.firstName);
  await fillFieldByLabelOrPlaceholder(page, "Last Name", config.lastName);
  await selectOptionByLabelOrText(page, "Current Nationality", config.currentNationality);
  await fillFieldByLabelOrPlaceholder(page, "Passport Number", config.passportNumber);

  const phoneInputs = page.locator("input").filter({ hasNotText: /./ });
  await fillFieldByLabelOrPlaceholder(page, "Contact number", config.phoneNumber).catch(async () => {
    const count = await phoneInputs.count();
    if (count < 2) {
      throw new Error("Champs telephone introuvables.");
    }
    await phoneInputs.nth(Math.max(0, count - 2)).fill(config.phoneDialCode);
    await phoneInputs.nth(Math.max(0, count - 1)).fill(config.phoneNumber);
  });

  const dialCodeField = page.locator("input").filter({ hasText: config.phoneDialCode }).first();
  if (!(await dialCodeField.isVisible().catch(() => false))) {
    const allInputs = page.locator("input");
    const count = await allInputs.count();
    for (let index = 0; index < count; index += 1) {
      const input = allInputs.nth(index);
      const value = await input.inputValue().catch(() => "");
      if (value === config.phoneNumber && index > 0) {
        await allInputs.nth(index - 1).fill(config.phoneDialCode);
        break;
      }
    }
  }

  await fillFieldByLabelOrPlaceholder(page, "Email", config.applicantEmail);
  await clickByRoleOrText(page, "Save");
  await waitSeconds(page, config.afterSaveWaitSeconds, "traitement apres sauvegarde du candidat");
  await clickContinue(page);
};

const clickFirstAvailableDate = async (page: Page): Promise<void> => {
  logger.info("Recherche d'une date disponible.");

  const date = await firstVisible([
    page.locator("button:not([disabled])").filter({ hasText: /^\d{1,2}$/ }),
    page.locator("[role='button']").filter({ hasText: /^\d{1,2}$/ })
  ]);

  if (!date) {
    throw new Error("Aucune date disponible cliquable trouvee.");
  }

  await date.click();
};

const selectFirstSlot = async (page: Page): Promise<void> => {
  logger.info("Selection du premier slot disponible.");
  await clickByRoleOrText(page, "Select");
};

export const bookFirstAvailableAppointment = async (
  page: Page,
  config: MissionConfig
): Promise<void> => {
  await clickByRoleOrText(page, "Choose a slot").catch(() => undefined);
  await waitSeconds(page, 40, "chargement du calendrier de rendez-vous");
  await clickFirstAvailableDate(page);
  await waitSeconds(page, config.afterDateClickWaitSeconds, "chargement des heures disponibles");
  await selectFirstSlot(page);
  await page.mouse.wheel(0, 1200);
  await clickContinue(page);
};

export const continueServices = async (
  page: Page,
  config: MissionConfig
): Promise<void> => {
  await waitSeconds(page, config.servicesWaitSeconds, "page services");
  await page.mouse.wheel(0, 1600);
  await clickContinue(page);
};

export const reviewAndGoToPayment = async (page: Page): Promise<void> => {
  await page.mouse.wheel(0, 2200);

  const terms = await firstVisible([
    page.getByLabel(/terms and conditions/i),
    page.locator("input[type='checkbox']").first()
  ]);

  if (!terms) {
    throw new Error("Case Terms and Conditions introuvable.");
  }

  const checked = await terms.isChecked().catch(() => false);
  if (!checked) {
    await terms.click();
  }

  await clickByRoleOrText(page, "Pay Online");
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);

  const continueButton = page.getByRole("button", { name: /continue/i });
  if (await continueButton.first().isVisible().catch(() => false)) {
    await page.mouse.wheel(0, 1600);
    await continueButton.first().click();
  }

  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(3_000);
  logger.success("Page de paiement atteinte. Le bot s'arrete avant toute saisie bancaire.");
};
