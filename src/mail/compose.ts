import { randomUUID } from "node:crypto";

import type { ParsedMail } from "mailparser";
import type Mail from "nodemailer/lib/mailer";
import MailComposer from "nodemailer/lib/mail-composer";

import { addressesOf, formatAddress, referencesOf } from "./parse";
import { normalizeAddress } from "../rules/decision";
import type { RulePec } from "../rules/types";

export interface ComposedMessage {
  raw: Buffer;
  envelope: { from: string; to: string[] };
  subject: string;
  messageId: string;
}

export interface Identity {
  /** `Name <address>` used as From. */
  from: string;
  timeZone: string;
  /** Marks messages so the router never re-processes its own output. */
  instanceId: string;
}

const LOOP_HEADER = "X-Mail-Router-Instance";
export const LOOP_HEADER_KEY = LOOP_HEADER.toLowerCase();

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>\n");
}

function formatDate(date: Date | undefined, timeZone: string): string {
  if (!date || Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("it-IT", { dateStyle: "full", timeStyle: "short", timeZone }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** The inner body of an HTML document, keeping its <style> blocks. */
function htmlBody(html: string): string {
  const styles = html.match(/<style[\s\S]*?<\/style>/gi)?.join("\n") ?? "";
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return `${styles}${body ? body[1] : html}`;
}

function withPrefix(prefix: string, subject: string): string {
  const trimmed = subject.trim();
  if (!prefix) return trimmed;
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase()) ? trimmed : `${prefix} ${trimmed}`.trim();
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1) || "mail-router.local";
}

function senderAddress(from: string): string {
  return normalizeAddress(from);
}

function newMessageId(from: string): string {
  return `<${randomUUID()}@${domainOf(senderAddress(from))}>`;
}

async function compile(options: Mail.Options): Promise<Buffer> {
  return new MailComposer(options).compile().build();
}

function originalAttachments(original: ParsedMail): Mail.Attachment[] {
  return original.attachments.map((attachment) => ({
    filename: attachment.filename,
    content: attachment.content,
    contentType: attachment.contentType,
    ...(attachment.cid && attachment.related
      ? { cid: attachment.cid, contentDisposition: "inline" as const }
      : { contentDisposition: "attachment" as const }),
  }));
}

function forwardedHeader(original: ParsedMail, timeZone: string, pec?: RulePec | null): { text: string; html: string } {
  if (pec && !pec.isReceipt) return pecHeader(original, timeZone, pec);
  const from = addressesOf(original.from).map(formatAddress).join(", ");
  const to = addressesOf(original.to).map(formatAddress).join(", ");
  const cc = addressesOf(original.cc).map(formatAddress).join(", ");
  const rows: [string, string][] = [
    ["Da", from],
    ["Data", formatDate(original.date, timeZone)],
    ["Oggetto", original.subject ?? ""],
    ["A", to],
    ...(cc ? ([["Cc", cc]] as [string, string][]) : []),
  ];
  const title = "---------- Messaggio inoltrato ----------";
  return {
    text: [title, ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n"),
    html:
      `<div>${title}<br>\n` +
      rows.map(([label, value]) => `<b>${label}:</b> ${escapeHtml(value)}<br>`).join("\n") +
      "</div>",
  };
}

/** For a PEC the useful facts are the inner message's, not the provider envelope's. */
function pecHeader(original: ParsedMail, timeZone: string, pec: RulePec): { text: string; html: string } {
  const inner = pec.original;
  const date = inner?.date ? new Date(inner.date) : original.date;
  const rows: [string, string][] = [
    ["Mittente PEC", pec.sender ?? (inner?.from ? formatAddress(inner.from) : "")],
    ["Data", formatDate(date, timeZone)],
    ["Oggetto", pec.subject ?? inner?.subject ?? original.subject ?? ""],
    ["Destinatari", (inner?.to ?? []).map(formatAddress).join(", ")],
    ...(inner?.attachments.length ? ([["Allegati", inner.attachments.map((attachment) => attachment.filename).join(", ")]] as [string, string][]) : []),
    ...(pec.identificativo ? ([["Identificativo PEC", pec.identificativo]] as [string, string][]) : []),
  ];
  const title = "---------- PEC inoltrata ----------";
  return {
    text: [title, ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n"),
    html:
      `<div>${title}<br>\n` +
      rows.map(([label, value]) => `<b>${label}:</b> ${escapeHtml(value)}<br>`).join("\n") +
      "</div>",
  };
}

export async function buildForward(params: {
  original: ParsedMail;
  originalRaw: Buffer;
  identity: Identity;
  to: string[];
  cc: string[];
  note: string | null;
  asAttachment: boolean;
  replyToSender: boolean;
  prefix: string;
  /** Rule id, or "manual". */
  origin: string;
  automatic: boolean;
  pec?: RulePec | null;
}): Promise<ComposedMessage> {
  const { original, identity } = params;
  const subject = withPrefix(params.prefix, original.subject ?? "");
  const messageId = newMessageId(identity.from);
  const header = forwardedHeader(original, identity.timeZone, params.pec);
  const note = params.note?.trim() ?? "";
  const noteText = note ? `${note}\n\n` : "";
  const noteHtml = note ? `<div>${textToHtml(note)}</div><br>\n` : "";

  let text: string;
  let html: string;
  let attachments: Mail.Attachment[];
  if (params.asAttachment) {
    const what = params.pec ? "La PEC originale, con busta e firma del gestore, è allegata." : "Il messaggio originale è allegato.";
    text = `${noteText}${header.text}\n\n(${what})`;
    html = `${noteHtml}${header.html}<p>(${what})</p>`;
    const base = params.pec?.subject ? `PEC - ${params.pec.subject}` : (original.subject ?? "messaggio");
    const name = base.replace(/[\\/:*?"<>|\r\n]+/g, " ").trim().slice(0, 80) || "messaggio";
    attachments = [{ filename: `${name}.eml`, content: params.originalRaw, contentType: "message/rfc822" }];
  } else {
    const originalText = original.text ?? "";
    text = `${noteText}${header.text}\n\n${originalText}`;
    const originalHtml = typeof original.html === "string" && original.html ? htmlBody(original.html) : textToHtml(originalText);
    html = `${noteHtml}${header.html}<br>\n${originalHtml}`;
    attachments = originalAttachments(original);
  }

  const replyTo = params.replyToSender
    ? (addressesOf(original.replyTo).length ? addressesOf(original.replyTo) : addressesOf(original.from)).map(formatAddress)
    : undefined;

  const headers: Record<string, string> = {
    [LOOP_HEADER]: identity.instanceId,
    "X-Mail-Router-Origin": params.origin,
  };
  if (params.automatic) headers["Auto-Submitted"] = "auto-generated";

  const raw = await compile({
    from: identity.from,
    to: params.to,
    cc: params.cc.length ? params.cc : undefined,
    replyTo,
    subject,
    messageId,
    references: [...referencesOf(original), ...(original.messageId ? [original.messageId] : [])],
    text,
    html,
    attachments,
    headers,
    date: new Date(),
  });
  return {
    raw,
    envelope: { from: senderAddress(identity.from), to: [...params.to, ...params.cc] },
    subject,
    messageId,
  };
}

export async function buildReply(params: {
  original: ParsedMail;
  identity: Identity;
  body: string;
  replyAll: boolean;
  ownAddresses: string[];
  prefix: string;
}): Promise<ComposedMessage> {
  const { original, identity } = params;
  const own = new Set([...params.ownAddresses.map(normalizeAddress), senderAddress(identity.from)]);
  const replyTargets = addressesOf(original.replyTo).length ? addressesOf(original.replyTo) : addressesOf(original.from);
  const to = replyTargets.filter((address) => !own.has(address.address));
  if (!to.length) throw new Error("Il messaggio non ha un mittente a cui rispondere");
  const toSet = new Set(to.map((address) => address.address));
  const cc = params.replyAll
    ? [...addressesOf(original.to), ...addressesOf(original.cc)].filter(
        (address, index, list) =>
          !own.has(address.address) &&
          !toSet.has(address.address) &&
          list.findIndex((other) => other.address === address.address) === index,
      )
    : [];
  const strippedSubject = (original.subject ?? "").replace(/^\s*((re|r|fwd|fw|i|rif)\s*:\s*)+/i, "");
  const subject = withPrefix(params.prefix, strippedSubject);
  const messageId = newMessageId(identity.from);
  const when = formatDate(original.date, identity.timeZone);
  const author = addressesOf(original.from).map(formatAddress).join(", ");
  const intro = `Il ${when}, ${author} ha scritto:`;
  const quotedText = (original.text ?? "")
    .slice(0, 20_000)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  const originalHtml = typeof original.html === "string" && original.html ? htmlBody(original.html) : textToHtml(original.text ?? "");

  const raw = await compile({
    from: identity.from,
    to: to.map(formatAddress),
    cc: cc.length ? cc.map(formatAddress) : undefined,
    subject,
    messageId,
    inReplyTo: original.messageId,
    references: [...referencesOf(original), ...(original.messageId ? [original.messageId] : [])],
    text: `${params.body}\n\n${intro}\n${quotedText}`,
    html:
      `<div>${textToHtml(params.body)}</div><br>\n<div>${escapeHtml(intro)}</div>\n` +
      `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${originalHtml}</blockquote>`,
    headers: { [LOOP_HEADER]: identity.instanceId, "X-Mail-Router-Origin": "manual" },
    date: new Date(),
  });
  return {
    raw,
    envelope: { from: senderAddress(identity.from), to: [...to, ...cc].map((address) => address.address) },
    subject,
    messageId,
  };
}

export async function buildMessage(params: {
  identity: Identity;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}): Promise<ComposedMessage> {
  const messageId = newMessageId(params.identity.from);
  const raw = await compile({
    from: params.identity.from,
    to: params.to,
    cc: params.cc.length ? params.cc : undefined,
    subject: params.subject,
    messageId,
    text: params.body,
    html: `<div>${textToHtml(params.body)}</div>`,
    headers: { [LOOP_HEADER]: params.identity.instanceId, "X-Mail-Router-Origin": "manual" },
    date: new Date(),
  });
  return {
    raw,
    envelope: { from: senderAddress(params.identity.from), to: [...params.to, ...params.cc] },
    subject: params.subject,
    messageId,
  };
}
