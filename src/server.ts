import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { createReadStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Server, Socket } from "socket.io";
import { createBotSession, BotSession, SessionEvent, SessionStatus } from "./sessionManager.js";
import {
  deleteBrowserProfileForAgency,
  listBrowserProfiles,
  reserveStandardProfileForBot
} from "./browserProfileService.js";
import {
  cancelRecordingExtensionPreparation,
  confirmRecordingExtensionPreparation,
  getActivePreparation,
  startProfileExtensionManagement,
  startRecordingExtensionPreparation,
  stopProfileExtensionManagement
} from "./recordingExtensionService.js";
import { logger } from "./logger.js";
import { AuthenticatedRequest, createSession, destroySession, getSessionUser, requireAdmin, requireAgencyManager, requireAuth } from "./auth.js";
import { DbUser } from "./db.js";
import {
  authenticateUser,
  changeOwnPassword,
  createAgency,
  createUser,
  createExtensionLink,
  deleteExtensionLink,
  getAgency,
  getAgencyMonitoringSettings,
  getAgencySettings,
  initUserModule,
  listAgencies,
  listExtensionLinks,
  listUsersForRequester,
  resetUserPassword,
  updateAgency,
  updateAgencyMonitoringSettings,
  updateAgencyRecordingExtensionSettings,
  updateExtensionLink,
  updateUser
} from "./userService.js";
import { notifyUserIfNeeded } from "./notifications.js";
import { sendAppAlert } from "./appAlertService.js";
import { loadAgentCommandConfig, loadAgentGatewayConfig, loadAgentReleaseConfig, loadPhase2FeatureFlags, resolveAgentTlsStartUrl } from "./config.js";
import { getAgentReleaseMetadata, resolveAgentReleaseDownload } from "./agentReleaseService.js";
import { requirePositiveInt, requireValidPort } from "./envValidation.js";
import { createPairingCode, listAgentsForAgency, renameAgent, revokeAgent } from "./agentService.js";
import {
  AgentSnapshot,
  disconnectAgentSocket,
  getConnectedAgentSocket,
  getSnapshotForAgent,
  isAgentReadyForCommands,
  registerAgentNamespace
} from "./agentGateway.js";
import {
  BOT_STATUS_VALUES,
  PublicAgentCommand,
  clearTerminalCommandsForAgency,
  deleteCommandForAgency,
  dispatchAgentCommand,
  failNonTerminalOnRevoke,
  generateBotId,
  getAgentBot,
  getCommandForAgency,
  listAgentBotsForAgency,
  listAgentCommandsForAgency,
  registerAgentBot,
  toPublicAgentCommand,
  toPublicAgentCommandDetail
} from "./agentCommandService.js";

type SessionOwner = {
  userId: number;
  agencyId: number | null;
  botName: string;
  category?: string;
  login?: string;
};

type StoredLog = {
  event: SessionEvent;
  owner: SessionOwner;
  sessionKey: string;
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const preferredPort = requireValidPort("WEB_PORT", process.env.WEB_PORT, 3000);
const maxClients = requirePositiveInt("MAX_CLIENTS_PER_VM", process.env.MAX_CLIENTS_PER_VM, 15);
const agentGatewayConfig = loadAgentGatewayConfig();
const featureFlags = loadPhase2FeatureFlags();
const agentCommandConfig = loadAgentCommandConfig();
const agentReleaseConfig = loadAgentReleaseConfig();
const sessions = new Map<string, BotSession>();
const sessionOwners = new Map<string, SessionOwner>();
const socketUsers = new Map<string, DbUser>();
const selectedSessionBySocket = new Map<string, string>();
const activePrompts = new Map<string, { message: string; owner: SessionOwner }>();
const logHistory: StoredLog[] = [];
let currentPort = preferredPort;

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(path.join(process.cwd(), "public")));

// Routes SPA pour les nouvelles pages Agent (aucun fichier statique
// correspondant): ne servent index.html que si la fonctionnalite est
// activee, pour que ces chemins restent inexistants (404) quand
// AGENT_UI_ENABLED=false, exactement comme avant la Phase 2.
if (featureFlags.agentUiEnabled) {
  app.get(["/agent", "/agent/setup"], (_req, res) => {
    res.sendFile(path.join(process.cwd(), "public", "index.html"));
  });
}

app.post("/api/login", async (req, res) => {
  const { login, password } = req.body as { login?: string; password?: string };
  const user = await authenticateUser(login ?? "", password ?? "");

  if (!user) {
    res.status(401).json({ error: "Login ou mot de passe invalide." });
    return;
  }

  const token = createSession(user);
  res.cookie("rdv_session", token, {
    httpOnly: true,
    sameSite: "lax"
  });
  res.json({ user });
});

app.post("/api/logout", (req, res) => {
  destroySession(req.cookies?.rdv_session as string | undefined);
  res.clearCookie("rdv_session");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});

app.get("/api/client-config", requireAuth, (_req, res) => {
  res.json({
    agentUiEnabled: featureFlags.agentUiEnabled,
    agentDownloadUrl: featureFlags.agentDownloadUrl,
    botExecutionMode: featureFlags.botExecutionMode
  });
});

// Phase 5 (Lot 4, section 4): renvoie la release explicitement configuree
// (jamais une selection arbitraire du contenu du dossier de releases) -
// available:false si l'artefact est absent/invalide, jamais une exception.
app.get("/api/agent/releases/latest", requireAuth, async (_req, res) => {
  try {
    const metadata = await getAgentReleaseMetadata(agentReleaseConfig);
    res.json(metadata);
  } catch (error) {
    logger.error(`Erreur interne /api/agent/releases/latest: ${error instanceof Error ? error.message : String(error)}`);
    res.json({ available: false });
  }
});

const RELEASE_VERSION_PARAM_PATTERN = /^\d+\.\d+\.\d+$/;

// Section 5: version validee strictement, aucun nom de fichier fourni par
// l'utilisateur, streaming (jamais un chargement complet en memoire), aucune
// information sensible (chemin disque) dans une reponse ou un log destine au
// client.
app.get("/api/agent/releases/:version/download", requireAuth, async (req, res) => {
  // Express 5 type req.params[key] en string | string[] (path-to-regexp
  // generique) - notre route n'a qu'un seul segment simple, jamais un
  // tableau en pratique, mais on refuse explicitement ce cas plutot que de
  // forcer un cast non sur.
  const requestedVersion = req.params.version;
  if (typeof requestedVersion !== "string" || !RELEASE_VERSION_PARAM_PATTERN.test(requestedVersion)) {
    res.status(400).json({ error: "Version invalide." });
    return;
  }

  let target;
  try {
    target = await resolveAgentReleaseDownload(agentReleaseConfig, requestedVersion);
  } catch (error) {
    logger.error(`Erreur interne telechargement de release: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({ error: "Erreur interne." });
    return;
  }

  if (!target) {
    res.status(404).json({ error: "Release indisponible." });
    return;
  }

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${target.fileName}"`);
  res.setHeader("Content-Length", String(target.sizeBytes));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");

  const stream = createReadStream(target.filePath);
  stream.on("error", (error) => {
    logger.error(`Erreur de streaming pendant le telechargement d'une release: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Erreur interne." });
    } else {
      res.destroy();
    }
  });
  req.on("close", () => {
    stream.destroy();
  });
  stream.pipe(res);
});

app.post("/api/profile/password", requireAuth, async (req: AuthenticatedRequest, res) => {
  const body = req.body as { currentPassword?: string; newPassword?: string };
  await changeOwnPassword(req.user!.id, body.currentPassword ?? "", body.newPassword ?? "");
  res.json({ ok: true });
});

app.get("/api/agencies", requireAuth, requireAdmin, async (_req, res) => {
  res.json({ agencies: await listAgencies() });
});

app.post("/api/agencies", requireAuth, requireAdmin, async (req, res) => {
  const body = req.body as { name?: string; maxActiveClients?: number; notificationEmail?: string };
  res.json({
    agency: await createAgency(
      body.name ?? "Nouvelle agence",
      body.maxActiveClients ?? 15,
      body.notificationEmail
    )
  });
});

app.patch("/api/agencies/:id", requireAuth, requireAdmin, async (req, res) => {
  const body = req.body as {
    isActive?: boolean;
    maxActiveClients?: number;
    notificationEmail?: string;
  };
  res.json({
    agency: await updateAgency(Number(req.params.id), {
      is_active: body.isActive,
      max_active_clients: body.maxActiveClients,
      notification_email: body.notificationEmail
    })
  });
});

app.get("/api/users", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  res.json({ users: await listUsersForRequester(req.user!) });
});

app.post("/api/users", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  const body = req.body as {
    agencyId?: number;
    login?: string;
    name?: string;
    email?: string;
    photoUrl?: string;
    role?: 1 | 2;
    isActive?: boolean;
  };
  const agencyId = req.user!.role === 0 ? Number(body.agencyId) : Number(req.user!.agency_id);

  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return;
  }

  if (!body.email || !body.email.trim()) {
    res.status(400).json({ error: "L'adresse e-mail est obligatoire." });
    return;
  }

  res.json({
    ...(await createUser({
      agencyId,
      login: body.login ?? "",
      name: body.name ?? body.login ?? "",
      email: body.email,
      photoUrl: body.photoUrl,
      role: body.role ?? 2,
      isActive: body.isActive ?? true
    }))
  });
});

app.patch("/api/users/:id", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  const body = req.body as { name?: string; email?: string; photoUrl?: string; isActive?: boolean; role?: 1 | 2 };
  const role = body.role === 1 || body.role === 2 ? body.role : undefined;
  res.json({
    user: await updateUser(Number(req.params.id), {
      name: body.name,
      email: body.email,
      photo_url: body.photoUrl,
      is_active: body.isActive,
      role
    }, req.user!)
  });
});

app.post("/api/users/:id/reset-password", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  res.json(await resetUserPassword(Number(req.params.id), req.user!));
});

app.get("/api/monitoring-settings", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = req.user!.role === 0
    ? Number(req.query.agencyId)
    : Number(req.user!.agency_id);

  if (![0, 1].includes(req.user!.role) || !agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  res.json({ settings: await getAgencySettings(agencyId) });
});

app.patch("/api/monitoring-settings", requireAuth, async (req: AuthenticatedRequest, res) => {
  const body = req.body as { agencyId?: number };
  const agencyId = req.user!.role === 0
    ? Number(body.agencyId)
    : Number(req.user!.agency_id);

  if (![0, 1].includes(req.user!.role) || !agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  res.json({
    settings: await updateAgencyMonitoringSettings(agencyId, req.body)
  });
});

const getSettingsAgencyId = (user: DbUser, value?: unknown): number | null => {
  if (![0, 1].includes(user.role)) {
    return null;
  }

  if (user.role === 0) {
    const agencyId = Number(value);
    return agencyId ? agencyId : null;
  }

  return user.agency_id ? Number(user.agency_id) : null;
};

// Centralise la resolution de l'agence pour les routes qui agissent "pour son
// agence" (revocation, actions sur un agent...): lit body/query de facon
// defensive (req.body peut etre undefined si la requete n'a pas de payload
// JSON, ex. un POST d'action sans corps) et ecrit elle-meme la reponse 400
// controlee si aucun rattachement n'existe, plutot que de laisser un acces
// direct type `req.body!.agencyId` planter en TypeError.
const requireAgencyId = (req: AuthenticatedRequest, res: express.Response): number | null => {
  const bodyAgencyId = (req.body as { agencyId?: unknown } | undefined)?.agencyId;
  const queryAgencyId = req.query?.agencyId;
  const agencyId = getSettingsAgencyId(req.user!, bodyAgencyId ?? queryAgencyId);

  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return null;
  }

  return agencyId;
};

app.get("/api/extensions", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, req.query.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  res.json({ extensions: await listExtensionLinks(agencyId) });
});

app.post("/api/extensions", requireAuth, async (req: AuthenticatedRequest, res) => {
  const body = req.body as { agencyId?: number; name?: string; installUrl?: string; isActive?: boolean };
  const agencyId = getSettingsAgencyId(req.user!, body.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  res.json({
    extension: await createExtensionLink({
      agencyId,
      name: body.name ?? "Extension",
      installUrl: body.installUrl ?? "",
      isActive: body.isActive ?? true
    })
  });
});

app.patch("/api/extensions/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  const body = req.body as { agencyId?: number; name?: string; installUrl?: string; isActive?: boolean };
  const agencyId = getSettingsAgencyId(req.user!, body.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  res.json({
    extension: await updateExtensionLink(agencyId, Number(req.params.id), body)
  });
});

app.delete("/api/extensions/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, req.query.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  await deleteExtensionLink(agencyId, Number(req.params.id));
  res.json({ ok: true });
});

app.patch("/api/recording-extension/settings", requireAuth, async (req: AuthenticatedRequest, res) => {
  const body = req.body as {
    agencyId?: number;
    enabled?: boolean;
    installUrl?: string | null;
    name?: string | null;
    licenseType?: string | null;
  };
  const agencyId = getSettingsAgencyId(req.user!, body.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  const settings = await updateAgencyRecordingExtensionSettings(agencyId, body);
  res.json({
    settings,
    warning: settings.linkChanged
      ? "Lien modifie: les profils precedemment prets devront etre prepares a nouveau. Les sessions deja ouvertes ne sont pas modifiees."
      : "Les modifications s'appliquent aux prochains demarrages des bots."
  });
});

app.get("/api/recording-extension/profiles", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, req.query.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  res.json({
    profiles: await listBrowserProfiles(agencyId),
    activePreparation: getActivePreparation(agencyId)
  });
});

app.post("/api/recording-extension/prepare", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, (req.body as { agencyId?: number } | undefined)?.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  const settings = (await getAgencySettings(agencyId)).recordingExtension;
  const snapshot = await startRecordingExtensionPreparation(agencyId, settings, {
    onEvent: (level, message, prepareSnapshot) => {
      emitRecordingExtensionStatus(agencyId, {
        level,
        message,
        preparation: prepareSnapshot ?? null
      });
    }
  });
  emitRecordingExtensionStatus(agencyId, { level: "warn", message: snapshot.message, preparation: snapshot });
  res.json({ preparation: snapshot });
});

app.post("/api/recording-extension/confirm", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, (req.body as { agencyId?: number } | undefined)?.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  const profile = await confirmRecordingExtensionPreparation(agencyId);
  emitRecordingExtensionStatus(agencyId, {
    level: "success",
    message: `Profil ${profile.profile_key} marque comme pret apres confirmation utilisateur.`,
    profile
  });
  res.json({ profile });
});

app.post("/api/recording-extension/cancel", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, (req.body as { agencyId?: number } | undefined)?.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  const profile = await cancelRecordingExtensionPreparation(agencyId);
  emitRecordingExtensionStatus(agencyId, {
    level: "warn",
    message: `Preparation annulee pour ${profile.profile_key}.`,
    profile
  });
  res.json({ profile });
});

app.post("/api/recording-extension/profiles/:id/manage", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, (req.body as { agencyId?: number } | undefined)?.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  const preparation = await startProfileExtensionManagement(agencyId, Number(req.params.id));
  emitRecordingExtensionStatus(agencyId, {
    level: "info",
    message: `Gestion des extensions ouverte pour ${preparation.profile.profile_key}.`
  });
  res.json({ preparation });
});

app.post("/api/recording-extension/profiles/:id/stop-management", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, (req.body as { agencyId?: number } | undefined)?.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  stopProfileExtensionManagement(Number(req.params.id));
  emitRecordingExtensionStatus(agencyId, {
    level: "info",
    message: "Fenetre de gestion demandee a la fermeture."
  });
  res.json({ ok: true });
});

app.delete("/api/recording-extension/profiles/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, req.query.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  await deleteBrowserProfileForAgency(agencyId, Number(req.params.id));
  emitRecordingExtensionStatus(agencyId, {
    level: "warn",
    message: "Profil Chrome supprime avec son dossier."
  });
  res.json({ ok: true });
});

app.post("/api/email/test-alert", requireAuth, requireAdmin, async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({
      success: false,
      provider: "brevo",
      message: "Route indisponible en production."
    });
    return;
  }

  const body = req.body as { to?: string; subject?: string; message?: string };

  if (!body.to || !body.to.trim()) {
    res.status(400).json({
      success: false,
      provider: "brevo",
      message: "Le champ 'to' est obligatoire."
    });
    return;
  }

  const result = await sendAppAlert({
    type: "info",
    title: body.subject ?? "Test alerte RendezBot",
    message: body.message ?? "Ceci est un test d'alerte email depuis Brevo.",
    userEmail: body.to,
    data: {
      route: "/api/email/test-alert",
      sandbox: process.env.BREVO_SANDBOX ?? "true"
    }
  });

  res.status(result.success ? 200 : 400).json(result);
});

const resolveViewAgencyId = (user: DbUser, value?: unknown): number | null => {
  if (user.role === 0) {
    const agencyId = Number(value);
    return agencyId ? agencyId : null;
  }

  return user.agency_id ? Number(user.agency_id) : null;
};

app.get("/api/agents", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = resolveViewAgencyId(req.user!, req.query.agencyId);

  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return;
  }

  const agents = await listAgentsForAgency(agencyId);
  const snapshots = await Promise.all(agents.map((agent) => getSnapshotForAgent(agent.id, agentGatewayConfig)));
  res.json({ agents: snapshots.filter((snapshot): snapshot is AgentSnapshot => snapshot !== null) });
});

// Section 17: non necessaires au temps reel (deja couvert par
// agent-command-status), utilises pour recharger l'etat apres une
// reconnexion de la page. DTO toujours passes par toPublicAgentCommand*.
app.get("/api/agent-commands", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = resolveViewAgencyId(req.user!, req.query.agencyId);
  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return;
  }

  const query = req.query as Record<string, string | undefined>;
  const commands = await listAgentCommandsForAgency(agencyId, {
    agentId: query.agentId ? Number(query.agentId) : undefined,
    botId: query.botId,
    status: query.status as never,
    commandType: query.commandType as never,
    limit: query.limit ? Number(query.limit) : undefined,
    offset: query.offset ? Number(query.offset) : undefined
  });

  res.json({
    commands: commands.map((command) => toPublicAgentCommandDetail(command))
  });
});

app.get("/api/agent-commands/:commandId", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = resolveViewAgencyId(req.user!, req.query.agencyId);
  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return;
  }

  const command = await getCommandForAgency(agencyId, String(req.params.commandId));
  if (!command) {
    res.status(404).json({ error: "Commande introuvable." });
    return;
  }

  res.json({ command: toPublicAgentCommandDetail(command) });
});

// Nettoyage rapide de l'historique (section "Bots pilotes par l'agent"):
// supprime uniquement des LIGNES d'historique deja terminees - ne touche
// jamais un profil Chrome, ne coupe jamais un bot, ne revoque jamais un
// agent (deleteCommandForAgency/clearTerminalCommandsForAgency refusent
// elles-memes toute commande/bot encore actif, cf. agentCommandService.ts).
// Meme regle d'isolation que les routes GET ci-dessus: resolveViewAgencyId
// force un non-admin sur SA seule agence, jamais un botId/commandId seul.
app.delete("/api/agent-commands", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = resolveViewAgencyId(req.user!, req.query.agencyId);
  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return;
  }

  const deletedCount = await clearTerminalCommandsForAgency(agencyId);
  res.json({ ok: true, deletedCount });
});

app.delete("/api/agent-commands/:commandId", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = resolveViewAgencyId(req.user!, req.query.agencyId);
  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return;
  }

  const result = await deleteCommandForAgency(agencyId, String(req.params.commandId));
  if (!result.ok) {
    const status = result.reason === "NOT_FOUND" ? 404 : 409;
    const error = result.reason === "NOT_FOUND"
      ? "Commande introuvable."
      : result.reason === "BOT_ACTIVE"
        ? "Ce bot est encore actif: arretez-le avant de supprimer cette ligne."
        : "Cette commande est encore en cours: attendez sa fin avant de la supprimer.";
    res.status(status).json({ error });
    return;
  }

  res.json({ ok: true });
});

app.post("/api/agents/pairing-codes", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  const agencyId = requireAgencyId(req, res);
  if (agencyId === null) {
    return;
  }

  const pairing = await createPairingCode(agencyId, req.user!.id, agentGatewayConfig);
  res.json({ pairing });
});

app.patch("/api/agents/:id", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  const agencyId = requireAgencyId(req, res);
  if (agencyId === null) {
    return;
  }

  // Body toujours defensif (peut etre absent): seul le nom est encore lu ici,
  // agencyId est deja resolu par requireAgencyId ci-dessus.
  const body = (req.body ?? {}) as { name?: unknown };
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "Nom requis." });
    return;
  }

  const agent = await renameAgent(agencyId, Number(req.params.id), body.name);
  const snapshot = await getSnapshotForAgent(agent.id, agentGatewayConfig);
  res.json({ agent: snapshot });
});

app.post("/api/agents/:id/revoke", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  const agencyId = requireAgencyId(req, res);
  if (agencyId === null) {
    return;
  }

  const agentId = Number(req.params.id);
  let agent: Awaited<ReturnType<typeof revokeAgent>>;
  try {
    // revokeAgent filtre par "id = ... AND agency_id = ..." (voir agentService.ts):
    // un agent inexistant et un agent d'une autre agence produisent tous les deux
    // ce meme echec, sans jamais distinguer les deux cas dans la reponse.
    agent = await revokeAgent(agencyId, agentId);
  } catch {
    res.status(404).json({ error: "Agent introuvable." });
    return;
  }

  // Toute commande non terminale doit echouer avec un code distinct
  // (AGENT_REVOKED) AVANT de couper le socket: la deconnexion qui suit
  // declenche aussi son propre nettoyage (agentGateway.ts), mais les clauses
  // WHERE status=... de ce dernier ne trouveront alors plus rien a modifier,
  // sans jamais ecraser AGENT_REVOKED par AGENT_DISCONNECTED.
  const revokedCommands = await failNonTerminalOnRevoke(agent.id);
  for (const command of revokedCommands) {
    emitAgentCommandStatusToAuthorizedSockets(command.agency_id, toPublicAgentCommand(command));
  }
  disconnectAgentSocket(agent.id);

  const snapshot = await getSnapshotForAgent(agent.id, agentGatewayConfig);
  if (snapshot) {
    emitAgentStatusToAuthorizedSockets(agencyId, snapshot);
  }
  res.json({ agent: snapshot });
});

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(`API error: ${error.message}`);

  // Le code metier de ce fichier leve systematiquement des `Error` simples avec
  // un message francais destine a l'utilisateur (ex: "Agent introuvable.").
  // TypeError/RangeError signalent au contraire un acces non defensif (bug),
  // jamais une erreur volontaire: leur message technique ne doit jamais
  // atteindre le client, meme si l'analyse ci-dessus (requireAgencyId, etc.)
  // a deja neutralise les cas connus.
  if (error instanceof TypeError || error instanceof RangeError) {
    res.status(400).json({ error: "Requete invalide." });
    return;
  }

  // Lot 6 (audit final, section 7): CORRECTIF - une erreur brute du pilote
  // PostgreSQL (ex: "invalid input syntax for type uuid: ...") est un objet
  // Error ordinaire, indiscernable ici d'une erreur metier deliberee sans
  // verification supplementaire: elle atteignait donc le client tel quel,
  // avant ce correctif (confirme par un test de securite dedie). Le pilote
  // "pg" expose systematiquement un code SQLSTATE a 5 caracteres
  // (ex: "22P02") sur ces erreurs, jamais present sur les Error metier
  // volontairement levees dans ce fichier: c'est un marqueur fiable pour ne
  // filtrer QUE les erreurs de bas niveau, sans toucher aux messages
  // francais deliberes (ex: "Agence introuvable.") dont ce handler reste
  // par ailleurs le relais legitime.
  const pgErrorCode = (error as { code?: unknown }).code;
  if (typeof pgErrorCode === "string" && /^[0-9A-Z]{5}$/.test(pgErrorCode)) {
    res.status(400).json({ error: "Requete invalide." });
    return;
  }

  res.status(400).json({ error: error.message });
});

const writeServerLock = (port: number): void => {
  currentPort = port;
  const lockPath = path.join(process.cwd(), "artifacts", `server-${port}.lock`);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    port,
    startedAt: new Date().toISOString()
  }, null, 2));
};

const cleanupServerLock = (): void => {
  const lockPath = path.join(process.cwd(), "artifacts", `server-${currentPort}.lock`);
  if (!existsSync(lockPath)) {
    return;
  }

  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
  if (lock.pid === process.pid) {
    unlinkSync(lockPath);
  }
};

const sessionSnapshotsForUser = (user?: DbUser | null) => [...sessions.entries()]
  .filter(([sessionKey]) => {
    const owner = sessionOwners.get(sessionKey);
    return owner && (!user || canSeeOwner(user, owner));
  })
  .map(([sessionKey, session]) => ({
    ...session.snapshot(),
    category: sessionOwners.get(sessionKey)?.category ?? "",
    login: sessionOwners.get(sessionKey)?.login ?? "",
    hasPrompt: activePrompts.has(sessionKey),
    promptMessage: activePrompts.get(sessionKey)?.message ?? ""
  }));

const countAgencySessions = (agencyId: number | null): number =>
  [...sessionOwners.values()].filter((owner) => owner.agencyId === agencyId).length;

const emitMaintenanceToSocket = async (socket: Socket, user?: DbUser | null): Promise<void> => {
  const agency = user?.agency_id ? await getAgency(user.agency_id).catch(() => null) : null;
  const agencyActiveCount = user?.agency_id ? countAgencySessions(user.agency_id) : sessions.size;
  const agencyMaxClients = agency?.max_active_clients ?? maxClients;

  socket.emit("maintenance", {
    pid: process.pid,
    port: currentPort,
    maxClients,
    agencyActiveCount,
    agencyMaxClients,
    activeSessions: sessionSnapshotsForUser(user)
  });
};

const emitMaintenance = (): void => {
  for (const [socketId, socket] of io.sockets.sockets) {
    void emitMaintenanceToSocket(socket, socketUsers.get(socketId));
  }
};

const getUserFromSocket = (socket: Socket): DbUser | null => {
  const cookie = socket.handshake.headers.cookie ?? "";
  const token = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("rdv_session="))?.split("=")[1];
  return getSessionUser(token);
};

const canSeeOwner = (user: DbUser, owner: SessionOwner): boolean => {
  return user.role === 0
    || user.id === owner.userId
    || (Boolean(user.agency_id) && user.agency_id === owner.agencyId);
};

const canManageAgencySettings = (user: DbUser, agencyId: number): boolean =>
  user.role === 0 || (user.role === 1 && user.agency_id === agencyId);

const emitRecordingExtensionStatus = (agencyId: number, payload: Record<string, unknown>): void => {
  for (const [socketId, socket] of io.sockets.sockets) {
    const user = socketUsers.get(socketId);
    if (user && canManageAgencySettings(user, agencyId)) {
      socket.emit("recording-extension-status", { agencyId, ...payload });
    }
  }
};

const canSeeAgencyAgentStatus = (user: DbUser, agencyId: number): boolean =>
  user.role === 0 || user.agency_id === agencyId;

const emitAgentStatusToAuthorizedSockets = (agencyId: number, snapshot: AgentSnapshot): void => {
  for (const [socketId, socket] of io.sockets.sockets) {
    const user = socketUsers.get(socketId);
    if (user && canSeeAgencyAgentStatus(user, agencyId)) {
      socket.emit("agent-status", snapshot);
    }
  }
};

// Meme portee de diffusion que le statut d'agent: un utilisateur voit les
// commandes de sa propre agence (ou toutes, s'il est admin global), jamais
// celles d'une autre agence.
const emitAgentCommandStatusToAuthorizedSockets = (agencyId: number, publicCommand: PublicAgentCommand): void => {
  for (const [socketId, socket] of io.sockets.sockets) {
    const user = socketUsers.get(socketId);
    if (user && canSeeAgencyAgentStatus(user, agencyId)) {
      socket.emit("agent-command-status", publicCommand);
    }
  }
};

// Relie les statuts de bot remontes par un agent au systeme de logs existant
// (page Logs, historique, alertes Brevo): un bot pilote par un agent est
// traite comme un SessionOwner ordinaire pour cette diffusion, meme s'il n'a
// pas de BotSession Playwright locale (cf. agentCommandService.ts).
const emitBotLogFromAgent = (
  agencyId: number,
  botId: string,
  botName: string,
  level: "info" | "warn" | "error" | "success",
  message: string
): void => {
  const bot = getAgentBot(botId);
  const owner: SessionOwner = {
    userId: bot?.ownerUserId ?? 0,
    agencyId,
    botName,
    category: bot?.category ?? "",
    login: ""
  };
  recordLog(owner, makeEvent(level, message), botId);
};

type AgentSelectionResult =
  | { ok: true; agentId: number }
  | { ok: false; code: "AGENT_NOT_CONNECTED" | "AGENT_VERSION_INCOMPATIBLE" | "AGENT_SELECTION_REQUIRED" | "AGENT_SYNCING"; agents?: AgentSnapshot[] };

const AGENT_SELECTION_ERROR_MESSAGES: Record<string, string> = {
  AGENT_NOT_CONNECTED: "Aucun agent local autorise n'est actuellement connecte.",
  AGENT_VERSION_INCOMPATIBLE: "La version de RendezBot Agent doit etre mise a jour avant de lancer un bot.",
  AGENT_SELECTION_REQUIRED: "Plusieurs ordinateurs sont connectes: selectionnez celui qui doit executer ce bot.",
  // Lot 5 (section 9): agent techniquement connecte mais reconciliation
  // (AGENT_RUNTIME_STATUS) pas encore terminee - jamais de commande envoyee
  // avant READY_FOR_COMMANDS.
  AGENT_SYNCING: "Agent connecte - synchronisation en cours. Reessayez dans un instant."
};

// Section 6: choisit l'agent qui recevra la commande. Ne revele jamais qu'un
// agentId demande appartient a une autre agence (meme code generique que
// "non connecte"): la portee par agence vient de listAgentsForAgency, qui ne
// retourne jamais que les agents de CETTE agence.
const selectAgentForCommand = async (agencyId: number, requestedAgentId?: number): Promise<AgentSelectionResult> => {
  const agents = await listAgentsForAgency(agencyId);
  const snapshotsOrNull = await Promise.all(agents.map((agent) => getSnapshotForAgent(agent.id, agentGatewayConfig)));
  const snapshots = snapshotsOrNull.filter((snapshot): snapshot is AgentSnapshot => snapshot !== null);

  if (requestedAgentId) {
    const requested = snapshots.find((snapshot) => snapshot.agentId === requestedAgentId);
    if (!requested) {
      return { ok: false, code: "AGENT_NOT_CONNECTED" };
    }
    if (requested.status === "VERSION_INCOMPATIBLE") {
      return { ok: false, code: "AGENT_VERSION_INCOMPATIBLE" };
    }
    if (requested.status !== "CONNECTED") {
      return { ok: false, code: "AGENT_NOT_CONNECTED" };
    }
    if (!requested.readyForCommands) {
      return { ok: false, code: "AGENT_SYNCING" };
    }
    return { ok: true, agentId: requested.agentId };
  }

  const connected = snapshots.filter((snapshot) => snapshot.status === "CONNECTED");
  const ready = connected.filter((snapshot) => snapshot.readyForCommands);
  if (ready.length === 1) {
    return { ok: true, agentId: ready[0].agentId };
  }
  if (ready.length > 1) {
    return { ok: false, code: "AGENT_SELECTION_REQUIRED", agents: snapshots };
  }
  if (connected.length > 0) {
    // Au moins un agent connecte, mais aucun encore READY_FOR_COMMANDS.
    return { ok: false, code: "AGENT_SYNCING" };
  }

  if (snapshots.some((snapshot) => snapshot.status === "VERSION_INCOMPATIBLE")) {
    return { ok: false, code: "AGENT_VERSION_INCOMPATIBLE" };
  }

  return { ok: false, code: "AGENT_NOT_CONNECTED" };
};

// Section 14: STOP_BOT partage le meme bus generique que START_BOT plutot
// que d'inventer un evenement par type. Toujours envoye a l'agent
// proprietaire du bot (jamais une nouvelle selection), et refuse
// silencieusement si ce bot n'est pas/plus connu (deja arrete, jamais
// demarre en mode agent...): idempotence deja voulue et testee (Lot 2).
const dispatchOwnedAgentCommand = async (
  socket: Socket,
  type: "STOP_BOT",
  botId: string,
  clientRequestId?: string
): Promise<void> => {
  const user = socketUsers.get(socket.id);
  const bot = getAgentBot(botId);
  if (!user || !bot) {
    return;
  }

  const owner: SessionOwner = { userId: bot.ownerUserId, agencyId: bot.agencyId, botName: bot.botName, category: bot.category, login: "" };
  if (!canSeeOwner(user, owner)) {
    return;
  }

  const normalizedClientRequestId = typeof clientRequestId === "string" && clientRequestId.trim()
    ? clientRequestId.trim().slice(0, 100)
    : null;

  try {
    const { command } = await dispatchAgentCommand(
      {
        agencyId: bot.agencyId,
        agentId: bot.agentId,
        botId,
        type,
        publicPayload: {},
        createdByUserId: user.id,
        clientRequestId: normalizedClientRequestId
      },
      {
        config: agentCommandConfig,
        getAgentSocket: getConnectedAgentSocket,
        onChange: (updatedCommand) => emitAgentCommandStatusToAuthorizedSockets(
          updatedCommand.agency_id,
          toPublicAgentCommand(updatedCommand)
        )
      }
    );

    emitOwnedLog(socket, owner, makeEvent("info", `Commande d'arret envoyee a l'agent (id ${command.command_id.slice(0, 8)}).`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Echec du dispatch ${type}: ${message}`);
    emitOwnedLog(socket, owner, makeEvent("error", "Erreur interne lors de l'envoi de la commande a l'agent."));
  }
};

// Section 1 (Lot 3): contrat propre a VALIDATE_BOT, distinct de STOP_BOT
// (idempotent, toujours tente quel que soit l'etat). VALIDATE_BOT n'a de
// sens que si le bot est encore WAITING_FOR_USER: refuser AVANT de creer une
// commande (bot inconnu, autre agence, mauvais etat, agent hors ligne)
// plutot que de faire un aller-retour agent inutile pour un echec deja
// connu du serveur. Ne revele jamais qu'un botId appartient a une autre
// agence: meme code generique (BOT_NOT_RUNNING) que pour un bot inconnu.
const VALIDATE_BOT_ERROR_MESSAGES: Record<string, string> = {
  BOT_NOT_RUNNING: "Ce bot n'est plus actif.",
  AGENT_NOT_CONNECTED: "L'agent proprietaire de ce bot n'est plus connecte.",
  INVALID_BOT_STATE: "Ce bot n'est pas dans un etat permettant la validation.",
  AGENT_SYNCING: "Agent connecte - synchronisation en cours. Reessayez dans un instant."
};

const dispatchValidateBotCommand = async (
  socket: Socket,
  botId: string,
  clientRequestId?: string
): Promise<void> => {
  const user = socketUsers.get(socket.id);
  if (!user) {
    return;
  }

  const bot = getAgentBot(botId);
  if (!bot) {
    socket.emit("bot-status", { botId, status: "error", code: "BOT_NOT_RUNNING" });
    return;
  }

  const owner: SessionOwner = { userId: bot.ownerUserId, agencyId: bot.agencyId, botName: bot.botName, category: bot.category, login: "" };
  if (!canSeeOwner(user, owner)) {
    socket.emit("bot-status", { botId, status: "error", code: "BOT_NOT_RUNNING" });
    return;
  }

  if (bot.botStatus !== "WAITING_FOR_USER") {
    socket.emit("bot-status", { botId, status: "error", code: "INVALID_BOT_STATE" });
    emitOwnedLog(socket, owner, makeEvent("error", VALIDATE_BOT_ERROR_MESSAGES.INVALID_BOT_STATE));
    return;
  }

  if (!getConnectedAgentSocket(bot.agentId)) {
    socket.emit("bot-status", { botId, status: "error", code: "AGENT_NOT_CONNECTED" });
    emitOwnedLog(socket, owner, makeEvent("error", VALIDATE_BOT_ERROR_MESSAGES.AGENT_NOT_CONNECTED));
    return;
  }

  if (!isAgentReadyForCommands(bot.agentId)) {
    socket.emit("bot-status", { botId, status: "error", code: "AGENT_SYNCING" });
    emitOwnedLog(socket, owner, makeEvent("error", VALIDATE_BOT_ERROR_MESSAGES.AGENT_SYNCING));
    return;
  }

  const normalizedClientRequestId = typeof clientRequestId === "string" && clientRequestId.trim()
    ? clientRequestId.trim().slice(0, 100)
    : null;

  try {
    const { command } = await dispatchAgentCommand(
      {
        agencyId: bot.agencyId,
        agentId: bot.agentId,
        botId,
        type: "VALIDATE_BOT",
        publicPayload: {},
        createdByUserId: user.id,
        clientRequestId: normalizedClientRequestId
      },
      {
        config: agentCommandConfig,
        getAgentSocket: getConnectedAgentSocket,
        onChange: (updatedCommand) => emitAgentCommandStatusToAuthorizedSockets(
          updatedCommand.agency_id,
          toPublicAgentCommand(updatedCommand)
        )
      }
    );

    emitOwnedLog(socket, owner, makeEvent("info", `Commande de validation envoyee a l'agent (id ${command.command_id.slice(0, 8)}).`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Echec du dispatch VALIDATE_BOT: ${message}`);
    emitOwnedLog(socket, owner, makeEvent("error", "Erreur interne lors de l'envoi de la commande a l'agent."));
  }
};

registerAgentNamespace(io, agentGatewayConfig, agentCommandConfig, {
  onStatusChange: emitAgentStatusToAuthorizedSockets,
  onCommandChange: emitAgentCommandStatusToAuthorizedSockets,
  onBotLog: emitBotLogFromAgent
});

const emitLogToAuthorizedSockets = (owner: SessionOwner, event: SessionEvent): void => {
  for (const [socketId, socket] of io.sockets.sockets) {
    const user = socketUsers.get(socketId);
    if (user && canSeeOwner(user, owner)) {
      socket.emit("bot-log", event);
    }
  }
};

const emitPromptToAuthorizedSockets = (owner: SessionOwner, message: string, sessionKey: string): void => {
  for (const [socketId, socket] of io.sockets.sockets) {
    const user = socketUsers.get(socketId);
    if (user && canSeeOwner(user, owner)) {
      socket.emit("bot-prompt", { sessionId: sessionKey, botName: owner.botName, message });
    }
  }
};

const emitStatusToAuthorizedSockets = (owner: SessionOwner, sessionKey: string, status: SessionStatus): void => {
  for (const [socketId, socket] of io.sockets.sockets) {
    const user = socketUsers.get(socketId);
    if (user && canSeeOwner(user, owner)) {
      socket.emit("bot-status", { sessionId: sessionKey, botName: owner.botName, status });
    }
  }
};

const recordLog = (owner: SessionOwner, event: SessionEvent, sessionKey: string): void => {
  const visibleEvent = {
    ...event,
    message: `[${owner.botName}] ${event.message}`
  };

  logHistory.unshift({ event: visibleEvent, owner, sessionKey });
  logHistory.splice(300);
  emitLogToAuthorizedSockets(owner, visibleEvent);
  void notifyUserIfNeeded({
    userId: owner.userId,
    level: event.level,
    message: event.message,
    sessionId: sessions.get(sessionKey)?.snapshot().id ?? sessionKey,
    botName: owner.botName
  });
};

const emitOwnedLog = (socket: Socket, owner: SessionOwner | null, event: SessionEvent): void => {
  if (owner) {
    recordLog(owner, event, socket.id);
    return;
  }

  socket.emit("bot-log", event);
};

const makeEvent = (level: SessionEvent["level"], message: string): SessionEvent => ({
  level,
  message,
  timestamp: new Date().toISOString()
});

const findSessionForSocket = (socketId: string): [string, BotSession] | undefined => {
  const selectedSessionKey = selectedSessionBySocket.get(socketId);
  const selectedSession = selectedSessionKey ? sessions.get(selectedSessionKey) : undefined;
  if (selectedSession) {
    return [selectedSessionKey!, selectedSession];
  }

  const user = socketUsers.get(socketId);
  if (!user) {
    return undefined;
  }

  const match = [...sessionOwners.entries()].find(([sessionKey, owner]) => {
    const session = sessions.get(sessionKey);
    return Boolean(session) && canSeeOwner(user, owner);
  });
  if (!match) {
    return undefined;
  }

  const session = sessions.get(match[0]);
  return session ? [match[0], session] : undefined;
};

io.on("connection", (socket) => {
  logger.info(`Interface connectee: ${socket.id}`);

  const connectedUser = getUserFromSocket(socket);
  if (connectedUser) {
    socketUsers.set(socket.id, connectedUser);
    socket.emit(
      "bot-log-history",
      logHistory.filter((entry) => canSeeOwner(connectedUser, entry.owner)).map((entry) => entry.event)
    );

    for (const [sessionKey, prompt] of activePrompts) {
      if (canSeeOwner(connectedUser, prompt.owner)) {
        const session = sessions.get(sessionKey);
        if (session) {
          socket.emit("bot-session", session.snapshot());
        }
        socket.emit("bot-prompt", {
          sessionId: sessionKey,
          botName: prompt.owner.botName,
          message: prompt.message
        });
      }
    }
  }

  void emitMaintenanceToSocket(socket, connectedUser);

  socket.on("start-bot", async (payload?: {
    botName?: string;
    category?: string;
    login?: string;
    password?: string;
    agentId?: number;
    clientRequestId?: string;
  }) => {
    const user = socketUsers.get(socket.id) ?? getUserFromSocket(socket);
    if (!user) {
      socket.emit("bot-log", makeEvent("error", "Connexion utilisateur requise pour demarrer un bot."));
      return;
    }

    socketUsers.set(socket.id, user);
    const fallbackBotNumber = user.agency_id ? countAgencySessions(user.agency_id) + 1 : sessions.size + 1;
    const botName = payload?.botName?.trim() || `Bot ${fallbackBotNumber}`;
    const category = payload?.category?.trim() || "";
    const login = payload?.login?.trim() || "";
    const password = payload?.password || "";
    const owner: SessionOwner = { userId: user.id, agencyId: user.agency_id, botName, category, login };

    // Mode agent: plus de refus systematique (Phase 2) mais un vrai dispatch.
    // Le moteur Chrome/Playwright reste hors de cette phase (Phase 4): aucune
    // reservation de profil local ni aucun lancement de Chrome n'a lieu ici,
    // uniquement la creation et l'envoi d'une commande START_BOT.
    if (featureFlags.botExecutionMode === "agent") {
      const agencyId = owner.agencyId;
      if (!agencyId) {
        emitOwnedLog(socket, owner, makeEvent("error", "Utilisateur sans agence: impossible de demarrer un bot."));
        socket.emit("bot-status", { status: "error", code: "AGENT_NOT_CONNECTED" });
        return;
      }

      // Toute la suite touche la base et le reseau (agent potentiellement
      // deconnecte entre-temps, contrainte SQL, etc.): une erreur ici ne doit
      // jamais devenir une rejection non geree susceptible d'arreter tout le
      // process serveur, seulement un echec de ce demarrage precis.
      try {
        const requestedAgentId = payload?.agentId ? Number(payload.agentId) : undefined;
        const selection = await selectAgentForCommand(agencyId, requestedAgentId);

        if (!selection.ok) {
          emitOwnedLog(socket, owner, makeEvent("error", AGENT_SELECTION_ERROR_MESSAGES[selection.code]));
          socket.emit("bot-status", {
            status: "error",
            code: selection.code,
            ...(selection.code === "AGENT_SELECTION_REQUIRED" ? { agents: selection.agents } : {})
          });
          return;
        }

        const botId = generateBotId();
        registerAgentBot({
          botId,
          agentId: selection.agentId,
          agencyId,
          ownerUserId: owner.userId,
          botName,
          category,
          latestCommandId: "",
          botStatus: null,
          botStatusUpdatedAt: null,
          active: true,
          updatedAt: new Date().toISOString()
        });

        const clientRequestId = typeof payload?.clientRequestId === "string" && payload.clientRequestId.trim()
          ? payload.clientRequestId.trim().slice(0, 100)
          : null;

        // Lot 4 (section 4 du cahier des charges): snapshot public et deja
        // valide des parametres de surveillance de l'agence, transmis une
        // fois pour toutes au demarrage. L'agent le revalide/borne de son
        // cote (defense en profondeur, cf. agentMonitoringSettings.ts):
        // jamais fait confiance tel quel meme si deja normalise ici.
        const monitoringSettings = await getAgencyMonitoringSettings(agencyId);
        const extensionLinks = await listExtensionLinks(agencyId, true);

        // Hotfix 0.1.2 (points 1-3 du cahier des charges): reutilise
        // TARGET_URL (deja la source de verite du flux legacy_vm existant),
        // jamais une entree utilisateur - non sensible, donc transmise dans
        // publicPayload (jamais transientPayload, reserve aux secrets).
        // null si non configure/invalide: c'est alors l'agent qui decide
        // (extension locale -> conserve son propre chargement ; sans
        // extension -> refuse immediatement plutot que de rester bloque sur
        // about:blank pendant plusieurs minutes, cf. agentBotManager.ts).
        const tlsStartUrl = resolveAgentTlsStartUrl();

        const { command, alreadyExisted } = await dispatchAgentCommand(
          {
            agencyId,
            agentId: selection.agentId,
            botId,
            type: "START_BOT",
            publicPayload: { botName, category, monitoringSettings, startUrl: tlsStartUrl.ok ? tlsStartUrl.url : null },
            createdByUserId: user.id,
            clientRequestId,
            // Hotfix 0.1.1: identifiants TLScontact transmis a l'agent
            // UNIQUEMENT via ce canal transient (jamais persiste, voir
            // agentCommandService.ts) - jamais dans publicPayload, jamais
            // dans public_payload/public_result en base, jamais logue.
            transientPayload: (login || password || extensionLinks.length > 0)
              ? { login, password, extensionLinks }
              : undefined
          },
          {
            config: agentCommandConfig,
            getAgentSocket: getConnectedAgentSocket,
            onChange: (updatedCommand) => emitAgentCommandStatusToAuthorizedSockets(
              updatedCommand.agency_id,
              toPublicAgentCommand(updatedCommand)
            )
          }
        );

        emitOwnedLog(socket, owner, makeEvent(
          "info",
          alreadyExisted
            ? `Commande de demarrage deja enregistree pour ce bot (id ${command.command_id.slice(0, 8)}).`
            : `Commande de demarrage envoyee a l'agent (id ${command.command_id.slice(0, 8)}).`
        ));
        // Pas d'emission "agent-command-status" explicite ici: le callback
        // onChange de dispatchAgentCommand a deja diffuse chaque transition
        // (PENDING puis SENT) a tous les sockets autorises de l'agence, y
        // compris celui-ci. Une emission de plus ici ne ferait que dupliquer
        // le dernier evenement deja recu par ce socket.
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Echec du dispatch START_BOT: ${message}`);
        emitOwnedLog(socket, owner, makeEvent("error", "Erreur interne lors de l'envoi de la commande a l'agent."));
        socket.emit("bot-status", { status: "error", code: "DISPATCH_ERROR" });
      }
      return;
    }

    if (user.role !== 0) {
      if (!user.agency_id) {
        emitOwnedLog(socket, owner, makeEvent("error", "Utilisateur sans agence: impossible de demarrer un bot."));
        return;
      }

      const agency = await getAgency(user.agency_id);
      if (!agency?.is_active) {
        emitOwnedLog(socket, owner, makeEvent("error", "Agence inactive: impossible de demarrer un bot."));
        return;
      }

      const activeAgencySessions = [...sessionOwners.values()]
        .filter((sessionOwner) => sessionOwner.agencyId === user.agency_id).length;
      if (activeAgencySessions >= agency.max_active_clients) {
        emitOwnedLog(socket, owner, makeEvent("error", `Limite agence atteinte: ${activeAgencySessions}/${agency.max_active_clients} navigateurs actifs.`));
        return;
      }
    }

    const activeCount = [...sessions.values()].filter((session) => session.isActive()).length;
    if (activeCount >= maxClients) {
      socket.emit("bot-status", { status: "error" });
      emitOwnedLog(socket, owner, makeEvent("error", `Limite VM atteinte: ${activeCount}/${maxClients} clients actifs.`));
      return;
    }

    let sessionKey = "";
    try {
      const agencySettings = await getAgencySettings(owner.agencyId);
      const profileLease = await reserveStandardProfileForBot(owner.agencyId);
      const extensionLinks = owner.agencyId ? await listExtensionLinks(owner.agencyId, true) : [];

      const session = await createBotSession({
        onLog: (event) => recordLog(owner, event, sessionKey),
        onPrompt: (message) => {
          activePrompts.set(sessionKey, { message, owner });
          selectedSessionBySocket.set(socket.id, sessionKey);
          emitPromptToAuthorizedSockets(owner, message, sessionKey);
          void notifyUserIfNeeded({
            userId: owner.userId,
            level: "warn",
            message,
            sessionId: sessions.get(sessionKey)?.snapshot().id ?? sessionKey,
            botName: owner.botName
          });
        },
        onStatus: (status) => {
          emitStatusToAuthorizedSockets(owner, sessionKey, status);
          if (status === "stopped" || status === "error") {
            sessions.delete(sessionKey);
            sessionOwners.delete(sessionKey);
            selectedSessionBySocket.delete(socket.id);
            activePrompts.delete(sessionKey);
            emitMaintenance();
          }
        }
      }, profileLease, botName, agencySettings, { login, password, category }, extensionLinks);

      sessionKey = session.snapshot().id;
      sessions.set(sessionKey, session);
      sessionOwners.set(sessionKey, owner);
      selectedSessionBySocket.set(socket.id, sessionKey);
      socket.emit("bot-session", { ...session.snapshot(), category, login });
      emitMaintenance();
      void session.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      socket.emit("bot-status", { status: "error" });
      emitOwnedLog(socket, owner, makeEvent("error", message));
      emitMaintenance();
    }
  });

  socket.on("select-session", ({ sessionId }: { sessionId?: string }) => {
    if (!sessionId) {
      return;
    }

    const user = socketUsers.get(socket.id);
    const owner = sessionOwners.get(sessionId);
    const session = sessions.get(sessionId);
    if (!user || !owner || !session || !canSeeOwner(user, owner)) {
      return;
    }

    selectedSessionBySocket.set(socket.id, sessionId);
    socket.emit("bot-session", session.snapshot());
    const prompt = activePrompts.get(sessionId);
    if (prompt) {
      socket.emit("bot-prompt", { sessionId, botName: owner.botName, message: prompt.message });
    } else {
      socket.emit("bot-prompt", { sessionId, botName: owner.botName, message: "" });
    }
  });

  socket.on("continue-bot", (payload: { sessionId?: string; botId?: string; clientRequestId?: string } = {}) => {
    if (featureFlags.botExecutionMode === "agent" && payload.botId) {
      void dispatchValidateBotCommand(socket, payload.botId, payload.clientRequestId);
      return;
    }

    const sessionId = payload.sessionId;
    const match = sessionId && sessions.has(sessionId) ? [sessionId, sessions.get(sessionId)!] as [string, BotSession] : findSessionForSocket(socket.id);
    if (!match) {
      return;
    }

    const user = socketUsers.get(socket.id);
    const owner = sessionOwners.get(match[0]);
    if (!user || !owner || !canSeeOwner(user, owner)) {
      return;
    }

    selectedSessionBySocket.set(socket.id, match[0]);
    activePrompts.delete(match[0]);
    match[1].continue();
    emitMaintenance();
  });

  socket.on("pause-bot", ({ sessionId }: { sessionId?: string } = {}) => {
    const match = sessionId && sessions.has(sessionId) ? [sessionId, sessions.get(sessionId)!] as [string, BotSession] : findSessionForSocket(socket.id);
    if (!match) {
      return;
    }

    const user = socketUsers.get(socket.id);
    const owner = sessionOwners.get(match[0]);
    if (!user || !owner || !canSeeOwner(user, owner)) {
      return;
    }

    match[1].pause();
    emitMaintenance();
  });

  socket.on("resume-bot", ({ sessionId }: { sessionId?: string } = {}) => {
    const match = sessionId && sessions.has(sessionId) ? [sessionId, sessions.get(sessionId)!] as [string, BotSession] : findSessionForSocket(socket.id);
    if (!match) {
      return;
    }

    const user = socketUsers.get(socket.id);
    const owner = sessionOwners.get(match[0]);
    if (!user || !owner || !canSeeOwner(user, owner)) {
      return;
    }

    match[1].resume();
    emitMaintenance();
  });

  socket.on("stop-bot", async (payload: { sessionId?: string; botId?: string; clientRequestId?: string } = {}) => {
    if (featureFlags.botExecutionMode === "agent" && payload.botId) {
      void dispatchOwnedAgentCommand(socket, "STOP_BOT", payload.botId, payload.clientRequestId);
      return;
    }

    const sessionId = payload.sessionId;
    const match = sessionId && sessions.has(sessionId) ? [sessionId, sessions.get(sessionId)!] as [string, BotSession] : findSessionForSocket(socket.id);
    if (!match) {
      return;
    }

    const user = socketUsers.get(socket.id);
    const owner = sessionOwners.get(match[0]);
    if (!user || !owner || !canSeeOwner(user, owner)) {
      return;
    }

    await match[1].stop();
    sessions.delete(match[0]);
    sessionOwners.delete(match[0]);
    selectedSessionBySocket.delete(socket.id);
    activePrompts.delete(match[0]);
    emitMaintenance();
  });

  socket.on("stop-session", async ({ sessionId }: { sessionId?: string }) => {
    if (!sessionId) {
      return;
    }

    const user = socketUsers.get(socket.id);
    const owner = sessionOwners.get(sessionId);
    const session = sessions.get(sessionId);
    if (!user || !owner || !session || !canSeeOwner(user, owner)) {
      return;
    }

    await session.stop();
    sessions.delete(sessionId);
    sessionOwners.delete(sessionId);
    activePrompts.delete(sessionId);
    for (const [socketId, selectedSessionId] of selectedSessionBySocket) {
      if (selectedSessionId === sessionId) {
        selectedSessionBySocket.delete(socketId);
      }
    }
    emitMaintenance();
  });

  socket.on("stop-all-sessions", async () => {
    await Promise.all([...sessions.values()].map((session) => session.stop()));
    sessions.clear();
    sessionOwners.clear();
    selectedSessionBySocket.clear();
    activePrompts.clear();
    emitMaintenance();
  });

  socket.on("shutdown-server", async () => {
    await Promise.all([...sessions.values()].map((session) => session.stop()));
    sessions.clear();
    sessionOwners.clear();
    selectedSessionBySocket.clear();
    activePrompts.clear();
    emitMaintenance();
    cleanupServerLock();
    socket.emit("bot-log", makeEvent("warn", "Arret du serveur web demande depuis l'interface."));
    server.close(() => process.exit(0));
  });

  socket.on("disconnect", async () => {
    logger.info(`Interface deconnectee: ${socket.id}`);
    socketUsers.delete(socket.id);
    selectedSessionBySocket.delete(socket.id);
  });
});

const listen = (port: number): void => {
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.warn(`Port ${port} deja utilise, tentative sur ${port + 1}.`);
      listen(port + 1);
      return;
    }

    throw error;
  });

  server.listen(port, () => {
    writeServerLock(port);
    logger.success(`Interface web disponible: http://localhost:${port}`);
    logger.info(`Limite de clients actifs par VM: ${maxClients}`);
    emitMaintenance();
  });
};

listen(preferredPort);

initUserModule().catch((error) => {
  logger.error(`Module utilisateurs indisponible: ${error instanceof Error ? error.message : String(error)}`);
  logger.error("Verifie que PostgreSQL est installe, lance, et accessible avec postgres / SMART.");
});

process.once("exit", cleanupServerLock);
process.once("SIGINT", () => {
  cleanupServerLock();
  process.exit(0);
});
process.once("SIGTERM", () => {
  cleanupServerLock();
  process.exit(0);
});
