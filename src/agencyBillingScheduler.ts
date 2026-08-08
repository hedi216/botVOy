// CHANTIER CIBLE (gestion des echeances et impayes des agences) - scheduler
// leger et borne, meme convention que les setInterval deja existants
// (agentGateway.ts: offline-sweep/command-sweep - tick enveloppe dans un
// .catch dedie, jamais clearInterval, timer permanent pour la duree du
// process). Tourne toutes les heures par defaut; la DECISION de stage reste
// basee sur la date CALENDAIRE Africa/Tunis (agencyBillingService.ts),
// jamais sur l'heure exacte du tick.
import { pool, DbAgency } from "./db.js";
import { sendAppAlert } from "./appAlertService.js";
import { logger } from "./logger.js";
import {
  BillingStage,
  attemptSendBillingStage,
  computeAgencyBillingState,
  diffCalendarDaysInTunis,
  recordBillingTransition,
  stageForExactDiff,
  GRACE_PERIOD_DAYS,
  SendAppAlertFn
} from "./agencyBillingService.js";

export const DEFAULT_BILLING_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;

// Verrou en memoire (correction #5): un tick qui prendrait exceptionnellement
// plus longtemps que l'intervalle ne doit jamais s'executer en parallele
// d'un autre - le tick suivant est alors simplement ignore (jamais mis en
// file d'attente, jamais une double execution concurrente sur la meme agence
// qui risquerait un doublon malgre la contrainte UNIQUE).
let billingSchedulerRunning = false;

export type AgencyBillingTickResult = {
  agenciesProcessed: number;
  stagesAttempted: number;
  skippedAlreadyRunning: boolean;
};

export type AgencyBillingTickOptions = {
  now?: Date;
  sendAlert?: SendAppAlertFn;
};

export const runAgencyBillingTick = async (
  options: AgencyBillingTickOptions = {}
): Promise<AgencyBillingTickResult> => {
  if (billingSchedulerRunning) {
    logger.warn("Scheduler billing: tick precedent encore actif, ce tick est ignore (aucun rattrapage en rafale).");
    return { agenciesProcessed: 0, stagesAttempted: 0, skippedAlreadyRunning: true };
  }

  billingSchedulerRunning = true;
  const now = options.now ?? new Date();
  const sendAlert = options.sendAlert ?? sendAppAlert;
  let agenciesProcessed = 0;
  let stagesAttempted = 0;

  try {
    const { rows: agencies } = await pool.query<DbAgency>(
      `SELECT * FROM agencies WHERE next_payment_date IS NOT NULL`
    );

    for (const agency of agencies) {
      agenciesProcessed += 1;
      const state = computeAgencyBillingState(agency, now);

      // Trace "premiere observation de suspension" (jamais la source de
      // verite de accessAllowed, deja calcule ci-dessus) - identique a
      // l'appel effectue depuis la route admin, reutilise ici pour couvrir
      // la transition purement temporelle (aucune action admin).
      await recordBillingTransition(agency.id, agency, state, null);

      if (!state.nextPaymentDate) {
        continue;
      }

      const diffDays = diffCalendarDaysInTunis(state.nextPaymentDate, now);
      let stage: BillingStage | null = stageForExactDiff(diffDays);
      if (!stage && diffDays >= GRACE_PERIOD_DAYS) {
        // Correction #5: SEUL le mail final SUSPENDED peut "rattraper" un
        // tick manque (ex. serveur indisponible exactement a D+7) - jamais
        // les rappels pre-echeance/grace, qui ne partent que sur leur jour
        // calendaire exact (stageForExactDiff renvoie alors null pour tout
        // diffDays > 6 different de ce cas precis).
        stage = "SUSPENDED";
      }
      if (!stage) {
        continue;
      }

      stagesAttempted += 1;
      try {
        const outcome = await attemptSendBillingStage(agency.id, state.nextPaymentDate, stage, sendAlert);
        if (outcome === "failed" || outcome === "no_recipient") {
          logger.warn(`Scheduler billing: notification ${stage} non envoyee pour l'agence ${agency.id} (${outcome}).`);
        }
      } catch (error) {
        logger.error(`Scheduler billing: echec traitement agence ${agency.id} stage ${stage}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    billingSchedulerRunning = false;
  }

  return { agenciesProcessed, stagesAttempted, skippedAlreadyRunning: false };
};

// Demarre au boot (une premiere passe immediate) puis toutes les
// `intervalMs` - jamais clearInterval (timer permanent pour la duree du
// process, meme convention que agentGateway.ts). Retourne le handle pour
// permettre son arret explicite dans les tests uniquement.
export const startAgencyBillingScheduler = (
  intervalMs: number = DEFAULT_BILLING_SCHEDULER_INTERVAL_MS
): NodeJS.Timeout => {
  const tick = (): void => {
    void runAgencyBillingTick().catch((error) => {
      logger.error(`Scheduler billing: tick en erreur: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  tick();
  return setInterval(tick, intervalMs);
};
