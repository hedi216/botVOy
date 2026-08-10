import { existsSync, renameSync, statSync, unlinkSync, appendFileSync } from "node:fs";
import path from "node:path";
import { AgentRuntimeSettings } from "./types.js";
import { getLogsDir } from "./agentStorage.js";

// "success" est une nuance positive d'info (deja utilisee partout dans
// l'agent), pas un niveau de severite a part entiere: elle partage le rang
// de filtrage d'"info" (cf. LOG_LEVEL_RANK). "debug" est ajoute pour la
// configuration (AGENT_LOG_LEVEL=debug), meme si rien ne l'emet encore.
export type AgentLogLevel = "debug" | "info" | "warn" | "error" | "success";
export type AgentLogFn = (level: AgentLogLevel, message: string) => void;

// Meme liste de sous-chaines interdites que le serveur (agentGateway.ts), mais
// tenue independamment ici: l'agent tourne sur le PC de l'agence, hors du
// process serveur, et ne doit dependre d'aucun module cote serveur pour
// garantir cette regle (defense en profondeur, cf. section 11/12).
const FORBIDDEN_SUBSTRINGS = [
  "token", "secret", "password", "cookie", "code_hash", "codehash",
  "authorization", "set-cookie", "profilepath", "debugport", "apikey", "api_key"
];

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

// Section 11: fonction UNIQUE de redaction appliquee a toute ligne de log
// texte (locale ou destinee au serveur) avant ecriture/emission - en plus de
// redactForLog (structures), pour les cas ou un secret finirait dans une
// simple chaine de caracteres (ex. message d'erreur Playwright qui
// recopierait une URL avec parametres, ou un mot cle sensible glisse dans un
// texte libre). Jamais de contenu HTML complet ni d'URL avec query string.
const SENSITIVE_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\b[A-Za-z0-9_-]*token[A-Za-z0-9_-]*\s*[:=]\s*\S+/gi, "token=[redacted]"],
  [/\b[A-Za-z0-9_-]*password[A-Za-z0-9_-]*\s*[:=]\s*\S+/gi, "password=[redacted]"],
  // .+ (pas \S+): "Authorization: Bearer <token>" a une valeur sur plusieurs
  // mots, \S+ ne masquerait que "Bearer" et laisserait le token en clair.
  [/\bAuthorization\s*:\s*.+/gi, "Authorization: [redacted]"],
  [/\bSet-Cookie\s*:\s*\S+/gi, "Set-Cookie: [redacted]"],
  [/\bcookie\s*[:=]\s*\S+/gi, "cookie=[redacted]"],
  // Exige une paire ouvrante/fermante correspondante (ex: <body>...</body>):
  // un simple texte a chevrons ("pair <CODE_APPARIEMENT>", present dans nos
  // propres messages d'usage) n'a jamais de fermeture correspondante et ne
  // doit donc jamais etre pris pour du HTML a supprimer.
  [/<([a-z][a-z0-9]*)\b[^<>]*>[\s\S]*?<\/\1>/gi, "[html omis]"],
  // URL avec query string: conserve origine + chemin, masque les parametres.
  [/(https?:\/\/[^\s?]+)\?[^\s]*/gi, "$1?[redacted]"]
];

export const redactLogLine = (line: string): string =>
  SENSITIVE_TEXT_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), line);

const LOG_LEVEL_RANK: Record<AgentLogLevel, number> = {
  debug: 0,
  info: 1,
  success: 1,
  warn: 2,
  error: 3
};

const CONFIG_LEVEL_RANK: Record<AgentRuntimeSettings["logLevel"], number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

export const rotateIfNeeded = (filePath: string, maxBytes: number, maxFiles: number): void => {
  if (!existsSync(filePath) || statSync(filePath).size < maxBytes) {
    return;
  }

  const oldest = `${filePath}.${maxFiles}`;
  if (existsSync(oldest)) {
    unlinkSync(oldest);
  }
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const from = `${filePath}.${index}`;
    if (existsSync(from)) {
      renameSync(from, `${filePath}.${index + 1}`);
    }
  }
  renameSync(filePath, `${filePath}.1`);
};

// Section 10: jamais de crash de l'agent a cause du logger - toute erreur
// disque (disque plein, dossier inaccessible, permission refusee) reste
// locale a cette fonction, jamais propagee. Section 11: chaque ligne passe
// par redactLogLine avant d'etre ecrite (defense en profondeur en plus des
// appelants qui evitent deja d'inclure des secrets dans leurs messages).
export const createAgentLogger = (settings: AgentRuntimeSettings): AgentLogFn => {
  const filePath = path.join(getLogsDir(settings), "agent.log");
  const maxBytes = Math.max(1, settings.logMaxFileSizeMb) * 1024 * 1024;
  const maxFiles = Math.max(1, settings.logMaxFiles);
  const minRank = CONFIG_LEVEL_RANK[settings.logLevel];

  return (level, message) => {
    if (LOG_LEVEL_RANK[level] < minRank) {
      return;
    }

    const safeMessage = redactLogLine(message);
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${safeMessage}`;

    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }

    try {
      rotateIfNeeded(filePath, maxBytes, maxFiles);
      appendFileSync(filePath, `${line}\n`, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[agentLocalLogger] Ecriture du log local impossible: ${detail}`);
    }
  };
};

// --------------------------------------------------------------------------
// BUG CIBLE 0.2.4 (nouveaux logs par bot): un fichier DEDIE par EXECUTION de
// bot (jamais un deuxieme pipeline de logging independant - reutilise
// redactLogLine/rotateIfNeeded/getLogsDir ci-dessus, exactement comme
// createAgentLogger). Format exact: nomdubot_DDMMYYYY_HHMMSS.log, heure
// LOCALE du PC (jamais UTC) pour le nom de fichier uniquement - le contenu
// garde les timestamps ISO existants (inchange).
// --------------------------------------------------------------------------

// Caracteres interdits sur Windows (< > : " / \ | ? *) + caracteres de
// controle: remplaces par "_", jamais supprimes silencieusement au point de
// vider la chaine (fallback "bot" ci-dessous si le resultat est vide).
const WINDOWS_FORBIDDEN_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const MAX_BOT_NAME_LENGTH_IN_FILENAME = 60;
const FALLBACK_BOT_NAME = "bot";

// Neutralise toute traversee de chemin ("../", segments ".."/"." isoles)
// AVANT le remplacement caractere-par-caractere ci-dessous, qui ne
// neutraliserait jamais ".." a lui seul (compose uniquement de caracteres
// deja autorises). Slashes/backslashes deja retires ici aussi (jamais
// seulement par WINDOWS_FORBIDDEN_FILENAME_CHARS ensuite, pour ne laisser
// aucune fenetre ou un ".." reconstruit par concatenation redeviendrait actif).
export const sanitizeBotNameForFilename = (raw: string | undefined): string => {
  if (!raw) {
    return FALLBACK_BOT_NAME;
  }
  const withoutTraversal = raw.replace(/\.\.+/g, "_").replace(/[\\/]/g, "_");
  const sanitized = withoutTraversal
    .replace(WINDOWS_FORBIDDEN_FILENAME_CHARS, "_")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "_") // jamais un nom commencant par un point seul (fichier cache/edge case Windows).
    .slice(0, MAX_BOT_NAME_LENGTH_IN_FILENAME);
  return sanitized || FALLBACK_BOT_NAME;
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

// Heure LOCALE du PC (jamais UTC/ISO) - EXCLUSIVEMENT pour le nom de fichier,
// jamais pour le contenu des lignes de log (deja horodate en ISO ci-dessus,
// inchange).
export const formatLocalTimestampForFilename = (date: Date): string =>
  `${pad2(date.getDate())}${pad2(date.getMonth() + 1)}${date.getFullYear()}_${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;

// Collision exceptionnelle (meme botName sanitize + meme seconde precise):
// suffixe numerique, jamais un ecrasement silencieux d'un fichier existant.
export const buildBotLogFileName = (
  botName: string | undefined,
  startedAt: Date,
  fileExistsInLogsDir: (candidateFileName: string) => boolean
): string => {
  const base = `${sanitizeBotNameForFilename(botName)}_${formatLocalTimestampForFilename(startedAt)}`;
  let candidate = `${base}.log`;
  let suffix = 2;
  while (fileExistsInLogsDir(candidate)) {
    candidate = `${base}_${suffix}.log`;
    suffix += 1;
  }
  return candidate;
};

export type BotLogger = { log: AgentLogFn; fileName: string; filePath: string };

// Tee vers le logger partage (baseLog, inchange - agent.log continue de
// recevoir TOUTES les lignes comme avant) ET vers un fichier propre a CE bot.
// Jamais de crash agent a cause de ce fichier dedie (meme garantie que
// createAgentLogger): une erreur d'ecriture reste locale a cette fonction.
export const createBotLogger = (
  settings: AgentRuntimeSettings,
  baseLog: AgentLogFn,
  botName: string | undefined,
  startedAt: Date
): BotLogger => {
  const logsDir = getLogsDir(settings);
  const fileName = buildBotLogFileName(botName, startedAt, (candidate) => existsSync(path.join(logsDir, candidate)));
  const filePath = path.join(logsDir, fileName);
  const maxBytes = Math.max(1, settings.logMaxFileSizeMb) * 1024 * 1024;
  const maxFiles = Math.max(1, settings.logMaxFiles);
  const minRank = CONFIG_LEVEL_RANK[settings.logLevel];

  const log: AgentLogFn = (level, message) => {
    baseLog(level, message);

    if (LOG_LEVEL_RANK[level] < minRank) {
      return;
    }

    const safeMessage = redactLogLine(message);
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${safeMessage}`;

    try {
      rotateIfNeeded(filePath, maxBytes, maxFiles);
      appendFileSync(filePath, `${line}\n`, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[agentLocalLogger] Ecriture du log du bot (${fileName}) impossible: ${detail}`);
    }
  };

  return { log, fileName, filePath };
};
