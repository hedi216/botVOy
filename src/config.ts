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
  pairingCodeTtlMinutes: number;
  pairingMaxAttemptsPerCode: number;
};

export const loadAgentGatewayConfig = (): AgentGatewayConfig => ({
  heartbeatIntervalMs: numberEnv("AGENT_HEARTBEAT_INTERVAL_MS", 10_000),
  offlineTimeoutMs: numberEnv("AGENT_OFFLINE_TIMEOUT_MS", 40_000),
  minAgentVersion: process.env.AGENT_MIN_VERSION?.trim() || "0.1.0",
  pairingCodeTtlMinutes: numberEnv("AGENT_PAIRING_CODE_TTL_MINUTES", 10),
  pairingMaxAttemptsPerCode: numberEnv("AGENT_PAIRING_MAX_ATTEMPTS", 5)
});

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
