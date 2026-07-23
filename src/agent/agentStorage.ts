import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AgentRuntimeSettings, StoredAgentCredentials } from "./types.js";

// Centralise l'emplacement des donnees locales de l'agent (profils, logs,
// config d'extensions): un seul endroit a faire evoluer si l'emplacement
// change au packaging final (Phase 5), plutot que de disperser des chemins
// en dur dans chaque module.
export const ensureDir = (directoryPath: string): string => {
  mkdirSync(directoryPath, { recursive: true });
  return directoryPath;
};

export const getProfilesDir = (settings: AgentRuntimeSettings): string =>
  ensureDir(path.join(settings.dataRoot, "profiles"));

export const getLogsDir = (settings: AgentRuntimeSettings): string =>
  ensureDir(path.join(settings.dataRoot, "logs"));

export const getConfigDir = (settings: AgentRuntimeSettings): string =>
  ensureDir(path.join(settings.dataRoot, "config"));

// Phase 5 (Lot 1, section 3/4): fonction centrale de resolution du chemin de
// credentials par defaut, appelee UNIQUEMENT quand AGENT_CREDENTIALS_PATH
// n'est pas fourni explicitement. Prend `dataRoot` directement (pas
// `settings`, pas encore construit a cet instant dans agentSettings.ts)
// pour rester coherente avec profiles/logs/config: jamais process.cwd()
// (qui, en execution packagee, pointerait vers un dossier d'installation
// potentiellement non inscriptible comme Program Files - defaut trouve et
// corrige au Lot 1 de la Phase 5).
export const getDefaultCredentialsPath = (dataRoot: string): string =>
  path.join(ensureDir(path.join(dataRoot, "config")), "credentials.json");

export const loadStoredCredentials = (settings: AgentRuntimeSettings): StoredAgentCredentials | null => {
  if (!existsSync(settings.credentialsPath)) {
    return null;
  }
  return JSON.parse(readFileSync(settings.credentialsPath, "utf8")) as StoredAgentCredentials;
};

// Phase 5 (Lot 1): defaut trouve par test-agent-packaging-real.ts -
// n'assumait l'existence du dossier parent que dans le cas par defaut (via
// getDefaultCredentialsPath, qui appelle ensureDir). Des qu'AGENT_CREDENTIALS_PATH
// est fourni explicitement (ce que fera un installeur reel, cf.
// docs/agent-packaging.md section 3) vers un dossier pas encore cree,
// l'ecriture echouait (ENOENT) au tout premier appairage reussi.
export const saveStoredCredentials = (settings: AgentRuntimeSettings, credentials: StoredAgentCredentials): void => {
  ensureDir(path.dirname(settings.credentialsPath));
  writeFileSync(settings.credentialsPath, JSON.stringify(credentials, null, 2));
};
