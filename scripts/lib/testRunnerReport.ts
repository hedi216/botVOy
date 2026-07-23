// Lot 6 (section 4/5): infrastructure partagee des runners de regression
// finale. Chaque sous-test reste un script INDEPENDANT (son propre process
// serveur/agent/DB/nettoyage): ce module se contente de les executer en
// enfant, mesurer leur duree, extraire leur resultat, et produire un
// rapport JSON assaini (jamais de secret/chemin sensible/HTML).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export type SuiteStatus = "passed" | "failed" | "skipped";

export type SuiteResult = {
  name: string;
  status: SuiteStatus;
  durationMs: number;
  passed: number;
  failed: number;
  // Jamais de stack trace complete (section 5): un resume court seulement.
  errorSummary?: string;
};

export type FinalReport = {
  startedAt: string;
  finishedAt: string;
  environment: "vm" | "windows-interactive";
  commit: string;
  suites: SuiteResult[];
  totalPassed: number;
  totalFailed: number;
};

export const getCommitHash = (): string => {
  try {
    return execSync("git rev-parse HEAD", { cwd: process.cwd() }).toString().trim();
  } catch {
    return "unknown";
  }
};

// Un message d'erreur reste utile pour diagnostiquer un prerequis manquant
// (port deja utilise, Postgres injoignable, Chrome introuvable) sans jamais
// exposer un chemin absolu du poste ou un secret.
const sanitizeErrorSummary = (raw: string): string => raw
  .replace(/[A-Za-z]:\\[^\s"]+/g, "[chemin]")
  .replace(/\/(home|Users)\/[^\s"]+/g, "[chemin]")
  .slice(0, 400);

const RESULT_LINE_PATTERN = /(\d+)\s+succes,\s+(\d+)\s+echec/i;

export type RunScriptOptions = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  // Si vrai, l'absence du motif "N succes, M echec(s)" dans stdout n'est pas
  // une erreur (ex: tsc --noEmit n'affiche pas ce format) - seul le code de
  // sortie du process determine passed/failed (1/0 respectivement).
  exitCodeOnly?: boolean;
};

// Execute UN sous-test en process enfant independant et retourne son
// resultat. Ne lance JAMAIS deux suites reelles en parallele (section 4):
// c'est a l'appelant de les executer sequentiellement (await en boucle),
// jamais via Promise.all.
export const runScript = (options: RunScriptOptions): Promise<SuiteResult> => new Promise((resolve) => {
  const startedAt = Date.now();
  const child = spawn(options.command, options.args, {
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });

  let output = "";
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const timer = setTimeout(() => {
    // Jamais convertir un TimeoutError en succes (section 5): un depassement
    // de delai est toujours un echec explicite, jamais un skip silencieux.
    child.kill();
    finish(1, "TimeoutError: le sous-test a depasse le delai maximum.");
  }, timeoutMs);

  const finish = (exitCode: number, forcedErrorSummary?: string): void => {
    clearTimeout(timer);
    const durationMs = Date.now() - startedAt;
    const match = output.match(RESULT_LINE_PATTERN);

    if (forcedErrorSummary) {
      resolve({ name: options.name, status: "failed", durationMs, passed: 0, failed: 1, errorSummary: sanitizeErrorSummary(forcedErrorSummary) });
      return;
    }

    if (options.exitCodeOnly || !match) {
      const status: SuiteStatus = exitCode === 0 ? "passed" : "failed";
      resolve({
        name: options.name,
        status,
        durationMs,
        passed: status === "passed" ? 1 : 0,
        failed: status === "passed" ? 0 : 1,
        errorSummary: status === "failed" ? sanitizeErrorSummary(output.slice(-400)) : undefined
      });
      return;
    }

    const passed = Number(match[1]);
    const failed = Number(match[2]);
    resolve({
      name: options.name,
      status: failed > 0 || exitCode !== 0 ? "failed" : "passed",
      durationMs,
      passed,
      failed,
      errorSummary: (failed > 0 || exitCode !== 0) ? sanitizeErrorSummary(output.slice(-400)) : undefined
    });
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  });

  child.once("exit", (code) => finish(code ?? 1));
  child.once("error", (error) => finish(1, error.message));
});

export const printSuiteHeader = (name: string): void => {
  console.log(`\n${"=".repeat(70)}\n[SUITE] ${name}\n${"=".repeat(70)}`);
};

export const printFinalSummary = (report: FinalReport): void => {
  console.log(`\n${"=".repeat(70)}`);
  console.log("RESUME FINAL");
  console.log("=".repeat(70));
  for (const suite of report.suites) {
    const icon = suite.status === "passed" ? "[PASS]" : suite.status === "skipped" ? "[SKIP]" : "[FAIL]";
    console.log(`${icon} ${suite.name} - ${suite.passed} succes / ${suite.failed} echec(s) - ${suite.durationMs}ms${suite.errorSummary ? ` - ${suite.errorSummary}` : ""}`);
  }
  console.log(`\nTotal: ${report.totalPassed} succes, ${report.totalFailed} echec(s).`);
};

export const writeJsonReport = (filePath: string, report: FinalReport): void => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nRapport JSON ecrit: ${filePath}`);
};

export const buildFinalReport = (
  environment: FinalReport["environment"],
  startedAt: string,
  suites: SuiteResult[]
): FinalReport => ({
  startedAt,
  finishedAt: new Date().toISOString(),
  environment,
  commit: getCommitHash(),
  suites,
  totalPassed: suites.reduce((sum, s) => sum + s.passed, 0),
  totalFailed: suites.reduce((sum, s) => sum + s.failed, 0)
});
