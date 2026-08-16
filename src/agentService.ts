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
  // Lot 5 (section 9): distinct de status==="CONNECTED" - vrai seulement
  // apres reconciliation (AGENT_RUNTIME_STATUS traite). Permet a
  // l'interface d'afficher brievement "synchronisation en cours".
  readyForCommands: boolean;
  // Lot 5 (section 14): inventaire public rapporte par AGENT_EXTENSION_STATUS
  // - jamais de chemin local (garanti par agentExtensionConfig.ts cote agent).
  extensions: PublicAgentExtension[];
};

export type PublicAgentExtension = {
  id: string;
  configured: boolean;
  valid: boolean;
  version: string | null;
};

export const toPublicAgent = (
  agent: DbAgent,
  liveStatus: AgentLiveStatus,
  activeBotCount = 0,
  readyForCommands = false,
  extensions: PublicAgentExtension[] = []
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
  revokedAt: agent.revoked_at,
  readyForCommands: liveStatus === "CONNECTED" && readyForCommands,
  extensions
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

// Phase 5 (Lot 2 - correctif protocole, puis correctif de securite
// complementaire): resultat structure remplacant l'ancien DbAgent|null
// ambigu. Cause exacte du premier defaut trouve par l'audit : agent
// inexistant, token errone, ET agent revoque produisaient tous les trois
// EXACTEMENT le meme resultat (null), donc la meme reponse INVALID_TOKEN
// cote protocole - un agent reellement revoque ne pouvait jamais
// l'apprendre.
//
// Defaut complementaire trouve APRES ce premier correctif : verifier le
// statut "revoked" AVANT la comparaison du token permettait a un client ne
// connaissant PAS le vrai token de distinguer un agentId revoque (toujours
// AGENT_REVOKED, quel que soit le token presente) d'un agentId inexistant ou
// actif (INVALID_TOKEN) - une enumeration d'agentId sans jamais avoir besoin
// du token reel. Corrige en deplacant la verification du token AVANT le
// controle de revocation : AGENT_REVOKED n'est desormais renvoye QUE si le
// token presente est reellement celui de cet agent. Le hash n'est jamais
// efface a la revocation (revokeAgent() ne touche que status/revoked_at,
// voir plus bas) - necessaire pour effectuer cette comparaison meme apres
// revocation. Jamais de journalisation du token ni de son hash ici.
export type AgentAuthenticationResult =
  | { ok: true; agent: DbAgent }
  | { ok: false; reason: "INVALID_TOKEN" }
  | { ok: false; reason: "AGENT_REVOKED" };

export const authenticateAgent = async (agentId: number, token: string): Promise<AgentAuthenticationResult> => {
  const agent = await getAgentById(agentId);
  if (!agent) {
    // Jamais reveler si cet agentId existe reellement : un agentId inconnu
    // et un token errone pour un agent existant partagent EXACTEMENT la
    // meme reponse publique.
    return { ok: false, reason: "INVALID_TOKEN" };
  }

  // Comparaison sure (bcrypt, temps constant par construction) AVANT tout
  // controle de statut : un token errone ne doit jamais reveler si l'agent
  // cible est actif, revoque, ou distinguer quoi que ce soit d'un agentId
  // inexistant - toujours INVALID_TOKEN dans ces trois cas.
  const matches = await verifyPassword(token, agent.token_hash);
  if (!matches) {
    return { ok: false, reason: "INVALID_TOKEN" };
  }

  // A partir d'ici, le token presente est PROUVE etre le veritable token de
  // cet agent : reveler AGENT_REVOKED est desormais sans risque
  // d'enumeration (le client possede deja la preuve que cet agentId existe
  // et lui appartient).
  if (agent.status === "revoked") {
    return { ok: false, reason: "AGENT_REVOKED" };
  }

  return { ok: true, agent };
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

// CHANTIER CIBLE (suppression visuelle des Agents revoques): exclut
// desormais les Agents archives (archived_at IS NOT NULL) - source UNIQUE
// des listes normales (page Agents, selectAgentForCommand) et donc de tout
// ce qui en depend (un Agent archive ne peut plus jamais etre propose/
// selectionne pour une nouvelle commande, ni affiche). Ne filtre PAS
// getAgentById() (utilise par l'authentification et l'historique, qui
// doivent toujours pouvoir resoudre un ancien agentId).
export const listAgentsForAgency = async (agencyId: number): Promise<DbAgent[]> => {
  const result = await pool.query<DbAgent>(
    "SELECT * FROM agents WHERE agency_id = $1 AND archived_at IS NULL ORDER BY id",
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

// CHANTIER CIBLE (suppression visuelle des Agents revoques): SOFT-DELETE
// uniquement (archived_at), jamais un DELETE physique - agent_commands.agent_id
// REFERENCES agents(id) ON DELETE CASCADE supprimerait sinon tout
// l'historique de commandes de cet agent, ce que ce chantier doit
// explicitement preserver. Un Agent DOIT deja etre status='revoked' avant
// d'etre archivable (jamais un raccourci "archive == revoke implicite": les
// deux actions ont des intentions distinctes, cf. route DELETE /api/agents/:id
// dans server.ts qui verifie separement l'absence de bot encore actif).
export type ArchiveAgentResult =
  | { ok: true; agent: DbAgent }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "NOT_REVOKED" };

export const archiveAgent = async (agencyId: number, agentId: number): Promise<ArchiveAgentResult> => {
  // Idempotence (double-clic/requete rejouee): un Agent deja archive n'est
  // jamais une erreur - meme convention que revokeAgent (deja idempotent en
  // succes), jamais une exception SQL brute ni une restauration implicite.
  const result = await pool.query<DbAgent>(
    `UPDATE agents
     SET archived_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND agency_id = $2 AND status = 'revoked' AND archived_at IS NULL
     RETURNING *`,
    [agentId, agencyId]
  );

  if (result.rows[0]) {
    return { ok: true, agent: result.rows[0] };
  }

  // La clause WHERE ci-dessus n'a rien modifie: distingue "introuvable pour
  // cette agence" (id/agencyId invalide) de "pas encore revoque" ou "deja
  // archive" (idempotent) via une lecture separee - jamais de distinction
  // entre "n'existe pas" et "appartient a une autre agence" (meme principe
  // que renameAgent/revokeAgent, aucune enumeration d'agentId possible).
  const existing = await pool.query<DbAgent>(
    "SELECT * FROM agents WHERE id = $1 AND agency_id = $2",
    [agentId, agencyId]
  );
  const agent = existing.rows[0];
  if (!agent) {
    return { ok: false, reason: "NOT_FOUND" };
  }
  if (agent.archived_at) {
    return { ok: true, agent };
  }
  return { ok: false, reason: "NOT_REVOKED" };
};
