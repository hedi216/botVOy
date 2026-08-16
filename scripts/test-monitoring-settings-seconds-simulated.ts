// HOTFIX CIBLE - Parametres de surveillance en secondes entieres.
//
// Tous les parametres TEMPORELS de l'interface (delai mois, pause cycles,
// refresh de controle, cooldown rate limit) sont desormais exprimes en
// SECONDES ENTIERES cote UI/API publique - jamais de ms/minutes/fractions de
// minute cote utilisateur, jamais de "X cycles". Contrat interne (ms pour
// mois/cycles, secondes natives pour refresh/rate-limit) inchange, converti
// UNIQUEMENT a la frontiere API publique (userService.ts:
// toPublicMonitoringSettings/fromPublicMonitoringSettingsPatch).
//
// Teste UNIQUEMENT la logique de ce hotfix: lecture/ecriture API en
// secondes, planchers de securite alignes UI/serveur/Agent (rejet HTTP 400
// clair, jamais un clamp silencieux), refresh de controle desormais
// configurable par agence (remplace la constante de production
// AGENT_CONTROL_REFRESH_INTERVAL_MS=20min), rate-limit avec une vraie
// precision a la seconde (jamais tronque en minutes), migration non
// destructive de l'ancienne colonne rate_limit_cooldown_minutes, snapshot
// immuable au demarrage du bot, retrocompatibilite legacy_vm/ancien payload.
//
// Usage: npx tsx scripts/test-monitoring-settings-seconds-simulated.ts

import { ChildProcess, spawn } from "node:child_process";
import { Socket, io as ioClient } from "socket.io-client";
import { ADMIN_LOGIN, ADMIN_PASSWORD, ensureSchema, pool } from "../src/db.js";
import { getAgencyMonitoringSettings } from "../src/userService.js";
import { DEFAULT_AGENT_MONITORING_SETTINGS, toAppConfig, validateMonitoringSettings } from "../src/agent/agentMonitoringSettings.js";

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

// ===================== Partie A: unites pures (aucun serveur, aucun Chrome) =====================

const runPureUnitTests = async (): Promise<void> => {
  log("UNIT", "=== TEST G (precision): rateLimitCooldownSeconds -> rateLimitCooldownMinutes, jamais tronque ===");
  const preciseSettings = { ...DEFAULT_AGENT_MONITORING_SETTINGS, rateLimitCooldownSeconds: 90 };
  const preciseConfig = toAppConfig(preciseSettings, "https://example.test/", 1_200_000);
  assert(preciseConfig.rateLimitCooldownMinutes === 1.5, `G) 90 secondes -> exactement 1.5 minute, jamais 1 ni 2 (recu: ${preciseConfig.rateLimitCooldownMinutes})`);

  const thirtySecondsConfig = toAppConfig({ ...DEFAULT_AGENT_MONITORING_SETTINGS, rateLimitCooldownSeconds: 30 }, "https://example.test/", 1_200_000);
  assert(thirtySecondsConfig.rateLimitCooldownMinutes === 0.5, `G) 30 secondes -> exactement 0.5 minute, jamais 0 ni 1 (recu: ${thirtySecondsConfig.rateLimitCooldownMinutes})`);

  log("UNIT", "=== TEST L: fallback ancien payload (champs absents ou ancien format minutes) ===");
  const missingFields = validateMonitoringSettings(undefined);
  assert(missingFields.controlRefreshIntervalSeconds === 1_200, `L) Payload absent -> controlRefreshIntervalSeconds retombe sur le defaut 1200s (recu: ${missingFields.controlRefreshIntervalSeconds})`);
  assert(missingFields.rateLimitCooldownSeconds === 2_700, `L) Payload absent -> rateLimitCooldownSeconds retombe sur le defaut 2700s (recu: ${missingFields.rateLimitCooldownSeconds})`);

  const oldStylePayload = validateMonitoringSettings({ rateLimitCooldownMinutes: 45 });
  assert(oldStylePayload.rateLimitCooldownSeconds === 2_700, `L) Ancien payload (rateLimitCooldownMinutes seul, sans rateLimitCooldownSeconds) -> converti exactement en secondes (recu: ${oldStylePayload.rateLimitCooldownSeconds})`);
  assert(oldStylePayload.controlRefreshIntervalSeconds === 1_200, "L) Ancien payload sans controlRefreshIntervalSeconds -> defaut de compatibilite, aucun crash");

  log("UNIT", "=== TEST K: retrocompatibilite legacy_vm (sessionManager.ts spread direct dans AppConfig) ===");
  const defaultSettings = await getAgencyMonitoringSettings(null);
  const legacyBaseAppConfig = {
    targetUrl: "https://example.test/", connectToExistingChrome: false, chromeDebugUrl: "", refreshIntervalMs: 1_000,
    headless: true, slowMoMs: 0, debugKeepBrowserOpen: false, maxRefreshAttempts: 0, scanMonthCount: 0
  };
  // Reproduit EXACTEMENT le spread de sessionManager.ts (BotSession.start()):
  // const config: AppConfig = { ...loadConfig(), ...this.monitoringSettings, ... };
  const spreadConfig = { ...legacyBaseAppConfig, ...defaultSettings } as Record<string, unknown>;
  assert(spreadConfig.refreshEveryCycles === defaultSettings.refreshEveryCycles, "K) legacy_vm recoit toujours refreshEveryCycles depuis MonitoringSettings, inchange");
  assert(typeof spreadConfig.rateLimitCooldownMinutes === "number", "K) legacy_vm recoit toujours rateLimitCooldownMinutes (nombre), jamais undefined apres le spread");
  assert(
    spreadConfig.controlRefreshIntervalMs === undefined,
    "K) controlRefreshIntervalSeconds (agent uniquement) ne bascule JAMAIS accidentellement legacy_vm vers le refresh temporel (AppConfig.controlRefreshIntervalMs reste absent apres le spread)"
  );
};

// ===================== Partie B: migration DB (aucun serveur, ensureSchema() direct) =====================

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

const runMigrationTest = async (): Promise<void> => {
  log("UNIT", "=== TEST H: migration ancien rate limit (45 min -> 2700s), idempotente, aucune perte ===");

  // Garantit que les colonnes existent deja (etat "deploiement precedent
  // deja effectue"), sans quoi l'INSERT/SELECT ci-dessous echouerait sur une
  // base totalement vierge de ce hotfix.
  await ensureSchema();

  const name = `Test Settings Seconds Migration ${RUN_SUFFIX}`;
  createdAgencyNames.push(name);
  // Simule une agence deja presente AVANT ce hotfix, avec un cooldown DEJA
  // personnalise (30 min, jamais le defaut 45) - jamais via createAgency()
  // (qui poserait deja les nouvelles colonnes): INSERT direct minimal,
  // rate_limit_cooldown_seconds reste donc a SON PROPRE defaut de colonne
  // (2700), exactement l'etat d'une agence reelle au moment du deploiement
  // (colonne ajoutee, mais pas encore alignee sur les 30 min personnalisees).
  const inserted = await pool.query<{ id: number }>(
    "INSERT INTO agencies (name, rate_limit_cooldown_minutes) VALUES ($1, 30) RETURNING id",
    [name]
  );
  const agencyId = inserted.rows[0].id;

  const beforeMigration = await pool.query<{ rate_limit_cooldown_seconds: number }>(
    "SELECT rate_limit_cooldown_seconds FROM agencies WHERE id = $1", [agencyId]
  );
  assert(beforeMigration.rows[0].rate_limit_cooldown_seconds === 2_700, "H) Avant le premier passage du backfill: rate_limit_cooldown_seconds au defaut de colonne (2700), pas encore aligne sur les 30 min personnalisees");

  await ensureSchema();

  const afterMigration = await pool.query<{ rate_limit_cooldown_seconds: number; rate_limit_cooldown_minutes: number }>(
    "SELECT rate_limit_cooldown_seconds, rate_limit_cooldown_minutes FROM agencies WHERE id = $1", [agencyId]
  );
  assert(afterMigration.rows[0].rate_limit_cooldown_seconds === 1_800, `H) Apres backfill: 30 min personnalisees -> exactement 1800 secondes, aucune perte (recu: ${afterMigration.rows[0].rate_limit_cooldown_seconds})`);
  assert(afterMigration.rows[0].rate_limit_cooldown_minutes === 30, "H) La colonne minutes d'origine reste intacte (jamais ecrasee, gelee pour compatibilite de schema)");

  // Un redemarrage serveur ULTERIEUR (nouveau passage d'ensureSchema()) ne
  // doit JAMAIS ecraser une valeur en secondes deja alignee/ajustee depuis.
  await pool.query("UPDATE agencies SET rate_limit_cooldown_seconds = 999 WHERE id = $1", [agencyId]);
  await ensureSchema();
  const afterSecondBoot = await pool.query<{ rate_limit_cooldown_seconds: number }>(
    "SELECT rate_limit_cooldown_seconds FROM agencies WHERE id = $1", [agencyId]
  );
  assert(afterSecondBoot.rows[0].rate_limit_cooldown_seconds === 999, "H) Un redemarrage serveur ULTERIEUR ne re-ecrase PAS une valeur en secondes deja personnalisee depuis (backfill non re-declenchable)");
};

// ===================== Serveur reel (Parties C/D: API HTTP + agents fantomes) =====================

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

const createAgencyAndManager = async (baseUrl: string, adminCookie: string, label: string): Promise<{ agencyId: number; managerCookie: string }> => {
  const agencyName = `Test Settings Seconds ${label} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;

  const managerLogin = `test-settings-sec-mgr-${label.toLowerCase()}-${RUN_SUFFIX}`;
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

// START_BOT est declenche via l'evenement socket.io "start-bot" (namespace
// principal, authentifie par cookie de session) - il n'existe PAS de route
// HTTP POST dediee (meme convention que test-agent-archive-simulated.ts:
// TEST C, uiSocket.emit("start-bot", ...)).
const openUiSocket = (baseUrl: string, cookie: string): Promise<Socket> => new Promise((resolve, reject) => {
  const socket = ioClient(baseUrl, { autoConnect: false, reconnection: false, forceNew: true, extraHeaders: { Cookie: cookie } });
  const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion socket UI.")); }, 8_000);
  socket.on("connect", () => { clearTimeout(t); resolve(socket); });
  socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
  socket.connect();
});

const startBotAndCaptureSnapshot = async (
  baseUrl: string,
  managerCookie: string,
  agent: FakeAgentHandle,
  botName: string
): Promise<Record<string, unknown>> => {
  const commandsSeen: Array<Record<string, unknown>> = [];
  const onCommand = (command: Record<string, unknown>): void => { commandsSeen.push(command); };
  agent.socket.on("AGENT_COMMAND", onCommand);

  // selectAgentForCommand() (server.ts) exige un snapshot d'inventaire deja
  // recu (getSnapshotForAgent) avant de considerer l'agent eligible - meme
  // convention que test-agent-archive-simulated.ts (TEST C).
  agent.socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
  await sleep(300);

  const uiSocket = await openUiSocket(baseUrl, managerCookie);
  try {
    uiSocket.emit("start-bot", {
      botName, category: "", login: "x", password: "y",
      agentId: agent.agentId, clientRequestId: `settings-seconds-${botName}-${RUN_SUFFIX}`
    });

    await waitUntilAsync(() => commandsSeen.some((c) => c.type === "START_BOT"), 8_000);
    agent.socket.off("AGENT_COMMAND", onCommand);
    const startCommand = commandsSeen.find((c) => c.type === "START_BOT");
    if (!startCommand) throw new Error("START_BOT jamais recu par l'agent fantome.");

    const payload = startCommand.payload as { monitoringSettings?: Record<string, unknown> } | undefined;
    const settings = payload?.monitoringSettings;
    if (!settings) throw new Error("START_BOT.payload.monitoringSettings absent.");

    // Accuse reception + termine proprement pour ne pas laisser de commande
    // pendante entre deux tests (meme convention que test-agent-archive-simulated.ts).
    agent.socket.emit("COMMAND_ACK", { commandId: startCommand.commandId, receivedAt: new Date().toISOString() });
    agent.socket.emit("BOT_STATUS", { commandId: startCommand.commandId, botId: startCommand.botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
    agent.socket.emit("COMMAND_COMPLETED", { commandId: startCommand.commandId, completedAt: new Date().toISOString(), result: { botId: startCommand.botId, status: "WAITING_FOR_USER", started: true } });

    return settings;
  } finally {
    uiSocket.disconnect();
  }
};

const dbAgencyRow = async (agencyId: number): Promise<{ month_click_min_delay_ms: number; month_click_max_delay_ms: number; bot_cycle_cooldown_min_ms: number; bot_cycle_cooldown_max_ms: number; control_refresh_interval_seconds: number; rate_limit_cooldown_seconds: number }> => {
  const result = await pool.query(
    "SELECT month_click_min_delay_ms, month_click_max_delay_ms, bot_cycle_cooldown_min_ms, bot_cycle_cooldown_max_ms, control_refresh_interval_seconds, rate_limit_cooldown_seconds FROM agencies WHERE id = $1",
    [agencyId]
  );
  return result.rows[0];
};

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  if (createdAgencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
};

// ===================== TEST A: lecture API en secondes =====================

const runTestA = async (baseUrl: string): Promise<void> => {
  log("TEST-A", "=== Lecture API: DB en ms/secondes internes -> reponse GET explicitement en secondes ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const { agencyId, managerCookie } = await createAgencyAndManager(baseUrl, admin, "A");
  void agencyId;

  const result = await requestJson(baseUrl, "GET", "/api/monitoring-settings", managerCookie);
  assert(result.status === 200, `A) GET /api/monitoring-settings reussit (recu: ${result.status})`);
  const settings = result.body as Record<string, unknown> & { settings?: Record<string, unknown> };
  const s = (settings.settings ?? {}) as Record<string, unknown>;

  assert(s.monthClickMinDelaySeconds === 5, `A) monthClickMinDelaySeconds = 5 (defaut, recu: ${s.monthClickMinDelaySeconds})`);
  assert(s.monthClickMaxDelaySeconds === 10, `A) monthClickMaxDelaySeconds = 10 (defaut, recu: ${s.monthClickMaxDelaySeconds})`);
  assert(s.botCycleCooldownMinSeconds === 120, `A) botCycleCooldownMinSeconds = 120 (defaut, recu: ${s.botCycleCooldownMinSeconds})`);
  assert(s.botCycleCooldownMaxSeconds === 240, `A) botCycleCooldownMaxSeconds = 240 (defaut, recu: ${s.botCycleCooldownMaxSeconds})`);
  assert(s.controlRefreshIntervalSeconds === 1_200, `A) controlRefreshIntervalSeconds = 1200 (defaut, recu: ${s.controlRefreshIntervalSeconds})`);
  assert(s.rateLimitCooldownSeconds === 2_700, `A) rateLimitCooldownSeconds = 2700 (defaut, recu: ${s.rateLimitCooldownSeconds})`);
  assert(!("monthClickMinDelayMs" in s) && !("rateLimitCooldownMinutes" in s) && !("refreshEveryCycles" in s), "A) Aucun nom Ms/Minutes/cycles dans le contrat public (contrat propre)");
};

// ===================== TEST B: ecriture API en secondes =====================

const runTestB = async (baseUrl: string): Promise<void> => {
  log("TEST-B", "=== Ecriture API: PATCH en secondes -> mapping interne ms correct ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const { agencyId, managerCookie } = await createAgencyAndManager(baseUrl, admin, "B");

  const patch = await requestJson(baseUrl, "PATCH", "/api/monitoring-settings", managerCookie, {
    botCycleCooldownMinSeconds: 30, botCycleCooldownMaxSeconds: 45
  });
  assert(patch.status === 200, `B) PATCH reussit (recu: ${patch.status}: ${JSON.stringify(patch.body)})`);

  const row = await dbAgencyRow(agencyId);
  assert(row.bot_cycle_cooldown_min_ms === 30_000, `B) DB bot_cycle_cooldown_min_ms = 30000 (recu: ${row.bot_cycle_cooldown_min_ms})`);
  assert(row.bot_cycle_cooldown_max_ms === 45_000, `B) DB bot_cycle_cooldown_max_ms = 45000 (recu: ${row.bot_cycle_cooldown_max_ms})`);
};

// ===================== TEST C: 30 secondes jamais interprete comme 30 minutes =====================

const runTestC = async (baseUrl: string): Promise<void> => {
  log("TEST-C", "=== 30 secondes n'est jamais interprete comme 30 minutes ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const { agencyId, managerCookie } = await createAgencyAndManager(baseUrl, admin, "C");

  const patch = await requestJson(baseUrl, "PATCH", "/api/monitoring-settings", managerCookie, { monthClickMinDelaySeconds: 30, monthClickMaxDelaySeconds: 40 });
  assert(patch.status === 200, `C) PATCH reussit (recu: ${patch.status})`);

  const row = await dbAgencyRow(agencyId);
  assert(row.month_click_min_delay_ms === 30_000, `C) 30 secondes -> exactement 30000ms, jamais 1800000ms (30 min) (recu: ${row.month_click_min_delay_ms})`);
};

// ===================== TEST D: plancher de securite cycle (rejet clair, pas de clamp silencieux) =====================

const runTestD = async (baseUrl: string): Promise<void> => {
  log("TEST-D", "=== Plancher de securite cycle: 2s refuse clairement, 5s accepte ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const { agencyId, managerCookie } = await createAgencyAndManager(baseUrl, admin, "D");

  const before = await dbAgencyRow(agencyId);

  const refused = await requestJson(baseUrl, "PATCH", "/api/monitoring-settings", managerCookie, { botCycleCooldownMinSeconds: 2, botCycleCooldownMaxSeconds: 10 });
  assert(refused.status === 400, `D) 2 secondes refuse clairement (HTTP 400, recu: ${refused.status}: ${JSON.stringify(refused.body)})`);
  const afterRefusal = await dbAgencyRow(agencyId);
  assert(afterRefusal.bot_cycle_cooldown_min_ms === before.bot_cycle_cooldown_min_ms, "D) Aucun clamp silencieux: la valeur DB reste inchangee apres un refus (jamais 2 accepte puis remonte a 5 sans le dire)");

  const accepted = await requestJson(baseUrl, "PATCH", "/api/monitoring-settings", managerCookie, { botCycleCooldownMinSeconds: 5, botCycleCooldownMaxSeconds: 10 });
  assert(accepted.status === 200, `D) 5 secondes (le plancher exact) accepte (recu: ${accepted.status})`);
  const afterAccept = await dbAgencyRow(agencyId);
  assert(afterAccept.bot_cycle_cooldown_min_ms === 5_000, `D) DB reflete bien 5000ms (recu: ${afterAccept.bot_cycle_cooldown_min_ms})`);
};

// ===================== TEST E/F: refresh de controle configurable + independance des agences =====================

const runTestEF = async (baseUrl: string): Promise<void> => {
  log("TEST-EF", "=== Refresh de controle configurable par agence -> chaque bot recoit SA propre valeur (jamais la constante 20 min, jamais celle d'une autre agence) ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const a = await createAgencyAndManager(baseUrl, admin, "EF-A");
  const b = await createAgencyAndManager(baseUrl, admin, "EF-B");

  const patchA = await requestJson(baseUrl, "PATCH", "/api/monitoring-settings", a.managerCookie, { controlRefreshIntervalSeconds: 600 });
  assert(patchA.status === 200, `EF) Agence A configuree a 600s (recu: ${patchA.status})`);
  const patchB = await requestJson(baseUrl, "PATCH", "/api/monitoring-settings", b.managerCookie, { controlRefreshIntervalSeconds: 1_800 });
  assert(patchB.status === 200, `EF) Agence B configuree a 1800s (recu: ${patchB.status})`);

  const agentA = await pairFakeAgent(baseUrl, a.managerCookie, `PW-SETTINGS-SEC-EF-A-${RUN_SUFFIX}`);
  const agentB = await pairFakeAgent(baseUrl, b.managerCookie, `PW-SETTINGS-SEC-EF-B-${RUN_SUFFIX}`);

  const snapshotA = await startBotAndCaptureSnapshot(baseUrl, a.managerCookie, agentA, `Bot EF A ${RUN_SUFFIX}`);
  const snapshotB = await startBotAndCaptureSnapshot(baseUrl, b.managerCookie, agentB, `Bot EF B ${RUN_SUFFIX}`);

  assert(snapshotA.controlRefreshIntervalSeconds === 600, `E) Le snapshot START_BOT de l'agence A transporte bien SA valeur configuree (600s), jamais la constante 20 min = 1200s (recu: ${snapshotA.controlRefreshIntervalSeconds})`);
  assert(snapshotB.controlRefreshIntervalSeconds === 1_800, `F) Le snapshot START_BOT de l'agence B transporte bien SA PROPRE valeur (1800s), independante et differente de celle de A (recu: ${snapshotB.controlRefreshIntervalSeconds})`);

  agentA.socket.disconnect();
  agentB.socket.disconnect();
};

// ===================== TEST I: snapshot immuable pour un bot deja actif =====================

const runTestI = async (baseUrl: string): Promise<void> => {
  log("TEST-I", "=== Bot A demarre avec cycle 30-45s, agence ensuite modifiee en 60-90s -> Bot A garde 30-45s, nouveau Bot B recoit 60-90s ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const { managerCookie } = await createAgencyAndManager(baseUrl, admin, "I");

  const initial = await requestJson(baseUrl, "PATCH", "/api/monitoring-settings", managerCookie, { botCycleCooldownMinSeconds: 30, botCycleCooldownMaxSeconds: 45 });
  assert(initial.status === 200, `I) Configuration initiale (30-45s) acceptee (recu: ${initial.status})`);

  const agentA = await pairFakeAgent(baseUrl, managerCookie, `PW-SETTINGS-SEC-I-A-${RUN_SUFFIX}`);
  const snapshotA = await startBotAndCaptureSnapshot(baseUrl, managerCookie, agentA, `Bot I A ${RUN_SUFFIX}`);
  assert(snapshotA.botCycleCooldownMinMs === 30_000 && snapshotA.botCycleCooldownMaxMs === 45_000, `I) Bot A demarre bien avec 30000-45000ms (recu: ${snapshotA.botCycleCooldownMinMs}-${snapshotA.botCycleCooldownMaxMs})`);

  const updated = await requestJson(baseUrl, "PATCH", "/api/monitoring-settings", managerCookie, { botCycleCooldownMinSeconds: 60, botCycleCooldownMaxSeconds: 90 });
  assert(updated.status === 200, `I) Agence modifiee en 60-90s (recu: ${updated.status})`);

  // Bot A deja actif: son snapshot deja transmis reste 30-45s (pas de
  // UPDATE_SETTINGS live dans ce hotfix) - verifie que la commande START_BOT
  // deja envoyee, relue depuis l'historique, n'a pas ete modifiee retroactivement.
  const historyA = await requestJson(baseUrl, "GET", "/api/agent-commands?limit=20", managerCookie);
  const commandsA = (historyA.body as { commands?: Array<{ botName?: string; publicPayload?: { monitoringSettings?: Record<string, unknown> } }> }).commands ?? [];
  const startCommandA = commandsA.find((c) => c.botName === `Bot I A ${RUN_SUFFIX}`);
  const historicalMinMs = (startCommandA?.publicPayload?.monitoringSettings as { botCycleCooldownMinMs?: number } | undefined)?.botCycleCooldownMinMs;
  assert(
    historicalMinMs === 30_000,
    `I) L'historique de la commande START_BOT de Bot A reste figee a 30000ms, jamais retroactivement modifiee (recu: ${historicalMinMs})`
  );

  const agentB = await pairFakeAgent(baseUrl, managerCookie, `PW-SETTINGS-SEC-I-B-${RUN_SUFFIX}`);
  const snapshotB = await startBotAndCaptureSnapshot(baseUrl, managerCookie, agentB, `Bot I B ${RUN_SUFFIX}`);
  assert(snapshotB.botCycleCooldownMinMs === 60_000 && snapshotB.botCycleCooldownMaxMs === 90_000, `I) Nouveau Bot B recoit bien 60000-90000ms (recu: ${snapshotB.botCycleCooldownMinMs}-${snapshotB.botCycleCooldownMaxMs})`);

  agentA.socket.disconnect();
  agentB.socket.disconnect();
};

// ===================== TEST J: min/max invalides refuses clairement =====================

const runTestJ = async (baseUrl: string): Promise<void> => {
  log("TEST-J", "=== min > max refuse clairement (HTTP 400), jamais permute silencieusement ===");
  const admin = await loginWithRetry(baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
  const { agencyId, managerCookie } = await createAgencyAndManager(baseUrl, admin, "J");
  const before = await dbAgencyRow(agencyId);

  const monthInverted = await requestJson(baseUrl, "PATCH", "/api/monitoring-settings", managerCookie, { monthClickMinDelaySeconds: 60, monthClickMaxDelaySeconds: 30 });
  assert(monthInverted.status === 400, `J) Delai mois min=60 > max=30 refuse (recu: ${monthInverted.status})`);

  const cycleInverted = await requestJson(baseUrl, "PATCH", "/api/monitoring-settings", managerCookie, { botCycleCooldownMinSeconds: 90, botCycleCooldownMaxSeconds: 60 });
  assert(cycleInverted.status === 400, `J) Pause cycles min=90 > max=60 refusee (recu: ${cycleInverted.status})`);

  const after = await dbAgencyRow(agencyId);
  assert(
    after.month_click_min_delay_ms === before.month_click_min_delay_ms && after.bot_cycle_cooldown_min_ms === before.bot_cycle_cooldown_min_ms,
    "J) Aucune valeur DB modifiee par une requete refusee (jamais de permutation silencieuse min/max)"
  );
};

// ===================== main =====================

const run = async (): Promise<void> => {
  let server: ServerHandle | undefined;
  try {
    await runPureUnitTests();
    await runMigrationTest();

    server = await startServer(3405);

    await runTestA(server.baseUrl);
    await runTestB(server.baseUrl);
    await runTestC(server.baseUrl);
    await runTestD(server.baseUrl);
    await runTestEF(server.baseUrl);
    await runTestI(server.baseUrl);
    await runTestJ(server.baseUrl);
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
