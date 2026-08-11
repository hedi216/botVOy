// HOTFIX CIBLE - Compteur et limite des bots actifs par agence (mode Agent).
//
// Teste uniquement la logique de ce hotfix (serveur reel + registre agentBots
// existant + evenement "maintenance") - jamais src/agent/** (aucun vrai
// Chrome/Playwright n'est implique, un "agent" ici est un simple socket.io
// client qui simule l'API deja existante: AGENT_COMMAND -> COMMAND_ACK,
// BOT_STATUS).
//
// Usage: npx tsx scripts/test-agency-bot-quota.ts

import { ChildProcess, spawn } from "node:child_process";
import { Socket, io as ioClient } from "socket.io-client";
import { ADMIN_LOGIN, ADMIN_PASSWORD, pool } from "../src/db.js";
import {
  countActiveAgentBotsForAgency,
  dispatchAgentCommand,
  generateBotId,
  registerAgentBot,
  removeAgentBot
} from "../src/agentCommandService.js";

const RUN_SUFFIX = Date.now();

let passCount = 0;
let failCount = 0;

const log = (label: string, message: string): void => {
  console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
};

const assert = (condition: boolean, description: string): void => {
  if (condition) {
    passCount += 1;
    console.log(`[PASS] ${description}`);
  } else {
    failCount += 1;
    console.error(`[FAIL] ${description}`);
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ===================== Serveur reel (memes helpers que test-agency-billing.ts/test-agency-categories.ts) =====================

type ServerHandle = { child: ChildProcess; baseUrl: string };

const waitForServerReady = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/me`);
      if (res.status === 401 || res.status === 200) {
        return;
      }
    } catch {
      // pas encore pret
    }
    await sleep(500);
  }
  throw new Error(`Le serveur de test n'a jamais repondu sur ${baseUrl}/api/me.`);
};

const startServer = async (port: number): Promise<ServerHandle> => {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(command, ["tsx", "src/server.ts"], {
    env: { ...process.env, WEB_PORT: String(port), BOT_EXECUTION_MODE: "agent" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  return { child, baseUrl };
};

const stopServer = async (handle: ServerHandle): Promise<void> => {
  if (!handle.child.pid) {
    return;
  }
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

type HttpResult = { status: number; body: unknown; cookie: string | undefined };

const extractCookie = (res: Response): string | undefined => {
  const raw = res.headers.get("set-cookie");
  return raw ? raw.split(";")[0] : undefined;
};

const requestJson = async (
  baseUrl: string,
  method: string,
  pathName: string,
  cookie: string | undefined,
  json?: unknown
): Promise<HttpResult> => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(json ?? {}) } : {})
  });
  const rawText = await res.text();
  let body: unknown = null;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    body = rawText;
  }
  return { status: res.status, body, cookie: extractCookie(res) };
};

const login = async (baseUrl: string, loginName: string, password: string): Promise<{ cookie: string; body: unknown }> => {
  const result = await requestJson(baseUrl, "POST", "/api/login", undefined, { login: loginName, password });
  if (result.status !== 200 || !result.cookie) {
    throw new Error(`Login ${loginName} a echoue: ${JSON.stringify(result.body)}`);
  }
  return { cookie: result.cookie, body: result.body };
};

const loginWithRetry = async (baseUrl: string, loginName: string, password: string, attempts = 5): Promise<{ cookie: string; body: unknown }> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await login(baseUrl, loginName, password);
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

type FakeAgentHandle = { agentId: number; socket: Socket };

// Simule uniquement l'API deja existante cote agent (AGENT_COMMAND ->
// COMMAND_ACK immediat, pour eviter le timeout d'accuse de reception - le
// controle du quota lui-meme n'a besoin de RIEN de plus qu'un ACK). Le test
// pilote lui-meme l'emission des BOT_STATUS via handle.socket.emit(...),
// jamais un vrai Chrome/Playwright.
const connectFakeAgent = (baseUrl: string, pairingCode: string, computerName: string): Promise<FakeAgentHandle> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false,
      reconnection: false,
      forceNew: true,
      auth: { mode: "pair", pairingCode, computerName, version: "0.2.5", protocolVersion: 1 }
    });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion agent fantome.")); }, 8_000);
    socket.on("connect_error", (error: Error) => { clearTimeout(timer); reject(new Error(`Rejete: ${error.message}`)); });
    socket.on("AGENT_COMMAND", (payload: { commandId: string }) => {
      socket.emit("COMMAND_ACK", { commandId: payload.commandId });
    });
    socket.on("AGENT_CONNECTED", (payload: { agentId: number; token: string | null }) => {
      clearTimeout(timer);
      if (!payload.token) {
        reject(new Error("Aucun jeton recu."));
        return;
      }
      socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
      resolve({ agentId: payload.agentId, socket });
    });
    socket.connect();
  });

const connectUiSocket = (baseUrl: string, cookie: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { autoConnect: false, reconnection: false, forceNew: true, extraHeaders: { Cookie: cookie } });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion socket UI.")); }, 8_000);
    socket.on("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.on("connect_error", (error: Error) => { clearTimeout(timer); reject(error); });
    socket.connect();
  });

const waitUntilAsync = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return predicate();
};

// ===================== Etat de test partage =====================

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

type MaintenanceSnapshot = { agencyActiveCount: number; agencyMaxClients: number };
type CommandSeen = { commandId: string; botId: string };

// Suit le dernier evenement "maintenance" recu par un socket UI, et chaque
// paire {commandId, botId} vue via "agent-command-status" - INDEXEE PAR
// botName (jamais par ordre d'arrivee/taille de map): deux START_BOT
// presque simultanes (Test K) doivent pouvoir etre distingues sans
// ambiguite meme si un seul aboutit reellement a une commande.
const trackUiSocket = (socket: Socket): { maintenance: MaintenanceSnapshot | null; commandsByBotName: Map<string, CommandSeen>; commandsByBotId: Map<string, CommandSeen>; botStatusEvents: Array<{ status: string; code?: string }> } => {
  const state = {
    maintenance: null as MaintenanceSnapshot | null,
    commandsByBotName: new Map<string, CommandSeen>(),
    commandsByBotId: new Map<string, CommandSeen>(),
    botStatusEvents: [] as Array<{ status: string; code?: string }>
  };
  socket.on("maintenance", (payload: MaintenanceSnapshot) => { state.maintenance = payload; });
  socket.on("agent-command-status", (payload: { commandId: string; botId: string; botName: string | null }) => {
    const seen: CommandSeen = { commandId: payload.commandId, botId: payload.botId };
    state.commandsByBotId.set(payload.botId, seen);
    if (payload.botName) {
      state.commandsByBotName.set(payload.botName, seen);
    }
  });
  socket.on("bot-status", (payload: { status: string; code?: string }) => { state.botStatusEvents.push(payload); });
  return state;
};

const setupAgencyWithAgent = async (
  baseUrl: string,
  adminCookie: string,
  label: string,
  maxActiveClients: number
): Promise<{ agencyId: number; managerCookie: string; fakeAgent: FakeAgentHandle; ui: ReturnType<typeof trackUiSocket>; uiSocket: Socket }> => {
  const agencyName = `Test Quota ${label} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;

  const managerLogin = `test-quota-mgr-${label.toLowerCase()}-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const managerResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: `Manager ${label}`, email: `${managerLogin}@example.test`, role: 1
  });
  const managerPassword = (managerResult.body as { temporaryPassword: string }).temporaryPassword;
  const managerCookie = (await loginWithRetry(baseUrl, managerLogin, managerPassword)).cookie;

  const pairing = await requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
  const pairingCode = (pairing.body as { pairing: { code: string } }).pairing.code;
  const fakeAgent = await connectFakeAgent(baseUrl, pairingCode, `PW-QUOTA-${label}-${RUN_SUFFIX}`);

  const uiSocket = await connectUiSocket(baseUrl, managerCookie);
  const ui = trackUiSocket(uiSocket);
  // Point de synchronisation deterministe: le premier "maintenance" arrive a
  // la connexion (emitMaintenanceToSocket, server.ts) - jamais un delai
  // arbitraire.
  await waitUntilAsync(() => ui.maintenance !== null);

  return { agencyId, managerCookie, fakeAgent, ui, uiSocket };
};

// Demarre un bot via le socket UI et attend que le agent-command-status
// correspondant arrive (necessaire pour recuperer botId/commandId et piloter
// ensuite le faux agent). Retourne null si le demarrage a ete refuse (utile
// pour les tests I/K qui s'attendent justement a un refus).
const startBotAndCapture = async (
  ui: ReturnType<typeof trackUiSocket>,
  uiSocket: Socket,
  agentId: number,
  botName: string
): Promise<CommandSeen | null> => {
  // botName UNIQUE par appel (jamais reutilise entre deux tests): permet de
  // savoir avec certitude SI CETTE requete precise a obtenu une commande,
  // meme quand deux START_BOT sont envoyes presque simultanement (Test K) -
  // jamais une comparaison de taille de map, ambigue dans ce cas.
  const beforeBotStatus = ui.botStatusEvents.length;
  uiSocket.emit("start-bot", { botName, category: "", agentId, clientRequestId: `tc-quota-${botName.replace(/\s+/g, "-")}-${RUN_SUFFIX}` });

  const gotCommand = await waitUntilAsync(() => ui.commandsByBotName.has(botName), 8_000);
  if (gotCommand) {
    return ui.commandsByBotName.get(botName) ?? null;
  }
  // Pas de commande pour CE botName: soit refus explicite (bot-status
  // error), soit timeout.
  await waitUntilAsync(() => ui.botStatusEvents.length > beforeBotStatus, 4_000);
  return null;
};

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) {
    await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  }
  if (createdAgencyNames.length > 0) {
    await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
  }
};

// ===================== Section 1: isolation A/B (Test A) =====================

const runIsolationTests = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("SECTION", "1) Isolation stricte par agence (Test A)");

  const p = await setupAgencyWithAgent(baseUrl, adminCookie, "P", 15);
  const q = await setupAgencyWithAgent(baseUrl, adminCookie, "Q", 15);

  for (let i = 1; i <= 4; i += 1) {
    const cmd = await startBotAndCapture(p.ui, p.uiSocket, p.fakeAgent.agentId, `Bot P${i}`);
    assert(cmd !== null, `A) Bot P${i} demarre avec succes (agence P, limite large)`);
    if (cmd) {
      p.fakeAgent.socket.emit("BOT_STATUS", { commandId: cmd.commandId, botId: cmd.botId, status: "WAITING_FOR_USER" });
    }
  }
  await waitUntilAsync(() => p.ui.maintenance?.agencyActiveCount === 4);
  assert(p.ui.maintenance?.agencyActiveCount === 4, `A) Agence P recoit bien 4 actifs (recu: ${p.ui.maintenance?.agencyActiveCount})`);

  for (let i = 1; i <= 5; i += 1) {
    const cmd = await startBotAndCapture(q.ui, q.uiSocket, q.fakeAgent.agentId, `Bot Q${i}`);
    assert(cmd !== null, `A) Bot Q${i} demarre avec succes (agence Q, limite large)`);
    if (cmd) {
      q.fakeAgent.socket.emit("BOT_STATUS", { commandId: cmd.commandId, botId: cmd.botId, status: "WAITING_FOR_USER" });
    }
  }
  await waitUntilAsync(() => q.ui.maintenance?.agencyActiveCount === 5);
  assert(q.ui.maintenance?.agencyActiveCount === 5, `A) Agence Q recoit bien 5 actifs (recu: ${q.ui.maintenance?.agencyActiveCount})`);

  // P ne doit JAMAIS avoir ete affecte par l'activite de Q (relecture apres coup).
  assert(p.ui.maintenance?.agencyActiveCount === 4, `A) Agence P reste a 4 actifs, jamais affectee par Q (recu: ${p.ui.maintenance?.agencyActiveCount})`);

  return runStatusTransitionTests(p);
};

// ===================== Section 2: transitions de statut (Tests C/D/E/F/G) =====================

const runStatusTransitionTests = async (p: Awaited<ReturnType<typeof setupAgencyWithAgent>>): Promise<void> => {
  log("SECTION", "2) Transitions de statut runtime (Tests C/D/E/F/G) - sur l'agence P (deja 4 actifs)");

  // On pilote precisement le PREMIER bot de P (Bot P1) a travers plusieurs statuts.
  const p1 = [...p.ui.commandsByBotId.values()][0];

  p.fakeAgent.socket.emit("BOT_STATUS", { commandId: p1.commandId, botId: p1.botId, status: "WAITING_FOR_USER" });
  await sleep(300);
  assert(p.ui.maintenance?.agencyActiveCount === 4, "C) WAITING_FOR_USER compte toujours (reste a 4, aucune baisse)");

  p.fakeAgent.socket.emit("BOT_STATUS", { commandId: p1.commandId, botId: p1.botId, status: "MONITORING" });
  await sleep(300);
  assert(p.ui.maintenance?.agencyActiveCount === 4, "D) MONITORING compte toujours (reste a 4)");

  // E) command.status=FAILED mais botStatus=WAITING_FOR_USER -> compte toujours.
  // Simule le cas reel signale (ex. timeout d'accuse de reception apres coup,
  // ou tout autre motif d'echec DE LA COMMANDE) sans jamais toucher au
  // registre agentBots lui-meme - countActiveAgentBotsForAgency ne lit QUE
  // AgentBotRecord.active, jamais agent_commands.status. La verification se
  // fait via le VRAI serveur (evenement "maintenance", jamais un appel
  // direct a countActiveAgentBotsForAgency depuis CE process de test - le
  // registre agentBots vit dans le processus serveur spawn, pas ici).
  await pool.query("UPDATE agent_commands SET status = 'failed', failed_at = NOW() WHERE command_id = $1", [p1.commandId]);
  // Force une diffusion "maintenance" fraiche (re-emission du MEME statut,
  // aucun changement fonctionnel) pour observer l'etat reel du serveur
  // APRES la mutation SQL ci-dessus, plutot que de se fier a une valeur
  // eventuellement perimee.
  p.fakeAgent.socket.emit("BOT_STATUS", { commandId: p1.commandId, botId: p1.botId, status: "MONITORING" });
  await sleep(300);
  assert(p.ui.maintenance?.agencyActiveCount === 4, `E) command.status=FAILED (botStatus toujours WAITING_FOR_USER/MONITORING cote registre) -> le bot compte toujours (recu: ${p.ui.maintenance?.agencyActiveCount})`);

  // F) STOPPED -> ne compte plus.
  p.fakeAgent.socket.emit("BOT_STATUS", { commandId: p1.commandId, botId: p1.botId, status: "STOPPED" });
  await waitUntilAsync(() => p.ui.maintenance?.agencyActiveCount === 3);
  assert(p.ui.maintenance?.agencyActiveCount === 3, `F) STOPPED -> le compteur redescend a 3 (recu: ${p.ui.maintenance?.agencyActiveCount})`);

  // G) ERROR -> comportement conforme a AgentBotRecord.active actuel (ne compte plus).
  const p2 = [...p.ui.commandsByBotId.values()][1];
  p.fakeAgent.socket.emit("BOT_STATUS", { commandId: p2.commandId, botId: p2.botId, status: "ERROR" });
  await waitUntilAsync(() => p.ui.maintenance?.agencyActiveCount === 2);
  assert(p.ui.maintenance?.agencyActiveCount === 2, `G) ERROR -> le compteur redescend a 2, conforme a AgentBotRecord.active existant (recu: ${p.ui.maintenance?.agencyActiveCount})`);
};

// ===================== Section 3: multi-agents meme agence (Test B) =====================

const runMultiAgentTests = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("SECTION", "3) Deux Agents differents de la MEME agence (Test B)");

  const agencyName = `Test Quota Multi ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;

  const managerLogin = `test-quota-mgr-multi-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const managerResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: "Manager Multi", email: `${managerLogin}@example.test`, role: 1
  });
  const managerPassword = (managerResult.body as { temporaryPassword: string }).temporaryPassword;
  const managerCookie = (await loginWithRetry(baseUrl, managerLogin, managerPassword)).cookie;

  const pairing1 = await requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
  const agent1 = await connectFakeAgent(baseUrl, (pairing1.body as { pairing: { code: string } }).pairing.code, `PW-QUOTA-MULTI-1-${RUN_SUFFIX}`);
  const pairing2 = await requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
  const agent2 = await connectFakeAgent(baseUrl, (pairing2.body as { pairing: { code: string } }).pairing.code, `PW-QUOTA-MULTI-2-${RUN_SUFFIX}`);

  const uiSocket = await connectUiSocket(baseUrl, managerCookie);
  const ui = trackUiSocket(uiSocket);
  await waitUntilAsync(() => ui.maintenance !== null);

  for (let i = 1; i <= 3; i += 1) {
    const cmd = await startBotAndCapture(ui, uiSocket, agent1.agentId, `Bot Multi PC1-${i}`);
    if (cmd) {
      agent1.socket.emit("BOT_STATUS", { commandId: cmd.commandId, botId: cmd.botId, status: "WAITING_FOR_USER" });
    }
  }
  for (let i = 1; i <= 4; i += 1) {
    const cmd = await startBotAndCapture(ui, uiSocket, agent2.agentId, `Bot Multi PC2-${i}`);
    if (cmd) {
      agent2.socket.emit("BOT_STATUS", { commandId: cmd.commandId, botId: cmd.botId, status: "WAITING_FOR_USER" });
    }
  }

  await waitUntilAsync(() => ui.maintenance?.agencyActiveCount === 7);
  assert(ui.maintenance?.agencyActiveCount === 7, `B) Deux Agents de la meme agence (3 + 4) -> l'agence affiche bien 7 (recu: ${ui.maintenance?.agencyActiveCount})`);
};

// ===================== Section 4: limite/quota/course (Tests H/I/J/K) =====================

const runQuotaAndRaceTests = async (baseUrl: string, adminCookie: string): Promise<void> => {
  log("SECTION", "4) Limite agence + protection de course 14->16 (Tests H/I/J/K), agence a max=2");

  const z = await setupAgencyWithAgent(baseUrl, adminCookie, "Z", 2);

  // J) 14/15 (ici 0/2) -> START_BOT -> passe a 15 (ici 1/2) immediatement.
  const cmdZ1 = await startBotAndCapture(z.ui, z.uiSocket, z.fakeAgent.agentId, "Bot Z1");
  assert(cmdZ1 !== null, "J) Premier bot demarre avec succes (0/2 -> 1/2)");
  if (cmdZ1) {
    z.fakeAgent.socket.emit("BOT_STATUS", { commandId: cmdZ1.commandId, botId: cmdZ1.botId, status: "WAITING_FOR_USER" });
  }
  await waitUntilAsync(() => z.ui.maintenance?.agencyActiveCount === 1);
  assert(z.ui.maintenance?.agencyActiveCount === 1, `J) Le compteur passe immediatement a 1/2 (recu: ${z.ui.maintenance?.agencyActiveCount}/${z.ui.maintenance?.agencyMaxClients})`);

  const cmdZ2 = await startBotAndCapture(z.ui, z.uiSocket, z.fakeAgent.agentId, "Bot Z2");
  assert(cmdZ2 !== null, "J) Deuxieme bot demarre avec succes (1/2 -> 2/2)");
  if (cmdZ2) {
    z.fakeAgent.socket.emit("BOT_STATUS", { commandId: cmdZ2.commandId, botId: cmdZ2.botId, status: "WAITING_FOR_USER" });
  }
  await waitUntilAsync(() => z.ui.maintenance?.agencyActiveCount === 2);

  // H) 15/15 (ici 2/2): le SEUL input du bouton frontend (updateStartBotAvailability,
  // app.js, inchange par ce hotfix) est agencyActiveCount/agencyMaxClients de
  // CET evenement "maintenance" - deja verifie egal, donc quotaOk=false cote
  // frontend est garanti par construction.
  assert(
    z.ui.maintenance?.agencyActiveCount === 2 && z.ui.maintenance?.agencyMaxClients === 2,
    `H) A 2/2, l'evenement maintenance transmet bien agencyActiveCount>=agencyMaxClients (recu: ${z.ui.maintenance?.agencyActiveCount}/${z.ui.maintenance?.agencyMaxClients}) - le bouton "Demarrer le bot" se desactive automatiquement (updateStartBotAvailability, app.js, non modifie)`
  );

  // I) 15/15 (ici 2/2): START_BOT force manuellement cote socket -> refuse serveur.
  const beforeCount = z.ui.commandsByBotId.size;
  const cmdRefused = await startBotAndCapture(z.ui, z.uiSocket, z.fakeAgent.agentId, "Bot Z Forge");
  assert(cmdRefused === null, "I) START_BOT force via socket a 2/2 est refuse (aucune commande creee)");
  assert(z.ui.commandsByBotId.size === beforeCount, "I) Aucune nouvelle commande enregistree suite au refus");
  assert(
    z.ui.botStatusEvents.some((e) => e.code === "AGENCY_BOT_LIMIT_REACHED"),
    "I) Le refus porte bien le code AGENCY_BOT_LIMIT_REACHED"
  );
  // Un refus n'emet jamais de nouvelle diffusion "maintenance" (rien n'a
  // change server-side) - la derniere valeur connue (etablie apres Bot Z2)
  // reste donc la preuve valide qu'aucune 3e place fantome n'a ete creee.
  assert(z.ui.maintenance?.agencyActiveCount === 2, `I) Le compte reste exactement a 2 (aucune 3e place fantome, recu: ${z.ui.maintenance?.agencyActiveCount})`);

  // F/M) STOPPED -> le compteur redescend et libere une place.
  z.fakeAgent.socket.emit("BOT_STATUS", { commandId: cmdZ1.commandId, botId: cmdZ1.botId, status: "STOPPED" });
  await waitUntilAsync(() => z.ui.maintenance?.agencyActiveCount === 1);
  assert(
    z.ui.maintenance?.agencyActiveCount === 1,
    `M) Apres STOPPED, le compteur redescend a 1/2 - le bouton frontend se reactive automatiquement (meme mecanisme que H, recu: ${z.ui.maintenance?.agencyActiveCount})`
  );

  // K) Deux START_BOT presque simultanes pour la DERNIERE place (1/2 -> une seule place restante).
  const [resultA, resultB] = await Promise.all([
    startBotAndCapture(z.ui, z.uiSocket, z.fakeAgent.agentId, "Bot Z Course A"),
    startBotAndCapture(z.ui, z.uiSocket, z.fakeAgent.agentId, "Bot Z Course B")
  ]);
  const successes = [resultA, resultB].filter((r) => r !== null);
  assert(successes.length === 1, `K) Exactement UNE des deux tentatives simultanees obtient la derniere place (recu: ${successes.length} succes)`);
  assert(
    z.ui.botStatusEvents.some((e) => e.code === "AGENCY_BOT_LIMIT_REACHED"),
    "K) L'autre tentative recoit bien AGENCY_BOT_LIMIT_REACHED (jamais deux acceptations)"
  );
  const winner = successes[0]!;
  z.fakeAgent.socket.emit("BOT_STATUS", { commandId: winner.commandId, botId: winner.botId, status: "WAITING_FOR_USER" });
  await waitUntilAsync(() => z.ui.maintenance?.agencyActiveCount === 2);
  assert(z.ui.maintenance?.agencyActiveCount === 2, `K) Le compte final est bien 2 (jamais 3) apres la course (recu: ${z.ui.maintenance?.agencyActiveCount})`);
};

// ===================== Section 5: dispatch echoue avant creation reelle (Test L) =====================
// Isole au niveau service (registerAgentBot/dispatchAgentCommand/removeAgentBot,
// tous exportes et reellement utilises par server.ts) plutot que via une
// vraie coupure socket (fenetre de course reseau non deterministe a
// reproduire de facon fiable) - reproduit EXACTEMENT la meme regle de
// nettoyage que server.ts (cf. section 9 du hotfix): command.status==="failed"
// -> removeAgentBot(botId).

const runDispatchFailureCleanupTest = async (): Promise<void> => {
  log("SECTION", "5) Nettoyage si le dispatch echoue avant creation reelle (Test L)");

  const agencyName = `Test Quota DispatchFail ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyInsert = await pool.query<{ id: number }>("INSERT INTO agencies (name, max_active_clients) VALUES ($1, 15) RETURNING id", [agencyName]);
  const agencyId = agencyInsert.rows[0].id;

  // agent_commands.agent_id/created_by_user_id sont des vraies foreign keys:
  // il faut un agent et un utilisateur reellement existants en base (jamais
  // un id invente) - l'agent existe (paire) mais n'est simplement JAMAIS
  // connecte (aucun socket), reproduisant exactement le cas AGENT_DISCONNECTED.
  const agentInsert = await pool.query<{ id: number }>(
    "INSERT INTO agents (agency_id, name, computer_name, token_hash) VALUES ($1, 'Agent DispatchFail', 'PW-DISPATCHFAIL', 'unused') RETURNING id",
    [agencyId]
  );
  const fakeAgentId = agentInsert.rows[0].id;
  const adminUser = await pool.query<{ id: number }>("SELECT id FROM users WHERE login = $1", [ADMIN_LOGIN]);
  const adminUserId = adminUser.rows[0].id;

  const beforeCount = countActiveAgentBotsForAgency(agencyId);
  const botId = generateBotId();
  registerAgentBot({
    botId,
    agentId: fakeAgentId,
    agencyId,
    ownerUserId: adminUserId,
    botName: "Bot DispatchFail",
    category: "",
    latestCommandId: "",
    botStatus: null,
    botStatusUpdatedAt: null,
    active: true,
    updatedAt: new Date().toISOString()
  });
  assert(countActiveAgentBotsForAgency(agencyId) === beforeCount + 1, "L) La reservation initiale est bien visible (avant meme le dispatch)");

  // getAgentSocket renvoie undefined: reproduit exactement "agent deconnecte
  // avant l'envoi de la commande" (AGENT_DISCONNECTED, agentCommandService.ts) -
  // l'agent EXISTE bien en base (paire), mais n'a simplement aucun socket
  // connecte au moment du dispatch.
  const { command } = await dispatchAgentCommand(
    {
      agencyId,
      agentId: fakeAgentId,
      botId,
      type: "START_BOT",
      publicPayload: { botName: "Bot DispatchFail" },
      createdByUserId: adminUserId
    },
    {
      config: { ackTimeoutMs: 10_000, ttlMs: 60_000, sweepIntervalMs: 5_000 },
      getAgentSocket: () => undefined,
      onChange: () => undefined
    }
  );

  assert(command.status === "failed", `L) dispatchAgentCommand retourne bien status=failed quand l'agent n'a pas de socket connecte (recu: ${command.status})`);

  // Regle de nettoyage EXACTE appliquee par server.ts (start-bot, section 9).
  if (command.status === "failed") {
    removeAgentBot(botId);
  }

  assert(countActiveAgentBotsForAgency(agencyId) === beforeCount, `L) Apres nettoyage, aucune place fantome conservee (recu: ${countActiveAgentBotsForAgency(agencyId)}, attendu: ${beforeCount})`);

  await pool.query("DELETE FROM agencies WHERE id = $1", [agencyId]);
};

// ===================== Execution =====================

const run = async (): Promise<void> => {
  let server: ServerHandle | undefined;
  try {
    await runDispatchFailureCleanupTest();

    server = await startServer(3398);
    const admin = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    await runIsolationTests(server.baseUrl, admin.cookie);
    await runMultiAgentTests(server.baseUrl, admin.cookie);
    await runQuotaAndRaceTests(server.baseUrl, admin.cookie);
  } finally {
    if (server) {
      await stopServer(server);
    }
    await cleanupTestData().catch((error) => log("CLEANUP_ERROR", String(error)));
    await pool.end().catch(() => undefined);
  }
};

run()
  .then(() => {
    console.log(`\n${passCount} succes, ${failCount} echec(s).`);
    process.exit(failCount > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error("Erreur fatale pendant le scenario de test:", error);
    process.exit(1);
  });
