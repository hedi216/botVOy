import { Locator, Page } from "playwright";

export const highlightElement = async (page: Page, locator: Locator): Promise<void> => {
  await locator.scrollIntoViewIfNeeded();

  await locator.evaluate((node) => {
    const element = node as HTMLElement;
    element.style.outline = "4px solid red";
    element.style.boxShadow = "0 0 0 6px rgba(255, 0, 0, 0.25)";
    element.style.borderRadius = "4px";
    element.setAttribute("data-rdv-agent-highlight", "true");
  });

  await page.bringToFront().catch(() => undefined);
};
