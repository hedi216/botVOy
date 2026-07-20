// Tests d'integration backend Phase 2: GET /api/client-config, garde-fou
// serveur sur l'evenement Socket.IO start-bot en BOT_EXECUTION_MODE=agent
// (appel direct, sans passer par l'interface), et verification REELLE
// (process chrome.exe) qu'aucun Chrome n'est jamais lance sur la VM dans ce
// mode, avec en contrepoint la preuve que legacy_vm continue de fonctionner
// exactement comme avant.
//
// Usage: npx tsx scripts/test-phase2-backend.ts

import { ChildProcess, spawn } from "node:child_process";
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
): Promise<{ agencyId: number; managerCookie: string }> => {
  const agencyName = `Test Phase2 Backend ${labelSuffix} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;

  const managerLogin = `test-p2-be-${labelSuffix.toLowerCase()}-${RUN_SUFFIX}`;
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

// --- Inventaire reel des process chrome.exe (verification litterale de "aucun
// Chrome lance sur la VM"), plutot que de se fier uniquement au code d'erreur
// renvoye par le serveur. ---

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
      const pids = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^\d+$/.test(line));
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

// --- Socket UI (pas /agent: c'est un client web, comme le navigateur) ---

const connectUiSocket = (baseUrl: string, cookie: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      autoConnect: false,
      reconnection: false,
      extraHeaders: { Cookie: cookie }
    });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion socket UI.")); }, 8_000);
    socket.on("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.on("connect_error", (error: Error) => { clearTimeout(timer); reject(error); });
    socket.connect();
  });

type CapturedEvent = { type: string; payload: unknown };

const run = async (): Promise<void> => {
  const servers: ServerHandle[] = [];
  const spawnedChromePidsToCleanup: string[] = [];

  try {
    // ===================== Serveur "agent": UI activee + mode agent =====================
    const serverAgent = await startServer(3231, {
      AGENT_UI_ENABLED: "true",
      AGENT_DOWNLOAD_URL: "https://downloads.example.test/RendezBotAgentSetup.exe",
      BOT_EXECUTION_MODE: "agent"
    });
    servers.push(serverAgent);

    const adminCookieAgent = await loginWithRetry(serverAgent.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    // --- GET /api/client-config reflete les variables d'environnement ---
    const configAgent = await requestJson(serverAgent.baseUrl, "GET", "/api/client-config", adminCookieAgent);
    assert(configAgent.status === 200, "GET /api/client-config repond 200");
    const configAgentBody = configAgent.body as { agentUiEnabled: boolean; agentDownloadUrl: string; botExecutionMode: string };
    assert(configAgentBody.agentUiEnabled === true, "client-config: agentUiEnabled=true reflete");
    assert(
      configAgentBody.agentDownloadUrl === "https://downloads.example.test/RendezBotAgentSetup.exe",
      "client-config: agentDownloadUrl reflete"
    );
    assert(configAgentBody.botExecutionMode === "agent", "client-config: botExecutionMode=agent reflete");

    // --- Garde-fou start-bot en mode agent: appel direct, hors interface ---
    const fixtureAgent = await createAgencyAndManager(serverAgent.baseUrl, adminCookieAgent, "Agent");
    const uiSocketAgent = await connectUiSocket(serverAgent.baseUrl, fixtureAgent.managerCookie);
    const eventsAgent: CapturedEvent[] = [];
    uiSocketAgent.on("bot-status", (payload) => eventsAgent.push({ type: "bot-status", payload }));
    uiSocketAgent.on("bot-log", (payload) => eventsAgent.push({ type: "bot-log", payload }));
    uiSocketAgent.on("bot-session", (payload) => eventsAgent.push({ type: "bot-session", payload }));

    const chromeBeforeAgentMode = await listChromePids();
    uiSocketAgent.emit("start-bot", {
      botName: "Direct API Test Agent",
      category: "Tourisme",
      login: "test-login",
      password: "test-password"
    });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const chromeAfterAgentMode = await listChromePids();
    const newChromePidsAgentMode = [...chromeAfterAgentMode].filter((pid) => !chromeBeforeAgentMode.has(pid));

    const refusal = eventsAgent.find(
      (event) => event.type === "bot-status" && (event.payload as { code?: string }).code === "AGENT_EXECUTION_NOT_READY"
    );
    assert(Boolean(refusal), "start-bot emis directement en mode agent -> refuse avec le code AGENT_EXECUTION_NOT_READY");
    assert(
      !eventsAgent.some((event) => event.type === "bot-session"),
      "Aucune session de bot creee en mode agent (appel direct)"
    );
    assert(newChromePidsAgentMode.length === 0, "Aucun nouveau process chrome.exe lance sur la VM en mode agent");

    uiSocketAgent.disconnect();

    // ===================== Serveur "legacy": valeurs par defaut =====================
    const serverLegacy = await startServer(3232, {});
    servers.push(serverLegacy);

    const adminCookieLegacy = await loginWithRetry(serverLegacy.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    const configLegacy = await requestJson(serverLegacy.baseUrl, "GET", "/api/client-config", adminCookieLegacy);
    const configLegacyBody = configLegacy.body as { agentUiEnabled: boolean; agentDownloadUrl: string; botExecutionMode: string };
    assert(configLegacyBody.agentUiEnabled === false, "client-config: agentUiEnabled=false par defaut");
    assert(configLegacyBody.agentDownloadUrl === "", "client-config: agentDownloadUrl vide par defaut");
    assert(configLegacyBody.botExecutionMode === "legacy_vm", "client-config: botExecutionMode=legacy_vm par defaut");

    // --- Regression: en legacy_vm, start-bot n'est jamais refuse par le
    // garde-fou et lance reellement Chrome, exactement comme avant la Phase 2 ---
    const fixtureLegacy = await createAgencyAndManager(serverLegacy.baseUrl, adminCookieLegacy, "Legacy");
    const uiSocketLegacy = await connectUiSocket(serverLegacy.baseUrl, fixtureLegacy.managerCookie);
    const eventsLegacy: CapturedEvent[] = [];
    uiSocketLegacy.on("bot-status", (payload) => eventsLegacy.push({ type: "bot-status", payload }));
    uiSocketLegacy.on("bot-log", (payload) => eventsLegacy.push({ type: "bot-log", payload }));
    uiSocketLegacy.on("bot-session", (payload) => eventsLegacy.push({ type: "bot-session", payload }));

    const chromeBeforeLegacy = await listChromePids();
    uiSocketLegacy.emit("start-bot", {
      botName: "Direct API Test Legacy",
      category: "Tourisme",
      login: "",
      password: ""
    });
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const chromeAfterLegacy = await listChromePids();
    const newChromePidsLegacy = [...chromeAfterLegacy].filter((pid) => !chromeBeforeLegacy.has(pid));
    spawnedChromePidsToCleanup.push(...newChromePidsLegacy);

    assert(
      !eventsLegacy.some((event) => event.type === "bot-status" && (event.payload as { code?: string }).code === "AGENT_EXECUTION_NOT_READY"),
      "En legacy_vm, le garde-fou Phase 2 ne bloque jamais start-bot"
    );
    assert(
      newChromePidsLegacy.length > 0,
      `En legacy_vm, Chrome se lance toujours reellement sur la VM comme avant (nouveaux PID: ${newChromePidsLegacy.join(", ") || "aucun"})`
    );

    uiSocketLegacy.disconnect();
  } finally {
    await killPids(spawnedChromePidsToCleanup).catch(() => undefined);
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
