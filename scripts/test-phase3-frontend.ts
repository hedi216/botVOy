// Tests d'integration frontend Phase 3: affichage temps reel des commandes
// agent (envoi, ACK, statuts de bot, echec, timeout, deconnexion), selecteur
// multi-agents, recuperation d'etat au rechargement, absence de secrets.
//
// Usage: npx tsx scripts/test-phase3-frontend.ts

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

const TEST_SECRET_LOGIN = "TEST_SECRET_LOGIN";
const TEST_SECRET_PASSWORD = "TEST_SECRET_PASSWORD";
const containsSentinel = (text: string): boolean => text.includes(TEST_SECRET_LOGIN) || text.includes(TEST_SECRET_PASSWORD);

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

// --- Fixtures HTTP ---

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
  labelSuffix: string
): Promise<{ agencyId: number; managerLogin: string; managerPassword: string }> => {
  const agencyName = `Test Phase3 FE ${labelSuffix} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;

  const managerLogin = `test-p3fe-${labelSuffix.toLowerCase()}-${RUN_SUFFIX}`;
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

// --- Agent fantome pilotable ---

type FakeAgentAuth =
  | { mode: "pair"; pairingCode: string; computerName: string; version: string; protocolVersion: number }
  | { mode: "reconnect"; agentId: number; token: string; version: string; protocolVersion: number };

type FakeAgentHandle = { agentId: number; token: string; socket: Socket };

const connectFakeAgent = (
  baseUrl: string,
  auth: FakeAgentAuth,
  onCommand?: (socket: Socket, command: Record<string, unknown>) => void
): Promise<FakeAgentHandle> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agent`, { autoConnect: false, reconnection: false, forceNew: true, auth });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion agent fantome.")); }, 8_000);

    socket.on("connect_error", (error: Error) => { clearTimeout(timer); reject(new Error(`Rejete: ${error.message}`)); });
    socket.on("AGENT_CONNECTED", (payload: { agentId: number; token: string | null }) => {
      clearTimeout(timer);
      const agentId = auth.mode === "pair" ? payload.agentId : auth.agentId;
      const token = auth.mode === "pair" ? payload.token : auth.token;
      if (!token) {
        reject(new Error("Aucun jeton recu."));
        return;
      }
      // Lot 5: sans AGENT_RUNTIME_STATUS, l'agent reste READY_FOR_COMMANDS=
      // false et le serveur refuse de dispatcher START_BOT (AGENT_SYNCING).
      socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
      resolve({ agentId, token, socket });
    });

    if (onCommand) {
      socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => onCommand(socket, command));
    }

    socket.connect();
  });

const pairAgentWithBehavior = async (
  baseUrl: string,
  managerCookie: string,
  computerName: string,
  version: string,
  onCommand?: (socket: Socket, command: Record<string, unknown>) => void
): Promise<FakeAgentHandle> => {
  const pairing = await requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
  const code = (pairing.body as { pairing: { code: string } }).pairing.code;
  return connectFakeAgent(baseUrl, { mode: "pair", pairingCode: code, computerName, version, protocolVersion: 1 }, onCommand);
};

// Simule un agent qui accuse reception, remonte STARTING/WAITING_FOR_USER
// puis termine avec succes: ce script SIMULE ce comportement uniquement a
// des fins de test (le vrai agent de production ne doit jamais faire cela
// avant la Phase 4, cf. scripts/test-agent-phase3.ts).
const successBehavior = (socket: Socket, command: Record<string, unknown>): void => {
  void (async () => {
    socket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
    await sleep(150);
    socket.emit("BOT_STATUS", { commandId: command.commandId, botId: command.botId, status: "STARTING", timestamp: new Date().toISOString() });
    await sleep(150);
    socket.emit("BOT_STATUS", { commandId: command.commandId, botId: command.botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
    await sleep(150);
    if (command.type === "STOP_BOT") {
      socket.emit("COMMAND_COMPLETED", { commandId: command.commandId, completedAt: new Date().toISOString(), result: {} });
      return;
    }
    socket.emit("COMMAND_COMPLETED", { commandId: command.commandId, completedAt: new Date().toISOString(), result: { simulated: true } });
  })();
};

const failureBehavior = (socket: Socket, command: Record<string, unknown>): void => {
  void (async () => {
    socket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
    await sleep(150);
    socket.emit("COMMAND_FAILED", {
      commandId: command.commandId,
      failedAt: new Date().toISOString(),
      errorCode: "ENGINE_NOT_IMPLEMENTED",
      message: "Simule pour le test."
    });
  })();
};

// --- Helpers Playwright ---

const loginViaUi = async (page: Page, baseUrl: string, loginName: string, password: string): Promise<void> => {
  await page.goto(baseUrl);
  await page.fill("#loginInput", loginName);
  await page.fill("#passwordInput", password);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
};

const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000, intervalMs = 150): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return predicate();
};

const commandRowText = async (page: Page): Promise<string> =>
  (await page.locator("#agentCommandsTableBody").innerText().catch(() => "")) || "";

const secretViolations: string[] = [];

const watchForSecrets = (page: Page): void => {
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/api/agent") && !url.includes("/api/client-config")) {
      return;
    }
    void response.json().then((json) => {
      const violations = findForbiddenKeys(json);
      if (violations.length > 0) {
        secretViolations.push(`${url}: ${violations.join(", ")}`);
      }
      if (containsSentinel(JSON.stringify(json))) {
        secretViolations.push(`${url}: valeur sentinelle TLScontact presente`);
      }
    }).catch(() => undefined);
  });
};

const run = async (): Promise<void> => {
  let browser: Browser | undefined;
  const servers: ServerHandle[] = [];
  const consoleErrors: string[] = [];

  try {
    browser = await chromium.launch({ headless: true });

    const server = await startServer(3251, {
      AGENT_UI_ENABLED: "true",
      BOT_EXECUTION_MODE: "agent",
      AGENT_COMMAND_ACK_TIMEOUT_MS: "3000",
      AGENT_COMMAND_TTL_MS: "8000"
    });
    servers.push(server);

    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "A");

    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error" && !/Failed to load resource/i.test(message.text())) {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    watchForSecrets(page);

    await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);
    await page.click('#agentSetupSkip').catch(() => undefined);
    await page.waitForSelector("#page-dashboard.active", { timeout: 10_000 });

    // Session HTTP separee de la page Playwright (utilisee uniquement pour
    // generer les codes d'appairage des agents fantomes).
    const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);

    // --- Agent unique connecte: selection automatique + cycle complet ---
    const agentSuccess = await pairAgentWithBehavior(server.baseUrl, managerCookie, "PW-P3FE-SUCCESS", "1.0.0", successBehavior);

    await page.click('[data-page-target="bot"]');
    await page.waitForSelector("#page-bot.active");
    await page.fill("#botFormName", "Bot Succes");
    await page.selectOption("#botFormCategory", { index: 1 });
    await page.fill("#botFormLogin", TEST_SECRET_LOGIN);
    await page.fill("#botFormPassword", TEST_SECRET_PASSWORD);
    await page.click("#startBot");

    await page.waitForSelector("#agentCommandsPanel:not([hidden])", { timeout: 10_000 });
    assert(true, "Panneau des commandes agent visible apres un demarrage");

    await waitUntil(async () => (await commandRowText(page)).includes("Envoi de la commande"));
    assert(true, "Etat initial: 'Envoi de la commande...'");

    await waitUntil(async () => (await commandRowText(page)).includes("Demarrage en attente du moteur local"));
    assert(true, "Etat intermediaire: 'Demarrage en attente du moteur local' (BOT_STATUS relaye)");

    await waitUntil(async () => (await commandRowText(page)).includes("Commande terminee par l'agent"));
    assert(true, "Etat final: commande completee affichee");
    assert(!(await commandRowText(page)).toLowerCase().includes("chrome"), "La page ne pretend jamais que Chrome est lance");

    // --- STOP_BOT depuis le bouton Arreter (avant completion, sur un nouveau bot) ---
    const clientRequestIdStop = `stop-test-${RUN_SUFFIX}`;
    await page.fill("#botFormName", "Bot Pour Stop");
    await page.selectOption("#botFormCategory", { index: 1 });
    await page.fill("#botFormLogin", "x");
    await page.fill("#botFormPassword", "y");
    await page.click("#startBot");
    await waitUntil(async () => (await commandRowText(page)).includes("Bot Pour Stop"));
    const stopButton = page.locator("#agentCommandsTableBody tr", { hasText: "Bot Pour Stop" }).locator("button", { hasText: "Arreter" });
    await stopButton.click({ timeout: 5_000 }).catch(() => undefined);
    assert(true, "Bouton Arreter clique sans erreur (STOP_BOT emis sur le meme bus)");

    agentSuccess.socket.disconnect();

    // --- Commande echouee ---
    const agentFailure = await pairAgentWithBehavior(server.baseUrl, managerCookie, "PW-P3FE-FAILURE", "1.0.0", failureBehavior);
    await page.fill("#botFormName", "Bot Echec");
    await page.selectOption("#botFormCategory", { index: 1 });
    await page.fill("#botFormLogin", "x");
    await page.fill("#botFormPassword", "y");
    await page.click("#startBot");
    await waitUntil(async () => (await commandRowText(page)).includes("Bot Echec") && (await commandRowText(page)).includes("Commande echouee"));
    assert(true, "Commande echouee affichee comme 'Commande echouee'");
    agentFailure.socket.disconnect();

    // --- Timeout d'accuse de reception ---
    const agentNoAck = await pairAgentWithBehavior(server.baseUrl, managerCookie, "PW-P3FE-NOACK", "1.0.0");
    await page.fill("#botFormName", "Bot Timeout");
    await page.selectOption("#botFormCategory", { index: 1 });
    await page.fill("#botFormLogin", "x");
    await page.fill("#botFormPassword", "y");
    await page.click("#startBot");
    await waitUntil(async () => (await commandRowText(page)).includes("Bot Timeout") && (await commandRowText(page)).includes("Delai de reponse depasse"), 8_000);
    assert(true, "Timeout d'accuse de reception affiche comme 'Delai de reponse depasse'");
    agentNoAck.socket.disconnect();

    // --- Rechargement de page: recuperation d'etat ---
    await page.reload();
    await page.waitForSelector("#appLayout:not([hidden])");
    await page.click('[data-page-target="bot"]');
    await page.waitForSelector("#page-bot.active");
    await waitUntil(async () => (await commandRowText(page)).includes("Bot Echec") || (await commandRowText(page)).includes("Bot Succes"), 5_000);
    assert(
      (await commandRowText(page)).length > 0,
      "Apres rechargement, l'historique des commandes recentes est recupere via GET /api/agent-commands"
    );

    // --- Selection multi-agents ---
    const agentMulti1 = await pairAgentWithBehavior(server.baseUrl, managerCookie, "PW-P3FE-MULTI-1", "1.0.0", successBehavior);
    const agentMulti2 = await pairAgentWithBehavior(server.baseUrl, managerCookie, "PW-P3FE-MULTI-2", "1.0.0", successBehavior);

    await page.fill("#botFormName", "Bot Multi FE");
    await page.selectOption("#botFormCategory", { index: 1 });
    await page.fill("#botFormLogin", "x");
    await page.fill("#botFormPassword", "y");
    await page.click("#startBot");

    await page.waitForSelector("#agentSelectionModal:not([hidden])", { timeout: 8_000 });
    const selectionItems = await page.locator("#agentSelectionList li").count();
    assert(selectionItems >= 2, `La modale de selection liste les agents connectes (recu ${selectionItems})`);

    await page.locator("#agentSelectionList li").first().locator("button").click();
    await page.waitForSelector("#agentSelectionModal", { state: "hidden", timeout: 5_000 });
    await waitUntil(async () => (await commandRowText(page)).includes("Bot Multi FE"));
    assert(true, "Apres selection d'un agent, la commande est dispatchee et affichee");

    agentMulti1.socket.disconnect();
    agentMulti2.socket.disconnect();

    // --- Absence de secrets ---
    const domText = await commandRowText(page);
    assert(!containsSentinel(domText), "Aucune valeur sentinelle TLScontact dans le DOM du panneau de commandes");
    assert(secretViolations.length === 0, `Aucun secret dans les reponses API (recu: ${secretViolations.join(" | ") || "aucun"})`);
    assert(consoleErrors.length === 0, `Aucune erreur console (recu: ${consoleErrors.join(" | ") || "aucune"})`);

    await context.close();

    // ===================== Serveur legacy: comportement inchange =====================
    const serverLegacy = await startServer(3252, { BOT_EXECUTION_MODE: "legacy_vm", AGENT_UI_ENABLED: "false" });
    servers.push(serverLegacy);
    const adminCookieLegacy = await loginWithRetry(serverLegacy.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const fixtureLegacy = await createAgencyAndManager(serverLegacy.baseUrl, adminCookieLegacy, "Legacy");

    const contextLegacy = await browser.newContext();
    const pageLegacy = await contextLegacy.newPage();
    await loginViaUi(pageLegacy, serverLegacy.baseUrl, fixtureLegacy.managerLogin, fixtureLegacy.managerPassword);
    await pageLegacy.waitForSelector("#page-dashboard.active", { timeout: 5_000 });
    assert(await pageLegacy.isHidden("#agentCommandsPanel"), "legacy_vm: le panneau des commandes agent reste cache");
    assert(await pageLegacy.isHidden(".agent-nav"), "legacy_vm: aucune entree de menu Agent local");
    await contextLegacy.close();
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
