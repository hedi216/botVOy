// Test SIMULE Phase 5 (Lot 2, section 15): verifie le credential store
// DPAPI, la migration, le verrou mono-instance et l'interface locale SANS
// jamais lancer un Chrome de bot - executable sur la VM (Windows requis pour
// les branches DPAPI reelles ; sur une VM Windows sans session interactive,
// System.Security.Cryptography.ProtectedData/CurrentUser reste disponible
// des qu'un profil utilisateur est charge).
//
// Usage: npx tsx scripts/test-agent-packaging-lot2-simulated.ts
//    ou: npm run test:agent:packaging-lot2:simulated

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createCredentialStore,
  DevFileCredentialStore,
  TestCredentialStore,
  writeFileAtomic
} from "../src/agent/agentCredentialStore.js";
import { CredentialFileCorruptedError, WindowsDpapiCredentialStore } from "../src/agent/agentDpapiCredentialStore.js";
import { migratePlaintextCredentialsIfNeeded } from "../src/agent/agentCredentialMigration.js";
import { resolveAgentPaths } from "../src/agent/agentPaths.js";
import { AgentSingleInstanceLock } from "../src/agent/agentSingleInstanceLock.js";
import { AgentLocalUi } from "../src/agent/agentLocalUi.js";
import { redactLogLine } from "../src/agent/agentLocalLogger.js";
import { AgentRuntimeSettings, StoredAgentCredentials } from "../src/agent/types.js";

let passCount = 0;
let failCount = 0;
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const log = (level: string, message: string): void => console.log(`[${level}] ${message}`);
const noopLog = (): void => undefined;

// Attend reellement la fin du process avant de continuer: sur Windows,
// enchainer kill() + un nouveau spawn() sans attendre l'evenement "exit" a
// provoque un crash libuv (UV_HANDLE_CLOSING) en fin de script - le process
// parent doit laisser le temps au handle du process tue d'etre nettoye.
const killAndWait = (child: ReturnType<typeof spawn>): Promise<void> => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve();
    return;
  }
  child.once("exit", () => resolve());
  child.kill();
});

const ROOT = path.resolve(process.cwd());
const RUN_SUFFIX = Date.now();
const SCRATCH_ROOT = path.join(ROOT, `.test-packaging-lot2-${RUN_SUFFIX}`);

const makeSettings = (overrides: Partial<AgentRuntimeSettings> = {}): AgentRuntimeSettings => {
  const dataRoot = overrides.dataRoot ?? path.join(SCRATCH_ROOT, `dataroot-${Math.random().toString(36).slice(2)}`);
  return {
    serverUrl: "http://localhost:1",
    credentialsPath: path.join(dataRoot, "credentials", "agent-credentials.json"),
    computerName: "PC-TEST",
    version: "0.1.0",
    protocolVersion: 1,
    runtimeMode: "test",
    targetMode: "production",
    fixtureUrl: null,
    targetUrl: "about:blank",
    maxActiveBots: 5,
    dataRoot,
    reconnectMinDelayMs: 500,
    reconnectMaxDelayMs: 2000,
    reconnectJitterRatio: 0.1,
    offlineEventBufferMax: 100,
    logMaxFileSizeMb: 1,
    logMaxFiles: 1,
    logLevel: "info",
    ...overrides
  };
};

const sampleCredentials = (token: string): StoredAgentCredentials => ({
  agentId: 42,
  token,
  agencyId: 7,
  computerName: "PC-TEST",
  displayName: "PC-TEST",
  version: "0.1.0",
  pairedAt: new Date().toISOString()
});

const main = async (): Promise<void> => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });

  try {
    // ===================== 1. Selection du store par mode =====================
    {
      const testStore = await createCredentialStore(makeSettings({ runtimeMode: "test" }), noopLog);
      assert(testStore instanceof TestCredentialStore, "runtimeMode=test -> TestCredentialStore");
      assert(testStore.describeSecurity().protection === "memory-test", "TestCredentialStore: protection=memory-test");

      const devStore = await createCredentialStore(makeSettings({ runtimeMode: "development" }), noopLog);
      assert(devStore instanceof DevFileCredentialStore, "runtimeMode=development -> DevFileCredentialStore");
      assert(devStore.describeSecurity().protection === "plaintext-dev", "DevFileCredentialStore: protection=plaintext-dev");

      if (process.platform === "win32") {
        const packagedStore = await createCredentialStore(makeSettings({ runtimeMode: "packaged" }), noopLog);
        assert(packagedStore instanceof WindowsDpapiCredentialStore, "runtimeMode=packaged (Windows, DPAPI disponible) -> WindowsDpapiCredentialStore");
        assert(packagedStore.describeSecurity().protection === "windows-dpapi-current-user", "WindowsDpapiCredentialStore: protection=windows-dpapi-current-user");
      }
    }

    // ===================== 2. Echec ferme si DPAPI indisponible en mode packaged =====================
    {
      // PATH vide -> spawn("powershell", ...) echoue (ENOENT) -> isDpapiAvailable()
      // renvoie false -> createCredentialStore doit lever, jamais un fallback silencieux.
      const probeScriptPath = path.join(SCRATCH_ROOT, "dpapi-unavailable-probe.ts");
      writeFileSync(probeScriptPath, `
        import { createCredentialStore } from "../src/agent/agentCredentialStore.js";
        createCredentialStore({ runtimeMode: "packaged", credentialsPath: "x", dataRoot: "x" } as any, () => undefined)
          .then(() => { console.log("NO_THROW"); process.exit(0); })
          .catch((e) => { console.log("THREW:" + e.message); process.exit(0); });
      `);
      const probe = await new Promise<{ code: number | null; output: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", probeScriptPath], {
          cwd: SCRATCH_ROOT,
          env: { SystemRoot: process.env.SystemRoot, PATH: "" },
          stdio: ["ignore", "pipe", "pipe"]
        });
        let output = "";
        child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
        child.stderr?.on("data", (c: Buffer) => { output += c.toString(); });
        child.on("exit", (code) => resolve({ code, output }));
      });
      assert(probe.output.includes("THREW:"), `packaged + DPAPI indisponible (PATH vide) -> echec ferme, jamais un fallback silencieux (sortie: ${probe.output.trim().slice(0, 300)})`);
      assert(probe.output.toLowerCase().includes("dpapi") || probe.output.toLowerCase().includes("packaged"), "message d'echec explicite (mentionne DPAPI/packaged)");
    }

    if (process.platform !== "win32") {
      console.log("Plateforme non-Windows: suite des tests DPAPI reels ignoree (le reste du test continue).");
    } else {
      // ===================== 3. Save/load/clear (store DPAPI reel) =====================
      const settingsA = makeSettings();
      const storeA = new WindowsDpapiCredentialStore(settingsA, noopLog);
      assert(!(await storeA.exists()), "store vide au depart");

      const sentinelToken = "TEST_SECRET_AGENT_TOKEN_" + RUN_SUFFIX;
      await storeA.save(sampleCredentials(sentinelToken));
      assert(await storeA.exists(), "exists()=true apres save()");

      const onDisk = readFileSync(settingsA.credentialsPath, "utf8");
      assert(!onDisk.includes(sentinelToken), "le token n'apparait JAMAIS en clair sur disque");
      assert(JSON.parse(onDisk).formatVersion === 1, "formatVersion=1 present dans le fichier protege");

      const reloaded = await storeA.load();
      assert(reloaded?.token === sentinelToken, "load() apres save() renvoie le token d'origine (aller-retour DPAPI correct)");

      const remainingTmpFiles = readdirSync(path.dirname(settingsA.credentialsPath)).filter((f) => f.includes(".tmp-"));
      assert(remainingTmpFiles.length === 0, "aucun fichier temporaire d'ecriture atomique laisse derriere (rename() complet)");

      await storeA.clear();
      assert(!(await storeA.exists()), "exists()=false apres clear()");

      // ===================== 4. Corruption / taille / cles dangereuses =====================
      const settingsB = makeSettings();
      const storeB = new WindowsDpapiCredentialStore(settingsB, noopLog);
      mkdirSync(path.dirname(settingsB.credentialsPath), { recursive: true });

      writeFileSync(settingsB.credentialsPath, "{ not valid json at all");
      await storeB.load().then(
        () => assert(false, "JSON illisible aurait du lever"),
        (e) => assert(e instanceof CredentialFileCorruptedError, "JSON illisible -> CredentialFileCorruptedError")
      );

      writeFileSync(settingsB.credentialsPath, JSON.stringify({
        formatVersion: 1, protection: "windows-dpapi-current-user", agentId: 1,
        protectedToken: "x".repeat(70_000), agencyId: 1, computerName: "a", displayName: "a",
        version: "1", pairedAt: "x", createdAt: "x", updatedAt: "x"
      }));
      await storeB.load().then(
        () => assert(false, "fichier surdimensionne aurait du lever"),
        (e) => assert(e instanceof CredentialFileCorruptedError, "fichier surdimensionne (>64KB) -> CredentialFileCorruptedError")
      );

      writeFileSync(settingsB.credentialsPath, JSON.stringify({ formatVersion: 2, protection: "windows-dpapi-current-user" }));
      await storeB.load().then(
        () => assert(false, "formatVersion inattendu aurait du lever"),
        (e) => assert(e instanceof CredentialFileCorruptedError, "formatVersion != 1 -> CredentialFileCorruptedError")
      );

      // Cle dangereuse via une VRAIE chaine JSON (JSON.parse cree bien une
      // propriete propre "__proto__" ici, contrairement a un objet litteral JS).
      writeFileSync(settingsB.credentialsPath, '{"formatVersion":1,"protection":"windows-dpapi-current-user","agentId":1,"protectedToken":"x","agencyId":1,"computerName":"a","displayName":"a","version":"1","pairedAt":"x","createdAt":"x","updatedAt":"x","__proto__":{"evil":true}}');
      await storeB.load().then(
        () => assert(false, "cle __proto__ aurait du lever"),
        (e) => assert(e instanceof CredentialFileCorruptedError && /interdite/.test(e.message), "cle __proto__ (JSON brut) -> CredentialFileCorruptedError")
      );
      rmSync(settingsB.credentialsPath, { force: true });

      // ===================== 5. Migration =====================
      const settingsC = makeSettings();
      const legacyPath = settingsC.credentialsPath;
      mkdirSync(path.dirname(legacyPath), { recursive: true });
      const migrationToken = "TEST_SECRET_AGENT_TOKEN_MIGRATION_" + RUN_SUFFIX;
      writeFileSync(legacyPath, JSON.stringify(sampleCredentials(migrationToken)));

      const targetStoreC = new WindowsDpapiCredentialStore(settingsC, noopLog);
      const migrationResult1 = await migratePlaintextCredentialsIfNeeded(settingsC, targetStoreC, noopLog);
      assert(migrationResult1.outcome === "migrated", `migration reussie depuis un fichier en clair (obtenu: ${migrationResult1.outcome})`);
      assert(!existsSync(legacyPath) || JSON.parse(readFileSync(legacyPath, "utf8")).formatVersion === 1, "l'ancien fichier en clair est remplace/supprime apres migration reussie");
      const afterMigration = await targetStoreC.load();
      assert(afterMigration?.token === migrationToken, "les identifiants migres sont corrects (aller-retour DPAPI)");

      const migrationResult2 = await migratePlaintextCredentialsIfNeeded(settingsC, targetStoreC, noopLog);
      assert(migrationResult2.outcome === "already-present", "migration idempotente (deuxieme appel -> already-present, jamais reecrit)");

      // Migration echouee: le store cible echoue systematiquement -> l'ancien
      // fichier ne doit jamais etre supprime, aucune donnee perdue.
      const settingsD = makeSettings();
      mkdirSync(path.dirname(settingsD.credentialsPath), { recursive: true });
      writeFileSync(settingsD.credentialsPath, JSON.stringify(sampleCredentials("TEST_SECRET_AGENT_TOKEN_FAIL")));
      const failingStore = {
        load: async () => null,
        save: async () => { throw new Error("echec simule"); },
        clear: async () => undefined,
        exists: async () => false,
        describeSecurity: () => ({ mode: "packaged" as const, protection: "windows-dpapi-current-user" as const, path: settingsD.credentialsPath })
      };
      const migrationResult3 = await migratePlaintextCredentialsIfNeeded(settingsD, failingStore, noopLog);
      assert(migrationResult3.outcome === "failed", "migration en echec renvoie outcome=failed");
      assert(existsSync(settingsD.credentialsPath), "l'ancien fichier en clair est CONSERVE apres un echec de migration");

      // ===================== 6. AgentPaths: espaces + Unicode =====================
      const unicodeDataRoot = path.join(SCRATCH_ROOT, "Résumé Ünïcödé Dossier avec espaces");
      const unicodeSettings = makeSettings({ dataRoot: unicodeDataRoot, credentialsPath: path.join(unicodeDataRoot, "credentials", "agent-credentials.json") });
      const paths = resolveAgentPaths(unicodeSettings);
      assert(existsSync(paths.logsDir) && existsSync(paths.configDir) && existsSync(paths.profilesDir) && existsSync(paths.stateDir), "AgentPaths cree tous les sous-dossiers avec un dataRoot contenant espaces/Unicode");
      const unicodeStore = new WindowsDpapiCredentialStore(unicodeSettings, noopLog);
      await unicodeStore.save(sampleCredentials("TEST_SECRET_AGENT_TOKEN_UNICODE"));
      const unicodeReloaded = await unicodeStore.load();
      assert(unicodeReloaded?.token === "TEST_SECRET_AGENT_TOKEN_UNICODE", "save/load fonctionne avec un chemin contenant espaces/Unicode");

      // ===================== 7. Verrou mono-instance (vrais process distincts) =====================
      const lockDataRoot = path.join(SCRATCH_ROOT, "lock-test");
      mkdirSync(lockDataRoot, { recursive: true });
      const lockScript = `
        import { AgentSingleInstanceLock } from "c:/Users/marzo/Desktop/APPS/RendezBOT/src/agent/agentSingleInstanceLock.js";
        const lock = new AgentSingleInstanceLock({ dataRoot: process.argv[2] });
        lock.tryAcquire().then((r) => {
          console.log(JSON.stringify(r));
          if (r.acquired) { setTimeout(() => {}, 8000); } else { process.exit(0); }
        });
      `;
      const scratchScriptPath = path.join(SCRATCH_ROOT, "lock-holder.mjs.ts");
      writeFileSync(scratchScriptPath, lockScript);

      const holder = spawn(process.execPath, ["--import", "tsx", scratchScriptPath, lockDataRoot], { stdio: ["ignore", "pipe", "pipe"] });
      let holderOutput = "";
      holder.stdout?.on("data", (c: Buffer) => { holderOutput += c.toString(); });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert(holderOutput.includes('"acquired":true'), "premier process: verrou acquis");

      const second = spawn(process.execPath, ["--import", "tsx", scratchScriptPath, lockDataRoot], { stdio: ["ignore", "pipe", "pipe"] });
      let secondOutput = "";
      second.stdout?.on("data", (c: Buffer) => { secondOutput += c.toString(); });
      const secondExitCode = await new Promise<number | null>((resolve) => second.on("exit", resolve));
      assert(secondOutput.includes('"acquired":false'), "deuxieme process (meme dataRoot): verrou refuse, instance existante detectee");
      assert(secondExitCode === 0, "deuxieme lancement se termine avec le code 0 (jamais une erreur technique)");

      await killAndWait(holder);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const third = spawn(process.execPath, ["--import", "tsx", scratchScriptPath, lockDataRoot], { stdio: ["ignore", "pipe", "pipe"] });
      let thirdOutput = "";
      third.stdout?.on("data", (c: Buffer) => { thirdOutput += c.toString(); });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert(thirdOutput.includes('"acquired":true'), "recuperation apres crash: le verrou perime (process tue) est repris avec succes");
      await killAndWait(third);
    }

    // ===================== 8. Interface locale (loopback, nonce, tailles, routes) =====================
    {
      let unpairCalled = false;
      const ui = new AgentLocalUi(noopLog as any, {
        getStatus: () => ({
          state: "NOT_PAIRED", agentVersion: "0.1.0", protocolVersion: 1, computerName: "PC-TEST",
          serverHost: "localhost:3000", paired: false, activeBotCount: 0, extensions: [], message: null
        }),
        pairWithCode: async (code) => code === "TEST_SECRET_PAIRING_CODE" ? { ok: true } : { ok: false, error: "invalide" },
        retry: () => undefined,
        requestQuit: () => undefined,
        openLogsFolder: () => undefined,
        openConfigFolder: () => undefined,
        unpair: async () => { unpairCalled = true; }
      });
      const port = await ui.start(0);
      const base = `http://127.0.0.1:${port}`;

      const statusRes = await fetch(`${base}/local/status`);
      const status = await statusRes.json();
      assert(statusRes.status === 200 && typeof status.nonce === "string", "GET /local/status renvoie un nonce");
      assert(JSON.stringify(status).indexOf("TEST_SECRET") === -1, "le statut public ne contient aucune sentinelle");

      const badNonce = await fetch(`${base}/local/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce: "wrong" }) });
      assert(badNonce.status === 403, "nonce invalide -> 403");

      const badOrigin = await fetch(`${base}/local/retry`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example" }, body: JSON.stringify({ nonce: status.nonce }) });
      assert(badOrigin.status === 403, "origine etrangere -> 403");

      const oversized = await fetch(`${base}/local/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce: status.nonce, code: "x".repeat(20_000) }) }).catch(() => null);
      assert(!oversized || oversized.status === 413, "corps de requete surdimensionne -> 413 (ou connexion refusee)");

      const wrongCt = await fetch(`${base}/local/pair`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "not-json" });
      assert(wrongCt.status === 400, "Content-Type non-JSON -> 400");

      const unknownRoute = await fetch(`${base}/local/does-not-exist`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce: status.nonce }) });
      assert(unknownRoute.status === 404, "route inconnue -> 404");

      const pairResult = await fetch(`${base}/local/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce: status.nonce, code: "TEST_SECRET_PAIRING_CODE" }) });
      assert(pairResult.status === 200 && (await pairResult.json()).ok === true, "appairage avec un code valide reussit");

      const unpairResult = await fetch(`${base}/local/unpair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce: status.nonce }) });
      assert(unpairResult.status === 200 && unpairCalled, "POST /local/unpair declenche bien le callback de dissociation");

      const pageRes = await fetch(`${base}/`);
      const html = await pageRes.text();
      assert(html.includes("RendezBot Agent") && !html.includes("TEST_SECRET"), "page HTML servie, sans aucune sentinelle");

      ui.stop();
    }

    // ===================== 9. Redaction (garde-fou) =====================
    {
      const sample = `Authorization: Bearer TEST_SECRET_AUTHORIZATION_${RUN_SUFFIX}`;
      assert(!redactLogLine(sample).includes(`TEST_SECRET_AUTHORIZATION_${RUN_SUFFIX}`), "redactLogLine masque une sentinelle Authorization");
      const cookieSample = `Set-Cookie: session=TEST_SECRET_COOKIE_${RUN_SUFFIX}`;
      assert(!redactLogLine(cookieSample).includes(`TEST_SECRET_COOKIE_${RUN_SUFFIX}`), "redactLogLine masque une sentinelle Set-Cookie");
    }

    // ===================== 10. Ecriture atomique (garde-fou generique) =====================
    {
      const atomicTarget = path.join(SCRATCH_ROOT, "atomic-test", "file.json");
      writeFileAtomic(atomicTarget, JSON.stringify({ ok: true }));
      assert(existsSync(atomicTarget), "writeFileAtomic cree bien le fichier cible");
      const siblings = readdirSync(path.dirname(atomicTarget));
      assert(!siblings.some((f) => f.includes(".tmp-")), "aucun fichier temporaire residuel apres writeFileAtomic");
    }

    console.log("\nAucun Chrome de bot n'a ete lance a aucun moment de ce test (verifie par construction: agentBrowserManager.ts n'est jamais importe ici).");
  } finally {
    if (existsSync(SCRATCH_ROOT)) {
      rmSync(SCRATCH_ROOT, { recursive: true, force: true });
    }
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  // process.exit() immediat (plutot que laisser le process se terminer
  // naturellement) declenchait un crash libuv Windows
  // (UV_HANDLE_CLOSING, src/win/async.c) apres avoir enchaine plusieurs
  // spawn()/kill() de process enfants dans le meme processus - exitCode
  // laisse la boucle d'evenements se vider proprement.
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
