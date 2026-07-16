import { ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Browser, Page } from "playwright";
import { launchBrowser } from "./browser.js";
import { loadConfig } from "./config.js";
import { clickBookNewAppointment, clickSeConnecter, clickSelectTravelGroup, fillLoginForm } from "./loginFlow.js";
import { logger } from "./logger.js";
import { monitorAppointments, waitForUserToStart } from "./monitor.js";
import { takeTimestampedScreenshot } from "./screenshot.js";
import { AppConfig, MonitorEventLevel } from "./types.js";
import { MonitoringSettings } from "./userService.js";

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
  logFile: string;
};

const isTargetClosedMessage = (message: string): boolean =>
  /target page, context or browser has been closed|browser has been closed|context has been closed|page has been closed/i.test(message);
const appointmentPagePattern = /\/workflow\/appointment-booking\//i;
const authPagePattern = /i2-auth\.visas-fr\.tlscontact\.com/i;
const travelGroupsPagePattern = /\/fr-fr\/travel-groups/i;
const applicationSummaryPagePattern = /\/workflow\/application-summary/i;
const HUMAN_VALIDATION_TIMEOUT_MS = 2 * 60 * 1000;

export class BotSession {
  private browser?: Browser;
  private chromeProcess?: ChildProcess;
  private page?: Page;
  private pendingContinue?: () => void;
  private pauseGate?: Promise<void>;
  private resolvePause?: () => void;
  private status: SessionStatus = "created";
  private stopRequested = false;
  private logStream: WriteStream;

  constructor(
    private readonly id: string,
    private readonly name: string,
    private readonly port: number,
    private readonly profileDir: string,
    private readonly callbacks: SessionCallbacks,
    private readonly monitoringSettings?: MonitoringSettings,
    private readonly credentials?: BotCredentials
  ) {
    mkdirSync(path.join(process.cwd(), "artifacts", "logs"), { recursive: true });
    this.logStream = createWriteStream(this.logFile, { flags: "a" });
  }

  get logFile(): string {
    return path.join("artifacts", "logs", `${this.id}.log`);
  }

  snapshot(): BotSessionSnapshot {
    return {
      id: this.id,
      name: this.name,
      port: this.port,
      status: this.status,
      profileDir: this.profileDir,
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
    this.logStream.end();
  }

  async start(): Promise<void> {
    this.setStatus("starting");
    await mkdir(this.profileDir, { recursive: true });
    await this.launchChrome();

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
      }
    });
    this.log("success", `Chrome client demarre sur le port ${this.port}.`);

    try {
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

      await this.attemptAutoLogin();

      const monitoredPage = await this.waitForAppointmentPage();
      this.setStatus("monitoring");
      await monitorAppointments(monitoredPage, config, {
        botName: this.name,
        category: this.credentials?.category,
        log: (level, message) => this.log(level, message),
        waitForUser: (message) => this.waitForUser(message),
        recoverPage: (preferredUrl) => this.recoverPage(preferredUrl),
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
    }
  }

  private async launchChrome(): Promise<void> {
    const chromePath = process.env.CHROME_EXECUTABLE_PATH
      || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

    this.log("info", `Lancement Chrome: port=${this.port}`);
    this.chromeProcess = spawn(chromePath, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-search-engine-choice-screen",
      "--new-window",
      "about:blank"
    ], {
      stdio: "ignore",
      windowsHide: false
    });

    this.chromeProcess.once("exit", (code) => {
      this.log("warn", `Process Chrome termine avec code ${code ?? "inconnu"}.`);
      if (!this.stopRequested && this.isActive()) {
        this.pendingContinue?.();
        this.pendingContinue = undefined;
        this.setStatus("stopped");
      }
    });

    await this.waitForChromeDebug();
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

    await fillLoginForm(this.page, this.credentials.login, this.credentials.password, (level, message) => this.log(level, message))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log("warn", `Remplissage automatique du formulaire de connexion impossible: ${message}`);
        return false;
      });

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

    const selected = await clickSelectTravelGroup(this.page, (level, message) => this.log(level, message))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log("warn", `Selection automatique de la demande impossible: ${message}`);
        return false;
      });

    // La navigation apres "Selectionner" est cote SPA et peut enchainer plusieurs
    // etapes intermediaires (applicants-information, etc.) sans rechargement complet:
    // waitForLoadState("domcontentloaded") ne l'attend pas. On poll l'URL jusqu'a ce
    // qu'elle quitte reellement travel-groups, avec une marge large pour les enchainements.
    if (selected) {
      await this.waitForUrlAway(travelGroupsPagePattern, 15_000);
    }

    if (this.page.isClosed() || appointmentPagePattern.test(this.page.url())) {
      return;
    }

    if (!applicationSummaryPagePattern.test(this.page.url())) {
      return;
    }

    const booking = await clickBookNewAppointment(this.page, (level, message) => this.log(level, message))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log("warn", `Clic automatique sur 'Prendre un nouveau rendez-vous' impossible: ${message}`);
        return false;
      });

    if (booking) {
      await this.waitForUrlAway(applicationSummaryPagePattern, 15_000);
    }
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
      await this.waitForUser(
        "Fermez les onglets/fenetres extra, gardez seulement la page de rendez-vous, puis validez."
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
  displayName?: string,
  monitoringSettings?: MonitoringSettings,
  credentials?: BotCredentials
): Promise<BotSession> => {
  const id = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const name = displayName?.trim() || id;
  const port = await getFreePort();
  const profileDir = path.join(process.cwd(), "artifacts", "chrome-profiles", id);

  return new BotSession(id, name, port, profileDir, callbacks, monitoringSettings, credentials);
};
