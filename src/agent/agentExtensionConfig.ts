import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { AgentExtensionConfigFile, AgentExtensionEntry, AgentExtensionValidationResult } from "./types.js";

// Lot 5 (section 12/13): configuration D'EXTENSIONS STRICTEMENT LOCALE a
// l'agent. Le serveur ne fournit et ne recoit JAMAIS localPath (section 14):
// ce module ne s'importe jamais depuis un contexte serveur.

const CONFIG_FILE_NAME = "extensions.json";
const MANIFEST_FILE_NAME = "manifest.json";
const MAX_CONFIG_ENTRIES = 20;

export const getExtensionConfigPath = (configDir: string): string => path.join(configDir, CONFIG_FILE_NAME);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Refuse toute entree malformee plutot que de la "corriger" silencieusement:
// un fichier de configuration d'extensions est ecrit/edite a la main sur le
// PC agent, une erreur doit etre visible localement (log), jamais masquee.
const parseEntry = (raw: unknown): AgentExtensionEntry | null => {
  if (!isPlainObject(raw)) {
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const localPath = typeof raw.localPath === "string" ? raw.localPath.trim() : "";
  if (!id || !localPath) {
    return null;
  }
  return {
    id: id.slice(0, 100),
    enabled: raw.enabled !== false,
    required: raw.required === true,
    localPath
  };
};

export const loadExtensionConfig = (configDir: string, log?: (level: "warn", message: string) => void): AgentExtensionEntry[] => {
  const configPath = getExtensionConfigPath(configDir);
  if (!existsSync(configPath)) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    log?.("warn", `Configuration d'extensions illisible (${configPath}): ${error instanceof Error ? error.message : String(error)}. Aucune extension chargee.`);
    return [];
  }

  const rawList = isPlainObject(parsed) && Array.isArray((parsed as AgentExtensionConfigFile).extensions)
    ? (parsed as AgentExtensionConfigFile).extensions
    : [];

  const entries: AgentExtensionEntry[] = [];
  for (const rawEntry of rawList.slice(0, MAX_CONFIG_ENTRIES)) {
    const entry = parseEntry(rawEntry);
    if (!entry) {
      log?.("warn", "Entree d'extension ignoree (id ou localPath manquant/invalide dans extensions.json).");
      continue;
    }
    entries.push(entry);
  }
  return entries;
};

// Interdiction de traversal (section 12): le chemin resolu (liens
// symboliques compris, via realpathSync) doit exister et pointer vers un
// dossier reel; on ne restreint pas a un prefixe unique impose (l'agence
// choisit son propre dossier local), mais on refuse tout chemin qui ne
// resout pas vers un dossier existant AVANT de lire quoi que ce soit dedans
// - jamais de lecture hors d'un dossier explicitement designe par cette
// configuration locale.
const resolveExistingDirectory = (rawPath: string): string | null => {
  try {
    if (!existsSync(rawPath) || !statSync(rawPath).isDirectory()) {
      return null;
    }
    return realpathSync(rawPath);
  } catch {
    return null;
  }
};

// Validation minimale du manifest (section 12): doit exister, etre un JSON
// valide, et contenir au moins "manifest_version" et "name" (structure
// minimale d'un manifest Chrome). Jamais d'execution/evaluation du contenu.
const validateManifest = (extensionDir: string): { ok: true; version: string | null } | { ok: false; reason: string } => {
  const manifestPath = path.join(extensionDir, MANIFEST_FILE_NAME);
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    return { ok: false, reason: "manifest.json introuvable" };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, reason: "manifest.json invalide (JSON illisible)" };
  }

  if (!isPlainObject(manifest) || !manifest.manifest_version || !manifest.name) {
    return { ok: false, reason: "manifest.json incomplet (manifest_version/name manquant)" };
  }

  const version = typeof manifest.version === "string" ? manifest.version : null;
  return { ok: true, version };
};

export const validateExtensions = (
  entries: AgentExtensionEntry[],
  log?: (level: "warn", message: string) => void
): AgentExtensionValidationResult[] => {
  return entries.map((entry): AgentExtensionValidationResult => {
    if (!entry.enabled) {
      return { id: entry.id, enabled: false, required: entry.required, status: "disabled", localPath: entry.localPath, version: null, reason: null };
    }

    const resolvedDir = resolveExistingDirectory(entry.localPath);
    if (!resolvedDir) {
      log?.("warn", `Extension "${entry.id}": dossier local introuvable ou invalide.`);
      return { id: entry.id, enabled: true, required: entry.required, status: "not_found", localPath: entry.localPath, version: null, reason: "Dossier local introuvable." };
    }

    const manifestResult = validateManifest(resolvedDir);
    if (!manifestResult.ok) {
      log?.("warn", `Extension "${entry.id}": ${manifestResult.reason}.`);
      return { id: entry.id, enabled: true, required: entry.required, status: "invalid", localPath: entry.localPath, version: null, reason: manifestResult.reason };
    }

    return { id: entry.id, enabled: true, required: entry.required, status: "ok", localPath: resolvedDir, version: manifestResult.version, reason: null };
  });
};

// Jamais transmis au serveur (section 14): uniquement id/configured/valid/
// version, jamais localPath.
export const toPublicExtensionStatus = (results: AgentExtensionValidationResult[]) =>
  results.map((result) => ({
    id: result.id,
    configured: result.status !== "not_found",
    valid: result.status === "ok",
    version: result.version
  }));
