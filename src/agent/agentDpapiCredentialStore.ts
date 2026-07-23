import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dpapiProtect, dpapiUnprotect, DpapiUnavailableError } from "./agentDpapi.js";
import { writeFileAtomic } from "./agentCredentialStore.js";
import { AgentLogFn } from "./agentLocalLogger.js";
import {
  AgentCredentialStore,
  AgentRuntimeSettings,
  CredentialStoreSecurityDescription,
  ProtectedCredentialsFileV1,
  StoredAgentCredentials
} from "./types.js";

// Phase 5 (Lot 2, section 3/4): store DPAPI CurrentUser. Le token est
// TOUJOURS protege avant ecriture disque (jamais en clair); le reste de
// l'enveloppe (agentId, computerName, dates...) n'est pas un secret mais reste
// dans le meme fichier versionne pour une coherence de format unique.
//
// Echec ferme (section 3): toute erreur DPAPI, JSON corrompu, ou champ
// manquant/dangereux fait echouer load()/save() explicitement - jamais un
// fallback silencieux vers un stockage en clair.

const MAX_FILE_SIZE_BYTES = 64 * 1024;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class CredentialFileCorruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialFileCorruptedError";
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Validation stricte (section 4): rejette tout champ inconnu potentiellement
// dangereux, exige formatVersion=1 explicite, valide chaque champ attendu
// individuellement plutot que de faire confiance a un cast direct.
const parseProtectedFile = (raw: string): ProtectedCredentialsFileV1 => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialFileCorruptedError("JSON illisible.");
  }

  if (!isPlainObject(parsed)) {
    throw new CredentialFileCorruptedError("Contenu racine invalide (objet attendu).");
  }

  for (const key of Object.keys(parsed)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new CredentialFileCorruptedError(`Cle interdite presente: ${key}.`);
    }
  }

  if (parsed.formatVersion !== 1) {
    throw new CredentialFileCorruptedError(`formatVersion inattendu: ${String(parsed.formatVersion)}.`);
  }
  if (parsed.protection !== "windows-dpapi-current-user") {
    throw new CredentialFileCorruptedError(`Champ protection inattendu: ${String(parsed.protection)}.`);
  }
  if (typeof parsed.agentId !== "number" || typeof parsed.protectedToken !== "string" || !parsed.protectedToken) {
    throw new CredentialFileCorruptedError("Champs agentId/protectedToken manquants ou invalides.");
  }
  if (typeof parsed.agencyId !== "number" || typeof parsed.computerName !== "string"
    || typeof parsed.displayName !== "string" || typeof parsed.version !== "string"
    || typeof parsed.pairedAt !== "string" || typeof parsed.createdAt !== "string"
    || typeof parsed.updatedAt !== "string") {
    throw new CredentialFileCorruptedError("Champs de l'enveloppe protegee manquants ou de type invalide.");
  }

  return parsed as ProtectedCredentialsFileV1;
};

export class WindowsDpapiCredentialStore implements AgentCredentialStore {
  constructor(private readonly settings: AgentRuntimeSettings, private readonly log: AgentLogFn) {}

  async load(): Promise<StoredAgentCredentials | null> {
    const filePath = this.settings.credentialsPath;
    if (!existsSync(filePath)) {
      return null;
    }

    const size = statSync(filePath).size;
    if (size > MAX_FILE_SIZE_BYTES) {
      throw new CredentialFileCorruptedError(`Fichier de credentials anormalement volumineux (${size} octets).`);
    }

    const raw = readFileSync(filePath, "utf8");
    const envelope = parseProtectedFile(raw);

    let token: string;
    try {
      token = await dpapiUnprotect(envelope.protectedToken);
    } catch (error) {
      // Jamais journalise le blob ni le message brut PowerShell (pourrait
      // contenir un fragment de la valeur en cas d'echec partiel): message
      // generique uniquement.
      const detail = error instanceof DpapiUnavailableError ? error.message : "erreur DPAPI";
      throw new CredentialFileCorruptedError(`Impossible de dechiffrer le token protege (${detail}).`);
    }

    return {
      agentId: envelope.agentId,
      token,
      agencyId: envelope.agencyId,
      computerName: envelope.computerName,
      displayName: envelope.displayName,
      version: envelope.version,
      pairedAt: envelope.pairedAt
    };
  }

  async save(credentials: StoredAgentCredentials): Promise<void> {
    const protectedToken = await dpapiProtect(credentials.token);
    const now = new Date().toISOString();
    const existingCreatedAt = await this.readCreatedAtIfPresent();

    const envelope: ProtectedCredentialsFileV1 = {
      formatVersion: 1,
      protection: "windows-dpapi-current-user",
      agentId: credentials.agentId,
      protectedToken,
      agencyId: credentials.agencyId,
      computerName: credentials.computerName,
      displayName: credentials.displayName,
      version: credentials.version,
      pairedAt: credentials.pairedAt,
      createdAt: existingCreatedAt ?? now,
      updatedAt: now
    };

    writeFileAtomic(this.settings.credentialsPath, JSON.stringify(envelope, null, 2));
    this.log("success", `Identifiants agent proteges (DPAPI CurrentUser) sauvegardes dans ${this.settings.credentialsPath}.`);
  }

  private async readCreatedAtIfPresent(): Promise<string | null> {
    if (!existsSync(this.settings.credentialsPath)) {
      return null;
    }
    try {
      const envelope = parseProtectedFile(readFileSync(this.settings.credentialsPath, "utf8"));
      return envelope.createdAt;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    if (existsSync(this.settings.credentialsPath)) {
      rmSync(this.settings.credentialsPath, { force: true });
    }
  }

  async exists(): Promise<boolean> {
    return existsSync(this.settings.credentialsPath);
  }

  describeSecurity(): CredentialStoreSecurityDescription {
    return { mode: "packaged", protection: "windows-dpapi-current-user", path: this.settings.credentialsPath };
  }
}
