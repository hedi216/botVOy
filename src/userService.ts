import { ADMIN_LOGIN, ADMIN_PASSWORD, DbAgency, DbUser, ensureDatabaseExists, ensureSchema, pool } from "./db.js";
import { hashPassword, verifyPassword } from "./password.js";
import { randomBytes } from "node:crypto";

export type CreateUserInput = {
  agencyId: number;
  login: string;
  name: string;
  photoUrl?: string | null;
  role: 1 | 2;
  isActive?: boolean;
};

export type CreateUserResult = {
  user: DbUser;
  temporaryPassword: string;
};

export const initUserModule = async (): Promise<void> => {
  await ensureDatabaseExists();
  await ensureSchema();

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
    "SELECT * FROM users WHERE login = $1",
    [login]
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

export const getAgencyNotificationEmail = async (agencyId: number): Promise<string | null> => {
  const result = await pool.query<{ notification_email: string | null }>(
    "SELECT notification_email FROM agencies WHERE id = $1",
    [agencyId]
  );
  return result.rows[0]?.notification_email ?? null;
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

export const generateTemporaryPassword = (): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = randomBytes(14);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
};

export const createUser = async (input: CreateUserInput): Promise<CreateUserResult> => {
  if (input.isActive ?? true) {
    await assertAgencyCapacity(input.agencyId);
  }

  const temporaryPassword = generateTemporaryPassword();
  const result = await pool.query<DbUser>(
    `INSERT INTO users (agency_id, login, password_hash, name, photo_url, role, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.agencyId,
      input.login,
      await hashPassword(temporaryPassword),
      input.name,
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
  patch: Partial<Pick<DbUser, "name" | "photo_url" | "is_active" | "role">>,
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

  const result = await pool.query<DbUser>(
    `UPDATE users
     SET name = COALESCE($2, name),
         photo_url = COALESCE($3, photo_url),
         is_active = COALESCE($4, is_active),
         role = COALESCE($5, role),
         failed_login_attempts = CASE WHEN COALESCE($4, is_active) = TRUE THEN 0 ELSE failed_login_attempts END
     WHERE id = $1
     RETURNING *`,
    [userId, patch.name ?? null, patch.photo_url ?? null, patch.is_active ?? null, patch.role ?? null]
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

  const temporaryPassword = generateTemporaryPassword();
  const result = await pool.query<DbUser>(
    `UPDATE users
     SET password_hash = $2,
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
