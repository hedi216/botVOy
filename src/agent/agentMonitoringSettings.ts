import { AppConfig } from "../shared/types.js";

// Snapshot public envoye par le serveur dans START_BOT.publicPayload
// (getAgencyMonitoringSettings, cf. userService.ts MonitoringSettings), valide
// et bornee cote agent AVANT tout usage: le serveur borne deja ces valeurs
// (normalizeMonitoringSettings) mais autorise par exemple un cooldown de
// 0ms, ce que l'agent ne doit jamais executer tel quel (section 4 du cahier
// des charges Lot 4: "ne jamais permettre un intervalle nul produisant une
// boucle intensive"). Cette validation est donc une seconde ligne de
// defense independante, jamais une simple redite de celle du serveur.
export type AgentMonitoringSettings = Pick<
  AppConfig,
  | "maxParallelScansPerDomain"
  | "monthClickMinDelayMs"
  | "monthClickMaxDelayMs"
  | "botCycleCooldownMinMs"
  | "botCycleCooldownMaxMs"
  | "refreshEveryCycles"
  | "rateLimitCooldownMinutes"
  | "scanMonthCount"
>;

// Planchers de securite STRICTEMENT internes a l'agent: jamais configurables
// depuis le serveur, precisement pour rester une garde-fou independante.
const MIN_SAFE_DELAY_MS = 500;
const MIN_SAFE_CYCLE_COOLDOWN_MS = 5_000;

export const DEFAULT_AGENT_MONITORING_SETTINGS: AgentMonitoringSettings = {
  maxParallelScansPerDomain: 1,
  monthClickMinDelayMs: 5_000,
  monthClickMaxDelayMs: 10_000,
  botCycleCooldownMinMs: 120_000,
  botCycleCooldownMaxMs: 240_000,
  refreshEveryCycles: 20,
  rateLimitCooldownMinutes: 45,
  scanMonthCount: 0
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
  const rateLimitCooldownMinutes = boundedInt(input.rateLimitCooldownMinutes, defaults.rateLimitCooldownMinutes, 1, 1_440);
  const scanMonthCount = boundedInt(input.scanMonthCount, defaults.scanMonthCount, 0, 24);

  return {
    maxParallelScansPerDomain,
    monthClickMinDelayMs,
    monthClickMaxDelayMs,
    botCycleCooldownMinMs,
    botCycleCooldownMaxMs,
    refreshEveryCycles,
    rateLimitCooldownMinutes,
    scanMonthCount
  };
};

// Construit l'AppConfig complet requis par monitorAppointments() a partir
// d'un snapshot deja valide, en completant les champs restants avec des
// valeurs neutres pour un contexte agent (Chrome deja ouvert/connecte par
// agentBrowserManager.ts, jamais relance par ce module).
export const toAppConfig = (
  settings: AgentMonitoringSettings,
  targetUrl: string
): AppConfig => ({
  targetUrl,
  connectToExistingChrome: true,
  chromeDebugUrl: "",
  refreshIntervalMs: 0,
  headless: false,
  slowMoMs: 0,
  debugKeepBrowserOpen: true,
  maxRefreshAttempts: 0,
  ...settings
});
