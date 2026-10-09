import { writeFileSync } from "node:fs";

import { z } from "zod";

import { configPath, parseConfig, PRIVATE_NETWORKS, type Config, type ConfigInput } from "./config";
import { listFoldersFor } from "./check";
import { verifySmtp, type AccountRuntime } from "./mail/clients";
import { protectSecret, resolveSecret } from "./secrets";

/**
 * The shape the setup wizard and the settings page exchange with the server.
 * It covers the first account; further accounts in config.json are preserved.
 * Passwords travel only towards the server and are never sent back.
 */
const imapForm = z.object({
  host: z.string().trim().min(1, "server IMAP obbligatorio"),
  port: z.coerce.number().int().positive(),
  secure: z.boolean(),
  user: z.string().trim().min(1, "utente obbligatorio"),
  password: z.string().optional(),
  rejectUnauthorized: z.boolean().default(true),
});

const smtpForm = z.object({
  host: z.string().trim().min(1, "server SMTP obbligatorio"),
  port: z.coerce.number().int().positive(),
  secure: z.boolean(),
  user: z.string().trim().min(1, "utente SMTP obbligatorio"),
  password: z.string().optional(),
  sameAsImap: z.boolean().default(false),
  from: z.string().trim().min(3, "mittente obbligatorio"),
  requireTls: z.boolean().default(true),
  rejectUnauthorized: z.boolean().default(true),
});

export const settingsForm = z.object({
  instanceName: z.string().trim().min(1).max(80),
  imap: imapForm,
  smtp: smtpForm.nullable(),
  watch: z.array(z.string().min(1)).min(1, "scegli almeno una cartella da sorvegliare"),
  sentFolder: z.string().nullable().optional(),
  trashFolder: z.string().nullable().optional(),
  ownAddresses: z.array(z.string().trim().min(3)).default([]),
  markForwarded: z.boolean().default(true),
  forwardAsAttachment: z.boolean().default(false),
  moveAfterForward: z.string().trim().min(1).nullable().optional(),
  allowedDomains: z.array(z.string().trim().min(2)).default([]),
  mcpPort: z.coerce.number().int().min(1).max(65535).default(8787),
});

export type SettingsForm = z.infer<typeof settingsForm>;
export type ImapForm = z.infer<typeof imapForm>;
export type SmtpForm = z.infer<typeof smtpForm>;

export function parseImapForm(value: unknown): ImapForm {
  return imapForm.parse(value);
}

export function parseSmtpForm(value: unknown): SmtpForm {
  return smtpForm.parse(value);
}

/** Settings as shown in the panel: no secrets, only whether one is stored. */
export function publicSettings(config: Config) {
  const account = config.accounts[0]!;
  return {
    instanceName: config.instanceName,
    imap: { ...account.imap, password: undefined, passwordSet: true },
    smtp: account.smtp ? { ...account.smtp, password: undefined, passwordSet: true, sameAsImap: false } : null,
    watch: account.watch,
    sentFolder: account.sentFolder ?? null,
    trashFolder: account.trashFolder ?? null,
    ownAddresses: account.ownAddresses,
    markForwarded: account.markForwarded,
    forwardAsAttachment: account.forwardAsAttachment,
    moveAfterForward: account.moveAfterForward ?? null,
    allowedDomains: config.outbound.allowedDomains,
    mcpPort: config.mcp.port,
    otherAccounts: config.accounts.slice(1).map((other) => other.id),
  };
}

function plainPassword(given: string | undefined, stored: string | undefined, label: string): string {
  if (given) return given;
  if (stored) return resolveSecret(stored, label);
  throw new Error(`${label}: password obbligatoria`);
}

/** A throwaway runtime to test the credentials typed in the form (stored ones when left blank). */
export function probeRuntime(imap: ImapForm, smtp: SmtpForm | null, existing?: Config): AccountRuntime {
  const stored = existing?.accounts[0];
  const imapPassword = plainPassword(imap.password, stored?.imap.password, "IMAP");
  const smtpPassword = smtp
    ? smtp.sameAsImap
      ? imapPassword
      : plainPassword(smtp.password, stored?.smtp?.password, "SMTP")
    : null;
  return {
    config: {
      id: stored?.id ?? "posta",
      imap: { ...imap, password: "-", rejectUnauthorized: imap.rejectUnauthorized },
      smtp: smtp
        ? {
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            requireTls: smtp.requireTls,
            user: smtp.user,
            password: "-",
            rejectUnauthorized: smtp.rejectUnauthorized,
            from: smtp.from,
          }
        : undefined,
      watch: ["INBOX"],
      ownAddresses: [],
      markForwarded: true,
      forwardAsAttachment: false,
    },
    imapPassword,
    smtpPassword,
  };
}

export async function testImap(imap: ImapForm, existing?: Config) {
  return listFoldersFor(probeRuntime(imap, null, existing));
}

export async function testSmtp(imap: ImapForm, smtp: SmtpForm, existing?: Config): Promise<void> {
  await verifySmtp(probeRuntime(imap, smtp, existing));
}

/**
 * Builds the new config: typed passwords are encrypted (DPAPI on Windows),
 * blank ones keep the stored value. Everything is validated before writing.
 */
export function buildConfig(form: SettingsForm, existing?: Config): Config {
  const stored = existing?.accounts[0];
  const imapPassword = form.imap.password ? protectSecret(form.imap.password) : stored?.imap.password;
  if (!imapPassword) throw new Error("Password IMAP obbligatoria");
  let smtp: NonNullable<ConfigInput["accounts"][number]["smtp"]> | undefined;
  if (form.smtp) {
    const smtpPassword = form.smtp.sameAsImap
      ? imapPassword
      : form.smtp.password
        ? protectSecret(form.smtp.password)
        : stored?.smtp?.password;
    if (!smtpPassword) throw new Error("Password SMTP obbligatoria");
    smtp = {
      host: form.smtp.host,
      port: form.smtp.port,
      secure: form.smtp.secure,
      requireTls: form.smtp.requireTls,
      user: form.smtp.user,
      password: smtpPassword,
      rejectUnauthorized: form.smtp.rejectUnauthorized,
      from: form.smtp.from,
    };
  }
  const account: ConfigInput["accounts"][number] = {
    id: stored?.id ?? "posta",
    imap: {
      host: form.imap.host,
      port: form.imap.port,
      secure: form.imap.secure,
      user: form.imap.user,
      password: imapPassword,
      rejectUnauthorized: form.imap.rejectUnauthorized,
    },
    ...(smtp ? { smtp } : {}),
    watch: form.watch,
    ownAddresses: form.ownAddresses,
    ...(form.sentFolder ? { sentFolder: form.sentFolder } : {}),
    ...(form.trashFolder ? { trashFolder: form.trashFolder } : {}),
    markForwarded: form.markForwarded,
    forwardAsAttachment: form.forwardAsAttachment,
    ...(form.moveAfterForward ? { moveAfterForward: form.moveAfterForward } : {}),
  };
  const input: ConfigInput = {
    instanceName: form.instanceName,
    timeZone: existing?.timeZone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Rome"),
    accounts: [account, ...(existing?.accounts.slice(1) ?? [])],
    outbound: { ...(existing?.outbound ?? {}), allowedDomains: form.allowedDomains },
    mcp: { ...(existing?.mcp ?? { host: "0.0.0.0", allowedNetworks: PRIVATE_NETWORKS }), port: form.mcpPort },
    ...(existing ? { engine: existing.engine } : {}),
  };
  return parseConfig(input);
}

export function writeConfig(home: string, config: Config): void {
  writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`);
}
