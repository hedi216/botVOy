// Test cible UI: retour visuel "Copier" -> "Copié ✓" -> "Copier" (et
// "Copie impossible" en cas d'echec du presse-papiers), applique au mot de
// passe temporaire (creation utilisateur) et au code d'appairage Agent.
// Playwright headless pilote l'interface reelle - aucun agent/Chrome de bot
// necessaire ici (uniquement le tableau de bord web). Peut tourner sans
// risque sur la VM.
//
// Usage: npx tsx scripts/test-copy-feedback-simulated.ts
//    ou: npm run test:ui:copy-feedback:simulated

import { ChildProcess, spawn } from "node:child_process";
import { Browser, chromium } from "playwright";
import { pool } from "../src/db.js";

const ADMIN_LOGIN = "admin";
const ADMIN_PASSWORD = "HtlsH2030*";
const RUN_SUFFIX = Date.now();

let passCount = 0;
let failCount = 0;
const log = (label: string, message: string): void => console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000, intervalMs = 150): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
};

// --- Cycle de vie serveur (meme convention que les autres tests) ---

type ServerHandle = { child: ChildProcess; baseUrl: string };
let server: ServerHandle | undefined;

const waitForServerReady = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`${baseUrl}/api/me`); if (res.status === 401 || res.status === 200) return; } catch { /* pas encore pret */ }
    await sleep(500);
  }
  throw new Error("Le serveur de test n'a jamais repondu.");
};

const startServer = async (port: number, env: Record<string, string>): Promise<ServerHandle> => {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(command, ["tsx", "src/server.ts"], {
    env: { ...process.env, WEB_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  child.stdout?.on("data", (c: Buffer) => log("SERVER", c.toString().trim()));
  child.stderr?.on("data", (c: Buffer) => log("SERVER-ERR", c.toString().trim()));
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  return { child, baseUrl };
};

const killTree = (pid: number | undefined): Promise<void> => new Promise((resolve) => {
  if (!pid) { resolve(); return; }
  if (process.platform === "win32") {
    const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"]);
    k.once("exit", () => resolve());
    k.once("error", () => resolve());
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* deja mort */ }
  resolve();
});

// --- HTTP / auth ---

const requestJson = async (baseUrl: string, method: string, pathName: string, cookie: string | undefined, json?: unknown): Promise<any> => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(json ?? {}) } : {})
  });
  const text = await res.text();
  const setCookie = res.headers.get("set-cookie");
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, cookie: setCookie?.split(";")[0] };
};

const loginWithRetry = async (baseUrl: string, loginName: string, password: string, attempts = 5): Promise<string> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await requestJson(baseUrl, "POST", "/api/login", undefined, { login: loginName, password });
    if (result.status === 200 && result.cookie) return result.cookie;
    lastError = new Error(`Login ${loginName} echoue: ${JSON.stringify(result.body)}`);
    await sleep(1_000);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) await pool.query("DELETE FROM users WHERE login LIKE $1", [`test-copyfb-%-${RUN_SUFFIX}`]);
  if (createdAgencyNames.length > 0) await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
};

const main = async (): Promise<void> => {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });

    server = await startServer(3283, { AGENT_UI_ENABLED: "true", BOT_EXECUTION_MODE: "agent" });
    const adminCookie = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    const agencyName = `Test CopyFeedback ${RUN_SUFFIX}`;
    createdAgencyNames.push(agencyName);
    const agencyId = (await requestJson(server.baseUrl, "POST", "/api/agencies", adminCookie, { name: agencyName, maxActiveClients: 15 })).body.agency.id;
    const managerLogin = `test-copyfb-mgr-${RUN_SUFFIX}`;
    createdUserLogins.push(managerLogin);
    const managerRes = await requestJson(server.baseUrl, "POST", "/api/users", adminCookie, {
      agencyId, login: managerLogin, name: "Copy Feedback Manager", email: `${managerLogin}@example.test`, role: 1
    });
    const managerPassword = managerRes.body.temporaryPassword;

    // ===================== Scenario 1: copie reussie (mot de passe temporaire) =====================
    log("SCENARIO-1", "=== Copie reussie: mot de passe temporaire (creation utilisateur) ===");
    const context1 = await browser.newContext();
    await context1.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.baseUrl });
    const page1 = await context1.newPage();
    await page1.goto(server.baseUrl);
    await page1.fill("#loginInput", managerLogin);
    await page1.fill("#passwordInput", managerPassword);
    await page1.click('#loginForm button[type="submit"]');
    await page1.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
    await page1.click('#agentSetupSkip').catch(() => undefined);
    await page1.click('[data-page-target="users"]');
    await page1.waitForSelector("#page-users.active");

    const newUserLogin = `test-copyfb-u1-${RUN_SUFFIX}`;
    createdUserLogins.push(newUserLogin);
    await page1.fill("#userLogin", newUserLogin);
    await page1.fill("#userName", "Copy Feedback User");
    await page1.fill("#userEmail", `${newUserLogin}@example.test`);
    await page1.click('#userForm button[type="submit"]');
    await page1.waitForSelector("#passwordNotice:not([hidden])", { timeout: 10_000 });

    const shownPassword = (await page1.locator("#temporaryPassword").innerText()).trim();
    assert(shownPassword.length > 0, "1) Mot de passe temporaire affiche apres creation");
    assert((await page1.locator("#copyPassword").innerText()).trim() === "Copier", "2) Bouton affiche 'Copier' avant tout clic");

    await page1.click("#copyPassword");
    const becameCopied = await waitUntil(async () => (await page1.locator("#copyPassword").innerText()).includes("Copié"), 3_000);
    assert(becameCopied, "3) Le bouton affiche 'Copié ✓' juste apres un clic reussi");

    const clipboardText = await page1.evaluate(() => navigator.clipboard.readText());
    assert(clipboardText === shownPassword, "4) Le presse-papiers contient exactement le mot de passe affiche");

    const revertedToCopier = await waitUntil(async () => (await page1.locator("#copyPassword").innerText()).trim() === "Copier", 4_000);
    assert(revertedToCopier, "5) Le bouton revient a 'Copier' apres le delai (~2s)");

    // Meme mecanisme reutilise pour la reinitialisation de mot de passe.
    // #passwordNotice est deja visible depuis la creation ci-dessus (jamais
    // fermee): on attend donc que le CONTENU change reellement plutot que la
    // seule visibilite (deja vraie), sans quoi la lecture pourrait devancer
    // la reponse de /api/users/:id/reset-password.
    await page1.locator("#userTableBody tr", { hasText: newUserLogin }).locator('button[data-user-action="reset-password"]').click();
    await waitUntil(async () => {
      const current = (await page1.locator("#temporaryPassword").innerText()).trim();
      return current.length > 0 && current !== shownPassword;
    }, 10_000);
    const resetPassword = (await page1.locator("#temporaryPassword").innerText()).trim();
    assert(resetPassword.length > 0 && resetPassword !== shownPassword, "6) Nouveau mot de passe temporaire affiche apres reinitialisation");
    await page1.click("#copyPassword");
    const resetCopied = await waitUntil(async () => (await page1.locator("#copyPassword").innerText()).includes("Copié"), 3_000);
    assert(resetCopied, "7) Le meme bouton fonctionne aussi pour le mot de passe de reinitialisation");
    const clipboardTextReset = await page1.evaluate(() => navigator.clipboard.readText());
    assert(clipboardTextReset === resetPassword, "8) Le presse-papiers contient le mot de passe de reinitialisation (pas l'ancien)");

    await context1.close();

    // ===================== Scenario 2: copie reussie (code d'appairage) =====================
    log("SCENARIO-2", "=== Copie reussie: code d'appairage Agent ===");
    const context2 = await browser.newContext();
    await context2.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.baseUrl });
    const page2 = await context2.newPage();
    await page2.goto(server.baseUrl);
    await page2.fill("#loginInput", managerLogin);
    await page2.fill("#passwordInput", managerPassword);
    await page2.click('#loginForm button[type="submit"]');
    await page2.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
    await page2.click('[data-page-target="agent"]');
    await page2.waitForSelector("#page-agent.active");
    await page2.click("#agentPageGenerateCode");
    await page2.waitForSelector("#agentPagePairingBox:not([hidden])", { timeout: 10_000 });

    const pairingCode = (await page2.locator("#agentPagePairingCode").innerText()).trim();
    assert(pairingCode.length > 0, "9) Code d'appairage affiche");
    assert((await page2.locator("#agentPageCopyCode").innerText()).trim() === "Copier", "10) Bouton affiche 'Copier' avant tout clic (code d'appairage)");

    await page2.click("#agentPageCopyCode");
    const codeCopied = await waitUntil(async () => (await page2.locator("#agentPageCopyCode").innerText()).includes("Copié"), 3_000);
    assert(codeCopied, "11) Le bouton affiche 'Copié ✓' apres un clic reussi (code d'appairage)");

    const clipboardCode = await page2.evaluate(() => navigator.clipboard.readText());
    assert(clipboardCode === pairingCode, "12) Le presse-papiers contient exactement le code d'appairage affiche");

    const codeReverted = await waitUntil(async () => (await page2.locator("#agentPageCopyCode").innerText()).trim() === "Copier", 4_000);
    assert(codeReverted, "13) Le bouton du code d'appairage revient a 'Copier' apres le delai");

    await context2.close();

    // ===================== Scenario 3: echec du presse-papiers =====================
    log("SCENARIO-3", "=== Echec du presse-papiers: jamais 'Copié', 'Copie impossible' affiche ===");
    const context3 = await browser.newContext();
    // AUCUNE permission clipboard accordee ET ecriture forcee en echec: simule
    // un presse-papiers indisponible (permission refusee, contexte non
    // securise...) de maniere deterministe, plutot que de dependre d'un
    // comportement de permission variable selon l'environnement CI.
    await context3.addInitScript(() => {
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("Ecriture presse-papiers refusee (simulation de test).")) }
      });
    });
    const page3 = await context3.newPage();
    await page3.goto(server.baseUrl);
    await page3.fill("#loginInput", managerLogin);
    await page3.fill("#passwordInput", managerPassword);
    await page3.click('#loginForm button[type="submit"]');
    await page3.waitForSelector("#appLayout:not([hidden])", { timeout: 10_000 });
    await page3.click('[data-page-target="users"]');
    await page3.waitForSelector("#page-users.active");

    const newUserLogin2 = `test-copyfb-u2-${RUN_SUFFIX}`;
    createdUserLogins.push(newUserLogin2);
    await page3.fill("#userLogin", newUserLogin2);
    await page3.fill("#userName", "Copy Feedback User 2");
    await page3.fill("#userEmail", `${newUserLogin2}@example.test`);
    await page3.click('#userForm button[type="submit"]');
    await page3.waitForSelector("#passwordNotice:not([hidden])", { timeout: 10_000 });
    const shownPassword2 = (await page3.locator("#temporaryPassword").innerText()).trim();

    await page3.click("#copyPassword");
    const showsImpossible = await waitUntil(async () => (await page3.locator("#copyPassword").innerText()).includes("Copie impossible"), 3_000);
    assert(showsImpossible, "14) 'Copie impossible' affiche quand le presse-papiers echoue");
    assert(!(await page3.locator("#copyPassword").innerText()).includes("Copié"), "15) 'Copié' n'est jamais affiche en cas d'echec");

    // Point 3 du cahier des charges: l'utilisateur doit pouvoir selectionner
    // manuellement la valeur - verifie que le helper pre-selectionne bien le
    // texte source (l'utilisateur n'a alors qu'a faire Ctrl+C lui-meme).
    const selectedText = await page3.evaluate(() => window.getSelection()?.toString() ?? "");
    assert(selectedText === shownPassword2, "16) Le mot de passe reste selectionnable manuellement apres l'echec (pre-selectionne)");

    await context3.close();
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (server) await killTree(server.child.pid);
    await cleanupTestData();
    await pool.end();
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exit(failCount > 0 ? 1 : 0);
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
