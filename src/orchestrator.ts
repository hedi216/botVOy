import { MonitorEventLevel } from "./types.js";
import { MonitoringSettings } from "./userService.js";

type Logger = (level: MonitorEventLevel, message: string) => void;

type DomainState = {
  activeScans: number;
  cooldownUntil: number;
  waiters: Array<() => void>;
  appointmentSignalVersion: number;
  appointmentSignalWaiters: Array<() => void>;
  appointmentSignalAt: number;
  reservationRecheckTimer?: NodeJS.Timeout;
  participants: Map<string, number>;
  coverageSleepers: Map<string, () => void>;
  coverageTimer?: NodeJS.Timeout;
};

type TurnInput = {
  botName?: string;
  domain: string;
  settings: MonitoringSettings;
  log: Logger;
};

const domainStates = new Map<string, DomainState>();
const PARTICIPANT_TTL_MS = 10 * 60 * 1000;
const EMERGENCY_WINDOW_MS = 5 * 60 * 1000;
const COVERAGE_WAKE_MIN_MS = 15_000;
const COVERAGE_WAKE_MAX_MS = 45_000;
const RESERVATION_HOLD_RECHECK_MINUTES = 119;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const getState = (domain: string): DomainState => {
  const existing = domainStates.get(domain);
  if (existing) {
    return existing;
  }

  const state: DomainState = {
    activeScans: 0,
    cooldownUntil: 0,
    waiters: [],
    appointmentSignalVersion: 0,
    appointmentSignalWaiters: [],
    appointmentSignalAt: 0,
    reservationRecheckTimer: undefined,
    participants: new Map(),
    coverageSleepers: new Map()
  };
  domainStates.set(domain, state);
  return state;
};

const wakeNext = (domain: string): void => {
  const state = getState(domain);
  const next = state.waiters.shift();
  next?.();
};

const wakeAll = (callbacks: Array<() => void>): void => {
  const pending = callbacks.splice(0);
  for (const callback of pending) {
    callback();
  }
};

const clearCoverageTimer = (state: DomainState): void => {
  if (!state.coverageTimer) {
    return;
  }

  clearTimeout(state.coverageTimer);
  state.coverageTimer = undefined;
};

const purgeStaleParticipants = (state: DomainState): void => {
  const now = Date.now();
  for (const [botName, lastSeen] of state.participants) {
    if (now - lastSeen > PARTICIPANT_TTL_MS) {
      state.participants.delete(botName);
      state.coverageSleepers.delete(botName);
    }
  }
};

const touchParticipant = (domain: string, botName?: string): void => {
  if (!botName) {
    return;
  }

  const state = getState(domain);
  purgeStaleParticipants(state);
  state.participants.set(botName, Date.now());
};

const participantCount = (state: DomainState): number => {
  purgeStaleParticipants(state);
  return state.participants.size;
};

const isEmergencyWindowActive = (state: DomainState): boolean =>
  Date.now() - state.appointmentSignalAt <= EMERGENCY_WINDOW_MS;

export const isAppointmentSignalActive = (domain: string): boolean =>
  isEmergencyWindowActive(getState(domain));

const scheduleCoverageWake = (domain: string, log?: Logger): void => {
  const state = getState(domain);
  purgeStaleParticipants(state);

  if (
    state.coverageTimer
    || state.activeScans > 0
    || state.waiters.length > 0
    || state.coverageSleepers.size === 0
    || participantCount(state) <= 1
    || isEmergencyWindowActive(state)
  ) {
    return;
  }

  const delayMs = randomBetween(COVERAGE_WAKE_MIN_MS, COVERAGE_WAKE_MAX_MS);
  state.coverageTimer = setTimeout(() => {
    state.coverageTimer = undefined;

    if (state.activeScans > 0 || state.waiters.length > 0 || state.coverageSleepers.size === 0) {
      return;
    }

    const sleepers = [...state.coverageSleepers.entries()];
    const [botName, wake] = sleepers[Math.floor(Math.random() * sleepers.length)] ?? [];
    if (!wake) {
      return;
    }

    log?.("warn", `Orchestration: couverture minimale, reveil de ${botName} sur ${domain}.`);
    wake();
  }, delayMs);
};

const waitForAppointmentSignalOrTimeout = (
  domain: string,
  knownVersion: number,
  timeoutMs: number
): Promise<boolean> => {
  const state = getState(domain);
  if (state.appointmentSignalVersion > knownVersion) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      const index = state.appointmentSignalWaiters.indexOf(callback);
      if (index >= 0) {
        state.appointmentSignalWaiters.splice(index, 1);
      }
    };

    const callback = () => {
      cleanup();
      resolve(true);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    state.appointmentSignalWaiters.push(callback);
  });
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
  label = "Attente",
  wakeOnAppointmentDomain?: string,
  botName?: string
): Promise<void> => {
  const delayMs = randomBetween(min, max);
  if (delayMs > 0) {
    log?.("info", `${label}: ${delayMs}ms.`);

    if (wakeOnAppointmentDomain) {
      touchParticipant(wakeOnAppointmentDomain, botName);
      const signalVersion = getState(wakeOnAppointmentDomain).appointmentSignalVersion;
      const state = getState(wakeOnAppointmentDomain);

      const wokeBySignal = await new Promise<boolean>((resolve) => {
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          if (botName) {
            state.coverageSleepers.delete(botName);
          }
        };

        const finish = (value: boolean) => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          resolve(value);
        };

        const wakeCoverage = () => {
          finish(false);
        };

        const timer = setTimeout(() => {
          finish(false);
        }, delayMs);

        if (botName) {
          state.coverageSleepers.set(botName, wakeCoverage);
          scheduleCoverageWake(wakeOnAppointmentDomain, log);
        }

        void waitForAppointmentSignalOrTimeout(wakeOnAppointmentDomain, signalVersion, delayMs)
          .then((appointmentSignal) => {
            if (appointmentSignal) {
              finish(true);
            }
          });
      });

      if (wokeBySignal) {
        log?.("warn", `${label} interrompue: un autre bot a detecte un creneau sur ${wakeOnAppointmentDomain}.`);
      }
      return;
    }

    await sleep(delayMs);
  }
};

export const waitForScanTurn = async ({ botName, domain, settings, log }: TurnInput): Promise<void> => {
  const label = botName ? `${botName}` : "Bot";
  touchParticipant(domain, botName);

  while (true) {
    const state = getState(domain);
    const now = Date.now();
    if (state.cooldownUntil > now) {
      const waitMs = state.cooldownUntil - now;
      log("warn", `Orchestration: ${domain} en cooldown rate-limit. ${label} attend ${Math.ceil(waitMs / 60_000)} min.`);
      await sleep(Math.min(waitMs, 60_000));
      continue;
    }

    const activeParticipants = participantCount(state);
    const emergencyActive = isEmergencyWindowActive(state);
    const effectiveMaxScans = emergencyActive
      ? Math.max(settings.maxParallelScansPerDomain, Math.min(activeParticipants || 1, 5))
      : settings.maxParallelScansPerDomain;

    if (state.activeScans < effectiveMaxScans) {
      clearCoverageTimer(state);
      state.activeScans += 1;
      const mode = emergencyActive ? "urgence creneau" : "normal";
      log("info", `Orchestration: tour de scan obtenu (${state.activeScans}/${effectiveMaxScans}) pour ${domain} (${mode}).`);
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
  scheduleCoverageWake(domain, log);
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

export const broadcastAppointmentSignal = (
  domain: string,
  botName?: string,
  log?: Logger
): void => {
  const state = getState(domain);
  state.appointmentSignalVersion += 1;
  state.appointmentSignalAt = Date.now();
  const label = botName ? ` par ${botName}` : "";
  log?.("success", `Orchestration: signal creneau detecte${label}. Reveil des autres bots sur ${domain}.`);
  wakeAll(state.waiters);
  wakeAll(state.appointmentSignalWaiters);
};

export const clearAppointmentSignal = (
  domain: string,
  reason: string,
  log?: Logger
): void => {
  const state = getState(domain);
  state.appointmentSignalVersion += 1;
  state.appointmentSignalAt = 0;
  log?.("info", `Orchestration: retour au mode lazy sur ${domain}. Raison: ${reason}`);
  wakeAll(state.waiters);
  wakeAll(state.appointmentSignalWaiters);
  scheduleCoverageWake(domain, log);
};

export const scheduleReservationHoldRecheck = (
  domain: string,
  botName?: string,
  log?: Logger,
  delayMinutes = RESERVATION_HOLD_RECHECK_MINUTES
): void => {
  const state = getState(domain);
  if (state.reservationRecheckTimer) {
    clearTimeout(state.reservationRecheckTimer);
  }

  const delayMs = Math.max(1, delayMinutes) * 60_000;
  const label = botName ? ` apres reservation par ${botName}` : "";
  log?.("info", `Orchestration: recheck global planifie dans ${delayMinutes} min${label}.`);

  state.reservationRecheckTimer = setTimeout(() => {
    state.reservationRecheckTimer = undefined;
    state.appointmentSignalVersion += 1;
    state.appointmentSignalAt = Date.now();
    log?.("warn", `Orchestration: recheck global apres reservation temporaire sur ${domain}. Reveil des bots.`);
    wakeAll(state.waiters);
    wakeAll(state.appointmentSignalWaiters);
  }, delayMs);
};
