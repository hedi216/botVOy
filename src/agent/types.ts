// Types locaux au runtime RendezBot Agent. Distinct de src/shared/types.ts
// (moteur de surveillance) et de src/db.ts (types serveur/PostgreSQL): ce
// fichier ne doit jamais importer quoi que ce soit depuis src/server.ts,
// src/db.ts ou tout module cote serveur (cf. section 2 du cahier des charges).

import type { AgentMonitoringSettings } from "./agentMonitoringSettings.js";
import type { MonitoringRuntimeHandle } from "./agentMonitoringRuntime.js";

export type AgentTargetMode = "production" | "fixture";

export type AgentRuntimeSettings = {
  serverUrl: string;
  credentialsPath: string;
  computerName: string;
  version: string;
  targetMode: AgentTargetMode;
  fixtureUrl: string | null;
  // URL de navigation initiale effective: settings.fixtureUrl en mode
  // "fixture", sinon AGENT_TARGET_URL (env local a l'agent, jamais lu depuis
  // la configuration serveur). Jamais TLScontact dans les tests (section 10).
  targetUrl: string;
  maxActiveBots: number;
  dataRoot: string;
  // Lot 5 (section 2): reconnexion manuelle a backoff exponentiel + jitter,
  // pilotee entierement par l'agent (reconnection socket.io native
  // desactivee) pour distinguer erreur transitoire/definitive.
  reconnectMinDelayMs: number;
  reconnectMaxDelayMs: number;
  reconnectJitterRatio: number;
  // Lot 5 (section 4): borne stricte du buffer d'evenements hors ligne.
  offlineEventBufferMax: number;
  // Lot 5 (section 10): logs locaux.
  logMaxFileSizeMb: number;
  logMaxFiles: number;
  logLevel: AgentLogLevelSetting;
};

export type AgentLogLevelSetting = "debug" | "info" | "warn" | "error";

// Meme forme que celle deja ecrite par scripts/test-agent-phase1.ts (mode
// "pair"): un appairage effectue par l'un ou l'autre reste utilisable par
// l'autre, sans dupliquer un second format de fichier de credentials.
export type StoredAgentCredentials = {
  agentId: number;
  token: string;
  agencyId: number;
  computerName: string;
  displayName: string;
  version: string;
  pairedAt: string;
};

export type AgentCommandEnvelope = {
  commandId: string;
  type: string;
  agentId: number;
  botId: string;
  createdAt: string;
  expiresAt: string | null;
  payload: unknown;
};

// -------- Lot 2: cycle de vie reel Chrome/Playwright --------

export type AgentBotStatusValue =
  | "STARTING"
  | "WAITING_FOR_USER"
  | "MONITORING"
  | "RATE_LIMITED"
  | "SLOT_DETECTED"
  | "STOPPING"
  | "STOPPED"
  | "ERROR";

// Codes publics whitelistes (section 6/7/8 du cahier des charges Phase 4
// Lot 2/3): jamais de stack trace, jamais de detail Playwright/Chrome brut.
export const AGENT_COMMAND_ERROR_CODES = [
  "BROWSER_LAUNCH_FAILED",
  "BROWSER_NOT_FOUND",
  "BROWSER_CONNECTION_FAILED",
  "PROFILE_LOCKED",
  "PROFILE_CREATE_FAILED",
  "BOT_ALREADY_RUNNING",
  "AGENT_CAPACITY_REACHED",
  "BOT_NOT_FOUND",
  "ENGINE_NOT_IMPLEMENTED",
  // Lot 3 (VALIDATE_BOT)
  "BOT_NOT_RUNNING",
  "BROWSER_CLOSED",
  "BROWSER_CONNECTION_LOST",
  "PAGE_NOT_READY",
  "PAGE_CLOSED",
  "INVALID_BOT_STATE",
  "AGENT_NOT_CONNECTED",
  "VALIDATION_ALREADY_RUNNING",
  // Lot 4 (surveillance reelle)
  "REFRESH_FAILED",
  // Lot 5 (extensions locales, section 13)
  "EXTENSION_NOT_FOUND",
  "EXTENSION_INVALID"
] as const;

export type AgentCommandErrorCode = typeof AGENT_COMMAND_ERROR_CODES[number];

// browser/context/browserProcess ne sont JAMAIS serialises ni transmis au
// serveur (section 6): uniquement conserves en memoire, cote agent.
export type AgentBotHandle = {
  botId: string;
  startCommandId: string;
  browserProcess: import("node:child_process").ChildProcess;
  browser: import("playwright").Browser;
  context: import("playwright").BrowserContext;
  page: import("playwright").Page;
  profilePath: string;
  debugPort: number;
  currentStatus: AgentBotStatusValue;
  startedAt: string;
  lastActivityAt: string;
  lastError: string | null;
  // Lot 3: vrai seulement une fois VALIDATE_BOT reussi et la boucle
  // effectivement demarree (Lot 4).
  monitoringPrepared: boolean;
  // Lot 4: snapshot deja valide/borne (jamais le payload brut du serveur),
  // propre a CE bot (section 3/4).
  settingsSnapshot: AgentMonitoringSettings;
  // Lot 4: present uniquement pendant MONITORING (entre VALIDATE_BOT reussi
  // et STOP_BOT/fermeture).
  monitoringRuntime: MonitoringRuntimeHandle | null;
};

// -------- Lot 5: resilience (reconnexion, buffer, resync, extensions) --------

// Snapshot public envoye au serveur via AGENT_RUNTIME_STATUS (section 6):
// jamais profilePath/debugPort/PID/cookies/URL complete/objets Playwright.
export type RuntimeStatusBotSnapshot = {
  botId: string;
  status: AgentBotStatusValue;
  startedAt: string;
  lastActivityAt: string;
  monitoringActive: boolean;
  browserOpen: boolean;
};

// -------- Lot 5: extensions Chrome locales (section 12/13) --------

export type AgentExtensionEntry = {
  id: string;
  enabled: boolean;
  required: boolean;
  localPath: string;
};

export type AgentExtensionConfigFile = {
  extensions: AgentExtensionEntry[];
};

export type AgentExtensionValidationStatus = "ok" | "invalid" | "not_found" | "disabled";

export type AgentExtensionValidationResult = {
  id: string;
  enabled: boolean;
  required: boolean;
  status: AgentExtensionValidationStatus;
  // Jamais transmis au serveur (section 14): usage strictement local (choix
  // des arguments --load-extension, logs locaux assainis).
  localPath: string;
  version: string | null;
  reason: string | null;
};

// Inventaire public envoye via AGENT_EXTENSION_STATUS (section 14): jamais
// localPath, jamais reason (pourrait reveler une structure de dossier).
export type AgentExtensionPublicStatus = {
  id: string;
  configured: boolean;
  valid: boolean;
  version: string | null;
};
