import express from "express";
import cookieParser from "cookie-parser";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Server } from "socket.io";
import { createBotSession, BotSession } from "./sessionManager.js";
import { logger } from "./logger.js";
import { AuthenticatedRequest, createSession, destroySession, getSessionUser, requireAdmin, requireAgencyManager, requireAuth } from "./auth.js";
import { authenticateUser, changeOwnPassword, createAgency, createUser, getAgency, initUserModule, listAgencies, listUsersForRequester, resetUserPassword, setAgencyActive, updateUser } from "./userService.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const preferredPort = Number(process.env.WEB_PORT ?? 3000);
const maxClients = Number(process.env.MAX_CLIENTS_PER_VM ?? 15);
const sessions = new Map<string, BotSession>();
const sessionOwners = new Map<string, { userId: number; agencyId: number | null }>();
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
  const { name, maxActiveClients } = req.body as { name?: string; maxActiveClients?: number };
  res.json({ agency: await createAgency(name ?? "Nouvelle agence", maxActiveClients ?? 15) });
});

app.patch("/api/agencies/:id", requireAuth, requireAdmin, async (req, res) => {
  const { isActive } = req.body as { isActive?: boolean };
  res.json({ agency: await setAgencyActive(Number(req.params.id), Boolean(isActive)) });
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

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(`API error: ${error.message}`);
  res.status(400).json({ error: error.message });
});

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

const sessionSnapshots = () => [...sessions.values()].map((session) => session.snapshot());

const emitMaintenance = (): void => {
  io.emit("maintenance", {
    pid: process.pid,
    port: currentPort,
    maxClients,
    activeSessions: sessionSnapshots()
  });
};

io.on("connection", (socket) => {
  logger.info(`Interface connectee: ${socket.id}`);
  emitMaintenance();

  socket.on("start-bot", async () => {
    const cookie = socket.handshake.headers.cookie ?? "";
    const token = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("rdv_session="))?.split("=")[1];
    const user = getSessionUser(token);
    if (!user) {
      socket.emit("bot-log", {
        level: "error",
        message: "Connexion utilisateur requise pour demarrer un bot.",
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (user.role !== 0) {
      if (!user.agency_id) {
        socket.emit("bot-log", {
          level: "error",
          message: "Utilisateur sans agence: impossible de demarrer un bot.",
          timestamp: new Date().toISOString()
        });
        return;
      }

      const agency = await getAgency(user.agency_id);
      if (!agency?.is_active) {
        socket.emit("bot-log", {
          level: "error",
          message: "Agence inactive: impossible de demarrer un bot.",
          timestamp: new Date().toISOString()
        });
        return;
      }

      const activeAgencySessions = [...sessionOwners.values()]
        .filter((owner) => owner.agencyId === user.agency_id).length;
      if (activeAgencySessions >= agency.max_active_clients) {
        socket.emit("bot-log", {
          level: "error",
          message: `Limite agence atteinte: ${activeAgencySessions}/${agency.max_active_clients} navigateurs actifs.`,
          timestamp: new Date().toISOString()
        });
        return;
      }
    }

    const currentSession = sessions.get(socket.id);
    if (currentSession?.isActive()) {
      socket.emit("bot-log", {
        level: "warn",
        message: "Un bot est deja actif pour cette interface.",
        timestamp: new Date().toISOString()
      });
      return;
    }

    const activeCount = [...sessions.values()].filter((session) => session.isActive()).length;
    if (activeCount >= maxClients) {
      socket.emit("bot-status", { status: "error" });
      socket.emit("bot-log", {
        level: "error",
        message: `Limite VM atteinte: ${activeCount}/${maxClients} clients actifs.`,
        timestamp: new Date().toISOString()
      });
      return;
    }

    const session = await createBotSession({
      onLog: (event) => socket.emit("bot-log", event),
      onPrompt: (message) => socket.emit("bot-prompt", { message }),
      onStatus: (status) => {
        socket.emit("bot-status", { status });
        if (status === "stopped" || status === "error") {
          sessions.delete(socket.id);
          sessionOwners.delete(socket.id);
          emitMaintenance();
        }
      }
    });

    sessions.set(socket.id, session);
    sessionOwners.set(socket.id, { userId: user.id, agencyId: user.agency_id });
    socket.emit("bot-session", session.snapshot());
    emitMaintenance();
    void session.start();
  });

  socket.on("continue-bot", () => {
    sessions.get(socket.id)?.continue();
  });

  socket.on("stop-bot", async () => {
    const session = sessions.get(socket.id);
    if (!session) {
      return;
    }

    await session.stop();
    sessions.delete(socket.id);
    sessionOwners.delete(socket.id);
    emitMaintenance();
  });

  socket.on("stop-all-sessions", async () => {
    await Promise.all([...sessions.values()].map((session) => session.stop()));
    sessions.clear();
    sessionOwners.clear();
    emitMaintenance();
  });

  socket.on("shutdown-server", async () => {
    await Promise.all([...sessions.values()].map((session) => session.stop()));
    sessions.clear();
    sessionOwners.clear();
    emitMaintenance();
    cleanupServerLock();
    socket.emit("bot-log", {
      level: "warn",
      message: "Arret du serveur web demande depuis l'interface.",
      timestamp: new Date().toISOString()
    });
    server.close(() => process.exit(0));
  });

  socket.on("disconnect", async () => {
    logger.info(`Interface deconnectee: ${socket.id}`);
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
