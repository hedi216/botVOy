// Test SIMULE Phase 5 (Lot 3, section 18): verifie le runtime embarque, le
// script Inno Setup, l'inventaire des fichiers livres, le manifeste et les
// hashes SANS jamais lancer Chrome ni realiser une vraie installation/
// desinstallation - executable sur une VM Windows sans GUI reelle (ISCC
// n'a pas besoin de GUI; s'il est absent, les verifications qui en
// dependent sont clairement journalisees comme ignorees, jamais silencieuses).
//
// Usage: npx tsx scripts/test-agent-packaging-lot3-simulated.ts
//    ou: npm run test:agent:packaging-lot3:simulated

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { loadAgentSettings } from "../src/agent/agentSettings.js";

let passCount = 0;
let failCount = 0;
const assert = (condition: boolean, description: string): void => {
  if (condition) { passCount += 1; console.log(`[PASS] ${description}`); }
  else { failCount += 1; console.error(`[FAIL] ${description}`); }
};
const log = (label: string, message: string): void => console.log(`[${label}] ${message}`);

const ROOT = path.resolve(process.cwd());
const APP_DIR = path.join(ROOT, "release", "agent-win", "app");
const RELEASE_DIR = path.join(ROOT, "release", "agent-win");
const WINDOWS_DIR = path.join(ROOT, "release", "windows");
const ISS_PATH = path.join(ROOT, "scripts", "agent-installer.iss");

const runPowerShell = (args: string[], cwd = ROOT): Promise<{ code: number; output: string }> => new Promise((resolve) => {
  const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
  child.stderr?.on("data", (c: Buffer) => { output += c.toString(); });
  child.on("exit", (code) => resolve({ code: code ?? 1, output }));
  child.on("error", () => resolve({ code: 1, output }));
});

const findIsccPath = (): string | null => {
  const override = process.env.INNO_SETUP_COMPILER_PATH;
  if (override && existsSync(override)) return override;
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe"),
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe"
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
};

const sha256 = (filePath: string): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn("powershell", ["-NoProfile", "-Command", `(Get-FileHash -Path '${filePath}' -Algorithm SHA256).Hash.ToLowerInvariant()`], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
  child.on("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error("Get-FileHash a echoue")));
});

const listFilesRecursive = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      out.push(path.relative(dir, full).replace(/\\/g, "/"));
    }
  };
  walk(dir);
  return out;
};

const main = async (): Promise<void> => {
  log("BOOT", "=== Test SIMULE Phase 5 (Lot 3): runtime embarque, installateur Inno Setup, manifeste, hashes ===");

  if (process.platform !== "win32") {
    console.log("Plateforme non-Windows: ce test necessite Windows. Ignore, 0 succes / 0 echec.");
    process.exit(0);
    return;
  }

  // ===================== 1. Build du runtime autonome (sans installateur, sans re-passer les regressions deja couvertes ailleurs) =====================
  log("BUILD", "Construction du runtime autonome (agent-package-win.ps1 -SkipTests -SkipInstaller)...");
  const build = await runPowerShell(["-File", "scripts/agent-package-win.ps1", "-SkipTests", "-SkipInstaller"]);
  assert(build.code === 0, `Build du runtime autonome reussi (code ${build.code})`);
  if (build.code !== 0) {
    console.log(build.output.slice(-4000));
  }

  // ===================== 2. Resolution du chemin installe / inventaire des fichiers =====================
  assert(existsSync(path.join(APP_DIR, "RendezBotAgent.exe")), "RendezBotAgent.exe present dans le dossier livre (runtime Node embarque)");
  assert(existsSync(path.join(APP_DIR, "agent", "agentMain.js")), "agent/agentMain.js present");
  assert(existsSync(path.join(APP_DIR, "agent", "agentStopHelper.js")), "agent/agentStopHelper.js present (arret gracieux installateur)");
  assert(existsSync(path.join(APP_DIR, "shared")), "shared/ present");
  assert(existsSync(path.join(APP_DIR, "agent-launch-no-console.vbs")), "Lanceur sans console (VBS transitoire) present");
  assert(existsSync(path.join(APP_DIR, "package.json")), "package.json minimal present");

  const allFiles = listFilesRecursive(APP_DIR);
  const forbiddenPathPatterns = [
    /^src\//, /(^|\/)scripts\/fixtures\//, /\.env($|\.)/i, /test-agent-/i, /\.test\./i,
    /agent-credentials\.json$/i, /\.log$/i
  ];
  const offendingFiles = allFiles.filter((f) => forbiddenPathPatterns.some((p) => p.test(f)));
  assert(offendingFiles.length === 0, `Aucun fichier interdit livre (src/, fixtures, .env, tests, credentials, logs) - trouve: ${offendingFiles.join(", ") || "aucun"}`);

  const forbiddenSecretPatterns = ["BREVO_API_KEY", "PGPASSWORD", "HtlsH2030", "POSTGRES_PASSWORD", "PGUSER", "PGDATABASE"];
  let secretFound = false;
  for (const relFile of allFiles) {
    if (!/\.(js|json|ts|vbs)$/i.test(relFile)) continue;
    const content = readFileSync(path.join(APP_DIR, relFile), "utf8");
    if (forbiddenSecretPatterns.some((p) => content.includes(p))) { secretFound = true; break; }
  }
  assert(!secretFound, "Aucune chaine secrete interdite trouvee dans le dossier livre");

  const pkg = JSON.parse(readFileSync(path.join(APP_DIR, "package.json"), "utf8"));
  const depNames = Object.keys(pkg.dependencies ?? {}).sort();
  assert(JSON.stringify(depNames) === JSON.stringify(["dotenv", "playwright", "socket.io-client"]), `package.json livre ne contient QUE les 3 dependances runtime agent (obtenu: ${depNames.join(", ")})`);

  // ===================== 3. Verification "aucune dependance Node systeme" (contrat SEA-rejete / embedded-node-copy) =====================
  const verifyDataRoot = path.join(ROOT, `.test-lot3-sim-verify-${Date.now()}`);
  const verifyResult = await new Promise<{ started: boolean }>((resolve) => {
    const child = spawn(path.join(APP_DIR, "RendezBotAgent.exe"), ["agent\\agentMain.js"], {
      cwd: APP_DIR,
      // AGENT_RUNTIME_MODE force a "development": cette verification cible
      // UNIQUEMENT l'absence de dependance Node.js systeme, jamais le
      // detecteur automatique de mode packaged (qui, combine au PATH vide
      // ci-dessous, ferait echouer DPAPI - un probleme distinct, deja
      // couvert par ses propres tests plus bas).
      env: { PATH: "", SystemRoot: process.env.SystemRoot ?? "", AGENT_DATA_DIR: verifyDataRoot, AGENT_SERVER_URL: "http://127.0.0.1:1", AGENT_RUNTIME_MODE: "development" },
      stdio: ["ignore", "ignore", "ignore"]
    });
    let started = true;
    child.on("error", () => { started = false; });
    setTimeout(() => {
      const wasRunning = started && child.exitCode === null;
      if (child.exitCode === null) child.kill();
      resolve({ started: wasRunning });
    }, 2_500);
  });
  assert(verifyResult.started, "RendezBotAgent.exe demarre avec PATH vide (aucune dependance a un Node.js systeme installe)");
  if (existsSync(verifyDataRoot)) rmSync(verifyDataRoot, { recursive: true, force: true });

  // ===================== 3bis. Lancement installe SANS AUCUNE variable Windows -> mode packaged auto-detecte (defaut trouve en test manuel VM) =====================
  const cleanLaunchDataRoot = path.join(ROOT, `.test-lot3-sim-cleanlaunch-${Date.now()}`);
  const cleanLaunchOutput = await new Promise<string>((resolve) => {
    const child = spawn(path.join(APP_DIR, "RendezBotAgent.exe"), ["agent\\agentMain.js"], {
      cwd: APP_DIR,
      // PATH normal (DPAPI doit fonctionner ici) - AUCUN AGENT_RUNTIME_MODE,
      // AUCUN AGENT_SERVER_URL: reproduit exactement un lancement installe
      // (raccourci) sans la moindre variable Windows definie, comme
      // reellement constate en test manuel VM.
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", AGENT_DATA_DIR: cleanLaunchDataRoot },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { output += c.toString(); });
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
      resolve(output);
    }, 3_000);
  });
  assert(/Serveur: https:\/\/app\.rendezbot\.xyz/.test(cleanLaunchOutput), `Lancement sans aucune variable Windows -> mode packaged auto-detecte -> https://app.rendezbot.xyz (sortie: ${cleanLaunchOutput.slice(0, 300)})`);
  if (existsSync(cleanLaunchDataRoot)) rmSync(cleanLaunchDataRoot, { recursive: true, force: true });

  // ===================== 4. Script Inno Setup: structure statique =====================
  const iss = readFileSync(ISS_PATH, "utf8");
  assert(/PrivilegesRequired=lowest/.test(iss), "Installateur per-user: PrivilegesRequired=lowest (aucune elevation)");
  assert(!/^SignTool=/m.test(iss), "Installateur explicitement non signe (aucune directive SignTool)");
  assert(/DefaultDirName=\{localappdata\}\\Programs\\RendezBot Agent/.test(iss), "Installation par defaut dans %LOCALAPPDATA%\\Programs (jamais Program Files)");
  assert(/AppId=\{\{137428DC-78FA-414F-BF17-F9CC0FD444C6\}/.test(iss), "AppId stable present (necessaire a la detection de mise a niveau)");
  assert(/Name: "autostart";.*Flags: checkedonce/.test(iss), "Tache de demarrage automatique presente (option installateur)");
  assert(/\{userstartup\}\\RendezBot Agent.*Tasks: autostart/.test(iss), "Raccourci de demarrage automatique gate par la tache 'autostart' (jamais une cle Run/tache planifiee)");
  assert(!/taskkill\.exe['\s"]+\/IM/.test(iss), "Aucun taskkill par nom d'image (jamais 'tuer tous les chrome.exe'/tous les node.exe)");
  assert(/taskkill\.exe['"]?,\s*'\/PID/.test(iss) || /\/PID '\s*\+/.test(iss), "Le seul taskkill de secours cible un PID precis lu dans le verrou");

  const codeSection = iss.slice(iss.indexOf("[Code]"));
  // Ne retient que le CODE (jamais les commentaires "//", qui mentionnent
  // legitimement WizardSilent() a titre documentaire pour expliquer le bug
  // historique) avant de verifier l'absence d'un appel reel.
  const codeSectionNoComments = codeSection
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  assert(!/WizardSilent\s*\(/.test(codeSectionNoComments), "Regression: WizardSilent() n'est jamais appele pendant la desinstallation (fonction invalide dans ce contexte - cause d'un blocage silencieux decouvert au Lot 3)");
  assert(/UninstallSilent\(\)/.test(codeSection), "UninstallSilent() est utilise pour detecter un mode silencieux pendant la desinstallation");
  const delTreeMatches = codeSection.match(/DelTree\(/g) ?? [];
  assert(delTreeMatches.length === 1, `DelTree n'apparait qu'une seule fois dans tout le script (obtenu: ${delTreeMatches.length}) - suppression completement scopee`);
  assert(/DELETEALLDATA/.test(codeSection), "La suppression complete en mode silencieux exige le parametre explicite /DELETEALLDATA=1 (jamais par defaut)");
  assert(/CompareVersions/.test(codeSection) && /GetInstalledVersion/.test(codeSection), "Detection de downgrade presente (CompareVersions/GetInstalledVersion)");
  assert(/PrepareToInstall/.test(codeSection) && /StopRunningAgentGracefully/.test(codeSection), "PrepareToInstall declenche l'arret gracieux avant remplacement de fichiers");

  // Tous les raccourcis (menu Demarrer, Bureau, Demarrage) et l'action
  // "Lancer maintenant" post-installation utilisent le MEME fichier .vbs -
  // un seul correctif du launcher (mode packaged transmis) couvre donc tous
  // les points d'entree (defaut trouve pendant un test manuel VM).
  const launcherReferences = iss.match(/Parameters:\s*"*\{app\}\\\{#MyAppLauncher\}/g) ?? [];
  assert(launcherReferences.length === 4, `Les 4 points de lancement (Menu Demarrer, Bureau, Demarrage, "Lancer maintenant") utilisent le meme launcher .vbs (obtenu: ${launcherReferences.length})`);

  // ===================== 4bis. Launcher .vbs livre: transmet explicitement le mode packaged =====================
  const launcherPath = path.join(ROOT, "scripts", "agent-launch-no-console.vbs");
  const launcherSource = readFileSync(launcherPath, "utf8");
  assert(/shell\.Environment\("Process"\)/i.test(launcherSource), "Le launcher .vbs definit l'environnement en portee 'Process' uniquement");
  assert(/processEnv\("AGENT_RUNTIME_MODE"\)\s*=\s*"packaged"/.test(launcherSource), "Le launcher .vbs transmet explicitement AGENT_RUNTIME_MODE=packaged avant de lancer l'agent (defaut trouve en VM: sans cela, le runtime retombait sur 'development'/localhost:3000)");
  assert(!/shell\.Environment\("User"\)/i.test(launcherSource) && !/shell\.Environment\("System"\)/i.test(launcherSource), "Le launcher .vbs ne depend jamais d'une variable d'environnement User/Machine (portee Process uniquement)");
  const shippedLauncherPath = path.join(APP_DIR, "agent-launch-no-console.vbs");
  if (existsSync(shippedLauncherPath)) {
    const shippedLauncher = readFileSync(shippedLauncherPath, "utf8");
    assert(shippedLauncher === launcherSource, "Le launcher livre dans le build correspond exactement au launcher source (aucune ancienne copie residuelle)");
  }

  // ===================== 5. Compilation ISCC (si l'outil est disponible sur cette VM) =====================
  const isccPath = findIsccPath();
  if (!isccPath) {
    log("SKIP", "ISCC.exe introuvable sur cette VM (INNO_SETUP_COMPILER_PATH non defini) - verification de compilation Inno Setup ignoree (journalise, pas de faux succes).");
  } else {
    const tempOut = path.join(ROOT, `.test-lot3-sim-installer-${Date.now()}`);
    const compile = await runPowerShell(["-Command", `& '${isccPath}' '/DMyAppVersion=0.0.0' '/DSourceDir=${APP_DIR}' '/O${tempOut}' '/FSimTest' '${ISS_PATH}'`]);
    assert(compile.code === 0, `Compilation Inno Setup reussie avec ISCC reel (code ${compile.code})`);
    assert(existsSync(path.join(tempOut, "SimTest.exe")), "Installateur de test genere par ISCC");
    if (existsSync(tempOut)) rmSync(tempOut, { recursive: true, force: true });
  }

  // ===================== 6. Manifeste de build + hashes (si un build complet avec installateur a deja ete produit) =====================
  const manifestPath = path.join(WINDOWS_DIR, "build-manifest.json");
  if (!existsSync(manifestPath)) {
    log("SKIP", "Aucun build-manifest.json present (aucun build complet avec installateur n'a encore ete lance dans cet environnement) - verifications manifeste/hashes ignorees, jamais silencieusement reussies.");
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert(manifest.product === "RendezBot Agent", "Manifeste: product = 'RendezBot Agent'");
    assert(typeof manifest.agentVersion === "string" && manifest.agentVersion.length > 0, "Manifeste: agentVersion present");
    assert(typeof manifest.protocolVersion === "number", "Manifeste: protocolVersion present");
    assert(manifest.architecture === "x64", "Manifeste: architecture = x64");
    assert(manifest.signed === false, "Manifeste: signed = false (Lot 3 reste explicitement non signe)");
    assert(Array.isArray(manifest.files) && manifest.files.every((f: any) => typeof f.name === "string" && typeof f.sha256 === "string" && typeof f.size === "number"), "Manifeste: chaque entree 'files' a name/sha256/size");

    const manifestText = JSON.stringify(manifest);
    const forbiddenManifestPatterns = [/[A-Z]:\\Users\\/i, /token/i, /password/i, /cookie/i, /secret/i, /pairing/i, /HtlsH2030/, process.env.USERNAME ?? "___no-username___"];
    const offendingManifestKeys = forbiddenManifestPatterns.filter((p) => (p instanceof RegExp ? p.test(manifestText) : manifestText.includes(p)));
    assert(offendingManifestKeys.length === 0, "Manifeste: aucun chemin utilisateur absolu / token / mot de passe / cookie / secret / code d'appairage");

    const versionInfo = JSON.parse(readFileSync(path.join(ROOT, "src", "agent", "agentVersionInfo.json"), "utf8"));
    assert(manifest.agentVersion === versionInfo.agentVersion, `Version coherente: manifeste (${manifest.agentVersion}) = agentVersionInfo.json (${versionInfo.agentVersion})`);

    const appVersionJson = path.join(APP_DIR, "version.json");
    if (existsSync(appVersionJson)) {
      const appVersion = JSON.parse(readFileSync(appVersionJson, "utf8"));
      assert(appVersion.agentVersion === manifest.agentVersion, "Version coherente: version.json livre = manifeste");
    }

    const installerEntry = manifest.files.find((f: any) => f.name.startsWith("windows/RendezBotAgentSetup-"));
    if (installerEntry) {
      assert(installerEntry.name.includes(manifest.agentVersion), "Nom de l'installateur contient bien la version du manifeste");
      const installerPath = path.join(ROOT, "release", installerEntry.name);
      if (existsSync(installerPath)) {
        const actualHash = await sha256(installerPath);
        assert(actualHash === installerEntry.sha256, "Le hash SHA-256 du manifeste correspond bien au fichier installateur reel sur disque");
      }
    }

    const sumsPath = path.join(WINDOWS_DIR, "SHA256SUMS.txt");
    if (existsSync(sumsPath)) {
      const sumsLines = readFileSync(sumsPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
      const sumsMap = new Map(sumsLines.map((l) => { const [hash, ...rest] = l.split(/\s+/); return [rest.join(" "), hash]; }));
      const allMatch = manifest.files.every((f: any) => sumsMap.get(f.name) === f.sha256);
      assert(allMatch && sumsMap.size === manifest.files.length, "SHA256SUMS.txt correspond exactement aux entrees du manifeste (memes fichiers, memes hashes)");
    }

    const manifestFilesText = manifest.files.map((f: any) => f.name).join("\n");
    assert(!/AGENT_SERVER_URL/.test(manifestText), "Manifeste: aucune valeur AGENT_SERVER_URL du poste de build n'est jamais serialisee");
    assert(!offendingFiles.includes("app/.env") && !manifestFilesText.includes(".env"), "Aucun .env (build ou local) n'est jamais reference/livre");
  }

  // ===================== 7. Resolution de l'URL serveur par mode (defaut trouve en test manuel VM: interface locale affichait localhost:3000 apres une vraie installation) =====================
  {
    const withEnv = async (overrides: Record<string, string | undefined>, fn: () => void): Promise<void> => {
      const previous = { ...process.env };
      try {
        for (const [key, value] of Object.entries(overrides)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        fn();
      } finally {
        process.env = previous;
      }
    };

    await withEnv({ AGENT_RUNTIME_MODE: "packaged", AGENT_SERVER_URL: undefined, AGENT_DATA_DIR: path.join(ROOT, ".test-lot3-sim-serverurl-1") }, () => {
      const settings = loadAgentSettings();
      assert(settings.serverUrl === "https://app.rendezbot.xyz", `Packaged sans variable -> defaut de production https://app.rendezbot.xyz (obtenu: ${settings.serverUrl})`);
    });

    await withEnv({ AGENT_RUNTIME_MODE: "packaged", AGENT_SERVER_URL: "http://example.com", AGENT_DATA_DIR: path.join(ROOT, ".test-lot3-sim-serverurl-2") }, () => {
      let threw = false;
      try { loadAgentSettings(); } catch { threw = true; }
      assert(threw, "Packaged avec HTTP distant (non-loopback) -> refus (HTTPS obligatoire pour un serveur distant)");
    });

    await withEnv({ AGENT_RUNTIME_MODE: "packaged", AGENT_SERVER_URL: "https://example.com", AGENT_DATA_DIR: path.join(ROOT, ".test-lot3-sim-serverurl-3") }, () => {
      let threw = false;
      let settings: any;
      try { settings = loadAgentSettings(); } catch { threw = true; }
      assert(!threw && settings.serverUrl === "https://example.com", "Packaged avec HTTPS distant explicite -> accepte tel quel");
    });

    await withEnv({ AGENT_RUNTIME_MODE: "packaged", AGENT_SERVER_URL: "http://127.0.0.1:1", AGENT_DATA_DIR: path.join(ROOT, ".test-lot3-sim-serverurl-4") }, () => {
      let threw = false;
      let settings: any;
      try { settings = loadAgentSettings(); } catch { threw = true; }
      assert(!threw && settings.serverUrl === "http://127.0.0.1:1", "Packaged avec un hote loopback explicite (tests internes du runtime packaged) -> accepte, jamais refuse");
    });

    await withEnv({ AGENT_RUNTIME_MODE: "development", AGENT_SERVER_URL: "http://localhost:3000", AGENT_DATA_DIR: path.join(ROOT, ".test-lot3-sim-serverurl-5") }, () => {
      const settings = loadAgentSettings();
      assert(settings.serverUrl === "http://localhost:3000", "Dev avec localhost explicite -> accepte");
    });

    await withEnv({ AGENT_RUNTIME_MODE: "development", AGENT_SERVER_URL: undefined, AGENT_DATA_DIR: path.join(ROOT, ".test-lot3-sim-serverurl-6") }, () => {
      const settings = loadAgentSettings();
      assert(settings.serverUrl.startsWith("http://localhost:"), "Dev sans variable -> comportement historique conserve (localhost par defaut)");
    });

    await withEnv({ AGENT_RUNTIME_MODE: "test", AGENT_SERVER_URL: undefined, AGENT_DATA_DIR: path.join(ROOT, ".test-lot3-sim-serverurl-7") }, () => {
      let threw = false;
      try { loadAgentSettings(); } catch { threw = true; }
      assert(threw, "Test sans variable -> refus (aucun serveur par defaut en mode test)");
    });

    await withEnv({ AGENT_RUNTIME_MODE: "test", AGENT_SERVER_URL: "http://127.0.0.1:1", AGENT_DATA_DIR: path.join(ROOT, ".test-lot3-sim-serverurl-8") }, () => {
      let threw = false;
      let settings: any;
      try { settings = loadAgentSettings(); } catch { threw = true; }
      assert(!threw && settings.serverUrl === "http://127.0.0.1:1", "Test avec serveur local explicite -> accepte");
    });

    await withEnv({ AGENT_RUNTIME_MODE: "test", AGENT_SERVER_URL: "https://example.com", AGENT_DATA_DIR: path.join(ROOT, ".test-lot3-sim-serverurl-9") }, () => {
      let threw = false;
      try { loadAgentSettings(); } catch { threw = true; }
      assert(threw, "Test avec serveur distant explicite -> refus (jamais de connexion Internet reelle en mode test)");
    });

    for (let i = 1; i <= 9; i += 1) {
      const dir = path.join(ROOT, `.test-lot3-sim-serverurl-${i}`);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }

  // ===================== 8. Aucune ancienne valeur de serveur embarquee dans le build compile =====================
  {
    const compiledSettingsPath = path.join(APP_DIR, "agent", "agentSettings.js");
    if (existsSync(compiledSettingsPath)) {
      const compiled = readFileSync(compiledSettingsPath, "utf8");
      assert(compiled.includes("https://app.rendezbot.xyz"), "Le fichier compile livre contient bien le nouveau defaut de production");
    }
  }

  console.log(`\n${passCount} succes, ${failCount} echec(s).`);
  process.exitCode = failCount > 0 ? 1 : 0;
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exitCode = 1;
});
