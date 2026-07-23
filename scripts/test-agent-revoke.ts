// Test d'integration pour POST /api/agents/:id/revoke (regression du bug
// "Cannot read properties of undefined (reading 'agencyId')") et pour la
// portee stricte de la revocation par agence.
//
// Demarre une vraie instance du serveur (src/server.ts) sur un port dedie,
// cree deux agences + utilisateurs de test via l'API reelle, appaire de vrais
// agents via socket.io-client, puis exerce la route de revocation dans les
// scenarios exiges. Nettoie ses propres donnees de test a la fin (succes ou
// echec) et ferme le pool pg pour laisser le process se terminer proprement.
//
// Necessite PostgreSQL accessible (memes variables d'env que le reste du
// projet) et le port de test libre. Usage:
//   npx tsx scripts/test-agent-revoke.ts

import { ChildProcess, spawn } from "node:child_process";
import { io as ioClient } from "socket.io-client";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/password.js";

const TEST_PORT = Number(process.env.TEST_REVOKE_PORT || 3211);
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

// Reproduit EXACTEMENT les conditions du bug rapporte: aucune entete
// Content-Type, aucun corps du tout (req.body reste undefined cote serveur).
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
      // pas encore pret, on reessaie
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
    // .cmd sur Windows doit passer par un shell pour etre execute (spawn EINVAL sinon).
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

type ReconnectOutcome = { outcome: "connected" | "rejected" | "timeout"; reason?: string };

const attemptReconnect = (agentId: number, token: string): Promise<ReconnectOutcome> =>
  new Promise((resolve) => {
    const socket = ioClient(`${BASE_URL}/agent`, {
      autoConnect: false,
      reconnection: false,
      auth: { mode: "reconnect", agentId, token, version: "1.0.0", protocolVersion: 1 }
    });

    const finish = (result: ReconnectOutcome): void => {
      clearTimeout(timer);
      socket.disconnect();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ outcome: "timeout" }), 5_000);

    socket.on("connect", () => finish({ outcome: "connected" }));
    socket.on("connect_error", (error: Error) => finish({ outcome: "rejected", reason: error.message }));

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

    const agencyAName = `Test Revoke A ${RUN_SUFFIX}`;
    const agencyBName = `Test Revoke B ${RUN_SUFFIX}`;
    createdAgencyNames.push(agencyAName, agencyBName);

    const agencyA = await requestJson("POST", "/api/agencies", adminCookie, { name: agencyAName, maxActiveClients: 15 });
    const agencyB = await requestJson("POST", "/api/agencies", adminCookie, { name: agencyBName, maxActiveClients: 15 });
    const agencyAId = (agencyA.body as { agency: { id: number } }).agency.id;
    const agencyBId = (agencyB.body as { agency: { id: number } }).agency.id;

    const mgrALogin = `test-revoke-mgr-a-${RUN_SUFFIX}`;
    const mgrBLogin = `test-revoke-mgr-b-${RUN_SUFFIX}`;
    const orphanLogin = `test-revoke-orphan-${RUN_SUFFIX}`;
    createdUserLogins.push(mgrALogin, mgrBLogin, orphanLogin);

    const mgrACreate = await requestJson("POST", "/api/users", adminCookie, {
      agencyId: agencyAId, login: mgrALogin, name: "Manager A", email: `${mgrALogin}@example.test`, role: 1
    });
    const mgrBCreate = await requestJson("POST", "/api/users", adminCookie, {
      agencyId: agencyBId, login: mgrBLogin, name: "Manager B", email: `${mgrBLogin}@example.test`, role: 1
    });
    const mgrAPassword = (mgrACreate.body as { temporaryPassword: string }).temporaryPassword;
    const mgrBPassword = (mgrBCreate.body as { temporaryPassword: string }).temporaryPassword;

    // Fixture non atteignable via l'API existante (createUser exige toujours une
    // agence): utilisateur role "manager" mais sans rattachement, insere
    // directement pour couvrir le cas "Agence requise.".
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

    const pairingA1 = await requestJson("POST", "/api/agents/pairing-codes", cookieA, {});
    const pairingA2 = await requestJson("POST", "/api/agents/pairing-codes", cookieA, {});
    const codeA1 = (pairingA1.body as { pairing: { code: string } }).pairing.code;
    const codeA2 = (pairingA2.body as { pairing: { code: string } }).pairing.code;

    const agentA1 = await pairAgent(codeA1, "TEST-REVOKE-A1");
    const agentA2 = await pairAgent(codeA2, "TEST-REVOKE-A2");
    log("SETUP", `Agents appaires: A1=${agentA1.agentId}, A2=${agentA2.agentId}.`);

    // --- TC1: reproduction exacte du bug rapporte (aucun corps, aucun Content-Type) ---
    const tc1 = await requestNoBody("POST", `/api/agents/${agentA1.agentId}/revoke`, cookieA);
    assert(
      !tc1.rawText.includes("Cannot read properties"),
      "TC1: aucune TypeError renvoyee pour une requete de revocation sans corps"
    );
    assert(tc1.status === 200, `TC1: revocation par le proprietaire legitime -> 200 (recu ${tc1.status}: ${tc1.rawText})`);
    const tc1Agent = (tc1.body as { agent?: Record<string, unknown> } | null)?.agent;
    assert(tc1Agent?.status === "REVOKED", `TC1: status = REVOKED (recu ${tc1Agent?.status})`);
    assert(typeof tc1Agent?.revokedAt === "string" && Boolean(tc1Agent.revokedAt), "TC1: revokedAt renseigne");
    assertSanitized(tc1.body, "TC1: reponse assainie (sans token/secret/password/code_hash)");

    // --- TC2: double revocation, comportement controle et idempotent ---
    const tc2 = await requestJson("POST", `/api/agents/${agentA1.agentId}/revoke`, cookieA, {});
    assert(tc2.status === 200, `TC2: double revocation reste controlee -> 200 (recu ${tc2.status}: ${tc2.rawText})`);
    const tc2Agent = (tc2.body as { agent?: Record<string, unknown> } | null)?.agent;
    assert(tc2Agent?.status === "REVOKED", "TC2: status reste REVOKED apres double revocation");
    assertSanitized(tc2.body, "TC2: reponse assainie sur la double revocation");

    // --- TC3: utilisateur sans agence -> 400 "Agence requise." ---
    const tc3 = await requestJson("POST", `/api/agents/${agentA1.agentId}/revoke`, cookieOrphan, {});
    assert(tc3.status === 400, `TC3: utilisateur sans agence -> 400 (recu ${tc3.status})`);
    assert(
      (tc3.body as { error?: string } | null)?.error === "Agence requise.",
      `TC3: message "Agence requise." (recu ${JSON.stringify(tc3.body)})`
    );

    // --- TC4: agent d'une autre agence -> refus sans reveler d'information ---
    const tc4 = await requestJson("POST", `/api/agents/${agentA2.agentId}/revoke`, cookieB, {});
    assert([403, 404].includes(tc4.status), `TC4: agent d'une autre agence -> 403/404 (recu ${tc4.status})`);
    const tc4Snapshot = await requestJson("GET", `/api/agents`, cookieA, undefined);
    const stillActiveA2 = (tc4Snapshot.body as { agents: Array<{ agentId: number; status: string; revokedAt: string | null }> })
      .agents.find((a) => a.agentId === agentA2.agentId);
    assert(
      stillActiveA2?.status !== "REVOKED" && !stillActiveA2?.revokedAt,
      "TC4: l'agent A2 n'a pas ete revoque par la tentative inter-agence"
    );

    // --- TC5: agent inexistant -> 404 ---
    const tc5 = await requestJson("POST", `/api/agents/999999999/revoke`, cookieA, {});
    assert(tc5.status === 404, `TC5: agent inexistant -> 404 (recu ${tc5.status})`);

    // --- TC6: regression GET /api/agents et PATCH /api/agents/:id ---
    const tc6Get = await requestJson("GET", "/api/agents", cookieA, undefined);
    assert(tc6Get.status === 200, `TC6: GET /api/agents toujours fonctionnel (recu ${tc6Get.status})`);
    assertSanitized(tc6Get.body, "TC6: GET /api/agents toujours assaini");

    const tc6Patch = await requestJson("PATCH", `/api/agents/${agentA2.agentId}`, cookieA, { name: "A2 Renomme" });
    assert(tc6Patch.status === 200, `TC6: PATCH /api/agents/:id toujours fonctionnel (recu ${tc6Patch.status})`);
    assert(
      (tc6Patch.body as { agent?: { name?: string } } | null)?.agent?.name === "A2 Renomme",
      "TC6: PATCH applique bien le renommage (comportement inchange)"
    );
    assertSanitized(tc6Patch.body, "TC6: PATCH /api/agents/:id toujours assaini");

    // --- TC7: reconnexion Socket.IO d'un agent revoque refusee ---
    const reconnectResult = await attemptReconnect(agentA1.agentId, agentA1.token);
    assert(
      reconnectResult.outcome === "rejected",
      `TC7: reconnexion refusee pour l'agent revoque A1 (resultat: ${reconnectResult.outcome}${reconnectResult.reason ? `, raison: ${reconnectResult.reason}` : ""})`
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
