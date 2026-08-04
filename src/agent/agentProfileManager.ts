import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computeAccountKey } from "./agentAccountKey.js";
import { getProfilesDir, getStateDir } from "./agentStorage.js";
import { AgentLogFn } from "./agentLocalLogger.js";
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

// -------- HOTFIX CRITIQUE: isolation des profils Chrome par compte TLS --------
//
// Bug reel confirme manuellement: acquirePooledProfileLock() ci-dessus alloue
// le premier slot LIBRE sans connaitre l'identite du compte TLS - un profil
// utilise par le compte A a une session pouvait donc etre ensuite attribue
// au compte B, qui retrouvait alors les cookies/session de A. Le mapping
// ci-dessous fixe une affinite STABLE et DEFINITIVE entre un compte TLS
// (jamais le login en clair - uniquement son accountKey pseudonyme, cf.
// agentAccountKey.ts) et un slot de profil: une fois attribue, un slot n'est
// JAMAIS reattribue automatiquement a un autre compte, meme apres STOP_BOT,
// redemarrage de l'agent, revocation/reappairage ou redemarrage Windows.
// Aucune suppression automatique de cookies/mapping (section 7/8 du hotfix):
// seule une intervention manuelle explicite (deleteProfileManually, deja
// existante) peut liberer un slot pour reattribution.
const ACCOUNT_PROFILE_MAP_FILENAME = "account-profile-map.json";

type AccountProfileMapV3 = {
  formatVersion: 3;
  accounts: Record<string, string>;
  // HOTFIX FINAL AVANT PACKAGE (migration sure des profils legacy): tout
  // profile-NN present sur disque AVANT que ce mapping n'existe (ou avant que
  // ce champ n'existe, pour un mapping v1 anterieur) peut deja contenir la
  // session/les cookies d'un compte TLS totalement inconnu de ce mapping -
  // jamais attribuable automatiquement, ni a un compte identifie ni au pool
  // anonyme. Calculee UNE SEULE FOIS (a la migration), jamais recalculee
  // ensuite: un profil cree APRES la migration par ce meme code (mappe ou
  // anonyme) n'est jamais ajoute ici.
  legacyUnassignedProfiles: string[];
  // DERNIER CORRECTIF CIBLE AVANT RELEASE (reservation des profils anonymes):
  // un profil ayant deja servi a un flux SANS compte identifie (extension
  // locale) peut deja contenir une session/des cookies - jamais attribuable
  // ensuite a un compte identifie, meme totalement libre. Un profil anonyme
  // reste anonyme pour toujours (regle 3/4 du hotfix): jamais transforme en
  // profil de compte, jamais un profil de compte ou legacy n'y devient
  // anonyme.
  anonymousProfiles: string[];
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const accountProfileMapPath = (settings: AgentRuntimeSettings): string =>
  path.join(getStateDir(settings), ACCOUNT_PROFILE_MAP_FILENAME);

// Instantane de tous les profile-NN deja presents sur disque, au moment
// exact de la migration - jamais recalcule apres (cf. AccountProfileMapV3.
// legacyUnassignedProfiles ci-dessus). Reutilise listPooledProfileDirs (deja
// existante) plutot que de dupliquer le parcours du dossier profils.
const scanExistingProfileSlotNames = (settings: AgentRuntimeSettings): string[] =>
  listPooledProfileDirs(settings).map((profileDir) => path.basename(profileDir));

// Migration sure DEPUIS RIEN OU DEPUIS v1 (jamais depuis v2 - cf.
// migrateV2ToV3 ci-dessous, qui ne rescanne JAMAIS le disque): scanne les
// profils presents MAINTENANT, exclut ceux deja associes (accounts deja
// valides, point 8 du hotfix precedent - jamais transformes en legacy), et
// met tout le reste en quarantaine. anonymousProfiles demarre toujours vide:
// ce concept n'existait pas avant ce hotfix.
const migrateFromScratch = (settings: AgentRuntimeSettings, accounts: Record<string, string>): AccountProfileMapV3 => {
  const mappedSlots = new Set(Object.values(accounts));
  const migrated: AccountProfileMapV3 = {
    formatVersion: 3,
    accounts,
    legacyUnassignedProfiles: scanExistingProfileSlotNames(settings).filter((slot) => !mappedSlots.has(slot)),
    anonymousProfiles: []
  };
  saveAccountProfileMap(settings, migrated);
  return migrated;
};

// Migration v2 -> v3: CORRECTIF (profils existants non classes) - v2 ne
// suivait aucun profil anonyme (le champ n'existait pas encore), donc
// acquireAnonymousProfileLock() a pu, sous l'ancien code, creer/utiliser un
// profil sans jamais le persister nulle part dans le mapping. Un tel profil
// (present sur disque, absent de accounts ET de legacyUnassignedProfiles)
// pourrait sinon etre attribue plus tard a un nouveau compte identifie -
// exactement le bug que ce hotfix corrige. On scanne donc le disque ICI, UNE
// SEULE FOIS au moment precis de cette migration (jamais plus tard - un
// mapping deja v3 n'est jamais rescanne, cf. loadAccountProfileMap
// ci-dessous): tout profile-NN present qui n'est ni dans accounts.values()
// ni dans legacyUnassignedProfiles est mis en quarantaine (legacy), jamais en
// anonymousProfiles (on ne peut pas prouver qu'il vient reellement d'un flux
// anonyme - la quarantaine, jamais l'hypothese optimiste, est la strategie
// sure). accounts et legacyUnassignedProfiles deja valides restent
// EXACTEMENT tels quels, jamais retires ni deplaces.
const migrateV2ToV3 = (
  settings: AgentRuntimeSettings,
  v2: { accounts: Record<string, string>; legacyUnassignedProfiles: string[] }
): AccountProfileMapV3 => {
  const alreadyKnown = new Set([...Object.values(v2.accounts), ...v2.legacyUnassignedProfiles]);
  const newlyDiscoveredLegacy = scanExistingProfileSlotNames(settings).filter((slot) => !alreadyKnown.has(slot));
  const migrated: AccountProfileMapV3 = {
    formatVersion: 3,
    accounts: v2.accounts,
    legacyUnassignedProfiles: [...v2.legacyUnassignedProfiles, ...newlyDiscoveredLegacy],
    anonymousProfiles: []
  };
  saveAccountProfileMap(settings, migrated);
  return migrated;
};

// Format volontairement minimal et non chiffre: ne contient jamais de login
// ni de mot de passe, uniquement des paires accountKey (pseudonyme
// irreversible sans la cle locale) -> nom de slot ("profile-01", ...) et des
// listes (noms de slots seuls, jamais de login) de profils legacy/anonymes.
// Sa lecture seule ne revele donc rien d'exploitable sur les comptes reels.
const loadAccountProfileMap = (settings: AgentRuntimeSettings): AccountProfileMapV3 => {
  const filePath = accountProfileMapPath(settings);

  if (!existsSync(filePath)) {
    // Tout premier chargement pour ce dataRoot: aucun mapping n'a jamais
    // existe, donc AUCUNE association n'est deja "validee" - tous les
    // profils deja presents sont legacy.
    return migrateFromScratch(settings, {});
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (
      isPlainObject(parsed) && parsed.formatVersion === 3
      && isPlainObject(parsed.accounts) && isStringArray(parsed.legacyUnassignedProfiles) && isStringArray(parsed.anonymousProfiles)
    ) {
      // Deja migre: jamais rescanne (persistance stricte de la decision).
      return parsed as AccountProfileMapV3;
    }
    if (
      isPlainObject(parsed) && parsed.formatVersion === 2
      && isPlainObject(parsed.accounts) && isStringArray(parsed.legacyUnassignedProfiles)
    ) {
      return migrateV2ToV3(settings, parsed as { accounts: Record<string, string>; legacyUnassignedProfiles: string[] });
    }
    if (isPlainObject(parsed) && parsed.formatVersion === 1 && isPlainObject(parsed.accounts)) {
      // Mapping v1 anterieur: ses associations DEJA VALIDES sont conservees
      // telles quelles, mais v1 n'a jamais suivi de quarantaine ni de profils
      // anonymes: tout profil sur disque hors de ces associations est mis en
      // legacyUnassignedProfiles maintenant, une seule fois.
      return migrateFromScratch(settings, parsed.accounts as Record<string, string>);
    }
  } catch {
    // Fichier corrompu/illisible: traite comme un premier chargement plutot
    // que de retourner un mapping vide sans quarantaine - sur-quarantiner
    // (marquer legacy des profils en realite deja mappes mais illisibles ici)
    // est toujours sur ; l'inverse (oublier une quarantaine) ne l'est jamais.
  }

  return migrateFromScratch(settings, {});
};

const saveAccountProfileMap = (settings: AgentRuntimeSettings, mapping: AccountProfileMapV3): void => {
  writeFileSync(accountProfileMapPath(settings), JSON.stringify(mapping, null, 2));
};

// Reservee aux flux SANS identite de compte connue (extension locale geree
// entierement par l'extension, section 4 du hotfix 0.1.1 - aucun login
// transmis a l'agent): ne doit JAMAIS recuperer silencieusement un profil
// deja mappe a un compte TLS connu, ni un profil legacy non mappe (un ancien
// profil peut deja contenir la session d'un compte TLS totalement inconnu de
// ce mapping), meme totalement libre/deverrouille. Priorite a la
// REUTILISATION d'un profil DEJA anonyme et actuellement libre (regle 1 du
// hotfix "reserver les profils anonymes"): un profil anonyme reste toujours
// anonyme, jamais transforme en profil de compte (regle 3/4) - a l'inverse,
// un profil de compte ou legacy ne devient jamais anonyme (regle 3/4/5). Un
// nouveau slot anonyme est enregistre dans anonymousProfiles IMMEDIATEMENT,
// avant tout usage reel du profil (regle 1).
export const acquireAnonymousProfileLock = (settings: AgentRuntimeSettings): ProfileLease => {
  const mapping = loadAccountProfileMap(settings);

  for (const slotName of mapping.anonymousProfiles) {
    const lease = tryLockProfile(path.resolve(path.join(getProfilesDir(settings), slotName)));
    if (lease) {
      return lease;
    }
  }

  const reservedSlots = new Set([
    ...Object.values(mapping.accounts),
    ...mapping.legacyUnassignedProfiles,
    ...mapping.anonymousProfiles
  ]);

  for (let index = 1; index <= MAX_POOL_SLOTS; index += 1) {
    const slotName = `profile-${String(index).padStart(2, "0")}`;
    if (reservedSlots.has(slotName)) {
      continue;
    }
    const lease = tryLockProfile(poolProfileDir(settings, index));
    if (!lease) {
      continue;
    }
    mapping.anonymousProfiles.push(slotName);
    saveAccountProfileMap(settings, mapping);
    return lease;
  }
  throw new AgentCommandError(
    "PROFILE_LOCKED",
    `Aucun profil anonyme disponible dans le pool local (${MAX_POOL_SLOTS} slots tous occupes ou reserves).`
  );
};

// Alloue un profil avec AFFINITE STABLE au compte TLS (params.login), en
// remplacement de "premier slot libre" pour START_BOT. Comportement par
// identite de compte:
// - compte deja connu, profil libre -> reutilise EXACTEMENT ce meme profil
//   (jamais un autre, meme si un slot "plus tot" dans le pool est libre) ;
// - compte deja connu, profil actuellement verrouille (un bot de ce compte
//   tourne deja sur cet agent) -> refuse explicitement (TLS_ACCOUNT_ALREADY_
//   RUNNING), jamais un second Chrome sur le meme profil ;
// - compte inconnu -> attribue le premier slot ni verrouille NI DEJA MAPPE A
//   UN AUTRE COMPTE (jamais reutiliser un slot d'un autre compte meme
//   deverrouille), puis enregistre immediatement accountKey -> slot.
// Sans login fourni: acquireAnonymousProfileLock ci-dessus - jamais le pool
// brut acquirePooledProfileLock (qui, lui, ignore totalement le mapping et
// pourrait donc recuperer silencieusement un profil mappe a un vrai compte).
export const acquireProfileLockForAccount = async (
  settings: AgentRuntimeSettings,
  login: string | undefined,
  log: AgentLogFn
): Promise<ProfileLease> => {
  if (!login || !login.trim()) {
    return acquireAnonymousProfileLock(settings);
  }

  const accountKey = await computeAccountKey(settings, login, log);
  const mapping = loadAccountProfileMap(settings);
  const existingSlot = mapping.accounts[accountKey];

  if (existingSlot) {
    const profilePath = path.resolve(path.join(getProfilesDir(settings), existingSlot));
    const lease = tryLockProfile(profilePath);
    if (!lease) {
      throw new AgentCommandError(
        "TLS_ACCOUNT_ALREADY_RUNNING",
        "Un bot de ce compte TLS est deja actif sur cet agent (meme profil persistant deja verrouille)."
      );
    }
    return lease;
  }

  // Jamais un slot deja mappe a un AUTRE compte, ni legacy non mappe, ni deja
  // utilise par le flux anonyme (regle 2 du hotfix "reserver les profils
  // anonymes" - un profil anonyme ne devient jamais un profil de compte):
  // un nouveau compte ne doit recevoir qu'un slot jamais utilise auparavant
  // par ce mapping, sous quelque forme que ce soit.
  const reservedSlots = new Set([
    ...Object.values(mapping.accounts),
    ...mapping.legacyUnassignedProfiles,
    ...mapping.anonymousProfiles
  ]);
  for (let index = 1; index <= MAX_POOL_SLOTS; index += 1) {
    const slotName = `profile-${String(index).padStart(2, "0")}`;
    if (reservedSlots.has(slotName)) {
      continue;
    }
    const lease = tryLockProfile(poolProfileDir(settings, index));
    if (!lease) {
      // Verrouille par un autre process (tres improbable, jamais mappe a ce
      // compte): passe au slot suivant plutot que d'echouer prematurement.
      continue;
    }
    mapping.accounts[accountKey] = slotName;
    saveAccountProfileMap(settings, mapping);
    log("info", `Nouveau profil persistant attribue a ce compte TLS (${slotName}).`);
    return lease;
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
