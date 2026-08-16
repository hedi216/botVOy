// HOTFIX CIBLE - Suppression complete de "Arreter ce serveur".
//
// L'ancienne fonctionnalite (bouton "Arreter ce serveur" + evenement
// Socket.IO "shutdown-server" + handler backend appelant server.close/
// process.exit) est retiree integralement: UI, JS frontend, handler
// backend. "Arreter les navigateurs" (stop-all-sessions) reste inchangee.
//
// Teste UNIQUEMENT ce retrait: verification structurelle du HTML/JS/backend
// (le code source ne contient plus aucune reference fonctionnelle), et
// verification comportementale (un evenement "shutdown-server" manuel
// n'arrete plus le serveur, "stop-all-sessions" continue de fonctionner).
//
// Usage: npx tsx scripts/test-remove-shutdown-server-simulated.ts

import { ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { io as ioClient, Socket } from "socket.io-client";
import { ADMIN_LOGIN, ADMIN_PASSWORD, pool } from "../src/db.js";

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ===================== TEST A/B/C: verification structurelle (sources) =====================

const runStaticSourceTests = (): void => {
  log("TEST-A", "=== HTML: le bouton 'Arreter ce serveur' a disparu ===");
  const indexHtml = readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");
  assert(!indexHtml.includes('id="shutdownServer"'), "A) public/index.html ne contient plus id=\"shutdownServer\"");
  assert(!indexHtml.includes("Arreter ce serveur") && !indexHtml.includes("Arrêter ce serveur"), "A) public/index.html ne contient plus le texte \"Arreter ce serveur\"");
  assert(indexHtml.includes('id="stopAllSessions"') && indexHtml.includes("Arreter les navigateurs"), "A) public/index.html conserve bien le bouton \"Arreter les navigateurs\"");

  log("TEST-B", "=== Frontend JS: aucun acces DOM ni emission liee a shutdown-server ===");
  const appJs = readFileSync(path.join(process.cwd(), "public", "app.js"), "utf8");
  assert(!appJs.includes("shutdownServer"), "B) public/app.js ne contient plus la cle \"shutdownServer\"");
  assert(!appJs.includes('"shutdown-server"'), "B) public/app.js ne contient plus socket.emit(\"shutdown-server\")");
  assert(appJs.includes('els.stopAllSessions.addEventListener("click"'), "B) public/app.js conserve bien le listener de \"stopAllSessions\"");

  log("TEST-C", "=== Backend: plus de listener applicatif socket.on(\"shutdown-server\", ...) ===");
  const serverTs = readFileSync(path.join(process.cwd(), "src", "server.ts"), "utf8");
  assert(!serverTs.includes('"shutdown-server"'), "C) src/server.ts ne contient plus socket.on(\"shutdown-server\", ...)");
  assert(serverTs.includes('socket.on("stop-all-sessions"'), "C) src/server.ts conserve bien socket.on(\"stop-all-sessions\", ...)");
  // Garde-fou explicite du hotfix: les VRAIS mecanismes d'arret de process
  // (hors chemin applicatif shutdown-server) doivent rester intacts.
  assert(serverTs.includes('process.once("SIGINT"'), "C) src/server.ts conserve le handler SIGINT (arret normal du process, hors perimetre)");
  assert(serverTs.includes('process.once("SIGTERM"'), "C) src/server.ts conserve le handler SIGTERM (arret normal du process, hors perimetre)");
  assert(serverTs.includes('process.once("exit", cleanupServerLock)'), "C) src/server.ts conserve le nettoyage cleanupServerLock sur exit (hors perimetre)");
};

// ===================== Serveur reel (TEST D/E) =====================

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
    env: { ...process.env, WEB_PORT: String(port) },
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

const openUiSocket = (baseUrl: string, cookie: string): Promise<Socket> => new Promise((resolve, reject) => {
  const socket = ioClient(baseUrl, { autoConnect: false, reconnection: false, forceNew: true, extraHeaders: { Cookie: cookie } });
  const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion socket UI.")); }, 8_000);
  socket.on("connect", () => { clearTimeout(t); resolve(socket); });
  socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
  socket.connect();
});

// ===================== TEST D: evenement manuel shutdown-server =====================

const runManualShutdownEventTest = async (server: ServerHandle, adminCookie: string): Promise<void> => {
  log("TEST-D", '=== Un client authentifie emet manuellement "shutdown-server" -> le serveur ne s\'arrete PAS ===');
  const socket = await openUiSocket(server.baseUrl, adminCookie);
  try {
    assert(server.child.exitCode === null && !server.child.killed, "D) Precondition: le processus serveur est bien vivant avant l'emission");

    socket.emit("shutdown-server");
    await sleep(1_500);

    assert(server.child.exitCode === null && !server.child.killed, 'D) Le processus serveur est toujours vivant apres l\'emission manuelle de "shutdown-server" (aucun handler ne l\'ecoute plus)');

    const after = await fetch(`${server.baseUrl}/api/me`);
    assert(after.status === 401 || after.status === 200, `D) Une requete HTTP suivante recoit toujours une reponse normale (recu: ${after.status})`);

    assert(socket.connected, "D) La socket elle-meme n'a pas ete coupee de force par le serveur suite a cet evenement");
  } finally {
    socket.disconnect();
  }
};

// ===================== TEST E: stop-all-sessions non regresse =====================

const runStopAllSessionsRegressionTest = async (server: ServerHandle, adminCookie: string): Promise<void> => {
  log("TEST-E", '=== "Arreter les navigateurs" (stop-all-sessions) reste fonctionnel: le chemin existe encore, serveur reste vivant ===');
  const socket = await openUiSocket(server.baseUrl, adminCookie);
  try {
    const maintenanceEvents: unknown[] = [];
    socket.on("maintenance", (payload: unknown) => maintenanceEvents.push(payload));

    socket.emit("stop-all-sessions");
    await sleep(1_000);

    assert(maintenanceEvents.length > 0, 'E) "stop-all-sessions" execute bien jusqu\'au bout (un evenement "maintenance" est renvoye, meme sans session active)');
    assert(server.child.exitCode === null && !server.child.killed, 'E) Le serveur web reste actif apres "stop-all-sessions" (contrairement a l\'ancien "shutdown-server")');

    const after = await fetch(`${server.baseUrl}/api/me`);
    assert(after.status === 401 || after.status === 200, `E) Le serveur repond toujours normalement apres "stop-all-sessions" (recu: ${after.status})`);
  } finally {
    socket.disconnect();
  }
};

// ===================== main =====================

const run = async (): Promise<void> => {
  runStaticSourceTests();

  let server: ServerHandle | undefined;
  try {
    server = await startServer(3407);
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    await runManualShutdownEventTest(server, adminCookie);
    await runStopAllSessionsRegressionTest(server, adminCookie);
  } finally {
    if (server) await stopServer(server);
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
