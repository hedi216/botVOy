import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getStateDir } from "./agentStorage.js";
import { writeFileAtomic } from "./agentCredentialStore.js";
import { AgentRuntimeSettings, AgentSingleInstanceLockInfo } from "./types.js";

// Phase 5 (Lot 2, section 9): verrou mono-instance par fichier + PID +
// verification de vivacite - jamais un mutex/named pipe natif (meme
// raisonnement qu'agentDpapi.ts: aucune dependance native, compatible avec un
// futur executable Node SEA qui n'a pas de mecanisme mature d'addons natifs
// embarques). Un fichier JSON simple, non sensible (jamais de credential
// dedans), est suffisant pour detecter une seconde instance sur le meme
// compte Windows.

const LOCK_FILE_NAME = "agent.lock";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseLockInfo = (raw: string): AgentSingleInstanceLockInfo | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") {
    return null;
  }
  const localUiPort = typeof parsed.localUiPort === "number" ? parsed.localUiPort : null;
  return { pid: parsed.pid, localUiPort, startedAt: parsed.startedAt };
};

// Signal 0 ne tue rien: sert uniquement a verifier l'existence du process,
// y compris sous Windows (Node l'implemente via une verification d'existence
// native, pas un vrai signal POSIX).
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export type AcquireResult =
  | { acquired: true }
  | { acquired: false; existing: AgentSingleInstanceLockInfo };

export class AgentSingleInstanceLock {
  private readonly lockFilePath: string;
  private held = false;

  constructor(settings: AgentRuntimeSettings) {
    this.lockFilePath = path.join(getStateDir(settings), LOCK_FILE_NAME);
  }

  // Recuperation controlee apres crash (section 9): un fichier de verrou
  // present mais dont le PID n'est plus vivant est considere perime et
  // repris sans hesitation - jamais suppose "verrou actif d'une autre
  // instance" sans verification reelle de vivacite.
  async tryAcquire(): Promise<AcquireResult> {
    if (existsSync(this.lockFilePath)) {
      const info = parseLockInfo(readFileSync(this.lockFilePath, "utf8"));
      if (info && info.pid !== process.pid && isProcessAlive(info.pid)) {
        return { acquired: false, existing: info };
      }
    }

    this.writeInfo({ pid: process.pid, localUiPort: null, startedAt: new Date().toISOString() });
    this.held = true;
    return { acquired: true };
  }

  updateLocalUiPort(port: number): void {
    if (!this.held) {
      return;
    }
    this.writeInfo({ pid: process.pid, localUiPort: port, startedAt: this.readStartedAt() ?? new Date().toISOString() });
  }

  // Ne supprime JAMAIS le verrou d'une AUTRE instance (section 9): relit et
  // verifie que le PID present est bien le notre avant de retirer le
  // fichier.
  release(): void {
    if (!this.held) {
      return;
    }
    if (existsSync(this.lockFilePath)) {
      const info = parseLockInfo(readFileSync(this.lockFilePath, "utf8"));
      if (info && info.pid === process.pid) {
        rmSync(this.lockFilePath, { force: true });
      }
    }
    this.held = false;
  }

  private readStartedAt(): string | null {
    if (!existsSync(this.lockFilePath)) {
      return null;
    }
    return parseLockInfo(readFileSync(this.lockFilePath, "utf8"))?.startedAt ?? null;
  }

  private writeInfo(info: AgentSingleInstanceLockInfo): void {
    writeFileAtomic(this.lockFilePath, JSON.stringify(info, null, 2));
  }
}

// Comportement du second lancement (section 9): reveille l'interface locale
// existante plutot que d'afficher une erreur technique au client. Best
// effort - une erreur ici ne doit jamais faire planter le second lancement,
// qui doit de toute facon se terminer avec le code 0.
export const openUrlInDefaultBrowser = (url: string): void => {
  if (process.platform !== "win32") {
    return;
  }
  try {
    const child = spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true });
    // Defaut trouve au Lot 3 (verification "aucune dependance a Node
    // installe", PATH vide): spawn() rapporte un ENOENT (cmd introuvable)
    // de maniere ASYNCHRONE via l'evenement "error", jamais via une
    // exception synchrone - un ChildProcess sans handler "error" attache
    // fait planter tout le process agent (comportement par defaut de
    // Node pour un evenement "error" non ecoute), transformant une
    // fonctionnalite de confort (ouvrir un onglet) en crash total de
    // l'agent. Ce handler est necessaire meme si son corps reste vide.
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // best effort uniquement.
  }
};
