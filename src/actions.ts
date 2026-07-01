import { Page, Locator } from "playwright";
import { logger } from "./logger.js";

const cookieButtonTexts = [
  "Accept",
  "Accept all",
  "Accept All Cookies",
  "Accept only necessary",
  "I agree",
  "Agree",
  "Tout accepter",
  "Accepter"
];

export const firstVisible = async (locators: Locator[]): Promise<Locator | null> => {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (await item.isVisible().catch(() => false)) {
        return item;
      }
    }
  }

  return null;
};

export const clickByRoleOrText = async (page: Page, text: string): Promise<void> => {
  logger.info(`Clic sur "${text}".`);

  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const button = page.getByRole("button", { name: new RegExp(escaped, "i") });
  const link = page.getByRole("link", { name: new RegExp(escaped, "i") });
  const visible = await firstVisible([button, link, page.getByText(text, { exact: false })]);

  if (!visible) {
    throw new Error(`Bouton ou lien introuvable: ${text}`);
  }

  await visible.click();
};

export const waitSeconds = async (page: Page, seconds: number, reason: string): Promise<void> => {
  logger.info(`Attente ${seconds}s: ${reason}`);
  await page.waitForTimeout(seconds * 1_000);
};

export const acceptCookiesIfPresent = async (page: Page): Promise<void> => {
  logger.info("Recherche d'une bannière cookies.");

  for (const text of cookieButtonTexts) {
    const button = page.getByRole("button", { name: new RegExp(text, "i") });
    const visibleButton = await firstVisible([button]);

    if (visibleButton) {
      logger.info(`Bouton cookies détecté: ${text}`);
      await visibleButton.click();
      logger.success("Bannière cookies acceptée.");
      return;
    }
  }

  logger.info("Aucune bannière cookies visible détectée.");
};

export const selectOptionByLabelOrText = async (
  page: Page,
  labelText: string,
  optionText: string
): Promise<void> => {
  logger.info(`Sélection de "${optionText}" dans "${labelText}".`);

  const field = page.getByLabel(labelText, { exact: false });

  if (await field.first().isVisible().catch(() => false)) {
    try {
      await field.first().selectOption({ label: optionText });
      logger.success(`Option sélectionnée via <select>: ${labelText} = ${optionText}`);
      return;
    } catch {
      logger.info(`"${labelText}" ne semble pas être un <select>, tentative via clic.`);
    }

    await field.first().click();
  } else {
    const label = page.getByText(labelText, { exact: false }).first();

    if (!(await label.isVisible().catch(() => false))) {
      throw new Error(`Champ introuvable ou non visible pour le label: ${labelText}`);
    }

    await label.click();
  }

  const option = page.getByRole("option", { name: new RegExp(optionText, "i") }).first();
  if (await option.isVisible().catch(() => false)) {
    await option.click();
    logger.success(`Option sélectionnée via rôle option: ${optionText}`);
    return;
  }

  const textOption = page.getByText(optionText, { exact: true }).first();
  if (await textOption.isVisible().catch(() => false)) {
    await textOption.click();
    logger.success(`Option sélectionnée via texte visible: ${optionText}`);
    return;
  }

  throw new Error(`Option introuvable ou non visible: ${optionText}`);
};

export const fillFieldByLabelOrPlaceholder = async (
  page: Page,
  labelOrPlaceholder: string,
  value: string
): Promise<void> => {
  logger.info(`Remplissage du champ "${labelOrPlaceholder}".`);

  const escaped = labelOrPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const field = await firstVisible([
    page.getByLabel(new RegExp(escaped, "i")),
    page.getByPlaceholder(new RegExp(escaped, "i")),
    page.locator(`input[aria-label*="${labelOrPlaceholder}" i]`)
  ]);

  if (!field) {
    throw new Error(`Champ introuvable ou non visible: ${labelOrPlaceholder}`);
  }

  await field.fill(value);
};

export const fillLoginFields = async (
  page: Page,
  email: string,
  password: string
): Promise<void> => {
  logger.info(`Remplissage du login pour ${email}.`);

  const emailField = await firstVisible([
    page.locator('input[type="email"]'),
    page.locator('input[name*="email" i]'),
    page.locator('input[name*="login" i]'),
    page.locator('input[id*="email" i]'),
    page.locator('input[id*="login" i]')
  ]);

  if (!emailField) {
    throw new Error("Champ email/login introuvable ou non visible.");
  }

  await emailField.fill(email);
  logger.success("Champ email/login rempli.");

  const passwordField = await firstVisible([page.locator('input[type="password"]')]);

  if (!passwordField) {
    throw new Error("Champ mot de passe introuvable ou non visible.");
  }

  await passwordField.fill(password);
  logger.success("Champ mot de passe rempli.");
};

export const takeScreenshot = async (page: Page, prefix: string): Promise<string> => {
  const safePrefix = prefix.replace(/[^a-z0-9-_]/gi, "-").toLowerCase();
  const path = `artifacts/screenshots/${safePrefix}-${Date.now()}.png`;
  await page.screenshot({ path, fullPage: true });
  logger.info(`Capture écran enregistrée: ${path}`);
  return path;
};
