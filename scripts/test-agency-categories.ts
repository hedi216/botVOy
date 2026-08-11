// QUICK HOTFIX (categories gerees independamment par chaque agence).
//
// Teste uniquement la logique de ce hotfix (DB reelle, service layer,
// resolution serveur du role/agency_id) - jamais les suites Agent/recovery/
// refresh/packaging existantes (hors scope, deja couvertes ailleurs).
//
// Usage: npx tsx scripts/test-agency-categories.ts

import { ChildProcess, spawn } from "node:child_process";
import { Socket, io as ioClient } from "socket.io-client";
import { ADMIN_LOGIN, ADMIN_PASSWORD, DbUser, DEFAULT_AGENCY_CATEGORIES, ensureSchema, pool } from "../src/db.js";
import {
  createAgency,
  createAgencyCategory,
  createUser,
  deleteAgencyCategory,
  getCategoriesReadAgencyId,
  getSettingsAgencyId,
  initUserModule,
  listAgencyCategories,
  renameAgencyCategory
} from "../src/userService.js";

const RUN_SUFFIX = Date.now();

let passCount = 0;
let failCount = 0;

const log = (label: string, message: string): void => {
  console.log(`[${new Date().toISOString()}] [${label}] ${message}`);
};

const assert = (condition: boolean, description: string): void => {
  if (condition) {
    passCount += 1;
    console.log(`[PASS] ${description}`);
  } else {
    failCount += 1;
    console.error(`[FAIL] ${description}`);
  }
};

const createdAgencyNames: string[] = [];
const createdUserLogins: string[] = [];

const makeTestAgency = async (label: string): Promise<number> => {
  const name = `Test Categories ${label} ${RUN_SUFFIX}`;
  createdAgencyNames.push(name);
  const agency = await createAgency(name);
  return agency.id;
};

const cleanupTestData = async (): Promise<void> => {
  if (createdUserLogins.length > 0) {
    await pool.query("DELETE FROM users WHERE login = ANY($1::text[])", [createdUserLogins]);
  }
  if (createdAgencyNames.length > 0) {
    // ON DELETE CASCADE (agency_categories.agency_id) nettoie deja les
    // categories de test associees.
    await pool.query("DELETE FROM agencies WHERE name = ANY($1::text[])", [createdAgencyNames]);
  }
};

const fakeUser = (role: number, agencyId: number | null): DbUser => ({
  id: -1,
  agency_id: agencyId,
  login: "test-fake-user",
  name: "Test",
  email: null,
  photo_url: null,
  role,
  is_active: true,
  failed_login_attempts: 0,
  created_at: new Date().toISOString(),
  last_login_at: null,
  password_changed_at: null
});

// --------------------------------------------------------------------------
// Section 1: seed initial par agence (nouvelle agence -> copie exacte des
// defauts actuels, jamais une liste inventee).
// --------------------------------------------------------------------------

const runSeedTests = async (): Promise<number> => {
  log("SECTION", "1) Seed initial d'une nouvelle agence (createAgency)");

  const agencyId = await makeTestAgency("Seed");
  const categories = await listAgencyCategories(agencyId);

  assert(categories.length === DEFAULT_AGENCY_CATEGORIES.length, `A) Une nouvelle agence recoit exactement ${DEFAULT_AGENCY_CATEGORIES.length} categories par defaut (recu: ${categories.length})`);
  const names = categories.map((c) => c.name).sort();
  const expected = [...DEFAULT_AGENCY_CATEGORIES].sort();
  assert(JSON.stringify(names) === JSON.stringify(expected), `A) La liste recue correspond EXACTEMENT (verbatim) a la liste actuelle - jamais une liste inventee (recu: ${JSON.stringify(names)})`);

  const seededAgency = await pool.query<{ categories_seeded_at: string | null }>(
    "SELECT categories_seeded_at FROM agencies WHERE id = $1",
    [agencyId]
  );
  assert(seededAgency.rows[0]?.categories_seeded_at !== null, "A) categories_seeded_at est pose au moment de la creation (jamais NULL apres createAgency)");

  return agencyId;
};

// --------------------------------------------------------------------------
// Section 2: isolation stricte entre agences (suppression/ajout dans une
// agence sans AUCUN effet sur une autre - meme nom autorise dans les deux).
// --------------------------------------------------------------------------

const runIsolationTests = async (agencyA: number): Promise<void> => {
  log("SECTION", "2) Isolation A/B (suppression, ajout, meme nom dans les deux)");

  const agencyB = await makeTestAgency("Isolation-B");

  const categoriesA = await listAgencyCategories(agencyA);
  const toDeleteInA = categoriesA.find((c) => c.name === "Visite circulation")!;
  await deleteAgencyCategory(agencyA, toDeleteInA.id);

  const afterDeleteA = await listAgencyCategories(agencyA);
  const afterB = await listAgencyCategories(agencyB);
  assert(!afterDeleteA.some((c) => c.name === "Visite circulation"), "B) Agence A a bien perdu 'Visite circulation'");
  assert(afterB.some((c) => c.name === "Visite circulation"), "B) Agence B (jamais touchee) possede toujours 'Visite circulation' - aucune action de A ne modifie B");

  await createAgencyCategory(agencyA, "VIP");
  const afterAddA = await listAgencyCategories(agencyA);
  const afterAddB = await listAgencyCategories(agencyB);
  assert(afterAddA.some((c) => c.name === "VIP"), "B) Agence A possede bien 'VIP' apres ajout");
  assert(!afterAddB.some((c) => c.name === "VIP"), "B) Agence B ne voit PAS 'VIP' ajoutee dans A - aucun melange entre agences");

  const vipInB = await createAgencyCategory(agencyB, "VIP");
  assert(vipInB.name === "VIP" && vipInB.agencyId === agencyB, "B) Le MEME nom 'VIP' est autorise dans B - l'unicite n'est qu'intra-agence, jamais globale");

  const duplicateAttempt = await createAgencyCategory(agencyA, "VIP").then(() => null).catch((error: Error) => error);
  assert(duplicateAttempt instanceof Error, "C) Un nom deja utilise DANS LA MEME agence (A, 'VIP' en double) est rejete");

  const renameTarget = afterAddA.find((c) => c.name === "Affaires et professionnel")!;
  const renamed = await renameAgencyCategory(agencyA, renameTarget.id, "Affaires (renomme)");
  assert(renamed.name === "Affaires (renomme)", "D) Renommer une categorie fonctionne (role 1/0 uniquement, cf. routes)");
  const renameCollision = await renameAgencyCategory(agencyA, renameTarget.id, "VIP").then(() => null).catch((error: Error) => error);
  assert(renameCollision instanceof Error, "D) Renommer vers un nom deja utilise DANS LA MEME agence est rejete");
};

// --------------------------------------------------------------------------
// Section 3: resolution SERVEUR de l'agence (role/agency_id depuis la
// session) - jamais un agencyId fourni par un role 1/2 pour agir sur une
// autre agence.
// --------------------------------------------------------------------------

const runRoleResolutionTests = (agencyA: number): void => {
  log("SECTION", "3) Isolation backend (role/agencyId resolus cote serveur, jamais depuis le client)");

  const otherAgencyId = agencyA + 999_999; // agence arbitraire "d'un autre"

  const role1Own = fakeUser(1, agencyA);
  assert(
    getSettingsAgencyId(role1Own, otherAgencyId) === agencyA,
    "E) Role 1: un agencyId different envoye par le client est IGNORE - toujours sa propre agence de session (jamais de spoofing)"
  );

  const role2Own = fakeUser(2, agencyA);
  assert(getSettingsAgencyId(role2Own, otherAgencyId) === null, "E) Role 2 ne peut jamais administrer (create/rename/delete) les categories - getSettingsAgencyId refuse");
  assert(getCategoriesReadAgencyId(role2Own, otherAgencyId) === agencyA, "E) Role 2 peut LIRE les categories de SA propre agence (dropdown du formulaire Bot), jamais celles envoyees par le client");

  const role0NoValue = fakeUser(0, null);
  assert(getSettingsAgencyId(role0NoValue, undefined) === null, "E) Role 0 (admin global) sans agence explicite fournie -> aucune agence resolue (jamais une agence par defaut implicite)");
  assert(getSettingsAgencyId(role0NoValue, agencyA) === agencyA, "E) Role 0 peut cibler explicitement n'importe quelle agence (agencyId fourni par la requete, seul role autorise a le faire)");
};

// --------------------------------------------------------------------------
// Section 4: seed one-time pour les agences PRE-EXISTANTES (backfill
// ensureSchema()) - jamais un resync qui annulerait une suppression
// utilisateur a chaque redemarrage serveur.
// --------------------------------------------------------------------------

const runOneTimeBackfillTests = async (): Promise<void> => {
  log("SECTION", "4) Backfill one-time (agence 'pre-existante', jamais resynchronisee ensuite)");

  // Simule une agence deja presente AVANT ce hotfix: creee par INSERT direct
  // (jamais createAgency(), qui seed deja + pose categories_seeded_at) ->
  // categories_seeded_at reste NULL, exactement l'etat d'une agence reelle
  // au moment du deploiement de ce hotfix.
  const name = `Test Categories Backfill ${RUN_SUFFIX}`;
  createdAgencyNames.push(name);
  const inserted = await pool.query<{ id: number }>(
    "INSERT INTO agencies (name) VALUES ($1) RETURNING id",
    [name]
  );
  const agencyId = inserted.rows[0].id;

  const beforeBackfill = await listAgencyCategories(agencyId);
  assert(beforeBackfill.length === 0, "F) Agence 'pre-existante' simulee: 0 categorie avant le premier passage du backfill");

  await ensureSchema();

  const afterFirstBackfill = await listAgencyCategories(agencyId);
  assert(afterFirstBackfill.length === DEFAULT_AGENCY_CATEGORIES.length, `F) Premier redemarrage apres le hotfix: cette agence recoit bien les ${DEFAULT_AGENCY_CATEGORIES.length} defauts (recu: ${afterFirstBackfill.length})`);

  // L'utilisateur supprime ENSUITE volontairement TOUTES ses categories.
  await pool.query("DELETE FROM agency_categories WHERE agency_id = $1", [agencyId]);
  const afterUserDeletesAll = await listAgencyCategories(agencyId);
  assert(afterUserDeletesAll.length === 0, "F) L'agence a bien 0 categorie apres suppression volontaire de toutes ses categories");

  // Un redemarrage serveur ULTERIEUR (nouveau passage d'ensureSchema()) ne
  // doit JAMAIS les recreer - categories_seeded_at est deja pose.
  await ensureSchema();
  const afterSecondBoot = await listAgencyCategories(agencyId);
  assert(afterSecondBoot.length === 0, "F) Un redemarrage serveur ULTERIEUR ne recree PAS les categories supprimees (categories_seeded_at empeche tout resync)");
};

// --------------------------------------------------------------------------
// Section 5: guards server reels (serveur HTTP+socket reel spawn) - billing
// sur l'ecriture des categories, et validation serveur de `category` a
// START_BOT (jamais une valeur cliente arbitraire acceptee).
// --------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type ServerHandle = { child: ChildProcess; baseUrl: string };

const waitForServerReady = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/me`);
      if (res.status === 401 || res.status === 200) {
        return;
      }
    } catch {
      // pas encore pret
    }
    await sleep(500);
  }
  throw new Error(`Le serveur de test n'a jamais repondu sur ${baseUrl}/api/me.`);
};

const startServer = async (port: number): Promise<ServerHandle> => {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(command, ["tsx", "src/server.ts"], {
    env: { ...process.env, WEB_PORT: String(port), BOT_EXECUTION_MODE: "agent" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  const baseUrl = `http://localhost:${port}`;
  await waitForServerReady(baseUrl);
  return { child, baseUrl };
};

const stopServer = async (handle: ServerHandle): Promise<void> => {
  if (!handle.child.pid) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(handle.child.pid), "/T", "/F"]);
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  handle.child.kill("SIGTERM");
};

type HttpResult = { status: number; body: unknown; cookie: string | undefined };

const extractCookie = (res: Response): string | undefined => {
  const raw = res.headers.get("set-cookie");
  return raw ? raw.split(";")[0] : undefined;
};

const requestJson = async (
  baseUrl: string,
  method: string,
  pathName: string,
  cookie: string | undefined,
  json?: unknown
): Promise<HttpResult> => {
  const hasBody = !["GET", "HEAD"].includes(method.toUpperCase());
  const res = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(hasBody ? { "Content-Type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(json ?? {}) } : {})
  });
  const rawText = await res.text();
  let body: unknown = null;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    body = rawText;
  }
  return { status: res.status, body, cookie: extractCookie(res) };
};

const login = async (baseUrl: string, loginName: string, password: string): Promise<{ cookie: string; body: unknown }> => {
  const result = await requestJson(baseUrl, "POST", "/api/login", undefined, { login: loginName, password });
  if (result.status !== 200 || !result.cookie) {
    throw new Error(`Login ${loginName} a echoue: ${JSON.stringify(result.body)}`);
  }
  return { cookie: result.cookie, body: result.body };
};

const loginWithRetry = async (baseUrl: string, loginName: string, password: string, attempts = 5): Promise<{ cookie: string; body: unknown }> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await login(baseUrl, loginName, password);
    } catch (error) {
      lastError = error;
      await sleep(1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const connectUiSocket = (baseUrl: string, cookie: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { autoConnect: false, reconnection: false, forceNew: true, extraHeaders: { Cookie: cookie } });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error("Timeout connexion socket UI.")); }, 8_000);
    socket.on("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.on("connect_error", (error: Error) => { clearTimeout(timer); reject(error); });
    socket.connect();
  });

const waitUntilAsync = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000, intervalMs = 100): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return predicate();
};

const runStartBotAndBillingGuardTests = async (): Promise<void> => {
  log("SECTION", "5) Guards serveur reels: billing sur l'ecriture des categories + validation category a START_BOT");

  const server = await startServer(3399);
  try {
    const admin = await loginWithRetry(server.baseUrl, ADMIN_LOGIN, ADMIN_PASSWORD);

    const agencyXName = `Test Categories Guard X ${RUN_SUFFIX}`;
    createdAgencyNames.push(agencyXName);
    const agencyXResult = await requestJson(server.baseUrl, "POST", "/api/agencies", admin.cookie, { name: agencyXName, maxActiveClients: 15 });
    const agencyX = (agencyXResult.body as { agency: { id: number } }).agency.id;

    const agencyYName = `Test Categories Guard Y ${RUN_SUFFIX}`;
    createdAgencyNames.push(agencyYName);
    const agencyYResult = await requestJson(server.baseUrl, "POST", "/api/agencies", admin.cookie, { name: agencyYName, maxActiveClients: 15 });
    const agencyY = (agencyYResult.body as { agency: { id: number } }).agency.id;

    const managerLogin = `test-cat-guard-mgr-${RUN_SUFFIX}`;
    createdUserLogins.push(managerLogin);
    const managerResult = await createUser({ agencyId: agencyX, login: managerLogin, name: "Manager Guard", email: `${managerLogin}@example.test`, role: 1 });
    const managerCookie = (await loginWithRetry(server.baseUrl, managerLogin, managerResult.temporaryPassword)).cookie;

    const categoriesX = await listAgencyCategories(agencyX);
    const validCategoryName = categoriesX[0].name;
    const toDeleteCategory = categoriesX[1];

    // Categorie EXISTANT UNIQUEMENT dans Y (jamais dans X): distincte des 6
    // defauts (identiques dans X et Y) pour prouver l'isolation, pas juste
    // l'existence globale du nom.
    const onlyInYName = `SeulementDansY-${RUN_SUFFIX}`;
    await createAgencyCategory(agencyY, onlyInYName);

    // --- Test 1: agence suspendue -> ecriture categorie refusee (guard billing central reutilise) ---
    await pool.query("UPDATE agencies SET next_payment_date = CURRENT_DATE - INTERVAL '10 days' WHERE id = $1", [agencyX]);

    const suspendedCreate = await requestJson(server.baseUrl, "POST", "/api/categories", managerCookie, { name: `Suspendu-${RUN_SUFFIX}` });
    assert(
      suspendedCreate.status === 403 && (suspendedCreate.body as { code?: string }).code === "PAYMENT_SUSPENDED",
      "1) POST /api/categories refuse une agence PAYMENT_SUSPENDED (role 1) avec le code machine central"
    );

    const suspendedDelete = await requestJson(server.baseUrl, "DELETE", `/api/categories/${toDeleteCategory.id}`, managerCookie);
    assert(
      suspendedDelete.status === 403 && (suspendedDelete.body as { code?: string }).code === "PAYMENT_SUSPENDED",
      "1) DELETE /api/categories/:id refuse une agence PAYMENT_SUSPENDED (role 1) avec le code machine central"
    );

    const suspendedRead = await requestJson(server.baseUrl, "GET", "/api/categories", managerCookie);
    assert(suspendedRead.status === 200, "1) GET /api/categories reste accessible meme agence PAYMENT_SUSPENDED (lecture jamais bloquee)");

    const adminBypass = await requestJson(server.baseUrl, "POST", "/api/categories", admin.cookie, { agencyId: agencyX, name: `AdminBypass-${RUN_SUFFIX}` });
    assert(adminBypass.status === 200, "1) Role 0 (admin global) bypasse toujours le guard billing, y compris pour une agence PAYMENT_SUSPENDED");

    // Regularisation: necessaire pour que les tests START_BOT suivants ne
    // soient jamais refuses pour une raison DIFFERENTE (billing) - on isole
    // strictement la validation de categorie.
    await pool.query("UPDATE agencies SET next_payment_date = CURRENT_DATE + INTERVAL '30 days' WHERE id = $1", [agencyX]);

    // --- Test 2/3/4: START_BOT - validation serveur de `category` ---
    const uiSocket = await connectUiSocket(server.baseUrl, managerCookie);
    const botStatusEvents: Array<{ status: string; code?: string }> = [];
    uiSocket.on("bot-status", (payload: { status: string; code?: string }) => botStatusEvents.push(payload));

    try {
      // Test 2: categorie valide (existe reellement pour l'agence de session) -> passe la validation.
      botStatusEvents.length = 0;
      uiSocket.emit("start-bot", { botName: `Bot Valide ${RUN_SUFFIX}`, category: validCategoryName, clientRequestId: `tc-cat-valid-${RUN_SUFFIX}` });
      await waitUntilAsync(() => botStatusEvents.length > 0);
      assert(
        botStatusEvents.length > 0 && botStatusEvents[0].code !== "CATEGORY_INVALID",
        `2) Categorie valide (${validCategoryName}) -> START_BOT passe la validation de categorie (code recu: ${botStatusEvents[0]?.code ?? "aucun"})`
      );

      // Test 3a: categorie jamais existante pour cette agence -> refus.
      botStatusEvents.length = 0;
      uiSocket.emit("start-bot", { botName: `Bot Inexistant ${RUN_SUFFIX}`, category: `NexistePas-${RUN_SUFFIX}`, clientRequestId: `tc-cat-missing-${RUN_SUFFIX}` });
      await waitUntilAsync(() => botStatusEvents.some((e) => e.code === "CATEGORY_INVALID"));
      assert(
        botStatusEvents.some((e) => e.code === "CATEGORY_INVALID"),
        "3) Categorie inexistante pour cette agence -> START_BOT refuse avec CATEGORY_INVALID"
      );

      // Test 3b: categorie reellement supprimee depuis (existait, puis retiree) -> refus.
      const deleteResult = await requestJson(server.baseUrl, "DELETE", `/api/categories/${toDeleteCategory.id}`, managerCookie);
      assert(deleteResult.status === 200, "3b) Precondition: suppression de la categorie via l'API reussit (agence redevenue current)");
      botStatusEvents.length = 0;
      uiSocket.emit("start-bot", { botName: `Bot Supprime ${RUN_SUFFIX}`, category: toDeleteCategory.name, clientRequestId: `tc-cat-deleted-${RUN_SUFFIX}` });
      await waitUntilAsync(() => botStatusEvents.some((e) => e.code === "CATEGORY_INVALID"));
      assert(
        botStatusEvents.some((e) => e.code === "CATEGORY_INVALID"),
        `3b) Categorie recemment supprimee (${toDeleteCategory.name}) -> START_BOT refuse avec CATEGORY_INVALID (jamais recreee/acceptee)`
      );

      // Test 4: categorie existant SEULEMENT dans une autre agence (Y) -> refus pour X.
      botStatusEvents.length = 0;
      uiSocket.emit("start-bot", { botName: `Bot Autre Agence ${RUN_SUFFIX}`, category: onlyInYName, clientRequestId: `tc-cat-foreign-${RUN_SUFFIX}` });
      await waitUntilAsync(() => botStatusEvents.some((e) => e.code === "CATEGORY_INVALID"));
      assert(
        botStatusEvents.some((e) => e.code === "CATEGORY_INVALID"),
        `4) Categorie existant uniquement dans une AUTRE agence (${onlyInYName}) -> START_BOT refuse pour l'agence de session (aucun melange entre agences)`
      );
    } finally {
      uiSocket.disconnect();
    }

    await requestJson(server.baseUrl, "POST", "/api/logout", managerCookie);
  } finally {
    await stopServer(server);
  }
};

// --------------------------------------------------------------------------

const run = async (): Promise<void> => {
  await initUserModule();
  try {
    const agencyA = await runSeedTests();
    await runIsolationTests(agencyA);
    runRoleResolutionTests(agencyA);
    await runOneTimeBackfillTests();
    await runStartBotAndBillingGuardTests();
  } finally {
    await cleanupTestData().catch((error) => log("CLEANUP_ERROR", String(error)));
    await pool.end().catch(() => undefined);
  }
};

run()
  .then(() => {
    console.log(`\n${passCount} succes, ${failCount} echec(s).`);
    process.exit(failCount > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error("Erreur fatale pendant le scenario de test:", error);
    process.exit(1);
  });
