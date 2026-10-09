import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import pkg from "../package.json";

export const APP_NAME = "MailRouter";
export const VERSION: string = pkg.version;
export const CONFIG_FILE = "config.json";
export const DB_FILE = "mail-router.db";

/** Private and loopback ranges: the MCP endpoint is meant for the office LAN/VPN only. */
export const PRIVATE_NETWORKS = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "::1",
];

/** A secret is `dpapi:<base64>` (Windows, LocalMachine scope), `env:NAME`, or a plain value. */
const secret = z.string().min(1);

const imapSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(993),
  secure: z.boolean().default(true),
  user: z.string().min(1),
  password: secret,
  rejectUnauthorized: z.boolean().default(true),
});

const smtpSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().default(587),
  /** true = implicit TLS (465); false = STARTTLS on a plain port (587). */
  secure: z.boolean().default(false),
  /** With secure=false, refuse to send unless the server upgrades to TLS. Disable only for local test servers. */
  requireTls: z.boolean().default(true),
  user: z.string().min(1),
  password: secret,
  rejectUnauthorized: z.boolean().default(true),
  /** Sender of forwards and replies, e.g. `Smistamento <info@example.it>`. */
  from: z.string().min(3),
});

/** Turns free text such as «info@azienda.it» into a valid account id («info-azienda-it»); "" when nothing usable is left. */
export function toAccountId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "");
}

const accountSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, "solo lettere, numeri, - e _"),
  imap: imapSchema,
  smtp: smtpSchema.optional(),
  /** Folders whose new messages are run through the rules. */
  watch: z.array(z.string().min(1)).min(1).default(["INBOX"]),
  /** Addresses of this mailbox: never forward to them (loop guard). */
  ownAddresses: z.array(z.string()).default([]),
  /** Where a copy of every message sent by the router is appended (optional). */
  sentFolder: z.string().optional(),
  /** Destination of delete_email; without it delete_email is refused. */
  trashFolder: z.string().optional(),
  /** Add the `$Forwarded` keyword to the original after an automatic forward. */
  markForwarded: z.boolean().default(true),
  /** Forward the original as an .eml attachment (keeps a PEC envelope and its signature intact). */
  forwardAsAttachment: z.boolean().default(false),
  /** After a successful automatic forward, move the original here (created if missing). */
  moveAfterForward: z.string().min(1).optional(),
});

const configSchema = z
  .object({
    instanceName: z.string().default("Mail Router"),
    timeZone: z.string().default("Europe/Rome"),
    accounts: z.array(accountSchema).min(1),
    outbound: z
      .object({
        /** Recipient domains automatic forwards may reach; empty = any. */
        allowedDomains: z.array(z.string()).default([]),
        forwardPrefix: z.string().default("I:"),
        replyPrefix: z.string().default("R:"),
      })
      .prefault({}),
    mcp: z
      .object({
        host: z.string().default("0.0.0.0"),
        port: z.number().int().positive().default(8787),
        allowedNetworks: z.array(z.string()).default(PRIVATE_NETWORKS),
        tls: z.object({ cert: z.string(), key: z.string() }).optional(),
      })
      .prefault({}),
    engine: z
      .object({
        pollSeconds: z.number().int().min(15).default(60),
        ruleTimeoutMs: z.number().int().min(10).max(5000).default(250),
        maxTextChars: z.number().int().min(1000).default(20_000),
        maxAttempts: z.number().int().min(1).default(8),
        retentionDays: z.number().int().min(7).default(180),
      })
      .prefault({}),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.accounts.forEach((account, index) => {
      if (seen.has(account.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["accounts", index, "id"],
          message: `id account duplicato: ${account.id}`,
        });
      }
      seen.add(account.id);
    });
  });

export type Config = z.infer<typeof configSchema>;
export type AccountConfig = Config["accounts"][number];
export type ConfigInput = z.input<typeof configSchema>;

export class ConfigError extends Error {}

export function defaultHome(): string {
  if (process.env.MAIL_ROUTER_HOME) return path.resolve(process.env.MAIL_ROUTER_HOME);
  if (process.platform === "win32") {
    return path.join(process.env.ProgramData ?? "C:\\ProgramData", APP_NAME);
  }
  return path.join(os.homedir(), ".mail-router");
}

export function configPath(home: string): string {
  return path.join(home, CONFIG_FILE);
}

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(radice)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Configurazione non valida:\n${issues}`);
  }
  return result.data;
}

export function loadConfig(home: string): Config {
  const file = configPath(home);
  if (!existsSync(file)) {
    throw new ConfigError(
      `Configurazione non trovata in ${file}. Esegui prima: mail-router setup`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigError(`${file} non è un JSON valido: ${(error as Error).message}`);
  }
  return parseConfig(raw);
}

export function findAccount(config: Config, accountId?: string): AccountConfig {
  if (!accountId) return config.accounts[0]!;
  const account = config.accounts.find((candidate) => candidate.id === accountId);
  if (!account) {
    const known = config.accounts.map((candidate) => candidate.id).join(", ");
    throw new Error(`Account sconosciuto "${accountId}". Account configurati: ${known}`);
  }
  return account;
}
