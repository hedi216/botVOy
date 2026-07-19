import { sendAlertEmail, BrevoEmailResult } from "./brevoEmailService.js";

export type SendAppAlertInput = {
  type?: "appointment" | "human" | "system" | "warning" | "info";
  title: string;
  message: string;
  userEmail: string | string[];
  data?: Record<string, unknown>;
};

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const subjectForType = (type: SendAppAlertInput["type"], title: string): string => {
  if (title.trim().startsWith("[RendezBot]")) {
    return title;
  }

  if (type === "appointment") {
    return `[RendezBot] ${title}`;
  }

  if (type === "system") {
    return `[RendezBot] Erreur systeme`;
  }

  if (type === "human") {
    return `[RendezBot] ${title}`;
  }

  return `[RendezBot] ${title}`;
};

const renderDataHtml = (data?: Record<string, unknown>): string => {
  if (!data || Object.keys(data).length === 0) {
    return "";
  }

  const rows = Object.entries(data).map(([key, value]) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e6edf5;color:#66738a;">${escapeHtml(key)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e6edf5;">${escapeHtml(String(value))}</td>
    </tr>
  `).join("");

  return `
    <h2 style="font-size:16px;margin:24px 0 8px;">Details</h2>
    <table style="border-collapse:collapse;width:100%;font-size:14px;">${rows}</table>
  `;
};

const renderDataText = (data?: Record<string, unknown>): string => {
  if (!data || Object.keys(data).length === 0) {
    return "";
  }

  return [
    "",
    "Details:",
    ...Object.entries(data).map(([key, value]) => `- ${key}: ${String(value)}`)
  ].join("\n");
};

export const sendAppAlert = async ({
  type = "warning",
  title,
  message,
  userEmail,
  data
}: SendAppAlertInput): Promise<BrevoEmailResult> => {
  const to = userEmail;

  if (!to || (Array.isArray(to) && to.length === 0)) {
    return {
      success: false,
      provider: "brevo",
      message: "Aucun destinataire explicite fourni pour la notification."
    };
  }

  const subject = subjectForType(type, title);
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#12213a;line-height:1.5;">
      <h1 style="font-size:22px;margin:0 0 12px;color:#06264a;">${escapeHtml(title)}</h1>
      <p style="font-size:15px;margin:0 0 18px;">${escapeHtml(message).replace(/\r?\n/g, "<br>")}</p>
      ${renderDataHtml(data)}
      <p style="margin-top:24px;color:#66738a;font-size:12px;">Notification automatique RendezBot.</p>
    </div>
  `;
  const text = [
    title,
    "",
    message,
    renderDataText(data),
    "",
    "Notification automatique RendezBot."
  ].filter(Boolean).join("\n");

  return sendAlertEmail({
    to,
    subject,
    text,
    html,
    metadata: {
      type,
      ...data
    }
  });
};
