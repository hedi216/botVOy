import { logger } from "./logger.js";
import { sendAlertEmail as sendBrevoAlertEmail } from "./brevoEmailService.js";
import { sendSmtpEmail } from "./smtpEmailService.js";

export type EmailProvider = "smtp" | "brevo";

export type EmailResult = {
  success: boolean;
  provider: EmailProvider;
  messageId?: string;
  statusCode?: number;
  message?: string;
  fallbackUsed?: boolean;
};

export type SendEmailInput = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  metadata?: Record<string, unknown>;
};

export type TransportSenders = {
  smtp: (input: SendEmailInput) => Promise<EmailResult>;
  brevo: (input: SendEmailInput) => Promise<EmailResult>;
};

const VALID_TRANSPORTS: readonly EmailProvider[] = ["smtp", "brevo"];

const parseTransport = (value: string | undefined): EmailProvider | null => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return (VALID_TRANSPORTS as readonly string[]).includes(normalized) ? (normalized as EmailProvider) : null;
};

// Retrocompatibilite (section 15 du hotfix 0.2.4): si EMAIL_PRIMARY_TRANSPORT
// n'est pas defini dans l'environnement, Brevo reste le transport par defaut
// historique - le code peut donc etre deploye avant meme que le .env Contabo
// ne soit mis a jour avec les variables SMTP.
const resolvePrimaryTransport = (): EmailProvider => parseTransport(process.env.EMAIL_PRIMARY_TRANSPORT) ?? "brevo";

const resolveFallbackTransport = (primary: EmailProvider): EmailProvider | null => {
  const fallback = parseTransport(process.env.EMAIL_FALLBACK_TRANSPORT);
  if (!fallback || fallback === primary) {
    return null;
  }
  return fallback;
};

const transportLabel = (name: EmailProvider): string => (name === "smtp" ? "SMTP" : "Brevo");

const runTransport = (name: EmailProvider, input: SendEmailInput, senders: TransportSenders): Promise<EmailResult> =>
  name === "smtp" ? senders.smtp(input) : senders.brevo(input);

export const sendAlertEmailWithTransports = async (
  input: SendEmailInput,
  senders: TransportSenders
): Promise<EmailResult> => {
  const primary = resolvePrimaryTransport();
  const fallback = resolveFallbackTransport(primary);

  const primaryResult = await runTransport(primary, input, senders);
  if (primaryResult.success || !fallback) {
    return primaryResult;
  }

  logger.warn(`${transportLabel(primary)} email failed, trying fallback transport.`);
  const fallbackResult = await runTransport(fallback, input, senders);
  if (fallbackResult.success) {
    logger.success(`${transportLabel(fallback)} fallback sent.`);
    return { ...fallbackResult, fallbackUsed: true };
  }

  return {
    ...fallbackResult,
    fallbackUsed: true,
    message: `${transportLabel(primary)} echec (${primaryResult.message ?? "erreur inconnue"}); ${transportLabel(fallback)} echec (${fallbackResult.message ?? "erreur inconnue"}).`
  };
};

const defaultSenders: TransportSenders = {
  smtp: sendSmtpEmail,
  brevo: (input) => sendBrevoAlertEmail(input)
};

export const sendAlertEmail = (input: SendEmailInput): Promise<EmailResult> =>
  sendAlertEmailWithTransports(input, defaultSenders);
