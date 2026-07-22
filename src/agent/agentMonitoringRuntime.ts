import { BrowserContext, Page } from "playwright";
import { monitorAppointments } from "../shared/monitor.js";
import { MonitorEventLevel } from "../shared/types.js";
import { findReadyAppointmentPage } from "./agentPageDetector.js";
import { AgentMonitoringSettings, toAppConfig } from "./agentMonitoringSettings.js";
import { SlotAlertDeduplicator } from "./agentSlotDedup.js";
import { AgentEventReporter } from "./agentEventReporter.js";
import { AgentLogFn } from "./agentLocalLogger.js";

// Lot 4 (Phase 4): fait reellement demarrer monitorAppointments() (deja
// partage avec legacy_vm) pour UN bot, avec un AbortController et un
// snapshot de parametres qui lui sont propres (section 3 du cahier des
// charges: aucun timer/etat mutable global partage entre deux bots). Les
// seuls etats partages entre bots restent ceux, deliberement multi-bots,
// d'orchestrator.ts (coordination par domaine TLS, deja existante).

const RATE_LIMIT_STATUS = "RATE_LIMITED";
const MONITORING_STATUS = "MONITORING";
const WAITING_FOR_USER_STATUS = "WAITING_FOR_USER";

// L'agent ne simule et n'automatise jamais de "clic Valider": quand
// monitor.ts demande une intervention humaine (captcha/Cloudflare/etat
// ambigu apres reservation) au-dela de sa fenetre de grace interne, on se
// contente de re-attendre par petites tranches annulables. Cela transforme
// la chaine pauseForHuman -> waitForUser -> (retour en tete de boucle) en un
// polling annulable, sans jamais bloquer indefiniment ni cliquer quoi que ce
// soit a la place de l'utilisateur.
const AGENT_HUMAN_POLL_MS = 15_000;

// Section 10: "pas de boucle infinie de refresh" — au-dela de ce nombre de
// refresh PERIODIQUES (config.refreshEveryCycles) consecutifs en echec, la
// boucle s'arrete elle-meme plutot que de re-attendre indefiniment via
// pauseForHuman. Remis a zero par le moindre refresh reussi.
const MAX_CONSECUTIVE_REFRESH_FAILURES = 3;

export type MonitoringRuntimeStatus = {
  rateLimited: boolean;
  lastSlotDetectedAt: string | null;
};

export type StartMonitoringParams = {
  botId: string;
  botName?: string;
  category?: string;
  page: Page;
  context: BrowserContext;
  settings: AgentMonitoringSettings;
  targetUrl: string;
  // commandId reutilise pour toutes les emissions BOT_STATUS de cette boucle
  // (celui de la commande VALIDATE_BOT qui a declenche le demarrage): valide
  // cote serveur car agentGateway.ts ne verifie que l'appartenance de la
  // commande a l'agent/au bot, jamais son propre statut (cf. audit).
  commandId: string;
  reporter: AgentEventReporter;
  log: AgentLogFn;
  // Verifie apres la fin (naturelle, non annulee) de la boucle si ce bot
  // est encore enregistre: si wireUnexpectedClosure l'a deja retire (vrai
  // Chrome ferme), ce module ne doit rien re-signaler par-dessus.
  isBotStillRegistered: () => boolean;
};

export type MonitoringRuntimeHandle = {
  abortController: AbortController;
  loopPromise: Promise<void>;
  getStatus: () => MonitoringRuntimeStatus;
};

export const startMonitoring = (params: StartMonitoringParams): MonitoringRuntimeHandle => {
  const { botId, botName, category, page, context, settings, targetUrl, commandId, reporter, log, isBotStillRegistered } = params;

  const abortController = new AbortController();
  const signal = abortController.signal;

  let rateLimited = false;
  let rateLimitResumeTimer: NodeJS.Timeout | null = null;
  const slotDedup = new SlotAlertDeduplicator();
  let lastSlotDetectedAtIso: string | null = null;
  let consecutiveRefreshFailures = 0;
  let refreshFailureAbort = false;

  const clearRateLimitTimer = (): void => {
    if (rateLimitResumeTimer) {
      clearTimeout(rateLimitResumeTimer);
      rateLimitResumeTimer = null;
    }
  };
  signal.addEventListener("abort", clearRateLimitTimer, { once: true });

  const agentLog = (level: MonitorEventLevel, message: string): void => {
    log(level, `[Surveillance ${botId}] ${message}`);
  };

  const recoverCurrentPage = async (): Promise<Page | null> => {
    if (signal.aborted) {
      return null;
    }
    // findReadyAppointmentPage (jamais findAppointmentPage ici): la
    // recuperation doit constater un contenu REELLEMENT pret, pas seulement
    // la presence du marqueur fixture (toujours present, quel que soit le
    // scenario en cours) - sinon un probleme encore actif (rate limit, page
    // non prete) serait annonce "recupere" instantanement, en boucle.
    const selection = await findReadyAppointmentPage(context.pages());
    return selection.ok ? selection.page : null;
  };

  const waitForUser = async (): Promise<void> => {
    if (signal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
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
      }, AGENT_HUMAN_POLL_MS);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  const onRateLimited = (cooldownMinutes: number): void => {
    rateLimited = true;
    const resumeAt = new Date(Date.now() + cooldownMinutes * 60_000).toISOString();
    reporter.botStatus(botId, commandId, RATE_LIMIT_STATUS, { cooldownMinutes, resumeAt });
    agentLog("warn", `Rate limit detecte, cooldown ${cooldownMinutes} min (reprise estimee ${resumeAt}).`);

    clearRateLimitTimer();
    rateLimitResumeTimer = setTimeout(() => {
      rateLimitResumeTimer = null;
      if (signal.aborted) {
        return;
      }
      rateLimited = false;
      reporter.botStatus(botId, commandId, MONITORING_STATUS);
      agentLog("success", "Cooldown rate limit ecoule, surveillance reprise.");
    }, cooldownMinutes * 60_000);
  };

  const onSlotDetected = (info: { textFound?: string; dateTimeHint?: string }): void => {
    const signature = `${info.textFound ?? ""}|${info.dateTimeHint ?? ""}`;
    const now = Date.now();
    if (!slotDedup.shouldAlert(signature, now)) {
      agentLog("info", "Creneau deja signale recemment (meme signature): alerte non repetee.");
      return;
    }
    lastSlotDetectedAtIso = new Date(now).toISOString();

    reporter.botStatus(botId, commandId, "SLOT_DETECTED", {
      available: true,
      textFound: info.textFound ?? null,
      dateTimeHint: info.dateTimeHint ?? null,
      detectedAt: lastSlotDetectedAtIso
    });
    agentLog("success", "Creneau detecte, alerte envoyee au serveur.");
  };

  const onRefreshSucceeded = (): void => {
    consecutiveRefreshFailures = 0;
  };

  const onRefreshFailed = (): void => {
    consecutiveRefreshFailures += 1;
    if (consecutiveRefreshFailures < MAX_CONSECUTIVE_REFRESH_FAILURES) {
      return;
    }
    refreshFailureAbort = true;
    agentLog("error", `${consecutiveRefreshFailures} echecs de refresh consecutifs: arret de la surveillance (REFRESH_FAILED).`);
    abortController.abort();
  };

  const appConfig = toAppConfig(settings, targetUrl);

  const loopPromise = monitorAppointments(page, appConfig, {
    botName,
    category,
    log: agentLog,
    waitForUser,
    recoverPage: recoverCurrentPage,
    recoverWorkflow: recoverCurrentPage,
    signal,
    onRateLimited,
    onSlotDetected,
    onRefreshFailed,
    onRefreshSucceeded
  })
    .catch((error) => {
      agentLog("error", `Surveillance interrompue par une erreur: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      clearRateLimitTimer();

      if (!isBotStillRegistered()) {
        // Fermeture navigateur reelle: wireUnexpectedClosure a deja tout pris
        // en charge (registre + BOT_STATUS), rien a ajouter ici.
        return;
      }

      if (refreshFailureAbort) {
        reporter.botStatus(botId, commandId, "ERROR", { errorCode: "REFRESH_FAILED" });
        agentLog("error", "Bot en erreur: echecs de refresh repetes (REFRESH_FAILED).");
        return;
      }

      // STOP_BOT a deja pris en charge la communication de fin (STOPPING/
      // STOPPED): rien a ajouter ici.
      if (signal.aborted) {
        return;
      }

      // La boucle s'est arretee d'elle-meme (ex: onglet ferme mais Chrome
      // encore ouvert) sans que STOP_BOT ni une fermeture navigateur ne
      // l'explique: on ne laisse jamais le serveur croire que la
      // surveillance est encore active (section 2/12).
      reporter.botStatus(botId, commandId, WAITING_FOR_USER_STATUS, { reason: "PAGE_CLOSED" });
      agentLog("warn", "Surveillance arretee (page introuvable ou fin de cycle). Revalidez une fois une page de rendez-vous ouverte.");
    });

  return {
    abortController,
    loopPromise,
    getStatus: () => ({ rateLimited, lastSlotDetectedAt: lastSlotDetectedAtIso })
  };
};
