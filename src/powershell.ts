import path from "node:path";

/**
 * Runs a Windows PowerShell script. The script travels as -EncodedCommand
 * (UTF-16LE base64), so quotes, `$` and newlines need no command-line escaping;
 * values travel as environment variables. The absolute path avoids depending
 * on PATH, which is minimal for a task running as SYSTEM.
 */
export function runPowerShell(
  script: string,
  env: Record<string, string> = {},
  options: { interactive?: boolean } = {},
): { ok: boolean; exitCode: number; out: string; err: string } {
  const exe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const args = [exe, "-NoProfile", "-ExecutionPolicy", "Bypass"];
  if (!options.interactive) args.push("-NonInteractive");
  args.push("-EncodedCommand", encoded);
  const result = Bun.spawnSync(args, {
    env: { ...process.env, ...env },
    stdin: options.interactive ? "inherit" : "ignore",
    stdout: "pipe",
    stderr: options.interactive ? "inherit" : "pipe",
  });
  const exitCode = result.exitCode ?? 1;
  return {
    ok: exitCode === 0,
    exitCode,
    out: result.stdout ? result.stdout.toString().trim() : "",
    err: result.stderr ? result.stderr.toString().trim() : "",
  };
}
