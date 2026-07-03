import "dotenv/config";
import { AppConfig } from "./types.js";

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

export const loadConfig = (): AppConfig => ({
  targetUrl: process.env.TARGET_URL?.trim() || "about:blank",
  connectToExistingChrome: booleanEnv("CONNECT_TO_EXISTING_CHROME", false),
  chromeDebugUrl: process.env.CHROME_DEBUG_URL?.trim() || "http://127.0.0.1:9222",
  refreshIntervalMs: numberEnv("REFRESH_INTERVAL_MS", 180_000),
  headless: booleanEnv("HEADLESS", false),
  slowMoMs: numberEnv("SLOW_MO_MS", 200),
  debugKeepBrowserOpen: booleanEnv("DEBUG_KEEP_BROWSER_OPEN", true),
  maxRefreshAttempts: numberEnv("MAX_REFRESH_ATTEMPTS", 0),
  scanMonthCount: numberEnv("SCAN_MONTH_COUNT", 0)
});
