// Test REEL Phase 5 (Lot 2, section 17): construit le build agent compile
// (agent-package-win.ps1, incluant desormais le credential store DPAPI,
// l'interface locale et le verrou mono-instance), le copie HORS du depot,
// puis verifie avec ce build copie: premier appairage via l'interface locale
// (jamais PowerShell/CLI), redemarrage + reconnexion DPAPI, verrou
// mono-instance, et l'absence totale d'ecriture dans le dossier "programme"
// copie pendant tout le cycle - uniquement le dataRoot de test recoit des
// donnees.
//
// A executer UNIQUEMENT sur un PC Windows personnel avec une session
// interactive - JAMAIS sur la VM/serveur de production.
//
// Usage: npx tsx scripts/test-agent-packaging-lot2-outside-repo.ts

import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pool } from "../src/db.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();
const SERVER_PORT = 3301;

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

type ServerHandle = { child: ChildProcess; baseUrl: string };

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
  child.stdout?.on("data", (c: Buffer) => log("SERVER", c.toString().trim()));
  child.stderr?.on("data", (c: Buffer) => log("SERVER-ERR", c.toString().trim()));
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  return { child, baseUrl };
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

const runBuild = (root: string, args: string[]): Promise<number> => new Promise((resolve) => {
  const child = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-File", "scripts/agent-package-win.ps1", ...args], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (c: Buffer) => log("BUILD", c.toString().trim()));
  child.stderr?.on("data", (c: Buffer) => log("BUILD-ERR", c.toString().trim()));
  child.on("exit", (code) => resolve(code ?? 1));
});

const snapshotDir = (root: string): Map<string, number> => {
  const snapshot = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      snapshot.set(path.relative(root, full), statSync(full).mtimeMs);
    }
  };
  walk(root);
  return snapshot;
};

type RealAgentHandle = { child: ChildProcess; stdout: string[] };

const spawnCompiledAgent = (cwd: string, serverUrl: string, dataRoot: string): RealAgentHandle => {
  const child = spawn("node", ["agent/agentMain.js"], {
    cwd,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      AGENT_SERVER_URL: serverUrl,
      AGENT_DATA_DIR: dataRoot,
      AGENT_COMPUTER_NAME: "REAL-LOT2-OUTSIDE-PC",
      AGENT_RUNTIME_MODE: "packaged",
      AGENT_TARGET_MODE: "fixture",
      AGENT_FIXTURE_URL: "about:blank",
      AGENT_MAX_ACTIVE_BOTS: "5",
      AGENT_RECONNECT_MIN_DELAY_MS: "500",
      AGENT_RECONNECT_MAX_DELAY_MS: "3000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout: string[] = [];
  child.stdout?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("AGENT", t.trim()); });
  child.stderr?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("AGENT-ERR", t.trim()); });
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

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL Phase 5 (Lot 2): build compile execute hors du depot ===");

  if (process.platform !== "win32") {
    console.log("Plateforme non-Windows: ce test necessite Windows. Ignore, 0 succes / 0 echec.");
    process.exit(0);
  }

  const root = path.resolve(process.cwd());
  let server: ServerHandle | undefined;
  let agent: RealAgentHandle | undefined;
  let agentSecondInstance: RealAgentHandle | undefined;
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];
  const outsideRoot = path.join(os.tmpdir(), `rendezbot-lot2-outside-${RUN_SUFFIX}`);
  const installedAppDir = path.join(outsideRoot, "installed-app");
  const dataRoot = path.join(outsideRoot, "agent-data");

  try {
    log("BUILD", "Construction du build agent (Lot 1+2, -SkipTests: non-regression deja verifiee ailleurs)...");
    const buildCode = await runBuild(root, ["-SkipTests"]);
    if (buildCode !== 0) throw new Error(`Le build agent a echoue (code ${buildCode}).`);
    const builtAppDir = path.join(root, "release", "agent-win", "app");
    if (!existsSync(path.join(builtAppDir, "agent", "agentMain.js"))) throw new Error("agentMain.js compile introuvable apres le build.");

    mkdirSync(outsideRoot, { recursive: true });
    const copyCode = await new Promise<number>((resolve) => {
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Copy-Item -Path '${builtAppDir}' -Destination '${installedAppDir}' -Recurse`]);
      child.on("exit", (code) => resolve(code ?? 1));
    });
    if (copyCode !== 0 || !existsSync(path.join(installedAppDir, "agent", "agentMain.js"))) throw new Error("Copie du build hors du depot a echoue.");
    assert(true, "Build compile (Lot 1+2) copie avec succes hors du depot");

    const snapshotBefore = snapshotDir(installedAppDir);

    server = await startServer(SERVER_PORT, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);
    const agencyName = `Test Lot2 Outside ${RUN_SUFFIX}`;
    agencyNames.push(agencyName);
    const agencyId = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
    const managerLogin = `test-lot2-outside-${RUN_SUFFIX}`;
    managerLogins.push(managerLogin);
    const userRes = await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, {
      agencyId, login: managerLogin, name: "Outside Manager", email: `${managerLogin}@example.test`, role: 1
    });
    const managerPassword = userRes.body.temporaryPassword;
    const managerCookie = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);

    // ===================== Premier appairage via l'interface locale =====================
    agent = spawnCompiledAgent(installedAppDir, server.baseUrl, dataRoot);
    const gotPort = await waitUntil(() => extractLocalUiPort(agent!.stdout) !== null, 10_000);
    if (!gotPort) throw new Error("TimeoutError: interface locale jamais demarree (build compile).");
    const port = extractLocalUiPort(agent.stdout)!;

    const status1 = await localUiStatus(port);
    assert(status1.state === "NOT_PAIRED", "Build compile: premier lancement sans credentials -> NOT_PAIRED");

    const pairing = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    const pairResult = await localUiPost(port, "/local/pair", status1.nonce, { code: pairing.body.pairing.code });
    assert(pairResult.status === 200 && pairResult.body.ok === true, "Build compile: appairage reussi via l'interface locale (jamais PowerShell/CLI)");

    const credPath = path.join(dataRoot, "credentials", "agent-credentials.json");
    assert(existsSync(credPath), "Build compile: fichier de credentials DPAPI cree dans le dataRoot de test");

    const connected = await waitUntil(async () => (await localUiStatus(port)).state === "CONNECTED", 10_000);
    assert(connected, "Build compile: etat CONNECTED atteint apres appairage");

    // ===================== Redemarrage + reconnexion DPAPI =====================
    await killTree(agent.child.pid);
    await sleep(1_000);
    agent = spawnCompiledAgent(installedAppDir, server.baseUrl, dataRoot);
    const reconnected = await waitUntil(() => /Synchronisation terminee/.test(agent!.stdout.join("")), 15_000, 300);
    assert(reconnected, "Build compile: reconnexion automatique via DPAPI apres redemarrage (aucun nouveau code)");

    // ===================== Mono-instance =====================
    agentSecondInstance = spawnCompiledAgent(installedAppDir, server.baseUrl, dataRoot);
    const secondExit = await new Promise<number | null>((resolve) => agentSecondInstance!.child.on("exit", resolve));
    assert(secondExit === 0, "Build compile: second lancement (meme dataRoot) se termine avec le code 0");
    assert(/deja active/.test(agentSecondInstance.stdout.join("")), "Build compile: second lancement detecte l'instance existante");

    // ===================== Arret propre + verification "aucune ecriture programme" =====================
    await killTree(agent.child.pid);
    await sleep(500);

    const snapshotAfter = snapshotDir(installedAppDir);
    let writesDetected = snapshotAfter.size !== snapshotBefore.size;
    for (const [relPath, mtime] of snapshotBefore) {
      if (snapshotAfter.get(relPath) !== mtime) writesDetected = true;
    }
    assert(!writesDetected, "Build compile: aucune ecriture dans le dossier programme copie pendant tout le cycle (appairage, redemarrage, mono-instance)");
    assert(existsSync(path.join(dataRoot, "logs")) && existsSync(path.join(dataRoot, "credentials")), "Build compile: toutes les donnees restent dans le dataRoot de test");
  } finally {
    await killTree(agent?.child.pid).catch(() => undefined);
    await killTree(agentSecondInstance?.child.pid).catch(() => undefined);
    if (server) {
      await killTree(server.child.pid).catch(() => undefined);
    }
    if (existsSync(outsideRoot)) {
      try { rmSync(outsideRoot, { recursive: true, force: true }); } catch { /* best effort */ }
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
