import pg from "pg";
import { logger } from "./logger.js";

const { Pool, Client } = pg;

export type DbUser = {
  id: number;
  agency_id: number | null;
  login: string;
  name: string;
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
  is_active: boolean;
  max_active_clients: number;
  created_at: string;
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
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      max_active_clients INTEGER NOT NULL DEFAULT 15 CHECK (max_active_clients BETWEEN 0 AND 15),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      agency_id INTEGER REFERENCES agencies(id) ON DELETE SET NULL,
      login TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
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
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
  `);
};
