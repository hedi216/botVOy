import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { AgentLogFn } from "./agentLocalLogger.js";
import { AgentCredentialStore, AgentRuntimeSettings, StoredAgentCredentials } from "./types.js";

// Phase 5 (Lot 2, section 5): migration du fichier de developpement en clair
// vers le store protege (DPAPI), au premier demarrage packaged. Recherche
// UNIQUEMENT des chemins explicitement connus (jamais un balayage arbitraire
// du disque): le chemin de credentials courant (AGENT_CREDENTIALS_PATH ou
// defaut Lot 2), et le defaut historique du Lot 1 ("config/credentials.json"
// sous le meme dataRoot) pour couvrir un agent deja appaire avec un build
// Lot 1 avant que ce chemin par defaut ne change.

export type MigrationResult =
  | { outcome: "not-needed" }
  | { outcome: "already-present" }
  | { outcome: "migrated"; fromPath: string }
  | { outcome: "failed"; reason: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Un fichier protege (Lot 2) porte formatVersion/protection/protectedToken;
// un fichier en clair (Lot 1) porte directement token en texte. Distingue
// les deux SANS jamais tenter de dechiffrer un champ qui n'existe pas.
const readAsLegacyPlaintext = (filePath: string): StoredAgentCredentials | null => {
  if (!existsSync(filePath)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || "formatVersion" in parsed || "protectedToken" in parsed) {
    return null;
  }
  if (
    typeof parsed.agentId !== "number" || typeof parsed.token !== "string" || !parsed.token
    || typeof parsed.agencyId !== "number" || typeof parsed.computerName !== "string"
    || typeof parsed.displayName !== "string" || typeof parsed.version !== "string"
    || typeof parsed.pairedAt !== "string"
  ) {
    return null;
  }
  return parsed as StoredAgentCredentials;
};

const legacyCandidatePaths = (settings: AgentRuntimeSettings): string[] => {
  const currentPath = settings.credentialsPath;
  const lot1DefaultPath = path.join(settings.dataRoot, "config", "credentials.json");
  return currentPath === lot1DefaultPath ? [currentPath] : [currentPath, lot1DefaultPath];
};

// Idempotente (section 5): si le store cible contient deja des identifiants
// valides, ne touche a rien et renvoie "already-present". Jamais de
// suppression de l'ancien fichier avant confirmation ecrite ET relue avec
// succes dans le nouveau store.
export const migratePlaintextCredentialsIfNeeded = async (
  settings: AgentRuntimeSettings,
  targetStore: AgentCredentialStore,
  log: AgentLogFn
): Promise<MigrationResult> => {
  // exists() signifie seulement "un fichier est present a ce chemin", pas
  // "ce fichier est un envelope protege valide pour ce store" - un fichier
  // en clair (Lot 1) legitimement present au MEME chemin par defaut
  // (settings.credentialsPath partage entre l'ancien et le nouveau format)
  // ferait echouer exists()=true et sauterait a tort la migration (defaut
  // trouve pendant la validation du test simule Lot 2). load() est le test
  // fiable: un envelope protege valide se charge sans erreur.
  const alreadyProtected = await targetStore.load().then((value) => value !== null).catch(() => false);
  if (alreadyProtected) {
    return { outcome: "already-present" };
  }

  for (const candidatePath of legacyCandidatePaths(settings)) {
    const legacy = readAsLegacyPlaintext(candidatePath);
    if (!legacy) {
      continue;
    }

    try {
      await targetStore.save(legacy);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log("error", `Migration des identifiants: echec de l'ecriture protegee (${reason}). Ancien fichier conserve, aucun nouveau fichier partiel.`);
      return { outcome: "failed", reason };
    }

    const reloaded = await targetStore.load().catch(() => null);
    if (!reloaded || reloaded.agentId !== legacy.agentId || reloaded.token !== legacy.token) {
      log("error", "Migration des identifiants: la relecture apres sauvegarde ne correspond pas. Ancien fichier conserve par securite.");
      await targetStore.clear().catch(() => undefined);
      return { outcome: "failed", reason: "Verification post-ecriture invalide." };
    }

    // Quand l'ancien chemin en clair EST le chemin cible du nouveau store
    // (cas courant: meme settings.credentialsPath avant/apres le Lot 2),
    // save() a deja ECRASE le fichier en clair par l'enveloppe protegee -
    // le supprimer ici effacerait les identifiants qui viennent d'etre
    // migres et verifies, pas l'ancien fichier (defaut trouve pendant la
    // validation du test simule Lot 2).
    if (candidatePath === targetStore.describeSecurity().path) {
      log("success", "Migration reussie.");
      return { outcome: "migrated", fromPath: candidatePath };
    }

    try {
      rmSync(candidatePath, { force: true });
    } catch (error) {
      // La migration reste reussie (le nouveau store est valide et verifie):
      // l'echec de suppression de l'ancien fichier est journalise mais ne
      // fait pas echouer la migration elle-meme (jamais de donnee perdue).
      log("warn", `Migration reussie mais l'ancien fichier en clair n'a pas pu etre supprime: ${error instanceof Error ? error.message : String(error)}.`);
    }

    log("success", "Migration reussie.");
    return { outcome: "migrated", fromPath: candidatePath };
  }

  return { outcome: "not-needed" };
};
