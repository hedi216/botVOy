// Tests d'integration frontend Phase 2 (detection, /agent/setup, page Agent
// local, bandeau, indicateur, modale) pilotes avec un vrai navigateur
// (Playwright, deja une dependance du projet) contre une vraie instance du
// serveur + PostgreSQL. Un agent "fantome" est simule via socket.io-client en
// arriere-plan pour provoquer des changements de statut en temps reel.
//
// Usage: npx tsx scripts/test-phase2-frontend.ts

import { ChildProcess, spawn } from "node:child_process";
import { Browser, Page, chromium } from "playwright";
import { Socket, io as ioClient } from "socket.io-client";
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

// --- Detection recursive de cles sensibles (reprise des scripts precedents) ---

const FORBIDDEN_KEY_SUBSTRINGS = ["token", "secret", "password", "code_hash", "codehash"];

const findForbiddenKeys = (value: unknown, pathPrefix = ""): string[] => {
  if (value === null || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenKeys(item, `${pathPrefix}[${index}]`));
  }
  const found: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (FORBIDDEN_KEY_SUBSTRINGS.some((forbidden) => key.toLowerCase().includes(forbidden))) {
      found.push(fullPath);
    }
    found.push(...findForbiddenKeys(nested, fullPath));
  }
  return found;
};

// --- Cycle de vie serveur (un process par jeu de variables d'environnement) ---

type ServerHandle = { child: ChildProcess; baseUrl: string; port: number };

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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Le serveur de test n'a jamais repondu sur ${baseUrl}/api/me.`);
};

const startServer = async (port: number, env: Record<string, string>): Promise<ServerHandle> => {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(command, ["tsx", "src/server.ts"], {
    env: { ...process.env, WEB_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  child.stdout?.on("data", (chunk: Buffer) => log("SERVER_STDOUT", chunk.toString().trim()));
  child.stderr?.on("data", (chunk: Buffer) => log("SERVER_STDERR", chunk.toString().trim()));

  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  return { child, baseUrl, port };
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

// --- Fixtures HTTP (admin cree agences/utilisateurs via l'API reelle) ---

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
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

const createAgencyAndManager = async (
  baseUrl: string,
  adminCookie: string,
  labelSuffix: string
): Promise<{ agencyId: number; managerLogin: string; managerPassword: string }> => {
  const agencyName = `Test Phase2 ${labelSuffix} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;

  const managerLogin = `test-p2-${labelSuffix.toLowerCase()}-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const userResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: `Manager ${labelSuffix}`, email: `${managerLogin}@example.test`, role: 1
  });
  const managerPassword = (userResult.body as { temporaryPassword: string }).temporaryPassword;

  return { agencyId, managerLogin, managerPassword };
};

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) {
    await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  }
  if (createdAgencyNames.length > 0) {
    await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
  }
};

// --- Agent fantome (socket.io-client), pour simuler des changements de statut ---

type FakeAgent = { agentId: number; token: string; socket: Socket };

const pairFakeAgent = (baseUrl: string, pairingCode: string, computerName: string, version: string): Promise<FakeAgent> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false,
      reconnection: false,
      auth: { mode: "pair", pairingCode, computerName, version, protocolVersion: 1 }
    });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error(`Timeout appairage ${computerName}`)); }, 8_000);
    socket.on("connect_error", (error: Error) => { clearTimeout(timer); reject(new Error(`Appairage rejete: ${error.message}`)); });
    socket.on("AGENT_CONNECTED", (payload: { agentId: number; token: string | null }) => {
      clearTimeout(timer);
      if (!payload.token) {
        reject(new Error("Aucun jeton recu."));
        return;
      }
      resolve({ agentId: payload.agentId, token: payload.token, socket });
    });
    socket.connect();
  });

const reconnectFakeAgent = (baseUrl: string, agentId: number, token: string, version: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false,
      reconnection: false,
      auth: { mode: "reconnect", agentId, token, version, protocolVersion: 1 }
    });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout reconnexion agent fantome.")); }, 8_000);
    socket.on("connect_error", (error: Error) => { clearTimeout(timer); reject(new Error(`Reconnexion rejetee: ${error.message}`)); });
    socket.on("AGENT_CONNECTED", () => { clearTimeout(timer); resolve(socket); });
    socket.connect();
  });

// --- Helpers Playwright ---

const loginViaUi = async (page: Page, baseUrl: string, loginName: string, password: string): Promise<void> => {
  await page.goto(baseUrl);
  await page.fill("#loginInput", loginName);
  await page.fill("#passwordInput", password);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
};

const waitForBadgeText = (page: Page, selector: string, expectedSubstring: string): Promise<void> =>
  page.waitForFunction(
    ({ sel, text }) => (document.querySelector(sel)?.textContent || "").includes(text),
    { sel: selector, text: expectedSubstring },
    { timeout: 10_000 }
  ) as unknown as Promise<void>;

// CORRECTIF CIBLE (release 0.2.4): trouve la ligne #agentTableBody dont une
// cellule contient computerName, puis attend que sa colonne Statut (4e)
// contienne le texte attendu - jamais ":has-text()" (extension Playwright
// non comprise par document.querySelector natif execute dans la page).
const waitForAgentRowStatus = (page: Page, computerName: string, expectedStatusSubstring: string): Promise<void> =>
  page.waitForFunction(
    ({ name, text }) => {
      const rows = [...document.querySelectorAll("#agentTableBody tr")];
      const row = rows.find((candidate) => (candidate.textContent || "").includes(name));
      const statusCell = row?.querySelector("td:nth-child(4)");
      return Boolean(statusCell && (statusCell.textContent || "").includes(text));
    },
    { name: computerName, text: expectedStatusSubstring },
    { timeout: 10_000 }
  ) as unknown as Promise<void>;

// Le boot() de app.js sonde volontairement /api/me pour detecter une session
// existante et attend un 401 pour un visiteur anonyme (cf. public/app.js) ;
// Chromium journalise cet echec reseau attendu comme un message "error" cote
// DevTools, sans rapport avec une vraie erreur applicative. On l'ignore.
const EXPECTED_NOISE_PATTERN = /Failed to load resource/i;

const collectConsoleErrors = (page: Page, bucket: string[]): void => {
  page.on("console", (message) => {
    if (message.type() === "error" && !EXPECTED_NOISE_PATTERN.test(message.text())) {
      bucket.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    bucket.push(error.message);
  });
};

// --- Scenario principal ---

const secretViolations: string[] = [];

const watchForSecrets = (page: Page): void => {
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/api/agents")) {
      return;
    }
    void response
      .json()
      .then((json) => {
        const violations = findForbiddenKeys(json);
        if (violations.length > 0) {
          secretViolations.push(`${url}: ${violations.join(", ")}`);
        }
      })
      .catch(() => undefined);
  });
};

const acceptNextDialog = (page: Page, promptValue?: string): void => {
  page.once("dialog", (dialog) => {
    void dialog.accept(promptValue);
  });
};

const countBotRows = (page: Page): Promise<number> =>
  page.locator("#botTableBody tr").count();

const run = async (): Promise<void> => {
  let browser: Browser | undefined;
  const servers: ServerHandle[] = [];
  const consoleErrors: string[] = [];

  try {
    browser = await chromium.launch({ headless: true });

    // ===================== Serveur A: parcours complet =====================
    const serverA = await startServer(3221, {
      AGENT_UI_ENABLED: "true",
      BOT_EXECUTION_MODE: "agent",
      AGENT_DOWNLOAD_URL: "",
      // ~3.6s: assez court pour tester l'expiration sans attendre les 10 min par defaut.
      AGENT_PAIRING_CODE_TTL_MINUTES: "0.06"
    });
    servers.push(serverA);

    const adminCookieA = await loginWithRetry(serverA.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const fixtureA = await createAgencyAndManager(serverA.baseUrl, adminCookieA, "A");
    log("SETUP", `Serveur A pret (agencyId=${fixtureA.agencyId}).`);

    const context = await browser.newContext();
    const page = await context.newPage();
    collectConsoleErrors(page, consoleErrors);
    watchForSecrets(page);

    await loginViaUi(page, serverA.baseUrl, fixtureA.managerLogin, fixtureA.managerPassword);

    // --- 1) Redirection automatique vers /agent/setup (NEVER_PAIRED) ---
    await page.waitForURL(/\/agent\/setup$/, { timeout: 10_000 });
    assert(true, "Redirection automatique vers /agent/setup pour un utilisateur sans agent");
    await waitForBadgeText(page, "#agentSetupBadge", "Non associe");
    assert(
      (await page.textContent("#agentSetupMessage"))?.includes("Aucun ordinateur n'est encore associe") ?? false,
      "Message NEVER_PAIRED affiche sur /agent/setup"
    );
    assert(await page.isDisabled("#agentSetupDownload"), "Bouton telecharger desactive sans AGENT_DOWNLOAD_URL");
    assert(
      !(await page.isHidden("#agentSetupDownloadNotice")),
      "Message d'indisponibilite de l'installateur affiche"
    );

    // --- 2) Ignorer la detection -> dashboard + bandeau persistant ---
    await page.click("#agentSetupSkip");
    await page.waitForSelector("#page-dashboard.active", { timeout: 5_000 });
    assert(true, "Lien Ignorer la detection donne acces au dashboard");
    const sessionSkipValue = await page.evaluate(() => window.sessionStorage.getItem("rendezbot.agentDetectionSkipped"));
    assert(sessionSkipValue === "true", "Cle sessionStorage rendezbot.agentDetectionSkipped positionnee");
    assert(!(await page.isHidden("#agentBanner")), "Bandeau visible tant qu'aucun agent n'est connecte");
    assert(
      (await page.textContent("#agentBannerMessage"))?.includes("les bots ne peuvent pas etre lances") ?? false,
      "Texte du bandeau conforme"
    );

    // --- 3) Ecran Bot: bouton bloque + modale tant qu'aucun agent n'est connecte ---
    await page.click('[data-page-target="bot"]');
    await page.waitForSelector("#page-bot.active");
    assert(
      (await page.textContent("#agentIndicatorBotText"))?.includes("Agent non configure") ?? false,
      "Indicateur ecran Bot: Agent non configure"
    );

    await page.fill("#botFormName", "Bot Test Phase2");
    await page.selectOption("#botFormCategory", { index: 1 });
    await page.fill("#botFormLogin", "login-test");
    await page.fill("#botFormPassword", "password-test");
    const rowsBeforeBlockedAttempt = await countBotRows(page);
    await page.click('#startBot');
    await page.waitForSelector("#agentModal:not([hidden])", { timeout: 5_000 });
    assert((await page.textContent("#agentModalTitle")) === "RendezBot Agent requis", "Titre de la modale de blocage");
    assert(
      (await page.textContent("#agentModalMessage"))?.includes("Installez et associez RendezBot Agent") ?? false,
      "Message NEVER_PAIRED dans la modale de blocage"
    );
    await page.click("#agentModalCancel");
    await page.waitForSelector("#agentModal", { state: "hidden" });
    assert((await countBotRows(page)) === rowsBeforeBlockedAttempt, "Aucun bot demarre via la modale bloquee");

    // --- 4) Generation d'un code d'appairage puis appairage reel en tache de fond ---
    await page.click("#agentBannerConfigure");
    await page.waitForURL(/\/agent\/setup$/);
    await page.click("#agentSetupGenerateCode");
    await page.waitForSelector("#agentSetupPairingBox:not([hidden])", { timeout: 5_000 });
    const pairingCode = (await page.textContent("#agentSetupPairingCode"))?.trim() ?? "";
    assert(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pairingCode), `Code d'appairage au format attendu (recu "${pairingCode}")`);
    assert(
      (await page.textContent("#agentSetupPairingExpiry"))?.includes("Expire") ?? false,
      "Date d'expiration du code affichee"
    );

    const fakeAgentA1 = await pairFakeAgent(serverA.baseUrl, pairingCode, "PW-TEST-A1", "1.0.0");
    log("AGENT", `Agent fantome appaire: agentId=${fakeAgentA1.agentId}.`);

    await waitForBadgeText(page, "#agentSetupBadge", "Connecte");
    assert(true, "Passage en CONNECTED reflete en temps reel sur /agent/setup (sans rechargement)");
    await page.waitForSelector("#agentSetupPairingBox", { state: "hidden", timeout: 5_000 });
    assert(true, "Boite de code d'appairage retiree des qu'un agent apparait (code consomme)");
    assert(!(await page.isHidden("#agentSetupGoDashboard")), "Bouton Acceder au tableau de bord visible une fois connecte");

    await page.click("#agentSetupGoDashboard");
    await page.waitForSelector("#page-dashboard.active");

    // --- 5) Une fois connecte, le bouton Demarrer n'est plus bloque cote client ---
    await page.click('[data-page-target="bot"]');
    await page.waitForSelector("#page-bot.active");
    await waitForBadgeText(page, "#agentIndicatorBotBadge", "Connecte");
    assert(
      (await page.textContent("#agentIndicatorBotText"))?.includes("PW-TEST-A1") ?? false,
      "Indicateur ecran Bot affiche le nom de l'agent connecte"
    );

    await page.fill("#botFormName", "Bot Test Phase2 bis");
    await page.selectOption("#botFormCategory", { index: 1 });
    await page.fill("#botFormLogin", "login-test");
    await page.fill("#botFormPassword", "password-test");
    const rowsBeforeReadyAttempt = await countBotRows(page);
    await page.click("#startBot");
    await page.waitForTimeout(1_500);
    assert(await page.isHidden("#agentModal"), "Pas de modale cote client une fois l'agent connecte");
    assert(
      (await countBotRows(page)) === rowsBeforeReadyAttempt,
      "Le serveur refuse toujours le demarrage (Phase 3 non implementee), meme agent connecte"
    );

    // --- 6) Deconnexion de l'agent -> hors ligne + bandeau qui revient, en temps reel ---
    fakeAgentA1.socket.disconnect();
    await waitForBadgeText(page, "#agentIndicatorBotBadge", "Hors ligne");
    assert(true, "Passage OFFLINE reflete en temps reel");
    assert(!(await page.isHidden("#agentBanner")), "Bandeau reapparait automatiquement une fois l'agent hors ligne");

    // --- 7) sessionStorage: persiste au rechargement, pas a une nouvelle session ---
    await page.reload();
    await page.waitForSelector("#appLayout:not([hidden])");
    await page.waitForTimeout(500);
    assert(
      !(await page.url()).includes("/agent/setup"),
      "Rechargement dans le meme onglet: pas de redirection (sessionStorage conservee)"
    );

    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await loginViaUi(freshPage, serverA.baseUrl, fixtureA.managerLogin, fixtureA.managerPassword);
    await freshPage.waitForURL(/\/agent\/setup$/, { timeout: 10_000 });
    assert(true, "Nouvelle session (nouveau contexte navigateur): redirection de nouveau vers /agent/setup");
    await freshContext.close();

    // --- 8) Reconnexion de l'agent -> connecte de nouveau, bandeau disparait ---
    const reconnectedSocket = await reconnectFakeAgent(serverA.baseUrl, fakeAgentA1.agentId, fakeAgentA1.token, "1.0.0");
    await waitForBadgeText(page, "#agentIndicatorBotBadge", "Connecte");
    assert(await page.isHidden("#agentBanner"), "Bandeau retire automatiquement une fois l'agent reconnecte");

    // --- 9) Page Agent local: renommage puis revocation avec confirmation ---
    await page.click('[data-page-target="agent"]');
    await page.waitForSelector("#page-agent.active");
    await page.waitForFunction(
      () => (document.querySelectorAll("#agentTableBody tr").length) > 0,
      undefined,
      { timeout: 5_000 }
    );
    const firstRowNameBefore = await page.textContent("#agentTableBody tr:first-child td:first-child");
    assert(firstRowNameBefore?.trim() === "PW-TEST-A1", "La page Agent local liste bien l'agent appaire");

    acceptNextDialog(page, "PW-TEST-A1 Renomme");
    await page.click("#agentTableBody tr:first-child button:has-text(\"Renommer\")");
    await page.waitForFunction(
      () => document.querySelector("#agentTableBody tr:first-child td:first-child")?.textContent?.trim() === "PW-TEST-A1 Renomme",
      undefined,
      { timeout: 5_000 }
    );
    assert(true, "Renommage de l'agent applique et reflete dans le tableau");

    acceptNextDialog(page);
    await page.click("#agentTableBody tr:first-child button:has-text(\"Revoquer\")");
    await page.waitForFunction(
      () => (document.querySelector("#agentTableBody tr:first-child td:nth-child(4)")?.textContent || "").includes("Revoque"),
      undefined,
      { timeout: 5_000 }
    );
    assert(true, "Revocation appliquee (avec confirmation) et immediatement reflete dans le tableau");
    const actionsAfterRevoke = await page.locator("#agentTableBody tr:first-child .action-cell button").count();
    assert(actionsAfterRevoke === 0, "Plus aucune action proposee sur un agent revoque");

    reconnectedSocket.disconnect();

    // ===================== Serveur B: version incompatible + telechargement =====================
    const serverB = await startServer(3222, {
      AGENT_UI_ENABLED: "true",
      BOT_EXECUTION_MODE: "legacy_vm",
      AGENT_DOWNLOAD_URL: "https://downloads.example.test/RendezBotAgentSetup.exe",
      AGENT_MIN_VERSION: "99.0.0"
    });
    servers.push(serverB);

    const adminCookieB = await loginWithRetry(serverB.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const fixtureB = await createAgencyAndManager(serverB.baseUrl, adminCookieB, "B");

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    collectConsoleErrors(pageB, consoleErrors);

    await loginViaUi(pageB, serverB.baseUrl, fixtureB.managerLogin, fixtureB.managerPassword);
    await pageB.waitForURL(/\/agent\/setup$/, { timeout: 10_000 });
    assert(!(await pageB.isDisabled("#agentSetupDownload")), "Bouton telecharger active quand AGENT_DOWNLOAD_URL est fourni");

    // CORRECTIF CIBLE (release 0.2.4): requiredAgentVersion vient
    // EXCLUSIVEMENT de agentGatewayConfig.minAgentVersion cote serveur -
    // jamais hardcode ni deduit de la release.
    const clientConfigB = await pageB.evaluate(() => fetch("/api/client-config").then((r) => r.json()));
    assert(clientConfigB.requiredAgentVersion === "99.0.0", `client-config expose requiredAgentVersion=AGENT_MIN_VERSION (recu: ${clientConfigB.requiredAgentVersion})`);

    await pageB.click("#agentSetupGenerateCode");
    await pageB.waitForSelector("#agentSetupPairingBox:not([hidden])");
    const codeB = (await pageB.textContent("#agentSetupPairingCode"))?.trim() ?? "";
    const fakeAgentB1 = await pairFakeAgent(serverB.baseUrl, codeB, "PW-TEST-B1", "1.0.0");
    await waitForBadgeText(pageB, "#agentSetupBadge", "Version incompatible");
    assert(
      (await pageB.textContent("#agentSetupMessage"))?.includes("doit etre mise a jour") ?? false,
      "Message VERSION_INCOMPATIBLE affiche quand la version de l'agent est trop ancienne"
    );

    // ---- Bandeau OBLIGATOIRE (section 5 du correctif): jamais masquable,
    // independant de "Ignorer la detection" (jamais active dans ce contexte),
    // affiche version installee/requise, propose le telechargement. ----
    await pageB.click('[data-page-target="dashboard"]');
    await pageB.waitForSelector("#page-dashboard.active");
    await waitForBadgeText(pageB, "#agentUpdateBannerInstalled", "1.0.0");
    assert(!(await pageB.isHidden("#agentUpdateBanner")), "Bandeau obligatoire de mise a jour visible (VERSION_INCOMPATIBLE, un seul agent, aucun compatible)");
    assert((await pageB.textContent("#agentUpdateBannerInstalled"))?.trim() === "1.0.0", "Version installee affichee dans le bandeau obligatoire");
    assert((await pageB.textContent("#agentUpdateBannerRequired"))?.trim() === "99.0.0", "Version requise affichee dans le bandeau obligatoire");
    assert(await pageB.isHidden("#agentBanner"), "Le bandeau generique dismissible n'apparait jamais pour VERSION_INCOMPATIBLE (bandeau dedie a la place)");
    assert(!(await pageB.locator("#agentUpdateBanner .agent-banner-close").count()), "Le bandeau obligatoire ne possede aucun bouton fermer");
    assert(!(await pageB.isHidden("#agentUpdateBannerDownload")), "Bouton telecharger actif dans le bandeau obligatoire (release/override disponible)");
    assert(await pageB.isHidden("#agentUpdateBannerUnavailable"), "Message 'installateur indisponible' absent quand une release est disponible");

    // Preuve que le serveur (et non une URL reconstruite cote frontend) est
    // bien la source de l'URL de telechargement exacte.
    const releaseB = await pageB.evaluate(() => fetch("/api/agent/releases/latest").then((r) => r.json()));
    assert(
      releaseB.available === true && releaseB.downloadUrl === "https://downloads.example.test/RendezBotAgentSetup.exe",
      `/api/agent/releases/latest renvoie exactement l'URL configuree (recu: ${releaseB.downloadUrl})`
    );

    // ---- Multi-agent (section "MULTI-AGENTS"): un second agent COMPATIBLE
    // dans la MEME agence doit rendre l'agence utilisable, faire disparaitre
    // le bandeau obligatoire, et laisser PW-TEST-B1 clairement marque
    // "Version incompatible" sur la page Agent local. ----
    await pageB.click('[data-page-target="agent"]');
    await pageB.waitForSelector("#page-agent.active");
    await pageB.click("#agentPageGenerateCode");
    await pageB.waitForSelector("#agentPagePairingBox:not([hidden])");
    const codeB2 = (await pageB.textContent("#agentPagePairingCode"))?.trim() ?? "";
    const fakeAgentB2 = await pairFakeAgent(serverB.baseUrl, codeB2, "PW-TEST-B2", "99.0.0");
    // Sans ceci, readyForCommands reste false (fenetre AGENT_SYNCING) et la
    // ligne afficherait "Synchronisation..." plutot que "Connecte" - ce test
    // verifie le statut stabilise, pas la fenetre transitoire.
    fakeAgentB2.socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
    await pageB.waitForFunction(
      () => (document.querySelectorAll("#agentTableBody tr").length) >= 2,
      undefined,
      { timeout: 5_000 }
    );
    // L'element du bandeau existe partout dans le layout (pas seulement sur
    // Dashboard): son attribut hidden reflete le globalStatus courant
    // independamment de la page active - pas besoin d'y naviguer.
    await pageB.waitForFunction(
      () => document.getElementById("agentUpdateBanner")?.hidden === true,
      undefined,
      { timeout: 5_000 }
    );
    assert(await pageB.isHidden("#agentUpdateBanner"), "Bandeau obligatoire disparait des qu'un agent compatible CONNECTE existe (agence de nouveau utilisable)");
    assert(await pageB.isHidden("#agentBanner"), "Le bandeau generique reste absent (globalStatus=CONNECTED)");
    await waitForAgentRowStatus(pageB, "PW-TEST-B1", "Version incompatible");
    await waitForAgentRowStatus(pageB, "PW-TEST-B2", "Connecte");
    assert(
      !(await pageB.isHidden("#agentPageUpdateNotice")),
      "Notice contextuelle 'mise a jour' visible sur la page Agent local tant qu'un ordinateur reste incompatible, meme agence utilisable"
    );
    assert(
      (await pageB.textContent("#agentPageUpdateNotice"))?.includes("99.0.0") ?? false,
      "Notice contextuelle mentionne la version requise"
    );

    fakeAgentB1.socket.disconnect();
    fakeAgentB2.socket.disconnect();
    await contextB.close();

    // ===================== Serveur B2: version incompatible, AUCUNE release disponible =====================
    const serverB2 = await startServer(3224, {
      AGENT_UI_ENABLED: "true",
      BOT_EXECUTION_MODE: "legacy_vm",
      AGENT_MIN_VERSION: "99.0.0"
    });
    servers.push(serverB2);

    const adminCookieB2 = await loginWithRetry(serverB2.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const fixtureB2 = await createAgencyAndManager(serverB2.baseUrl, adminCookieB2, "B2");

    const contextB2 = await browser.newContext();
    const pageB2 = await contextB2.newPage();
    collectConsoleErrors(pageB2, consoleErrors);

    await loginViaUi(pageB2, serverB2.baseUrl, fixtureB2.managerLogin, fixtureB2.managerPassword);
    await pageB2.waitForURL(/\/agent\/setup$/, { timeout: 10_000 });

    const releaseB2 = await pageB2.evaluate(() => fetch("/api/agent/releases/latest").then((r) => r.json()));
    assert(releaseB2.available === false, "CAS RELEASE INDISPONIBLE: /api/agent/releases/latest renvoie available:false (aucun AGENT_DOWNLOAD_URL, aucun manifeste)");

    await pageB2.click("#agentSetupGenerateCode");
    await pageB2.waitForSelector("#agentSetupPairingBox:not([hidden])");
    const codeB2Setup = (await pageB2.textContent("#agentSetupPairingCode"))?.trim() ?? "";
    const fakeAgentB2Old = await pairFakeAgent(serverB2.baseUrl, codeB2Setup, "PW-TEST-B2-OLD", "1.0.0");
    await waitForBadgeText(pageB2, "#agentSetupBadge", "Version incompatible");

    await pageB2.click('[data-page-target="dashboard"]');
    await pageB2.waitForSelector("#page-dashboard.active");
    await waitForBadgeText(pageB2, "#agentUpdateBannerInstalled", "1.0.0");
    assert(!(await pageB2.isHidden("#agentUpdateBanner")), "Bandeau obligatoire toujours visible meme sans release disponible (demarrage reste bloque)");
    assert(await pageB2.isHidden("#agentUpdateBannerDownload"), "CAS RELEASE INDISPONIBLE: jamais de bouton telecharger fonctionnel");
    assert(!(await pageB2.isHidden("#agentUpdateBannerUnavailable")), "CAS RELEASE INDISPONIBLE: message explicite 'contactez l'administrateur' affiche");
    assert(
      (await pageB2.textContent("#agentUpdateBannerUnavailable"))?.includes("Contactez l'administrateur") ?? false,
      "Le message d'indisponibilite mentionne bien de contacter l'administrateur"
    );

    fakeAgentB2Old.socket.disconnect();
    await contextB2.close();

    // ===================== Serveur C: AGENT_UI_ENABLED=false, comportement historique =====================
    // Valeurs explicites (pas juste omises): le .env reel du depot peut definir
    // ces variables pour des tests manuels, et dotenv ne complete que les
    // variables absentes du process enfant.
    const serverC = await startServer(3223, {
      BOT_EXECUTION_MODE: "legacy_vm",
      AGENT_UI_ENABLED: "false",
      AGENT_DOWNLOAD_URL: ""
    });
    servers.push(serverC);

    const adminCookieC = await loginWithRetry(serverC.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const fixtureC = await createAgencyAndManager(serverC.baseUrl, adminCookieC, "C");

    const routeCheck = await fetch(`${serverC.baseUrl}/agent/setup`);
    assert(routeCheck.status === 404, "AGENT_UI_ENABLED=false: la route /agent/setup n'existe pas (404)");

    const contextC = await browser.newContext();
    const pageC = await contextC.newPage();
    collectConsoleErrors(pageC, consoleErrors);

    await loginViaUi(pageC, serverC.baseUrl, fixtureC.managerLogin, fixtureC.managerPassword);
    await pageC.waitForSelector("#page-dashboard.active", { timeout: 5_000 });
    assert(!(await pageC.url()).includes("/agent"), "AGENT_UI_ENABLED=false: aucune redirection vers /agent/setup");
    assert(await pageC.isHidden(".agent-nav"), "AGENT_UI_ENABLED=false: pas d'entree de menu Agent local");
    assert(await pageC.isHidden("#agentBanner"), "AGENT_UI_ENABLED=false: jamais de bandeau agent");
    assert(await pageC.isHidden("#agentIndicatorDashboard"), "AGENT_UI_ENABLED=false: pas d'indicateur agent");
    await contextC.close();

    // --- Bilan transverse ---
    assert(consoleErrors.length === 0, `Aucune erreur console navigateur (recu: ${consoleErrors.join(" | ") || "aucune"})`);
    assert(secretViolations.length === 0, `Aucun secret dans les reponses /api/agents (recu: ${secretViolations.join(" | ") || "aucun"})`);
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
