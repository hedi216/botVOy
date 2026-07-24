import { randomBytes } from "node:crypto";
import http, { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { AgentLogFn } from "./agentLocalLogger.js";
import { AgentLocalUiStatusPayload } from "./types.js";
import { LOCAL_UI_PAGE_HTML } from "./agentLocalUiPage.js";

// Phase 5 (Lot 2, section 7/8): interface locale minimale, loopback
// uniquement, sans aucune dependance nouvelle (http natif Node, jamais
// Express - l'agent conserve exactement les 3 dependances runtime auditees
// au Lot 1: playwright, socket.io-client, dotenv).
//
// Menace consideree: une page web malveillante ouverte dans le navigateur de
// l'utilisateur qui tenterait un appel fetch() vers 127.0.0.1:<port> (CSRF
// local). Mitigations: bind strict sur 127.0.0.1 (jamais 0.0.0.0), nonce de
// session obtenu uniquement via GET /local/status, verification de
// Content-Type + Origin sur toute route POST, limite de taille de corps,
// aucune route ne lit un chemin fourni par la requete (open-logs/open-config
// ouvrent toujours un dossier FIXE, deja connu de l'agent).

const MAX_BODY_BYTES = 16 * 1024;

export type LocalUiCallbacks = {
  getStatus: () => AgentLocalUiStatusPayload;
  pairWithCode: (code: string) => Promise<{ ok: boolean; error?: string }>;
  retry: () => void;
  requestQuit: () => void;
  openLogsFolder: () => void;
  openConfigFolder: () => void;
  // Section 12: "Dissocier cet ordinateur" - arrete les bots, ferme Chrome,
  // deconnecte le socket, efface le credential store, jamais les
  // logs/profils/extensions (reserve a la desinstallation, Lot 3).
  unpair: () => Promise<void>;
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
};

const sendHtml = (res: ServerResponse, html: string): void => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
  res.end(html);
};

// Renvoie { handled: true } des qu'une reponse HTTP a deja ete ecrite (413
// pour un corps trop volumineux): l'appelant ne doit alors plus rien
// ecrire sur `res`. Sinon, `body` est soit l'objet JSON parse, soit `null`
// (corps absent/invalide/mauvais Content-Type) pour un 400 generique.
type ReadJsonBodyResult = { handled: true } | { handled: false; body: Record<string, unknown> | null };

const readJsonBody = (req: IncomingMessage, res: ServerResponse): Promise<ReadJsonBodyResult> => new Promise((resolve) => {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    resolve({ handled: false, body: null });
    return;
  }

  const tooLarge = (): void => {
    // Repondre AVANT de detruire req: detruire d'abord fermerait le socket
    // partage par req/res, empechant toute reponse HTTP propre de partir
    // (le client verrait une simple coupure de connexion, jamais un 413).
    if (!res.headersSent) {
      sendJson(res, 413, { error: "Corps de requete trop volumineux." });
    }
    req.destroy();
    resolve({ handled: true });
  };

  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    tooLarge();
    return;
  }

  let total = 0;
  let settled = false;
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    if (settled) return;
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      settled = true;
      tooLarge();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (settled) return;
    settled = true;
    if (chunks.length === 0) {
      resolve({ handled: false, body: {} });
      return;
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      resolve({ handled: false, body: typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null });
    } catch {
      resolve({ handled: false, body: null });
    }
  });
  req.on("error", () => {
    if (settled) return;
    settled = true;
    resolve({ handled: false, body: null });
  });
});

export class AgentLocalUi {
  private server: http.Server | null = null;
  private readonly nonce = randomBytes(24).toString("hex");
  private port: number | null = null;
  // Limite volontairement basse (section 6: "trop de tentatives"): l'agent
  // n'est qu'une seconde ligne de defense, le serveur distant conserve son
  // propre anti-brute-force sur le code d'appairage lui-meme.
  private pairAttemptsThisSession = 0;
  private readonly maxPairAttempts = 10;

  constructor(private readonly log: AgentLogFn, private readonly callbacks: LocalUiCallbacks) {}

  async start(preferredPort = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          this.log("error", `Interface locale: erreur interne non geree (${error instanceof Error ? error.message : String(error)}).`);
          if (!res.headersSent) {
            sendJson(res, 500, { error: "Erreur interne." });
          }
        });
      });
      server.on("error", reject);
      // 127.0.0.1 explicitement (jamais 0.0.0.0/toutes interfaces, section 7).
      server.listen(preferredPort, "127.0.0.1", () => {
        const address = server.address();
        this.port = typeof address === "object" && address ? address.port : preferredPort;
        this.server = server;
        this.log("info", `Interface locale disponible: http://127.0.0.1:${this.port}/`);
        resolve(this.port);
      });
    });
  }

  getPort(): number | null {
    return this.port;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private isSameOriginOrAbsent(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) {
      // Navigation directe / fetch same-origin sans en-tete Origin: accepte.
      return true;
    }
    return origin === `http://127.0.0.1:${this.port}`;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    if (req.method === "GET" && url.pathname === "/") {
      sendHtml(res, LOCAL_UI_PAGE_HTML);
      return;
    }

    if (req.method === "GET" && url.pathname === "/local/status") {
      sendJson(res, 200, { nonce: this.nonce, ...this.callbacks.getStatus() });
      return;
    }

    if (req.method !== "POST" || !url.pathname.startsWith("/local/")) {
      sendJson(res, 404, { error: "Route inconnue." });
      return;
    }

    if (!this.isSameOriginOrAbsent(req)) {
      sendJson(res, 403, { error: "Origine refusee." });
      return;
    }

    const bodyResult = await readJsonBody(req, res);
    if (bodyResult.handled) {
      return;
    }
    const body = bodyResult.body;
    if (!body) {
      sendJson(res, 400, { error: "Corps de requete invalide (JSON attendu, taille limitee)." });
      return;
    }

    if (body.nonce !== this.nonce) {
      sendJson(res, 403, { error: "Nonce invalide." });
      return;
    }

    switch (url.pathname) {
      case "/local/pair": {
        if (this.pairAttemptsThisSession >= this.maxPairAttempts) {
          sendJson(res, 429, { error: "Trop de tentatives d'appairage locales. Redemarrez l'agent pour reessayer." });
          return;
        }
        const code = typeof body.code === "string" ? body.code.trim() : "";
        if (!code || code.length > 64) {
          sendJson(res, 400, { error: "Code d'appairage invalide." });
          return;
        }
        this.pairAttemptsThisSession += 1;
        // Le code n'est JAMAIS journalise (section 6) - ni ici, ni dans les
        // callbacks (agentMain.ts respecte la meme regle).
        const result = await this.callbacks.pairWithCode(code);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }
      case "/local/retry":
        this.callbacks.retry();
        sendJson(res, 200, { ok: true });
        return;
      case "/local/unpair":
        await this.callbacks.unpair();
        sendJson(res, 200, { ok: true });
        return;
      case "/local/quit":
        sendJson(res, 200, { ok: true });
        // Repond avant de declencher l'arret (sinon la reponse HTTP ne
        // partirait jamais si le process se termine trop vite).
        setImmediate(() => this.callbacks.requestQuit());
        return;
      case "/local/open-logs":
        this.callbacks.openLogsFolder();
        sendJson(res, 200, { ok: true });
        return;
      case "/local/open-config":
        this.callbacks.openConfigFolder();
        sendJson(res, 200, { ok: true });
        return;
      default:
        sendJson(res, 404, { error: "Route inconnue." });
    }
  }
}

// Ouvre un dossier FIXE (jamais un chemin fourni par la requete) dans
// l'explorateur Windows - best effort, jamais bloquant pour l'agent.
export const openFolderInExplorer = (folderPath: string): void => {
  if (process.platform !== "win32") {
    return;
  }
  try {
    // Meme defaut qu'openUrlInDefaultBrowser (Lot 3): un spawn() introuvable
    // rapporte son erreur de maniere ASYNCHRONE ("error"), jamais par une
    // exception synchrone - sans ce handler, une simple fonctionnalite de
    // confort (ouvrir un dossier) peut faire planter tout l'agent.
    const child = spawn("explorer.exe", [folderPath], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // best effort uniquement.
  }
};
