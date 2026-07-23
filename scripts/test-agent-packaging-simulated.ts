// Test SIMULE Phase 5 (Lot 1, section 18): verifie les fondations du
// packaging SANS lancer Chrome de bot et sans installation reelle -
// executable sur la VM. Couvre uniquement le perimetre du Lot 1: resolution
// des chemins, mode de version centralise, classification des dependances,
// redaction, et generation reelle du build compile (tsc + dependances
// minimales + manifeste), avec verification anti-secret sur le resultat.
//
// N'appelle jamais Chrome, n'installe rien sur le systeme, ne touche aucun
// profil reel. Le seul processus externe lance est le script de build
// PowerShell (compilation + copie + `npm install` des 3 dependances runtime
// de l'agent), execute avec -SkipTests pour rester rapide (la non-regression
// Phase 4 est deja verifiee separement par test:phase4:final:simulated).
//
// Usage: npx tsx scripts/test-agent-packaging-simulated.ts
//    ou: npm run test:agent:packaging:simulated

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { loadAgentSettings } from "../src/agent/agentSettings.js";
import { redactLogLine } from "../src/agent/agentLocalLogger.js";

let passCount = 0;
let failCount = 0;
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};

const ROOT = path.resolve(process.cwd());

const readAgentVersionInfo = (): { agentVersion: string; protocolVersion: number } =>
  JSON.parse(readFileSync(path.join(ROOT, "src/agent/agentVersionInfo.json"), "utf8"));

const main = async (): Promise<void> => {
  const testDataRoot = path.join(ROOT, ".test-packaging-dataroot");
  try {
  const agentVersionInfo = readAgentVersionInfo();

  // ===================== 1. Resolution des chemins (jamais process.cwd()) =====================
  {
    const previousEnv = { ...process.env };
    try {
      delete process.env.AGENT_CREDENTIALS_PATH;
      process.env.AGENT_DATA_DIR = path.join(ROOT, ".test-packaging-dataroot");
      process.env.AGENT_SERVER_URL = "http://localhost:1";
      process.env.AGENT_TARGET_MODE = "production";
      delete process.env.AGENT_FIXTURE_URL;

      const settings = loadAgentSettings();
      assert(settings.dataRoot === process.env.AGENT_DATA_DIR, "dataRoot respecte AGENT_DATA_DIR quand fourni");
      assert(
        settings.credentialsPath.startsWith(settings.dataRoot),
        `credentialsPath (${settings.credentialsPath}) derive de dataRoot, jamais de process.cwd() (defaut corrige au Lot 1)`
      );
      assert(!settings.credentialsPath.includes(".agent-test-credentials.json"), "l'ancien defaut base sur process.cwd() n'est plus utilise");
    } finally {
      process.env = previousEnv;
    }
  }

  // ===================== 2. Source unique de version =====================
  {
    const previousEnv = { ...process.env };
    try {
      delete process.env.AGENT_VERSION;
      process.env.AGENT_DATA_DIR = path.join(ROOT, ".test-packaging-dataroot");
      process.env.AGENT_SERVER_URL = "http://localhost:1";
      const settings = loadAgentSettings();
      assert(settings.version === agentVersionInfo.agentVersion, "AGENT_VERSION (sans override) provient de agentVersionInfo.json (source unique)");
    } finally {
      process.env = previousEnv;
    }
  }
  assert(typeof agentVersionInfo.protocolVersion === "number", "protocolVersion defini dans la source unique de version");

  // AGENT_VERSION est fige a l'import du module (comme avant le Lot 1): une
  // simple mutation de process.env en cours de processus ne le fait jamais
  // reagir - il faut un NOUVEAU processus pour verifier la surcharge
  // explicite (dev/test), fidele au comportement reel au demarrage.
  {
    const overrideResult = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import", "tsx",
        "-e",
        "import('./src/agent/agentSettings.js').then(m => console.log(m.loadAgentSettings().version))"
      ], {
        cwd: ROOT,
        env: { ...process.env, AGENT_VERSION: "9.9.9-override-test", AGENT_DATA_DIR: path.join(ROOT, ".test-packaging-dataroot"), AGENT_SERVER_URL: "http://localhost:1" },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let output = "";
      child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
      child.on("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`sous-processus AGENT_VERSION: code ${code}`)));
    });
    assert(overrideResult.endsWith("9.9.9-override-test"), `AGENT_VERSION reste surchargeable explicitement au demarrage d'un nouveau processus (obtenu: "${overrideResult}")`);
  }

  // ===================== 3. Classification des dependances (garde-fou anti-regression) =====================
  {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert(
      Object.prototype.hasOwnProperty.call(pkg.dependencies ?? {}, "socket.io-client"),
      "socket.io-client est classe en dependency (jamais devDependency): requis a l'execution par src/agent/agentClient.ts"
    );
    assert(
      !Object.prototype.hasOwnProperty.call(pkg.devDependencies ?? {}, "socket.io-client"),
      "socket.io-client absent de devDependencies"
    );
    for (const forbidden of ["express", "pg", "cookie-parser"]) {
      assert(
        !Object.prototype.hasOwnProperty.call(pkg.devDependencies ?? {}, forbidden),
        `${forbidden} n'est pas dans devDependencies (deja en dependencies, cote serveur)`
      );
    }
  }

  // ===================== 4. Redaction (garde-fou, deja couvert ailleurs mais critique pour un build distribue) =====================
  {
    const sample = "Authorization: Bearer test-sentinel-value-should-not-appear";
    const redacted = redactLogLine(sample);
    assert(!redacted.includes("test-sentinel-value-should-not-appear"), "redactLogLine masque bien une valeur Authorization avant tout build/distribution");
  }

  // ===================== 5. Build reel (compile + dependances minimales) + verification anti-secret =====================
  {
    console.log("[BUILD] Lancement du build agent (scripts/agent-package-win.ps1 -SkipTests)...");
    const isWindows = process.platform === "win32";
    if (!isWindows) {
      console.log("[BUILD] Plateforme non-Windows detectee: verification du build reel ignoree (le script de build est PowerShell/Windows uniquement), pas comptee en echec.");
    } else {
      const buildResult = await new Promise<{ code: number | null }>((resolve) => {
        const child = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-File", "scripts/agent-package-win.ps1", "-SkipTests"], {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"]
        });
        child.stdout?.on("data", () => undefined);
        child.stderr?.on("data", () => undefined);
        child.on("exit", (code) => resolve({ code }));
      });
      assert(buildResult.code === 0, `Le build agent (Lot 1) se termine sans erreur (code ${buildResult.code})`);

      const releaseDir = path.join(ROOT, "release", "agent-win");
      const appDir = path.join(releaseDir, "app");
      assert(existsSync(path.join(appDir, "agent", "agentMain.js")), "agentMain.js compile present dans le build");
      assert(existsSync(path.join(appDir, "shared")), "dossier shared compile present dans le build");
      assert(existsSync(path.join(appDir, "logger.js")), "logger.js compile present dans le build");
      assert(!existsSync(path.join(appDir, "server.js")) && !existsSync(path.join(appDir, "db.js")), "aucun fichier serveur/PostgreSQL dans le build agent");
      assert(existsSync(path.join(releaseDir, "version.json")), "version.json genere");
      assert(existsSync(path.join(releaseDir, "build-manifest.json")), "build-manifest.json genere");
      assert(existsSync(path.join(releaseDir, "SHA256SUMS.txt")), "SHA256SUMS.txt genere");

      const versionInfo = JSON.parse(readFileSync(path.join(releaseDir, "version.json"), "utf8"));
      assert(versionInfo.agentVersion === agentVersionInfo.agentVersion, "version.json reflete la source unique de version");
      assert(typeof versionInfo.gitCommit === "string" && versionInfo.gitCommit.length > 0, "version.json contient un commit Git");

      const nodeModulesEntries = existsSync(path.join(appDir, "node_modules")) ? readdirSync(path.join(appDir, "node_modules")) : [];
      assert(nodeModulesEntries.includes("playwright") && nodeModulesEntries.includes("socket.io-client") && nodeModulesEntries.includes("dotenv"), "les 3 dependances runtime attendues sont presentes");
      assert(!existsSync(path.join(appDir, "node_modules", "express")) && !existsSync(path.join(appDir, "node_modules", "pg")), "aucune dependance serveur (express/pg) dans le build agent");

      const forbidden = ["BREVO_API_KEY", "PGPASSWORD", "HtlsH2030", "POSTGRES_PASSWORD"];
      const manifestText = readFileSync(path.join(releaseDir, "build-manifest.json"), "utf8") + readFileSync(path.join(releaseDir, "version.json"), "utf8");
      assert(!forbidden.some((f) => manifestText.includes(f)), "aucun secret connu dans version.json/build-manifest.json");
    }
  }

  } finally {
    if (existsSync(testDataRoot)) {
      rmSync(testDataRoot, { recursive: true, force: true });
    }
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exit(failCount > 0 ? 1 : 0);
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
