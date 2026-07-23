// Lot 6 (section 11): valide au demarrage les variables numeriques
// serveur les plus sensibles (port TCP, capacite). Avant ce module,
// une valeur non numerique (ex: PGPORT=abc) produisait un NaN silencieux
// qui echouait plus tard avec une erreur bas niveau illisible (driver pg
// ou net.Server.listen), au lieu d'un message clair au demarrage.
export const requirePositiveInt = (label: string, raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Variable d'environnement invalide: ${label}="${raw}" (entier positif attendu).`);
  }

  return value;
};

export const requireValidPort = (label: string, raw: string | undefined, fallback: number): number => {
  const value = requirePositiveInt(label, raw, fallback);
  if (value > 65535) {
    throw new Error(`Variable d'environnement invalide: ${label}="${raw}" (port TCP attendu entre 1 et 65535).`);
  }

  return value;
};
