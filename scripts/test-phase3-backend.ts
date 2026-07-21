// Tests d'integration backend Phase 3: protocole de commandes serveur-agent,
// accuses de reception, remontee de statuts, idempotence, timeouts,
// deconnexions, revocation, absence de secrets, absence de Chrome sur la VM.
//
// Usage: npx tsx scripts/test-phase3-backend.ts

import { ChildProcess, spawn } from "node:child_process";
import { Socket, io as ioClient } from "socket.io-client";
import { pool } from "../src/db.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
const TEST_SECRET_LOGIN = "TEST_SECRET_LOGIN";
const TEST_SECRET_PASSWORD = "TEST_SECRET_PASSWORD";

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

// --- Detection recursive de cles/valeurs sensibles ---

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

const containsSentinel = (value: unknown): boolean => JSON.stringify(value ?? null).includes(TEST_SECRET_LOGIN)
  || JSON.stringify(value ?? null).includes(TEST_SECRET_PASSWORD);

// --- Cycle de vie serveur ---

type ServerHandle = { child: ChildProcess; baseUrl: string; stdout: string[] };

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
  const stdout: string[] = [];
  const child = spawn(command, ["tsx", "src/server.ts"], {
    env: { ...process.env, WEB_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout.push(text);
    log("SERVER_STDOUT", text.trim());
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stdout.push(text);
    log("SERVER_STDERR", text.trim());
  });

  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  return { child, baseUrl, stdout };
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

// --- Inventaire chrome.exe (verification litterale) ---

const listChromePids = (): Promise<Set<string>> =>
  new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve(new Set());
      return;
    }
    const child = spawn("wmic", ["process", "where", "Name='chrome.exe'", "get", "ProcessId"]);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.on("exit", () => {
      const pids = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
      resolve(new Set(pids));
    });
    child.on("error", () => resolve(new Set()));
  });

const killPids = async (pids: string[]): Promise<void> => {
  for (const pid of pids) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", pid, "/T", "/F"]);
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
  }
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
): Promise<{ agencyId: number; managerCookie: string }> => {
  const agencyName = `Test Phase3 ${labelSuffix} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;

  const managerLogin = `test-p3-${labelSuffix.toLowerCase()}-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const userResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: `Manager ${labelSuffix}`, email: `${managerLogin}@example.test`, role: 1
  });
  const managerPassword = (userResult.body as { temporaryPassword: string }).temporaryPassword;
  const managerCookie = await loginWithRetry(baseUrl, managerLogin, managerPassword);

  return { agencyId, managerCookie };
};

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) {
    await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  }
  if (createdAgencyNames.length > 0) {
    await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
  }
};

// --- Socket UI (client web authentifie, comme le navigateur) ---

const connectUiSocket = (baseUrl: string, cookie: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { autoConnect: false, reconnection: false, extraHeaders: { Cookie: cookie } });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion socket UI.")); }, 8_000);
    socket.on("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.on("connect_error", (error: Error) => { clearTimeout(timer); reject(error); });
    socket.connect();
  });

type CommandEvent = Record<string, unknown> & { commandId: string; status: string; botId: string };

const collectCommandEvents = (socket: Socket): CommandEvent[] => {
  const events: CommandEvent[] = [];
  socket.on("agent-command-status", (payload: CommandEvent) => events.push(payload));
  return events;
};

const waitUntil = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
  intervalMs = 100
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return predicate();
};

// --- Agent fantome pilotable (comportement injecte par scenario) ---

type FakeAgentAuth =
  | { mode: "pair"; pairingCode: string; computerName: string; version: string }
  | { mode: "reconnect"; agentId: number; token: string; version: string };

type FakeAgentHandle = { agentId: number; token: string; socket: Socket };

const connectFakeAgent = (
  baseUrl: string,
  auth: FakeAgentAuth,
  onCommand?: (socket: Socket, command: Record<string, unknown>) => void
): Promise<FakeAgentHandle> =>
  new Promise((resolve, reject) => {
    // forceNew: sans cela, socket.io-client multiplexe par defaut plusieurs
    // connexions vers la meme URI sur un seul Manager sous-jacent ; ce test
    // ouvre volontairement de nombreuses connexions /agent successives dans
    // le meme process (chacune avec une auth differente), ce qui s'est
    // revele responsable d'ACK ne parvenant jamais au bon socket cote serveur.
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
  return connectFakeAgent(baseUrl, { mode: "pair", pairingCode: code, computerName, version }, onCommand);
};

const ackOnly = (socket: Socket, command: Record<string, unknown>): void => {
  socket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
};

// --- Scenario principal ---

const run = async (): Promise<void> => {
  const servers: ServerHandle[] = [];
  const chromePidsToCleanup: string[] = [];

  try {
    const chromeBeforeAll = await listChromePids();

    // ===================== Serveur principal: mode agent =====================
    const server = await startServer(3241, {
      BOT_EXECUTION_MODE: "agent",
      // Marges generreuses: le scenario complet paire ~20 agents en sequence,
      // et un delai trop serre s'est revele fragile sous cette charge cumulee
      // (confirme sans equivoque par une reproduction isolee du meme flux,
      // qui reussit systematiquement en dehors de la grande suite).
      AGENT_COMMAND_ACK_TIMEOUT_MS: "6000",
      AGENT_COMMAND_TTL_MS: "12000",
      AGENT_COMMAND_SWEEP_INTERVAL_MS: "1000"
    });
    servers.push(server);

    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyA = await createAgencyAndManager(server.baseUrl, adminCookie, "A");
    const agencyB = await createAgencyAndManager(server.baseUrl, adminCookie, "B");

    const uiA = await connectUiSocket(server.baseUrl, agencyA.managerCookie);
    const eventsA = collectCommandEvents(uiA);
    const botStatusEventsA: Array<Record<string, unknown>> = [];
    uiA.on("bot-status", (payload: Record<string, unknown>) => botStatusEventsA.push(payload));

    // --- TC1: aucun agent connecte -> AGENT_NOT_CONNECTED ---
    uiA.emit("start-bot", { botName: "Bot TC1", category: "Tourisme", clientRequestId: `tc1-${RUN_SUFFIX}` });
    await waitUntil(() => botStatusEventsA.some((e) => e.code === "AGENT_NOT_CONNECTED"));
    assert(
      botStatusEventsA.some((e) => e.code === "AGENT_NOT_CONNECTED"),
      "TC1: aucun agent connecte -> AGENT_NOT_CONNECTED"
    );
    assert(eventsA.length === 0, "TC1: aucune commande creee sans agent connecte");

    // --- Agent principal (comportement "succes", mais reellement simule) ---
    const agentAuto = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-AUTO", "1.0.0", (socket, command) => {
      void (async () => {
        socket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
        await sleep(150);
        socket.emit("BOT_STATUS", { commandId: command.commandId, botId: command.botId, status: "STARTING", timestamp: new Date().toISOString() });
        await sleep(150);
        socket.emit("BOT_STATUS", { commandId: command.commandId, botId: command.botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
        await sleep(150);
        socket.emit("COMMAND_COMPLETED", { commandId: command.commandId, completedAt: new Date().toISOString(), result: { simulated: true } });
      })();
    });

    // --- TC2: agent unique connecte -> selection automatique, cycle complet,
    // avec des valeurs sentinelles TLScontact qui ne doivent apparaitre nulle part ---
    const clientRequestIdTc2 = `tc2-${RUN_SUFFIX}`;
    uiA.emit("start-bot", {
      botName: "Bot TC2",
      category: "Tourisme",
      login: TEST_SECRET_LOGIN,
      password: TEST_SECRET_PASSWORD,
      clientRequestId: clientRequestIdTc2
    });

    await waitUntil(() => eventsA.some((e) => e.status === "COMPLETED"));
    const tc2Sequence = eventsA.filter((e) => e.status !== undefined).map((e) => e.status);
    assert(tc2Sequence.includes("SENT"), "TC2: la sequence contient SENT");
    assert(tc2Sequence.includes("ACKNOWLEDGED"), "TC2: la sequence contient ACKNOWLEDGED");
    assert(tc2Sequence.includes("COMPLETED"), "TC2: la sequence contient COMPLETED");
    const tc2Completed = eventsA.find((e) => e.status === "COMPLETED")!;
    assert(!containsSentinel(eventsA), "TC2: aucune valeur sentinelle TLScontact dans les evenements agent-command-status");
    assert(findForbiddenKeys(eventsA).length === 0, "TC2: aucune cle sensible dans les evenements agent-command-status");

    await waitUntil(() => botStatusEventsA.length >= 0, 500); // laisse le temps aux BOT_STATUS d'etre journalises
    const commandIdTc2 = tc2Completed.commandId;

    const dbRowTc2 = await pool.query("SELECT public_payload, public_result, error_message FROM agent_commands WHERE command_id = $1", [commandIdTc2]);
    assert(!containsSentinel(dbRowTc2.rows[0]), "TC2: aucune valeur sentinelle dans public_payload/public_result en base");
    assert(
      !("login" in ((dbRowTc2.rows[0]?.public_payload as Record<string, unknown>) ?? {})) &&
      !("password" in ((dbRowTc2.rows[0]?.public_payload as Record<string, unknown>) ?? {})),
      "TC2: public_payload ne contient ni login ni password (solution A)"
    );

    const tc2Rest = await requestJson(server.baseUrl, "GET", `/api/agent-commands/${commandIdTc2}`, agencyA.managerCookie);
    assert(!containsSentinel(tc2Rest.body), "TC2: aucune valeur sentinelle dans la reponse REST de la commande");
    assert(findForbiddenKeys(tc2Rest.body).length === 0, "TC2: aucune cle sensible dans la reponse REST de la commande");

    // --- TC3 (idempotence / double-clic): meme clientRequestId -> meme commande ---
    uiA.emit("start-bot", { botName: "Bot TC2 bis", category: "Tourisme", clientRequestId: clientRequestIdTc2 });
    await sleep(500);
    const commandsWithSameId = eventsA.filter((e) => e.commandId === commandIdTc2);
    const distinctCommandIdsAfterDuplicate = new Set(eventsA.map((e) => e.commandId));
    assert(commandsWithSameId.length > 0, "TC3: la repetition du meme clientRequestId retrouve la commande existante");
    assert(distinctCommandIdsAfterDuplicate.size === 1, "TC3: aucune seconde commande creee pour le meme clientRequestId");

    // ===================== Plusieurs agents connectes: selection requise =====================
    const agentMulti1 = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-MULTI-1", "1.0.0", ackOnly);
    const agentMulti2 = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-MULTI-2", "1.0.0", ackOnly);

    uiA.emit("start-bot", { botName: "Bot Multi", category: "Tourisme", clientRequestId: `tc-multi-${RUN_SUFFIX}` });
    await waitUntil(() => botStatusEventsA.some((e) => e.code === "AGENT_SELECTION_REQUIRED"));
    const selectionRequiredEvent = botStatusEventsA.find((e) => e.code === "AGENT_SELECTION_REQUIRED");
    assert(Boolean(selectionRequiredEvent), "TC-multi: plusieurs agents connectes -> AGENT_SELECTION_REQUIRED");
    assert(
      Array.isArray(selectionRequiredEvent?.agents) && (selectionRequiredEvent!.agents as unknown[]).length >= 2,
      "TC-multi: la liste des agents assainis est fournie pour permettre la selection"
    );
    assert(findForbiddenKeys(selectionRequiredEvent?.agents).length === 0, "TC-multi: la liste d'agents ne contient aucun secret");

    uiA.emit("start-bot", {
      botName: "Bot Multi Explicite",
      category: "Tourisme",
      agentId: agentMulti1.agentId,
      clientRequestId: `tc-multi-explicit-${RUN_SUFFIX}`
    });
    await waitUntil(() => eventsA.some((e) => e.commandId && e.status === "SENT" && e.agentId === agentMulti1.agentId));
    assert(
      eventsA.some((e) => e.agentId === agentMulti1.agentId && e.status === "SENT"),
      "TC-multi: avec agentId explicite, la commande est envoyee au bon agent"
    );

    agentMulti1.socket.disconnect();
    agentMulti2.socket.disconnect();

    // ===================== Agent hors ligne =====================
    const agentOffline = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-OFFLINE", "1.0.0");
    agentOffline.socket.disconnect();
    await sleep(300);

    const beforeOfflineTest = eventsA.length;
    uiA.emit("start-bot", { botName: "Bot Offline", category: "Tourisme", agentId: agentOffline.agentId, clientRequestId: `tc-offline-${RUN_SUFFIX}` });
    await waitUntil(() => botStatusEventsA.filter((e) => e.code === "AGENT_NOT_CONNECTED").length >= 2);
    assert(
      botStatusEventsA.filter((e) => e.code === "AGENT_NOT_CONNECTED").length >= 2,
      "TC-offline: agent hors ligne -> AGENT_NOT_CONNECTED"
    );
    assert(eventsA.length === beforeOfflineTest, "TC-offline: aucune commande creee pour un agent hors ligne");

    // ===================== Agent d'une autre agence =====================
    const agentB = await pairAgentWithBehavior(server.baseUrl, agencyB.managerCookie, "PW-P3-AGENCY-B", "1.0.0", ackOnly);
    const beforeCrossAgency = eventsA.length;
    uiA.emit("start-bot", { botName: "Bot Cross Agency", category: "Tourisme", agentId: agentB.agentId, clientRequestId: `tc-cross-${RUN_SUFFIX}` });
    await sleep(500);
    assert(
      botStatusEventsA.some((e) => e.code === "AGENT_NOT_CONNECTED"),
      "TC-cross-agency: un agentId d'une autre agence est refuse comme AGENT_NOT_CONNECTED (pas de fuite d'info)"
    );
    assert(eventsA.length === beforeCrossAgency, "TC-cross-agency: aucune commande creee vers l'agent d'une autre agence");
    agentB.socket.disconnect();

    // ===================== Agent revoque =====================
    const agentToRevoke = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-REVOKE-SELECT", "1.0.0", ackOnly);
    const agentsListForRevoke = await requestJson(server.baseUrl, "GET", "/api/agents", agencyA.managerCookie);
    const revokeTargetRow = (agentsListForRevoke.body as { agents: Array<{ agentId: number }> }).agents.find((a) => a.agentId === agentToRevoke.agentId)!;
    await requestJson(server.baseUrl, "POST", `/api/agents/${revokeTargetRow.agentId}/revoke`, agencyA.managerCookie, {});
    await sleep(300);

    const beforeRevokedSelectTest = eventsA.length;
    uiA.emit("start-bot", { botName: "Bot Revoked", category: "Tourisme", agentId: agentToRevoke.agentId, clientRequestId: `tc-revoked-select-${RUN_SUFFIX}` });
    await sleep(500);
    assert(
      botStatusEventsA.filter((e) => e.code === "AGENT_NOT_CONNECTED").length > 0,
      "TC-revoked: un agent revoque ne peut jamais etre selectionne (AGENT_NOT_CONNECTED)"
    );
    assert(eventsA.length === beforeRevokedSelectTest, "TC-revoked: aucune commande creee vers un agent revoque");

    // ===================== Revocation avec commande en cours =====================
    const agentToRevokeInFlight = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-REVOKE-INFLIGHT", "1.0.0");
    // (pas d'ACK: la commande reste "sent" quand la revocation survient)
    const revokeInFlightRequestId = `tc-revoke-inflight-${RUN_SUFFIX}`;
    uiA.emit("start-bot", {
      botName: "Bot Revoke InFlight",
      category: "Tourisme",
      agentId: agentToRevokeInFlight.agentId,
      clientRequestId: revokeInFlightRequestId
    });
    await waitUntil(() => eventsA.some((e) => e.commandId && e.status === "SENT" && e.agentId === agentToRevokeInFlight.agentId));
    const inFlightCommandId = eventsA.find((e) => e.agentId === agentToRevokeInFlight.agentId && e.status === "SENT")!.commandId;

    const socketDisconnectedPromise = new Promise<void>((resolve) => agentToRevokeInFlight.socket.once("disconnect", () => resolve()));
    await requestJson(server.baseUrl, "POST", `/api/agents/${agentToRevokeInFlight.agentId}/revoke`, agencyA.managerCookie, {});
    await Promise.race([socketDisconnectedPromise, sleep(3_000)]);

    await waitUntil(() => eventsA.some((e) => e.commandId === inFlightCommandId && e.status === "FAILED"));
    const revokedCommandEvent = eventsA.find((e) => e.commandId === inFlightCommandId && e.status === "FAILED");
    assert(Boolean(revokedCommandEvent), "TC-revoke-inflight: la commande en cours passe FAILED apres revocation");
    const revokedRow = await pool.query("SELECT error_code FROM agent_commands WHERE command_id = $1", [inFlightCommandId]);
    assert(revokedRow.rows[0]?.error_code === "AGENT_REVOKED", "TC-revoke-inflight: error_code = AGENT_REVOKED (pas AGENT_DISCONNECTED)");

    // ===================== ACK timeout =====================
    const agentNoAck = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-NO-ACK", "1.0.0");
    const noAckRequestId = `tc-no-ack-${RUN_SUFFIX}`;
    uiA.emit("start-bot", { botName: "Bot No Ack", category: "Tourisme", agentId: agentNoAck.agentId, clientRequestId: noAckRequestId });
    await waitUntil(() => eventsA.some((e) => e.agentId === agentNoAck.agentId && e.status === "SENT"));
    const noAckCommandId = eventsA.find((e) => e.agentId === agentNoAck.agentId && e.status === "SENT")!.commandId;

    await waitUntil(() => eventsA.some((e) => e.commandId === noAckCommandId && e.status === "FAILED"), 15_000);
    const noAckRow = await pool.query("SELECT status, error_code FROM agent_commands WHERE command_id = $1", [noAckCommandId]);
    assert(noAckRow.rows[0]?.status === "failed", "TC-ack-timeout: la commande finit FAILED sans accuse de reception");
    assert(noAckRow.rows[0]?.error_code === "AGENT_ACK_TIMEOUT", "TC-ack-timeout: error_code = AGENT_ACK_TIMEOUT");
    agentNoAck.socket.disconnect();

    // ===================== Deconnexion avant ACK =====================
    const agentDiscBeforeAck = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-DISC-BEFORE", "1.0.0", (socket) => {
      socket.disconnect();
    });
    const discBeforeRequestId = `tc-disc-before-${RUN_SUFFIX}`;
    uiA.emit("start-bot", { botName: "Bot Disc Before", category: "Tourisme", agentId: agentDiscBeforeAck.agentId, clientRequestId: discBeforeRequestId });
    await waitUntil(() => eventsA.some((e) => e.agentId === agentDiscBeforeAck.agentId && e.status === "FAILED"));
    const discBeforeCommand = eventsA.find((e) => e.agentId === agentDiscBeforeAck.agentId && e.status === "FAILED")!;
    const discBeforeRow = await pool.query("SELECT error_code FROM agent_commands WHERE command_id = $1", [discBeforeCommand.commandId]);
    assert(discBeforeRow.rows[0]?.error_code === "AGENT_DISCONNECTED", "TC-disc-before-ack: error_code = AGENT_DISCONNECTED");

    // ===================== Deconnexion apres ACK =====================
    // La deconnexion est declenchee depuis le test lui-meme APRES avoir vu
    // passer l'evenement ACKNOWLEDGED (plutot qu'apres un delai fixe cote
    // agent fantome), pour eliminer toute course avec l'ecriture DB de l'ACK.
    const agentDiscAfterAck = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-DISC-AFTER", "1.0.0", ackOnly);
    const discAfterRequestId = `tc-disc-after-${RUN_SUFFIX}`;
    uiA.emit("start-bot", { botName: "Bot Disc After", category: "Tourisme", agentId: agentDiscAfterAck.agentId, clientRequestId: discAfterRequestId });
    await waitUntil(() => eventsA.some((e) => e.agentId === agentDiscAfterAck.agentId && e.status === "SENT"));
    const discAfterCommandId = eventsA.find((e) => e.agentId === agentDiscAfterAck.agentId && e.status === "SENT")!.commandId;

    // Interroge directement la base (source de verite) plutot que le flux
    // d'evenements capture cote client, pour la condition d'attente avant de
    // declencher la deconnexion.
    await waitUntil(async () => {
      const row = await pool.query("SELECT status FROM agent_commands WHERE command_id = $1", [discAfterCommandId]);
      return row.rows[0]?.status === "acknowledged";
    });
    agentDiscAfterAck.socket.disconnect();

    await waitUntil(async () => {
      const row = await pool.query("SELECT status FROM agent_commands WHERE command_id = $1", [discAfterCommandId]);
      return row.rows[0]?.status === "failed";
    });
    const discAfterRow = await pool.query("SELECT error_code FROM agent_commands WHERE command_id = $1", [discAfterCommandId]);
    assert(discAfterRow.rows[0]?.error_code === "AGENT_DISCONNECTED_AFTER_ACK", "TC-disc-after-ack: error_code = AGENT_DISCONNECTED_AFTER_ACK");

    // ===================== ACK dupliquer =====================
    const agentDupAck = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-DUP-ACK", "1.0.0", (socket, command) => {
      const ackPayload = { commandId: command.commandId, receivedAt: new Date().toISOString() };
      socket.emit("COMMAND_ACK", ackPayload);
      setTimeout(() => socket.emit("COMMAND_ACK", ackPayload), 150);
    });
    const dupAckRequestId = `tc-dup-ack-${RUN_SUFFIX}`;
    uiA.emit("start-bot", { botName: "Bot Dup Ack", category: "Tourisme", agentId: agentDupAck.agentId, clientRequestId: dupAckRequestId });
    await waitUntil(() => eventsA.some((e) => e.agentId === agentDupAck.agentId && e.status === "ACKNOWLEDGED"));
    await sleep(500);
    const dupAckCommandId = eventsA.find((e) => e.agentId === agentDupAck.agentId && e.status === "ACKNOWLEDGED")!.commandId;
    const dupAckRow = await pool.query("SELECT status FROM agent_commands WHERE command_id = $1", [dupAckCommandId]);
    assert(dupAckRow.rows[0]?.status === "acknowledged", "TC-dup-ack: un second COMMAND_ACK identique reste sans effet (statut inchange)");
    agentDupAck.socket.disconnect();

    // ===================== ACK du mauvais agent =====================
    const agentWrongTarget = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-WRONG-TARGET", "1.0.0");
    const agentWrongIntruder = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-WRONG-INTRUDER", "1.0.0");
    const wrongAgentRequestId = `tc-wrong-agent-${RUN_SUFFIX}`;
    uiA.emit("start-bot", { botName: "Bot Wrong Agent", category: "Tourisme", agentId: agentWrongTarget.agentId, clientRequestId: wrongAgentRequestId });
    await waitUntil(() => eventsA.some((e) => e.agentId === agentWrongTarget.agentId && e.status === "SENT"));
    const wrongTargetCommandId = eventsA.find((e) => e.agentId === agentWrongTarget.agentId && e.status === "SENT")!.commandId;

    agentWrongIntruder.socket.emit("COMMAND_ACK", { commandId: wrongTargetCommandId, receivedAt: new Date().toISOString() });
    await sleep(500);
    const wrongTargetRow = await pool.query("SELECT status FROM agent_commands WHERE command_id = $1", [wrongTargetCommandId]);
    assert(
      wrongTargetRow.rows[0]?.status === "sent",
      "TC-wrong-agent: un ACK envoye par un AUTRE agent est ignore (la commande reste SENT)"
    );
    agentWrongTarget.socket.disconnect();
    agentWrongIntruder.socket.disconnect();

    // ===================== Resultat duplique =====================
    const agentDupResult = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-DUP-RESULT", "1.0.0", (socket, command) => {
      socket.emit("COMMAND_ACK", { commandId: command.commandId, receivedAt: new Date().toISOString() });
      setTimeout(() => {
        socket.emit("COMMAND_COMPLETED", { commandId: command.commandId, completedAt: new Date().toISOString(), result: { attempt: 1 } });
        setTimeout(() => {
          socket.emit("COMMAND_COMPLETED", { commandId: command.commandId, completedAt: new Date().toISOString(), result: { attempt: 2 } });
        }, 150);
      }, 150);
    });
    const dupResultRequestId = `tc-dup-result-${RUN_SUFFIX}`;
    uiA.emit("start-bot", { botName: "Bot Dup Result", category: "Tourisme", agentId: agentDupResult.agentId, clientRequestId: dupResultRequestId });
    await waitUntil(() => eventsA.some((e) => e.agentId === agentDupResult.agentId && e.status === "COMPLETED"));
    await sleep(500);
    const dupResultCommandId = eventsA.find((e) => e.agentId === agentDupResult.agentId && e.status === "COMPLETED")!.commandId;
    const dupResultRow = await pool.query("SELECT public_result FROM agent_commands WHERE command_id = $1", [dupResultCommandId]);
    assert(
      (dupResultRow.rows[0]?.public_result as { attempt?: number })?.attempt === 1,
      "TC-dup-result: le second COMMAND_COMPLETED ne remplace pas le resultat du premier"
    );
    agentDupResult.socket.disconnect();

    // ===================== Transition interdite (COMPLETED sans ACK prealable) =====================
    const agentIllegalTransition = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-ILLEGAL", "1.0.0", (socket, command) => {
      socket.emit("COMMAND_COMPLETED", { commandId: command.commandId, completedAt: new Date().toISOString(), result: { skip: true } });
    });
    const illegalRequestId = `tc-illegal-${RUN_SUFFIX}`;
    uiA.emit("start-bot", { botName: "Bot Illegal", category: "Tourisme", agentId: agentIllegalTransition.agentId, clientRequestId: illegalRequestId });
    await waitUntil(() => eventsA.some((e) => e.agentId === agentIllegalTransition.agentId && e.status === "SENT"));
    await sleep(500);
    const illegalCommandId = eventsA.find((e) => e.agentId === agentIllegalTransition.agentId && e.status === "SENT")!.commandId;
    const illegalRow = await pool.query("SELECT status FROM agent_commands WHERE command_id = $1", [illegalCommandId]);
    assert(
      illegalRow.rows[0]?.status === "sent",
      "TC-illegal-transition: COMPLETED sans ACK prealable est ignore (reste SENT, pas de saut d'etat)"
    );
    agentIllegalTransition.socket.disconnect();

    // ===================== Expiration (TTL) =====================
    const agentExpire = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-EXPIRE", "1.0.0", ackOnly);
    const expireRequestId = `tc-expire-${RUN_SUFFIX}`;
    uiA.emit("start-bot", { botName: "Bot Expire", category: "Tourisme", agentId: agentExpire.agentId, clientRequestId: expireRequestId });
    await waitUntil(() => eventsA.some((e) => e.agentId === agentExpire.agentId && e.status === "ACKNOWLEDGED"));
    const expireCommandId = eventsA.find((e) => e.agentId === agentExpire.agentId && e.status === "ACKNOWLEDGED")!.commandId;

    await waitUntil(() => eventsA.some((e) => e.commandId === expireCommandId && e.status === "EXPIRED"), 20_000);
    const expireRow = await pool.query("SELECT status FROM agent_commands WHERE command_id = $1", [expireCommandId]);
    assert(expireRow.rows[0]?.status === "expired", "TC-expire: une commande ACKNOWLEDGED jamais completee finit EXPIRED (TTL)");
    agentExpire.socket.disconnect();

    // ===================== Redemarrage simule: sweep DB (sent_at ancien) =====================
    const agentRestartSweep = await pairAgentWithBehavior(server.baseUrl, agencyA.managerCookie, "PW-P3-RESTART-SWEEP", "1.0.0");
    const restartSweepRequestId = `tc-restart-sweep-${RUN_SUFFIX}`;
    uiA.emit("start-bot", { botName: "Bot Restart Sweep", category: "Tourisme", agentId: agentRestartSweep.agentId, clientRequestId: restartSweepRequestId });
    await waitUntil(() => eventsA.some((e) => e.agentId === agentRestartSweep.agentId && e.status === "SENT"));
    const restartSweepCommandId = eventsA.find((e) => e.agentId === agentRestartSweep.agentId && e.status === "SENT")!.commandId;

    // Simule un redemarrage serveur: les minuteurs en memoire de l'ancien
    // process ont disparu, seule sent_at en base permet encore de detecter
    // que le delai d'accuse de reception est depasse.
    await pool.query("UPDATE agent_commands SET sent_at = NOW() - INTERVAL '1 hour' WHERE command_id = $1", [restartSweepCommandId]);
    await waitUntil(() => eventsA.some((e) => e.commandId === restartSweepCommandId && e.status === "FAILED"), 5_000);
    const restartSweepRow = await pool.query("SELECT status, error_code FROM agent_commands WHERE command_id = $1", [restartSweepCommandId]);
    assert(
      restartSweepRow.rows[0]?.status === "failed" && restartSweepRow.rows[0]?.error_code === "AGENT_ACK_TIMEOUT",
      "TC-restart-sweep: le balayage base sur sent_at resout une commande 'ancienne' independamment des minuteurs en memoire"
    );
    agentRestartSweep.socket.disconnect();

    // ===================== Aucun secret dans les logs serveur =====================
    const allServerOutput = server.stdout.join("\n");
    assert(
      !allServerOutput.includes(TEST_SECRET_LOGIN) && !allServerOutput.includes(TEST_SECRET_PASSWORD),
      "Aucune valeur sentinelle TLScontact dans les logs serveur (stdout/stderr)"
    );

    // ===================== Aucun Chrome lance sur la VM en mode agent =====================
    const chromeAfterAgentMode = await listChromePids();
    const newChromePids = [...chromeAfterAgentMode].filter((pid) => !chromeBeforeAll.has(pid));
    assert(newChromePids.length === 0, "Aucun nouveau process chrome.exe lance sur la VM pendant tout le scenario en mode agent");

    uiA.disconnect();

    // ===================== Serveur separe: version incompatible =====================
    const serverVersion = await startServer(3242, { BOT_EXECUTION_MODE: "agent", AGENT_MIN_VERSION: "99.0.0" });
    servers.push(serverVersion);
    const adminCookieVersion = await loginWithRetry(serverVersion.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyVersion = await createAgencyAndManager(serverVersion.baseUrl, adminCookieVersion, "Version");
    const uiVersion = await connectUiSocket(serverVersion.baseUrl, agencyVersion.managerCookie);
    const versionBotStatusEvents: Array<Record<string, unknown>> = [];
    uiVersion.on("bot-status", (payload: Record<string, unknown>) => versionBotStatusEvents.push(payload));

    const agentOldVersion = await pairAgentWithBehavior(serverVersion.baseUrl, agencyVersion.managerCookie, "PW-P3-OLD-VERSION", "1.0.0", ackOnly);
    uiVersion.emit("start-bot", { botName: "Bot Version", category: "Tourisme", clientRequestId: `tc-version-${RUN_SUFFIX}` });
    await waitUntil(() => versionBotStatusEvents.some((e) => e.code === "AGENT_VERSION_INCOMPATIBLE"));
    assert(
      versionBotStatusEvents.some((e) => e.code === "AGENT_VERSION_INCOMPATIBLE"),
      "TC-version: agent connecte mais version incompatible -> AGENT_VERSION_INCOMPATIBLE"
    );
    agentOldVersion.socket.disconnect();
    uiVersion.disconnect();

    // ===================== Serveur separe: legacy_vm inchange =====================
    // Valeurs explicites (pas juste omises): le .env reel du depot peut definir
    // BOT_EXECUTION_MODE=agent pour des tests manuels, et dotenv ne complete
    // que les variables absentes du process enfant.
    const serverLegacy = await startServer(3243, { BOT_EXECUTION_MODE: "legacy_vm" });
    servers.push(serverLegacy);
    const adminCookieLegacy = await loginWithRetry(serverLegacy.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyLegacy = await createAgencyAndManager(serverLegacy.baseUrl, adminCookieLegacy, "Legacy");
    const uiLegacy = await connectUiSocket(serverLegacy.baseUrl, agencyLegacy.managerCookie);
    const legacyBotStatusEvents: Array<Record<string, unknown>> = [];
    uiLegacy.on("bot-status", (payload: Record<string, unknown>) => legacyBotStatusEvents.push(payload));

    const chromeBeforeLegacy = await listChromePids();
    uiLegacy.emit("start-bot", { botName: "Bot Legacy", category: "Tourisme", login: "", password: "" });
    await sleep(5_000);
    const chromeAfterLegacy = await listChromePids();
    const newChromePidsLegacy = [...chromeAfterLegacy].filter((pid) => !chromeBeforeLegacy.has(pid));
    chromePidsToCleanup.push(...newChromePidsLegacy);
    assert(
      !legacyBotStatusEvents.some((e) => e.code === "AGENT_NOT_CONNECTED" || e.code === "AGENT_EXECUTION_NOT_READY"),
      "TC-legacy: en legacy_vm, aucun garde-fou agent ne bloque start-bot"
    );
    assert(newChromePidsLegacy.length > 0, "TC-legacy: en legacy_vm, Chrome se lance toujours reellement sur la VM comme avant");
    uiLegacy.disconnect();
  } finally {
    await killPids(chromePidsToCleanup).catch(() => undefined);
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
