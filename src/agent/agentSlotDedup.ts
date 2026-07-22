// Lot 4 (section 8 du cahier des charges): deduplique une meme alerte de
// creneau (meme bot, meme signature publique) dans une fenetre de temps
// raisonnable. Extrait de agentMonitoringRuntime.ts en module pur et sans
// dependance Playwright, pour rester testable unitairement sans Chrome
// (section 16: le test simule doit couvrir "SLOT_DETECTED et deduplication"
// sans agent reel ni Chrome de bot).
export const SLOT_DEDUP_WINDOW_MS = 10 * 60 * 1000;

export class SlotAlertDeduplicator {
  private lastSignature: string | null = null;
  private lastAtMs = 0;

  constructor(private readonly windowMs: number = SLOT_DEDUP_WINDOW_MS) {}

  // Retourne true si une NOUVELLE alerte doit etre envoyee (et memorise cette
  // signature/cet instant), false si une alerte identique a deja ete
  // envoyee recemment (aucun etat modifie dans ce cas).
  shouldAlert(signature: string, nowMs: number): boolean {
    if (this.lastSignature === signature && nowMs - this.lastAtMs < this.windowMs) {
      return false;
    }
    this.lastSignature = signature;
    this.lastAtMs = nowMs;
    return true;
  }

  reset(): void {
    this.lastSignature = null;
    this.lastAtMs = 0;
  }
}
