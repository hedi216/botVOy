import { clickBookNewAppointment, clickSeConnecter, clickSelectTravelGroup, fillLoginForm } from "../shared/loginFlow.js";
import { closeBrowserWithTimeout, killChromeProcess, launchChromeForBot } from "./agentBrowserManager.js";
import { loadExtensionConfig, validateExtensions } from "./agentExtensionConfig.js";
import { getConfigDir } from "./agentStorage.js";
import { findAppointmentPage, maskUrlForLog } from "./agentPageDetector.js";
import { acquireProfileLock, ProfileLease } from "./agentProfileManager.js";
import { AgentCommandError, toAgentCommandError } from "./agentErrors.js";
import { AgentEventReporter } from "./agentEventReporter.js";
import { AgentLogFn } from "./agentLocalLogger.js";
import { validateMonitoringSettings } from "./agentMonitoringSettings.js";
import { startMonitoring } from "./agentMonitoringRuntime.js";
import { AgentBotHandle, AgentRuntimeSettings, RuntimeStatusBotSnapshot } from "./types.js";

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
  // tout point d'attente (acquireProfileLock/launchChromeForBot sont ensuite
  // asynchrones): sans cela, deux START_BOT quasi simultanes pour le meme
  // botId (redelivraison socket, bug serveur) passeraient tous les deux le
  // controle "this.bots.has(botId)" avant que le premier n'ait eu le temps
  // d'inserer son handle, et lanceraient chacun un vrai Chrome sur le meme
  // profil.
  private readonly starting = new Set<string>();
  // Deduplique VALIDATE_BOT en cours (section 1: "une commande VALIDATE_BOT
  // equivalente est deja en cours" -> VALIDATION_ALREADY_RUNNING), meme
  // principe que this.starting/this.stopping.
  private readonly validating = new Set<string>();
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
    const settingsSnapshot = validateMonitoringSettings(params.rawMonitoringSettings, this.log);

    if (this.shuttingDown) {
      this.reporter.failed(commandId, "AGENT_CAPACITY_REACHED", "Agent en cours d'arret: aucune nouvelle commande acceptee.");
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

      lease = acquireProfileLock(this.settings, botId);
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
        category
      };
      this.bots.set(botId, handle);
      this.wireUnexpectedClosure(handle);

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
      this.log("success", `Bot ${botId} demarre (Chrome visible, profil verrouille). Connexion automatique en cours...`);

      void this.runAutoNavigation(handle, hasLocalExtension, login, password).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log("error", `Bot ${botId}: demarrage automatique interrompu de maniere inattendue (${message}).`);
      });
    } catch (error) {
      lease?.release();
      this.leases.delete(botId);
      const commandError = toAgentCommandError(error, "BROWSER_LAUNCH_FAILED");
      this.log("error", `Demarrage du bot ${botId} echoue (${commandError.code}): ${commandError.message}`);
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
      this.log("warn", `STOP_BOT recu pour un botId inconnu de cet agent: ${botId} (traite comme deja arrete).`);
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
    }

    this.reporter.botStatus(botId, commandId, "STOPPED");
    this.reporter.completed(commandId, { botId, status: "STOPPED", stopped: true });
    this.log("success", `Bot ${botId} arrete, Chrome ferme, profil libere.`);
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
        this.log("warn", `VALIDATE_BOT ${botId}: ${selection.reason}`);
        this.reporter.botStatus(botId, commandId, "WAITING_FOR_USER");
        this.reporter.failed(
          commandId,
          "PAGE_NOT_READY",
          "La page de rendez-vous n'est pas prete. Verifiez la page ouverte dans Chrome, puis validez a nouveau."
        );
        return;
      }

      handle.page = selection.page;

      // Section 2 du cahier des charges Lot 4: AbortController + snapshot
      // deja valides (a l'ouverture du bot) -> demarrage reel de la boucle
      // -> BOT_STATUS MONITORING -> COMMAND_COMPLETED, dans cet ordre.
      this.beginMonitoring(handle, commandId);

      this.reporter.completed(commandId, { botId, status: "MONITORING", validated: true });
      this.log("success", `Bot ${botId} valide: page reconnue (${maskUrlForLog(selection.page.url())}), surveillance demarree.`);
    } catch (error) {
      const commandError = toAgentCommandError(error, "PAGE_NOT_READY");
      this.log("error", `VALIDATE_BOT ${botId} echoue (${commandError.code}): ${commandError.message}`);
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
      targetUrl: this.settings.targetUrl,
      commandId,
      reporter: this.reporter,
      log: this.log,
      isBotStillRegistered: () => this.bots.has(botId)
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
    password: string | undefined
  ): Promise<void> {
    const { botId } = handle;
    const stillRunning = (): boolean => this.bots.has(botId) && !this.stopping.has(botId);
    const navLog = (level: Parameters<AgentLogFn>[0], message: string): void =>
      this.log(level, `[Connexion auto ${botId}] ${message}`);

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

    const attemptOnce = async (): Promise<boolean> => {
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
      await clickSeConnecter(page, navLog).catch(() => false);
      if (page.isClosed() || !stillRunning()) {
        return false;
      }

      if (login && password) {
        await fillLoginForm(page, login, password, navLog).catch(() => false);
      }
      if (page.isClosed() || !stillRunning()) {
        return false;
      }
      if (await waitForAppointmentPageOrTimeout(AUTO_NAV_STEP_SETTLE_MS)) {
        return true;
      }

      await clickSelectTravelGroup(page, navLog).catch(() => false);
      if (page.isClosed() || !stillRunning()) {
        return false;
      }
      if (await waitForAppointmentPageOrTimeout(AUTO_NAV_STEP_SETTLE_MS)) {
        return true;
      }

      await clickBookNewAppointment(page, navLog).catch(() => false);
      if (page.isClosed() || !stillRunning()) {
        return false;
      }
      return waitForAppointmentPageOrTimeout(AUTO_NAV_STEP_SETTLE_MS);
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
        this.beginMonitoring(handle, handle.startCommandId);
        this.log("success", `Bot ${botId}: page de rendez-vous atteinte automatiquement, surveillance demarree.`);
        return;
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
    // hotfix): la connexion/le parcours automatique n'a pas abouti apres
    // toutes les tentatives - une intervention humaine reelle (captcha,
    // controle, etape non automatisable) est necessaire.
    navLog("warn", `page de rendez-vous introuvable apres ${AUTO_NAV_FINAL_ATTEMPT} tentatives automatiques. Intervention humaine requise.`);
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
      this.log("warn", `Bot ${handle.botId}: navigateur ferme ou deconnecte de maniere inattendue.`);
      handle.monitoringRuntime?.abortController.abort();
      this.leases.get(handle.botId)?.release();
      this.leases.delete(handle.botId);
      this.bots.delete(handle.botId);
      this.reporter.botStatus(handle.botId, handle.startCommandId, "STOPPED", { reason: "BROWSER_CLOSED" });
    };

    handle.browser.on("disconnected", onClosed);
    handle.browserProcess.once("exit", onClosed);
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
      BOT_NOT_RUNNING: "Ce bot n'est plus actif sur cet agent.",
      BROWSER_CLOSED: "Le navigateur de ce bot a ete ferme.",
      BROWSER_CONNECTION_LOST: "La connexion au navigateur de ce bot a ete perdue.",
      PAGE_NOT_READY: "La page de rendez-vous n'est pas prete.",
      PAGE_CLOSED: "L'onglet du bot a ete ferme.",
      VALIDATION_ALREADY_RUNNING: "Une verification de page est deja en cours pour ce bot.",
      REFRESH_FAILED: "Le rafraichissement de la page a echoue de maniere repetee.",
      EXTENSION_NOT_FOUND: "Une extension Chrome obligatoire est introuvable sur cet ordinateur.",
      EXTENSION_INVALID: "Une extension Chrome obligatoire est invalide sur cet ordinateur."
    };
    return messages[error.code] ?? "Erreur interne de l'agent.";
  }

  // Utilise par Ctrl+C (section 12): ferme tous les bots actifs sans
  // necessiter de commande serveur (aucun commandId disponible dans ce
  // contexte, donc pas de COMMAND_COMPLETED emis ici, seulement un BOT_STATUS
  // best-effort pour que l'interface web se mette a jour immediatement).
  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
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
  }
}
