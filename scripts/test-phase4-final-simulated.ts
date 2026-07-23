// Lot 6: runner de regression finale VM-SAFE. N'importe et ne lance JAMAIS
// src/agent/agentMain.ts pour ouvrir un Chrome de bot (test-agent-phase4-lot2.ts
// est deliberement EXCLU de ce runner: ses deux suites ouvrent un vrai
// Chrome, cf. docs/agent-testing.md - classe cote "reel"). Chaque sous-test
// reste un process enfant independant (son propre serveur/DB/nettoyage);
// ce runner mesure et agrege leurs resultats, jamais ne les remplace.
//
// Usage: npx tsx scripts/test-phase4-final-simulated.ts
//    ou: npm run test:phase4:final:simulated
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
    const result = await runScript({ name, command: TSX, args, exitCodeOnly: opts.exitCodeOnly });
    suites.push(result);
  };

  await run("tsc --noEmit", ["tsc", "--noEmit"], { exitCodeOnly: true });
  await run("Phase 1: serialisation publique agent", ["tsx", "scripts/test-agent-serialization.ts"]);
  await run("Phase 1: revocation agent", ["tsx", "scripts/test-agent-revoke.ts"]);
  await run("Phase 1: renommage/appairage agent", ["tsx", "scripts/test-agent-patch-pairing.ts"]);
  await run("Phase 2: backend", ["tsx", "scripts/test-phase2-backend.ts"]);
  await run("Phase 2: frontend", ["tsx", "scripts/test-phase2-frontend.ts"]);
  await run("Phase 3: backend (protocole de commandes + legacy_vm)", ["tsx", "scripts/test-phase3-backend.ts"]);
  await run("Phase 3: frontend (legacy_vm)", ["tsx", "scripts/test-phase3-frontend.ts"]);
  await run("Lot 3: VALIDATE_BOT simule", ["tsx", "scripts/test-agent-validate-simulated.ts"]);
  await run("Lot 4: surveillance simulee", ["tsx", "scripts/test-agent-monitoring-simulated.ts"]);
  await run("Lot 5: resilience simulee", ["tsx", "scripts/test-agent-resilience-simulated.ts"]);
  await run("Bot status: simule (correctif race botStatus)", ["tsx", "scripts/test-agent-bot-status-simulated.ts"]);
  await run("Lot 6: securite finale (simule)", ["tsx", "scripts/test-agent-security-simulated.ts"]);

  const report = buildFinalReport("vm", startedAt, suites);
  printFinalSummary(report);
  writeJsonReport(path.join(process.cwd(), "artifacts/test-results/phase4-final-simulated.json"), report);

  process.exit(report.totalFailed > 0 ? 1 : 0);
};

main().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
