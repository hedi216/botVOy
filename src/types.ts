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
  log?: (level: MonitorEventLevel, message: string) => void;
  waitForUser?: (message: string) => Promise<void>;
  recoverPage?: (preferredUrl?: string) => Promise<Page | null>;
};
