import { existsSync, renameSync, statSync, unlinkSync, appendFileSync } from "node:fs";
import path from "node:path";
import { AgentRuntimeSettings } from "./types.js";
import { getLogsDir } from "./agentStorage.js";

export type AgentLogLevel = "info" | "warn" | "error" | "success";
export type AgentLogFn = (level: AgentLogLevel, message: string) => void;

const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_FILES = 5;

// Meme liste de sous-chaines interdites que le serveur (agentGateway.ts), mais
// tenue independamment ici: l'agent tourne sur le PC de l'agence, hors du
// process serveur, et ne doit dependre d'aucun module cote serveur pour
// garantir cette regle (defense en profondeur, cf. section 12).
const FORBIDDEN_SUBSTRINGS = ["token", "secret", "password", "cookie", "code_hash", "codehash"];

export const redactForLog = (value: unknown, depth = 0): unknown => {
  if (depth > 4 || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactForLog(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SUBSTRINGS.some((forbidden) => key.toLowerCase().includes(forbidden))) {
      result[key] = "[redacted]";
      continue;
    }
    result[key] = redactForLog(nested, depth + 1);
  }
  return result;
};

const rotateIfNeeded = (filePath: string): void => {
  if (!existsSync(filePath) || statSync(filePath).size < MAX_LOG_FILE_BYTES) {
    return;
  }

  const oldest = `${filePath}.${MAX_ROTATED_FILES}`;
  if (existsSync(oldest)) {
    unlinkSync(oldest);
  }
  for (let index = MAX_ROTATED_FILES - 1; index >= 1; index -= 1) {
    const from = `${filePath}.${index}`;
    if (existsSync(from)) {
      renameSync(from, `${filePath}.${index + 1}`);
    }
  }
  renameSync(filePath, `${filePath}.1`);
};

export const createAgentLogger = (settings: AgentRuntimeSettings): AgentLogFn => {
  const filePath = path.join(getLogsDir(settings), "agent.log");

  return (level, message) => {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;

    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }

    try {
      rotateIfNeeded(filePath);
      appendFileSync(filePath, `${line}\n`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[agentLocalLogger] Ecriture du log local impossible: ${detail}`);
    }
  };
};
