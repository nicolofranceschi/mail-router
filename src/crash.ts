import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where unexpected errors are written, so they can be sent along later. */
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

/** Expected problems (configuration, missing key…) as a plain message; anything else with its stack. */
export function reportFailure(context: string, error: unknown, expected = false): void {
  if (!expected) reportCrash(context, error);
  else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
}
