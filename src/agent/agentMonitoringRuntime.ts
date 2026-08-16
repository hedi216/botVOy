import { BrowserContext, Page } from "playwright";
import {
  applicationSummaryPagePattern,
  clickBookNewAppointment,
  clickContinueServiceLevel,
  clickSeConnecter,
  clickSelectTravelGroup,
  fillLoginForm,
  homeCountryPagePattern,
  isAuthPage,
  isServiceLevelPage,
  isTlsLoggedOutLandingPage,
  travelGroupsPagePattern
} from "../shared/loginFlow.js";
import { HUMAN_BLOCK_GRACE_MS, monitorAppointments, waitForConditionToClear } from "../shared/monitor.js";
import { MonitorEventLevel } from "../shared/types.js";
import { findReadyAppointmentPage, isCloudflareBlockedPage, maskUrlForLog } from "./agentPageDetector.js";
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

// CORRECTIF CIBLE (retour vers TARGET_URL apres expiration session TLS):
// delai borne raisonnable pour le SEUL goto() explicitement autorise ici (vers
// targetUrl deja fourni au monitoring, jamais une URL arbitraire issue de la
// page) - aligne sur les autres delais de navigation deja utilises ailleurs
// dans le projet (ex. CLIENT_SIDE_EXCEPTION_RELOAD_TIMEOUT_MS), jamais une
// nouvelle fenetre divergente.
const LOGGED_OUT_LANDING_GOTO_TIMEOUT_MS = 20_000;

// CORRECTIF CIBLE (refresh temporel securise toutes les 20 minutes): cadence
// de refresh de controle de l'agent, basee sur le temps REEL ecoule (jamais
// un nombre de cycles - remplace refreshEveryCycles comme cadence PRINCIPALE
// de l'agent, cf. toAppConfig/monitor.ts). refreshEveryCycles reste dans
// AgentMonitoringSettings uniquement pour retrocompatibilite (legacy_vm/UI
// agence), mais n'est plus consulte comme declencheur ici.
//
// HOTFIX CIBLE (parametres de surveillance en secondes entieres): cette
// constante n'est plus la source PRINCIPALE en production - elle ne reste
// qu'un FALLBACK de compatibilite si settings.controlRefreshIntervalSeconds
// est absent d'un ancien payload (cf. resolution ci-dessous). La valeur par
// defaut du champ configurable (1200s, agentMonitoringSettings.ts) est
// deliberement identique, donc aucun changement de comportement par defaut.
const AGENT_CONTROL_REFRESH_INTERVAL_MS = 20 * 60 * 1000;

// CORRECTIF CIBLE (login/captcha bloque trop longtemps apres recovery):
// strategie bornee et claire, jamais une seule attente de 15 min (ancien
// comportement de waitForRecaptchaResolution, src/shared/loginFlow.ts).
// Premiere fenetre d'attente humaine sur la page login/auth rencontree
// pendant le recovery - au-dela, UNE SEULE tentative de recuperation simple
// (reload de la meme page, jamais un goto arbitraire) avant une seconde
// fenetre identique. Aucun contournement/solver CAPTCHA: seule la duree de
// l'attente automatique change, jamais la resolution elle-meme (toujours
// humaine, cf. waitForRecaptchaResolution).
const LOGIN_CAPTCHA_FIRST_WAIT_MS = 3 * 60 * 1000;
const LOGIN_CAPTCHA_SECOND_WAIT_MS = 3 * 60 * 1000;

export type MonitoringRuntimeStatus = {
  rateLimited: boolean;
  lastSlotDetectedAt: string | null;
};

// HOTFIX 0.2.3 (section 5): permet au recovery workflow de refaire
// fillLoginForm() si la session TLS expire pendant la surveillance (defaut
// reel confirme: le recovery ne savait jusqu'ici jamais se reconnecter).
// Contrat de securite strict, respecte partout ou ce type circule:
// - JAMAIS ecrit sur disque, dans le mapping account/profile, en base, ni
//   dans un BOT_STATUS/log/erreur ;
// - JAMAIS assigne sur AgentBotHandle (deja documente comme ne devant jamais
//   porter de credential, cf. types.ts) ;
// - vit UNIQUEMENT dans la fermeture (closure) de startMonitoring() ci-dessous,
//   pour la duree de vie de CETTE boucle de surveillance, et est explicitement
//   dereferencee (mise a undefined) des la fin de la boucle (STOP_BOT ou fin
//   naturelle) - jamais conservee au-dela.
export type RuntimeCredentials = {
  login: string;
  password: string;
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
  // Optionnel, EN MEMOIRE UNIQUEMENT (cf. commentaire sur RuntimeCredentials
  // ci-dessus) - absent pour VALIDATE_BOT (jamais de credentials dans ce
  // flux, comportement inchange) et pour START_BOT sans login/password.
  runtimeCredentials?: RuntimeCredentials;
  // HOTFIX 0.2.3: override test uniquement (cf. AgentRuntimeSettings) -
  // absent en production reelle, retombe alors sur les constantes ci-dessous.
  workflowRecoveryRetryIntervalMs?: number;
  workflowRecoveryLongWaitMs?: number;
  humanValidationGraceMs?: number;
  // CORRECTIF CIBLE (refresh temporel securise toutes les 20 minutes):
  // override TEST UNIQUEMENT (jamais en production reelle, retombe alors sur
  // settings.controlRefreshIntervalSeconds - cf. HOTFIX parametres en
  // secondes - ou sur AGENT_CONTROL_REFRESH_INTERVAL_MS en dernier recours) -
  // jamais d'attente reelle de 20 minutes dans les tests.
  controlRefreshIntervalMs?: number;
  // CORRECTIF CIBLE (login/captcha bloque trop longtemps apres recovery):
  // overrides TEST UNIQUEMENT (jamais en production reelle, retombent alors
  // sur LOGIN_CAPTCHA_FIRST_WAIT_MS/LOGIN_CAPTCHA_SECOND_WAIT_MS ci-dessus) -
  // jamais 2x3 minutes d'attente reelle dans les tests.
  loginCaptchaFirstWaitMs?: number;
  loginCaptchaSecondWaitMs?: number;
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
  let workflowRecoveryFailedEmitted = false;
  // HOTFIX 0.2.3 (correctif Cloudflare/validation humaine): distingue un
  // echec de recovery cause par un blocage humain TOUJOURS present au-dela de
  // la fenetre deja prevue (HUMAN_BLOCK_GRACE_MS, jamais WORKFLOW_RECOVERY_FAILED)
  // d'un echec de recovery REEL (aucun blocage humain, les tentatives
  // automatiques elles-memes ont echoue). Empeche onWorkflowRecoveryFailed
  // d'emettre WORKFLOW_RECOVERY_FAILED par-dessus une notification humaine
  // deja emise pour le meme episode.
  let humanValidationTimeoutEmitted = false;
  // CORRECTIF CIBLE (login/captcha bloque trop longtemps apres recovery):
  // meme principe que humanValidationTimeoutEmitted ci-dessus - la strategie
  // bornee (2x3 min + reload unique) a deja ete integralement consommee
  // quand ce flag passe a true, jamais une notification WORKFLOW_RECOVERY_FAILED
  // par-dessus (deja alertable directement, aucune grace supplementaire due).
  let loginCaptchaStuckEmitted = false;
  // Reference locale UNIQUE a ce credential (cf. RuntimeCredentials
  // ci-dessus) - explicitement videe dans le .finally() de la boucle, jamais
  // conservee au-dela de la duree de vie de cette surveillance.
  let runtimeCredentialsRef = params.runtimeCredentials;
  const resolvedLoginCaptchaFirstWaitMs = params.loginCaptchaFirstWaitMs ?? LOGIN_CAPTCHA_FIRST_WAIT_MS;
  const resolvedLoginCaptchaSecondWaitMs = params.loginCaptchaSecondWaitMs ?? LOGIN_CAPTCHA_SECOND_WAIT_MS;

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

  // HOTFIX 0.2.3 (section 4 - recovery niveau 2, pilote par etat reel):
  // remplace l'ancienne sequence aveugle (goto(targetUrl) INCONDITIONNEL puis
  // select -> book -> continue, rejouee entierement a chaque tentative meme
  // depuis un etat deja avance) par une classification de la page REELLEMENT
  // affichee, puis UNE SEULE action pertinente pour cet etat - exactement le
  // meme principe deja valide par agentBotManager.ts/dispatchOnState (0.1.9+),
  // jamais duplique en logique divergente ici: memes helpers, meme ordre de
  // priorite explicitement demande pour ce contexte de reprise (travel-groups
  // -> application-summary -> service-level -> accueil -> login/auth ->
  // Cloudflare/captcha -> inconnu).
  type RecoveryState = "travel-groups" | "application-summary" | "logged-out-landing" | "service-level" | "home" | "auth" | "cloudflare" | "unknown";

  const classifyRecoveryState = async (recoveryPage: Page): Promise<RecoveryState> => {
    const url = recoveryPage.url();
    if (travelGroupsPagePattern.test(url)) {
      return "travel-groups";
    }
    if (applicationSummaryPagePattern.test(url)) {
      return "application-summary";
    }
    // CORRECTIF CIBLE (retour vers TARGET_URL apres expiration session TLS):
    // detecte AVANT "unknown" (et avant les etats async ci-dessous, pour ne
    // pas leur faire interroger inutilement le DOM d'une page dont on sait
    // deja qu'elle est l'accueil deconnecte) - jamais confondu avec "home"
    // (homeCountryPagePattern exige /country/.../vac/..., strictement plus
    // long qu'un pathname de locale seule).
    if (isTlsLoggedOutLandingPage(url)) {
      return "logged-out-landing";
    }
    if (await isServiceLevelPage(recoveryPage).catch(() => false)) {
      return "service-level";
    }
    if (homeCountryPagePattern.test(url)) {
      return "home";
    }
    if (await isAuthPage(recoveryPage).catch(() => false)) {
      return "auth";
    }
    if (await isCloudflareBlockedPage(recoveryPage).catch(() => false)) {
      return "cloudflare";
    }
    return "unknown";
  };

  // CORRECTIF CIBLE (refresh temporel securise toutes les 20 minutes, CAS D -
  // etat inconnu apres refresh): meme mecanisme QUE le cas "logged-out-landing"
  // ci-dessous, jamais une deuxieme architecture de navigation - le seul
  // goto() autorise cible EXCLUSIVEMENT targetUrl deja fourni au monitoring
  // (jamais une URL arbitraire issue de la page, jamais un clic au hasard sur
  // l'etat inconnu lui-meme). Deja borne par le plafond partage
  // WORKFLOW_RECOVERY_FINAL_ATTEMPT (recoverWorkflowWithRetries ci-dessous):
  // jamais une boucle separee/infinie, meme si l'etat reste "unknown" apres
  // le retour (nouvelle classification tentee a chaque tentative numerotee
  // suivante, jusqu'a epuisement du meme plafond que tous les autres etats).
  // `description` est la phrase COMPLETE decrivant l'etat detecte (jamais un
  // simple nom d'etat interpole) - preserve exactement le libelle deja
  // existant pour "logged-out-landing" (deja verifie par un test anterieur),
  // "unknown" recoit sa propre description distincte.
  // BUG CIBLE 0.2.4 (recovery multi-etapes, section 3): decoupe l'ancien
  // attemptReturnToTargetUrl en une action PURE de navigation (ci-dessous,
  // jamais d'attente propre) et une attente generique de progression/etat
  // pret partagee par tous les etats (waitForProgressOrReady, plus bas) -
  // memes libelles de log EXACTS que la version precedente (deja verifies
  // par des tests anterieurs, jamais renommes). `description` reste la
  // phrase COMPLETE decrivant l'etat detecte (jamais un simple nom d'etat).
  const navigateToRecoveryTargetUrl = async (page: Page, description: string): Promise<boolean> => {
    let validTargetUrl: URL | null = null;
    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        validTargetUrl = parsed;
      }
    } catch {
      validTargetUrl = null;
    }

    if (!validTargetUrl) {
      agentLog("warn", `${description}, mais targetUrl invalide/non http(s): retour impossible.`);
      return false;
    }

    agentLog(
      "info",
      `${description}: retour vers targetUrl (${maskUrlForLog(validTargetUrl.toString())}), meme Chrome/profil/bot/monitoring - jamais un nouveau START_BOT.`
    );
    try {
      await page.goto(validTargetUrl.toString(), { waitUntil: "domcontentloaded", timeout: LOGGED_OUT_LANDING_GOTO_TIMEOUT_MS });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      agentLog("warn", `Retour vers targetUrl impossible (${description}): ${message}`);
      return false;
    }
    return true;
  };

  // BUG CIBLE 0.2.4 (recovery multi-etapes, section 5.A "progression
  // interne"): plafond de TRANSITIONS RECONNUES enchainees dans UNE SEULE
  // tentative externe numerotee - jamais une boucle infinie. Une chaine
  // reelle complete (logged-out-landing -> target -> home -> auth ->
  // travel-groups -> application-summary/service-level -> appointment-
  // booking) tient en 6 transitions au plus: cette marge reste tres
  // largement suffisante sans jamais pouvoir degenerer en boucle sans fin.
  const MAX_INTERNAL_RECOVERY_TRANSITIONS = 10;

  // Une seule action, celle pertinente pour l'etat REELLEMENT classifie -
  // reprend exactement les memes actions/libelles qu'avant (jamais une
  // logique divergente), uniquement decouplees de l'attente qui suit
  // (waitForProgressOrReady, desormais generique et partagee par tous les
  // etats). canContinue=false signifie que cette tentative externe doit
  // s'arreter immediatement (aucun identifiant disponible pour "auth",
  // Cloudflare/captcha detecte) - jamais un cas ou une progression interne
  // supplementaire serait encore possible.
  const performRecoveryStateAction = async (state: RecoveryState, page: Page): Promise<{ canContinue: boolean }> => {
    switch (state) {
      case "travel-groups":
        await clickSelectTravelGroup(page, agentLog).catch(() => false);
        return { canContinue: true };

      case "application-summary":
        await clickBookNewAppointment(page, agentLog).catch(() => false);
        return { canContinue: true };

      case "logged-out-landing":
        return { canContinue: await navigateToRecoveryTargetUrl(page, "Accueil TLS deconnecte (logged-out-landing) detecte pendant la reprise") };

      case "service-level":
        await clickContinueServiceLevel(page, agentLog).catch(() => false);
        return { canContinue: true };

      case "home":
        await clickSeConnecter(page, agentLog).catch(() => false);
        return { canContinue: true };

      case "auth": {
        if (!runtimeCredentialsRef) {
          agentLog("warn", "Page de connexion detectee pendant la reprise, mais aucun identifiant en memoire pour cette session: reconnexion automatique impossible.");
          return { canContinue: false };
        }
        // CORRECTIF CIBLE (login/captcha bloque trop longtemps apres
        // recovery): fillLoginForm() n'attend plus qu'une seule fenetre
        // bornee (jusqu'a resolvedLoginCaptchaFirstWaitMs, jamais 15 min) et
        // ne soumet JAMAIS le formulaire si le captcha reste non resolu -
        // reutilise tel quel (aucune nouvelle logique de detection captcha),
        // uniquement orchestre ici pour la strategie en 2 fenetres + 1 reload
        // (CAPTCHA reste 100% manuel, section 6 du hotfix inchangee).
        agentLog("info", "Page de connexion detectee pendant la reprise: nouvelle tentative de connexion automatique (identifiants en memoire, jamais journalises).");
        const firstAttempt = await fillLoginForm(page, runtimeCredentialsRef.login, runtimeCredentialsRef.password, agentLog, {
          signal,
          maxCaptchaWaitMs: resolvedLoginCaptchaFirstWaitMs
        }).catch(() => ({ submitted: false, captchaOutcome: "not-reached" as const }));

        if (firstAttempt.captchaOutcome === "aborted") {
          return { canContinue: false };
        }
        if (firstAttempt.captchaOutcome !== "timed-out") {
          // Soumis, page deja changee pendant l'attente, ou echec non lie au
          // captcha (champ introuvable...): comportement normal existant,
          // la reclassification standard (waitForProgressOrReady) prend
          // le relais - jamais de reload ici.
          return { canContinue: true };
        }

        // Premiere fenetre (jusqu'a resolvedLoginCaptchaFirstWaitMs) epuisee,
        // captcha toujours bloquant - UNE SEULE tentative de recuperation
        // simple: reload de la MEME page login/auth (jamais un goto vers une
        // URL arbitraire, jamais une boucle de reload).
        agentLog(
          "warn",
          `Captcha toujours present apres ${Math.round(resolvedLoginCaptchaFirstWaitMs / 1000)}s. `
          + "Refresh unique de la page de connexion avant seconde attente."
        );
        if (signal.aborted) {
          return { canContinue: false };
        }
        try {
          await page.reload({ waitUntil: "domcontentloaded", timeout: LOGGED_OUT_LANDING_GOTO_TIMEOUT_MS });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          agentLog("warn", `Reload de la page de connexion en echec technique: ${message}. Reclassification malgre tout.`);
        }

        if (page.isClosed() || signal.aborted) {
          return { canContinue: false };
        }

        const stateAfterReload = await classifyRecoveryState(page);
        if (stateAfterReload !== "auth") {
          // CAS A: le workflow a progresse (ou un autre etat reconnu/inconnu
          // est atteint) - reprend le recovery normal existant via la
          // reclassification standard, jamais une logique dupliquee ici.
          agentLog("info", `Apres reload de la page de connexion: nouvel etat detecte = ${stateAfterReload}.`);
          return { canContinue: true };
        }

        // CAS B/C: toujours sur login/auth - le formulaire doit etre rempli
        // a nouveau (page rechargee, champs vides), puis seconde fenetre
        // d'attente du captcha (memes helpers, jamais une soumission tant
        // qu'il reste non resolu).
        const secondAttempt = await fillLoginForm(page, runtimeCredentialsRef.login, runtimeCredentialsRef.password, agentLog, {
          signal,
          maxCaptchaWaitMs: resolvedLoginCaptchaSecondWaitMs
        }).catch(() => ({ submitted: false, captchaOutcome: "not-reached" as const }));

        if (secondAttempt.captchaOutcome === "aborted") {
          return { canContinue: false };
        }
        if (secondAttempt.captchaOutcome !== "timed-out") {
          return { canContinue: true };
        }

        // Deux fenetres de 3 min + un reload deja consommes: le captcha
        // reste reellement bloquant - etat FINAL pour cet episode, jamais un
        // troisieme essai automatique (Chrome reste ouvert, intervention
        // humaine requise). Emis directement ici (meme pattern que
        // waitOutHumanValidationBeforeAttempt/HUMAN_VALIDATION_TIMEOUT
        // ci-dessous): l'attente a deja ete integralement consommee, jamais
        // une grace supplementaire avant cette notification.
        agentLog(
          "error",
          `Captcha toujours present apres la seconde attente de ${Math.round(resolvedLoginCaptchaSecondWaitMs / 1000)}s. `
          + "Intervention utilisateur requise (LOGIN_CAPTCHA_STUCK)."
        );
        loginCaptchaStuckEmitted = true;
        reporter.botStatus(botId, commandId, WAITING_FOR_USER_STATUS, { reason: "LOGIN_CAPTCHA_STUCK" });
        return { canContinue: false };
      }

      case "cloudflare":
        // Section 6/8/10: ne jamais contourner Cloudflare/un captcha - aucune
        // action automatique ici, aucune tentative numerotee consommee pour
        // ce seul constat au niveau interne. La reprise se fait naturellement
        // a la PROCHAINE tentative externe (waitOutHumanValidationBeforeAttempt
        // ci-dessous, inchange) si le blocage a disparu.
        agentLog("warn", "Blocage Cloudflare/validation humaine detecte pendant la reprise: aucune action automatique, attente d'une resolution (humaine ou naturelle).");
        return { canContinue: false };

      case "unknown":
      default:
        // Section 4.H/8 (correctif precedent): interdit tout CLIC au hasard
        // sur un etat non reconnu - toujours vrai ici (aucun clic tente sur
        // la page inconnue elle-meme). Mais une navigation vers targetUrl,
        // DEJA connu/fourni au monitoring, n'est pas un clic au hasard.
        agentLog("warn", `Etat de page non reconnu pendant la reprise (${maskUrlForLog(page.url())}): tentative bornee de retour vers targetUrl.`);
        return { canContinue: await navigateToRecoveryTargetUrl(page, "Etat de page non reconnu (unknown) detecte pendant la reprise") };
    }
  };

  // BUG CIBLE 0.2.4 (recovery multi-etapes, section 6): remplace l'ancienne
  // attente qui ne verifiait QUE la destination finale
  // (waitForReadyAppointment: "max 8s" mais en pratique "toujours 8s si pas
  // pret") par un sondage rapide qui detecte AUSSI une progression vers un
  // etat reconnu DIFFERENT, pas seulement l'arrivee finale sur
  // appointment-booking - "max WORKFLOW_STEP_SETTLE_MS" ne signifie jamais
  // "toujours dormir WORKFLOW_STEP_SETTLE_MS". Une transition vers
  // "cloudflare" est une progression comme une autre au sens de cette
  // fonction (etat reconnu different): c'est performRecoveryStateAction
  // ci-dessus qui l'arrete ensuite immediatement (canContinue=false), sans
  // jamais consommer de tentative supplementaire ni rien contourner.
  const RECOVERY_STEP_POLL_INTERVAL_MS = 500;

  const waitForProgressOrReady = async (
    page: Page,
    previousState: RecoveryState,
    timeoutMs: number
  ): Promise<{ kind: "ready"; page: Page } | { kind: "progressed"; state: RecoveryState } | { kind: "no-change" }> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal.aborted || page.isClosed()) {
        return { kind: "no-change" };
      }

      const ready = await recoverCurrentPage();
      if (ready) {
        return { kind: "ready", page: ready };
      }

      const currentState = await classifyRecoveryState(page);
      if (currentState !== previousState && currentState !== "unknown") {
        return { kind: "progressed", state: currentState };
      }

      await new Promise((resolve) => setTimeout(resolve, RECOVERY_STEP_POLL_INTERVAL_MS));
    }
    return { kind: "no-change" };
  };

  // BUG CIBLE 0.2.4 (recovery multi-etapes, section 3/5): UNE tentative
  // externe numerotee enchaine desormais toutes les transitions reconnues
  // qu'elle rencontre (section 5.A - jamais de retry/attente externe pour
  // une simple progression de workflow), et ne retourne null (= echec REEL
  // de cette tentative, consomme un retry externe existant, inchange) QUE
  // si aucune progression n'a ete observee: action technique en echec, page
  // fermee, etat inchange, "unknown" qui reste "unknown", Cloudflare/captcha
  // detecte, ou limite de transitions internes atteinte sans jamais
  // atteindre la page de rendez-vous (jamais une boucle infinie).
  const recoverWorkflowOnce = async (attempt: number, reason?: string): Promise<Page | null> => {
    const readyAtStart = await recoverCurrentPage();
    if (readyAtStart) {
      return readyAtStart;
    }

    const initialPage = pickWorkflowPage();
    if (!initialPage || initialPage.isClosed()) {
      return null;
    }

    const page = initialPage;
    let state = await classifyRecoveryState(page);

    for (let step = 1; step <= MAX_INTERNAL_RECOVERY_TRANSITIONS; step += 1) {
      agentLog(
        "info",
        `Reprise workflow ${attempt}/${WORKFLOW_RECOVERY_FINAL_ATTEMPT}${reason ? " apres page inattendue" : ""} `
        + `(transition interne ${step}/${MAX_INTERNAL_RECOVERY_TRANSITIONS}): etat detecte = ${state} (${maskUrlForLog(page.url())}).`
      );

      const actionOutcome = await performRecoveryStateAction(state, page);
      if (!actionOutcome.canContinue) {
        return null;
      }

      const stepOutcome = await waitForProgressOrReady(page, state, WORKFLOW_STEP_SETTLE_MS);
      if (stepOutcome.kind === "ready") {
        return stepOutcome.page;
      }
      if (stepOutcome.kind === "progressed") {
        if (stepOutcome.state !== "cloudflare") {
          agentLog("success", `Recovery progression: ${state} -> ${stepOutcome.state}.`);
        }
        state = stepOutcome.state;
        continue;
      }

      agentLog("warn", `Recovery sans progression: etat toujours ${state}.`);
      return null;
    }

    agentLog("warn", `Limite de ${MAX_INTERNAL_RECOVERY_TRANSITIONS} transitions internes atteinte sans atteindre la page de rendez-vous pendant cette tentative.`);
    return null;
  };

  const resolvedRetryIntervalMs = params.workflowRecoveryRetryIntervalMs ?? WORKFLOW_RECOVERY_RETRY_INTERVAL_MS;
  const resolvedLongWaitMs = params.workflowRecoveryLongWaitMs ?? WORKFLOW_RECOVERY_LONG_WAIT_MS;
  const resolvedHumanValidationGraceMs = params.humanValidationGraceMs ?? HUMAN_BLOCK_GRACE_MS;

  // HOTFIX 0.2.3 (correctif Cloudflare/validation humaine, verifie AVANT
  // chaque tentative numerotee - jamais seulement une fois avant la boucle,
  // un challenge peut survenir entre deux tentatives): ne clique/contourne
  // rien, ne fait ni goto agressif ni reload en boucle, se contente
  // d'attendre/sonder la disparition du challenge a l'intervalle DEJA utilise
  // par l'application (waitForConditionToClear/HUMAN_BLOCK_GRACE_MS,
  // monitor.ts - jamais une nouvelle fenetre divergente). Tant que le
  // challenge est present, la tentative en cours n'est JAMAIS comptee
  // (#1/#2/#3/#4 inchanges); des sa disparition, reevaluation immediate de
  // l'etat reel (retour en tete de boucle, toujours sans consommer de
  // tentative). Au-dela de la fenetre humaine: raison distincte
  // (HUMAN_VALIDATION_TIMEOUT), jamais WORKFLOW_RECOVERY_FAILED.
  const waitOutHumanValidationBeforeAttempt = async (): Promise<"clear" | "timed-out" | "aborted"> => {
    const blockedPage = pickWorkflowPage();
    if (!blockedPage || blockedPage.isClosed()) {
      return "clear";
    }
    const isBlocked = await isCloudflareBlockedPage(blockedPage).catch(() => false);
    if (!isBlocked) {
      return "clear";
    }

    agentLog(
      "warn",
      "Blocage Cloudflare/validation humaine detecte pendant le recovery: attente de sa disparition "
      + "(aucun clic, aucun contournement, aucune tentative numerotee consommee)."
    );
    const cleared = await waitForConditionToClear(
      blockedPage,
      () => isCloudflareBlockedPage(blockedPage),
      signal,
      resolvedHumanValidationGraceMs
    );
    if (signal.aborted) {
      return "aborted";
    }
    if (cleared) {
      agentLog("success", "Blocage Cloudflare/validation humaine disparu: reevaluation immediate de l'etat reel.");
      return "clear";
    }
    return "timed-out";
  };

  const recoverWorkflowWithRetries = async (reason?: string): Promise<Page | null> => {
    let attempt = 1;
    while (attempt <= WORKFLOW_RECOVERY_FINAL_ATTEMPT) {
      if (signal.aborted) {
        return null;
      }

      const humanValidationOutcome = await waitOutHumanValidationBeforeAttempt();
      if (humanValidationOutcome === "aborted") {
        return null;
      }
      if (humanValidationOutcome === "timed-out") {
        humanValidationTimeoutEmitted = true;
        reporter.botStatus(botId, commandId, WAITING_FOR_USER_STATUS, { reason: "HUMAN_VALIDATION_TIMEOUT" });
        agentLog(
          "error",
          `Blocage Cloudflare/validation humaine toujours present au-dela de la fenetre prevue `
          + `(${Math.round(resolvedHumanValidationGraceMs / 1_000)}s): intervention humaine requise (HUMAN_VALIDATION_TIMEOUT). Chrome reste ouvert.`
        );
        return null;
      }
      // "clear": aucun blocage (ou vient de disparaitre) - reevalue l'etat
      // reel MAINTENANT, sans jamais consommer une tentative pour ce constat.
      const alreadyReady = await recoverCurrentPage();
      if (alreadyReady) {
        return alreadyReady;
      }

      if (attempt === WORKFLOW_RECOVERY_FINAL_ATTEMPT) {
        agentLog("warn", `${WORKFLOW_RECOVERY_ATTEMPTS_BEFORE_LONG_WAIT} tentatives sans page reconnue. Attente de ${Math.round(resolvedLongWaitMs / 60_000)} minutes avant la tentative finale.`);
        await new Promise((resolve) => setTimeout(resolve, resolvedLongWaitMs));
      }

      const recovered = await recoverWorkflowOnce(attempt, reason);
      if (recovered) {
        return recovered;
      }
      if (loginCaptchaStuckEmitted) {
        // CORRECTIF CIBLE (login/captcha bloque trop longtemps apres
        // recovery): la strategie bornee (2x3 min + reload unique) a deja
        // ete integralement consommee et notifiee (WAITING_FOR_USER,
        // LOGIN_CAPTCHA_STUCK) - jamais un nouvel essai numerote qui
        // relancerait la meme attente depuis le debut.
        return null;
      }

      if (attempt < WORKFLOW_RECOVERY_ATTEMPTS_BEFORE_LONG_WAIT) {
        await new Promise((resolve) => setTimeout(resolve, resolvedRetryIntervalMs));
      }
      attempt += 1;
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

  // HOTFIX 0.2.3 (section 9): declenche exactement une fois par episode,
  // quand monitor.ts a deja epuise refresh simple + recovery workflow complet
  // (jamais pour un rate limit, cf. section 8 - ce cas garde son propre
  // cooldown). "reason" volontairement absent du payload BOT_STATUS: jamais
  // d'URL/detail potentiellement sensible transmis au serveur, uniquement ce
  // code stable.
  const onWorkflowRecoveryFailed = (): void => {
    if (humanValidationTimeoutEmitted || loginCaptchaStuckEmitted) {
      // Deja notifie ci-dessus avec une raison specifique
      // (HUMAN_VALIDATION_TIMEOUT ou LOGIN_CAPTCHA_STUCK): WORKFLOW_RECOVERY_FAILED
      // reste reserve aux vraies tentatives automatiques ayant echoue en
      // dehors de ces cas deja notifies - jamais emis par-dessus une
      // notification specifique deja envoyee pour le meme episode.
      return;
    }
    workflowRecoveryFailedEmitted = true;
    reporter.botStatus(botId, commandId, WAITING_FOR_USER_STATUS, { reason: "WORKFLOW_RECOVERY_FAILED" });
    agentLog("error", "Echec final de la reprise automatique du workflow (WORKFLOW_RECOVERY_FAILED): intervention humaine requise. Chrome reste ouvert.");
  };

  // HOTFIX CIBLE (parametres de surveillance en secondes entieres): source
  // configurable par agence (settings.controlRefreshIntervalSeconds, cf.
  // agentMonitoringSettings.ts) - AGENT_CONTROL_REFRESH_INTERVAL_MS ne reste
  // qu'un FALLBACK de compatibilite si ce champ manquait totalement d'un
  // ancien payload (validateMonitoringSettings le renseigne pourtant
  // toujours avec un defaut de 1200s = 20min, identique a cette constante).
  const snapshotControlRefreshIntervalMs = typeof settings.controlRefreshIntervalSeconds === "number"
    ? settings.controlRefreshIntervalSeconds * 1000
    : AGENT_CONTROL_REFRESH_INTERVAL_MS;
  const resolvedControlRefreshIntervalMs = params.controlRefreshIntervalMs ?? snapshotControlRefreshIntervalMs;
  const appConfig = toAppConfig(settings, targetUrl, resolvedControlRefreshIntervalMs);

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
    onRefreshSucceeded,
    onWorkflowRecoveryFailed
  })
    .catch((error) => {
      agentLog("error", `Surveillance interrompue par une erreur: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      clearRateLimitTimer();
      // HOTFIX 0.2.3 (section 5): derniere reference vivante au credential en
      // memoire pour cette boucle - videe ici, quelle que soit l'issue
      // (STOP_BOT, fin naturelle, erreur), jamais conservee au-dela.
      runtimeCredentialsRef = undefined;

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

      if (workflowRecoveryFailedEmitted || humanValidationTimeoutEmitted || loginCaptchaStuckEmitted) {
        // Deja notifie explicitement ci-dessus (WORKFLOW_RECOVERY_FAILED,
        // HUMAN_VALIDATION_TIMEOUT ou LOGIN_CAPTCHA_STUCK): ne jamais emettre
        // PAGE_CLOSED par-dessus (section 10 - une seule alerte par episode).
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
