import { ADMIN_LOGIN, ADMIN_PASSWORD, DbAgency, DbExtensionLink, DbUser, ensureDatabaseExists, ensureSchema, pool } from "./db.js";
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

export type MonitoringSettings = Pick<
  AppConfig,
  | "maxParallelScansPerDomain"
  | "monthClickMinDelayMs"
  | "monthClickMaxDelayMs"
  | "botCycleCooldownMinMs"
  | "botCycleCooldownMaxMs"
  | "refreshEveryCycles"
  | "rateLimitCooldownMinutes"
>;

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

const defaultMonitoringSettings = (): MonitoringSettings => {
  const config = loadConfig();
  return {
    maxParallelScansPerDomain: config.maxParallelScansPerDomain,
    monthClickMinDelayMs: config.monthClickMinDelayMs,
    monthClickMaxDelayMs: config.monthClickMaxDelayMs,
    botCycleCooldownMinMs: config.botCycleCooldownMinMs,
    botCycleCooldownMaxMs: config.botCycleCooldownMaxMs,
    refreshEveryCycles: config.refreshEveryCycles,
    rateLimitCooldownMinutes: config.rateLimitCooldownMinutes
  };
};

const agencyToMonitoringSettings = (agency: DbAgency | null): MonitoringSettings => {
  const defaults = defaultMonitoringSettings();
  if (!agency) {
    return defaults;
  }

  return {
    maxParallelScansPerDomain: agency.max_parallel_scans_per_domain ?? defaults.maxParallelScansPerDomain,
    monthClickMinDelayMs: agency.month_click_min_delay_ms ?? defaults.monthClickMinDelayMs,
    monthClickMaxDelayMs: agency.month_click_max_delay_ms ?? defaults.monthClickMaxDelayMs,
    botCycleCooldownMinMs: agency.bot_cycle_cooldown_min_ms ?? defaults.botCycleCooldownMinMs,
    botCycleCooldownMaxMs: agency.bot_cycle_cooldown_max_ms ?? defaults.botCycleCooldownMaxMs,
    refreshEveryCycles: agency.refresh_every_cycles ?? defaults.refreshEveryCycles,
    rateLimitCooldownMinutes: agency.rate_limit_cooldown_minutes ?? defaults.rateLimitCooldownMinutes
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

export const normalizeMonitoringSettings = (
  patch: Partial<MonitoringSettings>,
  current = defaultMonitoringSettings()
): MonitoringSettings => {
  const minMonthDelay = clampInt(patch.monthClickMinDelayMs, current.monthClickMinDelayMs, 0, 600_000);
  const maxMonthDelay = clampInt(patch.monthClickMaxDelayMs, current.monthClickMaxDelayMs, minMonthDelay, 600_000);
  const minCycleCooldown = clampInt(patch.botCycleCooldownMinMs, current.botCycleCooldownMinMs, 0, 3_600_000);
  const maxCycleCooldown = clampInt(patch.botCycleCooldownMaxMs, current.botCycleCooldownMaxMs, minCycleCooldown, 3_600_000);

  return {
    maxParallelScansPerDomain: clampInt(patch.maxParallelScansPerDomain, current.maxParallelScansPerDomain, 1, 5),
    monthClickMinDelayMs: minMonthDelay,
    monthClickMaxDelayMs: maxMonthDelay,
    botCycleCooldownMinMs: minCycleCooldown,
    botCycleCooldownMaxMs: maxCycleCooldown,
    refreshEveryCycles: clampInt(patch.refreshEveryCycles, current.refreshEveryCycles, 0, 100),
    rateLimitCooldownMinutes: clampInt(patch.rateLimitCooldownMinutes, current.rateLimitCooldownMinutes, 1, 1_440)
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
  return result.rows[0];
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

export const updateAgencyMonitoringSettings = async (
  agencyId: number,
  patch: Partial<MonitoringSettings>
): Promise<MonitoringSettings> => {
  const current = await getAgencyMonitoringSettings(agencyId);
  const settings = normalizeMonitoringSettings(patch, current);
  const result = await pool.query<DbAgency>(
    `UPDATE agencies
     SET max_parallel_scans_per_domain = $2,
         month_click_min_delay_ms = $3,
         month_click_max_delay_ms = $4,
         bot_cycle_cooldown_min_ms = $5,
         bot_cycle_cooldown_max_ms = $6,
         refresh_every_cycles = $7,
         rate_limit_cooldown_minutes = $8
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
      settings.rateLimitCooldownMinutes
    ]
  );

  return agencyToMonitoringSettings(result.rows[0]);
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
