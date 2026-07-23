// Lot 6 (section 4): verification COURTE apres deploiement - pas une
// regression complete. VM-safe (aucun Chrome de bot). Le soak test
// (npm run test:agent:soak:real, section 9) est deliberement exclu d'ici:
// trop long pour un smoke test.
//
// Usage: npx tsx scripts/test-phase4-smoke.ts
//    ou: npm run test:phase4:smoke
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

const main = async (): Promise<void> => {
  const startedAt = new Date().toISOString();
  const suites: SuiteResult[] = [];

  const run = async (name: string, args: string[], opts: { exitCodeOnly?: boolean } = {}): Promise<void> => {
    printSuiteHeader(name);
    const result = await runScript({ name, command: TSX, args, exitCodeOnly: opts.exitCodeOnly, timeoutMs: 3 * 60 * 1000 });
    suites.push(result);
  };

  await run("tsc --noEmit", ["tsc", "--noEmit"], { exitCodeOnly: true });
  await run("Serialisation publique agent (aucun secret)", ["tsx", "scripts/test-agent-serialization.ts"]);
  await run("Bot status: simule (chemin START_BOT/VALIDATE_BOT/STOP_BOT complet)", ["tsx", "scripts/test-agent-bot-status-simulated.ts"]);

  const report = buildFinalReport("vm", startedAt, suites);
  printFinalSummary(report);
  writeJsonReport(path.join(process.cwd(), "artifacts/test-results/phase4-smoke.json"), report);

  process.exit(report.totalFailed > 0 ? 1 : 0);
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
