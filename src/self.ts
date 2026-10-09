import path from "node:path";

/** How to start this same program again: the compiled exe itself, or `bun <entry script>` in development. */
export function selfCommand(): string[] {
  const runtime = path.basename(process.execPath).toLowerCase().replace(/\.exe$/, "");
  const isBunRuntime = runtime === "bun" || runtime === "bun-debug";
  return isBunRuntime ? [process.execPath, Bun.main] : [process.execPath];
}
