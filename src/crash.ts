import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runPowerShell } from "./powershell";

/** Where unexpected errors are written, so they can be sent along even after the window closed. */
export const CRASH_FILE = path.join(os.tmpdir(), "mail-router-errori.log");

export function reportCrash(context: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const header = `${new Date().toISOString()} ${context} (sistema: ${process.platform} ${os.release()}, argomenti: ${process.argv.slice(2).join(" ") || "nessuno"})`;
  try {
    appendFileSync(CRASH_FILE, `${header}\n${detail}\n\n`);
  } catch {
    // Nowhere else to write: the console below still shows it.
  }
  process.stderr.write(`\nErrore imprevisto (${context}):\n${detail}\n\nDettagli salvati in ${CRASH_FILE}\n`);
}

/** Opened by double click or from the shortcut (whose console starts minimized): there is no terminal to read. */
export function isWindowsUiLaunch(): boolean {
  const command = process.argv[2];
  return process.platform === "win32" && (command === undefined || command === "ui");
}

/** A regular Windows message box, so an error is seen even when the console is hidden or minimized. */
export function showErrorDialog(message: string): void {
  runPowerShell(
    `
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($env:MR_MESSAGE, 'Mail Router', 'OK', 'Error') | Out-Null
    `,
    { MR_MESSAGE: message },
  );
}

/** Reports a failure where the user will actually see it. */
export function reportFailure(context: string, error: unknown, expected = false): void {
  if (!expected) reportCrash(context, error);
  else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (!isWindowsUiLaunch()) return;
  const message = error instanceof Error ? error.message : String(error);
  try {
    showErrorDialog(expected ? message : `${message}\n\nDettagli in ${CRASH_FILE}`);
  } catch {
    // Without PowerShell the console text above is all we have.
  }
}
