// CHANTIER CIBLE (gestion des echeances et impayes des agences).
//
// Module dedie, separe de userService.ts (deja volumineux) - toute la
// logique de facturation/suspension d'agence vit ici, avec UNE fonction
// centrale (computeAgencyBillingState) comme SOURCE UNIQUE DE VERITE pour le
// backend, l'API, l'UI, le controle d'acces et le scheduler email. Aucun
// billing_status n'est jamais stocke: tout est derive dynamiquement de
// next_payment_date + billing_override_until + la date du jour.
//
// TIMEZONE: RendezBot est exploite en Tunisie - une "date de paiement"
// correspond a une JOURNEE CIVILE tunisienne (Africa/Tunis), jamais a une
// difference d'heures (168h, etc.). Toutes les comparaisons D/D+7 sont
// calculees via Intl.DateTimeFormat sur le fuseau Africa/Tunis, jamais un
// offset UTC fixe pour "aujourd'hui" (Intl gere correctement un eventuel
// futur changement de regle DST cote OS/ICU). Pour l'ENTREE admin
// (billing_override_until, saisie via <input type="datetime-local"> donc
// SANS decalage), on applique en revanche un offset fixe +01:00: la Tunisie
// n'observe plus l'heure d'ete depuis 2009, ce qui rend ce raccourci correct
// sans dependre d'une librairie de fuseaux horaires tierce.
import { pool, DbAgency } from "./db.js";
import { getAgency } from "./userService.js";
import { sendAppAlert } from "./appAlertService.js";
import type { Response } from "express";
import type { AuthenticatedRequest } from "./auth.js";

export const BILLING_TIMEZONE = "Africa/Tunis";
export const GRACE_PERIOD_DAYS = 7;

const dateFormatterInTunis = new Intl.DateTimeFormat("en-CA", {
  timeZone: BILLING_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

// "en-CA" formate directement en YYYY-MM-DD - jamais un calcul d'offset
// manuel qui se desynchroniserait d'un futur changement de regle DST.
export const todayInTunis = (now: Date = new Date()): string => dateFormatterInTunis.format(now);

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Convertit une valeur DATE Postgres (pg construit un objet Date EN HEURE
// LOCALE du process a partir du texte stocke, jamais en UTC) en 'YYYY-MM-DD'
// via les getters LOCAUX uniquement - jamais toISOString()/les getters UTC,
// qui feraient glisser la date d'un jour selon le TZ du serveur.
export const toDateOnlyString = (value: string | Date | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return value.slice(0, 10);
  }
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const dayNumberFromDateOnly = (dateOnly: string): number => {
  const [year, month, day] = dateOnly.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
};

// Difference en JOURS CALENDAIRES Africa/Tunis (jamais une difference
// d'heures/millisecondes): positif = en retard de N jours, 0 = du
// aujourd'hui, negatif = pas encore du.
export const diffCalendarDaysInTunis = (dateOnly: string, now: Date = new Date()): number =>
  dayNumberFromDateOnly(todayInTunis(now)) - dayNumberFromDateOnly(dateOnly);

export type AgencyBillingStatus = "not_configured" | "current" | "due_today" | "grace_period" | "suspended" | "override";

export type AgencyBillingState = {
  status: AgencyBillingStatus;
  nextPaymentDate: string | null;
  overdueDays: number | null;
  graceDaysRemaining: number | null;
  accessAllowed: boolean;
  overrideUntil: string | null;
  suspendedAt: string | null;
};

export type AgencyBillingRow = {
  next_payment_date: string | Date | null;
  billing_override_until: string | Date | null;
  payment_suspended_at: string | Date | null;
};

// SOURCE UNIQUE DE VERITE: backend, API, UI, controle d'acces et scheduler
// email appellent tous CETTE fonction, jamais une logique dupliquee. Pure et
// synchrone - `now` injectable pour les tests (jamais une attente reelle de
// plusieurs jours). payment_suspended_at n'intervient JAMAIS dans le calcul
// de accessAllowed/status ci-dessous (correction explicite): il n'est
// restitue que comme trace informative (suspendedAt), jamais comme source de
// verite - une nouvelle next_payment_date future doit immediatement redonner
// accessAllowed=true meme si payment_suspended_at est encore renseigne en
// base (le code d'ecriture le remet a NULL par ailleurs, mais cette fonction
// ne DOIT PAS en dependre pour rester correcte par elle-meme).
export const computeAgencyBillingState = (
  agency: AgencyBillingRow,
  now: Date = new Date()
): AgencyBillingState => {
  const nextPaymentDate = toDateOnlyString(agency.next_payment_date);
  const overrideUntilIso = agency.billing_override_until ? new Date(agency.billing_override_until).toISOString() : null;
  const overrideActive = Boolean(overrideUntilIso && new Date(overrideUntilIso).getTime() > now.getTime());
  const suspendedAtIso = agency.payment_suspended_at ? new Date(agency.payment_suspended_at).toISOString() : null;

  if (!nextPaymentDate) {
    return {
      status: "not_configured",
      nextPaymentDate: null,
      overdueDays: null,
      graceDaysRemaining: null,
      accessAllowed: true,
      overrideUntil: null,
      suspendedAt: null
    };
  }

  const diffDays = diffCalendarDaysInTunis(nextPaymentDate, now);

  if (overrideActive) {
    return {
      status: "override",
      nextPaymentDate,
      overdueDays: diffDays > 0 ? diffDays : null,
      graceDaysRemaining: null,
      accessAllowed: true,
      overrideUntil: overrideUntilIso,
      suspendedAt: suspendedAtIso
    };
  }

  if (diffDays < 0) {
    return { status: "current", nextPaymentDate, overdueDays: null, graceDaysRemaining: null, accessAllowed: true, overrideUntil: null, suspendedAt: null };
  }
  if (diffDays === 0) {
    return { status: "due_today", nextPaymentDate, overdueDays: 0, graceDaysRemaining: GRACE_PERIOD_DAYS, accessAllowed: true, overrideUntil: null, suspendedAt: null };
  }
  if (diffDays <= GRACE_PERIOD_DAYS - 1) {
    return {
      status: "grace_period",
      nextPaymentDate,
      overdueDays: diffDays,
      graceDaysRemaining: GRACE_PERIOD_DAYS - diffDays,
      accessAllowed: true,
      overrideUntil: null,
      suspendedAt: null
    };
  }

  return {
    status: "suspended",
    nextPaymentDate,
    overdueDays: diffDays,
    graceDaysRemaining: null,
    accessAllowed: false,
    overrideUntil: null,
    suspendedAt: suspendedAtIso
  };
};

export const getAgencyBillingState = async (agencyId: number, now: Date = new Date()): Promise<AgencyBillingState> => {
  const agency = await getAgency(agencyId);
  if (!agency) {
    throw new Error(`Agence introuvable (id=${agencyId}).`);
  }
  return computeAgencyBillingState(agency, now);
};

export type BillingAccessCheck = { allowed: true } | { allowed: false; state: AgencyBillingState };

export const PAYMENT_SUSPENDED_CODE = "PAYMENT_SUSPENDED";
export const PAYMENT_SUSPENDED_MESSAGE = "Acces RendezBot suspendu en raison d'un paiement en attente. Contactez votre agence ou l'administrateur RendezBot.";

// Politique centrale d'acces (section "GUARD BILLING CENTRAL"): role 0
// (admin global) bypasse TOUJOURS - meme convention deja etablie ailleurs
// (canSeeOwner/canManageAgencySettings, server.ts). Role 1/2 sans agence
// rattachee est refuse (rien a autoriser). Charge TOUJOURS l'etat depuis
// PostgreSQL (getAgency -> vraie requete SQL) - JAMAIS depuis un objet
// utilisateur de session (req.user est un snapshot memoire perime, cf.
// src/auth.ts: les sessions ne sont jamais re-synchronisees apres le login).
export const checkAgencyBillingAccess = async (
  role: number,
  agencyId: number | null,
  now: Date = new Date()
): Promise<BillingAccessCheck> => {
  if (role === 0) {
    return { allowed: true };
  }
  if (!agencyId) {
    return {
      allowed: false,
      state: computeAgencyBillingState({ next_payment_date: null, billing_override_until: null, payment_suspended_at: null }, now)
    };
  }
  const state = await getAgencyBillingState(agencyId, now);
  return state.accessAllowed ? { allowed: true } : { allowed: false, state };
};

// Guard HTTP reutilisable: a appeler juste APRES la resolution habituelle de
// l'agencyId reel de l'action (meme point d'insertion que les 403 existants
// getSettingsAgencyId/requireAgencyId/resolveViewAgencyId) - jamais une
// deuxieme resolution d'agence divergente.
export const requireAgencyBillingAccess = async (
  req: AuthenticatedRequest,
  res: Response,
  agencyId: number | null
): Promise<boolean> => {
  const check = await checkAgencyBillingAccess(req.user!.role, agencyId);
  if (check.allowed) {
    return true;
  }
  res.status(403).json({ error: PAYMENT_SUSPENDED_MESSAGE, code: PAYMENT_SUSPENDED_CODE, billing: check.state });
  return false;
};

// --------------------------------------------------------------------------
// Destinataires email (section "DESTINATAIRES EMAIL")
// --------------------------------------------------------------------------

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

// Priorite a agencies.notification_email ; a defaut, utilisateurs ACTIFS
// role 1 (jamais role 2 si un destinataire administratif valide existe,
// jamais l'admin global par defaut). Normalise (trim + minuscule) pour
// dedupliquer correctement.
export const resolveAgencyBillingRecipients = async (agencyId: number): Promise<string[]> => {
  const agency = await getAgency(agencyId);
  const notificationEmail = agency?.notification_email?.trim();
  if (notificationEmail) {
    return [normalizeEmail(notificationEmail)];
  }

  const result = await pool.query<{ email: string }>(
    `SELECT email FROM users
     WHERE agency_id = $1 AND role = 1 AND is_active = TRUE AND email IS NOT NULL AND TRIM(email) <> ''`,
    [agencyId]
  );
  const emails = new Set<string>();
  for (const row of result.rows) {
    emails.add(normalizeEmail(row.email));
  }
  return [...emails];
};

// --------------------------------------------------------------------------
// Historique admin (agency_billing_events)
// --------------------------------------------------------------------------

export type AgencyBillingEventType = "PAYMENT_DATE_CHANGED" | "OVERRIDE_GRANTED" | "OVERRIDE_REMOVED" | "SUSPENDED" | "ACCESS_RESTORED";

export const logAgencyBillingEvent = async (
  agencyId: number,
  eventType: AgencyBillingEventType,
  oldValue: string | null,
  newValue: string | null,
  createdByUserId: number | null
): Promise<void> => {
  await pool.query(
    `INSERT INTO agency_billing_events (agency_id, event_type, old_value, new_value, created_by_user_id) VALUES ($1, $2, $3, $4, $5)`,
    [agencyId, eventType, oldValue, newValue, createdByUserId]
  );
};

// "Premiere observation effective de suspension" (section 6/7 des
// corrections): payment_suspended_at n'est JAMAIS la source de verite de
// accessAllowed (deja calcule par computeAgencyBillingState avant cet appel)
// - il sert UNIQUEMENT de trace, ecrite une seule fois grace a la clause
// `WHERE payment_suspended_at IS NULL`. Le SUSPENDED event n'est donc jamais
// duplique, ni a chaque tick horaire du scheduler ni si cette fonction est
// appelee plusieurs fois pour la meme transition. Reutilisee A LA FOIS par
// le scheduler (transition purement temporelle) ET par la route admin
// (ex. suppression d'un override qui revele une suspension deja due).
export const recordBillingTransition = async (
  agencyId: number,
  agencyRow: Pick<DbAgency, "payment_suspended_at">,
  state: AgencyBillingState,
  actingUserId: number | null
): Promise<void> => {
  if (state.accessAllowed || agencyRow.payment_suspended_at !== null) {
    return;
  }
  const updated = await pool.query<{ id: number }>(
    `UPDATE agencies SET payment_suspended_at = NOW() WHERE id = $1 AND payment_suspended_at IS NULL RETURNING id`,
    [agencyId]
  );
  if (updated.rows.length > 0) {
    await logAgencyBillingEvent(agencyId, "SUSPENDED", null, state.nextPaymentDate, actingUserId);
  }
};

// --------------------------------------------------------------------------
// Ecriture admin (route dediee - jamais via le COALESCE generique
// d'updateAgency(), qui ne peut pas exprimer "remettre explicitement a NULL")
// --------------------------------------------------------------------------

export type UpdateAgencyBillingInput = {
  // Cle ABSENTE => ne pas modifier ce champ. Cle presente => appliquer la
  // valeur (y compris null, qui a une semantique EXPLICITE differente selon
  // le champ - cf. plus bas).
  nextPaymentDate?: string | null;
  overrideUntil?: string | null;
};

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

// Un <input type="datetime-local"> produit une chaine SANS decalage (ex.
// "2026-08-20T18:00") - interpretee comme heure LOCALE Tunisie (Africa/Tunis,
// UTC+1 fixe: la Tunisie n'observe plus l'heure d'ete depuis 2009, ce qui
// rend cette simplification correcte sans dependance externe). Si un
// decalage est deja present dans la chaine recue (ex. "+01:00"/"Z"), il est
// respecte tel quel, jamais double-applique.
export const parseOverrideUntilInput = (raw: string): Date => {
  const hasOffset = /(?:[+-]\d{2}:\d{2}|Z)$/.test(raw);
  const parsed = new Date(hasOffset ? raw : `${raw}+01:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Date d'autorisation temporaire invalide.");
  }
  return parsed;
};

// Route reservee a role 0 (verifie par le routeur Express, pas ici) - PATCH
// dediee /api/agencies/:id/billing plutot que de detourner le COALESCE
// generique d'updateAgency(): overrideUntil doit pouvoir passer explicitement
// a NULL pour supprimer l'autorisation, ce que COALESCE ne sait pas exprimer.
export const updateAgencyBilling = async (
  agencyId: number,
  patch: UpdateAgencyBillingInput,
  adminUserId: number
): Promise<DbAgency> => {
  const before = await getAgency(agencyId);
  if (!before) {
    throw new Error("Agence introuvable.");
  }
  const beforeState = computeAgencyBillingState(before);

  const hasNextPaymentDate = hasOwn(patch, "nextPaymentDate");
  const hasOverrideUntil = hasOwn(patch, "overrideUntil");

  const setClauses: string[] = [];
  const values: unknown[] = [agencyId];
  let paramIndex = 2;
  let overrideChange: "granted" | "removed" | null = null;
  let newOverrideIso: string | null = null;

  if (hasNextPaymentDate) {
    const raw = patch.nextPaymentDate;
    if (raw === null) {
      setClauses.push("next_payment_date = NULL");
    } else {
      if (typeof raw !== "string" || !DATE_ONLY_PATTERN.test(raw) || Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime())) {
        throw new Error("Date de paiement invalide (format attendu: AAAA-MM-JJ).");
      }
      setClauses.push(`next_payment_date = $${paramIndex}`);
      values.push(raw);
      paramIndex += 1;
    }
    // Correction utilisateur #6: une nouvelle echeance (ou son effacement)
    // repart TOUJOURS a zero - override et trace de suspension nettoyes
    // immediatement, jamais laisses trainer (sinon un override perime
    // masquerait un statut "current" pourtant deja legitime, et
    // payment_suspended_at donnerait une fausse impression de suspension
    // persistante alors que accessAllowed==true).
    setClauses.push("billing_override_until = NULL");
    setClauses.push("payment_suspended_at = NULL");
  }

  if (hasOverrideUntil && !hasNextPaymentDate) {
    const raw = patch.overrideUntil;
    if (raw === null || raw === undefined) {
      setClauses.push("billing_override_until = NULL");
      overrideChange = "removed";
    } else {
      const parsed = parseOverrideUntilInput(raw);
      newOverrideIso = parsed.toISOString();
      setClauses.push(`billing_override_until = $${paramIndex}`);
      values.push(newOverrideIso);
      paramIndex += 1;
      overrideChange = "granted";
    }
  }

  if (setClauses.length === 0) {
    return before;
  }

  setClauses.push("billing_updated_at = NOW()");

  const result = await pool.query<DbAgency>(
    `UPDATE agencies SET ${setClauses.join(", ")} WHERE id = $1 RETURNING *`,
    values
  );
  const after = result.rows[0];
  const afterState = computeAgencyBillingState(after);

  if (hasNextPaymentDate) {
    await logAgencyBillingEvent(
      agencyId,
      "PAYMENT_DATE_CHANGED",
      toDateOnlyString(before.next_payment_date),
      toDateOnlyString(after.next_payment_date),
      adminUserId
    );
    // Correction #7: ACCESS_RESTORED uniquement lors d'une VRAIE transition
    // depuis un etat bloque vers un acces retrouve - jamais a chaque
    // changement de date (ex. jamais si l'agence etait deja "current").
    if (!beforeState.accessAllowed && afterState.accessAllowed) {
      await logAgencyBillingEvent(agencyId, "ACCESS_RESTORED", beforeState.status, afterState.status, adminUserId);
    }
  }
  if (overrideChange === "granted") {
    await logAgencyBillingEvent(agencyId, "OVERRIDE_GRANTED", null, newOverrideIso, adminUserId);
  } else if (overrideChange === "removed") {
    await logAgencyBillingEvent(
      agencyId,
      "OVERRIDE_REMOVED",
      before.billing_override_until ? new Date(before.billing_override_until).toISOString() : null,
      null,
      adminUserId
    );
  }

  // Cas limite explicitement gere (correction #7): supprimer un override sur
  // une agence deja en retard de plus de 7 jours revele une suspension
  // jusque-la MASQUEE par cet override - jamais tracee avant cet instant.
  await recordBillingTransition(agencyId, after, afterState, adminUserId);

  const finalRow = await getAgency(agencyId);
  return finalRow ?? after;
};

// --------------------------------------------------------------------------
// Scheduler (src/agencyBillingScheduler.ts) - reexporte ici pour la logique
// de contenu email partagee.
// --------------------------------------------------------------------------

export type SendAppAlertFn = typeof sendAppAlert;

export const BILLING_STAGE_ORDER = [
  "D_MINUS_7", "D_MINUS_2", "DUE_TODAY",
  "OVERDUE_1", "OVERDUE_2", "OVERDUE_3", "OVERDUE_4", "OVERDUE_5", "OVERDUE_6",
  "SUSPENDED"
] as const;
export type BillingStage = typeof BILLING_STAGE_ORDER[number];

// Stage attendu pour un diffDays donne - jamais de rattrapage pour les
// rappels pre-echeance/grace (correction #5): un serveur absent le jour
// exact d'un rappel ne le rattrape JAMAIS au tick suivant.
export const stageForExactDiff = (diffDays: number): BillingStage | null => {
  if (diffDays === -7) return "D_MINUS_7";
  if (diffDays === -2) return "D_MINUS_2";
  if (diffDays === 0) return "DUE_TODAY";
  if (diffDays >= 1 && diffDays <= GRACE_PERIOD_DAYS - 1) return `OVERDUE_${diffDays}` as BillingStage;
  return null;
};

const formatDateFr = (dateOnly: string): string => {
  const [year, month, day] = dateOnly.split("-");
  return `${day}/${month}/${year}`;
};

export const buildBillingStageContent = (
  stage: BillingStage,
  dueDateOnly: string
): { type: "info" | "warning"; title: string; message: string } => {
  const dueDateFr = formatDateFr(dueDateOnly);
  switch (stage) {
    case "D_MINUS_7":
      return { type: "info", title: "Rappel de paiement RendezBot", message: `Votre paiement RendezBot est du dans 7 jours (le ${dueDateFr}).` };
    case "D_MINUS_2":
      return { type: "info", title: "Rappel de paiement RendezBot", message: `Votre paiement RendezBot est du dans 2 jours (le ${dueDateFr}).` };
    case "DUE_TODAY":
      return { type: "warning", title: "Paiement RendezBot du aujourd'hui", message: `Votre paiement RendezBot est du aujourd'hui (${dueDateFr}). Merci de regulariser rapidement.` };
    case "SUSPENDED":
      return { type: "warning", title: "Acces RendezBot suspendu", message: "Votre acces RendezBot est suspendu en raison du paiement non regularise. Contactez l'administrateur pour regulariser votre situation." };
    default: {
      const overdueDayNumber = Number(stage.slice("OVERDUE_".length));
      const remaining = GRACE_PERIOD_DAYS - overdueDayNumber;
      return {
        type: "warning",
        title: "Paiement RendezBot en attente",
        message: `Paiement en attente. Il vous reste ${remaining} jour${remaining > 1 ? "s" : ""} avant la suspension de votre acces.`
      };
    }
  }
};

// Idempotent (section 5/EMAIL): cree/recupere la ligne du stage, n'envoie
// JAMAIS si sent_at est deja renseigne, ne marque sent_at qu'apres un succes
// REEL de sendAlert (jamais avant), permet un retry au tick suivant en cas
// d'echec (sent_at reste NULL, last_error trace la raison).
export const attemptSendBillingStage = async (
  agencyId: number,
  dueDateOnly: string,
  stage: BillingStage,
  sendAlert: SendAppAlertFn
): Promise<"sent" | "already_sent" | "no_recipient" | "failed"> => {
  const existing = await pool.query<{ id: number; sent_at: string | null }>(
    `SELECT id, sent_at FROM agency_billing_notifications WHERE agency_id = $1 AND payment_due_date = $2 AND stage = $3`,
    [agencyId, dueDateOnly, stage]
  );
  if (existing.rows[0]?.sent_at) {
    return "already_sent";
  }

  const notificationId = existing.rows[0]?.id ?? (
    await pool.query<{ id: number }>(
      `INSERT INTO agency_billing_notifications (agency_id, payment_due_date, stage) VALUES ($1, $2, $3) RETURNING id`,
      [agencyId, dueDateOnly, stage]
    )
  ).rows[0].id;

  const recipients = await resolveAgencyBillingRecipients(agencyId);
  if (recipients.length === 0) {
    await pool.query(`UPDATE agency_billing_notifications SET last_error = $2 WHERE id = $1`, [notificationId, "Aucun destinataire configure (notification_email absent et aucun manager actif)."]);
    return "no_recipient";
  }

  const content = buildBillingStageContent(stage, dueDateOnly);
  let result: Awaited<ReturnType<SendAppAlertFn>>;
  try {
    result = await sendAlert({
      type: content.type,
      title: content.title,
      message: content.message,
      userEmail: recipients,
      data: { agencyId, stage, paymentDueDate: dueDateOnly }
    });
  } catch (error) {
    result = { success: false, provider: "brevo", message: error instanceof Error ? error.message : String(error) };
  }

  if (result.success) {
    await pool.query(`UPDATE agency_billing_notifications SET sent_at = NOW(), last_error = NULL WHERE id = $1`, [notificationId]);
    return "sent";
  }

  await pool.query(`UPDATE agency_billing_notifications SET last_error = $2 WHERE id = $1`, [notificationId, result.message ?? "Echec d'envoi inconnu."]);
  return "failed";
};
