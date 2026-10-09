import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

type Level = "debug" | "info" | "warn" | "error";

const RING_SIZE = 1000;
const KEEP_DAYS = 14;

/**
 * Line logger: stdout plus one file per day under <home>/logs, and an
 * in-memory tail that the MCP `get_logs` tool can read remotely.
 */
export class Logger {
  private readonly ring: string[] = [];
  private dir: string | null = null;
  private lastPrune = "";

  attachDirectory(home: string): void {
    this.dir = path.join(home, "logs");
    mkdirSync(this.dir, { recursive: true });
  }

  debug(message: string, data?: unknown): void {
    if (process.env.MAIL_ROUTER_DEBUG) this.write("debug", message, data);
  }
  info(message: string, data?: unknown): void {
    this.write("info", message, data);
  }
  warn(message: string, data?: unknown): void {
    this.write("warn", message, data);
  }
  error(message: string, data?: unknown): void {
    this.write("error", message, data);
  }

  tail(lines: number, minLevel: Level = "info"): string[] {
    const order: Level[] = ["debug", "info", "warn", "error"];
    const min = order.indexOf(minLevel);
    return this.ring
      .filter((line) => order.indexOf(line.split(" ", 3)[1]!.toLowerCase() as Level) >= min)
      .slice(-lines);
  }

  private write(level: Level, message: string, data?: unknown): void {
    const now = new Date();
    const suffix = data === undefined ? "" : ` ${formatData(data)}`;
    const line = `${now.toISOString()} ${level.toUpperCase()} ${message}${suffix}`;
    this.ring.push(line);
    if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE);
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
    if (!this.dir) return;
    const day = now.toISOString().slice(0, 10);
    try {
      appendFileSync(path.join(this.dir, `mail-router-${day}.log`), `${line}\n`);
      if (this.lastPrune !== day) {
        this.lastPrune = day;
        this.prune(now);
      }
    } catch {
      // A full disk must not take the service down with it.
    }
  }

  private prune(now: Date): void {
    if (!this.dir) return;
    const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    for (const name of readdirSync(this.dir)) {
      const match = /^mail-router-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (match && match[1]! < cutoff) rmSync(path.join(this.dir, name), { force: true });
    }
  }
}

function formatData(data: unknown): string {
  if (data instanceof Error) return data.stack ?? data.message;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const extra = (error as { responseText?: string; response?: string }).responseText ??
      (error as { response?: string }).response;
    return extra && !error.message.includes(extra) ? `${error.message} (${extra})` : error.message;
  }
  return String(error);
}

export const log = new Logger();
