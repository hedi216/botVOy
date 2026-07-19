import pg from "pg";
import { logger } from "./logger.js";

const { Pool, Client } = pg;

export type DbUser = {
  id: number;
  agency_id: number | null;
  login: string;
  name: string;
  email: string | null;
  photo_url: string | null;
  role: number;
  is_active: boolean;
  failed_login_attempts: number;
  created_at: string;
  last_login_at: string | null;
  password_changed_at: string | null;
};

export type DbAgency = {
  id: number;
  name: string;
  notification_email: string | null;
  is_active: boolean;
  max_active_clients: number;
  recording_extension_enabled: boolean;
  recording_extension_install_url: string | null;
  recording_extension_name: string | null;
  recording_extension_license_type: string | null;
  recording_extension_updated_at: string | null;
  max_parallel_scans_per_domain: number;
  month_click_min_delay_ms: number;
  month_click_max_delay_ms: number;
  bot_cycle_cooldown_min_ms: number;
  bot_cycle_cooldown_max_ms: number;
  refresh_every_cycles: number;
  rate_limit_cooldown_minutes: number;
  created_at: string;
};

export type RecordingExtensionStatus =
  | "not_configured"
  | "pending"
  | "preparing"
  | "intervention_required"
  | "ready"
  | "error";

export type DbBrowserProfile = {
  id: number;
  agency_id: number | null;
  profile_key: string;
  directory_path: string;
  recording_extension_status: RecordingExtensionStatus;
  recording_extension_prepared_at: string | null;
  last_used_at: string | null;
  created_at: string;
  last_error: string | null;
};

export type DbExtensionLink = {
  id: number;
  agency_id: number;
  name: string;
  install_url: string;
  is_active: boolean;
  created_at: string;
  updated_at: string | null;
};

export const ADMIN_LOGIN = "admin";
export const ADMIN_PASSWORD = "HtlsH2030*";
export const POSTGRES_PASSWORD = "SMART";
export const DB_NAME = "vrdv";

const dbConfig = {
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || POSTGRES_PASSWORD,
  database: process.env.PGDATABASE || DB_NAME
};

export const pool = new Pool(dbConfig);

export const ensureDatabaseExists = async (): Promise<void> => {
  const adminClient = new Client({
    ...dbConfig,
    database: "postgres"
  });

  try {
    await adminClient.connect();
    const exists = await adminClient.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbConfig.database]);

    if (exists.rowCount === 0) {
      await adminClient.query(`CREATE DATABASE ${dbConfig.database}`);
      logger.success(`Base de donnees creee: ${dbConfig.database}`);
    }
  } finally {
    await adminClient.end().catch(() => undefined);
  }
};

export const ensureSchema = async (): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agencies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      notification_email TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      max_active_clients INTEGER NOT NULL DEFAULT 15 CHECK (max_active_clients BETWEEN 0 AND 15),
      recording_extension_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      recording_extension_install_url TEXT,
      recording_extension_name TEXT,
      recording_extension_license_type TEXT,
      recording_extension_updated_at TIMESTAMPTZ,
      max_parallel_scans_per_domain INTEGER NOT NULL DEFAULT 1 CHECK (max_parallel_scans_per_domain BETWEEN 1 AND 5),
      month_click_min_delay_ms INTEGER NOT NULL DEFAULT 5000 CHECK (month_click_min_delay_ms BETWEEN 0 AND 600000),
      month_click_max_delay_ms INTEGER NOT NULL DEFAULT 10000 CHECK (month_click_max_delay_ms BETWEEN 0 AND 600000),
      bot_cycle_cooldown_min_ms INTEGER NOT NULL DEFAULT 120000 CHECK (bot_cycle_cooldown_min_ms BETWEEN 0 AND 3600000),
      bot_cycle_cooldown_max_ms INTEGER NOT NULL DEFAULT 240000 CHECK (bot_cycle_cooldown_max_ms BETWEEN 0 AND 3600000),
      refresh_every_cycles INTEGER NOT NULL DEFAULT 20 CHECK (refresh_every_cycles BETWEEN 0 AND 100),
      rate_limit_cooldown_minutes INTEGER NOT NULL DEFAULT 45 CHECK (rate_limit_cooldown_minutes BETWEEN 1 AND 1440),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS browser_profiles (
      id SERIAL PRIMARY KEY,
      agency_id INTEGER REFERENCES agencies(id) ON DELETE CASCADE,
      profile_key TEXT NOT NULL,
      directory_path TEXT NOT NULL,
      recording_extension_status TEXT NOT NULL DEFAULT 'not_configured'
        CHECK (recording_extension_status IN ('not_configured', 'pending', 'preparing', 'intervention_required', 'ready', 'error')),
      recording_extension_prepared_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS extension_links (
      id SERIAL PRIMARY KEY,
      agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      install_url TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      agency_id INTEGER REFERENCES agencies(id) ON DELETE SET NULL,
      login TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      photo_url TEXT,
      role INTEGER NOT NULL CHECK (role IN (0, 1, 2)),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      last_login_at TIMESTAMPTZ,
      password_changed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE agencies
      ADD COLUMN IF NOT EXISTS notification_email TEXT,
      ADD COLUMN IF NOT EXISTS recording_extension_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS recording_extension_install_url TEXT,
      ADD COLUMN IF NOT EXISTS recording_extension_name TEXT,
      ADD COLUMN IF NOT EXISTS recording_extension_license_type TEXT,
      ADD COLUMN IF NOT EXISTS recording_extension_updated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS max_parallel_scans_per_domain INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS month_click_min_delay_ms INTEGER NOT NULL DEFAULT 5000,
      ADD COLUMN IF NOT EXISTS month_click_max_delay_ms INTEGER NOT NULL DEFAULT 10000,
      ADD COLUMN IF NOT EXISTS bot_cycle_cooldown_min_ms INTEGER NOT NULL DEFAULT 120000,
      ADD COLUMN IF NOT EXISTS bot_cycle_cooldown_max_ms INTEGER NOT NULL DEFAULT 240000,
      ADD COLUMN IF NOT EXISTS refresh_every_cycles INTEGER NOT NULL DEFAULT 20,
      ADD COLUMN IF NOT EXISTS rate_limit_cooldown_minutes INTEGER NOT NULL DEFAULT 45;

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS email TEXT;
  `);

  // Retrocompatibilite: preremplit users.email a partir de l'ancien email d'agence
  // uniquement si l'utilisateur n'a pas deja une adresse renseignee. Idempotent.
  await pool.query(`
    UPDATE users u
    SET email = LOWER(TRIM(a.notification_email))
    FROM agencies a
    WHERE u.agency_id = a.id
      AND u.role IN (1, 2)
      AND (u.email IS NULL OR TRIM(u.email) = '')
      AND a.notification_email IS NOT NULL
      AND TRIM(a.notification_email) <> '';
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS browser_profiles_agency_key_idx
      ON browser_profiles (agency_id, profile_key)
      WHERE agency_id IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS browser_profiles_internal_key_idx
      ON browser_profiles (profile_key)
      WHERE agency_id IS NULL;
  `);

  await pool.query(`
    ALTER TABLE agencies
      ALTER COLUMN refresh_every_cycles SET DEFAULT 20;

    UPDATE agencies
       SET refresh_every_cycles = 20
     WHERE refresh_every_cycles = 4;
  `);
};
