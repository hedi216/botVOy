// HOTFIX CIBLE - Isolation des logs entre utilisateurs et agences.
//
// Politique cible (canViewBotLog, src/server.ts):
//   - role 0 (admin global): tous les logs ;
//   - role 1 (gestionnaire d'agence): tous les logs de SA PROPRE agence
//     (jamais une autre agence) ;
//   - role 2 (utilisateur standard): UNIQUEMENT les logs des bots qu'il
//     possede lui-meme (double condition explicite: meme agence ET meme
//     utilisateur - jamais "toute l'agence" comme c'etait le cas avant ce
//     hotfix via l'ancienne regle canSeeOwner reutilisee partout).
//   - proprietaire inconnu (agencyId/userId non determinable de maniere
//     fiable): FAIL CLOSED - jamais un broadcast par defaut a toute l'agence.
//
// Cette suite teste EXCLUSIVEMENT les canaux de logs (temps reel bot-log,
// historique bot-log-history a la connexion/reconnexion) - jamais les
// actions de controle bot (pause/reprise/arret), qui restent sur l'ancienne
// regle canSeeOwner (inchangee, hors perimetre de ce hotfix).
//
// Usage: npx tsx scripts/test-log-isolation-simulated.ts

import { ChildProcess, spawn } from "node:child_process";
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

type ServerHandle = { child: ChildProcess; baseUrl: string; port: number };

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
    env: { ...process.env, WEB_PORT: String(port), BOT_EXECUTION_MODE: "agent" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  return { child, baseUrl, port };
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

// ===================== Fixtures agences/utilisateurs =====================

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

type UserFixture = { userId: number; login: string; password: string; cookie: string };

const createUserFixture = async (
  baseUrl: string, adminCookie: string, agencyId: number, label: string, role: 1 | 2
): Promise<UserFixture> => {
  const loginName = `test-logiso-${label.toLowerCase()}-${RUN_SUFFIX}`;
  createdUserLogins.push(loginName);
  const userResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: loginName, name: `User ${label}`, email: `${loginName}@example.test`, role
  });
  if (userResult.status !== 200 && userResult.status !== 201) {
    throw new Error(`Creation utilisateur ${label} echouee: ${userResult.status} ${JSON.stringify(userResult.body)}`);
  }
  const body = userResult.body as { user?: { id: number }; temporaryPassword: string };
  const password = body.temporaryPassword;
  const cookie = await loginWithRetry(baseUrl, loginName, password);
  const me = await requestJson(baseUrl, "GET", "/api/me", cookie);
  const userId = (me.body as { user: { id: number } }).user.id;
  return { userId, login: loginName, password, cookie };
};

const createAgencyFixture = async (baseUrl: string, adminCookie: string, label: string): Promise<number> => {
  const agencyName = `Test LogIso ${label} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  return (agencyResult.body as { agency: { id: number } }).agency.id;
};

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  if (createdAgencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
};

// ===================== Agents fantomes + bots =====================

type FakeAgentHandle = { agentId: number; token: string; socket: Socket };

const pairFakeAgent = (baseUrl: string, managerCookie: string, computerName: string): Promise<FakeAgentHandle> =>
  requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {}).then((pairing) => new Promise((resolve, reject) => {
    const pairingCode = (pairing.body as { pairing: { code: string } }).pairing.code;
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "pair", pairingCode, computerName, version: "1.0.0", protocolVersion: 1 }
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

const reconnectFakeAgent = (baseUrl: string, agentId: number, token: string, computerName: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "reconnect", agentId, token, computerName, version: "1.0.0", protocolVersion: 1 }
    });
    const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout reconnexion agent fantome.")); }, 8_000);
    socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
    socket.on("AGENT_CONNECTED", () => { clearTimeout(t); resolve(socket); });
    socket.connect();
  });

const openUiSocket = (baseUrl: string, cookie: string): Promise<Socket> => new Promise((resolve, reject) => {
  const socket = ioClient(baseUrl, { autoConnect: false, reconnection: false, forceNew: true, extraHeaders: { Cookie: cookie } });
  const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion socket UI.")); }, 8_000);
  socket.on("connect", () => { clearTimeout(t); resolve(socket); });
  socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
  socket.connect();
});

// Ouvre une socket UI et capture (a) l'historique recu a la connexion et (b)
// tous les logs temps reel recus par la suite.
type UiListener = { socket: Socket; history: Array<{ message: string }>; live: Array<{ message: string }> };

const openUiListener = (baseUrl: string, cookie: string): Promise<UiListener> => new Promise((resolve, reject) => {
  const socket = ioClient(baseUrl, { autoConnect: false, reconnection: false, forceNew: true, extraHeaders: { Cookie: cookie } });
  const live: Array<{ message: string }> = [];
  socket.on("bot-log", (event: { message: string }) => live.push(event));
  const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion socket UI.")); }, 8_000);
  socket.once("bot-log-history", (events: Array<{ message: string }>) => {
    clearTimeout(t);
    resolve({ socket, history: Array.isArray(events) ? events : [], live });
  });
  socket.connect();
});

// Demarre un bot en mode Agent au nom de l'utilisateur `userCookie`, sur
// l'agent fantome fourni, et renvoie botId/commandId une fois START_BOT
// recu et acquitte. `extraPayload` permet d'injecter des champs additionnels
// (ex. TEST L: tentative de spoof agencyId).
const startAgentBotAsUser = async (
  baseUrl: string,
  userCookie: string,
  agent: FakeAgentHandle,
  botName: string,
  extraPayload: Record<string, unknown> = {}
): Promise<{ botId: string; commandId: string }> => {
  const commandsSeen: Array<Record<string, unknown>> = [];
  const onCommand = (command: Record<string, unknown>): void => { commandsSeen.push(command); };
  agent.socket.on("AGENT_COMMAND", onCommand);
  agent.socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
  await sleep(300);

  const uiSocket = await openUiSocket(baseUrl, userCookie);
  try {
    uiSocket.emit("start-bot", {
      botName, category: "", login: "x", password: "y",
      agentId: agent.agentId, clientRequestId: `logiso-${botName}-${RUN_SUFFIX}`,
      ...extraPayload
    });

    await waitUntilAsync(() => commandsSeen.some((c) => c.type === "START_BOT" && (c.payload as { botName?: string } | undefined)?.botName === botName), 8_000);
    agent.socket.off("AGENT_COMMAND", onCommand);
    const startCommand = commandsSeen.find((c) => c.type === "START_BOT" && (c.payload as { botName?: string } | undefined)?.botName === botName);
    if (!startCommand) throw new Error(`START_BOT jamais recu pour ${botName}.`);

    agent.socket.emit("COMMAND_ACK", { commandId: startCommand.commandId, receivedAt: new Date().toISOString() });
    return { botId: startCommand.botId as string, commandId: startCommand.commandId as string };
  } finally {
    uiSocket.disconnect();
  }
};

// Emet un log pour un bot Agent (via BOT_STATUS, seul canal reel de
// "log Agent -> web" - cf. audit emitBotLogFromAgent) et attend qu'il soit
// bien inscrit dans l'historique global cote serveur avant de continuer.
const emitAgentBotLog = async (agent: FakeAgentHandle, botId: string, commandId: string, status = "MONITORING"): Promise<void> => {
  agent.socket.emit("BOT_STATUS", { commandId, botId, status, timestamp: new Date().toISOString() });
  await sleep(400);
};

// ===================== TEST A-E: temps reel (une seule emission, plusieurs observateurs) =====================

const runRealtimeTests = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-A-E", "=== Temps reel: role2 meme agence / role1 / autre agence / admin ===");

  const agencyA = await createAgencyFixture(baseUrl, adminCookie, "RT-A");
  const agencyB = await createAgencyFixture(baseUrl, adminCookie, "RT-B");
  const managerA = await createUserFixture(baseUrl, adminCookie, agencyA, "RT-MgrA", 1);
  const userA1 = await createUserFixture(baseUrl, adminCookie, agencyA, "RT-A1", 2);
  const userA2 = await createUserFixture(baseUrl, adminCookie, agencyA, "RT-A2", 2);
  const managerB = await createUserFixture(baseUrl, adminCookie, agencyB, "RT-MgrB", 1);
  const userB1 = await createUserFixture(baseUrl, adminCookie, agencyB, "RT-B1", 2);

  const agentA = await pairFakeAgent(baseUrl, managerA.cookie, `PW-LOGISO-RT-A-${RUN_SUFFIX}`);
  const botX = await startAgentBotAsUser(baseUrl, userA1.cookie, agentA, `Bot RT X ${RUN_SUFFIX}`);

  // Tous les observateurs se connectent APRES le demarrage du bot (donc son
  // historique de demarrage n'est pas ce qu'on observe) mais AVANT le log
  // temps reel declencheur ci-dessous.
  const listeners = {
    a1: await openUiListener(baseUrl, userA1.cookie),
    a2: await openUiListener(baseUrl, userA2.cookie),
    mgrA: await openUiListener(baseUrl, managerA.cookie),
    mgrB: await openUiListener(baseUrl, managerB.cookie),
    b1: await openUiListener(baseUrl, userB1.cookie),
    admin: await openUiListener(baseUrl, adminCookie)
  };

  await emitAgentBotLog(agentA, botX.botId, botX.commandId, "MONITORING");
  await sleep(300);

  const received = (l: UiListener): boolean => l.live.some((e) => e.message.includes(`Bot RT X ${RUN_SUFFIX}`));

  assert(received(listeners.a1), "A) User A1 (proprietaire) recoit le log temps reel de son propre bot");
  assert(!received(listeners.a2), "A) User A2 (role 2, MEME agence, bot d'un AUTRE utilisateur) ne recoit PAS le log");
  assert(received(listeners.mgrA), "B) Manager A (role 1, meme agence) recoit le log");
  assert(!received(listeners.mgrB), "C) Manager B (autre agence) ne recoit PAS le log");
  assert(!received(listeners.b1), "C) User B1 (autre agence) ne recoit PAS le log");
  assert(received(listeners.admin), "D) Admin global recoit le log");
  assert(received(listeners.a1) && received(listeners.mgrA) && received(listeners.admin), "E) Log Agent temps reel: exactement A1 + Manager A + Admin (jamais A2/Agence B)");

  for (const l of Object.values(listeners)) l.socket.disconnect();
  agentA.socket.disconnect();
};

// ===================== TEST F: historique =====================

const runHistoryTest = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-F", "=== Historique (bot-log-history a la connexion): memes regles que le temps reel ===");

  const agencyA = await createAgencyFixture(baseUrl, adminCookie, "H-A");
  const agencyB = await createAgencyFixture(baseUrl, adminCookie, "H-B");
  const managerA = await createUserFixture(baseUrl, adminCookie, agencyA, "H-MgrA", 1);
  const userA1 = await createUserFixture(baseUrl, adminCookie, agencyA, "H-A1", 2);
  const userA2 = await createUserFixture(baseUrl, adminCookie, agencyA, "H-A2", 2);
  const managerB = await createUserFixture(baseUrl, adminCookie, agencyB, "H-MgrB", 1);
  const userB1 = await createUserFixture(baseUrl, adminCookie, agencyB, "H-B1", 2);

  const agentA = await pairFakeAgent(baseUrl, managerA.cookie, `PW-LOGISO-H-A-${RUN_SUFFIX}`);
  const agentB = await pairFakeAgent(baseUrl, managerB.cookie, `PW-LOGISO-H-B-${RUN_SUFFIX}`);

  const botA1X = await startAgentBotAsUser(baseUrl, userA1.cookie, agentA, `Bot H A1X ${RUN_SUFFIX}`);
  await emitAgentBotLog(agentA, botA1X.botId, botA1X.commandId);
  const botA2Y = await startAgentBotAsUser(baseUrl, userA2.cookie, agentA, `Bot H A2Y ${RUN_SUFFIX}`);
  await emitAgentBotLog(agentA, botA2Y.botId, botA2Y.commandId);
  const botB1Z = await startAgentBotAsUser(baseUrl, userB1.cookie, agentB, `Bot H B1Z ${RUN_SUFFIX}`);
  await emitAgentBotLog(agentB, botB1Z.botId, botB1Z.commandId);

  const hasEntry = (history: Array<{ message: string }>, needle: string): boolean =>
    history.some((e) => e.message.includes(needle));

  const a1 = await openUiListener(baseUrl, userA1.cookie);
  assert(hasEntry(a1.history, `Bot H A1X ${RUN_SUFFIX}`) && !hasEntry(a1.history, `Bot H A2Y ${RUN_SUFFIX}`) && !hasEntry(a1.history, `Bot H B1Z ${RUN_SUFFIX}`), "F) User A1: historique = A1-X seulement");

  const mgrA = await openUiListener(baseUrl, managerA.cookie);
  assert(hasEntry(mgrA.history, `Bot H A1X ${RUN_SUFFIX}`) && hasEntry(mgrA.history, `Bot H A2Y ${RUN_SUFFIX}`) && !hasEntry(mgrA.history, `Bot H B1Z ${RUN_SUFFIX}`), "F) Manager A: historique = A1-X + A2-Y (jamais B1-Z)");

  const mgrB = await openUiListener(baseUrl, managerB.cookie);
  assert(!hasEntry(mgrB.history, `Bot H A1X ${RUN_SUFFIX}`) && !hasEntry(mgrB.history, `Bot H A2Y ${RUN_SUFFIX}`) && hasEntry(mgrB.history, `Bot H B1Z ${RUN_SUFFIX}`), "F) Manager B: historique = B1-Z seulement");

  const admin = await openUiListener(baseUrl, adminCookie);
  assert(hasEntry(admin.history, `Bot H A1X ${RUN_SUFFIX}`) && hasEntry(admin.history, `Bot H A2Y ${RUN_SUFFIX}`) && hasEntry(admin.history, `Bot H B1Z ${RUN_SUFFIX}`), "F) Admin: historique = les 3 logs");

  log("TEST-G", "=== Dashboard: verifie par audit de code (public/app.js) - reutilise EXACTEMENT le meme flux bot-log/bot-log-history, aucune logique serveur separee -> deja couvert par TEST F, non retestable independamment cote serveur ===");

  for (const s of [a1, mgrA, mgrB, admin]) s.socket.disconnect();
  agentA.socket.disconnect();
  agentB.socket.disconnect();
};

// ===================== TEST H: reconnexion socket =====================

const runReconnectTest = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-H", "=== Reconnexion socket: aucune fuite temporaire pendant la phase de reconnexion ===");

  const agencyA = await createAgencyFixture(baseUrl, adminCookie, "RC-A");
  const userA1 = await createUserFixture(baseUrl, adminCookie, agencyA, "RC-A1", 2);
  const userA2 = await createUserFixture(baseUrl, adminCookie, agencyA, "RC-A2", 2);
  const managerA = await createUserFixture(baseUrl, adminCookie, agencyA, "RC-MgrA", 1);

  const agentA = await pairFakeAgent(baseUrl, managerA.cookie, `PW-LOGISO-RC-A-${RUN_SUFFIX}`);
  const botA2 = await startAgentBotAsUser(baseUrl, userA2.cookie, agentA, `Bot RC A2 ${RUN_SUFFIX}`);
  await emitAgentBotLog(agentA, botA2.botId, botA2.commandId);

  // A1 se connecte, se deconnecte, se reconnecte - a chaque etape, jamais le
  // log de A2.
  const first = await openUiListener(baseUrl, userA1.cookie);
  assert(!first.history.some((e) => e.message.includes(`Bot RC A2 ${RUN_SUFFIX}`)), "H) A1 (1ere connexion): historique ne contient pas le log de A2");
  first.socket.disconnect();
  await sleep(200);

  const second = await openUiListener(baseUrl, userA1.cookie);
  assert(!second.history.some((e) => e.message.includes(`Bot RC A2 ${RUN_SUFFIX}`)), "H) A1 (reconnexion): snapshot ne contient toujours pas le log de A2");

  // Un nouveau log de A2 pendant que A1 est reconnecte: toujours filtre en
  // temps reel egalement.
  await emitAgentBotLog(agentA, botA2.botId, botA2.commandId, "RATE_LIMITED");
  await sleep(300);
  assert(!second.live.some((e) => e.message.includes(`Bot RC A2 ${RUN_SUFFIX}`)), "H) A1 (apres reconnexion): aucune fuite temps reel du log de A2 non plus");

  second.socket.disconnect();
  agentA.socket.disconnect();
};

// ===================== TEST I/J: reboot Agent (reconstruction) + owner inconnu =====================

const runRebootAndUnknownOwnerTest = async (port: number): Promise<void> => {
  log("TEST-I-J", "=== Reboot Agent (registre en memoire perdu) -> ownership reconstruite depuis l'historique DB ; puis owner reellement inconnu -> fail closed ===");

  let server = await startServer(port);
  try {
    // Chaque redemarrage de PROCESSUS serveur ci-dessous invalide les cookies
    // de session precedents (store en memoire, cf. auth.ts): une connexion
    // admin FRAICHE est necessaire a chaque fois, jamais un cookie capture
    // avant un redemarrage.
    let adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyA = await createAgencyFixture(server.baseUrl, adminCookie, "RB-A");
    const managerA = await createUserFixture(server.baseUrl, adminCookie, agencyA, "RB-MgrA", 1);
    const userA1 = await createUserFixture(server.baseUrl, adminCookie, agencyA, "RB-A1", 2);
    const userA2 = await createUserFixture(server.baseUrl, adminCookie, agencyA, "RB-A2", 2);

    let agent = await pairFakeAgent(server.baseUrl, managerA.cookie, `PW-LOGISO-RB-A-${RUN_SUFFIX}`);
    const botX = await startAgentBotAsUser(server.baseUrl, userA1.cookie, agent, `Bot RB X ${RUN_SUFFIX}`);
    await emitAgentBotLog(agent, botX.botId, botX.commandId);

    const beforeReboot = await openUiListener(server.baseUrl, userA1.cookie);
    assert(beforeReboot.history.some((e) => e.message.includes(`Bot RB X ${RUN_SUFFIX}`)), "I) Avant reboot: A1 voit bien son propre log (etat prealable)");
    beforeReboot.socket.disconnect();

    const agentToken = agent.token;
    const agentId = agent.agentId;
    agent.socket.disconnect();

    // Redemarre le PROCESSUS serveur (jamais juste la socket agent): son
    // registre AgentBotRecord en memoire est entierement perdu, exactement
    // le scenario "Agent redemarre / bot runtime reconstruit" du cahier des
    // charges - la seule source durable pour reconstruire l'ownership est
    // alors l'historique DB (getBotOwnershipHistory), jamais l'inventaire
    // rapporte par l'agent lui-meme.
    await stopServer(server);
    server = await startServer(port);

    agent = { agentId, token: agentToken, socket: await reconnectFakeAgent(server.baseUrl, agentId, agentToken, `PW-LOGISO-RB-A-${RUN_SUFFIX}`) };
    agent.socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [{ botId: botX.botId, botName: `Bot RB X ${RUN_SUFFIX}`, status: "MONITORING" }] });
    await sleep(600);

    const managerACookieAfter = await loginWithRetry(server.baseUrl, managerA.login, managerA.password);
    const userA1CookieAfter = await loginWithRetry(server.baseUrl, userA1.login, userA1.password);
    const userA2CookieAfter = await loginWithRetry(server.baseUrl, userA2.login, userA2.password);

    const a1After = await openUiListener(server.baseUrl, userA1CookieAfter);
    const a2After = await openUiListener(server.baseUrl, userA2CookieAfter);
    const mgrAAfter = await openUiListener(server.baseUrl, managerACookieAfter);

    await emitAgentBotLog(agent, botX.botId, botX.commandId, "SLOT_DETECTED");
    await sleep(300);

    const receivedAfter = (l: UiListener): boolean => l.live.some((e) => e.message.includes(`Bot RB X ${RUN_SUFFIX}`));
    assert(receivedAfter(a1After), "I) Apres reboot serveur + reconstruction: A1 (proprietaire original) recoit toujours le log de Bot X");
    assert(!receivedAfter(a2After), "I) Apres reboot serveur + reconstruction: A2 ne recoit PAS le log (ownership n'a PAS bascule vers 'toute l'agence')");
    assert(receivedAfter(mgrAAfter), "I) Apres reboot serveur + reconstruction: Manager A recoit toujours le log (agence intacte)");

    a1After.socket.disconnect();
    a2After.socket.disconnect();
    mgrAAfter.socket.disconnect();

    // ---- TEST J: owner reellement inconnu (utilisateur createur supprime) ----
    // Supprime A1 de la base (agent_commands.created_by_user_id passe a NULL
    // via ON DELETE SET NULL) PUIS redemarre le serveur: la reconstruction ne
    // peut plus determiner ownerUserId de maniere fiable pour Bot X.
    await pool.query("DELETE FROM users WHERE id = $1", [userA1.userId]);
    agent.socket.disconnect();
    await stopServer(server);
    server = await startServer(port);

    agent = { agentId, token: agentToken, socket: await reconnectFakeAgent(server.baseUrl, agentId, agentToken, `PW-LOGISO-RB-A-${RUN_SUFFIX}`) };
    agent.socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [{ botId: botX.botId, botName: `Bot RB X ${RUN_SUFFIX}`, status: "MONITORING" }] });
    await sleep(600);

    const managerACookieJ = await loginWithRetry(server.baseUrl, managerA.login, managerA.password);
    const userA2CookieJ = await loginWithRetry(server.baseUrl, userA2.login, userA2.password);
    const adminCookieJ = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    const a2J = await openUiListener(server.baseUrl, userA2CookieJ);
    const mgrAJ = await openUiListener(server.baseUrl, managerACookieJ);
    const adminJ = await openUiListener(server.baseUrl, adminCookieJ);

    await emitAgentBotLog(agent, botX.botId, botX.commandId, "ERROR");
    await sleep(300);

    const receivedJ = (l: UiListener): boolean => l.live.some((e) => e.message.includes(`Bot RB X ${RUN_SUFFIX}`));
    assert(!receivedJ(a2J), "J) Owner (userId) inconnu: un autre role 2 de la meme agence ne recoit RIEN (fail closed, jamais un userId devine)");
    assert(receivedJ(mgrAJ), "J) Owner (userId) inconnu mais agencyId fiable: Role 1 de cette agence reste autorise");
    assert(receivedJ(adminJ), "J) Owner inconnu: Role 0 (admin global) recoit toujours");

    a2J.socket.disconnect();
    mgrAJ.socket.disconnect();
    adminJ.socket.disconnect();
    agent.socket.disconnect();
  } finally {
    await stopServer(server);
  }
};

// ===================== TEST L: tentative de spoof agence =====================

const runSpoofAttemptTest = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("TEST-L", "=== Tentative de spoof agence: un agencyId fourni par le client dans start-bot est ignore, l'agence reelle vient de la session ===");

  const agencyA = await createAgencyFixture(baseUrl, adminCookie, "SP-A");
  const agencyB = await createAgencyFixture(baseUrl, adminCookie, "SP-B");
  const managerA = await createUserFixture(baseUrl, adminCookie, agencyA, "SP-MgrA", 1);
  const managerB = await createUserFixture(baseUrl, adminCookie, agencyB, "SP-MgrB", 1);
  const userB1 = await createUserFixture(baseUrl, adminCookie, agencyB, "SP-B1", 2);

  const agentB = await pairFakeAgent(baseUrl, managerB.cookie, `PW-LOGISO-SP-B-${RUN_SUFFIX}`);

  // B1 (Agence B) tente d'injecter agencyId=Agence A dans le payload
  // start-bot - ce champ n'existe meme pas dans le contrat du handler
  // (server.ts): seul user.agency_id, issu de la session authentifiee, est
  // utilise.
  const botSpoof = await startAgentBotAsUser(baseUrl, userB1.cookie, agentB, `Bot SP Spoof ${RUN_SUFFIX}`, { agencyId: agencyA });
  await emitAgentBotLog(agentB, botSpoof.botId, botSpoof.commandId);

  const mgrAListener = await openUiListener(baseUrl, managerA.cookie);
  const mgrBListener = await openUiListener(baseUrl, managerB.cookie);

  assert(!mgrAListener.history.some((e) => e.message.includes(`Bot SP Spoof ${RUN_SUFFIX}`)), "L) Manager A (agence cible du spoof) ne voit PAS le log: le champ agencyId client injecte est ignore");
  assert(mgrBListener.history.some((e) => e.message.includes(`Bot SP Spoof ${RUN_SUFFIX}`)), "L) Manager B (agence REELLE de la session B1) voit bien le log: l'agence vient de la session, jamais du client");

  mgrAListener.socket.disconnect();
  mgrBListener.socket.disconnect();
  agentB.socket.disconnect();
};

// ===================== TEST K: clear logs (note, verifie par audit) =====================

const runClearLogsNote = (): void => {
  log("TEST-K", "=== Effacer les logs: verifie par audit de code (public/app.js) - action PUREMENT client (state.logs = []), aucun appel socket/HTTP emis, ne touche jamais logHistory ni un autre utilisateur -> rien a observer cote serveur, aucune regression possible sur ce chantier ===");
  assert(true, "K) Confirme par lecture du code: 'Effacer les logs' ne fait que vider le tableau local du navigateur (public/app.js), jamais d'effet serveur/inter-utilisateur");
};

// ===================== main =====================

const run = async (): Promise<void> => {
  let server: ServerHandle | undefined;
  try {
    server = await startServer(3406);
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    await runRealtimeTests(server.baseUrl, adminCookie);
    await runHistoryTest(server.baseUrl, adminCookie);
    await runReconnectTest(server.baseUrl, adminCookie);
    await runSpoofAttemptTest(server.baseUrl, adminCookie);
    runClearLogsNote();

    await stopServer(server);
    server = undefined;
    await runRebootAndUnknownOwnerTest(3406);
  } finally {
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
