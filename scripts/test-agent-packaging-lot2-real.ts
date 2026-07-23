// Test REEL Phase 5 (Lot 2, section 16): verifie sur ce PC Windows le
// credential store DPAPI, la migration, le premier appairage SANS
// PowerShell (via l'interface locale HTTP), le verrou mono-instance et la
// politique de revocation - avec le VRAI runtime agent (tsx, pas encore le
// build compile: la variante "hors depot" avec le build compile est
// verifiee separement, cf. docs/agent-packaging.md).
//
// N'utilise le fixture/Chrome QUE si necessaire (ici: non - ce test se
// concentre sur l'identite/le stockage/le verrou, deja isoles du cycle de
// vie des bots, deja teste ailleurs). Utilise un serveur de test local, une
// agence/agent temporaires, des dossiers temporaires uniques.
//
// Mise a jour (correctif protocole post-Lot 2, voir docs/agent-packaging.md
// section 9.2/10) : AGENT_REVOKED et VERSION_INCOMPATIBLE sont desormais
// reellement distincts et atteignables via le protocole reel (authentication
// structuree cote serveur + validation de protocolVersion au handshake).
// Le scenario N (VERSION_INCOMPATIBLE) reste teste separement dans
// scripts/test-agent-protocol-auth-real.ts plutot que duplique ici.
//
// A executer UNIQUEMENT sur un PC Windows personnel avec une session
// interactive - JAMAIS sur la VM/serveur de production.
//
// Usage: npx tsx scripts/test-agent-packaging-lot2-real.ts
//    ou: npm run test:agent:packaging-lot2:real

import { ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pool } from "../src/db.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
const SERVER_PORT = 3300;

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

// Sur toute la duree du test, plusieurs agentId distincts peuvent se
// succeder pour le MEME computerName (chaque appairage reussi cree une
// nouvelle ligne "agents" cote serveur, cf. redeemPairingCode) - rechercher
// par computerName dans /api/agents renverrait potentiellement un agentId
// perime (deja dissocie localement mais toujours present, non revoque, cote
// serveur). Le dernier "Agent connecte: agentId=X" logue par le serveur
// identifie sans ambiguite la connexion ACTUELLE.
const extractLatestConnectedAgentId = (serverStdout: string[]): number | null => {
  const matches = [...serverStdout.join("").matchAll(/Agent connecte: agentId=(\d+)/g)];
  return matches.length > 0 ? Number(matches[matches.length - 1][1]) : null;
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

const localUiStatus = async (port: number): Promise<any> => {
  const res = await fetch(`http://127.0.0.1:${port}/local/status`);
  return res.json();
};

const localUiPost = async (port: number, route: string, nonce: string, extra?: Record<string, unknown>): Promise<{ status: number; body: any }> => {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nonce, ...extra })
  });
  return { status: res.status, body: await res.json() };
};

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL Phase 5 (Lot 2): DPAPI, appairage local, mono-instance, revocation ===");
  log("BOOT", "A executer sur un PC Windows personnel avec session interactive. JAMAIS sur la VM.");

  if (process.platform !== "win32") {
    console.log("Plateforme non-Windows: ce test necessite Windows (DPAPI reel). Ignore, 0 succes / 0 echec.");
    process.exit(0);
  }

  let server: ServerHandle | undefined;
  let agentA: RealAgentHandle | undefined;
  let agentB: RealAgentHandle | undefined;
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  const dataRoot = path.join(process.cwd(), `.test-lot2-real-data-${RUN_SUFFIX}`);
  const credentialsFile = path.join(dataRoot, "credentials", "agent-credentials.json");

  try {
    server = await startServer(SERVER_PORT, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });

    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyName = `Test Lot2 Real ${RUN_SUFFIX}`;
    agencyNames.push(agencyName);
    const agencyId = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
    const managerLogin = `test-lot2-real-${RUN_SUFFIX}`;
    managerLogins.push(managerLogin);
    const userRes = await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, {
      agencyId, login: managerLogin, name: "Real Lot2 Manager", email: `${managerLogin}@example.test`, role: 1
    });
    const managerPassword = userRes.body.temporaryPassword;
    const managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);

    // ===================== A. Premier lancement sans credentials =====================
    assert(!existsSync(credentialsFile), "Scenario A: aucun fichier de credentials avant le premier lancement");
    agentA = spawnRealAgent(server.baseUrl, dataRoot, "REAL-LOT2-PC");
    const gotPort = await waitUntil(() => extractLocalUiPort(agentA!.stdout) !== null, 10_000);
    if (!gotPort) throw new Error("TimeoutError: l'interface locale n'a jamais demarre.");
    const port = extractLocalUiPort(agentA.stdout)!;
    assert(true, `Scenario A: agent demarre sans credentials, interface locale sur le port ${port}`);

    // ===================== B. Interface locale ouverte =====================
    const statusBeforePair = await localUiStatus(port);
    assert(statusBeforePair.state === "NOT_PAIRED" && statusBeforePair.paired === false, "Scenario B: interface locale renvoie l'etat NOT_PAIRED avant appairage");
    assert(typeof statusBeforePair.nonce === "string" && statusBeforePair.nonce.length > 0, "Scenario B: un nonce de session est fourni");

    // ===================== C. Appairage reel via l'interface locale (jamais PowerShell/CLI) =====================
    const pairing1 = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const code1 = pairing1.body.pairing.code;
    const pairResult = await localUiPost(port, "/local/pair", statusBeforePair.nonce, { code: code1 });
    assert(pairResult.status === 200 && pairResult.body.ok === true, "Scenario C: appairage reussi via POST /local/pair (jamais PowerShell/CLI)");

    // ===================== D/E. Fichier DPAPI cree, jamais de token en clair =====================
    const dpapiReady = await waitUntil(() => existsSync(credentialsFile), 5_000);
    assert(dpapiReady, "Scenario D: le fichier de credentials proteges est cree");
    const rawContent = readFileSync(credentialsFile, "utf8");
    const parsedEnvelope = JSON.parse(rawContent);
    assert(parsedEnvelope.formatVersion === 1 && parsedEnvelope.protection === "windows-dpapi-current-user", "Scenario D: enveloppe versionnee DPAPI correcte");
    assert(typeof parsedEnvelope.protectedToken === "string" && !("token" in parsedEnvelope), "Scenario E: aucun champ 'token' en clair, uniquement 'protectedToken'");

    const connectedAfterPair = await waitUntil(async () => (await localUiStatus(port)).state === "CONNECTED", 10_000);
    assert(connectedAfterPair, "Scenario C (suite): l'agent atteint l'etat CONNECTED apres appairage");

    // ===================== F/G. Arret puis redemarrage, reconnexion via DPAPI =====================
    await killTree(agentA.child.pid);
    await sleep(1_000);
    agentA = spawnRealAgent(server.baseUrl, dataRoot, "REAL-LOT2-PC");
    const reconnected = await waitUntil(() => /Synchronisation terminee/.test(agentA!.stdout.join("")), 15_000, 300);
    assert(reconnected, "Scenario F/G: apres redemarrage, l'agent se reconnecte automatiquement via les identifiants DPAPI (sans nouveau code)");
    const portAfterRestart = await waitUntil(() => extractLocalUiPort(agentA!.stdout) !== null, 5_000) ? extractLocalUiPort(agentA.stdout)! : port;

    // ===================== H/I. Second lancement (verrou mono-instance) =====================
    agentB = spawnRealAgent(server.baseUrl, dataRoot, "REAL-LOT2-PC");
    const secondExitCode = await new Promise<number | null>((resolve) => agentB!.child.on("exit", resolve));
    assert(secondExitCode === 0, "Scenario H/I: le second lancement (meme dataRoot) se termine avec le code 0");
    assert(/deja active/.test(agentB.stdout.join("")), "Scenario I: le second lancement detecte l'instance existante (jamais une erreur technique brute)");

    // ===================== J. Dissociation locale =====================
    const statusBeforeUnpair = await localUiStatus(portAfterRestart);
    const unpairResult = await localUiPost(portAfterRestart, "/local/unpair", statusBeforeUnpair.nonce);
    assert(unpairResult.status === 200, "Scenario J: POST /local/unpair reussit");
    const unpairedFileGone = await waitUntil(() => !existsSync(credentialsFile), 5_000);
    assert(unpairedFileGone, "Scenario J: le fichier de credentials est supprime apres dissociation locale");
    const statusAfterUnpair = await localUiStatus(portAfterRestart);
    assert(statusAfterUnpair.state === "NOT_PAIRED" && statusAfterUnpair.paired === false, "Scenario J: l'interface locale repasse a NOT_PAIRED");

    // ===================== K. Nouvel appairage (meme process, apres dissociation) =====================
    const pairing2 = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const code2 = pairing2.body.pairing.code;
    const rePairResult = await localUiPost(portAfterRestart, "/local/pair", statusAfterUnpair.nonce, { code: code2 });
    assert(rePairResult.status === 200 && rePairResult.body.ok === true, "Scenario K: nouvel appairage reussi sur le MEME process apres dissociation");
    const reconnectedAfterRepair = await waitUntil(async () => (await localUiStatus(portAfterRestart)).state === "CONNECTED", 10_000);
    assert(reconnectedAfterRepair, "Scenario K (suite): reconnexion reelle confirmee apres re-appairage");

    // ===================== L/M. Revocation distante =====================
    // Identifie l'agentId de la connexion COURANTE via le dernier log serveur
    // (jamais une recherche par computerName, qui pourrait cibler un agentId
    // perime d'un appairage precedent dans ce meme test - voir
    // extractLatestConnectedAgentId).
    const currentAgentId = extractLatestConnectedAgentId(server.stdout);
    if (!currentAgentId) throw new Error("Agent REAL-LOT2-PC introuvable (aucun log de connexion) pour la revocation.");
    const revokeResult = await requestJson(server.baseUrl, "POST", `/api/agents/${currentAgentId}/revoke`, managerCookie, {});
    assert(revokeResult.status === 200, "Scenario L: revocation distante acceptee par le serveur");

    const revokedLocally = await waitUntil(async () => {
      const s = await localUiStatus(portAfterRestart);
      return s.state === "NOT_PAIRED";
    }, 20_000, 500);
    // Correctif protocole (voir docs/agent-packaging.md section 9.2/10): la
    // reconnexion d'un agent revoque produit desormais AGENT_REVOKED, distinct
    // d'INVALID_TOKEN - couverture dediee dans test-agent-protocol-auth-real.ts.
    assert(revokedLocally, "Scenario L (suite): l'agent detecte la revocation (AGENT_REVOKED a la reconnexion) et repasse NOT_PAIRED");
    const credentialsGoneAfterRevoke = await waitUntil(() => !existsSync(credentialsFile), 5_000);
    assert(credentialsGoneAfterRevoke, "Scenario M: les credentials locaux sont supprimes apres revocation confirmee");

    log("INFO", "Scenario N (VERSION_INCOMPATIBLE) couvert separement par test-agent-protocol-auth-real.ts (correctif protocole ulterieur, voir docs/agent-packaging.md section 9.2/10).");
  } finally {
    // ===================== O. Nettoyage =====================
    await killTree(agentA?.child.pid).catch(() => undefined);
    await killTree(agentB?.child.pid).catch(() => undefined);
    if (server) {
      await killTree(server.child.pid).catch(() => undefined);
    }
    if (existsSync(dataRoot)) {
      try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* best effort */ }
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
