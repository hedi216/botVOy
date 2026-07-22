import { AgentBotManager } from "./agentBotManager.js";
import { AgentClient } from "./agentClient.js";
import { AgentEventReporter, createAgentEventReporter } from "./agentEventReporter.js";
import { createAgentLogger } from "./agentLocalLogger.js";
import { loadAgentSettings } from "./agentSettings.js";
import { AgentCommandEnvelope } from "./types.js";

const parseArgs = (): { pairingCode?: string } => {
  const [, , mode, arg] = process.argv;
  if (mode === "pair") {
    if (!arg || !arg.trim()) {
      console.error("Usage: npm run agent:dev -- pair <CODE_APPARIEMENT>");
      process.exit(1);
    }
    return { pairingCode: arg.trim() };
  }
  return {};
};

// VALIDATE_BOT (et tout type de commande non gere par ce lot) reste
// honnetement refuse: le moteur de surveillance n'arrive qu'au Lot 3/4.
// Jamais de faux succes simule (meme principe que scripts/test-agent-phase3.ts).
const NOT_YET_IMPLEMENTED = new Set(["VALIDATE_BOT", "REFRESH_BOT", "UPDATE_SETTINGS", "REQUEST_STATUS", "SHUTDOWN_BOT"]);

const main = async (): Promise<void> => {
  const settings = loadAgentSettings();
  const log = createAgentLogger(settings);

  log("info", `RendezBot Agent v${settings.version}`);
  log("info", `Ordinateur: ${settings.computerName}`);
  log("info", `Serveur: ${settings.serverUrl}`);
  log("info", `Mode cible: ${settings.targetMode}${settings.fixtureUrl ? ` (${settings.fixtureUrl})` : ""}`);
  log("info", `URL de navigation initiale: ${settings.targetUrl}`);
  log("info", `Limite locale de bots actifs: ${settings.maxActiveBots}`);

  let botManager: AgentBotManager;
  let reporter: AgentEventReporter;
  let acceptingCommands = true;

  const client: AgentClient = new AgentClient(settings, log, {
    onCommand: (command) => {
      if (!acceptingCommands) {
        log("warn", `Commande ${command.type} (${command.commandId}) ignoree: agent en cours d'arret.`);
        return;
      }
      handleCommand(botManager, reporter, command, log);
    },
    onConnectionChange: (connected) => {
      log(connected ? "success" : "warn", connected ? "En attente de commandes." : "Connexion perdue, reconnexion en cours...");
    }
  });
  client.setActiveBotCountProvider(() => botManager.activeCount());

  reporter = createAgentEventReporter(client, log);
  botManager = new AgentBotManager(settings, log, reporter);

  await client.start(parseArgs().pairingCode);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    acceptingCommands = false;
    log("info", `${signal} recu: arret de tous les bots locaux, aucune nouvelle commande acceptee.`);

    void botManager.shutdownAll()
      .catch((error) => log("error", `Erreur pendant l'arret des bots: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        client.stop();
        log("info", "Agent arrete proprement.");
        process.exit(0);
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
};

const handleCommand = (
  botManager: AgentBotManager,
  reporter: AgentEventReporter,
  command: AgentCommandEnvelope,
  log: ReturnType<typeof createAgentLogger>
): void => {
  if (command.type === "START_BOT") {
    void botManager.startBot({ commandId: command.commandId, botId: command.botId });
    return;
  }

  if (command.type === "STOP_BOT") {
    void botManager.stopBot({ commandId: command.commandId, botId: command.botId });
    return;
  }

  // VALIDATE_BOT et les autres types non geres par ce lot restent refuses
  // honnetement (accuse puis echec explicite), jamais laisses en silence
  // jusqu'au timeout serveur (constraint 9).
  reporter.ack(command.commandId);
  const message = NOT_YET_IMPLEMENTED.has(command.type)
    ? "Cette fonctionnalite n'est pas encore implementee cote agent (lot suivant de la Phase 4)."
    : `Type de commande inconnu de cet agent: ${command.type}.`;
  reporter.failed(command.commandId, "ENGINE_NOT_IMPLEMENTED", message);
  log("warn", `Commande ${command.type} (${command.commandId}) refusee: ${message}`);
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[agentMain] Arret: ${message}`);
  process.exitCode = 1;
});
