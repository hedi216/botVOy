import { spawn } from "node:child_process";

// Phase 5 (Lot 2, section 3): protection DPAPI via un appel controle a
// System.Security.Cryptography.ProtectedData (PowerShell), jamais un module
// natif Node. Raisons (voir docs/agent-credential-store.md pour la matrice
// complete):
// - Aucune dependance native a maintenir/precompiler par ABI Node (un module
//   natif casserait la reproductibilite du build et l'integration future dans
//   un executable SEA, qui n'a pas de mecanisme mature d'embarquement
//   d'addons natifs).
// - PowerShell est deja une dependance etablie de toute la chaine de
//   packaging Windows (agent-package-win.ps1, tests reels *-real.ts) - aucune
//   nouvelle fragilite introduite.
// - ProtectedData::Protect/Unprotect avec DataProtectionScope.CurrentUser est
//   l'API DPAPI officielle .NET, disponible nativement sur tout Windows
//   supporte, sans certificat ni cle a gerer nous-memes.
//
// Regle de securite stricte (section 3): la valeur en clair et le blob
// chiffre transitent UNIQUEMENT par stdin/stdout du sous-processus, JAMAIS en
// argument de ligne de commande (visible via Get-Process/Task Manager/
// journaux d'evenements) ni en variable d'environnement.

const DPAPI_TIMEOUT_MS = 10_000;

export class DpapiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DpapiUnavailableError";
  }
}

const runPowerShellDpapi = (mode: "protect" | "unprotect", inputBase64: string): Promise<string> =>
  new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new DpapiUnavailableError("DPAPI non disponible: plateforme non-Windows."));
      return;
    }

    // Script minimal, sans aucune valeur secrete inline: l'entree arrive par
    // stdin (base64, une seule ligne), la sortie repart par stdout (base64,
    // une seule ligne). Echec fermé: toute exception PowerShell se traduit
    // par un code de sortie non nul, jamais un succes silencieux partiel.
    const script = mode === "protect"
      ? "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; "
        + "$b64 = [Console]::In.ReadLine(); $bytes = [Convert]::FromBase64String($b64); "
        + "$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, "
        + "[System.Security.Cryptography.DataProtectionScope]::CurrentUser); "
        + "[Console]::Out.WriteLine([Convert]::ToBase64String($protected))"
      : "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; "
        + "$b64 = [Console]::In.ReadLine(); $bytes = [Convert]::FromBase64String($b64); "
        + "$unprotected = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, "
        + "[System.Security.Cryptography.DataProtectionScope]::CurrentUser); "
        + "[Console]::Out.WriteLine([Convert]::ToBase64String($unprotected))";

    // Le script lui-meme ne contient AUCUNE valeur secrete (uniquement du
    // code fixe): il peut donc etre passe en argument sans risque. Seule la
    // donnee (texte en clair ou blob chiffre) transite par stdin, jamais par
    // un argument de ligne de commande.
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new DpapiUnavailableError("DPAPI: delai depasse (powershell n'a jamais repondu)."));
    }, DPAPI_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    // stderr volontairement ignore dans le message d'erreur final (section 3:
    // ne jamais recopier une valeur en clair qu'un message PowerShell pourrait
    // echoer par erreur) - seul un code de sortie non nul est retenu.
    child.stderr?.on("data", () => undefined);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new DpapiUnavailableError(`DPAPI indisponible (powershell introuvable ou non lancable): ${error.message}`));
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new DpapiUnavailableError(`DPAPI: l'operation ${mode} a echoue (code ${code}).`));
        return;
      }
      const line = stdout.trim().split(/\r?\n/).pop() ?? "";
      if (!line) {
        reject(new DpapiUnavailableError(`DPAPI: aucune sortie recue pour l'operation ${mode}.`));
        return;
      }
      resolve(line);
    });

    child.stdin?.write(`${inputBase64}\n`);
    child.stdin?.end();
  });

export const dpapiProtect = async (plaintext: string): Promise<string> => {
  const inputBase64 = Buffer.from(plaintext, "utf8").toString("base64");
  return runPowerShellDpapi("protect", inputBase64);
};

export const dpapiUnprotect = async (protectedBase64: string): Promise<string> => {
  const outputBase64 = await runPowerShellDpapi("unprotect", protectedBase64);
  return Buffer.from(outputBase64, "base64").toString("utf8");
};

// Verification rapide de disponibilite (section 3, "echec ferme si DPAPI
// indisponible"): un aller-retour protect/unprotect sur une valeur de test
// jetable, jamais journalise, jamais persiste.
export const isDpapiAvailable = async (): Promise<boolean> => {
  if (process.platform !== "win32") {
    return false;
  }
  try {
    const probe = `rendezbot-dpapi-probe-${Date.now()}`;
    const protectedValue = await dpapiProtect(probe);
    const roundTrip = await dpapiUnprotect(protectedValue);
    return roundTrip === probe;
  } catch {
    return false;
  }
};
