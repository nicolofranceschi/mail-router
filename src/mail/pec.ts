/**
 * Italian certified mail (PEC). What lands in a PEC inbox is an envelope from
 * the provider ("POSTA CERTIFICATA: <subject>", From "Per conto di: …"): the
 * message the sender actually wrote travels inside as postacert.eml, and
 * daticert.xml carries the certified data. Receipts (accettazione, avvenuta
 * consegna…) and anomaly envelopes arrive in the same inbox. Rules need to
 * tell these apart and to read the inner message, so it is unpacked here.
 */
import type { ParsedMail } from "mailparser";

import type { RulePec } from "../rules/types";
import { addressesOf, headerMap, parseRaw } from "./parse";

const RECEIPTS = new Set([
  "accettazione",
  "non-accettazione",
  "presa-in-carico",
  "avvenuta-consegna",
  "errore-consegna",
  "preavviso-errore-consegna",
  "rilevazione-virus",
]);

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&")
    .trim();
}

function xmlField(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "i").exec(xml);
  return match ? decodeXml(match[1]!) || null : null;
}

/** Returns the PEC view of a message, or null for ordinary mail. */
export async function extractPec(parsed: ParsedMail, maxTextChars: number): Promise<RulePec | null> {
  const headers = headerMap(parsed);
  const transport = (headers["x-trasporto"] ?? "").toLowerCase().trim();
  const receipt = (headers["x-ricevuta"] ?? "").toLowerCase().trim();
  const daticert = parsed.attachments.find((attachment) => (attachment.filename ?? "").toLowerCase() === "daticert.xml");
  if (!transport && !receipt && !daticert) return null;

  const xml = daticert ? daticert.content.toString("utf8") : "";
  const xmlType = /<postacert[^>]*\btipo="([^"]+)"/i.exec(xml)?.[1]?.toLowerCase() ?? null;
  const tipo = receipt || transport || xmlType || "sconosciuto";

  const inner =
    parsed.attachments.find((attachment) => (attachment.filename ?? "").toLowerCase() === "postacert.eml") ??
    parsed.attachments.find((attachment) => attachment.contentType === "message/rfc822");
  let original: RulePec["original"] = null;
  if (inner) {
    try {
      const message = await parseRaw(inner.content);
      const text = (message.text ?? "").replace(/\r\n/g, "\n").trim();
      original = {
        from: addressesOf(message.from)[0] ?? null,
        to: addressesOf(message.to),
        cc: addressesOf(message.cc),
        replyTo: addressesOf(message.replyTo),
        subject: message.subject ?? "",
        date: message.date && !Number.isNaN(message.date.getTime()) ? message.date.toISOString() : null,
        messageId: message.messageId ?? null,
        text: text.slice(0, maxTextChars),
        textTruncated: text.length > maxTextChars,
        attachments: message.attachments
          .filter((attachment) => !attachment.related)
          .map((attachment) => ({ filename: attachment.filename ?? "", contentType: attachment.contentType, size: attachment.size })),
      };
    } catch {
      original = null;
    }
  }

  const sender = (xml && xmlField(xml, "mittente")) || original?.from?.address || null;
  return {
    tipo,
    isReceipt: RECEIPTS.has(tipo) || Boolean(receipt),
    isAnomaly: transport === "errore" || tipo === "errore",
    sender: sender ? sender.toLowerCase() : null,
    subject: (xml && xmlField(xml, "oggetto")) || original?.subject || null,
    identificativo: xml ? xmlField(xml, "identificativo") : null,
    gestore: xml ? xmlField(xml, "gestore-emittente") : null,
    original,
  };
}
