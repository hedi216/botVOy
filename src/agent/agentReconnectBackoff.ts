// Lot 5 (section 2): calcul pur du delai de reconnexion (backoff
// exponentiel borne + jitter), extrait de agentClient.ts pour rester
// testable unitairement sans socket ni serveur.
export const computeReconnectDelayMs = (
  attempt: number,
  minDelayMs: number,
  maxDelayMs: number,
  jitterRatio: number,
  random: () => number = Math.random
): number => {
  const safeAttempt = Math.max(1, Math.trunc(attempt));
  const exponential = minDelayMs * (2 ** (safeAttempt - 1));
  const base = Math.min(maxDelayMs, exponential);
  const jitterSpan = base * jitterRatio;
  const jitter = jitterSpan > 0 ? (random() * 2 - 1) * jitterSpan : 0;
  return Math.max(0, Math.round(base + jitter));
};
