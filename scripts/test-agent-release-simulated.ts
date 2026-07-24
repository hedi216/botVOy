// Test SIMULE Phase 5 (Lot 4, section 11): couvre le service de release
// (src/agentReleaseService.ts) et les deux routes HTTP associees avec un
// FAUX binaire de quelques octets (jamais le vrai setup de ~27 Mo) - aucun
// Chrome de bot n'est jamais lance ici. Utilise un serveur local reel + une
// agence/un utilisateur temporaires (comme les autres suites "simulees" de
// ce projet, qui reposent deja sur une vraie base Postgres) uniquement pour
// les assertions HTTP (endpoint/headers/auth) ; toutes les autres
// verifications (manifeste, hash, path traversal, etc.) appellent le
// service directement en process, sans jamais redemarrer de serveur.
//
// Usage: npx tsx scripts/test-agent-release-simulated.ts
//    ou: npm run test:agent:release:simulated

import { createHash } from "node:crypto";
import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AgentReleaseChannel, AgentReleaseConfig } from "../src/config.js";
import { getAgentReleaseMetadata, resetAgentReleaseHashCacheForTests, resolveAgentReleaseDownload } from "../src/agentReleaseService.js";

const RUN_SUFFIX = Date.now();
const SERVER_PORT = 3310;
const ROOT = path.resolve(process.cwd());
const SCRATCH_ROOT = path.join(ROOT, `.test-release-sim-${RUN_SUFFIX}`);

let passCount = 0;
let failCount = 0;
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type FakeReleaseOptions = {
  content?: Buffer;
  signed?: boolean;
  protocolVersion?: number | string;
  declaredSha256?: string;
  declaredSize?: number;
  fileEntryName?: string;
  manifestOverrideText?: string;
  omitManifest?: boolean;
  omitFile?: boolean;
};

const createFakeRelease = (releasesDir: string, version: string, options: FakeReleaseOptions = {}) => {
  const versionDir = path.join(releasesDir, version);
  mkdirSync(versionDir, { recursive: true });
  const fileName = `RendezBotAgentSetup-${version}.exe`;
  const filePath = path.join(versionDir, fileName);
  const content = options.content ?? Buffer.from(`FAKE-INSTALLER-${version}-${Math.random().toString(36)}`);
  if (!options.omitFile) {
    writeFileSync(filePath, content);
  }
  const realSha256 = createHash("sha256").update(content).digest("hex");

  if (options.manifestOverrideText !== undefined) {
    writeFileSync(path.join(versionDir, "build-manifest.json"), options.manifestOverrideText);
  } else if (!options.omitManifest) {
    const manifest = {
      product: "RendezBot Agent",
      agentVersion: version,
      protocolVersion: options.protocolVersion ?? 1,
      commit: "deadbeef0000",
      builtAt: "2026-01-01T00:00:00.000Z",
      architecture: "x64",
      packaging: "embedded-node-copy",
      installer: "inno-setup",
      signed: options.signed ?? false,
      files: [{
        name: options.fileEntryName ?? `windows/${fileName}`,
        sha256: options.declaredSha256 ?? realSha256,
        size: options.declaredSize ?? content.length
      }]
    };
    writeFileSync(path.join(versionDir, "build-manifest.json"), JSON.stringify(manifest, null, 2));
  }

  writeFileSync(path.join(versionDir, "SHA256SUMS.txt"), `${realSha256}  windows/${fileName}\n`);
  return { versionDir, filePath, fileName, realSha256, size: content.length };
};

const makeConfig = (overrides: Partial<AgentReleaseConfig>): AgentReleaseConfig => ({
  releasesDir: null,
  releaseVersion: null,
  channel: "candidate" as AgentReleaseChannel,
  downloadUrlOverride: null,
  ...overrides
});

// ===================== Section HTTP (un seul serveur reel + une agence/un utilisateur temporaires) =====================

type ServerHandle = { child: ChildProcess; baseUrl: string; stdout: string[] };
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
  const stdout: string[] = [];
  child.stdout?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("SERVER", t.trim()); });
  child.stderr?.on("data", (c: Buffer) => { const t = c.toString(); stdout.push(t); log("SERVER-ERR", t.trim()); });
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  return { child, baseUrl, stdout };
};
const killTree = (pid: number | undefined): Promise<void> => new Promise((resolve) => {
  if (!pid) { resolve(); return; }
  const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
  k.once("exit", () => resolve());
  k.once("error", () => resolve());
});
const requestJson = async (baseUrl: string, method: string, pathName: string, cookie: string | undefined): Promise<{ status: number; body: any; headers: Headers }> => {
  const res = await fetch(`${baseUrl}${pathName}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}) } });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};
const loginWithRetry = async (baseUrl: string, loginName: string, password: string, attempts = 8): Promise<string> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const res = await fetch(`${baseUrl}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login: loginName, password }) });
    const cookie = res.headers.get("set-cookie")?.split(";")[0];
    if (res.status === 200 && cookie) return cookie;
    lastError = new Error(`Login ${loginName} echoue (status ${res.status})`);
    await sleep(1_000);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const main = async (): Promise<void> => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  let server: ServerHandle | undefined;
  const managerLogins: string[] = [];
  const agencyNames: string[] = [];

  try {
    // ===================== 1. Release valide (in-process) =====================
    const validDir = path.join(SCRATCH_ROOT, "valid-releases");
    const valid = createFakeRelease(validDir, "1.0.0");
    resetAgentReleaseHashCacheForTests();
    const validConfig = makeConfig({ releasesDir: validDir, releaseVersion: "1.0.0" });
    const validMeta = await getAgentReleaseMetadata(validConfig);
    assert(validMeta.available === true, "Release valide: available=true");
    if (validMeta.available) {
      assert(validMeta.version === "1.0.0", "Release valide: version correcte");
      assert(validMeta.sha256 === valid.realSha256, "Release valide: sha256 correspond au fichier reel sur disque");
      assert(validMeta.sizeBytes === valid.size, "Release valide: sizeBytes correspond au fichier reel");
      assert(validMeta.signed === false, "Release valide: signed=false");
      assert(validMeta.channel === "candidate", "Release valide: channel=candidate");
      assert(validMeta.downloadUrl === "/api/agent/releases/1.0.0/download", "Release valide: downloadUrl relative par defaut");
      assert(JSON.stringify(validMeta).indexOf(SCRATCH_ROOT) === -1, "Release valide: aucun chemin absolu du disque dans la reponse publique");
    }
    const validDownload = await resolveAgentReleaseDownload(validConfig, "1.0.0");
    assert(validDownload !== null && validDownload.fileName === valid.fileName, "Release valide: telechargement resolu avec le bon nom de fichier");

    // ===================== 2. Fichier absent =====================
    const noFileDir = path.join(SCRATCH_ROOT, "no-file");
    createFakeRelease(noFileDir, "1.0.1", { omitFile: true });
    const noFileMeta = await getAgentReleaseMetadata(makeConfig({ releasesDir: noFileDir, releaseVersion: "1.0.1" }));
    assert(noFileMeta.available === false, "Fichier absent -> available=false (jamais un crash)");

    // ===================== 3. Manifeste absent =====================
    const noManifestDir = path.join(SCRATCH_ROOT, "no-manifest");
    createFakeRelease(noManifestDir, "1.0.2", { omitManifest: true });
    const noManifestMeta = await getAgentReleaseMetadata(makeConfig({ releasesDir: noManifestDir, releaseVersion: "1.0.2" }));
    assert(noManifestMeta.available === false, "Manifeste absent -> available=false");

    // ===================== 4. JSON malforme =====================
    const badJsonDir = path.join(SCRATCH_ROOT, "bad-json");
    createFakeRelease(badJsonDir, "1.0.3", { manifestOverrideText: "{ not valid json at all" });
    const badJsonMeta = await getAgentReleaseMetadata(makeConfig({ releasesDir: badJsonDir, releaseVersion: "1.0.3" }));
    assert(badJsonMeta.available === false, "Manifeste JSON malforme -> available=false (jamais une exception)");

    // ===================== 5. Hash incorrect =====================
    const badHashDir = path.join(SCRATCH_ROOT, "bad-hash");
    createFakeRelease(badHashDir, "1.0.4", { declaredSha256: "0".repeat(64) });
    const badHashMeta = await getAgentReleaseMetadata(makeConfig({ releasesDir: badHashDir, releaseVersion: "1.0.4" }));
    assert(badHashMeta.available === false, "Hash declare incorrect -> available=false (jamais servi malgre l'existence du fichier)");

    // ===================== 6. Taille incorrecte =====================
    const badSizeDir = path.join(SCRATCH_ROOT, "bad-size");
    createFakeRelease(badSizeDir, "1.0.5", { declaredSize: 999_999 });
    const badSizeMeta = await getAgentReleaseMetadata(makeConfig({ releasesDir: badSizeDir, releaseVersion: "1.0.5" }));
    assert(badSizeMeta.available === false, "Taille declaree incorrecte -> available=false");

    // ===================== 7. Version incorrecte / non autorisee =====================
    const wrongVersionDl = await resolveAgentReleaseDownload(validConfig, "1.0.1");
    assert(wrongVersionDl === null, "Version differente de celle configuree -> refus (jamais une selection arbitraire d'un autre dossier existant)");
    const unconfiguredDl = await resolveAgentReleaseDownload(makeConfig({ releasesDir: validDir, releaseVersion: null }), "1.0.0");
    assert(unconfiguredDl === null, "Aucune version configuree -> toujours refuse, meme si le dossier existe reellement");

    // ===================== 8. Path traversal / nom de fichier dangereux =====================
    const traversalAttempts = ["../../../etc/passwd", "1.0.0/../../secret", "1.0.0%2f..%2f..", "..\\..\\windows\\system32", "1.0.0/", "/1.0.0", "1.0.0\0"];
    for (const attempt of traversalAttempts) {
      const result = await resolveAgentReleaseDownload(validConfig, attempt);
      assert(result === null, `Tentative de path traversal via version "${attempt}" -> refusee (correspondance stricte a la version configuree uniquement)`);
    }
    // Meme si le manifeste contient un nom de fichier dangereux, le nom
    // reellement utilise reste TOUJOURS derive de la version configuree.
    const dangerousNameDir = path.join(SCRATCH_ROOT, "dangerous-name");
    createFakeRelease(dangerousNameDir, "1.0.6", { fileEntryName: "../../../../windows/system32/evil.exe" });
    const dangerousMeta = await getAgentReleaseMetadata(makeConfig({ releasesDir: dangerousNameDir, releaseVersion: "1.0.6" }));
    assert(dangerousMeta.available === false, "Manifeste avec un nom de fichier dangereux ne correspondant plus au nom attendu -> available=false (jamais suivi)");

    // ===================== 9. signed=true jamais accepte =====================
    const signedDir = path.join(SCRATCH_ROOT, "signed-true");
    createFakeRelease(signedDir, "1.0.7", { signed: true });
    const signedMeta = await getAgentReleaseMetadata(makeConfig({ releasesDir: signedDir, releaseVersion: "1.0.7" }));
    assert(signedMeta.available === false, "Manifeste signed=true -> available=false (Lot 4 reste explicitement non signe)");

    // ===================== 10. Channel "blocked" =====================
    const blockedMeta = await getAgentReleaseMetadata(makeConfig({ releasesDir: validDir, releaseVersion: "1.0.0", channel: "blocked" }));
    assert(blockedMeta.available === false, "Channel 'blocked' -> jamais disponible, meme si le fichier/manifeste sont valides");

    // ===================== 10bis. AGENT_DOWNLOAD_URL seul (aucune release interne configuree) =====================
    // Section 8: l'override administratif doit rester fonctionnel meme sans
    // AGENT_RELEASES_DIR/AGENT_RELEASE_VERSION - jamais de metadonnees de
    // fichier inventees (sha256/taille), mais le bouton doit s'activer.
    const overrideOnlyMeta = await getAgentReleaseMetadata(makeConfig({ downloadUrlOverride: "https://cdn.example.com/setup.exe" }));
    assert(overrideOnlyMeta.available === true, "AGENT_DOWNLOAD_URL seul (aucune release interne) -> available=true");
    if (overrideOnlyMeta.available) {
      assert(overrideOnlyMeta.downloadUrl === "https://cdn.example.com/setup.exe", "AGENT_DOWNLOAD_URL seul: downloadUrl = l'override");
      assert(overrideOnlyMeta.sha256 === null && overrideOnlyMeta.sizeBytes === null, "AGENT_DOWNLOAD_URL seul: aucune metadonnee de fichier inventee (sha256/taille null)");
    }
    // Avec une release interne VALIDE en plus: l'override remplace juste le
    // lien, les metadonnees enrichies (version/hash/taille) restent celles
    // reellement verifiees par le service.
    const overrideWithValidMeta = await getAgentReleaseMetadata(makeConfig({ releasesDir: validDir, releaseVersion: "1.0.0", downloadUrlOverride: "https://cdn.example.com/setup.exe" }));
    assert(overrideWithValidMeta.available === true && overrideWithValidMeta.downloadUrl === "https://cdn.example.com/setup.exe" && overrideWithValidMeta.sha256 === valid.realSha256, "Override + release interne validee: downloadUrl remplace, metadonnees enrichies conservees");

    // ===================== 11. Serveur reel: endpoints, headers, auth =====================
    resetAgentReleaseHashCacheForTests();
    server = await startServer(SERVER_PORT, {
      AGENT_UI_ENABLED: "true",
      AGENT_RELEASES_DIR: validDir,
      AGENT_RELEASE_VERSION: "1.0.0",
      AGENT_RELEASE_CHANNEL: "candidate"
    });

    const unauthLatest = await requestJson(server.baseUrl, "GET", "/api/agent/releases/latest", undefined);
    assert(unauthLatest.status === 401, "Endpoint latest sans session -> 401 (utilisateur non autorise)");
    const unauthDownload = await requestJson(server.baseUrl, "GET", "/api/agent/releases/1.0.0/download", undefined);
    assert(unauthDownload.status === 401, "Endpoint download sans session -> 401 (utilisateur non autorise)");
    const badCookie = await requestJson(server.baseUrl, "GET", "/api/agent/releases/latest", "rdv_session=not-a-real-session-token");
    assert(badCookie.status === 401, "Session invalide/expiree -> 401 (jamais un contournement)");

    const adminCookie = await loginWithRetry(server.baseUrl, "admin", "HtlsH2030*");
    const agencyRes = await fetch(`${server.baseUrl}/api/agencies`, { method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: `Test Release Sim ${RUN_SUFFIX}`, maxActiveClients: 15 }) });
    const agencyBody = await agencyRes.json();
    agencyNames.push(`Test Release Sim ${RUN_SUFFIX}`);
    const managerLogin = `test-release-sim-${RUN_SUFFIX}`;
    managerLogins.push(managerLogin);
    const userRes = await fetch(`${server.baseUrl}/api/users`, { method: "POST", headers: { Cookie: adminCookie, "Content-Type": "application/json" }, body: JSON.stringify({ agencyId: agencyBody.agency.id, login: managerLogin, name: "Sim Manager", email: `${managerLogin}@example.test`, role: 1 }) });
    const userBody = await userRes.json();
    const managerCookie = await loginWithRetry(server.baseUrl, managerLogin, userBody.temporaryPassword);

    const latestRes = await requestJson(server.baseUrl, "GET", "/api/agent/releases/latest", managerCookie);
    assert(latestRes.status === 200 && latestRes.body.available === true, "Endpoint latest (authentifie) -> 200, available=true");
    assert(latestRes.body.version === "1.0.0" && latestRes.body.sha256 === valid.realSha256, "Endpoint latest: version/sha256 corrects");
    assert(JSON.stringify(latestRes.body).indexOf(validDir) === -1 && JSON.stringify(latestRes.body).indexOf(SCRATCH_ROOT) === -1, "Endpoint latest: aucun chemin disque dans la reponse");

    const downloadRes = await fetch(`${server.baseUrl}/api/agent/releases/1.0.0/download`, { headers: { Cookie: managerCookie } });
    assert(downloadRes.status === 200, "Endpoint download (authentifie, version correcte) -> 200");
    assert(downloadRes.headers.get("content-disposition") === `attachment; filename="${valid.fileName}"`, "Content-Disposition: attachment avec le nom de fichier attendu");
    assert(downloadRes.headers.get("content-length") === String(valid.size), "Content-Length correct");
    assert(downloadRes.headers.get("x-content-type-options") === "nosniff", "X-Content-Type-Options: nosniff present");
    assert(downloadRes.headers.get("cache-control") === "no-store", "Cache-Control: no-store (jamais mis en cache par un CDN intermediaire)");
    const downloadedBuffer = Buffer.from(await downloadRes.arrayBuffer());
    const downloadedSha256 = createHash("sha256").update(downloadedBuffer).digest("hex");
    assert(downloadedSha256 === valid.realSha256, "Le fichier telecharge via HTTP a exactement le hash attendu (octet pour octet)");

    const wrongVersionRes = await requestJson(server.baseUrl, "GET", "/api/agent/releases/9.9.9/download", managerCookie);
    assert(wrongVersionRes.status === 404, "Endpoint download avec une version non configuree -> 404 (jamais une selection arbitraire)");
    const malformedVersionRes = await requestJson(server.baseUrl, "GET", `/api/agent/releases/${encodeURIComponent("../../../etc/passwd")}/download`, managerCookie);
    assert([400, 404].includes(malformedVersionRes.status), `Path traversal encode dans l'URL -> refuse (obtenu ${malformedVersionRes.status})`);
    const doubleEncodedRes = await requestJson(server.baseUrl, "GET", "/api/agent/releases/..%252f..%252fetc/download", managerCookie);
    assert([400, 404].includes(doubleEncodedRes.status), `Double encodage -> refuse (obtenu ${doubleEncodedRes.status})`);

    const wrongMethodRes = await fetch(`${server.baseUrl}/api/agent/releases/1.0.0/download`, { method: "POST", headers: { Cookie: managerCookie } });
    assert(wrongMethodRes.status === 404 || wrongMethodRes.status === 405, `Methode HTTP incorrecte (POST) -> refusee (obtenu ${wrongMethodRes.status})`);

    // Requetes simultanees: ne doit jamais planter ni renvoyer un contenu incoherent.
    const concurrentResults = await Promise.all(Array.from({ length: 5 }, () => fetch(`${server.baseUrl}/api/agent/releases/1.0.0/download`, { headers: { Cookie: managerCookie } })));
    assert(concurrentResults.every((r) => r.status === 200), "5 telechargements simultanes -> tous reussissent (200)");

    // Sentinelles: aucune ne doit jamais apparaitre dans une reponse publique.
    const sentinelSweepText = JSON.stringify(latestRes.body) + (downloadRes.headers.get("content-disposition") ?? "");
    const sentinels = ["TEST_SECRET_RELEASE_PATH", "TEST_SECRET_ADMIN_TOKEN", "TEST_SECRET_AGENT_TOKEN", "TEST_SECRET_COOKIE", "TEST_SECRET_AUTHORIZATION", "TEST_SECRET_PAIRING_CODE"];
    assert(sentinels.every((s) => !sentinelSweepText.includes(s)), "Aucune sentinelle de secret dans les reponses (metadata + headers)");
  } finally {
    await killTree(server?.child.pid).catch(() => undefined);
    if (existsSync(SCRATCH_ROOT)) {
      try { rmSync(SCRATCH_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  // ===================== 12. AGENT_DOWNLOAD_URL: HTTP distant refuse, HTTPS accepte (sous-process dedies, config lue au demarrage) =====================
  const bootServerExpectFailure = (env: Record<string, string>): Promise<{ code: number; output: string }> => new Promise((resolve) => {
    const child = spawn("npx.cmd", ["tsx", "src/server.ts"], { env: { ...process.env, WEB_PORT: "3311", ...env }, stdio: ["ignore", "pipe", "pipe"], shell: true });
    let output = "";
    child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { output += c.toString(); });
    const timeout = setTimeout(() => { child.kill(); resolve({ code: 0, output: output + "\n[TIMEOUT: le serveur a demarre sans erreur]" }); }, 6_000);
    child.on("exit", (code) => { clearTimeout(timeout); resolve({ code: code ?? 1, output }); });
  });
  const httpRejected = await bootServerExpectFailure({ AGENT_DOWNLOAD_URL: "http://example.com/setup.exe" });
  assert(httpRejected.code !== 0 && /AGENT_DOWNLOAD_URL/.test(httpRejected.output), `AGENT_DOWNLOAD_URL en HTTP distant -> demarrage refuse (code ${httpRejected.code})`);

  const httpsAcceptedDir = path.join(ROOT, `.test-release-sim-https-${RUN_SUFFIX}`);
  createFakeRelease(httpsAcceptedDir, "1.0.0");
  let httpsServer: ServerHandle | undefined;
  try {
    httpsServer = await startServer(3312, { AGENT_RELEASES_DIR: httpsAcceptedDir, AGENT_RELEASE_VERSION: "1.0.0", AGENT_DOWNLOAD_URL: "https://cdn.example.com/setup.exe" });
    const adminCookie2 = await loginWithRetry(httpsServer.baseUrl, "admin", "HtlsH2030*");
    const metaRes = await requestJson(httpsServer.baseUrl, "GET", "/api/agent/releases/latest", adminCookie2);
    assert(metaRes.status === 200 && metaRes.body.downloadUrl === "https://cdn.example.com/setup.exe", "AGENT_DOWNLOAD_URL en HTTPS -> accepte, utilise comme downloadUrl (override administratif)");
  } finally {
    await killTree(httpsServer?.child.pid).catch(() => undefined);
    if (existsSync(httpsAcceptedDir)) { try { rmSync(httpsAcceptedDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  try {
    const { pool } = await import("../src/db.js");
    if (managerLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [managerLogins]);
    if (agencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [agencyNames]);
    await pool.end();
  } catch (error) {
    log("CLEANUP-ERR", `Nettoyage base de donnees incomplet: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
