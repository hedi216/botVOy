// Test d'integration pour le correctif des deux autres acces fragiles a req.body:
//   PATCH /api/agents/:id
//   POST  /api/agents/pairing-codes
// Meme style que scripts/test-agent-revoke.ts: demarre une vraie instance du
// serveur sur un port dedie, cree des agences/utilisateurs de test via l'API
// reelle, exerce les routes, puis nettoie ses propres donnees.
//
// Usage: npx tsx scripts/test-agent-patch-pairing.ts

import { ChildProcess, spawn } from "node:child_process";
import { io as ioClient } from "socket.io-client";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/password.js";

const TEST_PORT = Number(process.env.TEST_PATCH_PAIRING_PORT || 3212);
const BASE_URL = `http://localhost:${TEST_PORT}`;
const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();

const log = (label: string, message: string): void => {
  console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
};

let passCount = 0;
let failCount = 0;

const assert = (condition: boolean, description: string): void => {
  if (condition) {
    passCount += 1;
    console.log(`[PASS] ${description}`);
  } else {
    failCount += 1;
    console.error(`[FAIL] ${description}`);
  }
};

// --- Detection recursive de cles sensibles dans une reponse publique ---

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

const assertSanitized = (value: unknown, description: string): void => {
  const forbidden = findForbiddenKeys(value);
  assert(forbidden.length === 0, `${description}${forbidden.length ? ` (cles sensibles: ${forbidden.join(", ")})` : ""}`);
};

// --- HTTP minimal (fetch + cookie-jar manuel par session) ---

type HttpResult = { status: number; body: unknown; rawText: string; cookie?: string };

const extractCookie = (res: globalThis.Response): string | undefined => {
  const setCookie = res.headers.get("set-cookie");
  return setCookie ? setCookie.split(";")[0] : undefined;
};

const parseBody = (rawText: string): unknown => {
  if (!rawText) {
    return null;
  }
  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
};

const requestJson = async (
  method: string,
  pathName: string,
  cookie: string | undefined,
  json: unknown
): Promise<HttpResult> => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${BASE_URL}${pathName}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(hasBody ? { "Content-Type": "application/json" } : {})
    },
    ...(hasBody ? { body: JSON.stringify(json ?? {}) } : {})
  });
  const rawText = await res.text();
  return { status: res.status, body: parseBody(rawText), rawText, cookie: extractCookie(res) };
};

// Reproduit une requete sans corps du tout (pas de Content-Type, pas de body):
// c'est la condition exacte du bug d'origine (req.body reste undefined).
const requestNoBody = async (method: string, pathName: string, cookie: string): Promise<HttpResult> => {
  const res = await fetch(`${BASE_URL}${pathName}`, { method, headers: { Cookie: cookie } });
  const rawText = await res.text();
  return { status: res.status, body: parseBody(rawText), rawText };
};

const login = async (loginName: string, password: string): Promise<string> => {
  const result = await requestJson("POST", "/api/login", undefined, { login: loginName, password });
  if (result.status !== 200 || !result.cookie) {
    throw new Error(`Login ${loginName} a echoue (status ${result.status}): ${result.rawText}`);
  }
  return result.cookie;
};

const loginWithRetry = async (loginName: string, password: string, attempts = 5): Promise<string> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await login(loginName, password);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

// --- Cycle de vie du serveur de test ---

const waitForServerReady = async (): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/me`);
      if (res.status === 401 || res.status === 200) {
        return;
      }
    } catch {
      // pas encore pret
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Le serveur de test n'a jamais repondu sur ${BASE_URL}/api/me.`);
};

const startServer = (): ChildProcess => {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(command, ["tsx", "src/server.ts"], {
    env: { ...process.env, WEB_PORT: String(TEST_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });

  child.stdout?.on("data", (chunk: Buffer) => log("SERVER_STDOUT", chunk.toString().trim()));
  child.stderr?.on("data", (chunk: Buffer) => log("SERVER_STDERR", chunk.toString().trim()));

  return child;
};

const stopServer = async (child: ChildProcess): Promise<void> => {
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }

  child.kill("SIGTERM");
};

// --- Appairage d'un agent de test via socket.io-client ---

type PairResult = { agentId: number; token: string };

const pairAgent = (pairingCode: string, computerName: string): Promise<PairResult> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(`${BASE_URL}/agent`, {
      autoConnect: false,
      reconnection: false,
      auth: { mode: "pair", pairingCode, computerName, version: "1.0.0", protocolVersion: 1 }
    });

    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`Timeout lors de l'appairage de ${computerName}.`));
    }, 8_000);

    socket.on("connect_error", (error: Error) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(new Error(`Appairage de ${computerName} rejete: ${error.message}`));
    });

    socket.on("AGENT_CONNECTED", (payload: { agentId: number; token: string | null }) => {
      clearTimeout(timer);
      socket.disconnect();
      if (!payload.token) {
        reject(new Error(`Aucun jeton recu pour ${computerName}.`));
        return;
      }
      resolve({ agentId: payload.agentId, token: payload.token });
    });

    socket.connect();
  });

// --- Nettoyage des donnees de test ---

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) {
    await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  }
  if (createdAgencyNames.length > 0) {
    await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
  }
};

// --- Scenario principal ---

const run = async (): Promise<void> => {
  const server = startServer();

  try {
    await waitForServerReady();
    log("SETUP", "Serveur de test pret.");

    const adminCookie = await loginWithRetry(ADMIN_LOGIN, ADMIN_PASSWORD);

    const agencyAName = `Test PatchPairing A ${RUN_SUFFIX}`;
    const agencyBName = `Test PatchPairing B ${RUN_SUFFIX}`;
    createdAgencyNames.push(agencyAName, agencyBName);

    const agencyA = await requestJson("POST", "/api/agencies", adminCookie, { name: agencyAName, maxActiveClients: 15 });
    const agencyB = await requestJson("POST", "/api/agencies", adminCookie, { name: agencyBName, maxActiveClients: 15 });
    const agencyAId = (agencyA.body as { agency: { id: number } }).agency.id;
    const agencyBId = (agencyB.body as { agency: { id: number } }).agency.id;

    const mgrALogin = `test-pp-mgr-a-${RUN_SUFFIX}`;
    const mgrBLogin = `test-pp-mgr-b-${RUN_SUFFIX}`;
    const orphanLogin = `test-pp-orphan-${RUN_SUFFIX}`;
    createdUserLogins.push(mgrALogin, mgrBLogin, orphanLogin);

    const mgrACreate = await requestJson("POST", "/api/users", adminCookie, {
      agencyId: agencyAId, login: mgrALogin, name: "Manager A", email: `${mgrALogin}@example.test`, role: 1
    });
    const mgrBCreate = await requestJson("POST", "/api/users", adminCookie, {
      agencyId: agencyBId, login: mgrBLogin, name: "Manager B", email: `${mgrBLogin}@example.test`, role: 1
    });
    const mgrAPassword = (mgrACreate.body as { temporaryPassword: string }).temporaryPassword;
    const mgrBPassword = (mgrBCreate.body as { temporaryPassword: string }).temporaryPassword;

    const orphanPassword = "Or8h4n-T3st-P@ss";
    await pool.query(
      `INSERT INTO users (agency_id, login, password_hash, name, email, role, is_active)
       VALUES (NULL, $1, $2, 'Manager Sans Agence', $3, 1, TRUE)`,
      [orphanLogin, await hashPassword(orphanPassword), `${orphanLogin}@example.test`]
    );

    const cookieA = await loginWithRetry(mgrALogin, mgrAPassword);
    const cookieB = await loginWithRetry(mgrBLogin, mgrBPassword);
    const cookieOrphan = await loginWithRetry(orphanLogin, orphanPassword);
    log("SETUP", `Agences et utilisateurs de test crees (agencyA=${agencyAId}, agencyB=${agencyBId}).`);

    const pairingForA1 = await requestJson("POST", "/api/agents/pairing-codes", cookieA, {});
    const codeA1 = (pairingForA1.body as { pairing: { code: string } }).pairing.code;
    const agentA1 = await pairAgent(codeA1, "TEST-PP-A1");
    log("SETUP", `Agent de test appaire pour agence A: agentId=${agentA1.agentId}.`);

    // --- TC1: PATCH sans corps du tout -> erreur metier controlee, pas de TypeError ---
    const tc1 = await requestNoBody("PATCH", `/api/agents/${agentA1.agentId}`, cookieA);
    assert(!tc1.rawText.includes("Cannot read properties"), "TC1: PATCH sans corps -> aucune TypeError renvoyee");
    assert(tc1.status === 400, `TC1: PATCH sans corps -> 400 (recu ${tc1.status}: ${tc1.rawText})`);
    assert(
      (tc1.body as { error?: string } | null)?.error === "Nom requis.",
      `TC1: message "Nom requis." (recu ${JSON.stringify(tc1.body)})`
    );
    assertSanitized(tc1.body, "TC1: reponse assainie");

    // --- TC2: PATCH avec un name valide -> 200 ---
    const tc2 = await requestJson("PATCH", `/api/agents/${agentA1.agentId}`, cookieA, { name: "Nom Valide" });
    assert(tc2.status === 200, `TC2: PATCH avec name valide -> 200 (recu ${tc2.status}: ${tc2.rawText})`);
    const tc2Agent = (tc2.body as { agent?: Record<string, unknown> } | null)?.agent;
    assert(tc2Agent?.name === "Nom Valide", `TC2: le nom est applique (recu ${tc2Agent?.name})`);
    assertSanitized(tc2.body, "TC2: reponse assainie");

    // --- TC3: PATCH d'un agent d'une autre agence -> refus ---
    const tc3 = await requestJson("PATCH", `/api/agents/${agentA1.agentId}`, cookieB, { name: "Vole" });
    assert(tc3.status !== 200, `TC3: PATCH inter-agence refuse (recu ${tc3.status})`);
    assert(!tc3.rawText.includes("Cannot read properties"), "TC3: PATCH inter-agence -> aucune TypeError renvoyee");
    assertSanitized(tc3.body, "TC3: reponse assainie");

    // --- TC4: pairing-codes sans corps pour un utilisateur d'agence -> 200 ---
    const tc4 = await requestNoBody("POST", "/api/agents/pairing-codes", cookieA);
    assert(!tc4.rawText.includes("Cannot read properties"), "TC4: pairing-codes sans corps -> aucune TypeError renvoyee");
    assert(tc4.status === 200, `TC4: pairing-codes sans corps pour un manager d'agence -> 200 (recu ${tc4.status}: ${tc4.rawText})`);
    const tc4Pairing = (tc4.body as { pairing?: { code?: string; expiresAt?: string } } | null)?.pairing;
    assert(typeof tc4Pairing?.code === "string" && tc4Pairing.code.length > 0, "TC4: un code d'appairage est retourne");
    assertSanitized(tc4.body, "TC4: reponse assainie");

    // --- TC5: pairing-codes sans agence resolue -> 400 "Agence requise." ---
    const tc5 = await requestNoBody("POST", "/api/agents/pairing-codes", cookieOrphan);
    assert(!tc5.rawText.includes("Cannot read properties"), "TC5: pairing-codes sans agence -> aucune TypeError renvoyee");
    assert(tc5.status === 400, `TC5: utilisateur sans agence -> 400 (recu ${tc5.status})`);
    assert(
      (tc5.body as { error?: string } | null)?.error === "Agence requise.",
      `TC5: message "Agence requise." (recu ${JSON.stringify(tc5.body)})`
    );

    // --- TC6: administrateur global, agencyId autorise via body PUIS via query ---
    const tc6Body = await requestJson("POST", "/api/agents/pairing-codes", adminCookie, { agencyId: agencyAId });
    assert(tc6Body.status === 200, `TC6a: admin avec agencyId en body -> 200 (recu ${tc6Body.status}: ${tc6Body.rawText})`);
    assertSanitized(tc6Body.body, "TC6a: reponse assainie");

    const tc6Query = await requestNoBody("POST", `/api/agents/pairing-codes?agencyId=${agencyAId}`, adminCookie);
    assert(tc6Query.status === 200, `TC6b: admin avec agencyId en query (sans corps) -> 200 (recu ${tc6Query.status}: ${tc6Query.rawText})`);
    assertSanitized(tc6Query.body, "TC6b: reponse assainie");

    // --- TC7: administrateur global sans agencyId du tout -> 400 ---
    const tc7 = await requestNoBody("POST", "/api/agents/pairing-codes", adminCookie);
    assert(tc7.status === 400, `TC7: admin sans agencyId -> 400 (recu ${tc7.status})`);
    assert(
      (tc7.body as { error?: string } | null)?.error === "Agence requise.",
      `TC7: message "Agence requise." pour l'admin sans agencyId (recu ${JSON.stringify(tc7.body)})`
    );
  } finally {
    await cleanupTestData().catch((error) => log("CLEANUP_ERROR", String(error)));
    await stopServer(server);
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
