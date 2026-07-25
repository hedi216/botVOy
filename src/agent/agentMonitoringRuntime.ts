import { BrowserContext, Page } from "playwright";
import { clickBookNewAppointment, clickContinueServiceLevel, clickSelectTravelGroup } from "../shared/loginFlow.js";
import { monitorAppointments } from "../shared/monitor.js";
import { MonitorEventLevel } from "../shared/types.js";
import { findReadyAppointmentPage, maskUrlForLog } from "./agentPageDetector.js";
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
const WORKFLOW_RECOVERY_ATTEMPTS_BEFORE_LONG_WAIT = 3;
const WORKFLOW_RECOVERY_FINAL_ATTEMPT = 4;
const WORKFLOW_RECOVERY_RETRY_INTERVAL_MS = 10_000;
const WORKFLOW_RECOVERY_LONG_WAIT_MS = 5 * 60 * 1000;
const WORKFLOW_STEP_SETTLE_MS = 8_000;

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

  const pickWorkflowPage = (): Page | null => {
    const pages = context.pages()
      .filter((candidate) => {
        const url = candidate.url();
        return !candidate.isClosed()
          && !url.startsWith("devtools://")
          && !url.startsWith("chrome://")
          && !url.startsWith("chrome-extension://");
      });
    return [...pages].reverse().find((candidate) => /tlscontact|vfsglobal/i.test(candidate.url()))
      ?? [...pages].reverse().find((candidate) => candidate.url() !== "about:blank")
      ?? pages[0]
      ?? null;
  };

  const isSafeRecoveryUrl = (rawUrl: string): boolean => {
    try {
      const parsed = new URL(rawUrl);
      return parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    } catch {
      return false;
    }
  };

  const waitForReadyAppointment = async (timeoutMs: number): Promise<Page | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !signal.aborted) {
      const ready = await recoverCurrentPage();
      if (ready) {
        return ready;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return recoverCurrentPage();
  };

  const recoverWorkflowOnce = async (attempt: number, reason?: string): Promise<Page | null> => {
    const ready = await recoverCurrentPage();
    if (ready) {
      return ready;
    }

    const page = pickWorkflowPage();
    if (!page || page.isClosed()) {
      return null;
    }

    agentLog("info", `Reprise workflow ${attempt}/${WORKFLOW_RECOVERY_FINAL_ATTEMPT}${reason ? " apres page inattendue" : ""}.`);

    if (isSafeRecoveryUrl(targetUrl)) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 })
        .then(() => agentLog("info", `Retour automatique vers l'URL cible (${maskUrlForLog(targetUrl)}).`))
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          agentLog("warn", `Navigation vers l'URL cible impossible: ${message}`);
        });
      const afterTarget = await waitForReadyAppointment(WORKFLOW_STEP_SETTLE_MS);
      if (afterTarget) {
        return afterTarget;
      }
    }

    await clickSelectTravelGroup(page, agentLog).catch(() => false);
    let recovered = await waitForReadyAppointment(WORKFLOW_STEP_SETTLE_MS);
    if (recovered) {
      return recovered;
    }

    await clickBookNewAppointment(page, agentLog).catch(() => false);
    recovered = await waitForReadyAppointment(WORKFLOW_STEP_SETTLE_MS);
    if (recovered) {
      return recovered;
    }

    await clickContinueServiceLevel(page, agentLog).catch(() => false);
    return waitForReadyAppointment(WORKFLOW_STEP_SETTLE_MS);
  };

  const recoverWorkflowWithRetries = async (reason?: string): Promise<Page | null> => {
    for (let attempt = 1; attempt <= WORKFLOW_RECOVERY_FINAL_ATTEMPT; attempt += 1) {
      if (signal.aborted) {
        return null;
      }

      if (attempt === WORKFLOW_RECOVERY_FINAL_ATTEMPT) {
        agentLog("warn", `${WORKFLOW_RECOVERY_ATTEMPTS_BEFORE_LONG_WAIT} tentatives sans page reconnue. Attente de ${WORKFLOW_RECOVERY_LONG_WAIT_MS / 60_000} minutes avant la tentative finale.`);
        await new Promise((resolve) => setTimeout(resolve, WORKFLOW_RECOVERY_LONG_WAIT_MS));
      }

      const recovered = await recoverWorkflowOnce(attempt, reason);
      if (recovered) {
        return recovered;
      }

      if (attempt < WORKFLOW_RECOVERY_ATTEMPTS_BEFORE_LONG_WAIT) {
        await new Promise((resolve) => setTimeout(resolve, WORKFLOW_RECOVERY_RETRY_INTERVAL_MS));
      }
    }

    agentLog("error", `Reprise workflow impossible apres ${WORKFLOW_RECOVERY_FINAL_ATTEMPT} tentatives. Notification et intervention humaine requises.`);
    return null;
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
    recoverWorkflow: recoverWorkflowWithRetries,
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
