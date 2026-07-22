import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getProfilesDir } from "./agentStorage.js";
import { AgentRuntimeSettings } from "./types.js";
import { AgentCommandError } from "./agentErrors.js";

// botId est toujours genere par le serveur (generateBotId() dans
// agentCommandService.ts: "bot-<timestamp>-<6 alphanumeriques>"), mais
// l'agent ne doit jamais lui faire confiance aveuglement pour construire un
// chemin de fichier (section 7): whitelist stricte, aucun caractere permettant
// une traversee de chemin (../, separateurs, null byte...).
const BOT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

const sanitizeBotId = (botId: string): string => {
  if (!BOT_ID_PATTERN.test(botId)) {
    throw new AgentCommandError("PROFILE_CREATE_FAILED", `botId invalide refuse: "${botId}"`);
  }
  return botId;
};

// Deuxieme ceinture de securite en plus de la whitelist: le chemin resolu
// doit rester strictement a l'interieur du dossier profils, quelle que soit
// la valeur de botId (meme verification que browserProfileService.ts cote
// serveur pour la suppression de profils).
export const resolveProfileDir = (settings: AgentRuntimeSettings, botId: string): string => {
  const safeBotId = sanitizeBotId(botId);
  const root = path.resolve(getProfilesDir(settings));
  const target = path.resolve(path.join(root, safeBotId));

  if (!target.startsWith(root + path.sep)) {
    throw new AgentCommandError("PROFILE_CREATE_FAILED", `Chemin de profil hors du dossier autorise pour botId="${botId}".`);
  }

  return target;
};

const lockFileName = ".rendezbot-agent.lock";

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export type ProfileLease = {
  profilePath: string;
  release: () => void;
};

// Verrou local par profil (fichier contenant le PID du process agent qui le
// detient): empeche deux bots (ou deux instances d'agent) d'utiliser le meme
// profil Chrome simultanement. Un verrou dont le PID n'est plus vivant est
// considere perime et remplace silencieusement (crash precedent de l'agent).
export const acquireProfileLock = (settings: AgentRuntimeSettings, botId: string): ProfileLease => {
  const profilePath = resolveProfileDir(settings, botId);
  mkdirSync(profilePath, { recursive: true });

  const lockPath = path.join(profilePath, lockFileName);
  if (existsSync(lockPath)) {
    const existing = readFileSync(lockPath, "utf8").trim();
    const existingPid = Number(existing);
    if (Number.isFinite(existingPid) && existingPid !== process.pid && isPidAlive(existingPid)) {
      throw new AgentCommandError("PROFILE_LOCKED", `Profil deja verrouille par le process ${existingPid}.`);
    }
    // Verrou perime (process disparu ou meme process): on le remplace.
  }

  writeFileSync(lockPath, String(process.pid));

  let released = false;
  return {
    profilePath,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      try {
        if (existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
          rmSync(lockPath, { force: true });
        }
      } catch {
        // best effort: un verrou perime sera de toute facon detecte comme
        // mort (PID non vivant) par la prochaine acquisition.
      }
    }
  };
};

// Jamais de suppression automatique agressive (section 7): fonction de
// nettoyage manuel explicite uniquement, jamais appelee par le cycle de vie
// normal START_BOT/STOP_BOT.
export const deleteProfileManually = (settings: AgentRuntimeSettings, botId: string): void => {
  const profilePath = resolveProfileDir(settings, botId);
  rmSync(profilePath, { recursive: true, force: true });
};
