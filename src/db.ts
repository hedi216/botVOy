import pg from "pg";
import { logger } from "./logger.js";
import { requireValidPort } from "./envValidation.js";

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
  // CHANTIER CIBLE (gestion des echeances et impayes): source de verite pour
  // computeAgencyBillingState() (src/agencyBillingService.ts) - jamais un
  // statut stocke (deliberement absent ici), toujours derive dynamiquement de
  // ces 3 champs + de la date du jour (Africa/Tunis). NULL par defaut (donc
  // pour toute agence existante avant cette migration): "not_configured",
  // jamais suspendue par la seule migration.
  next_payment_date: string | null;
  billing_override_until: string | null;
  payment_suspended_at: string | null;
  billing_updated_at: string | null;
};

export type DbAgencyBillingNotification = {
  id: number;
  agency_id: number;
  payment_due_date: string;
  stage: string;
  sent_at: string | null;
  last_error: string | null;
  created_at: string;
};

export type DbAgencyBillingEvent = {
  id: number;
  agency_id: number;
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  created_by_user_id: number | null;
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

// "status" ne reflete que l'etat d'appairage persistant (actif/revoque). L'etat
// temps reel (connecte/hors ligne/version incompatible) se derive a la volee a
// partir du registre en memoire des sockets connectes et de last_seen_at: ce
// n'est jamais une source de verite stockee, pour eviter les incoherences apres
// un redemarrage du serveur.
export type AgentPairingStatus = "active" | "revoked";

export type DbAgent = {
  id: number;
  agency_id: number;
  name: string;
  computer_name: string;
  version: string | null;
  status: AgentPairingStatus;
  token_hash: string;
  paired_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DbAgentPairingCode = {
  id: number;
  agency_id: number;
  created_by: number;
  code_hash: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  attempts: number;
  created_at: string;
};

export type AgentCommandType =
  | "START_BOT"
  | "STOP_BOT"
  | "VALIDATE_BOT"
  | "REFRESH_BOT"
  | "UPDATE_SETTINGS"
  | "REQUEST_STATUS"
  | "SHUTDOWN_BOT";

export type AgentCommandStatus =
  | "pending"
  | "sent"
  | "acknowledged"
  | "completed"
  | "failed"
  | "expired"
  | "cancelled";

export type DbAgentCommand = {
  id: number;
  command_id: string;
  agency_id: number;
  agent_id: number;
  bot_id: string;
  command_type: AgentCommandType;
  public_payload: unknown;
  status: AgentCommandStatus;
  client_request_id: string | null;
  created_by_user_id: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
  sent_at: string | null;
  acknowledged_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  public_result: unknown;
};

export const ADMIN_LOGIN = "admin";
export const ADMIN_PASSWORD = "HtlsH2030*";
export const POSTGRES_PASSWORD = "SMART";
export const DB_NAME = "vrdv";

const dbConfig = {
  host: process.env.PGHOST || "localhost",
  port: requireValidPort("PGPORT", process.env.PGPORT, 5432),
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id SERIAL PRIMARY KEY,
      agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      computer_name TEXT NOT NULL,
      version TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      token_hash TEXT NOT NULL,
      paired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_pairing_codes (
      id SERIAL PRIMARY KEY,
      agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_commands (
      id SERIAL PRIMARY KEY,
      command_id UUID,
      agency_id INTEGER REFERENCES agencies(id) ON DELETE CASCADE,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      bot_id TEXT,
      command_type TEXT NOT NULL CHECK (command_type IN (
        'START_BOT', 'STOP_BOT', 'VALIDATE_BOT', 'REFRESH_BOT',
        'UPDATE_SETTINGS', 'REQUEST_STATUS', 'SHUTDOWN_BOT'
      )),
      public_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'sent', 'acknowledged', 'completed', 'failed', 'expired', 'cancelled'
      )),
      client_request_id TEXT,
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      acknowledged_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      error_code TEXT,
      error_message TEXT,
      public_result JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE INDEX IF NOT EXISTS agents_agency_idx ON agents (agency_id);
    CREATE INDEX IF NOT EXISTS agent_pairing_codes_agency_idx ON agent_pairing_codes (agency_id);
    CREATE INDEX IF NOT EXISTS agent_pairing_codes_lookup_idx
      ON agent_pairing_codes (expires_at)
      WHERE used_at IS NULL AND revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS agent_commands_agent_idx ON agent_commands (agent_id, status);
  `);

  // Migration non destructive pour les bases Phase 1 ou` agent_commands existait
  // deja` sous sa forme initiale (colonnes minimales, table jamais utilisee en
  // pratique: aucune ligne n'a donc jamais ete ecrite, le renommage est sans risque).
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agent_commands' AND column_name = 'payload'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agent_commands' AND column_name = 'public_payload'
      ) THEN
        ALTER TABLE agent_commands RENAME COLUMN payload TO public_payload;
      END IF;
    END $$;

    ALTER TABLE agent_commands
      ADD COLUMN IF NOT EXISTS command_id UUID,
      ADD COLUMN IF NOT EXISTS agency_id INTEGER REFERENCES agencies(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS client_request_id TEXT,
      ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS error_code TEXT,
      ADD COLUMN IF NOT EXISTS public_result JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS public_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

    ALTER TABLE agent_commands DROP CONSTRAINT IF EXISTS agent_commands_status_check;
    ALTER TABLE agent_commands ADD CONSTRAINT agent_commands_status_check
      CHECK (status IN ('pending', 'sent', 'acknowledged', 'completed', 'failed', 'expired', 'cancelled'));

    CREATE UNIQUE INDEX IF NOT EXISTS agent_commands_command_id_idx
      ON agent_commands (command_id) WHERE command_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS agent_commands_client_request_id_idx
      ON agent_commands (client_request_id) WHERE client_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS agent_commands_agency_created_idx
      ON agent_commands (agency_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS agent_commands_bot_created_idx
      ON agent_commands (bot_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS agent_commands_expiry_sweep_idx
      ON agent_commands (expires_at)
      WHERE status IN ('pending', 'sent', 'acknowledged');
  `);

  // CHANTIER CIBLE (gestion des echeances et impayes des agences): idempotent
  // comme toutes les migrations ci-dessus - toute agence existante recoit
  // next_payment_date=NULL (via le DEFAULT implicite d'une colonne nullable
  // sans DEFAULT), donc "not_configured"/accessAllowed=true immediatement
  // apres deploiement, jamais suspendue par la seule migration. Aucun
  // billing_status stocke (deliberement absent): toujours derive par
  // computeAgencyBillingState() a partir de ces 3 champs + la date du jour.
  await pool.query(`
    ALTER TABLE agencies
      ADD COLUMN IF NOT EXISTS next_payment_date DATE,
      ADD COLUMN IF NOT EXISTS billing_override_until TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS payment_suspended_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS billing_updated_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS agency_billing_notifications (
      id SERIAL PRIMARY KEY,
      agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      payment_due_date DATE NOT NULL,
      stage TEXT NOT NULL CHECK (stage IN (
        'D_MINUS_7', 'D_MINUS_2', 'DUE_TODAY',
        'OVERDUE_1', 'OVERDUE_2', 'OVERDUE_3', 'OVERDUE_4', 'OVERDUE_5', 'OVERDUE_6',
        'SUSPENDED'
      )),
      sent_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT agency_billing_notifications_unique UNIQUE (agency_id, payment_due_date, stage)
    );

    CREATE TABLE IF NOT EXISTS agency_billing_events (
      id SERIAL PRIMARY KEY,
      agency_id INTEGER NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (event_type IN (
        'PAYMENT_DATE_CHANGED', 'OVERRIDE_GRANTED', 'OVERRIDE_REMOVED', 'SUSPENDED', 'ACCESS_RESTORED'
      )),
      old_value TEXT,
      new_value TEXT,
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS agency_billing_notifications_agency_idx
      ON agency_billing_notifications (agency_id, payment_due_date);
    CREATE INDEX IF NOT EXISTS agency_billing_events_agency_idx
      ON agency_billing_events (agency_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS agencies_next_payment_date_idx
      ON agencies (next_payment_date)
      WHERE next_payment_date IS NOT NULL;
  `);
};
