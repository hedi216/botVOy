// Types locaux au runtime RendezBot Agent. Distinct de src/shared/types.ts
// (moteur de surveillance) et de src/db.ts (types serveur/PostgreSQL): ce
// fichier ne doit jamais importer quoi que ce soit depuis src/server.ts,
// src/db.ts ou tout module cote serveur (cf. section 2 du cahier des charges).

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
};

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
  | "STOPPING"
  | "STOPPED"
  | "ERROR";

// Codes publics whitelistes (section 7/8 du cahier des charges Phase 4):
// jamais de stack trace, jamais de detail Playwright/Chrome brut.
export const AGENT_COMMAND_ERROR_CODES = [
  "BROWSER_LAUNCH_FAILED",
  "BROWSER_NOT_FOUND",
  "BROWSER_CONNECTION_FAILED",
  "PROFILE_LOCKED",
  "PROFILE_CREATE_FAILED",
  "BOT_ALREADY_RUNNING",
  "AGENT_CAPACITY_REACHED",
  "BOT_NOT_FOUND",
  "ENGINE_NOT_IMPLEMENTED"
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
};
