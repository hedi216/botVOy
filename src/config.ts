import "dotenv/config";
import { MissionConfig } from "./types.js";

const requiredEnv = (key: string): string => {
  const value = process.env[key];

  if (!value || value.trim().length === 0) {
    throw new Error(`Variable d'environnement manquante: ${key}`);
  }

  return value.trim();
};

const numberEnv = (key: string, fallback: number): number => {
  const raw = process.env[key];

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Variable d'environnement invalide: ${key}`);
  }

  return value;
};

const booleanEnv = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];

  if (!raw) {
    return fallback;
  }

  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
};

export const loadConfig = (): MissionConfig => ({
  targetUrl: requiredEnv("TARGET_URL"),
  loginEmail: requiredEnv("LOGIN_EMAIL"),
  loginPassword: requiredEnv("LOGIN_PASSWORD"),
  applicationCentre: requiredEnv("APPLICATION_CENTRE"),
  appointmentCategory: requiredEnv("APPOINTMENT_CATEGORY"),
  subCategory: requiredEnv("SUB_CATEGORY"),
  firstName: requiredEnv("FIRST_NAME"),
  lastName: requiredEnv("LAST_NAME"),
  currentNationality: requiredEnv("CURRENT_NATIONALITY"),
  passportNumber: requiredEnv("PASSPORT_NUMBER"),
  phoneDialCode: requiredEnv("PHONE_DIAL_CODE"),
  phoneNumber: requiredEnv("PHONE_NUMBER"),
  applicantEmail: requiredEnv("APPLICANT_EMAIL"),
  checkIntervalMinutes: numberEnv("CHECK_INTERVAL_MINUTES", 7),
  afterSaveWaitSeconds: numberEnv("AFTER_SAVE_WAIT_SECONDS", 40),
  afterDateClickWaitSeconds: numberEnv("AFTER_DATE_CLICK_WAIT_SECONDS", 5),
  servicesWaitSeconds: numberEnv("SERVICES_WAIT_SECONDS", 10),
  notificationEmail: process.env.NOTIFICATION_EMAIL?.trim() || requiredEnv("LOGIN_EMAIL"),
  smtpHost: process.env.SMTP_HOST?.trim(),
  smtpPort: numberEnv("SMTP_PORT", 587),
  smtpSecure: booleanEnv("SMTP_SECURE", false),
  smtpUser: process.env.SMTP_USER?.trim(),
  smtpPass: process.env.SMTP_PASS?.trim(),
  browserChannel: process.env.BROWSER_CHANNEL?.trim() || undefined,
  userDataDir: process.env.USER_DATA_DIR?.trim() || undefined,
  slowMoMs: numberEnv("SLOW_MO_MS", 250),
  headless: booleanEnv("HEADLESS", false),
  humanPauseTimeoutMinutes: numberEnv("HUMAN_PAUSE_TIMEOUT_MINUTES", 15),
  enableAiAssistant: booleanEnv("ENABLE_AI_ASSISTANT", false),
  openAiApiKey: process.env.OPENAI_API_KEY?.trim(),
  aiModel: process.env.AI_MODEL?.trim() || "gpt-4.1-mini"
});
