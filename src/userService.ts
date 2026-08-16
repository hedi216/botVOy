import { ADMIN_LOGIN, ADMIN_PASSWORD, DbAgency, DbAgencyCategory, DbExtensionLink, DbUser, DEFAULT_AGENCY_CATEGORIES, ensureDatabaseExists, ensureSchema, pool } from "./db.js";
import { loadConfig } from "./config.js";
import { hashPassword, verifyPassword } from "./password.js";
import { randomBytes } from "node:crypto";
import { AppConfig } from "./shared/types.js";

export type CreateUserInput = {
  agencyId: number;
  login: string;
  name: string;
  email: string;
  photoUrl?: string | null;
  role: 1 | 2;
  isActive?: boolean;
};

export type CreateUserResult = {
  user: DbUser;
  temporaryPassword: string;
};

// HOTFIX CIBLE (parametres de surveillance en secondes entieres):
// rateLimitCooldownSeconds est desormais le champ canonique (precision
// exacte a la seconde, jamais tronquee) - rateLimitCooldownMinutes (Picked
// depuis AppConfig ci-dessus) reste calculee automatiquement en
// rateLimitCooldownSeconds/60 UNIQUEMENT pour que sessionManager.ts
// (legacy_vm, spread direct de MonitoringSettings dans AppConfig, cf.
// BotSession.start()) continue de fonctionner sans aucune modification.
// controlRefreshIntervalSeconds n'a pas d'equivalent AppConfig (le champ
// AppConfig s'appelle controlRefreshIntervalMs et n'est jamais renseigne par
// ce spread) - legacy_vm reste donc exclusivement sur refreshEveryCycles.
export type MonitoringSettings = Pick<
  AppConfig,
  | "maxParallelScansPerDomain"
  | "monthClickMinDelayMs"
  | "monthClickMaxDelayMs"
  | "botCycleCooldownMinMs"
  | "botCycleCooldownMaxMs"
  | "refreshEveryCycles"
  | "rateLimitCooldownMinutes"
> & {
  controlRefreshIntervalSeconds: number;
  rateLimitCooldownSeconds: number;
};

// Contrat PUBLIC (HTTP GET/PATCH /api/monitoring-settings, consomme par
// public/app.js): unites explicitement en SECONDES, jamais de nom `Ms` ou
// `Minutes` - distinct de MonitoringSettings (interne, hybride ms/secondes)
// pour ne jamais faire fuiter les unites internes vers l'UI. refreshEveryCycles
// n'apparait plus ici (retire de l'ecran Agent, reste uniquement pour
// legacy_vm en interne, cf. section 5 du hotfix).
export type PublicMonitoringSettings = {
  maxParallelScansPerDomain: number;
  monthClickMinDelaySeconds: number;
  monthClickMaxDelaySeconds: number;
  botCycleCooldownMinSeconds: number;
  botCycleCooldownMaxSeconds: number;
  controlRefreshIntervalSeconds: number;
  rateLimitCooldownSeconds: number;
};

export type PublicMonitoringSettingsPatch = Partial<PublicMonitoringSettings>;

export const toPublicMonitoringSettings = (settings: MonitoringSettings): PublicMonitoringSettings => ({
  maxParallelScansPerDomain: settings.maxParallelScansPerDomain,
  monthClickMinDelaySeconds: Math.round(settings.monthClickMinDelayMs / 1000),
  monthClickMaxDelaySeconds: Math.round(settings.monthClickMaxDelayMs / 1000),
  botCycleCooldownMinSeconds: Math.round(settings.botCycleCooldownMinMs / 1000),
  botCycleCooldownMaxSeconds: Math.round(settings.botCycleCooldownMaxMs / 1000),
  controlRefreshIntervalSeconds: settings.controlRefreshIntervalSeconds,
  rateLimitCooldownSeconds: settings.rateLimitCooldownSeconds
});

// Convertit uniquement les champs presents dans le patch public (secondes)
// vers le patch interne (ms pour mois/cycles, secondes deja natives pour
// refresh/rate-limit) - jamais de multiplication par 60000 pour un champ en
// secondes (cf. "30 secondes ne doit jamais devenir 30 minutes").
export const fromPublicMonitoringSettingsPatch = (patch: PublicMonitoringSettingsPatch): Partial<MonitoringSettings> => {
  const result: Partial<MonitoringSettings> = {};
  if (patch.maxParallelScansPerDomain !== undefined) {
    result.maxParallelScansPerDomain = patch.maxParallelScansPerDomain;
  }
  if (patch.monthClickMinDelaySeconds !== undefined) {
    result.monthClickMinDelayMs = patch.monthClickMinDelaySeconds * 1000;
  }
  if (patch.monthClickMaxDelaySeconds !== undefined) {
    result.monthClickMaxDelayMs = patch.monthClickMaxDelaySeconds * 1000;
  }
  if (patch.botCycleCooldownMinSeconds !== undefined) {
    result.botCycleCooldownMinMs = patch.botCycleCooldownMinSeconds * 1000;
  }
  if (patch.botCycleCooldownMaxSeconds !== undefined) {
    result.botCycleCooldownMaxMs = patch.botCycleCooldownMaxSeconds * 1000;
  }
  if (patch.controlRefreshIntervalSeconds !== undefined) {
    result.controlRefreshIntervalSeconds = patch.controlRefreshIntervalSeconds;
  }
  if (patch.rateLimitCooldownSeconds !== undefined) {
    result.rateLimitCooldownSeconds = patch.rateLimitCooldownSeconds;
  }
  return result;
};

export type RecordingExtensionLicenseType = "" | "free" | "paid";

export type RecordingExtensionSettings = {
  enabled: boolean;
  installUrl: string | null;
  name: string | null;
  licenseType: RecordingExtensionLicenseType;
  updatedAt: string | null;
};

export type AgencySettings = MonitoringSettings & {
  recordingExtension: RecordingExtensionSettings;
};

export type ExtensionLinkInput = {
  agencyId: number;
  name: string;
  installUrl: string;
  isActive?: boolean;
};

export type ExtensionLink = {
  id: number;
  agencyId: number;
  name: string;
  installUrl: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
};

export type AgencyCategory = {
  id: number;
  agencyId: number;
  name: string;
  createdAt: string;
};

const DEFAULT_CONTROL_REFRESH_INTERVAL_SECONDS = 1_200;

const defaultMonitoringSettings = (): MonitoringSettings => {
  const config = loadConfig();
  return {
    maxParallelScansPerDomain: config.maxParallelScansPerDomain,
    monthClickMinDelayMs: config.monthClickMinDelayMs,
    monthClickMaxDelayMs: config.monthClickMaxDelayMs,
    botCycleCooldownMinMs: config.botCycleCooldownMinMs,
    botCycleCooldownMaxMs: config.botCycleCooldownMaxMs,
    refreshEveryCycles: config.refreshEveryCycles,
    rateLimitCooldownMinutes: config.rateLimitCooldownMinutes,
    controlRefreshIntervalSeconds: DEFAULT_CONTROL_REFRESH_INTERVAL_SECONDS,
    rateLimitCooldownSeconds: config.rateLimitCooldownMinutes * 60
  };
};

const agencyToMonitoringSettings = (agency: DbAgency | null): MonitoringSettings => {
  const defaults = defaultMonitoringSettings();
  if (!agency) {
    return defaults;
  }

  const rateLimitCooldownSeconds = agency.rate_limit_cooldown_seconds ?? defaults.rateLimitCooldownSeconds;

  return {
    maxParallelScansPerDomain: agency.max_parallel_scans_per_domain ?? defaults.maxParallelScansPerDomain,
    monthClickMinDelayMs: agency.month_click_min_delay_ms ?? defaults.monthClickMinDelayMs,
    monthClickMaxDelayMs: agency.month_click_max_delay_ms ?? defaults.monthClickMaxDelayMs,
    botCycleCooldownMinMs: agency.bot_cycle_cooldown_min_ms ?? defaults.botCycleCooldownMinMs,
    botCycleCooldownMaxMs: agency.bot_cycle_cooldown_max_ms ?? defaults.botCycleCooldownMaxMs,
    refreshEveryCycles: agency.refresh_every_cycles ?? defaults.refreshEveryCycles,
    // Retrocompatibilite legacy_vm (sessionManager.ts, spread direct dans
    // AppConfig): derivee de rateLimitCooldownSeconds, simple division jamais
    // tronquee - jamais lue depuis la colonne DB minutes (gelee, cf. db.ts),
    // pour rester alignee sur la valeur reellement configuree en secondes.
    rateLimitCooldownMinutes: rateLimitCooldownSeconds / 60,
    controlRefreshIntervalSeconds: agency.control_refresh_interval_seconds ?? defaults.controlRefreshIntervalSeconds,
    rateLimitCooldownSeconds
  };
};

export const agencyToRecordingExtensionSettings = (agency: DbAgency | null): RecordingExtensionSettings => ({
  enabled: agency?.recording_extension_enabled ?? false,
  installUrl: agency?.recording_extension_install_url ?? null,
  name: agency?.recording_extension_name ?? null,
  licenseType: (agency?.recording_extension_license_type as RecordingExtensionLicenseType | null) ?? "",
  updatedAt: agency?.recording_extension_updated_at ?? null
});

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(numberValue), min), max);
};

// HOTFIX CIBLE (parametres de surveillance en secondes entieres): planchers
// alignes UI/serveur/Agent - une valeur hors bornes est desormais REFUSEE
// (HTTP 400 clair), jamais silencieusement remontee a la valeur plancher
// sans que l'utilisateur le sache (cf. MIN_SAFE_CYCLE_COOLDOWN_MS cote
// Agent, agentMonitoringSettings.ts, qui reste une SECONDE ligne de defense
// independante avec le meme plancher).
const MONTH_DELAY_MIN_MS = 1_000;
const MONTH_DELAY_MAX_MS = 600_000;
const CYCLE_COOLDOWN_MIN_MS = 5_000;
const CYCLE_COOLDOWN_MAX_MS = 3_600_000;
const CONTROL_REFRESH_MIN_SECONDS = 60;
const CONTROL_REFRESH_MAX_SECONDS = 86_400;
const RATE_LIMIT_MIN_SECONDS = 60;
const RATE_LIMIT_MAX_SECONDS = 86_400;

export type NormalizeMonitoringSettingsResult =
  | { ok: true; settings: MonitoringSettings }
  | { ok: false; error: string };

export const normalizeMonitoringSettings = (
  patch: Partial<MonitoringSettings>,
  current: MonitoringSettings = defaultMonitoringSettings()
): NormalizeMonitoringSettingsResult => {
  const monthClickMinDelayMs = patch.monthClickMinDelayMs ?? current.monthClickMinDelayMs;
  const monthClickMaxDelayMs = patch.monthClickMaxDelayMs ?? current.monthClickMaxDelayMs;
  if (
    !Number.isFinite(monthClickMinDelayMs) || !Number.isFinite(monthClickMaxDelayMs)
    || monthClickMinDelayMs < MONTH_DELAY_MIN_MS || monthClickMinDelayMs > MONTH_DELAY_MAX_MS
    || monthClickMaxDelayMs < MONTH_DELAY_MIN_MS || monthClickMaxDelayMs > MONTH_DELAY_MAX_MS
  ) {
    return { ok: false, error: `Delai entre mois hors bornes (${MONTH_DELAY_MIN_MS / 1000} a ${MONTH_DELAY_MAX_MS / 1000} secondes).` };
  }
  if (monthClickMinDelayMs > monthClickMaxDelayMs) {
    return { ok: false, error: "Le delai min entre mois doit etre inferieur ou egal au delai max." };
  }

  const botCycleCooldownMinMs = patch.botCycleCooldownMinMs ?? current.botCycleCooldownMinMs;
  const botCycleCooldownMaxMs = patch.botCycleCooldownMaxMs ?? current.botCycleCooldownMaxMs;
  if (
    !Number.isFinite(botCycleCooldownMinMs) || !Number.isFinite(botCycleCooldownMaxMs)
    || botCycleCooldownMinMs < CYCLE_COOLDOWN_MIN_MS || botCycleCooldownMinMs > CYCLE_COOLDOWN_MAX_MS
    || botCycleCooldownMaxMs < CYCLE_COOLDOWN_MIN_MS || botCycleCooldownMaxMs > CYCLE_COOLDOWN_MAX_MS
  ) {
    return { ok: false, error: `Pause entre cycles hors bornes (${CYCLE_COOLDOWN_MIN_MS / 1000} a ${CYCLE_COOLDOWN_MAX_MS / 1000} secondes).` };
  }
  if (botCycleCooldownMinMs > botCycleCooldownMaxMs) {
    return { ok: false, error: "La pause min entre cycles doit etre inferieure ou egale a la pause max." };
  }

  const controlRefreshIntervalSeconds = patch.controlRefreshIntervalSeconds ?? current.controlRefreshIntervalSeconds;
  if (
    !Number.isFinite(controlRefreshIntervalSeconds)
    || controlRefreshIntervalSeconds < CONTROL_REFRESH_MIN_SECONDS
    || controlRefreshIntervalSeconds > CONTROL_REFRESH_MAX_SECONDS
  ) {
    return { ok: false, error: `Refresh de controle hors bornes (${CONTROL_REFRESH_MIN_SECONDS} a ${CONTROL_REFRESH_MAX_SECONDS} secondes).` };
  }

  const rateLimitCooldownSeconds = patch.rateLimitCooldownSeconds ?? current.rateLimitCooldownSeconds;
  if (
    !Number.isFinite(rateLimitCooldownSeconds)
    || rateLimitCooldownSeconds < RATE_LIMIT_MIN_SECONDS
    || rateLimitCooldownSeconds > RATE_LIMIT_MAX_SECONDS
  ) {
    return { ok: false, error: `Cooldown rate limit hors bornes (${RATE_LIMIT_MIN_SECONDS} a ${RATE_LIMIT_MAX_SECONDS} secondes).` };
  }

  return {
    ok: true,
    settings: {
      maxParallelScansPerDomain: clampInt(patch.maxParallelScansPerDomain, current.maxParallelScansPerDomain, 1, 5),
      monthClickMinDelayMs: Math.trunc(monthClickMinDelayMs),
      monthClickMaxDelayMs: Math.trunc(monthClickMaxDelayMs),
      botCycleCooldownMinMs: Math.trunc(botCycleCooldownMinMs),
      botCycleCooldownMaxMs: Math.trunc(botCycleCooldownMaxMs),
      refreshEveryCycles: clampInt(patch.refreshEveryCycles, current.refreshEveryCycles, 0, 100),
      rateLimitCooldownMinutes: rateLimitCooldownSeconds / 60,
      controlRefreshIntervalSeconds: Math.trunc(controlRefreshIntervalSeconds),
      rateLimitCooldownSeconds: Math.trunc(rateLimitCooldownSeconds)
    }
  };
};

export const initUserModule = async (): Promise<void> => {
  await ensureDatabaseExists();
  await ensureSchema();

  await pool.query(
    `UPDATE browser_profiles
     SET recording_extension_status = 'intervention_required',
         last_error = 'Preparation interrompue par un arret de RendezBot.'
     WHERE recording_extension_status = 'preparing'`
  );

  const admin = await pool.query("SELECT id FROM users WHERE login = $1", [ADMIN_LOGIN]);
  if (admin.rowCount === 0) {
    await pool.query(
      `INSERT INTO users (agency_id, login, password_hash, name, role, is_active)
       VALUES (NULL, $1, $2, 'Administrateur', 0, TRUE)`,
      [ADMIN_LOGIN, await hashPassword(ADMIN_PASSWORD)]
    );
  }
};

export const authenticateUser = async (login: string, password: string): Promise<DbUser | null> => {
  const result = await pool.query<DbUser & { password_hash: string }>(
    `SELECT *
     FROM users
     WHERE lower(login) = lower($1)
     ORDER BY CASE WHEN login = $1 THEN 0 ELSE 1 END
     LIMIT 1`,
    [login.trim()]
  );
  const user = result.rows[0];

  if (!user || !user.is_active) {
    return null;
  }

  const passwordValid = await verifyPassword(password, user.password_hash);

  if (!passwordValid) {
    const attempts = user.failed_login_attempts + 1;
    if (user.role === 0) {
      await pool.query(
        "UPDATE users SET failed_login_attempts = $2 WHERE id = $1",
        [user.id, attempts]
      );
    } else {
      await pool.query(
        `UPDATE users
         SET failed_login_attempts = $2,
             is_active = CASE WHEN $2 >= 3 THEN FALSE ELSE is_active END
         WHERE id = $1`,
        [user.id, attempts]
      );
    }
    return null;
  }

  const updated = await pool.query<DbUser>(
    `UPDATE users
     SET failed_login_attempts = 0,
         last_login_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [user.id]
  );

  return sanitizeUser(updated.rows[0]);
};

export const sanitizeUser = (user: DbUser): DbUser => ({
  id: user.id,
  agency_id: user.agency_id,
  login: user.login,
  name: user.name,
  email: user.email,
  photo_url: user.photo_url,
  role: user.role,
  is_active: user.is_active,
  failed_login_attempts: user.failed_login_attempts,
  created_at: user.created_at,
  last_login_at: user.last_login_at,
  password_changed_at: user.password_changed_at
});

export const listAgencies = async (): Promise<Array<DbAgency & { active_users: number }>> => {
  const result = await pool.query<DbAgency & { active_users: number }>(`
    SELECT a.*, COUNT(u.id)::int AS active_users
    FROM agencies a
    LEFT JOIN users u ON u.agency_id = a.id AND u.is_active = TRUE AND u.role IN (1, 2)
    GROUP BY a.id
    ORDER BY a.id
  `);
  return result.rows;
};

export const createAgency = async (
  name: string,
  maxActiveClients = 15,
  notificationEmail?: string | null
): Promise<DbAgency> => {
  const result = await pool.query<DbAgency>(
    "INSERT INTO agencies (name, max_active_clients, notification_email) VALUES ($1, $2, $3) RETURNING *",
    [name, Math.min(maxActiveClients, 15), notificationEmail || null]
  );
  const agency = result.rows[0];

  // QUICK HOTFIX (categories par agence): toute NOUVELLE agence recoit
  // immediatement sa PROPRE copie des categories par defaut - independante de
  // toute autre agence des cet instant (suppression/ajout ulterieur sans
  // aucun effet croise). categories_seeded_at est pose ICI, dans la meme
  // operation de creation, pour que le backfill boot-time (ensureSchema(),
  // db.ts) ignore toujours cette agence (colonne deja non NULL) et ne puisse
  // jamais entrer en course avec ce seed initial.
  await pool.query(
    `INSERT INTO agency_categories (agency_id, name)
     SELECT $1::int, d.name FROM unnest($2::text[]) AS d(name)
     ON CONFLICT (agency_id, name) DO NOTHING`,
    [agency.id, DEFAULT_AGENCY_CATEGORIES]
  );
  const seeded = await pool.query<DbAgency>(
    "UPDATE agencies SET categories_seeded_at = NOW() WHERE id = $1 RETURNING *",
    [agency.id]
  );

  return seeded.rows[0];
};

// QUICK HOTFIX (categories par agence): resolution SERVEUR de l'agence
// ciblee, jamais confiee au client - reutilise le meme contrat que les
// extensions/parametres deja en place (getSettingsAgencyId ci-dessous,
// deplace ici depuis server.ts pour rester testable sans demarrer tout le
// serveur HTTP). Role 0 (admin global) peut agir sur l'agence de son choix
// (`value`, fournie par la requete); role 1 (gestionnaire d'agence) est
// TOUJOURS fixe a sa propre agence de session, jamais une valeur cliente;
// role 2 n'a jamais le droit d'administrer (categories WRITE) -> null.
export const getSettingsAgencyId = (user: DbUser, value?: unknown): number | null => {
  if (![0, 1].includes(user.role)) {
    return null;
  }

  if (user.role === 0) {
    const agencyId = Number(value);
    return agencyId ? agencyId : null;
  }

  return user.agency_id ? Number(user.agency_id) : null;
};

// QUICK HOTFIX (categories par agence): variante LECTURE, utilisee
// uniquement par la liste des categories (GET) - role 2 a le droit
// d'UTILISER les categories de sa propre agence (dropdown du formulaire Bot)
// sans jamais pouvoir les administrer (create/delete restent sur
// getSettingsAgencyId ci-dessus, role 0/1 seulement). Role 2 est TOUJOURS
// fixe a sa propre agence de session, jamais une valeur cliente - identique
// au traitement du role 1 dans getSettingsAgencyId.
export const getCategoriesReadAgencyId = (user: DbUser, value?: unknown): number | null => {
  if (user.role === 0) {
    const agencyId = Number(value);
    return agencyId ? agencyId : null;
  }

  return user.agency_id ? Number(user.agency_id) : null;
};

const agencyCategoryFromDb = (row: DbAgencyCategory): AgencyCategory => ({
  id: row.id,
  agencyId: row.agency_id,
  name: row.name,
  createdAt: row.created_at
});

export const listAgencyCategories = async (agencyId: number): Promise<AgencyCategory[]> => {
  const result = await pool.query<DbAgencyCategory>(
    "SELECT * FROM agency_categories WHERE agency_id = $1 ORDER BY name",
    [agencyId]
  );
  return result.rows.map(agencyCategoryFromDb);
};

export const createAgencyCategory = async (agencyId: number, name: unknown): Promise<AgencyCategory> => {
  const normalized = normalizeOptionalText(name, 160, "Le nom de la categorie");
  if (!normalized) {
    throw new Error("Le nom de la categorie est requis.");
  }

  try {
    const result = await pool.query<DbAgencyCategory>(
      "INSERT INTO agency_categories (agency_id, name) VALUES ($1, $2) RETURNING *",
      [agencyId, normalized]
    );
    return agencyCategoryFromDb(result.rows[0]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new Error("Cette categorie existe deja pour cette agence.");
    }
    throw error;
  }
};

export const renameAgencyCategory = async (agencyId: number, categoryId: number, name: unknown): Promise<AgencyCategory> => {
  const normalized = normalizeOptionalText(name, 160, "Le nom de la categorie");
  if (!normalized) {
    throw new Error("Le nom de la categorie est requis.");
  }

  try {
    const result = await pool.query<DbAgencyCategory>(
      "UPDATE agency_categories SET name = $3 WHERE agency_id = $1 AND id = $2 RETURNING *",
      [agencyId, categoryId, normalized]
    );
    if (!result.rows[0]) {
      throw new Error("Categorie introuvable.");
    }
    return agencyCategoryFromDb(result.rows[0]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new Error("Cette categorie existe deja pour cette agence.");
    }
    throw error;
  }
};

// Ne supprime jamais un bot/historique/log existant (deja stocke comme
// simple string libre, jamais une foreign key vers cette table) - retire
// uniquement ce choix des futurs demarrages de bot pour cette agence.
export const deleteAgencyCategory = async (agencyId: number, categoryId: number): Promise<void> => {
  const result = await pool.query(
    "DELETE FROM agency_categories WHERE agency_id = $1 AND id = $2",
    [agencyId, categoryId]
  );
  if (result.rowCount === 0) {
    throw new Error("Categorie introuvable.");
  }
};

export const getAgency = async (agencyId: number): Promise<DbAgency | null> => {
  const result = await pool.query<DbAgency>("SELECT * FROM agencies WHERE id = $1", [agencyId]);
  return result.rows[0] ?? null;
};

export const getAgencyMonitoringSettings = async (agencyId: number | null): Promise<MonitoringSettings> => {
  if (!agencyId) {
    return defaultMonitoringSettings();
  }

  return agencyToMonitoringSettings(await getAgency(agencyId));
};

export const getAgencySettings = async (agencyId: number | null): Promise<AgencySettings> => {
  const agency = agencyId ? await getAgency(agencyId) : null;
  return {
    ...agencyToMonitoringSettings(agency),
    recordingExtension: agencyToRecordingExtensionSettings(agency)
  };
};

export type UpdateAgencyMonitoringSettingsResult =
  | { ok: true; settings: MonitoringSettings }
  | { ok: false; error: string };

export const updateAgencyMonitoringSettings = async (
  agencyId: number,
  patch: Partial<MonitoringSettings>
): Promise<UpdateAgencyMonitoringSettingsResult> => {
  const current = await getAgencyMonitoringSettings(agencyId);
  const normalized = normalizeMonitoringSettings(patch, current);
  if (!normalized.ok) {
    return normalized;
  }

  const settings = normalized.settings;
  const result = await pool.query<DbAgency>(
    `UPDATE agencies
     SET max_parallel_scans_per_domain = $2,
         month_click_min_delay_ms = $3,
         month_click_max_delay_ms = $4,
         bot_cycle_cooldown_min_ms = $5,
         bot_cycle_cooldown_max_ms = $6,
         refresh_every_cycles = $7,
         control_refresh_interval_seconds = $8,
         rate_limit_cooldown_seconds = $9
     WHERE id = $1
     RETURNING *`,
    [
      agencyId,
      settings.maxParallelScansPerDomain,
      settings.monthClickMinDelayMs,
      settings.monthClickMaxDelayMs,
      settings.botCycleCooldownMinMs,
      settings.botCycleCooldownMaxMs,
      settings.refreshEveryCycles,
      settings.controlRefreshIntervalSeconds,
      settings.rateLimitCooldownSeconds
    ]
  );

  return { ok: true, settings: agencyToMonitoringSettings(result.rows[0]) };
};

const validateInstallUrl = (value: unknown): string | null => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return null;
  }

  if (raw.length > 2_000) {
    throw new Error("Le lien d'installation est trop long.");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Le lien d'installation doit etre une URL valide.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Le lien d'installation doit commencer par http:// ou https://.");
  }

  return raw;
};

const normalizeOptionalText = (value: unknown, maxLength: number, fieldLabel: string): string | null => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return null;
  }

  if (raw.length > maxLength) {
    throw new Error(`${fieldLabel} est trop long.`);
  }

  return raw;
};

export const updateAgencyRecordingExtensionSettings = async (
  agencyId: number,
  patch: {
    enabled?: boolean;
    installUrl?: string | null;
    name?: string | null;
    licenseType?: string | null;
  }
): Promise<RecordingExtensionSettings & { linkChanged: boolean }> => {
  const current = await getAgency(agencyId);
  if (!current) {
    throw new Error("Agence introuvable.");
  }

  const enabled = typeof patch.enabled === "boolean" ? patch.enabled : current.recording_extension_enabled;
  const installUrl = "installUrl" in patch
    ? validateInstallUrl(patch.installUrl)
    : current.recording_extension_install_url;
  const name = "name" in patch
    ? normalizeOptionalText(patch.name, 160, "Le nom de l'extension")
    : current.recording_extension_name;
  const licenseType = "licenseType" in patch
    ? (patch.licenseType || null)
    : current.recording_extension_license_type;

  if (licenseType && !["free", "paid"].includes(licenseType)) {
    throw new Error("Type de licence invalide.");
  }

  if (enabled && !installUrl) {
    throw new Error("Un lien d'installation valide est requis pour activer l'extension.");
  }

  const linkChanged = installUrl !== current.recording_extension_install_url;
  const configChanged = linkChanged
    || enabled !== current.recording_extension_enabled
    || name !== current.recording_extension_name
    || licenseType !== current.recording_extension_license_type;
  const result = await pool.query<DbAgency>(
    `UPDATE agencies
     SET recording_extension_enabled = $2,
         recording_extension_install_url = $3,
         recording_extension_name = $4,
         recording_extension_license_type = $5,
         recording_extension_updated_at = CASE
           WHEN $6 THEN NOW()
           ELSE recording_extension_updated_at
         END
     WHERE id = $1
     RETURNING *`,
    [agencyId, enabled, installUrl, name, licenseType, configChanged]
  );

  if (linkChanged) {
    await pool.query(
      `UPDATE browser_profiles
       SET recording_extension_status = CASE
             WHEN recording_extension_status = 'ready' THEN 'pending'
             ELSE recording_extension_status
           END,
           last_error = CASE
             WHEN recording_extension_status = 'ready' THEN 'Lien d''installation modifie: preparation requise.'
             ELSE last_error
           END
       WHERE agency_id = $1`,
      [agencyId]
    );
  }

  return {
    ...agencyToRecordingExtensionSettings(result.rows[0]),
    linkChanged
  };
};

const extensionLinkFromDb = (row: DbExtensionLink): ExtensionLink => ({
  id: row.id,
  agencyId: row.agency_id,
  name: row.name,
  installUrl: row.install_url,
  isActive: row.is_active,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export const listExtensionLinks = async (agencyId: number, activeOnly = false): Promise<ExtensionLink[]> => {
  const result = await pool.query<DbExtensionLink>(
    `SELECT * FROM extension_links
     WHERE agency_id = $1 AND ($2::boolean = FALSE OR is_active = TRUE)
     ORDER BY id`,
    [agencyId, activeOnly]
  );
  return result.rows.map(extensionLinkFromDb);
};

export const createExtensionLink = async (input: ExtensionLinkInput): Promise<ExtensionLink> => {
  const installUrl = validateInstallUrl(input.installUrl);
  if (!installUrl) {
    throw new Error("Le lien d'installation est requis.");
  }

  const name = normalizeOptionalText(input.name, 160, "Le nom de l'extension") ?? "Extension";
  const result = await pool.query<DbExtensionLink>(
    `INSERT INTO extension_links (agency_id, name, install_url, is_active)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.agencyId, name, installUrl, input.isActive ?? true]
  );
  return extensionLinkFromDb(result.rows[0]);
};

export const updateExtensionLink = async (
  agencyId: number,
  extensionId: number,
  patch: Partial<Pick<ExtensionLinkInput, "name" | "installUrl" | "isActive">>
): Promise<ExtensionLink> => {
  const current = await pool.query<DbExtensionLink>(
    "SELECT * FROM extension_links WHERE agency_id = $1 AND id = $2",
    [agencyId, extensionId]
  );
  if (!current.rows[0]) {
    throw new Error("Lien d'extension introuvable.");
  }

  const installUrl = "installUrl" in patch
    ? validateInstallUrl(patch.installUrl)
    : current.rows[0].install_url;
  if (!installUrl) {
    throw new Error("Le lien d'installation est requis.");
  }

  const name = "name" in patch
    ? normalizeOptionalText(patch.name, 160, "Le nom de l'extension") ?? "Extension"
    : current.rows[0].name;
  const isActive = typeof patch.isActive === "boolean" ? patch.isActive : current.rows[0].is_active;

  const result = await pool.query<DbExtensionLink>(
    `UPDATE extension_links
     SET name = $3,
         install_url = $4,
         is_active = $5,
         updated_at = NOW()
     WHERE agency_id = $1 AND id = $2
     RETURNING *`,
    [agencyId, extensionId, name, installUrl, isActive]
  );
  return extensionLinkFromDb(result.rows[0]);
};

export const deleteExtensionLink = async (agencyId: number, extensionId: number): Promise<void> => {
  const result = await pool.query(
    "DELETE FROM extension_links WHERE agency_id = $1 AND id = $2",
    [agencyId, extensionId]
  );
  if (result.rowCount === 0) {
    throw new Error("Lien d'extension introuvable.");
  }
};

export const setAgencyActive = async (agencyId: number, isActive: boolean): Promise<DbAgency> => {
  const result = await pool.query<DbAgency>(
    "UPDATE agencies SET is_active = $2 WHERE id = $1 RETURNING *",
    [agencyId, isActive]
  );
  return result.rows[0];
};

export const updateAgency = async (
  agencyId: number,
  patch: Partial<Pick<DbAgency, "is_active" | "notification_email" | "max_active_clients">>
): Promise<DbAgency> => {
  const result = await pool.query<DbAgency>(
    `UPDATE agencies
     SET is_active = COALESCE($2, is_active),
         notification_email = COALESCE($3, notification_email),
         max_active_clients = COALESCE($4, max_active_clients)
     WHERE id = $1
     RETURNING *`,
    [
      agencyId,
      patch.is_active ?? null,
      patch.notification_email ?? null,
      patch.max_active_clients ?? null
    ]
  );
  return result.rows[0];
};

export const listUsersForRequester = async (requester: DbUser): Promise<DbUser[]> => {
  const query = requester.role === 0
    ? "SELECT * FROM users WHERE role IN (1, 2) ORDER BY id"
    : "SELECT * FROM users WHERE agency_id = $1 AND role IN (1, 2) ORDER BY id";
  const values = requester.role === 0 ? [] : [requester.agency_id];
  const result = await pool.query<DbUser>(query, values);
  return result.rows.map(sanitizeUser);
};

const assertAgencyCapacity = async (agencyId: number): Promise<void> => {
  const result = await pool.query<{ active_users: number; max_active_clients: number; is_active: boolean }>(`
    SELECT
      a.max_active_clients,
      a.is_active,
      COUNT(u.id)::int AS active_users
    FROM agencies a
    LEFT JOIN users u ON u.agency_id = a.id AND u.is_active = TRUE AND u.role IN (1, 2)
    WHERE a.id = $1
    GROUP BY a.id
  `, [agencyId]);
  const agency = result.rows[0];

  if (!agency) {
    throw new Error("Agence introuvable.");
  }

  if (!agency.is_active) {
    throw new Error("Agence inactive.");
  }

  if (agency.active_users >= agency.max_active_clients) {
    throw new Error(`Limite d'utilisateurs actifs atteinte pour cette agence (${agency.active_users}/${agency.max_active_clients}).`);
  }
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeUserEmail = (value: unknown): string => {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (!raw) {
    throw new Error("L'adresse e-mail est obligatoire.");
  }

  if (raw.length > 254) {
    throw new Error("L'adresse e-mail est trop longue.");
  }

  if (!EMAIL_PATTERN.test(raw)) {
    throw new Error("L'adresse e-mail est invalide.");
  }

  return raw;
};

export const getUserNotificationEmail = async (userId: number): Promise<string | null> => {
  const result = await pool.query<{ email: string | null }>(
    "SELECT email FROM users WHERE id = $1",
    [userId]
  );
  return result.rows[0]?.email ?? null;
};

export const generateTemporaryPassword = (): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = randomBytes(14);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
};

export const createUser = async (input: CreateUserInput): Promise<CreateUserResult> => {
  if (input.isActive ?? true) {
    await assertAgencyCapacity(input.agencyId);
  }

  const email = normalizeUserEmail(input.email);
  const temporaryPassword = generateTemporaryPassword();
  const result = await pool.query<DbUser>(
    `INSERT INTO users (agency_id, login, password_hash, name, email, photo_url, role, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.agencyId,
      input.login,
      await hashPassword(temporaryPassword),
      input.name,
      email,
      input.photoUrl ?? null,
      input.role,
      input.isActive ?? true
    ]
  );
  return {
    user: sanitizeUser(result.rows[0]),
    temporaryPassword
  };
};

export const updateUser = async (
  userId: number,
  patch: Partial<Pick<DbUser, "name" | "photo_url" | "is_active" | "role" | "email">>,
  requester: DbUser
): Promise<DbUser> => {
  const targetResult = await pool.query<DbUser>("SELECT * FROM users WHERE id = $1", [userId]);
  const target = targetResult.rows[0];

  if (!target) {
    throw new Error("Utilisateur introuvable.");
  }

  if (target.role === 0) {
    throw new Error("Le compte administrateur interne ne peut pas etre modifie ici.");
  }

  if (requester.role !== 0 && requester.agency_id !== target.agency_id) {
    throw new Error("Acces refuse.");
  }

  if (requester.id === target.id && patch.is_active === false) {
    throw new Error("Impossible de desactiver votre propre compte.");
  }

  if (requester.id === target.id && patch.role && patch.role !== target.role) {
    throw new Error("Impossible de changer votre propre niveau.");
  }

  if (patch.is_active === true && target.is_active === false && target.agency_id) {
    await assertAgencyCapacity(target.agency_id);
  }

  const email = "email" in patch && patch.email !== undefined ? normalizeUserEmail(patch.email) : null;

  const result = await pool.query<DbUser>(
    `UPDATE users
     SET name = COALESCE($2, name),
         photo_url = COALESCE($3, photo_url),
         is_active = COALESCE($4, is_active),
         role = COALESCE($5, role),
         email = COALESCE($6, email),
         failed_login_attempts = CASE WHEN COALESCE($4, is_active) = TRUE THEN 0 ELSE failed_login_attempts END
     WHERE id = $1
     RETURNING *`,
    [userId, patch.name ?? null, patch.photo_url ?? null, patch.is_active ?? null, patch.role ?? null, email]
  );

  return sanitizeUser(result.rows[0]);
};

export const resetUserPassword = async (userId: number, requester: DbUser): Promise<CreateUserResult> => {
  const targetResult = await pool.query<DbUser>("SELECT * FROM users WHERE id = $1", [userId]);
  const target = targetResult.rows[0];

  if (!target || target.role === 0) {
    throw new Error("Utilisateur introuvable.");
  }

  if (requester.role !== 0 && requester.agency_id !== target.agency_id) {
    throw new Error("Acces refuse.");
  }

  if (!target.is_active && target.agency_id) {
    await assertAgencyCapacity(target.agency_id);
  }

  const temporaryPassword = generateTemporaryPassword();
  const result = await pool.query<DbUser>(
    `UPDATE users
     SET password_hash = $2,
         is_active = TRUE,
         failed_login_attempts = 0,
         password_changed_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [userId, await hashPassword(temporaryPassword)]
  );

  return {
    user: sanitizeUser(result.rows[0]),
    temporaryPassword
  };
};

export const changeOwnPassword = async (
  userId: number,
  currentPassword: string,
  newPassword: string
): Promise<void> => {
  if (newPassword.length < 8) {
    throw new Error("Le nouveau mot de passe doit contenir au moins 8 caracteres.");
  }

  const result = await pool.query<DbUser & { password_hash: string }>(
    "SELECT * FROM users WHERE id = $1",
    [userId]
  );
  const user = result.rows[0];

  if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
    throw new Error("Mot de passe actuel incorrect.");
  }

  await pool.query(
    `UPDATE users
     SET password_hash = $2,
         failed_login_attempts = 0,
         password_changed_at = NOW()
     WHERE id = $1`,
    [userId, await hashPassword(newPassword)]
  );
};
