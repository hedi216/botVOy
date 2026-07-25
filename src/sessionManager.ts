import { ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Browser, Page } from "playwright";
import { BrowserProfileLease, pinInstalledExtensions } from "./browserProfileService.js";
import { launchBrowser } from "./shared/browser.js";
import { loadConfig } from "./config.js";
import { clickBookNewAppointment, clickContinueServiceLevel, clickSeConnecter, clickSelectTravelGroup, fillLoginForm } from "./shared/loginFlow.js";
import { logger } from "./logger.js";
import { monitorAppointments, waitForUserToStart } from "./shared/monitor.js";
import { takeTimestampedScreenshot } from "./shared/screenshot.js";
import { AppConfig, MonitorEventLevel } from "./shared/types.js";
import { ExtensionLink, MonitoringSettings } from "./userService.js";

export type SessionStatus = "created" | "starting" | "waiting" | "monitoring" | "paused" | "stopped" | "error";

export type BotCredentials = {
  login?: string;
  password?: string;
  category?: string;
};

export type SessionEvent = {
  level: MonitorEventLevel;
  message: string;
  timestamp: string;
};

type SessionCallbacks = {
  onLog: (event: SessionEvent) => void;
  onPrompt: (message: string) => void;
  onStatus: (status: SessionStatus) => void;
};

export type BotSessionSnapshot = {
  id: string;
  name: string;
  port: number;
  status: SessionStatus;
  profileDir: string;
  profileId: number;
  profileKey: string;
  logFile: string;
};

const isTargetClosedMessage = (message: string): boolean =>
  /target page, context or browser has been closed|browser has been closed|context has been closed|page has been closed/i.test(message);
const appointmentPagePattern = /\/workflow\/appointment-booking\//i;
const authPagePattern = /i2-auth\.visas-fr\.tlscontact\.com/i;
const travelGroupsPagePattern = /\/fr-fr\/travel-groups/i;
const applicationSummaryPagePattern = /\/workflow\/application-summary/i;
const serviceLevelPagePattern = /\/workflow\/service-level/i;
const HUMAN_VALIDATION_TIMEOUT_MS = 2 * 60 * 1000;
// Le bot retente seul la suite du parcours avant de solliciter l'humain:
// 3 tentatives courtes, attente de 5 minutes, puis une 4e tentative finale.
// Si aucune page reconnue n'est retrouvee apres cela, le flux d'alerte existant
// prend le relais et declenche la notification.
const SILENT_RECOVERY_ATTEMPTS_BEFORE_WAIT = 3;
const SILENT_RECOVERY_FINAL_ATTEMPT = 4;
const SILENT_RECOVERY_LONG_WAIT_MS = 5 * 60 * 1000;
const SILENT_RECOVERY_RETRY_INTERVAL_MS = 10_000;

export class BotSession {
  private browser?: Browser;
  private chromeProcess?: ChildProcess;
  private page?: Page;
  private pendingContinue?: () => void;
  private pauseGate?: Promise<void>;
  private resolvePause?: () => void;
  private status: SessionStatus = "created";
  private stopRequested = false;
  private profileReleased = false;
  private logStream: WriteStream;

  constructor(
    private readonly id: string,
    private readonly name: string,
    private readonly port: number,
    private readonly profileLease: BrowserProfileLease,
    private readonly callbacks: SessionCallbacks,
    private readonly monitoringSettings?: MonitoringSettings,
    private readonly credentials?: BotCredentials,
    private readonly extensionLinks: ExtensionLink[] = []
  ) {
    mkdirSync(path.join(process.cwd(), "artifacts", "logs"), { recursive: true });
    this.logStream = createWriteStream(this.logFile, { flags: "a" });
  }

  get logFile(): string {
    return path.join("artifacts", "logs", `${this.id}.log`);
  }

  private get profileDir(): string {
    return this.profileLease.profile.directory_path;
  }

  snapshot(): BotSessionSnapshot {
    return {
      id: this.id,
      name: this.name,
      port: this.port,
      status: this.status,
      profileDir: this.profileDir,
      profileId: this.profileLease.profile.id,
      profileKey: this.profileLease.profile.profile_key,
      logFile: this.logFile
    };
  }

  isActive(): boolean {
    return !["stopped", "error"].includes(this.status);
  }

  continue(): void {
    if (!this.pendingContinue) {
      this.log("warn", "Aucune action en attente de validation.");
      return;
    }

    const resolve = this.pendingContinue;
    this.pendingContinue = undefined;
    this.log("info", "Validation utilisateur recue depuis l'interface.");
    resolve();
  }

  pause(): void {
    if (this.pauseGate || !this.isActive() || this.status === "paused") {
      return;
    }

    this.pauseGate = new Promise((resolve) => {
      this.resolvePause = resolve;
    });
    this.setStatus("paused");
    this.log("warn", "Bot mis en pause.");
  }

  resume(): void {
    if (!this.pauseGate) {
      return;
    }

    this.resolvePause?.();
    this.pauseGate = undefined;
    this.resolvePause = undefined;
    this.setStatus("monitoring");
    this.log("info", "Bot repris.");
  }

  private waitWhilePaused = (): Promise<void> => this.pauseGate ?? Promise.resolve();

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.resolvePause?.();
    this.setStatus("stopped");
    await this.browser?.close().catch(() => undefined);
    this.chromeProcess?.kill();
    this.releaseProfile();
    this.logStream.end();
  }

  async start(): Promise<void> {
    try {
      this.setStatus("starting");
      await mkdir(this.profileDir, { recursive: true });
      await this.launchChrome("about:blank");

      const config: AppConfig = {
        ...loadConfig(),
        ...this.monitoringSettings,
        connectToExistingChrome: true,
        chromeDebugUrl: `http://127.0.0.1:${this.port}`,
        headless: false
      };

      const { browser, page } = await launchBrowser(config);
      this.browser = browser;
      this.page = page;
      this.browser.on("disconnected", () => {
        if (!this.stopRequested && this.isActive()) {
          this.log("warn", "Navigateur du bot ferme ou deconnecte. Session arretee.");
          this.pendingContinue?.();
          this.pendingContinue = undefined;
          this.setStatus("stopped");
          this.releaseProfile();
        }
      });
      this.log("success", `Chrome client demarre sur le port ${this.port}. Profil: ${this.profileLease.profile.profile_key}.`);
      await this.openExtensionLinks();

      this.setStatus("waiting");
      const pendingValidationTimer = setTimeout(() => {
        this.log(
          "warn",
          "Validation humaine en attente depuis plus de 2 minutes. Ouvrez le navigateur du bot pour terminer la connexion, puis validez dans l'application."
        );
      }, HUMAN_VALIDATION_TIMEOUT_MS);

      try {
        await waitForUserToStart({
          log: (level, message) => this.log(level, message),
          waitForUser: (message) => this.waitForUser(message)
        });
      } finally {
        clearTimeout(pendingValidationTimer);
      }

      const activeTlsPage = await this.recoverPage();
      if (activeTlsPage) {
        await this.closeExtraPages(activeTlsPage);
      }

      await this.attemptAutoLogin();

      const monitoredPage = await this.waitForAppointmentPage();
      this.setStatus("monitoring");
      await monitorAppointments(monitoredPage, config, {
        botName: this.name,
        category: this.credentials?.category,
        log: (level, message) => this.log(level, message),
        waitForUser: (message) => this.waitForUser(message),
        recoverPage: (preferredUrl) => this.recoverPage(preferredUrl),
        recoverWorkflow: (reason) => this.recoverWorkflow(reason),
        waitWhileNotPaused: () => this.waitWhilePaused()
      });

      this.setStatus("stopped");
    } catch (error) {
      if (!this.isActive()) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (isTargetClosedMessage(message)) {
        this.log("warn", "Navigateur du bot ferme ou deconnecte. Session arretee.");
        this.setStatus("stopped");
        return;
      }

      this.setStatus("error");
      this.log("error", message);
    } finally {
      this.releaseProfile();
    }
  }

  private releaseProfile(): void {
    if (this.profileReleased) {
      return;
    }

    this.profileReleased = true;
    this.profileLease.release();
  }

  private async launchChrome(initialUrl: string): Promise<void> {
    const chromePath = process.env.CHROME_EXECUTABLE_PATH
      || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const pinnedExtensionCount = pinInstalledExtensions(this.profileDir);

    this.log("info", `Lancement Chrome: port=${this.port}, profil=${this.profileLease.profile.profile_key}, extensions epinglees=${pinnedExtensionCount}`);
    this.chromeProcess = spawn(chromePath, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-search-engine-choice-screen",
      "--new-window",
      initialUrl
    ], {
      stdio: "ignore",
      windowsHide: false
    });

    const startupError = new Promise<never>((_resolve, reject) => {
      this.chromeProcess?.once("error", reject);
    });

    this.chromeProcess.once("exit", (code) => {
      this.log("warn", `Process Chrome termine avec code ${code ?? "inconnu"}.`);
      if (!this.stopRequested && this.isActive()) {
        this.pendingContinue?.();
        this.pendingContinue = undefined;
        this.setStatus("stopped");
      }
    });

    await Promise.race([this.waitForChromeDebug(), startupError]);
  }

  private async openExtensionLinks(): Promise<void> {
    const links = this.extensionLinks.filter((link) => link.isActive);
    if (!this.browser?.isConnected() || links.length === 0) {
      return;
    }

    const context = this.browser.contexts()[0] ?? await this.browser.newContext();
    for (const link of links) {
      const extensionPage = await context.newPage();
      extensionPage.setDefaultTimeout(8_000);
      await extensionPage.goto(link.installUrl, { waitUntil: "domcontentloaded" })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.log("warn", `Ouverture du lien extension '${link.name}' impossible: ${message}`);
        });
    }

    await this.page?.bringToFront().catch(() => undefined);
    this.log("info", `${links.length} lien(s) d'extension ouvert(s). Installez-les dans Chrome, puis validez le bot.`);
  }

  private async closeExtraPages(keepPage: Page): Promise<void> {
    const pages = this.browser?.contexts().flatMap((context) => context.pages()) ?? [];
    await Promise.all(pages.map(async (candidate) => {
      if (candidate === keepPage || candidate.isClosed()) {
        return;
      }

      const url = candidate.url();
      if (url.startsWith("devtools://") || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
        return;
      }

      await candidate.close().catch(() => undefined);
    }));
  }

  private async recoverWorkflow(reason?: string): Promise<Page | null> {
    this.log("warn", `Tentative de reprise automatique du workflow TLS${reason ? `: ${reason}` : "."}`);

    for (let attempt = 1; attempt <= SILENT_RECOVERY_FINAL_ATTEMPT; attempt += 1) {
      if (attempt === SILENT_RECOVERY_FINAL_ATTEMPT) {
        this.log("warn", `Trois tentatives sans page reconnue. Attente de ${SILENT_RECOVERY_LONG_WAIT_MS / 60_000} minutes avant la tentative finale.`);
        await new Promise((resolve) => setTimeout(resolve, SILENT_RECOVERY_LONG_WAIT_MS));
      }

      const recoveredPage = await this.tryRecoverWorkflowOnce(attempt, reason);
      if (recoveredPage) {
        return recoveredPage;
      }

      if (attempt < SILENT_RECOVERY_ATTEMPTS_BEFORE_WAIT) {
        await new Promise((resolve) => setTimeout(resolve, SILENT_RECOVERY_RETRY_INTERVAL_MS));
      }
    }

    this.log(
      "error",
      `Reprise automatique impossible apres ${SILENT_RECOVERY_FINAL_ATTEMPT} tentatives. Notification et intervention humaine requises.`
    );
    return null;
  }

  private async tryRecoverWorkflowOnce(attempt: number, reason?: string): Promise<Page | null> {
    if (!this.browser?.isConnected()) {
      return null;
    }

    this.log("info", `Tentative reprise workflow ${attempt}/${SILENT_RECOVERY_FINAL_ATTEMPT}${reason ? ` depuis etat inattendu` : ""}.`);

    let page = await this.recoverPage();
    if (!page || page.isClosed()) {
      return null;
    }

    await this.closeExtraPages(page);
    this.page = page;

    if (appointmentPagePattern.test(page.url())) {
      return page;
    }

    await this.resumeIfRecognizedState();
    page = await this.recoverPage();
    if (page && appointmentPagePattern.test(page.url())) {
      return page;
    }

    const targetUrl = loadConfig().targetUrl;
    if (targetUrl && targetUrl !== "about:blank" && this.page && !this.page.isClosed()) {
      this.log("info", `Retour automatique vers TARGET_URL: ${targetUrl}`);
      await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.log("warn", `Navigation TARGET_URL impossible: ${message}`);
        });
    }

    await this.attemptAutoLogin();
    page = await this.recoverPage();
    if (page && appointmentPagePattern.test(page.url())) {
      return page;
    }

    return null;
  }

  private async recoverPage(preferredUrl?: string): Promise<Page | null> {
    if (!this.browser?.isConnected()) {
      return null;
    }

    const pages = this.browser.contexts()
      .flatMap((context) => context.pages())
      .filter((candidate) => {
        const url = candidate.url();
        return !candidate.isClosed()
          && !url.startsWith("devtools://")
          && !url.startsWith("chrome://")
          && !url.startsWith("chrome-extension://");
      });

    const preferredIsAppointment = preferredUrl ? appointmentPagePattern.test(preferredUrl) : false;
    const appointmentPage = [...pages].reverse().find((candidate) => appointmentPagePattern.test(candidate.url()));
    const exactPreferredPage = preferredUrl
      ? [...pages].reverse().find((candidate) => candidate.url() === preferredUrl)
      : undefined;

    const page = (preferredIsAppointment ? exactPreferredPage : undefined)
      ?? appointmentPage
      ?? exactPreferredPage
      ?? [...pages].reverse().find((candidate) => /tlscontact|vfsglobal/i.test(candidate.url()))
      ?? [...pages].reverse().find((candidate) => candidate.url() !== "about:blank")
      ?? pages[0]
      ?? null;

    if (!page) {
      return null;
    }

    page.setDefaultTimeout(8_000);
    await page.bringToFront().catch(() => undefined);
    this.page = page;
    return page;
  }

  private async attemptAutoLogin(): Promise<void> {
    if (!this.page || this.page.isClosed()) {
      return;
    }

    const url = this.page.url();
    if (appointmentPagePattern.test(url)) {
      return;
    }

    if (!authPagePattern.test(url)) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const clicked = await clickSeConnecter(this.page, (level, message) => this.log(level, message))
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.log("warn", `Clic automatique sur 'Se connecter' impossible: ${message}`);
            return false;
          });

        if (clicked) {
          await this.page?.waitForURL(authPagePattern, { timeout: 8_000 }).catch(() => undefined);
        }

        if (this.page.isClosed() || authPagePattern.test(this.page.url())) {
          break;
        }

        if (attempt === 1) {
          this.log("info", "Nouvelle tentative de clic sur 'Se connecter' dans 3s.");
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
      }

      if (!this.page.isClosed() && !authPagePattern.test(this.page.url())) {
        this.log("warn", "Page de connexion non atteinte apres les tentatives automatiques.");
        await takeTimestampedScreenshot(this.page, "auto-login-failed").catch(() => undefined);
      }
    }

    if (!this.credentials?.login || !this.credentials?.password || this.page.isClosed()) {
      return;
    }

    if (!authPagePattern.test(this.page.url())) {
      return;
    }

    await this.tryFillLoginForm();

    if (this.page.isClosed()) {
      return;
    }

    // Meme si fillLoginForm n'a pas pu confirmer le clic (bouton non trouve, soumission
    // via Entree, etc.), la page a pu naviguer quand meme: on verifie l'URL resultante
    // plutot que de s'arreter sur la seule valeur de retour.
    await this.page.waitForURL((current) => !authPagePattern.test(current.toString()), { timeout: 20_000 })
      .catch(() => undefined);

    if (this.page.isClosed() || appointmentPagePattern.test(this.page.url())) {
      return;
    }

    if (authPagePattern.test(this.page.url())) {
      this.log("warn", "Toujours sur la page de connexion apres soumission automatique.");
      await takeTimestampedScreenshot(this.page, "auto-fill-login-failed").catch(() => undefined);
      return;
    }

    if (!travelGroupsPagePattern.test(this.page.url())) {
      return;
    }

    const selected = await this.trySelectTravelGroup();

    // La navigation apres "Selectionner" est cote SPA et peut enchainer plusieurs
    // etapes intermediaires silencieuses (applicants-information, recapitulatif de
    // commande, paiement...) avant d'atteindre application-summary. Attendre juste
    // "quitter travel-groups" s'arrete au premier saut ; on attend plutot d'atteindre
    // une des pages qu'on sait gerer, avec une marge large pour tenir la chaine entiere.
    if (selected) {
      await this.waitForAnyUrl([applicationSummaryPagePattern, serviceLevelPagePattern, appointmentPagePattern], 40_000);
    }

    if (this.page.isClosed() || appointmentPagePattern.test(this.page.url())) {
      return;
    }

    if (!applicationSummaryPagePattern.test(this.page.url())) {
      return;
    }

    const booking = await this.tryBookAppointment();

    if (booking) {
      await this.waitForAnyUrl([serviceLevelPagePattern, appointmentPagePattern], 15_000);
    }

    if (this.page.isClosed() || appointmentPagePattern.test(this.page.url())) {
      return;
    }

    if (serviceLevelPagePattern.test(this.page.url())) {
      const continued = await this.tryContinueServiceLevel();
      if (continued) {
        await this.waitForUrlAway(serviceLevelPagePattern, 15_000);
      }
    }
  }

  private async tryFillLoginForm(): Promise<boolean> {
    if (!this.page || this.page.isClosed() || !this.credentials?.login || !this.credentials?.password) {
      return false;
    }

    return fillLoginForm(this.page, this.credentials.login, this.credentials.password, (level, message) => this.log(level, message))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log("warn", `Remplissage automatique du formulaire de connexion impossible: ${message}`);
        return false;
      });
  }

  private async trySelectTravelGroup(): Promise<boolean> {
    if (!this.page || this.page.isClosed()) {
      return false;
    }

    return clickSelectTravelGroup(this.page, (level, message) => this.log(level, message))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log("warn", `Selection automatique de la demande impossible: ${message}`);
        return false;
      });
  }

  private async tryBookAppointment(): Promise<boolean> {
    if (!this.page || this.page.isClosed()) {
      return false;
    }

    return clickBookNewAppointment(this.page, (level, message) => this.log(level, message))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log("warn", `Clic automatique sur 'Prendre un nouveau rendez-vous' impossible: ${message}`);
        return false;
      });
  }

  private async tryContinueServiceLevel(): Promise<boolean> {
    if (!this.page || this.page.isClosed()) {
      return false;
    }

    return clickContinueServiceLevel(this.page, (level, message) => this.log(level, message))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log("warn", `Clic automatique sur 'Continuer' impossible: ${message}`);
        return false;
      });
  }

  // Contrairement au premier bloc de attemptAutoLogin (qui force une navigation vers
  // /fr-fr/login via clickSeConnecter), cette methode ne reagit qu'a des etats DEJA
  // reconnus sans jamais rien forcer: si la page est dans un etat ambigu (captcha,
  // file d'attente Cloudflare, ecran de chargement...), elle ne fait rien pour ne
  // jamais interrompre une action manuelle de l'humain en cours.
  private async resumeIfRecognizedState(): Promise<boolean> {
    if (!this.page || this.page.isClosed()) {
      return false;
    }

    const url = this.page.url();

    if (authPagePattern.test(url)) {
      if (!this.credentials?.login || !this.credentials?.password) {
        return false;
      }
      await this.tryFillLoginForm();
      return true;
    }

    if (travelGroupsPagePattern.test(url)) {
      await this.trySelectTravelGroup();
      return true;
    }

    if (applicationSummaryPagePattern.test(url)) {
      await this.tryBookAppointment();
      return true;
    }

    if (serviceLevelPagePattern.test(url)) {
      await this.tryContinueServiceLevel();
      return true;
    }

    return false;
  }

  private async retryNavigationSilently(): Promise<boolean> {
    for (let attempt = 1; attempt <= SILENT_RECOVERY_FINAL_ATTEMPT; attempt += 1) {
      if (attempt === SILENT_RECOVERY_FINAL_ATTEMPT) {
        this.log("warn", `Trois tentatives sans page de rendez-vous. Attente de ${SILENT_RECOVERY_LONG_WAIT_MS / 60_000} minutes avant la tentative finale.`);
        await new Promise((resolve) => setTimeout(resolve, SILENT_RECOVERY_LONG_WAIT_MS));
      }

      const page = await this.tryRecoverWorkflowOnce(attempt);
      if (page && appointmentPagePattern.test(page.url())) {
        return true;
      }

      if (attempt < SILENT_RECOVERY_ATTEMPTS_BEFORE_WAIT) {
        await new Promise((resolve) => setTimeout(resolve, SILENT_RECOVERY_RETRY_INTERVAL_MS));
      }
    }

    this.log("error", `Page de rendez-vous introuvable apres ${SILENT_RECOVERY_FINAL_ATTEMPT} tentatives. Notification et intervention humaine requises.`);
    return false;
  }

  private async waitForUrlAway(currentPagePattern: RegExp, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!this.page || this.page.isClosed()) {
        return;
      }

      if (!currentPagePattern.test(this.page.url())) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private async waitForAnyUrl(patterns: RegExp[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!this.page || this.page.isClosed()) {
        return;
      }

      if (patterns.some((pattern) => pattern.test(this.page!.url()))) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private async waitForAppointmentPage(): Promise<Page> {
    let attempt = 0;

    // Pas de limite de tentatives : une procedure externe (file d'attente Cloudflare,
    // OTP...) peut prendre plusieurs minutes. On ne renonce que si le navigateur est
    // reellement ferme/deconnecte (verifie explicitement, pas par un compteur d'essais).
    while (true) {
      attempt += 1;

      if (!this.browser?.isConnected()) {
        throw new Error("Navigateur du bot deconnecte.");
      }

      const page = await this.recoverPage();
      if (page && appointmentPagePattern.test(page.url())) {
        this.log("success", `Onglet rendez-vous selectionne: ${page.url()}`);
        return page;
      }

      const currentUrl = page?.url() ?? "aucun onglet";
      this.log("warn", `Onglet rendez-vous introuvable (tentative ${attempt}). Onglet actuel: ${currentUrl}`);

      // Avant de solliciter l'humain, on retente seul la suite du parcours pendant
      // quelques minutes (connexion, selection de la demande, clic "Prendre un
      // nouveau rendez-vous"...): beaucoup de blocages se resolvent sans aucune
      // intervention (captcha resolu entre-temps, page qui finit de charger...).
      if (await this.retryNavigationSilently()) {
        continue;
      }

      this.log(
        "warn",
        `Bot toujours bloque apres ${SILENT_RECOVERY_FINAL_ATTEMPT} tentatives de reprise automatique.`
      );
      await this.waitForUser(
        "Le bot n'arrive pas a atteindre la page de rendez-vous (captcha, connexion ou navigation bloquee). Verifiez le navigateur du bot, corrigez si besoin, puis validez."
      );
    }
  }

  private async waitForChromeDebug(): Promise<void> {
    const deadline = Date.now() + 20_000;
    const url = `http://127.0.0.1:${this.port}/json/version`;

    while (Date.now() < deadline) {
      const ok = await fetch(url).then((response) => response.ok).catch(() => false);
      if (ok) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Chrome debug non disponible sur le port ${this.port}.`);
  }

  private waitForUser(message: string): Promise<void> {
    this.callbacks.onPrompt(message);
    return new Promise((resolve) => {
      this.pendingContinue = resolve;
    });
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === status) {
      return;
    }

    this.status = status;
    this.callbacks.onStatus(status);
  }

  private log(level: MonitorEventLevel, message: string): void {
    const event = {
      level,
      message,
      timestamp: new Date().toISOString()
    };

    this.logStream.write(`[${event.timestamp}] [${level.toUpperCase()}] ${message}\n`);
    this.callbacks.onLog(event);
    logger[level](`[${this.id}] ${message}`);
  }
}

const getFreePort = async (): Promise<number> => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => {
      if (typeof address === "object" && address?.port) {
        resolve(address.port);
        return;
      }

      reject(new Error("Port libre introuvable."));
    });
  });
});

export const createBotSession = async (
  callbacks: SessionCallbacks,
  profileLease: BrowserProfileLease,
  displayName?: string,
  monitoringSettings?: MonitoringSettings,
  credentials?: BotCredentials,
  extensionLinks: ExtensionLink[] = []
): Promise<BotSession> => {
  const id = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const name = displayName?.trim() || id;
  const port = await getFreePort();

  return new BotSession(id, name, port, profileLease, callbacks, monitoringSettings, credentials, extensionLinks);
};
