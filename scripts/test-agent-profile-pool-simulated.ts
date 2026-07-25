// Test cible (unitaire, aucun Chrome/agent/serveur reel): verifie
// directement la logique du pool de profils persistants introduit par le
// diagnostic Cloudflare (src/agent/agentProfileManager.ts) :
// 1) deux acquisitions successives (avec liberation entre les deux)
//    reutilisent le meme profil ;
// 2) deux acquisitions concurrentes (sans liberation) obtiennent deux
//    profils distincts ;
// 3) un verrou perime (PID mort) est correctement recycle ;
// 4) un fichier de verrouillage Chrome interne (SingletonLock) laisse par un
//    arret force est nettoye avant reutilisation du profil.
//
// Peut tourner sans risque sur la VM (aucun Chrome reellement lance).
//
// Usage: npx tsx scripts/test-agent-profile-pool-simulated.ts
//    ou: npm run test:agent:profile-pool:simulated

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquirePooledProfileLock } from "../src/agent/agentProfileManager.js";
import { AgentRuntimeSettings } from "../src/agent/types.js";

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};

const RUN_SUFFIX = Date.now();
const dataRoot = path.resolve(`.test-profile-pool-data-${RUN_SUFFIX}`);

// Seuls les champs lus par acquirePooledProfileLock (via getProfilesDir)
// sont necessaires: dataRoot. Le reste est un remplissage minimal pour
// satisfaire le type AgentRuntimeSettings.
const fakeSettings: AgentRuntimeSettings = {
  serverUrl: "http://localhost:0",
  credentialsPath: path.join(dataRoot, "credentials", "agent-credentials.json"),
  computerName: "TEST-PROFILE-POOL",
  version: "0.0.0",
  protocolVersion: 1,
  runtimeMode: "test",
  targetMode: "fixture",
  fixtureUrl: "about:blank",
  targetUrl: "about:blank",
  maxActiveBots: 5,
  dataRoot,
  reconnectMinDelayMs: 1_000,
  reconnectMaxDelayMs: 30_000,
  reconnectJitterRatio: 0.2,
  offlineEventBufferMax: 500,
  logMaxFileSizeMb: 5,
  logMaxFiles: 5,
  logLevel: "info",
  autoNavRetryIntervalMs: 10_000,
  autoNavLongWaitMs: 300_000
};

const profilesRoot = path.join(dataRoot, "profiles");
const listProfileDirs = (): string[] => {
  if (!existsSync(profilesRoot)) return [];
  return readdirSync(profilesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^profile-\d{2,}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
};

const main = (): void => {
  log("BOOT", "=== Test cible - pool de profils persistants (unitaire) ===");

  try {
    // ----- Test 1: reutilisation apres liberation -----
    const leaseA = acquirePooledProfileLock(fakeSettings);
    leaseA.release();
    const leaseB = acquirePooledProfileLock(fakeSettings);
    assert(leaseA.profilePath === leaseB.profilePath, `1) Deux acquisitions successives (avec liberation entre les deux) reutilisent le meme profil (${leaseA.profilePath})`);
    assert(listProfileDirs().length === 1, `1) Un seul dossier de profil cree apres ces deux acquisitions successives (trouve: ${listProfileDirs().length})`);
    leaseB.release();

    // ----- Test 2: deux acquisitions concurrentes -> deux profils distincts -----
    const leaseC = acquirePooledProfileLock(fakeSettings);
    const leaseD = acquirePooledProfileLock(fakeSettings);
    assert(leaseC.profilePath !== leaseD.profilePath, `2) Deux acquisitions concurrentes (sans liberation) obtiennent deux profils distincts (${leaseC.profilePath} / ${leaseD.profilePath})`);
    assert(listProfileDirs().length === 2, `2) Exactement deux dossiers de profil apres deux acquisitions concurrentes (trouve: ${listProfileDirs().length})`);

    // ----- Test 3: verrou perime (PID mort) recycle -----
    leaseD.release();
    const deadPid = 999_999; // PID quasi certainement mort sur n'importe quelle machine de test
    writeFileSync(path.join(leaseD.profilePath, ".rendezbot-agent.lock"), String(deadPid));
    const leaseE = acquirePooledProfileLock(fakeSettings);
    assert(leaseE.profilePath === leaseD.profilePath, `3) Un verrou perime (PID mort ${deadPid}) est correctement recycle plutot que de creer un nouveau profil (${leaseE.profilePath})`);
    assert(listProfileDirs().length === 2, `3) Toujours exactement deux dossiers de profil apres recyclage d'un verrou perime (trouve: ${listProfileDirs().length})`);

    // ----- Test 4: nettoyage d'un verrou Chrome interne perime (SingletonLock) -----
    leaseE.release();
    leaseC.release();
    const staleChromeLockDir = path.join(profilesRoot, "profile-01");
    mkdirSync(staleChromeLockDir, { recursive: true });
    writeFileSync(path.join(staleChromeLockDir, "SingletonLock"), "stale-symlink-target");
    writeFileSync(path.join(staleChromeLockDir, "SingletonCookie"), "stale");
    writeFileSync(path.join(staleChromeLockDir, "SingletonSocket"), "stale");
    const leaseF = acquirePooledProfileLock(fakeSettings);
    assert(leaseF.profilePath === staleChromeLockDir, "4) Le profil reutilise est bien profile-01 (premier slot disponible)");
    assert(
      !existsSync(path.join(staleChromeLockDir, "SingletonLock"))
      && !existsSync(path.join(staleChromeLockDir, "SingletonCookie"))
      && !existsSync(path.join(staleChromeLockDir, "SingletonSocket")),
      "4) Les fichiers de verrouillage Chrome internes perimes (SingletonLock/Cookie/Socket) sont nettoyes avant reutilisation du profil"
    );
    leaseF.release();
  } finally {
    try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main();
