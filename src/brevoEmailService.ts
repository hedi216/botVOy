import { logger } from "./logger.js";

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

export type SendAlertEmailInput = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  metadata?: Record<string, unknown>;
};

export type BrevoEmailResult = {
  success: boolean;
  provider: "brevo";
  messageId?: string;
  statusCode?: number;
  message?: string;
};

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const textToHtml = (text: string): string => {
  return `<p>${escapeHtml(text).replace(/\r?\n/g, "<br>")}</p>`;
};

const htmlToText = (html: string): string => {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();
};

const normalizeRecipients = (to: string | string[]): Array<{ email: string }> => {
  const recipients = Array.isArray(to) ? to : [to];
  return recipients
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => ({ email }));
};

const formatBrevoError = (statusCode: number, body: unknown): string => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const message = typeof body === "object" && body && "message" in body
    ? String((body as { message?: unknown }).message)
    : raw;

  if (/unauthorized ip|unrecognised ip|ip.*not.*authorized|not authorized|authorised_ips/i.test(message)) {
    return `${message}. L'IP du serveur doit etre autorisee dans Brevo.`;
  }

  return message || `Erreur Brevo HTTP ${statusCode}`;
};

const parseJsonSafely = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export const buildBrevoEmailPayload = (input: SendAlertEmailInput): Record<string, unknown> => {
  if (!input.subject?.trim()) {
    throw new Error("Sujet email obligatoire.");
  }

  if (!input.text && !input.html) {
    throw new Error("Contenu email obligatoire: text ou html.");
  }

  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || "RendezBot";
  const recipients = normalizeRecipients(input.to);

  if (!senderEmail) {
    throw new Error("BREVO_SENDER_EMAIL manquant.");
  }

  if (recipients.length === 0) {
    throw new Error("Destinataire email manquant.");
  }

  const htmlContent = input.html ?? textToHtml(input.text ?? "");
  const textContent = input.text ?? htmlToText(input.html ?? "");
  const sandbox = (process.env.BREVO_SANDBOX ?? "true").toLowerCase() === "true";
  const payload: Record<string, unknown> = {
    sender: {
      name: senderName,
      email: senderEmail
    },
    to: recipients,
    subject: input.subject,
    htmlContent,
    textContent,
    tags: ["rendezbot-alert"]
  };

  if (input.metadata && Object.keys(input.metadata).length > 0) {
    payload.params = input.metadata;
  }

  if (sandbox) {
    payload.headers = {
      "X-Sib-Sandbox": "drop"
    };
  }

  return payload;
};

export const sendAlertEmail = async (input: SendAlertEmailInput): Promise<BrevoEmailResult> => {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      provider: "brevo",
      message: "BREVO_API_KEY manquant."
    };
  }

  let payload: Record<string, unknown>;
  try {
    payload = buildBrevoEmailPayload(input);
  } catch (error) {
    return {
      success: false,
      provider: "brevo",
      message: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    const response = await fetch(BREVO_ENDPOINT, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const body = await parseJsonSafely(response);

    if (!response.ok) {
      const message = formatBrevoError(response.status, body);
      logger.error(`Brevo email error ${response.status}: ${message}`);
      return {
        success: false,
        provider: "brevo",
        statusCode: response.status,
        message
      };
    }

    const messageId = typeof body === "object" && body && "messageId" in body
      ? String((body as { messageId?: unknown }).messageId)
      : undefined;

    logger.success(`Brevo email envoye: ${input.subject}`);
    return {
      success: true,
      provider: "brevo",
      messageId
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Brevo email error: ${message}`);
    return {
      success: false,
      provider: "brevo",
      message
    };
  }
};
