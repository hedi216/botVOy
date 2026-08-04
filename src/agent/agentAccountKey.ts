import { randomBytes, createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dpapiProtect, dpapiUnprotect, isDpapiAvailable } from "./agentDpapi.js";
import { ensureDir } from "./agentStorage.js";
import { AgentLogFn } from "./agentLocalLogger.js";
import { AgentRuntimeSettings } from "./types.js";

// HOTFIX CRITIQUE (isolation des profils Chrome par compte TLS): un compte
// TLS doit toujours obtenir le MEME profil persistant, mais le login ne doit
// JAMAIS etre ecrit sur disque (nom de dossier, mapping, logs). On derive
// donc un identifiant local pseudonyme stable ("accountKey") par HMAC-SHA256
// du login normalise, avec une cle LOCALE aleatoire generee une seule fois
// par machine agent. Jamais un simple SHA256(login) sans cle: sans secret,
// n'importe qui lisant le fichier de mapping pourrait tester une liste de
// logins probables et retrouver lequel correspond a quel profil (attaque par
// dictionnaire). Avec une cle secrete locale inconnue de l'attaquant, ce
// calcul devient impossible a inverser depuis le seul mapping.
//
// Meme convention de stockage que agentCredentialStore.ts/createCredentialStore
// (reutilisee ici, jamais reinventee): DPAPI CurrentUser obligatoire en mode
// "packaged" (echec ferme si indisponible, jamais de repli silencieux vers du
// clair), fichier local simple en mode "development"/"test" (comportement
// documente, deja accepte pour les identifiants d'appairage dans ce meme
// codebase).
const ACCOUNT_KEY_BYTES = 32;
// 96 bits (24 caracteres hex): largement suffisant pour eviter toute
// collision realiste entre comptes geres par un seul agent, tout en restant
// court si jamais affiche (noms de slots, diagnostics futurs).
const ACCOUNT_KEY_HEX_LENGTH = 24;

type LocalAccountKeyEnvelopeV1 =
  | { formatVersion: 1; protection: "windows-dpapi-current-user"; protectedKeyBase64: string; createdAt: string }
  | { formatVersion: 1; protection: "plaintext-dev"; keyBase64: string; createdAt: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseEnvelope = (raw: string): LocalAccountKeyEnvelopeV1 => {
  const parsed = JSON.parse(raw);
  if (!isPlainObject(parsed) || parsed.formatVersion !== 1) {
    throw new Error("Fichier de cle locale (isolation profils/comptes) corrompu ou de format inattendu.");
  }
  if (parsed.protection === "windows-dpapi-current-user" && typeof parsed.protectedKeyBase64 === "string") {
    return parsed as LocalAccountKeyEnvelopeV1;
  }
  if (parsed.protection === "plaintext-dev" && typeof parsed.keyBase64 === "string") {
    return parsed as LocalAccountKeyEnvelopeV1;
  }
  throw new Error("Fichier de cle locale (isolation profils/comptes) corrompu ou de format inattendu.");
};

const localKeyFilePath = (settings: AgentRuntimeSettings): string =>
  path.join(ensureDir(path.join(settings.dataRoot, "security")), "account-hmac-key.json");

// Mis en cache par dataRoot (jamais par instance): un redemarrage simule de
// l'agent (nouvelle instance, meme dataRoot) doit retrouver la MEME cle,
// jamais une nouvelle - sans quoi le mapping accountKey->profil deviendrait
// illisible apres chaque redemarrage reel.
const cachedKeysByDataRoot = new Map<string, Buffer>();

// Reservee aux tests cibles (isolation profils/comptes, test D "redemarrage
// simule"): vide le cache en memoire pour forcer un rechargement REEL depuis
// disque au prochain appel, exactement ce qu'un redemarrage de process ferait
// naturellement. Jamais appelee par le code de production.
export const __resetAccountKeyCacheForTests = (): void => {
  cachedKeysByDataRoot.clear();
};

const loadOrCreateLocalKey = async (settings: AgentRuntimeSettings, log: AgentLogFn): Promise<Buffer> => {
  const cached = cachedKeysByDataRoot.get(settings.dataRoot);
  if (cached) {
    return cached;
  }

  const filePath = localKeyFilePath(settings);
  if (existsSync(filePath)) {
    const envelope = parseEnvelope(readFileSync(filePath, "utf8"));
    const keyBase64 = envelope.protection === "windows-dpapi-current-user"
      ? await dpapiUnprotect(envelope.protectedKeyBase64)
      : envelope.keyBase64;
    const key = Buffer.from(keyBase64, "base64");
    cachedKeysByDataRoot.set(settings.dataRoot, key);
    return key;
  }

  if (settings.runtimeMode === "packaged" && !(await isDpapiAvailable())) {
    throw new Error(
      "AGENT_RUNTIME_MODE=packaged requiert DPAPI (Windows, CurrentUser) pour proteger la cle locale "
      + "d'isolation des profils par compte TLS, mais DPAPI est indisponible sur ce poste. Echec ferme volontaire."
    );
  }

  const freshKey = randomBytes(ACCOUNT_KEY_BYTES);
  const keyBase64 = freshKey.toString("base64");
  const createdAt = new Date().toISOString();

  const envelope: LocalAccountKeyEnvelopeV1 = settings.runtimeMode === "packaged"
    ? { formatVersion: 1, protection: "windows-dpapi-current-user", protectedKeyBase64: await dpapiProtect(keyBase64), createdAt }
    : { formatVersion: 1, protection: "plaintext-dev", keyBase64, createdAt };

  if (envelope.protection === "plaintext-dev") {
    log("warn", "Cle locale d'isolation des profils par compte TLS stockee EN CLAIR (mode developpement/test uniquement, jamais en production packagee).");
  }

  writeFileSync(filePath, JSON.stringify(envelope, null, 2));
  cachedKeysByDataRoot.set(settings.dataRoot, freshKey);
  return freshKey;
};

// Identifiant local pseudonyme stable pour un compte TLS - jamais le login en
// clair, jamais persiste tel quel: seul ce digest tronque (HMAC-SHA256 avec
// la cle locale ci-dessus) est ecrit dans le mapping accountKey->profil.
// Normalisation minimale (espaces + casse) pour qu'un meme compte tape
// differemment donne toujours la meme cle.
export const computeAccountKey = async (
  settings: AgentRuntimeSettings,
  rawLogin: string,
  log: AgentLogFn
): Promise<string> => {
  const normalized = rawLogin.trim().toLowerCase();
  const key = await loadOrCreateLocalKey(settings, log);
  return createHmac("sha256", key).update(normalized, "utf8").digest("hex").slice(0, ACCOUNT_KEY_HEX_LENGTH);
};
