/**
 * What a double click does. Opening the panel needs administrator rights on
 * Windows (the data folder, the one-time login link and the installation are
 * protected), so the clicked process asks UAC for an elevated helper, waits
 * for the address it publishes, and opens it — non-elevated — in an app-style
 * window. On first run the helper serves the setup wizard instead.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { createOnceToken } from "./auth";
import { configPath, DB_FILE, loadConfig } from "./config";
import { errorMessage } from "./log";
import { Store } from "./store";
import { startSetupServer } from "./web/setup";
import {
  installService,
  isAdmin,
  openAppWindow,
  openFromElevated,
  relaunchElevated,
  serviceTaskExists,
  startServiceTask,
} from "./service/windows";

/** Problems the user can act on: shown as they are, without a crash report. */
export class UserFacingError extends Error {}

async function healthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy(port)) return true;
    await Bun.sleep(1000);
  }
  return false;
}

/** Elevated side: the address to open, plus — for the wizard — when this process may exit. */
async function prepareUi(home: string): Promise<{ url: string; done?: Promise<void> }> {
  if (!existsSync(configPath(home))) return startSetupServer(home);

  const config = loadConfig(home);
  const port = config.mcp.port;
  if (!(await healthy(port))) {
    if (process.platform !== "win32") {
      throw new Error("Il servizio non è in esecuzione: avvialo con «mail-router run»");
    }
    if (serviceTaskExists()) startServiceTask();
    else await installService({ home, firewallRemote: ["LocalSubnet"] });
    if (!(await waitHealthy(port, 60_000))) {
      throw new Error(`Il servizio non risponde sulla porta ${port}. Controlla i log in ${path.join(home, "logs")}`);
    }
  }
  const store = new Store(path.join(home, DB_FILE));
  try {
    return { url: `http://127.0.0.1:${port}/?once=${createOnceToken(store)}` };
  } finally {
    store.close();
  }
}

/** `ui-helper`: runs elevated, publishes the address (or the error) in a file for the launcher. */
export async function runUiHelper(home: string, outFile: string): Promise<void> {
  let prepared: { url: string; done?: Promise<void> };
  try {
    prepared = await prepareUi(home);
  } catch (error) {
    await Bun.write(outFile, JSON.stringify({ error: errorMessage(error) }));
    throw error;
  }
  await Bun.write(outFile, JSON.stringify({ url: prepared.url }));
  await prepared.done;
}

function openInBrowser(url: string): void {
  const command = process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
  Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
}

export async function openUi(home: string): Promise<void> {
  if (process.platform !== "win32") {
    const prepared = await prepareUi(home);
    console.log(`Pannello: ${prepared.url}`);
    openInBrowser(prepared.url);
    await prepared.done;
    return;
  }

  if (isAdmin()) {
    const prepared = await prepareUi(home);
    openFromElevated(prepared.url);
    if (prepared.done) {
      console.log("Procedura guidata aperta nel browser. Lascia aperta questa finestra fino alla fine.");
      await prepared.done;
    }
    return;
  }

  console.log("Apro Mail Router… conferma la richiesta di Windows per continuare.");
  const outFile = path.join(os.tmpdir(), `mail-router-ui-${randomUUID()}.json`);
  if (!relaunchElevated(`ui-helper --home "${home}" --out "${outFile}"`)) {
    throw new UserFacingError("Per aprire Mail Router serve confermare la richiesta di amministratore di Windows.");
  }
  const deadline = Date.now() + 3 * 60_000;
  while (!existsSync(outFile)) {
    if (Date.now() > deadline) throw new UserFacingError("Mail Router non ha risposto in tempo: riprova.");
    await Bun.sleep(400);
  }
  await Bun.sleep(100);
  const result = JSON.parse(readFileSync(outFile, "utf8")) as { url?: string; error?: string };
  rmSync(outFile, { force: true });
  if (!result.url) throw new UserFacingError(result.error ?? "Risposta non valida dal servizio.");
  openAppWindow(result.url);
}
