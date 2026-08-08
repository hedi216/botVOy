// CHANTIER CIBLE (gestion des echeances et impayes des agences) - tests
// frontend pilotes avec un vrai navigateur (Playwright) contre une vraie
// instance du serveur + PostgreSQL: ecran de blocage, bandeau non bloquant
// (grace/override), interception globale du code PAYMENT_SUSPENDED en cours
// de session, et extension de l'ecran admin "Agences" (inputs date/datetime-
// local, jamais window.prompt).
//
// Usage: npx tsx scripts/test-agency-billing-frontend.ts

import { ChildProcess, spawn } from "node:child_process";
import { Browser, Page, chromium } from "playwright";
import { pool } from "../src/db.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();

let passCount = 0;
let failCount = 0;

const log = (label: string, message: string): void => {
  console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
};

const assert = (condition: boolean, description: string): void => {
  if (condition) {
    passCount += 1;
    console.log(`[PASS] ${description}`);
  } else {
    failCount += 1;
    console.error(`[FAIL] ${description}`);
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const dateOnlyPlusDays = (base: string, days: number): string => {
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
};

// Meme technique que agencyBillingService.ts (Intl en-CA -> YYYY-MM-DD direct).
const todayInTunis = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tunis" }).format(new Date());
const TODAY = todayInTunis();

// --- Cycle de vie serveur ---

type ServerHandle = { child: ChildProcess; baseUrl: string };

const waitForServerReady = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/me`);
      if (res.status === 401 || res.status === 200) {
        return;
      }
    } catch {
      // pas encore pret
    }
    await sleep(500);
  }
  throw new Error(`Le serveur de test n'a jamais repondu sur ${baseUrl}/api/me.`);
};

const startServer = async (port: number): Promise<ServerHandle> => {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(command, ["tsx", "src/server.ts"], {
    env: { ...process.env, WEB_PORT: String(port), BOT_EXECUTION_MODE: "agent" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  child.stdout?.on("data", (chunk: Buffer) => log("SERVER_STDOUT", chunk.toString().trim()));
  child.stderr?.on("data", (chunk: Buffer) => log("SERVER_STDERR", chunk.toString().trim()));
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  return { child, baseUrl };
};

const stopServer = async (handle: ServerHandle): Promise<void> => {
  if (!handle.child.pid) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(handle.child.pid), "/T", "/F"]);
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  handle.child.kill("SIGTERM");
};

// --- Fixtures HTTP (admin cree agences/utilisateurs/echeances via l'API reelle) ---

type HttpResult = { status: number; body: unknown; cookie?: string };

const extractCookie = (res: globalThis.Response): string | undefined => {
  const setCookie = res.headers.get("set-cookie");
  return setCookie ? setCookie.split(";")[0] : undefined;
};

const requestJson = async (
  baseUrl: string,
  method: string,
  pathName: string,
  cookie: string | undefined,
  json?: unknown
): Promise<HttpResult> => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(json ?? {}) } : {})
  });
  const rawText = await res.text();
  let body: unknown = null;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    body = rawText;
  }
  return { status: res.status, body, cookie: extractCookie(res) };
};

const login = async (baseUrl: string, loginName: string, password: string): Promise<string> => {
  const result = await requestJson(baseUrl, "POST", "/api/login", undefined, { login: loginName, password });
  if (result.status !== 200 || !result.cookie) {
    throw new Error(`Login ${loginName} a echoue: ${JSON.stringify(result.body)}`);
  }
  return result.cookie;
};

const loginWithRetry = async (baseUrl: string, loginName: string, password: string, attempts = 5): Promise<string> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await login(baseUrl, loginName, password);
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

const createAgencyAndManager = async (
  baseUrl: string,
  adminCookie: string,
  labelSuffix: string,
  nextPaymentDate: string | null
): Promise<{ agencyId: number; managerLogin: string; managerPassword: string; agencyName: string }> => {
  const agencyName = `Test BillingUI ${labelSuffix} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency?: { id: number } })?.agency?.id;
  if (!agencyId) {
    throw new Error(`Creation agence '${agencyName}' echouee (status=${agencyResult.status}): ${JSON.stringify(agencyResult.body)}`);
  }

  if (nextPaymentDate) {
    await requestJson(baseUrl, "PATCH", `/api/agencies/${agencyId}/billing`, adminCookie, { nextPaymentDate });
  }

  const managerLogin = `test-billingui-${labelSuffix.toLowerCase()}-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const userResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: `Manager ${labelSuffix}`, email: `${managerLogin}@example.test`, role: 1
  });
  const managerPassword = (userResult.body as { temporaryPassword: string }).temporaryPassword;

  return { agencyId, managerLogin, managerPassword, agencyName };
};

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) {
    await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  }
  if (createdAgencyNames.length > 0) {
    await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
  }
};

// --- Helpers Playwright ---

const loginViaUi = async (page: Page, baseUrl: string, loginName: string, password: string): Promise<void> => {
  await page.goto(baseUrl);
  await page.fill("#loginInput", loginName);
  await page.fill("#passwordInput", password);
  await page.click('#loginForm button[type="submit"]');
};

const waitForAgencyRowText = (page: Page, agencyName: string, expectedSubstring: string): Promise<void> =>
  page.waitForFunction(
    ({ name, text }) => {
      const rows = [...document.querySelectorAll("#agencyTableBody tr")];
      const row = rows.find((candidate) => (candidate.textContent || "").includes(name));
      return Boolean(row && (row.textContent || "").includes(text));
    },
    { name: agencyName, text: expectedSubstring },
    { timeout: 10_000 }
  ) as unknown as Promise<void>;

const collectConsoleErrors = (page: Page, bucket: string[]): void => {
  const expectedNoise = /Failed to load resource/i;
  page.on("console", (message) => {
    if (message.type() === "error" && !expectedNoise.test(message.text())) {
      bucket.push(message.text());
    }
  });
  page.on("pageerror", (error) => bucket.push(error.message));
};

// --- Scenario principal ---

const run = async (): Promise<void> => {
  let browser: Browser | undefined;
  const servers: ServerHandle[] = [];
  const consoleErrors: string[] = [];

  try {
    browser = await chromium.launch({ headless: true });
    const server = await startServer(3261);
    servers.push(server);

    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    const graceFixture = await createAgencyAndManager(server.baseUrl, adminCookie, "Grace", dateOnlyPlusDays(TODAY, -3));
    const suspendedFixture = await createAgencyAndManager(server.baseUrl, adminCookie, "Suspended", dateOnlyPlusDays(TODAY, -10));
    const overrideFixture = await createAgencyAndManager(server.baseUrl, adminCookie, "Override", dateOnlyPlusDays(TODAY, -20));
    await requestJson(server.baseUrl, "PATCH", `/api/agencies/${overrideFixture.agencyId}/billing`, adminCookie, {
      overrideUntil: new Date(Date.now() + 3_600_000).toISOString()
    });

    // ===================== A) grace_period: bandeau non bloquant, app usable =====================
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      collectConsoleErrors(page, consoleErrors);
      await loginViaUi(page, server.baseUrl, graceFixture.managerLogin, graceFixture.managerPassword);
      await page.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
      assert(await page.isHidden("#billingLockScreen"), "A) grace_period: l'ecran de blocage reste masque (accessAllowed=true)");
      await page.waitForSelector("#billingBanner:not([hidden])", { timeout: 10_000 });
      const bannerText = await page.locator("#billingBannerMessage").textContent();
      assert(Boolean(bannerText && /reste 4 jour/i.test(bannerText)), `A) Bandeau grace_period affiche le compte a rebours ("il vous reste 4 jours" attendu, obtenu: ${bannerText})`);
      // Navigation explicite (plutot qu'une simple lecture de la page de
      // routage post-login, qui peut atterrir sur /agent-setup si aucun agent
      // n'est encore appaire pour cette agence de test - comportement Task 2/3
      // sans rapport avec la facturation): prouve que l'app reste pleinement
      // navigable pendant la periode de grace, jamais bloquante.
      await page.click('[data-page-target="dashboard"]');
      await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });
      assert(await page.isVisible("#dashboardStatus"), "A) Le Dashboard reste pleinement utilisable et navigable pendant la periode de grace (jamais bloquant)");
      await context.close();
    }

    // ===================== B) suspended: ecran de blocage exact, app inaccessible =====================
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      collectConsoleErrors(page, consoleErrors);
      await loginViaUi(page, server.baseUrl, suspendedFixture.managerLogin, suspendedFixture.managerPassword);
      await page.waitForSelector("#billingLockScreen:not([hidden])", { timeout: 10_000 });

      assert(await page.isHidden("#appLayout"), "B) Suspension: #appLayout reste MASQUE (aucun Dashboard/Bot accessible derriere l'ecran de blocage)");
      const lockText = (await page.locator("#billingLockScreen").textContent()) || "";
      assert(lockText.includes("Acces suspendu"), "B) Message exact: 'Acces suspendu'");
      assert(lockText.includes("n'a pas ete regularise") || lockText.includes("n'a pas été régularisé"), "B) Message exact: paiement non regularise");
      assert(lockText.includes("Contactez votre agence ou l'administrateur RendezBot") || lockText.includes("Contactez votre agence ou l'administrateur RendezBot."), "B) Message exact: contact agence/administrateur");
      const expectedDate = dateOnlyPlusDays(TODAY, -10).split("-").reverse().join("/");
      const lockDateText = await page.locator("#billingLockDate").textContent();
      assert(lockDateText === expectedDate, `B) La date d'echeance affichee correspond a next_payment_date (attendu ${expectedDate}, obtenu ${lockDateText})`);

      // Deconnexion possible depuis l'ecran de blocage (seule action requise/autorisee).
      await page.click("#billingLockLogout");
      await page.waitForSelector("#loginScreen:not([hidden])", { timeout: 10_000 });
      assert(true, "B) La deconnexion depuis l'ecran de blocage ramene bien a l'ecran de login");
      await context.close();
    }

    // ===================== C) override actif: bandeau informatif, app usable =====================
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      collectConsoleErrors(page, consoleErrors);
      await loginViaUi(page, server.baseUrl, overrideFixture.managerLogin, overrideFixture.managerPassword);
      await page.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
      assert(await page.isHidden("#billingLockScreen"), "C) Autorisation temporaire active: aucun ecran de blocage malgre une echeance tres depassee");
      await page.waitForSelector("#billingBanner:not([hidden])", { timeout: 10_000 });
      const overrideBannerText = await page.locator("#billingBannerMessage").textContent();
      assert(Boolean(overrideBannerText && /autorise temporairement/i.test(overrideBannerText)), `C) Bandeau distinct pour l'autorisation temporaire (obtenu: ${overrideBannerText})`);
      const hasOverrideClass = await page.locator("#billingBanner").evaluate((el) => el.classList.contains("billing-banner-override"));
      assert(hasOverrideClass, "C) Le bandeau override porte une classe visuelle distincte du bandeau grace_period/due_today");

      // ---- Coexistence avec le bandeau Agent (Task 3): jamais le meme element ----
      const distinctBanners = await page.evaluate(() => document.querySelector("#billingBanner") !== document.querySelector("#agentUpdateBanner"));
      assert(distinctBanners, "F) #billingBanner et #agentUpdateBanner sont deux elements DOM distincts (jamais reutilise l'un pour l'autre)");
      const agentUpdateBannerStillHidden = await page.isHidden("#agentUpdateBanner");
      assert(agentUpdateBannerStillHidden, "F) L'affichage du bandeau de facturation ne rend jamais visible le bandeau Agent (VERSION_INCOMPATIBLE) par effet de bord");
      await context.close();
    }

    // ===================== D) Interception PAYMENT_SUSPENDED EN COURS DE SESSION =====================
    {
      const midFixture = await createAgencyAndManager(server.baseUrl, adminCookie, "MidSession", dateOnlyPlusDays(TODAY, 5));
      const context = await browser.newContext();
      const page = await context.newPage();
      collectConsoleErrors(page, consoleErrors);
      await loginViaUi(page, server.baseUrl, midFixture.managerLogin, midFixture.managerPassword);
      await page.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
      assert(await page.isHidden("#billingLockScreen"), "D) Precondition: session ouverte normalement, agence encore 'current'");

      // L'agence est suspendue par un admin PENDANT que la session est deja ouverte.
      await requestJson(server.baseUrl, "PATCH", `/api/agencies/${midFixture.agencyId}/billing`, adminCookie, {
        nextPaymentDate: dateOnlyPlusDays(TODAY, -10)
      });

      // Premiere requete metier suivante (ici: soumission des parametres de
      // surveillance) -> doit reconnaitre PAYMENT_SUSPENDED et basculer
      // IMMEDIATEMENT sur l'ecran de blocage, sans rechargement de page.
      await page.click('[data-page-target="settings"]');
      await page.waitForSelector("#page-settings.active", { timeout: 10_000 });
      await page.click('#settingsForm button[type="submit"]');
      await page.waitForSelector("#billingLockScreen:not([hidden])", { timeout: 10_000 });
      assert(await page.isHidden("#appLayout"), "Correction #4/D) Une action metier refusee avec PAYMENT_SUSPENDED bascule IMMEDIATEMENT sur l'ecran de blocage, sans texte d'erreur local ni rechargement");
      await context.close();
    }

    // ===================== E) Role 0: jamais de bandeau/ecran de blocage pour son propre compte =====================
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      collectConsoleErrors(page, consoleErrors);
      await loginViaUi(page, server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
      await page.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
      assert(await page.isHidden("#billingLockScreen"), "E) Role 0: jamais d'ecran de blocage (aucune agence propre)");
      assert(await page.isHidden("#billingBanner"), "E) Role 0: jamais de bandeau de facturation pour son propre compte");

      // ===================== D bis) Ecran admin Agences: colonnes, inputs date, override =====================
      await page.click('[data-page-target="agencies"]');
      await page.waitForSelector("#page-agencies.active", { timeout: 10_000 });

      const headers = await page.locator("#page-agencies thead th").allTextContents();
      for (const expected of ["Statut agence", "Prochain paiement", "Statut paiement"]) {
        assert(headers.includes(expected), `Correction #9) Colonne '${expected}' presente dans l'entete du tableau Agences`);
      }

      const freshFixture = await createAgencyAndManager(server.baseUrl, adminCookie, "AdminUiFresh", null);
      await page.reload();
      await page.click('[data-page-target="agencies"]');
      await page.waitForSelector("#page-agencies.active", { timeout: 10_000 });
      await waitForAgencyRowText(page, freshFixture.agencyName, "Non configure");
      assert(true, "Correction #9) Une agence sans echeance affiche le badge 'Non configure' (jamais suspendue par defaut)");

      const dateInputCount = await page.locator("#agencyTableBody input[type='date']").count();
      const overrideInputCount = await page.locator("#agencyTableBody input[type='datetime-local']").count();
      assert(dateInputCount > 0, "Correction #9) La colonne 'Prochain paiement' utilise <input type=\"date\"> (jamais window.prompt)");
      assert(overrideInputCount > 0, "Correction #9) La gestion de l'autorisation temporaire utilise <input type=\"datetime-local\"> (jamais window.prompt)");

      const freshRow = page.locator("#agencyTableBody tr", { hasText: freshFixture.agencyName });
      const futureDate = dateOnlyPlusDays(TODAY, 15);
      await freshRow.locator("input[type='date']").fill(futureDate);
      await freshRow.locator("button[data-save-next-payment-date]").click();
      await waitForAgencyRowText(page, freshFixture.agencyName, "A jour");
      assert(true, "D bis) Apres saisie d'une echeance future via l'input date + 'Enregistrer', le badge passe a 'A jour'");

      const overrideRow = page.locator("#agencyTableBody tr", { hasText: freshFixture.agencyName });
      // Reproduit exactement l'exemple demande: "20/08/2026 18:00" saisi tel
      // quel dans <input type="datetime-local"> doit representer 18:00
      // Africa/Tunis (jamais 18:00 UTC ni l'heure locale du navigateur/serveur
      // executant ce test). public/app.js transmet input.value tel quel (aucune
      // transformation cote client, verifie par lecture directe du code) ;
      // seul parseOverrideUntilInput() cote backend applique le decalage fixe
      // +01:00 de la Tunisie. On verifie ici la CHAINE COMPLETE (UI -> API ->
      // valeur stockee), pas seulement la fonction backend isolee (deja
      // couverte unitairement dans scripts/test-agency-billing.ts).
      const overrideDateOnly = dateOnlyPlusDays(TODAY, 30);
      const typedDateTimeLocal = `${overrideDateOnly}T18:00`;
      const expectedUtcInstant = `${overrideDateOnly}T17:00:00.000Z`;
      await overrideRow.locator("input[type='datetime-local']").fill(typedDateTimeLocal);
      await overrideRow.locator("button[data-grant-override]").click();
      await waitForAgencyRowText(page, freshFixture.agencyName, "Autorisation temporaire");
      assert(true, "D bis) 'Autoriser temporairement' pose bien une autorisation, reflete immediatement dans le badge de statut paiement");

      const agenciesAfterOverride = await requestJson(server.baseUrl, "GET", "/api/agencies", adminCookie);
      const freshAgencyRow = (agenciesAfterOverride.body as { agencies: Array<{ id: number; billing: { overrideUntil: string | null } }> }).agencies.find((a) => a.id === freshFixture.agencyId);
      assert(
        freshAgencyRow?.billing?.overrideUntil === expectedUtcInstant,
        `Correction timezone override) "${typedDateTimeLocal}" saisi via <input type="datetime-local"> -> stocke comme ${expectedUtcInstant} (18:00 Africa/Tunis = 17:00 UTC), jamais 18:00 UTC (obtenu: ${freshAgencyRow?.billing?.overrideUntil})`
      );

      const removeRow = page.locator("#agencyTableBody tr", { hasText: freshFixture.agencyName });
      await removeRow.locator("button[data-remove-override]").click();
      await waitForAgencyRowText(page, freshFixture.agencyName, "A jour");
      assert(true, "D bis) 'Supprimer l'autorisation' retire l'override, le badge revient a l'etat reel sous-jacent ('A jour' ici)");

      await context.close();
    }

    assert(consoleErrors.length === 0, `Aucune erreur console inattendue sur l'ensemble du scenario (obtenu: ${JSON.stringify(consoleErrors)})`);
  } finally {
    if (browser) {
      await browser.close();
    }
    await cleanupTestData().catch((error) => log("CLEANUP_ERROR", String(error)));
    for (const handle of servers) {
      await stopServer(handle);
    }
    await pool.end().catch(() => undefined);
  }
};

run()
  .then(() => {
    console.log(`\n${passCount} succes, ${failCount} echec(s).`);
    process.exit(failCount > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error("Erreur fatale pendant le scenario de test:", error);
    process.exit(1);
  });
