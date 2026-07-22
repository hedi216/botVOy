import { AgentCommandErrorCode } from "./types.js";

// Erreur porteuse d'un code public whitelist (section 7): le message reste
// pour les logs locaux uniquement, jamais transmis tel quel au serveur/UI
// (agentEventReporter envoie toujours errorCode + un message deja controle).
export class AgentCommandError extends Error {
  constructor(public readonly code: AgentCommandErrorCode, message: string) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export const toAgentCommandError = (error: unknown, fallbackCode: AgentCommandErrorCode): AgentCommandError => {
  if (error instanceof AgentCommandError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AgentCommandError(fallbackCode, message);
};
