import { Locator, Page } from "playwright";
import { MonitorEventLevel } from "./types.js";

type LogFn = (level: MonitorEventLevel, message: string) => void;

// Sur TLScontact, "Se connecter" pointe toujours vers /fr-fr/login : directement
// visible dans le header en fenetre large (xl), derriere l'icone du "Dropdown selector"
// (role="listitem") en fenetre etroite.
const loginLinkSelector = 'a[href="/fr-fr/login"]:visible';
const dropdownToggleSelector = '[aria-label="Dropdown selector"] [role="listitem"]';
const directLoginTextPattern = /^se connecter$/i;
export const loginPathPattern = /\/fr-fr\/login/i;

// locator.isVisible({timeout}) n'attend pas reellement (l'option timeout y est
// ignoree par Playwright) : on utilise waitFor(), qui poll pour de vrai, avant de
// cliquer. Le clic n'est jamais avale par un catch ici, pour ne pas logger un
// succes alors que le clic a en realite echoue.
const clickLocatorIfVisible = async (locator: Locator, timeoutMs: number): Promise<boolean> => {
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }

  await locator.click({ timeout: timeoutMs });
  return true;
};

const clickFirstVisible = (page: Page, selector: string, timeoutMs: number): Promise<boolean> =>
  clickLocatorIfVisible(page.locator(selector).first(), timeoutMs);

// Hotfix 0.1.2: new URL(chemin, base) exige une base hierarchique (http/
// https) - "about:blank", "chrome://..." ou toute autre base non-HTTP(S) la
// fait echouer avec "Invalid URL" (defaut reel constate en 0.1.1: l'agent
// appelait cette fonction avant toute navigation reelle, page.url() valant
// encore about:blank). Jamais de tentative dans ce cas: le point d'appel
// (AgentBotManager.runAutoNavigation) est desormais cense avoir deja
// navigue vers une vraie URL TLS avant d'appeler clickSeConnecter, mais
// cette garde reste une seconde ligne de defense independante - jamais
// supprimee meme si l'appelant est corrige par ailleurs.
const isSafeNavigationBase = (rawUrl: string): boolean => {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

// HOTFIX CIBLE 0.1.9 (agent bloque sur la page d'accueil malgre un lien 'Se
// connecter' reel et cliquable, confirme par DevTools): cette fonction
// declarait un succes des que page.goto() ne levait aucune exception, sans
// jamais verifier que la navigation avait REELLEMENT atteint /fr-fr/login (ou
// une etape d'authentification reconnue). Or une navigation directe (goto,
// sans evenement de clic reel ni Referer de page) peut tres bien "reussir"
// techniquement (aucune erreur Playwright, domcontentloaded declenche) tout
// en etant silencieusement renvoyee vers la page d'origine par le site
// (redirection cote serveur/anti-bot, garde SPA) - Playwright suit cette
// redirection sans jamais la signaler comme une erreur. Le defaut constate en
// reel correspond exactement a ce cas: clickSeConnecter() se croyait deja
// reussi via ce seul chemin et n'essayait donc jamais le clic direct sur le
// vrai lien (pourtant present et fonctionnel d'apres DevTools). On verifie
// desormais l'etat REELLEMENT atteint apres le goto, avec une courte
// attente (la page peut avoir besoin d'un instant pour s'hydrater/rediriger),
// avant de declarer un succes - sinon on se rabat sur les chemins de clic
// direct ci-dessous, qui simulent un vrai geste utilisateur.
const CONFIRM_LOGIN_REACHED_TIMEOUT_MS = 4_000;
// BUG CIBLE 0.2.4 (section 8: home -> travel-groups direct sans login si la
// session TLS est encore valide): une navigation vers /fr-fr/login peut tout
// a fait etre redirigee IMMEDIATEMENT par TLS vers une etape PLUS AVANCEE du
// parcours (travel-groups, application-summary, service-level, page pays,
// voire directement appointment-booking) plutot que vers login/auth - c'est
// une PROGRESSION reelle, jamais un echec de navigation qui devrait
// declencher le repli sur le clic direct du lien (defaut reel confirme: le
// code loguait "navigation /login sans effet reel" alors que travel-groups
// EST une progression). Motifs deja exportes plus bas dans CE MEME fichier
// (jamais une seconde logique de classification divergente/importee).
const hasReachedLoginOrAuth = async (page: Page): Promise<boolean> => {
  const deadline = Date.now() + CONFIRM_LOGIN_REACHED_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (page.isClosed()) {
      return false;
    }
    const url = page.url();
    if (
      loginPathPattern.test(url)
      || authPagePattern.test(url)
      || travelGroupsPagePattern.test(url)
      || applicationSummaryPagePattern.test(url)
      || serviceLevelPagePattern.test(url)
      || homeCountryPagePattern.test(url)
      || appointmentBookingPathPattern.test(url)
    ) {
      return true;
    }
    if (await hasVisibleLoginForm(page)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

// Le lien "Se connecter" pointe toujours vers /fr-fr/login, que ce soit en fenetre
// large (visible directement) ou etroite (derriere un menu compte qui, en pratique,
// se referme parfois avant qu'on ait pu cliquer dedans). Naviguer directement vers
// cette URL connue evite toute dependance a ce menu deroulant peu fiable - mais
// seulement si elle atteint reellement sa cible (cf. hasReachedLoginOrAuth ci-dessus).
const navigateToLogin = async (page: Page, log: LogFn): Promise<boolean> => {
  const currentUrl = page.url();
  if (!isSafeNavigationBase(currentUrl)) {
    log("warn", `Navigation directe vers /fr-fr/login impossible: page actuelle non exploitable comme base (${currentUrl}).`);
    return false;
  }

  const target = new URL("/fr-fr/login", currentUrl).toString();
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 8_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("warn", `Navigation directe vers /fr-fr/login impossible: ${message}`);
    return false;
  }

  if (await hasReachedLoginOrAuth(page)) {
    log("success", `Navigation directe vers ${target}.`);
    return true;
  }

  log(
    "warn",
    `Navigation directe vers /fr-fr/login sans effet reel (URL obtenue: ${page.url()}). `
    + "Repli sur le clic direct du lien 'Se connecter'."
  );
  return false;
};

export const clickSeConnecter = async (page: Page, log: LogFn): Promise<boolean> => {
  if (await navigateToLogin(page, log)) {
    return true;
  }

  if (await clickFirstVisible(page, loginLinkSelector, 3_000).catch(() => false)) {
    log("success", "Bouton 'Se connecter' clique directement (fenetre large).");
    return true;
  }

  log("info", "Lien 'Se connecter' non visible directement, ouverture du menu compte (fenetre etroite).");

  if (!(await clickFirstVisible(page, dropdownToggleSelector, 3_000).catch(() => false))) {
    log("warn", "Menu compte introuvable. Connexion manuelle requise.");
    return false;
  }

  if (await clickFirstVisible(page, loginLinkSelector, 3_000).catch(() => false)) {
    log("success", "Bouton 'Se connecter' clique via le menu compte (fenetre etroite).");
    return true;
  }

  // Repli generique si la structure du site a change : cherche par texte visible.
  const fallbackLogin = page.getByRole("link", { name: directLoginTextPattern })
    .or(page.getByRole("button", { name: directLoginTextPattern }))
    .first();

  if (await clickLocatorIfVisible(fallbackLogin, 2_000).catch(() => false)) {
    log("success", "Bouton 'Se connecter' clique via repli generique.");
    return true;
  }

  log("warn", "Bouton 'Se connecter' introuvable apres ouverture du menu compte. Connexion manuelle requise.");
  return false;
};

// Le realm i2-auth.visas-fr.tlscontact.com est un Keycloak standard : le theme par
// defaut expose #username / #password / #kc-login. On garde un repli generique au
// cas ou le theme differe (premier champ texte/email + premier champ mot de passe visibles).
const fillFirstVisible = async (page: Page, selector: string, value: string, timeoutMs: number): Promise<boolean> => {
  const target = page.locator(selector).first();

  try {
    await target.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }

  await target.fill(value, { timeout: timeoutMs });
  return true;
};

const RECAPTCHA_POLL_INTERVAL_MS = 2_000;
const RECAPTCHA_HEARTBEAT_MS = 30_000;
const RECAPTCHA_MAX_WAIT_MS = 15 * 60 * 1000;

const isRecaptchaSolved = (page: Page): Promise<boolean> => page.evaluate(() => {
  const field = document.querySelector('textarea[name="g-recaptcha-response"]') as HTMLTextAreaElement | null;
  return Boolean(field && field.value && field.value.length > 0);
}).catch(() => false);

// Le badge reCAPTCHA v3 invisible (iframe ancre avec `size=invisible`) est present
// sur quasiment toutes les pages sans exiger la moindre action humaine : son jeton
// se remplit seul. On ne le compte donc pas comme un captcha bloquant, contrairement
// a la checkbox v2 visible (`size=normal`/`size=compact`) ou au popup de defi (bframe).
const isRecaptchaPresent = (page: Page): Promise<boolean> => page.locator(
  'iframe[src*="recaptcha"]:not([src*="size=invisible"])'
).first().count().then((count) => count > 0).catch(() => false);

// Un autre bot (ou un humain) resout le reCAPTCHA pendant ce temps. On ne clique
// 'Se connecter' qu'une fois le jeton g-recaptcha-response rempli par Google — c'est
// le signal fiable, verifiable cote serveur, que la resolution est bonne. Pas de clic
// a l'aveugle avant ca, et pas d'abandon premature: on poll longtemps (15 min).
const waitForRecaptchaResolution = async (page: Page, log: LogFn): Promise<void> => {
  if (!(await isRecaptchaPresent(page)) || (await isRecaptchaSolved(page))) {
    return;
  }

  log("info", "Captcha detecte sur la page de connexion. Attente de sa resolution avant de cliquer 'Se connecter'.");
  const deadline = Date.now() + RECAPTCHA_MAX_WAIT_MS;
  let lastHeartbeat = Date.now();

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      return;
    }

    if (await isRecaptchaSolved(page)) {
      log("success", "Captcha resolu. Poursuite de la connexion.");
      return;
    }

    if (Date.now() - lastHeartbeat > RECAPTCHA_HEARTBEAT_MS) {
      log("info", "Toujours en attente de la resolution du captcha...");
      lastHeartbeat = Date.now();
    }

    await new Promise((resolve) => setTimeout(resolve, RECAPTCHA_POLL_INTERVAL_MS));
  }

  log("warn", "Captcha non resolu apres 15 minutes d'attente. Connexion manuelle requise.");
};

const cloudflareQueuePattern = /file d.?attente/i;
const CLOUDFLARE_QUEUE_POLL_MS = 10_000;
const CLOUDFLARE_QUEUE_HEARTBEAT_MS = 30_000;
const CLOUDFLARE_QUEUE_MAX_WAIT_MS = 15 * 60 * 1000;

const isInCloudflareQueue = (page: Page): Promise<boolean> =>
  page.getByText(cloudflareQueuePattern).first().isVisible().catch(() => false);

// Cloudflare protege i2-auth avec une "file d'attente virtuelle" (meme URL, contenu
// different) qui s'actualise seule et finit par afficher le vrai formulaire. On
// patiente sans jamais demander de validation humaine ni abandonner le workflow.
const waitForCloudflareQueue = async (page: Page, log: LogFn): Promise<void> => {
  if (!(await isInCloudflareQueue(page))) {
    return;
  }

  log("info", "File d'attente Cloudflare detectee. Attente de son ecoulement automatique.");
  const deadline = Date.now() + CLOUDFLARE_QUEUE_MAX_WAIT_MS;
  let lastHeartbeat = Date.now();

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      return;
    }

    if (!(await isInCloudflareQueue(page))) {
      log("success", "File d'attente Cloudflare ecoulee. Poursuite de la connexion.");
      return;
    }

    if (Date.now() - lastHeartbeat > CLOUDFLARE_QUEUE_HEARTBEAT_MS) {
      log("info", "Toujours dans la file d'attente Cloudflare...");
      lastHeartbeat = Date.now();
    }

    await new Promise((resolve) => setTimeout(resolve, CLOUDFLARE_QUEUE_POLL_MS));
  }

  log("warn", "File d'attente Cloudflare toujours active apres 15 minutes. Connexion manuelle requise.");
};

export const fillLoginForm = async (page: Page, login: string, password: string, log: LogFn): Promise<boolean> => {
  await waitForCloudflareQueue(page, log);

  if (page.isClosed()) {
    return false;
  }

  const usernameFilled = await fillFirstVisible(page, "#username", login, 5_000).catch(() => false)
    || await fillFirstVisible(page, 'input[type="email"]:visible, input[type="text"]:visible', login, 3_000).catch(() => false);

  if (!usernameFilled) {
    log("warn", "Champ identifiant introuvable sur la page de connexion. Connexion manuelle requise.");
    return false;
  }

  const passwordFilled = await fillFirstVisible(page, "#password", password, 3_000).catch(() => false)
    || await fillFirstVisible(page, 'input[type="password"]:visible', password, 3_000).catch(() => false);

  if (!passwordFilled) {
    log("warn", "Champ mot de passe introuvable sur la page de connexion. Connexion manuelle requise.");
    return false;
  }

  await waitForRecaptchaResolution(page, log);

  if (page.isClosed()) {
    return false;
  }

  const submitButton = page.locator("#btn-login:visible, #kc-login:visible")
    .or(page.getByRole("button", { name: /^se connecter$/i }))
    .or(page.locator('button[type="submit"]:visible, input[type="submit"]:visible'))
    .first();

  if (await clickLocatorIfVisible(submitButton, 5_000).catch(() => false)) {
    log("success", "Formulaire de connexion rempli et soumis automatiquement.");
    return true;
  }

  // Repli robuste si le bouton n'est pas identifiable avec certitude: la touche
  // Entree dans le champ mot de passe soumet le formulaire nativement, sans
  // dependre d'un id ou d'un libelle precis.
  log("info", "Bouton de connexion non identifie avec certitude, soumission via la touche Entree.");
  const passwordField = page.locator("#password:visible, input[type=\"password\"]:visible").first();

  try {
    await passwordField.press("Enter", { timeout: 3_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("warn", `Soumission via Entree impossible: ${message}. Connexion manuelle requise.`);
    return false;
  }

  log("success", "Formulaire de connexion soumis via la touche Entree.");
  return true;
};

const selectTravelGroupTextPattern = /^s[ée]lectionner$/i;

// HOTFIX CIBLE 0.2.1 (bot bloque sur /fr-fr/travel-groups malgre un bouton
// 'Selectionner' visible d'apres l'utilisateur): l'ancienne version ne
// cherchait QUE role=button[name=Selectionner] et retournait false sans
// jamais journaliser ce qu'elle avait effectivement trouve sur la page -
// impossible de distinguer "aucun candidat" de "candidat present mais role
// non reconnu" (ex. un <a> stylise en bouton plutot qu'un <button> reel).
// Recherche desormais, dans cet ordre strict (le plus specifique/fiable
// d'abord), et journalise le compte de CHAQUE strategie: jamais seulement
// celle qui a fini par matcher. Correspondance texte TOUJOURS exacte
// (selectTravelGroupTextPattern est ancre ^...$): ne clique jamais un
// element parce qu'il contient partiellement "Selectionner", et ne peut donc
// jamais confondre avec "Creer une nouvelle demande"/modifier/supprimer/une
// autre demande - aucune exclusion additionnelle n'est necessaire, l'ancrage
// du motif suffit deja a lui seul.
const findExactTextMatches = async (locator: Locator, pattern: RegExp): Promise<Locator[]> => {
  const count = await locator.count().catch(() => 0);
  const matches: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    const text = (await item.innerText({ timeout: 1_000 }).catch(() => "")).trim();
    if (pattern.test(text)) {
      matches.push(item);
    }
  }
  return matches;
};

type TravelGroupCandidateSet = { label: string; matches: Locator[] };

const collectTravelGroupCandidateSets = async (page: Page): Promise<TravelGroupCandidateSet[]> => {
  const roleButtonLocator = page.getByRole("button", { name: selectTravelGroupTextPattern });
  const roleLinkLocator = page.getByRole("link", { name: selectTravelGroupTextPattern });
  const [roleButtonMatches, roleLinkMatches, buttonMatches, linkMatches, roleAttrMatches] = await Promise.all([
    roleButtonLocator.all().catch(() => []),
    roleLinkLocator.all().catch(() => []),
    findExactTextMatches(page.locator("button:visible"), selectTravelGroupTextPattern),
    findExactTextMatches(page.locator("a:visible"), selectTravelGroupTextPattern),
    findExactTextMatches(page.locator('[role="button"]:visible'), selectTravelGroupTextPattern)
  ]);
  return [
    { label: "role=button[name=Selectionner]", matches: roleButtonMatches },
    { label: "role=link[name=Selectionner]", matches: roleLinkMatches },
    { label: "button:visible (texte exact)", matches: buttonMatches },
    { label: "a:visible (texte exact)", matches: linkMatches },
    { label: "[role=\"button\"]:visible (texte exact)", matches: roleAttrMatches }
  ];
};

// Apres connexion, TLScontact affiche parfois "Gestionnaire des demandes"
// (/fr-fr/travel-groups) avant la page de rendez-vous : il faut cliquer
// "Selectionner" sur la demande pour continuer. S'il y en a plusieurs, on prend
// la premiere et on le signale (pas de logique de tri par categorie ici). Ne
// declare un succes qu'apres un clic REELLEMENT execute (trial puis clic
// reel, jamais d'exception avalee) - la confirmation de progression reelle
// (sortie de travel-groups) est verifiee par l'appelant (agentBotManager.ts).
export const clickSelectTravelGroup = async (page: Page, log: LogFn): Promise<boolean> => {
  const candidateSets = await collectTravelGroupCandidateSets(page);
  log(
    "info",
    `Etape travel-groups: candidats 'Selectionner' par strategie (${candidateSets.map((set) => `${set.label}=${set.matches.length}`).join(", ")}).`
  );

  const firstNonEmpty = candidateSets.find((set) => set.matches.length > 0);
  if (!firstNonEmpty) {
    log("warn", "Aucune demande 'Selectionner' trouvee sur 'Gestionnaire des demandes' (toutes strategies a 0 candidat).");
    return false;
  }

  if (firstNonEmpty.matches.length > 1) {
    log("warn", `${firstNonEmpty.matches.length} demandes trouvees sur 'Gestionnaire des demandes' (strategie ${firstNonEmpty.label}). Selection de la premiere.`);
  }

  const target = firstNonEmpty.matches[0];
  const [tagName, role, id, dataTestId, hrefAttr, accessibleTextRaw] = await Promise.all([
    target.evaluate((el) => el.tagName).catch(() => "?"),
    target.getAttribute("role").catch(() => null),
    target.getAttribute("id").catch(() => null),
    target.getAttribute("data-testid").catch(() => null),
    target.getAttribute("href").catch(() => null),
    target.innerText({ timeout: 1_000 }).catch(() => "")
  ]);
  const visible = await target.isVisible().catch(() => false);
  const enabled = await target.isEnabled().catch(() => false);
  log(
    "info",
    `Etape travel-groups: candidat retenu via ${firstNonEmpty.label} (tag=${tagName}, role=${role ?? "(absent)"}, `
    + `id=${id ?? "(absent)"}, data-testid=${dataTestId ?? "(absent)"}, visible=${visible}, enabled=${enabled}, `
    + `href-pathname=${hrefPathnameOf(hrefAttr, page.url())}, texte=${sanitizeDiagnosticMessage(accessibleTextRaw.trim())}).`
  );

  let clickOutcome: { ok: true } | { ok: false; className: string; message: string };
  try {
    await target.waitFor({ state: "visible", timeout: 5_000 });
    await target.scrollIntoViewIfNeeded({ timeout: 5_000 });
    if (!(await target.isVisible()) || !(await target.isEnabled())) {
      throw new Error("Element non actionnable (visible/enabled=false apres attente).");
    }
    // Trial d'abord (detecte une erreur d'actionnabilite sans declencher la
    // navigation), meme principe deja etabli pour le clic 'Continuer' voisin.
    await target.click({ trial: true, timeout: 5_000 });
    await target.click({ timeout: 5_000 });
    clickOutcome = { ok: true };
  } catch (error) {
    clickOutcome = { ok: false, ...describeUnknownError(error) };
  }

  if (!clickOutcome.ok) {
    log("warn", `Clic Playwright sur 'Selectionner' echoue (${clickOutcome.className}): ${clickOutcome.message}.`);
    return false;
  }

  log("success", "Demande selectionnee automatiquement ('Selectionner').");
  return true;
};

const notReservedTextPattern = /non r[ée]serv[ée]/i;
const bookAppointmentTextPattern = /prendre un nouveau rendez-vous/i;

// Patterns d'etat du parcours TLS, partages entre legacy_vm (sessionManager.ts,
// usage local prive non modifie ici) et l'agent (agentBotManager.ts): permet a
// l'agent de piloter sa reprise automatique par l'etat REEL de la page courante,
// comme resumeIfRecognizedState() cote legacy_vm, au lieu d'une sequence figee
// qui rejouerait des actions non pertinentes (ex. retenter clickSeConnecter/
// fillLoginForm depuis une page deja avancee dans le parcours). Correctif
// cible du blocage observe en reel sur /workflow/service-level malgre un lien
// "Continuer" deja trouvable: la cause n'etait pas un selecteur manquant mais
// une tentative suivante qui repartait en aveugle vers /fr-fr/login.
export const authPagePattern = /i2-auth\.visas-fr\.tlscontact\.com/i;
export const travelGroupsPagePattern = /\/fr-fr\/travel-groups/i;
export const applicationSummaryPagePattern = /\/workflow\/application-summary/i;
export const serviceLevelPagePattern = /\/workflow\/service-level/i;
export const appointmentBookingPathPattern = /\/workflow\/appointment-booking\//i;
// Page d'accueil TLS reelle: /fr-fr/country/<pays>/vac/<code> (cf. capture
// d'ecran/logs reels: .../fr-fr/country/tn/vac/tnTUN2fr).
export const homeCountryPagePattern = /\/country\/[^/]+\/vac\//i;

// CORRECTIF CIBLE (retour vers TARGET_URL apres expiration session TLS): apres
// environ 1h de surveillance, TLScontact peut sortir le navigateur de tout le
// parcours et le renvoyer vers l'accueil general DECONNECTE (ex. reel:
// https://visas-fr.tlscontact.com/fr-fr), distinct de homeCountryPagePattern
// ci-dessus (qui exige /country/.../vac/...). Ancre strictement sur un
// pathname de LOCALE SEULE (ex. /fr-fr ou /fr-fr/) - jamais tout le domaine
// visas-fr.tlscontact.com (que toutes les pages normales du parcours
// utilisent aussi): un pathname plus long (/fr-fr/travel-groups, /fr-fr/login,
// /fr-fr/country/.../vac/...) ne peut jamais matcher cette regexe ancree.
// Volontairement sans verification de hostname (comme tous les autres motifs
// d'etat ci-dessus, ex. homeCountryPagePattern/travelGroupsPagePattern): reste
// ainsi testable de bout en bout contre un fixture HTTP local (127.0.0.1),
// sans affaiblir la sensibilite - un pathname ancre a la locale seule ne peut
// deja plus se confondre avec une page reelle du parcours.
export const tlsLoggedOutLandingPathPattern = /^\/[a-z]{2}-[a-z]{2}\/?$/i;

export const isTlsLoggedOutLandingPage = (rawUrl: string): boolean => {
  try {
    const { pathname } = new URL(rawUrl);
    return tlsLoggedOutLandingPathPattern.test(pathname);
  } catch {
    return false;
  }
};

// HOTFIX CIBLE 0.2.1 (cause racine - bot bloque a la fois sur la page
// d'accueil ET sur /fr-fr/travel-groups, deux fois de suite en reel):
// isServiceLevelPage() se fiait a un texte GENERIQUE ("services additionnels"
// n'importe ou dans <body>) - or ce libelle apparait aussi bien dans le nav
// persistant (corrige au hotfix 0.2.0) que dans le contenu propre d'autres
// pages reelles (confirme en reel via les logs: le motif matchait alors que
// l'URL etait deja /fr-fr/travel-groups). DECISION: le CHEMIN URL est
// desormais la preuve principale et quasi-exclusive; un simple texte de page
// ne suffit plus JAMAIS a lui seul. Le repli structurel eventuel n'accepte
// qu'un marqueur DOM fort et specifique (lien reel vers l'etape suivante
// connue, avec id/data-testid exacts) - jamais du texte libre - et est
// explicitement refuse sur toute URL DEJA reconnue comme un autre etat
// (jamais false-positive croise entre etats, quel que soit leur contenu).
const STRICT_APPOINTMENT_BOOKING_LINK_SELECTORS = [
  'a#book-appointment-btn[href*="/workflow/appointment-booking/"]',
  'a[data-testid="btn-book-appointment"][href*="/workflow/appointment-booking/"]'
];

// URLs deja reconnues comme un AUTRE etat du parcours: le repli structurel
// (moins fiable que le chemin URL) n'a jamais le droit de les reclasser en
// service-level, meme si leur contenu mentionne "services additionnels"
// ailleurs sur la page (defaut reel corrige ici).
const isKnownNonServiceLevelUrl = (url: string): boolean =>
  travelGroupsPagePattern.test(url)
  || loginPathPattern.test(url)
  || authPagePattern.test(url)
  || applicationSummaryPagePattern.test(url)
  || appointmentBookingPathPattern.test(url)
  || homeCountryPagePattern.test(url);

export const isServiceLevelPage = async (page: Page): Promise<boolean> => {
  if (page.isClosed()) {
    return false;
  }
  const url = page.url();

  // Preuve principale: le chemin URL exact de l'etape service-level.
  if (serviceLevelPagePattern.test(url)) {
    return true;
  }

  // Repli structurel refuse explicitement sur toute URL deja reconnue comme
  // un autre etat du parcours - jamais de reclassement croise.
  if (isKnownNonServiceLevelUrl(url)) {
    return false;
  }

  // Repli structurel (URL inconnue uniquement): un lien REEL et VISIBLE vers
  // l'etape suivante connue (appointment-booking), avec un marqueur DOM fort
  // (id ou data-testid exact) - jamais un simple mot dans le texte de la page.
  for (const selector of STRICT_APPOINTMENT_BOOKING_LINK_SELECTORS) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) {
      return true;
    }
  }
  return false;
};

// authPagePattern seul ne suffit pas a reconnaitre "une page d'authentification":
// il ne matche QUE le vrai hostname Keycloak de production
// (i2-auth.visas-fr.tlscontact.com), jamais une page de connexion equivalente
// servie ailleurs (fixture locale de test, environnement de recette...).
// Detection de contenu en repli: presence d'un champ mot de passe visible,
// exactement le meme signal que fillLoginForm() utilise deja pour remplir le
// formulaire - garantit que les deux fonctions s'accordent sur ce qu'est
// "une page d'authentification".
export const hasVisibleLoginForm = async (page: Page): Promise<boolean> => {
  if (page.isClosed()) {
    return false;
  }
  const passwordField = page.locator('#password:visible, input[type="password"]:visible').first();
  return passwordField.isVisible().catch(() => false);
};

export const isAuthPage = async (page: Page): Promise<boolean> =>
  authPagePattern.test(page.url()) || (await hasVisibleLoginForm(page));

// Sur "Recapitulatif de la demande" (/workflow/application-summary), le rendez-vous
// affiche "Non reserve" tant qu'aucune reservation n'existe : il faut alors cliquer
// "Prendre un nouveau rendez-vous" pour continuer vers la vraie page de surveillance.
// On ne clique que si ce statut "non reserve" est confirme, pour ne jamais toucher a
// une reservation deja existante.
export const clickBookNewAppointment = async (page: Page, log: LogFn): Promise<boolean> => {
  const notReserved = await page.getByText(notReservedTextPattern).first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (!notReserved) {
    return false;
  }

  const bookButton = page.locator("#btn-confirm-appointment:visible")
    .or(page.getByRole("button", { name: bookAppointmentTextPattern }))
    .first();

  if (!(await clickLocatorIfVisible(bookButton, 5_000).catch(() => false))) {
    log("warn", "Statut 'Non reserve' detecte mais bouton 'Prendre un nouveau rendez-vous' introuvable.");
    return false;
  }

  log("success", "Rendez-vous non reserve: clic automatique sur 'Prendre un nouveau rendez-vous'.");
  return true;
};

const continueLinkNamePattern = /^continuer$/i;

// Ordre de recherche strict (jamais un bouton generique, jamais "n'importe
// quel element contenant Continuer" sans validation du href): du plus
// specifique (id+href) au plus generique (role+libelle). Chaque candidat est
// ensuite revalide explicitement contre /workflow/appointment-booking/ avant
// tout clic (cf. performClickContinueServiceLevel), y compris le repli par role.
const CONTINUE_LINK_SELECTORS = [
  'a#book-appointment-btn[href*="/workflow/appointment-booking/"]',
  'a[data-testid="btn-book-appointment"][href*="/workflow/appointment-booking/"]',
  'a[href*="/workflow/appointment-booking/"]'
];

type ContinueLinkTarget = { locator: Locator; matchedSelector: string; candidateCount: number };

const resolveContinueLinkTarget = async (page: Page): Promise<ContinueLinkTarget | null> => {
  for (const selector of CONTINUE_LINK_SELECTORS) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      return { locator: locator.first(), matchedSelector: selector, candidateCount: count };
    }
  }
  const roleLocator = page.getByRole("link", { name: continueLinkNamePattern });
  const roleCount = await roleLocator.count().catch(() => 0);
  if (roleCount > 0) {
    return { locator: roleLocator.first(), matchedSelector: "role=link[name=Continuer] (repli)", candidateCount: roleCount };
  }
  return null;
};

const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 500;

// Journalisation diagnostique jamais sensible: jamais login/mot de passe/
// cookies/token/query string/DOM complet. Une erreur Playwright brute peut
// occasionnellement citer un court fragment de balisage (ex. l'element qui
// intercepte le clic) - on tronque et on masque par prudence supplementaire
// tout motif ressemblant a un identifiant/secret.
const sanitizeDiagnosticMessage = (raw: string): string => {
  const truncated = raw.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH
    ? `${raw.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH)}...(tronque)`
    : raw;
  return truncated
    .replace(/password=[^&\s"']+/gi, "password=[redacted]")
    .replace(/token=[^&\s"']+/gi, "token=[redacted]")
    .replace(/authorization\s*:\s*\S+/gi, "authorization: [redacted]")
    .replace(/cookie\s*:\s*[^\n]+/gi, "cookie: [redacted]");
};

const describeUnknownError = (error: unknown): { className: string; message: string } => ({
  className: error instanceof Error ? error.constructor.name : typeof error,
  message: sanitizeDiagnosticMessage(error instanceof Error ? error.message : String(error))
});

const hrefPathnameOf = (rawHref: string | null, baseUrl: string): string => {
  if (!rawHref) {
    return "(absent)";
  }
  try {
    return new URL(rawHref, baseUrl).pathname;
  } catch {
    return "(invalide)";
  }
};

const resolveAbsoluteHref = (rawHref: string | null, baseUrl: string): URL | null => {
  if (!rawHref) {
    return null;
  }
  try {
    return new URL(rawHref, baseUrl);
  } catch {
    return null;
  }
};

// Validation stricte partagee par le controle pre-clic ET le repli par
// navigation (jamais deux logiques divergentes): protocole http(s), MEME
// origine que la page courante, et chemin contenant exactement
// /workflow/appointment-booking/. Exportee pour etre testee directement
// (refus d'une origine externe, refus d'un chemin incorrect) sans avoir a
// declencher tout le cycle clic-echoue-puis-repli.
export const isAllowedAppointmentBookingRedirect = (absoluteTarget: URL, currentPageUrl: string): boolean => {
  const protocolOk = absoluteTarget.protocol === "http:" || absoluteTarget.protocol === "https:";
  let sameOrigin = false;
  try {
    sameOrigin = new URL(currentPageUrl).origin === absoluteTarget.origin;
  } catch {
    sameOrigin = false;
  }
  const pathnameOk = appointmentBookingPathPattern.test(absoluteTarget.pathname);
  return protocolOk && sameOrigin && pathnameOk;
};

// Repli de derniere instance UNIQUEMENT si l'element exact a deja ete trouve
// ET son href deja strictement valide (avant cet appel) mais que le clic
// Playwright lui-meme a echoue (overlay, barre sticky en mouvement, element
// detache pendant un rerender...): jamais utilise pour ignorer un paiement,
// un CAPTCHA, Cloudflare, ou pour selectionner/confirmer quoi que ce soit -
// la cible est TOUJOURS exactement celle du href deja affiche a l'utilisateur,
// revalidee ici une seconde fois avant de naviguer.
const attemptControlledHrefFallback = async (
  page: Page,
  absoluteTarget: URL,
  currentPageUrl: string,
  log: LogFn
): Promise<boolean> => {
  if (!isAllowedAppointmentBookingRedirect(absoluteTarget, currentPageUrl)) {
    log("warn", "Repli par navigation controlee refuse: cible non conforme (origine/protocole/chemin invalide).");
    return false;
  }

  try {
    await page.goto(absoluteTarget.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 });
    log("warn", "Repli par navigation controlee utilise (le clic Playwright avait echoue mais la cible etait strictement validee: meme origine, http(s), /workflow/appointment-booking/).");
    return true;
  } catch (error) {
    const { className, message } = describeUnknownError(error);
    log("warn", `Repli par navigation controlee egalement en echec (${className}): ${message}`);
    return false;
  }
};

// Deduplication: une meme Page ne doit jamais subir deux tentatives
// concurrentes de clic "Continuer" (ex. VALIDATE_BOT manuel declenche pendant
// qu'une reprise automatique est deja en cours sur la meme page) - la seconde
// attend et reutilise le resultat de la premiere plutot que de cliquer une
// seconde fois.
const serviceLevelTransitionInFlight = new WeakMap<Page, Promise<boolean>>();

// TLScontact insere parfois une etape "Services additionnels" avant la page
// appointment-booking. Tant qu'aucun service optionnel n'est selectionne par
// RendezBot, le seul geste metier attendu est de continuer vers l'etape de
// prise de rendez-vous.
//
// HOTFIX CIBLE (service-level bloque malgre un lien "Continuer" deja valide
// et deja trouvable en reel): l'ancienne version avalait toute erreur du clic
// dans un .catch(() => false), masquant la vraie cause (timeout, element
// intercepte, non actionnable, navigation en cours...) derriere le seul
// message "bouton introuvable" - alors que l'element etait present. Cette
// version conserve et journalise l'erreur reelle (sans donnee sensible),
// verifie l'actionnabilite avant de cliquer (trial click), ne considere le
// clic reussi qu'apres confirmation de la navigation vers appointment-booking,
// et ne se rabat sur une navigation directe que si la cible a ete strictement
// validee (meme origine, http(s), chemin exact).
const performClickContinueServiceLevel = async (page: Page, log: LogFn): Promise<boolean> => {
  if (!(await isServiceLevelPage(page))) {
    return false;
  }

  const target = await resolveContinueLinkTarget(page);
  if (!target) {
    log("warn", "Etape services additionnels detectee mais aucun lien 'Continuer' valide (vers /workflow/appointment-booking/) n'a ete trouve.");
    return false;
  }

  const currentPageUrl = page.url();
  const rawHref = await target.locator.getAttribute("href").catch(() => null);
  const absoluteTarget = resolveAbsoluteHref(rawHref, currentPageUrl);
  if (!absoluteTarget || !isAllowedAppointmentBookingRedirect(absoluteTarget, currentPageUrl)) {
    log(
      "warn",
      `Lien 'Continuer' trouve (${target.matchedSelector}) mais sa cible n'est pas strictement validee `
      + `(meme origine http(s) + /workflow/appointment-booking/ attendus; pathname obtenu: ${hrefPathnameOf(rawHref, currentPageUrl)}): clic refuse.`
    );
    return false;
  }

  // Diagnostic avant clic (jamais de donnee sensible: ni login/mot de passe,
  // ni cookies/token, ni query string, ni DOM complet - uniquement des
  // attributs structurels publics de l'element candidat).
  const [tagName, id, dataTestId, visible, enabled, boundingBox] = await Promise.all([
    target.locator.evaluate((el) => el.tagName).catch(() => "?"),
    target.locator.getAttribute("id").catch(() => null),
    target.locator.getAttribute("data-testid").catch(() => null),
    target.locator.isVisible().catch(() => false),
    target.locator.isEnabled().catch(() => false),
    target.locator.boundingBox().catch(() => null)
  ]);
  log(
    "info",
    `Etape services additionnels: candidat 'Continuer' trouve via ${target.matchedSelector} `
    + `(candidats=${target.candidateCount}, tag=${tagName}, id=${id ?? "(absent)"}, `
    + `data-testid=${dataTestId ?? "(absent)"}, visible=${visible}, enabled=${enabled}, `
    + `href-pathname=${absoluteTarget.pathname}, bbox=${boundingBox ? "oui" : "absente"}).`
  );

  let clickOutcome: { ok: true } | { ok: false; className: string; message: string };
  try {
    await target.locator.waitFor({ state: "visible", timeout: 5_000 });
    await target.locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
    if (!(await target.locator.isVisible()) || !(await target.locator.isEnabled())) {
      throw new Error("Element non actionnable (visible/enabled=false apres attente).");
    }
    // Trial: detecte une erreur d'actionnabilite (overlay, interception par
    // la barre sticky, element instable) SANS declencher la navigation,
    // avant le vrai clic - jamais avale silencieusement.
    await target.locator.click({ trial: true, timeout: 5_000 });
    await target.locator.click({ timeout: 5_000 });
    clickOutcome = { ok: true };
  } catch (error) {
    clickOutcome = { ok: false, ...describeUnknownError(error) };
  }

  if (!clickOutcome.ok) {
    log("warn", `Clic Playwright sur 'Continuer' (services additionnels) echoue (${clickOutcome.className}): ${clickOutcome.message}.`);
    const fallbackOk = await attemptControlledHrefFallback(page, absoluteTarget, currentPageUrl, log);
    if (!fallbackOk) {
      return false;
    }
  } else {
    // Le clic n'ayant pas leve d'exception, on attend encore la confirmation
    // reelle de la navigation - jamais un succes suppose du seul fait que
    // click() n'a pas jete d'erreur (point explicitement corrige ici).
    await page.waitForURL(appointmentBookingPathPattern, { timeout: 20_000 }).catch(() => undefined);
  }

  if (!appointmentBookingPathPattern.test(page.url())) {
    log("warn", "Clic/navigation 'Continuer' effectue mais la page appointment-booking n'a jamais ete atteinte.");
    return false;
  }

  log("success", "Etape services additionnels: 'Continuer' confirme, page appointment-booking atteinte.");
  return true;
};

export const clickContinueServiceLevel = async (page: Page, log: LogFn): Promise<boolean> => {
  const inFlight = serviceLevelTransitionInFlight.get(page);
  if (inFlight) {
    log("info", "Transition 'Continuer' (services additionnels) deja en cours pour cette page: attente du resultat en cours plutot qu'un second clic.");
    return inFlight;
  }

  const attempt = performClickContinueServiceLevel(page, log);
  serviceLevelTransitionInFlight.set(page, attempt);
  try {
    return await attempt;
  } finally {
    if (serviceLevelTransitionInFlight.get(page) === attempt) {
      serviceLevelTransitionInFlight.delete(page);
    }
  }
};
