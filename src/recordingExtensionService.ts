import { ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { DbBrowserProfile } from "./db.js";
import {
  BrowserProfileLease,
  getInstalledExtensionCount,
  pinInstalledExtensions,
  reserveBrowserProfileById,
  reserveProfileForPreparation,
  updateProfileStatus
} from "./browserProfileService.js";
import { logger } from "./logger.js";
import { MonitorEventLevel } from "./types.js";
import { RecordingExtensionSettings } from "./userService.js";

export type RecordingExtensionPrepareSnapshot = {
  agencyId: number;
  profile: DbBrowserProfile;
  port: number;
  status: "preparing" | "intervention_required" | "error";
  message: string;
};

type PrepareSession = {
  agencyId: number;
  lease: BrowserProfileLease;
  process: ChildProcess;
  port: number;
  closing: boolean;
};

type PrepareCallbacks = {
  onEvent?: (level: MonitorEventLevel, message: string, snapshot?: RecordingExtensionPrepareSnapshot) => void;
};

const prepareSessions = new Map<number, PrepareSession>();
const managementSessions = new Map<number, PrepareSession>();

const getFreePort = async (): Promise<number> => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => {
      if (typeof address === "object" && address?.port) {
        resolve(address.port);
        return;
      }

      reject(new Error("Port libre introuvable."));
    });
  });
});

const waitForChromeDebug = async (port: number): Promise<void> => {
  const deadline = Date.now() + 20_000;
  const url = `http://127.0.0.1:${port}/json/version`;

  while (Date.now() < deadline) {
    const ok = await fetch(url).then((response) => response.ok).catch(() => false);
    if (ok) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Chrome debug non disponible sur le port ${port}.`);
};

export const maskUrlForLog = (value: string): string => {
  try {
    const parsed = new URL(value);
    const suffix = parsed.search ? "?..." : "";
    const path = parsed.pathname.length > 80 ? `${parsed.pathname.slice(0, 80)}...` : parsed.pathname;
    return `${parsed.origin}${path}${suffix}`;
  } catch {
    return value.length > 80 ? `${value.slice(0, 80)}...` : value;
  }
};

const snapshot = (session: PrepareSession, status: RecordingExtensionPrepareSnapshot["status"], message: string): RecordingExtensionPrepareSnapshot => ({
  agencyId: session.agencyId,
  profile: session.lease.profile,
  port: session.port,
  status,
  message
});

export const getActivePreparation = (agencyId: number): RecordingExtensionPrepareSnapshot | null => {
  const session = prepareSessions.get(agencyId);
  return session ? snapshot(session, "intervention_required", "Installation en cours: terminez dans Chrome puis confirmez.") : null;
};

export const startRecordingExtensionPreparation = async (
  agencyId: number,
  settings: RecordingExtensionSettings,
  callbacks: PrepareCallbacks = {}
): Promise<RecordingExtensionPrepareSnapshot> => {
  if (!settings.enabled) {
    throw new Error("Activez l'extension pour cette agence avant de preparer un profil.");
  }

  if (!settings.installUrl) {
    throw new Error("Renseignez un lien d'installation valide avant de preparer un profil.");
  }

  if (prepareSessions.has(agencyId)) {
    throw new Error("Une preparation est deja en cours pour cette agence.");
  }

  const lease = await reserveProfileForPreparation(agencyId);
  const port = await getFreePort();
  const chromePath = process.env.CHROME_EXECUTABLE_PATH
    || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

  const session: PrepareSession = {
    agencyId,
    lease,
    port,
    process: spawn(chromePath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${lease.profile.directory_path}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-search-engine-choice-screen",
      "--new-window",
      settings.installUrl
    ], {
      stdio: "ignore",
      windowsHide: false
    }),
    closing: false
  };

  prepareSessions.set(agencyId, session);
  const openedUrl = maskUrlForLog(settings.installUrl);
  logger.info(`[recording-extension] Chrome preparation lance agence=${agencyId} profil=${lease.profile.profile_key} url=${openedUrl}`);

  const startupError = new Promise<never>((_resolve, reject) => {
    session.process.once("error", reject);
  });

  session.process.once("exit", async (code) => {
    prepareSessions.delete(agencyId);
    session.lease.release();

    if (session.closing) {
      return;
    }

    const message = `Chrome de preparation ferme avant confirmation (code ${code ?? "inconnu"}).`;
    await updateProfileStatus(lease.profile.id, "intervention_required", message).catch(() => undefined);
    callbacks.onEvent?.("warn", message, snapshot(session, "intervention_required", message));
  });

  try {
    await Promise.race([waitForChromeDebug(port), startupError]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.closing = true;
    session.process.kill();
    prepareSessions.delete(agencyId);
    session.lease.release();
    await updateProfileStatus(lease.profile.id, "error", message);
    throw new Error(`Erreur de lancement Chrome: ${message}`);
  }

  const message = "Chrome est ouvert. Terminez l'installation dans Chrome, puis confirmez dans RendezBot.";
  await updateProfileStatus(lease.profile.id, "intervention_required", null);
  callbacks.onEvent?.("warn", message, snapshot(session, "intervention_required", message));
  return snapshot(session, "intervention_required", message);
};

export const confirmRecordingExtensionPreparation = async (agencyId: number): Promise<DbBrowserProfile> => {
  const session = prepareSessions.get(agencyId);
  if (!session) {
    throw new Error("Aucune preparation en cours pour cette agence.");
  }

  session.closing = true;
  session.process.kill();
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  const installedExtensionCount = getInstalledExtensionCount(session.lease.profile.directory_path);
  if (installedExtensionCount === 0) {
    const message = "Aucune extension Chrome detectee dans ce profil. Installez l'extension dans le Chrome de preparation avant de confirmer.";
    const profile = await updateProfileStatus(session.lease.profile.id, "intervention_required", message);
    prepareSessions.delete(agencyId);
    session.lease.release();
    throw new Error(message);
  }

  const profile = await updateProfileStatus(session.lease.profile.id, "ready", null);
  prepareSessions.delete(agencyId);
  session.lease.release();
  return profile;
};

export const cancelRecordingExtensionPreparation = async (agencyId: number): Promise<DbBrowserProfile> => {
  const session = prepareSessions.get(agencyId);
  if (!session) {
    throw new Error("Aucune preparation en cours pour cette agence.");
  }

  session.closing = true;
  const profile = await updateProfileStatus(session.lease.profile.id, "intervention_required", "Preparation annulee par l'utilisateur.");
  session.process.kill();
  prepareSessions.delete(agencyId);
  session.lease.release();
  return profile;
};

export const startProfileExtensionManagement = async (
  agencyId: number,
  profileId: number
): Promise<RecordingExtensionPrepareSnapshot> => {
  if (managementSessions.has(profileId)) {
    throw new Error("Ce profil est deja ouvert en gestion.");
  }

  const lease = await reserveBrowserProfileById(agencyId, profileId);
  const port = await getFreePort();
  const chromePath = process.env.CHROME_EXECUTABLE_PATH
    || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  pinInstalledExtensions(lease.profile.directory_path);

  const session: PrepareSession = {
    agencyId,
    lease,
    port,
    process: spawn(chromePath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${lease.profile.directory_path}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-search-engine-choice-screen",
      "--new-window",
      "chrome://extensions"
    ], {
      stdio: "ignore",
      windowsHide: false
    }),
    closing: false
  };

  managementSessions.set(profileId, session);
  session.process.once("exit", () => {
    managementSessions.delete(profileId);
    session.lease.release();
  });

  const startupError = new Promise<never>((_resolve, reject) => {
    session.process.once("error", reject);
  });

  try {
    await Promise.race([waitForChromeDebug(port), startupError]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.closing = true;
    session.process.kill();
    managementSessions.delete(profileId);
    session.lease.release();
    throw new Error(`Erreur de lancement Chrome: ${message}`);
  }

  return snapshot(session, "intervention_required", "Chrome ouvert sur la gestion des extensions de ce profil.");
};

export const stopProfileExtensionManagement = (profileId: number): boolean => {
  const session = managementSessions.get(profileId);
  if (!session) {
    return false;
  }

  session.closing = true;
  session.process.kill();
  managementSessions.delete(profileId);
  session.lease.release();
  return true;
};
