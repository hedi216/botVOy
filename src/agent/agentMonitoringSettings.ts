import { AppConfig } from "../shared/types.js";

// Snapshot public envoye par le serveur dans START_BOT.publicPayload
// (getAgencyMonitoringSettings, cf. userService.ts MonitoringSettings), valide
// et bornee cote agent AVANT tout usage: le serveur borne deja ces valeurs
// (normalizeMonitoringSettings) mais autorise par exemple un cooldown de
// 0ms, ce que l'agent ne doit jamais executer tel quel (section 4 du cahier
// des charges Lot 4: "ne jamais permettre un intervalle nul produisant une
// boucle intensive"). Cette validation est donc une seconde ligne de
// defense independante, jamais une simple redite de celle du serveur.
//
// HOTFIX CIBLE (parametres de surveillance en secondes entieres):
// rateLimitCooldownSeconds remplace rateLimitCooldownMinutes (precision
// exacte a la seconde, jamais tronquee par un Math.trunc en minutes) et
// controlRefreshIntervalSeconds est un nouveau champ (rend configurable
// l'ancienne constante de production AGENT_CONTROL_REFRESH_INTERVAL_MS,
// cf. agentMonitoringRuntime.ts) - ni l'un ni l'autre n'est Picked depuis
// AppConfig (pas d'equivalent direct: AppConfig reste en minutes/optionnel
// en ms respectivement pour ne rien casser cote legacy_vm/orchestrator.ts).
export type AgentMonitoringSettings = Pick<
  AppConfig,
  | "maxParallelScansPerDomain"
  | "monthClickMinDelayMs"
  | "monthClickMaxDelayMs"
  | "botCycleCooldownMinMs"
  | "botCycleCooldownMaxMs"
  | "refreshEveryCycles"
  | "scanMonthCount"
> & {
  controlRefreshIntervalSeconds: number;
  rateLimitCooldownSeconds: number;
};

// Planchers de securite STRICTEMENT internes a l'agent: jamais configurables
// depuis le serveur, precisement pour rester une garde-fou independante.
const MIN_SAFE_DELAY_MS = 500;
const MIN_SAFE_CYCLE_COOLDOWN_MS = 5_000;

// Bornes de production pour les deux nouveaux champs en secondes (alignees
// sur normalizeMonitoringSettings, userService.ts): la encore une seconde
// ligne de defense, jamais une simple redite du serveur.
const CONTROL_REFRESH_MIN_SECONDS = 60;
const CONTROL_REFRESH_MAX_SECONDS = 86_400;
const RATE_LIMIT_MIN_SECONDS = 60;
const RATE_LIMIT_MAX_SECONDS = 86_400;
const DEFAULT_CONTROL_REFRESH_INTERVAL_SECONDS = 1_200;
const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 2_700;

export const DEFAULT_AGENT_MONITORING_SETTINGS: AgentMonitoringSettings = {
  maxParallelScansPerDomain: 1,
  monthClickMinDelayMs: 5_000,
  monthClickMaxDelayMs: 10_000,
  botCycleCooldownMinMs: 120_000,
  botCycleCooldownMaxMs: 240_000,
  refreshEveryCycles: 20,
  scanMonthCount: 0,
  controlRefreshIntervalSeconds: DEFAULT_CONTROL_REFRESH_INTERVAL_SECONDS,
  rateLimitCooldownSeconds: DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS
};

const isSafeFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

// Nombre entier borne [min, max], jamais NaN/Infinity/negatif: toute valeur
// absente ou invalide retombe silencieusement sur fallback (jamais d'echec
// de START_BOT/VALIDATE_BOT pour un parametre malforme, cf. section 4:
// "utiliser des valeurs par defaut sures si un champ optionnel manque").
const boundedInt = (value: unknown, fallback: number, min: number, max: number): number => {
  if (!isSafeFiniteNumber(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
};

// Valide/borne un snapshot brut recu du serveur (payload non fiable par
// nature: JSON reseau) en une config toujours sure a executer. Ne rejette
// jamais: une configuration dangereuse ou incoherente est ramenee a des
// bornes raisonnables plutot que de bloquer le demarrage du bot.
export const validateMonitoringSettings = (
  raw: unknown,
  log?: (level: "warn", message: string) => void
): AgentMonitoringSettings => {
  const input = (raw && typeof raw === "object" ? raw as Record<string, unknown> : {});
  const defaults = DEFAULT_AGENT_MONITORING_SETTINGS;
  const warn = (message: string): void => log?.("warn", message);

  const maxParallelScansPerDomain = boundedInt(input.maxParallelScansPerDomain, defaults.maxParallelScansPerDomain, 1, 5);

  let monthClickMinDelayMs = boundedInt(input.monthClickMinDelayMs, defaults.monthClickMinDelayMs, 0, 600_000);
  if (monthClickMinDelayMs < MIN_SAFE_DELAY_MS) {
    warn(`monthClickMinDelayMs (${monthClickMinDelayMs}ms) sous le plancher de securite: releve a ${MIN_SAFE_DELAY_MS}ms.`);
    monthClickMinDelayMs = MIN_SAFE_DELAY_MS;
  }
  let monthClickMaxDelayMs = boundedInt(input.monthClickMaxDelayMs, defaults.monthClickMaxDelayMs, monthClickMinDelayMs, 600_000);
  if (monthClickMaxDelayMs < monthClickMinDelayMs) {
    monthClickMaxDelayMs = monthClickMinDelayMs;
  }

  let botCycleCooldownMinMs = boundedInt(input.botCycleCooldownMinMs, defaults.botCycleCooldownMinMs, 0, 3_600_000);
  if (botCycleCooldownMinMs < MIN_SAFE_CYCLE_COOLDOWN_MS) {
    warn(`botCycleCooldownMinMs (${botCycleCooldownMinMs}ms) sous le plancher de securite: releve a ${MIN_SAFE_CYCLE_COOLDOWN_MS}ms.`);
    botCycleCooldownMinMs = MIN_SAFE_CYCLE_COOLDOWN_MS;
  }
  let botCycleCooldownMaxMs = boundedInt(input.botCycleCooldownMaxMs, defaults.botCycleCooldownMaxMs, botCycleCooldownMinMs, 3_600_000);
  if (botCycleCooldownMaxMs < botCycleCooldownMinMs) {
    botCycleCooldownMaxMs = botCycleCooldownMinMs;
  }

  const refreshEveryCycles = boundedInt(input.refreshEveryCycles, defaults.refreshEveryCycles, 0, 100);
  const scanMonthCount = boundedInt(input.scanMonthCount, defaults.scanMonthCount, 0, 24);

  const controlRefreshIntervalSeconds = boundedInt(
    input.controlRefreshIntervalSeconds,
    defaults.controlRefreshIntervalSeconds,
    CONTROL_REFRESH_MIN_SECONDS,
    CONTROL_REFRESH_MAX_SECONDS
  );

  // Compat ascendante (Hotfix parametres en secondes): un ancien
  // serveur/payload peut encore n'envoyer que rateLimitCooldownMinutes -
  // convertie sans arrondi destructeur (jamais 30s -> 0 ni 1 minute) avant
  // d'etre bornee comme une vraie valeur en secondes.
  const legacyRateLimitCooldownMinutes = (input as { rateLimitCooldownMinutes?: unknown }).rateLimitCooldownMinutes;
  const rawRateLimitCooldownSeconds = isSafeFiniteNumber(input.rateLimitCooldownSeconds)
    ? input.rateLimitCooldownSeconds
    : isSafeFiniteNumber(legacyRateLimitCooldownMinutes)
      ? legacyRateLimitCooldownMinutes * 60
      : defaults.rateLimitCooldownSeconds;
  const rateLimitCooldownSeconds = boundedInt(
    rawRateLimitCooldownSeconds,
    defaults.rateLimitCooldownSeconds,
    RATE_LIMIT_MIN_SECONDS,
    RATE_LIMIT_MAX_SECONDS
  );

  return {
    maxParallelScansPerDomain,
    monthClickMinDelayMs,
    monthClickMaxDelayMs,
    botCycleCooldownMinMs,
    botCycleCooldownMaxMs,
    refreshEveryCycles,
    scanMonthCount,
    controlRefreshIntervalSeconds,
    rateLimitCooldownSeconds
  };
};

// Construit l'AppConfig complet requis par monitorAppointments() a partir
// d'un snapshot deja valide, en completant les champs restants avec des
// valeurs neutres pour un contexte agent (Chrome deja ouvert/connecte par
// agentBrowserManager.ts, jamais relance par ce module).
//
// CORRECTIF CIBLE (refresh temporel securise toutes les 20 minutes):
// controlRefreshIntervalMs est TOUJOURS renseigne ici (jamais absent) pour
// l'agent - c'est ce qui fait basculer monitorAppointments() (src/shared/
// monitor.ts) sur la cadence en temps reel plutot que sur refreshEveryCycles
// (qui reste dans `settings` uniquement pour retrocompatibilite/legacy_vm,
// et n'est alors plus la cadence principale de l'agent). Parametre requis
// (jamais implicite): l'appelant (agentMonitoringRuntime.ts) est seul
// responsable de resoudre la valeur reelle (snapshot, override test, ou
// constante de compatibilite).
//
// HOTFIX CIBLE (parametres de surveillance en secondes entieres):
// rateLimitCooldownMinutes (AppConfig/orchestrator.ts, inchanges) est
// calculee ici par simple division exacte de rateLimitCooldownSeconds -
// jamais via boundedInt/Math.trunc, pour ne jamais perdre en route une
// precision a la seconde (30s ne doit jamais devenir 0 ni 1 minute).
export const toAppConfig = (
  settings: AgentMonitoringSettings,
  targetUrl: string,
  controlRefreshIntervalMs: number
): AppConfig => ({
  targetUrl,
  connectToExistingChrome: true,
  chromeDebugUrl: "",
  refreshIntervalMs: 0,
  headless: false,
  slowMoMs: 0,
  debugKeepBrowserOpen: true,
  maxRefreshAttempts: 0,
  maxParallelScansPerDomain: settings.maxParallelScansPerDomain,
  monthClickMinDelayMs: settings.monthClickMinDelayMs,
  monthClickMaxDelayMs: settings.monthClickMaxDelayMs,
  botCycleCooldownMinMs: settings.botCycleCooldownMinMs,
  botCycleCooldownMaxMs: settings.botCycleCooldownMaxMs,
  refreshEveryCycles: settings.refreshEveryCycles,
  scanMonthCount: settings.scanMonthCount,
  rateLimitCooldownMinutes: settings.rateLimitCooldownSeconds / 60,
  controlRefreshIntervalMs
});
