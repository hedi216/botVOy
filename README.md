# RDV Agent MVP

MVP local Node.js + TypeScript + Playwright pour surveiller une page de rendez-vous deja ouverte par l'utilisateur.

Le bot ne gere plus le login, les mots de passe, les pays, le centre de demande ou les informations candidat. L'utilisateur ouvre le site, se connecte et valide les controles humains. Ensuite le bot surveille la disponibilite, clique le creneau probable s'il en trouve un, puis s'arrete pour laisser la suite a l'humain.

## Installation

```cmd
npm.cmd install
npm.cmd run playwright:install
npm.cmd run db:init
```

PostgreSQL doit etre installe et lance. Configuration MVP attendue :

```env
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=SMART
PGDATABASE=vrdv
```

Le script `db:init` cree la base `vrdv` si elle n'existe pas, cree les tables `agencies` et `users`, puis ajoute l'admin initial :

```text
login: admin
mot de passe: HtlsH2030*
```

### PostgreSQL Windows natif

Ouvre PowerShell en mode Administrateur, puis lance :

```powershell
.\scripts\install-postgres-admin.ps1
```

Ensuite, dans le terminal du projet :

```cmd
npm.cmd run db:init
```

Si `psql` n'est pas reconnu, ce n'est pas bloquant pour l'application Node.js. Ce qui compte est que le serveur PostgreSQL ecoute sur `localhost:5432` avec `postgres / SMART`.

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
WEB_PORT=3000
MAX_CLIENTS_PER_VM=15
BREVO_API_KEY=
BREVO_SENDER_EMAIL=notif.noreply@rendezbot.xyz
BREVO_SENDER_NAME=RendezBot
BREVO_ALERT_DEFAULT_TO=rendezbot.app@gmail.com
BREVO_SANDBOX=true
EMAIL_NOTIFY_NO_SLOT=false
```

- `TARGET_URL` : optionnel. Utilise `about:blank` si tu veux naviguer manuellement.
- `CONNECT_TO_EXISTING_CHROME` : si `true`, le bot se connecte a un Chrome deja lance avec un port debug.
- `CHROME_DEBUG_URL` : URL du port debug Chrome.
- `REFRESH_INTERVAL_MS` : conserve pour configuration future; le mode actuel refresh puis relance la recherche des que la page est prete.
- `HEADLESS=false` : navigateur visible.
- `SLOW_MO_MS` : ralentit les actions Playwright.
- `DEBUG_KEEP_BROWSER_OPEN=true` : garde le navigateur ouvert apres erreur ou arret.
- `MAX_REFRESH_ATTEMPTS=0` : illimite. Mets `5`, `10`, etc. pour limiter.
- `SCAN_MONTH_COUNT=0` : scanne tous les mois suivants activables jusqu'au premier mois grise/desactive. Mets `4`, `6`, etc. pour limiter manuellement.
- `WEB_PORT` : port de l'interface web locale.
- `MAX_CLIENTS_PER_VM` : limite de sessions Chrome/bot actives sur la VM.
- `BREVO_API_KEY` : cle API Brevo, cote backend uniquement. Ne jamais la mettre dans le frontend.
- `BREVO_SENDER_EMAIL` : expediteur verifie dans Brevo. Pour RendezBot : `notif.noreply@rendezbot.xyz`.
- `BREVO_SENDER_NAME` : nom expediteur, par defaut `RendezBot`.
- `BREVO_ALERT_DEFAULT_TO` : email de fallback si aucune agence ou aucun destinataire n'est fourni.
- `BREVO_SANDBOX=true` : ajoute `X-Sib-Sandbox: drop`, Brevo accepte la requete mais ne livre pas l'email.
- `EMAIL_NOTIFY_NO_SLOT` : si `true`, envoie aussi une notification quand aucun creneau n'est detecte. Laisse `false` pour eviter les emails repetitifs.

## Notifications email Brevo

L'envoi d'emails utilise l'API HTTP Brevo :

```text
POST https://api.brevo.com/v3/smtp/email
```

Le domaine `rendezbot.xyz` et l'expediteur `RendezBot <notif.noreply@rendezbot.xyz>` sont deja configures cote Brevo.

Chaque agence peut avoir un email de notification. Cet email recoit uniquement les evenements importants :

- intervention humaine requise ;
- validation humaine ou blocage detecte ;
- creneau potentiel detecte ;
- alerte utilisateur ;
- erreur ou page inattendue.

Les logs de routine comme `AUCUN_CRENEAU_DETECTE` ne sont pas envoyes par email pour eviter le spam.
Tu peux activer cette notification avec `EMAIL_NOTIFY_NO_SLOT=true` si tu veux recevoir aussi l'absence de creneau.

Pour tester sans envoyer de vrai email, garde :

```env
BREVO_SANDBOX=true
```

Pour envoyer reellement :

```env
BREVO_SANDBOX=false
```

Si Brevo retourne une erreur d'IP non reconnue, ajoute l'IP publique de la VM dans la liste des IP autorisees Brevo.

Route de test disponible uniquement hors production et avec le compte admin :

```http
POST /api/email/test-alert
```

Exemple body :

```json
{
  "to": "rendezbot.app@gmail.com",
  "subject": "Test alerte RendezBot",
  "message": "Ceci est un test d'alerte email depuis Brevo."
}
```

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

## Interface web et maintenance

Le serveur web essaie `WEB_PORT`, puis le port suivant si celui-ci est deja utilise (`3000`, `3001`, `3002`, etc.). Chaque interface affiche son PID et son port dans `Maintenance`, avec un bouton pour arreter proprement ce serveur.

L'interface affiche une section `Maintenance` :

- PID du serveur courant ;
- port de l'interface ;
- nombre de sessions actives ;
- bouton pour arreter tous les navigateurs clients ;
- bouton pour arreter proprement le serveur courant.

Build :

```cmd
npm.cmd run build
npm.cmd start
```

## Extensions d'enregistrement par agence

Chaque agence peut configurer une extension d'enregistrement d'ecran depuis `Parametres`, section `Extension d'enregistrement d'ecran`.

Champs disponibles :

- activation de l'extension pour l'agence ;
- lien d'installation fourni par le prestataire ;
- nom informatif de l'extension ;
- type de licence informatif : non renseignee, gratuite ou payante.

Le lien doit etre une URL `http://` ou `https://`. RendezBot conserve le lien original du fournisseur, y compris si ce lien redirige vers Chrome Web Store ou contient une activation specifique. Les chemins locaux, `file:`, `javascript:`, `data:` et autres schemas ne sont pas acceptes.

RendezBot ne calcule pas de quota de minutes et ne pilote pas le fonctionnement interne de l'extension. Le demarrage automatique de l'enregistrement depend de l'extension installee, de sa licence et de ses propres autorisations.

### Profils Chrome persistants

Les bots utilisent des profils Chrome persistants par agence :

```text
artifacts/
  chrome-profiles/
    agency-<agencyId>/
      profile-01/
      profile-02/
      profile-03/
```

Un profil conserve l'extension installee, la licence, les connexions, autorisations, parametres et stockage local Chrome. Un meme profil n'est jamais attribue simultanement a deux processus Chrome. L'occupation en cours est suivie en memoire, et RendezBot verifie aussi les verrous `Singleton*` laisses par Chrome sur disque.

Si un profil reste bloque apres un crash ou une fermeture brutale, ferme toutes les fenetres Chrome liees a cette agence, verifie qu'aucun processus `chrome.exe` correspondant ne tourne encore, puis relance RendezBot. Si Chrome a laisse un verrou abandonne dans le dossier du profil, nettoie-le seulement apres avoir confirme qu'aucun Chrome n'utilise ce profil.

### Preparation d'un profil avec extension

Parcours normal :

1. Dans `Parametres`, active l'extension et enregistre le lien fourni par le prestataire.
2. Clique `Preparer / installer l'extension`.
3. RendezBot ouvre Google Chrome visible avec un profil persistant dedie a l'agence.
4. Le lien d'installation est ouvert dans ce Chrome.
5. Termine manuellement l'installation, la connexion, la licence et les autorisations si Chrome ou le fournisseur le demande.
6. Clique `Installation terminee` dans RendezBot.
7. Le profil est marque `Pret` et pourra etre utilise par un prochain bot.

Ne clique pas `Installation terminee` tant que l'installation n'est pas reellement finie. RendezBot ne marque jamais un profil comme pret uniquement parce que la page d'installation a ete ouverte.

Boutons disponibles :

- `Preparer / installer l'extension` : ouvre Chrome avec le profil selectionne ou cree.
- `Installation terminee` : ferme le Chrome de preparation et marque le profil pret.
- `Annuler` : ferme le Chrome de preparation et laisse le profil en intervention requise.

### Limites connues Chrome Web Store

RendezBot ne contourne pas les protections de Google Chrome et ne clique pas automatiquement sur `Ajouter a Chrome`. Une confirmation Chrome Web Store peut etre necessaire. Les installations silencieuses via politiques Chrome/Windows globales ne sont pas configurees automatiquement, car elles peuvent affecter tous les profils de la machine et toutes les agences.

Si l'extension est activee pour une agence mais qu'aucun profil pret et libre n'existe, le demarrage du bot est refuse avec un message explicite. Prepare un profil supplementaire pour lancer plusieurs bots simultanes avec l'extension. Si l'extension est desactivee, les bots continuent de fonctionner avec des profils persistants standards et aucun lien d'installation n'est ouvert.

### Validation manuelle recommandee

1. Agence sans extension configuree : demarrer un bot et verifier qu'un profil `not_configured` est cree.
2. Extension desactivee avec un lien enregistre : demarrer un bot et verifier qu'aucun lien d'installation ne s'ouvre.
3. Lien invalide (`file:`, `javascript:`, texte libre) : verifier l'erreur francaise.
4. Lien fournisseur `https://...` : enregistrer puis lancer `Preparer / installer l'extension`.
5. Premier profil : verifier la creation de `artifacts/chrome-profiles/agency-<id>/profile-01`.
6. Preparation reussie : installer manuellement, cliquer `Installation terminee`, verifier l'etat `Pret`.
7. Annulation : lancer une preparation puis `Annuler`, verifier `Intervention requise`.
8. Bot avec profil pret : demarrer et verifier que le profil pret est utilise.
9. Deux bots simultanes : preparer deux profils puis verifier deux dossiers/profils distincts.
10. Aucun profil libre : occuper tous les profils prets puis verifier le message d'erreur.
11. Fermeture manuelle Chrome : fermer la fenetre du bot et verifier l'arret/liberation de session.
12. Arret depuis RendezBot : utiliser `Arreter` et verifier que le profil redevient disponible.
13. Crash Chrome : tuer le processus Chrome et verifier le log d'arret.
14. Changement de lien : modifier le lien et verifier que les profils `Pret` passent a `A preparer`.
15. Deux agences : configurer deux liens differents et verifier les dossiers `agency-<id>` separes.
16. Droits : verifier qu'un niveau 2 ne voit pas les parametres et qu'un niveau 1 ne voit que son agence.
17. Redemarrage complet : relancer RendezBot et verifier que profils et etats persistent.

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
10. Si aucun creneau n'est trouve, il refresh immediatement la page, puis attend jusqu'a 3 fois 10 secondes que la page soit prete.
11. Si la page n'est toujours pas prete apres ces 3 attentes, ou si une page inattendue apparait (`Bad gateway`, 502/503/504, page not found, session expired, coupure reseau), il logge `ALERTE_UTILISATEUR`, tente un screenshot, bip, puis s'arrete.
12. Quand la page est prete, il recommence immediatement la recherche.
13. Toutes les etapes apres le clic sur un creneau restent humaines.

## Limites du MVP

- Pas de contournement CAPTCHA.
- Pas de contournement anti-bot.
- Pas de finalisation de reservation.
- Pas de paiement.
- Pas de donnees personnelles dans `.env`.
- Les detecteurs sont generiques; des regles specifiques pourront etre ajoutees plus tard avec des captures d'ecran.
- Les mois grises/desactives sont ignores autant que possible via `disabled`, `aria-disabled`, opacite et classes CSS.
