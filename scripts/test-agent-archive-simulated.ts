// HOTFIX CIBLE - Suppression visuelle/logique des Agents deja revoques.
//
// "Supprimer" cote interface = ARCHIVAGE (soft-delete, agents.archived_at)
// cote serveur - jamais un DELETE physique (agent_commands.agent_id
// REFERENCES agents(id) ON DELETE CASCADE supprimerait sinon tout
// l'historique de commandes de cet agent). Un Agent doit deja etre
// status='revoked' avant d'etre archivable (jamais un raccourci implicite
// revoke+archive). listAgentsForAgency() exclut desormais les Agents
// archives - source unique des listes normales ET de selectAgentForCommand.
//
// Teste UNIQUEMENT la logique de ce hotfix (serveur reel + agents fantomes
// socket.io-client, jamais de vrai Chrome/agentMain.ts), meme architecture
// que scripts/test-agent-revoke-bots-simulated.ts (reutilisee ici).
//
// Usage: npx tsx scripts/test-agent-archive-simulated.ts

import { ChildProcess, spawn } from "node:child_process";
import { Socket, io as ioClient } from "socket.io-client";
import { ADMIN_LOGIN, ADMIN_PASSWORD, pool } from "../src/db.js";
import { registerAgentBot, updateAgentBotStatus, removeAgentBot, archiveAgentIfNoActiveBots } from "../src/agentCommandService.js";

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
    env: { ...process.env, WEB_PORT: String(port), BOT_EXECUTION_MODE: "agent" },
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

// ===================== Agences/managers/agents fantomes =====================

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

const createAgencyAndManager = async (baseUrl: string, adminCookie: string, label: string): Promise<{ agencyId: number; managerCookie: string }> => {
  const agencyName = `Test Archive ${label} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;

  const managerLogin = `test-archive-mgr-${label.toLowerCase()}-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const userResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: `Manager ${label}`, email: `${managerLogin}@example.test`, role: 1
  });
  const managerPassword = (userResult.body as { temporaryPassword: string }).temporaryPassword;
  const managerCookie = await loginWithRetry(baseUrl, managerLogin, managerPassword);
  return { agencyId, managerCookie };
};

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

const attemptReconnectFakeAgent = (baseUrl: string, agentId: number, token: string, computerName: string): Promise<{ ok: true; socket: Socket } | { ok: false; reason: string }> =>
  new Promise((resolve) => {
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "reconnect", agentId, token, computerName, version: "1.0.0", protocolVersion: 1 }
    });
    const t = setTimeout(() => { socket.disconnect(); resolve({ ok: false, reason: "TIMEOUT" }); }, 8_000);
    socket.on("connect_error", (e: Error) => { clearTimeout(t); resolve({ ok: false, reason: e.message }); });
    socket.on("AGENT_CONNECTED", () => { clearTimeout(t); resolve({ ok: true, socket }); });
    socket.connect();
  });

const revokeAgentViaApi = (baseUrl: string, cookie: string, agentId: number, agencyId?: number): Promise<HttpResult> =>
  requestJson(baseUrl, "POST", `/api/agents/${agentId}/revoke`, cookie, agencyId ? { agencyId } : {});

const deleteAgentViaApi = (baseUrl: string, cookie: string, agentId: number, agencyId?: number): Promise<HttpResult> =>
  requestJson(baseUrl, "DELETE", `/api/agents/${agentId}`, cookie, agencyId ? { agencyId } : {});

const listAgentsViaApi = async (baseUrl: string, cookie: string, agencyId?: number): Promise<Array<{ agentId: number; status: string }>> => {
  const path = agencyId ? `/api/agents?agencyId=${agencyId}` : "/api/agents";
  const result = await requestJson(baseUrl, "GET", path, cookie);
  return (result.body as { agents: Array<{ agentId: number; status: string }> }).agents;
};

const dbAgentRow = async (agentId: number): Promise<{ archived_at: string | null; status: string; agency_id: number } | null> => {
  const result = await pool.query<{ archived_at: string | null; status: string; agency_id: number }>(
    "SELECT archived_at, status, agency_id FROM agents WHERE id = $1",
    [agentId]
  );
  return result.rows[0] ?? null;
};

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  if (createdAgencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
};

// ===================== TEST A: Agent revoque supprimable =====================

const runTestA = async (baseUrl: string): Promise<void> => {
  log("TEST-A", "=== Agent revoque -> DELETE archive (archived_at renseigne, ligne DB conservee, absent des listes) ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const { agencyId, managerCookie } = await createAgencyAndManager(baseUrl, admin, "A");
  const agent = await pairFakeAgent(baseUrl, managerCookie, `PW-ARCHIVE-A-${RUN_SUFFIX}`);

  const revoke = await revokeAgentViaApi(baseUrl, managerCookie, agent.agentId);
  assert(revoke.status === 200, `A) Revoke prealable reussit (recu: ${revoke.status})`);

  const del = await deleteAgentViaApi(baseUrl, managerCookie, agent.agentId);
  assert(del.status === 200, `A) DELETE reussit sur un Agent revoque (recu: ${del.status}: ${JSON.stringify(del.body)})`);
  assert((del.body as { ok?: boolean } | null)?.ok === true, "A) Reponse { ok: true }");

  const row = await dbAgentRow(agent.agentId);
  assert(row !== null, "A) La ligne agents reste presente en base (jamais un DELETE physique)");
  assert(Boolean(row?.archived_at), `A) archived_at est renseigne (recu: ${row?.archived_at})`);
  assert(row?.status === "revoked", "A) status reste 'revoked' (jamais reecrit)");

  const list = await listAgentsViaApi(baseUrl, managerCookie);
  assert(!list.some((a) => a.agentId === agent.agentId), "A) L'agent n'apparait plus dans GET /api/agents");

  agent.socket.disconnect();
};

// ===================== TEST B: Agent actif non supprimable =====================

const runTestB = async (baseUrl: string): Promise<void> => {
  log("TEST-B", "=== Agent actif (jamais revoque) -> DELETE refuse (409), archived_at reste null, toujours visible ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const { managerCookie } = await createAgencyAndManager(baseUrl, admin, "B");
  const agent = await pairFakeAgent(baseUrl, managerCookie, `PW-ARCHIVE-B-${RUN_SUFFIX}`);

  const del = await deleteAgentViaApi(baseUrl, managerCookie, agent.agentId);
  assert(del.status === 409, `B) DELETE refuse pour un Agent encore actif (recu: ${del.status}: ${JSON.stringify(del.body)})`);
  assert(
    (del.body as { error?: string } | null)?.error === "L'agent doit etre revoque avant d'etre supprime.",
    `B) Message d'erreur exact (recu: ${JSON.stringify(del.body)})`
  );

  const row = await dbAgentRow(agent.agentId);
  assert(row?.archived_at == null, "B) archived_at reste null");
  assert(row?.status === "active", "B) status reste 'active'");

  const list = await listAgentsViaApi(baseUrl, managerCookie);
  assert(list.some((a) => a.agentId === agent.agentId && a.status !== "REVOKED"), "B) L'agent reste visible dans la liste");

  agent.socket.disconnect();
};

// ===================== TEST C: historique conserve =====================

const runTestC = async (baseUrl: string): Promise<void> => {
  log("TEST-C", "=== Revoke + archive -> l'historique agent_commands reste strictement inchange ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const { managerCookie } = await createAgencyAndManager(baseUrl, admin, "C");
  const agent = await pairFakeAgent(baseUrl, managerCookie, `PW-ARCHIVE-C-${RUN_SUFFIX}`);
  const uiSocket: Socket = await new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { autoConnect: false, reconnection: false, forceNew: true, extraHeaders: { Cookie: managerCookie } });
    const t = setTimeout(() => reject(new Error("timeout ui socket")), 8_000);
    socket.on("connect", () => { clearTimeout(t); resolve(socket); });
    socket.connect();
  });
  const commandsSeen: Array<Record<string, unknown>> = [];
  agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => {
    commandsSeen.push(command);
    agent.socket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
  });
  agent.socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
  await sleep(300);

  // Genere plusieurs lignes d'historique reelles: 2x (START_BOT + STOP_BOT).
  for (let i = 1; i <= 2; i += 1) {
    const botName = `Bot History ${i} ${RUN_SUFFIX}`;
    uiSocket.emit("start-bot", { botName, category: "", agentId: agent.agentId, clientRequestId: `tc-archive-start-${i}-${RUN_SUFFIX}` });
    const startCmd = await waitUntilAsync(() => commandsSeen.find((c) => c.type === "START_BOT" && (c as { botName?: string }).botName === undefined) !== undefined || true, 200)
      .then(() => commandsSeen.find((c) => c.type === "START_BOT"));
    // Recupere via l'historique reel plutot que de deviner: relit toutes les commandes vues.
    const started = await waitUntilAsync(() => commandsSeen.some((c) => c.type === "START_BOT"), 8_000);
    assert(started, `C) START_BOT ${i} bien recu par l'agent fantome`);
    const cmd = commandsSeen[commandsSeen.length - 1];
    const botId = cmd.botId as string;
    agent.socket.emit("BOT_STATUS", { commandId: cmd.commandId, botId, status: "WAITING_FOR_USER" });
    agent.socket.emit("COMMAND_COMPLETED", { commandId: cmd.commandId, completedAt: new Date().toISOString(), result: { botId, status: "WAITING_FOR_USER", started: true } });
    await sleep(200);

    uiSocket.emit("stop-bot", { botId, clientRequestId: `tc-archive-stop-${i}-${RUN_SUFFIX}` });
    await waitUntilAsync(() => commandsSeen.some((c) => c.type === "STOP_BOT" && c.botId === botId), 8_000);
    const stopCmd = commandsSeen.find((c) => c.type === "STOP_BOT" && c.botId === botId)!;
    agent.socket.emit("BOT_STATUS", { commandId: stopCmd.commandId, botId, status: "STOPPED" });
    agent.socket.emit("COMMAND_COMPLETED", { commandId: stopCmd.commandId, completedAt: new Date().toISOString(), result: { botId, status: "STOPPED", stopped: true } });
    await sleep(200);
    void startCmd;
  }

  const before = await pool.query<{ command_id: string }>("SELECT command_id FROM agent_commands WHERE agent_id = $1 ORDER BY command_id", [agent.agentId]);
  assert(before.rows.length === 4, `C) 4 commandes historiques generees avant revoke/archive (recu: ${before.rows.length})`);

  await revokeAgentViaApi(baseUrl, managerCookie, agent.agentId);
  await deleteAgentViaApi(baseUrl, managerCookie, agent.agentId);

  const after = await pool.query<{ command_id: string }>("SELECT command_id FROM agent_commands WHERE agent_id = $1 ORDER BY command_id", [agent.agentId]);
  assert(
    JSON.stringify(after.rows.map((r) => r.command_id)) === JSON.stringify(before.rows.map((r) => r.command_id)),
    `C) L'ensemble EXACT des command_id est inchange apres revoke+archive (avant: ${before.rows.length}, apres: ${after.rows.length})`
  );

  agent.socket.disconnect();
  uiSocket.disconnect();
};

// ===================== TEST D: isolation agence =====================

const runTestD = async (baseUrl: string): Promise<void> => {
  log("TEST-D", "=== Manager Agence A ne peut jamais supprimer un Agent d'Agence B ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const a = await createAgencyAndManager(baseUrl, admin, "D-A");
  const b = await createAgencyAndManager(baseUrl, admin, "D-B");
  const agentB = await pairFakeAgent(baseUrl, b.managerCookie, `PW-ARCHIVE-D-B-${RUN_SUFFIX}`);
  await revokeAgentViaApi(baseUrl, b.managerCookie, agentB.agentId);

  const del = await deleteAgentViaApi(baseUrl, a.managerCookie, agentB.agentId);
  assert([403, 404].includes(del.status), `D) Manager A ne peut pas supprimer l'Agent d'Agence B (recu: ${del.status})`);

  const row = await dbAgentRow(agentB.agentId);
  assert(row?.archived_at == null, "D) L'agent B n'est pas archive par la tentative inter-agence");

  agentB.socket.disconnect();
};

// ===================== TEST E: admin global avec agence choisie =====================

const runTestE = async (baseUrl: string): Promise<void> => {
  log("TEST-E", "=== Admin global: agencyId explicite requis et verifie, jamais un DELETE inter-agence via agentId seul ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const a = await createAgencyAndManager(baseUrl, admin, "E-A");
  const b = await createAgencyAndManager(baseUrl, admin, "E-B");
  const agentA = await pairFakeAgent(baseUrl, a.managerCookie, `PW-ARCHIVE-E-A-${RUN_SUFFIX}`);
  const agentB = await pairFakeAgent(baseUrl, b.managerCookie, `PW-ARCHIVE-E-B-${RUN_SUFFIX}`);
  await revokeAgentViaApi(baseUrl, admin, agentA.agentId, a.agencyId);
  await revokeAgentViaApi(baseUrl, admin, agentB.agentId, b.agencyId);

  const okDelete = await deleteAgentViaApi(baseUrl, admin, agentA.agentId, a.agencyId);
  assert(okDelete.status === 200, `E) Admin cible Agence A, Agent appartient a A -> succes (recu: ${okDelete.status})`);

  // Admin CIBLE l'agence A (agencyId=A dans le corps) mais l'agentId fourni
  // appartient reellement a B: jamais un archivage croise via agentId seul.
  const crossDelete = await deleteAgentViaApi(baseUrl, admin, agentB.agentId, a.agencyId);
  assert([403, 404].includes(crossDelete.status), `E) Admin ciblant Agence A ne peut pas supprimer un Agent de B via son id (recu: ${crossDelete.status})`);
  const rowB = await dbAgentRow(agentB.agentId);
  assert(rowB?.archived_at == null, "E) L'agent B reste non archive apres la tentative croisee");

  agentA.socket.disconnect();
  agentB.socket.disconnect();
};

// ===================== TEST F: securite bot actif =====================
//
// Le registre AgentBotRecord (agentBots) est un Map en memoire PROPRE A
// CHAQUE PROCESSUS Node. Le serveur de test tourne dans un processus enfant
// spawn (startServer/spawn ci-dessus): un import direct de
// registerAgentBot/updateAgentBotStatus depuis CE script de test n'affecte
// donc jamais le registre de ce serveur spawn - seulement celui de ce script.
// Ce test verifie donc la regle metier "un AgentBotRecord actif bloque
// l'archivage" directement EN PROCESS, en appelant archiveAgentIfNoActiveBots
// (le meme code exact que la route DELETE /api/agents/:id) sur une ligne
// agents reelle inseree directement en base pour ce test (meme pattern que
// runDispatchFailureCleanupTest dans scripts/test-agency-bot-quota.ts), sans
// passer par le serveur spawn ni par HTTP.

const runTestF = async (): Promise<void> => {
  log("TEST-F", "=== [en process] Agent revoque + AgentBotRecord actif anormal -> archivage refuse tant qu'il reste actif ===");
  const agencyName = `Test Archive F ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyInsert = await pool.query<{ id: number }>(
    "INSERT INTO agencies (name, max_active_clients) VALUES ($1, 15) RETURNING id",
    [agencyName]
  );
  const agencyId = agencyInsert.rows[0].id;

  const agentInsert = await pool.query<{ id: number }>(
    `INSERT INTO agents (agency_id, name, computer_name, token_hash, status, revoked_at)
     VALUES ($1, 'Agent Archive F', $2, 'unused', 'revoked', NOW())
     RETURNING id`,
    [agencyId, `PW-ARCHIVE-F-${RUN_SUFFIX}`]
  );
  const agentId = agentInsert.rows[0].id;

  // Simule un runtime anormal: un AgentBotRecord actif subsiste pour cet
  // agentId revoque (bug hypothetique ailleurs, jamais suppose impossible) -
  // le revoke garantit deja normalement bots STOPPED/active=false, cette
  // verification reste purement defensive.
  const fakeBotId = `bot-archive-f-${RUN_SUFFIX}`;
  registerAgentBot({
    botId: fakeBotId,
    agentId,
    agencyId,
    ownerUserId: 0,
    botName: "Bot F Artificial",
    category: "",
    latestCommandId: "",
    botStatus: "MONITORING",
    botStatusUpdatedAt: new Date().toISOString(),
    active: true,
    updatedAt: new Date().toISOString()
  });

  try {
    const blocked = await archiveAgentIfNoActiveBots(agencyId, agentId);
    assert(!blocked.ok && blocked.reason === "BOT_ACTIVE", `F) Archivage refuse tant qu'un bot actif subsiste (recu: ${JSON.stringify(blocked)})`);
    const rowBlocked = await dbAgentRow(agentId);
    assert(rowBlocked?.archived_at == null, "F) L'agent n'est pas archive tant que le bot est actif");

    updateAgentBotStatus(fakeBotId, "STOPPED");
    const allowed = await archiveAgentIfNoActiveBots(agencyId, agentId);
    assert(allowed.ok === true, `F) Une fois le bot STOPPED/active=false, l'archivage est accepte (recu: ${JSON.stringify(allowed)})`);
    const rowOk = await dbAgentRow(agentId);
    assert(Boolean(rowOk?.archived_at), "F) L'agent est bien archive une fois le bot inactif");
  } finally {
    removeAgentBot(fakeBotId);
  }
};

// ===================== TEST G: ancien token inutilisable =====================

const runTestG = async (baseUrl: string): Promise<void> => {
  log("TEST-G", "=== Agent archive: une reconnexion avec le VRAI ancien token est toujours refusee (AGENT_REVOKED) ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const { managerCookie } = await createAgencyAndManager(baseUrl, admin, "G");
  const agent = await pairFakeAgent(baseUrl, managerCookie, `PW-ARCHIVE-G-${RUN_SUFFIX}`);
  await revokeAgentViaApi(baseUrl, managerCookie, agent.agentId);
  await waitUntilAsync(() => !agent.socket.connected, 5_000);
  await deleteAgentViaApi(baseUrl, managerCookie, agent.agentId);

  const reconnectResult = await attemptReconnectFakeAgent(baseUrl, agent.agentId, agent.token, `PW-ARCHIVE-G-${RUN_SUFFIX}`);
  assert(!reconnectResult.ok, "G) La reconnexion (vrai agentId + vrai token) est refusee apres archivage");
  if (!reconnectResult.ok) {
    assert(reconnectResult.reason === "AGENT_REVOKED", `G) Raison exacte AGENT_REVOKED, jamais reactive (recu: ${reconnectResult.reason})`);
  }
};

// ===================== TEST H: nouvel appairage meme ordinateur =====================

const runTestH = async (baseUrl: string): Promise<void> => {
  log("TEST-H", "=== Nouvel appairage du meme ordinateur -> nouvel agentId, l'ancien archive reste invisible ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const { managerCookie } = await createAgencyAndManager(baseUrl, admin, "H");
  const computerName = `PW-ARCHIVE-H-${RUN_SUFFIX}`;

  const oldAgent = await pairFakeAgent(baseUrl, managerCookie, computerName);
  await revokeAgentViaApi(baseUrl, managerCookie, oldAgent.agentId);
  await deleteAgentViaApi(baseUrl, managerCookie, oldAgent.agentId);
  oldAgent.socket.disconnect();

  const newAgent = await pairFakeAgent(baseUrl, managerCookie, computerName);
  assert(newAgent.agentId !== oldAgent.agentId, `H) Le nouvel appairage cree un NOUVEL agentId (ancien: ${oldAgent.agentId}, nouveau: ${newAgent.agentId})`);

  const list = await listAgentsViaApi(baseUrl, managerCookie);
  assert(list.some((a) => a.agentId === newAgent.agentId), "H) Le nouvel Agent est visible");
  assert(!list.some((a) => a.agentId === oldAgent.agentId), "H) L'ancien Agent archive reste invisible");

  newAgent.socket.disconnect();
};

// ===================== TEST I: liste (ACTIVE/REVOKED/REVOKED+archived) =====================

const runTestI = async (baseUrl: string): Promise<void> => {
  log("TEST-I", "=== Liste: ACTIVE visible, REVOKED non archive visible, REVOKED archive absent ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const { managerCookie } = await createAgencyAndManager(baseUrl, admin, "I");

  const agentA = await pairFakeAgent(baseUrl, managerCookie, `PW-ARCHIVE-I-A-${RUN_SUFFIX}`);
  const agentB = await pairFakeAgent(baseUrl, managerCookie, `PW-ARCHIVE-I-B-${RUN_SUFFIX}`);
  const agentC = await pairFakeAgent(baseUrl, managerCookie, `PW-ARCHIVE-I-C-${RUN_SUFFIX}`);
  await revokeAgentViaApi(baseUrl, managerCookie, agentB.agentId);
  await revokeAgentViaApi(baseUrl, managerCookie, agentC.agentId);
  await deleteAgentViaApi(baseUrl, managerCookie, agentC.agentId);

  const list = await listAgentsViaApi(baseUrl, managerCookie);
  assert(list.some((a) => a.agentId === agentA.agentId), "I) Agent A (ACTIVE) present");
  assert(list.some((a) => a.agentId === agentB.agentId && a.status === "REVOKED"), "I) Agent B (REVOKED non archive) present");
  assert(!list.some((a) => a.agentId === agentC.agentId), "I) Agent C (REVOKED + archive) absent");

  agentA.socket.disconnect();
  agentB.socket.disconnect();
  agentC.socket.disconnect();
};

// ===================== main =====================

const run = async (): Promise<void> => {
  let server: ServerHandle | undefined;
  try {
    server = await startServer(3404);

    await runTestA(server.baseUrl);
    await runTestB(server.baseUrl);
    await runTestC(server.baseUrl);
    await runTestD(server.baseUrl);
    await runTestE(server.baseUrl);
    await runTestF();
    await runTestG(server.baseUrl);
    await runTestH(server.baseUrl);
    await runTestI(server.baseUrl);
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
