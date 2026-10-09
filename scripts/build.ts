/**
 * Builds a single self-contained executable (Bun runtime, dependencies and the
 * QuickJS WebAssembly module embedded).
 *   bun scripts/build.ts windows  → dist/mail-router.exe (Windows x64, baseline CPU: no AVX2 required)
 *   bun scripts/build.ts local    → dist/mail-router     (this machine, for testing)
 */
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const target = process.argv[2] ?? "windows";
const args =
  target === "windows"
    ? ["--target=bun-windows-x64-baseline", "--outfile", path.join(root, "dist", "mail-router.exe")]
    : ["--outfile", path.join(root, "dist", "mail-router")];

const result = Bun.spawnSync(
  [process.execPath, "build", path.join(root, "src", "entry.ts"), "--compile", "--minify", "--sourcemap", ...args],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
process.exit(result.exitCode ?? 1);
