import { randomUUID } from "node:crypto";
import { Socket } from "socket.io";
import { AgentCommandConfig } from "./config.js";
import { AgentCommandStatus, AgentCommandType, DbAgentCommand, pool } from "./db.js";
import { logger } from "./logger.js";

// Une erreur ici (DB, ou callback onChange fourni par l'appelant) ne doit
// jamais devenir une rejection non geree: elle arreterait tout le process
// serveur pour un simple minuteur d'accuse de reception d'UNE commande.
const logAsyncError = (context: string) => (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`agentCommandService (${context}): ${message}`);
};

// -------- DTO public (jamais de public_payload/public_result dans la
// diffusion temps reel: cf. section 12 du cahier des charges, l'exemple ne
// contient que des champs de suivi, pas de charge utile) --------

export type PublicAgentCommand = {
  commandId: string;
  botId: string;
  botName: string | null;
  agentId: number;
  type: AgentCommandType;
  status: string;
  botStatus: string | null;
  errorCode: string | null;
  message: string | null;
  createdAt: string;
  updatedAt: string;
};

// DTO plus complet pour les endpoints de consultation (section 17): ces
// champs sont deja qualifies "publics" par construction (public_payload/
// public_result n'ont jamais le droit de contenir un secret, cf. section 5).
export type PublicAgentCommandDetail = PublicAgentCommand & {
  publicPayload: unknown;
  publicResult: unknown;
  expiresAt: string | null;
  sentAt: string | null;
  acknowledgedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
};

const toPublicStatus = (status: AgentCommandStatus): string => status.toUpperCase();

// Consulte lui-meme le registre en memoire des bots (getAgentBot) plutot que
// d'exiger de chaque appelant qu'il le fasse et transmette botStatus/botName:
// ce registre est deja tenu a jour par ce meme module (registerAgentBot/
// updateAgentBotStatus), inutile de dupliquer cette lecture partout.
export const toPublicAgentCommand = (row: DbAgentCommand): PublicAgentCommand => {
  const bot = getAgentBot(row.bot_id);
  return {
    commandId: row.command_id,
    botId: row.bot_id,
    botName: bot?.botName ?? null,
    agentId: row.agent_id,
    type: row.command_type,
    status: toPublicStatus(row.status),
    botStatus: bot?.botStatus ?? null,
    errorCode: row.error_code,
    message: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

export const toPublicAgentCommandDetail = (row: DbAgentCommand): PublicAgentCommandDetail => ({
  ...toPublicAgentCommand(row),
  publicPayload: row.public_payload,
  publicResult: row.public_result,
  expiresAt: row.expires_at,
  sentAt: row.sent_at,
  acknowledgedAt: row.acknowledged_at,
  completedAt: row.completed_at,
  failedAt: row.failed_at
});

// -------- Statuts de bot remontes par l'agent (whitelist stricte) --------

export const BOT_STATUS_VALUES = [
  "COMMAND_SENT",
  "STARTING",
  "WAITING_FOR_USER",
  "MONITORING",
  "RATE_LIMITED",
  "SLOT_DETECTED",
  "STOPPING",
  "STOPPED",
  "ERROR"
] as const;

export type BotStatusValue = typeof BOT_STATUS_VALUES[number];

export const isValidBotStatus = (value: unknown): value is BotStatusValue =>
  typeof value === "string" && (BOT_STATUS_VALUES as readonly string[]).includes(value);

// -------- Registre en memoire des bots pilotes par un agent (pas de table
// "bots": un bot Phase 3+ n'est qu'un botId genere au dispatch, associe a
// l'agent qui l'execute. Meme principe que les sessions legacy_vm existantes
// (server.ts, Map en memoire), perdu au redemarrage sans regression par
// rapport a l'existant. --------

export type AgentBotRecord = {
  botId: string;
  agentId: number;
  agencyId: number;
  ownerUserId: number;
  botName: string;
  category: string;
  latestCommandId: string;
  botStatus: BotStatusValue | null;
  updatedAt: string;
};

const agentBots = new Map<string, AgentBotRecord>();

export const generateBotId = (): string => `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const registerAgentBot = (record: AgentBotRecord): void => {
  agentBots.set(record.botId, record);
};

export const getAgentBot = (botId: string): AgentBotRecord | undefined => agentBots.get(botId);

export const listAgentBotsForAgency = (agencyId: number): AgentBotRecord[] =>
  [...agentBots.values()].filter((bot) => bot.agencyId === agencyId);

export const updateAgentBotStatus = (botId: string, status: BotStatusValue): AgentBotRecord | undefined => {
  const bot = agentBots.get(botId);
  if (!bot) {
    return undefined;
  }
  bot.botStatus = status;
  bot.updatedAt = new Date().toISOString();
  return bot;
};

export const removeAgentBot = (botId: string): void => {
  agentBots.delete(botId);
};

// -------- Lecture/ecriture DB (chaque mutation est ecrite pour etre
// idempotente via une clause WHERE conditionnee sur le statut courant plutot
// que de faire confiance a l'appelant: un doublon ne modifie alors 0 ligne au
// lieu de provoquer une transition invalide. --------

export const getCommandForAgent = async (commandId: string, agentId: number): Promise<DbAgentCommand | null> => {
  const result = await pool.query<DbAgentCommand>(
    "SELECT * FROM agent_commands WHERE command_id = $1 AND agent_id = $2",
    [commandId, agentId]
  );
  return result.rows[0] ?? null;
};

export const getCommandForAgency = async (agencyId: number, commandId: string): Promise<DbAgentCommand | null> => {
  const result = await pool.query<DbAgentCommand>(
    "SELECT * FROM agent_commands WHERE command_id = $1 AND agency_id = $2",
    [commandId, agencyId]
  );
  return result.rows[0] ?? null;
};

export type ListAgentCommandsFilters = {
  agentId?: number;
  botId?: string;
  status?: AgentCommandStatus;
  commandType?: AgentCommandType;
  limit?: number;
  offset?: number;
};

export const listAgentCommandsForAgency = async (
  agencyId: number,
  filters: ListAgentCommandsFilters
): Promise<DbAgentCommand[]> => {
  const conditions: string[] = ["agency_id = $1"];
  const values: unknown[] = [agencyId];

  if (filters.agentId) {
    values.push(filters.agentId);
    conditions.push(`agent_id = $${values.length}`);
  }
  if (filters.botId) {
    values.push(filters.botId);
    conditions.push(`bot_id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.commandType) {
    values.push(filters.commandType);
    conditions.push(`command_type = $${values.length}`);
  }

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  values.push(limit, offset);

  const result = await pool.query<DbAgentCommand>(
    `SELECT * FROM agent_commands
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  return result.rows;
};

export type CreatePendingCommandParams = {
  agencyId: number;
  agentId: number;
  botId: string;
  type: AgentCommandType;
  publicPayload: unknown;
  createdByUserId: number;
  clientRequestId?: string | null;
  ttlMs: number;
};

export const createPendingCommand = async (
  params: CreatePendingCommandParams
): Promise<{ command: DbAgentCommand; alreadyExisted: boolean }> => {
  const commandId = randomUUID();
  const expiresAt = new Date(Date.now() + params.ttlMs).toISOString();
  const payloadJson = JSON.stringify(params.publicPayload ?? {});

  if (params.clientRequestId) {
    const inserted = await pool.query<DbAgentCommand>(
      `INSERT INTO agent_commands
         (command_id, agency_id, agent_id, bot_id, command_type, public_payload, status, client_request_id, created_by_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)
       ON CONFLICT (client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [commandId, params.agencyId, params.agentId, params.botId, params.type, payloadJson, params.clientRequestId, params.createdByUserId, expiresAt]
    );

    if (inserted.rows[0]) {
      return { command: inserted.rows[0], alreadyExisted: false };
    }

    // Deja insere par une requete precedente avec le meme clientRequestId
    // (double-clic, retry reseau...): on renvoie la commande existante,
    // jamais une seconde commande ni une seconde reservation.
    const existing = await pool.query<DbAgentCommand>(
      "SELECT * FROM agent_commands WHERE client_request_id = $1",
      [params.clientRequestId]
    );
    if (!existing.rows[0]) {
      throw new Error("Conflit d'idempotence sans commande retrouvee.");
    }
    return { command: existing.rows[0], alreadyExisted: true };
  }

  const inserted = await pool.query<DbAgentCommand>(
    `INSERT INTO agent_commands
       (command_id, agency_id, agent_id, bot_id, command_type, public_payload, status, created_by_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
     RETURNING *`,
    [commandId, params.agencyId, params.agentId, params.botId, params.type, payloadJson, params.createdByUserId, expiresAt]
  );
  return { command: inserted.rows[0], alreadyExisted: false };
};

export const markSent = async (commandId: string): Promise<DbAgentCommand | null> => {
  const result = await pool.query<DbAgentCommand>(
    `UPDATE agent_commands SET status = 'sent', sent_at = NOW(), updated_at = NOW()
     WHERE command_id = $1 AND status = 'pending'
     RETURNING *`,
    [commandId]
  );
  return result.rows[0] ?? null;
};

export type MutationResult = { command: DbAgentCommand | null; duplicate: boolean };

export const markAcknowledged = async (commandId: string, agentId: number): Promise<MutationResult> => {
  const result = await pool.query<DbAgentCommand>(
    `UPDATE agent_commands SET status = 'acknowledged', acknowledged_at = NOW(), updated_at = NOW()
     WHERE command_id = $1 AND agent_id = $2 AND status = 'sent'
     RETURNING *`,
    [commandId, agentId]
  );
  if (result.rows[0]) {
    return { command: result.rows[0], duplicate: false };
  }
  const existing = await getCommandForAgent(commandId, agentId);
  return { command: existing, duplicate: Boolean(existing) };
};

export const markCompleted = async (
  commandId: string,
  agentId: number,
  publicResult: unknown
): Promise<MutationResult> => {
  const result = await pool.query<DbAgentCommand>(
    `UPDATE agent_commands SET status = 'completed', completed_at = NOW(), updated_at = NOW(), public_result = $3
     WHERE command_id = $1 AND agent_id = $2 AND status = 'acknowledged'
     RETURNING *`,
    [commandId, agentId, JSON.stringify(publicResult ?? {})]
  );
  if (result.rows[0]) {
    return { command: result.rows[0], duplicate: false };
  }
  const existing = await getCommandForAgent(commandId, agentId);
  return { command: existing, duplicate: Boolean(existing) };
};

const MAX_ERROR_MESSAGE_LENGTH = 500;

export const markFailedByAgent = async (
  commandId: string,
  agentId: number,
  errorCode: string,
  errorMessage: string
): Promise<MutationResult> => {
  const result = await pool.query<DbAgentCommand>(
    `UPDATE agent_commands SET status = 'failed', failed_at = NOW(), updated_at = NOW(), error_code = $3, error_message = $4
     WHERE command_id = $1 AND agent_id = $2 AND status IN ('pending', 'sent', 'acknowledged')
     RETURNING *`,
    [commandId, agentId, errorCode.slice(0, 64), errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH)]
  );
  if (result.rows[0]) {
    return { command: result.rows[0], duplicate: false };
  }
  const existing = await getCommandForAgent(commandId, agentId);
  return { command: existing, duplicate: Boolean(existing) };
};

// Echecs d'origine serveur (jamais declenches par un payload d'agent): la
// clause WHERE status=... exacte agit comme garde-fou contre toute course
// avec un ACK/resultat arrivant entre-temps.

const failFromStatus = async (
  commandId: string,
  fromStatus: AgentCommandStatus,
  errorCode: string,
  errorMessage: string
): Promise<DbAgentCommand | null> => {
  const result = await pool.query<DbAgentCommand>(
    `UPDATE agent_commands SET status = 'failed', failed_at = NOW(), updated_at = NOW(), error_code = $3, error_message = $4
     WHERE command_id = $1 AND status = $2
     RETURNING *`,
    [commandId, fromStatus, errorCode, errorMessage]
  );
  return result.rows[0] ?? null;
};

export const failPendingDispatchError = (commandId: string, errorCode: string, errorMessage: string): Promise<DbAgentCommand | null> =>
  failFromStatus(commandId, "pending", errorCode, errorMessage);

export const failAckTimeout = (commandId: string): Promise<DbAgentCommand | null> =>
  failFromStatus(commandId, "sent", "AGENT_ACK_TIMEOUT", "Aucun accuse de reception recu dans le delai imparti.");

export const expireOverdueCommands = async (): Promise<DbAgentCommand[]> => {
  const result = await pool.query<DbAgentCommand>(
    `UPDATE agent_commands SET status = 'expired', updated_at = NOW()
     WHERE status IN ('pending', 'sent', 'acknowledged') AND expires_at IS NOT NULL AND expires_at < NOW()
     RETURNING *`
  );
  return result.rows;
};

// Filet de securite pour un redemarrage serveur: les minuteurs en memoire de
// l'ancien process ont disparu, donc une commande "sent" trop ancienne ne
// serait plus jamais resolue sans ce balayage base sur sent_at en base.
export const failOverdueAcksInDb = async (ackTimeoutMs: number): Promise<DbAgentCommand[]> => {
  const result = await pool.query<DbAgentCommand>(
    `UPDATE agent_commands SET status = 'failed', failed_at = NOW(), updated_at = NOW(),
            error_code = 'AGENT_ACK_TIMEOUT', error_message = 'Aucun accuse de reception recu dans le delai imparti.'
     WHERE status = 'sent' AND sent_at IS NOT NULL AND sent_at < NOW() - ($1 || ' milliseconds')::interval
     RETURNING *`,
    [ackTimeoutMs]
  );
  return result.rows;
};

export const failNonTerminalOnDisconnect = async (agentId: number): Promise<DbAgentCommand[]> => {
  const beforeAck = await pool.query<DbAgentCommand>(
    `UPDATE agent_commands SET status = 'failed', failed_at = NOW(), updated_at = NOW(),
            error_code = 'AGENT_DISCONNECTED', error_message = 'Agent deconnecte avant accuse de reception.'
     WHERE agent_id = $1 AND status IN ('pending', 'sent')
     RETURNING *`,
    [agentId]
  );
  const afterAck = await pool.query<DbAgentCommand>(
    `UPDATE agent_commands SET status = 'failed', failed_at = NOW(), updated_at = NOW(),
            error_code = 'AGENT_DISCONNECTED_AFTER_ACK', error_message = 'Agent deconnecte apres accuse de reception, avant confirmation finale.'
     WHERE agent_id = $1 AND status = 'acknowledged'
     RETURNING *`,
    [agentId]
  );
  return [...beforeAck.rows, ...afterAck.rows];
};

export const failNonTerminalOnRevoke = async (agentId: number): Promise<DbAgentCommand[]> => {
  const result = await pool.query<DbAgentCommand>(
    `UPDATE agent_commands SET status = 'failed', failed_at = NOW(), updated_at = NOW(),
            error_code = 'AGENT_REVOKED', error_message = 'Agent revoque.'
     WHERE agent_id = $1 AND status IN ('pending', 'sent', 'acknowledged')
     RETURNING *`,
    [agentId]
  );
  return result.rows;
};

// -------- Dispatch (creation + envoi + minuterie d'accuse de reception) --------

const ackTimers = new Map<string, NodeJS.Timeout>();

export const clearAckTimer = (commandId: string): void => {
  const existing = ackTimers.get(commandId);
  if (existing) {
    clearTimeout(existing);
    ackTimers.delete(commandId);
  }
};

export type DispatchDeps = {
  config: AgentCommandConfig;
  getAgentSocket: (agentId: number) => Socket | undefined;
  onChange: (command: DbAgentCommand) => void;
};

const scheduleAckTimeout = (commandId: string, deps: DispatchDeps): void => {
  clearAckTimer(commandId);
  const timer = setTimeout(() => {
    ackTimers.delete(commandId);
    failAckTimeout(commandId).then((failed) => {
      if (failed) {
        deps.onChange(failed);
      }
    }).catch(logAsyncError("ack-timeout"));
  }, deps.config.ackTimeoutMs);
  ackTimers.set(commandId, timer);
};

export type DispatchAgentCommandParams = {
  agencyId: number;
  agentId: number;
  botId: string;
  type: AgentCommandType;
  publicPayload: unknown;
  createdByUserId: number;
  clientRequestId?: string | null;
};

// Point d'entree unique pour emettre une commande vers un agent: valide,
// persiste AVANT emission, emet AGENT_COMMAND, marque SENT, arme le
// minuteur d'accuse de reception. L'agent doit deja avoir ete valide comme
// connecte/compatible/autorise par l'appelant (server.ts) avant d'appeler ceci.
export const dispatchAgentCommand = async (
  params: DispatchAgentCommandParams,
  deps: DispatchDeps
): Promise<{ command: DbAgentCommand; alreadyExisted: boolean }> => {
  const { command, alreadyExisted } = await createPendingCommand({ ...params, ttlMs: deps.config.ttlMs });
  deps.onChange(command);

  if (alreadyExisted) {
    return { command, alreadyExisted };
  }

  const socket = deps.getAgentSocket(params.agentId);
  if (!socket) {
    const failed = await failPendingDispatchError(command.command_id, "AGENT_DISCONNECTED", "Agent deconnecte avant l'envoi de la commande.");
    if (failed) {
      deps.onChange(failed);
    }
    return { command: failed ?? command, alreadyExisted };
  }

  // Marquer "sent" en base AVANT d'emettre, jamais apres: un agent tres
  // reactif (latence quasi nulle, ex. sur la meme machine) peut repondre
  // COMMAND_ACK plus vite que cette ecriture DB si elle survient apres
  // l'emission. Un ACK recu pendant que la ligne est encore "pending" ne
  // correspond a aucune transition valide (markAcknowledged exige
  // status='sent') et serait perdu silencieusement jusqu'a l'expiration du
  // delai d'accuse de reception.
  const sent = await markSent(command.command_id);
  if (!sent) {
    return { command, alreadyExisted };
  }

  deps.onChange(sent);
  scheduleAckTimeout(sent.command_id, deps);

  socket.emit("AGENT_COMMAND", {
    commandId: sent.command_id,
    type: sent.command_type,
    agentId: sent.agent_id,
    botId: sent.bot_id,
    createdAt: sent.created_at,
    expiresAt: sent.expires_at,
    payload: sent.public_payload
  });

  return { command: sent, alreadyExisted };
};

// Balayage periodique: expiration TTL + filet de securite ack-timeout au cas
// ou le process aurait redemarre (minuteurs en memoire perdus).
export const sweepAgentCommands = async (
  config: AgentCommandConfig,
  onChange: (command: DbAgentCommand) => void
): Promise<void> => {
  const [overdueAcks, expired] = await Promise.all([
    failOverdueAcksInDb(config.ackTimeoutMs),
    expireOverdueCommands()
  ]);

  for (const command of overdueAcks) {
    clearAckTimer(command.command_id);
    onChange(command);
  }
  for (const command of expired) {
    clearAckTimer(command.command_id);
    onChange(command);
  }
};
