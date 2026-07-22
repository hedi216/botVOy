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

// Ne suppose jamais que la premiere page est la bonne (section 3): examine
// TOUTES les pages ouvertes du contexte, ignore les pages fermees, prefere
// une page reconnue par le detecteur approprie au mode, et ne retient
// about:blank que s'il n'existe strictement aucune autre page ouverte (et
// meme alors, seulement si elle passe elle-meme le detecteur - jamais par
// defaut).
export const findAppointmentPage = async (
  pages: Page[],
  targetMode: AgentTargetMode
): Promise<PageSelectionResult> => {
  const usable = pages.filter(isUsablePage);
  const nonBlank = usable.filter((page) => page.url() !== "about:blank");
  const candidates = nonBlank.length > 0 ? nonBlank : usable;

  const checker = targetMode === "fixture" ? isFixtureAppointmentPage : isAppointmentPageReady;

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
