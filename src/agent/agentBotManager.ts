import {
  applicationSummaryPagePattern,
  clickBookNewAppointment,
  clickContinueServiceLevel,
  clickSeConnecter,
  clickSelectTravelGroup,
  fillLoginForm,
  isAuthPage,
  isServiceLevelPage,
  loginPathPattern,
  travelGroupsPagePattern
} from "../shared/loginFlow.js";
import { closeBrowserWithTimeout, killChromeProcess, launchChromeForBot } from "./agentBrowserManager.js";
import { loadExtensionConfig, validateExtensions } from "./agentExtensionConfig.js";
import { getConfigDir } from "./agentStorage.js";
import { findAppointmentPage, isCloudflareBlockedPage, maskUrlForLog } from "./agentPageDetector.js";
import { acquireProfileLockForAccount, ProfileLease } from "./agentProfileManager.js";
import { AgentCommandError, toAgentCommandError } from "./agentErrors.js";
import { AgentEventReporter } from "./agentEventReporter.js";
import { AgentLogFn, createBotLogger } from "./agentLocalLogger.js";
import { validateMonitoringSettings } from "./agentMonitoringSettings.js";
import { RuntimeCredentials, startMonitoring } from "./agentMonitoringRuntime.js";
import { AgentBotHandle, AgentExtensionInstallLink, AgentRuntimeSettings, RuntimeStatusBotSnapshot } from "./types.js";

// Delai maximum laisse a la boucle de surveillance pour repondre a
// l'annulation avant de fermer Chrome de force (section 11 du cahier des
// charges Lot 4): l'arret du navigateur ne doit jamais dependre de la boucle.
const MONITORING_STOP_TIMEOUT_MS = 8_000;

// Hotfix 0.1.1: cadence de reprise automatique du parcours TLS apres
// lancement de Chrome, calquee sur le flux legacy_vm deja valide
// (src/sessionManager.ts: SILENT_RECOVERY_*) - 3 tentatives rapprochees,
// une attente longue, une tentative finale, puis escalade reelle vers
// WAITING_FOR_USER (jamais avant: section 5 du hotfix). Le nombre de
// tentatives reste fixe (comportement metier); les delais entre tentatives
// sont lus depuis AgentRuntimeSettings (this.settings.autoNavRetryIntervalMs/
// autoNavLongWaitMs, configurables uniquement pour les tests automatises).
const AUTO_NAV_ATTEMPTS_BEFORE_LONG_WAIT = 3;
const AUTO_NAV_FINAL_ATTEMPT = 4;

// Delai borne pour la navigation initiale vers l'URL TLS de depart (hotfix
// 0.1.2): une navigation qui echoue (site injoignable) ne doit jamais
// bloquer indefiniment le demarrage - la cascade d'auto-navigation qui suit
// gere de toute facon les echecs de maniere resiliente.
const INITIAL_NAVIGATION_TIMEOUT_MS = 15_000;

// Hotfix 0.1.2 (points 3/5/6 du cahier des charges): validation locale,
// simple et sans E/S - jamais "about:blank", jamais un schema autre que
// http(s) (chrome://, file://, etc.), jamais une chaine qui n'est pas une
// URL. Sert a la fois a decider si le demarrage peut continuer sans
// extension locale et si une navigation initiale reelle doit etre tentee.
const isValidAbsoluteStartUrl = (raw: string | undefined): raw is string => {
  if (!raw) {
    return false;
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

export type StartBotParams = {
  commandId: string;
  botId: string;
  botName?: string;
  category?: string;
  // Hotfix 0.1.1 (section 3 du cahier des charges): transitent UNIQUEMENT en
  // memoire, de la requete socket "start-bot" jusqu'ici (voir
  // DispatchAgentCommandParams.transientPayload cote serveur) - jamais
  // persistes, jamais stockes sur AgentBotHandle (duree de vie limitee a
  // startBot()/runAutoNavigation()), jamais journalises, jamais ecrits sur
  // disque.
  login?: string;
  password?: string;
  // Snapshot brut (non fiable) transmis par le serveur dans
  // START_BOT.publicPayload.monitoringSettings (Lot 4): toujours revalide
  // ici, jamais fait confiance tel quel (section 4).
  rawMonitoringSettings?: unknown;
  // Hotfix 0.1.2 (point 3): URL TLS de depart absolue, non sensible (transmise
  // dans publicPayload, jamais transientPayload) - toujours revalidee ici
  // (isValidAbsoluteStartUrl), jamais fait confiance telle quelle.
  startUrl?: string;
  extensionLinks?: AgentExtensionInstallLink[];
};

export type StopBotParams = {
  commandId: string;
  botId: string;
};

export type ValidateBotParams = {
  commandId: string;
  botId: string;
};

// Registre local des bots actifs (section 5/6): jamais persiste, jamais
// serialise. Perdu au redemarrage de l'agent, comme les sessions legacy_vm
// existantes cote serveur (meme principe deja accepte en Phase 3).
export class AgentBotManager {
  private readonly bots = new Map<string, AgentBotHandle>();
  private readonly leases = new Map<string, ProfileLease>();
  private readonly stopping = new Set<string>();
  // Reserve un botId des la validation initiale, de facon synchrone, avant
  // tout point d'attente (acquirePooledProfileLock/launchChromeForBot sont
  // ensuite asynchrones): sans cela, deux START_BOT quasi simultanes pour le
  // meme botId (redelivraison socket, bug serveur) passeraient tous les deux
  // le controle "this.bots.has(botId)" avant que le premier n'ait eu le
  // temps d'inserer son handle, et lanceraient chacun un vrai Chrome sur le
  // meme profil.
  private readonly starting = new Set<string>();
  // Deduplique VALIDATE_BOT en cours (section 1: "une commande VALIDATE_BOT
  // equivalente est deja en cours" -> VALIDATION_ALREADY_RUNNING), meme
  // principe que this.starting/this.stopping.
  private readonly validating = new Set<string>();
  // BUG CIBLE 0.2.4 (credentials perdus apres VALIDATE_BOT): stockage EN
  // MEMOIRE UNIQUEMENT, jamais sur AgentBotHandle (invariant deja documente,
  // cf. types.ts) ni sur disque/DB/logs/payload public - source UNIQUE que
  // beginMonitoring() interroge desormais lui-meme (jamais un parametre
  // fourni au cas par cas par l'appelant, qui divergeait entre le chemin
  // automatique et VALIDATE_BOT). Detruit explicitement partout ou un bot
  // quitte le registre (stopHandle/wireUnexpectedClosure/closeAllBotHandles) -
  // jamais laisse trainer au-dela de la vie reelle du bot/process.
  private readonly runtimeCredentials = new Map<string, RuntimeCredentials>();
  private shuttingDown = false;

  constructor(
    private readonly settings: AgentRuntimeSettings,
    private readonly log: AgentLogFn,
    private readonly reporter: AgentEventReporter
  ) {}

  activeCount(): number {
    return this.bots.size;
  }

  isActive(botId: string): boolean {
    return this.bots.has(botId);
  }

  // Lot 5 (section 6): snapshot public envoye via AGENT_RUNTIME_STATUS a
  // chaque connexion/reconnexion. Jamais profilePath/debugPort/PID/objets
  // Playwright: uniquement des champs deja publics ailleurs (BOT_STATUS).
  snapshotForRuntimeStatus(): RuntimeStatusBotSnapshot[] {
    return [...this.bots.values()].map((handle) => ({
      botId: handle.botId,
      status: handle.currentStatus,
      startedAt: handle.startedAt,
      lastActivityAt: handle.lastActivityAt,
      monitoringActive: handle.monitoringRuntime !== null,
      browserOpen: !handle.browserProcess.killed && handle.browserProcess.exitCode === null
    }));
  }

  async startBot(params: StartBotParams): Promise<void> {
    const { commandId, botId, botName, category } = params;
    // Jamais assignes a une propriete de classe/handle: portee locale a cet
    // appel et a runAutoNavigation() uniquement (section 3 du hotfix 0.1.1).
    const login = params.login;
    const password = params.password;

    // BUG CIBLE 0.2.4 (nouveaux logs par bot): cree DES LE DEBUT de START_BOT
    // (avant tout controle pouvant echouer, avant meme la validation des
    // parametres de surveillance) - un echec de demarrage, ou un simple
    // avertissement de bornage de parametres, doit lui aussi atterrir dans le
    // fichier dedie a CETTE execution de bot. Le nom de fichier est fige a cet
    // instant (heure locale de reception de START_BOT), jamais recalcule ensuite.
    const startedAt = new Date();
    const botLog = createBotLogger(this.settings, this.log, botName, startedAt).log;
    botLog("info", `START_BOT recu (botId=${botId}${botName ? `, botName=${botName}` : ""}).`);

    const settingsSnapshot = validateMonitoringSettings(params.rawMonitoringSettings, botLog);

    // HOTFIX CIBLE (parametres de surveillance en secondes entieres): UN
    // seul log synthetique par demarrage de bot (jamais un log par cycle),
    // non sensible (aucun login/password/token) - permet de verifier
    // immediatement chez le client que la config reellement chargee (apres
    // validateMonitoringSettings ci-dessus) correspond bien aux parametres
    // configures cote agence.
    botLog(
      "info",
      `Parametres surveillance: mois=${Math.round(settingsSnapshot.monthClickMinDelayMs / 1000)}-${Math.round(settingsSnapshot.monthClickMaxDelayMs / 1000)}s, `
      + `cycles=${Math.round(settingsSnapshot.botCycleCooldownMinMs / 1000)}-${Math.round(settingsSnapshot.botCycleCooldownMaxMs / 1000)}s, `
      + `refresh=${settingsSnapshot.controlRefreshIntervalSeconds}s, rate-limit=${settingsSnapshot.rateLimitCooldownSeconds}s, `
      + `scans-paralleles=${settingsSnapshot.maxParallelScansPerDomain}.`
    );

    if (this.shuttingDown) {
      this.reporter.failed(commandId, "AGENT_SHUTTING_DOWN", "L'agent est en cours d'arret. Relancez RendezBot Agent.");
      return;
    }

    if (this.bots.has(botId) || this.starting.has(botId)) {
      this.reporter.failed(commandId, "BOT_ALREADY_RUNNING", "Ce bot est deja actif sur cet agent.");
      return;
    }

    if (this.bots.size + this.starting.size >= this.settings.maxActiveBots) {
      this.reporter.failed(commandId, "AGENT_CAPACITY_REACHED", `Limite locale atteinte (${this.settings.maxActiveBots} bots actifs).`);
      return;
    }

    // Reservation synchrone immediate (cf. commentaire sur this.starting),
    // puis accuse de reception (section 6).
    this.starting.add(botId);
    this.reporter.ack(commandId);
    this.reporter.botStatus(botId, commandId, "STARTING");

    let lease: ProfileLease | undefined;
    try {
      // Section 13: extensions locales validees AVANT tout lancement de
      // Chrome - une extension "required" absente/invalide doit refuser
      // START_BOT sans jamais ouvrir Chrome, une extension optionnelle
      // manquante ne fait que logger un avertissement local assaini.
      const extensionEntries = loadExtensionConfig(getConfigDir(this.settings), this.log);
      const extensionResults = validateExtensions(extensionEntries, this.log);
      const missingRequired = extensionResults.find((result) => result.required && result.status !== "ok");
      if (missingRequired) {
        const code = missingRequired.status === "not_found" ? "EXTENSION_NOT_FOUND" : "EXTENSION_INVALID";
        throw new AgentCommandError(code, `Extension obligatoire "${missingRequired.id}" ${missingRequired.status === "not_found" ? "introuvable" : "invalide"} (${missingRequired.reason ?? "raison inconnue"}).`);
      }
      const extensionDirs = extensionResults.filter((result) => result.status === "ok").map((result) => result.localPath);
      const hasLocalExtension = extensionDirs.length > 0;

      // Hotfix 0.1.2 (points 3/6 du cahier des charges): sans extension
      // locale, le demarrage automatique DOIT pouvoir naviguer vers une vraie
      // URL TLS - sans cela, la cascade tenterait indefiniment une navigation
      // relative depuis about:blank (defaut trouve en 0.1.1: "Invalid URL").
      // Refuse ici, AVANT tout lancement de Chrome (jamais un navigateur
      // ouvert pour rien), plutot que de boucler silencieusement plusieurs
      // minutes sur une configuration structurellement impossible. Avec une
      // extension locale, celle-ci gere son propre chargement (section 4 du
      // hotfix 0.1.1): l'absence de startUrl n'est alors jamais bloquante.
      const validStartUrl = isValidAbsoluteStartUrl(params.startUrl) ? params.startUrl : undefined;
      if (!hasLocalExtension && !validStartUrl) {
        throw new AgentCommandError(
          "TLS_START_URL_INVALID",
          "Aucune URL TLS de depart valide fournie par le serveur (TARGET_URL absent ou invalide cote serveur) et aucune extension locale configuree: demarrage automatique impossible."
        );
      }

      // Diagnostic Cloudflare (profils): pool local persistant (profile-01,
      // profile-02, ...) plutot qu'un profil jetable par botId - cf.
      // agentProfileManager.ts. Hotfix critique (isolation par compte TLS):
      // affinite stable au compte (params.login) plutot que "premier slot
      // libre" - jamais deux comptes TLS differents sur le meme profil.
      lease = await acquireProfileLockForAccount(this.settings, login, this.log);
      this.leases.set(botId, lease);

      const chrome = await launchChromeForBot(lease.profilePath, this.settings.targetUrl, extensionDirs);

      const handle: AgentBotHandle = {
        botId,
        startCommandId: commandId,
        browserProcess: chrome.browserProcess,
        browser: chrome.browser,
        context: chrome.context,
        page: chrome.page,
        profilePath: lease.profilePath,
        debugPort: chrome.debugPort,
        currentStatus: "STARTING",
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastError: null,
        monitoringPrepared: false,
        settingsSnapshot,
        monitoringRuntime: null,
        botName,
        category,
        // BUG CIBLE 0.2.4 (mauvais target URL): startUrl DEJA VALIDE (jamais
        // about:blank), source unique de verite pour le monitoring/recovery
        // de CE bot - cf. commentaire sur AgentBotHandle.recoveryTargetUrl
        // (types.ts). Absent (undefined) uniquement si aucun startUrl valide
        // n'a ete fourni (flux extension locale): beginMonitoring retombe
        // alors sur this.settings.targetUrl, comportement inchange.
        recoveryTargetUrl: validStartUrl,
        log: botLog
      };
      this.bots.set(botId, handle);
      // BUG CIBLE 0.2.4 (credentials perdus apres VALIDATE_BOT): stocke ICI,
      // une seule fois, des que le bot est reellement enregistre - jamais sur
      // un echec de demarrage (handle jamais cree dans ce cas, rien a
      // associer). Lu ensuite par beginMonitoring() pour CE botId, que le
      // declenchement soit automatique (runAutoNavigation) ou manuel
      // (VALIDATE_BOT) - source UNIQUE, jamais un parametre divergent par appelant.
      if (login && password) {
        this.runtimeCredentials.set(botId, { login, password });
      }
      this.wireUnexpectedClosure(handle);
      await this.openExtensionLinks(handle, params.extensionLinks ?? []);

      // Hotfix 0.1.1 (section 2/4/5): la commande START_BOT est completee des
      // que Chrome est reellement lance - jamais retardee jusqu'a la fin de
      // la cascade d'auto-navigation ci-dessous, qui peut prendre plusieurs
      // minutes (captcha, file d'attente Cloudflare) et depasserait tres
      // largement le TTL de la commande. Le statut reel du bot (WAITING_FOR_
      // USER seulement si une intervention humaine est reellement necessaire,
      // ou MONITORING des que la page de rendez-vous est atteinte) est relaye
      // ensuite via BOT_STATUS, un canal deja independant du cycle de vie de
      // cette commande (meme principe que wireUnexpectedClosure ci-dessous).
      this.reporter.botStatus(botId, commandId, "STARTING");
      this.reporter.completed(commandId, {
        botId,
        status: "STARTING",
        started: true,
        computerName: this.settings.computerName
      });
      botLog("success", `Bot ${botId} demarre (Chrome visible, profil verrouille). Connexion automatique en cours...`);

      void this.runAutoNavigation(handle, hasLocalExtension, login, password, validStartUrl).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        handle.log("error", `Bot ${botId}: demarrage automatique interrompu de maniere inattendue (${message}).`);
      });
    } catch (error) {
      lease?.release();
      this.leases.delete(botId);
      const commandError = toAgentCommandError(error, "BROWSER_LAUNCH_FAILED");
      botLog("error", `Demarrage du bot ${botId} echoue (${commandError.code}): ${commandError.message}`);
      this.reporter.botStatus(botId, commandId, "ERROR");
      this.reporter.failed(commandId, commandError.code, this.publicMessageFor(commandError));
    } finally {
      this.starting.delete(botId);
    }
  }

  async stopBot(params: StopBotParams): Promise<void> {
    const { commandId, botId } = params;
    const handle = this.bots.get(botId);

    // COMMAND_ACK doit toujours preceder COMMAND_COMPLETED (machine a etats
    // Phase 3: markCompleted() exige status='acknowledged' cote serveur).
    // Sans cet accuse, le COMPLETED envoye plus bas serait silencieusement
    // ignore (0 ligne mise a jour) et la commande finirait par expirer en
    // AGENT_ACK_TIMEOUT malgre un arret reellement reussi cote agent.
    this.reporter.ack(commandId);

    if (!handle) {
      // Idempotent par choix documente (section 8): un STOP_BOT pour un bot
      // deja arrete (ou jamais connu de cette instance d'agent, ex. apres
      // redemarrage) ne doit jamais faire echouer l'utilisateur qui clique
      // "Arreter" une seconde fois. On complete directement, sans erreur.
      //
      // CORRECTIF CIBLE (convergence STOP_BOT / bots fantomes): ce chemin ne
      // completait JUSQU'ICI que la COMMANDE (COMMAND_COMPLETED), sans jamais
      // emettre le BOT_STATUS STOPPED correspondant - contrairement au chemin
      // normal ci-dessous (stopHandle) qui emet toujours les deux. Cote
      // serveur, AgentBotRecord.botStatus/active ne convergeaient donc jamais
      // vers STOPPED/false pour ce cas precis (bouton "Arreter" restant
      // affiche, bot reste compte comme actif). Meme ordre que stopHandle
      // (botStatus AVANT completed): un STOP_BOT sur un bot deja absent doit
      // converger EXACTEMENT comme un STOP_BOT reussi.
      this.log("warn", `STOP_BOT recu pour un botId inconnu de cet agent: ${botId} (traite comme deja arrete).`);
      this.reporter.botStatus(botId, commandId, "STOPPED", { alreadyStopped: true });
      this.reporter.completed(commandId, { botId, status: "STOPPED", stopped: true, alreadyStopped: true });
      return;
    }

    await this.stopHandle(handle, commandId);
  }

  private async stopHandle(handle: AgentBotHandle, commandId: string): Promise<void> {
    const { botId } = handle;
    this.stopping.add(botId);
    this.reporter.botStatus(botId, commandId, "STOPPING");

    try {
      handle.browser.removeAllListeners("disconnected");
      handle.browserProcess.removeAllListeners("exit");

      // Section 11: annulation immediate de la boucle de surveillance
      // (sleeps/tour de scan/attente humaine deja abortables, cf. Lot 4),
      // avec un delai maximum avant de fermer Chrome de force quoi qu'il
      // arrive: l'arret du navigateur ne doit jamais dependre de la boucle.
      if (handle.monitoringRuntime) {
        handle.monitoringRuntime.abortController.abort();
        await Promise.race([
          handle.monitoringRuntime.loopPromise,
          new Promise<void>((resolve) => setTimeout(resolve, MONITORING_STOP_TIMEOUT_MS))
        ]);
        handle.monitoringRuntime = null;
      }

      await closeBrowserWithTimeout(handle.browser);
      await killChromeProcess(handle.browserProcess);
    } finally {
      this.leases.get(botId)?.release();
      this.leases.delete(botId);
      this.bots.delete(botId);
      this.stopping.delete(botId);
      // BUG CIBLE 0.2.4: bot arrete -> credentials en memoire detruits (jamais
      // conserves au-dela de la vie reelle du bot).
      this.runtimeCredentials.delete(botId);
    }

    this.reporter.botStatus(botId, commandId, "STOPPED");
    this.reporter.completed(commandId, { botId, status: "STOPPED", stopped: true });
    handle.log("success", `Bot ${botId} arrete, Chrome ferme, profil libere.`);
  }

  // VALIDATE_BOT (Lot 3): verifie que la page ouverte par l'utilisateur est
  // bien reconnue, sans jamais automatiser la connexion/un captcha/Cloudflare
  // (section 4). Une tentative echouee ne ferme JAMAIS Chrome et ne retire
  // JAMAIS le bot du registre (section 2): seul BOT_STATUS revient a
  // WAITING_FOR_USER, le navigateur et le verrou de profil restent intacts.
  async validateBot(params: ValidateBotParams): Promise<void> {
    const { commandId, botId } = params;
    const handle = this.bots.get(botId);

    if (!handle) {
      this.reporter.failed(commandId, "BOT_NOT_RUNNING", "Ce bot n'est plus actif sur cet agent.");
      return;
    }

    if (this.validating.has(botId)) {
      this.reporter.failed(commandId, "VALIDATION_ALREADY_RUNNING", "Une verification de page est deja en cours pour ce bot.");
      return;
    }

    // Verifications d'infrastructure AVANT tout accuse (section 2, etapes
    // 3/4): un bot dont le navigateur a deja disparu ne doit jamais recevoir
    // d'ACK pour une commande qu'il ne peut pas honorer. Le nettoyage du
    // registre/verrou pour une fermeture reelle est deja assure par
    // wireUnexpectedClosure (listeners poses au demarrage): ces verifications
    // ne sont qu'un filet pour la fenetre etroite ou l'evenement n'a pas
    // encore ete traite par la boucle d'evenements.
    if (handle.browserProcess.killed || handle.browserProcess.exitCode !== null) {
      this.reporter.failed(commandId, "BROWSER_CLOSED", "Le navigateur de ce bot a ete ferme.");
      return;
    }
    if (!handle.browser.isConnected()) {
      this.reporter.failed(commandId, "BROWSER_CONNECTION_LOST", "La connexion au navigateur de ce bot a ete perdue.");
      return;
    }

    this.validating.add(botId);
    this.reporter.ack(commandId);

    try {
      const pages = handle.context.pages();
      const selection = await findAppointmentPage(pages, this.settings.targetMode);

      if (!selection.ok) {
        handle.log("warn", `VALIDATE_BOT ${botId}: ${selection.reason}`);
        this.reporter.botStatus(botId, commandId, "WAITING_FOR_USER");
        this.reporter.failed(
          commandId,
          "PAGE_NOT_READY",
          "La page de rendez-vous n'est pas prete. Verifiez la page ouverte dans Chrome, puis validez a nouveau."
        );
        return;
      }

      handle.page = selection.page;
      await this.closeExtraPages(selection.page);

      // Section 2 du cahier des charges Lot 4: AbortController + snapshot
      // deja valides (a l'ouverture du bot) -> demarrage reel de la boucle
      // -> BOT_STATUS MONITORING -> COMMAND_COMPLETED, dans cet ordre.
      this.beginMonitoring(handle, commandId);

      this.reporter.completed(commandId, { botId, status: "MONITORING", validated: true });
      handle.log("success", `Bot ${botId} valide: page reconnue (${maskUrlForLog(selection.page.url())}), surveillance demarree.`);
    } catch (error) {
      const commandError = toAgentCommandError(error, "PAGE_NOT_READY");
      handle.log("error", `VALIDATE_BOT ${botId} echoue (${commandError.code}): ${commandError.message}`);
      this.reporter.botStatus(botId, commandId, "WAITING_FOR_USER");
      this.reporter.failed(commandId, commandError.code, this.publicMessageFor(commandError));
    } finally {
      this.validating.delete(botId);
    }
  }

  // Demarre reellement la boucle de surveillance pour un bot dont la page de
  // rendez-vous vient d'etre reconnue - factorise entre VALIDATE_BOT (Lot 3,
  // declenchement manuel) et runAutoNavigation ci-dessous (hotfix 0.1.1,
  // declenchement automatique des que le parcours aboutit seul). Ne complete
  // JAMAIS de commande elle-meme: chaque appelant garde la responsabilite de
  // son propre COMMAND_COMPLETED (ou aucun, si aucune commande n'est en
  // attente a ce moment-la).
  // BUG CIBLE 0.2.4 (mauvais target URL + credentials perdus apres
  // VALIDATE_BOT): factorise desormais DEUX resolutions qui divergaient entre
  // le chemin automatique et VALIDATE_BOT -
  //   - targetUrl: handle.recoveryTargetUrl (startUrl DEJA VALIDE recu par
  //     START_BOT) en priorite, jamais this.settings.targetUrl
  //     (AGENT_TARGET_URL local, "about:blank" par defaut en installation
  //     packaged) tant que ce champ est renseigne ;
  //   - runtimeCredentials: relu depuis this.runtimeCredentials (memes
  //     credentials que ceux stockes par startBot(), EN MEMOIRE UNIQUEMENT),
  //     jamais un parametre fourni au cas par cas par l'appelant - VALIDATE_BOT
  //     beneficie donc desormais des memes identifiants que le chemin automatique.
  // Ni l'un ni l'autre n'est jamais assigne sur `handle` lui-meme au-dela de
  // recoveryTargetUrl (deja documente comme non sensible, cf. types.ts): les
  // credentials restent exclusivement dans this.runtimeCredentials/la
  // fermeture de startMonitoring (cf. RuntimeCredentials, agentMonitoringRuntime.ts).
  private beginMonitoring(handle: AgentBotHandle, commandId: string): void {
    const { botId } = handle;
    handle.monitoringPrepared = true;
    handle.currentStatus = "MONITORING";
    handle.lastActivityAt = new Date().toISOString();

    handle.monitoringRuntime = startMonitoring({
      botId,
      botName: handle.botName,
      category: handle.category,
      page: handle.page,
      context: handle.context,
      settings: handle.settingsSnapshot,
      targetUrl: handle.recoveryTargetUrl ?? this.settings.targetUrl,
      commandId,
      reporter: this.reporter,
      log: handle.log,
      isBotStillRegistered: () => this.bots.has(botId),
      runtimeCredentials: this.runtimeCredentials.get(botId),
      workflowRecoveryRetryIntervalMs: this.settings.workflowRecoveryRetryIntervalMs,
      workflowRecoveryLongWaitMs: this.settings.workflowRecoveryLongWaitMs,
      humanValidationGraceMs: this.settings.humanValidationGraceMs
    });

    this.reporter.botStatus(botId, commandId, "MONITORING");
  }

  // Hotfix 0.1.1 (defaut confirme: START_BOT ouvrait Chrome puis passait
  // immediatement a WAITING_FOR_USER sans jamais tenter la connexion/le
  // parcours automatique). Reprend la logique deja eprouvee de
  // src/sessionManager.ts (legacy_vm: attemptAutoLogin/waitForAppointmentPage/
  // retryNavigationSilently), adaptee a l'agent :
  // - jamais de blocage initial demandant a l'utilisateur d'ouvrir TLS
  //   manuellement (section 5 du hotfix) ;
  // - avec extension locale configuree : ne touche jamais au formulaire de
  //   connexion (l'extension gere son propre parcours), se contente
  //   d'attendre que la page de rendez-vous apparaisse ;
  // - sans extension : rejoue le meme enchainement que l'ancien flux
  //   (clickSeConnecter -> fillLoginForm -> clickSelectTravelGroup ->
  //   clickBookNewAppointment), chaque fonction etant deja concue pour ne
  //   rien faire silencieusement si l'etape ne s'applique pas (section 4) ;
  // - WAITING_FOR_USER n'est envoye QUE si la page de rendez-vous reste
  //   introuvable apres toutes les tentatives (captcha/controle humain/etape
  //   non automatisable), jamais avant (section 5).
  // login/password ne sont jamais stockes au-dela de la portee de cette
  // methode (section 3): jamais assignes a `handle`, jamais journalises.
  private async runAutoNavigation(
    handle: AgentBotHandle,
    hasLocalExtension: boolean,
    login: string | undefined,
    password: string | undefined,
    startUrl: string | undefined
  ): Promise<void> {
    const { botId } = handle;
    const stillRunning = (): boolean => this.bots.has(botId) && !this.stopping.has(botId);
    const navLog = (level: Parameters<AgentLogFn>[0], message: string): void =>
      handle.log(level, `[Connexion auto ${botId}] ${message}`);

    // Hotfix 0.1.2 (point 4 du cahier des charges): quitte reellement
    // about:blank AVANT toute tentative de connexion automatique - jamais de
    // navigation relative (new URL("/fr-fr/login", page.url())) tant que
    // page.url() vaut encore about:blank (defaut trouve en 0.1.1). Un echec
    // ici (site injoignable) n'interrompt jamais le demarrage: la cascade
    // ci-dessous gere deja ce cas de maniere resiliente (jusqu'a l'escalade
    // finale vers WAITING_FOR_USER).
    if (startUrl && stillRunning() && !handle.page.isClosed()) {
      try {
        await handle.page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: INITIAL_NAVIGATION_TIMEOUT_MS });
        navLog("success", `Navigation initiale vers l'URL TLS de depart reussie (${maskUrlForLog(startUrl)}).`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        navLog("warn", `Navigation initiale vers l'URL TLS de depart impossible (${message}).`);
      }
    }

    const isAtAppointmentPage = async (): Promise<boolean> => {
      if (!stillRunning() || !handle.browser.isConnected()) {
        return false;
      }
      const selection = await findAppointmentPage(handle.context.pages(), this.settings.targetMode).catch(() => null);
      if (selection?.ok) {
        handle.page = selection.page;
        return true;
      }
      return false;
    };

    // Une action (soumission du formulaire, clic "Selectionner"/"Prendre un
    // rendez-vous") declenche une navigation ASYNCHRONE : verifier
    // isAtAppointmentPage() immediatement apres l'action, sans attendre,
    // observe presque toujours l'ancienne page et declenche une nouvelle
    // tentative inutile (defaut reel constate lors de la validation de ce
    // hotfix). On attend donc, borne dans le temps, que la navigation se
    // termine avant de conclure que l'etape n'a rien change.
    const AUTO_NAV_STEP_SETTLE_MS = 8_000;
    const waitForAppointmentPageOrTimeout = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await isAtAppointmentPage()) {
          return true;
        }
        if (!stillRunning() || handle.page?.isClosed()) {
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return isAtAppointmentPage();
    };

    // Diagnostic Cloudflare (sequence de navigation): l'ancien flux
    // (sessionManager.ts, resumeIfRecognizedState) ne relance JAMAIS une
    // action sur une page dans un etat ambigu/bloque - il attend, sans rien
    // forcer. Un blocage Cloudflare constate arrete definitivement les
    // tentatives automatiques (jamais de nouvelle soumission sur la meme
    // page bloquee, jamais de retour au login, jamais d'attente longue puis
    // tentative finale qui ne ferait que re-soumettre sur la meme page).
    let blockedByCloudflare = false;
    let lastSubmittedPageUrl: string | null = null;

    // HOTFIX CIBLE (service-level bloque malgre un lien "Continuer" valide et
    // deja trouvable en reel): l'ancienne cascade rejouait INCONDITIONNELLEMENT
    // clickSeConnecter -> fillLoginForm -> clickSelectTravelGroup ->
    // clickBookNewAppointment -> clickContinueServiceLevel a CHAQUE tentative,
    // meme depuis une page deja avancee dans le parcours (ex. deja sur
    // service-level): une tentative relancait alors une navigation vers
    // /fr-fr/login avant meme d'essayer de cliquer "Continuer", perdant l'etat
    // deja atteint (confirme en reel: artifacts/logs/agent.log du 2026-07-25,
    // "Navigation directe vers /fr-fr/login impossible" suivi d'un nouvel echec
    // identique sur service-level). dispatchOnState() remplace cette sequence
    // figee par un pilotage par etat courant, calque sur
    // resumeIfRecognizedState() (sessionManager.ts): une seule action, celle
    // pertinente pour la page REELLEMENT affichee.
    //
    // Etats geres :
    //   B. service-level        -> clickContinueServiceLevel (uniquement)
    //   C. travel-groups        -> clickSelectTravelGroup (uniquement)
    //   D. application-summary  -> clickBookNewAppointment (uniquement)
    //   E. page d'authentification (i2-auth) -> fillLoginForm (uniquement)
    //   F. page d'accueil/TARGET_URL: UNIQUEMENT la premiere etape non
    //      reconnue de CETTE tentative -> clickSeConnecter (jamais une
    //      deuxieme fois dans la meme tentative: c'est precisement le defaut
    //      corrige ici)
    //   H. etat inconnu (toute etape suivante non reconnue dans la meme
    //      tentative) -> aucune action forcee, attente breve puis reevaluation.
    // Cloudflare (G) et la page de rendez-vous (A) restent geres en dehors de
    // dispatchOnState (respectivement isCloudflareBlockedPage ci-dessous et
    // isAtAppointmentPage ci-dessus/dans la boucle de pas).
    type StateDispatchOutcome = "confirmed" | "attempted" | "none";

    // HOTFIX CIBLE 0.1.9 (agent bloque sur la page d'accueil malgre un lien
    // 'Se connecter' reel, confirme par DevTools): avant la toute premiere
    // action d'une tentative, journalise l'etat REEL du contexte Chrome
    // pilote - jamais de donnee sensible (cookies/login/mot de passe), une
    // URL toujours masquee via maskUrlForLog. Objectif: confirmer que
    // Playwright pilote bien l'onglet visible affichant la page TLS attendue,
    // et non un autre onglet (profil persistant reutilise, restauration de
    // session Chrome apres un arret force taskkill /F).
    const logDrivenPageDiagnostics = async (): Promise<void> => {
      if (!handle.browser.isConnected()) {
        return;
      }
      const pages = handle.context.pages();
      navLog(
        "info",
        `Diagnostic pages pilotees avant premiere action: handle.page=${maskUrlForLog(handle.page.url())}, `
        + `total onglets=${pages.length}.`
      );
      for (let index = 0; index < pages.length; index += 1) {
        const candidate = pages[index];
        const closed = candidate.isClosed();
        const visibilityState = closed
          ? "(fermee)"
          : await candidate.evaluate(() => document.visibilityState).catch(() => "(indetermine)");
        navLog(
          "info",
          `  onglet[${index}] url=${closed ? "(fermee)" : maskUrlForLog(candidate.url())} `
          + `isClosed=${closed} estHandlePage=${candidate === handle.page} visibilityState=${visibilityState}.`
        );
      }
    };

    // Attente explicite, apres un clic 'Se connecter' reellement execute, de
    // l'une des etapes TLS reconnues - jamais uniquement appointment-booking
    // (defaut corrige: home->auth est deja une progression reelle, pas
    // seulement l'arrivee finale sur la page de rendez-vous).
    const RECOGNIZED_STATE_WAIT_MS = 12_000;
    const detectRecognizedState = async (page: import("playwright").Page): Promise<string | null> => {
      if (page.isClosed()) {
        return null;
      }
      const url = page.url();
      if (loginPathPattern.test(url)) {
        return "login";
      }
      if (travelGroupsPagePattern.test(url)) {
        return "travel-groups";
      }
      if (applicationSummaryPagePattern.test(url)) {
        return "application-summary";
      }
      if (await isServiceLevelPage(page).catch(() => false)) {
        return "service-level";
      }
      if (await isAtAppointmentPage()) {
        return "appointment-booking";
      }
      if (await isAuthPage(page).catch(() => false)) {
        return "auth";
      }
      if (await isCloudflareBlockedPage(page).catch(() => false)) {
        return "cloudflare";
      }
      return null;
    };
    const waitForRecognizedStateOrTimeout = async (page: import("playwright").Page, timeoutMs: number): Promise<string | null> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const state = await detectRecognizedState(page);
        if (state) {
          return state;
        }
        if (page.isClosed() || !stillRunning()) {
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return detectRecognizedState(page);
    };

    // HOTFIX CIBLE 0.2.1 (bot bloque sur /fr-fr/travel-groups malgre un bouton
    // 'Selectionner' visible): attente explicite, apres un clic 'Selectionner'
    // reellement execute, d'une VRAIE progression - jamais uniquement le fait
    // que click() n'a pas leve d'exception. Cible les 3 destinations valides
    // depuis travel-groups (jamais travel-groups elle-meme, qui matcherait
    // trivialement sans aucune progression reelle si reutilisee telle quelle).
    const TRAVEL_GROUPS_PROGRESS_WAIT_MS = 18_000;
    const detectTravelGroupsProgress = async (page: import("playwright").Page): Promise<string | null> => {
      if (page.isClosed()) {
        return null;
      }
      const url = page.url();
      if (applicationSummaryPagePattern.test(url)) {
        return "application-summary";
      }
      if (await isServiceLevelPage(page).catch(() => false)) {
        return "service-level";
      }
      if (await isAtAppointmentPage()) {
        return "appointment-booking";
      }
      return null;
    };
    const waitForTravelGroupsProgressOrTimeout = async (page: import("playwright").Page, timeoutMs: number): Promise<string | null> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const state = await detectTravelGroupsProgress(page);
        if (state) {
          return state;
        }
        if (page.isClosed() || !stillRunning()) {
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return detectTravelGroupsProgress(page);
    };

    const dispatchOnState = async (
      page: import("playwright").Page,
      initialLoginState: { attempted: boolean }
    ): Promise<StateDispatchOutcome> => {
      const url = page.url();

      // HOTFIX CIBLE 0.2.1 (cause racine): priorite STRICTE aux etats
      // identifies par leur URL EXACTE, avant tout detecteur de contenu -
      // service-level (dont le repli structurel reste possible sur une URL
      // INCONNUE, cf. isServiceLevelPage) ne doit jamais intercepter une URL
      // deja reconnue comme un autre etat (defaut reel confirme deux fois:
      // page d'accueil ET /fr-fr/travel-groups classees a tort en
      // service-level par un texte present ailleurs sur ces pages). Ordre:
      // appointment-booking (deja gere hors de dispatchOnState, cf.
      // isAtAppointmentPage) -> travel-groups -> application-summary ->
      // login/auth -> service-level (URL exacte OU repli structurel strict)
      // -> page d'accueil (clickSeConnecter, jamais avant les etats ci-dessus).
      if (travelGroupsPagePattern.test(url)) {
        const urlBeforeSelect = page.url();
        // HOTFIX CIBLE 0.2.1: meme defaut que le hotfix precedent (clickSeConnecter)
        // - le resultat de clickSelectTravelGroup() etait avale puis ignore, un
        // clic/une action qui echouait reellement etait tout de meme rapportee
        // comme "attempted", et le garde-fou lastDispatchedUrl abandonnait la
        // tentative sans jamais journaliser la vraie cause (defaut confirme en
        // reel: bot bloque sur /fr-fr/travel-groups malgre un bouton 'Selectionner'
        // visible d'apres l'utilisateur).
        const selected = await clickSelectTravelGroup(page, navLog).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          navLog("warn", `Erreur inattendue (non geree par clickSelectTravelGroup) lors du clic 'Selectionner': ${message}`);
          return false;
        });
        if (!selected) {
          navLog(
            "warn",
            `clickSelectTravelGroup() a echoue reellement (selected=false, URL=${maskUrlForLog(urlBeforeSelect)}): `
            + "aucune action n'a fait progresser cette page. Abandon de cette tentative (reprise controlee a la tentative suivante) plutot que de pretendre un succes."
          );
          return "none";
        }
        navLog(
          "info",
          `clickSelectTravelGroup() execute avec succes (selected=true, URL=${maskUrlForLog(urlBeforeSelect)}). `
          + "Attente d'une progression reelle (application-summary/service-level/appointment-booking), pas uniquement l'absence d'exception."
        );
        const reachedState = await waitForTravelGroupsProgressOrTimeout(page, TRAVEL_GROUPS_PROGRESS_WAIT_MS);
        if (reachedState) {
          navLog("success", `Progression confirmee apres clickSelectTravelGroup(): etape '${reachedState}' atteinte (URL=${maskUrlForLog(page.url())}).`);
        } else {
          navLog(
            "warn",
            `clickSelectTravelGroup() execute (selected=true) mais aucune progression reelle detectee apres `
            + `${Math.round(TRAVEL_GROUPS_PROGRESS_WAIT_MS / 1000)}s (URL actuelle=${maskUrlForLog(page.url())}): clic execute mais navigation absente.`
          );
        }
        return "attempted";
      }

      if (applicationSummaryPagePattern.test(url)) {
        await clickBookNewAppointment(page, navLog).catch(() => false);
        return "attempted";
      }

      if (await isAuthPage(page)) {
        if (!(login && password)) {
          return "none";
        }
        // Une seule soumission par page/etat: si la page actuelle est
        // exactement celle laissee par la soumission precedente (aucun
        // changement depuis), ne resoumet jamais en aveugle une seconde fois.
        if (lastSubmittedPageUrl !== null && url === lastSubmittedPageUrl) {
          navLog("info", "Formulaire deja soumis sur cette page sans changement detecte depuis: nouvelle soumission ignoree.");
          return "none";
        }
        await fillLoginForm(page, login, password, navLog).catch(() => false);
        lastSubmittedPageUrl = page.url();
        return "attempted";
      }

      if (await isServiceLevelPage(page)) {
        const advanced = await clickContinueServiceLevel(page, navLog).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          navLog("warn", `Erreur inattendue (non geree par clickContinueServiceLevel) lors du clic 'Continuer': ${message}`);
          return false;
        });
        return advanced ? "confirmed" : "attempted";
      }

      if (!initialLoginState.attempted) {
        initialLoginState.attempted = true;
        const urlBeforeClick = page.url();
        // HOTFIX CIBLE 0.1.9: le resultat de clickSeConnecter() etait avale
        // (.catch(() => false) puis totalement ignore) - un clic/une
        // navigation qui echouait reellement (site injoignable, element non
        // actionnable, mauvaise page ciblee...) etait tout de meme rapporte
        // comme "attempted" au meme titre qu'un succes. Le garde-fou
        // lastDispatchedUrl (ci-dessous, dans attemptOnce) constatait alors
        // que l'URL n'avait pas change et abandonnait la tentative SANS
        // jamais journaliser la vraie cause - defaut confirme en reel
        // (agent bloque sur la page d'accueil malgre un lien reel et
        // cliquable d'apres DevTools).
        const connected = await clickSeConnecter(page, navLog).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          navLog("warn", `Erreur inattendue (non geree par clickSeConnecter) lors du clic 'Se connecter': ${message}`);
          return false;
        });
        if (!connected) {
          navLog(
            "warn",
            `clickSeConnecter() a echoue reellement (connected=false, URL avant=${maskUrlForLog(urlBeforeClick)}, `
            + `URL apres=${maskUrlForLog(page.url())}): aucune action n'a fait progresser cette page. `
            + "Abandon de cette tentative (reprise controlee a la tentative suivante) plutot que de pretendre un succes."
          );
          return "none";
        }
        navLog(
          "info",
          `clickSeConnecter() execute avec succes (connected=true, URL avant=${maskUrlForLog(urlBeforeClick)}, `
          + `URL immediatement apres=${maskUrlForLog(page.url())}). Attente d'une etape TLS reconnue `
          + "(login/auth/travel-groups/service-level/application-summary/appointment-booking), pas uniquement appointment-booking."
        );
        const reachedState = await waitForRecognizedStateOrTimeout(page, RECOGNIZED_STATE_WAIT_MS);
        if (reachedState) {
          navLog("success", `Progression confirmee apres clickSeConnecter(): etape '${reachedState}' atteinte (URL=${maskUrlForLog(page.url())}).`);
        } else {
          navLog(
            "warn",
            `clickSeConnecter() execute (connected=true) mais aucune etape TLS reconnue atteinte apres `
            + `${Math.round(RECOGNIZED_STATE_WAIT_MS / 1000)}s (URL actuelle=${maskUrlForLog(page.url())}).`
          );
        }
        return "attempted";
      }

      // Etat H: aucune des etapes reconnues (B-E) ni la premiere tentative de
      // connexion (F) ne s'applique. Jamais de navigation forcee vers le
      // login ici (c'est precisement le defaut corrige par ce hotfix): on
      // attend brievement une eventuelle navigation SPA deja en cours, puis
      // on reevalue une seule fois avant d'abandonner cette tentative.
      navLog("warn", `Etat de page non reconnu (${maskUrlForLog(url)}). Attente breve puis reevaluation avant abandon de cette tentative.`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      if (page.isClosed() || !stillRunning()) {
        return "none";
      }
      return page.url() === url ? "none" : "attempted";
    };

    // Borne haute de defense (jamais atteinte en pratique: le parcours
    // complet home->auth->travel-groups->application-summary/service-level->
    // appointment-booking tient en 4-5 pas) - un etat H repete abandonne des
    // le 2e pas de toute facon (initialLoginState.attempted deja vrai).
    const MAX_STATE_STEPS_PER_ATTEMPT = 8;

    const attemptOnce = async (): Promise<boolean> => {
      const initialLoginState = { attempted: false };
      // Garde-fou anti-repetition: si une action a deja ete tentee sur cette
      // EXACTE url (le clic/remplissage a echoue sans faire bouger la page),
      // rejouer la meme action sur la meme page n'aidera jamais - on arrete
      // cette tentative plutot que de marteler jusqu'a MAX_STATE_STEPS_PER_ATTEMPT
      // fois la meme action (defaut constate en reel: jusqu'a 13 clics
      // "Continuer" rapproches sur une page de service-level bloquee avant
      // qu'un crash Chrome ne survienne - jamais acceptable, y compris pour
      // la simple charge que cela represente sur le vrai site).
      let lastDispatchedUrl: string | null = null;

      for (let step = 0; step < MAX_STATE_STEPS_PER_ATTEMPT; step += 1) {
        if (!stillRunning() || !handle.browser.isConnected() || !handle.page || handle.page.isClosed()) {
          return false;
        }
        if (await isAtAppointmentPage()) {
          return true;
        }

        // Extension locale configuree: jamais de remplissage de formulaire
        // injecte par l'agent (risque d'interference avec ce que l'extension
        // fait elle-meme) - seule l'attente/reprise du contexte est reeditee.
        if (hasLocalExtension) {
          return false;
        }

        const page = handle.page;

        if (await isCloudflareBlockedPage(page).catch(() => false)) {
          navLog("warn", "Page de blocage Cloudflare detectee. Aucune nouvelle tentative automatique ne sera effectuee.");
          blockedByCloudflare = true;
          return false;
        }

        if (step === 0) {
          await logDrivenPageDiagnostics();
        }

        const urlBeforeStep = page.url();
        if (lastDispatchedUrl !== null && urlBeforeStep === lastDispatchedUrl) {
          navLog("warn", `Etat inchange apres la derniere action sur cette page (${maskUrlForLog(urlBeforeStep)}): abandon de cette tentative plutot que de repeter la meme action.`);
          return false;
        }

        const outcome = await dispatchOnState(page, initialLoginState);
        if (outcome === "confirmed") {
          return true;
        }
        if (outcome === "none") {
          return false;
        }
        lastDispatchedUrl = urlBeforeStep;

        if (page.isClosed() || !stillRunning()) {
          return false;
        }
        if (await waitForAppointmentPageOrTimeout(AUTO_NAV_STEP_SETTLE_MS)) {
          return true;
        }
      }

      return false;
    };

    for (let attempt = 1; attempt <= AUTO_NAV_FINAL_ATTEMPT; attempt += 1) {
      if (!stillRunning()) {
        return;
      }

      if (attempt === AUTO_NAV_FINAL_ATTEMPT) {
        const longWaitMs = this.settings.autoNavLongWaitMs;
        navLog("warn", `${AUTO_NAV_ATTEMPTS_BEFORE_LONG_WAIT} tentatives sans page de rendez-vous. Attente de ${Math.round(longWaitMs / 60_000)} minutes avant la tentative finale.`);
        await new Promise((resolve) => setTimeout(resolve, longWaitMs));
        if (!stillRunning()) {
          return;
        }
      }

      if (await attemptOnce()) {
        await this.closeExtraPages(handle.page);
        // BUG CIBLE 0.2.4: runtimeCredentials n'est plus passe au cas par cas
        // ici - beginMonitoring() les relit lui-meme depuis this.runtimeCredentials
        // (memes credentials, deja stockes dans startBot()), source UNIQUE
        // partagee avec le chemin VALIDATE_BOT (jamais deux mecanismes divergents).
        this.beginMonitoring(handle, handle.startCommandId);
        handle.log("success", `Bot ${botId}: page de rendez-vous atteinte automatiquement, surveillance demarree.`);
        return;
      }

      // Diagnostic Cloudflare: un blocage constate arrete definitivement les
      // tentatives automatiques - jamais de longue attente puis une tentative
      // finale qui ne ferait que re-soumettre sur la meme page bloquee.
      if (blockedByCloudflare) {
        break;
      }

      if (attempt < AUTO_NAV_ATTEMPTS_BEFORE_LONG_WAIT) {
        await new Promise((resolve) => setTimeout(resolve, this.settings.autoNavRetryIntervalMs));
        if (!stillRunning()) {
          return;
        }
      }
    }

    if (!stillRunning()) {
      return;
    }

    // Seul point ou WAITING_FOR_USER est envoye pour ce bot (section 5 du
    // hotfix 0.1.1): la connexion/le parcours automatique n'a pas abouti -
    // soit apres toutes les tentatives, soit immediatement des la detection
    // d'un blocage Cloudflare (jamais de nouvel essai dans ce cas) - une
    // intervention humaine reelle est necessaire.
    navLog("warn", blockedByCloudflare
      ? "Blocage Cloudflare constate: passage en attente d'une intervention humaine, sans nouvel essai automatique."
      : `page de rendez-vous introuvable apres ${AUTO_NAV_FINAL_ATTEMPT} tentatives automatiques. Intervention humaine requise.`);
    handle.currentStatus = "WAITING_FOR_USER";
    this.reporter.botStatus(botId, handle.startCommandId, "WAITING_FOR_USER");
  }

  // Detecte une fermeture non sollicitee (Chrome ferme manuellement par
  // l'utilisateur, crash) et distincte d'un STOP_BOT deliberement declenche:
  // stopHandle() retire ces memes listeners avant de fermer volontairement,
  // donc ce chemin n'est jamais atteint pour un arret demande par le serveur.
  private wireUnexpectedClosure(handle: AgentBotHandle): void {
    const onClosed = (): void => {
      if (this.stopping.has(handle.botId) || !this.bots.has(handle.botId)) {
        return;
      }
      handle.log("warn", `Bot ${handle.botId}: navigateur ferme ou deconnecte de maniere inattendue.`);
      handle.monitoringRuntime?.abortController.abort();
      this.leases.get(handle.botId)?.release();
      this.leases.delete(handle.botId);
      this.bots.delete(handle.botId);
      // BUG CIBLE 0.2.4: fermeture inattendue du navigateur -> credentials en
      // memoire detruits (jamais conserves au-dela de la vie reelle du bot).
      this.runtimeCredentials.delete(handle.botId);
      this.reporter.botStatus(handle.botId, handle.startCommandId, "STOPPED", { reason: "BROWSER_CLOSED" });
    };

    handle.browser.on("disconnected", onClosed);
    handle.browserProcess.once("exit", onClosed);
  }

  private sanitizeInstallLink(link: AgentExtensionInstallLink): string | null {
    if (!link.installUrl || link.installUrl.length > 2_000) {
      return null;
    }
    try {
      const parsed = new URL(link.installUrl);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? link.installUrl : null;
    } catch {
      return null;
    }
  }

  private async openExtensionLinks(handle: AgentBotHandle, links: AgentExtensionInstallLink[]): Promise<void> {
    const validLinks = links
      .map((link) => ({ ...link, installUrl: this.sanitizeInstallLink(link) }))
      .filter((link): link is AgentExtensionInstallLink => Boolean(link.installUrl));

    if (validLinks.length === 0 || !handle.browser.isConnected()) {
      return;
    }

    for (const link of validLinks) {
      const extensionPage = await handle.context.newPage();
      extensionPage.setDefaultTimeout(8_000);
      await extensionPage.goto(link.installUrl, { waitUntil: "domcontentloaded" })
        .then(() => handle.log("info", `Bot ${handle.botId}: lien extension ouvert (${link.name}, ${maskUrlForLog(link.installUrl)}).`))
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          handle.log("warn", `Bot ${handle.botId}: ouverture du lien extension "${link.name}" impossible (${message}).`);
        });
    }

    await handle.page.bringToFront().catch(() => undefined);
    handle.log("info", `Bot ${handle.botId}: ${validLinks.length} lien(s) d'extension ouvert(s). Installez manuellement si Chrome le demande, puis validez le bot.`);
  }

  private async closeExtraPages(keepPage: import("playwright").Page): Promise<void> {
    const pages = keepPage.context().pages();
    await Promise.all(pages.map(async (candidate) => {
      if (candidate === keepPage || candidate.isClosed()) {
        return;
      }
      const url = candidate.url();
      if (url.startsWith("devtools://") || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
        return;
      }
      await candidate.close().catch(() => undefined);
    }));
  }

  // Jamais de detail Playwright/Chrome brut transmis au serveur (section 7):
  // seul le code public + un message deja generique est envoye.
  private publicMessageFor(error: AgentCommandError): string {
    const messages: Record<string, string> = {
      BROWSER_LAUNCH_FAILED: "Le lancement de Chrome a echoue sur cet ordinateur.",
      BROWSER_NOT_FOUND: "Google Chrome est introuvable sur cet ordinateur (CHROME_EXECUTABLE_PATH).",
      BROWSER_CONNECTION_FAILED: "La connexion au navigateur ouvert a echoue.",
      PROFILE_LOCKED: "Ce profil Chrome est deja utilise par une autre instance.",
      PROFILE_CREATE_FAILED: "Impossible de preparer le profil Chrome local.",
      BOT_ALREADY_RUNNING: "Ce bot est deja actif sur cet agent.",
      AGENT_CAPACITY_REACHED: "Limite locale de bots actifs atteinte sur cet agent.",
      AGENT_SHUTTING_DOWN: "L'agent est en cours d'arret. Relancez RendezBot Agent.",
      BOT_NOT_RUNNING: "Ce bot n'est plus actif sur cet agent.",
      BROWSER_CLOSED: "Le navigateur de ce bot a ete ferme.",
      BROWSER_CONNECTION_LOST: "La connexion au navigateur de ce bot a ete perdue.",
      PAGE_NOT_READY: "La page de rendez-vous n'est pas prete.",
      PAGE_CLOSED: "L'onglet du bot a ete ferme.",
      VALIDATION_ALREADY_RUNNING: "Une verification de page est deja en cours pour ce bot.",
      REFRESH_FAILED: "Le rafraichissement de la page a echoue de maniere repetee.",
      EXTENSION_NOT_FOUND: "Une extension Chrome obligatoire est introuvable sur cet ordinateur.",
      EXTENSION_INVALID: "Une extension Chrome obligatoire est invalide sur cet ordinateur.",
      TLS_START_URL_INVALID: "Aucune URL TLS de depart n'est configuree cote serveur (TARGET_URL) et aucune extension locale ne prend le relais.",
      TLS_ACCOUNT_ALREADY_RUNNING: "Un bot de ce compte TLS est deja actif sur cet agent."
    };
    return messages[error.code] ?? "Erreur interne de l'agent.";
  }

  // Ferme reellement tous les bots actifs (navigateur, surveillance, verrou
  // de profil) - factorise entre stopAllBotsForIdentityReset() (agent
  // reutilisable ensuite) et shutdownAll() (arret definitif du process).
  // Ne touche jamais this.shuttingDown ni starting/stopping/validating:
  // chaque appelant decide seul de ce qui doit rester coherent pour son
  // propre cas d'usage.
  private async closeAllBotHandles(): Promise<void> {
    const handles = [...this.bots.values()];
    await Promise.all(handles.map(async (handle) => {
      handle.browser.removeAllListeners("disconnected");
      handle.browserProcess.removeAllListeners("exit");
      try {
        this.reporter.botStatus(handle.botId, handle.startCommandId, "STOPPING");
      } catch {
        // best effort: la connexion serveur peut deja etre fermee.
      }
      if (handle.monitoringRuntime) {
        handle.monitoringRuntime.abortController.abort();
        await Promise.race([
          handle.monitoringRuntime.loopPromise,
          new Promise<void>((resolve) => setTimeout(resolve, MONITORING_STOP_TIMEOUT_MS))
        ]);
      }
      await closeBrowserWithTimeout(handle.browser);
      await killChromeProcess(handle.browserProcess);
      this.leases.get(handle.botId)?.release();
    }));
    this.bots.clear();
    this.leases.clear();
    // BUG CIBLE 0.2.4: agent arrete/identite reinitialisee -> plus aucun
    // credential ne doit survivre au-dela de cet instant.
    this.runtimeCredentials.clear();
  }

  // BUG CIBLE 0.1.5 (agent inutilisable apres revocation/reappairage dans le
  // MEME processus): shutdownAll() positionne this.shuttingDown=true de
  // facon PERMANENTE (jamais remis a false), alors que la revocation/
  // dissociation locale sont des resets d'IDENTITE, pas un arret du process
  // - l'utilisateur peut tout a fait reappairer cet agent juste apres, dans
  // le meme processus Node (agentMain.ts ne redemarre rien). Avant ce
  // correctif, ce reappairage laissait AgentBotManager durablement bloque:
  // tout START_BOT suivant etait refuse avec AGENT_CAPACITY_REACHED alors
  // que activeCount()=0 et que la limite locale n'etait pas atteinte.
  // Utilisee par applyPermanentFailurePolicy (AGENT_REVOKED/INVALID_TOKEN/
  // ...) et par la dissociation locale (agentMain.ts): ferme tout, vide
  // integralement le registre (y compris starting/stopping/validating, pour
  // ne laisser aucune reservation fantome), mais laisse le manager
  // parfaitement reutilisable pour un nouvel appairage a venir.
  async stopAllBotsForIdentityReset(): Promise<void> {
    await this.closeAllBotHandles();
    this.starting.clear();
    this.stopping.clear();
    this.validating.clear();
  }

  // Reserve exclusivement a l'arret DEFINITIF du process agent (SIGINT/
  // SIGTERM, ou "Quitter" depuis l'UI locale, cf. agentMain.ts): positionne
  // this.shuttingDown=true de maniere permanente - plus aucun START_BOT ne
  // sera jamais accepte ensuite par cette instance, ce qui est correct ici
  // puisque le process se termine juste apres. Ne jamais appeler cette
  // methode pour un simple reset d'identite (revocation/dissociation suivie
  // d'un reappairage): utiliser stopAllBotsForIdentityReset() a la place.
  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    await this.closeAllBotHandles();
    this.starting.clear();
    this.stopping.clear();
    this.validating.clear();
  }
}
