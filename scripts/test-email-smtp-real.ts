// Test REEL et EXPLICITE (hotfix 0.2.4) du transport SMTP Namecheap via
// src/smtpEmailService.ts (le MEME service que la production, aucune
// implementation parallele). Envoie UN SEUL email reel.
//
// JAMAIS execute automatiquement, JAMAIS dans une suite globale. Necessite
// la variable d'environnement explicite SMTP_REAL_TEST_TO: sans elle, ce
// script refuse tout envoi.
//
// Usage: SMTP_REAL_TEST_TO=destinataire@example.com npx tsx scripts/test-email-smtp-real.ts

import { sendSmtpEmail } from "../src/smtpEmailService.js";

const main = async (): Promise<void> => {
  const to = process.env.SMTP_REAL_TEST_TO?.trim();
  if (!to) {
    console.error("Refuse: SMTP_REAL_TEST_TO n'est pas defini. Aucun email reel envoye.");
    process.exit(1);
  }

  console.log(`Envoi d'UN email de test reel a ${to} via le smtpEmailService de production...`);
  const result = await sendSmtpEmail({
    to,
    subject: "[RendezBot] Test SMTP reel (hotfix 0.2.4)",
    text: "Ceci est un email de test reel du transport SMTP Namecheap (scripts/test-email-smtp-real.ts)."
  });

  console.log("Resultat:", JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
};

main().catch((error) => {
  console.error("Erreur inattendue:", error);
  process.exit(1);
});
