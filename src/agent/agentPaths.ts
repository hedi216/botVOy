import path from "node:path";
import { getConfigDir, getLogsDir, getProfilesDir, getStateDir } from "./agentStorage.js";
import { AgentPaths, AgentRuntimeSettings } from "./types.js";

// Phase 5 (Lot 2, section 13): agregation en LECTURE SEULE des chemins deja
// resolus par agentSettings.ts/agentStorage.ts - jamais une seconde
// resolution independante (aucune duplication de logique de chemin). Toute
// nouvelle donnee locale doit passer par cette fonction plutot que de
// construire un chemin dataRoot-relatif directement dans un module.
export const resolveAgentPaths = (settings: AgentRuntimeSettings): AgentPaths => ({
  dataRoot: settings.dataRoot,
  credentialsDir: path.dirname(settings.credentialsPath),
  credentialsFilePath: settings.credentialsPath,
  logsDir: getLogsDir(settings),
  configDir: getConfigDir(settings),
  profilesDir: getProfilesDir(settings),
  stateDir: getStateDir(settings)
});
