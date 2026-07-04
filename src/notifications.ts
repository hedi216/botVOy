import { getAgencyNotificationEmail } from "./userService.js";
import { sendAppAlert } from "./appAlertService.js";
import { MonitorEventLevel } from "./types.js";

type NotificationInput = {
  agencyId: number | null;
  level: MonitorEventLevel;
  message: string;
  sessionId?: string;
};

const recentNotifications = new Map<string, number>();
const DEDUPE_MS = 5 * 60 * 1000;

const shouldNotify = (level: MonitorEventLevel, message: string): boolean => {
  const text = message.toLowerCase();
  const notifyNoSlot = (process.env.EMAIL_NOTIFY_NO_SLOT ?? "false").toLowerCase() === "true";

  return level === "error"
    || (notifyNoSlot && text.includes("aucun_creneau_detecte"))
    || text.includes("alerte_utilisateur")
    || text.includes("creneau_potentiel_detecte")
    || text.includes("intervention humaine requise")
    || text.includes("validation humaine")
    || text.includes("controle humain")
    || text.includes("blocage")
    || text.includes("bloque")
    || text.includes("page instable")
    || text.includes("page inattendue")
    || text.includes("element de creneau clique");
};

const notificationSubject = (level: MonitorEventLevel, message: string): string => {
  const text = message.toLowerCase();

  if (text.includes("creneau_potentiel_detecte") || text.includes("element de creneau clique")) {
    return "[RendezBot] Creneau potentiel detecte";
  }

  if (text.includes("intervention humaine") || text.includes("validation humaine") || text.includes("controle humain")) {
    return "[RendezBot] Intervention humaine requise";
  }

  if (level === "error" || text.includes("alerte_utilisateur")) {
    return "[RendezBot] Alerte bot";
  }

  return "[RendezBot] Notification";
};

const alertType = (level: MonitorEventLevel, message: string): "appointment" | "human" | "system" | "warning" => {
  const text = message.toLowerCase();

  if (text.includes("creneau_potentiel_detecte") || text.includes("element de creneau clique")) {
    return "appointment";
  }

  if (text.includes("intervention humaine") || text.includes("validation humaine") || text.includes("controle humain")) {
    return "human";
  }

  if (level === "error" || text.includes("alerte_utilisateur")) {
    return "system";
  }

  return "warning";
};

export const notifyAgencyIfNeeded = async ({
  agencyId,
  level,
  message,
  sessionId
}: NotificationInput): Promise<void> => {
  if (!agencyId || !shouldNotify(level, message)) {
    return;
  }

  const email = await getAgencyNotificationEmail(agencyId);
  if (!email) {
    return;
  }

  const subject = notificationSubject(level, message);
  const dedupeKey = `${agencyId}:${subject}:${message}`;
  const lastSent = recentNotifications.get(dedupeKey) ?? 0;
  if (Date.now() - lastSent < DEDUPE_MS) {
    return;
  }

  recentNotifications.set(dedupeKey, Date.now());

  await sendAppAlert({
    type: alertType(level, message),
    title: subject.replace("[RendezBot] ", ""),
    message,
    userEmail: email,
    data: {
      niveau: level.toUpperCase(),
      session: sessionId ?? "non determinee",
      date: new Date().toLocaleString("fr-FR")
    }
  });
};
