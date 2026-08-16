import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { createReadStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Server, Socket } from "socket.io";
import { createBotSession, BotSession, SessionEvent, SessionStatus } from "./sessionManager.js";
import {
  deleteBrowserProfileForAgency,
  listBrowserProfiles,
  reserveStandardProfileForBot
} from "./browserProfileService.js";
import {
  cancelRecordingExtensionPreparation,
  confirmRecordingExtensionPreparation,
  getActivePreparation,
  startProfileExtensionManagement,
  startRecordingExtensionPreparation,
  stopProfileExtensionManagement
} from "./recordingExtensionService.js";
import { logger } from "./logger.js";
import { AuthenticatedRequest, createSession, destroySession, getSessionUser, requireAdmin, requireAgencyManager, requireAuth } from "./auth.js";
import { DbUser } from "./db.js";
import {
  authenticateUser,
  changeOwnPassword,
  createAgency,
  createAgencyCategory,
  createUser,
  createExtensionLink,
  deleteAgencyCategory,
  deleteExtensionLink,
  getAgency,
  getAgencyMonitoringSettings,
  getAgencySettings,
  getCategoriesReadAgencyId,
  getSettingsAgencyId,
  fromPublicMonitoringSettingsPatch,
  initUserModule,
  listAgencies,
  listAgencyCategories,
  listExtensionLinks,
  listUsersForRequester,
  PublicMonitoringSettingsPatch,
  renameAgencyCategory,
  resetUserPassword,
  toPublicMonitoringSettings,
  updateAgency,
  updateAgencyMonitoringSettings,
  updateAgencyRecordingExtensionSettings,
  updateExtensionLink,
  updateUser
} from "./userService.js";
import { notifyUserIfNeeded } from "./notifications.js";
import { sendAppAlert } from "./appAlertService.js";
import { loadAgentCommandConfig, loadAgentGatewayConfig, loadAgentReleaseConfig, loadPhase2FeatureFlags, resolveAgentTlsStartUrl } from "./config.js";
import { getAgentReleaseMetadata, resolveAgentReleaseDownload } from "./agentReleaseService.js";
import { requirePositiveInt, requireValidPort } from "./envValidation.js";
import { createPairingCode, getAgentById, listAgentsForAgency, renameAgent, revokeAgent } from "./agentService.js";
import {
  AgentSnapshot,
  disconnectAgentSocket,
  getConnectedAgentSocket,
  getSnapshotForAgent,
  isAgentReadyForCommands,
  registerAgentNamespace
} from "./agentGateway.js";
import {
  BOT_STATUS_VALUES,
  PublicAgentCommand,
  clearTerminalCommandsForAgency,
  countActiveAgentBotsForAgency,
  deleteCommandForAgency,
  dispatchAgentCommand,
  failNonTerminalOnRevoke,
  generateBotId,
  archiveAgentIfNoActiveBots,
  getAgentBot,
  getCommandForAgency,
  getLatestCommandForBot,
  listAgentBotsForAgency,
  listAgentCommandsForAgency,
  registerAgentBot,
  removeAgentBot,
  stopAllBotsForAgent,
  toPublicAgentCommand,
  toPublicAgentCommandDetail
} from "./agentCommandService.js";
import {
  checkAgencyBillingAccess,
  computeAgencyBillingState,
  getAgencyBillingState,
  PAYMENT_SUSPENDED_CODE,
  PAYMENT_SUSPENDED_MESSAGE,
  requireAgencyBillingAccess,
  updateAgencyBilling
} from "./agencyBillingService.js";
import { startAgencyBillingScheduler } from "./agencyBillingScheduler.js";

// HOTFIX CIBLE (isolation des logs entre utilisateurs et agences):
// userId/agencyId peuvent tous deux etre inconnus/non fiables au moment ou un
// log est produit (ex. bot Agent dont le AgentBotRecord n'est plus dans le
// registre en memoire) - jamais remplaces par une valeur sentinelle (0/-1)
// qui pourrait accidentellement correspondre a un utilisateur/une agence
// reels: null signifie explicitement "inconnu", exploite par canViewBotLog()
// ci-dessous pour refuser l'acces plutot que de deviner (fail closed).
type SessionOwner = {
  userId: number | null;
  agencyId: number | null;
  botName: string;
  category?: string;
  login?: string;
};

type StoredLog = {
  event: SessionEvent;
  owner: SessionOwner;
  sessionKey: string;
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const preferredPort = requireValidPort("WEB_PORT", process.env.WEB_PORT, 3000);
const maxClients = requirePositiveInt("MAX_CLIENTS_PER_VM", process.env.MAX_CLIENTS_PER_VM, 15);
const agentGatewayConfig = loadAgentGatewayConfig();
const featureFlags = loadPhase2FeatureFlags();
const agentCommandConfig = loadAgentCommandConfig();
const agentReleaseConfig = loadAgentReleaseConfig();
const sessions = new Map<string, BotSession>();
const sessionOwners = new Map<string, SessionOwner>();
const socketUsers = new Map<string, DbUser>();
const selectedSessionBySocket = new Map<string, string>();
const activePrompts = new Map<string, { message: string; owner: SessionOwner }>();
const logHistory: StoredLog[] = [];
let currentPort = preferredPort;

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(path.join(process.cwd(), "public")));

// Routes SPA pour les nouvelles pages Agent (aucun fichier statique
// correspondant): ne servent index.html que si la fonctionnalite est
// activee, pour que ces chemins restent inexistants (404) quand
// AGENT_UI_ENABLED=false, exactement comme avant la Phase 2.
if (featureFlags.agentUiEnabled) {
  app.get(["/agent", "/agent/setup"], (_req, res) => {
    res.sendFile(path.join(process.cwd(), "public", "index.html"));
  });
}

// CHANTIER CIBLE (gestion des echeances et impayes): meme si l'agence est
// suspendue, le login REUSSIT toujours pour des identifiants corrects (une
// session limitee est necessaire pour afficher l'ecran de suspension et
// permettre logout - jamais un blocage au niveau du login lui-meme). Le
// signal distinctif n'est pas un statut HTTP special mais l'objet `billing`
// inclus dans la reponse: billing.status==="suspended" (ou plus generalement
// !accessAllowed) est ce que le frontend utilise pour basculer immediatement
// sur l'ecran verrouille des la reponse de login, sans jamais recalculer la
// logique metier lui-meme (source unique: computeAgencyBillingState cote
// serveur). null pour role 0 (admin global, jamais concerne).
const billingContextForUser = async (user: DbUser): Promise<ReturnType<typeof computeAgencyBillingState> | null> => {
  if (user.role === 0 || !user.agency_id) {
    return null;
  }
  try {
    return await getAgencyBillingState(user.agency_id);
  } catch {
    return null;
  }
};

app.post("/api/login", async (req, res) => {
  const { login, password } = req.body as { login?: string; password?: string };
  const user = await authenticateUser(login ?? "", password ?? "");

  if (!user) {
    res.status(401).json({ error: "Login ou mot de passe invalide." });
    return;
  }

  const token = createSession(user);
  res.cookie("rdv_session", token, {
    httpOnly: true,
    sameSite: "lax"
  });
  res.json({ user, billing: await billingContextForUser(user) });
});

app.post("/api/logout", (req, res) => {
  destroySession(req.cookies?.rdv_session as string | undefined);
  res.clearCookie("rdv_session");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, async (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user, billing: await billingContextForUser(req.user!) });
});

// CORRECTIF CIBLE (release 0.2.4, bandeau de mise a jour obligatoire):
// requiredAgentVersion vient EXCLUSIVEMENT de agentGatewayConfig.minAgentVersion
// (deja la source de verite utilisee par computeLiveStatus()/isVersionAtLeast()
// pour calculer VERSION_INCOMPATIBLE) - jamais hardcode cote frontend, et
// jamais deduit de la release disponible au telechargement (AGENT_RELEASE_VERSION
// est une notion distincte: version de l'installateur propose, pas version
// minimale exigee). Champ public, non sensible.
app.get("/api/client-config", requireAuth, (_req, res) => {
  res.json({
    agentUiEnabled: featureFlags.agentUiEnabled,
    agentDownloadUrl: featureFlags.agentDownloadUrl,
    botExecutionMode: featureFlags.botExecutionMode,
    requiredAgentVersion: agentGatewayConfig.minAgentVersion
  });
});

// Phase 5 (Lot 4, section 4): renvoie la release explicitement configuree
// (jamais une selection arbitraire du contenu du dossier de releases) -
// available:false si l'artefact est absent/invalide, jamais une exception.
app.get("/api/agent/releases/latest", requireAuth, async (_req, res) => {
  try {
    const metadata = await getAgentReleaseMetadata(agentReleaseConfig);
    res.json(metadata);
  } catch (error) {
    logger.error(`Erreur interne /api/agent/releases/latest: ${error instanceof Error ? error.message : String(error)}`);
    res.json({ available: false });
  }
});

const RELEASE_VERSION_PARAM_PATTERN = /^\d+\.\d+\.\d+$/;

// Section 5: version validee strictement, aucun nom de fichier fourni par
// l'utilisateur, streaming (jamais un chargement complet en memoire), aucune
// information sensible (chemin disque) dans une reponse ou un log destine au
// client.
app.get("/api/agent/releases/:version/download", requireAuth, async (req, res) => {
  // Express 5 type req.params[key] en string | string[] (path-to-regexp
  // generique) - notre route n'a qu'un seul segment simple, jamais un
  // tableau en pratique, mais on refuse explicitement ce cas plutot que de
  // forcer un cast non sur.
  const requestedVersion = req.params.version;
  if (typeof requestedVersion !== "string" || !RELEASE_VERSION_PARAM_PATTERN.test(requestedVersion)) {
    res.status(400).json({ error: "Version invalide." });
    return;
  }

  let target;
  try {
    target = await resolveAgentReleaseDownload(agentReleaseConfig, requestedVersion);
  } catch (error) {
    logger.error(`Erreur interne telechargement de release: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({ error: "Erreur interne." });
    return;
  }

  if (!target) {
    res.status(404).json({ error: "Release indisponible." });
    return;
  }

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${target.fileName}"`);
  res.setHeader("Content-Length", String(target.sizeBytes));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");

  const stream = createReadStream(target.filePath);
  stream.on("error", (error) => {
    logger.error(`Erreur de streaming pendant le telechargement d'une release: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Erreur interne." });
    } else {
      res.destroy();
    }
  });
  req.on("close", () => {
    stream.destroy();
  });
  stream.pipe(res);
});

app.post("/api/profile/password", requireAuth, async (req: AuthenticatedRequest, res) => {
  const body = req.body as { currentPassword?: string; newPassword?: string };
  await changeOwnPassword(req.user!.id, body.currentPassword ?? "", body.newPassword ?? "");
  res.json({ ok: true });
});

// CHANTIER CIBLE: `billing` est calcule ici (jamais stocke) et ajoute a
// chaque ligne, en plus des champs bruts deja renvoyes par listAgencies()
// (SELECT a.* -> next_payment_date/billing_override_until/payment_suspended_at
// deja presents automatiquement) - la meme fonction unique
// computeAgencyBillingState() que le guard d'acces et le scheduler, jamais
// une logique recalculee cote frontend.
app.get("/api/agencies", requireAuth, requireAdmin, async (_req, res) => {
  const agencies = await listAgencies();
  res.json({
    agencies: agencies.map((agency) => ({ ...agency, billing: computeAgencyBillingState(agency) }))
  });
});

app.post("/api/agencies", requireAuth, requireAdmin, async (req, res) => {
  const body = req.body as { name?: string; maxActiveClients?: number; notificationEmail?: string };
  res.json({
    agency: await createAgency(
      body.name ?? "Nouvelle agence",
      body.maxActiveClients ?? 15,
      body.notificationEmail
    )
  });
});

app.patch("/api/agencies/:id", requireAuth, requireAdmin, async (req, res) => {
  const body = req.body as {
    isActive?: boolean;
    maxActiveClients?: number;
    notificationEmail?: string;
  };
  res.json({
    agency: await updateAgency(Number(req.params.id), {
      is_active: body.isActive,
      max_active_clients: body.maxActiveClients,
      notification_email: body.notificationEmail
    })
  });
});

// CHANTIER CIBLE (gestion des echeances et impayes): route DEDIEE, jamais
// fusionnee dans le PATCH /api/agencies/:id generique ci-dessus, qui repose
// sur COALESCE pour les champs absents - un COALESCE ne peut jamais exprimer
// "remettre explicitement billing_override_until a NULL" (supprimer une
// autorisation temporaire), contrairement a la semantique explicite voulue
// ici (cle absente = ne pas toucher, cle presente avec valeur null =
// effacer reellement). Reserve a role 0 (requireAdmin), comme le reste des
// routes /api/agencies.
app.patch("/api/agencies/:id/billing", requireAuth, requireAdmin, async (req: AuthenticatedRequest, res) => {
  const body = req.body as { nextPaymentDate?: string | null; overrideUntil?: string | null };
  try {
    const agency = await updateAgencyBilling(Number(req.params.id), body, req.user!.id);
    res.json({ agency: { ...agency, billing: computeAgencyBillingState(agency) } });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Requete invalide." });
  }
});

app.get("/api/users", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  res.json({ users: await listUsersForRequester(req.user!) });
});

app.post("/api/users", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  const body = req.body as {
    agencyId?: number;
    login?: string;
    name?: string;
    email?: string;
    photoUrl?: string;
    role?: 1 | 2;
    isActive?: boolean;
  };
  const agencyId = req.user!.role === 0 ? Number(body.agencyId) : Number(req.user!.agency_id);

  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  if (!body.email || !body.email.trim()) {
    res.status(400).json({ error: "L'adresse e-mail est obligatoire." });
    return;
  }

  res.json({
    ...(await createUser({
      agencyId,
      login: body.login ?? "",
      name: body.name ?? body.login ?? "",
      email: body.email,
      photoUrl: body.photoUrl,
      role: body.role ?? 2,
      isActive: body.isActive ?? true
    }))
  });
});

// CHANTIER CIBLE: la gestion des utilisateurs d'agence est une "modification
// metier qui permet de continuer a exploiter RendezBot" (audit exhaustif) -
// bloquee pour une agence billing-suspendue. Role 1 ne peut de toute facon
// agir que sur SA PROPRE agence (deja applique par updateUser/resetUserPassword
// ci-dessous): req.user!.agency_id est donc la bonne agence a verifier ici,
// role 0 etant deja exempte par requireAgencyBillingAccess.
app.patch("/api/users/:id", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  if (!(await requireAgencyBillingAccess(req, res, req.user!.agency_id))) {
    return;
  }
  const body = req.body as { name?: string; email?: string; photoUrl?: string; isActive?: boolean; role?: 1 | 2 };
  const role = body.role === 1 || body.role === 2 ? body.role : undefined;
  res.json({
    user: await updateUser(Number(req.params.id), {
      name: body.name,
      email: body.email,
      photo_url: body.photoUrl,
      is_active: body.isActive,
      role
    }, req.user!)
  });
});

app.post("/api/users/:id/reset-password", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  if (!(await requireAgencyBillingAccess(req, res, req.user!.agency_id))) {
    return;
  }
  res.json(await resetUserPassword(Number(req.params.id), req.user!));
});

app.get("/api/monitoring-settings", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = req.user!.role === 0
    ? Number(req.query.agencyId)
    : Number(req.user!.agency_id);

  if (![0, 1].includes(req.user!.role) || !agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  const settings = await getAgencySettings(agencyId);
  res.json({
    settings: {
      ...toPublicMonitoringSettings(settings),
      recordingExtension: settings.recordingExtension
    }
  });
});

app.patch("/api/monitoring-settings", requireAuth, async (req: AuthenticatedRequest, res) => {
  const body = req.body as { agencyId?: number } & PublicMonitoringSettingsPatch;
  const agencyId = req.user!.role === 0
    ? Number(body.agencyId)
    : Number(req.user!.agency_id);

  if (![0, 1].includes(req.user!.role) || !agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  const result = await updateAgencyMonitoringSettings(agencyId, fromPublicMonitoringSettingsPatch(body));
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json({ settings: toPublicMonitoringSettings(result.settings) });
});

// Centralise la resolution de l'agence pour les routes qui agissent "pour son
// agence" (revocation, actions sur un agent...): lit body/query de facon
// defensive (req.body peut etre undefined si la requete n'a pas de payload
// JSON, ex. un POST d'action sans corps) et ecrit elle-meme la reponse 400
// controlee si aucun rattachement n'existe, plutot que de laisser un acces
// direct type `req.body!.agencyId` planter en TypeError.
const requireAgencyId = (req: AuthenticatedRequest, res: express.Response): number | null => {
  const bodyAgencyId = (req.body as { agencyId?: unknown } | undefined)?.agencyId;
  const queryAgencyId = req.query?.agencyId;
  const agencyId = getSettingsAgencyId(req.user!, bodyAgencyId ?? queryAgencyId);

  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return null;
  }

  return agencyId;
};

app.get("/api/extensions", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, req.query.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  res.json({ extensions: await listExtensionLinks(agencyId) });
});

app.post("/api/extensions", requireAuth, async (req: AuthenticatedRequest, res) => {
  const body = req.body as { agencyId?: number; name?: string; installUrl?: string; isActive?: boolean };
  const agencyId = getSettingsAgencyId(req.user!, body.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  res.json({
    extension: await createExtensionLink({
      agencyId,
      name: body.name ?? "Extension",
      installUrl: body.installUrl ?? "",
      isActive: body.isActive ?? true
    })
  });
});

app.patch("/api/extensions/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  const body = req.body as { agencyId?: number; name?: string; installUrl?: string; isActive?: boolean };
  const agencyId = getSettingsAgencyId(req.user!, body.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  res.json({
    extension: await updateExtensionLink(agencyId, Number(req.params.id), body)
  });
});

app.delete("/api/extensions/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, req.query.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  await deleteExtensionLink(agencyId, Number(req.params.id));
  res.json({ ok: true });
});

// QUICK HOTFIX (categories gerees independamment par chaque agence): GET est
// accessible aux 3 roles (role 2 UTILISE les categories - dropdown du
// formulaire Bot - sans jamais les administrer) via getCategoriesReadAgencyId;
// POST/PATCH/DELETE restent reserves a role 0/1 via getSettingsAgencyId,
// exactement comme les extensions ci-dessus. agencyId est TOUJOURS resolu
// cote serveur depuis la session (role 1/2 ne peut jamais agir sur une autre
// agence, meme en envoyant un agencyId different dans le corps/la requete -
// seul role 0 peut cibler une agence explicite).
app.get("/api/categories", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getCategoriesReadAgencyId(req.user!, req.query.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Agence requise." });
    return;
  }

  res.json({ categories: await listAgencyCategories(agencyId) });
});

app.post("/api/categories", requireAuth, async (req: AuthenticatedRequest, res) => {
  const body = req.body as { agencyId?: number; name?: string };
  const agencyId = getSettingsAgencyId(req.user!, body.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  try {
    res.json({ category: await createAgencyCategory(agencyId, body.name) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Erreur serveur." });
  }
});

app.patch("/api/categories/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  const body = req.body as { agencyId?: number; name?: string };
  const agencyId = getSettingsAgencyId(req.user!, body.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  try {
    res.json({ category: await renameAgencyCategory(agencyId, Number(req.params.id), body.name) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Erreur serveur." });
  }
});

app.delete("/api/categories/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, req.query.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  try {
    await deleteAgencyCategory(agencyId, Number(req.params.id));
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Erreur serveur." });
  }
});

app.patch("/api/recording-extension/settings", requireAuth, async (req: AuthenticatedRequest, res) => {
  const body = req.body as {
    agencyId?: number;
    enabled?: boolean;
    installUrl?: string | null;
    name?: string | null;
    licenseType?: string | null;
  };
  const agencyId = getSettingsAgencyId(req.user!, body.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  const settings = await updateAgencyRecordingExtensionSettings(agencyId, body);
  res.json({
    settings,
    warning: settings.linkChanged
      ? "Lien modifie: les profils precedemment prets devront etre prepares a nouveau. Les sessions deja ouvertes ne sont pas modifiees."
      : "Les modifications s'appliquent aux prochains demarrages des bots."
  });
});

app.get("/api/recording-extension/profiles", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, req.query.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  res.json({
    profiles: await listBrowserProfiles(agencyId),
    activePreparation: getActivePreparation(agencyId)
  });
});

app.post("/api/recording-extension/prepare", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, (req.body as { agencyId?: number } | undefined)?.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  const settings = (await getAgencySettings(agencyId)).recordingExtension;
  const snapshot = await startRecordingExtensionPreparation(agencyId, settings, {
    onEvent: (level, message, prepareSnapshot) => {
      emitRecordingExtensionStatus(agencyId, {
        level,
        message,
        preparation: prepareSnapshot ?? null
      });
    }
  });
  emitRecordingExtensionStatus(agencyId, { level: "warn", message: snapshot.message, preparation: snapshot });
  res.json({ preparation: snapshot });
});

app.post("/api/recording-extension/confirm", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, (req.body as { agencyId?: number } | undefined)?.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  const profile = await confirmRecordingExtensionPreparation(agencyId);
  emitRecordingExtensionStatus(agencyId, {
    level: "success",
    message: `Profil ${profile.profile_key} marque comme pret apres confirmation utilisateur.`,
    profile
  });
  res.json({ profile });
});

app.post("/api/recording-extension/cancel", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, (req.body as { agencyId?: number } | undefined)?.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  const profile = await cancelRecordingExtensionPreparation(agencyId);
  emitRecordingExtensionStatus(agencyId, {
    level: "warn",
    message: `Preparation annulee pour ${profile.profile_key}.`,
    profile
  });
  res.json({ profile });
});

app.post("/api/recording-extension/profiles/:id/manage", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, (req.body as { agencyId?: number } | undefined)?.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  const preparation = await startProfileExtensionManagement(agencyId, Number(req.params.id));
  emitRecordingExtensionStatus(agencyId, {
    level: "info",
    message: `Gestion des extensions ouverte pour ${preparation.profile.profile_key}.`
  });
  res.json({ preparation });
});

app.post("/api/recording-extension/profiles/:id/stop-management", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, (req.body as { agencyId?: number } | undefined)?.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  stopProfileExtensionManagement(Number(req.params.id));
  emitRecordingExtensionStatus(agencyId, {
    level: "info",
    message: "Fenetre de gestion demandee a la fermeture."
  });
  res.json({ ok: true });
});

app.delete("/api/recording-extension/profiles/:id", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = getSettingsAgencyId(req.user!, req.query.agencyId);

  if (!agencyId) {
    res.status(403).json({ error: "Admin ou niveau 1 agence requis." });
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  await deleteBrowserProfileForAgency(agencyId, Number(req.params.id));
  emitRecordingExtensionStatus(agencyId, {
    level: "warn",
    message: "Profil Chrome supprime avec son dossier."
  });
  res.json({ ok: true });
});

app.post("/api/email/test-alert", requireAuth, requireAdmin, async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({
      success: false,
      provider: "brevo",
      message: "Route indisponible en production."
    });
    return;
  }

  const body = req.body as { to?: string; subject?: string; message?: string };

  if (!body.to || !body.to.trim()) {
    res.status(400).json({
      success: false,
      provider: "brevo",
      message: "Le champ 'to' est obligatoire."
    });
    return;
  }

  const result = await sendAppAlert({
    type: "info",
    title: body.subject ?? "Test alerte RendezBot",
    message: body.message ?? "Ceci est un test d'alerte email depuis Brevo.",
    userEmail: body.to,
    data: {
      route: "/api/email/test-alert",
      sandbox: process.env.BREVO_SANDBOX ?? "true"
    }
  });

  res.status(result.success ? 200 : 400).json(result);
});

const resolveViewAgencyId = (user: DbUser, value?: unknown): number | null => {
  if (user.role === 0) {
    const agencyId = Number(value);
    return agencyId ? agencyId : null;
  }

  return user.agency_id ? Number(user.agency_id) : null;
};

app.get("/api/agents", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = resolveViewAgencyId(req.user!, req.query.agencyId);

  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return;
  }

  const agents = await listAgentsForAgency(agencyId);
  const snapshots = await Promise.all(agents.map((agent) => getSnapshotForAgent(agent.id, agentGatewayConfig)));
  res.json({ agents: snapshots.filter((snapshot): snapshot is AgentSnapshot => snapshot !== null) });
});

// Section 17: non necessaires au temps reel (deja couvert par
// agent-command-status), utilises pour recharger l'etat apres une
// reconnexion de la page. DTO toujours passes par toPublicAgentCommand*.
app.get("/api/agent-commands", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = resolveViewAgencyId(req.user!, req.query.agencyId);
  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return;
  }

  const query = req.query as Record<string, string | undefined>;
  const commands = await listAgentCommandsForAgency(agencyId, {
    agentId: query.agentId ? Number(query.agentId) : undefined,
    botId: query.botId,
    status: query.status as never,
    commandType: query.commandType as never,
    limit: query.limit ? Number(query.limit) : undefined,
    offset: query.offset ? Number(query.offset) : undefined
  });

  res.json({
    commands: commands.map((command) => toPublicAgentCommandDetail(command))
  });
});

app.get("/api/agent-commands/:commandId", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = resolveViewAgencyId(req.user!, req.query.agencyId);
  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return;
  }

  const command = await getCommandForAgency(agencyId, String(req.params.commandId));
  if (!command) {
    res.status(404).json({ error: "Commande introuvable." });
    return;
  }

  res.json({ command: toPublicAgentCommandDetail(command) });
});

// Nettoyage rapide de l'historique (section "Bots pilotes par l'agent"):
// supprime uniquement des LIGNES d'historique deja terminees - ne touche
// jamais un profil Chrome, ne coupe jamais un bot, ne revoque jamais un
// agent (deleteCommandForAgency/clearTerminalCommandsForAgency refusent
// elles-memes toute commande/bot encore actif, cf. agentCommandService.ts).
// Meme regle d'isolation que les routes GET ci-dessus: resolveViewAgencyId
// force un non-admin sur SA seule agence, jamais un botId/commandId seul.
app.delete("/api/agent-commands", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = resolveViewAgencyId(req.user!, req.query.agencyId);
  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return;
  }

  const deletedCount = await clearTerminalCommandsForAgency(agencyId);
  res.json({ ok: true, deletedCount });
});

app.delete("/api/agent-commands/:commandId", requireAuth, async (req: AuthenticatedRequest, res) => {
  const agencyId = resolveViewAgencyId(req.user!, req.query.agencyId);
  if (!agencyId) {
    res.status(400).json({ error: "Agence requise." });
    return;
  }

  const result = await deleteCommandForAgency(agencyId, String(req.params.commandId));
  if (!result.ok) {
    const status = result.reason === "NOT_FOUND" ? 404 : 409;
    const error = result.reason === "NOT_FOUND"
      ? "Commande introuvable."
      : result.reason === "BOT_ACTIVE"
        ? "Ce bot est encore actif: arretez-le avant de supprimer cette ligne."
        : "Cette commande est encore en cours: attendez sa fin avant de la supprimer.";
    res.status(status).json({ error });
    return;
  }

  res.json({ ok: true });
});

// CHANTIER CIBLE: "creation de nouveaux pairing codes" est explicitement
// nommee comme action a bloquer pour une agence billing-suspendue (provisionne
// une NOUVELLE capacite Agent). A l'inverse, renommer/revoquer un agent
// (routes suivantes) reste volontairement EXEMPT: ces actions ne "permettent
// jamais de continuer a exploiter" (elles reduisent ou sont neutres vis-a-vis
// de la capacite), et revoquer doit rester possible pour securiser/decommissionner
// une machine meme agence suspendue.
app.post("/api/agents/pairing-codes", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  const agencyId = requireAgencyId(req, res);
  if (agencyId === null) {
    return;
  }

  if (!(await requireAgencyBillingAccess(req, res, agencyId))) {
    return;
  }

  const pairing = await createPairingCode(agencyId, req.user!.id, agentGatewayConfig);
  res.json({ pairing });
});

app.patch("/api/agents/:id", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  const agencyId = requireAgencyId(req, res);
  if (agencyId === null) {
    return;
  }

  // Body toujours defensif (peut etre absent): seul le nom est encore lu ici,
  // agencyId est deja resolu par requireAgencyId ci-dessus.
  const body = (req.body ?? {}) as { name?: unknown };
  if (typeof body.name !== "string" || !body.name.trim()) {
    res.status(400).json({ error: "Nom requis." });
    return;
  }

  const agent = await renameAgent(agencyId, Number(req.params.id), body.name);
  const snapshot = await getSnapshotForAgent(agent.id, agentGatewayConfig);
  res.json({ agent: snapshot });
});

app.post("/api/agents/:id/revoke", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  const agencyId = requireAgencyId(req, res);
  if (agencyId === null) {
    return;
  }

  const agentId = Number(req.params.id);
  let agent: Awaited<ReturnType<typeof revokeAgent>>;
  try {
    // revokeAgent filtre par "id = ... AND agency_id = ..." (voir agentService.ts):
    // un agent inexistant et un agent d'une autre agence produisent tous les deux
    // ce meme echec, sans jamais distinguer les deux cas dans la reponse.
    agent = await revokeAgent(agencyId, agentId);
  } catch {
    res.status(404).json({ error: "Agent introuvable." });
    return;
  }

  // Toute commande non terminale doit echouer avec un code distinct
  // (AGENT_REVOKED) AVANT de couper le socket: la deconnexion qui suit
  // declenche aussi son propre nettoyage (agentGateway.ts), mais les clauses
  // WHERE status=... de ce dernier ne trouveront alors plus rien a modifier,
  // sans jamais ecraser AGENT_REVOKED par AGENT_DISCONNECTED.
  const revokedCommands = await failNonTerminalOnRevoke(agent.id);
  for (const command of revokedCommands) {
    emitAgentCommandStatusToAuthorizedSockets(command.agency_id, toPublicAgentCommand(command));
  }

  // CORRECTIF CIBLE (revoke Agent doit terminer tous ses bots): convergence
  // SERVEUR immediate, AVANT de couper le socket - un Agent hors ligne au
  // moment du revoke ne recevra jamais de commande, mais son quota et son
  // affichage doivent neanmoins etre corrects sans attendre une eventuelle
  // reconnexion future. Strictement ce seul agentId (jamais toute l'agence,
  // cf. stopAllBotsForAgent/listAgentBotsForAgent).
  const stoppedBotIds = stopAllBotsForAgent(agent.id);
  for (const botId of stoppedBotIds) {
    const latest = await getLatestCommandForBot(botId);
    if (latest) {
      emitAgentCommandStatusToAuthorizedSockets(latest.agency_id, toPublicAgentCommand(latest));
    }
  }

  disconnectAgentSocket(agent.id);

  const snapshot = await getSnapshotForAgent(agent.id, agentGatewayConfig);
  if (snapshot) {
    emitAgentStatusToAuthorizedSockets(agencyId, snapshot);
  }
  res.json({ agent: snapshot });
});

// CHANTIER CIBLE (suppression visuelle des Agents revoques): "Supprimer"
// cote interface = archivage (soft-delete) cote serveur - jamais un DELETE
// physique (cascaderait sur agent_commands, cf. commentaire DbAgent.archived_at,
// db.ts). Un Agent DOIT deja etre revoque: jamais un raccourci implicite
// revoke+archive ici, ce sont deux intentions/actions utilisateur distinctes.
app.delete("/api/agents/:id", requireAuth, requireAgencyManager, async (req: AuthenticatedRequest, res) => {
  const agencyId = requireAgencyId(req, res);
  if (agencyId === null) {
    return;
  }

  const agentId = Number(req.params.id);

  // Verifie l'appartenance AVANT toute autre chose (meme reponse 404 pour
  // "n'existe pas" et "appartient a une autre agence", cf. revoke/rename):
  // jamais reveler via un 409 "bot actif" qu'un agentId d'une AUTRE agence
  // possede un runtime actif.
  const agent = await getAgentById(agentId);
  if (!agent || agent.agency_id !== agencyId) {
    res.status(404).json({ error: "Agent introuvable." });
    return;
  }

  // archiveAgentIfNoActiveBots() combine la verification defensive du
  // registre AgentBotRecord (jamais masquer un Agent avec un runtime encore
  // actif, meme si le revoke le garantit deja normalement) et l'archivage
  // DB lui-meme - directement testable en process (agentCommandService.ts).
  const result = await archiveAgentIfNoActiveBots(agencyId, agentId);
  if (!result.ok) {
    if (result.reason === "NOT_FOUND") {
      res.status(404).json({ error: "Agent introuvable." });
      return;
    }
    if (result.reason === "BOT_ACTIVE") {
      res.status(409).json({ error: "Cet agent possede encore un bot actif: impossible de le supprimer." });
      return;
    }
    res.status(409).json({ error: "L'agent doit etre revoque avant d'etre supprime." });
    return;
  }

  res.json({ ok: true });
});

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(`API error: ${error.message}`);

  // Le code metier de ce fichier leve systematiquement des `Error` simples avec
  // un message francais destine a l'utilisateur (ex: "Agent introuvable.").
  // TypeError/RangeError signalent au contraire un acces non defensif (bug),
  // jamais une erreur volontaire: leur message technique ne doit jamais
  // atteindre le client, meme si l'analyse ci-dessus (requireAgencyId, etc.)
  // a deja neutralise les cas connus.
  if (error instanceof TypeError || error instanceof RangeError) {
    res.status(400).json({ error: "Requete invalide." });
    return;
  }

  // Lot 6 (audit final, section 7): CORRECTIF - une erreur brute du pilote
  // PostgreSQL (ex: "invalid input syntax for type uuid: ...") est un objet
  // Error ordinaire, indiscernable ici d'une erreur metier deliberee sans
  // verification supplementaire: elle atteignait donc le client tel quel,
  // avant ce correctif (confirme par un test de securite dedie). Le pilote
  // "pg" expose systematiquement un code SQLSTATE a 5 caracteres
  // (ex: "22P02") sur ces erreurs, jamais present sur les Error metier
  // volontairement levees dans ce fichier: c'est un marqueur fiable pour ne
  // filtrer QUE les erreurs de bas niveau, sans toucher aux messages
  // francais deliberes (ex: "Agence introuvable.") dont ce handler reste
  // par ailleurs le relais legitime.
  const pgErrorCode = (error as { code?: unknown }).code;
  if (typeof pgErrorCode === "string" && /^[0-9A-Z]{5}$/.test(pgErrorCode)) {
    res.status(400).json({ error: "Requete invalide." });
    return;
  }

  res.status(400).json({ error: error.message });
});

const writeServerLock = (port: number): void => {
  currentPort = port;
  const lockPath = path.join(process.cwd(), "artifacts", `server-${port}.lock`);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    port,
    startedAt: new Date().toISOString()
  }, null, 2));
};

const cleanupServerLock = (): void => {
  const lockPath = path.join(process.cwd(), "artifacts", `server-${currentPort}.lock`);
  if (!existsSync(lockPath)) {
    return;
  }

  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
  if (lock.pid === process.pid) {
    unlinkSync(lockPath);
  }
};

const sessionSnapshotsForUser = (user?: DbUser | null) => [...sessions.entries()]
  .filter(([sessionKey]) => {
    const owner = sessionOwners.get(sessionKey);
    return owner && (!user || canSeeOwner(user, owner));
  })
  .map(([sessionKey, session]) => ({
    ...session.snapshot(),
    category: sessionOwners.get(sessionKey)?.category ?? "",
    login: sessionOwners.get(sessionKey)?.login ?? "",
    hasPrompt: activePrompts.has(sessionKey),
    promptMessage: activePrompts.get(sessionKey)?.message ?? ""
  }));

const countAgencySessions = (agencyId: number | null): number =>
  [...sessionOwners.values()].filter((owner) => owner.agencyId === agencyId).length;

// HOTFIX CIBLE (compteur bots actifs par agence): en mode Agent (mode de
// fonctionnement ACTUEL), la seule source de verite pour "bots actifs de
// cette agence" est le registre agentBots (countActiveAgentBotsForAgency) -
// jamais plus countAgencySessions()/sessionOwners (registre legacy_vm
// exclusivement, toujours a 0 pour un deploiement Agent, cause exacte du
// bug "0/15" alors que des bots tournent reellement). Le chemin legacy_vm
// (BOT_EXECUTION_MODE != "agent") garde son calcul historique inchange,
// volontairement isole derriere cette meme branche existante - jamais deux
// definitions melangees pour la meme agence.
const emitMaintenanceToSocket = async (socket: Socket, user?: DbUser | null): Promise<void> => {
  const agency = user?.agency_id ? await getAgency(user.agency_id).catch(() => null) : null;
  const agencyActiveCount = user?.agency_id
    ? (featureFlags.botExecutionMode === "agent" ? countActiveAgentBotsForAgency(user.agency_id) : countAgencySessions(user.agency_id))
    : sessions.size;
  const agencyMaxClients = agency?.max_active_clients ?? maxClients;

  socket.emit("maintenance", {
    pid: process.pid,
    port: currentPort,
    maxClients,
    agencyActiveCount,
    agencyMaxClients,
    activeSessions: sessionSnapshotsForUser(user)
  });
};

const emitMaintenance = (): void => {
  for (const [socketId, socket] of io.sockets.sockets) {
    void emitMaintenanceToSocket(socket, socketUsers.get(socketId));
  }
};

const getUserFromSocket = (socket: Socket): DbUser | null => {
  const cookie = socket.handshake.headers.cookie ?? "";
  const token = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("rdv_session="))?.split("=")[1];
  return getSessionUser(token);
};

const canSeeOwner = (user: DbUser, owner: SessionOwner): boolean => {
  return user.role === 0
    || user.id === owner.userId
    || (Boolean(user.agency_id) && user.agency_id === owner.agencyId);
};

// HOTFIX CIBLE (isolation des logs entre utilisateurs et agences): fonction
// centrale UNIQUE pour "cet utilisateur peut-il voir ce log de bot",
// reutilisee identiquement par tous les canaux de logs (temps reel
// bot-log/emitLogToAuthorizedSockets, historique bot-log-history a la
// reconnexion) - jamais une variante legerement differente d'un canal a
// l'autre. Politique exacte:
//   - role 0 (admin global): tous les logs ;
//   - role 1 (gestionnaire d'agence): tous les logs de SA PROPRE agence
//     (agencyId doit etre connu et correspondre - jamais suppose) ;
//   - role 2 (utilisateur standard): UNIQUEMENT les logs des bots qu'il
//     possede lui-meme - double condition explicite (meme agence ET meme
//     utilisateur), jamais un simple userId===userId qui suffirait a lui
//     seul si les identifiants venaient a se recouper autrement ;
//   - tout owner dont l'agencyId (ou, pour le role 2, le userId) est
//     inconnu (null) est REFUSE plutot que suppose "visible par toute
//     l'agence" (fail closed) - cf. emitBotLogFromAgent ci-dessous, qui ne
//     substitue plus jamais une valeur sentinelle (0) a un proprietaire
//     reellement inconnu.
// Distincte de canSeeOwner ci-dessus (inchangee, utilisee par les actions de
// controle bot pause/reprise/arret et la selection de session implicite -
// hors perimetre de ce hotfix, qui ne porte que sur les logs).
const canViewBotLog = (user: DbUser, owner: SessionOwner): boolean => {
  if (user.role === 0) {
    return true;
  }
  if (owner.agencyId == null || user.agency_id !== owner.agencyId) {
    return false;
  }
  if (user.role === 1) {
    return true;
  }
  return owner.userId != null && user.id === owner.userId;
};

const canManageAgencySettings = (user: DbUser, agencyId: number): boolean =>
  user.role === 0 || (user.role === 1 && user.agency_id === agencyId);

const emitRecordingExtensionStatus = (agencyId: number, payload: Record<string, unknown>): void => {
  for (const [socketId, socket] of io.sockets.sockets) {
    const user = socketUsers.get(socketId);
    if (user && canManageAgencySettings(user, agencyId)) {
      socket.emit("recording-extension-status", { agencyId, ...payload });
    }
  }
};

const canSeeAgencyAgentStatus = (user: DbUser, agencyId: number): boolean =>
  user.role === 0 || user.agency_id === agencyId;

const emitAgentStatusToAuthorizedSockets = (agencyId: number, snapshot: AgentSnapshot): void => {
  for (const [socketId, socket] of io.sockets.sockets) {
    const user = socketUsers.get(socketId);
    if (user && canSeeAgencyAgentStatus(user, agencyId)) {
      socket.emit("agent-status", snapshot);
    }
  }
};

// Meme portee de diffusion que le statut d'agent: un utilisateur voit les
// commandes de sa propre agence (ou toutes, s'il est admin global), jamais
// celles d'une autre agence.
const emitAgentCommandStatusToAuthorizedSockets = (agencyId: number, publicCommand: PublicAgentCommand): void => {
  for (const [socketId, socket] of io.sockets.sockets) {
    const user = socketUsers.get(socketId);
    if (user && canSeeAgencyAgentStatus(user, agencyId)) {
      socket.emit("agent-command-status", publicCommand);
    }
  }

  // HOTFIX CIBLE (compteur bots actifs par agence, section 7 - temps reel):
  // point de passage UNIQUE de tout changement de statut de commande Agent
  // (START_BOT/STOP_BOT/BOT_STATUS remonte par l'agent, via le meme
  // onCommandChange deja cable dans registerAgentNamespace ci-dessous et
  // dans le handler start-bot) - n'importe lequel peut faire varier
  // AgentBotRecord.active, donc on rediffuse systematiquement le compteur
  // existant plutot que d'essayer de determiner au cas par cas lequel
  // compte reellement (jamais un calcul divergent, cf. emitMaintenanceToSocket).
  emitMaintenance();
};

// Relie les statuts de bot remontes par un agent au systeme de logs existant
// (page Logs, historique, alertes Brevo): un bot pilote par un agent est
// traite comme un SessionOwner ordinaire pour cette diffusion, meme s'il n'a
// pas de BotSession Playwright locale (cf. agentCommandService.ts).
const emitBotLogFromAgent = (
  agencyId: number,
  botId: string,
  botName: string,
  level: "info" | "warn" | "error" | "success",
  message: string
): void => {
  const bot = getAgentBot(botId);
  // HOTFIX CIBLE (isolation des logs): jamais de sentinelle (0) quand le bot
  // est absent du registre en memoire - null signifie explicitement
  // "proprietaire inconnu", que canViewBotLog() refuse pour le role 2 plutot
  // que de risquer une correspondance accidentelle avec un vrai userId.
  const owner: SessionOwner = {
    userId: bot?.ownerUserId ?? null,
    agencyId,
    botName,
    category: bot?.category ?? "",
    login: ""
  };
  recordLog(owner, makeEvent(level, message), botId);
};

type AgentSelectionResult =
  | { ok: true; agentId: number }
  | { ok: false; code: "AGENT_NOT_CONNECTED" | "AGENT_VERSION_INCOMPATIBLE" | "AGENT_SELECTION_REQUIRED" | "AGENT_SYNCING"; agents?: AgentSnapshot[] };

const AGENT_SELECTION_ERROR_MESSAGES: Record<string, string> = {
  AGENT_NOT_CONNECTED: "Aucun agent local autorise n'est actuellement connecte.",
  AGENT_VERSION_INCOMPATIBLE: "La version de RendezBot Agent doit etre mise a jour avant de lancer un bot.",
  AGENT_SELECTION_REQUIRED: "Plusieurs ordinateurs sont connectes: selectionnez celui qui doit executer ce bot.",
  // Lot 5 (section 9): agent techniquement connecte mais reconciliation
  // (AGENT_RUNTIME_STATUS) pas encore terminee - jamais de commande envoyee
  // avant READY_FOR_COMMANDS.
  AGENT_SYNCING: "Agent connecte - synchronisation en cours. Reessayez dans un instant."
};

// Section 6: choisit l'agent qui recevra la commande. Ne revele jamais qu'un
// agentId demande appartient a une autre agence (meme code generique que
// "non connecte"): la portee par agence vient de listAgentsForAgency, qui ne
// retourne jamais que les agents de CETTE agence.
const selectAgentForCommand = async (agencyId: number, requestedAgentId?: number): Promise<AgentSelectionResult> => {
  const agents = await listAgentsForAgency(agencyId);
  const snapshotsOrNull = await Promise.all(agents.map((agent) => getSnapshotForAgent(agent.id, agentGatewayConfig)));
  const snapshots = snapshotsOrNull.filter((snapshot): snapshot is AgentSnapshot => snapshot !== null);

  if (requestedAgentId) {
    const requested = snapshots.find((snapshot) => snapshot.agentId === requestedAgentId);
    if (!requested) {
      return { ok: false, code: "AGENT_NOT_CONNECTED" };
    }
    if (requested.status === "VERSION_INCOMPATIBLE") {
      return { ok: false, code: "AGENT_VERSION_INCOMPATIBLE" };
    }
    if (requested.status !== "CONNECTED") {
      return { ok: false, code: "AGENT_NOT_CONNECTED" };
    }
    if (!requested.readyForCommands) {
      return { ok: false, code: "AGENT_SYNCING" };
    }
    return { ok: true, agentId: requested.agentId };
  }

  const connected = snapshots.filter((snapshot) => snapshot.status === "CONNECTED");
  const ready = connected.filter((snapshot) => snapshot.readyForCommands);
  if (ready.length === 1) {
    return { ok: true, agentId: ready[0].agentId };
  }
  if (ready.length > 1) {
    return { ok: false, code: "AGENT_SELECTION_REQUIRED", agents: snapshots };
  }
  if (connected.length > 0) {
    // Au moins un agent connecte, mais aucun encore READY_FOR_COMMANDS.
    return { ok: false, code: "AGENT_SYNCING" };
  }

  if (snapshots.some((snapshot) => snapshot.status === "VERSION_INCOMPATIBLE")) {
    return { ok: false, code: "AGENT_VERSION_INCOMPATIBLE" };
  }

  return { ok: false, code: "AGENT_NOT_CONNECTED" };
};

// Section 14: STOP_BOT partage le meme bus generique que START_BOT plutot
// que d'inventer un evenement par type. Toujours envoye a l'agent
// proprietaire du bot (jamais une nouvelle selection), et refuse
// silencieusement si ce bot n'est pas/plus connu (deja arrete, jamais
// demarre en mode agent...): idempotence deja voulue et testee (Lot 2).
const dispatchOwnedAgentCommand = async (
  socket: Socket,
  type: "STOP_BOT",
  botId: string,
  clientRequestId?: string
): Promise<void> => {
  const user = socketUsers.get(socket.id);
  const bot = getAgentBot(botId);
  if (!user || !bot) {
    return;
  }

  const owner: SessionOwner = { userId: bot.ownerUserId, agencyId: bot.agencyId, botName: bot.botName, category: bot.category, login: "" };
  if (!canSeeOwner(user, owner)) {
    return;
  }

  // HOTFIX CIBLE (disponibilite des actions distantes): garde manquant
  // aligne sur dispatchValidateBotCommand ci-dessous - un agent techniquement
  // connecte mais pas encore synchronise (AGENT_RUNTIME_STATUS pas encore
  // traite, cf. isAgentReadyForCommands) ne doit jamais recevoir de NOUVELLE
  // commande. Le cas agent totalement deconnecte reste gere par le repli
  // existant de dispatchAgentCommand (AGENT_DISCONNECTED, immediat) - ce
  // garde ferme uniquement la fenetre "connecte mais pas pret" que STOP_BOT
  // ignorait jusqu'ici.
  if (getConnectedAgentSocket(bot.agentId) && !isAgentReadyForCommands(bot.agentId)) {
    socket.emit("bot-status", { botId, status: "error", code: "AGENT_SYNCING" });
    emitOwnedLog(socket, owner, makeEvent("error", "Agent connecte - synchronisation en cours. Reessayez dans un instant."));
    return;
  }

  const normalizedClientRequestId = typeof clientRequestId === "string" && clientRequestId.trim()
    ? clientRequestId.trim().slice(0, 100)
    : null;

  try {
    const { command } = await dispatchAgentCommand(
      {
        agencyId: bot.agencyId,
        agentId: bot.agentId,
        botId,
        type,
        publicPayload: {},
        createdByUserId: user.id,
        clientRequestId: normalizedClientRequestId
      },
      {
        config: agentCommandConfig,
        getAgentSocket: getConnectedAgentSocket,
        onChange: (updatedCommand) => emitAgentCommandStatusToAuthorizedSockets(
          updatedCommand.agency_id,
          toPublicAgentCommand(updatedCommand)
        )
      }
    );

    emitOwnedLog(socket, owner, makeEvent("info", `Commande d'arret envoyee a l'agent (id ${command.command_id.slice(0, 8)}).`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Echec du dispatch ${type}: ${message}`);
    emitOwnedLog(socket, owner, makeEvent("error", "Erreur interne lors de l'envoi de la commande a l'agent."));
  }
};

// Section 1 (Lot 3): contrat propre a VALIDATE_BOT, distinct de STOP_BOT
// (idempotent, toujours tente quel que soit l'etat). VALIDATE_BOT n'a de
// sens que si le bot est encore WAITING_FOR_USER: refuser AVANT de creer une
// commande (bot inconnu, autre agence, mauvais etat, agent hors ligne)
// plutot que de faire un aller-retour agent inutile pour un echec deja
// connu du serveur. Ne revele jamais qu'un botId appartient a une autre
// agence: meme code generique (BOT_NOT_RUNNING) que pour un bot inconnu.
const VALIDATE_BOT_ERROR_MESSAGES: Record<string, string> = {
  BOT_NOT_RUNNING: "Ce bot n'est plus actif.",
  AGENT_NOT_CONNECTED: "L'agent proprietaire de ce bot n'est plus connecte.",
  INVALID_BOT_STATE: "Ce bot n'est pas dans un etat permettant la validation.",
  AGENT_SYNCING: "Agent connecte - synchronisation en cours. Reessayez dans un instant."
};

const dispatchValidateBotCommand = async (
  socket: Socket,
  botId: string,
  clientRequestId?: string
): Promise<void> => {
  const user = socketUsers.get(socket.id);
  if (!user) {
    return;
  }

  const bot = getAgentBot(botId);
  if (!bot) {
    socket.emit("bot-status", { botId, status: "error", code: "BOT_NOT_RUNNING" });
    return;
  }

  const owner: SessionOwner = { userId: bot.ownerUserId, agencyId: bot.agencyId, botName: bot.botName, category: bot.category, login: "" };
  if (!canSeeOwner(user, owner)) {
    socket.emit("bot-status", { botId, status: "error", code: "BOT_NOT_RUNNING" });
    return;
  }

  if (bot.botStatus !== "WAITING_FOR_USER") {
    socket.emit("bot-status", { botId, status: "error", code: "INVALID_BOT_STATE" });
    emitOwnedLog(socket, owner, makeEvent("error", VALIDATE_BOT_ERROR_MESSAGES.INVALID_BOT_STATE));
    return;
  }

  if (!getConnectedAgentSocket(bot.agentId)) {
    socket.emit("bot-status", { botId, status: "error", code: "AGENT_NOT_CONNECTED" });
    emitOwnedLog(socket, owner, makeEvent("error", VALIDATE_BOT_ERROR_MESSAGES.AGENT_NOT_CONNECTED));
    return;
  }

  if (!isAgentReadyForCommands(bot.agentId)) {
    socket.emit("bot-status", { botId, status: "error", code: "AGENT_SYNCING" });
    emitOwnedLog(socket, owner, makeEvent("error", VALIDATE_BOT_ERROR_MESSAGES.AGENT_SYNCING));
    return;
  }

  const normalizedClientRequestId = typeof clientRequestId === "string" && clientRequestId.trim()
    ? clientRequestId.trim().slice(0, 100)
    : null;

  try {
    const { command } = await dispatchAgentCommand(
      {
        agencyId: bot.agencyId,
        agentId: bot.agentId,
        botId,
        type: "VALIDATE_BOT",
        publicPayload: {},
        createdByUserId: user.id,
        clientRequestId: normalizedClientRequestId
      },
      {
        config: agentCommandConfig,
        getAgentSocket: getConnectedAgentSocket,
        onChange: (updatedCommand) => emitAgentCommandStatusToAuthorizedSockets(
          updatedCommand.agency_id,
          toPublicAgentCommand(updatedCommand)
        )
      }
    );

    emitOwnedLog(socket, owner, makeEvent("info", `Commande de validation envoyee a l'agent (id ${command.command_id.slice(0, 8)}).`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Echec du dispatch VALIDATE_BOT: ${message}`);
    emitOwnedLog(socket, owner, makeEvent("error", "Erreur interne lors de l'envoi de la commande a l'agent."));
  }
};

registerAgentNamespace(io, agentGatewayConfig, agentCommandConfig, {
  onStatusChange: emitAgentStatusToAuthorizedSockets,
  onCommandChange: emitAgentCommandStatusToAuthorizedSockets,
  onBotLog: emitBotLogFromAgent
});

const emitLogToAuthorizedSockets = (owner: SessionOwner, event: SessionEvent): void => {
  for (const [socketId, socket] of io.sockets.sockets) {
    const user = socketUsers.get(socketId);
    if (user && canViewBotLog(user, owner)) {
      socket.emit("bot-log", event);
    }
  }
};

const emitPromptToAuthorizedSockets = (owner: SessionOwner, message: string, sessionKey: string): void => {
  for (const [socketId, socket] of io.sockets.sockets) {
    const user = socketUsers.get(socketId);
    if (user && canSeeOwner(user, owner)) {
      socket.emit("bot-prompt", { sessionId: sessionKey, botName: owner.botName, message });
    }
  }
};

const emitStatusToAuthorizedSockets = (owner: SessionOwner, sessionKey: string, status: SessionStatus): void => {
  for (const [socketId, socket] of io.sockets.sockets) {
    const user = socketUsers.get(socketId);
    if (user && canSeeOwner(user, owner)) {
      socket.emit("bot-status", { sessionId: sessionKey, botName: owner.botName, status });
    }
  }
};

const recordLog = (owner: SessionOwner, event: SessionEvent, sessionKey: string): void => {
  const visibleEvent = {
    ...event,
    message: `[${owner.botName}] ${event.message}`
  };

  logHistory.unshift({ event: visibleEvent, owner, sessionKey });
  logHistory.splice(300);
  emitLogToAuthorizedSockets(owner, visibleEvent);
  // Proprietaire inconnu (cf. emitBotLogFromAgent): jamais de notification
  // email mal routee vers un userId devine/sentinelle.
  if (owner.userId != null) {
    void notifyUserIfNeeded({
      userId: owner.userId,
      level: event.level,
      message: event.message,
      sessionId: sessions.get(sessionKey)?.snapshot().id ?? sessionKey,
      botName: owner.botName
    });
  }
};

const emitOwnedLog = (socket: Socket, owner: SessionOwner | null, event: SessionEvent): void => {
  if (owner) {
    recordLog(owner, event, socket.id);
    return;
  }

  socket.emit("bot-log", event);
};

const makeEvent = (level: SessionEvent["level"], message: string): SessionEvent => ({
  level,
  message,
  timestamp: new Date().toISOString()
});

const findSessionForSocket = (socketId: string): [string, BotSession] | undefined => {
  const selectedSessionKey = selectedSessionBySocket.get(socketId);
  const selectedSession = selectedSessionKey ? sessions.get(selectedSessionKey) : undefined;
  if (selectedSession) {
    return [selectedSessionKey!, selectedSession];
  }

  const user = socketUsers.get(socketId);
  if (!user) {
    return undefined;
  }

  const match = [...sessionOwners.entries()].find(([sessionKey, owner]) => {
    const session = sessions.get(sessionKey);
    return Boolean(session) && canSeeOwner(user, owner);
  });
  if (!match) {
    return undefined;
  }

  const session = sessions.get(match[0]);
  return session ? [match[0], session] : undefined;
};

io.on("connection", (socket) => {
  logger.info(`Interface connectee: ${socket.id}`);

  const connectedUser = getUserFromSocket(socket);
  if (connectedUser) {
    socketUsers.set(socket.id, connectedUser);
    socket.emit(
      "bot-log-history",
      logHistory.filter((entry) => canViewBotLog(connectedUser, entry.owner)).map((entry) => entry.event)
    );

    for (const [sessionKey, prompt] of activePrompts) {
      if (canSeeOwner(connectedUser, prompt.owner)) {
        const session = sessions.get(sessionKey);
        if (session) {
          socket.emit("bot-session", session.snapshot());
        }
        socket.emit("bot-prompt", {
          sessionId: sessionKey,
          botName: prompt.owner.botName,
          message: prompt.message
        });
      }
    }
  }

  void emitMaintenanceToSocket(socket, connectedUser);

  socket.on("start-bot", async (payload?: {
    botName?: string;
    category?: string;
    login?: string;
    password?: string;
    agentId?: number;
    clientRequestId?: string;
  }) => {
    const user = socketUsers.get(socket.id) ?? getUserFromSocket(socket);
    if (!user) {
      socket.emit("bot-log", makeEvent("error", "Connexion utilisateur requise pour demarrer un bot."));
      return;
    }

    socketUsers.set(socket.id, user);
    const fallbackBotNumber = user.agency_id ? countAgencySessions(user.agency_id) + 1 : sessions.size + 1;
    const botName = payload?.botName?.trim() || `Bot ${fallbackBotNumber}`;
    const category = payload?.category?.trim() || "";
    const login = payload?.login?.trim() || "";
    const password = payload?.password || "";
    const owner: SessionOwner = { userId: user.id, agencyId: user.agency_id, botName, category, login };

    // CHANTIER CIBLE (gestion des echeances et impayes): point de blocage
    // CENTRAL pour "demarrer de nouveaux bots" - couvre les DEUX modes
    // (agent ET legacy_vm, qui partagent ce meme handler) en un seul
    // controle, avant toute branche. Charge TOUJOURS l'etat de facturation
    // depuis PostgreSQL (jamais depuis `user`, un DbUser peut etre le
    // snapshot memoire perime de socketUsers/getUserFromSocket - cf.
    // src/auth.ts). Ne bloque JAMAIS pause/resume/continue/stop d'un bot deja
    // actif (aucun controle equivalent n'est ajoute sur ces handlers,
    // volontairement - cf. rapport final): seul le lancement d'un NOUVEAU bot
    // est concerne ici.
    const billingCheck = await checkAgencyBillingAccess(user.role, user.agency_id);
    if (!billingCheck.allowed) {
      emitOwnedLog(socket, owner, makeEvent("error", PAYMENT_SUSPENDED_MESSAGE));
      socket.emit("bot-status", { status: "error", code: PAYMENT_SUSPENDED_CODE, billing: billingCheck.state });
      return;
    }

    // QUICK HOTFIX (categories par agence): le dropdown frontend est
    // desormais dynamique (chargement depuis /api/categories), mais rien
    // n'empeche un client de forger un payload socket "start-bot" arbitraire
    // (DevTools, replay...). Un `category` non vide DOIT donc exister dans
    // agency_categories POUR L'AGENCE DE LA SESSION (jamais une valeur
    // cliente pour l'agence - identique au contrat des routes /api/categories).
    // Une categorie supprimee depuis, ou appartenant a une autre agence, est
    // refusee ici. Categorie vide: comportement historique inchange (aucune
    // validation, jamais rendue obligatoire par ce hotfix). Concerne
    // uniquement ce NOUVEAU demarrage - aucun bot/historique existant n'est
    // jamais touche.
    if (category && user.agency_id) {
      const allowedCategories = await listAgencyCategories(user.agency_id);
      if (!allowedCategories.some((allowed) => allowed.name === category)) {
        emitOwnedLog(socket, owner, makeEvent("error", "Categorie invalide, supprimee, ou appartenant a une autre agence."));
        socket.emit("bot-status", { status: "error", code: "CATEGORY_INVALID" });
        return;
      }
    }

    // Mode agent: plus de refus systematique (Phase 2) mais un vrai dispatch.
    // Le moteur Chrome/Playwright reste hors de cette phase (Phase 4): aucune
    // reservation de profil local ni aucun lancement de Chrome n'a lieu ici,
    // uniquement la creation et l'envoi d'une commande START_BOT.
    if (featureFlags.botExecutionMode === "agent") {
      const agencyId = owner.agencyId;
      if (!agencyId) {
        emitOwnedLog(socket, owner, makeEvent("error", "Utilisateur sans agence: impossible de demarrer un bot."));
        socket.emit("bot-status", { status: "error", code: "AGENT_NOT_CONNECTED" });
        return;
      }

      // Toute la suite touche la base et le reseau (agent potentiellement
      // deconnecte entre-temps, contrainte SQL, etc.): une erreur ici ne doit
      // jamais devenir une rejection non geree susceptible d'arreter tout le
      // process serveur, seulement un echec de ce demarrage precis.
      // botId declare ICI (avant le try): le bloc catch doit pouvoir liberer
      // la reservation (removeAgentBot) meme si l'erreur survient apres son
      // enregistrement, sans jamais laisser une place fantome bloquee.
      let botId: string | undefined;
      try {
        const agency = await getAgency(agencyId);
        if (!agency) {
          emitOwnedLog(socket, owner, makeEvent("error", "Agence introuvable."));
          socket.emit("bot-status", { status: "error", code: "AGENT_NOT_CONNECTED" });
          return;
        }

        const requestedAgentId = payload?.agentId ? Number(payload.agentId) : undefined;
        const selection = await selectAgentForCommand(agencyId, requestedAgentId);

        if (!selection.ok) {
          emitOwnedLog(socket, owner, makeEvent("error", AGENT_SELECTION_ERROR_MESSAGES[selection.code]));
          socket.emit("bot-status", {
            status: "error",
            code: selection.code,
            ...(selection.code === "AGENT_SELECTION_REQUIRED" ? { agents: selection.agents } : {})
          });
          return;
        }

        // HOTFIX CIBLE (limite agence, section 8/9 du cahier des charges):
        // controle FINAL du quota - AUCUN await entre cette lecture et
        // registerAgentBot() juste en dessous. Deux "start-bot" presque
        // simultanes a 14/15 s'executent chacun jusqu'ici via leurs propres
        // await (selectAgentForCommand ci-dessus) de facon entrelacee, mais
        // ce bloc lui-meme est synchrone: quel que soit l'ordre d'arrivee,
        // le second a atteindre CE point verra forcement le compte deja
        // incremente par le premier (meme Map en memoire, jamais une lecture
        // perimee) - jamais deux acceptations pour la meme 15e place.
        const activeNow = countActiveAgentBotsForAgency(agencyId);
        if (activeNow >= agency.max_active_clients) {
          emitOwnedLog(socket, owner, makeEvent("error", `Limite agence atteinte : ${agency.max_active_clients}/${agency.max_active_clients} bots actifs.`));
          socket.emit("bot-status", { status: "error", code: "AGENCY_BOT_LIMIT_REACHED" });
          return;
        }

        botId = generateBotId();
        registerAgentBot({
          botId,
          agentId: selection.agentId,
          agencyId,
          ownerUserId: owner.userId,
          botName,
          category,
          latestCommandId: "",
          botStatus: null,
          botStatusUpdatedAt: null,
          active: true,
          updatedAt: new Date().toISOString()
        });
        // La reservation ci-dessus est deja visible de tout START_BOT
        // concurrent suivant (countActiveAgentBotsForAgency la relit a
        // chaud) - tout ce qui suit peut de nouveau attendre normalement.

        const clientRequestId = typeof payload?.clientRequestId === "string" && payload.clientRequestId.trim()
          ? payload.clientRequestId.trim().slice(0, 100)
          : null;

        // Lot 4 (section 4 du cahier des charges): snapshot public et deja
        // valide des parametres de surveillance de l'agence, transmis une
        // fois pour toutes au demarrage. L'agent le revalide/borne de son
        // cote (defense en profondeur, cf. agentMonitoringSettings.ts):
        // jamais fait confiance tel quel meme si deja normalise ici.
        const monitoringSettings = await getAgencyMonitoringSettings(agencyId);
        const extensionLinks = await listExtensionLinks(agencyId, true);

        // Hotfix 0.1.2 (points 1-3 du cahier des charges): reutilise
        // TARGET_URL (deja la source de verite du flux legacy_vm existant),
        // jamais une entree utilisateur - non sensible, donc transmise dans
        // publicPayload (jamais transientPayload, reserve aux secrets).
        // null si non configure/invalide: c'est alors l'agent qui decide
        // (extension locale -> conserve son propre chargement ; sans
        // extension -> refuse immediatement plutot que de rester bloque sur
        // about:blank pendant plusieurs minutes, cf. agentBotManager.ts).
        const tlsStartUrl = resolveAgentTlsStartUrl();

        const { command, alreadyExisted } = await dispatchAgentCommand(
          {
            agencyId,
            agentId: selection.agentId,
            botId,
            type: "START_BOT",
            publicPayload: { botName, category, monitoringSettings, startUrl: tlsStartUrl.ok ? tlsStartUrl.url : null },
            createdByUserId: user.id,
            clientRequestId,
            // Hotfix 0.1.1: identifiants TLScontact transmis a l'agent
            // UNIQUEMENT via ce canal transient (jamais persiste, voir
            // agentCommandService.ts) - jamais dans publicPayload, jamais
            // dans public_payload/public_result en base, jamais logue.
            transientPayload: (login || password || extensionLinks.length > 0)
              ? { login, password, extensionLinks }
              : undefined
          },
          {
            config: agentCommandConfig,
            getAgentSocket: getConnectedAgentSocket,
            onChange: (updatedCommand) => emitAgentCommandStatusToAuthorizedSockets(
              updatedCommand.agency_id,
              toPublicAgentCommand(updatedCommand)
            )
          }
        );

        // HOTFIX CIBLE (section 9 - jamais de place fantome): deux cas ou
        // AUCUN bot reel ne pourra jamais exister pour ce botId precis, donc
        // la reservation ci-dessus doit etre liberee immediatement plutot
        // que de bloquer une place indefiniment:
        //  - alreadyExisted: la commande reutilisee (meme clientRequestId,
        //    double-clic/retry reseau) porte l'ANCIEN bot_id d'une requete
        //    precedente, jamais celui genere ici - ce nouvel enregistrement
        //    n'est donc lie a aucune commande reelle ;
        //  - command.status === "failed" (ex. AGENT_DISCONNECTED): l'agent
        //    n'a jamais recu la commande, aucun BOT_STATUS ne viendra donc
        //    jamais liberer ce botId via updateAgentBotStatus.
        if (alreadyExisted) {
          removeAgentBot(botId);
          emitOwnedLog(socket, owner, makeEvent("info", `Commande de demarrage deja enregistree pour ce bot (id ${command.command_id.slice(0, 8)}).`));
          emitMaintenance();
          return;
        }

        if (command.status === "failed") {
          removeAgentBot(botId);
          emitOwnedLog(socket, owner, makeEvent("error", `Envoi de la commande a l'agent impossible: ${command.error_message ?? command.error_code ?? "agent deconnecte"}.`));
          socket.emit("bot-status", { status: "error", code: "DISPATCH_FAILED" });
          emitMaintenance();
          return;
        }

        emitOwnedLog(socket, owner, makeEvent("info", `Commande de demarrage envoyee a l'agent (id ${command.command_id.slice(0, 8)}).`));
        // Pas d'emission "agent-command-status" explicite ici: le callback
        // onChange de dispatchAgentCommand a deja diffuse chaque transition
        // (PENDING puis SENT) a tous les sockets autorises de l'agence, y
        // compris celui-ci. Une emission de plus ici ne ferait que dupliquer
        // le dernier evenement deja recu par ce socket.
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Echec du dispatch START_BOT: ${message}`);
        // HOTFIX CIBLE (section 9): si la reservation a deja ete faite
        // (botId defini) avant que cette erreur ne survienne, elle doit
        // etre liberee - jamais une place fantome conservee suite a une
        // erreur inattendue (DB, reseau...) survenue apres registerAgentBot().
        if (botId) {
          removeAgentBot(botId);
          emitMaintenance();
        }
        emitOwnedLog(socket, owner, makeEvent("error", "Erreur interne lors de l'envoi de la commande a l'agent."));
        socket.emit("bot-status", { status: "error", code: "DISPATCH_ERROR" });
      }
      return;
    }

    if (user.role !== 0) {
      if (!user.agency_id) {
        emitOwnedLog(socket, owner, makeEvent("error", "Utilisateur sans agence: impossible de demarrer un bot."));
        return;
      }

      const agency = await getAgency(user.agency_id);
      if (!agency?.is_active) {
        emitOwnedLog(socket, owner, makeEvent("error", "Agence inactive: impossible de demarrer un bot."));
        return;
      }

      const activeAgencySessions = [...sessionOwners.values()]
        .filter((sessionOwner) => sessionOwner.agencyId === user.agency_id).length;
      if (activeAgencySessions >= agency.max_active_clients) {
        emitOwnedLog(socket, owner, makeEvent("error", `Limite agence atteinte: ${activeAgencySessions}/${agency.max_active_clients} navigateurs actifs.`));
        return;
      }
    }

    const activeCount = [...sessions.values()].filter((session) => session.isActive()).length;
    if (activeCount >= maxClients) {
      socket.emit("bot-status", { status: "error" });
      emitOwnedLog(socket, owner, makeEvent("error", `Limite VM atteinte: ${activeCount}/${maxClients} clients actifs.`));
      return;
    }

    let sessionKey = "";
    try {
      const agencySettings = await getAgencySettings(owner.agencyId);
      const profileLease = await reserveStandardProfileForBot(owner.agencyId);
      const extensionLinks = owner.agencyId ? await listExtensionLinks(owner.agencyId, true) : [];

      const session = await createBotSession({
        onLog: (event) => recordLog(owner, event, sessionKey),
        onPrompt: (message) => {
          activePrompts.set(sessionKey, { message, owner });
          selectedSessionBySocket.set(socket.id, sessionKey);
          emitPromptToAuthorizedSockets(owner, message, sessionKey);
          if (owner.userId != null) {
            void notifyUserIfNeeded({
              userId: owner.userId,
              level: "warn",
              message,
              sessionId: sessions.get(sessionKey)?.snapshot().id ?? sessionKey,
              botName: owner.botName
            });
          }
        },
        onStatus: (status) => {
          emitStatusToAuthorizedSockets(owner, sessionKey, status);
          if (status === "stopped" || status === "error") {
            sessions.delete(sessionKey);
            sessionOwners.delete(sessionKey);
            selectedSessionBySocket.delete(socket.id);
            activePrompts.delete(sessionKey);
            emitMaintenance();
          }
        }
      }, profileLease, botName, agencySettings, { login, password, category }, extensionLinks);

      sessionKey = session.snapshot().id;
      sessions.set(sessionKey, session);
      sessionOwners.set(sessionKey, owner);
      selectedSessionBySocket.set(socket.id, sessionKey);
      socket.emit("bot-session", { ...session.snapshot(), category, login });
      emitMaintenance();
      void session.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      socket.emit("bot-status", { status: "error" });
      emitOwnedLog(socket, owner, makeEvent("error", message));
      emitMaintenance();
    }
  });

  socket.on("select-session", ({ sessionId }: { sessionId?: string }) => {
    if (!sessionId) {
      return;
    }

    const user = socketUsers.get(socket.id);
    const owner = sessionOwners.get(sessionId);
    const session = sessions.get(sessionId);
    if (!user || !owner || !session || !canSeeOwner(user, owner)) {
      return;
    }

    selectedSessionBySocket.set(socket.id, sessionId);
    socket.emit("bot-session", session.snapshot());
    const prompt = activePrompts.get(sessionId);
    if (prompt) {
      socket.emit("bot-prompt", { sessionId, botName: owner.botName, message: prompt.message });
    } else {
      socket.emit("bot-prompt", { sessionId, botName: owner.botName, message: "" });
    }
  });

  socket.on("continue-bot", (payload: { sessionId?: string; botId?: string; clientRequestId?: string } = {}) => {
    if (featureFlags.botExecutionMode === "agent" && payload.botId) {
      void dispatchValidateBotCommand(socket, payload.botId, payload.clientRequestId);
      return;
    }

    const sessionId = payload.sessionId;
    const match = sessionId && sessions.has(sessionId) ? [sessionId, sessions.get(sessionId)!] as [string, BotSession] : findSessionForSocket(socket.id);
    if (!match) {
      return;
    }

    const user = socketUsers.get(socket.id);
    const owner = sessionOwners.get(match[0]);
    if (!user || !owner || !canSeeOwner(user, owner)) {
      return;
    }

    selectedSessionBySocket.set(socket.id, match[0]);
    activePrompts.delete(match[0]);
    match[1].continue();
    emitMaintenance();
  });

  socket.on("pause-bot", ({ sessionId }: { sessionId?: string } = {}) => {
    const match = sessionId && sessions.has(sessionId) ? [sessionId, sessions.get(sessionId)!] as [string, BotSession] : findSessionForSocket(socket.id);
    if (!match) {
      return;
    }

    const user = socketUsers.get(socket.id);
    const owner = sessionOwners.get(match[0]);
    if (!user || !owner || !canSeeOwner(user, owner)) {
      return;
    }

    match[1].pause();
    emitMaintenance();
  });

  socket.on("resume-bot", ({ sessionId }: { sessionId?: string } = {}) => {
    const match = sessionId && sessions.has(sessionId) ? [sessionId, sessions.get(sessionId)!] as [string, BotSession] : findSessionForSocket(socket.id);
    if (!match) {
      return;
    }

    const user = socketUsers.get(socket.id);
    const owner = sessionOwners.get(match[0]);
    if (!user || !owner || !canSeeOwner(user, owner)) {
      return;
    }

    match[1].resume();
    emitMaintenance();
  });

  socket.on("stop-bot", async (payload: { sessionId?: string; botId?: string; clientRequestId?: string } = {}) => {
    if (featureFlags.botExecutionMode === "agent" && payload.botId) {
      void dispatchOwnedAgentCommand(socket, "STOP_BOT", payload.botId, payload.clientRequestId);
      return;
    }

    const sessionId = payload.sessionId;
    const match = sessionId && sessions.has(sessionId) ? [sessionId, sessions.get(sessionId)!] as [string, BotSession] : findSessionForSocket(socket.id);
    if (!match) {
      return;
    }

    const user = socketUsers.get(socket.id);
    const owner = sessionOwners.get(match[0]);
    if (!user || !owner || !canSeeOwner(user, owner)) {
      return;
    }

    await match[1].stop();
    sessions.delete(match[0]);
    sessionOwners.delete(match[0]);
    selectedSessionBySocket.delete(socket.id);
    activePrompts.delete(match[0]);
    emitMaintenance();
  });

  socket.on("stop-session", async ({ sessionId }: { sessionId?: string }) => {
    if (!sessionId) {
      return;
    }

    const user = socketUsers.get(socket.id);
    const owner = sessionOwners.get(sessionId);
    const session = sessions.get(sessionId);
    if (!user || !owner || !session || !canSeeOwner(user, owner)) {
      return;
    }

    await session.stop();
    sessions.delete(sessionId);
    sessionOwners.delete(sessionId);
    activePrompts.delete(sessionId);
    for (const [socketId, selectedSessionId] of selectedSessionBySocket) {
      if (selectedSessionId === sessionId) {
        selectedSessionBySocket.delete(socketId);
      }
    }
    emitMaintenance();
  });

  socket.on("stop-all-sessions", async () => {
    await Promise.all([...sessions.values()].map((session) => session.stop()));
    sessions.clear();
    sessionOwners.clear();
    selectedSessionBySocket.clear();
    activePrompts.clear();
    emitMaintenance();
  });

  socket.on("disconnect", async () => {
    logger.info(`Interface deconnectee: ${socket.id}`);
    socketUsers.delete(socket.id);
    selectedSessionBySocket.delete(socket.id);
  });
});

const listen = (port: number): void => {
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.warn(`Port ${port} deja utilise, tentative sur ${port + 1}.`);
      listen(port + 1);
      return;
    }

    throw error;
  });

  server.listen(port, () => {
    writeServerLock(port);
    logger.success(`Interface web disponible: http://localhost:${port}`);
    logger.info(`Limite de clients actifs par VM: ${maxClients}`);
    emitMaintenance();
  });
};

listen(preferredPort);

initUserModule()
  .then(() => {
    // CHANTIER CIBLE (gestion des echeances et impayes): demarre APRES la
    // migration (ensureSchema(), executee par initUserModule()) - jamais en
    // parallele, pour ne jamais interroger next_payment_date/les tables
    // agency_billing_* avant qu'elles n'existent sur une base fraiche.
    startAgencyBillingScheduler();
  })
  .catch((error) => {
    logger.error(`Module utilisateurs indisponible: ${error instanceof Error ? error.message : String(error)}`);
    logger.error("Verifie que PostgreSQL est installe, lance, et accessible avec postgres / SMART.");
  });

process.once("exit", cleanupServerLock);
process.once("SIGINT", () => {
  cleanupServerLock();
  process.exit(0);
});
process.once("SIGTERM", () => {
  cleanupServerLock();
  process.exit(0);
});
