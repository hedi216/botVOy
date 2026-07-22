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

export const loadStoredCredentials = (settings: AgentRuntimeSettings): StoredAgentCredentials | null => {
  if (!existsSync(settings.credentialsPath)) {
    return null;
  }
  return JSON.parse(readFileSync(settings.credentialsPath, "utf8")) as StoredAgentCredentials;
};

export const saveStoredCredentials = (settings: AgentRuntimeSettings, credentials: StoredAgentCredentials): void => {
  writeFileSync(settings.credentialsPath, JSON.stringify(credentials, null, 2));
};
