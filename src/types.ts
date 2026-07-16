import { Locator, Page } from "playwright";

export type AppConfig = {
  targetUrl: string;
  connectToExistingChrome: boolean;
  chromeDebugUrl: string;
  refreshIntervalMs: number;
  headless: boolean;
  slowMoMs: number;
  debugKeepBrowserOpen: boolean;
  maxRefreshAttempts: number;
  scanMonthCount: number;
  maxParallelScansPerDomain: number;
  monthClickMinDelayMs: number;
  monthClickMaxDelayMs: number;
  botCycleCooldownMinMs: number;
  botCycleCooldownMaxMs: number;
  refreshEveryCycles: number;
  rateLimitCooldownMinutes: number;
};

export type HumanValidationResult = {
  detected: boolean;
  reason?: string;
};

export type AppointmentAvailabilityResult = {
  detected: boolean;
  textFound?: string;
  dateTimeHint?: string;
};

export type CandidateElementResult = {
  locator: Locator;
  text: string;
};

export type MonitorEventLevel = "info" | "warn" | "error" | "success";

export type MonitorRuntime = {
  botName?: string;
  category?: string;
  log?: (level: MonitorEventLevel, message: string) => void;
  waitForUser?: (message: string) => Promise<void>;
  recoverPage?: (preferredUrl?: string) => Promise<Page | null>;
  waitWhileNotPaused?: () => Promise<void>;
};
