import { randomUUID } from "node:crypto";

// Lot 5 (Phase 4, section 4): buffer local borne des evenements runtime
// (BOT_STATUS uniquement - jamais ACK/COMPLETED/FAILED, deja geres par le
// TTL/disconnect existant cote serveur, cf. section 4 "ne pas mettre dans
// le buffer: commandes serveur"). Module pur, sans dependance socket, pour
// rester testable unitairement sans Chrome ni serveur.

export type BufferedEventPriority = "high" | "normal";

export type BufferedEventEnvelope = {
  eventId: string;
  type: string;
  botId: string;
  timestamp: string;
  payload: unknown;
};

export type OfflineBufferEventInput = {
  type: string;
  botId: string;
  payload: unknown;
  // Signature optionnelle pour la deduplication (ex: SLOT_DETECTED avec la
  // meme signature de creneau): sans elle, seule la coalescence par
  // (botId, type) adjacente s'applique.
  dedupKey?: string;
};

// Jamais sacrifies en premier quand le buffer est plein (section 4: "ne pas
// perdre SLOT_DETECTED, BOT_ERROR ou STOPPED au profit de logs de cycles").
const HIGH_PRIORITY_TYPES = new Set(["SLOT_DETECTED", "BOT_ERROR", "STOPPED", "ERROR"]);

const priorityOf = (type: string): BufferedEventPriority =>
  HIGH_PRIORITY_TYPES.has(type) ? "high" : "normal";

type Entry = {
  envelope: BufferedEventEnvelope;
  priority: BufferedEventPriority;
  dedupKey?: string;
};

export class AgentOfflineEventBuffer {
  private entries: Entry[] = [];
  // Cle: `${botId}::${dedupKey}` -> deja vu recemment (evite de re-empiler
  // une alerte identique si elle est poussee plusieurs fois pendant la
  // meme coupure, en plus de la deduplication deja faite en amont, ex.
  // SlotAlertDeduplicator du Lot 4).
  private recentDedupKeys = new Set<string>();

  constructor(private readonly maxSize: number) {}

  size(): number {
    return this.entries.length;
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  // Retourne l'eventId genere (utile pour les tests), ou null si l'evenement
  // a ete rejete par deduplication (jamais une erreur: un evenement
  // redondant silencieusement ignore n'est pas un echec).
  push(input: OfflineBufferEventInput): string | null {
    if (input.dedupKey) {
      const dedupCompositeKey = `${input.botId}::${input.dedupKey}`;
      if (this.recentDedupKeys.has(dedupCompositeKey)) {
        return null;
      }
      this.recentDedupKeys.add(dedupCompositeKey);
    }

    const priority = priorityOf(input.type);

    // Coalescence des doublons adjacents (section 4): un evenement de meme
    // (botId, type) qui suit IMMEDIATEMENT le dernier pour ce bot dans le
    // buffer est redondant (seul le plus recent compte pour un statut qui
    // n'a pas change) - jamais pour deux types differents, jamais si un
    // autre evenement de ce bot s'est intercale.
    const lastForBot = [...this.entries].reverse().find((entry) => entry.envelope.botId === input.botId);
    if (lastForBot && lastForBot.envelope.type === input.type && priority === "normal") {
      lastForBot.envelope.payload = input.payload;
      lastForBot.envelope.timestamp = new Date().toISOString();
      return lastForBot.envelope.eventId;
    }

    const envelope: BufferedEventEnvelope = {
      eventId: randomUUID(),
      type: input.type,
      botId: input.botId,
      timestamp: new Date().toISOString(),
      payload: input.payload
    };
    this.entries.push({ envelope, priority, dedupKey: input.dedupKey });

    this.enforceBound();
    return envelope.eventId;
  }

  // Borne stricte (section 4: "aucune croissance memoire infinie"): retire
  // en priorite le plus ancien evenement "normal" ; si le buffer ne
  // contient plus que des evenements "high", retire quand meme le plus
  // ancien (une borne stricte doit rester une borne, meme au prix d'un
  // evenement important tres ancien).
  private enforceBound(): void {
    while (this.entries.length > this.maxSize) {
      const normalIndex = this.entries.findIndex((entry) => entry.priority === "normal");
      const removed = normalIndex >= 0 ? this.entries.splice(normalIndex, 1)[0] : this.entries.shift();
      if (removed?.dedupKey) {
        this.recentDedupKeys.delete(`${removed.envelope.botId}::${removed.dedupKey}`);
      }
    }
  }

  // Vide le buffer dans l'ordre FIFO pour rejeu (section 5). Ne retire PAS
  // les entrees ici: l'appelant doit confirmer l'envoi via acknowledge()
  // pour chaque eventId reellement transmis, afin de ne jamais perdre un
  // evenement dont l'envoi echoue a nouveau (section 5, etape 5).
  peekAll(): BufferedEventEnvelope[] {
    return this.entries.map((entry) => entry.envelope);
  }

  acknowledge(eventId: string): void {
    const index = this.entries.findIndex((entry) => entry.envelope.eventId === eventId);
    if (index < 0) {
      return;
    }
    const [removed] = this.entries.splice(index, 1);
    if (removed.dedupKey) {
      this.recentDedupKeys.delete(`${removed.envelope.botId}::${removed.dedupKey}`);
    }
  }

  clear(): void {
    this.entries = [];
    this.recentDedupKeys.clear();
  }
}
