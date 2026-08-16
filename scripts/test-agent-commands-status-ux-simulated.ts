// HOTFIX CIBLE - Le tableau "Bots pilotes par l'agent" doit presenter
// l'ETAT DU BOT (botStatus) comme information PRINCIPALE, jamais eclipsee
// par le statut de la DERNIERE COMMANDE (command.status). Purement UX/
// frontend (public/index.html, public/agentUi.js) - AUCUN champ backend
// (command.status, botStatus, DTO) n'est modifie par ce hotfix.
//
// Nouvel ordre de colonnes: Bot / Etat du bot / Derniere commande / Details
// / Actions (au lieu de Bot / Commande / Etat local / Details / Actions).
// commandStatusMessage() ne verifie plus FAILED en premier: le runtime
// (botStatus) prime desormais, sauf ERROR/STOPPED qui gardent leur propre
// presentation dediee - une commande FAILED reste toujours diagnosticable,
// mais explicitement rattachee a "la derniere commande", jamais confondue
// avec l'etat actuel du bot.
//
// Usage: npx tsx scripts/test-agent-commands-status-ux-simulated.ts

import { ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Browser, Page, chromium } from "playwright";
import { Socket, io as ioClient } from "socket.io-client";
import { ADMIN_LOGIN, ADMIN_PASSWORD, pool } from "../src/db.js";

const RUN_SUFFIX = Date.now();

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntilAsync = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};

// ===================== TEST F/G/H/I (partiel) + entetes: verification statique des libelles =====================
// Verifie que les BONS MOTS existent dans les objets de mapping - rapide et
// deterministe. La logique de PRIORITE (runtime vs derniere commande) est
// verifiee separement plus bas via un rendu reel (TEST A-E).

const runStaticLabelTests = (): void => {
  log("STATIC", "=== Libelles francais (RUNTIME_BADGE / COMMAND_TYPE_LABEL / COMMAND_STATUS_LABEL) et entetes ===");
  const agentUiJs = readFileSync(path.join(process.cwd(), "public", "agentUi.js"), "utf8");

  // TEST F/G + reste de RUNTIME_BADGE
  assert(agentUiJs.includes('WAITING_FOR_USER: { label: "Intervention requise"'), "F/label) WAITING_FOR_USER -> \"Intervention requise\" (jamais le code brut)");
  assert(agentUiJs.includes('RATE_LIMITED: { label: "Pause du site"'), "F) RATE_LIMITED -> \"Pause du site\" (jamais \"RATE_LIMITED\" brut)");
  assert(agentUiJs.includes('SLOT_DETECTED: { label: "Creneau detecte"'), "G) SLOT_DETECTED -> \"Creneau detecte\" (jamais \"SLOT_DETECTED\" brut)");
  assert(agentUiJs.includes('STARTING: { label: "Demarrage"'), "label) STARTING -> \"Demarrage\"");
  assert(agentUiJs.includes('MONITORING: { label: "Surveillance"'), "label) MONITORING -> \"Surveillance\"");
  assert(agentUiJs.includes('STOPPING: { label: "Arret en cours"'), "label) STOPPING -> \"Arret en cours\"");
  assert(agentUiJs.includes('STOPPED: { label: "Arrete"'), "label) STOPPED -> \"Arrete\"");
  assert(agentUiJs.includes('ERROR: { label: "Erreur"'), "label) ERROR -> \"Erreur\"");

  // TEST H: les 7 statuts de commande
  const commandStatusLabels = {
    PENDING: "En attente", SENT: "Envoyee", ACKNOWLEDGED: "Recue par l'agent",
    COMPLETED: "Terminee", FAILED: "Echouee", EXPIRED: "Expiree", CANCELLED: "Annulee"
  };
  for (const [code, expectedLabel] of Object.entries(commandStatusLabels)) {
    assert(agentUiJs.includes(`${code}: "${expectedLabel}"`), `H) COMMAND_STATUS_LABEL.${code} -> "${expectedLabel}"`);
  }

  // TEST I: les types de commande cites explicitement par le hotfix
  const commandTypeLabels = { START_BOT: "Demarrer", VALIDATE_BOT: "Valider", STOP_BOT: "Arreter" };
  for (const [code, expectedLabel] of Object.entries(commandTypeLabels)) {
    assert(agentUiJs.includes(`${code}: "${expectedLabel}"`), `I) COMMAND_TYPE_LABEL.${code} -> "${expectedLabel}"`);
  }

  // TEST 9 (raw codes): plus aucun header ambigu "Commande"/"Etat local".
  const indexHtml = readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");
  assert(indexHtml.includes("<th>Etat du bot</th>"), "entete) Colonne renommee \"Etat du bot\" (jamais \"Etat local\")");
  assert(indexHtml.includes("<th>Derniere commande</th>"), "entete) Colonne renommee \"Derniere commande\" (jamais \"Commande\" seul)");
  assert(!indexHtml.includes("<th>Commande</th>"), "entete) L'ancien intitule \"Commande\" a disparu");
  assert(!indexHtml.includes("<th>Etat local</th>"), "entete) L'ancien intitule \"Etat local\" a disparu (terme \"local\" ambigu)");

  // TEST J: le DTO backend n'a pas change (les valeurs consommees par le
  // frontend existent toujours telles quelles cote serveur).
  const agentCommandServiceTs = readFileSync(path.join(process.cwd(), "src", "agentCommandService.ts"), "utf8");
  assert(agentCommandServiceTs.includes("status: string;") && agentCommandServiceTs.includes("botStatus: string | null;"), "J) PublicAgentCommand conserve exactement command.status et botStatus (aucune fusion des deux modeles)");
  for (const statusValue of ["COMMAND_SENT", "STARTING", "WAITING_FOR_USER", "MONITORING", "RATE_LIMITED", "SLOT_DETECTED", "STOPPING", "STOPPED", "ERROR"]) {
    assert(agentCommandServiceTs.includes(`"${statusValue}"`), `J) BOT_STATUS_VALUES conserve "${statusValue}" (backend inchange)`);
  }
};

// ===================== Serveur reel + agent fantome =====================

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
    env: {
      ...process.env, WEB_PORT: String(port), BOT_EXECUTION_MODE: "agent", AGENT_UI_ENABLED: "true",
      AGENT_COMMAND_ACK_TIMEOUT_MS: "500", AGENT_COMMAND_TTL_MS: "20000", AGENT_COMMAND_SWEEP_INTERVAL_MS: "300"
    },
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

type HttpResult = { status: number; body: unknown };

const requestJson = async (baseUrl: string, method: string, pathName: string, cookie: string | undefined, json?: unknown): Promise<HttpResult> => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(json ?? {}) } : {})
  });
  const rawText = await res.text();
  let body: unknown = null;
  try { body = rawText ? JSON.parse(rawText) : null; } catch { body = rawText; }
  return { status: res.status, body };
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

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

const createAgencyAndManager = async (baseUrl: string, adminCookie: string, label: string): Promise<{ agencyId: number; managerLogin: string; managerPassword: string }> => {
  const agencyName = `Test Cmd UX ${label} ${RUN_SUFFIX}`;
  createdAgencyNames.push(agencyName);
  const agencyResult = await requestJson(baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 });
  const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;

  const managerLogin = `test-cmdux-mgr-${label.toLowerCase()}-${RUN_SUFFIX}`;
  createdUserLogins.push(managerLogin);
  const userResult = await requestJson(baseUrl, "POST", "/api/users", adminCookie, {
    agencyId, login: managerLogin, name: `Manager ${label}`, email: `${managerLogin}@example.test`, role: 1
  });
  const managerPassword = (userResult.body as { temporaryPassword: string }).temporaryPassword;
  return { agencyId, managerLogin, managerPassword };
};

type FakeAgentHandle = { agentId: number; token: string; socket: Socket };

const pairFakeAgent = (baseUrl: string, managerCookie: string, computerName: string): Promise<FakeAgentHandle> =>
  requestJson(baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {}).then((pairing) => new Promise((resolve, reject) => {
    const pairingCode = (pairing.body as { pairing: { code: string } }).pairing.code;
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false, reconnection: false, forceNew: true,
      auth: { mode: "pair", pairingCode, computerName, version: "1.0.0", protocolVersion: 1 }
    });
    const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout agent fantome.")); }, 8_000);
    socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
    socket.on("AGENT_CONNECTED", (payload: { agentId: number; token: string | null }) => {
      clearTimeout(t);
      if (!payload.token) { reject(new Error("Aucun jeton.")); return; }
      resolve({ agentId: payload.agentId, token: payload.token, socket });
    });
    socket.connect();
  }));

const openControlSocket = (baseUrl: string, cookie: string): Promise<Socket> => new Promise((resolve, reject) => {
  const socket = ioClient(baseUrl, { autoConnect: false, reconnection: false, forceNew: true, extraHeaders: { Cookie: cookie } });
  const t = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion socket de controle.")); }, 8_000);
  socket.on("connect", () => { clearTimeout(t); resolve(socket); });
  socket.on("connect_error", (e: Error) => { clearTimeout(t); reject(e); });
  socket.connect();
});

const loginViaUi = async (page: Page, baseUrl: string, loginName: string, password: string): Promise<void> => {
  await page.goto(baseUrl);
  await page.fill("#loginInput", loginName);
  await page.fill("#passwordInput", password);
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
  await page.click("#agentSetupSkip").catch(() => undefined);
  await page.click('[data-page-target="bot"]');
  await page.waitForSelector("#page-bot.active");
};

const rowFor = (page: Page, botNameText: string) => page.locator("#agentCommandsTableBody tr", { hasText: botNameText });

const rowCellsText = async (page: Page, botNameText: string): Promise<string[]> => {
  const row = rowFor(page, botNameText);
  await row.waitFor({ state: "visible", timeout: 10_000 });
  return row.locator("td").allTextContents();
};

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  if (createdAgencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
};

// ===================== TEST A: MONITORING + START_BOT COMPLETED =====================

const runTestA = async (page: Page, control: Socket, agent: FakeAgentHandle): Promise<void> => {
  log("TEST-A", "=== MONITORING + START_BOT COMPLETED: aucune impression d'erreur ===");
  const botName = `Bot UX A ${RUN_SUFFIX}`;
  const commandsSeen: Array<Record<string, unknown>> = [];
  agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));

  control.emit("start-bot", { botName, category: "", login: "x", password: "y", agentId: agent.agentId, clientRequestId: `ux-a-${RUN_SUFFIX}` });
  await waitUntilAsync(() => commandsSeen.some((c) => c.type === "START_BOT" && (c.payload as { botName?: string } | undefined)?.botName === botName), 8_000);
  const startCmd = commandsSeen.find((c) => c.type === "START_BOT" && (c.payload as { botName?: string } | undefined)?.botName === botName)!;
  agent.socket.emit("COMMAND_ACK", { commandId: startCmd.commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("BOT_STATUS", { commandId: startCmd.commandId, botId: startCmd.botId, status: "MONITORING", timestamp: new Date().toISOString() });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: startCmd.commandId, completedAt: new Date().toISOString(), result: { botId: startCmd.botId, status: "MONITORING", started: true } });

  const [, etatDuBot, derniereCommande, details] = await rowCellsText(page, botName);

  assert(etatDuBot.trim() === "Surveillance", `A) Etat du bot = "Surveillance" (recu: "${etatDuBot.trim()}")`);
  assert(derniereCommande.trim() === "Demarrer - Terminee", `A) Derniere commande = "Demarrer - Terminee" (recu: "${derniereCommande.trim()}")`);
  assert(details.includes("Surveillance active"), `A) Details mentionne bien "Surveillance active" (recu: "${details}")`);
  assert(!details.toLowerCase().includes("echouee") && !details.toLowerCase().includes("echec"), `A) Aucune impression d'erreur dans les details (recu: "${details}")`);
};

// ===================== TEST B: WAITING_FOR_USER + VALIDATE_BOT FAILED PAGE_NOT_READY =====================

const runTestB = async (page: Page, control: Socket, agent: FakeAgentHandle): Promise<void> => {
  log("TEST-B", "=== WAITING_FOR_USER + VALIDATE_BOT FAILED PAGE_NOT_READY ===");
  const botName = `Bot UX B ${RUN_SUFFIX}`;
  const commandsSeen: Array<Record<string, unknown>> = [];
  agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));

  control.emit("start-bot", { botName, category: "", login: "x", password: "y", agentId: agent.agentId, clientRequestId: `ux-b-start-${RUN_SUFFIX}` });
  await waitUntilAsync(() => commandsSeen.some((c) => c.type === "START_BOT" && (c.payload as { botName?: string } | undefined)?.botName === botName), 8_000);
  const startCmd = commandsSeen.find((c) => c.type === "START_BOT" && (c.payload as { botName?: string } | undefined)?.botName === botName)!;
  agent.socket.emit("COMMAND_ACK", { commandId: startCmd.commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("BOT_STATUS", { commandId: startCmd.commandId, botId: startCmd.botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: startCmd.commandId, completedAt: new Date().toISOString(), result: { botId: startCmd.botId, status: "WAITING_FOR_USER", started: true } });

  const row = rowFor(page, botName);
  await row.waitFor({ state: "visible", timeout: 10_000 });
  const validateButton = row.locator("button", { hasText: "Valider" });
  await validateButton.waitFor({ state: "visible", timeout: 10_000 });
  await validateButton.click();

  await waitUntilAsync(() => commandsSeen.some((c) => c.type === "VALIDATE_BOT" && c.botId === startCmd.botId), 8_000);
  const validateCmd = commandsSeen.find((c) => c.type === "VALIDATE_BOT" && c.botId === startCmd.botId)!;
  agent.socket.emit("COMMAND_ACK", { commandId: validateCmd.commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("COMMAND_FAILED", { commandId: validateCmd.commandId, errorCode: "PAGE_NOT_READY", message: "La page de rendez-vous n'est pas prete. Verifiez la page ouverte dans Chrome, puis validez a nouveau." });

  await waitUntilAsync(async () => (await rowCellsText(page, botName))[2].includes("Echouee"), 8_000);
  const [, etatDuBot, derniereCommande, details] = await rowCellsText(page, botName);

  assert(etatDuBot.trim() === "Intervention requise", `B) Etat principal = "Intervention requise" (recu: "${etatDuBot.trim()}")`);
  assert(derniereCommande.trim() === "Valider - Echouee", `B) Derniere commande = "Valider - Echouee" (recu: "${derniereCommande.trim()}")`);
  assert(details.trim() === "La page de rendez-vous n'est pas prete. Verifiez la page ouverte dans Chrome, puis validez a nouveau.", `B) Details = message PAGE_NOT_READY existant, sans prefixe (recu: "${details.trim()}")`);
};

// ===================== TEST C: MONITORING + commande FAILED AGENT_ACK_TIMEOUT =====================

const runTestC = async (page: Page, control: Socket, agent: FakeAgentHandle): Promise<void> => {
  log("TEST-C", "=== MONITORING + commande FAILED AGENT_ACK_TIMEOUT: l'etat principal reste Surveillance ===");
  const botName = `Bot UX C ${RUN_SUFFIX}`;
  const commandsSeen: Array<Record<string, unknown>> = [];
  agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));

  control.emit("start-bot", { botName, category: "", login: "x", password: "y", agentId: agent.agentId, clientRequestId: `ux-c-start-${RUN_SUFFIX}` });
  await waitUntilAsync(() => commandsSeen.some((c) => c.type === "START_BOT" && (c.payload as { botName?: string } | undefined)?.botName === botName), 8_000);
  const startCmd = commandsSeen.find((c) => c.type === "START_BOT" && (c.payload as { botName?: string } | undefined)?.botName === botName)!;
  agent.socket.emit("COMMAND_ACK", { commandId: startCmd.commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("BOT_STATUS", { commandId: startCmd.commandId, botId: startCmd.botId, status: "MONITORING", timestamp: new Date().toISOString() });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: startCmd.commandId, completedAt: new Date().toISOString(), result: { botId: startCmd.botId, status: "MONITORING", started: true } });

  // STOP_BOT volontairement JAMAIS acquitte par l'agent fantome: expire via
  // AGENT_COMMAND_ACK_TIMEOUT_MS (500ms, config de ce serveur de test) sans
  // qu'aucun BOT_STATUS ne soit jamais rapporte - le runtime reste donc
  // MONITORING (seule source de verite: le dernier BOT_STATUS reellement recu).
  control.emit("stop-bot", { botId: startCmd.botId, clientRequestId: `ux-c-stop-${RUN_SUFFIX}` });

  await waitUntilAsync(async () => (await rowCellsText(page, botName))[2].includes("Echouee"), 10_000);
  const [, etatDuBot, derniereCommande, details] = await rowCellsText(page, botName);

  assert(etatDuBot.trim() === "Surveillance", `C) L'etat principal reste "Surveillance" malgre la commande FAILED (recu: "${etatDuBot.trim()}")`);
  assert(derniereCommande.trim() === "Arreter - Echouee", `C) Derniere commande = "Arreter - Echouee" (recu: "${derniereCommande.trim()}")`);
  assert(details.includes("Derniere commande non executee"), `C) Details precise explicitement qu'il s'agit de la derniere commande, jamais de l'etat actuel (recu: "${details}")`);
  assert(!details.toLowerCase().includes("erreur du bot"), `C) Aucune formulation ne laisse croire que le bot est actuellement en erreur (recu: "${details}")`);
};

// ===================== TEST D: STOPPED + ancienne commande FAILED =====================

const runTestD = async (page: Page, control: Socket, agent: FakeAgentHandle): Promise<void> => {
  log("TEST-D", "=== STOPPED + ancienne commande FAILED: etat principal Arrete, aucune action Valider/Arreter ===");
  const botName = `Bot UX D ${RUN_SUFFIX}`;
  const commandsSeen: Array<Record<string, unknown>> = [];
  agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));

  control.emit("start-bot", { botName, category: "", login: "x", password: "y", agentId: agent.agentId, clientRequestId: `ux-d-start-${RUN_SUFFIX}` });
  await waitUntilAsync(() => commandsSeen.some((c) => c.type === "START_BOT" && (c.payload as { botName?: string } | undefined)?.botName === botName), 8_000);
  const startCmd = commandsSeen.find((c) => c.type === "START_BOT" && (c.payload as { botName?: string } | undefined)?.botName === botName)!;
  agent.socket.emit("COMMAND_ACK", { commandId: startCmd.commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("BOT_STATUS", { commandId: startCmd.commandId, botId: startCmd.botId, status: "WAITING_FOR_USER", timestamp: new Date().toISOString() });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: startCmd.commandId, completedAt: new Date().toISOString(), result: { botId: startCmd.botId, status: "WAITING_FOR_USER", started: true } });

  const row = rowFor(page, botName);
  await row.locator("button", { hasText: "Valider" }).click();
  await waitUntilAsync(() => commandsSeen.some((c) => c.type === "VALIDATE_BOT" && c.botId === startCmd.botId), 8_000);
  const validateCmd = commandsSeen.find((c) => c.type === "VALIDATE_BOT" && c.botId === startCmd.botId)!;
  agent.socket.emit("COMMAND_ACK", { commandId: validateCmd.commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("COMMAND_FAILED", { commandId: validateCmd.commandId, errorCode: "PAGE_NOT_READY", message: "La page de rendez-vous n'est pas prete." });
  await waitUntilAsync(async () => (await rowCellsText(page, botName))[2].includes("Echouee"), 8_000);

  // Arret reel du bot APRES cet echec: la vieille commande FAILED reste dans
  // l'historique, mais le badge "Etat du bot" doit converger vers Arrete.
  control.emit("stop-bot", { botId: startCmd.botId, clientRequestId: `ux-d-stop-${RUN_SUFFIX}` });
  await waitUntilAsync(() => commandsSeen.some((c) => c.type === "STOP_BOT" && c.botId === startCmd.botId), 8_000);
  const stopCmd = commandsSeen.find((c) => c.type === "STOP_BOT" && c.botId === startCmd.botId)!;
  agent.socket.emit("COMMAND_ACK", { commandId: stopCmd.commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("BOT_STATUS", { commandId: stopCmd.commandId, botId: startCmd.botId, status: "STOPPED", timestamp: new Date().toISOString() });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: stopCmd.commandId, completedAt: new Date().toISOString(), result: { botId: startCmd.botId, status: "STOPPED", stopped: true } });

  await waitUntilAsync(async () => (await rowCellsText(page, botName))[1].trim() === "Arrete", 8_000);
  const [, etatDuBot, , details] = await rowCellsText(page, botName);
  assert(etatDuBot.trim() === "Arrete", `D) Etat principal = "Arrete" (recu: "${etatDuBot.trim()}")`);
  assert(details.trim() === "Bot arrete.", `D) Details = "Bot arrete." (une vieille commande FAILED ne doit jamais faire croire a une erreur actuelle) (recu: "${details.trim()}")`);

  const row2 = rowFor(page, botName);
  assert(await row2.locator("button", { hasText: "Valider" }).count() === 0, "D) Aucun bouton Valider une fois le bot Arrete");
  assert(await row2.locator("button", { hasText: "Arreter" }).count() === 0, "D) Aucun bouton Arreter une fois le bot Arrete");
  assert(await row2.locator("button", { hasText: "Supprimer" }).count() === 1, "D) Bouton Supprimer disponible (regle de suppression existante, botStatus=STOPPED)");
};

// ===================== TEST E: ERROR + command COMPLETED =====================

const runTestE = async (page: Page, control: Socket, agent: FakeAgentHandle): Promise<void> => {
  log("TEST-E", "=== ERROR + command COMPLETED: etat principal Erreur, details runtime visibles sans suffixe de commande ===");
  const botName = `Bot UX E ${RUN_SUFFIX}`;
  const commandsSeen: Array<Record<string, unknown>> = [];
  agent.socket.on("AGENT_COMMAND", (command: Record<string, unknown>) => commandsSeen.push(command));

  control.emit("start-bot", { botName, category: "", login: "x", password: "y", agentId: agent.agentId, clientRequestId: `ux-e-start-${RUN_SUFFIX}` });
  await waitUntilAsync(() => commandsSeen.some((c) => c.type === "START_BOT" && (c.payload as { botName?: string } | undefined)?.botName === botName), 8_000);
  const startCmd = commandsSeen.find((c) => c.type === "START_BOT" && (c.payload as { botName?: string } | undefined)?.botName === botName)!;
  agent.socket.emit("COMMAND_ACK", { commandId: startCmd.commandId, receivedAt: new Date().toISOString() });
  agent.socket.emit("BOT_STATUS", { commandId: startCmd.commandId, botId: startCmd.botId, status: "ERROR", timestamp: new Date().toISOString() });
  agent.socket.emit("COMMAND_COMPLETED", { commandId: startCmd.commandId, completedAt: new Date().toISOString(), result: { botId: startCmd.botId, status: "ERROR", started: true } });

  await waitUntilAsync(async () => (await rowCellsText(page, botName))[1].trim() === "Erreur", 8_000);
  const [, etatDuBot, derniereCommande, details] = await rowCellsText(page, botName);

  assert(etatDuBot.trim() === "Erreur", `E) Etat principal = "Erreur" (recu: "${etatDuBot.trim()}")`);
  assert(derniereCommande.trim() === "Demarrer - Terminee", `E) Derniere commande = "Demarrer - Terminee" (recu: "${derniereCommande.trim()}")`);
  assert(details.includes("Erreur du bot"), `E) Details runtime d'erreur visible (recu: "${details}")`);
  assert(!details.includes("Derniere commande :"), `E) Aucun suffixe de commande ajoute quand la derniere commande n'a PAS echoue (recu: "${details}")`);
};

// ===================== main =====================

const run = async (): Promise<void> => {
  runStaticLabelTests();

  let server: ServerHandle | undefined;
  let browser: Browser | undefined;
  try {
    server = await startServer(3408);
    browser = await chromium.launch({ headless: true });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    const fixture = await createAgencyAndManager(server.baseUrl, adminCookie, "AE");
    const managerCookie = await loginWithRetry(server.baseUrl, fixture.managerLogin, fixture.managerPassword);
    const agent = await pairFakeAgent(server.baseUrl, managerCookie, `PW-CMDUX-${RUN_SUFFIX}`);
    // selectAgentForCommand() (server.ts) exige un snapshot d'inventaire deja
    // recu (getSnapshotForAgent) avant de considerer l'agent eligible pour
    // recevoir des commandes.
    agent.socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
    await sleep(300);
    const control = await openControlSocket(server.baseUrl, managerCookie);

    const context = await browser.newContext();
    const page = await context.newPage();
    await loginViaUi(page, server.baseUrl, fixture.managerLogin, fixture.managerPassword);

    await runTestA(page, control, agent);
    await runTestB(page, control, agent);
    await runTestC(page, control, agent);
    await runTestD(page, control, agent);
    await runTestE(page, control, agent);

    await context.close();
    control.disconnect();
    agent.socket.disconnect();
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (server) await stopServer(server);
    await cleanupTestData().catch((error) => log("CLEANUP_ERROR", String(error)));
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
