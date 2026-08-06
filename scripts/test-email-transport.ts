// Test CIBLE (hotfix 0.2.4) de la logique primary/fallback SMTP -> Brevo
// dans src/emailService.ts. Transports 100% mockes/stubbes: AUCUN reseau,
// AUCUN email reel n'est jamais envoye par ce script.
//
// Usage: npx tsx scripts/test-email-transport.ts
//    ou: npm run test:email:transport

import { sendAlertEmailWithTransports, EmailResult, SendEmailInput, TransportSenders } from "../src/emailService.js";
import { sendSmtpEmail } from "../src/smtpEmailService.js";

let passCount = 0;
let failCount = 0;
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};

const baseInput: SendEmailInput = {
  to: "destinataire@example.com",
  subject: "[RendezBot] Test",
  text: "Corps du message de test."
};

const withEnv = async <T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    if (env[key] === undefined) { delete process.env[key]; } else { process.env[key] = env[key]; }
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) { delete process.env[key]; } else { process.env[key] = previous[key]; }
    }
  }
};

const makeCountingSender = (result: EmailResult): { fn: (input: SendEmailInput) => Promise<EmailResult>; calls: SendEmailInput[] } => {
  const calls: SendEmailInput[] = [];
  const fn = async (input: SendEmailInput): Promise<EmailResult> => {
    calls.push(input);
    return result;
  };
  return { fn, calls };
};

const scenarioA = async (): Promise<void> => {
  const smtp = makeCountingSender({ success: true, provider: "smtp", messageId: "smtp-1" });
  const brevo = makeCountingSender({ success: true, provider: "brevo", messageId: "brevo-1" });
  const senders: TransportSenders = { smtp: smtp.fn, brevo: brevo.fn };

  const result = await withEnv({ EMAIL_PRIMARY_TRANSPORT: "smtp", EMAIL_FALLBACK_TRANSPORT: "brevo" }, () =>
    sendAlertEmailWithTransports(baseInput, senders));

  assert(smtp.calls.length === 1, "A) SMTP appele exactement 1 fois");
  assert(brevo.calls.length === 0, "A) Brevo jamais appele quand SMTP reussit");
  assert(result.provider === "smtp" && result.success === true, "A) resultat: provider smtp, success true");
  assert(!result.fallbackUsed, "A) fallbackUsed absent/false");
};

const scenarioB = async (): Promise<void> => {
  const smtp = makeCountingSender({ success: false, provider: "smtp", message: "SMTP indisponible (simule)." });
  const brevo = makeCountingSender({ success: true, provider: "brevo", messageId: "brevo-2" });
  const senders: TransportSenders = { smtp: smtp.fn, brevo: brevo.fn };

  const result = await withEnv({ EMAIL_PRIMARY_TRANSPORT: "smtp", EMAIL_FALLBACK_TRANSPORT: "brevo" }, () =>
    sendAlertEmailWithTransports(baseInput, senders));

  assert(smtp.calls.length === 1, "B) SMTP appele exactement 1 fois avant fallback");
  assert(brevo.calls.length === 1, "B) Brevo appele exactement 1 fois en fallback");
  assert(result.success === true && result.provider === "brevo", "B) resultat final: succes via brevo");
  assert(result.fallbackUsed === true, "B) fallbackUsed=true");
};

const scenarioC = async (): Promise<void> => {
  const smtp = makeCountingSender({ success: false, provider: "smtp", message: "SMTP en echec (simule)." });
  const brevo = makeCountingSender({ success: false, provider: "brevo", message: "Brevo en echec (simule)." });
  const senders: TransportSenders = { smtp: smtp.fn, brevo: brevo.fn };

  const result = await withEnv({ EMAIL_PRIMARY_TRANSPORT: "smtp", EMAIL_FALLBACK_TRANSPORT: "brevo" }, () =>
    sendAlertEmailWithTransports(baseInput, senders));

  assert(smtp.calls.length === 1, "C) SMTP appele exactement 1 fois (aucune boucle/retry)");
  assert(brevo.calls.length === 1, "C) Brevo appele exactement 1 fois (aucune boucle/retry)");
  assert(result.success === false, "C) resultat final: echec (les deux transports ont echoue)");
  assert(result.fallbackUsed === true, "C) fallbackUsed=true meme en double echec");
};

const scenarioD = async (): Promise<void> => {
  const smtp = makeCountingSender({ success: true, provider: "smtp", messageId: "smtp-3" });
  const brevo = makeCountingSender({ success: true, provider: "brevo", messageId: "brevo-3" });
  const senders: TransportSenders = { smtp: smtp.fn, brevo: brevo.fn };

  const result = await withEnv({ EMAIL_PRIMARY_TRANSPORT: "brevo", EMAIL_FALLBACK_TRANSPORT: "smtp" }, () =>
    sendAlertEmailWithTransports(baseInput, senders));

  assert(brevo.calls.length === 1, "D) Brevo (principal) appele 1 fois");
  assert(smtp.calls.length === 0, "D) SMTP jamais appele quand le principal (brevo) reussit");
  assert(result.provider === "brevo" && result.success === true, "D) resultat: provider brevo, success true");
};

const scenarioE = async (): Promise<void> => {
  const smtp = makeCountingSender({ success: false, provider: "smtp", message: "SMTP en echec (simule)." });
  const brevo = makeCountingSender({ success: true, provider: "brevo", messageId: "brevo-4" });
  const senders: TransportSenders = { smtp: smtp.fn, brevo: brevo.fn };

  await withEnv({ EMAIL_PRIMARY_TRANSPORT: "smtp", EMAIL_FALLBACK_TRANSPORT: "smtp" }, () =>
    sendAlertEmailWithTransports(baseInput, senders));

  assert(smtp.calls.length === 1, "E) primary == fallback: un seul appel total (smtp)");
  assert(brevo.calls.length === 0, "E) primary == fallback: brevo jamais appele");
};

const scenarioF = async (): Promise<void> => {
  const brevo = makeCountingSender({ success: true, provider: "brevo", messageId: "brevo-5" });
  const senders: TransportSenders = { smtp: sendSmtpEmail, brevo: brevo.fn };

  const result = await withEnv({
    EMAIL_PRIMARY_TRANSPORT: "smtp",
    EMAIL_FALLBACK_TRANSPORT: "brevo",
    SMTP_HOST: undefined,
    SMTP_PORT: undefined,
    SMTP_USER: undefined,
    SMTP_PASSWORD: undefined,
    EMAIL_FROM: undefined
  }, () => sendAlertEmailWithTransports(baseInput, senders));

  assert(brevo.calls.length === 1, "F) SMTP non configure: fallback Brevo appele proprement (1 fois)");
  assert(result.success === true && result.provider === "brevo" && result.fallbackUsed === true, "F) resultat final coherent (succes via fallback)");
};

const scenarioG = async (): Promise<void> => {
  const secret = "S3cretAppPassword-NeJamaisLogger";
  const result = await withEnv({
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "1",
    SMTP_USER: "alerts@example.com",
    SMTP_PASSWORD: secret,
    EMAIL_FROM: "alerts@example.com",
    SMTP_SECURE: "false"
  }, () => sendSmtpEmail(baseInput));

  const serialized = JSON.stringify(result);
  assert(result.success === false, "G) connexion SMTP impossible (127.0.0.1:1): echec propre attendu");
  assert(!serialized.includes(secret), "G) le mot de passe SMTP n'apparait jamais dans le resultat");
};

const scenarioH = async (): Promise<void> => {
  const smtp = makeCountingSender({ success: true, provider: "smtp", messageId: "smtp-multi" });
  const brevo = makeCountingSender({ success: true, provider: "brevo" });
  const senders: TransportSenders = { smtp: smtp.fn, brevo: brevo.fn };
  const recipients = ["a@example.com", "b@example.com", "c@example.com"];

  await withEnv({ EMAIL_PRIMARY_TRANSPORT: "smtp" }, () =>
    sendAlertEmailWithTransports({ ...baseInput, to: recipients }, senders));

  assert(smtp.calls.length === 1 && Array.isArray(smtp.calls[0].to) && smtp.calls[0].to.length === 3, "H) plusieurs destinataires transmis sans alteration au transport");
  assert(JSON.stringify(smtp.calls[0].to) === JSON.stringify(recipients), "H) liste des destinataires identique a l'entree");
};

const scenarioBackwardCompat = async (): Promise<void> => {
  const smtp = makeCountingSender({ success: true, provider: "smtp" });
  const brevo = makeCountingSender({ success: true, provider: "brevo" });
  const senders: TransportSenders = { smtp: smtp.fn, brevo: brevo.fn };

  await withEnv({ EMAIL_PRIMARY_TRANSPORT: undefined, EMAIL_FALLBACK_TRANSPORT: undefined }, () =>
    sendAlertEmailWithTransports(baseInput, senders));

  assert(brevo.calls.length === 1 && smtp.calls.length === 0, "Retrocompat) EMAIL_PRIMARY_TRANSPORT absent -> Brevo reste le defaut historique, SMTP jamais appele");
};

const main = async (): Promise<void> => {
  await scenarioBackwardCompat();
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioE();
  await scenarioF();
  await scenarioG();
  await scenarioH();

  console.log(`\n${passCount} PASS, ${failCount} FAIL`);
  process.exit(failCount > 0 ? 1 : 0);
};

main().catch((error) => {
  console.error("Erreur inattendue:", error);
  process.exit(1);
});
