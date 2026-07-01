import nodemailer from "nodemailer";
import { MissionConfig } from "./types.js";
import { logger } from "./logger.js";

export const sendNotificationEmail = async (
  config: MissionConfig,
  subject: string,
  text: string
): Promise<void> => {
  if (!config.smtpHost || !config.smtpUser || !config.smtpPass) {
    logger.warn("SMTP non configure. Email simule uniquement.");
    logger.info(`Email pour ${config.notificationEmail}: ${subject} - ${text}`);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass
    }
  });

  await transporter.sendMail({
    from: config.smtpUser,
    to: config.notificationEmail,
    subject,
    text
  });

  logger.success(`Email envoye a ${config.notificationEmail}.`);
};
