import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { DbBrowserProfile, RecordingExtensionStatus, pool } from "./db.js";

export type BrowserProfileLease = {
  profile: DbBrowserProfile;
  release: () => void;
};

const occupiedProfiles = new Set<number>();

const profileRoot = (agencyId: number | null): string =>
  path.join(process.cwd(), "artifacts", "chrome-profiles", agencyId ? `agency-${agencyId}` : "internal");

const profileDir = (agencyId: number | null, profileKey: string): string =>
  path.join(profileRoot(agencyId), profileKey);

const chromeProfilesRoot = (): string => path.join(process.cwd(), "artifacts", "chrome-profiles");

export const isProfileLockedOnDisk = (directoryPath: string): boolean =>
  ["SingletonLock", "SingletonCookie", "SingletonSocket"]
    .some((fileName) => existsSync(path.join(directoryPath, fileName)));

export const getInstalledExtensionIds = (directoryPath: string): string[] => {
  const extensionsPath = path.join(directoryPath, "Default", "Extensions");
  if (!existsSync(extensionsPath)) {
    return [];
  }

  return readdirSync(extensionsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "Temp")
    .map((entry) => entry.name)
    .filter((name) => /^[a-p]{32}$/.test(name));
};

export const getInstalledExtensionCount = (directoryPath: string): number =>
  getInstalledExtensionIds(directoryPath).length;

export const pinInstalledExtensions = (directoryPath: string): number => {
  const extensionIds = getInstalledExtensionIds(directoryPath);
  if (extensionIds.length === 0) {
    return 0;
  }

  const preferencesPath = path.join(directoryPath, "Default", "Preferences");
  if (!existsSync(preferencesPath)) {
    return 0;
  }

  const preferences = JSON.parse(readFileSync(preferencesPath, "utf8")) as {
    extensions?: { pinned_extensions?: string[] };
    toolbar?: { pinned_extension_ids?: string[] };
  };
  preferences.extensions ??= {};
  preferences.toolbar ??= {};

  const existingExtensionPins = new Set(preferences.extensions.pinned_extensions ?? []);
  const existingToolbarPins = new Set(preferences.toolbar.pinned_extension_ids ?? []);
  for (const extensionId of extensionIds) {
    existingExtensionPins.add(extensionId);
    existingToolbarPins.add(extensionId);
  }

  preferences.extensions.pinned_extensions = [...existingExtensionPins];
  preferences.toolbar.pinned_extension_ids = [...existingToolbarPins];
  writeFileSync(preferencesPath, JSON.stringify(preferences));
  return extensionIds.length;
};

const rowQueryForAgency = (agencyId: number | null, whereClause = "TRUE"): { sql: string; values: unknown[] } => {
  if (agencyId) {
    return {
      sql: `SELECT * FROM browser_profiles WHERE agency_id = $1 AND ${whereClause} ORDER BY id`,
      values: [agencyId]
    };
  }

  return {
    sql: `SELECT * FROM browser_profiles WHERE agency_id IS NULL AND ${whereClause} ORDER BY id`,
    values: []
  };
};

export const listBrowserProfiles = async (
  agencyId: number | null
): Promise<Array<DbBrowserProfile & { occupied: boolean; lockedOnDisk: boolean; installedExtensionCount: number; installedExtensionIds: string[] }>> => {
  const query = rowQueryForAgency(agencyId);
  const result = await pool.query<DbBrowserProfile>(query.sql, query.values);
  return result.rows.map((profile) => {
    const installedExtensionIds = getInstalledExtensionIds(profile.directory_path);
    return {
      ...profile,
      occupied: occupiedProfiles.has(profile.id),
      lockedOnDisk: isProfileLockedOnDisk(profile.directory_path),
      installedExtensionCount: installedExtensionIds.length,
      installedExtensionIds
    };
  });
};

const nextProfileKey = async (agencyId: number | null): Promise<string> => {
  const profiles = await listBrowserProfiles(agencyId);
  const used = new Set(profiles.map((profile) => profile.profile_key));

  for (let index = 1; index < 1_000; index += 1) {
    const key = `profile-${String(index).padStart(2, "0")}`;
    if (!used.has(key)) {
      return key;
    }
  }

  throw new Error("Nombre maximal de profils atteint pour cette agence.");
};

export const createBrowserProfile = async (
  agencyId: number | null,
  status: RecordingExtensionStatus
): Promise<DbBrowserProfile> => {
  const profileKey = await nextProfileKey(agencyId);
  const directoryPath = profileDir(agencyId, profileKey);
  await mkdir(directoryPath, { recursive: true });

  const result = await pool.query<DbBrowserProfile>(
    `INSERT INTO browser_profiles (agency_id, profile_key, directory_path, recording_extension_status)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [agencyId, profileKey, directoryPath, status]
  );
  return result.rows[0];
};

const reserveFromCandidates = async (profiles: DbBrowserProfile[]): Promise<BrowserProfileLease | null> => {
  for (const profile of profiles) {
    if (occupiedProfiles.has(profile.id)) {
      continue;
    }

    await mkdir(profile.directory_path, { recursive: true });
    if (isProfileLockedOnDisk(profile.directory_path)) {
      await pool.query(
        "UPDATE browser_profiles SET last_error = $2 WHERE id = $1",
        [profile.id, "Profil Chrome verrouille sur disque: fermeture ou nettoyage requis."]
      );
      continue;
    }

    occupiedProfiles.add(profile.id);
    await pool.query("UPDATE browser_profiles SET last_used_at = NOW() WHERE id = $1", [profile.id]);
    return {
      profile,
      release: () => {
        occupiedProfiles.delete(profile.id);
      }
    };
  }

  return null;
};

export const reserveReadyProfileForBot = async (agencyId: number): Promise<BrowserProfileLease> => {
  const result = await pool.query<DbBrowserProfile>(
    `SELECT * FROM browser_profiles
     WHERE agency_id = $1 AND recording_extension_status = 'ready'
     ORDER BY last_used_at NULLS FIRST, id`,
    [agencyId]
  );

  const installableProfiles: DbBrowserProfile[] = [];
  for (const profile of result.rows) {
    if (getInstalledExtensionCount(profile.directory_path) > 0) {
      installableProfiles.push(profile);
      continue;
    }

    await pool.query(
      `UPDATE browser_profiles
       SET recording_extension_status = 'intervention_required',
           last_error = 'Profil marque pret mais aucune extension Chrome n''est detectee sur disque.'
       WHERE id = $1`,
      [profile.id]
    );
  }

  const lease = await reserveFromCandidates(installableProfiles);
  if (!lease) {
    const occupiedCount = installableProfiles.filter((profile) => occupiedProfiles.has(profile.id)).length;
    const lockedCount = installableProfiles.filter((profile) => isProfileLockedOnDisk(profile.directory_path)).length;
    const readyCount = installableProfiles.length;
    throw new Error(
      readyCount > 0
        ? `Tous les profils Chrome prepares avec extension sont indisponibles (${occupiedCount} occupe(s), ${lockedCount} verrouille(s), ${readyCount} pret(s) au total). Preparez un profil supplementaire pour lancer un autre bot avec l'extension.`
        : "Aucun profil Chrome prepare avec extension detectee pour cette agence. Preparez un profil avant de demarrer ce bot."
    );
  }

  return lease;
};

export const reserveReadyProfileForBotOrCreatePreparation = async (
  agencyId: number
): Promise<{ lease: BrowserProfileLease; needsExtensionPreparation: boolean }> => {
  const result = await pool.query<DbBrowserProfile>(
    `SELECT * FROM browser_profiles
     WHERE agency_id = $1 AND recording_extension_status = 'ready'
     ORDER BY last_used_at NULLS FIRST, id`,
    [agencyId]
  );

  const installableProfiles: DbBrowserProfile[] = [];
  for (const profile of result.rows) {
    if (getInstalledExtensionCount(profile.directory_path) > 0) {
      installableProfiles.push(profile);
    }
  }

  const lease = await reserveFromCandidates(installableProfiles);
  if (lease) {
    return { lease, needsExtensionPreparation: false };
  }

  return {
    lease: await reserveProfileForPreparation(agencyId),
    needsExtensionPreparation: true
  };
};

export const reserveStandardProfileForBot = async (agencyId: number | null): Promise<BrowserProfileLease> => {
  const query = agencyId
    ? {
      sql: `SELECT * FROM browser_profiles
            WHERE agency_id = $1 AND recording_extension_status = 'not_configured'
            ORDER BY last_used_at NULLS FIRST, id`,
      values: [agencyId]
    }
    : {
      sql: `SELECT * FROM browser_profiles
            WHERE agency_id IS NULL AND recording_extension_status = 'not_configured'
            ORDER BY last_used_at NULLS FIRST, id`,
      values: []
    };
  const result = await pool.query<DbBrowserProfile>(query.sql, query.values);
  const lease = await reserveFromCandidates(result.rows);
  if (lease) {
    return lease;
  }

  const profile = await createBrowserProfile(agencyId, "not_configured");
  occupiedProfiles.add(profile.id);
  await pool.query("UPDATE browser_profiles SET last_used_at = NOW() WHERE id = $1", [profile.id]);
  return {
    profile,
    release: () => {
      occupiedProfiles.delete(profile.id);
    }
  };
};

export const reserveBrowserProfileById = async (agencyId: number, profileId: number): Promise<BrowserProfileLease> => {
  const profile = await getBrowserProfileForAgency(agencyId, profileId);
  const lease = await reserveFromCandidates([profile]);
  if (!lease) {
    throw new Error("Ce profil est deja occupe ou verrouille.");
  }

  return lease;
};

export const reserveProfileForPreparation = async (agencyId: number): Promise<BrowserProfileLease> => {
  const result = await pool.query<DbBrowserProfile>(
    `SELECT * FROM browser_profiles
     WHERE agency_id = $1
     ORDER BY
       CASE recording_extension_status
         WHEN 'pending' THEN 1
         WHEN 'intervention_required' THEN 2
         WHEN 'error' THEN 3
         WHEN 'not_configured' THEN 4
         WHEN 'ready' THEN 5
         ELSE 6
       END,
       last_used_at NULLS FIRST,
       id`,
    [agencyId]
  );

  const lease = await reserveFromCandidates(result.rows);
  if (lease) {
    await pool.query(
      "UPDATE browser_profiles SET recording_extension_status = 'preparing', last_error = NULL WHERE id = $1",
      [lease.profile.id]
    );
    lease.profile.recording_extension_status = "preparing";
    lease.profile.last_error = null;
    return lease;
  }

  const profile = await createBrowserProfile(agencyId, "preparing");
  occupiedProfiles.add(profile.id);
  await pool.query("UPDATE browser_profiles SET last_used_at = NOW() WHERE id = $1", [profile.id]);
  return {
    profile,
    release: () => {
      occupiedProfiles.delete(profile.id);
    }
  };
};

export const updateProfileStatus = async (
  profileId: number,
  status: RecordingExtensionStatus,
  error?: string | null
): Promise<DbBrowserProfile> => {
  const result = await pool.query<DbBrowserProfile>(
    `UPDATE browser_profiles
     SET recording_extension_status = $2,
         recording_extension_prepared_at = CASE WHEN $2 = 'ready' THEN NOW() ELSE recording_extension_prepared_at END,
         last_error = $3
     WHERE id = $1
     RETURNING *`,
    [profileId, status, error ?? null]
  );
  return result.rows[0];
};

export const getBrowserProfileForAgency = async (agencyId: number, profileId: number): Promise<DbBrowserProfile> => {
  const result = await pool.query<DbBrowserProfile>(
    "SELECT * FROM browser_profiles WHERE agency_id = $1 AND id = $2",
    [agencyId, profileId]
  );
  const profile = result.rows[0];
  if (!profile) {
    throw new Error("Profil introuvable pour cette agence.");
  }

  return profile;
};

export const deleteBrowserProfileForAgency = async (agencyId: number, profileId: number): Promise<void> => {
  const profile = await getBrowserProfileForAgency(agencyId, profileId);
  if (occupiedProfiles.has(profile.id) || isProfileLockedOnDisk(profile.directory_path)) {
    throw new Error("Ce profil est occupe ou verrouille. Arretez le Chrome avant de le supprimer.");
  }

  const root = path.resolve(chromeProfilesRoot());
  const target = path.resolve(profile.directory_path);
  if (!target.startsWith(root + path.sep)) {
    throw new Error("Chemin de profil invalide: suppression refusee.");
  }

  await pool.query("DELETE FROM browser_profiles WHERE id = $1 AND agency_id = $2", [profileId, agencyId]);
  await rm(target, { recursive: true, force: true });
};
