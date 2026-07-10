import { ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Browser, Page } from "playwright";
import { launchBrowser } from "./browser.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { monitorAppointments, waitForUserToStart } from "./monitor.js";
import { AppConfig, MonitorEventLevel } from "./types.js";
import { MonitoringSettings } from "./userService.js";

export type SessionStatus = "created" | "starting" | "waiting" | "monitoring" | "stopped" | "error";

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

export class BotSession {
  private browser?: Browser;
  private chromeProcess?: ChildProcess;
  private page?: Page;
  private pendingContinue?: () => void;
  private status: SessionStatus = "created";
  private stopRequested = false;
  private logStream: WriteStream;

  constructor(
    private readonly id: string,
    private readonly name: string,
    private readonly port: number,
    private readonly profileDir: string,
    private readonly callbacks: SessionCallbacks,
    private readonly monitoringSettings?: MonitoringSettings
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

  async stop(): Promise<void> {
    this.stopRequested = true;
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
      targetUrl: "about:blank",
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
      await waitForUserToStart({
        log: (level, message) => this.log(level, message),
        waitForUser: (message) => this.waitForUser(message)
      });

      const monitoredPage = await this.waitForAppointmentPage();
      this.setStatus("monitoring");
      await monitorAppointments(monitoredPage, config, {
        log: (level, message) => this.log(level, message),
        waitForUser: (message) => this.waitForUser(message),
        recoverPage: (preferredUrl) => this.recoverPage(preferredUrl)
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

  private async waitForAppointmentPage(): Promise<Page> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const page = await this.recoverPage();
      if (page && appointmentPagePattern.test(page.url())) {
        this.log("success", `Onglet rendez-vous selectionne: ${page.url()}`);
        return page;
      }

      const currentUrl = page?.url() ?? "aucun onglet";
      this.log("warn", `Onglet rendez-vous introuvable. Onglet actuel: ${currentUrl}`);
      await this.waitForUser(
        "Fermez les onglets/fenetres extra, gardez seulement la page de rendez-vous, puis validez."
      );
    }

    const page = await this.recoverPage();
    if (!page || !appointmentPagePattern.test(page.url())) {
      throw new Error("Impossible de trouver l'onglet de prise de rendez-vous apres validation.");
    }

    return page;
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
  monitoringSettings?: MonitoringSettings
): Promise<BotSession> => {
  const id = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const name = displayName?.trim() || id;
  const port = await getFreePort();
  const profileDir = path.join(process.cwd(), "artifacts", "chrome-profiles", id);

  return new BotSession(id, name, port, profileDir, callbacks, monitoringSettings);
};
