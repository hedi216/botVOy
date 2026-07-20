import { randomBytes } from "node:crypto";
import { AgentGatewayConfig } from "./config.js";
import { DbAgent, DbAgentPairingCode, pool } from "./db.js";
import { hashPassword, verifyPassword } from "./password.js";

export type AgentLiveStatus =
  | "CONNECTED"
  | "OFFLINE"
  | "VERSION_INCOMPATIBLE"
  | "REVOKED";

// Liste blanche stricte: seule fonction autorisee a transformer une ligne
// agents (qui contient token_hash) en objet exposable au frontend ou a un
// evenement socket cote interface web. Toute nouvelle sortie publique doit
// passer par ici plutot que de spreader/retourner un DbAgent directement.
export type PublicAgent = {
  agentId: number;
  agencyId: number;
  name: string;
  computerName: string;
  version: string | null;
  status: AgentLiveStatus;
  pairedAt: string;
  lastSeenAt: string | null;
  activeBotCount: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};

export const toPublicAgent = (
  agent: DbAgent,
  liveStatus: AgentLiveStatus,
  activeBotCount = 0
): PublicAgent => ({
  agentId: agent.id,
  agencyId: agent.agency_id,
  name: agent.name,
  computerName: agent.computer_name,
  version: agent.version,
  status: liveStatus,
  pairedAt: agent.paired_at,
  lastSeenAt: agent.last_seen_at,
  activeBotCount: Math.max(0, Math.trunc(activeBotCount)),
  createdAt: agent.created_at,
  updatedAt: agent.updated_at,
  revokedAt: agent.revoked_at
});

// Alphabet sans caracteres ambigus (pas de 0/O, 1/I/L) pour que le code reste
// lisible et saisissable a la main sans confusion.
const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const generateReadableCode = (): string => {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((byte) => PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}`;
};

const generateAgentToken = (): string => randomBytes(32).toString("base64url");

export type PairingCodeResult = {
  code: string;
  expiresAt: string;
};

export const createPairingCode = async (
  agencyId: number,
  createdByUserId: number,
  config: AgentGatewayConfig
): Promise<PairingCodeResult> => {
  const code = generateReadableCode();
  const codeHash = await hashPassword(code);
  const expiresAt = new Date(Date.now() + config.pairingCodeTtlMinutes * 60_000);

  await pool.query(
    `INSERT INTO agent_pairing_codes (agency_id, created_by, code_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [agencyId, createdByUserId, codeHash, expiresAt.toISOString()]
  );

  return { code, expiresAt: expiresAt.toISOString() };
};

export type PairingFailureReason = "INVALID_OR_EXPIRED" | "TOO_MANY_ATTEMPTS";

export type PairingSuccess = {
  ok: true;
  agentId: number;
  agencyId: number;
  token: string;
};

export type PairingFailure = {
  ok: false;
  reason: PairingFailureReason;
};

// Les codes actifs sont peu nombreux a tout instant (courte duree de vie, usage
// unique) : on peut se permettre de les comparer un par un via un hash a sel plutot
// que d'indexer le code en clair, ce qui evite de stocker une version reversible.
export const redeemPairingCode = async (
  code: string,
  computerName: string,
  agentVersion: string,
  config: AgentGatewayConfig
): Promise<PairingSuccess | PairingFailure> => {
  const candidates = await pool.query<DbAgentPairingCode>(
    `SELECT * FROM agent_pairing_codes
     WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC`
  );

  for (const candidate of candidates.rows) {
    if (candidate.attempts >= config.pairingMaxAttemptsPerCode) {
      continue;
    }

    const matches = await verifyPassword(code, candidate.code_hash);
    if (!matches) {
      continue;
    }

    const claimed = await pool.query<DbAgentPairingCode>(
      `UPDATE agent_pairing_codes
       SET used_at = NOW()
       WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL
       RETURNING *`,
      [candidate.id]
    );

    if (claimed.rowCount === 0) {
      // Deja consomme par une requete concurrente entre le SELECT et l'UPDATE.
      return { ok: false, reason: "INVALID_OR_EXPIRED" };
    }

    const token = generateAgentToken();
    const tokenHash = await hashPassword(token);
    const agent = await pool.query<DbAgent>(
      `INSERT INTO agents (agency_id, name, computer_name, version, status, token_hash, last_seen_at)
       VALUES ($1, $2, $3, $4, 'active', $5, NOW())
       RETURNING *`,
      [candidate.agency_id, computerName, computerName, agentVersion, tokenHash]
    );

    return { ok: true, agentId: agent.rows[0].id, agencyId: candidate.agency_id, token };
  }

  // Aucun hash ne correspond : on incremente la tentative de tous les codes
  // encore valides pour freiner le brute-force sans reveler lequel etait proche.
  await pool.query(
    `UPDATE agent_pairing_codes
     SET attempts = attempts + 1
     WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`
  );

  const anyAttemptsLeft = candidates.rows.some((candidate) => candidate.attempts < config.pairingMaxAttemptsPerCode);
  return { ok: false, reason: anyAttemptsLeft ? "INVALID_OR_EXPIRED" : "TOO_MANY_ATTEMPTS" };
};

export const getAgentById = async (agentId: number): Promise<DbAgent | null> => {
  const result = await pool.query<DbAgent>("SELECT * FROM agents WHERE id = $1", [agentId]);
  return result.rows[0] ?? null;
};

export const verifyAgentToken = async (agentId: number, token: string): Promise<DbAgent | null> => {
  const agent = await getAgentById(agentId);
  if (!agent || agent.status === "revoked") {
    return null;
  }

  const matches = await verifyPassword(token, agent.token_hash);
  return matches ? agent : null;
};

export const touchAgentSeen = async (agentId: number, version?: string): Promise<void> => {
  await pool.query(
    `UPDATE agents
     SET last_seen_at = NOW(),
         version = COALESCE($2, version),
         updated_at = NOW()
     WHERE id = $1`,
    [agentId, version ?? null]
  );
};

const isVersionAtLeast = (version: string, minVersion: string): boolean => {
  const toParts = (value: string): number[] => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const versionParts = toParts(version);
  const minParts = toParts(minVersion);
  const length = Math.max(versionParts.length, minParts.length);

  for (let index = 0; index < length; index += 1) {
    const current = versionParts[index] ?? 0;
    const minimum = minParts[index] ?? 0;
    if (current !== minimum) {
      return current > minimum;
    }
  }

  return true;
};

export const computeLiveStatus = (
  agent: DbAgent,
  isSocketConnected: boolean,
  config: AgentGatewayConfig
): AgentLiveStatus => {
  if (agent.status === "revoked") {
    return "REVOKED";
  }

  if (!isSocketConnected) {
    return "OFFLINE";
  }

  if (agent.last_seen_at) {
    const elapsedMs = Date.now() - new Date(agent.last_seen_at).getTime();
    if (elapsedMs > config.offlineTimeoutMs) {
      return "OFFLINE";
    }
  }

  if (agent.version && !isVersionAtLeast(agent.version, config.minAgentVersion)) {
    return "VERSION_INCOMPATIBLE";
  }

  return "CONNECTED";
};

export const listAgentsForAgency = async (agencyId: number): Promise<DbAgent[]> => {
  const result = await pool.query<DbAgent>(
    "SELECT * FROM agents WHERE agency_id = $1 ORDER BY id",
    [agencyId]
  );
  return result.rows;
};

export const renameAgent = async (agencyId: number, agentId: number, name: string): Promise<DbAgent> => {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Le nom de l'ordinateur ne peut pas etre vide.");
  }

  const result = await pool.query<DbAgent>(
    `UPDATE agents SET name = $3, updated_at = NOW()
     WHERE id = $1 AND agency_id = $2
     RETURNING *`,
    [agentId, agencyId, trimmed.slice(0, 160)]
  );

  if (result.rowCount === 0) {
    throw new Error("Agent introuvable pour cette agence.");
  }

  return result.rows[0];
};

export const revokeAgent = async (agencyId: number, agentId: number): Promise<DbAgent> => {
  const result = await pool.query<DbAgent>(
    `UPDATE agents
     SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND agency_id = $2
     RETURNING *`,
    [agentId, agencyId]
  );

  if (result.rowCount === 0) {
    throw new Error("Agent introuvable pour cette agence.");
  }

  return result.rows[0];
};
