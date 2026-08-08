// CHANTIER CIBLE (gestion des echeances et impayes des agences).
// Tests: logique temporelle pure (computeAgencyBillingState), scheduler
// (idempotence, non-rattrapage des rappels, rattrapage SUSPENDED, verrou de
// concurrence), destinataires email, ecriture admin (semantique absent/null),
// granularite des evenements, et contournement backend (guard central).
//
// Aucun test n'envoie jamais un vrai email: la section 1/2 injecte une
// fonction sendAlert factice (jamais sendAppAlert reel), et la section 3
// (serveur reel spawn) cree/suspend ses agences de test SEULEMENT apres le
// demarrage du serveur - le tick immediat du scheduler au boot (qui, lui,
// utilise le vrai sendAppAlert) s'est deja execute avant qu'elles existent,
// et le tick suivant n'arrive qu'apres 1h (DEFAULT_BILLING_SCHEDULER_INTERVAL_MS),
// largement apres la fin du test.
//
// Usage: npx tsx scripts/test-agency-billing.ts

import { ChildProcess, spawn } from "node:child_process";
import { Socket, io as ioClient } from "socket.io-client";
import { pool } from "../src/db.js";
import { initUserModule, createAgency, createUser } from "../src/userService.js";
import {
  computeAgencyBillingState,
  diffCalendarDaysInTunis,
  todayInTunis,
  toDateOnlyString,
  resolveAgencyBillingRecipients,
  recordBillingTransition,
  updateAgencyBilling,
  AgencyBillingRow,
  SendAppAlertFn,
  attemptSendBillingStage,
  parseOverrideUntilInput
} from "../src/agencyBillingService.js";
import { runAgencyBillingTick } from "../src/agencyBillingScheduler.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();

let passCount = 0;
let failCount = 0;

const log = (label: string, message: string): void => {
  console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
};

const assert = (condition: boolean, description: string): void => {
  if (condition) {
    passCount += 1;
    console.log(`[PASS] ${description}`);
  } else {
    failCount += 1;
    console.error(`[FAIL] ${description}`);
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Arithmetique JOUR CALENDAIRE pure (memes bases que dayNumberFromDateOnly
// dans agencyBillingService.ts: Date.UTC sur les composants Y/M/D d'une
// chaine 'YYYY-MM-DD', jamais une vraie duree en millisecondes) - permet de
// deriver des dates de test relatives a "aujourd'hui" sans dependre d'une
// horloge figee ni recalculer une logique de fuseau deja testee ailleurs.
const dateOnlyPlusDays = (base: string, days: number): string => {
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
};

const NOW = new Date();
const TODAY = todayInTunis(NOW);

// --------------------------------------------------------------------------
// Section 1: computeAgencyBillingState (pure, aucune DB)
// --------------------------------------------------------------------------

const runPureStateTests = (): void => {
  log("SECTION", "1) computeAgencyBillingState - logique temporelle pure");

  const rowNotConfigured: AgencyBillingRow = { next_payment_date: null, billing_override_until: null, payment_suspended_at: null };
  const s1 = computeAgencyBillingState(rowNotConfigured, NOW);
  assert(s1.status === "not_configured" && s1.accessAllowed === true, "A) next_payment_date NULL -> not_configured, accessAllowed=true (retro-compat migration)");

  const rowFuture: AgencyBillingRow = { next_payment_date: dateOnlyPlusDays(TODAY, 5), billing_override_until: null, payment_suspended_at: null };
  const s2 = computeAgencyBillingState(rowFuture, NOW);
  assert(s2.status === "current" && s2.accessAllowed === true, "B) Echeance dans 5 jours -> current, accessAllowed=true");

  const rowDueToday: AgencyBillingRow = { next_payment_date: TODAY, billing_override_until: null, payment_suspended_at: null };
  const s3 = computeAgencyBillingState(rowDueToday, NOW);
  assert(s3.status === "due_today" && s3.accessAllowed === true && s3.overdueDays === 0, "C) Echeance aujourd'hui -> due_today, accessAllowed=true, overdueDays=0");

  const rowGrace1: AgencyBillingRow = { next_payment_date: dateOnlyPlusDays(TODAY, -1), billing_override_until: null, payment_suspended_at: null };
  const s4 = computeAgencyBillingState(rowGrace1, NOW);
  assert(s4.status === "grace_period" && s4.accessAllowed === true && s4.graceDaysRemaining === 6, "D) Retard de 1 jour (D+1) -> grace_period, accessAllowed=true, 6 jours restants");

  const rowGrace6: AgencyBillingRow = { next_payment_date: dateOnlyPlusDays(TODAY, -6), billing_override_until: null, payment_suspended_at: null };
  const s5 = computeAgencyBillingState(rowGrace6, NOW);
  assert(s5.status === "grace_period" && s5.accessAllowed === true && s5.graceDaysRemaining === 1, "E) Retard de 6 jours (D+6) -> grace_period, accessAllowed=true, 1 jour restant (dernier jour de grace)");

  const rowSuspended7: AgencyBillingRow = { next_payment_date: dateOnlyPlusDays(TODAY, -7), billing_override_until: null, payment_suspended_at: null };
  const s6 = computeAgencyBillingState(rowSuspended7, NOW);
  assert(s6.status === "suspended" && s6.accessAllowed === false, "F) Retard de 7 jours (D+7) -> suspended, accessAllowed=false");

  const rowSuspended30: AgencyBillingRow = { next_payment_date: dateOnlyPlusDays(TODAY, -30), billing_override_until: null, payment_suspended_at: null };
  const s7 = computeAgencyBillingState(rowSuspended30, NOW);
  assert(s7.status === "suspended" && s7.accessAllowed === false, "G) Retard de 30 jours -> reste suspended (pas de deuxieme etat au-dela de D+7)");

  const overrideFuture = new Date(NOW.getTime() + 3_600_000).toISOString();
  const rowOverrideOnSuspended: AgencyBillingRow = { next_payment_date: dateOnlyPlusDays(TODAY, -10), billing_override_until: overrideFuture, payment_suspended_at: null };
  const s8 = computeAgencyBillingState(rowOverrideOnSuspended, NOW);
  assert(s8.status === "override" && s8.accessAllowed === true, "H) Autorisation temporaire future active sur une agence en retard de 10 jours -> override, accessAllowed=true (jamais suspended)");

  const overridePast = new Date(NOW.getTime() - 3_600_000).toISOString();
  const rowOverrideExpired: AgencyBillingRow = { next_payment_date: dateOnlyPlusDays(TODAY, -10), billing_override_until: overridePast, payment_suspended_at: null };
  const s9 = computeAgencyBillingState(rowOverrideExpired, NOW);
  assert(s9.status === "suspended" && s9.accessAllowed === false, "I) Autorisation temporaire EXPIREE -> retombe sur l'etat reel sous-jacent (suspended), jamais accessAllowed=true par erreur");

  const rowFutureResetsSuspicion: AgencyBillingRow = { next_payment_date: dateOnlyPlusDays(TODAY, 5), billing_override_until: null, payment_suspended_at: new Date(NOW.getTime() - 86_400_000).toISOString() };
  const s10 = computeAgencyBillingState(rowFutureResetsSuspicion, NOW);
  assert(
    s10.status === "current" && s10.accessAllowed === true,
    "Correction #6) payment_suspended_at renseigne en base mais next_payment_date desormais future -> current/accessAllowed=true quand meme (payment_suspended_at n'est JAMAIS la source de verite)"
  );

  // Robustesse du calcul calendaire Africa/Tunis autour d'un changement d'annee
  // (jamais un piege UTC/heures - diffCalendarDaysInTunis compare des JOURS).
  const dec30 = "2025-12-30";
  const jan05 = "2026-01-05";
  const diffAcrossYear = diffCalendarDaysInTunis(dec30, new Date(`${jan05}T12:00:00Z`));
  assert(diffAcrossYear === 6, `J) diffCalendarDaysInTunis traverse une frontiere d'annee correctement (30/12->05/01 = 6 jours, obtenu: ${diffAcrossYear})`);

  assert(/^\d{4}-\d{2}-\d{2}$/.test(TODAY), "K) todayInTunis() renvoie un format 'YYYY-MM-DD' exploitable directement comme DATE Postgres");

  assert(toDateOnlyString("2026-03-15") === "2026-03-15", "toDateOnlyString: chaine deja au format DATE Postgres -> inchangee (jamais de reparsing qui risquerait un decalage de fuseau)");

  // --------------------------------------------------------------------------
  // parseOverrideUntilInput: cote frontend, un <input type="datetime-local">
  // renvoie TOUJOURS une chaine "flottante" sans decalage (ex. "2026-08-20T18:00"),
  // jamais convertie par le navigateur quel que soit son fuseau horaire local
  // (comportement standard, garanti par la specification HTML) - confirme par
  // lecture directe de public/app.js: `body: JSON.stringify({ overrideUntil:
  // input.value })`, aucune transformation cote client. C'est donc UNIQUEMENT
  // parseOverrideUntilInput (backend) qui doit interpreter cette chaine comme
  // une heure Africa/Tunis, jamais UTC ni le fuseau du serveur.
  // --------------------------------------------------------------------------
  const savedTz = process.env.TZ;
  // Verifie explicitement que l'interpretation NE DEPEND PAS du fuseau horaire
  // du serveur Node lui-meme (le bug le plus probable serait un `new Date(raw)`
  // implicitement interprete en heure locale du PROCESS, pas de Tunis).
  process.env.TZ = "America/New_York";
  try {
    const parsedNoOffset = parseOverrideUntilInput("2026-08-20T18:00");
    assert(
      parsedNoOffset.toISOString() === "2026-08-20T17:00:00.000Z",
      `Correction timezone override) "20/08/2026 18:00" saisi via <input type="datetime-local"> -> interprete comme 18:00 Africa/Tunis (UTC+1 fixe) = 17:00:00Z, JAMAIS 18:00 UTC ni l'heure locale du serveur (obtenu: ${parsedNoOffset.toISOString()})`
    );

    const parsedWithZ = parseOverrideUntilInput("2026-08-20T18:00Z");
    assert(
      parsedWithZ.toISOString() === "2026-08-20T18:00:00.000Z",
      `parseOverrideUntilInput: une chaine avec decalage EXPLICITE ('Z') est respectee telle quelle, jamais un +01:00 applique en plus (obtenu: ${parsedWithZ.toISOString()})`
    );

    const parsedWithOffset = parseOverrideUntilInput("2026-08-20T18:00+03:00");
    assert(
      parsedWithOffset.toISOString() === "2026-08-20T15:00:00.000Z",
      `parseOverrideUntilInput: une chaine avec un decalage explicite different (+03:00) est respectee telle quelle, jamais reinterpretee comme Tunis (obtenu: ${parsedWithOffset.toISOString()})`
    );
  } finally {
    if (savedTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = savedTz;
    }
  }
};

// --------------------------------------------------------------------------
// Section 2: scheduler + service (DB reelle, sendAlert et horloge injectes -
// JAMAIS sendAppAlert reel dans cette section)
// --------------------------------------------------------------------------

type FakeAlertCall = { title: string; message: string; userEmail: string | string[] };

const makeFakeSendAlert = (succeed = true): { fn: SendAppAlertFn; calls: FakeAlertCall[] } => {
  const calls: FakeAlertCall[] = [];
  const fn: SendAppAlertFn = async (input) => {
    calls.push({ title: input.title, message: input.message, userEmail: input.userEmail });
    return succeed
      ? { success: true, provider: "smtp", message: "ok (test, aucun envoi reel)" }
      : { success: false, provider: "smtp", message: "echec simule (test)" };
  };
  return { fn, calls };
};

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

// notification_email systematiquement renseigne (adresse factice @example.test,
// jamais utilisee reellement ici): sans destinataire resolu, attemptSendBillingStage
// s'arrete a "no_recipient" AVANT meme d'appeler sendAlert, ce qui empecherait
// de verifier le comportement du sendAlert factice sur les tests L/M/N/P/Q.
const makeTestAgency = async (label: string, nextPaymentDate: string | null): Promise<number> => {
  const name = `Test Billing ${label} ${RUN_SUFFIX}`;
  createdAgencyNames.push(name);
  const agency = await createAgency(name, 15, `billing-test-${label.toLowerCase()}-${RUN_SUFFIX}@example.test`);
  if (nextPaymentDate) {
    await pool.query("UPDATE agencies SET next_payment_date = $2 WHERE id = $1", [agency.id, nextPaymentDate]);
  }
  return agency.id;
};

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) {
    await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  }
  if (createdAgencyNames.length > 0) {
    await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
  }
};

const runServiceAndSchedulerTests = async (): Promise<void> => {
  log("SECTION", "2) Service + scheduler (DB reelle, sendAlert factice injecte)");

  const adminRow = await pool.query<{ id: number }>("SELECT id FROM users WHERE login = $1", [ADMIN_LOGIN]);
  const adminUserId = adminRow.rows[0].id;

  // --- L/M) attemptSendBillingStage: idempotence + retry apres echec ---
  {
    const agencyId = await makeTestAgency("Idempotence", dateOnlyPlusDays(TODAY, 7));
    const dueDate = dateOnlyPlusDays(TODAY, 7);
    const { fn: sendAlert, calls } = makeFakeSendAlert(true);

    const first = await attemptSendBillingStage(agencyId, dueDate, "D_MINUS_7", sendAlert);
    assert(first === "sent" && calls.length === 1, "L) attemptSendBillingStage: premier appel envoie effectivement (sendAlert factice appele une fois)");

    const second = await attemptSendBillingStage(agencyId, dueDate, "D_MINUS_7", sendAlert);
    assert(second === "already_sent" && calls.length === 1, "L) attemptSendBillingStage: deuxieme appel identique -> already_sent, sendAlert NON rappele (idempotent via sent_at)");

    const { fn: failingSendAlert, calls: failingCalls } = makeFakeSendAlert(false);
    const agencyId2 = await makeTestAgency("RetrySucces", dateOnlyPlusDays(TODAY, 2));
    const dueDate2 = dateOnlyPlusDays(TODAY, 2);
    const failedAttempt = await attemptSendBillingStage(agencyId2, dueDate2, "D_MINUS_2", failingSendAlert);
    assert(failedAttempt === "failed" && failingCalls.length === 1, "M) attemptSendBillingStage: echec d'envoi -> 'failed', sent_at reste NULL");
    const row = await pool.query<{ sent_at: string | null; last_error: string | null }>(
      "SELECT sent_at, last_error FROM agency_billing_notifications WHERE agency_id = $1 AND stage = 'D_MINUS_2'",
      [agencyId2]
    );
    assert(row.rows[0]?.sent_at === null && Boolean(row.rows[0]?.last_error), "M) sent_at NULL et last_error rempli apres un echec -> retry autorise au tick suivant");

    const { fn: retrySendAlert, calls: retryCalls } = makeFakeSendAlert(true);
    const retryOutcome = await attemptSendBillingStage(agencyId2, dueDate2, "D_MINUS_2", retrySendAlert);
    assert(retryOutcome === "sent" && retryCalls.length === 1, "M) Retry apres echec: la meme ligne (meme stage/date) est retentee et reussit");
  }

  // --- N/O/P) runAgencyBillingTick: stage exact, non-rattrapage, rattrapage SUSPENDED ---
  {
    const agencyExactDMinus7 = await makeTestAgency("TickDMinus7", dateOnlyPlusDays(TODAY, 7));
    const agencyLateDMinus6 = await makeTestAgency("TickLateNoRattrapage", dateOnlyPlusDays(TODAY, 6));
    const agencyOverdue10 = await makeTestAgency("TickCatchupSuspended", dateOnlyPlusDays(TODAY, -10));

    const { fn: sendAlert, calls } = makeFakeSendAlert(true);
    const result = await runAgencyBillingTick({ now: NOW, sendAlert });

    assert(result.skippedAlreadyRunning === false, "N) runAgencyBillingTick s'execute normalement (pas de verrou actif)");

    const dMinus7Row = await pool.query("SELECT sent_at FROM agency_billing_notifications WHERE agency_id = $1 AND stage = 'D_MINUS_7'", [agencyExactDMinus7]);
    assert(Boolean(dMinus7Row.rows[0]?.sent_at), "N) Agence exactement a D-7 -> notification D_MINUS_7 envoyee par le tick");

    const dMinus7LateRow = await pool.query("SELECT 1 FROM agency_billing_notifications WHERE agency_id = $1 AND stage = 'D_MINUS_7'", [agencyLateDMinus6]);
    assert(
      dMinus7LateRow.rowCount === 0,
      "Correction #5/O) Agence a D-6 (le tick a 'rate' D-7, ex. serveur indisponible) -> AUCUN rattrapage du rappel D_MINUS_7 (les rappels pre-echeance ne rattrapent jamais)"
    );

    const suspendedRow = await pool.query("SELECT sent_at FROM agency_billing_notifications WHERE agency_id = $1 AND stage = 'SUSPENDED'", [agencyOverdue10]);
    assert(
      Boolean(suspendedRow.rows[0]?.sent_at),
      "Correction #5/P) Agence en retard de 10 jours (le serveur a rate le declenchement exact a D+7) -> le mail final SUSPENDED, lui, RATTRAPE bien"
    );

    assert(calls.length === 2, `N/O/P) Exactement 2 emails factices envoyes sur ce tick (D_MINUS_7 + SUSPENDED, jamais pour l'agence a D-6): obtenu ${calls.length}`);
  }

  // --- Q) Verrou de concurrence: un tick qui chevauche le precedent est ignore ---
  {
    const agencySlow = await makeTestAgency("TickConcurrency", dateOnlyPlusDays(TODAY, 2));
    let releaseSlowSend: (() => void) | null = null;
    const slowSendAlert: SendAppAlertFn = async () => {
      await new Promise<void>((resolve) => { releaseSlowSend = resolve; });
      return { success: true, provider: "smtp", message: "ok (test, lent)" };
    };

    const firstTickPromise = runAgencyBillingTick({ now: NOW, sendAlert: slowSendAlert });
    await sleep(150);
    const overlappingResult = await runAgencyBillingTick({ now: NOW, sendAlert: slowSendAlert });
    assert(overlappingResult.skippedAlreadyRunning === true, "Correction #5/Q) Un tick declenche pendant qu'un precedent est encore actif est immediatement ignore (verrou en memoire)");

    if (releaseSlowSend) {
      (releaseSlowSend as () => void)();
    }
    const firstResult = await firstTickPromise;
    assert(firstResult.skippedAlreadyRunning === false, "Q) Le tick initial (non chevauche) s'est bien execute normalement jusqu'au bout");

    const sentRow = await pool.query("SELECT sent_at FROM agency_billing_notifications WHERE agency_id = $1 AND stage = 'D_MINUS_2'", [agencySlow]);
    assert(Boolean(sentRow.rows[0]?.sent_at), "Q) Le tick ignore n'a produit aucun doublon: la notification a bien ete envoyee exactement une fois par le tick qui a reellement tourne");
  }

  // --- R) recordBillingTransition: SUSPENDED trace une seule fois ---
  {
    const agencyId = await makeTestAgency("TransitionOnce", dateOnlyPlusDays(TODAY, -8));
    const agency = (await pool.query("SELECT * FROM agencies WHERE id = $1", [agencyId])).rows[0];
    const state = computeAgencyBillingState(agency, NOW);

    await recordBillingTransition(agencyId, agency, state, null);
    const afterFirst = await pool.query("SELECT payment_suspended_at FROM agencies WHERE id = $1", [agencyId]);
    const suspendedAtFirst = afterFirst.rows[0].payment_suspended_at;
    assert(Boolean(suspendedAtFirst), "R) Premiere observation de la suspension -> payment_suspended_at rempli");

    const eventCountFirst = await pool.query("SELECT COUNT(*)::int AS n FROM agency_billing_events WHERE agency_id = $1 AND event_type = 'SUSPENDED'", [agencyId]);
    assert(eventCountFirst.rows[0].n === 1, "R) Exactement un evenement SUSPENDED apres la premiere observation");

    // Deuxieme appel (ex. tick horaire suivant, meme etat inchange) -> aucune duplication.
    const agencyAfter = (await pool.query("SELECT * FROM agencies WHERE id = $1", [agencyId])).rows[0];
    await recordBillingTransition(agencyId, agencyAfter, computeAgencyBillingState(agencyAfter, NOW), null);
    const eventCountSecond = await pool.query("SELECT COUNT(*)::int AS n FROM agency_billing_events WHERE agency_id = $1 AND event_type = 'SUSPENDED'", [agencyId]);
    assert(eventCountSecond.rows[0].n === 1, "Correction #7/R) Un deuxieme appel sur le meme etat suspendu NE DUPLIQUE PAS l'evenement SUSPENDED (jamais un evenement par tick)");

    const afterSecond = await pool.query("SELECT payment_suspended_at FROM agencies WHERE id = $1", [agencyId]);
    assert(afterSecond.rows[0].payment_suspended_at.getTime() === new Date(suspendedAtFirst).getTime(), "R) payment_suspended_at n'est jamais reecrit une fois pose (ecriture protegee par WHERE payment_suspended_at IS NULL)");
  }

  // --- S) Destinataires email ---
  {
    const agencyWithEmail = await makeTestAgency("RecipientsExplicit", null);
    await pool.query("UPDATE agencies SET notification_email = $2 WHERE id = $1", [agencyWithEmail, ` Notif-${RUN_SUFFIX}@Example.Test `]);
    const recipientsExplicit = await resolveAgencyBillingRecipients(agencyWithEmail);
    assert(
      recipientsExplicit.length === 1 && recipientsExplicit[0] === `notif-${RUN_SUFFIX}@example.test`,
      `S) agencies.notification_email prioritaire, normalise trim+minuscule (obtenu: ${JSON.stringify(recipientsExplicit)})`
    );

    const agencyFallback = await makeTestAgency("RecipientsFallback", null);
    // Precondition du test de repli: aucun notification_email (makeTestAgency
    // en pose un par defaut pour les tests scheduler L/M/N/P/Q ci-dessus).
    await pool.query("UPDATE agencies SET notification_email = NULL WHERE id = $1", [agencyFallback]);
    const managerLogin = `test-billing-mgr-${RUN_SUFFIX}`;
    createdUserLogins.push(managerLogin);
    await createUser({ agencyId: agencyFallback, login: managerLogin, name: "Manager Test", email: `Manager-${RUN_SUFFIX}@Example.Test`, role: 1 });
    const staffLogin = `test-billing-staff-${RUN_SUFFIX}`;
    createdUserLogins.push(staffLogin);
    await createUser({ agencyId: agencyFallback, login: staffLogin, name: "Staff Test", email: `staff-${RUN_SUFFIX}@example.test`, role: 2 });
    const inactiveManagerLogin = `test-billing-mgr-inactive-${RUN_SUFFIX}`;
    createdUserLogins.push(inactiveManagerLogin);
    await createUser({ agencyId: agencyFallback, login: inactiveManagerLogin, name: "Manager Inactif", email: `mgr-inactive-${RUN_SUFFIX}@example.test`, role: 1, isActive: false });

    const recipientsFallback = await resolveAgencyBillingRecipients(agencyFallback);
    assert(
      recipientsFallback.length === 1 && recipientsFallback[0] === `manager-${RUN_SUFFIX}@example.test`,
      `S) Sans notification_email: repli sur le(s) role 1 ACTIF(S) uniquement - jamais le role 2, jamais un role 1 desactive (obtenu: ${JSON.stringify(recipientsFallback)})`
    );
  }

  // --- T/U/V) updateAgencyBilling: semantique absent/null, reset sur nouvelle echeance, granularite des evenements ---
  {
    const agencyId = await makeTestAgency("AdminWrite", dateOnlyPlusDays(TODAY, 10));

    // T) overrideUntil absent du body -> next_payment_date inchange.
    const untouched = await updateAgencyBilling(agencyId, {}, adminUserId);
    assert(toDateOnlyString(untouched.next_payment_date) === dateOnlyPlusDays(TODAY, 10), "T) Body vide -> aucun champ modifie (cle absente = ne pas toucher)");

    // Accorder une autorisation temporaire.
    const overrideUntilIso = new Date(NOW.getTime() + 3_600_000).toISOString();
    const granted = await updateAgencyBilling(agencyId, { overrideUntil: overrideUntilIso }, adminUserId);
    assert(granted.billing_override_until !== null, "T) overrideUntil fourni -> autorisation temporaire posee");
    const grantedEvent = await pool.query("SELECT 1 FROM agency_billing_events WHERE agency_id = $1 AND event_type = 'OVERRIDE_GRANTED'", [agencyId]);
    assert((grantedEvent.rowCount ?? 0) === 1, "T) OVERRIDE_GRANTED trace directement depuis l'action admin");

    // overrideUntil explicitement null -> suppression reelle (jamais possible via COALESCE).
    const removed = await updateAgencyBilling(agencyId, { overrideUntil: null }, adminUserId);
    assert(removed.billing_override_until === null, "Correction #2/T) overrideUntil: null (cle PRESENTE, valeur null) -> l'autorisation est reellement supprimee, pas ignoree comme le ferait un COALESCE generique");
    const removedEvent = await pool.query("SELECT 1 FROM agency_billing_events WHERE agency_id = $1 AND event_type = 'OVERRIDE_REMOVED'", [agencyId]);
    assert((removedEvent.rowCount ?? 0) === 1, "T) OVERRIDE_REMOVED trace directement depuis l'action admin");

    // U) Nouvelle echeance -> reset override + trace de suspension, meme si aucun des deux n'etait actif ici.
    const beforeAlreadyCurrentState = computeAgencyBillingState(await (async () => (await pool.query("SELECT * FROM agencies WHERE id = $1", [agencyId])).rows[0])(), NOW);
    assert(beforeAlreadyCurrentState.status === "current", "U) Precondition: l'agence est deja 'current' avant ce changement de date (retard de 10j corrige plus haut par updateAgencyBilling deja invoque avec overrideUntil, mais next_payment_date restait a J+10 -> verifie 'current')");
    const newDate = dateOnlyPlusDays(TODAY, 20);
    const dateChanged = await updateAgencyBilling(agencyId, { nextPaymentDate: newDate }, adminUserId);
    assert(toDateOnlyString(dateChanged.next_payment_date) === newDate && dateChanged.billing_override_until === null && dateChanged.payment_suspended_at === null, "Correction #6/U) Nouvelle echeance -> override et trace de suspension repartent a NULL systematiquement");
    const dateChangedEvent = await pool.query("SELECT 1 FROM agency_billing_events WHERE agency_id = $1 AND event_type = 'PAYMENT_DATE_CHANGED'", [agencyId]);
    assert((dateChangedEvent.rowCount ?? 0) === 1, "U) PAYMENT_DATE_CHANGED trace pour ce changement de date");
    const accessRestoredEventNone = await pool.query("SELECT 1 FROM agency_billing_events WHERE agency_id = $1 AND event_type = 'ACCESS_RESTORED'", [agencyId]);
    assert((accessRestoredEventNone.rowCount ?? 0) === 0, "Correction #7/U) Aucun ACCESS_RESTORED ici: l'agence etait deja 'current' (accessAllowed deja vrai) avant ce changement, ce n'est PAS une vraie transition bloque->debloque");

    // V) Suppression d'un override qui revele une suspension deja due -> SUSPENDED trace exactement une fois.
    const agencyReveal = await makeTestAgency("AdminRevealSuspended", dateOnlyPlusDays(TODAY, -15));
    const futureOverride = new Date(NOW.getTime() + 3_600_000).toISOString();
    await updateAgencyBilling(agencyReveal, { overrideUntil: futureOverride }, adminUserId);
    const stateWithOverride = computeAgencyBillingState((await pool.query("SELECT * FROM agencies WHERE id = $1", [agencyReveal])).rows[0], NOW);
    assert(stateWithOverride.status === "override", "V) Precondition: l'agence tres en retard est masquee par une autorisation temporaire active");

    await updateAgencyBilling(agencyReveal, { overrideUntil: null }, adminUserId);
    const stateAfterRemoval = computeAgencyBillingState((await pool.query("SELECT * FROM agencies WHERE id = $1", [agencyReveal])).rows[0], NOW);
    assert(stateAfterRemoval.status === "suspended", "V) Suppression de l'autorisation -> la suspension sous-jacente (deja due) redevient immediatement effective");
    const revealSuspendedEvents = await pool.query("SELECT COUNT(*)::int AS n FROM agency_billing_events WHERE agency_id = $1 AND event_type = 'SUSPENDED'", [agencyReveal]);
    assert(revealSuspendedEvents.rows[0].n === 1, "Correction #7/V) La suspension revelee par la suppression de l'override est tracee exactement une fois (jamais 0, jamais plusieurs)");

    // ACCESS_RESTORED doit, lui, apparaitre pour une vraie transition bloque->debloque.
    const agencyRestore = await makeTestAgency("AdminAccessRestored", dateOnlyPlusDays(TODAY, -15));
    const stateBeforeRestore = computeAgencyBillingState((await pool.query("SELECT * FROM agencies WHERE id = $1", [agencyRestore])).rows[0], NOW);
    assert(stateBeforeRestore.status === "suspended", "Precondition restauration: agence bien suspendue avant regularisation");
    await updateAgencyBilling(agencyRestore, { nextPaymentDate: dateOnlyPlusDays(TODAY, 30) }, adminUserId);
    const restoredEvent = await pool.query("SELECT 1 FROM agency_billing_events WHERE agency_id = $1 AND event_type = 'ACCESS_RESTORED'", [agencyRestore]);
    assert((restoredEvent.rowCount ?? 0) === 1, "U/V) Regularisation d'une agence reellement suspendue -> ACCESS_RESTORED trace (vraie transition bloque->debloque)");
  }
};

// --------------------------------------------------------------------------
// Section 3: contournement backend (serveur reel, guard central)
// --------------------------------------------------------------------------

type ServerHandle = { child: ChildProcess; baseUrl: string };

const waitForServerReady = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/me`);
      if (res.status === 401 || res.status === 200) {
        return;
      }
    } catch {
      // pas encore pret
    }
    await sleep(500);
  }
  throw new Error(`Le serveur de test n'a jamais repondu sur ${baseUrl}/api/me.`);
};

const startServer = async (port: number): Promise<ServerHandle> => {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(command, ["tsx", "src/server.ts"], {
    env: { ...process.env, WEB_PORT: String(port), BOT_EXECUTION_MODE: "agent" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  child.stdout?.on("data", (chunk: Buffer) => log("SERVER_STDOUT", chunk.toString().trim()));
  child.stderr?.on("data", (chunk: Buffer) => log("SERVER_STDERR", chunk.toString().trim()));
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  return { child, baseUrl };
};

const stopServer = async (handle: ServerHandle): Promise<void> => {
  if (!handle.child.pid) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(handle.child.pid), "/T", "/F"]);
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  handle.child.kill("SIGTERM");
};

type HttpResult = { status: number; body: unknown; cookie: string | undefined };

const extractCookie = (res: Response): string | undefined => {
  const raw = res.headers.get("set-cookie");
  return raw ? raw.split(";")[0] : undefined;
};

const requestJson = async (
  baseUrl: string,
  method: string,
  pathName: string,
  cookie: string | undefined,
  json?: unknown
): Promise<HttpResult> => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(json ?? {}) } : {})
  });
  const rawText = await res.text();
  let body: unknown = null;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    body = rawText;
  }
  return { status: res.status, body, cookie: extractCookie(res) };
};

const login = async (baseUrl: string, loginName: string, password: string): Promise<{ cookie: string; body: unknown }> => {
  const result = await requestJson(baseUrl, "POST", "/api/login", undefined, { login: loginName, password });
  if (result.status !== 200 || !result.cookie) {
    throw new Error(`Login ${loginName} a echoue: ${JSON.stringify(result.body)}`);
  }
  return { cookie: result.cookie, body: result.body };
};

const loginWithRetry = async (baseUrl: string, loginName: string, password: string, attempts = 5): Promise<{ cookie: string; body: unknown }> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await login(baseUrl, loginName, password);
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

type FakeAgentHandle = { agentId: number; token: string; socket: Socket };

const connectFakeAgent = (baseUrl: string, pairingCode: string): Promise<FakeAgentHandle> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(`${baseUrl}/agent`, {
      autoConnect: false,
      reconnection: false,
      forceNew: true,
      auth: { mode: "pair", pairingCode, computerName: "PW-BILLING-TEST", version: "0.2.4", protocolVersion: 1 }
    });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion agent fantome.")); }, 8_000);
    socket.on("connect_error", (error: Error) => { clearTimeout(timer); reject(new Error(`Rejete: ${error.message}`)); });
    socket.on("AGENT_CONNECTED", (payload: { agentId: number; token: string | null }) => {
      clearTimeout(timer);
      if (!payload.token) {
        reject(new Error("Aucun jeton recu."));
        return;
      }
      socket.emit("AGENT_RUNTIME_STATUS", { sentAt: new Date().toISOString(), bots: [] });
      resolve({ agentId: payload.agentId, token: payload.token, socket });
    });
    socket.connect();
  });

const connectUiSocket = (baseUrl: string, cookie: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { autoConnect: false, reconnection: false, forceNew: true, extraHeaders: { Cookie: cookie } });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion socket UI.")); }, 8_000);
    socket.on("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.on("connect_error", (error: Error) => { clearTimeout(timer); reject(error); });
    socket.connect();
  });

const waitUntil = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000, intervalMs = 100): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return predicate();
};

const runBackendBypassSecurityTests = async (): Promise<void> => {
  log("SECTION", "3) Contournement backend (serveur reel, guard central de facturation)");

  const server = await startServer(3251);
  try {
    const admin = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    const agencyName = `Test Billing Bypass ${RUN_SUFFIX}`;
    createdAgencyNames.push(agencyName);
    const agencyResult = await requestJson(server.baseUrl, "POST", "/api/agencies", admin.cookie, { name: agencyName, maxActiveClients: 15 });
    const agencyId = (agencyResult.body as { agency: { id: number } }).agency.id;

    const managerLogin = `test-billing-bypass-${RUN_SUFFIX}`;
    createdUserLogins.push(managerLogin);
    const userResult = await requestJson(server.baseUrl, "POST", "/api/users", admin.cookie, {
      agencyId, login: managerLogin, name: "Manager Bypass", email: `${managerLogin}@example.test`, role: 1
    });
    const managerPassword = (userResult.body as { temporaryPassword: string }).temporaryPassword;

    // Pairing d'un agent PENDANT que l'agence est encore 'current' (avant
    // suspension), pour verifier ensuite que le renommage/la revocation
    // restent utilisables meme une fois l'agence suspendue (exceptions
    // volontaires du guard central, cf. rapport final).
    const managerBeforeSuspension = await loginWithRetry(server.baseUrl, managerLogin, managerPassword);
    const pairingBeforeSuspension = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerBeforeSuspension.cookie, {});
    assert(pairingBeforeSuspension.status === 200, "Precondition: creation d'un code d'appairage autorisee tant que l'agence n'est pas suspendue");
    const pairingCode = (pairingBeforeSuspension.body as { pairing: { code: string } }).pairing.code;
    const fakeAgent = await connectFakeAgent(server.baseUrl, pairingCode);

    // Suspension: echeance largement depassee, appliquee via la route DEDIEE
    // (jamais le PATCH generique /api/agencies/:id). Fait APRES le demarrage
        // du serveur (cf. commentaire d'entete): le tick immediat au boot du
    // scheduler ne voit donc jamais cette agence, aucun risque de vrai envoi SMTP/Brevo.
    const suspendPatch = await requestJson(server.baseUrl, "PATCH", `/api/agencies/${agencyId}/billing`, admin.cookie, {
      nextPaymentDate: dateOnlyPlusDays(TODAY, -10)
    });
    assert(suspendPatch.status === 200, "Route dediee PATCH /api/agencies/:id/billing accessible et fonctionnelle (role 0)");

    // --- Connexion d'un utilisateur suspendu: doit reussir (session creee) ---
    const managerLoginResult = await requestJson(server.baseUrl, "POST", "/api/login", undefined, { login: managerLogin, password: managerPassword });
    assert(managerLoginResult.status === 200 && Boolean(managerLoginResult.cookie), "Correction session) Login avec identifiants valides reussit MEME agence suspendue (jamais un refus de connexion)");
    const managerBody = managerLoginResult.body as { billing: { status: string; accessAllowed: boolean; nextPaymentDate: string } };
    assert(managerBody.billing?.status === "suspended" && managerBody.billing?.accessAllowed === false, "/api/login expose billing.status='suspended'/accessAllowed=false pour permettre au frontend d'afficher l'ecran de blocage");
    const managerCookie = managerLoginResult.cookie as string;

    const meResult = await requestJson(server.baseUrl, "GET", "/api/me", managerCookie);
    assert(meResult.status === 200, "/api/me reste accessible pour un utilisateur suspendu (necessaire pour afficher l'ecran de blocage)");
    assert((meResult.body as { billing: { status: string } }).billing?.status === "suspended", "/api/me expose le meme etat de facturation que /api/login");

    // --- Actions bloquees ---
    const monitoringPatch = await requestJson(server.baseUrl, "PATCH", "/api/monitoring-settings", managerCookie, { maxParallelScansPerDomain: 2 });
    assert(monitoringPatch.status === 403 && (monitoringPatch.body as { code?: string }).code === "PAYMENT_SUSPENDED", "PATCH /api/monitoring-settings refuse un utilisateur suspendu avec le code machine PAYMENT_SUSPENDED (jamais un simple texte)");

    const pairingPatch = await requestJson(server.baseUrl, "POST", "/api/agents/pairing-codes", managerCookie, {});
    assert(pairingPatch.status === 403 && (pairingPatch.body as { code?: string }).code === "PAYMENT_SUSPENDED", "POST /api/agents/pairing-codes refuse un utilisateur suspendu (aucun nouvel appairage possible)");

    const uiSocket = await connectUiSocket(server.baseUrl, managerCookie);
    const botStatusEvents: Array<{ status: string; code?: string }> = [];
    let botSessionSeen = false;
    uiSocket.on("bot-status", (payload: { status: string; code?: string }) => botStatusEvents.push(payload));
    uiSocket.on("bot-session", () => { botSessionSeen = true; });
    uiSocket.emit("start-bot", { botName: "Bot Suspendu", category: "Tourisme", clientRequestId: `tc-billing-suspended-${RUN_SUFFIX}` });
    await waitUntil(() => botStatusEvents.some((e) => e.code === "PAYMENT_SUSPENDED"));
    assert(botStatusEvents.some((e) => e.code === "PAYMENT_SUSPENDED"), "Socket start-bot refuse egalement un utilisateur suspendu, avec le meme code machine PAYMENT_SUSPENDED (canal non-HTTP couvert aussi)");
    assert(!botSessionSeen, "Aucune session de bot n'est jamais creee pour une agence suspendue (refus AVANT tout dispatch/lancement)");
    uiSocket.disconnect();

    // --- Exceptions volontaires: renommage/revocation d'un agent DEJA appaire restent utilisables ---
    const renamePatch = await requestJson(server.baseUrl, "PATCH", `/api/agents/${fakeAgent.agentId}`, managerCookie, { name: "Agent Renomme Pendant Suspension" });
    assert(renamePatch.status === 200, "Exception volontaire: PATCH /api/agents/:id (renommage) reste utilisable meme agence suspendue (n'etend jamais l'exploitation)");
    const revokePatch = await requestJson(server.baseUrl, "POST", `/api/agents/${fakeAgent.agentId}/revoke`, managerCookie, {});
    assert(revokePatch.status === 200, "Exception volontaire: POST /api/agents/:id/revoke reste utilisable meme agence suspendue (decommissionnement de securite jamais bloque)");
    fakeAgent.socket.disconnect();

    // --- Role 0: bypass total, meme en agissant sur une agence suspendue ---
    const adminActingOnSuspended = await requestJson(server.baseUrl, "PATCH", "/api/monitoring-settings", admin.cookie, { agencyId, maxParallelScansPerDomain: 2 });
    assert(adminActingOnSuspended.status === 200, "Role 0 (admin global) bypasse TOUJOURS le guard de facturation, y compris en agissant explicitement sur une agence suspendue");

    const agenciesListResult = await requestJson(server.baseUrl, "GET", "/api/agencies", admin.cookie);
    const agencyRow = (agenciesListResult.body as { agencies: Array<{ id: number; billing: { status: string } }> }).agencies.find((a) => a.id === agencyId);
    assert(agencyRow?.billing?.status === "suspended", "GET /api/agencies (ecran admin) expose bien billing.status derive pour chaque agence");

    // --- Regularisation: acces immediatement restaure ---
    const restorePatch = await requestJson(server.baseUrl, "PATCH", `/api/agencies/${agencyId}/billing`, admin.cookie, { nextPaymentDate: dateOnlyPlusDays(TODAY, 30) });
    assert(restorePatch.status === 200, "Regularisation de l'echeance via la route dediee");
    const monitoringAfterRestore = await requestJson(server.baseUrl, "PATCH", "/api/monitoring-settings", managerCookie, { maxParallelScansPerDomain: 2 });
    assert(monitoringAfterRestore.status === 200, "Correction #6) Des la premiere requete suivante (aucune attente du scheduler), l'acces est immediatement restaure apres regularisation de l'echeance");

    await requestJson(server.baseUrl, "POST", "/api/logout", managerCookie);
  } finally {
    await stopServer(server);
  }
};

// --------------------------------------------------------------------------

const run = async (): Promise<void> => {
  await initUserModule();
  try {
    runPureStateTests();
    await runServiceAndSchedulerTests();

    // CRITIQUE (jamais de vrai SMTP dans les tests): la section 2 laisse des
    // agences de test avec next_payment_date en retard ET notification_email
    // renseigne. Le serveur reel demarre par la section 3 possede son PROPRE
    // scheduler (src/agencyBillingScheduler.ts), qui utilise le VRAI
    // sendAppAlert (SMTP/Brevo reels, cf. .env) - son tick immediat au boot
    // verrait ces agences et tenterait un envoi reel. Nettoyage systematique
    // ICI, avant le moindre spawn de serveur, pour ne JAMAIS laisser une
    // agence avec une echeance en retard dans la base au moment ou un
    // scheduler reel demarre.
    await cleanupTestData();
    createdAgencyNames.length = 0;
    createdUserLogins.length = 0;

    await runBackendBypassSecurityTests();
  } finally {
    await cleanupTestData().catch((error) => log("CLEANUP_ERROR", String(error)));
    await pool.end().catch(() => undefined);
  }
};

run()
  .then(() => {
    console.log(`\n${passCount} succes, ${failCount} echec(s).`);
    process.exit(failCount > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error("Erreur fatale pendant le scenario de test:", error);
    process.exit(1);
  });
