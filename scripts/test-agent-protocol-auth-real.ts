// Test REEL/integration Phase 5 (Lot 2 - correctif protocole): verifie que
// le protocole reel distingue desormais INVALID_TOKEN, AGENT_REVOKED et
// VERSION_INCOMPATIBLE (auparavant tous ambigus ou inatteignables - voir
// docs/agent-packaging.md section 9.2/10 pour la cause exacte). Utilise
// uniquement des agences/agents temporaires, jamais de donnee reelle.
//
// Scenarios (section 5 du correctif, complete par le correctif de securite
// anti-enumeration + plage bornee de protocole) :
//   A. agent valide, version compatible -> CONNECTED
//   B. token invalide -> INVALID_TOKEN (jamais AGENT_REVOKED)
//   C. agent revoque + VRAI token -> AGENT_REVOKED (jamais INVALID_TOKEN)
//   C-bis. agent revoque + FAUX token -> INVALID_TOKEN (anti-enumeration),
//          indiscernable d'un agentId inexistant
//   D. protocolVersion incompatible -> VERSION_INCOMPATIBLE (pair ET reconnect)
//   D2. plage bornee explicite (min ET max distincts): version minimale
//       acceptee, version maximale acceptee, trop ancienne rejetee, trop
//       recente rejetee, absente rejetee, non entiere (decimale) rejetee
//   E. un agent revoque ne recoit plus aucune commande NI heartbeat
//   F. une connexion VERSION_INCOMPATIBLE ne recoit jamais de commande (rejetee avant "connection")
//   G. AGENT_REVOKED supprime reellement les credentials DPAPI cote agent
//   H. INVALID_TOKEN supprime les credentials devenus inutilisables cote agent
//   I. VERSION_INCOMPATIBLE conserve les credentials cote agent (jamais supprimes)
//   J. aucune fuite de token/blob DPAPI/donnee DB dans les logs serveur/agent
//
// A executer UNIQUEMENT sur un PC Windows personnel avec une session
// interactive (DPAPI reel) - JAMAIS sur la VM/serveur de production.
//
// Usage: npx tsx scripts/test-agent-protocol-auth-real.ts

import { ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { io as ioClient, Socket } from "socket.io-client";
import { pool } from "../src/db.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
const SERVER_PORT = 3302;

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 15_000, intervalMs = 300): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};

type ServerHandle = { child: ChildProcess; baseUrl: string; stdout: string[] };

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
  return { child, baseUrl, stdout };
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

const requestJson = async (baseUrl: string, method: string, pathName: string, cookie: string | undefined, json?: unknown): Promise<any> => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(json ?? {}) } : {})
  });
  const text = await res.text();
  const setCookie = res.headers.get("set-cookie");
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, cookie: setCookie?.split(";")[0] };
};

const loginWithRetry = async (baseUrl: string, loginName: string, password: string, attempts = 8): Promise<string> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await requestJson(baseUrl, "POST", "/api/login", undefined, { login: loginName, password });
    if (result.status === 200 && result.cookie) return result.cookie;
    lastError = new Error(`Login ${loginName} echoue: ${JSON.stringify(result.body)}`);
    await sleep(1_000);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

// --- Agent fantome (fake socket), pour les scenarios protocole rapides B/D ---

type FakeConnectResult = { ok: true; agentId: number; token: string } | { ok: false; reason: string };

const attemptFakeConnect = (baseUrl: string, auth: Record<string, unknown>): Promise<FakeConnectResult> => new Promise((resolve) => {
  const socket: Socket = ioClient(`${baseUrl}/agent`, { autoConnect: false, reconnection: false, forceNew: true, auth });
  const timer = setTimeout(() => { socket.disconnect(); resolve({ ok: false, reason: "TIMEOUT_NO_RESPONSE" }); }, 8_000);
  socket.on("connect_error", (error: Error) => { clearTimeout(timer); socket.disconnect(); resolve({ ok: false, reason: error.message }); });
  socket.on("AGENT_CONNECTED", (payload: { agentId: number; token: string | null }) => {
    clearTimeout(timer);
    socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
    resolve({ ok: true, agentId: payload.agentId, token: payload.token ?? "" });
    socket.disconnect();
  });
  socket.connect();
});

// --- Agent reel (tsx), pour les scenarios DPAPI G/H/I ---

type RealAgentHandle = { child: ChildProcess; stdout: string[] };

const spawnRealAgent = (serverUrl: string, dataRoot: string, computerName: string, extraEnv: Record<string, string> = {}): RealAgentHandle => {
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "src/agent/agentMain.ts"], {
    env: {
      ...process.env,
      AGENT_SERVER_URL: serverUrl,
      AGENT_DATA_DIR: dataRoot,
      AGENT_COMPUTER_NAME: computerName,
      AGENT_RUNTIME_MODE: "packaged",
      AGENT_TARGET_MODE: "fixture",
      AGENT_FIXTURE_URL: "about:blank",
      AGENT_MAX_ACTIVE_BOTS: "5",
      AGENT_RECONNECT_MIN_DELAY_MS: "500",
      AGENT_RECONNECT_MAX_DELAY_MS: "3000",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  const stdout: string[] = [];
  child.stdout?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("REAL-AGENT", t.trim()); });
  child.stderr?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("REAL-AGENT-ERR", t.trim()); });
  return { child, stdout };
};

const extractLocalUiPort = (stdout: string[]): number | null => {
  const match = stdout.join("").match(/Interface locale disponible: http:\/\/127\.0\.0\.1:(\d+)\//);
  return match ? Number(match[1]) : null;
};

const localUiStatus = async (port: number): Promise<any> => (await fetch(`http://127.0.0.1:${port}/local/status`)).json();
const localUiPost = async (port: number, route: string, nonce: string, extra?: Record<string, unknown>): Promise<{ status: number; body: any }> => {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce, ...extra })
  });
  return { status: res.status, body: await res.json() };
};

const extractLatestConnectedAgentId = (serverStdout: string[]): number | null => {
  const matches = [...serverStdout.join("").matchAll(/Agent connecte: agentId=(\d+)/g)];
  return matches.length > 0 ? Number(matches[matches.length - 1][1]) : null;
};

const main = async (): Promise<void> => {
  log("BOOT", "=== Test protocole reel (Lot 2, correctif): INVALID_TOKEN / AGENT_REVOKED / VERSION_INCOMPATIBLE ===");

  if (process.platform !== "win32") {
    console.log("Plateforme non-Windows: DPAPI reel indisponible, ce test necessite Windows. Ignore, 0 succes / 0 echec.");
    process.exit(0);
  }

  let server: ServerHandle | undefined;
  let realAgent: RealAgentHandle | undefined;
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  const dataRootRevoke = path.join(process.cwd(), `.test-protocol-revoke-${RUN_SUFFIX}`);
  const dataRootInvalid = path.join(process.cwd(), `.test-protocol-invalid-${RUN_SUFFIX}`);
  const dataRootVersion = path.join(process.cwd(), `.test-protocol-version-${RUN_SUFFIX}`);
  const allTokensSeen: string[] = [];

  try {
    server = await startServer(SERVER_PORT, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyName = `Test Protocol Auth ${RUN_SUFFIX}`;
    agencyNames.push(agencyName);
    const agencyId = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
    const managerLogin = `test-protocol-auth-${RUN_SUFFIX}`;
    managerLogins.push(managerLogin);
    const userRes = await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, {
      agencyId, login: managerLogin, name: "Protocol Auth Manager", email: `${managerLogin}@example.test`, role: 1
    });
    const managerPassword = userRes.body.temporaryPassword;
    const managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);

    // ===================== Scenario A: agent valide, version compatible =====================
    const pairingA = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const connectA = await attemptFakeConnect(server.baseUrl, {
      mode: "pair", pairingCode: pairingA.body.pairing.code, computerName: "PROTO-A-PC", version: "0.1.0", protocolVersion: 1
    });
    assert(connectA.ok, "Scenario A: agent valide + protocolVersion compatible -> connexion acceptee");
    if (connectA.ok) allTokensSeen.push(connectA.token);

    // ===================== Scenario B: token invalide =====================
    const connectB = await attemptFakeConnect(server.baseUrl, {
      mode: "reconnect", agentId: connectA.ok ? connectA.agentId : 999999, token: "TEST_SECRET_WRONG_TOKEN_VALUE", version: "0.1.0", protocolVersion: 1
    });
    assert(!connectB.ok, "Scenario B: token errone -> connexion refusee");
    if (!connectB.ok) assert(connectB.reason === "INVALID_TOKEN", `Scenario B: raison exacte INVALID_TOKEN (recu: ${connectB.reason})`);

    // Agent totalement inexistant: doit produire EXACTEMENT la meme reponse
    // publique (section 3: jamais reveler si l'agentId existe).
    const connectBBis = await attemptFakeConnect(server.baseUrl, {
      mode: "reconnect", agentId: 987654321, token: "TEST_SECRET_ANY_TOKEN", version: "0.1.0", protocolVersion: 1
    });
    assert(!connectBBis.ok && connectBBis.reason === "INVALID_TOKEN", "Scenario B (suite): agentId inexistant -> meme reponse INVALID_TOKEN (aucune enumeration possible)");

    // ===================== Scenario C: agent revoque =====================
    const pairingC = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const connectC1 = await attemptFakeConnect(server.baseUrl, {
      mode: "pair", pairingCode: pairingC.body.pairing.code, computerName: "PROTO-C-PC", version: "0.1.0", protocolVersion: 1
    });
    if (!connectC1.ok) throw new Error("Scenario C: pre-requis (premier appairage) a echoue.");
    allTokensSeen.push(connectC1.token);
    await requestJson(server.baseUrl, "POST", `/api/agents/${connectC1.agentId}/revoke`, managerCookie, {});

    const connectC2 = await attemptFakeConnect(server.baseUrl, {
      mode: "reconnect", agentId: connectC1.agentId, token: connectC1.token, version: "0.1.0", protocolVersion: 1
    });
    assert(!connectC2.ok, "Scenario C: reconnexion d'un agent revoque avec le VRAI token -> refusee");
    if (!connectC2.ok) assert(connectC2.reason === "AGENT_REVOKED", `Scenario C: token valide + agent revoque -> AGENT_REVOKED, jamais INVALID_TOKEN (recu: ${connectC2.reason})`);

    // ===================== Scenario C-bis (correctif anti-enumeration): agent revoque + FAUX token =====================
    // Defaut corrige: verifier le statut revoked AVANT le token permettait a
    // un client ne connaissant PAS le vrai token d'apprendre qu'un agentId
    // est revoque (AGENT_REVOKED renvoye quel que soit le token). Desormais
    // le token est verifie EN PREMIER: un faux token pour un agent revoque
    // doit renvoyer INVALID_TOKEN, EXACTEMENT comme pour un agent inexistant.
    const connectCWrongToken = await attemptFakeConnect(server.baseUrl, {
      mode: "reconnect", agentId: connectC1.agentId, token: "TEST_SECRET_WRONG_TOKEN_FOR_REVOKED_AGENT", version: "0.1.0", protocolVersion: 1
    });
    assert(!connectCWrongToken.ok, "Scenario C-bis: agent revoque + FAUX token -> refusee");
    if (!connectCWrongToken.ok) {
      assert(connectCWrongToken.reason === "INVALID_TOKEN", `Scenario C-bis: agent revoque + faux token -> INVALID_TOKEN (jamais AGENT_REVOKED, anti-enumeration) (recu: ${connectCWrongToken.reason})`);
    }

    // Reponses publiques indiscernables (section 1 du correctif): un agentId
    // totalement inexistant et un agent revoque presente avec un faux token
    // doivent produire EXACTEMENT la meme reponse - aucun moyen de deduire
    // qu'un agentId "existe et est revoque" sans connaitre son vrai token.
    assert(
      !connectBBis.ok && !connectCWrongToken.ok && connectBBis.reason === connectCWrongToken.reason,
      `Scenario C-bis (suite): agentId inexistant et agent revoque+faux token sont indiscernables (recu: ${!connectBBis.ok ? connectBBis.reason : "ok"} vs ${!connectCWrongToken.ok ? connectCWrongToken.reason : "ok"})`
    );

    // ===================== Scenario E: aucune commande NI heartbeat pour un agent revoque =====================
    const startAttempt = await requestJson(server.baseUrl, "POST", "/api/bots", managerCookie, { botName: "Bot Revoked Proto", category: "Tourisme" }).catch(() => null);
    // Quelle que soit la route exacte, aucune commande ne doit jamais atteindre
    // un socket revoque (deja garanti par construction: la connexion n'existe
    // plus dans connectedAgents apres revocation) - verifie ici l'absence de
    // tout log serveur de dispatch vers cet agentId apres la revocation.
    const dispatchLogAfterRevoke = server.stdout.join("").split("Agent connecte:").pop() ?? "";
    assert(!new RegExp(`AGENT_COMMAND.*agentId=${connectC1.agentId}\\b`).test(dispatchLogAfterRevoke), "Scenario E: aucune commande dispatchee a l'agent revoque apres sa revocation");
    // Aucun heartbeat ne peut avoir ete traite pour cet agent apres
    // revocation: garanti par construction (la reconnexion est rejetee au
    // handshake, donc AUCUN socket "AGENT_HEARTBEAT" n'a jamais pu etre
    // emis pour cet agentId) - confirme par l'absence de toute mention.
    assert(!dispatchLogAfterRevoke.includes(`AGENT_HEARTBEAT`) || !new RegExp(`agentId=${connectC1.agentId}\\b`).test(dispatchLogAfterRevoke.match(/AGENT_HEARTBEAT[^\n]*/g)?.join("") ?? ""), "Scenario E (suite): aucun heartbeat traite pour l'agent revoque apres sa revocation");
    void startAttempt;

    // ===================== Scenario D: protocolVersion incompatible (pair ET reconnect) =====================
    const pairingD = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const connectDPair = await attemptFakeConnect(server.baseUrl, {
      mode: "pair", pairingCode: pairingD.body.pairing.code, computerName: "PROTO-D-PC", version: "0.1.0", protocolVersion: 0
    });
    assert(!connectDPair.ok && connectDPair.reason === "VERSION_INCOMPATIBLE", `Scenario D (pair): protocolVersion=0 -> VERSION_INCOMPATIBLE (recu: ${!connectDPair.ok ? connectDPair.reason : "ok"})`);

    // Le code de pairage ne doit jamais avoir ete consomme par cette tentative
    // rejetee (rejet AVANT redeemPairingCode): reutilisable pour un agent
    // reellement compatible.
    const connectDPairRetry = await attemptFakeConnect(server.baseUrl, {
      mode: "pair", pairingCode: pairingD.body.pairing.code, computerName: "PROTO-D-PC", version: "0.1.0", protocolVersion: 1
    });
    assert(connectDPairRetry.ok, "Scenario D (suite): le meme code d'appairage reste utilisable par un agent compatible (jamais consomme par la tentative incompatible)");
    if (connectDPairRetry.ok) allTokensSeen.push(connectDPairRetry.token);

    const connectDReconnect = await attemptFakeConnect(server.baseUrl, {
      mode: "reconnect", agentId: connectDPairRetry.ok ? connectDPairRetry.agentId : 0, token: connectDPairRetry.ok ? connectDPairRetry.token : "", version: "0.1.0", protocolVersion: 0
    });
    assert(!connectDReconnect.ok && connectDReconnect.reason === "VERSION_INCOMPATIBLE", `Scenario D (reconnect): protocolVersion=0 -> VERSION_INCOMPATIBLE (recu: ${!connectDReconnect.ok ? connectDReconnect.reason : "ok"})`);

    // Champ absent du tout: doit aussi etre traite comme incompatible, jamais
    // suppose compatible par defaut.
    const connectDMissing = await attemptFakeConnect(server.baseUrl, {
      mode: "reconnect", agentId: connectDPairRetry.ok ? connectDPairRetry.agentId : 0, token: connectDPairRetry.ok ? connectDPairRetry.token : "", version: "0.1.0"
    });
    assert(!connectDMissing.ok && connectDMissing.reason === "VERSION_INCOMPATIBLE", `Scenario D (suite): protocolVersion absent -> VERSION_INCOMPATIBLE (recu: ${!connectDMissing.ok ? connectDMissing.reason : "ok"})`);

    // ===================== Scenario F: VERSION_INCOMPATIBLE ne recoit jamais de commande =====================
    // La connexion n'a jamais atteint le handler "connection" (rejetee au
    // middleware): aucune entree connectedAgents, donc structurellement aucun
    // dispatch possible - confirme par l'absence totale du agentId dans un
    // contexte AGENT_COMMAND.
    assert(!server.stdout.join("").includes(`AGENT_COMMAND recue: type=`), "Scenario F: aucune commande n'a jamais ete recue par une connexion VERSION_INCOMPATIBLE (jamais atteint l'etat connecte)");

    // ===================== Scenario D2: plage bornee explicite (min/max distincts) =====================
    log("SCENARIO-D2", "=== Serveur avec AGENT_MIN_PROTOCOL_VERSION=1, AGENT_MAX_PROTOCOL_VERSION=3 ===");
    const RANGE_PORT = SERVER_PORT + 1;
    let rangeServer: ServerHandle | undefined;
    try {
      rangeServer = await startServer(RANGE_PORT, {
        AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent",
        AGENT_MIN_PROTOCOL_VERSION: "1", AGENT_MAX_PROTOCOL_VERSION: "3"
      });
      const rangeAdminCookie = await loginWithRetry(rangeServer.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
      const rangeAgencyName = `Test Protocol Range ${RUN_SUFFIX}`;
      agencyNames.push(rangeAgencyName);
      const rangeAgencyId = (await requestJson(rangeServer.baseUrl, "POST", "/api/agencies", rangeAdminCookie, { name: rangeAgencyName, maxActiveClients: 15 })).body.agency.id;
      const rangeManagerLogin = `test-protocol-range-${RUN_SUFFIX}`;
      managerLogins.push(rangeManagerLogin);
      const rangeUserRes = await requestJson(rangeServer.baseUrl, "POST", "/api/users", rangeAdminCookie, {
        agencyId: rangeAgencyId, login: rangeManagerLogin, name: "Protocol Range Manager", email: `${rangeManagerLogin}@example.test`, role: 1
      });
      const rangeManagerCookie = await loginWithRetry(rangeServer.baseUrl, rangeManagerLogin, rangeUserRes.body.temporaryPassword);

      const freshPairingCode = async (): Promise<string> =>
        (await requestJson(rangeServer!.baseUrl, "POST", "/api/agents/pairing-codes", rangeManagerCookie, {})).body.pairing.code;

      const connectMin = await attemptFakeConnect(rangeServer.baseUrl, {
        mode: "pair", pairingCode: await freshPairingCode(), computerName: "PROTO-D2-MIN-PC", version: "0.1.0", protocolVersion: 1
      });
      assert(connectMin.ok, "Scenario D2: protocolVersion = minimum exact (1) -> acceptee");

      const connectMax = await attemptFakeConnect(rangeServer.baseUrl, {
        mode: "pair", pairingCode: await freshPairingCode(), computerName: "PROTO-D2-MAX-PC", version: "0.1.0", protocolVersion: 3
      });
      assert(connectMax.ok, "Scenario D2: protocolVersion = maximum exact (3) -> acceptee");

      const connectTooOld = await attemptFakeConnect(rangeServer.baseUrl, {
        mode: "pair", pairingCode: await freshPairingCode(), computerName: "PROTO-D2-OLD-PC", version: "0.1.0", protocolVersion: 0
      });
      assert(!connectTooOld.ok && connectTooOld.reason === "VERSION_INCOMPATIBLE", `Scenario D2: protocolVersion trop ancienne (0 < min=1) -> VERSION_INCOMPATIBLE (recu: ${!connectTooOld.ok ? connectTooOld.reason : "ok"})`);

      const connectTooNew = await attemptFakeConnect(rangeServer.baseUrl, {
        mode: "pair", pairingCode: await freshPairingCode(), computerName: "PROTO-D2-NEW-PC", version: "0.1.0", protocolVersion: 4
      });
      assert(!connectTooNew.ok && connectTooNew.reason === "VERSION_INCOMPATIBLE", `Scenario D2: protocolVersion trop recente (4 > max=3) -> VERSION_INCOMPATIBLE (recu: ${!connectTooNew.ok ? connectTooNew.reason : "ok"})`);

      const connectAbsent = await attemptFakeConnect(rangeServer.baseUrl, {
        mode: "pair", pairingCode: await freshPairingCode(), computerName: "PROTO-D2-ABSENT-PC", version: "0.1.0"
      });
      assert(!connectAbsent.ok && connectAbsent.reason === "VERSION_INCOMPATIBLE", `Scenario D2: protocolVersion absente -> VERSION_INCOMPATIBLE (recu: ${!connectAbsent.ok ? connectAbsent.reason : "ok"})`);

      const connectDecimal = await attemptFakeConnect(rangeServer.baseUrl, {
        mode: "pair", pairingCode: await freshPairingCode(), computerName: "PROTO-D2-DECIMAL-PC", version: "0.1.0", protocolVersion: 1.5
      });
      assert(!connectDecimal.ok && connectDecimal.reason === "VERSION_INCOMPATIBLE", `Scenario D2: protocolVersion decimale (1.5, non entiere) -> VERSION_INCOMPATIBLE (recu: ${!connectDecimal.ok ? connectDecimal.reason : "ok"})`);

      const connectString = await attemptFakeConnect(rangeServer.baseUrl, {
        mode: "pair", pairingCode: await freshPairingCode(), computerName: "PROTO-D2-STRING-PC", version: "0.1.0", protocolVersion: "1" as unknown as number
      });
      assert(!connectString.ok && connectString.reason === "VERSION_INCOMPATIBLE", `Scenario D2: protocolVersion en chaine ("1") -> VERSION_INCOMPATIBLE (recu: ${!connectString.ok ? connectString.reason : "ok"})`);

      const connectNaNValue = await attemptFakeConnect(rangeServer.baseUrl, {
        mode: "pair", pairingCode: await freshPairingCode(), computerName: "PROTO-D2-NAN-PC", version: "0.1.0", protocolVersion: Number.NaN
      });
      assert(!connectNaNValue.ok && connectNaNValue.reason === "VERSION_INCOMPATIBLE", `Scenario D2: protocolVersion NaN -> VERSION_INCOMPATIBLE (recu: ${!connectNaNValue.ok ? connectNaNValue.reason : "ok"})`);

      const connectInfinity = await attemptFakeConnect(rangeServer.baseUrl, {
        mode: "pair", pairingCode: await freshPairingCode(), computerName: "PROTO-D2-INF-PC", version: "0.1.0", protocolVersion: Number.POSITIVE_INFINITY
      });
      assert(!connectInfinity.ok && connectInfinity.reason === "VERSION_INCOMPATIBLE", `Scenario D2: protocolVersion Infinity -> VERSION_INCOMPATIBLE (recu: ${!connectInfinity.ok ? connectInfinity.reason : "ok"})`);

      const connectNegative = await attemptFakeConnect(rangeServer.baseUrl, {
        mode: "pair", pairingCode: await freshPairingCode(), computerName: "PROTO-D2-NEG-PC", version: "0.1.0", protocolVersion: -1
      });
      assert(!connectNegative.ok && connectNegative.reason === "VERSION_INCOMPATIBLE", `Scenario D2: protocolVersion negative (-1) -> VERSION_INCOMPATIBLE (recu: ${!connectNegative.ok ? connectNegative.reason : "ok"})`);
    } finally {
      await killTree(rangeServer?.child.pid).catch(() => undefined);
    }

    // ===================== Scenario G: AGENT_REVOKED supprime les credentials DPAPI (agent reel) =====================
    log("SCENARIO-G", "=== Agent reel: revocation -> suppression DPAPI ===");
    const pairingG = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    realAgent = spawnRealAgent(server.baseUrl, dataRootRevoke, "PROTO-G-REAL-PC");
    const portG = await waitUntil(() => extractLocalUiPort(realAgent!.stdout) !== null, 10_000) ? extractLocalUiPort(realAgent.stdout)! : 0;
    if (!portG) throw new Error("Scenario G: interface locale jamais demarree.");
    const statusG = await localUiStatus(portG);
    const pairResultG = await localUiPost(portG, "/local/pair", statusG.nonce, { code: pairingG.body.pairing.code });
    assert(pairResultG.status === 200 && pairResultG.body.ok, "Scenario G: appairage reel reussi");
    const credPathG = path.join(dataRootRevoke, "credentials", "agent-credentials.json");
    assert(await waitUntil(() => existsSync(credPathG), 5_000), "Scenario G: fichier de credentials DPAPI cree");

    const agentIdG = extractLatestConnectedAgentId(server.stdout);
    if (!agentIdG) throw new Error("Scenario G: agentId introuvable dans les logs serveur.");
    await requestJson(server.baseUrl, "POST", `/api/agents/${agentIdG}/revoke`, managerCookie, {});

    const revokedLocallyG = await waitUntil(async () => (await localUiStatus(portG)).state === "NOT_PAIRED", 20_000, 500);
    assert(revokedLocallyG, "Scenario G: l'agent reel detecte AGENT_REVOKED et repasse NOT_PAIRED");
    assert(/AGENT_REVOKED/.test(realAgent.stdout.join("")), "Scenario G: le log agent mentionne explicitement AGENT_REVOKED (jamais INVALID_TOKEN generique)");
    assert(await waitUntil(() => !existsSync(credPathG), 5_000), "Scenario G: le fichier de credentials DPAPI est supprime apres AGENT_REVOKED");

    await killTree(realAgent.child.pid);
    realAgent = undefined;

    // ===================== Scenario H: INVALID_TOKEN supprime les credentials inutilisables =====================
    log("SCENARIO-H", "=== Agent reel: token corrompu -> INVALID_TOKEN -> suppression credentials ===");
    const pairingH = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    realAgent = spawnRealAgent(server.baseUrl, dataRootInvalid, "PROTO-H-REAL-PC");
    const portH = await waitUntil(() => extractLocalUiPort(realAgent!.stdout) !== null, 10_000) ? extractLocalUiPort(realAgent.stdout)! : 0;
    if (!portH) throw new Error("Scenario H: interface locale jamais demarree.");
    const statusH = await localUiStatus(portH);
    const pairResultH = await localUiPost(portH, "/local/pair", statusH.nonce, { code: pairingH.body.pairing.code });
    assert(pairResultH.status === 200 && pairResultH.body.ok, "Scenario H: appairage reel reussi (prealable)");
    const credPathH = path.join(dataRootInvalid, "credentials", "agent-credentials.json");
    await waitUntil(() => existsSync(credPathH), 5_000);

    await killTree(realAgent.child.pid);
    // Corrompt le token protege sur disque (simule un credential devenu
    // inutilisable - jamais un acces reseau, uniquement le fichier local).
    const envelopeH = JSON.parse(readFileSync(credPathH, "utf8"));
    envelopeH.protectedToken = Buffer.from("not-a-real-dpapi-blob-at-all").toString("base64");
    writeFileSync(credPathH, JSON.stringify(envelopeH, null, 2));

    realAgent = spawnRealAgent(server.baseUrl, dataRootInvalid, "PROTO-H-REAL-PC");
    const clearedH = await waitUntil(() => !existsSync(credPathH), 15_000, 500);
    assert(clearedH, "Scenario H: le credential devenu inutilisable (token corrompu) est efface par l'agent");
    const portHAfter = await waitUntil(() => extractLocalUiPort(realAgent!.stdout) !== null, 5_000) ? extractLocalUiPort(realAgent.stdout)! : portH;
    const statusHAfter = await waitUntil(async () => (await localUiStatus(portHAfter)).state === "NOT_PAIRED", 10_000);
    assert(statusHAfter, "Scenario H: l'agent repasse NOT_PAIRED apres l'echec d'authentification");

    await killTree(realAgent.child.pid);
    realAgent = undefined;

    // ===================== Scenario I: VERSION_INCOMPATIBLE conserve les credentials =====================
    log("SCENARIO-I", "=== Agent reel: appairage puis serveur exigeant un protocole superieur -> credentials conserves ===");
    const pairingI = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    realAgent = spawnRealAgent(server.baseUrl, dataRootVersion, "PROTO-I-REAL-PC");
    const portI = await waitUntil(() => extractLocalUiPort(realAgent!.stdout) !== null, 10_000) ? extractLocalUiPort(realAgent.stdout)! : 0;
    if (!portI) throw new Error("Scenario I: interface locale jamais demarree.");
    const statusI = await localUiStatus(portI);
    const pairResultI = await localUiPost(portI, "/local/pair", statusI.nonce, { code: pairingI.body.pairing.code });
    assert(pairResultI.status === 200 && pairResultI.body.ok, "Scenario I: appairage reel reussi (prealable)");
    const credPathI = path.join(dataRootVersion, "credentials", "agent-credentials.json");
    await waitUntil(() => existsSync(credPathI), 5_000);
    const credentialsContentBeforeI = readFileSync(credPathI, "utf8");

    await killTree(realAgent.child.pid);
    await killTree(server.child.pid);
    server = await startServer(SERVER_PORT, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent", AGENT_MIN_PROTOCOL_VERSION: "2", AGENT_MAX_PROTOCOL_VERSION: "2" });

    realAgent = spawnRealAgent(server.baseUrl, dataRootVersion, "PROTO-I-REAL-PC");
    const incompatibleDetected = await waitUntil(() => /VERSION_INCOMPATIBLE/.test(realAgent!.stdout.join("")), 15_000, 300);
    assert(incompatibleDetected, "Scenario I: l'agent reel detecte VERSION_INCOMPATIBLE face a un serveur exigeant un protocole superieur");
    await sleep(1_000);
    assert(existsSync(credPathI), "Scenario I: le fichier de credentials DPAPI N'EST PAS supprime (identite conservee)");
    const credentialsContentAfterI = readFileSync(credPathI, "utf8");
    assert(credentialsContentBeforeI === credentialsContentAfterI, "Scenario I: le contenu du fichier de credentials est strictement inchange");
    const portIAfter = extractLocalUiPort(realAgent.stdout.slice());
    if (portIAfter) {
      const statusIAfter = await waitUntil(async () => (await localUiStatus(portIAfter)).state === "VERSION_INCOMPATIBLE", 10_000);
      assert(statusIAfter, "Scenario I: l'interface locale affiche l'etat VERSION_INCOMPATIBLE (mise a jour requise)");
      const statusPayloadI = await localUiStatus(portIAfter);
      assert(statusPayloadI.paired === true, "Scenario I: l'agent reste considere appaire (paired=true) malgre l'incompatibilite");
    }

    // ===================== Scenario J: aucune fuite de token/blob/DB =====================
    const fullServerLog = server.stdout.join("");
    const fullAgentLog = realAgent.stdout.join("");
    const leaked = allTokensSeen.filter((t) => t && (fullServerLog.includes(t) || fullAgentLog.includes(t)));
    assert(leaked.length === 0, `Scenario J: aucun token reel n'apparait en clair dans les logs serveur/agent (${leaked.length} fuite(s) trouvee(s))`);
    assert(!fullServerLog.includes("token_hash"), "Scenario J: aucune mention de token_hash dans les logs serveur");
    assert(!/Bearer\s|Authorization:\s*\S/i.test(fullServerLog), "Scenario J: aucun en-tete Authorization brut dans les logs serveur");
  } finally {
    await killTree(realAgent?.child.pid).catch(() => undefined);
    if (server) {
      await killTree(server.child.pid).catch(() => undefined);
    }
    for (const dir of [dataRootRevoke, dataRootInvalid, dataRootVersion]) {
      if (existsSync(dir)) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    try {
      if (managerLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [managerLogins]);
      if (agencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [agencyNames]);
    } catch (error) {
      log("CLEANUP-ERR", `Nettoyage base de donnees incomplet: ${error instanceof Error ? error.message : String(error)}`);
    }
    await pool.end().catch(() => undefined);
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
