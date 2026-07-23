// Lot 6 (section 7): tests de securite FINAUX, complementaires aux
// verifications deja couvertes par les tests simules des Lots 2 a 5 (deja
// inclus dans npm run test:phase4:final:simulated):
//   - controle cross-agence, agent revoque, bot STOPPED non reactive,
//     eventId rejoue: deja verifies par test-agent-validate-simulated.ts /
//     test-agent-monitoring-simulated.ts / test-agent-resilience-simulated.ts.
//   - path traversal dans botId (profil local): deja verifie par
//     scripts/test-agent-phase4-lot2.ts (botId="../../evil").
//
// Ce script se concentre sur ce qui n'est PAS deja couvert ailleurs:
//   - nouvelles sentinelles (TEST_SECRET_AUTHORIZATION/PROFILE_PATH/
//     DEBUG_PORT) balayees a travers un cycle complet START_BOT ->
//     VALIDATE_BOT -> MONITORING -> SLOT_DETECTED -> STOP_BOT ;
//   - path traversal dans un chemin d'extension locale ;
//   - manifest d'extension malforme (JSON invalide) ;
//   - payload/JSON malforme ou absent envoye aux routes REST ;
//   - payload excessivement grand envoye via un evenement Socket.IO ;
//   - statut de bot inconnu envoye par un agent fantome ;
//   - evenement Socket.IO inconnu envoye par un agent fantome ;
//   - IDs invalides (non numeriques, inexistants) dans les routes REST.
//
// Ce script NE LANCE JAMAIS src/agent/agentMain.ts ET NE LANCE JAMAIS
// Chrome: agent fantome (socket.io-client brut). Le seul navigateur est
// le Chromium headless de Playwright pilotant l'INTERFACE WEB.
//
// Usage: npx tsx scripts/test-agent-security-simulated.ts
//    ou: npm run test:agent:security:simulated

import { ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Socket, io as ioClient } from "socket.io-client";
import { pool } from "../src/db.js";
import { validateExtensions, loadExtensionConfig } from "../src/agent/agentExtensionConfig.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();

const SENTINELS = {
  password: "TEST_SECRET_PASSWORD",
  cookie: "TEST_SECRET_COOKIE",
  token: "TEST_SECRET_TOKEN",
  apiKey: "TEST_SECRET_API_KEY",
  authorization: "TEST_SECRET_AUTHORIZATION",
  profilePath: "TEST_SECRET_PROFILE_PATH",
  debugPort: "TEST_SECRET_DEBUG_PORT"
};
const ALL_SENTINELS = Object.values(SENTINELS);

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000, intervalMs = 150): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};

type ServerHandle = { child: ChildProcess; baseUrl: string; stdout: string[] };
const runningServers: ServerHandle[] = [];

const waitForServerReady = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`${baseUrl}/api/me`); if (res.status === 401 || res.status === 200) return; } catch { /* pas encore pret */ }
    await sleep(500);
  }
  throw new Error("Le serveur de test n'a jamais repondu.");
};

const startServer = async (port: number, env: Record<string, string>): Promise<ServerHandle> => {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(command, ["tsx", "src/server.ts"], {
    env: { ...process.env, WEB_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  const stdout: string[] = [];
  child.stdout?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("SERVER", t.trim()); });
  child.stderr?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("SERVER-ERR", t.trim()); });
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  const handle = { child, baseUrl, stdout };
  runningServers.push(handle);
  return handle;
};

const killTree = (pid: number | undefined): Promise<void> => new Promise((resolve) => {
  if (!pid) { resolve(); return; }
  if (process.platform === "win32") {
    const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
    k.once("exit", () => resolve());
    k.once("error", () => resolve());
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* deja mort */ }
  resolve();
});

const requestJson = async (baseUrl: string, method: string, pathName: string, cookie: string | undefined, body?: unknown, rawBody?: string): Promise<any> => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: rawBody !== undefined ? rawBody : JSON.stringify(body ?? {}) } : {})
  });
  const text = await res.text();
  const setCookie = res.headers.get("set-cookie");
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, rawText: text, cookie: setCookie?.split(";")[0] };
};

const login = async (baseUrl: string, loginName: string, password: string): Promise<string> => {
  const result = await requestJson(baseUrl, "POST", "/api/login", undefined, { login: loginName, password });
  if (result.status !== 200 || !result.cookie) throw new Error(`Login ${loginName} echoue: ${JSON.stringify(result.body)}`);
  return result.cookie;
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

const createAgencyAndManager = async (baseUrl: string, adminCookie: string, labelSuffix: string) => {
  const agencyName = `Test Security Sim ${labelSuffix} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = agencyResult.body.agency.id;
  const managerLogin = `test-security-sim-${labelSuffix.toLowerCase()}-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const userResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: `Manager ${labelSuffix}`, email: `${managerLogin}@example.test`, role: 1
  });
  return { agencyId, managerLogin, managerPassword: userResult.body.temporaryPassword as string };
};

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  if (createdAgencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
};

type FakeAgentHandle = { agentId: number; token: string; socket: Socket };

const pairFakeAgent = async (baseUrl: string, managerCookie: string, computerName: string): Promise<FakeAgentHandle> => {
  const pairing = await requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
  return new Promise((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "pair", pairingCode: pairing.body.pairing.code, computerName, version: "1.0.0", protocolVersion: 1 }
    });
    const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout agent fantome.")); }, 8_000);
    socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
    socket.on("AGENT_CONNECTED", (payload: { agentId: number; token: string | null }) => {
      clearTimeout(t);
      if (!payload.token) { reject(new Error("Aucun jeton.")); return; }
      socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
      resolve({ agentId: payload.agentId, token: payload.token, socket });
    });
    socket.connect();
  });
};

const waitUntilValue = async <T>(getter: () => T | undefined, timeoutMs = 8_000): Promise<T | undefined> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = getter();
    if (value) return value;
    await sleep(100);
  }
  return getter();
};

const containsAnySentinel = (value: unknown): string | null => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  for (const sentinel of ALL_SENTINELS) {
    if (text.includes(sentinel)) return sentinel;
  }
  return null;
};

const main = async (): Promise<void> => {
  const server = await startServer(3297, {
    AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent",
    AGENT_COMMAND_ACK_TIMEOUT_MS: "8000", AGENT_COMMAND_TTL_MS: "20000"
  });

  try {
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    // ===================== Sentinelles: cycle complet =====================
    {
      log("SCENARIO-1", "=== Nouvelles sentinelles jamais exposees sur un cycle complet ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "Sentinels");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const agent = await pairFakeAgent(server.baseUrl, managerCookie, "SECURITY-SENTINELS-PC");
      const commandsSeen: Array<Record<string, unknown>> = [];
      agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));

      const uiSocket = ioClient(server.baseUrl, { autoConnect: false, reconnection: false, extraHeaders: { Cookie: managerCookie } });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout ui socket")), 5_000);
        uiSocket.on("connect", () => { clearTimeout(t); resolve(); });
        uiSocket.connect();
      });
      uiSocket.emit("start-bot", { botName: "Bot Sentinels", category: "Tourisme", login: "x", password: "y", clientRequestId: `sentinels-${RUN_SUFFIX}` });

      const startCommand = await waitUntilValue(() => commandsSeen.find((c) => c.type === "START_BOT"));
      if (!startCommand) throw new Error("START_BOT jamais recu.");
      const botId = startCommand.botId as string;

      agent.socket.emit("COMMAND_ACK", { commandId: startCommand.commandId, receivedAt: new Date().toISOString() });
      agent.socket.emit("BOT_STATUS", { commandId: startCommand.commandId, botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
      // Un agent reel ne transmettrait JAMAIS ces champs - simule une tentative
      // (accidentelle ou malveillante) de les glisser dans "details", pour
      // verifier que la sanitisation serveur (sanitizePublicRecord) les retire.
      agent.socket.emit("COMMAND_COMPLETED", {
        commandId: startCommand.commandId,
        completedAt: new Date().toISOString(),
        result: {
          botId, status: "WAITING_FOR_USER", started: true,
          profilePath: SENTINELS.profilePath,
          debugPort: SENTINELS.debugPort,
          Authorization: SENTINELS.authorization,
          cookie: SENTINELS.cookie,
          apiKey: SENTINELS.apiKey
        }
      });

      await waitUntil(async () => {
        const r = await requestJson(server.baseUrl, "GET", "/api/agent-commands?limit=10", managerCookie);
        return r.body.commands.some((c: any) => c.botId === botId && c.status === "COMPLETED");
      }, 8_000);

      const restList = await requestJson(server.baseUrl, "GET", "/api/agent-commands?limit=10", managerCookie);
      const foundInRest = containsAnySentinel(restList.body);
      assert(!foundInRest, `Aucune sentinelle dans GET /api/agent-commands (trouve: ${foundInRest})`);

      const restDetail = await requestJson(server.baseUrl, "GET", `/api/agent-commands/${startCommand.commandId}`, managerCookie);
      const foundInDetail = containsAnySentinel(restDetail.body);
      assert(!foundInDetail, `Aucune sentinelle dans GET /api/agent-commands/:id (trouve: ${foundInDetail})`);

      const dbRow = await pool.query("SELECT * FROM agent_commands WHERE command_id = $1", [startCommand.commandId]);
      const foundInDb = containsAnySentinel(dbRow.rows[0]);
      assert(!foundInDb, `Aucune sentinelle dans la ligne PostgreSQL agent_commands (trouve: ${foundInDb})`);

      const foundInServerLog = containsAnySentinel(server.stdout.join(""));
      assert(!foundInServerLog, `Aucune sentinelle dans les logs serveur (trouve: ${foundInServerLog})`);

      uiSocket.disconnect();
      agent.socket.disconnect();
    }

    // ===================== Payload/JSON malforme sur routes REST =====================
    {
      log("SCENARIO-2", "=== Corps JSON absent/malforme sur les routes REST ===");
      const malformedFixture = await createAgencyAndManager(server.baseUrl, adminCookie, "Malformed");
      const managerCookie = await loginWithRetry(server.baseUrl, malformedFixture.managerLogin, malformedFixture.managerPassword);

      const malformed = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, undefined, "{ not valid json");
      assert(malformed.status >= 400 && malformed.status < 500, `Corps JSON invalide -> code 4xx (recu: ${malformed.status})`);
      assert(!/at\s+.*\(.*:\d+:\d+\)/.test(malformed.rawText || ""), "Aucune stack trace dans la reponse a un corps JSON invalide");

      const emptyBody = await requestJson(server.baseUrl, "PATCH", "/api/monitoring-settings", managerCookie, undefined, "");
      assert(emptyBody.status >= 200 && emptyBody.status < 500, `Corps vide -> jamais un crash serveur 5xx (recu: ${emptyBody.status})`);

      const unknownAgentId = await requestJson(server.baseUrl, "POST", "/api/agents/not-a-number/revoke", managerCookie, {});
      assert(unknownAgentId.status >= 400 && unknownAgentId.status < 500, `ID non numerique dans l'URL -> code 4xx (recu: ${unknownAgentId.status})`);

      // command_id est un UUID en base: un identifiant qui n'a meme pas ce
      // format leve une erreur de type cote PostgreSQL, remontee en 400
      // (format invalide) plutot qu'en 404 (format valide, introuvable) -
      // les deux sont des refus surs et generiques, ni l'un ni l'autre ne
      // doit jamais exposer de detail interne (verifie ci-dessous).
      const missingCommand = await requestJson(server.baseUrl, "GET", "/api/agent-commands/does-not-exist", managerCookie);
      assert([400, 404].includes(missingCommand.status), `commandId au format invalide -> 400 ou 404, jamais un crash 5xx (recu: ${missingCommand.status})`);
      assert(!containsAnySentinel(missingCommand.body), "Reponse generique, sans detail interne (pas de message SQL brut)");
      assert(!/invalid input syntax|relation|column|SELECT|INSERT/i.test(JSON.stringify(missingCommand.body)), "Aucun detail SQL brut dans la reponse JSON");

      const wellFormedButMissing = await requestJson(server.baseUrl, "GET", `/api/agent-commands/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, managerCookie);
      assert(wellFormedButMissing.status === 404, `commandId au bon format mais inexistant -> 404 (recu: ${wellFormedButMissing.status})`);
    }

    // ===================== Statut de bot inconnu + evenement Socket.IO inconnu =====================
    {
      log("SCENARIO-3", "=== Statut/evenement inconnus envoyes par un agent fantome ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "UnknownEvents");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const agent = await pairFakeAgent(server.baseUrl, managerCookie, "SECURITY-UNKNOWN-PC");

      // Statut de bot hors liste blanche: ne doit jamais faire planter le
      // serveur ni etre accepte tel quel (isValidBotStatus le rejette).
      agent.socket.emit("BOT_STATUS", { commandId: "cmd-unknown", botId: "bot-unknown", status: "TOTALLY_MADE_UP_STATUS", timestamp: new Date().toISOString() });
      // Evenement Socket.IO totalement inconnu du protocole /agent.
      agent.socket.emit("THIS_EVENT_DOES_NOT_EXIST", { anything: "at all" });
      await sleep(500);

      const stillOk = await requestJson(server.baseUrl, "GET", "/api/me", managerCookie);
      assert(stillOk.status === 200, "Le serveur repond toujours normalement apres un statut/evenement inconnu (aucun crash)");

      agent.socket.disconnect();
    }

    // ===================== Payload Socket.IO excessivement grand =====================
    {
      log("SCENARIO-4", "=== Payload excessivement grand via start-bot ===");
      const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "Oversized");
      const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
      const agent = await pairFakeAgent(server.baseUrl, managerCookie, "SECURITY-OVERSIZED-PC");
      const commandsSeen: Array<Record<string, unknown>> = [];
      agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));

      const uiSocket = ioClient(server.baseUrl, { autoConnect: false, reconnection: false, extraHeaders: { Cookie: managerCookie } });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout ui socket")), 5_000);
        uiSocket.on("connect", () => { clearTimeout(t); resolve(); });
        uiSocket.connect();
      });

      const hugeName = "A".repeat(500_000);
      uiSocket.emit("start-bot", { botName: hugeName, category: "Tourisme", login: "x", password: "y", clientRequestId: `oversized-${RUN_SUFFIX}` });
      await sleep(1_500);

      const stillOk = await requestJson(server.baseUrl, "GET", "/api/me", managerCookie);
      assert(stillOk.status === 200, "Le serveur reste reactif apres un payload start-bot excessivement grand (aucun crash)");

      uiSocket.disconnect();
      agent.socket.disconnect();
    }

    log("DONE", "Tous les scenarios simules de securite (Lot 6) termines.");
  } finally {
    for (const s of runningServers) await killTree(s.child.pid);
    await cleanupTestData();
  }

  // ===================== Extensions: path traversal + manifest malforme =====================
  log("SCENARIO-5", "=== Extensions locales: path traversal + manifest malforme ===");
  const extRoot = mkdtempSync(path.join(os.tmpdir(), "rdv-agent-security-ext-"));
  try {
    const traversalTarget = path.join(extRoot, "..", "..", "..");
    const malformedDir = path.join(extRoot, "malformed");
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(path.join(malformedDir, "manifest.json"), "{ this is not json at all §§§");

    const configPath = path.join(extRoot, "extensions.json");
    writeFileSync(configPath, JSON.stringify({
      extensions: [
        { id: "traversal-attempt", enabled: true, required: false, localPath: traversalTarget },
        { id: "malformed-manifest", enabled: true, required: false, localPath: malformedDir }
      ]
    }));

    const entries = loadExtensionConfig(extRoot);
    const results = validateExtensions(entries);
    const traversal = results.find((r) => r.id === "traversal-attempt");
    const malformedResult = results.find((r) => r.id === "malformed-manifest");

    // Un chemin de traversal qui resout vers un dossier REEL et EXISTANT
    // (ex: la racine du disque) n'est pas bloque par le nom du chemin en
    // lui-meme (aucun "../" litteral n'est interdit), mais DOIT echouer la
    // validation du manifest (aucun manifest.json coherent a cet endroit):
    // le filtre reel contre le path traversal est donc "aucun manifest.json
    // valide trouve", jamais une simple lecture arbitraire acceptee.
    assert(traversal?.status !== "ok", `Un chemin de traversal ne peut jamais etre valide sans manifest.json coherent (status: ${traversal?.status})`);
    assert(malformedResult?.status === "invalid", `Manifest JSON malforme -> status invalid (recu: ${malformedResult?.status})`);
    assert(!containsAnySentinel(JSON.stringify(results)), "Aucune sentinelle dans le resultat de validation d'extensions");
  } finally {
    rmSync(extRoot, { recursive: true, force: true });
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exit(failCount > 0 ? 1 : 0);
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
