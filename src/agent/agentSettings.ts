import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { AgentRuntimeSettings, AgentTargetMode } from "./types.js";

// Version locale au runtime agent: independante du numero de version du
// package serveur (rdv-agent/package.json, qui designe le serveur lui-meme,
// pas ce runtime). Alignee par defaut sur AGENT_MIN_VERSION cote serveur
// (config.ts) pour qu'un agent fraichement demarre ne soit jamais rejete
// comme VERSION_INCOMPATIBLE sans configuration explicite.
export const AGENT_VERSION = process.env.AGENT_VERSION?.trim() || "0.1.0";

const numberEnv = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw || !raw.trim()) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Variable d'environnement invalide: ${key}`);
  }
  return value;
};

const resolveTargetMode = (): AgentTargetMode => {
  const raw = process.env.AGENT_TARGET_MODE?.trim();
  if (!raw || raw === "production") {
    return "production";
  }
  if (raw === "fixture") {
    return "fixture";
  }
  throw new Error(
    `AGENT_TARGET_MODE invalide: "${raw}". Valeurs acceptees: "production" (defaut) ou "fixture".`
  );
};

// Emplacement local Windows attendu (sections 7/11/12 du cahier des
// charges): jamais le dossier du projet. AGENT_DATA_DIR reste disponible
// pour les tests automatises (fixture) qui doivent isoler leurs donnees.
const resolveDataRoot = (): string => {
  const override = process.env.AGENT_DATA_DIR?.trim();
  if (override) {
    return override;
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "RendezBot");
  }
  return path.join(os.tmpdir(), "RendezBot");
};

export const loadAgentSettings = (): AgentRuntimeSettings => {
  const targetMode = resolveTargetMode();
  const fixtureUrl = process.env.AGENT_FIXTURE_URL?.trim() || null;

  if (targetMode === "fixture" && !fixtureUrl) {
    throw new Error(
      "AGENT_TARGET_MODE=fixture requiert AGENT_FIXTURE_URL (jamais de site de test utilise implicitement)."
    );
  }

  // AGENT_TARGET_URL: jamais lu depuis la configuration serveur (TARGET_URL
  // appartient a config.ts, cote serveur, hors de portee de l'agent). Vide
  // par defaut: Chrome s'ouvre alors sur about:blank en production tant que
  // cette variable n'est pas fournie explicitement, jamais sur TLScontact
  // sans configuration deliberee (section 10).
  const targetUrl = targetMode === "fixture"
    ? fixtureUrl!
    : (process.env.AGENT_TARGET_URL?.trim() || "about:blank");

  return {
    serverUrl: process.env.AGENT_SERVER_URL?.trim() || `http://localhost:${process.env.WEB_PORT || 3000}`,
    credentialsPath: process.env.AGENT_CREDENTIALS_PATH?.trim()
      || path.join(process.cwd(), ".agent-test-credentials.json"),
    computerName: process.env.AGENT_COMPUTER_NAME?.trim() || os.hostname(),
    version: AGENT_VERSION,
    targetMode,
    fixtureUrl,
    targetUrl,
    maxActiveBots: numberEnv("AGENT_MAX_ACTIVE_BOTS", 15),
    dataRoot: resolveDataRoot()
  };
};
