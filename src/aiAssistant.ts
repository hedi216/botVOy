import { Page } from "playwright";
import { AiPageAnalysis, MissionConfig } from "./types.js";
import { logger } from "./logger.js";

type VisibleControl = {
  tag: string;
  text: string;
  type: string | null;
  name: string | null;
  id: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
};

const parseJsonFromText = (text: string): AiPageAnalysis => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    return {
      understood: false,
      summary: text.slice(0, 800),
      suggestedAction: "Réponse IA non structurée."
    };
  }

  return JSON.parse(text.slice(start, end + 1)) as AiPageAnalysis;
};

const collectPageContext = async (page: Page): Promise<{
  url: string;
  title: string;
  visibleText: string;
  controls: VisibleControl[];
}> => {
  const title = await page.title().catch(() => "");
  const visibleText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");

  const controls = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll("button, a, input, select, textarea, [role='button'], [role='option'], [role='combobox']")
    );

    return nodes
      .filter((node) => {
        const element = node as HTMLElement;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      })
      .slice(0, 80)
      .map((node) => {
        const element = node as HTMLElement;
        const input = node as HTMLInputElement;

        return {
          tag: element.tagName.toLowerCase(),
          text: (element.innerText || input.value || "").trim().slice(0, 120),
          type: input.getAttribute("type"),
          name: input.getAttribute("name"),
          id: input.getAttribute("id"),
          placeholder: input.getAttribute("placeholder"),
          ariaLabel: input.getAttribute("aria-label")
        };
      });
  }).catch(() => []);

  return {
    url: page.url(),
    title,
    visibleText: visibleText.slice(0, 5_000),
    controls
  };
};

export const analyzePageWithAi = async (
  page: Page,
  config: MissionConfig,
  goal: string,
  error?: unknown
): Promise<AiPageAnalysis | null> => {
  if (!config.enableAiAssistant) {
    return null;
  }

  if (!config.openAiApiKey) {
    logger.warn("Assistant IA activé mais OPENAI_API_KEY est manquant.");
    return {
      understood: false,
      summary: "Assistant IA activé mais aucune clé API n'est configurée.",
      suggestedAction: "Ajouter OPENAI_API_KEY dans .env ou désactiver ENABLE_AI_ASSISTANT."
    };
  }

  const context = await collectPageContext(page);
  const errorMessage = error instanceof Error ? error.message : String(error ?? "");

  logger.info(`Analyse IA de la page pour l'objectif: ${goal}`);

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.openAiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.aiModel,
      input: [
        {
          role: "system",
          content:
            "Tu aides un agent Playwright local à comprendre une page web. Ne propose jamais de contourner captcha, sécurité, paiement ou validation humaine. Réponds uniquement en JSON."
        },
        {
          role: "user",
          content: JSON.stringify({
            goal,
            error: errorMessage,
            page: context,
            expectedJson: {
              understood: "boolean",
              summary: "court diagnostic en français",
              suggestedAction: "action Playwright prudente ou intervention humaine",
              risk: "risque éventuel"
            }
          })
        }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Erreur API IA ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json() as { output_text?: string };
  const outputText = data.output_text ?? JSON.stringify(data);
  const analysis = parseJsonFromText(outputText);

  logger.info(`Diagnostic IA: ${analysis.summary}`);
  if (analysis.suggestedAction) {
    logger.info(`Suggestion IA: ${analysis.suggestedAction}`);
  }

  return analysis;
};
