import nodemailer from "nodemailer";
import { logger } from "./logger.js";
import type { EmailResult, SendEmailInput } from "./emailService.js";

const SMTP_TIMEOUT_MS = 30_000;

type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
};

const readSmtpConfig = (): SmtpConfig | null => {
  const host = process.env.SMTP_HOST?.trim();
  const portRaw = process.env.SMTP_PORT?.trim();
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;
  const fromEmail = process.env.EMAIL_FROM?.trim() || user;
  const fromName = process.env.EMAIL_FROM_NAME?.trim() || "RendezBot";

  if (!host || !portRaw || !user || !password || !fromEmail) {
    return null;
  }

  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }

  const secure = (process.env.SMTP_SECURE ?? "false").trim().toLowerCase() === "true";

  return { host, port, secure, user, password, from: `${fromName} <${fromEmail}>` };
};

export const isSmtpConfigured = (): boolean => readSmtpConfig() !== null;

const normalizeRecipients = (to: string | string[]): string =>
  (Array.isArray(to) ? to : [to]).map((email) => email.trim()).filter(Boolean).join(", ");

// Ne jamais laisser un message d'erreur SMTP brut remonter au caller: un
// mot de passe applicatif Namecheap n'apparait normalement pas dans les
// erreurs nodemailer, mais on filtre par prudence (jamais de credentials
// dans un log/exception publique).
const sanitizeSmtpError = (error: unknown, password: string): string => {
  const raw = error instanceof Error ? error.message : String(error);
  return password ? raw.split(password).join("[redacted]") : raw;
};

export const sendSmtpEmail = async (input: SendEmailInput): Promise<EmailResult> => {
  const config = readSmtpConfig();
  if (!config) {
    return { success: false, provider: "smtp", message: "Configuration SMTP incomplete ou absente." };
  }

  if (!input.subject?.trim()) {
    return { success: false, provider: "smtp", message: "Sujet email obligatoire." };
  }
  if (!input.text && !input.html) {
    return { success: false, provider: "smtp", message: "Contenu email obligatoire: text ou html." };
  }
  const to = normalizeRecipients(input.to);
  if (!to) {
    return { success: false, provider: "smtp", message: "Destinataire email manquant." };
  }

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS
  });

  try {
    const info = await transporter.sendMail({
      from: config.from,
      to,
      subject: input.subject,
      text: input.text,
      html: input.html
    });
    logger.success(`SMTP email sent: ${input.subject}`);
    return { success: true, provider: "smtp", messageId: info.messageId };
  } catch (error) {
    const message = sanitizeSmtpError(error, config.password);
    logger.error(`SMTP email failed: ${message}`);
    return { success: false, provider: "smtp", message };
  } finally {
    transporter.close();
  }
};
