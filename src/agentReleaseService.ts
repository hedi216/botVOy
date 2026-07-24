import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { AgentReleaseChannel, AgentReleaseConfig } from "./config.js";

// Phase 5 (Lot 4, section 3/4): service centralise de metadonnees de
// release. Ne leve JAMAIS d'exception vers l'appelant - un artefact absent,
// un manifeste invalide ou un hash incorrect se traduisent toujours par
// "indisponible", jamais un crash serveur ni une fuite de chemin disque.

export type AgentReleasePublicMetadata = {
  available: true;
  // null uniquement pour un override administratif pur (section 8), quand
  // aucune release interne validee n'existe - jamais de metadonnees de
  // fichier inventees pour un lien externe non verifie par ce service.
  version: string | null;
  protocolVersion: number | null;
  fileName: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  signed: false;
  channel: AgentReleaseChannel;
  downloadUrl: string;
};

export type AgentReleaseUnavailable = { available: false };

type ValidatedRelease = {
  version: string;
  protocolVersion: number;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  sha256: string;
  channel: AgentReleaseChannel;
};

const HEX64 = /^[0-9a-f]{64}$/i;

type HashCacheEntry = { key: string; mtimeMs: number; size: number; sha256: string };
let hashCache: HashCacheEntry | null = null;

const sha256File = (filePath: string): Promise<string> => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", reject);
  stream.on("end", () => resolve(hash.digest("hex")));
});

// Section 6: n'hache jamais un artefact de ~27 Mo a chaque appel - le cache
// n'est invalide que si la taille OU la date de modification changent
// reellement sur disque (jamais suppose stable indefiniment sans verifier).
const getCachedOrComputeHash = async (filePath: string, cacheKey: string): Promise<string> => {
  const stat = statSync(filePath);
  if (hashCache && hashCache.key === cacheKey && hashCache.mtimeMs === stat.mtimeMs && hashCache.size === stat.size) {
    return hashCache.sha256;
  }
  const sha256 = await sha256File(filePath);
  hashCache = { key: cacheKey, mtimeMs: stat.mtimeMs, size: stat.size, sha256 };
  return sha256;
};

const resolveValidatedRelease = async (config: AgentReleaseConfig): Promise<ValidatedRelease | null> => {
  if (!config.releasesDir || !config.releaseVersion || config.channel === "blocked") {
    return null;
  }

  try {
    const versionDir = path.resolve(config.releasesDir, config.releaseVersion);
    const manifestPath = path.join(versionDir, "build-manifest.json");
    if (!existsSync(manifestPath)) {
      return null;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.agentVersion !== config.releaseVersion) {
      return null;
    }
    // Lot 4 (section 6/23): aucune release "signee" n'est jamais annoncee -
    // une valeur inattendue est traitee comme un manifeste invalide, jamais
    // silencieusement acceptee. A revoir uniquement quand une vraie
    // infrastructure de signature existera (voir agent-signing.md).
    if (manifest.signed !== false) {
      return null;
    }
    if (typeof manifest.protocolVersion !== "number") {
      return null;
    }

    // Le nom de fichier attendu est TOUJOURS derive de la version configuree
    // (jamais lu depuis une entree du manifeste ni depuis une requete
    // utilisateur) - coherent avec le nom reellement produit par le Lot 3.
    const fileName = `RendezBotAgentSetup-${config.releaseVersion}.exe`;
    const filePath = path.join(versionDir, fileName);
    // Defense en profondeur contre un path traversal (meme si releaseVersion
    // est deja strictement valide par regex a la configuration): le fichier
    // resolu doit rester exactement dans le dossier de version attendu.
    if (path.dirname(filePath) !== versionDir) {
      return null;
    }
    if (!existsSync(filePath)) {
      return null;
    }

    const manifestEntry = Array.isArray(manifest.files)
      ? manifest.files.find((f: unknown) =>
        typeof f === "object" && f !== null && typeof (f as { name?: unknown }).name === "string" &&
        (f as { name: string }).name.endsWith(fileName))
      : null;
    if (
      !manifestEntry ||
      typeof manifestEntry.sha256 !== "string" || !HEX64.test(manifestEntry.sha256) ||
      typeof manifestEntry.size !== "number"
    ) {
      return null;
    }

    const stat = statSync(filePath);
    if (stat.size !== manifestEntry.size) {
      return null;
    }

    const actualSha256 = await getCachedOrComputeHash(filePath, `${config.releaseVersion}:${filePath}`);
    if (actualSha256.toLowerCase() !== manifestEntry.sha256.toLowerCase()) {
      return null;
    }

    return {
      version: config.releaseVersion,
      protocolVersion: manifest.protocolVersion,
      fileName,
      filePath,
      sizeBytes: stat.size,
      sha256: actualSha256,
      channel: config.channel
    };
  } catch {
    return null;
  }
};

export const getAgentReleaseMetadata = async (config: AgentReleaseConfig): Promise<AgentReleasePublicMetadata | AgentReleaseUnavailable> => {
  const validated = await resolveValidatedRelease(config);

  if (!validated) {
    if (!config.downloadUrlOverride) {
      return { available: false };
    }
    // Override administratif pur (section 8): aucune release interne
    // validee n'est configuree/trouvee, mais un lien externe a ete
    // explicitement fourni - le bouton de telechargement doit rester
    // fonctionnel, sans jamais inventer de fausses metadonnees de fichier
    // (taille/hash) pour un artefact que ce service n'a pas lui-meme verifie.
    return {
      available: true,
      version: config.releaseVersion,
      protocolVersion: null,
      fileName: null,
      sizeBytes: null,
      sha256: null,
      signed: false,
      channel: config.channel,
      downloadUrl: config.downloadUrlOverride
    };
  }

  // L'URL de telechargement reste RELATIVE par defaut (jamais construite
  // depuis req.protocol/req.get('host'), fragile derriere un proxy/tunnel) -
  // le navigateur la resout depuis la page courante. L'override
  // administratif (section 8), lui, est deja une URL absolue complete.
  const downloadUrl = config.downloadUrlOverride ?? `/api/agent/releases/${validated.version}/download`;
  return {
    available: true,
    version: validated.version,
    protocolVersion: validated.protocolVersion,
    fileName: validated.fileName,
    sizeBytes: validated.sizeBytes,
    sha256: validated.sha256,
    signed: false,
    channel: validated.channel,
    downloadUrl
  };
};

export type AgentReleaseDownloadTarget = { filePath: string; fileName: string; sizeBytes: number };

// Ne correspond QUE a la version explicitement autorisee (section 4: "aucune
// selection arbitraire du dernier dossier trouve") - une requete pour toute
// autre valeur, meme si un dossier existe reellement sur disque, est refusee.
export const resolveAgentReleaseDownload = async (
  config: AgentReleaseConfig,
  requestedVersion: string
): Promise<AgentReleaseDownloadTarget | null> => {
  if (!config.releaseVersion || requestedVersion !== config.releaseVersion) {
    return null;
  }
  const validated = await resolveValidatedRelease(config);
  if (!validated) {
    return null;
  }
  return { filePath: validated.filePath, fileName: validated.fileName, sizeBytes: validated.sizeBytes };
};

// Expose pour les tests uniquement (jamais utilise en dehors): permet de
// forcer une re-lecture reelle du hash entre deux scenarios de test qui
// remplacent le meme fichier factice.
export const resetAgentReleaseHashCacheForTests = (): void => {
  hashCache = null;
};
