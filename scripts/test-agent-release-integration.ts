// Test INTEGRATION Phase 5 (Lot 4, section 12): serveur local reel, une
// agence/un utilisateur temporaires PAR agence (pour verifier l'absence de
// fuite cross-agence), un dossier de releases temporaire avec un artefact
// factice et un manifeste valide - verifie la connexion, la lecture des
// metadonnees, le telechargement complet, le hash du fichier telecharge, le
// Content-Length, l'absence de fuite cross-agence, et un nettoyage final
// sans port ni process residuel.
//
// Distinct de test-agent-release-simulated.ts (qui couvre exhaustivement les
// cas limites/de securite) : ce test-ci prouve le cycle de vie complet bout
// en bout, une seule fois, proprement.
//
// Usage: npx tsx scripts/test-agent-release-integration.ts
//    ou: npm run test:agent:release:integration

import { createHash } from "node:crypto";
import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const RUN_SUFFIX = Date.now();
const SERVER_PORT = 3315;
const ROOT = path.resolve(process.cwd());
const SCRATCH_ROOT = path.join(ROOT, `.test-release-integration-${RUN_SUFFIX}`);
const RELEASES_DIR = path.join(SCRATCH_ROOT, "releases");
const RELEASE_VERSION = "1.2.3";

let passCount = 0;
let failCount = 0;
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
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
  throw new Error("TimeoutError: le serveur de test n'a jamais repondu.");
};
const startServer = async (port: number, env: Record<string, string>): Promise<ServerHandle> => {
  const child = spawn("npx.cmd", ["tsx", "src/server.ts"], {
    env: { ...process.env, WEB_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true
  });
  child.stdout?.on("data", (c: Buffer) => log("SERVER", c.toString().trim()));
  child.stderr?.on("data", (c: Buffer) => log("SERVER-ERR", c.toString().trim()));
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  return { child, baseUrl };
};
const killTree = (pid: number | undefined): Promise<void> => new Promise((resolve) => {
  if (!pid) { resolve(); return; }
  const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
  k.once("exit", () => resolve());
  k.once("error", () => resolve());
});
const isPortListening = (port: number): Promise<boolean> => new Promise((resolve) => {
  const child = spawn("powershell", ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue) -ne $null`]);
  let output = "";
  child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
  child.on("exit", () => resolve(output.trim().toLowerCase() === "true"));
  child.on("error", () => resolve(false));
});

const requestJson = async (baseUrl: string, method: string, pathName: string, cookie: string | undefined, json?: unknown): Promise<{ status: number; body: any; cookie?: string }> => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(json ?? {}) } : {})
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, cookie: res.headers.get("set-cookie")?.split(";")[0] };
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

const createFakeRelease = (): { fileName: string; sha256: string; size: number } => {
  const versionDir = path.join(RELEASES_DIR, RELEASE_VERSION);
  mkdirSync(versionDir, { recursive: true });
  const fileName = `RendezBotAgentSetup-${RELEASE_VERSION}.exe`;
  const content = Buffer.from(`FAKE-INSTALLER-INTEGRATION-${RUN_SUFFIX}-${"x".repeat(2048)}`);
  writeFileSync(path.join(versionDir, fileName), content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const manifest = {
    product: "RendezBot Agent",
    agentVersion: RELEASE_VERSION,
    protocolVersion: 1,
    commit: "deadbeef0000",
    builtAt: "2026-01-01T00:00:00.000Z",
    architecture: "x64",
    packaging: "embedded-node-copy",
    installer: "inno-setup",
    signed: false,
    files: [{ name: `windows/${fileName}`, sha256, size: content.length }]
  };
  writeFileSync(path.join(versionDir, "build-manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(versionDir, "SHA256SUMS.txt"), `${sha256}  windows/${fileName}\n`);
  return { fileName, sha256, size: content.length };
};

const main = async (): Promise<void> => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  let server: ServerHandle | undefined;
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];

  try {
    const artefact = createFakeRelease();
    log("SETUP", `Artefact factice cree: ${artefact.fileName} (${artefact.size} octets, sha256=${artefact.sha256}).`);

    server = await startServer(SERVER_PORT, {
      AGENT_UI_ENABLED: "true",
      AGENT_RELEASES_DIR: RELEASES_DIR,
      AGENT_RELEASE_VERSION: RELEASE_VERSION
    });

    // ===================== Connexion =====================
    const adminCookie = await loginWithRetry(server.baseUrl, "admin", "HtlsH2030*");
    assert(true, "Connexion admin reussie");

    // ===================== Deux agences distinctes (verification cross-agence) =====================
    const agencyAName = `Test Release Int A ${RUN_SUFFIX}`;
    const agencyBName = `Test Release Int B ${RUN_SUFFIX}`;
    agencyNames.push(agencyAName, agencyBName);
    const agencyA = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyAName, maxActiveClients: 15 })).body.agency;
    const agencyB = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyBName, maxActiveClients: 15 })).body.agency;

    const loginA = `test-rel-int-a-${RUN_SUFFIX}`;
    const loginB = `test-rel-int-b-${RUN_SUFFIX}`;
    managerLogins.push(loginA, loginB);
    const userA = (await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, { agencyId: agencyA.id, login: loginA, name: "Manager A", email: `${loginA}@example.test`, role: 1 })).body;
    const userB = (await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, { agencyId: agencyB.id, login: loginB, name: "Manager B", email: `${loginB}@example.test`, role: 1 })).body;
    const cookieA = await loginWithRetry(server.baseUrl, loginA, userA.temporaryPassword);
    const cookieB = await loginWithRetry(server.baseUrl, loginB, userB.temporaryPassword);

    // ===================== Lecture metadata (agence A) =====================
    const metaA = await requestJson(server.baseUrl, "GET", "/api/agent/releases/latest", cookieA);
    assert(metaA.status === 200 && metaA.body.available === true, "Lecture metadata (agence A) reussie");
    assert(metaA.body.version === RELEASE_VERSION, "Metadata: version correcte");
    assert(!JSON.stringify(metaA.body).includes(agencyBName), "Metadata (agence A): aucune information de l'agence B");

    // ===================== Lecture metadata (agence B) - MEME release, jamais de scoping par agence sur le binaire =====================
    const metaB = await requestJson(server.baseUrl, "GET", "/api/agent/releases/latest", cookieB);
    assert(metaB.status === 200 && metaB.body.sha256 === metaA.body.sha256, "Lecture metadata (agence B): meme release, meme hash (le binaire n'est jamais scope par agence)");
    assert(!JSON.stringify(metaB.body).includes(agencyAName), "Metadata (agence B): aucune information de l'agence A");

    // ===================== Telechargement complet (agence A) =====================
    const downloadRes = await fetch(`${server.baseUrl}${metaA.body.downloadUrl}`, { headers: { Cookie: cookieA } });
    assert(downloadRes.status === 200, "Telechargement complet reussi (agence A)");
    assert(downloadRes.headers.get("content-length") === String(artefact.size), "Content-Length correct");
    const downloadedBuffer = Buffer.from(await downloadRes.arrayBuffer());
    assert(downloadedBuffer.length === artefact.size, "Taille du fichier telecharge correcte");
    const downloadedSha256 = createHash("sha256").update(downloadedBuffer).digest("hex");
    assert(downloadedSha256 === artefact.sha256, "Hash du fichier telecharge identique au hash declare/attendu");

    // ===================== Telechargement complet (agence B) - meme binaire accessible =====================
    const downloadResB = await fetch(`${server.baseUrl}${metaB.body.downloadUrl}`, { headers: { Cookie: cookieB } });
    assert(downloadResB.status === 200, "Telechargement complet reussi (agence B, meme binaire generique)");
    const downloadedBufferB = Buffer.from(await downloadResB.arrayBuffer());
    assert(createHash("sha256").update(downloadedBufferB).digest("hex") === artefact.sha256, "Hash identique pour l'agence B (meme fichier, pas de version differenciee par agence)");
  } finally {
    // ===================== Nettoyage =====================
    const pid = server?.child.pid;
    await killTree(pid).catch(() => undefined);
    const portFreed = await waitUntil(async () => !(await isPortListening(SERVER_PORT)), 10_000);
    assert(portFreed, "Aucun port residuel apres nettoyage");

    if (existsSync(SCRATCH_ROOT)) {
      try { rmSync(SCRATCH_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    assert(!existsSync(SCRATCH_ROOT), "Dossier de releases temporaire integralement supprime");

    try {
      const { pool } = await import("../src/db.js");
      if (managerLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [managerLogins]);
      if (agencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [agencyNames]);
      await pool.end();
    } catch (error) {
      log("CLEANUP-ERR", `Nettoyage base de donnees incomplet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
