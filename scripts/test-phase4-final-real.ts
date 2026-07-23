// Lot 6: runner de regression finale REEL. A executer UNIQUEMENT sur un PC
// Windows personnel avec session interactive et Google Chrome installe —
// JAMAIS sur la VM/serveur de production. Execute chaque suite reelle
// SEQUENTIELLEMENT (jamais en parallele, section 4), avec une verification
// de nettoyage (chrome.exe/node.exe residuels) entre chaque suite.
//
// Usage: npx tsx scripts/test-phase4-final-real.ts
//    ou: npm run test:phase4:final:real
import { spawn } from "node:child_process";
import path from "node:path";
import {
  SuiteResult,
  buildFinalReport,
  printFinalSummary,
  printSuiteHeader,
  runScript,
  writeJsonReport
} from "./lib/testRunnerReport.js";

const TSX = process.platform === "win32" ? "npx.cmd" : "npx";

type ProcSnapshot = { chrome: number; node: number };

const countProcesses = (name: string): Promise<number> => new Promise((resolve) => {
  if (process.platform !== "win32") { resolve(0); return; }
  const script = `(Get-Process ${name} -ErrorAction SilentlyContinue | Measure-Object).Count`;
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  let output = "";
  child.stdout?.on("data", (c: Buffer) => { output += c.toString(); });
  child.on("exit", () => resolve(Number(output.trim()) || 0));
  child.on("error", () => resolve(0));
});

const snapshotProcesses = async (): Promise<ProcSnapshot> => ({
  chrome: await countProcesses("chrome"),
  node: await countProcesses("node")
});

// Note: node.exe inclut ce runner lui-meme (attendu, >=1) - seule une
// AUGMENTATION residuelle entre deux suites signale une fuite reelle.
const checkNoResidual = (before: ProcSnapshot, after: ProcSnapshot, suiteName: string): void => {
  if (after.chrome > before.chrome) {
    console.error(`[NETTOYAGE] ATTENTION: ${after.chrome - before.chrome} process chrome.exe residuel(s) detecte(s) apres "${suiteName}".`);
  }
  if (after.node > before.node) {
    console.error(`[NETTOYAGE] ATTENTION: ${after.node - before.node} process node.exe residuel(s) detecte(s) apres "${suiteName}" (hors ce runner).`);
  }
};

const main = async (): Promise<void> => {
  console.log("=== Runner reel final Phase 4 (Lot 6) ===");
  console.log("A executer sur un PC Windows personnel avec session interactive. JAMAIS sur la VM.");

  const startedAt = new Date().toISOString();
  const suites: SuiteResult[] = [];
  let baseline = await snapshotProcesses();

  const run = async (name: string, scriptPath: string): Promise<void> => {
    printSuiteHeader(name);
    const before = await snapshotProcesses();
    const result = await runScript({ name, command: TSX, args: ["tsx", scriptPath], timeoutMs: 15 * 60 * 1000 });
    suites.push(result);
    const after = await snapshotProcesses();
    checkNoResidual(before, after, name);
  };

  await run("Lot 2: cycle de vie reel Chrome (START_BOT/STOP_BOT)", "scripts/test-agent-phase4-lot2.ts");
  await run("Bot status: reel (correctif race botStatus)", "scripts/test-agent-bot-status-real.ts");
  await run("Lot 3: VALIDATE_BOT reel", "scripts/test-agent-validate-real.ts");
  await run("Lot 4: surveillance reelle", "scripts/test-agent-monitoring-real.ts");
  await run("Lot 5: resilience reelle", "scripts/test-agent-resilience-real.ts");

  const finalSnapshot = await snapshotProcesses();
  checkNoResidual(baseline, finalSnapshot, "ensemble du runner reel");
  console.log(`\n[NETTOYAGE] chrome.exe: ${baseline.chrome} avant -> ${finalSnapshot.chrome} apres. node.exe: ${baseline.node} avant -> ${finalSnapshot.node} apres.`);

  const report = buildFinalReport("windows-interactive", startedAt, suites);
  printFinalSummary(report);
  writeJsonReport(path.join(process.cwd(), "artifacts/test-results/phase4-final-real.json"), report);

  process.exit(report.totalFailed > 0 ? 1 : 0);
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
