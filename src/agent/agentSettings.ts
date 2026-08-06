import "dotenv/config";
import os from "node:os";
import path from "node:path";
import agentVersionInfo from "./agentVersionInfo.json";
import { getDefaultCredentialsPath } from "./agentStorage.js";
import { AgentLogLevelSetting, AgentRuntimeMode, AgentRuntimeSettings, AgentTargetMode } from "./types.js";

// Version locale au runtime agent: independante du numero de version du
// package serveur (rdv-agent/package.json, qui designe le serveur lui-meme,
// pas ce runtime). Alignee par defaut sur AGENT_MIN_VERSION cote serveur
// (config.ts) pour qu'un agent fraichement demarre ne soit jamais rejete
// comme VERSION_INCOMPATIBLE sans configuration explicite.
//
// Phase 5 (Lot 1, section 13): source UNIQUE de version, importee en JSON
// (tsc copie automatiquement ce fichier a cote du .js compile, donc toujours
// resolu par un chemin relatif stable, meme empaquete) plutot qu'une chaine
// dupliquee en dur ici. Ne PAS changer agentVersionInfo.json sans decision
// explicite (jamais un bump de version silencieux depuis ce fichier de code).
export const AGENT_VERSION = process.env.AGENT_VERSION?.trim() || agentVersionInfo.agentVersion;
export const AGENT_PROTOCOL_VERSION = agentVersionInfo.protocolVersion;

const numberEnv = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw || !raw.trim()) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Variable d'environnement invalide: ${key}`);
  }
  return value;
};

const ratioEnv = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw || !raw.trim()) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Variable d'environnement invalide (attendu entre 0 et 1): ${key}`);
  }
  return value;
};

const resolveLogLevel = (): AgentLogLevelSetting => {
  const raw = process.env.AGENT_LOG_LEVEL?.trim().toLowerCase();
  if (!raw) {
    return "info";
  }
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  throw new Error(`AGENT_LOG_LEVEL invalide: "${raw}". Valeurs acceptees: debug, info, warn, error.`);
};

const resolveTargetMode = (): AgentTargetMode => {
  const raw = process.env.AGENT_TARGET_MODE?.trim();
  if (!raw || raw === "production") {
    return "production";
  }
  if (raw === "fixture") {
    return "fixture";
  }
  throw new Error(
    `AGENT_TARGET_MODE invalide: "${raw}". Valeurs acceptees: "production" (defaut) ou "fixture".`
  );
};

// Nom de l'executable embarque (copie renommee de node.exe, voir
// agent-packaging.md section 11.1/11.2) - jamais present hors d'une
// installation reelle (un `npm run agent:dev` execute toujours via le
// `node.exe`/`tsx` systeme, jamais via une copie renommee). Sert de
// "marqueur" fiable, genere par construction au build, pour detecter un
// lancement installe SANS dependre d'un fichier ni de process.cwd().
const PACKAGED_EXECUTABLE_BASENAME = "rendezbotagent.exe";

const isRunningFromPackagedExecutable = (): boolean =>
  path.basename(process.execPath).toLowerCase() === PACKAGED_EXECUTABLE_BASENAME;

// Phase 5 (Lot 2, section 2 ; defense renforcee au Lot 3): mode d'execution
// EXPLICITE. "development" reste le defaut HORS installation (comportement
// historique de `npm run agent:dev` inchange), pour ne jamais casser un usage
// existant sans configuration explicite - jamais devine depuis la plateforme
// ou la presence d'un fichier.
//
// Defense supplementaire (defaut trouve au Lot 3, test manuel VM): un
// lancement installe (raccourci menu Demarrer/Bureau/Demarrage/apres mise a
// niveau) qui, pour quelque raison que ce soit, ne transmettrait PAS
// AGENT_RUNTIME_MODE ne doit JAMAIS retomber silencieusement sur
// "development" (et donc sur un serveur localhost) - il ne peut s'agir que
// d'un build installe (voir PACKAGED_EXECUTABLE_BASENAME ci-dessus), jamais
// d'un autre cas ambigu a deviner.
const resolveRuntimeMode = (): AgentRuntimeMode => {
  const raw = process.env.AGENT_RUNTIME_MODE?.trim();
  if (!raw) {
    return isRunningFromPackagedExecutable() ? "packaged" : "development";
  }
  if (raw === "development" || raw === "packaged" || raw === "test") {
    return raw;
  }
  throw new Error(
    `AGENT_RUNTIME_MODE invalide: "${raw}". Valeurs acceptees: "development" (defaut), "packaged", "test".`
  );
};

// Emplacement local Windows attendu (sections 7/11/12 du cahier des
// charges): jamais le dossier du projet. AGENT_DATA_DIR reste disponible
// pour les tests automatises (fixture) qui doivent isoler leurs donnees.
const resolveDataRoot = (): string => {
  const override = process.env.AGENT_DATA_DIR?.trim();
  if (override) {
    return override;
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "RendezBot");
  }
  return path.join(os.tmpdir(), "RendezBot");
};

// Defaut de production reel du runtime packaged (defaut trouve pendant un
// test manuel sur VM Lot 3: sans configuration, l'interface locale affichait
// "localhost:3000" apres une VRAIE installation - un runtime packaged n'a,
// par construction, jamais de raison de tomber sur un serveur de
// developpement local). Litteral en dur ici (jamais derive de process.cwd()
// ni d'un fichier .env/de build/de test - aucun de ces mecanismes n'est
// jamais lu pour CE defaut precis) : c'est la seule adresse qu'un runtime
// packaged sans configuration doit jamais utiliser.
const PRODUCTION_SERVER_URL = "https://app.rendezbot.xyz";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const isLoopbackHost = (hostname: string): boolean => LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());

const parseServerUrl = (raw: string, context: string): URL => {
  try {
    return new URL(raw);
  } catch {
    throw new Error(`AGENT_SERVER_URL invalide ${context}: "${raw}".`);
  }
};

// Resolution du serveur EXPLICITEMENT dependante du mode d'execution
// (section "defaut trouve en VM", corrige au Lot 3) - jamais un seul defaut
// partage entre packaged/development/test comme precedemment.
const resolveServerUrl = (runtimeMode: AgentRuntimeMode): string => {
  const explicit = process.env.AGENT_SERVER_URL?.trim();

  if (runtimeMode === "packaged") {
    // Aucun fallback implicite vers un serveur de developpement local:
    // sans configuration explicite, un runtime packaged ne doit JAMAIS
    // pointer ailleurs que sur le serveur de production reel.
    if (!explicit) {
      return PRODUCTION_SERVER_URL;
    }
    const parsed = parseServerUrl(explicit, "en mode packaged");
    // Un hote local reste tolere explicitement (verifications internes du
    // runtime packaged lui-meme, ex. tests reels de packaging) - jamais un
    // defaut implicite, uniquement une configuration deliberee. Au-dela du
    // loopback, un serveur DISTANT est obligatoirement HTTPS: jamais de
    // trafic en clair vers un serveur reel.
    if (!isLoopbackHost(parsed.hostname) && parsed.protocol !== "https:") {
      throw new Error(
        `AGENT_SERVER_URL doit utiliser https:// pour un serveur distant en mode packaged (obtenu: "${explicit}"). Jamais de HTTP en clair vers un serveur de production.`
      );
    }
    return explicit;
  }

  if (runtimeMode === "test") {
    // Section 3 (cahier des charges Lot 3, correctif serveur par defaut):
    // jamais de serveur par defaut, jamais de connexion Internet reelle en
    // mode test - uniquement un serveur local explicite.
    if (!explicit) {
      throw new Error(
        "AGENT_SERVER_URL est requis explicitement en mode test (aucun serveur par defaut, jamais de connexion Internet implicite)."
      );
    }
    const parsed = parseServerUrl(explicit, "en mode test");
    if (!isLoopbackHost(parsed.hostname)) {
      throw new Error(
        `En mode test, AGENT_SERVER_URL doit pointer vers un serveur local (obtenu: "${explicit}") - jamais une connexion Internet reelle.`
      );
    }
    return explicit;
  }

  // development: comportement historique conserve (localhost autorise,
  // explicite via AGENT_SERVER_URL/WEB_PORT ou par le defaut de ce mode -
  // jamais utilise en mode packaged/test, qui valident desormais chacun
  // explicitement leur propre cas).
  return explicit || `http://localhost:${process.env.WEB_PORT || 3000}`;
};

export const loadAgentSettings = (): AgentRuntimeSettings => {
  const targetMode = resolveTargetMode();
  const fixtureUrl = process.env.AGENT_FIXTURE_URL?.trim() || null;

  if (targetMode === "fixture" && !fixtureUrl) {
    throw new Error(
      "AGENT_TARGET_MODE=fixture requiert AGENT_FIXTURE_URL (jamais de site de test utilise implicitement)."
    );
  }

  // AGENT_TARGET_URL: jamais lu depuis la configuration serveur (TARGET_URL
  // appartient a config.ts, cote serveur, hors de portee de l'agent). Vide
  // par defaut: Chrome s'ouvre alors sur about:blank en production tant que
  // cette variable n'est pas fournie explicitement, jamais sur TLScontact
  // sans configuration deliberee (section 10).
  const targetUrl = targetMode === "fixture"
    ? fixtureUrl!
    : (process.env.AGENT_TARGET_URL?.trim() || "about:blank");

  const reconnectMinDelayMs = numberEnv("AGENT_RECONNECT_MIN_DELAY_MS", 1_000);
  const reconnectMaxDelayMs = numberEnv("AGENT_RECONNECT_MAX_DELAY_MS", 30_000);
  if (reconnectMinDelayMs > reconnectMaxDelayMs) {
    // Section 11 (Lot 6): erreur claire au demarrage plutot qu'un
    // comportement silencieusement degrade (le backoff sauterait sa montee
    // progressive et resterait bloque au maximum des la premiere tentative),
    // coherent avec les autres validations deja strictes de ce fichier.
    throw new Error(
      `AGENT_RECONNECT_MIN_DELAY_MS (${reconnectMinDelayMs}) ne doit pas depasser AGENT_RECONNECT_MAX_DELAY_MS (${reconnectMaxDelayMs}).`
    );
  }

  const dataRoot = resolveDataRoot();
  const runtimeMode = resolveRuntimeMode();

  return {
    serverUrl: resolveServerUrl(runtimeMode),
    credentialsPath: process.env.AGENT_CREDENTIALS_PATH?.trim()
      || getDefaultCredentialsPath(dataRoot),
    computerName: process.env.AGENT_COMPUTER_NAME?.trim() || os.hostname(),
    version: AGENT_VERSION,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    runtimeMode,
    targetMode,
    fixtureUrl,
    targetUrl,
    maxActiveBots: numberEnv("AGENT_MAX_ACTIVE_BOTS", 15),
    dataRoot,
    reconnectMinDelayMs,
    reconnectMaxDelayMs,
    reconnectJitterRatio: ratioEnv("AGENT_RECONNECT_JITTER_RATIO", 0.2),
    offlineEventBufferMax: numberEnv("AGENT_OFFLINE_EVENT_BUFFER_MAX", 500),
    logMaxFileSizeMb: numberEnv("AGENT_LOG_MAX_FILE_SIZE_MB", 5),
    logMaxFiles: numberEnv("AGENT_LOG_MAX_FILES", 5),
    logLevel: resolveLogLevel(),
    autoNavRetryIntervalMs: numberEnv("AGENT_AUTO_NAV_RETRY_INTERVAL_MS", 10_000),
    autoNavLongWaitMs: numberEnv("AGENT_AUTO_NAV_LONG_WAIT_MS", 5 * 60 * 1000),
    workflowRecoveryRetryIntervalMs: process.env.AGENT_WORKFLOW_RECOVERY_RETRY_INTERVAL_MS?.trim()
      ? numberEnv("AGENT_WORKFLOW_RECOVERY_RETRY_INTERVAL_MS", 10_000)
      : undefined,
    workflowRecoveryLongWaitMs: process.env.AGENT_WORKFLOW_RECOVERY_LONG_WAIT_MS?.trim()
      ? numberEnv("AGENT_WORKFLOW_RECOVERY_LONG_WAIT_MS", 5 * 60 * 1000)
      : undefined,
    humanValidationGraceMs: process.env.AGENT_HUMAN_VALIDATION_GRACE_MS?.trim()
      ? numberEnv("AGENT_HUMAN_VALIDATION_GRACE_MS", 4 * 60 * 1000)
      : undefined
  };
};
