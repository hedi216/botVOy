# RDV Agent MVP

MVP local Node.js + TypeScript + Playwright pour surveiller une page de rendez-vous deja ouverte par l'utilisateur.

Le bot ne gere plus le login, les mots de passe, les pays, le centre de demande ou les informations candidat. L'utilisateur ouvre le site, se connecte et valide les controles humains. Ensuite le bot surveille la disponibilite, clique le creneau probable s'il en trouve un, puis s'arrete pour laisser la suite a l'humain.

## Installation

```cmd
npm.cmd install
npm.cmd run playwright:install
```

## Configuration

Copier `.env.example` vers `.env` :

```cmd
copy .env.example .env
```

Variables :

```env
TARGET_URL=about:blank
CONNECT_TO_EXISTING_CHROME=false
CHROME_DEBUG_URL=http://127.0.0.1:9222
REFRESH_INTERVAL_MS=180000
HEADLESS=false
SLOW_MO_MS=200
DEBUG_KEEP_BROWSER_OPEN=true
MAX_REFRESH_ATTEMPTS=0
SCAN_MONTH_COUNT=0
```

- `TARGET_URL` : optionnel. Utilise `about:blank` si tu veux naviguer manuellement.
- `CONNECT_TO_EXISTING_CHROME` : si `true`, le bot se connecte a un Chrome deja lance avec un port debug.
- `CHROME_DEBUG_URL` : URL du port debug Chrome.
- `REFRESH_INTERVAL_MS` : delai entre deux surveillances/rechargements.
- `HEADLESS=false` : navigateur visible.
- `SLOW_MO_MS` : ralentit les actions Playwright.
- `DEBUG_KEEP_BROWSER_OPEN=true` : garde le navigateur ouvert apres erreur ou arret.
- `MAX_REFRESH_ATTEMPTS=0` : illimite. Mets `5`, `10`, etc. pour limiter.
- `SCAN_MONTH_COUNT=0` : scanne tous les mois suivants activables jusqu'au premier mois grise/desactive. Mets `4`, `6`, etc. pour limiter manuellement.

## Lancement

```cmd
npm.cmd run dev
```

## Utiliser un Chrome deja ouvert

Ferme les autres fenetres Chrome, puis lance Chrome avec un port debug :

```cmd
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\Desktop\APPS\rdvAgent\.chrome-user"
```

Ensuite ouvre le site, connecte-toi, va jusqu'a la page rendez-vous, puis mets dans `.env` :

```env
CONNECT_TO_EXISTING_CHROME=true
CHROME_DEBUG_URL=http://127.0.0.1:9222
TARGET_URL=about:blank
```

Lance ensuite :

```cmd
npm.cmd run dev
```

Build :

```cmd
npm.cmd run build
npm.cmd start
```

## Workflow manuel

1. Le bot lance Chromium visible.
2. Si `TARGET_URL=about:blank`, navigue toi-meme vers le site.
3. Connecte-toi manuellement.
4. Valide tout CAPTCHA ou controle humain manuellement.
5. Va jusqu'a la page de rendez-vous.
6. Dans le terminal, appuie sur Entree.
7. Le bot surveille la page, le mois courant et tous les mois suivants activables jusqu'au premier mois grise/desactive.
8. S'il voit un blocage humain, il prend un screenshot et attend ton intervention.
9. S'il voit un creneau potentiel, il prend un screenshot, surligne l'element probable, clique cet element, bip, puis attend ton intervention.
10. Toutes les etapes apres ce clic restent humaines.

## Limites du MVP

- Pas de contournement CAPTCHA.
- Pas de contournement anti-bot.
- Pas de finalisation de reservation.
- Pas de paiement.
- Pas de donnees personnelles dans `.env`.
- Les detecteurs sont generiques; des regles specifiques pourront etre ajoutees plus tard avec des captures d'ecran.
- Les mois grises/desactives sont ignores autant que possible via `disabled`, `aria-disabled`, opacite et classes CSS.
