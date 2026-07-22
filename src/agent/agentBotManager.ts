import { closeBrowserWithTimeout, killChromeProcess, launchChromeForBot } from "./agentBrowserManager.js";
import { findAppointmentPage, maskUrlForLog } from "./agentPageDetector.js";
import { acquireProfileLock, ProfileLease } from "./agentProfileManager.js";
import { AgentCommandError, toAgentCommandError } from "./agentErrors.js";
import { AgentEventReporter } from "./agentEventReporter.js";
import { AgentLogFn } from "./agentLocalLogger.js";
import { validateMonitoringSettings } from "./agentMonitoringSettings.js";
import { startMonitoring } from "./agentMonitoringRuntime.js";
import { AgentBotHandle, AgentRuntimeSettings } from "./types.js";

// Delai maximum laisse a la boucle de surveillance pour repondre a
// l'annulation avant de fermer Chrome de force (section 11 du cahier des
// charges Lot 4): l'arret du navigateur ne doit jamais dependre de la boucle.
const MONITORING_STOP_TIMEOUT_MS = 8_000;

export type StartBotParams = {
  commandId: string;
  botId: string;
  botName?: string;
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

  async startBot(params: StartBotParams): Promise<void> {
    const { commandId, botId } = params;
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
      lease = acquireProfileLock(this.settings, botId);
      this.leases.set(botId, lease);

      const chrome = await launchChromeForBot(lease.profilePath, this.settings.targetUrl);

      const handle: AgentBotHandle = {
        botId,
        startCommandId: commandId,
        browserProcess: chrome.browserProcess,
        browser: chrome.browser,
        context: chrome.context,
        page: chrome.page,
        profilePath: lease.profilePath,
        debugPort: chrome.debugPort,
        currentStatus: "WAITING_FOR_USER",
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastError: null,
        monitoringPrepared: false,
        settingsSnapshot,
        monitoringRuntime: null
      };
      this.bots.set(botId, handle);
      this.wireUnexpectedClosure(handle);

      this.reporter.botStatus(botId, commandId, "WAITING_FOR_USER");
      this.reporter.completed(commandId, {
        botId,
        status: "WAITING_FOR_USER",
        started: true,
        computerName: this.settings.computerName
      });
      this.log("success", `Bot ${botId} demarre (Chrome visible, profil verrouille).`);
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
      handle.monitoringPrepared = true;
      handle.currentStatus = "MONITORING";
      handle.lastActivityAt = new Date().toISOString();

      // Section 2 du cahier des charges Lot 4: AbortController + snapshot
      // deja valides (a l'ouverture du bot) -> demarrage reel de la boucle
      // -> BOT_STATUS MONITORING -> COMMAND_COMPLETED, dans cet ordre.
      handle.monitoringRuntime = startMonitoring({
        botId,
        page: selection.page,
        context: handle.context,
        settings: handle.settingsSnapshot,
        targetUrl: this.settings.targetUrl,
        commandId,
        reporter: this.reporter,
        log: this.log,
        isBotStillRegistered: () => this.bots.has(botId)
      });

      this.reporter.botStatus(botId, commandId, "MONITORING");
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
      REFRESH_FAILED: "Le rafraichissement de la page a echoue de maniere repetee."
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
