import { AgentBotManager } from "./agentBotManager.js";
import { AgentClient } from "./agentClient.js";
import { createCredentialStore } from "./agentCredentialStore.js";
import { migratePlaintextCredentialsIfNeeded } from "./agentCredentialMigration.js";
import { AgentEventReporter, createAgentEventReporter } from "./agentEventReporter.js";
import { loadExtensionConfig, toPublicExtensionStatus, validateExtensions } from "./agentExtensionConfig.js";
import { createAgentLogger } from "./agentLocalLogger.js";
import { AgentLocalUi, openFolderInExplorer } from "./agentLocalUi.js";
import { resolveAgentPaths } from "./agentPaths.js";
import { loadAgentSettings } from "./agentSettings.js";
import { AgentSingleInstanceLock, openUrlInDefaultBrowser } from "./agentSingleInstanceLock.js";
import { AgentCommandEnvelope, AgentLocalUiState, AgentLocalUiStatusPayload } from "./types.js";

const parseArgs = (): { pairingCode?: string } => {
  const [, , mode, arg] = process.argv;
  if (mode === "pair") {
    if (!arg || !arg.trim()) {
      console.error("Usage: npm run agent:dev -- pair <CODE_APPARIEMENT>");
      process.exit(1);
    }
    return { pairingCode: arg.trim() };
  }
  return {};
};

// Types de commande non geres avant le Lot 4/5: restent refuses honnetement
// (accuse puis echec explicite), jamais un faux succes simule (meme principe
// que scripts/test-agent-phase3.ts). VALIDATE_BOT est gere depuis le Lot 3.
const NOT_YET_IMPLEMENTED = new Set(["REFRESH_BOT", "UPDATE_SETTINGS", "REQUEST_STATUS", "SHUTDOWN_BOT"]);

// Jamais l'URL complete (section 7): uniquement host:port, sans identifiants
// ni chemin/requete eventuels.
const sanitizeServerHost = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return "inconnu";
  }
};

// Messages publics par raison d'echec permanent (section 11): jamais un
// detail brut de protocole, toujours une phrase actionnable pour l'humain.
const PERMANENT_FAILURE_MESSAGES: Record<string, string> = {
  AGENT_REVOKED: "Agent revoque. Un nouvel appairage est requis.",
  INVALID_TOKEN: "Identifiants invalides ou revoques. Un nouvel appairage est requis.",
  INVALID_AUTH_MODE: "Configuration d'identifiants invalide. Un nouvel appairage est requis.",
  INVALID_OR_EXPIRED: "Code d'appairage invalide ou expire.",
  TOO_MANY_ATTEMPTS: "Trop de tentatives d'appairage pour ce code. Generez-en un nouveau.",
  VERSION_INCOMPATIBLE: "Version de l'agent incompatible avec le serveur. Une mise a jour est requise."
};

// Raisons qui invalident l'IDENTITE locale (section 11): l'agent redevient
// NOT_PAIRED et les identifiants locaux sont effaces. INVALID_OR_EXPIRED et
// TOO_MANY_ATTEMPTS concernent une TENTATIVE d'appairage qui n'a jamais
// abouti (rien n'a ete ecrit) - le nettoyage y est un no-op sans risque.
// VERSION_INCOMPATIBLE est volontairement absent (section 11: conserver
// l'identite, ne jamais la detruire pour une incompatibilite de version).
const IDENTITY_INVALIDATING_REASONS = new Set([
  "AGENT_REVOKED", "INVALID_TOKEN", "INVALID_AUTH_MODE", "INVALID_OR_EXPIRED", "TOO_MANY_ATTEMPTS"
]);

const main = async (): Promise<void> => {
  const settings = loadAgentSettings();
  const log = createAgentLogger(settings);

  log("info", `RendezBot Agent v${settings.version} (protocole ${settings.protocolVersion}, mode ${settings.runtimeMode})`);
  log("info", `Ordinateur: ${settings.computerName}`);
  log("info", `Serveur: ${settings.serverUrl}`);
  log("info", `Mode cible: ${settings.targetMode}${settings.fixtureUrl ? ` (${settings.fixtureUrl})` : ""}`);
  log("info", `URL de navigation initiale: ${settings.targetUrl}`);
  log("info", `Limite locale de bots actifs: ${settings.maxActiveBots}`);

  const paths = resolveAgentPaths(settings);

  // Phase 5 (Lot 2, section 9): verrou mono-instance AVANT toute autre
  // initialisation - un second lancement ne doit jamais toucher au
  // credential store, au socket, ni lancer un second ensemble de bots.
  const lock = new AgentSingleInstanceLock(settings);
  const acquireResult = await lock.tryAcquire();
  if (!acquireResult.acquired) {
    log("info", `Une instance RendezBot Agent est deja active (PID ${acquireResult.existing.pid}). Ouverture de l'interface existante.`);
    if (acquireResult.existing.localUiPort) {
      openUrlInDefaultBrowser(`http://127.0.0.1:${acquireResult.existing.localUiPort}/`);
    }
    process.exit(0);
    return;
  }

  const credentialStore = await createCredentialStore(settings, log);

  const migrationResult = await migratePlaintextCredentialsIfNeeded(settings, credentialStore, log);
  if (migrationResult.outcome === "migrated") {
    log("success", `Migration des identifiants depuis l'ancien stockage en clair reussie (${migrationResult.fromPath}).`);
  } else if (migrationResult.outcome === "failed") {
    log("error", `Migration des identifiants echouee: ${migrationResult.reason}. Un nouvel appairage sera necessaire.`);
  }

  let botManager: AgentBotManager;
  let reporter: AgentEventReporter;
  let acceptingCommands = true;
  let isPaired = await credentialStore.exists();
  let uiState: AgentLocalUiState = isPaired ? "CONNECTING" : "NOT_PAIRED";
  let uiMessage: string | null = null;

  let pendingPair: { resolve: (result: { ok: boolean; error?: string }) => void; timer: NodeJS.Timeout } | null = null;
  const resolvePendingPair = (result: { ok: boolean; error?: string }): void => {
    if (!pendingPair) {
      return;
    }
    clearTimeout(pendingPair.timer);
    pendingPair.resolve(result);
    pendingPair = null;
  };

  const applyPermanentFailurePolicy = async (reason: string): Promise<void> => {
    const message = PERMANENT_FAILURE_MESSAGES[reason] ?? `Echec d'authentification (${reason}).`;

    if (reason === "VERSION_INCOMPATIBLE") {
      // Section 11: conserve les credentials, bloque sans detruire
      // l'identite de l'agent.
      uiState = "VERSION_INCOMPATIBLE";
      uiMessage = message;
      resolvePendingPair({ ok: false, error: message });
      return;
    }

    uiMessage = message;
    resolvePendingPair({ ok: false, error: message });

    if (!IDENTITY_INVALIDATING_REASONS.has(reason)) {
      return;
    }

    uiState = "NOT_PAIRED";
    isPaired = false;
    acceptingCommands = false;
    await botManager.shutdownAll().catch((error) =>
      log("error", `Erreur pendant l'arret des bots (${reason}): ${error instanceof Error ? error.message : String(error)}`));
    await credentialStore.clear().catch((error) =>
      log("error", `Erreur pendant l'effacement des identifiants (${reason}): ${error instanceof Error ? error.message : String(error)}`));
    acceptingCommands = true;
  };

  const client: AgentClient = new AgentClient(settings, log, {
    onCommand: (command) => {
      if (!acceptingCommands) {
        log("warn", `Commande ${command.type} (${command.commandId}) ignoree: agent en cours d'arret.`);
        return;
      }
      handleCommand(botManager, reporter, command, log);
    },
    onConnectionChange: (connected) => {
      uiState = connected ? "SYNCING" : "OFFLINE";
      if (connected) {
        uiMessage = null;
      }
      log(connected ? "success" : "warn", connected ? "Connecte. Synchronisation en cours..." : "Connexion perdue: les bots locaux continuent, evenements mis en buffer.");
    },
    onSyncReady: () => {
      uiState = "CONNECTED";
      uiMessage = null;
      isPaired = true;
      log("success", "Synchronisation terminee. En attente de commandes.");
      resolvePendingPair({ ok: true });
    },
    onPermanentFailure: (reason) => {
      log("error", `Agent non reautorise a se connecter (${reason}). Les bots deja actifs localement continuent de tourner.`);
      void applyPermanentFailurePolicy(reason);
    },
    onCredentialSaveFailure: (reason) => {
      resolvePendingPair({ ok: false, error: `Connexion reussie mais echec de sauvegarde locale des identifiants (${reason}).` });
    }
  }, credentialStore);
  client.setActiveBotCountProvider(() => botManager.activeCount());
  client.setRuntimeStatusProvider(() => botManager.snapshotForRuntimeStatus());
  client.setExtensionStatusProvider(() => {
    const entries = loadExtensionConfig(paths.configDir, log);
    return toPublicExtensionStatus(validateExtensions(entries, log));
  });

  reporter = createAgentEventReporter(client, log);
  botManager = new AgentBotManager(settings, log, reporter);

  const localUi = new AgentLocalUi(log, {
    getStatus: (): AgentLocalUiStatusPayload => ({
      state: uiState,
      agentVersion: settings.version,
      protocolVersion: settings.protocolVersion,
      computerName: settings.computerName,
      serverHost: sanitizeServerHost(settings.serverUrl),
      paired: isPaired,
      activeBotCount: botManager.activeCount(),
      extensions: toPublicExtensionStatus(validateExtensions(loadExtensionConfig(paths.configDir, log), log)),
      message: uiMessage
    }),
    pairWithCode: (code) => {
      if (isPaired) {
        return Promise.resolve({ ok: false, error: "Agent deja appaire. Dissociez cet ordinateur avant un nouvel appairage." });
      }
      uiState = "CONNECTING";
      uiMessage = null;
      return new Promise((resolve) => {
        pendingPair = {
          resolve,
          timer: setTimeout(() => {
            pendingPair = null;
            resolve({ ok: false, error: "Serveur inaccessible ou reponse trop lente. Nouvelle tentative automatique en arriere-plan." });
          }, 15_000)
        };
        void client.start(code);
      });
    },
    retry: () => {
      uiState = "CONNECTING";
      uiMessage = null;
      void client.start();
    },
    requestQuit: () => shutdown("LOCAL_UI_QUIT"),
    openLogsFolder: () => openFolderInExplorer(paths.logsDir),
    openConfigFolder: () => openFolderInExplorer(paths.configDir),
    unpair: async () => {
      acceptingCommands = false;
      await botManager.shutdownAll().catch((error) =>
        log("error", `Erreur pendant l'arret des bots (dissociation): ${error instanceof Error ? error.message : String(error)}`));
      client.stop();
      await credentialStore.clear().catch((error) =>
        log("error", `Erreur pendant l'effacement des identifiants (dissociation): ${error instanceof Error ? error.message : String(error)}`));
      isPaired = false;
      uiState = "NOT_PAIRED";
      uiMessage = "Ordinateur dissocie. Un nouvel appairage est requis.";
      acceptingCommands = true;
      log("success", "Ordinateur dissocie a la demande locale.");
    }
  });
  const localUiPort = await localUi.start(0);
  lock.updateLocalUiPort(localUiPort);

  const cliPairingCode = parseArgs().pairingCode;
  if (cliPairingCode) {
    await client.start(cliPairingCode);
  } else if (isPaired) {
    try {
      await client.start();
    } catch (error) {
      // Phase 5 (Lot 2 - correctif protocole, section 3): un credential local
      // illisible/corrompu (ex. echec de dechiffrement DPAPI) doit etre traite
      // exactement comme un credential devenu inutilisable cote serveur
      // (INVALID_TOKEN) - jamais un crash du process. Avant ce correctif,
      // cette exception (levee par credentialStore.load() avant meme toute
      // tentative reseau) remontait non geree jusqu'a main(), terminant
      // l'agent entier au lieu de proposer un nouvel appairage.
      const reason = error instanceof Error ? error.message : String(error);
      log("error", `Identifiants locaux illisibles ou corrompus (${reason}). Nouvel appairage requis.`);
      await credentialStore.clear().catch((clearError) =>
        log("error", `Erreur pendant l'effacement des identifiants corrompus: ${clearError instanceof Error ? clearError.message : String(clearError)}`));
      isPaired = false;
      uiState = "NOT_PAIRED";
      uiMessage = "Identifiants locaux illisibles ou corrompus. Un nouvel appairage est requis.";
      openUrlInDefaultBrowser(`http://127.0.0.1:${localUiPort}/`);
    }
  } else {
    log("info", `Aucun agent appaire. Ouvrez http://127.0.0.1:${localUiPort}/ pour saisir un code d'appairage.`);
    openUrlInDefaultBrowser(`http://127.0.0.1:${localUiPort}/`);
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    acceptingCommands = false;
    log("info", `${signal} recu: arret de tous les bots locaux, aucune nouvelle commande acceptee.`);

    void botManager.shutdownAll()
      .catch((error) => log("error", `Erreur pendant l'arret des bots: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        client.stop();
        localUi.stop();
        lock.release();
        log("info", "Agent arrete proprement.");
        process.exit(0);
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
};

const handleCommand = (
  botManager: AgentBotManager,
  reporter: AgentEventReporter,
  command: AgentCommandEnvelope,
  log: ReturnType<typeof createAgentLogger>
): void => {
  if (command.type === "START_BOT") {
    const payload = command.payload as { botName?: unknown; category?: unknown; monitoringSettings?: unknown; startUrl?: unknown } | undefined;
    // Hotfix 0.1.1 (section 3): login/password ne proviennent JAMAIS de
    // `command.payload` (persiste en base cote serveur) - uniquement de
    // `command.transientPayload`, transmis sur ce seul socket, jamais ecrit
    // en base (voir DispatchAgentCommandParams.transientPayload). Jamais
    // journalise ici, jamais stocke au-dela de cet appel.
    const transient = command.transientPayload as { login?: unknown; password?: unknown } | undefined;
    void botManager.startBot({
      commandId: command.commandId,
      botId: command.botId,
      botName: typeof payload?.botName === "string" ? payload.botName : undefined,
      category: typeof payload?.category === "string" ? payload.category : undefined,
      login: typeof transient?.login === "string" ? transient.login : undefined,
      password: typeof transient?.password === "string" ? transient.password : undefined,
      rawMonitoringSettings: payload?.monitoringSettings,
      // Hotfix 0.1.2 (point 3): non sensible - toujours revalide cote agent
      // avant tout usage (jamais fait confiance tel quel, cf. agentBotManager.ts).
      startUrl: typeof payload?.startUrl === "string" ? payload.startUrl : undefined
    });
    return;
  }

  if (command.type === "STOP_BOT") {
    void botManager.stopBot({ commandId: command.commandId, botId: command.botId });
    return;
  }

  if (command.type === "VALIDATE_BOT") {
    void botManager.validateBot({ commandId: command.commandId, botId: command.botId });
    return;
  }

  // Les autres types non geres par ce lot restent refuses
  // honnetement (accuse puis echec explicite), jamais laisses en silence
  // jusqu'au timeout serveur (constraint 9).
  reporter.ack(command.commandId);
  const message = NOT_YET_IMPLEMENTED.has(command.type)
    ? "Cette fonctionnalite n'est pas encore implementee cote agent (lot suivant de la Phase 4)."
    : `Type de commande inconnu de cet agent: ${command.type}.`;
  reporter.failed(command.commandId, "ENGINE_NOT_IMPLEMENTED", message);
  log("warn", `Commande ${command.type} (${command.commandId}) refusee: ${message}`);
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[agentMain] Arret: ${message}`);
  process.exitCode = 1;
});
