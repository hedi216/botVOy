import { Locator, Page } from "playwright";
import { MonitorEventLevel } from "./types.js";

type LogFn = (level: MonitorEventLevel, message: string) => void;

// Sur TLScontact, "Se connecter" pointe toujours vers /fr-fr/login : directement
// visible dans le header en fenetre large (xl), derriere l'icone du "Dropdown selector"
// (role="listitem") en fenetre etroite.
const loginLinkSelector = 'a[href="/fr-fr/login"]:visible';
const dropdownToggleSelector = '[aria-label="Dropdown selector"] [role="listitem"]';
const directLoginTextPattern = /^se connecter$/i;

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

// Le lien "Se connecter" pointe toujours vers /fr-fr/login, que ce soit en fenetre
// large (visible directement) ou etroite (derriere un menu compte qui, en pratique,
// se referme parfois avant qu'on ait pu cliquer dedans). Naviguer directement vers
// cette URL connue evite toute dependance a ce menu deroulant peu fiable.
const navigateToLogin = async (page: Page, log: LogFn): Promise<boolean> => {
  const currentUrl = page.url();
  if (!isSafeNavigationBase(currentUrl)) {
    log("warn", `Navigation directe vers /fr-fr/login impossible: page actuelle non exploitable comme base (${currentUrl}).`);
    return false;
  }

  try {
    const target = new URL("/fr-fr/login", currentUrl).toString();
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 8_000 });
    log("success", `Navigation directe vers ${target}.`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("warn", `Navigation directe vers /fr-fr/login impossible: ${message}`);
    return false;
  }
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

// Apres connexion, TLScontact affiche parfois "Gestionnaire des demandes"
// (/fr-fr/travel-groups) avant la page de rendez-vous : il faut cliquer
// "Selectionner" sur la demande pour continuer. S'il y en a plusieurs, on prend
// la premiere et on le signale (pas de logique de tri par categorie ici).
export const clickSelectTravelGroup = async (page: Page, log: LogFn): Promise<boolean> => {
  const buttons = page.getByRole("button", { name: selectTravelGroupTextPattern });
  const count = await buttons.count().catch(() => 0);

  if (count === 0) {
    return false;
  }

  if (count > 1) {
    log("warn", `${count} demandes trouvees sur 'Gestionnaire des demandes'. Selection de la premiere.`);
  }

  if (!(await clickLocatorIfVisible(buttons.first(), 5_000).catch(() => false))) {
    log("warn", "Bouton 'Selectionner' trouve mais non cliquable.");
    return false;
  }

  log("success", "Demande selectionnee automatiquement ('Selectionner').");
  return true;
};

const notReservedTextPattern = /non r[ée]serv[ée]/i;
const bookAppointmentTextPattern = /prendre un nouveau rendez-vous/i;
const serviceLevelPagePattern = /\/workflow\/service-level/i;
const serviceLevelTitlePattern = /services additionnels|additional services/i;
// Libelle strict ("Continuer") d'abord, puis des formulations de poursuite
// plus larges - jamais un mot qui pourrait designer une action destructive/
// laterale sur cette page ("Ajouter", "Annuler", "Retour", un nom de service):
// uniquement des tournures qui font avancer vers la prise de rendez-vous.
const continueTextPattern = /^(continuer|continue|poursuivre|suivant|next)$|continuer vers|prendre.*(rendez-vous|rdv)|r[ée]server|book.*appointment/i;

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

// TLScontact insere parfois une etape "Services additionnels" avant la page
// appointment-booking. Tant qu'aucun service optionnel n'est selectionne par
// RendezBot, le seul geste metier attendu est de continuer vers l'etape de
// prise de rendez-vous.
export const clickContinueServiceLevel = async (page: Page, log: LogFn): Promise<boolean> => {
  const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
  if (!serviceLevelPagePattern.test(page.url()) && !serviceLevelTitlePattern.test(bodyText)) {
    return false;
  }

  // Priorite au repere structurel deja observe en reel sur cette etape
  // (id/data-testid, ou lien pointant explicitement vers l'etape suivante du
  // parcours) : insensible au libelle exact ou a la langue, donc plus fiable
  // qu'un texte. Confirme via DevTools sur un test reel (cf.
  // artifacts/logs/agent.log du 2026-07-25) que ce "Continuer" est en realite
  // un <a href="/workflow/appointment-booking/..."> (role="link"), pas un
  // <button> - d'ou aussi la recherche sur les deux roles en repli texte.
  const continueButton = page.locator('#book-appointment-btn:visible, [data-testid="btn-book-appointment"]:visible, a[href*="/workflow/appointment-booking/"]:visible')
    .or(page.getByRole("button", { name: continueTextPattern }))
    .or(page.getByRole("link", { name: continueTextPattern }))
    .or(page.locator("button, a").filter({ hasText: continueTextPattern }))
    .first();

  if (!(await clickLocatorIfVisible(continueButton, 5_000).catch(() => false))) {
    log("warn", "Etape services additionnels detectee mais bouton 'Continuer' introuvable.");
    return false;
  }

  log("success", "Etape services additionnels detectee: clic automatique sur 'Continuer'.");
  return true;
};
