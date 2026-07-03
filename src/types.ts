import { Locator } from "playwright";

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
