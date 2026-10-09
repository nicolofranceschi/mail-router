import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Store } from "./store";

/**
 * One access key opens both doors: Claude's MCP connection (Bearer header)
 * and the control panel login. Only its SHA-256 is stored.
 */
const KEY_META = "mcp_token_sha256";
export const SESSION_COOKIE = "mr_session";
export const SESSION_TTL_MS = 12 * 60 * 60_000;
export const ONCE_TTL_MS = 5 * 60_000;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(prefix = ""): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/** Generates a new access key, stores only its hash and returns the key (shown once). */
export function rotateToken(store: Store): string {
  const token = randomToken("mr_");
  store.setMeta(KEY_META, sha256Hex(token));
  return token;
}

export function hasToken(store: Store): boolean {
  return Boolean(store.getMeta(KEY_META));
}

export function tokenMatches(store: Store, provided: string): boolean {
  const stored = store.getMeta(KEY_META);
  if (!stored || !provided) return false;
  return timingSafeEqual(Buffer.from(sha256Hex(provided), "hex"), Buffer.from(stored, "hex"));
}

/** A single-use login link for the panel, valid a few minutes (created by an elevated local process). */
export function createOnceToken(store: Store): string {
  const token = randomToken();
  store.addUiToken(sha256Hex(token), "once", ONCE_TTL_MS);
  return token;
}

export function createSession(store: Store): string {
  const token = randomToken();
  store.addUiToken(sha256Hex(token), "session", SESSION_TTL_MS);
  return token;
}

export function sessionCookie(token: string, maxAgeSeconds = SESSION_TTL_MS / 1000): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function bearerToken(request: Request): string {
  return /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim() ?? "";
}

// ---- network allowlist -------------------------------------------------

type Network = { kind: "v4"; base: number; mask: number } | { kind: "v6"; address: string } | { kind: "any" };

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

export function parseNetworks(entries: string[]): Network[] {
  return entries.map((entry) => {
    const trimmed = entry.trim();
    if (trimmed === "*" || trimmed === "0.0.0.0/0" || trimmed === "any") return { kind: "any" };
    const [address, bitsText] = trimmed.split("/");
    const base = ipv4ToInt(address ?? "");
    if (base !== null) {
      const bits = bitsText === undefined ? 32 : Number(bitsText);
      if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error(`Rete non valida: ${entry}`);
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return { kind: "v4", base: (base & mask) >>> 0, mask };
    }
    return { kind: "v6", address: trimmed.toLowerCase() };
  });
}

export function ipAllowed(networks: Network[], rawAddress: string): boolean {
  const address = rawAddress.toLowerCase().replace(/^::ffff:/, "");
  const v4 = ipv4ToInt(address);
  return networks.some((network) => {
    if (network.kind === "any") return true;
    if (network.kind === "v6") return network.address === address;
    return v4 !== null && ((v4 & network.mask) >>> 0) === network.base;
  });
}

/** Per-IP brake on wrong keys. */
export class FailureLimiter {
  private readonly failures = new Map<string, { count: number; since: number }>();

  constructor(private readonly maxPerMinute = 10) {}

  blocked(ip: string): boolean {
    const window = this.failures.get(ip);
    return Boolean(window && Date.now() - window.since < 60_000 && window.count >= this.maxPerMinute);
  }

  fail(ip: string): void {
    const window = this.failures.get(ip);
    const current = window && Date.now() - window.since < 60_000 ? window : { count: 0, since: Date.now() };
    current.count++;
    this.failures.set(ip, current);
  }

  reset(ip: string): void {
    this.failures.delete(ip);
  }
}
