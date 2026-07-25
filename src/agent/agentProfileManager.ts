import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getProfilesDir } from "./agentStorage.js";
import { AgentRuntimeSettings } from "./types.js";
import { AgentCommandError } from "./agentErrors.js";

// Hotfix Cloudflare (diagnostic profils, cf. rapport): pool LOCAL de profils
// Chrome PERSISTANTS (profile-01, profile-02, ...), jamais un profil jetable
// cree a partir d'un botId ephemere. Defaut identifie: un profil neuf a
// chaque START_BOT n'accumule jamais de cookies/historique/jeton de
// clearance Cloudflare, contrairement au pool persistant deja utilise par
// l'ancien flux legacy_vm (browserProfileService.ts, table browser_profiles,
// profile-01/02/...). Un meme profil est desormais reutilise d'un
// demarrage a l'autre (jamais supprime automatiquement), et deux bots
// simultanes obtiennent toujours deux profils distincts (verrou exclusif
// par slot, meme mecanisme de fichier de verrouillage qu'auparavant).
const PROFILE_SLOT_PATTERN = /^profile-(\d{2,})$/;
const MAX_POOL_SLOTS = 1_000;

// path.resolve() (jamais seulement path.join()) est essentiel ici: un
// --user-data-dir RELATIF transmis a Chrome (ex. AGENT_DATA_DIR fourni sous
// forme relative) peut echouer a isoler correctement une nouvelle instance -
// Chrome bascule alors silencieusement sur "Ouverture dans une session de
// navigateur existante" (constat reel pendant ce diagnostic: le navigateur
// personnel de l'utilisateur recevait la navigation a la place d'une
// instance isolee, provoquant un "Chrome ferme prematurement" cote agent).
// L'ancienne fonction (resolveProfileDir, avant ce pool) resolvait deja en
// absolu pour cette meme raison - perdu par inadvertance lors de son
// remplacement, corrige ici.
const poolProfileDir = (settings: AgentRuntimeSettings, index: number): string =>
  path.resolve(path.join(getProfilesDir(settings), `profile-${String(index).padStart(2, "0")}`));

const lockFileName = ".rendezbot-agent.lock";

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Chrome maintient SES PROPRES fichiers de verrouillage internes dans un
// user-data-dir (SingletonLock/SingletonCookie/SingletonSocket), distincts
// du fichier .rendezbot-agent.lock ci-dessus. killChromeProcess() (Lot 2)
// ferme Chrome par taskkill /F (arret force, necessaire pour un arret
// garanti et rapide) - ce qui ne laisse jamais a Chrome l'occasion de
// nettoyer ces fichiers lui-meme. Un profil reutilise par un NOUVEAU Chrome
// peut alors trouver ces fichiers encore presents et refuser de demarrer
// une deuxieme fois sur ce meme profil, meme si aucun processus ne le
// detient plus reellement. Meme defense que l'ancien flux legacy_vm
// (browserProfileService.ts: isProfileLockedOnDisk) - jamais verifiee ici
// avant ce correctif. Sans risque: on ne les supprime QUE lorsque notre
// propre verrou (.rendezbot-agent.lock) vient d'etre acquis avec succes,
// preuve qu'aucun bot vivant de CET agent n'utilise plus ce profil.
const CHROME_SINGLETON_FILES = ["SingletonLock", "SingletonCookie", "SingletonSocket"];

const clearStaleChromeSingletonFiles = (profilePath: string): void => {
  for (const fileName of CHROME_SINGLETON_FILES) {
    try {
      rmSync(path.join(profilePath, fileName), { force: true });
    } catch {
      // best effort: si Chrome recree ces fichiers au demarrage, cela reste
      // sans consequence - jamais bloquant pour l'acquisition du profil.
    }
  }
};

// Correctif final avant release (diagnostic precedent): Chrome persiste par
// defaut, dans "Web Data" (table autofill - distincte de "Login Data", le
// gestionnaire de mots de passe), les valeurs tapees dans un champ de
// formulaire (ex. l'identifiant TLScontact rempli automatiquement). Jamais
// un secret ecrit PAR RendezBot, mais desormais persistant puisque le profil
// l'est lui-meme. RendezBot garantit a l'utilisateur que login/mot de passe
// ne sont jamais enregistres: on desactive donc, AVANT tout lancement de
// Chrome sur ce profil, l'autofill de formulaires et le gestionnaire de mots
// de passe - jamais les cookies/local storage/IndexedDB (utiles a la
// confiance Cloudflare), qui vivent dans des fichiers/dossiers totalement
// distincts (Network/Cookies, Local Storage/, IndexedDB/) jamais touches
// ici. Fusionne avec un Preferences existant plutot que de l'ecraser: ne
// doit jamais faire regresser un reglage deja present sur un profil reutilise.
const applyPrivacyPreferences = (profilePath: string): void => {
  const defaultDir = path.join(profilePath, "Default");
  mkdirSync(defaultDir, { recursive: true });
  const preferencesPath = path.join(defaultDir, "Preferences");

  let preferences: Record<string, unknown> = {};
  if (existsSync(preferencesPath)) {
    try {
      preferences = JSON.parse(readFileSync(preferencesPath, "utf8")) as Record<string, unknown>;
    } catch {
      preferences = {};
    }
  }

  const existingProfileSection = (preferences.profile && typeof preferences.profile === "object")
    ? preferences.profile as Record<string, unknown>
    : {};
  const existingAutofillSection = (preferences.autofill && typeof preferences.autofill === "object")
    ? preferences.autofill as Record<string, unknown>
    : {};

  preferences.credentials_enable_service = false;
  preferences.credentials_enable_autosignin = false;
  preferences.profile = {
    ...existingProfileSection,
    password_manager_enabled: false
  };
  preferences.autofill = {
    ...existingAutofillSection,
    enabled: false,
    profile_enabled: false,
    credit_card_enabled: false
  };

  writeFileSync(preferencesPath, JSON.stringify(preferences));
};

export type ProfileLease = {
  profilePath: string;
  release: () => void;
};

// Bug reel trouve pendant ce diagnostic: un verrou base UNIQUEMENT sur le
// PID ne peut jamais distinguer deux BOTS DIFFERENTS geres par le MEME
// process agent (this.bots peut contenir plusieurs bots actifs simultanes,
// tous lances par ce seul et meme process Node.js - donc le meme PID pour
// chacun). Sans ce Set, deux acquisitions concurrentes dans le meme process
// lisaient toutes les deux "PID = le mien" sur le meme fichier de verrou et
// se croyaient chacune legitimes, obtenant alors le MEME profil - exactement
// l'inverse du but recherche (un profil distinct par bot simultane). Ce Set
// en memoire (par process) est verifie EN PREMIER, avant meme le fichier de
// verrou (qui, lui, ne sert qu'a detecter un AUTRE process - agent
// redemarre, ou tres improbable second process agent). Meme principe que
// l'ancien flux legacy_vm (browserProfileService.ts: occupiedProfiles).
const heldProfilePaths = new Set<string>();

// Verrou local par profil: le Set ci-dessus protege contre deux bots du MEME
// process, le fichier (PID) protege contre un AUTRE process (redemarrage de
// l'agent apres un crash, verrou alors perime et remplace silencieusement).
// Entierement synchrone (aucun await avant l'ajout au Set): deux START_BOT
// quasi simultanes dans le meme process agent restent serialises par la
// boucle d'evenements, donc jamais deux bots ne peuvent obtenir le meme slot.
const tryLockProfile = (profilePath: string): ProfileLease | null => {
  if (heldProfilePaths.has(profilePath)) {
    return null;
  }

  mkdirSync(profilePath, { recursive: true });
  const lockPath = path.join(profilePath, lockFileName);

  if (existsSync(lockPath)) {
    const existing = readFileSync(lockPath, "utf8").trim();
    const existingPid = Number(existing);
    if (Number.isFinite(existingPid) && isPidAlive(existingPid)) {
      // Vivant et absent de heldProfilePaths (verifie ci-dessus): ne peut
      // appartenir qu'a un AUTRE process agent.
      return null;
    }
    // Verrou perime (process disparu, y compris apres un redemarrage de cet
    // agent): on le remplace.
  }

  writeFileSync(lockPath, String(process.pid));
  clearStaleChromeSingletonFiles(profilePath);
  applyPrivacyPreferences(profilePath);
  heldProfilePaths.add(profilePath);

  let released = false;
  return {
    profilePath,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      heldProfilePaths.delete(profilePath);
      try {
        if (existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
          rmSync(lockPath, { force: true });
        }
      } catch {
        // best effort: un verrou perime sera de toute facon detecte comme
        // mort (PID non vivant) par la prochaine acquisition.
      }
    }
  };
};

// Parcourt profile-01, profile-02, ... dans l'ordre et retient le PREMIER
// slot libre (jamais verrouille par un process vivant): favorise
// naturellement la reutilisation des memes profils au fil du temps (jamais
// un nouveau slot tant qu'un slot deja utilise est disponible) - exactement
// l'inverse du comportement precedent (un profil neuf par botId, jamais
// reutilise). Aucun login/mot de passe n'est jamais ecrit dans ce dossier
// par RendezBot (les identifiants ne vivent que dans la portee locale de
// startBot()/runAutoNavigation(), cf. section 3 du hotfix 0.1.1): seul
// Chrome lui-meme y ecrit ses propres cookies/stockage local.
export const acquirePooledProfileLock = (settings: AgentRuntimeSettings): ProfileLease => {
  for (let index = 1; index <= MAX_POOL_SLOTS; index += 1) {
    const lease = tryLockProfile(poolProfileDir(settings, index));
    if (lease) {
      return lease;
    }
  }
  throw new AgentCommandError("PROFILE_LOCKED", `Aucun profil disponible dans le pool local (${MAX_POOL_SLOTS} slots tous occupes).`);
};

// Diagnostic/administration uniquement: jamais appelee par le cycle de vie
// normal START_BOT/STOP_BOT (aucune suppression automatique de profil).
export const listPooledProfileDirs = (settings: AgentRuntimeSettings): string[] => {
  const root = getProfilesDir(settings);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PROFILE_SLOT_PATTERN.test(entry.name))
    .map((entry) => path.join(root, entry.name));
};

// Suppression manuelle explicite uniquement (jamais appelee automatiquement):
// meme verification de confinement que l'equivalent serveur historique
// (browserProfileService.ts: deleteBrowserProfileForAgency) - le chemin
// resolu doit rester strictement a l'interieur du dossier profils.
export const deleteProfileManually = (settings: AgentRuntimeSettings, profilePath: string): void => {
  const root = path.resolve(getProfilesDir(settings));
  const target = path.resolve(profilePath);
  if (!target.startsWith(root + path.sep)) {
    throw new AgentCommandError("PROFILE_CREATE_FAILED", "Chemin de profil hors du dossier autorise: suppression refusee.");
  }
  rmSync(target, { recursive: true, force: true });
};
