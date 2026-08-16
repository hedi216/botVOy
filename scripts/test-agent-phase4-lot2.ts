// Tests Phase 4 / Lot 2: AgentBotManager, profils locaux, cycle de vie reel
// de Chrome (START_BOT/STOP_BOT), sans le moteur de surveillance (Lot 3/4).
//
// Suite A: appels directs a AgentBotManager (import du vrai module, dans ce
// meme process) pour les scenarios ou l'attribution precise d'un PID Chrome
// a un bot precis est necessaire (deux profils, arret cible, verrou, chemin
// malveillant, capacite). Chrome est reellement lance pour chaque scenario
// qui l'exige: rien n'est simule.
//
// Suite B: bout en bout reel (serveur + vrai agent:dev + dispatch socket
// reel), pour prouver que le chemin complet START_BOT/STOP_BOT et Ctrl+C
// fonctionnent depuis l'interface web jusqu'a Chrome.
//
// Usage: npx tsx scripts/test-agent-phase4-lot2.ts

import { ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { io as ioClient, Socket } from "socket.io-client";
import { pool } from "../src/db.js";
import { AgentBotManager } from "../src/agent/agentBotManager.js";
import { AgentEventReporter } from "../src/agent/agentEventReporter.js";
import { AgentRuntimeSettings } from "../src/agent/types.js";

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// --- Inventaire chrome.exe avec parente (pour attribuer un PID a un bot ou a un process precis) ---

type ChromeProcInfo = { pid: string; parentPid: string };

const listChromeProcs = (): Promise<ChromeProcInfo[]> => new Promise((resolve) => {
  if (process.platform !== "win32") { resolve([]); return; }
  const child = spawn("wmic", ["process", "where", "Name='chrome.exe'", "get", "ProcessId,ParentProcessId"]);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.on("exit", () => {
    const rows = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(1);
    const procs = rows.map((row) => {
      const parts = row.split(/\s+/).filter(Boolean);
      return { pid: parts[1] ?? "", parentPid: parts[0] ?? "" };
    }).filter((p) => /^\d+$/.test(p.pid));
    resolve(procs);
  });
  child.on("error", () => resolve([]));
});

// Chaque instance de navigateur Chrome se traduit par ~8-10 process OS
// (crashpad-handler, gpu-process, utility, renderers...), tous enfants du
// process "racine" (browser process). Pour compter combien de NAVIGATEURS
// distincts sont ouverts (et non combien de process OS au total), on ne
// retient que les racines: celles dont le parent n'est pas lui-meme un
// chrome.exe connu.
const rootPids = (procs: ChromeProcInfo[]): string[] => {
  const allPids = new Set(procs.map((p) => p.pid));
  return procs.filter((p) => !allPids.has(p.parentPid)).map((p) => p.pid);
};

const killPids = async (pids: string[]): Promise<void> => {
  for (const pid of pids) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", pid, "/T", "/F"]);
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
  }
};

// --- Suite A: AgentBotManager en direct ---

type CapturedEvent = { kind: "ack" | "completed" | "failed" | "botStatus"; args: unknown[] };

const makeCapturingReporter = (): { reporter: AgentEventReporter; events: CapturedEvent[] } => {
  const events: CapturedEvent[] = [];
  const reporter: AgentEventReporter = {
    ack: (commandId) => events.push({ kind: "ack", args: [commandId] }),
    completed: (commandId, result) => events.push({ kind: "completed", args: [commandId, result] }),
    failed: (commandId, code, message) => events.push({ kind: "failed", args: [commandId, code, message] }),
    botStatus: (botId, commandId, status, details) => events.push({ kind: "botStatus", args: [botId, commandId, status, details] })
  };
  return { reporter, events };
};

const findFailure = (events: CapturedEvent[], commandId: string): { code: string; message: string } | undefined => {
  const entry = events.find((e) => e.kind === "failed" && e.args[0] === commandId);
  return entry ? { code: entry.args[1] as string, message: entry.args[2] as string } : undefined;
};

const findCompletion = (events: CapturedEvent[], commandId: string): unknown | undefined =>
  events.find((e) => e.kind === "completed" && e.args[0] === commandId)?.args[1];

const hasBotStatus = (events: CapturedEvent[], botId: string, status: string): boolean =>
  events.some((e) => e.kind === "botStatus" && e.args[0] === botId && e.args[2] === status);

const TEST_DATA_ROOT = path.join(process.cwd(), `.test-agent-lot2-data-${Date.now()}`);

const makeSettings = (overrides: Partial<AgentRuntimeSettings> = {}): AgentRuntimeSettings => ({
  serverUrl: "http://localhost:0",
  credentialsPath: path.join(TEST_DATA_ROOT, "creds.json"),
  computerName: "TEST-LOT2-PC",
  version: "0.1.0",
  targetMode: "fixture",
  fixtureUrl: "about:blank",
  targetUrl: "about:blank",
  maxActiveBots: 15,
  dataRoot: TEST_DATA_ROOT,
  ...overrides
});

// Lot 6 (audit final, section 1/8): CORRECTIF - cette fonction tuait
// auparavant TOUS les chrome.exe du systeme sans filtrage, y compris un
// Chrome personnel de l'utilisateur ouvert independamment du test. Elle
// exige desormais une baseline (PIDs deja presents AVANT que ce test ne
// lance quoi que ce soit) et ne touche jamais qu'aux process apparus depuis.
const cleanupChromeAndDir = async (baselinePids: string[]): Promise<void> => {
  const stray = (await listChromeProcs()).map((p) => p.pid).filter((pid) => !baselinePids.includes(pid));
  if (stray.length > 0) {
    await killPids(stray);
  }
  if (existsSync(TEST_DATA_ROOT)) {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  }
};

const runSuiteA = async (): Promise<void> => {
  log("SUITE-A", "=== AgentBotManager (appels directs) ===");
  // Capture AVANT tout lancement de Chrome par ce test: le nettoyage final
  // (finally ci-dessous) ne doit jamais toucher un Chrome deja present pour
  // une autre raison (session personnelle de l'utilisateur, par exemple).
  const suiteABaseline = (await listChromeProcs()).map((p) => p.pid);

  try {
  // --- botId malveillant ---
  {
    const settings = makeSettings();
    const { reporter, events } = makeCapturingReporter();
    const manager = new AgentBotManager(settings, log, reporter);
    await manager.startBot({ commandId: "cmd-traversal", botId: "../../evil" });
    const failure = findFailure(events, "cmd-traversal");
    assert(failure?.code === "PROFILE_CREATE_FAILED", "botId avec traversee de chemin (../../evil) refuse avec PROFILE_CREATE_FAILED");
    assert(!existsSync(path.join(TEST_DATA_ROOT, "..", "..", "evil")), "aucun dossier cree hors du perimetre profils pour un botId malveillant");
  }

  // --- profil verrouille (verrou detenu par un autre process reel, vivant) ---
  {
    const settings = makeSettings();
    const profileDir = path.join(TEST_DATA_ROOT, "profiles", "bot-lock-test");
    mkdirSync(profileDir, { recursive: true });

    // Process externe reel et vivant (pas la meme PID que ce process de test):
    // seul un vrai PID different et vivant doit etre reconnu comme un verrou
    // actif tenu par "une autre instance" (cf. agentProfileManager.ts).
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
    await sleep(300);
    writeFileSync(path.join(profileDir, ".rendezbot-agent.lock"), String(holder.pid));

    const { reporter, events } = makeCapturingReporter();
    const manager = new AgentBotManager(settings, log, reporter);
    await manager.startBot({ commandId: "cmd-lock-1", botId: "bot-lock-test" });
    const failure = findFailure(events, "cmd-lock-1");
    assert(failure?.code === "PROFILE_LOCKED", `un profil deja verrouille par un process reel et vivant est refuse avec PROFILE_LOCKED (recu: ${JSON.stringify(failure)})`);
    assert(!manager.isActive("bot-lock-test"), "aucun bot n'est enregistre localement quand le profil est verrouille");

    holder.kill();
    await sleep(300);

    // Une fois le process detenteur mort, le verrou est perime: le meme
    // botId doit pouvoir demarrer normalement (Chrome reellement ouvert).
    await manager.startBot({ commandId: "cmd-lock-2", botId: "bot-lock-test" });
    assert(hasBotStatus(events, "bot-lock-test", "WAITING_FOR_USER"), "apres liberation du verrou perime, le meme botId demarre normalement (Chrome reellement ouvert)");

    await manager.stopBot({ commandId: "cmd-lock-stop", botId: "bot-lock-test" });
    assert(hasBotStatus(events, "bot-lock-test", "STOPPED"), "arret propre du bot apres liberation du verrou perime");
  }

  // --- deux bots, deux profils, arret cible, aucun orphelin ---
  {
    const settings = makeSettings({ maxActiveBots: 5 });
    const { reporter, events } = makeCapturingReporter();
    const manager = new AgentBotManager(settings, log, reporter);

    const before = await listChromeProcs();
    const beforeRoots = new Set(rootPids(before));
    await manager.startBot({ commandId: "cmd-a", botId: "bot-a" });
    const afterA = await listChromeProcs();
    const newA = afterA.filter((p) => !before.some((b) => b.pid === p.pid));
    const newRootsA = rootPids(afterA).filter((pid) => !beforeRoots.has(pid));
    assert(newRootsA.length === 1, `un seul nouveau navigateur (process racine) apres le demarrage de bot-a (trouve: ${newRootsA.length})`);

    await manager.startBot({ commandId: "cmd-b", botId: "bot-b" });
    const afterB = await listChromeProcs();
    const newB = afterB.filter((p) => !afterA.some((b) => b.pid === p.pid));
    const newRootsB = rootPids(afterB).filter((pid) => !beforeRoots.has(pid) && !newRootsA.includes(pid));
    assert(newRootsB.length === 1, `un seul nouveau navigateur (process racine) apres le demarrage de bot-b (trouve: ${newRootsB.length})`);

    const profileA = path.join(TEST_DATA_ROOT, "profiles", "bot-a");
    const profileB = path.join(TEST_DATA_ROOT, "profiles", "bot-b");
    assert(existsSync(profileA) && existsSync(profileB) && profileA !== profileB, "bot-a et bot-b utilisent deux dossiers de profil distincts");

    assert(hasBotStatus(events, "bot-a", "WAITING_FOR_USER") && hasBotStatus(events, "bot-b", "WAITING_FOR_USER"), "les deux bots atteignent WAITING_FOR_USER independamment");

    const completionA = findCompletion(events, "cmd-a") as Record<string, unknown> | undefined;
    assert(
      Boolean(completionA) && !("profilePath" in (completionA ?? {})) && !("debugPort" in (completionA ?? {})) && !("browserProcess" in (completionA ?? {})),
      "le resultat public de START_BOT ne contient jamais profilePath/debugPort/browserProcess"
    );
    assert(
      completionA?.botId === "bot-a" && completionA?.status === "WAITING_FOR_USER" && completionA?.started === true && completionA?.computerName === "TEST-LOT2-PC",
      `le resultat public de START_BOT expose botId/status/started/computerName (recu: ${JSON.stringify(completionA)})`
    );

    // bot deja actif
    const { events: dupEvents } = { events };
    await manager.startBot({ commandId: "cmd-a-dup", botId: "bot-a" });
    const dupFailure = findFailure(dupEvents, "cmd-a-dup");
    assert(dupFailure?.code === "BOT_ALREADY_RUNNING", "un second START_BOT sur un botId deja actif est refuse avec BOT_ALREADY_RUNNING");

    // arret cible: stopper bot-a ne doit pas fermer bot-b
    const chromeBeforeStop = await listChromeProcs();
    const rootsBeforeStop = rootPids(chromeBeforeStop).length;
    await manager.stopBot({ commandId: "cmd-stop-a", botId: "bot-a" });
    // taskkill /F retourne des que l'arret est demande, mais Windows peut
    // mettre quelques centaines de ms a faire disparaitre tous les
    // sous-process d'un arbre Chrome complet (crashpad/gpu/renderers): on
    // reverifie brievement avant de conclure (meme pattern que shutdownAll
    // plus bas dans ce fichier).
    let chromeAfterStopA = await listChromeProcs();
    const stopADeadline = Date.now() + 5_000;
    while (Date.now() < stopADeadline) {
      chromeAfterStopA = await listChromeProcs();
      const settled = newA.every((p) => !chromeAfterStopA.some((c) => c.pid === p.pid));
      if (settled) break;
      await sleep(300);
    }
    const bPidStillAlive = newB.every((p) => chromeAfterStopA.some((c) => c.pid === p.pid));
    const aPidGone = newA.every((p) => !chromeAfterStopA.some((c) => c.pid === p.pid));
    assert(aPidGone, "STOP_BOT sur bot-a ferme bien le chrome.exe de bot-a (et tous ses sous-process)");
    assert(bPidStillAlive, "STOP_BOT sur bot-a NE ferme PAS le chrome.exe de bot-b");
    assert(rootPids(chromeAfterStopA).length === rootsBeforeStop - 1, "un seul navigateur (process racine) disparait apres l'arret d'un seul bot");

    // STOP_BOT idempotent sur un botId inconnu de ce manager
    await manager.stopBot({ commandId: "cmd-stop-unknown", botId: "bot-does-not-exist" });
    const unknownCompletion = findCompletion(events, "cmd-stop-unknown") as Record<string, unknown> | undefined;
    assert(unknownCompletion?.alreadyStopped === true, "STOP_BOT sur un botId inconnu est idempotent (COMPLETED, alreadyStopped=true), pas une erreur");
    // CORRECTIF CIBLE (convergence STOP_BOT / bots fantomes): ce chemin doit
    // aussi emettre BOT_STATUS STOPPED (jamais seulement COMMAND_COMPLETED) -
    // sans cela, AgentBotRecord.botStatus/active ne convergent jamais cote
    // serveur pour un STOP_BOT sur un bot deja absent localement.
    assert(hasBotStatus(events, "bot-does-not-exist", "STOPPED"), "STOP_BOT idempotent emet aussi BOT_STATUS STOPPED (convergence serveur AgentBotRecord.active/botStatus)");

    // nettoyage: fermer bot-b aussi et verifier plus aucun orphelin
    await manager.stopBot({ commandId: "cmd-stop-b", botId: "bot-b" });
    const chromeFinal = await listChromeProcs();
    assert(!newA.some((p) => chromeFinal.some((c) => c.pid === p.pid)) && !newB.some((p) => chromeFinal.some((c) => c.pid === p.pid)), "aucun process chrome.exe orphelin apres l'arret des deux bots");
  }

  // --- capacite locale ---
  {
    const settings = makeSettings({ maxActiveBots: 1 });
    const { reporter, events } = makeCapturingReporter();
    const manager = new AgentBotManager(settings, log, reporter);
    await manager.startBot({ commandId: "cmd-cap-1", botId: "bot-cap-1" });
    assert(hasBotStatus(events, "bot-cap-1", "WAITING_FOR_USER"), "premier bot demarre normalement avec maxActiveBots=1");
    await manager.startBot({ commandId: "cmd-cap-2", botId: "bot-cap-2" });
    const capFailure = findFailure(events, "cmd-cap-2");
    assert(capFailure?.code === "AGENT_CAPACITY_REACHED", "un second bot au-dela de la limite locale est refuse avec AGENT_CAPACITY_REACHED");
    await manager.stopBot({ commandId: "cmd-cap-stop", botId: "bot-cap-1" });
  }

  // --- fermeture manuelle de Chrome detectee ---
  {
    const settings = makeSettings();
    const { reporter, events } = makeCapturingReporter();
    const manager = new AgentBotManager(settings, log, reporter);
    const before = await listChromeProcs();
    const beforeRootsManual = new Set(rootPids(before));
    await manager.startBot({ commandId: "cmd-manual-close", botId: "bot-manual-close" });
    const after = await listChromeProcs();
    const newRootPid = rootPids(after).find((pid) => !beforeRootsManual.has(pid));
    assert(Boolean(newRootPid), "process racine chrome.exe identifie pour le test de fermeture manuelle");

    if (newRootPid) {
      // /T tue aussi les sous-process (crashpad/gpu/renderers): tuer la
      // racine simule fidelement une fermeture manuelle complete par l'utilisateur.
      await killPids([newRootPid]);
      const deadline = Date.now() + 8_000;
      let detected = false;
      while (Date.now() < deadline) {
        if (hasBotStatus(events, "bot-manual-close", "STOPPED")) { detected = true; break; }
        await sleep(200);
      }
      assert(detected, "la fermeture manuelle du Chrome du bot est detectee et remontee en BOT_STATUS STOPPED");
      assert(!manager.isActive("bot-manual-close"), "le bot est retire du registre local apres fermeture manuelle");
    }
  }

  // --- Ctrl+C / shutdownAll ferme tous les navigateurs ---
  {
    const settings = makeSettings({ maxActiveBots: 5 });
    const { reporter } = makeCapturingReporter();
    const manager = new AgentBotManager(settings, log, reporter);
    const before = await listChromeProcs();
    await manager.startBot({ commandId: "cmd-shut-1", botId: "bot-shut-1" });
    await manager.startBot({ commandId: "cmd-shut-2", botId: "bot-shut-2" });
    const afterStart = await listChromeProcs();
    const newPids = afterStart.filter((p) => !before.some((b) => b.pid === p.pid));
    const beforeRootsShut = new Set(rootPids(before));
    const newRootsShut = rootPids(afterStart).filter((pid) => !beforeRootsShut.has(pid));
    assert(newRootsShut.length === 2, `deux navigateurs (process racine) attendus avant shutdownAll (trouve: ${newRootsShut.length})`);

    await manager.shutdownAll();
    // taskkill /F retourne des que l'arret est demande, mais Windows peut
    // mettre quelques centaines de ms a reellement faire disparaitre tous
    // les sous-process d'un arbre (surtout quand deux arbres sont tues en
    // parallele): on reverifie brievement avant de conclure a un orphelin.
    let stillAlive = newPids;
    const pollDeadline = Date.now() + 5_000;
    while (Date.now() < pollDeadline) {
      const afterShutdown = await listChromeProcs();
      stillAlive = newPids.filter((p) => afterShutdown.some((c) => c.pid === p.pid));
      if (stillAlive.length === 0) break;
      await sleep(300);
    }
    assert(stillAlive.length === 0, "shutdownAll() (Ctrl+C) ferme tous les navigateurs actifs sans exception");
    assert(manager.activeCount() === 0, "le registre local est vide apres shutdownAll()");
  }
  } finally {
    // Lot 6: deplace dans un finally (auparavant en fin de fonction: un
    // throw plus haut - assertion echouee, exception - sautait ce nettoyage
    // et pouvait laisser un Chrome de test orphelin).
    await cleanupChromeAndDir(suiteABaseline);
  }
};

// --- Suite B: bout en bout reel (serveur + agent:dev + dispatch socket) ---

const requestJson = async (baseUrl: string, method: string, pathName: string, cookie: string | undefined, json?: unknown) => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(json ?? {}) } : {})
  });
  const text = await res.text();
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie: setCookie?.split(";")[0] };
};

const waitForServerReady = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/me`);
      if (r.status === 401 || r.status === 200) return;
    } catch { /* pas pret */ }
    await sleep(500);
  }
  throw new Error("Serveur de test jamais pret.");
};

const runSuiteB = async (): Promise<void> => {
  log("SUITE-B", "=== Bout en bout reel (serveur + agent:dev + Chrome) ===");
  const RUN_SUFFIX = Date.now();
  const port = 3402;
  const baseUrl = `http://localhost:${port}`;
  const agentDataRoot = path.join(process.cwd(), `.test-agent-lot2-e2e-${RUN_SUFFIX}`);
  const credPath = path.join(process.cwd(), `.test-agent-lot2-e2e-creds-${RUN_SUFFIX}.json`);

  const chromeBaseline = (await listChromeProcs()).map((p) => p.pid);

  // Declares en amont (jamais const a l'interieur du try) et initialises:
  // le finally ci-dessous doit pouvoir les lire meme si une exception
  // interrompt le try AVANT que ces variables n'aient ete assignees (une
  // const referencee dans un finally alors qu'elle n'a jamais ete atteinte
  // dans le try leve sa propre ReferenceError - "temporal dead zone" - qui
  // masquerait l'erreur d'origine et interromprait le nettoyage a son tour).
  let server: ChildProcess | undefined;
  let agent: ChildProcess | undefined;
  let uiSocket: Socket | undefined;
  let agencyName = "";
  let managerLogin = "";

  // Lot 6: le corps de cette suite est enveloppe dans try/finally pour
  // garantir que le nettoyage (process serveur/agent, Chrome orphelin,
  // lignes DB, fichiers temporaires) s'execute meme si une
  // assertion/etape intermediaire echoue avec une exception.
  try {

  server = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "src/server.ts"], {
    // https:// obligatoire pour un hote distant (Phase 5, Lot 4): un placeholder
    // http:// ferait desormais echouer le demarrage du serveur des la lecture
    // de la configuration de release (voir loadAgentReleaseConfig()).
    env: { ...process.env, WEB_PORT: String(port), BOT_EXECUTION_MODE: "agent", AGENT_UI_ENABLED: "true", AGENT_DOWNLOAD_URL: "https://example.test" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  const serverStdout: string[] = [];
  server.stdout?.on("data", (c: Buffer) => { serverStdout.push(c.toString()); });
  server.stderr?.on("data", (c: Buffer) => { serverStdout.push(c.toString()); });
  await waitForServerReady(baseUrl);

  const adminCookie = (await requestJson(baseUrl, "POST", "/api/login", undefined, { login: "admin", password: "HtlsH2030*" })).cookie!;
  agencyName = `Test Lot2 ${RUN_SUFFIX}`;
  const agencyId = (await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
  managerLogin = `test-lot2-${RUN_SUFFIX}`;
  const userRes = await requestJson(baseUrl, "POST", "/api/users", adminCookie, { agencyId, login: managerLogin, name: "Lot2 Manager", email: `${managerLogin}@example.test`, role: 1 });
  const managerPassword = userRes.body.temporaryPassword;
  const managerCookie = (await requestJson(baseUrl, "POST", "/api/login", undefined, { login: managerLogin, password: managerPassword })).cookie!;

  const pairing = await requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
  const code = pairing.body.pairing.code;

  // Invoque tsx directement via node (sans npx/cmd.exe): un SIGINT reel doit
  // atteindre CE process node precis. Passer par un shell intermediaire
  // (npx.cmd sous Windows) ne relaie pas fiablement le signal au process
  // node reellement charge de src/agent/agentMain.ts.
  const tsxPreflight = path.join(process.cwd(), "node_modules", "tsx", "dist", "preflight.cjs");
  const tsxLoader = path.join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs");
  agent = spawn(process.execPath, [
    "--require", tsxPreflight,
    "--import", `file://${tsxLoader.replace(/\\/g, "/")}`,
    "src/agent/agentMain.ts", "pair", code
  ], {
    env: {
      ...process.env,
      AGENT_SERVER_URL: baseUrl,
      AGENT_CREDENTIALS_PATH: credPath,
      AGENT_DATA_DIR: agentDataRoot,
      AGENT_COMPUTER_NAME: "E2E-LOT2-PC",
      AGENT_TARGET_MODE: "fixture",
      AGENT_FIXTURE_URL: "about:blank",
      AGENT_MAX_ACTIVE_BOTS: "5"
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });
  const agentStdout: string[] = [];
  agent.stdout?.on("data", (c: Buffer) => { const t = c.toString(); agentStdout.push(t); log("AGENT", t.trim()); });
  agent.stderr?.on("data", (c: Buffer) => { const t = c.toString(); agentStdout.push(t); log("AGENT-ERR", t.trim()); });

  await sleep(2_500);

  uiSocket = await new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { autoConnect: false, reconnection: false, extraHeaders: { Cookie: managerCookie } });
    const t = setTimeout(() => reject(new Error("timeout ui socket")), 8_000);
    s.on("connect", () => { clearTimeout(t); resolve(s); });
    s.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
    s.connect();
  });

  const commandEvents: Record<string, unknown>[] = [];
  uiSocket.on("agent-command-status", (payload: Record<string, unknown>) => commandEvents.push(payload));

  log("TEST", "Emission start-bot (E2E reel)...");
  const clientRequestId = `e2e-lot2-${RUN_SUFFIX}`;
  uiSocket.emit("start-bot", { botName: "E2E Bot", clientRequestId });

  const waitForStatus = async (predicate: (e: Record<string, unknown>) => boolean, timeoutMs = 15_000): Promise<Record<string, unknown> | undefined> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = commandEvents.find(predicate);
      if (found) return found;
      await sleep(150);
    }
    return undefined;
  };

  const waitingEvent = await waitForStatus((e) => e.botStatus === "WAITING_FOR_USER");
  assert(Boolean(waitingEvent), "BOT_STATUS WAITING_FOR_USER recu par l'interface web via le vrai agent");

  const completedEvent = await waitForStatus((e) => e.status === "COMPLETED");
  assert(Boolean(completedEvent), "COMMAND_COMPLETED recu par l'interface web apres ouverture reelle de Chrome");
  assert(waitingEvent && completedEvent && (waitingEvent.updatedAt as string) <= (completedEvent.updatedAt as string), "WAITING_FOR_USER precede bien COMPLETED (jamais l'inverse)");

  const botId = completedEvent?.botId as string;
  const commandId = completedEvent?.commandId as string;

  const chromeAfterStart = await listChromeProcs();
  const newChromePids = chromeAfterStart.filter((p) => !chromeBaseline.includes(p.pid));
  const newRootPidsStart = rootPids(chromeAfterStart).filter((pid) => !chromeBaseline.includes(pid));
  assert(newRootPidsStart.length === 1, `exactement un nouveau navigateur (process racine) apparait apres START_BOT reel (trouve: ${newRootPidsStart.length})`);

  // Verifie que ce chrome.exe est bien rattache a l'arbre de process de
  // l'AGENT, jamais a celui du SERVEUR (aucun Chrome sur la VM en mode agent).
  const agentTreePids = new Set<string>();
  if (agent.pid) agentTreePids.add(String(agent.pid));
  const collectDescendants = async (rootPid: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    await new Promise<void>((resolve) => {
      const w = spawn("wmic", ["process", "where", `ParentProcessId=${rootPid}`, "get", "ProcessId"]);
      let out = "";
      w.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
      w.on("exit", async () => {
        const pids = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+$/.test(l));
        for (const pid of pids) {
          if (!agentTreePids.has(pid)) {
            agentTreePids.add(pid);
            await collectDescendants(pid, depth + 1);
          }
        }
        resolve();
      });
      w.on("error", () => resolve());
    });
  };
  if (process.platform === "win32" && agent.pid) {
    await collectDescendants(String(agent.pid), 0);
  }
  const newChromeBelongsToAgent = newChromePids.every((p) => agentTreePids.has(p.parentPid));
  assert(process.platform !== "win32" || newChromeBelongsToAgent, "le chrome.exe lance appartient bien a l'arbre de process de l'agent (pas du serveur/VM)");

  const detail = await requestJson(baseUrl, "GET", `/api/agent-commands/${commandId}`, managerCookie);
  const publicResult = JSON.stringify(detail.body?.command?.publicResult ?? {});
  assert(!/profilePath|debugPort|browserProcess|chrome\.exe|--remote-debugging-port/i.test(publicResult), "aucune donnee interne (profilePath/debugPort/args Chrome) dans publicResult expose par l'API");

  // STOP_BOT reel
  uiSocket.emit("stop-bot", { botId, clientRequestId: `e2e-lot2-stop-${RUN_SUFFIX}` });
  const stoppedEvent = await waitForStatus((e) => e.type === "STOP_BOT" && e.status === "COMPLETED");
  assert(Boolean(stoppedEvent), "STOP_BOT reel complete avec succes via l'interface web");

  await sleep(1_000);
  const chromeAfterStop = await listChromeProcs();
  assert(!newChromePids.some((p) => chromeAfterStop.some((c) => c.pid === p.pid)), "le chrome.exe du bot est bien ferme apres STOP_BOT reel, aucun orphelin");

  // Aucune sentinelle secrete nulle part (agent n'a jamais recu login/password: constraint 11)
  const fullServerLog = serverStdout.join("");
  const fullAgentLog = agentStdout.join("");
  assert(!/TEST_SECRET|password|motdepasse/i.test(fullServerLog.replace(/HtlsH2030\*/g, "")), "aucune sentinelle/mot de passe dans les logs serveur");
  assert(!/TEST_SECRET/i.test(fullAgentLog), "aucune sentinelle dans les logs agent");
  const agentLogFile = path.join(agentDataRoot, "logs", "agent.log");
  if (existsSync(agentLogFile)) {
    const fileContent = readFileSync(agentLogFile, "utf8");
    assert(!/password|token|secret/i.test(fileContent) || /le moteur|not_implemented/i.test(fileContent.toLowerCase()), "le fichier de log local de l'agent ne contient pas de mots-cles sensibles inattendus");
  }

  // Ctrl+C reel sur le vrai process agent: doit fermer tout Chrome restant.
  log("TEST", "Envoi d'un second start-bot puis SIGINT reel sur le process agent...");
  uiSocket.emit("start-bot", { botName: "E2E Bot 2", clientRequestId: `e2e-lot2-2-${RUN_SUFFIX}` });
  const waiting2 = await waitForStatus((e) => e.botStatus === "WAITING_FOR_USER" && e.commandId !== commandId);
  assert(Boolean(waiting2), "second bot demarre avant le test Ctrl+C");
  await sleep(500);
  const chromeBeforeSigint = await listChromeProcs();
  const newBeforeSigint = chromeBeforeSigint.filter((p) => !chromeBaseline.includes(p.pid));
  assert(newBeforeSigint.length >= 1, "au moins un chrome.exe actif juste avant le SIGINT");

  if (agent.pid) {
    process.kill(agent.pid, "SIGINT");
  }
  const sigintDeadline = Date.now() + 10_000;
  let agentExited = false;
  agent.once("exit", () => { agentExited = true; });
  while (Date.now() < sigintDeadline && !agentExited) {
    await sleep(200);
  }
  assert(agentExited, "le process agent se termine proprement apres SIGINT (Ctrl+C)");
  await sleep(1_000);
  const chromeAfterSigint = await listChromeProcs();
  assert(!newBeforeSigint.some((p) => chromeAfterSigint.some((c) => c.pid === p.pid)), "SIGINT (Ctrl+C) ferme tous les navigateurs restants, aucun orphelin");

  uiSocket.disconnect();
  } finally {
    // Lot 6: nettoyage garanti (voir commentaire au debut de la fonction),
    // execute meme si une assertion/etape ci-dessus a leve une exception.
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
    await killTree(server?.pid);
    await killTree(agent?.pid);

    const strayChrome = (await listChromeProcs()).filter((p) => !chromeBaseline.includes(p.pid));
    if (strayChrome.length > 0) {
      await killPids(strayChrome.map((p) => p.pid));
    }

    await pool.query("DELETE FROM users WHERE login = $1", [managerLogin]).catch(() => undefined);
    await pool.query("DELETE FROM agencies WHERE name = $1", [agencyName]).catch(() => undefined);
    if (existsSync(credPath)) rmSync(credPath, { force: true });
    if (existsSync(agentDataRoot)) rmSync(agentDataRoot, { recursive: true, force: true });
  }
};

const main = async (): Promise<void> => {
  const which = process.argv[2];

  if (!which || which === "a") {
    try {
      await runSuiteA();
    } catch (error) {
      // Lot 6: le nettoyage lui-meme est desormais garanti par le
      // finally de runSuiteA() (baseline-aware), meme sur ce throw -
      // aucun appel redondant necessaire ici.
      console.error("[FATAL SUITE A]", error);
      failCount += 1;
    }
  }

  if (!which || which === "b") {
    try {
      await runSuiteB();
    } catch (error) {
      console.error("[FATAL SUITE B]", error);
      failCount += 1;
    }
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  await pool.end();
  process.exit(failCount > 0 ? 1 : 0);
};

void main();
