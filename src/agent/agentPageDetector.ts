import { Page } from "playwright";
import { isAppointmentPageReady } from "../shared/detectors.js";
import { AgentTargetMode } from "./types.js";

// Marqueur reconnu UNIQUEMENT par le detecteur fixture (jamais utilise en
// production): cf. scripts/fixtures/fake-appointment-site/appointment.html.
// Volontairement separe du detecteur production (isAppointmentPageReady,
// reutilise depuis src/shared/detectors.ts) pour ne jamais melanger les deux
// logiques (section 4 du cahier des charges Lot 3).
const FIXTURE_APPOINTMENT_SELECTOR = '[data-testid="fixture-appointment-page"]';

const isUsablePage = (page: Page): boolean => {
  if (page.isClosed()) {
    return false;
  }
  const url = page.url();
  return !url.startsWith("devtools://") && !url.startsWith("chrome://") && !url.startsWith("chrome-extension://");
};

const isFixtureAppointmentPage = async (page: Page): Promise<boolean> =>
  page.locator(FIXTURE_APPOINTMENT_SELECTOR).first().isVisible().catch(() => false);

// Jamais l'URL complete dans un log public: seule l'origine (+ pathname
// tronque) est conservee, jamais la query string qui peut porter des
// parametres sensibles (section 3 du cahier des charges Lot 3).
export const maskUrlForLog = (rawUrl: string): string => {
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname.length > 60 ? `${parsed.pathname.slice(0, 60)}...` : parsed.pathname;
    const suffix = parsed.search ? "?..." : "";
    // Les URL file:// (fixture locale) ont une origine "null" par
    // specification WHATWG: on utilise alors le protocole seul, plus lisible
    // qu'une origine litteralement "null" dans les logs.
    const origin = parsed.origin && parsed.origin !== "null" ? parsed.origin : parsed.protocol;
    return `${origin}${path}${suffix}`;
  } catch {
    return "(url invalide)";
  }
};

export type PageSelectionResult =
  | { ok: true; page: Page }
  | { ok: false; reason: string };

const usableCandidates = (pages: Page[]): Page[] => {
  const usable = pages.filter(isUsablePage);
  const nonBlank = usable.filter((page) => page.url() !== "about:blank");
  return nonBlank.length > 0 ? nonBlank : usable;
};

const selectWithChecker = async (
  pages: Page[],
  checker: (page: Page) => Promise<boolean>
): Promise<PageSelectionResult> => {
  const candidates = usableCandidates(pages);

  for (const page of candidates) {
    if (await checker(page)) {
      return { ok: true, page };
    }
  }

  return {
    ok: false,
    reason: candidates.length === 0
      ? "Aucun onglet ouvert dans le navigateur du bot."
      : `Aucune page de rendez-vous reconnue parmi ${candidates.length} onglet(s) ouvert(s).`
  };
};

// Ne suppose jamais que la premiere page est la bonne (section 3): examine
// TOUTES les pages ouvertes du contexte, ignore les pages fermees, prefere
// une page reconnue par le detecteur approprie au mode, et ne retient
// about:blank que s'il n'existe strictement aucune autre page ouverte (et
// meme alors, seulement si elle passe elle-meme le detecteur - jamais par
// defaut).
//
// Utilisee UNIQUEMENT pour VALIDATE_BOT (selection initiale, section 3 Lot
// 3): en mode fixture, verifie seulement la presence du marqueur de test
// (deliberement permissif, une page fixture peut legitimement ne pas encore
// afficher un contenu "pret" - ex. scenario rate-limited/refresh-required -
// et VALIDATE_BOT doit quand meme reconnaitre que c'est la bonne page pour
// que la boucle de surveillance puisse ensuite gerer ces cas elle-meme).
export const findAppointmentPage = async (
  pages: Page[],
  targetMode: AgentTargetMode
): Promise<PageSelectionResult> => selectWithChecker(pages, targetMode === "fixture" ? isFixtureAppointmentPage : isAppointmentPageReady);

// Utilisee UNIQUEMENT par la boucle de surveillance pour la RECUPERATION en
// cours de route (Lot 4: recoverPage/recoverWorkflow), jamais pour
// VALIDATE_BOT. Contrairement a findAppointmentPage, verifie TOUJOURS le
// contenu reellement pret (isAppointmentPageReady), y compris en mode
// fixture: le marqueur fixture seul (toujours present, quel que soit le
// scenario) ne doit jamais faire croire a une reprise reelle pendant qu'un
// probleme (rate limit, page non prete) est encore affiche - piege constate
// empiriquement (boucle a vitesse CPU tant que le marqueur reste present).
export const findReadyAppointmentPage = async (pages: Page[]): Promise<PageSelectionResult> =>
  selectWithChecker(pages, isAppointmentPageReady);

// -------- Diagnostic Cloudflare: detection PASSIVE d'un blocage (jamais une
// tentative de contournement - aucune modification d'empreinte, user-agent,
// navigator.webdriver, Canvas/WebGL: uniquement une lecture du contenu deja
// affiche par la page). Distincte de la "file d'attente virtuelle"
// Cloudflare (isInCloudflareQueue dans src/shared/loginFlow.ts, qui s'ecoule
// seule): ceci est un blocage qui ne se resout jamais tout seul - jamais de
// nouvelle tentative automatique une fois constate. --------

const CLOUDFLARE_BLOCK_TITLE_PATTERN = /attention required/i;
const CLOUDFLARE_BLOCK_TEXT_PATTERN = /sorry, you have been blocked/i;
const CLOUDFLARE_BLOCK_PATH_PATTERN = /\/cdn-cgi\//i;

export const isCloudflareBlockedPage = async (page: Page): Promise<boolean> => {
  if (page.isClosed()) {
    return false;
  }
  try {
    if (CLOUDFLARE_BLOCK_PATH_PATTERN.test(page.url())) {
      return true;
    }
    const title = await page.title().catch(() => "");
    if (CLOUDFLARE_BLOCK_TITLE_PATTERN.test(title)) {
      return true;
    }
    const bodyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    return CLOUDFLARE_BLOCK_TEXT_PATTERN.test(bodyText);
  } catch {
    return false;
  }
};
