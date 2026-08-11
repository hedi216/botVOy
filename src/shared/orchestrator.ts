import { AppConfig, MonitorEventLevel } from "./types.js";

// Le moteur partage (utilise a la fois par le chemin legacy_vm et par l'agent,
// cf. Phase 4) ne doit jamais dependre de userService.ts (couplage PostgreSQL
// cote serveur uniquement): seul le champ reellement utilise ici est requis,
// via un Pick structurel sur AppConfig. userService.MonitoringSettings (deja
// un Pick d'AppConfig) reste assignable ici sans aucun changement d'appelant.
type ScanTurnSettings = Pick<AppConfig, "maxParallelScansPerDomain">;

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
  settings: ScanTurnSettings;
  log: Logger;
  // Lot 4 (Phase 4): permet a un STOP_BOT d'interrompre immediatement
  // l'attente d'un tour de scan, sans consommer de permis ni perturber les
  // autres attentes du meme domaine (seul CE waiter precis est retire).
  // Optionnel: absent, comportement identique a avant (jamais annulable),
  // donc aucun changement pour le chemin legacy_vm.
  signal?: AbortSignal;
};

const domainStates = new Map<string, DomainState>();
const PARTICIPANT_TTL_MS = 10 * 60 * 1000;
const EMERGENCY_WINDOW_MS = 5 * 60 * 1000;
const COVERAGE_WAKE_MIN_MS = 15_000;
const COVERAGE_WAKE_MAX_MS = 45_000;
const RESERVATION_HOLD_RECHECK_MINUTES = 119;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Meme contrat que sleep(), mais resout immediatement des que le signal
// s'active (STOP_BOT), sans jamais rejeter: l'appelant traite une fin
// anticipee exactement comme un delai ecoule, seul le contexte appelant sait
// s'il doit alors s'arreter (via signal.aborted).
const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (!signal) {
    return sleep(ms);
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

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

// BUG CIBLE 0.2.4 (recovery plus reactif - pause entre cycles interruptible):
// cadence de sondage LEGERE d'interruptCheck ci-dessous - jamais un log a
// cette cadence (uniquement un appel synchrone fourni par l'appelant, jamais
// de navigation/reload/clic/requete reseau ici).
const INTERRUPT_CHECK_INTERVAL_MS = 1_500;

export type WaitRandomDelayResult = { interrupted: boolean };

export const waitRandomDelay = async (
  min: number,
  max: number,
  log?: Logger,
  label = "Attente",
  wakeOnAppointmentDomain?: string,
  botName?: string,
  // Lot 4: annulation cooperative (STOP_BOT). Optionnel, sans effet si
  // absent: comportement inchange pour le chemin legacy_vm existant.
  signal?: AbortSignal,
  // BUG CIBLE 0.2.4 (audit suite): verification LEGERE optionnelle,
  // interrogee toutes les INTERRUPT_CHECK_INTERVAL_MS. Peut etre SYNCHRONE
  // (ex. lecture de page.url()) OU retourner une Promise<boolean> - un
  // appelant qui a besoin d'une inspection DOM locale (ex. detecter un
  // CAPTCHA/Cloudflare affiche SANS changement d'URL) peut donc fournir une
  // fonction async, sans jamais dupliquer cette logique de detection ici:
  // ce watcher reste generique (il attend juste le booleen resolu), jamais
  // de navigation/reload/clic/requete TLS supplementaire de son propre chef.
  // Absent par defaut: comportement 100% inchange pour tous les autres
  // appelants (delai entre changements de mois, etc.) - seul l'appel dedie
  // au cooldown entre cycles de monitor.ts fournit cette fonction.
  interruptCheck?: () => boolean | Promise<boolean>
): Promise<WaitRandomDelayResult> => {
  if (signal?.aborted) {
    return { interrupted: false };
  }

  const delayMs = randomBetween(min, max);
  if (delayMs > 0) {
    log?.("info", `${label}: ${delayMs}ms.`);

    if (wakeOnAppointmentDomain) {
      touchParticipant(wakeOnAppointmentDomain, botName);
      const signalVersion = getState(wakeOnAppointmentDomain).appointmentSignalVersion;
      const state = getState(wakeOnAppointmentDomain);

      const wakeReason = await new Promise<"timeout" | "coverage" | "abort" | "appointment-signal" | "interrupt-check">((resolve) => {
        let settled = false;
        let interruptTimer: NodeJS.Timeout | undefined;
        const cleanup = () => {
          clearTimeout(timer);
          if (interruptTimer) {
            clearInterval(interruptTimer);
          }
          if (botName) {
            state.coverageSleepers.delete(botName);
          }
          signal?.removeEventListener("abort", onAbort);
        };

        const finish = (value: "timeout" | "coverage" | "abort" | "appointment-signal" | "interrupt-check") => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          resolve(value);
        };

        const wakeCoverage = () => {
          finish("coverage");
        };

        const onAbort = () => {
          finish("abort");
        };

        const timer = setTimeout(() => {
          finish("timeout");
        }, delayMs);

        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true });
        }

        if (botName) {
          state.coverageSleepers.set(botName, wakeCoverage);
          scheduleCoverageWake(wakeOnAppointmentDomain, log);
        }

        void waitForAppointmentSignalOrTimeout(wakeOnAppointmentDomain, signalVersion, delayMs)
          .then((appointmentSignal) => {
            if (appointmentSignal) {
              finish("appointment-signal");
            }
          });

        if (interruptCheck) {
          // "checkInFlight" evite d'empiler des appels si interruptCheck()
          // (potentiellement async - inspection DOM) met plus de temps que
          // INTERRUPT_CHECK_INTERVAL_MS a resoudre: le tick suivant est alors
          // simplement ignore, jamais mis en file - toujours un seul appel a
          // la fois, jamais deux inspections DOM concurrentes sur la meme page.
          let checkInFlight = false;
          interruptTimer = setInterval(() => {
            if (checkInFlight || settled) {
              return;
            }
            checkInFlight = true;
            Promise.resolve(interruptCheck())
              .then((shouldInterrupt) => {
                checkInFlight = false;
                if (shouldInterrupt) {
                  finish("interrupt-check");
                }
              })
              .catch(() => {
                checkInFlight = false;
              });
          }, INTERRUPT_CHECK_INTERVAL_MS);
        }
      });

      if (wakeReason === "appointment-signal") {
        log?.("warn", `${label} interrompue: un autre bot a detecte un creneau sur ${wakeOnAppointmentDomain}.`);
      }
      return { interrupted: wakeReason === "interrupt-check" };
    }

    await abortableSleep(delayMs, signal);
  }

  return { interrupted: false };
};

// IMPORTANT (contrat d'annulation, Lot 4): cette fonction RESOUT
// normalement dans les DEUX cas — permis reellement obtenu, OU `signal`
// active pendant l'attente. Elle ne rejette jamais sur annulation (pour ne
// pas transformer un STOP_BOT en exception a gerer partout). L'appelant DOIT
// donc toujours verifier `signal?.aborted` juste apres avoir attendu cette
// fonction avant de considerer qu'un permis a ete obtenu (monitor.ts le fait
// deja systematiquement) — ne jamais se fier a la simple resolution de la
// promesse.
export const waitForScanTurn = async ({ botName, domain, settings, log, signal }: TurnInput): Promise<void> => {
  const label = botName ? `${botName}` : "Bot";
  touchParticipant(domain, botName);

  while (true) {
    if (signal?.aborted) {
      log("info", `Orchestration: attente de tour de scan annulee pour ${label} sur ${domain}.`);
      return;
    }

    const state = getState(domain);
    const now = Date.now();
    if (state.cooldownUntil > now) {
      const waitMs = state.cooldownUntil - now;
      log("warn", `Orchestration: ${domain} en cooldown rate-limit. ${label} attend ${Math.ceil(waitMs / 60_000)} min.`);
      await abortableSleep(Math.min(waitMs, 60_000), signal);
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
    // Le waiter n'octroie jamais lui-meme de permis: il ne fait que reveiller
    // ce candidat precis pour qu'il reboucle et retente l'acquisition
    // ci-dessus (comportement identique a avant). Seule nouveaute (Lot 4):
    // si `signal` s'active pendant cette attente precise, CE waiter (et lui
    // seul) est retire de state.waiters puis la fonction retourne sans avoir
    // consomme de permis, sans perturber les autres bots en attente sur le
    // meme domaine.
    const acquiredTurn = await new Promise<boolean>((resolve) => {
      let settled = false;

      const waiter = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(true);
      };

      const onAbort = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) {
          state.waiters.splice(index, 1);
        }
        resolve(false);
      };

      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };

      state.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });

    if (!acquiredTurn) {
      log("info", `Orchestration: attente de tour de scan annulee pour ${label} sur ${domain}.`);
      return;
    }
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
