import { Locator, Page } from "playwright";

export type AppConfig = {
  targetUrl: string;
  connectToExistingChrome: boolean;
  chromeDebugUrl: string;
  refreshIntervalMs: number;
  headless: boolean;
  slowMoMs: number;
  debugKeepBrowserOpen: boolean;
  maxRefreshAttempts: number;
  scanMonthCount: number;
  maxParallelScansPerDomain: number;
  monthClickMinDelayMs: number;
  monthClickMaxDelayMs: number;
  botCycleCooldownMinMs: number;
  botCycleCooldownMaxMs: number;
  refreshEveryCycles: number;
  rateLimitCooldownMinutes: number;
};

export type HumanValidationResult = {
  detected: boolean;
  reason?: string;
};

export type AppointmentAvailabilityResult = {
  detected: boolean;
  textFound?: string;
  dateTimeHint?: string;
};

export type CandidateElementResult = {
  locator: Locator;
  text: string;
};

export type MonitorEventLevel = "info" | "warn" | "error" | "success";

export type SlotDetectedInfo = {
  textFound?: string;
  dateTimeHint?: string;
};

export type MonitorRuntime = {
  botName?: string;
  category?: string;
  log?: (level: MonitorEventLevel, message: string) => void;
  waitForUser?: (message: string) => Promise<void>;
  recoverPage?: (preferredUrl?: string) => Promise<Page | null>;
  recoverWorkflow?: (reason?: string) => Promise<Page | null>;
  waitWhileNotPaused?: () => Promise<void>;
  // Lot 4 (Phase 4): annulation cooperative de la boucle (STOP_BOT cote
  // agent). Optionnel et sans effet si absent: aucun changement de
  // comportement pour le chemin legacy_vm existant.
  signal?: AbortSignal;
  // Lot 4: points d'extension notifiant l'appelant (agent) exactement aux
  // memes endroits ou monitor.ts declenche deja applyRateLimitCooldown /
  // broadcastAppointmentSignal, sans dupliquer cette logique ni exposer de
  // detail Playwright/HTML brut (seules des donnees deja publiques/agregees).
  onRateLimited?: (cooldownMinutes: number) => void;
  onSlotDetected?: (info: SlotDetectedInfo) => void;
  // Lot 4: uniquement autour du refresh periodique canonique
  // (config.refreshEveryCycles), jamais des refresh rapides "mode creneau"
  // (concept distinct). Permet a l'appelant de compter les echecs
  // CONSECUTIFS et de couper la boucle au-dela d'un seuil (section 10:
  // "pas de boucle infinie de refresh"), remis a zero par onRefreshSucceeded.
  onRefreshFailed?: () => void;
  onRefreshSucceeded?: () => void;
  // HOTFIX 0.2.3: declenche UNE SEULE FOIS par episode, exactement quand le
  // refresh simple ET le recovery workflow complet (toutes tentatives
  // bornees, cf. recoverWorkflow) ont echoue - jamais pour un rate limit
  // (qui conserve son propre cooldown/reprise automatique, section 8).
  // Parametre volontairement vide: aucune raison detaillee (qui peut
  // contenir une URL/query string) n'est jamais transmise a l'appelant ici.
  onWorkflowRecoveryFailed?: () => void;
};
