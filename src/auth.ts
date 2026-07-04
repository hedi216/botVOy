import { randomUUID } from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { DbUser } from "./db.js";

const sessions = new Map<string, DbUser>();

export type AuthenticatedRequest = Request & {
  user?: DbUser;
};

export const createSession = (user: DbUser): string => {
  const token = randomUUID();
  sessions.set(token, user);
  return token;
};

export const destroySession = (token?: string): void => {
  if (token) {
    sessions.delete(token);
  }
};

export const getSessionUser = (token?: string): DbUser | null => {
  if (!token) {
    return null;
  }

  return sessions.get(token) ?? null;
};

export const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  const token = req.cookies?.rdv_session as string | undefined;
  const user = getSessionUser(token);

  if (!user) {
    res.status(401).json({ error: "Non authentifie." });
    return;
  }

  req.user = user;
  next();
};

export const requireAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  if (req.user?.role !== 0) {
    res.status(403).json({ error: "Admin requis." });
    return;
  }

  next();
};

export const requireAgencyManager = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
  if (![0, 1].includes(req.user?.role ?? -1)) {
    res.status(403).json({ error: "Role agence requis." });
    return;
  }

  next();
};
