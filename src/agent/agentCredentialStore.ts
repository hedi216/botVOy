import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ensureDir, loadStoredCredentials, saveStoredCredentials } from "./agentStorage.js";
import { AgentLogFn } from "./agentLocalLogger.js";
import {
  AgentCredentialStore,
  AgentRuntimeSettings,
  CredentialStoreSecurityDescription,
  StoredAgentCredentials
} from "./types.js";

// Phase 5 (Lot 2, section 2): store de developpement, comportement
// EXACTEMENT identique a agentStorage.ts (Lot 1) - fichier JSON en clair.
// Jamais selectionne implicitement en mode "packaged" (voir
// createCredentialStore ci-dessous): un avertissement local est journalise a
// chaque sauvegarde pour qu'un usage accidentel en environnement sensible
// reste visible.
export class DevFileCredentialStore implements AgentCredentialStore {
  constructor(private readonly settings: AgentRuntimeSettings, private readonly log: AgentLogFn) {}

  async load(): Promise<StoredAgentCredentials | null> {
    return loadStoredCredentials(this.settings);
  }

  async save(credentials: StoredAgentCredentials): Promise<void> {
    this.log("warn", "Stockage des identifiants agent EN CLAIR (mode developpement uniquement, jamais en production packagee).");
    saveStoredCredentials(this.settings, credentials);
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
    return { mode: "development", protection: "plaintext-dev", path: this.settings.credentialsPath };
  }
}

// Store de test: entierement en memoire, jamais touche au disque - isole par
// construction entre deux instances (chaque test cree la sienne), jamais de
// donnee reelle affectee.
export class TestCredentialStore implements AgentCredentialStore {
  private current: StoredAgentCredentials | null = null;

  async load(): Promise<StoredAgentCredentials | null> {
    return this.current;
  }

  async save(credentials: StoredAgentCredentials): Promise<void> {
    this.current = credentials;
  }

  async clear(): Promise<void> {
    this.current = null;
  }

  async exists(): Promise<boolean> {
    return this.current !== null;
  }

  describeSecurity(): CredentialStoreSecurityDescription {
    return { mode: "test", protection: "memory-test", path: null };
  }
}

// Phase 5 (Lot 2, section 2): selection EXPLICITE selon settings.runtimeMode
// - jamais une detection implicite (plateforme, presence d'un fichier). En
// mode "packaged", DPAPI est obligatoire: aucun fallback silencieux vers un
// fichier en clair si DPAPI est indisponible (non-Windows, powershell
// absent...) - echec ferme, l'agent ne demarre pas plutot que de degrader
// silencieusement la protection des identifiants.
export const createCredentialStore = async (
  settings: AgentRuntimeSettings,
  log: AgentLogFn
): Promise<AgentCredentialStore> => {
  if (settings.runtimeMode === "test") {
    return new TestCredentialStore();
  }

  if (settings.runtimeMode === "development") {
    return new DevFileCredentialStore(settings, log);
  }

  // "packaged"
  const { isDpapiAvailable } = await import("./agentDpapi.js");
  const available = await isDpapiAvailable();
  if (!available) {
    throw new Error(
      "AGENT_RUNTIME_MODE=packaged requiert DPAPI (Windows, CurrentUser) mais DPAPI est indisponible sur ce poste. "
      + "Echec ferme volontaire: aucun fallback vers un stockage en clair en mode packaged."
    );
  }
  const { WindowsDpapiCredentialStore } = await import("./agentDpapiCredentialStore.js");
  return new WindowsDpapiCredentialStore(settings, log);
};

// Ecriture atomique reutilisable (section 4): fichier temporaire unique dans
// le MEME dossier (garantit que rename() reste sur le meme volume, donc
// atomique sous Windows) puis rename() par-dessus la cible.
export const writeFileAtomic = (targetPath: string, content: string): void => {
  ensureDir(path.dirname(targetPath));
  const tmpPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, targetPath);
};
