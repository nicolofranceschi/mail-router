import { simpleParser, type AddressObject, type EmailAddress, type ParsedMail } from "mailparser";

import type { RuleAddress, RuleEmail, RulePec } from "../rules/types";

const MAX_HEADER_CHARS = 2000;

export function parseRaw(raw: Buffer): Promise<ParsedMail> {
  // keepCidLinks: inline images stay cid: references, so a forward can re-attach them.
  return simpleParser(raw, { skipImageLinks: true, skipTextLinks: true, keepCidLinks: true });
}

function flatten(entries: EmailAddress[]): RuleAddress[] {
  return entries.flatMap((entry) =>
    entry.group?.length
      ? flatten(entry.group)
      : entry.address
        ? [{ name: entry.name ?? "", address: entry.address.toLowerCase() }]
        : [],
  );
}

export function addressesOf(value: AddressObject | AddressObject[] | undefined): RuleAddress[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((object) => flatten(object.value));
}

export function formatAddress(address: RuleAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

export function headerMap(parsed: ParsedMail): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { key, line } of parsed.headerLines) {
    if (key in headers) continue;
    const colon = line.indexOf(":");
    const value = (colon >= 0 ? line.slice(colon + 1) : line).replace(/\r?\n[ \t]+/g, " ").trim();
    headers[key.toLowerCase()] = value.slice(0, MAX_HEADER_CHARS);
  }
  return headers;
}

function toIso(date: Date | undefined | null): string | null {
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

export function referencesOf(parsed: ParsedMail): string[] {
  const references = parsed.references;
  if (!references) return [];
  return Array.isArray(references) ? references : references.split(/\s+/).filter(Boolean);
}

export interface MessageMeta {
  account: string;
  folder: string;
  uid: number;
  flags: Iterable<string>;
  size: number;
  internalDate: Date | string | null | undefined;
}

/** Parsed message → the view rules receive, PEC envelopes unpacked. */
export async function buildRuleEmail(parsed: ParsedMail, meta: MessageMeta, maxTextChars: number): Promise<RuleEmail> {
  const { extractPec } = await import("./pec");
  return toRuleEmail(parsed, meta, maxTextChars, await extractPec(parsed, maxTextChars));
}

export function toRuleEmail(parsed: ParsedMail, meta: MessageMeta, maxTextChars: number, pec: RulePec | null = null): RuleEmail {
  const headers = headerMap(parsed);
  const fullText = (parsed.text ?? "").replace(/\r\n/g, "\n").trim();
  const precedence = (headers.precedence ?? "").toLowerCase();
  const autoSubmitted = (headers["auto-submitted"] ?? "").toLowerCase();
  const internalDate = meta.internalDate ? new Date(meta.internalDate) : null;
  return {
    account: meta.account,
    folder: meta.folder,
    uid: meta.uid,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: referencesOf(parsed),
    date: "date" in headers ? toIso(parsed.date) : null,
    receivedAt: toIso(internalDate),
    from: addressesOf(parsed.from)[0] ?? null,
    sender: headers.sender ? (addressesOf(parsed.headers.get("sender") as AddressObject | undefined)[0] ?? null) : null,
    replyTo: addressesOf(parsed.replyTo),
    to: addressesOf(parsed.to),
    cc: addressesOf(parsed.cc),
    subject: parsed.subject ?? "",
    text: fullText.slice(0, maxTextChars),
    textTruncated: fullText.length > maxTextChars,
    attachments: parsed.attachments
      .filter((attachment) => !attachment.related)
      .map((attachment) => ({
        filename: attachment.filename ?? "",
        contentType: attachment.contentType,
        size: attachment.size,
      })),
    headers,
    flags: [...meta.flags],
    size: meta.size,
    bulk:
      "list-unsubscribe" in headers || "list-id" in headers || /^(bulk|list|junk)$/.test(precedence),
    autoSubmitted: autoSubmitted !== "" && autoSubmitted !== "no",
    pec,
  };
}

/** A synthetic message used to smoke-test rule code when it is saved. */
export function sampleRuleEmail(account = "posta", folder = "INBOX"): RuleEmail {
  return {
    account,
    folder,
    uid: 1,
    messageId: "<esempio@example.it>",
    inReplyTo: null,
    references: [],
    date: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    from: { name: "Mario Rossi", address: "mario.rossi@example.it" },
    sender: null,
    replyTo: [],
    to: [{ name: "", address: "info@example.it" }],
    cc: [],
    subject: "Richiesta di preventivo",
    text: "Buongiorno, vorrei un preventivo. Cordiali saluti",
    textTruncated: false,
    attachments: [{ filename: "documento.pdf", contentType: "application/pdf", size: 1024 }],
    headers: { from: "Mario Rossi <mario.rossi@example.it>", subject: "Richiesta di preventivo" },
    flags: [],
    size: 2048,
    bulk: false,
    autoSubmitted: false,
    pec: null,
  };
}
