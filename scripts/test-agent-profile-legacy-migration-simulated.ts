// HOTFIX FINAL AVANT PACKAGE - migration sure des profils legacy non mappes.
//
// Bug reel a prevenir: sur une machine ayant deja tourne avec l'ancien pool
// anonyme (avant l'existence du mapping accountKey->profil), des dossiers
// profile-01/02/... existent deja et peuvent contenir la session/les cookies
// d'un compte TLS totalement inconnu de ce mapping. Sans migration explicite,
// le tout premier compte identifie apres mise a jour du code recevrait l'un
// de ces anciens profils (le mapping serait vide -> "premier slot libre").
//
// Ce test verifie loadAccountProfileMap()/migrateAndPersist() (prives, testes
// indirectement via acquireProfileLockForAccount/acquireAnonymousProfileLock,
// src/agent/agentProfileManager.ts): tout profil deja present AVANT la toute
// premiere lecture du mapping est mis en quarantaine (legacyUnassignedProfiles),
// jamais attribuable ensuite ni a un compte identifie ni au pool anonyme -
// sauf s'il est deja explicitement mappe dans un mapping v1 preexistant
// (auquel cas son association reste valide, jamais transformee en legacy).
//
// Purement logique (aucun Chrome, aucune ecriture sensible): peut tourner
// sans risque sur la VM.
//
// Usage: npx tsx scripts/test-agent-profile-legacy-migration-simulated.ts
//    ou: npm run test:agent:profile-legacy-migration:simulated

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireAnonymousProfileLock, acquireProfileLockForAccount } from "../src/agent/agentProfileManager.js";
import { computeAccountKey } from "../src/agent/agentAccountKey.js";
import { getProfilesDir, getStateDir } from "../src/agent/agentStorage.js";
import { AgentRuntimeSettings } from "../src/agent/types.js";

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const noopLog = (): void => { /* silencieux */ };

const RAW_LOGIN_A = "  LegacyMigration.UserA@Example.TEST  ";
const RAW_LOGIN_B = "legacymigration.userb@example.test";
const RAW_PASSWORD_NEVER_USED = "hunter2FakePasswordNeverPersistedMigration";

const makeSettings = (dataRoot: string): AgentRuntimeSettings => ({
  serverUrl: "http://localhost:0",
  credentialsPath: path.join(dataRoot, "credentials", "agent-credentials.json"),
  computerName: "TEST-PROFILE-LEGACY-MIGRATION",
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
});

const createLegacyProfileDir = (settings: AgentRuntimeSettings, slotName: string): void => {
  mkdirSync(path.join(getProfilesDir(settings), slotName), { recursive: true });
};

const readMapping = (settings: AgentRuntimeSettings): { formatVersion: number; accounts: Record<string, string>; legacyUnassignedProfiles: string[]; anonymousProfiles: string[] } =>
  JSON.parse(readFileSync(path.join(getStateDir(settings), "account-profile-map.json"), "utf8"));

const collectAllFileContents = (root: string): string => {
  if (!existsSync(root)) {
    return "";
  }
  let combined = "";
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      combined += collectAllFileContents(full);
    } else {
      try { combined += readFileSync(full, "utf8"); } catch { /* fichier binaire: ignore */ }
    }
  }
  return combined;
};

// ===================== Scenario 1 (tests A, B, C, D): migration a partir d'un mapping absent =====================

const runScenario1 = async (): Promise<void> => {
  log("SCENARIO-1", "=== Migration depuis un mapping absent: profils legacy en quarantaine (tests A, B, C, D) ===");
  const dataRoot = path.resolve(`.test-legacy-migration-s1-${Date.now()}`);
  const settings = makeSettings(dataRoot);
  const capturedLogs: string[] = [];
  const captureLog = (_level: unknown, message: string): void => { capturedLogs.push(message); };

  try {
    // Simule une machine deja utilisee AVANT l'existence du mapping: deux
    // profils existent, aucun mapping n'a jamais ete ecrit.
    createLegacyProfileDir(settings, "profile-01");
    createLegacyProfileDir(settings, "profile-02");
    assert(!existsSync(path.join(getStateDir(settings), "account-profile-map.json")), "Pre-requis) Aucun mapping n'existe avant la premiere allocation (etat simule pre-migration)");

    // ----- Test A -----
    const leaseA = await acquireProfileLockForAccount(settings, RAW_LOGIN_A, captureLog);
    const slotA = path.basename(leaseA.profilePath);
    assert(slotA !== "profile-01" && slotA !== "profile-02", `A) Premier compte identifie -> jamais profile-01/02 legacy (recu: ${slotA})`);
    assert(slotA === "profile-03", `A) Premier compte identifie -> profile-03 (premier slot jamais utilise) (recu: ${slotA})`);

    // ----- Test B -----
    const leaseB = await acquireProfileLockForAccount(settings, RAW_LOGIN_B, captureLog);
    const slotB = path.basename(leaseB.profilePath);
    assert(slotB === "profile-04", `B) Second compte identifie -> profile-04 (recu: ${slotB})`);

    // ----- Test C -----
    const leaseAnon = acquireAnonymousProfileLock(settings);
    const slotAnon = path.basename(leaseAnon.profilePath);
    assert(slotAnon !== "profile-01" && slotAnon !== "profile-02", `C) Bot anonyme -> jamais profile-01/02 legacy (recu: ${slotAnon})`);
    assert(slotAnon === "profile-05", `C) Bot anonyme -> profile-05 (premier slot anonyme jamais utilise) (recu: ${slotAnon})`);

    leaseA.release();
    leaseB.release();
    leaseAnon.release();

    // ----- Test D: redemarrage simule -----
    const mappingAfterFirstBoot = readMapping(settings);
    assert(
      mappingAfterFirstBoot.legacyUnassignedProfiles.includes("profile-01") && mappingAfterFirstBoot.legacyUnassignedProfiles.includes("profile-02"),
      `D) Le mapping persiste profile-01/02 comme legacyUnassignedProfiles (recu: ${JSON.stringify(mappingAfterFirstBoot.legacyUnassignedProfiles)})`
    );

    const leaseARestart = await acquireProfileLockForAccount(settings, RAW_LOGIN_A, captureLog);
    assert(path.basename(leaseARestart.profilePath) === "profile-03", "D) Apres redemarrage simule, le compte A reste sur profile-03");
    const leaseBRestart = await acquireProfileLockForAccount(settings, RAW_LOGIN_B, captureLog);
    assert(path.basename(leaseBRestart.profilePath) === "profile-04", "D) Apres redemarrage simule, le compte B reste sur profile-04");
    leaseARestart.release();
    leaseBRestart.release();

    const mappingAfterRestart = readMapping(settings);
    assert(
      JSON.stringify(mappingAfterRestart.legacyUnassignedProfiles.slice().sort()) === JSON.stringify(mappingAfterFirstBoot.legacyUnassignedProfiles.slice().sort()),
      "D) La liste de quarantaine n'est jamais reevaluee differemment apres un redemarrage simule (profile-03/04/05, crees APRES la migration, n'y sont jamais ajoutes)"
    );
    assert(
      !mappingAfterRestart.legacyUnassignedProfiles.includes("profile-03")
      && !mappingAfterRestart.legacyUnassignedProfiles.includes("profile-04")
      && !mappingAfterRestart.legacyUnassignedProfiles.includes("profile-05"),
      "D) Les profils crees APRES la migration (03/04/05) ne sont jamais mis en quarantaine a leur tour"
    );

    // ----- Test F (partiel, complete dans le scenario 2): aucun login/mot de passe dans le mapping/logs -----
    const mappingRaw = readFileSync(path.join(getStateDir(settings), "account-profile-map.json"), "utf8");
    assert(!mappingRaw.toLowerCase().includes("legacymigration"), "F) Aucun login en clair dans le fichier de mapping");
    assert(!capturedLogs.join("\n").toLowerCase().includes("legacymigration"), "F) Aucun login en clair dans les logs locaux captures");
  } finally {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try { rmSync(dataRoot, { recursive: true, force: true }); break; } catch { if (attempt < 5) await new Promise((r) => setTimeout(r, 300)); }
    }
  }
};

// ===================== Scenario 2 (test E): mapping v1 preexistant avec une association deja valide =====================

const runScenario2 = async (): Promise<void> => {
  log("SCENARIO-2", "=== Migration v1 -> v3 avec association deja valide ===");
  const dataRoot = path.resolve(`.test-legacy-migration-s2-${Date.now()}`);
  const settings = makeSettings(dataRoot);
  const capturedLogs: string[] = [];
  const captureLog = (_level: unknown, message: string): void => { capturedLogs.push(message); };

  try {
    // Compte A deja mappe vers profile-01 par l'ANCIEN code (mapping v1,
    // sans quarantaine) - profile-02 existe aussi sur disque mais n'a jamais
    // ete mappe (reliquat pre-mapping, meme sous ce mapping v1).
    const accountKeyA = await computeAccountKey(settings, RAW_LOGIN_A, captureLog);
    createLegacyProfileDir(settings, "profile-01");
    createLegacyProfileDir(settings, "profile-02");
    writeFileSync(
      path.join(getStateDir(settings), "account-profile-map.json"),
      JSON.stringify({ formatVersion: 1, accounts: { [accountKeyA]: "profile-01" } }, null, 2)
    );

    const leaseA = await acquireProfileLockForAccount(settings, RAW_LOGIN_A, captureLog);
    assert(path.basename(leaseA.profilePath) === "profile-01", `v1->v3) Le compte A deja mappe (mapping v1 preexistant) reste sur profile-01 (recu: ${path.basename(leaseA.profilePath)})`);
    leaseA.release();

    const migratedMapping = readMapping(settings);
    assert(migratedMapping.formatVersion === 3, "v1->v3) Le mapping v1 est bien mis a niveau directement vers formatVersion=3");
    assert(migratedMapping.accounts[accountKeyA] === "profile-01", "v1->v3) L'association deja valide (A -> profile-01) est conservee telle quelle, jamais transformee en legacy");
    assert(!migratedMapping.legacyUnassignedProfiles.includes("profile-01"), "v1->v3) profile-01 (deja mappe) n'est jamais mis en quarantaine");
    assert(migratedMapping.legacyUnassignedProfiles.includes("profile-02"), "v1->v3) profile-02 (jamais mappe, meme sous l'ancien mapping v1) est mis en quarantaine lors de cette migration");
    assert(Array.isArray(migratedMapping.anonymousProfiles) && migratedMapping.anonymousProfiles.length === 0, "v1->v3) anonymousProfiles demarre vide (concept inexistant avant ce hotfix)");

    // Un nouveau compte B ne doit toujours pas recevoir profile-02 (legacy).
    const leaseB = await acquireProfileLockForAccount(settings, RAW_LOGIN_B, captureLog);
    assert(path.basename(leaseB.profilePath) !== "profile-02", `v1->v3) Un nouveau compte B n'obtient jamais profile-02 (legacy, meme post-migration) (recu: ${path.basename(leaseB.profilePath)})`);
    leaseB.release();

    // ----- Test F: aucun login/mot de passe dans le mapping/logs -----
    const allDiskContent = collectAllFileContents(dataRoot);
    assert(!allDiskContent.toLowerCase().includes("legacymigration"), "F) Aucun login en clair sur disque (mapping compris) apres migration v1->v3");
    assert(!allDiskContent.includes(RAW_PASSWORD_NEVER_USED), "F) Aucun mot de passe sur disque (jamais transmis a ce module, verifie malgre tout)");
    assert(!capturedLogs.join("\n").toLowerCase().includes("legacymigration"), "F) Aucun login en clair dans les logs locaux");
    assert(!capturedLogs.join("\n").includes(RAW_PASSWORD_NEVER_USED), "F) Aucun mot de passe dans les logs locaux");
  } finally {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try { rmSync(dataRoot, { recursive: true, force: true }); break; } catch { if (attempt < 5) await new Promise((r) => setTimeout(r, 300)); }
    }
  }
};

// ===================== Scenario 3 (tests A-F): migration v2 -> v3, profils    =====================
// =====================            existants non classes mis en quarantaine   =====================

const runScenario3 = async (): Promise<void> => {
  log("SCENARIO-3", "=== CORRECTIF migration v2 -> v3: profils existants non classes mis en quarantaine (tests A-F) ===");
  const dataRoot = path.resolve(`.test-legacy-migration-s3-${Date.now()}`);
  const settings = makeSettings(dataRoot);
  const capturedLogs: string[] = [];
  const captureLog = (_level: unknown, message: string): void => { capturedLogs.push(message); };

  try {
    // Mapping v2 deja etabli par le hotfix precedent: A -> profile-01,
    // profile-02 deja classe legacy. profile-03 existe AUSSI sur disque mais
    // n'a jamais ete classe par ce mapping v2 (ni mappe, ni legacy): sous
    // l'ancien code v2, un flux anonyme a pu l'utiliser sans jamais le
    // persister (anonymousProfiles n'existait pas encore). Le CORRECTIF exige
    // que la migration v2->v3 le detecte et le mette en quarantaine (legacy,
    // jamais anonymous - on ne peut pas prouver son origine), UNE SEULE FOIS.
    const accountKeyA = await computeAccountKey(settings, RAW_LOGIN_A, captureLog);
    createLegacyProfileDir(settings, "profile-01");
    createLegacyProfileDir(settings, "profile-02");
    createLegacyProfileDir(settings, "profile-03");
    writeFileSync(
      path.join(getStateDir(settings), "account-profile-map.json"),
      JSON.stringify({ formatVersion: 2, accounts: { [accountKeyA]: "profile-01" }, legacyUnassignedProfiles: ["profile-02"] }, null, 2)
    );

    // ----- Test A: migration declenchee par la premiere allocation -----
    const leaseA = await acquireProfileLockForAccount(settings, RAW_LOGIN_A, captureLog);
    assert(path.basename(leaseA.profilePath) === "profile-01", `A) Le compte A deja mappe (mapping v2 preexistant) reste sur profile-01 (recu: ${path.basename(leaseA.profilePath)})`);
    leaseA.release();

    const migratedMapping = readMapping(settings);
    assert(migratedMapping.formatVersion === 3, "A) Le mapping v2 est bien mis a niveau vers formatVersion=3");
    assert(migratedMapping.accounts[accountKeyA] === "profile-01", "A) accounts est conserve tel quel lors de la migration v2->v3");
    assert(
      JSON.stringify(migratedMapping.legacyUnassignedProfiles.slice().sort()) === JSON.stringify(["profile-02", "profile-03"]),
      `A) legacyUnassignedProfiles contient profile-02 (deja classe sous v2) ET profile-03 (decouvert sur disque lors du scan unique de migration) (recu: ${JSON.stringify(migratedMapping.legacyUnassignedProfiles)})`
    );
    assert(Array.isArray(migratedMapping.anonymousProfiles) && migratedMapping.anonymousProfiles.length === 0, "A) anonymousProfiles demarre vide lors d'une migration v2->v3");

    // ----- Test B: un nouveau compte identifie ne recoit jamais profile-03 -----
    const leaseB = await acquireProfileLockForAccount(settings, RAW_LOGIN_B, captureLog);
    assert(path.basename(leaseB.profilePath) !== "profile-03", `B) Un nouveau compte B n'obtient jamais profile-03 (mis en quarantaine lors de la migration v2->v3) (recu: ${path.basename(leaseB.profilePath)})`);
    leaseB.release();

    // ----- Test C: un bot anonyme ne recoit jamais profile-03 -----
    const leaseAnon = acquireAnonymousProfileLock(settings);
    assert(path.basename(leaseAnon.profilePath) !== "profile-03", `C) Un bot anonyme n'obtient jamais profile-03 (quarantaine, pas anonymousProfiles) (recu: ${path.basename(leaseAnon.profilePath)})`);
    leaseAnon.release();

    // ----- Test D: redemarrage v3 -> aucun nouveau scan, classification inchangee -----
    const mappingBeforeRestart = readMapping(settings);
    const leaseARestart = await acquireProfileLockForAccount(settings, RAW_LOGIN_A, captureLog);
    assert(path.basename(leaseARestart.profilePath) === "profile-01", "D) Apres redemarrage simule (mapping deja v3), le compte A reste sur profile-01");
    leaseARestart.release();
    const mappingAfterRestart = readMapping(settings);
    assert(
      JSON.stringify(mappingAfterRestart.legacyUnassignedProfiles.slice().sort()) === JSON.stringify(mappingBeforeRestart.legacyUnassignedProfiles.slice().sort()),
      "D) La quarantaine (legacyUnassignedProfiles) n'est jamais reevaluee differemment une fois le mapping deja en v3 (aucun rescan automatique)"
    );

    // ----- Test E: un profil deja mappe dans accounts ne passe jamais en legacy -----
    assert(!mappingAfterRestart.legacyUnassignedProfiles.includes("profile-01"), "E) profile-01 (deja dans accounts) n'est jamais mis en quarantaine, ni lors de la migration ni ensuite");

    // ----- Test F: aucun login/mot de passe dans le mapping/logs -----
    const allDiskContent = collectAllFileContents(dataRoot);
    assert(!allDiskContent.toLowerCase().includes("legacymigration"), "F) Aucun login en clair sur disque apres migration v2->v3");
    assert(!allDiskContent.includes(RAW_PASSWORD_NEVER_USED), "F) Aucun mot de passe sur disque apres migration v2->v3");
    assert(!capturedLogs.join("\n").toLowerCase().includes("legacymigration"), "F) Aucun login en clair dans les logs locaux (migration v2->v3)");
  } finally {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try { rmSync(dataRoot, { recursive: true, force: true }); break; } catch { if (attempt < 5) await new Promise((r) => setTimeout(r, 300)); }
    }
  }
};

const main = async (): Promise<void> => {
  log("BOOT", "=== Test cible - migration sure des profils Chrome legacy non mappes ===");
  await runScenario1();
  await runScenario2();
  await runScenario3();
  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
