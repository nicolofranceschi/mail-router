import { writeFileSync } from "node:fs";

import { z } from "zod";

import { configPath, parseConfig, PRIVATE_NETWORKS, toAccountId, type AccountConfig, type Config, type ConfigInput } from "./config";
import { listFoldersFor } from "./check";
import { verifySmtp, type AccountRuntime } from "./mail/clients";
import { protectSecret, resolveSecret } from "./secrets";

/**
 * The shapes the setup wizard and the panel exchange with the server.
 * The wizard sends one form with the first mailbox and the general settings;
 * the panel edits each mailbox on its own and the general settings apart.
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

const mailboxFields = {
  imap: imapForm,
  smtp: smtpForm.nullable(),
  watch: z.array(z.string().min(1)).min(1, "scegli almeno una cartella da sorvegliare"),
  sentFolder: z.string().nullable().optional(),
  trashFolder: z.string().nullable().optional(),
  ownAddresses: z.array(z.string().trim().min(3)).default([]),
  markForwarded: z.boolean().default(true),
  forwardAsAttachment: z.boolean().default(false),
  moveAfterForward: z.string().trim().min(1).nullable().optional(),
  markSortedRead: z.boolean().default(false),
};

const generalFields = {
  instanceName: z.string().trim().min(1).max(80),
  allowedDomains: z.array(z.string().trim().min(2)).default([]),
  mcpPort: z.coerce.number().int().min(1).max(65535).default(8787),
};

/** Wizard (and older panels): first mailbox + general settings in one form. */
export const settingsForm = z.object({ ...generalFields, ...mailboxFields });

/** One mailbox, as edited in the panel. `id` is chosen when the mailbox is added and never changes. */
export const accountForm = z.object({
  id: z
    .string()
    .trim()
    .max(40)
    .regex(/^([a-z0-9][a-z0-9_-]*)?$/i, "nome breve: solo lettere, numeri, - e _")
    .optional(),
  ...mailboxFields,
});

export const generalForm = z.object(generalFields);

export type SettingsForm = z.infer<typeof settingsForm>;
export type AccountForm = z.infer<typeof accountForm>;
export type GeneralForm = z.infer<typeof generalForm>;
export type ImapForm = z.infer<typeof imapForm>;
export type SmtpForm = z.infer<typeof smtpForm>;
type AccountInput = ConfigInput["accounts"][number];

export function parseImapForm(value: unknown): ImapForm {
  return imapForm.parse(value);
}

export function parseSmtpForm(value: unknown): SmtpForm {
  return smtpForm.parse(value);
}

/** A mailbox as shown in the panel: no secrets, only whether one is stored. */
export function publicAccount(account: AccountConfig) {
  return {
    id: account.id,
    imap: { ...account.imap, password: undefined, passwordSet: true },
    smtp: account.smtp ? { ...account.smtp, password: undefined, passwordSet: true, sameAsImap: false } : null,
    watch: account.watch,
    sentFolder: account.sentFolder ?? null,
    trashFolder: account.trashFolder ?? null,
    ownAddresses: account.ownAddresses,
    markForwarded: account.markForwarded,
    forwardAsAttachment: account.forwardAsAttachment,
    moveAfterForward: account.moveAfterForward ?? null,
    markSortedRead: account.markSortedRead,
  };
}

export function publicGeneral(config: Config) {
  return {
    instanceName: config.instanceName,
    allowedDomains: config.outbound.allowedDomains,
    mcpPort: config.mcp.port,
  };
}

/** Settings as shown in the panel: the first mailbox flattened (older shape) plus every mailbox. */
export function publicSettings(config: Config) {
  return {
    ...publicGeneral(config),
    ...publicAccount(config.accounts[0]!),
    otherAccounts: config.accounts.slice(1).map((other) => other.id),
  };
}

function plainPassword(given: string | undefined, stored: string | undefined, label: string): string {
  if (given) return given;
  if (stored) return resolveSecret(stored, label);
  throw new Error(`${label}: password obbligatoria`);
}

/** A throwaway runtime to test the credentials typed in the form (the stored mailbox's ones when left blank). */
export function probeRuntime(imap: ImapForm, smtp: SmtpForm | null, stored?: AccountConfig): AccountRuntime {
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
      markSortedRead: false,
    },
    imapPassword,
    smtpPassword,
  };
}

export async function testImap(imap: ImapForm, stored?: AccountConfig) {
  return listFoldersFor(probeRuntime(imap, null, stored));
}

export async function testSmtp(imap: ImapForm, smtp: SmtpForm, stored?: AccountConfig): Promise<void> {
  await verifySmtp(probeRuntime(imap, smtp, stored));
}

/** The stored mailbox a panel request refers to (null for a new one). */
export function storedAccount(config: Config, id: unknown): AccountConfig | undefined {
  return typeof id === "string" && id ? config.accounts.find((account) => account.id === id) : undefined;
}

/** Typed passwords are encrypted; blank ones keep the stored value. */
function buildAccount(id: string, form: Omit<AccountForm, "id">, stored?: AccountConfig): AccountInput {
  const imapPassword = form.imap.password ? protectSecret(form.imap.password) : stored?.imap.password;
  if (!imapPassword) throw new Error("Password IMAP obbligatoria");
  let smtp: AccountInput["smtp"];
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
  return {
    id,
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
    markSortedRead: form.markSortedRead,
  };
}

/** Wizard: a whole new config (or the first mailbox and general settings of an existing one, the rest kept). */
export function buildConfig(form: SettingsForm, existing?: Config): Config {
  const stored = existing?.accounts[0];
  const account = buildAccount(stored?.id ?? "posta", form, stored);
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

/** A free id for a new mailbox, from the one asked for or the IMAP user («info@azienda.it» → «info-azienda-it»). */
export function newAccountId(config: Config, wanted: string | undefined, imapUser: string): string {
  const base = toAccountId(wanted || imapUser) || "posta";
  const taken = new Set(config.accounts.map((account) => account.id.toLowerCase()));
  if (wanted && taken.has(base.toLowerCase())) throw new Error(`Esiste già una casella con nome «${base}»`);
  let id = base;
  for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Adds a mailbox (editingId null) or replaces the one with that id, keeping
 * its position and its stored passwords when left blank.
 */
export function saveAccount(config: Config, editingId: string | null, form: AccountForm): { config: Config; id: string } {
  const accounts = config.accounts.map((account) => structuredClone(account) as AccountInput);
  if (editingId) {
    const index = config.accounts.findIndex((account) => account.id === editingId);
    if (index < 0) throw new Error(`Casella sconosciuta: ${editingId}`);
    accounts[index] = buildAccount(editingId, form, config.accounts[index]);
    return { config: parseConfig({ ...config, accounts }), id: editingId };
  }
  const id = newAccountId(config, form.id, form.imap.user);
  accounts.push(buildAccount(id, form));
  return { config: parseConfig({ ...config, accounts }), id };
}

/** Removes a mailbox; the last one cannot go (the service needs at least one). */
export function removeAccount(config: Config, id: string): Config {
  if (!config.accounts.some((account) => account.id === id)) throw new Error(`Casella sconosciuta: ${id}`);
  if (config.accounts.length === 1) throw new Error("È l'unica casella configurata: aggiungine un'altra prima di eliminarla");
  return parseConfig({ ...config, accounts: config.accounts.filter((account) => account.id !== id) });
}

export function applyGeneral(config: Config, form: GeneralForm): Config {
  return parseConfig({
    ...config,
    instanceName: form.instanceName,
    outbound: { ...config.outbound, allowedDomains: form.allowedDomains },
    mcp: { ...config.mcp, port: form.mcpPort },
  });
}

export function writeConfig(home: string, config: Config): void {
  writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`);
}
