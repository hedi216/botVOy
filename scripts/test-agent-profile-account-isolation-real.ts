// HOTFIX CRITIQUE - isolation des profils Chrome par compte TLS.
//
// Bug reel confirme manuellement: acquirePooledProfileLock() (pool anonyme,
// "premier slot libre") pouvait attribuer a un compte TLS B un profil deja
// utilise par un compte TLS A, qui retrouvait alors la session/cookies de A -
// y compris si le profil n'est plus VERROUILLE mais reste present dans le
// mapping historique (angle explicitement signale: il faut analyser le
// mapping, jamais seulement l'etat de verrouillage courant). Ce test verifie
// acquireProfileLockForAccount()/acquireAnonymousProfileLock() (src/agent/
// agentProfileManager.ts) et computeAccountKey() (src/agent/
// agentAccountKey.ts) : affinite stable compte<->profil, jamais de
// reattribution croisee meme apres liberation, jamais de login/mot de passe
// persiste, flux sans login jamais capable de recuperer un profil mappe, et
// persistance reelle des cookies verifiee avec un vrai Chrome (test H).
//
// PARTIE A: logique pure (mapping/cle), aucun Chrome - tests A a G, I.
// PARTIE B: vrai Chrome, verification fonctionnelle des cookies - test H.
//
// Usage: npx tsx scripts/test-agent-profile-account-isolation-real.ts
//    ou: npm run test:agent:profile-account-isolation:real

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { acquireAnonymousProfileLock, acquireProfileLockForAccount } from "../src/agent/agentProfileManager.js";
import { computeAccountKey, __resetAccountKeyCacheForTests } from "../src/agent/agentAccountKey.js";
import { AgentCommandError } from "../src/agent/agentErrors.js";
import { AgentRuntimeSettings } from "../src/agent/types.js";
import http, { Server } from "node:http";
import { AddressInfo } from "node:net";

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const noopLog = (): void => { /* silencieux: le test log lui-meme via log() */ };

const ACCOUNT_A = "  UserA@Example.TEST  "; // espaces/casse volontaires: verifie la normalisation
const ACCOUNT_B = "userb@example.test";
const RAW_PASSWORD_NEVER_USED = "hunter2FakePasswordNeverPersisted"; // jamais transmis a ce module - verifie son absence totale malgre tout

const RUN_SUFFIX = Date.now();
const dataRoot = path.resolve(`.test-account-isolation-data-${RUN_SUFFIX}`);

const makeSettings = (): AgentRuntimeSettings => ({
  serverUrl: "http://localhost:0",
  credentialsPath: path.join(dataRoot, "credentials", "agent-credentials.json"),
  computerName: "TEST-ACCOUNT-ISOLATION",
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

// ----- F/G: scan recursif de tout ce qui a ete ecrit sur disque -----
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
      try { combined += readFileSync(full, "utf8"); } catch { /* fichier binaire (SQLite Chrome...): ignore, jamais du JSON/texte du mapping */ }
    }
  }
  return combined;
};

const collectAllFileAndDirNames = (root: string): string[] => {
  if (!existsSync(root)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    names.push(entry.name);
    if (entry.isDirectory()) {
      names.push(...collectAllFileAndDirNames(path.join(root, entry.name)));
    }
  }
  return names;
};

// ----- Fixture HTTP minimale pour le test H (cookies reels) -----
// Le cookie sentinelle est pose via un VRAI Set-Cookie HTTP recu pendant une
// vraie navigation (jamais via context.addCookies(), qui l'injecte dans le
// jeton CDP en memoire sans garantie de flush disque avant un arret force de
// Chrome - piege deja constate/documente dans ce depot lors du diagnostic
// Cloudflare precedent: seule la persistance FONCTIONNELLE via une vraie
// requete reseau s'est reveleee fiable pour verifier un cookie apres
// fermeture forcee de Chrome).
type FixtureSite = { server: Server; baseUrl: string };
const startFixtureSite = (): Promise<FixtureSite> => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url === "/set-sentinel") {
      res.setHeader("Set-Cookie", "rendezbot_sentinel=sentinel-account-A; Path=/; Max-Age=86400");
    }
    res.end("<!DOCTYPE html><html><body>Fixture isolation profils/comptes (test uniquement)</body></html>");
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/` });
  });
});

const runPartA = async (): Promise<void> => {
  log("PART-A", "=== Logique pure: mapping accountKey -> profil (tests A, B, C, D, E, F, G, I) ===");
  const settings = makeSettings();
  const capturedLogs: string[] = [];
  const captureLog = (_level: unknown, message: string): void => { capturedLogs.push(message); };

  // ----- Test A: meme compte, deux lancements successifs -> meme profil -----
  const leaseA1 = await acquireProfileLockForAccount(settings, ACCOUNT_A, captureLog);
  assert(path.basename(leaseA1.profilePath) === "profile-01", `A) Premier lancement du compte A -> profile-01 (recu: ${path.basename(leaseA1.profilePath)})`);
  leaseA1.release();

  const leaseA2 = await acquireProfileLockForAccount(settings, ACCOUNT_A, captureLog);
  assert(leaseA2.profilePath === leaseA1.profilePath, `A) Second lancement du compte A apres arret -> le MEME profile-01 (recu: ${path.basename(leaseA2.profilePath)})`);

  // Normalisation: une variante d'ecriture du meme login (espaces/casse
  // differents) doit retrouver EXACTEMENT le meme profil, jamais un nouveau.
  const leaseAVariant = await acquireProfileLockForAccount(settings, "usera@example.test", captureLog).catch(() => null);
  if (leaseAVariant) {
    assert(false, "A) Le compte A ne devrait pas pouvoir demarrer deux fois concurremment (meme normalise differemment)");
    leaseAVariant.release();
  } else {
    assert(true, "A) Une variante de casse/espaces du meme login est bien reconnue comme le MEME compte (refus de double demarrage concurrent, cf. test C)");
  }
  leaseA2.release();

  // ----- Test B: compte A -> profile-01, compte B -> profile-02, stables apres arret -----
  const leaseB1 = await acquireProfileLockForAccount(settings, ACCOUNT_B, captureLog);
  assert(path.basename(leaseB1.profilePath) === "profile-02", `B) Premier lancement du compte B -> profile-02, jamais le profil de A (recu: ${path.basename(leaseB1.profilePath)})`);
  leaseB1.release();

  const leaseB2 = await acquireProfileLockForAccount(settings, ACCOUNT_B, captureLog);
  assert(path.basename(leaseB2.profilePath) === "profile-02", "B) Apres arret des deux: le compte B retrouve toujours profile-02");
  leaseB2.release();

  const leaseA3 = await acquireProfileLockForAccount(settings, ACCOUNT_A, captureLog);
  assert(path.basename(leaseA3.profilePath) === "profile-01", "B) Apres arret des deux: le compte A retrouve toujours profile-01");

  // ----- Test C: deux comptes simultanes -> jamais le meme profilePath -----
  const leaseBConcurrent = await acquireProfileLockForAccount(settings, ACCOUNT_B, captureLog);
  assert(leaseA3.profilePath !== leaseBConcurrent.profilePath, "C) Deux comptes actifs simultanement n'ont jamais le meme profilePath");

  // Refus explicite d'un second bot du MEME compte pendant que le premier tourne.
  let secondSameAccountRejected = false;
  let rejectionCode: string | undefined;
  try {
    await acquireProfileLockForAccount(settings, ACCOUNT_A, captureLog);
  } catch (error) {
    secondSameAccountRejected = true;
    rejectionCode = error instanceof AgentCommandError ? error.code : undefined;
  }
  assert(secondSameAccountRejected, "C) Un second bot du MEME compte TLS deja actif est refuse (jamais un second Chrome sur le meme profil)");
  assert(rejectionCode === "TLS_ACCOUNT_ALREADY_RUNNING", `C) Code d'erreur explicite TLS_ACCOUNT_ALREADY_RUNNING (recu: ${rejectionCode})`);

  leaseA3.release();
  leaseBConcurrent.release();

  // ----- Test D: redemarrage simule de l'agent -> le mapping (et la cle locale) persistent -----
  __resetAccountKeyCacheForTests();
  const keyBeforeRestart = await computeAccountKey(settings, ACCOUNT_A, captureLog);
  __resetAccountKeyCacheForTests(); // force un rechargement REEL depuis disque, comme un vrai redemarrage de process
  const keyAfterRestart = await computeAccountKey(settings, ACCOUNT_A, captureLog);
  assert(keyBeforeRestart === keyAfterRestart, "D) La cle locale (et donc l'accountKey) est identique apres un redemarrage simule de l'agent");

  const leaseAAfterRestart = await acquireProfileLockForAccount(settings, ACCOUNT_A, captureLog);
  assert(path.basename(leaseAAfterRestart.profilePath) === "profile-01", "D) Apres redemarrage simule, le compte A retrouve toujours profile-01 (mapping relu depuis disque)");

  const mappingPath = path.join(dataRoot, "state", "account-profile-map.json");
  assert(existsSync(mappingPath), "D) Le fichier de mapping existe reellement sur disque (persistance reelle, pas seulement en memoire)");
  leaseAAfterRestart.release();

  // ----- Test E: un profile-NN mappe a A (ou B) n'est JAMAIS attribue a un
  // AUTRE compte, meme totalement libre/deverrouille - la seule protection
  // "verrouille => refuse" ne suffirait pas ici: A et B sont bien LIBRES a ce
  // stade (releases ci-dessus), et pourtant un troisieme compte ne doit
  // jamais recevoir profile-01 ni profile-02. -----
  const ACCOUNT_C = "userc@example.test";
  const leaseC = await acquireProfileLockForAccount(settings, ACCOUNT_C, captureLog);
  assert(
    path.basename(leaseC.profilePath) !== "profile-01" && path.basename(leaseC.profilePath) !== "profile-02",
    `E) Un nouveau compte C n'obtient jamais un profil deja mappe a A/B meme libre (recu: ${path.basename(leaseC.profilePath)}, attendu ni profile-01 ni profile-02)`
  );
  leaseC.release();

  // ----- Flux sans login / reservation des profils anonymes (dernier hotfix
  // cible): ne doit JAMAIS pouvoir recuperer silencieusement un profil mappe
  // a un compte TLS connu, meme libre - acquireAnonymousProfileLock() doit
  // toujours reserver un slot strictement distinct de ceux du mapping
  // (profile-01/02/03 ici deja mappes a A/B/C). -----
  const mappingSoFar = JSON.parse(readFileSync(mappingPath, "utf8")) as { accounts: Record<string, string> };
  const mappedSlotsSoFar = new Set(Object.values(mappingSoFar.accounts));
  const anonymousLease1 = acquireAnonymousProfileLock(settings);
  assert(
    !mappedSlotsSoFar.has(path.basename(anonymousLease1.profilePath)),
    `C) acquireAnonymousProfileLock() n'attribue jamais un slot deja mappe a un compte TLS (recu: ${path.basename(anonymousLease1.profilePath)}, mappes: ${[...mappedSlotsSoFar].join(",")})`
  );
  // Meme via acquireProfileLockForAccount() sans login (chemin reellement
  // utilise par startBot() quand params.login est absent/vide): doit
  // aboutir au meme comportement, jamais silencieusement au pool brut.
  const anonymousLease2 = await acquireProfileLockForAccount(settings, undefined, captureLog);
  assert(
    !mappedSlotsSoFar.has(path.basename(anonymousLease2.profilePath)),
    `C) acquireProfileLockForAccount(login absent) n'attribue jamais un slot mappe (recu: ${path.basename(anonymousLease2.profilePath)})`
  );
  assert(anonymousLease1.profilePath !== anonymousLease2.profilePath, "C) deux acquisitions anonymes concurrentes obtiennent des slots distincts");
  const anonymousSlot1 = path.basename(anonymousLease1.profilePath);
  anonymousLease1.release();
  anonymousLease2.release();

  // ----- Test B: un profil anonyme LIBERE peut etre reutilise par le
  // PROCHAIN flux anonyme (contrairement a un profil de compte, qui ne
  // change jamais de nature - regle 3/4 du hotfix, mais le pool anonyme
  // reste interchangeable entre sessions anonymes successives). -----
  const anonymousLease3 = acquireAnonymousProfileLock(settings);
  assert(
    path.basename(anonymousLease3.profilePath) === anonymousSlot1,
    `B) Un profil anonyme libere est bien reutilisable par le flux anonyme suivant (attendu: ${anonymousSlot1}, recu: ${path.basename(anonymousLease3.profilePath)})`
  );
  anonymousLease3.release();

  // ----- Test A: un profil ayant deja servi a un flux ANONYME ne doit
  // JAMAIS etre attribue automatiquement a un NOUVEAU compte identifie,
  // meme totalement libre. -----
  const ACCOUNT_D = "userd@example.test";
  const leaseD = await acquireProfileLockForAccount(settings, ACCOUNT_D, captureLog);
  assert(
    path.basename(leaseD.profilePath) !== anonymousSlot1,
    `A) Un nouveau compte D n'obtient jamais un profil deja utilise par le flux anonyme, meme libre (recu: ${path.basename(leaseD.profilePath)}, anonyme: ${anonymousSlot1})`
  );
  leaseD.release();

  // ----- Test D: redemarrage simule -> anonymousProfiles persiste -----
  const mappingBeforeRestart = JSON.parse(readFileSync(mappingPath, "utf8")) as { anonymousProfiles: string[] };
  assert(
    mappingBeforeRestart.anonymousProfiles.includes(anonymousSlot1),
    `D) Le profil anonyme (${anonymousSlot1}) est bien persiste dans anonymousProfiles sur disque`
  );
  const anonymousLeaseAfterRestart = acquireAnonymousProfileLock(settings);
  assert(
    path.basename(anonymousLeaseAfterRestart.profilePath) === anonymousSlot1,
    `D) Apres redemarrage simule de l'agent, le flux anonyme retrouve toujours le meme profil anonyme (${anonymousSlot1})`
  );
  anonymousLeaseAfterRestart.release();

  // ----- Test F/G: aucun login ni mot de passe en clair nulle part sur disque, ni dans les logs -----
  const allDiskContent = collectAllFileContents(dataRoot);
  const allNames = collectAllFileAndDirNames(dataRoot);
  const allLogsJoined = capturedLogs.join("\n");

  const loginNeedles = ["UserA@Example.TEST", "userA@example.test", "usera@example.test", "userb@example.test", "UserB", ACCOUNT_C, ACCOUNT_D];
  const loginFoundOnDisk = loginNeedles.some((needle) => allDiskContent.toLowerCase().includes(needle.toLowerCase()));
  const loginFoundInNames = loginNeedles.some((needle) => allNames.some((name) => name.toLowerCase().includes(needle.toLowerCase())));
  const loginFoundInLogs = loginNeedles.some((needle) => allLogsJoined.toLowerCase().includes(needle.toLowerCase()));
  assert(!loginFoundOnDisk, "F) Aucun login en clair dans le contenu des fichiers ecrits (mapping compris)");
  assert(!loginFoundInNames, "F) Aucun login en clair dans un nom de fichier/dossier (profils compris)");
  assert(!loginFoundInLogs, "F) Aucun login en clair dans les logs locaux captures");

  const passwordFoundOnDisk = allDiskContent.includes(RAW_PASSWORD_NEVER_USED);
  const passwordFoundInLogs = allLogsJoined.includes(RAW_PASSWORD_NEVER_USED);
  assert(!passwordFoundOnDisk, "G) Aucun mot de passe dans le mapping ni les profils ecrits par RendezBot");
  assert(!passwordFoundInLogs, "G) Aucun mot de passe dans les logs locaux");

  const mappingRaw = readFileSync(mappingPath, "utf8");
  const mapping = JSON.parse(mappingRaw) as { formatVersion: number; accounts: Record<string, string>; legacyUnassignedProfiles: string[]; anonymousProfiles: string[] };
  assert(
    mapping.formatVersion === 3 && typeof mapping.accounts === "object"
    && Array.isArray(mapping.legacyUnassignedProfiles) && Array.isArray(mapping.anonymousProfiles),
    "F/G) Format du mapping conforme (formatVersion=3, accounts={accountKey:slot}, legacyUnassignedProfiles=[], anonymousProfiles=[...])"
  );
  // Ce test utilise un dataRoot neuf (aucun profil pre-existant au moment de
  // la toute premiere lecture du mapping): la migration ne trouve donc rien
  // a mettre en quarantaine ici (cf. scripts/test-agent-profile-legacy-
  // migration-simulated.ts pour la verification dediee de la quarantaine).
  assert(mapping.legacyUnassignedProfiles.length === 0, "F/G) Aucun profil legacy dans ce scenario (dataRoot neuf, rien a migrer)");
  // Deux slots anonymes distincts sont attendus: anonymousLease1/2 ont ete
  // acquis CONCURREMMENT plus haut (avant toute liberation), donc chacun a
  // legitimement reserve son propre nouveau slot (profile-04 et profile-05).
  assert(mapping.anonymousProfiles.length === 2, `F/G) Exactement deux profils anonymes suivis dans ce scenario (recu: ${JSON.stringify(mapping.anonymousProfiles)})`);
  const mappingValues = Object.entries(mapping.accounts);
  assert(
    mappingValues.every(([key, slot]) => /^[0-9a-f]{24}$/.test(key) && /^profile-\d{2,}$/.test(slot)),
    `F/G) Chaque entree du mapping est bien (accountKey hex opaque -> nom de slot), jamais un login (entrees: ${JSON.stringify(mapping.accounts)})`
  );

  // ----- Test I: le hotfix service-level (deja valide separement) n'est pas modifie -----
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.join(here, "..");
  try {
    const diffOutput = execFileSync(
      "git",
      ["diff", "--name-only", "--", "src/shared/loginFlow.ts"],
      { cwd: repoRoot, encoding: "utf8" }
    ).trim();
    assert(diffOutput === "", `I) src/shared/loginFlow.ts (hotfix service-level) n'a subi aucune modification depuis le dernier commit valide (diff: ${JSON.stringify(diffOutput)})`);
  } catch (error) {
    assert(false, `I) Impossible de verifier l'absence de modification de loginFlow.ts via git: ${error instanceof Error ? error.message : String(error)}`);
  }
};

// NOTE IMPORTANTE (decouverte pendant la mise au point de ce test, hors
// perimetre de ce hotfix): l'architecture normale de l'agent (agentBrowserManager.ts,
// launchChromeForBot -> --remote-debugging-port + connectOverCDP) NE RECHARGE
// PAS les cookies persistes depuis le profil au demarrage suivant, meme si
// l'ecriture sur disque (verifiee directement dans le fichier SQLite chiffre
// "Cookies") a bien eu lieu - confirme par diagnostic manuel: un lancement
// normal de Chrome (chromium.launchPersistentContext(), sans CDP) sur le MEME
// profil retrouve le cookie immediatement, alors que le meme profil via
// connectOverCDP ne le retrouve pas. C'est une caracteristique PRE-EXISTANTE
// de la connexion CDP de l'agent (fichier different, jamais touche par ce
// hotfix), pas un defaut de acquireProfileLockForAccount() - a signaler
// separement, hors du perimetre "isolation des profils par compte" de ce
// ticket. Le test H ci-dessous verifie donc la persistance des cookies AU
// NIVEAU DU PROFIL DISQUE (chromium.launchPersistentContext, methode deja
// utilisee ailleurs dans ce depot pour des verifications fonctionnelles de
// cookies) tout en utilisant acquireProfileLockForAccount() (code reellement
// en perimetre) pour determiner QUEL dossier de profil utiliser.
const CHROME_EXECUTABLE_PATH = process.env.CHROME_EXECUTABLE_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const runPartB = async (): Promise<void> => {
  log("PART-B", "=== Persistance reelle des cookies au niveau du profil disque (test H) ===");
  const settings = makeSettings();
  const fixture = await startFixtureSite();
  const noop = noopLog;

  const leaseA1 = await acquireProfileLockForAccount(settings, "cookieUserA@example.test", noop);
  const ctxA1 = await chromium.launchPersistentContext(leaseA1.profilePath, { headless: false, executablePath: CHROME_EXECUTABLE_PATH });
  const pageA1 = ctxA1.pages()[0] ?? await ctxA1.newPage();
  await pageA1.goto(`${fixture.baseUrl}set-sentinel`, { waitUntil: "domcontentloaded" });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await ctxA1.close();
  leaseA1.release();

  const leaseA2 = await acquireProfileLockForAccount(settings, "cookieUserA@example.test", noop);
  assert(leaseA2.profilePath === leaseA1.profilePath, "H) Le second lancement du compte A reutilise bien le meme profil que celui ou le cookie a ete pose");
  const ctxA2 = await chromium.launchPersistentContext(leaseA2.profilePath, { headless: false, executablePath: CHROME_EXECUTABLE_PATH });
  const cookiesA2 = await ctxA2.cookies(fixture.baseUrl);
  assert(
    cookiesA2.some((c) => c.name === "rendezbot_sentinel" && c.value === "sentinel-account-A"),
    "H) Le cookie sentinelle du compte A est retrouve par un nouveau lancement du MEME compte A"
  );
  await ctxA2.close();
  leaseA2.release();

  const leaseB = await acquireProfileLockForAccount(settings, "cookieUserB@example.test", noop);
  assert(leaseB.profilePath !== leaseA1.profilePath, "H) Le compte B obtient un profil different de celui du compte A");
  const ctxB = await chromium.launchPersistentContext(leaseB.profilePath, { headless: false, executablePath: CHROME_EXECUTABLE_PATH });
  const cookiesB = await ctxB.cookies(fixture.baseUrl);
  assert(
    !cookiesB.some((c) => c.name === "rendezbot_sentinel"),
    "H) Le cookie sentinelle du compte A n'est JAMAIS visible dans le profil du compte B"
  );
  await ctxB.close();
  leaseB.release();

  await new Promise<void>((resolve) => { fixture.server.closeAllConnections?.(); fixture.server.close(() => resolve()); });
};

const main = async (): Promise<void> => {
  log("BOOT", "=== Test cible - isolation des profils Chrome par compte TLS ===");

  try {
    await runPartA();
    await runPartB();
  } finally {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        rmSync(dataRoot, { recursive: true, force: true });
        break;
      } catch {
        if (attempt < 5) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
