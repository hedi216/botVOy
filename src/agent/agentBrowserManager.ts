import { ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser } from "../shared/browser.js";
import { AgentCommandError } from "./agentErrors.js";

// Reprend le modele technique deja valide cote serveur (sessionManager.ts,
// BotSession.launchChrome): un vrai chrome.exe visible, pilote via
// --remote-debugging-port + --user-data-dir, puis connexion Playwright par
// CDP (launchBrowser de src/shared/browser.ts, deja partage avec legacy_vm).
// Extraction volontairement locale a l'agent: sessionManager.ts reste couple
// au serveur (BrowserProfileLease/DB) et ne doit jamais etre importe ici.

export const getFreePort = async (): Promise<number> => new Promise((resolve, reject) => {
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

const waitForChromeDebug = async (port: number, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/json/version`;

  while (Date.now() < deadline) {
    const ok = await fetch(url).then((response) => response.ok).catch(() => false);
    if (ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new AgentCommandError("BROWSER_LAUNCH_FAILED", `Chrome debug non disponible sur le port ${port} apres ${timeoutMs}ms.`);
};

export type LaunchedChrome = {
  browserProcess: ChildProcess;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  debugPort: number;
};

export const launchChromeForBot = async (
  profilePath: string,
  initialUrl: string
): Promise<LaunchedChrome> => {
  const port = await getFreePort();
  const chromePath = process.env.CHROME_EXECUTABLE_PATH
    || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

  let browserProcess: ChildProcess;
  try {
    browserProcess = spawn(chromePath, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profilePath}`,
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentCommandError("BROWSER_NOT_FOUND", `Impossible de lancer Chrome (${chromePath}): ${message}`);
  }

  const spawnError = new Promise<never>((_resolve, reject) => {
    browserProcess.once("error", (error) => {
      const isNotFound = (error as NodeJS.ErrnoException).code === "ENOENT";
      reject(new AgentCommandError(
        isNotFound ? "BROWSER_NOT_FOUND" : "BROWSER_LAUNCH_FAILED",
        `Erreur de lancement Chrome: ${error.message}`
      ));
    });
  });

  const earlyExit = new Promise<never>((_resolve, reject) => {
    browserProcess.once("exit", (code) => {
      reject(new AgentCommandError("BROWSER_LAUNCH_FAILED", `Chrome ferme prematurement (code ${code ?? "inconnu"}) avant connexion.`));
    });
  });

  try {
    await Promise.race([waitForChromeDebug(port), spawnError, earlyExit]);
  } catch (error) {
    if (!browserProcess.killed) {
      browserProcess.kill();
    }
    throw error;
  }

  // A partir d'ici, l'arret premature de Chrome n'est plus une erreur de
  // lancement mais un evenement de cycle de vie normal (fermeture manuelle
  // par l'utilisateur, crash): remonte via onUnexpectedExit plutot qu'en
  // rejetant une promesse deja resolue.
  browserProcess.removeAllListeners("exit");

  let browser: Browser;
  try {
    const session = await launchBrowser({
      targetUrl: initialUrl,
      connectToExistingChrome: true,
      chromeDebugUrl: `http://127.0.0.1:${port}`,
      refreshIntervalMs: 0,
      headless: false,
      slowMoMs: 0,
      debugKeepBrowserOpen: true,
      maxRefreshAttempts: 0,
      scanMonthCount: 0,
      maxParallelScansPerDomain: 1,
      monthClickMinDelayMs: 0,
      monthClickMaxDelayMs: 0,
      botCycleCooldownMinMs: 0,
      botCycleCooldownMaxMs: 0,
      refreshEveryCycles: 0,
      rateLimitCooldownMinutes: 1
    });
    browser = session.browser;
    const context = browser.contexts()[0] ?? await browser.newContext();

    return { browserProcess, browser, context, page: session.page, debugPort: port };
  } catch (error) {
    browserProcess.kill();
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentCommandError("BROWSER_CONNECTION_FAILED", `Connexion Playwright/CDP impossible: ${message}`);
  }
};

// browser.close() sur un Browser connecte par CDP (chromium.connectOverCDP)
// attend une confirmation du navigateur qui peut ne jamais arriver de facon
// fiable une fois la page restee inactive quelques instants (observe en
// pratique sur ce type de connexion externe, contrairement a un navigateur
// lance directement par Playwright). On borne donc toujours cet appel dans
// le temps: la fermeture reelle du process (killChromeProcess, garantie et
// rapide) ne doit jamais dependre de la reussite de ce close() cote client.
export const closeBrowserWithTimeout = async (browser: Browser, timeoutMs = 3_000): Promise<void> => {
  await Promise.race([
    browser.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]);
};

// Ne tue jamais que CE process Chrome precis (jamais un taskkill global sur
// chrome.exe): /T pour emporter les processus enfants eventuels de cette
// seule instance (section 8).
export const killChromeProcess = async (browserProcess: ChildProcess): Promise<void> => {
  if (!browserProcess.pid || browserProcess.killed) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(browserProcess.pid), "/T", "/F"]);
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }

  browserProcess.kill();
};
