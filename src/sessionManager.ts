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
  port: number;
  status: SessionStatus;
  profileDir: string;
  logFile: string;
};

export class BotSession {
  private browser?: Browser;
  private chromeProcess?: ChildProcess;
  private page?: Page;
  private pendingContinue?: () => void;
  private status: SessionStatus = "created";
  private logStream: WriteStream;

  constructor(
    private readonly id: string,
    private readonly port: number,
    private readonly profileDir: string,
    private readonly callbacks: SessionCallbacks
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
      connectToExistingChrome: true,
      chromeDebugUrl: `http://127.0.0.1:${this.port}`,
      targetUrl: "about:blank",
      headless: false
    };

    const { browser, page } = await launchBrowser(config);
    this.browser = browser;
    this.page = page;
    this.log("success", `Chrome client demarre sur le port ${this.port}.`);

    try {
      this.setStatus("waiting");
      await waitForUserToStart({
        log: (level, message) => this.log(level, message),
        waitForUser: (message) => this.waitForUser(message)
      });

      this.setStatus("monitoring");
      await monitorAppointments(page, config, {
        log: (level, message) => this.log(level, message),
        waitForUser: (message) => this.waitForUser(message)
      });

      this.setStatus("stopped");
    } catch (error) {
      this.setStatus("error");
      this.log("error", error instanceof Error ? error.message : String(error));
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
    });

    await this.waitForChromeDebug();
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

export const createBotSession = async (callbacks: SessionCallbacks): Promise<BotSession> => {
  const id = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const port = await getFreePort();
  const profileDir = path.join(process.cwd(), "artifacts", "chrome-profiles", id);

  return new BotSession(id, port, profileDir, callbacks);
};
