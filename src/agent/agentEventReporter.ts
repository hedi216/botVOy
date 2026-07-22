import { AgentClient } from "./agentClient.js";
import { AgentLogFn } from "./agentLocalLogger.js";

// Seul point de passage entre la logique metier (AgentBotManager) et le
// socket serveur: centralise le log local + l'emission reseau, pour que
// toute future regle ("jamais de secret", format des evenements) se pose
// une seule fois ici plutot que dans chaque appelant.
export type AgentEventReporter = {
  ack: (commandId: string) => void;
  completed: (commandId: string, result: unknown) => void;
  failed: (commandId: string, errorCode: string, message: string) => void;
  botStatus: (botId: string, commandId: string, status: string, details?: unknown) => void;
};

export const createAgentEventReporter = (client: AgentClient, log: AgentLogFn): AgentEventReporter => ({
  ack: (commandId) => {
    client.sendAck(commandId);
  },
  completed: (commandId, result) => {
    log("success", `Commande ${commandId} terminee (COMMAND_COMPLETED).`);
    client.sendCompleted(commandId, result);
  },
  failed: (commandId, errorCode, message) => {
    log("warn", `Commande ${commandId} echouee: ${errorCode}.`);
    client.sendFailed(commandId, errorCode, message);
  },
  botStatus: (botId, commandId, status, details) => {
    client.sendBotStatus(commandId, botId, status, details);
  }
});
