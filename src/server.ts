import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
import { loadAgentGatewayConfig } from "./config.js";
import { createPairingCode, listAgentsForAgency, renameAgent, revokeAgent } from "./agentService.js";
import { AgentSnapshot, getSnapshotForAgent, registerAgentNamespace } from "./agentGateway.js";

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
const preferredPort = Number(process.env.WEB_PORT ?? 3000);
const maxClients = Number(process.env.MAX_CLIENTS_PER_VM ?? 15);
const agentGatewayConfig = loadAgentGatewayConfig();
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

registerAgentNamespace(io, agentGatewayConfig, emitAgentStatusToAuthorizedSockets);

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

  socket.on("start-bot", async (payload?: { botName?: string; category?: string; login?: string; password?: string }) => {
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

  socket.on("continue-bot", ({ sessionId }: { sessionId?: string } = {}) => {
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

  socket.on("stop-bot", async ({ sessionId }: { sessionId?: string } = {}) => {
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
