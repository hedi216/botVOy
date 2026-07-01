# RDV Agent MVP

MVP Node.js + TypeScript + Playwright pour piloter un navigateur local visible sur un parcours VFS direct.

Le bot ouvre la page login, se connecte, demarre une nouvelle reservation, cherche un slot, remplit les informations candidat, avance jusqu'a la page de paiement, puis s'arrete et envoie un email si SMTP est configure. Il ne saisit jamais de donnees bancaires et ne contourne pas les captchas.

## Configuration

Copier `.env.example` vers `.env`, puis remplir les valeurs :

```env
TARGET_URL=https://visa.vfsglobal.com/tun/en/aut/login
LOGIN_EMAIL=user@example.com
LOGIN_PASSWORD=change-me

APPLICATION_CENTRE=Austria Visa Application Centre, Tunis
APPOINTMENT_CATEGORY=Schengen Short Stay
SUB_CATEGORY=Slovenia Visa - Libyan National

FIRST_NAME=NOUHA
LAST_NAME=AYACHI
CURRENT_NATIONALITY=LIBYA
PASSPORT_NUMBER=K651651
PHONE_DIAL_CODE=218
PHONE_NUMBER=654168135
APPLICANT_EMAIL=user@example.com

CHECK_INTERVAL_MINUTES=7
AFTER_SAVE_WAIT_SECONDS=40
AFTER_DATE_CLICK_WAIT_SECONDS=5
SERVICES_WAIT_SECONDS=10

NOTIFICATION_EMAIL=user@example.com
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=

SLOW_MO_MS=250
HEADLESS=false
HUMAN_PAUSE_TIMEOUT_MINUTES=15

ENABLE_AI_ASSISTANT=false
OPENAI_API_KEY=
AI_MODEL=gpt-4.1-mini
```

## Installation

```bash
npm install
npm run playwright:install
```

Sur PowerShell Windows, si `npm` est bloque par la policy, utiliser :

```cmd
npm.cmd install
npm.cmd run playwright:install
```

## Lancer

```cmd
npm.cmd run dev
```

Build :

```cmd
npm.cmd run build
npm.cmd start
```

## Workflow

1. Ouvre `TARGET_URL`.
2. Accepte les cookies si possible.
3. Remplit login/password et se connecte.
4. Clique `Start New Booking`.
5. Selectionne `APPLICATION_CENTRE`, `APPOINTMENT_CATEGORY`, `SUB_CATEGORY`.
6. Si aucun slot existe, logout puis nouvel essai apres `CHECK_INTERVAL_MINUTES`.
7. Si un slot existe, clique `Continue`.
8. Remplit les informations candidat, clique `Save`, attend `AFTER_SAVE_WAIT_SECONDS`, puis continue.
9. Attend le calendrier, clique la premiere date disponible, attend `AFTER_DATE_CLICK_WAIT_SECONDS`.
10. Selectionne le premier horaire disponible, descend la page, clique `Continue`.
11. Sur Services, attend `SERVICES_WAIT_SECONDS`, descend la page, clique `Continue`.
12. Sur Review, accepte les Terms and Conditions, clique `Pay Online`.
13. Si une page intermediaire affiche `Continue`, clique encore.
14. Quand la page de paiement est atteinte, le bot s'arrete et envoie un email ou simule l'email dans les logs.

## Email

Pour un vrai email, remplir les variables SMTP. Exemple Gmail :

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=adresse@gmail.com
SMTP_PASS=app-password-gmail
NOTIFICATION_EMAIL=adresse_destination@example.com
```

Sans SMTP, le bot affiche seulement le contenu de l'email dans le terminal.

## Assistant IA

Si `ENABLE_AI_ASSISTANT=true` et `OPENAI_API_KEY` est configure, le bot demande a l'IA un diagnostic quand une etape echoue. L'IA aide a comprendre la page, mais le bot ne contourne pas les validations humaines, les captchas, les controles de securite ou le paiement.

## Limites

Le MVP est volontairement prudent :

- pas de saisie de carte bancaire ;
- pas de contournement captcha ;
- pas de paiement automatique ;
- les selecteurs restent generiques et pourront etre renforces apres quelques runs reels.
