import { getAgencyNotificationEmail } from "./userService.js";
import { sendAppAlert } from "./appAlertService.js";
import { MonitorEventLevel } from "./types.js";

type NotificationInput = {
  agencyId: number | null;
  level: MonitorEventLevel;
  message: string;
  sessionId?: string;
  botName?: string;
};

const recentNotifications = new Map<string, number>();
const recentAppointmentByAgency = new Map<number, number>();
const DEDUPE_MS = 5 * 60 * 1000;
const SUPPRESS_AFTER_APPOINTMENT_MS = 15 * 60 * 1000;

const stripTechnicalNoise = (message: string): string => message
  .replace(/\u001b\[[0-9;]*m/g, "")
  .split("Call log:")[0]
  .trim();

type NotificationCategory = "appointment-detected" | "appointment-reserved" | "human-blocked";

const normalizeMessage = (message: string): string => message
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[’']/g, "'")
  .toLowerCase();

const classifyNotification = (message: string): NotificationCategory | null => {
  const text = normalizeMessage(message);

  if (text.trim() === "creneau_potentiel_detecte") {
    return "appointment-detected";
  }

  if (text.trim() === "rendez_vous_reserve_temporaire") {
    return "appointment-reserved";
  }

  if (
    text.includes("alerte_utilisateur")
    || text.includes("intervention humaine requise")
    || text.includes("validation humaine")
    || text.includes("controle humain")
    || text.includes("captcha")
    || text.includes("security check")
    || text.includes("page instable")
    || text.includes("page inattendue")
    || text.includes("refresh impossible")
    || text.includes("session expiree")
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

  return `Action requise${suffix}`;
};

const notificationMessage = (category: NotificationCategory, message: string, botName?: string): string => {
  if (!botName) {
    return message;
  }

  if (category === "human-blocked") {
    return `Action recommandee pour le bot "${botName}":\n${message}`;
  }

  if (category === "appointment-detected") {
    return `Creneau potentiel detecte pour le bot "${botName}".\n${message}`;
  }

  return `Rendez-vous reserve temporairement pour le bot "${botName}".\n${message}`;
};

export const notifyAgencyIfNeeded = async ({
  agencyId,
  level,
  message,
  sessionId,
  botName
}: NotificationInput): Promise<void> => {
  const category = classifyNotification(message);

  if (!agencyId || !category) {
    return;
  }

  const email = await getAgencyNotificationEmail(agencyId);
  if (!email) {
    return;
  }

  if (isAppointmentMessage(category)) {
    recentAppointmentByAgency.set(agencyId, Date.now());
  } else {
    const lastAppointment = recentAppointmentByAgency.get(agencyId) ?? 0;
    if (Date.now() - lastAppointment < SUPPRESS_AFTER_APPOINTMENT_MS) {
      return;
    }
  }

  const cleanMessage = stripTechnicalNoise(message);
  const subject = botName
    ? `${notificationSubject(category)} - ${botName}`
    : notificationSubject(category);
  const dedupeKey = `${agencyId}:${subject}:${cleanMessage}`;
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
