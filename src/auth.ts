import { createHash, randomBytes } from "node:crypto";

import type { Store, UserRole, UserRow } from "./store";

/**
 * Every user has an own access key: it opens both doors, Claude's MCP
 * connection (Bearer header) and the control panel login. Only its SHA-256 is
 * stored, plus the last characters to tell keys apart. The role decides what
 * the key may do: an administrator manages mailboxes, settings and users, an
 * operator works with rules, data and mail.
 */
export const SESSION_COOKIE = "mr_session";
export const SESSION_TTL_MS = 12 * 60 * 60_000;
export const ONCE_TTL_MS = 5 * 60_000;
const TOUCH_EVERY_MS = 60_000;

export type Role = UserRole;
export type User = UserRow;

export const ROLE_LABEL: Record<Role, string> = { admin: "amministratore", operator: "operatore" };

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(prefix = ""): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function newKey(): { key: string; hash: string; hint: string } {
  const key = randomToken("mr_");
  return { key, hash: sha256Hex(key), hint: key.slice(-4) };
}

export function newUserId(): string {
  return `u_${randomBytes(5).toString("hex")}`;
}

/** Creates a user with a fresh key; the key is returned once and never stored. */
export function createUser(store: Store, name: string, role: Role): { user: User; key: string } {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Il nome dell'utente è obbligatorio");
  if (store.listUsers().some((user) => user.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`Esiste già un utente di nome «${trimmed}»`);
  }
  const { key, hash, hint } = newKey();
  const user = store.createUser({ id: newUserId(), name: trimmed, role, keyHash: hash, keyHint: hint });
  return { user, key };
}

/** Replaces a user's key: the old one stops working at once (open panel sessions stay valid). */
export function rotateUserKey(store: Store, userId: string): string {
  const { key, hash, hint } = newKey();
  if (!store.setUserKey(userId, hash, hint)) throw new Error("Utente non trovato");
  return key;
}

/** The main administrator, created when there is none (first run, or a database from before users). */
export function ensureAdmin(store: Store): { user: User; key: string | null } {
  const existing = store.mainAdmin();
  if (existing) return { user: existing, key: null };
  const taken = new Set(store.listUsers().map((user) => user.name.toLowerCase()));
  let name = "Amministratore";
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `Amministratore ${n}`;
  return createUser(store, name, "admin");
}

/** New key for the main administrator (CLI «token», setup): returns the key, shown once. */
export function rotateToken(store: Store): string {
  const { user, key } = ensureAdmin(store);
  return key ?? rotateUserKey(store, user.id);
}

export function hasToken(store: Store): boolean {
  return store.countUsers() > 0;
}

/** The user whose key this is, or null. Records the use (at most once a minute). */
export function authenticateKey(store: Store, provided: string): User | null {
  if (!provided) return null;
  const user = store.userByKeyHash(sha256Hex(provided));
  if (!user) return null;
  if (!user.last_used_at || Date.now() - Date.parse(user.last_used_at) > TOUCH_EVERY_MS) store.touchUser(user.id);
  return user;
}

export function tokenMatches(store: Store, provided: string): boolean {
  return authenticateKey(store, provided) !== null;
}

/** A single-use login link for the panel, valid a few minutes (created by an elevated local process): it logs in the main administrator. */
export function createOnceToken(store: Store, userId?: string): string {
  const token = randomToken();
  store.addUiToken(sha256Hex(token), "once", ONCE_TTL_MS, userId ?? ensureAdmin(store).user.id);
  return token;
}

export function createSession(store: Store, userId: string): string {
  const token = randomToken();
  store.addUiToken(sha256Hex(token), "session", SESSION_TTL_MS, userId);
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
