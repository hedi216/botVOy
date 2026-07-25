// BUG CIBLE 0.1.5 (agent inutilisable apres revocation/reappairage): test
// cible, unitaire sur AgentBotManager (vrai Chrome reellement lance, aucun
// serveur/socket/agentMain.ts requis - reproduit fidelement le bug sans le
// cout d'un harnais complet). Verifie que shutdownAll() et
// stopAllBotsForIdentityReset() ont bien des effets distincts:
// - stopAllBotsForIdentityReset() (revocation, dissociation locale): ferme
//   les bots actifs mais laisse le manager reutilisable (shuttingDown reste
//   false) ;
// - shutdownAll() (arret definitif du process): positionne durablement
//   shuttingDown=true, tout START_BOT suivant est refuse avec
//   AGENT_SHUTTING_DOWN (jamais AGENT_CAPACITY_REACHED, code desormais
//   distinct).
//
// Necessite Google Chrome installe localement (CHROME_EXECUTABLE_PATH sinon).
// Usage: npx tsx scripts/test-agent-revoke-repair-real.ts
//    ou: npm run test:agent:revoke-repair:real

import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBotManager } from "../src/agent/agentBotManager.js";
import { acquirePooledProfileLock } from "../src/agent/agentProfileManager.js";
import { AgentEventReporter } from "../src/agent/agentEventReporter.js";
import { AgentRuntimeSettings } from "../src/agent/types.js";

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};

const RUN_SUFFIX = Date.now();
const dataRoot = path.resolve(`.test-revoke-repair-data-${RUN_SUFFIX}`);

const makeSettings = (maxActiveBots: number): AgentRuntimeSettings => ({
  serverUrl: "http://localhost:0",
  credentialsPath: path.join(dataRoot, "credentials", "agent-credentials.json"),
  computerName: "TEST-REVOKE-REPAIR",
  version: "0.0.0",
  protocolVersion: 1,
  runtimeMode: "test",
  targetMode: "fixture",
  fixtureUrl: "about:blank",
  // Chrome est reellement lance sur about:blank (section 8 hotfix 0.1.1: aucune
  // navigation TLScontact reelle dans un test automatise) - startUrl (fourni par
  // bot, voir plus bas) pointe vers un port local inutilise pour que la cascade
  // d'auto-navigation echoue vite et sans effet de bord, sans jamais bloquer le
  // test sur une vraie ressource reseau.
  targetUrl: "about:blank",
  maxActiveBots,
  dataRoot,
  reconnectMinDelayMs: 1_000,
  reconnectMaxDelayMs: 30_000,
  reconnectJitterRatio: 0.2,
  offlineEventBufferMax: 500,
  logMaxFileSizeMb: 5,
  logMaxFiles: 5,
  logLevel: "info",
  // Cadence acceleree (deja concue pour etre testable, cf. commentaire
  // AgentBotManager): la cascade complete (3 tentatives + attente longue +
  // tentative finale) doit se terminer en quelques secondes, pas 5 minutes.
  autoNavRetryIntervalMs: 300,
  autoNavLongWaitMs: 800
});

type RecordedFailure = { commandId: string; errorCode: string; message: string };
type RecordedBotStatus = { botId: string; commandId: string; status: string };

const makeReporter = (): { reporter: AgentEventReporter; acks: string[]; failures: RecordedFailure[]; botStatuses: RecordedBotStatus[] } => {
  const acks: string[] = [];
  const failures: RecordedFailure[] = [];
  const botStatuses: RecordedBotStatus[] = [];
  const reporter: AgentEventReporter = {
    ack: (commandId) => { acks.push(commandId); },
    completed: () => { /* non utilise par ces scenarios */ },
    failed: (commandId, errorCode, message) => { failures.push({ commandId, errorCode, message }); },
    botStatus: (botId, commandId, status) => { botStatuses.push({ botId, commandId, status }); }
  };
  return { reporter, acks, failures, botStatuses };
};

const noopLog = (): void => { /* silencieux: le test log lui-meme via log() */ };

const waitUntil = async (predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  log("TIMEOUT", `Condition non atteinte dans le delai (${timeoutMs}ms): ${label}`);
  return predicate();
};

// Un port local garanti inutilise (jamais un vrai reseau/TLScontact, section 8):
// la navigation initiale echoue immediatement ("connection refused"), la
// cascade d'auto-navigation se deroule ensuite sans jamais rien attendre d'un
// serveur reel.
const UNREACHABLE_START_URL = "http://127.0.0.1:1/";

const startRealBot = async (
  manager: AgentBotManager,
  botId: string,
  commandId: string
): Promise<void> => {
  await manager.startBot({
    commandId,
    botId,
    botName: botId,
    login: undefined,
    password: undefined,
    rawMonitoringSettings: undefined,
    startUrl: UNREACHABLE_START_URL
  });
};

const main = async (): Promise<void> => {
  log("BOOT", "=== Test cible - revocation/reappairage (AgentBotManager, vrai Chrome) ===");

  try {
    // ----- Scenario 1: revocation -> arret des bots -> reappairage (meme
    // processus) -> START_BOT accepte -----
    {
      const settings = makeSettings(5);
      const { reporter, failures } = makeReporter();
      const manager = new AgentBotManager(settings, noopLog, reporter);

      await startRealBot(manager, "bot-revoke-1", "cmd-revoke-1");
      const started = await waitUntil(() => manager.isActive("bot-revoke-1"), 20_000, "bot-revoke-1 actif (Chrome lance)");
      assert(started, "1) Bot reellement demarre (Chrome lance) avant la revocation simulee");

      // Simule exactement ce que fait desormais applyPermanentFailurePolicy
      // (AGENT_REVOKED) - jamais shutdownAll().
      await manager.stopAllBotsForIdentityReset();
      assert(manager.activeCount() === 0, `1) activeCount()=0 apres stopAllBotsForIdentityReset() (recu ${manager.activeCount()})`);

      // Aucun verrou/profil orphelin: une nouvelle acquisition directe doit
      // reutiliser le MEME slot de profil (jamais un profile-02 supplementaire),
      // preuve que le bail precedent a bien ete libere.
      const reacquired = acquirePooledProfileLock(settings);
      const reusedSameSlot = reacquired.profilePath.endsWith("profile-01");
      reacquired.release();
      assert(reusedSameSlot, `1) Aucun verrou de profil orphelin: le slot profile-01 est bien reutilisable (obtenu: ${reacquired.profilePath})`);

      // Reappairage simule dans le MEME processus (meme instance de manager):
      // START_BOT doit etre accepte, jamais refuse par AGENT_SHUTTING_DOWN/
      // AGENT_CAPACITY_REACHED.
      const failuresBefore = failures.length;
      await startRealBot(manager, "bot-revoke-2", "cmd-revoke-2");
      const reStarted = await waitUntil(() => manager.isActive("bot-revoke-2"), 20_000, "bot-revoke-2 actif apres reappairage simule");
      assert(reStarted, "1) START_BOT accepte apres revocation+reappairage dans le meme processus (bot reellement relance)");
      const blockingFailure = failures.slice(failuresBefore).find((f) => f.commandId === "cmd-revoke-2");
      assert(
        !blockingFailure || !["AGENT_SHUTTING_DOWN", "AGENT_CAPACITY_REACHED"].includes(blockingFailure.errorCode),
        `1) Aucun refus AGENT_SHUTTING_DOWN/AGENT_CAPACITY_REACHED pour le reappairage (recu: ${blockingFailure ? blockingFailure.errorCode : "aucun echec"})`
      );

      await manager.shutdownAll();
      assert(manager.activeCount() === 0, "1) Nettoyage final: activeCount()=0");
    }

    // ----- Scenario 2: dissociation locale -> reappairage -> START_BOT
    // accepte (meme methode cote AgentBotManager que la revocation - verifie
    // ici dynamiquement, et statiquement plus bas que agentMain.ts appelle
    // bien stopAllBotsForIdentityReset() et non shutdownAll() a ces deux
    // points d'appel) -----
    {
      const settings = makeSettings(5);
      const { reporter, failures } = makeReporter();
      const manager = new AgentBotManager(settings, noopLog, reporter);

      await startRealBot(manager, "bot-unpair-1", "cmd-unpair-1");
      await waitUntil(() => manager.isActive("bot-unpair-1"), 20_000, "bot-unpair-1 actif");

      // Dissociation locale (agentMain.ts: unpair()).
      await manager.stopAllBotsForIdentityReset();
      assert(manager.activeCount() === 0, "2) activeCount()=0 apres dissociation locale simulee");

      const failuresBefore = failures.length;
      await startRealBot(manager, "bot-unpair-2", "cmd-unpair-2");
      const reStarted = await waitUntil(() => manager.isActive("bot-unpair-2"), 20_000, "bot-unpair-2 actif apres reappairage");
      assert(reStarted, "2) START_BOT accepte apres dissociation locale + reappairage");
      const blockingFailure = failures.slice(failuresBefore).find((f) => f.commandId === "cmd-unpair-2");
      assert(
        !blockingFailure || !["AGENT_SHUTTING_DOWN", "AGENT_CAPACITY_REACHED"].includes(blockingFailure.errorCode),
        `2) Aucun refus AGENT_SHUTTING_DOWN/AGENT_CAPACITY_REACHED (recu: ${blockingFailure ? blockingFailure.errorCode : "aucun echec"})`
      );

      await manager.shutdownAll();
    }

    // ----- Verification statique: agentMain.ts n'utilise plus jamais
    // shutdownAll() pour un reset d'identite (regression future) -----
    {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const agentMainSource = readFileSync(path.join(here, "..", "src", "agent", "agentMain.ts"), "utf8");
      const shutdownAllCallCount = (agentMainSource.match(/botManager\.shutdownAll\(\)/g) || []).length;
      const identityResetCallCount = (agentMainSource.match(/botManager\.stopAllBotsForIdentityReset\(\)/g) || []).length;
      assert(shutdownAllCallCount === 1, `Statique) agentMain.ts n'appelle shutdownAll() qu'une seule fois (arret definitif SIGINT/SIGTERM/quit) - trouve ${shutdownAllCallCount} appel(s)`);
      assert(identityResetCallCount === 2, `Statique) agentMain.ts appelle stopAllBotsForIdentityReset() exactement deux fois (applyPermanentFailurePolicy + unpair) - trouve ${identityResetCallCount} appel(s)`);
    }

    // ----- Scenario 3: shutdown final -> START_BOT refuse avec
    // AGENT_SHUTTING_DOWN (jamais AGENT_CAPACITY_REACHED) -----
    {
      const settings = makeSettings(5);
      const { reporter, failures } = makeReporter();
      const manager = new AgentBotManager(settings, noopLog, reporter);

      await manager.shutdownAll();
      await startRealBot(manager, "bot-after-shutdown", "cmd-after-shutdown");

      assert(!manager.isActive("bot-after-shutdown"), "3) Aucun bot demarre apres shutdownAll() definitif");
      assert(manager.activeCount() === 0, "3) activeCount()=0 apres tentative de START_BOT post-shutdown");
      const failure = failures.find((f) => f.commandId === "cmd-after-shutdown");
      assert(failure?.errorCode === "AGENT_SHUTTING_DOWN", `3) START_BOT refuse avec AGENT_SHUTTING_DOWN (recu: ${failure?.errorCode})`);
      assert(
        failure?.message === "L'agent est en cours d'arret. Relancez RendezBot Agent.",
        `3) Message public exact (recu: ${JSON.stringify(failure?.message)})`
      );
    }

    // ----- Scenario 4: capacite reelle atteinte -> AGENT_CAPACITY_REACHED
    // (jamais AGENT_SHUTTING_DOWN, puisque le manager n'est pas en arret) -----
    {
      const settings = makeSettings(1);
      const { reporter, failures } = makeReporter();
      const manager = new AgentBotManager(settings, noopLog, reporter);

      await startRealBot(manager, "bot-capacity-1", "cmd-capacity-1");
      await waitUntil(() => manager.isActive("bot-capacity-1"), 20_000, "bot-capacity-1 actif (limite=1 atteinte)");

      await startRealBot(manager, "bot-capacity-2", "cmd-capacity-2");
      const failure = failures.find((f) => f.commandId === "cmd-capacity-2");
      assert(failure?.errorCode === "AGENT_CAPACITY_REACHED", `4) Limite reelle (maxActiveBots=1) atteinte -> AGENT_CAPACITY_REACHED (recu: ${failure?.errorCode})`);
      assert(!manager.isActive("bot-capacity-2"), "4) Le second bot n'a jamais ete demarre");
      assert(manager.activeCount() === 1, `4) activeCount() reste a 1 (recu ${manager.activeCount()})`);

      await manager.shutdownAll();
    }

    console.log(`\n${passCount} succes, ${failCount} echec(s).`);
    process.exitCode = failCount > 0 ? 1 : 0;
  } finally {
    // Sur Windows, un handle Crashpad/journal SQLite du profil Chrome tout
    // juste ferme peut rester brievement verrouille apres killChromeProcess:
    // quelques tentatives espacees evitent de laisser un dossier de test
    // orphelin sur un rmSync trop rapide (constate empiriquement).
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        rmSync(dataRoot, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 5) {
          log("CLEANUP_WARN", `Nettoyage de ${dataRoot} incomplet apres 5 tentatives: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
};

main().catch((error) => {
  console.error("Erreur fatale pendant le scenario de test:", error);
  process.exitCode = 1;
});
