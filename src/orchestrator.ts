import { MonitorEventLevel } from "./types.js";
import { MonitoringSettings } from "./userService.js";

type Logger = (level: MonitorEventLevel, message: string) => void;

type DomainState = {
  activeScans: number;
  cooldownUntil: number;
  waiters: Array<() => void>;
};

type TurnInput = {
  botName?: string;
  domain: string;
  settings: MonitoringSettings;
  log: Logger;
};

const domainStates = new Map<string, DomainState>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const getState = (domain: string): DomainState => {
  const existing = domainStates.get(domain);
  if (existing) {
    return existing;
  }

  const state: DomainState = {
    activeScans: 0,
    cooldownUntil: 0,
    waiters: []
  };
  domainStates.set(domain, state);
  return state;
};

const wakeNext = (domain: string): void => {
  const state = getState(domain);
  const next = state.waiters.shift();
  next?.();
};

export const randomBetween = (min: number, max: number): number => {
  const safeMin = Math.max(0, Math.min(min, max));
  const safeMax = Math.max(safeMin, max);
  return Math.floor(safeMin + Math.random() * (safeMax - safeMin + 1));
};

export const waitRandomDelay = async (
  min: number,
  max: number,
  log?: Logger,
  label = "Attente"
): Promise<void> => {
  const delay = randomBetween(min, max);
  if (delay > 0) {
    log?.("info", `${label}: ${delay}ms.`);
    await sleep(delay);
  }
};

export const waitForScanTurn = async ({ botName, domain, settings, log }: TurnInput): Promise<void> => {
  const label = botName ? `${botName}` : "Bot";

  while (true) {
    const state = getState(domain);
    const now = Date.now();
    if (state.cooldownUntil > now) {
      const waitMs = state.cooldownUntil - now;
      log("warn", `Orchestration: ${domain} en cooldown rate-limit. ${label} attend ${Math.ceil(waitMs / 60_000)} min.`);
      await sleep(Math.min(waitMs, 60_000));
      continue;
    }

    if (state.activeScans < settings.maxParallelScansPerDomain) {
      state.activeScans += 1;
      log("info", `Orchestration: tour de scan obtenu (${state.activeScans}/${settings.maxParallelScansPerDomain}) pour ${domain}.`);
      return;
    }

    log("info", `Orchestration: ${label} attend son tour pour ${domain}.`);
    await new Promise<void>((resolve) => {
      state.waiters.push(resolve);
    });
  }
};

export const releaseScanTurn = (domain: string, log?: Logger): void => {
  const state = getState(domain);
  state.activeScans = Math.max(0, state.activeScans - 1);
  log?.("info", `Orchestration: tour de scan libere pour ${domain}.`);
  wakeNext(domain);
};

export const applyRateLimitCooldown = (
  domain: string,
  minutes: number,
  log?: Logger
): void => {
  const state = getState(domain);
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + minutes * 60_000);
  log?.("warn", `Orchestration: cooldown rate-limit applique sur ${domain} pendant ${minutes} min.`);
};
