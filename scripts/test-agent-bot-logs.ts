// BUG CIBLE 0.2.4 (nouveaux logs par bot): agent.log melangeait jusqu'ici
// plusieurs bots/sessions/jours/versions. Corrige dans src/agent/agentLocalLogger.ts
// (createBotLogger/buildBotLogFileName/sanitizeBotNameForFilename) et
// integre dans src/agent/agentBotManager.ts (chaque START_BOT cree son propre
// fichier, tee vers agent.log inchange). Ce fichier teste:
//   I) format exact du nom de fichier (heure LOCALE du PC) ;
//   J) sanitisation Windows + anti path-traversal ;
//   K) deux bots simultanes -> deux fichiers distincts, aucune fuite croisee ;
//   L) aucune sentinelle password/login/token/cookie dans les nouveaux logs.
//
// Usage: npx tsx scripts/test-agent-bot-logs.ts

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http, { IncomingMessage, ServerResponse, Server } from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentBotManager } from "../src/agent/agentBotManager.js";
import {
  AgentLogFn,
  buildBotLogFileName,
  createAgentLogger,
  formatLocalTimestampForFilename,
  sanitizeBotNameForFilename
} from "../src/agent/agentLocalLogger.js";
import { getLogsDir } from "../src/agent/agentStorage.js";
import { AgentEventReporter } from "../src/agent/agentEventReporter.js";
import { AgentRuntimeSettings } from "../src/agent/types.js";

const RUN_SUFFIX = Date.now();
const FAKE_LOGIN = "TEST_SECRET_FAKE_LOGIN_BOTLOGS";
const FAKE_PASSWORD = "TEST_SECRET_FAKE_PASSWORD_BOTLOGS_123";

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 20_000, intervalMs = 300): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};

// ===================== I/J: pure unit (aucun Chrome, aucun fichier reel) =====================

const runUnitTests = (): void => {
  log("BOOT", "=== I/J: format de nom de fichier + sanitisation Windows/anti path-traversal ===");

  // I) botName=bottest25, heure locale simulee 10/08/2026 10:28:52.
  const fixedLocalDate = new Date(2026, 7, 10, 10, 28, 52); // mois 0-index: 7 = aout.
  const stamp = formatLocalTimestampForFilename(fixedLocalDate);
  assert(stamp === "10082026_102852", `I) formatLocalTimestampForFilename(10/08/2026 10:28:52) -> "10082026_102852" (obtenu: ${stamp})`);

  const fileName = buildBotLogFileName("bottest25", fixedLocalDate, () => false);
  assert(fileName === "bottest25_10082026_102852.log", `I) buildBotLogFileName("bottest25", ...) -> nom exact attendu (obtenu: ${fileName})`);

  // Collision exceptionnelle: fileExists() simule un fichier deja present pour
  // le nom de base -> suffixe numerique, jamais un ecrasement silencieux.
  let calls = 0;
  const collidingFileName = buildBotLogFileName("bottest25", fixedLocalDate, (candidate) => {
    calls += 1;
    return candidate === "bottest25_10082026_102852.log";
  });
  assert(collidingFileName === "bottest25_10082026_102852_2.log", `I) Collision -> suffixe numerique "_2" (obtenu: ${collidingFileName})`);
  assert(calls === 2, "I) La detection de collision interroge bien chaque candidat avant de le retenir");

  // J) Caracteres Windows interdits + espaces + traversee de chemin.
  const withForbiddenChars = sanitizeBotNameForFilename('bot<>:"/\\|?*test');
  assert(!/[<>:"/\\|?*]/.test(withForbiddenChars), `J) Caracteres Windows interdits remplaces proprement (obtenu: ${withForbiddenChars})`);

  const withSpaces = sanitizeBotNameForFilename("Bot Test Avec Espaces");
  assert(!withSpaces.includes(" "), `J) Espaces remplaces (obtenu: ${withSpaces})`);

  const traversalAttempts = ["../../../etc/passwd", "..\\..\\windows\\system32", "....//....//secret", "../"];
  for (const attempt of traversalAttempts) {
    const sanitized = sanitizeBotNameForFilename(attempt);
    assert(!sanitized.includes(".."), `J) "${attempt}" sanitize ne contient jamais ".." (obtenu: ${sanitized})`);
    assert(!sanitized.includes("/") && !sanitized.includes("\\"), `J) "${attempt}" sanitize ne contient jamais de separateur de chemin (obtenu: ${sanitized})`);
    const logsDir = path.join(os.tmpdir(), "rdv-bot-logs-traversal-test");
    const joined = path.resolve(logsDir, buildBotLogFileName(attempt, fixedLocalDate, () => false));
    assert(joined.startsWith(path.resolve(logsDir) + path.sep), `J) Le fichier resultant reste strictement DANS logsDir (obtenu: ${joined})`);
  }

  const emptyName = sanitizeBotNameForFilename("");
  assert(emptyName === "bot", `J) botName absent -> fallback sur \"bot\" (obtenu: ${emptyName})`);
  const undefinedName = sanitizeBotNameForFilename(undefined);
  assert(undefinedName === "bot", `J) botName undefined -> fallback sur \"bot\" (obtenu: ${undefinedName})`);

  const veryLongName = sanitizeBotNameForFilename("x".repeat(500));
  assert(veryLongName.length <= 60, `J) Nom raisonnablement limite en longueur (obtenu: ${veryLongName.length} caracteres)`);

  const dotOnlyName = sanitizeBotNameForFilename("..");
  assert(!dotOnlyName.includes(".."), `J) Un botName compose uniquement de ".." ne produit jamais ".." tel quel (obtenu: ${dotOnlyName})`);
};

// ===================== Fixture minimale (toujours pret) =====================

type FixtureSite = { server: Server; baseUrl: string };
const APPOINTMENT_READY_HTML = `<!DOCTYPE html><html><body>
<div data-testid="fixture-appointment-page">Fausse page de rendez-vous (test uniquement)</div>
<button data-testid="btn-current-month-unavailable" disabled>Mois courant</button>
<button data-testid="btn-next-month-unavailable" disabled>Mois suivant</button>
<p>Nous n'avons actuellement plus de creneaux de rendez-vous disponibles.</p>
</body></html>`;

const startAlwaysReadyFixture = (): Promise<FixtureSite> => new Promise((resolve, reject) => {
  const server = http.createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(APPOINTMENT_READY_HTML);
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
  });
});

const makeFakeReporter = (): { reporter: AgentEventReporter; statuses: Array<{ botId: string; status: string }> } => {
  const statuses: Array<{ botId: string; status: string }> = [];
  const reporter: AgentEventReporter = {
    ack: () => undefined,
    completed: () => undefined,
    failed: () => undefined,
    botStatus: (botId, _commandId, status) => { statuses.push({ botId, status }); }
  };
  return { reporter, statuses };
};

const makeTestAgentSettings = (dataRoot: string): AgentRuntimeSettings => ({
  serverUrl: "http://127.0.0.1:1",
  credentialsPath: path.join(dataRoot, "credentials.json"),
  computerName: "TEST-BOTLOGS-PC",
  version: "0.2.4",
  protocolVersion: 1,
  runtimeMode: "test",
  targetMode: "fixture",
  fixtureUrl: "about:blank",
  targetUrl: "about:blank",
  maxActiveBots: 5,
  dataRoot,
  reconnectMinDelayMs: 1_000,
  reconnectMaxDelayMs: 5_000,
  reconnectJitterRatio: 0.2,
  offlineEventBufferMax: 100,
  logMaxFileSizeMb: 5,
  logMaxFiles: 3,
  logLevel: "info",
  autoNavRetryIntervalMs: 500,
  autoNavLongWaitMs: 800,
  workflowRecoveryRetryIntervalMs: 500,
  workflowRecoveryLongWaitMs: 1_000,
  humanValidationGraceMs: 2_000
});

// ===================== K/L: deux bots reels simultanes =====================

const runIntegrationTest = async (): Promise<void> => {
  log("BOOT", "=== K/L: deux bots reels simultanes -> deux fichiers de log distincts, aucune fuite croisee, aucun secret ===");

  const dataRoot = mkdtempSync(path.join(os.tmpdir(), `rdv-bot-logs-${RUN_SUFFIX}-`));
  const settings = makeTestAgentSettings(dataRoot);
  // Le VRAI createAgentLogger (jamais un simple capteur en memoire): la
  // presence reelle d'agent.log en plus des fichiers par bot fait partie de
  // ce qui est verifie ici (tee vers agent.log inchange, cf. commentaire
  // d'entete).
  const globalLog: AgentLogFn = createAgentLogger(settings);
  const { reporter, statuses } = makeFakeReporter();
  const manager = new AgentBotManager(settings, globalLog, reporter);

  const fixtureA = await startAlwaysReadyFixture();
  const fixtureB = await startAlwaysReadyFixture();
  const botIdA = "bot-logs-a";
  const botIdB = "bot-logs-b";
  const botNameA = "AlphaLogsBot";
  const botNameB = "BravoLogsBot";

  try {
    await manager.startBot({
      commandId: "cmd-logs-a",
      botId: botIdA,
      botName: botNameA,
      login: FAKE_LOGIN,
      password: FAKE_PASSWORD,
      rawMonitoringSettings: { botCycleCooldownMinMs: 5_000, botCycleCooldownMaxMs: 6_000, refreshEveryCycles: 0 },
      startUrl: `${fixtureA.baseUrl}/`
    });
    await manager.startBot({
      commandId: "cmd-logs-b",
      botId: botIdB,
      botName: botNameB,
      login: FAKE_LOGIN,
      password: FAKE_PASSWORD,
      rawMonitoringSettings: { botCycleCooldownMinMs: 5_000, botCycleCooldownMaxMs: 6_000, refreshEveryCycles: 0 },
      startUrl: `${fixtureB.baseUrl}/`
    });

    await waitUntil(() => statuses.filter((s) => s.botId === botIdA && s.status === "MONITORING").length >= 1, 30_000);
    await waitUntil(() => statuses.filter((s) => s.botId === botIdB && s.status === "MONITORING").length >= 1, 30_000);

    const logsDir = getLogsDir(settings);
    const files = readdirSync(logsDir).filter((name) => name.endsWith(".log") && name !== "agent.log");
    assert(files.length === 2, `K) Exactement 2 fichiers de log dedies crees (un par START_BOT) (obtenu: ${JSON.stringify(files)})`);

    const fileForBotName = (botName: string): string | undefined => files.find((name) => name.startsWith(`${botName}_`));
    const fileA = fileForBotName(botNameA);
    const fileB = fileForBotName(botNameB);
    assert(Boolean(fileA), `K) Le fichier du bot "${botNameA}" utilise bien botName (jamais le botId technique) dans son nom (fichiers: ${JSON.stringify(files)})`);
    assert(Boolean(fileB), `K) Le fichier du bot "${botNameB}" utilise bien botName (jamais le botId technique) dans son nom (fichiers: ${JSON.stringify(files)})`);
    assert(fileA !== fileB, "K) Les deux bots simultanes obtiennent bien deux fichiers DISTINCTS");
    assert(existsSync(path.join(logsDir, "agent.log")), "K) agent.log (evenements globaux) continue d'exister en plus des fichiers par bot");

    if (fileA && fileB) {
      const contentA = readFileSync(path.join(logsDir, fileA), "utf8");
      const contentB = readFileSync(path.join(logsDir, fileB), "utf8");

      assert(contentA.includes(botIdA), `K) Le fichier de "${botNameA}" contient bien des evenements de CE bot (botId=${botIdA})`);
      assert(contentB.includes(botIdB), `K) Le fichier de "${botNameB}" contient bien des evenements de CE bot (botId=${botIdB})`);
      assert(!contentA.includes(botIdB), `K) Le fichier de "${botNameA}" ne contient AUCUNE ligne du bot "${botNameB}" (aucune fuite croisee)`);
      assert(!contentB.includes(botIdA), `K) Le fichier de "${botNameB}" ne contient AUCUNE ligne du bot "${botNameA}" (aucune fuite croisee)`);
      assert(contentA.includes("START_BOT recu"), `K) Le fichier par bot contient bien START_BOT`);
      assert(contentA.includes("demarre (Chrome visible"), `K) Le fichier par bot contient bien le lancement de Chrome`);
      assert(contentA.includes("surveillance demarree") || contentA.includes("MONITORING"), `K) Le fichier par bot contient bien l'entree en surveillance`);

      const allContent = [contentA, contentB, readFileSync(path.join(logsDir, "agent.log"), "utf8")].join("\n");
      const forbiddenSentinels = [FAKE_LOGIN, FAKE_PASSWORD, FAKE_LOGIN.toLowerCase(), FAKE_PASSWORD.toLowerCase()];
      const leaked = forbiddenSentinels.filter((needle) => allContent.includes(needle));
      assert(leaked.length === 0, `L) Aucune sentinelle password/login dans les nouveaux logs (bot A/B) ni dans agent.log (fuites: ${JSON.stringify(leaked)})`);
      assert(!/password\s*[:=]\s*\S+/i.test(allContent.replace(/password=\[redacted\]/gi, "")), "L) Aucun motif password= residuel non redige");
      assert(!/cookie\s*[:=]\s*\S+/i.test(allContent.replace(/cookie=\[redacted\]/gi, "")), "L) Aucun motif cookie= residuel non redige");
      assert(!/authorization\s*:/i.test(allContent.replace(/Authorization:\s*\[redacted\]/gi, "")), "L) Aucun motif Authorization: residuel non redige");
    }
  } finally {
    await manager.stopBot({ commandId: "cmd-logs-a-stop", botId: botIdA }).catch(() => undefined);
    await manager.stopBot({ commandId: "cmd-logs-b-stop", botId: botIdB }).catch(() => undefined);
    fixtureA.server.closeAllConnections?.();
    fixtureB.server.closeAllConnections?.();
    await new Promise<void>((resolve) => fixtureA.server.close(() => resolve()));
    await new Promise<void>((resolve) => fixtureB.server.close(() => resolve()));
    // Windows peut garder brievement un verrou sur des fichiers du profil
    // juste apres la fermeture de Chrome (meme apres stopBot(), deja attendu
    // ci-dessus) - retry, jamais un rmSync unique fragile.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        rmSync(dataRoot, { recursive: true, force: true });
        break;
      } catch {
        if (attempt < 5) {
          await sleep(300);
        }
      }
    }
  }
};

const main = async (): Promise<void> => {
  log("BOOT", "=== Test REEL cible - BUG CIBLE 0.2.4 (nouveaux logs par bot) ===");

  if (process.platform !== "win32") {
    console.log("Plateforme non-Windows: ce test necessite Windows + Chrome. Ignore, 0 succes / 0 echec.");
    process.exit(0);
    return;
  }

  runUnitTests();
  await runIntegrationTest();

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
