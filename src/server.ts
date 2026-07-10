import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Server, Socket } from "socket.io";
import { createBotSession, BotSession, SessionEvent } from "./sessionManager.js";
import { logger } from "./logger.js";
import { AuthenticatedRequest, createSession, destroySession, getSessionUser, requireAdmin, requireAgencyManager, requireAuth } from "./auth.js";
import { DbUser } from "./db.js";
import {
  authenticateUser,
  changeOwnPassword,
  createAgency,
  createUser,
  getAgency,
  getAgencyMonitoringSettings,
  initUserModule,
  listAgencies,
  listUsersForRequester,
  resetUserPassword,
  updateAgency,
  updateAgencyMonitoringSettings,
  updateUser
} from "./userService.js";
import { notifyAgencyIfNeeded } from "./notifications.js";
import { sendAppAlert } from "./appAlertService.js";

type SessionOwner = {
  userId: number;
  agencyId: number | null;
  botName: string;
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
    photoUrl?: string;
    role?: 1 | 2;
    isActive?: boolean;
  };
  const agencyId = req.user!.role === 0 ? Number(body.agencyId) : Number(req.user!.agency_id);

  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return;
  }

  res.json({
    ...(await createUser({
      agencyId,
      login: body.login ?? "",
      name: body.name ?? body.login ?? "",
      photoUrl: body.photoUrl,
      role: body.role ?? 2,
      isActive: body.isActive ?? true
    }))
  });
});

app.patch("/api/users/:id", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  const body = req.body as { name?: string; photoUrl?: string; isActive?: boolean; role?: 1 | 2 };
  const role = body.role === 1 || body.role === 2 ? body.role : undefined;
  res.json({
    user: await updateUser(Number(req.params.id), {
      name: body.name,
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

  res.json({ settings: await getAgencyMonitoringSettings(agencyId) });
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
  const result = await sendAppAlert({
    type: "info",
    title: body.subject ?? "Test alerte RendezBot",
    message: body.message ?? "Ceci est un test d'alerte email depuis Brevo.",
    userEmail: body.to,
    adminOnly: !body.to,
    data: {
      route: "/api/email/test-alert",
      sandbox: process.env.BREVO_SANDBOX ?? "true"
    }
  });

  res.status(result.success ? 200 : 400).json(result);
});

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(`API error: ${error.message}`);
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

const recordLog = (owner: SessionOwner, event: SessionEvent, sessionKey: string): void => {
  const visibleEvent = {
    ...event,
    message: `[${owner.botName}] ${event.message}`
  };

  logHistory.unshift({ event: visibleEvent, owner, sessionKey });
  logHistory.splice(300);
  emitLogToAuthorizedSockets(owner, visibleEvent);
  void notifyAgencyIfNeeded({
    agencyId: owner.agencyId,
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

  socket.on("start-bot", async (payload?: { botName?: string }) => {
    const user = socketUsers.get(socket.id) ?? getUserFromSocket(socket);
    if (!user) {
      socket.emit("bot-log", makeEvent("error", "Connexion utilisateur requise pour demarrer un bot."));
      return;
    }

    socketUsers.set(socket.id, user);
    const fallbackBotNumber = user.agency_id ? countAgencySessions(user.agency_id) + 1 : sessions.size + 1;
    const botName = payload?.botName?.trim() || `Bot ${fallbackBotNumber}`;
    const owner: SessionOwner = { userId: user.id, agencyId: user.agency_id, botName };

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
    const monitoringSettings = await getAgencyMonitoringSettings(owner.agencyId);
    const session = await createBotSession({
      onLog: (event) => recordLog(owner, event, sessionKey),
      onPrompt: (message) => {
        activePrompts.set(sessionKey, { message, owner });
        selectedSessionBySocket.set(socket.id, sessionKey);
        emitPromptToAuthorizedSockets(owner, message, sessionKey);
        void notifyAgencyIfNeeded({
          agencyId: owner.agencyId,
          level: "warn",
          message,
          sessionId: sessions.get(sessionKey)?.snapshot().id ?? sessionKey,
          botName: owner.botName
        });
      },
      onStatus: (status) => {
        for (const [socketId, connectedSocket] of io.sockets.sockets) {
          const socketUser = socketUsers.get(socketId);
          if (socketUser && canSeeOwner(socketUser, owner) && selectedSessionBySocket.get(socketId) === sessionKey) {
            connectedSocket.emit("bot-status", { sessionId: sessionKey, botName: owner.botName, status });
          }
        }
        if (status === "stopped" || status === "error") {
          sessions.delete(sessionKey);
          sessionOwners.delete(sessionKey);
          selectedSessionBySocket.delete(socket.id);
          activePrompts.delete(sessionKey);
          emitMaintenance();
        }
      }
    }, botName, monitoringSettings);

    sessionKey = session.snapshot().id;
    sessions.set(sessionKey, session);
    sessionOwners.set(sessionKey, owner);
    selectedSessionBySocket.set(socket.id, sessionKey);
    socket.emit("bot-session", session.snapshot());
    emitMaintenance();
    void session.start();
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
