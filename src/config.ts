import "dotenv/config";
import { AppConfig } from "./shared/types.js";

const numberEnv = (key: string, fallback: number): number => {
  const raw = process.env[key];

  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Variable d'environnement invalide: ${key}`);
  }

  return value;
};

// Phase 5 (Lot 2 - correctif protocole complementaire): un plancher de
// protocole sans plafond acceptait implicitement toute version future -
// jamais souhaitable pour un champ de compatibilite. Entier strict (jamais
// de decimal), jamais negatif.
const integerEnv = (key: string, fallback: number): number => {
  const raw = process.env[key];

  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Variable d'environnement invalide: ${key} (entier positif attendu)`);
  }

  return value;
};

const booleanEnv = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];

  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
};

export type AgentGatewayConfig = {
  heartbeatIntervalMs: number;
  offlineTimeoutMs: number;
  minAgentVersion: string;
  // Phase 5 (Lot 2 - correctif protocole): plancher de PROTOCOLE, distinct de
  // minAgentVersion (version applicative). Valeur par defaut alignee sur
  // agentVersionInfo.json (protocolVersion actuel de l'agent, "1") par
  // convention documentee - jamais importee depuis src/agent (le serveur ne
  // doit jamais dependre du runtime agent), donc pas une duplication de la
  // meme source, mais bien le plancher de compatibilite propre au serveur.
  minProtocolVersion: number;
  // Plafond explicite (correctif de securite complementaire): sans lui,
  // AGENT_MIN_PROTOCOL_VERSION seul acceptait implicitement toute version
  // future, jamais une intention explicite pour un champ de compatibilite.
  maxProtocolVersion: number;
  pairingCodeTtlMinutes: number;
  pairingMaxAttemptsPerCode: number;
};

export const loadAgentGatewayConfig = (): AgentGatewayConfig => {
  const minProtocolVersion = integerEnv("AGENT_MIN_PROTOCOL_VERSION", 1);
  const maxProtocolVersion = integerEnv("AGENT_MAX_PROTOCOL_VERSION", 1);
  if (minProtocolVersion > maxProtocolVersion) {
    throw new Error(
      `AGENT_MIN_PROTOCOL_VERSION (${minProtocolVersion}) ne doit pas depasser AGENT_MAX_PROTOCOL_VERSION (${maxProtocolVersion}).`
    );
  }

  return {
    heartbeatIntervalMs: numberEnv("AGENT_HEARTBEAT_INTERVAL_MS", 10_000),
    offlineTimeoutMs: numberEnv("AGENT_OFFLINE_TIMEOUT_MS", 40_000),
    minAgentVersion: process.env.AGENT_MIN_VERSION?.trim() || "0.1.0",
    minProtocolVersion,
    maxProtocolVersion,
    pairingCodeTtlMinutes: numberEnv("AGENT_PAIRING_CODE_TTL_MINUTES", 10),
    pairingMaxAttemptsPerCode: numberEnv("AGENT_PAIRING_MAX_ATTEMPTS", 5)
  };
};

export type AgentCommandConfig = {
  ackTimeoutMs: number;
  ttlMs: number;
  sweepIntervalMs: number;
};

export const loadAgentCommandConfig = (): AgentCommandConfig => ({
  ackTimeoutMs: numberEnv("AGENT_COMMAND_ACK_TIMEOUT_MS", 10_000),
  ttlMs: numberEnv("AGENT_COMMAND_TTL_MS", 60_000),
  sweepIntervalMs: numberEnv("AGENT_COMMAND_SWEEP_INTERVAL_MS", 5_000)
});

export type BotExecutionMode = "legacy_vm" | "agent";

export type Phase2FeatureFlags = {
  agentUiEnabled: boolean;
  agentDownloadUrl: string;
  botExecutionMode: BotExecutionMode;
};

// legacy_vm reste la valeur par defaut uniquement pour ne pas casser
// l'environnement de developpement existant pendant la migration: ce n'est
// jamais un fallback silencieux choisi a l'execution, seulement l'absence
// explicite de la variable d'environnement.
export const loadPhase2FeatureFlags = (): Phase2FeatureFlags => ({
  agentUiEnabled: booleanEnv("AGENT_UI_ENABLED", false),
  agentDownloadUrl: process.env.AGENT_DOWNLOAD_URL?.trim() || "",
  botExecutionMode: process.env.BOT_EXECUTION_MODE?.trim() === "agent" ? "agent" : "legacy_vm"
});

// Phase 5 (Lot 4, section 10): enum simple - jamais un systeme de canaux
// complexe tant qu'une simple valeur suffit. "candidate" = ce lot (livraison
// interne, pas encore une release client finale).
export type AgentReleaseChannel = "candidate" | "stable" | "deprecated" | "blocked";
const AGENT_RELEASE_CHANNELS: AgentReleaseChannel[] = ["candidate", "stable", "deprecated", "blocked"];

export type AgentReleaseConfig = {
  // null = release service desactive/non configure (jamais un dossier ou une
  // version devinee par defaut - une release doit toujours etre activee
  // EXPLICITEMENT par un operateur, jamais choisie par tri alphabetique du
  // contenu d'un dossier).
  releasesDir: string | null;
  releaseVersion: string | null;
  channel: AgentReleaseChannel;
  // Override administratif (section 8): si fourni, remplace entierement le
  // lien de telechargement genere par le service interne - jamais lu
  // directement par le frontend, uniquement par le service de release.
  downloadUrlOverride: string | null;
};

const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Meme raisonnement que resolveServerUrl cote agent (Phase 5, Lot 3,
// agentSettings.ts): un override HTTP distant serait un telechargement en
// clair d'un executable Windows - jamais accepte. Un hote local reste tolere
// (tests explicites), jamais un defaut implicite.
const validateDownloadUrlOverride = (raw: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`AGENT_DOWNLOAD_URL invalide: "${raw}".`);
  }
  const isLoopback = LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
  if (parsed.protocol !== "https:" && !isLoopback) {
    throw new Error(
      `AGENT_DOWNLOAD_URL doit utiliser https:// pour un hote distant (obtenu: "${raw}"). Un hote local (test explicite) reste tolere.`
    );
  }
  return raw;
};

export const loadAgentReleaseConfig = (): AgentReleaseConfig => {
  const releasesDir = process.env.AGENT_RELEASES_DIR?.trim() || null;

  const releaseVersionRaw = process.env.AGENT_RELEASE_VERSION?.trim() || null;
  if (releaseVersionRaw && !RELEASE_VERSION_PATTERN.test(releaseVersionRaw)) {
    throw new Error(`AGENT_RELEASE_VERSION invalide: "${releaseVersionRaw}" (format attendu: X.Y.Z).`);
  }

  const channelRaw = process.env.AGENT_RELEASE_CHANNEL?.trim() || "candidate";
  if (!AGENT_RELEASE_CHANNELS.includes(channelRaw as AgentReleaseChannel)) {
    throw new Error(`AGENT_RELEASE_CHANNEL invalide: "${channelRaw}". Valeurs acceptees: ${AGENT_RELEASE_CHANNELS.join(", ")}.`);
  }

  const downloadUrlOverrideRaw = process.env.AGENT_DOWNLOAD_URL?.trim() || null;

  return {
    releasesDir,
    releaseVersion: releaseVersionRaw,
    channel: channelRaw as AgentReleaseChannel,
    downloadUrlOverride: downloadUrlOverrideRaw ? validateDownloadUrlOverride(downloadUrlOverrideRaw) : null
  };
};

// Lot 6 (section 11): les cas min > max sont deja geres de maniere
// defensive a l'usage (orchestrator.ts randomBetween() clampe silencieusement),
// donc jamais bloquant au demarrage - mais une configuration incoherente
// merite un avertissement explicite plutot qu'un silence total.
const warnIfInverted = (label: string, min: number, max: number): void => {
  if (min > max) {
    // eslint-disable-next-line no-console
    console.warn(`[config] ${label}: la valeur minimale (${min}) depasse la valeur maximale (${max}). Les delais reels seront tout de meme bornes correctement a l'usage, mais corrigez cette configuration.`);
  }
};

export const loadConfig = (): AppConfig => {
  const config: AppConfig = {
    targetUrl: process.env.TARGET_URL?.trim() || "about:blank",
    connectToExistingChrome: booleanEnv("CONNECT_TO_EXISTING_CHROME", false),
    chromeDebugUrl: process.env.CHROME_DEBUG_URL?.trim() || "http://127.0.0.1:9222",
    refreshIntervalMs: numberEnv("REFRESH_INTERVAL_MS", 180_000),
    headless: booleanEnv("HEADLESS", false),
    slowMoMs: numberEnv("SLOW_MO_MS", 200),
    debugKeepBrowserOpen: booleanEnv("DEBUG_KEEP_BROWSER_OPEN", true),
    maxRefreshAttempts: numberEnv("MAX_REFRESH_ATTEMPTS", 0),
    scanMonthCount: numberEnv("SCAN_MONTH_COUNT", 0),
    maxParallelScansPerDomain: numberEnv("MAX_PARALLEL_SCANS_PER_DOMAIN", 1),
    monthClickMinDelayMs: numberEnv("MONTH_CLICK_MIN_DELAY_MS", 5_000),
    monthClickMaxDelayMs: numberEnv("MONTH_CLICK_MAX_DELAY_MS", 10_000),
    botCycleCooldownMinMs: numberEnv("BOT_CYCLE_COOLDOWN_MIN_MS", 120_000),
    botCycleCooldownMaxMs: numberEnv("BOT_CYCLE_COOLDOWN_MAX_MS", 240_000),
    refreshEveryCycles: numberEnv("REFRESH_EVERY_CYCLES", 20),
    rateLimitCooldownMinutes: numberEnv("RATE_LIMIT_COOLDOWN_MINUTES", 45)
  };

  warnIfInverted("MONTH_CLICK_MIN_DELAY_MS/MAX_DELAY_MS", config.monthClickMinDelayMs, config.monthClickMaxDelayMs);
  warnIfInverted("BOT_CYCLE_COOLDOWN_MIN_MS/MAX_MS", config.botCycleCooldownMinMs, config.botCycleCooldownMaxMs);

  return config;
};
