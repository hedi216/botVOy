// Test automatise (pas de framework de test dans ce projet, cf. scripts/test-agent-phase1.ts
// pour le meme style): verifie que toPublicAgent() est bien l'unique porte de sortie pour un
// agent expose au frontend/aux evenements socket, et qu'aucun secret ne peut s'y glisser.
//
// Verifie:
// 1) la liste des cles du resultat de toPublicAgent() est un sous-ensemble strict de la liste
//    blanche attendue (aucune cle exotique/future ne peut apparaitre sans etre revue ici) ;
// 2) aucune cle ne contient token, secret, password, code_hash ou codeHash (insensible a la casse) ;
// 3) la valeur de token_hash presente dans la ligne DB source n'apparait nulle part dans le
//    JSON serialise du resultat (protection contre une fuite de valeur sous une cle inattendue) ;
// 4) aucun appel logger.*() dans les modules agent ne fait apparaitre token/secret/password/hash
//    dans le message logge (analyse statique du code source).

import { readFileSync } from "node:fs";
import path from "node:path";
import { DbAgent } from "../src/db.js";
import { toPublicAgent } from "../src/agentService.js";

const FORBIDDEN_KEY_SUBSTRINGS = ["token", "secret", "password", "code_hash", "codehash"];

const ALLOWED_KEYS = new Set([
  "agentId",
  "agencyId",
  "name",
  "computerName",
  "version",
  "status",
  "pairedAt",
  "lastSeenAt",
  "activeBotCount",
  "createdAt",
  "updatedAt",
  "revokedAt"
]);

const failures: string[] = [];

const fail = (message: string): void => {
  failures.push(message);
  console.error(`[FAIL] ${message}`);
};

const pass = (message: string): void => {
  console.log(`[PASS] ${message}`);
};

// Ligne DB fictive, avec un token_hash volontairement reconnaissable pour verifier
// qu'il ne fuite nulle part dans la sortie publique.
const SENTINEL_TOKEN_HASH = "scrypt:deadbeefcafebabe:5ecr3t0nlyth3s3rv3rsh0uldev3rs33th15v4lu3";

const mockAgent: DbAgent = {
  id: 42,
  agency_id: 7,
  name: "PC Reception",
  computer_name: "AGENCE-PC-01",
  version: "1.2.3",
  status: "active",
  token_hash: SENTINEL_TOKEN_HASH,
  paired_at: "2026-01-01T00:00:00.000Z",
  last_seen_at: "2026-01-02T00:00:00.000Z",
  revoked_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z"
};

// --- 1) Verification de la sortie de toPublicAgent() ---

const publicAgent = toPublicAgent(mockAgent, "CONNECTED", 3);
const actualKeys = Object.keys(publicAgent);

const unexpectedKeys = actualKeys.filter((key) => !ALLOWED_KEYS.has(key));
if (unexpectedKeys.length > 0) {
  fail(`toPublicAgent() expose des cles hors liste blanche: ${unexpectedKeys.join(", ")}`);
} else {
  pass(`toPublicAgent() n'expose que des cles de la liste blanche (${actualKeys.length} cles).`);
}

const keysWithForbiddenSubstring = actualKeys.filter((key) =>
  FORBIDDEN_KEY_SUBSTRINGS.some((forbidden) => key.toLowerCase().includes(forbidden))
);
if (keysWithForbiddenSubstring.length > 0) {
  fail(`Cles sensibles detectees dans toPublicAgent(): ${keysWithForbiddenSubstring.join(", ")}`);
} else {
  pass("Aucune cle de toPublicAgent() ne contient token/secret/password/code_hash/codeHash.");
}

const serialized = JSON.stringify(publicAgent);
if (serialized.includes(SENTINEL_TOKEN_HASH)) {
  fail("La valeur de token_hash apparait dans le JSON serialise de toPublicAgent().");
} else {
  pass("La valeur de token_hash n'apparait pas dans le JSON serialise de toPublicAgent().");
}

if ("token_hash" in (publicAgent as Record<string, unknown>)) {
  fail("La cle token_hash est presente sur l'objet retourne par toPublicAgent().");
} else {
  pass("La cle token_hash n'est pas presente sur l'objet retourne par toPublicAgent().");
}

// --- 2) Analyse statique: aucun logger.*() ne doit exposer un secret ---

const projectRoot = path.join(process.cwd());
const filesToScan = [
  "src/agentService.ts",
  "src/agentGateway.ts",
  "src/server.ts"
];

const LOGGER_CALL_PATTERN = /logger\.(info|warn|error|success)\(([^;]*?\));/gs;
const FORBIDDEN_IN_LOG_MESSAGE = /token|secret|password|code_hash|codehash/i;

for (const relativePath of filesToScan) {
  const fullPath = path.join(projectRoot, relativePath);
  const content = readFileSync(fullPath, "utf8");
  const matches = [...content.matchAll(LOGGER_CALL_PATTERN)];

  const offendingCalls = matches
    .map((match) => match[0])
    .filter((call) => FORBIDDEN_IN_LOG_MESSAGE.test(call));

  if (offendingCalls.length > 0) {
    fail(`${relativePath}: appel(s) logger suspect(s) mentionnant un secret: ${offendingCalls.join(" | ")}`);
  } else {
    pass(`${relativePath}: aucun appel logger ne mentionne token/secret/password/code_hash (${matches.length} appel(s) logger analyse(s)).`);
  }
}

// --- Bilan ---

if (failures.length > 0) {
  console.error(`\n${failures.length} verification(s) en echec.`);
  process.exit(1);
}

console.log("\nToutes les verifications de serialisation publique des agents sont passees.");
process.exit(0);
