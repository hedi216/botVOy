// Types locaux au runtime RendezBot Agent. Distinct de src/shared/types.ts
// (moteur de surveillance) et de src/db.ts (types serveur/PostgreSQL): ce
// fichier ne doit jamais importer quoi que ce soit depuis src/server.ts,
// src/db.ts ou tout module cote serveur (cf. section 2 du cahier des charges).

import type { AgentMonitoringSettings } from "./agentMonitoringSettings.js";
import type { MonitoringRuntimeHandle } from "./agentMonitoringRuntime.js";
import type { AgentLogFn } from "./agentLocalLogger.js";

export type AgentTargetMode = "production" | "fixture";

// Phase 5 (Lot 2, section 2): mode d'execution EXPLICITE, jamais devine a
// partir de la presence d'un fichier ou de la plateforme seule. Determine le
// choix de AgentCredentialStore (jamais un fallback silencieux vers un
// fichier en clair en mode "packaged").
export type AgentRuntimeMode = "development" | "packaged" | "test";

export type AgentRuntimeSettings = {
  serverUrl: string;
  credentialsPath: string;
  computerName: string;
  version: string;
  protocolVersion: number;
  runtimeMode: AgentRuntimeMode;
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
  // Hotfix 0.1.1: cadence de la cascade de connexion automatique
  // (AgentBotManager.runAutoNavigation) - valeurs de production calquees sur
  // sessionManager.ts (SILENT_RECOVERY_*), configurables uniquement pour
  // accelerer les tests automatises cibles (jamais utilise pour changer le
  // comportement reel en production sans decision explicite).
  autoNavRetryIntervalMs: number;
  autoNavLongWaitMs: number;
  // HOTFIX 0.2.3: meme principe que autoNavRetryIntervalMs/autoNavLongWaitMs
  // ci-dessus, pour la cadence du recovery workflow du MONITORING (jamais
  // celle de l'auto-navigation initiale). Optionnels: absent -> les
  // constantes de production actuelles (10s/5min) restent utilisees dans
  // agentMonitoringRuntime.ts, aucun changement de comportement reel sans
  // decision explicite.
  workflowRecoveryRetryIntervalMs?: number;
  workflowRecoveryLongWaitMs?: number;
  // HOTFIX 0.2.3 (correctif Cloudflare/validation humaine): meme principe -
  // override TEST UNIQUEMENT de la fenetre humaine (HUMAN_BLOCK_GRACE_MS,
  // src/shared/monitor.ts) consultee pendant le recovery. Absent en
  // production reelle, comportement inchange (4 min).
  humanValidationGraceMs?: number;
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

// -------- Phase 5 (Lot 2): stockage protege des credentials --------

export type CredentialProtectionKind = "plaintext-dev" | "windows-dpapi-current-user" | "memory-test";

// Jamais de secret ici (section 2): uniquement de quoi diagnostiquer/afficher
// sans risque cote interface locale ou logs.
export type CredentialStoreSecurityDescription = {
  mode: AgentRuntimeMode;
  protection: CredentialProtectionKind;
  path: string | null;
};

// load()/save()/clear() manipulent toujours StoredAgentCredentials (jamais le
// format sur disque, propre a chaque implementation): agentClient.ts n'a donc
// jamais besoin de connaitre le mode de protection reel.
export interface AgentCredentialStore {
  load(): Promise<StoredAgentCredentials | null>;
  save(credentials: StoredAgentCredentials): Promise<void>;
  clear(): Promise<void>;
  exists(): Promise<boolean>;
  describeSecurity(): CredentialStoreSecurityDescription;
}

// Format versionne du fichier protege par DPAPI (section 4): jamais le token
// en clair, uniquement protectedToken (base64 du blob DPAPI). agentId n'est
// pas un secret en soi mais reste dans la meme enveloppe versionnee pour une
// coherence de format et une eventuelle rotation future.
export type ProtectedCredentialsFileV1 = {
  formatVersion: 1;
  protection: "windows-dpapi-current-user";
  agentId: number;
  protectedToken: string;
  agencyId: number;
  computerName: string;
  displayName: string;
  version: string;
  pairedAt: string;
  createdAt: string;
  updatedAt: string;
};

// -------- Phase 5 (Lot 2): chemins centralises --------

export type AgentPaths = {
  dataRoot: string;
  credentialsDir: string;
  credentialsFilePath: string;
  logsDir: string;
  configDir: string;
  profilesDir: string;
  stateDir: string;
};

// -------- Phase 5 (Lot 2): verrou mono-instance --------

export type AgentSingleInstanceLockInfo = {
  pid: number;
  localUiPort: number | null;
  startedAt: string;
};

// -------- Phase 5 (Lot 2): interface locale --------

export type AgentLocalUiState =
  | "NOT_PAIRED"
  | "CONNECTING"
  | "CONNECTED"
  | "SYNCING"
  | "OFFLINE"
  | "REVOKED"
  | "VERSION_INCOMPATIBLE";

// Jamais de token/blob/chemin complet/URL avec query string ici (section 7):
// uniquement des champs deja surs a afficher tels quels.
export type AgentLocalUiStatusPayload = {
  state: AgentLocalUiState;
  agentVersion: string;
  protocolVersion: number;
  computerName: string;
  serverHost: string;
  paired: boolean;
  activeBotCount: number;
  extensions: AgentExtensionPublicStatus[];
  message: string | null;
};

export type AgentCommandEnvelope = {
  commandId: string;
  type: string;
  agentId: number;
  botId: string;
  createdAt: string;
  expiresAt: string | null;
  payload: unknown;
  // Hotfix 0.1.1: jamais persiste cote serveur (voir DispatchAgentCommandParams
  // dans agentCommandService.ts) - reserve aux secrets qui ne doivent
  // transiter qu'en memoire (ex. identifiants TLScontact pour START_BOT).
  // Jamais logue tel quel, jamais ecrit sur disque, jamais renvoye au serveur.
  transientPayload?: unknown;
};

export type AgentExtensionInstallLink = {
  id: number;
  name: string;
  installUrl: string;
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
  // BUG CIBLE 0.1.5: distinct de AGENT_CAPACITY_REACHED - jamais utilise
  // lorsque activeCount<maxActiveBots (cf. AgentBotManager.startBot()),
  // uniquement lorsque this.shuttingDown est vrai (arret definitif du
  // process en cours, cf. AgentBotManager.shutdownAll()).
  "AGENT_SHUTTING_DOWN",
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
  "EXTENSION_INVALID",
  // Hotfix 0.1.2: aucune URL TLS de depart absolue/valide n'a pu etre
  // resolue (startUrl absent ou invalide) alors qu'aucune extension locale
  // ne prend le relais - jamais de tentative de navigation relative depuis
  // about:blank (cf. src/shared/loginFlow.ts), jamais de boucle silencieuse
  // de plusieurs minutes sur une configuration structurellement impossible.
  "TLS_START_URL_INVALID",
  // Hotfix critique (isolation des profils par compte TLS): un profil deja
  // attribue a ce compte (cf. agentProfileManager.ts:
  // acquireProfileLockForAccount) est actuellement verrouille par un autre
  // bot de CE MEME compte - jamais un second Chrome sur le meme profil.
  "TLS_ACCOUNT_ALREADY_RUNNING"
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
  // Hotfix 0.1.1: jamais un secret - transmis a startMonitoring()/aux logs
  // publics comme avant (deja des champs publics ailleurs, ex. BOT_STATUS).
  // Jamais login/password ici: ceux-ci ne vivent que dans la portee locale de
  // startBot()/attemptAutoNavigation(), jamais stockes sur ce handle
  // long-lived (section 3 du hotfix: duree de vie minimale en memoire).
  botName?: string;
  category?: string;
  // BUG CIBLE 0.2.4 (mauvais target URL): startUrl DEJA VALIDE (jamais
  // about:blank, jamais un autre schema que http/https - cf.
  // isValidAbsoluteStartUrl dans agentBotManager.ts) recu par CE bot via
  // START_BOT.startUrl. Source UNIQUE de verite pour le monitoring/recovery de
  // ce bot pendant toute sa duree de vie (runAutoNavigation -> beginMonitoring
  // -> startMonitoring -> recoverWorkflow -> attemptReturnToTargetUrl),
  // qu'il ait atteint MONITORING automatiquement OU via VALIDATE_BOT -
  // jamais this.settings.targetUrl (AGENT_TARGET_URL local, "about:blank" par
  // defaut en installation packaged) une fois ce champ renseigne. Absent
  // uniquement si START_BOT n'a jamais fourni de startUrl valide (flux
  // extension locale) - beginMonitoring retombe alors sur
  // this.settings.targetUrl, comportement inchange pour ce cas. Jamais un
  // secret (juste une URL non sensible, deja transmise dans le payload public
  // START_BOT), jamais derive de l'URL courante du navigateur.
  recoveryTargetUrl?: string;
  // Logger DEDIE a ce bot (section "nouveaux logs par bot"): tee vers le
  // fichier partage agent.log (via le AgentLogFn injecte au constructeur de
  // AgentBotManager) ET vers un fichier propre a CETTE execution de bot (cf.
  // createBotLogger, agentLocalLogger.ts). Jamais un secret ici (une simple
  // fonction, deja soumise a la meme redaction que le logger partage).
  log: AgentLogFn;
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
