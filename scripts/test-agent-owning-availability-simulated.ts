// HOTFIX CIBLE - Disponibilite des actions distantes Valider/Arreter selon
// l'Agent PROPRIETAIRE precis du bot (command.agentId), jamais selon le
// premier agent connecte de l'agence ni CTX.getState().globalStatus (un
// agregat). Purement UX/frontend (public/agentUi.js) + un garde backend
// manquant (dispatchOwnedAgentCommand/STOP_BOT n'appelait pas encore
// isAgentReadyForCommands, contrairement a dispatchValidateBotCommand).
//
// IMPORTANT: Agent OFFLINE != bot STOPPED. Ce hotfix ne touche JAMAIS
// botStatus/active/quota sur simple deconnexion Agent - uniquement la
// disponibilite d'une NOUVELLE commande depuis l'interface.
//
// Usage: npx tsx scripts/test-agent-owning-availability-simulated.ts

import { ChildProcess, spawn } from "node:child_process";
import { Browser, Page, chromium } from "playwright";
import { Socket, io as ioClient } from "socket.io-client";
import { ADMIN_LOGIN, ADMIN_PASSWORD, pool } from "../src/db.js";

const RUN_SUFFIX = Date.now();

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntilAsync = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};

// ===================== Serveur reel =====================

type ServerHandle = { child: ChildProcess; baseUrl: string };

const waitForServerReady = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`${baseUrl}/api/me`); if (res.status === 401 || res.status === 200) return; } catch { /* pas encore pret */ }
    await sleep(500);
  }
  throw new Error(`Le serveur de test n'a jamais repondu sur ${baseUrl}/api/me.`);
};

const startServer = async (port: number): Promise<ServerHandle> => {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(command, ["tsx", "src/server.ts"], {
    env: {
      ...process.env, WEB_PORT: String(port), BOT_EXECUTION_MODE: "agent", AGENT_UI_ENABLED: "true",
      AGENT_COMMAND_ACK_TIMEOUT_MS: "8000", AGENT_COMMAND_TTL_MS: "20000"
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  return { child, baseUrl };
};

const stopServer = async (handle: ServerHandle): Promise<void> => {
  if (!handle.child.pid) return;
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

type HttpResult = { status: number; body: unknown };

const requestJson = async (baseUrl: string, method: string, pathName: string, cookie: string | undefined, json?: unknown): Promise<HttpResult> => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(json ?? {}) } : {})
  });
  const rawText = await res.text();
  let body: unknown = null;
  try { body = rawText ? JSON.parse(rawText) : null; } catch { body = rawText; }
  return { status: res.status, body };
};

const login = async (baseUrl: string, loginName: string, password: string): Promise<string> => {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: loginName, password })
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (res.status !== 200 || !cookie) throw new Error(`Login ${loginName} a echoue (status ${res.status}).`);
  return cookie;
};

const loginWithRetry = async (baseUrl: string, loginName: string, password: string, attempts = 5): Promise<string> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await login(baseUrl, loginName, password); } catch (error) { lastError = error; await sleep(1_000); }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

const createAgencyAndManager = async (baseUrl: string, adminCookie: string, label: string): Promise<{ agencyId: number; managerLogin: string; managerPassword: string }> => {
  const agencyName = `Test Agent Avail ${label} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;

  const managerLogin = `test-agentavail-mgr-${label.toLowerCase()}-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const userResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: `Manager ${label}`, email: `${managerLogin}@example.test`, role: 1
  });
  const managerPassword = (userResult.body as { temporaryPassword: string }).temporaryPassword;
  return { agencyId, managerLogin, managerPassword };
};

type FakeAgentHandle = { agentId: number; token: string; socket: Socket };

const pairFakeAgent = (baseUrl: string, managerCookie: string, computerName: string, version = "1.0.0"): Promise<FakeAgentHandle> =>
  requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {}).then((pairing) => new Promise((resolve, reject) => {
    const pairingCode = (pairing.body as { pairing: { code: string } }).pairing.code;
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "pair", pairingCode, computerName, version, protocolVersion: 1 }
    });
    const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout agent fantome.")); }, 8_000);
    socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
    socket.on("AGENT_CONNECTED", (payload: { agentId: number; token: string | null }) => {
      clearTimeout(t);
      if (!payload.token) { reject(new Error("Aucun jeton.")); return; }
      resolve({ agentId: payload.agentId, token: payload.token, socket });
    });
    socket.connect();
  }));

const reconnectFakeAgent = (baseUrl: string, agentId: number, token: string, computerName: string, version = "1.0.0"): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "reconnect", agentId, token, computerName, version, protocolVersion: 1 }
    });
    const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout reconnexion agent fantome.")); }, 8_000);
    socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
    socket.on("AGENT_CONNECTED", () => { clearTimeout(t); resolve(socket); });
    socket.connect();
  });

// IMPORTANT: AGENT_RUNTIME_STATUS est aussi le mecanisme de reconciliation
// apres reboot (chantier precedent) - tout bot ABSENT du tableau `bots`
// fourni ici converge vers STOPPED. Un tableau vide n'est donc correct que
// pour un agent qui n'a REELLEMENT aucun bot actif (ex. juste apres
// pairage) - une reconnexion d'un agent qui possede deja des bots actifs
// doit toujours reporter leur inventaire reel, sous peine de les arreter
// par erreur (exactement le bug que ce hotfix ne doit jamais reproduire:
// Agent OFFLINE puis reconnecte != bots stoppes).
const markAgentReady = async (agent: { socket: Socket }, activeBots: Array<{ botId: string; botName: string; status: string }> = []): Promise<void> => {
  agent.socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: activeBots });
  await sleep(300);
};

const openControlSocket = (baseUrl: string, cookie: string): Promise<Socket> => new Promise((resolve, reject) => {
  const socket = ioClient(baseUrl, { autoConnect: false, reconnection: false, forceNew: true, extraHeaders: { Cookie: cookie } });
  const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion socket de controle.")); }, 8_000);
  socket.on("connect", () => { clearTimeout(t); resolve(socket); });
  socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
  socket.connect();
});

const loginViaUi = async (page: Page, baseUrl: string, loginName: string, password: string): Promise<void> => {
  await page.goto(baseUrl);
  await page.fill("#loginInput", loginName);
  await page.fill("#passwordInput", password);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
  await page.click("#agentSetupSkip").catch(() => undefined);
  await page.click('[data-page-target="bot"]');
  await page.waitForSelector("#page-bot.active");
};

const rowFor = (page: Page, botNameText: string) => page.locator("#agentCommandsTableBody tr", { hasText: botNameText });

const startBotOnAgent = async (
  control: Socket, agent: FakeAgentHandle, botName: string, botStatus: string
): Promise<{ botId: string; commandId: string }> => {
  const commandsSeen: Array<Record<string, unknown>> = [];
  const onCommand = (command: Record<string, unknown>): void => { commandsSeen.push(command); };
  agent.socket.on("AGENT_COMMAND", onCommand);

  control.emit("start-bot", { botName, category: "", login: "x", password: "y", agentId: agent.agentId, clientRequestId: `avail-${botName}-${RUN_SUFFIX}` });
  await waitUntilAsync(() => commandsSeen.some((c) => c.type === "START_BOT" && (c.payload as { botName?: string } | undefined)?.botName === botName), 8_000);
  const startCmd = commandsSeen.find((c) => c.type === "START_BOT" && (c.payload as { botName?: string } | undefined)?.botName === botName)!;
  agent.socket.off("AGENT_COMMAND", onCommand);

  agent.socket.emit("COMMAND_ACK", { commandId: startCmd.commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("BOT_STATUS", { commandId: startCmd.commandId, botId: startCmd.botId, status: botStatus, timestamp: new Date().toISOString() });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: startCmd.commandId, completedAt: new Date().toISOString(), result: { botId: startCmd.botId, status: botStatus, started: true } });

  return { botId: startCmd.botId as string, commandId: startCmd.commandId as string };
};

const commandCountForAgency = async (baseUrl: string, cookie: string): Promise<number> => {
  const result = await requestJson(baseUrl, "GET", "/api/agent-commands?limit=200", cookie);
  return ((result.body as { commands?: unknown[] }).commands ?? []).length;
};

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  if (createdAgencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
};

// ===================== TEST A/B/C/D/E: un seul Agent, disponibilite selon son propre etat =====================

const runSingleAgentTests = async (baseUrl: string, page: Page, control: Socket, agent: FakeAgentHandle, agencyId: number, managerCookie: string): Promise<void> => {
  // ---- TEST A: WAITING_FOR_USER + Agent CONNECTED ready -> actions actives ----
  log("TEST-A", "=== WAITING_FOR_USER + Agent CONNECTED/ready: Valider et Arreter actifs ===");
  const botNameA = `Bot Avail A ${RUN_SUFFIX}`;
  await startBotOnAgent(control, agent, botNameA, "WAITING_FOR_USER");
  const rowA = rowFor(page, botNameA);
  await rowA.waitFor({ state: "visible", timeout: 10_000 });
  const validateA = rowA.locator("button", { hasText: "Valider" });
  const stopA = rowA.locator("button", { hasText: "Arreter" });
  assert(!(await validateA.isDisabled()), "A) Bouton Valider actif quand l'Agent est CONNECTED/ready");
  assert(!(await stopA.isDisabled()), "A) Bouton Arreter actif quand l'Agent est CONNECTED/ready");

  // ---- TEST B: WAITING_FOR_USER + Agent OFFLINE -> actions visibles mais disabled, aucune commande emise ----
  log("TEST-B", "=== WAITING_FOR_USER + Agent OFFLINE: boutons visibles mais desactives, aucune commande emise ===");
  const botNameB = `Bot Avail B ${RUN_SUFFIX}`;
  const { botId: botIdB } = await startBotOnAgent(control, agent, botNameB, "WAITING_FOR_USER");

  // Bot supplementaire en MONITORING, cree AVANT la coupure (necessaire pour
  // le TEST C juste apres: le dernier BOT_STATUS reellement recu doit etre
  // MONITORING, aucun nouveau rapport n'etant possible une fois l'agent hors
  // ligne).
  const botNameC = `Bot Avail C ${RUN_SUFFIX}`;
  const { botId: botIdC } = await startBotOnAgent(control, agent, botNameC, "MONITORING");

  const countBeforeOffline = await commandCountForAgency(baseUrl, managerCookie);

  agent.socket.disconnect();
  const rowB = rowFor(page, botNameB);
  await waitUntilAsync(async () => await rowB.locator("button", { hasText: "Valider" }).isDisabled(), 10_000);

  const validateB = rowB.locator("button", { hasText: "Valider" });
  const stopB = rowB.locator("button", { hasText: "Arreter" });
  assert(await validateB.count() === 1 && await validateB.isDisabled(), "B) Bouton Valider reste VISIBLE mais devient disabled (Agent OFFLINE)");
  assert(await stopB.count() === 1 && await stopB.isDisabled(), "B) Bouton Arreter reste VISIBLE mais devient disabled (Agent OFFLINE)");
  assert((await validateB.getAttribute("title"))?.includes("hors ligne") ?? false, "B) title explicite sur Valider (Agent hors ligne)");
  const rowTextB = await rowB.innerText();
  assert(rowTextB.toLowerCase().includes("hors ligne"), "B) Une indication \"Agent hors ligne\" est visible sur la ligne");

  await validateB.click({ force: true }).catch(() => undefined);
  await stopB.click({ force: true }).catch(() => undefined);
  await sleep(500);
  const countAfterClick = await commandCountForAgency(baseUrl, managerCookie);
  assert(countAfterClick === countBeforeOffline, `L) Aucune nouvelle commande creee par un clic sur un bouton disabled (avant: ${countBeforeOffline}, apres: ${countAfterClick})`);

  // ---- TEST C: MONITORING + Agent OFFLINE -> Arreter disabled, runtime inchange ----
  log("TEST-C", "=== MONITORING + Agent OFFLINE: Arreter visible mais desactive, botStatus/active inchanges ===");
  const rowC = rowFor(page, botNameC);
  await waitUntilAsync(async () => await rowC.locator("button", { hasText: "Arreter" }).isDisabled(), 10_000);
  assert(await rowC.locator("button", { hasText: "Arreter" }).isDisabled(), "C) Arreter desactive pour un bot MONITORING dont l'Agent est OFFLINE");
  const botCStatusRow = await requestJson(baseUrl, "GET", "/api/agent-commands?limit=200", managerCookie);
  const botCCommand = (botCStatusRow.body as { commands: Array<{ botName: string | null; botStatus: string | null; botActive: boolean }> }).commands.find((c) => c.botName === botNameC);
  assert(botCCommand?.botStatus === "MONITORING", `C) botStatus reste MONITORING malgre l'Agent OFFLINE (recu: ${botCCommand?.botStatus})`);
  assert(botCCommand?.botActive === true, `C) active reste true malgre l'Agent OFFLINE (recu: ${botCCommand?.botActive})`);

  // ---- TEST D: reconnexion -> reactivation automatique sans reload ----
  log("TEST-D", "=== Reconnexion Agent: les boutons redeviennent actifs automatiquement (sans reload) ===");
  const reconnected = await reconnectFakeAgent(baseUrl, agent.agentId, agent.token, `PW-AVAIL-${RUN_SUFFIX}`);
  const reconnectedAgent: FakeAgentHandle = { agentId: agent.agentId, token: agent.token, socket: reconnected };
  const liveInventory = [
    { botId: botIdB, botName: botNameB, status: "WAITING_FOR_USER" },
    { botId: botIdC, botName: botNameC, status: "MONITORING" }
  ];
  await markAgentReady(reconnectedAgent, liveInventory);

  await waitUntilAsync(async () => !(await rowC.locator("button", { hasText: "Arreter" }).isDisabled({ timeout: 1_000 }).catch(() => true)), 10_000);
  assert(!(await rowC.locator("button", { hasText: "Arreter" }).isDisabled({ timeout: 1_000 }).catch(() => true)), "D) Arreter redevient actif automatiquement des que l'Agent est reconnecte et pret, sans reload manuel");

  // ---- TEST E: CONNECTED mais readyForCommands=false (synchronisation) ----
  log("TEST-E", "=== Agent CONNECTE mais pas encore synchronise (readyForCommands=false): actions desactivees jusqu'a AGENT_RUNTIME_STATUS ===");
  reconnectedAgent.socket.disconnect();
  const syncingSocket = await reconnectFakeAgent(baseUrl, agent.agentId, agent.token, `PW-AVAIL-${RUN_SUFFIX}`);
  // Volontairement AUCUN AGENT_RUNTIME_STATUS envoye ici: readyForCommands
  // doit rester false malgre le socket connecte.
  await waitUntilAsync(async () => await rowC.locator("button", { hasText: "Arreter" }).isDisabled(), 10_000);
  assert(await rowC.locator("button", { hasText: "Arreter" }).isDisabled(), "E) Arreter reste desactive: Agent CONNECTE mais pas encore synchronise (readyForCommands=false)");
  const rowTextE = await rowC.innerText();
  assert(rowTextE.includes("synchronisation"), "E) Message \"Agent en cours de synchronisation.\" visible");

  syncingSocket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: liveInventory });
  await waitUntilAsync(async () => !(await rowC.locator("button", { hasText: "Arreter" }).isDisabled()), 10_000);
  assert(!(await rowC.locator("button", { hasText: "Arreter" }).isDisabled()), "E) Arreter redevient actif une fois readyForCommands=true (AGENT_RUNTIME_STATUS traite)");

  agent.socket = syncingSocket;

  // ---- TEST I: STOPPED -> aucune action distante, quel que soit l'Agent ----
  log("TEST-I", "=== STOPPED: aucune action distante proposee, regle existante conservee ===");
  const botNameI = `Bot Avail I ${RUN_SUFFIX}`;
  const { botId: botIdI, commandId: startCommandIdI } = await startBotOnAgent(control, agent, botNameI, "WAITING_FOR_USER");
  control.emit("stop-bot", { botId: botIdI, clientRequestId: `avail-i-stop-${RUN_SUFFIX}` });
  const stopCommandsSeen: Array<Record<string, unknown>> = [];
  agent.socket.on("AGENT_COMMAND", (c: Record<string, unknown>) => stopCommandsSeen.push(c));
  await waitUntilAsync(() => stopCommandsSeen.some((c) => c.type === "STOP_BOT" && c.botId === botIdI), 8_000);
  const stopCmdI = stopCommandsSeen.find((c) => c.type === "STOP_BOT" && c.botId === botIdI)!;
  agent.socket.emit("COMMAND_ACK", { commandId: stopCmdI.commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("BOT_STATUS", { commandId: stopCmdI.commandId, botId: botIdI, status: "STOPPED", timestamp: new Date().toISOString() });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: stopCmdI.commandId, completedAt: new Date().toISOString(), result: { botId: botIdI, status: "STOPPED", stopped: true } });
  void startCommandIdI;

  const rowI = rowFor(page, botNameI);
  // Verifie le badge "Etat du bot" (2e colonne) EXACTEMENT - "Arrete" est
  // litteralement une sous-chaine de "Arreter" (le bouton), un simple
  // innerText().includes("Arrete") matcherait donc a tort des l'etat initial.
  await waitUntilAsync(async () => (await rowI.locator("td").nth(1).innerText()).trim() === "Arrete", 8_000);
  assert(await rowI.locator("button", { hasText: "Valider" }).count() === 0, "I) Aucun bouton Valider une fois STOPPED (Agent connecte/pret, sans rapport avec la disponibilite)");
  assert(await rowI.locator("button", { hasText: "Arreter" }).count() === 0, "I) Aucun bouton Arreter une fois STOPPED (regle STOPPABLE_RUNTIME_STATUSES/botStatus deja existante, inchangee)");
};

// ===================== TEST F: multi-agent =====================

const runMultiAgentTest = async (page: Page, control: Socket, agentX: FakeAgentHandle, agentY: FakeAgentHandle): Promise<void> => {
  log("TEST-F", "=== CRITIQUE multi-agent: Agent X OFFLINE + Agent Y CONNECTED/ready dans la MEME agence -> disponibilite independante par bot ===");
  const botNameX = `Bot Avail X ${RUN_SUFFIX}`;
  const botNameY = `Bot Avail Y ${RUN_SUFFIX}`;
  await startBotOnAgent(control, agentX, botNameX, "WAITING_FOR_USER");
  await startBotOnAgent(control, agentY, botNameY, "WAITING_FOR_USER");

  agentX.socket.disconnect();

  const rowX = rowFor(page, botNameX);
  const rowY = rowFor(page, botNameY);
  await waitUntilAsync(async () => await rowX.locator("button", { hasText: "Valider" }).isDisabled(), 10_000);

  assert(await rowX.locator("button", { hasText: "Valider" }).isDisabled(), "F) Bot X (Agent OFFLINE) -> Valider desactive");
  assert(await rowX.locator("button", { hasText: "Arreter" }).isDisabled(), "F) Bot X (Agent OFFLINE) -> Arreter desactive");
  assert(!(await rowY.locator("button", { hasText: "Valider" }).isDisabled()), "F) Bot Y (Agent Y CONNECTED/ready, MEME agence) -> Valider reste actif");
  assert(!(await rowY.locator("button", { hasText: "Arreter" }).isDisabled()), "F) Bot Y (Agent Y CONNECTED/ready, MEME agence) -> Arreter reste actif");
};

// ===================== TEST G: VERSION_INCOMPATIBLE =====================

const runVersionIncompatibleTest = async (baseUrl: string, page: Page, managerCookie: string): Promise<void> => {
  log("TEST-G", "=== Agent VERSION_INCOMPATIBLE: actions desactivees, aucune emission ===");
  // Un Agent deja VERSION_INCOMPATIBLE au pairage ne peut jamais demarrer de
  // bot (selectAgentForCommand le refuse des le START_BOT) - le bot doit
  // donc deja exister, cree pendant que l'Agent est encore compatible, puis
  // l'Agent devient incompatible ENSUITE (reconnexion avec une version
  // inferieure a AGENT_MIN_VERSION, persistee via touchAgentSeen), exactement
  // le scenario reel vise ("ligne runtime active/stale, Agent desormais trop
  // ancien").
  const oldAgent = await pairFakeAgent(baseUrl, managerCookie, `PW-AVAIL-OLD-${RUN_SUFFIX}`, "1.0.0");
  await markAgentReady(oldAgent);
  const control = await openControlSocket(baseUrl, managerCookie);
  const botName = `Bot Avail Old ${RUN_SUFFIX}`;
  const { botId } = await startBotOnAgent(control, oldAgent, botName, "WAITING_FOR_USER");

  oldAgent.socket.disconnect();
  const incompatibleSocket = await reconnectFakeAgent(baseUrl, oldAgent.agentId, oldAgent.token, `PW-AVAIL-OLD-${RUN_SUFFIX}`, "0.0.1");
  const incompatibleAgent: FakeAgentHandle = { agentId: oldAgent.agentId, token: oldAgent.token, socket: incompatibleSocket };
  await markAgentReady(incompatibleAgent, [{ botId, botName, status: "WAITING_FOR_USER" }]);

  const row = rowFor(page, botName);
  await row.waitFor({ state: "visible", timeout: 10_000 });
  await waitUntilAsync(async () => await row.locator("button", { hasText: "Valider" }).isDisabled(), 10_000);

  assert(await row.locator("button", { hasText: "Valider" }).isDisabled(), "G) Valider desactive pour un Agent VERSION_INCOMPATIBLE");
  assert(await row.locator("button", { hasText: "Arreter" }).isDisabled(), "G) Arreter desactive pour un Agent VERSION_INCOMPATIBLE");
  const rowText = await row.innerText();
  assert(rowText.includes("Mise a jour de l'Agent requise"), "G) Message \"Mise a jour de l'Agent requise.\" visible");

  control.disconnect();
  incompatibleSocket.disconnect();
};

// ===================== TEST J: ERROR selon disponibilite Agent =====================

const runErrorStatusTest = async (baseUrl: string, page: Page, control: Socket, agent: FakeAgentHandle): Promise<void> => {
  log("TEST-J", "=== ERROR + Agent CONNECTED/ready -> Arreter actif ; ERROR + Agent OFFLINE -> Arreter desactive ===");
  const botName = `Bot Avail Error ${RUN_SUFFIX}`;
  await startBotOnAgent(control, agent, botName, "ERROR");

  const row = rowFor(page, botName);
  await row.waitFor({ state: "visible", timeout: 10_000 });
  assert(!(await row.locator("button", { hasText: "Arreter" }).isDisabled()), "J) ERROR + Agent CONNECTED/ready -> Arreter actif (ERROR reste dans STOPPABLE_RUNTIME_STATUSES)");

  agent.socket.disconnect();
  await waitUntilAsync(async () => await row.locator("button", { hasText: "Arreter" }).isDisabled(), 10_000);
  assert(await row.locator("button", { hasText: "Arreter" }).isDisabled(), "J) ERROR + Agent OFFLINE -> Arreter reste visible mais desactive");
};

// ===================== TEST K: race condition backend (connected au rendu, puis non-pret/deconnecte avant emission) =====================

const runBackendRaceTests = async (baseUrl: string, control: Socket, agent: FakeAgentHandle, managerCookie: string): Promise<void> => {
  log("TEST-K", "=== Race backend: le serveur refuse proprement meme si le frontend n'a pas encore reagi ===");

  // K1: Agent CONNECTE mais PAS ENCORE PRET (fenetre de synchronisation) -
  // emission DIRECTE via le socket de controle (contourne le disabled
  // frontend, simule un clic juste avant le prochain rendu) - c'est
  // exactement le garde AJOUTE par ce hotfix (dispatchOwnedAgentCommand).
  const botNameK1 = `Bot Avail K1 ${RUN_SUFFIX}`;
  const { botId: botIdK1 } = await startBotOnAgent(control, agent, botNameK1, "MONITORING");

  agent.socket.disconnect();
  const syncingSocket = await reconnectFakeAgent(baseUrl, agent.agentId, agent.token, `PW-AVAIL-${RUN_SUFFIX}`);
  // Aucun AGENT_RUNTIME_STATUS: readyForCommands reste false.
  const botStatusErrors: Array<Record<string, unknown>> = [];
  control.on("bot-status", (payload: Record<string, unknown>) => botStatusErrors.push(payload));

  const countBeforeK1 = await commandCountForAgency(baseUrl, managerCookie);
  control.emit("stop-bot", { botId: botIdK1, clientRequestId: `avail-k1-${RUN_SUFFIX}` });
  await sleep(1_000);

  assert(
    botStatusErrors.some((e) => e.botId === botIdK1 && e.code === "AGENT_SYNCING"),
    "K1) Le serveur refuse proprement STOP_BOT vers un Agent connecte mais pas encore synchronise (code AGENT_SYNCING)"
  );
  const countAfterK1 = await commandCountForAgency(baseUrl, managerCookie);
  assert(countAfterK1 === countBeforeK1, `K1) Aucune commande STOP_BOT persistee pour cette tentative refusee (avant: ${countBeforeK1}, apres: ${countAfterK1})`);
  const statusAfterK1 = await requestJson(baseUrl, "GET", "/api/agent-commands?limit=200", managerCookie);
  const botK1Row = (statusAfterK1.body as { commands: Array<{ botName: string | null; botStatus: string | null }> }).commands.find((c) => c.botName === botNameK1);
  assert(botK1Row?.botStatus === "MONITORING", `K1) botStatus reste MONITORING, aucune fausse transition (recu: ${botK1Row?.botStatus})`);

  // Reporte K1 dans l'inventaire (toujours MONITORING cote agent fantome):
  // ne jamais le laisser reconcilier a tort vers STOPPED simplement parce
  // que cette synchronisation ne le mentionnerait pas.
  syncingSocket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [{ botId: botIdK1, botName: botNameK1, status: "MONITORING" }] });
  await sleep(300);

  // K2: Agent TOTALEMENT deconnecte au moment de l'emission (protection
  // PRE-EXISTANTE de dispatchAgentCommand: AGENT_DISCONNECTED immediat) -
  // confirme qu'elle fonctionne toujours sans avoir ete affaiblie.
  const botNameK2 = `Bot Avail K2 ${RUN_SUFFIX}`;
  const { botId: botIdK2 } = await startBotOnAgent(control, { agentId: agent.agentId, token: agent.token, socket: syncingSocket }, botNameK2, "MONITORING");
  // Laisse le temps au serveur de reellement traiter le dernier BOT_STATUS/
  // COMMAND_COMPLETED emis par startBotOnAgent avant de couper la socket:
  // sans ce delai, la deconnexion peut survenir avant que ces messages
  // n'aient ete effectivement livres (race du harnais de test, pas du
  // produit) et le registre resterait alors a botStatus=null.
  await sleep(300);
  syncingSocket.disconnect();
  await sleep(300);

  control.emit("stop-bot", { botId: botIdK2, clientRequestId: `avail-k2-${RUN_SUFFIX}` });
  await sleep(1_000);

  const statusAfterK2 = await requestJson(baseUrl, "GET", "/api/agent-commands?limit=200", managerCookie);
  const commandsK2 = (statusAfterK2.body as { commands: Array<{ botId: string; type: string; status: string; errorCode: string | null; botStatus: string | null }> }).commands;
  const stopK2 = commandsK2.find((c) => c.botId === botIdK2 && c.type === "STOP_BOT");
  assert(stopK2?.status === "FAILED" && stopK2?.errorCode === "AGENT_DISCONNECTED", `K2) La commande STOP_BOT vers un Agent totalement deconnecte echoue proprement (AGENT_DISCONNECTED immediat) (recu: ${stopK2?.status}/${stopK2?.errorCode})`);
  const botK2Row = commandsK2.find((c) => c.botId === botIdK2 && c.type === "START_BOT");
  assert(botK2Row?.botStatus === "MONITORING", `K2) botStatus reste MONITORING malgre l'echec de STOP_BOT (recu: ${botK2Row?.botStatus})`);
};

// ===================== TEST H: Agent introuvable dans CTX.getState().agents (fail closed) =====================

const runAgentGoneTest = async (baseUrl: string, page: Page, managerCookie: string): Promise<void> => {
  log("TEST-H", "=== Agent introuvable (revoque puis archive): fail closed, aucune action distante ===");
  const control = await openControlSocket(baseUrl, managerCookie);
  const agent = await pairFakeAgent(baseUrl, managerCookie, `PW-AVAIL-GONE-${RUN_SUFFIX}`);
  await markAgentReady(agent);
  const botName = `Bot Avail Gone ${RUN_SUFFIX}`;
  await startBotOnAgent(control, agent, botName, "WAITING_FOR_USER");

  const revokeResult = await requestJson(baseUrl, "POST", `/api/agents/${agent.agentId}/revoke`, managerCookie, {});
  assert(revokeResult.status === 200, `H) Revoke prealable reussit (recu: ${revokeResult.status})`);
  const archiveResult = await requestJson(baseUrl, "DELETE", `/api/agents/${agent.agentId}`, managerCookie, {});
  assert(archiveResult.status === 200, `H) Archivage prealable reussit (recu: ${archiveResult.status})`);

  const listResult = await requestJson(baseUrl, "GET", "/api/agents", managerCookie);
  const stillListed = (listResult.body as { agents: Array<{ agentId: number }> }).agents.some((a) => a.agentId === agent.agentId);
  assert(!stillListed, "H) L'Agent revoque+archive n'apparait plus dans GET /api/agents (donc absent de CTX.getState().agents)");

  const row = rowFor(page, botName);
  await waitUntilAsync(async () => {
    const validateCount = await row.locator("button", { hasText: "Valider" }).count();
    const stopCount = await row.locator("button", { hasText: "Arreter" }).count();
    const validateOk = validateCount === 0 || await row.locator("button", { hasText: "Valider" }).isDisabled();
    const stopOk = stopCount === 0 || await row.locator("button", { hasText: "Arreter" }).isDisabled();
    return validateOk && stopOk;
  }, 10_000);

  const validateCount = await row.locator("button", { hasText: "Valider" }).count();
  const stopCount = await row.locator("button", { hasText: "Arreter" }).count();
  const validateOk = validateCount === 0 || await row.locator("button", { hasText: "Valider" }).isDisabled();
  const stopOk = stopCount === 0 || await row.locator("button", { hasText: "Arreter" }).isDisabled();
  assert(validateOk, "H) Aucune action Valider cliquable une fois l'Agent proprietaire introuvable (fail closed - absente ou desactivee)");
  assert(stopOk, "H) Aucune action Arreter cliquable une fois l'Agent proprietaire introuvable (fail closed - absente ou desactivee)");

  control.disconnect();
  agent.socket.disconnect();
};

// ===================== main =====================

const run = async (): Promise<void> => {
  let server: ServerHandle | undefined;
  let browser: Browser | undefined;
  try {
    server = await startServer(3409);
    browser = await chromium.launch({ headless: true });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "MAIN");
    const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);

    const agentMain = await pairFakeAgent(server.baseUrl, managerCookie, `PW-AVAIL-MAIN-${RUN_SUFFIX}`);
    await markAgentReady(agentMain);
    const control = await openControlSocket(server.baseUrl, managerCookie);

    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (msg) => { if (msg.type() === "error") log("BROWSER-CONSOLE-ERROR", msg.text()); });
    page.on("pageerror", (err) => log("BROWSER-PAGEERROR", err.message));
    await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);

    await runSingleAgentTests(server.baseUrl, page, control, agentMain, fixture.agencyId, managerCookie);

    const agentY = await pairFakeAgent(server.baseUrl, managerCookie, `PW-AVAIL-Y-${RUN_SUFFIX}`);
    await markAgentReady(agentY);
    const agentXForMulti = await pairFakeAgent(server.baseUrl, managerCookie, `PW-AVAIL-X-${RUN_SUFFIX}`);
    await markAgentReady(agentXForMulti);
    await runMultiAgentTest(page, control, agentXForMulti, agentY);

    await runVersionIncompatibleTest(server.baseUrl, page, managerCookie);
    await runAgentGoneTest(server.baseUrl, page, managerCookie);

    const agentForError = await pairFakeAgent(server.baseUrl, managerCookie, `PW-AVAIL-ERR-${RUN_SUFFIX}`);
    await markAgentReady(agentForError);
    await runErrorStatusTest(server.baseUrl, page, control, agentForError);

    const agentForRace = await pairFakeAgent(server.baseUrl, managerCookie, `PW-AVAIL-RACE-${RUN_SUFFIX}`);
    await markAgentReady(agentForRace);
    await runBackendRaceTests(server.baseUrl, control, agentForRace, managerCookie);

    await context.close();
    control.disconnect();
    agentMain.socket.disconnect();
    agentY.socket.disconnect();
    agentXForMulti.socket.disconnect();
    agentForError.socket.disconnect();
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (server) await stopServer(server);
    await cleanupTestData().catch((error) => log("CLEANUP_ERROR", String(error)));
    await pool.end().catch(() => undefined);
  }
};

run()
  .then(() => {
    console.log(`\n${passCount} succes, ${failCount} echec(s).`);
    process.exitCode = failCount > 0 ? 1 : 0;
  })
  .catch((error) => {
    console.error("[FATAL]", error);
    process.exitCode = 1;
  });
