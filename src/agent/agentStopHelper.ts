import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadAgentSettings } from "./agentSettings.js";
import { getStateDir } from "./agentStorage.js";

// Phase 5 (Lot 3, section 9/11): petit outil autonome utilise par
// l'installateur (mise a niveau) et la desinstallation pour demander un
// ARRET GRACIEUX de l'instance active AVANT de remplacer/supprimer les
// fichiers programme - reutilise le verrou mono-instance (Lot 2, contient
// deja le port de l'interface locale) et la sequence d'arret complete deja
// implementee dans agentMain.ts (POST /local/quit: bots arretes, Chrome
// ferme, buffer/socket/interface locale/verrou liberes) plutot que de
// reimplementer cette logique en Pascal (Inno Setup) ou de tuer le process
// brutalement en premier recours.
//
// Code de sortie: 0 = arret demande avec succes (ou aucune instance active),
// 1 = instance active mais impossible a arreter proprement (l'appelant -
// Inno Setup - doit alors recourir a un fallback taskkill borne par PID,
// jamais un "taskkill /IM node.exe" global).
//
// Usage: RendezBotAgent.exe agent/agentStopHelper.js

const main = async (): Promise<void> => {
  const settings = loadAgentSettings();
  const lockPath = path.join(getStateDir(settings), "agent.lock");

  if (!existsSync(lockPath)) {
    console.log("Aucune instance active (verrou absent).");
    return;
  }

  let lock: { pid?: number; localUiPort?: number | null };
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    console.log("Verrou illisible: aucune action possible depuis cet outil.");
    process.exitCode = 1;
    return;
  }

  if (!lock.localUiPort) {
    console.log(`Instance active (PID ${lock.pid ?? "inconnu"}) mais interface locale inconnue - arret gracieux impossible depuis cet outil.`);
    process.exitCode = 1;
    return;
  }

  const base = `http://127.0.0.1:${lock.localUiPort}`;
  try {
    const statusRes = await fetch(`${base}/local/status`, { signal: AbortSignal.timeout(5_000) });
    const status = await statusRes.json();
    await fetch(`${base}/local/quit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: status.nonce }),
      signal: AbortSignal.timeout(5_000)
    });
    console.log(`Arret gracieux demande (PID ${lock.pid ?? "inconnu"}).`);
  } catch (error) {
    console.log(`Interface locale injoignable (${error instanceof Error ? error.message : String(error)}) - fallback necessaire.`);
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
