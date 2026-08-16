import { logger } from "./logger.js";
import { getUserNotificationEmail } from "./userService.js";
import { sendAppAlert } from "./appAlertService.js";
import { MonitorEventLevel } from "./shared/types.js";

type NotificationInput = {
  userId: number;
  level: MonitorEventLevel;
  message: string;
  sessionId?: string;
  botName?: string;
};

const recentNotifications = new Map<string, number>();
const recentAppointmentByUser = new Map<number, number>();
const blockedSince = new Map<string, number>();
const DEDUPE_MS = 5 * 60 * 1000;
const SUPPRESS_AFTER_APPOINTMENT_MS = 15 * 60 * 1000;
// Le bot logue un blocage humain (captcha, session expiree, onglet introuvable...)
// des sa detection, mais la plupart se resolvent seuls en quelques dizaines de
// secondes. On laisse une fenetre de grace avant d'alerter par mail, pour ne pas
// spammer l'utilisateur a chaque micro-transition pendant la surveillance.
export const HUMAN_BLOCK_GRACE_MS = 4 * 60 * 1000;

const stripTechnicalNoise = (message: string): string => message
  .replace(/\u001b\[[0-9;]*m/g, "")
  .split("Call log:")[0]
  .trim();

type NotificationCategory = "appointment-detected" | "appointment-reserved" | "human-blocked" | "workflow-recovery-failed" | "login-captcha-stuck";

const normalizeMessage = (message: string): string => message
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[’']/g, "'")
  .toLowerCase();

// Exportee UNIQUEMENT pour etre testee directement (meme precedent que
// isAllowedAppointmentBookingRedirect, src/shared/loginFlow.ts) - jamais
// utilisee ailleurs dans le code applicatif que ce module.
export const classifyNotification = (message: string): NotificationCategory | null => {
  const text = normalizeMessage(message);

  if (text.trim() === "alerte_utilisateur") {
    return null;
  }

  if (text.trim() === "creneau_potentiel_detecte") {
    return "appointment-detected";
  }

  if (text.trim() === "rendez_vous_reserve_temporaire") {
    return "appointment-reserved";
  }

  // HOTFIX 0.2.3 (section 10): message reel construit par agentGateway.ts
  // pour un agent bot ("[Agent] Statut du bot: WAITING_FOR_USER
  // {"reason":"WORKFLOW_RECOVERY_FAILED"}") - ne correspondait JUSQU'ICI a
  // AUCUN motif ci-dessous (gap confirme: aucun email n'etait jamais envoye
  // pour un WAITING_FOR_USER/ERROR issu de l'agent). Categorie DISTINCTE de
  // "human-blocked": deliberement PAS soumise a la fenetre de grace
  // HUMAN_BLOCK_GRACE_MS ci-dessous (le recovery a deja dure plusieurs
  // minutes avant d'emettre ce statut - echec deja final, alertable
  // directement), tout en restant soumise au dedoublonnage normal
  // (DEDUPE_MS) pour ne jamais spammer plusieurs emails pour le meme episode.
  if (text.includes("workflow_recovery_failed")) {
    return "workflow-recovery-failed";
  }

  // CORRECTIF CIBLE (login/captcha bloque trop longtemps apres recovery):
  // message reel construit par agentGateway.ts pour ce statut ("[Agent]
  // Statut du bot: WAITING_FOR_USER {"reason":"LOGIN_CAPTCHA_STUCK"}").
  // Verifiee AVANT la liste generique ci-dessous (qui matcherait sinon sur
  // "captcha" et classerait a tort en "human-blocked"): meme raisonnement
  // que workflow_recovery_failed juste au-dessus - la strategie bornee (2x3
  // min + reload unique) a deja ete integralement consommee cote agent
  // avant l'emission de ce statut, donc AUCUNE grace HUMAN_BLOCK_GRACE_MS
  // supplementaire n'est due ici (sinon: 3+3 min deja attendues + encore 4
  // min de grace email, exactement ce que ce correctif interdit). Reste
  // soumise au dedoublonnage normal (DEDUPE_MS) comme toute notification.
  if (text.includes("login_captcha_stuck")) {
    return "login-captcha-stuck";
  }

  if (
    text.includes("intervention humaine requise")
    || text.includes("validation humaine")
    || text.includes("validation humaine tls/cloudflare")
    || text.includes("blocage tls/cloudflare")
    || text.includes("rate limit")
    || text.includes("controle humain")
    || text.includes("captcha")
    || text.includes("cloudflare")
    || text.includes("security check")
    || text.includes("page instable")
    || text.includes("page inattendue")
    || text.includes("refresh impossible")
    || text.includes("page de connexion detectee")
    || text.includes("session expiree")
    || text.includes("session tls")
    || text.includes("impossible de trouver l'onglet")
    || text.includes("onglet rendez-vous introuvable")
    || text.includes("fermez les onglets")
  ) {
    return "human-blocked";
  }

  return null;
};

const isAppointmentMessage = (category: NotificationCategory): boolean => {
  return category === "appointment-detected" || category === "appointment-reserved";
};

const notificationSubject = (category: NotificationCategory): string => {
  if (category === "appointment-detected") {
    return "[RendezBot] Creneau potentiel detecte";
  }

  if (category === "appointment-reserved") {
    return "[RendezBot] Rendez-vous reserve";
  }

  if (category === "workflow-recovery-failed") {
    return "[RendezBot] Recuperation automatique impossible - Intervention requise";
  }

  if (category === "login-captcha-stuck") {
    return "[RendezBot] CAPTCHA en attente - Intervention requise";
  }

  return "[RendezBot] Intervention humaine requise";
};

const alertType = (category: NotificationCategory): "appointment" | "human" | "system" | "warning" => {
  if (category === "appointment-detected" || category === "appointment-reserved") {
    return "appointment";
  }

  return "human";
};

const notificationTitle = (category: NotificationCategory, botName?: string): string => {
  const suffix = botName ? ` - ${botName}` : "";
  if (category === "appointment-detected") {
    return `Creneau potentiel detecte${suffix}`;
  }

  if (category === "appointment-reserved") {
    return `Rendez-vous reserve${suffix}`;
  }

  if (category === "workflow-recovery-failed") {
    return `Recuperation automatique impossible${suffix}`;
  }

  if (category === "login-captcha-stuck") {
    return `CAPTCHA en attente - Intervention requise${suffix}`;
  }

  return `Action requise${suffix}`;
};

const notificationMessage = (category: NotificationCategory, message: string, botName?: string): string => {
  if (!botName) {
    return message;
  }

  if (category === "human-blocked") {
    return `Action recommandee pour le bot "${botName}":\n${message}`;
  }

  if (category === "workflow-recovery-failed") {
    return `Le bot "${botName}" n'a pas pu se retablir automatiquement apres une erreur TLS (refresh puis recuperation complete du parcours epuises). Le navigateur reste ouvert: intervenez manuellement puis validez pour reprendre.`;
  }

  if (category === "login-captcha-stuck") {
    return `Le bot "${botName}" est toujours bloque sur la validation CAPTCHA de la page de connexion apres une tentative automatique de recuperation. Ouvrez le navigateur du bot, terminez la validation, puis laissez RendezBot reprendre le workflow.`;
  }

  if (category === "appointment-detected") {
    return `Creneau potentiel detecte pour le bot "${botName}".\n${message}`;
  }

  return `Rendez-vous reserve temporairement pour le bot "${botName}".\n${message}`;
};

export const notifyUserIfNeeded = async ({
  userId,
  level,
  message,
  sessionId,
  botName
}: NotificationInput): Promise<void> => {
  const category = classifyNotification(message);
  const blockKey = sessionId ?? `user:${userId}:${botName ?? ""}`;

  // Un log "success" signale que le blocage est leve : on remet le compteur de
  // grace a zero pour que le prochain blocage reparte d'une fenetre complete.
  if (blockKey && level === "success") {
    blockedSince.delete(blockKey);
  }

  if (!category) {
    return;
  }

  if (category === "human-blocked" && blockKey) {
    const firstSeen = blockedSince.get(blockKey);
    if (!firstSeen) {
      blockedSince.set(blockKey, Date.now());
      return;
    }
    if (Date.now() - firstSeen < HUMAN_BLOCK_GRACE_MS) {
      return;
    }
  }

  const email = await getUserNotificationEmail(userId);
  if (!email) {
    logger.warn(`Notification ignoree: aucune adresse e-mail configuree pour l'utilisateur ${userId}.`);
    return;
  }

  if (isAppointmentMessage(category)) {
    recentAppointmentByUser.set(userId, Date.now());
  } else {
    const lastAppointment = recentAppointmentByUser.get(userId) ?? 0;
    if (Date.now() - lastAppointment < SUPPRESS_AFTER_APPOINTMENT_MS) {
      return;
    }
  }

  const cleanMessage = stripTechnicalNoise(message);
  const subject = botName
    ? `${notificationSubject(category)} - ${botName}`
    : notificationSubject(category);
  const dedupeKey = `${userId}:${subject}:${cleanMessage}`;
  const lastSent = recentNotifications.get(dedupeKey) ?? 0;
  if (Date.now() - lastSent < DEDUPE_MS) {
    return;
  }

  recentNotifications.set(dedupeKey, Date.now());

  await sendAppAlert({
    type: alertType(category),
    title: notificationTitle(category, botName),
    message: notificationMessage(category, cleanMessage || message, botName),
    userEmail: email,
    data: {
      niveau: level.toUpperCase(),
      bot: botName ?? "non nomme",
      session: sessionId ?? "non determinee",
      date: new Date().toLocaleString("fr-FR")
    }
  });
};
