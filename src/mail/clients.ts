import { createHash } from "node:crypto";

import { ImapFlow } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";

import type { AccountConfig } from "../config";
import { errorMessage, log } from "../log";

/** An account with its secrets already resolved (kept in memory only). */
export interface AccountRuntime {
  config: AccountConfig;
  imapPassword: string;
  smtpPassword: string | null;
}

export function createImapClient(account: AccountRuntime, purpose: string, options: { autoIdleDelayMs?: number } = {}): ImapFlow {
  const { imap } = account.config;
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: imap.user, pass: account.imapPassword },
    tls: { rejectUnauthorized: imap.rejectUnauthorized },
    logger: false,
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    // Re-issue IDLE regularly so NAT gateways and firewalls keep the session open.
    maxIdleTime: 5 * 60_000,
    ...(options.autoIdleDelayMs !== undefined ? { autoIdleDelay: options.autoIdleDelayMs } : {}),
  });
  client.on("error", (error: unknown) => {
    log.warn(`[${account.config.id}] IMAP (${purpose}): ${errorMessage(error)}`);
  });
  return client;
}

/** One short-lived connection per operation: simple, and nothing to keep in sync. */
export async function withImap<T>(account: AccountRuntime, purpose: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = createImapClient(account, purpose);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

type SmtpConfig = NonNullable<AccountRuntime["config"]["smtp"]>;

function requireSmtp(account: AccountRuntime): { smtp: SmtpConfig; password: string } {
  const smtp = account.config.smtp;
  if (!smtp || account.smtpPassword === null) {
    throw new Error(`L'account ${account.config.id} non ha un server SMTP configurato: non può inviare`);
  }
  return { smtp, password: account.smtpPassword };
}

function createTransport(smtp: SmtpConfig, password: string): Transporter {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure && smtp.requireTls,
    auth: { user: smtp.user, pass: password },
    tls: { rejectUnauthorized: smtp.rejectUnauthorized },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
  });
}

/** Turns socket/TLS/auth failures into a sentence that says where and what to change. */
export function describeSmtpError(error: unknown, smtp: Pick<SmtpConfig, "host" | "port">): string {
  const where = `${smtp.host}:${smtp.port}`;
  const message = errorMessage(error);
  const code = (error as { code?: string }).code ?? "";
  if (/ENOTFOUND|EAI_AGAIN/.test(message) || code === "EDNS") return `Server SMTP «${smtp.host}» non trovato: controlla il nome.`;
  if (/ECONNREFUSED/.test(message)) return `Connessione rifiutata da ${where}: su questa porta il server non accetta SMTP (porta chiusa).`;
  if (/wrong version number|EPROTO|ssl3_get_record|unknown protocol/i.test(message)) {
    return `${where}: impostazione SSL non adatta alla porta. Con 587 togli «SSL diretto», con 465 mettilo.`;
  }
  if (/ETIMEDOUT|timeout/i.test(message) || code === "ETIMEDOUT") {
    return `Nessuna risposta da ${where}: porta bloccata da un firewall o server non raggiungibile da questa rete.`;
  }
  if (code === "EAUTH" || /\b535\b|authentication/i.test(message)) return `${where}: utente o password non accettati (${message}).`;
  if (/STARTTLS/i.test(message)) return `${where}: il server non offre STARTTLS (${message}). Prova a togliere «Richiedi cifratura STARTTLS».`;
  return `${where}: ${message}`;
}

function withSmtpContext(error: unknown, smtp: SmtpConfig): Error {
  const wrapped = new Error(describeSmtpError(error, smtp));
  // Keep the SMTP reply code: the executor uses it to tell permanent failures from transient ones.
  const { code, responseCode } = error as { code?: string; responseCode?: number };
  Object.assign(wrapped, { code, responseCode });
  return wrapped;
}

/** One transport per account for sending, rebuilt as soon as its settings change. */
const transports = new Map<string, { fingerprint: string; transport: Transporter }>();

function transportFor(account: AccountRuntime): { smtp: SmtpConfig; transport: Transporter } {
  const { smtp, password } = requireSmtp(account);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([smtp.host, smtp.port, smtp.secure, smtp.requireTls, smtp.user, smtp.rejectUnauthorized, password]))
    .digest("hex");
  const cached = transports.get(account.config.id);
  if (cached && cached.fingerprint === fingerprint) return { smtp, transport: cached.transport };
  cached?.transport.close();
  const transport = createTransport(smtp, password);
  transports.set(account.config.id, { fingerprint, transport });
  return { smtp, transport };
}

export async function sendRaw(
  account: AccountRuntime,
  raw: Buffer | Uint8Array,
  envelope: { from: string; to: string[] },
): Promise<SendResult> {
  const { smtp, transport } = transportFor(account);
  let info: Awaited<ReturnType<Transporter["sendMail"]>>;
  try {
    info = await transport.sendMail({ envelope, raw: Buffer.from(raw) });
  } catch (error) {
    throw withSmtpContext(error, smtp);
  }
  const accepted = (info.accepted ?? []).map(String);
  const rejected = (info.rejected ?? []).map(String);
  if (!accepted.length) {
    throw new Error(`Nessun destinatario accettato dal server SMTP (${info.response ?? "nessuna risposta"})`);
  }
  return { messageId: info.messageId, accepted, rejected, response: info.response };
}

/** Tests exactly the settings given, on a fresh connection — never one kept from an earlier attempt. */
export async function verifySmtp(account: AccountRuntime): Promise<void> {
  const { smtp, password } = requireSmtp(account);
  const transport = createTransport(smtp, password);
  try {
    await transport.verify();
  } catch (error) {
    throw withSmtpContext(error, smtp);
  } finally {
    transport.close();
  }
}

/** Copies a message sent by the router into the account's sent folder, when configured. */
export async function appendToSent(account: AccountRuntime, raw: Buffer | Uint8Array): Promise<void> {
  const folder = account.config.sentFolder;
  if (!folder) return;
  try {
    await withImap(account, "copia inviata", (client) => client.append(folder, Buffer.from(raw), ["\\Seen"]).then(() => undefined));
  } catch (error) {
    log.warn(`[${account.config.id}] copia nella cartella ${folder} non riuscita: ${errorMessage(error)}`);
  }
}
