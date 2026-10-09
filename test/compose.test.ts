import { describe, expect, test } from "bun:test";
import MailComposer from "nodemailer/lib/mail-composer";

import { buildForward, buildReply } from "../src/mail/compose";
import { parseRaw, toRuleEmail } from "../src/mail/parse";

const identity = { from: "Smistamento <info@azienda.it>", timeZone: "Europe/Rome", instanceId: "abc123" };

async function original() {
  const raw = await new MailComposer({
    from: "Fornitore Srl <ordini@fornitore.it>",
    to: "info@azienda.it",
    cc: "commerciale@azienda.it",
    replyTo: "risposte@fornitore.it",
    subject: "Ordine 55",
    messageId: "<orig-1@fornitore.it>",
    date: new Date("2026-10-01T08:30:00Z"),
    text: "Vi inviamo l'ordine.",
    html: "<html><head><style>p{color:red}</style></head><body><p>Vi inviamo l'ordine.</p><img src=\"cid:logo1\"></body></html>",
    headers: { "List-Unsubscribe": "<mailto:stop@fornitore.it>" },
    attachments: [
      { filename: "ordine.pdf", content: Buffer.from("%PDF-1.4 test"), contentType: "application/pdf" },
      { filename: "logo.png", content: Buffer.from("png"), contentType: "image/png", cid: "logo1" },
    ],
  })
    .compile()
    .build();
  return { raw, parsed: await parseRaw(raw) };
}

describe("parse", () => {
  test("toRuleEmail exposes addresses, flags, bulk and attachments", async () => {
    const { parsed } = await original();
    const email = toRuleEmail(parsed, { account: "posta", folder: "INBOX", uid: 9, flags: new Set(["\\Seen"]), size: 100, internalDate: new Date() }, 5);
    expect(email.from).toEqual({ name: "Fornitore Srl", address: "ordini@fornitore.it" });
    expect(email.cc.map((entry) => entry.address)).toEqual(["commerciale@azienda.it"]);
    expect(email.bulk).toBe(true);
    expect(email.text).toBe("Vi in");
    expect(email.textTruncated).toBe(true);
    expect(email.attachments.map((attachment) => attachment.filename)).toEqual(["ordine.pdf"]);
    expect(email.flags).toEqual(["\\Seen"]);
  });
});

describe("forward", () => {
  test("inline forward keeps attachments, inline images and threading, and marks the loop header", async () => {
    const { raw, parsed } = await original();
    const composed = await buildForward({
      original: parsed,
      originalRaw: raw,
      identity,
      to: ["paghe@azienda.it"],
      cc: [],
      note: "Da gestire entro venerdì",
      asAttachment: false,
      replyToSender: true,
      prefix: "I:",
      origin: "r_1",
      automatic: true,
    });
    expect(composed.subject).toBe("I: Ordine 55");
    expect(composed.envelope).toEqual({ from: "info@azienda.it", to: ["paghe@azienda.it"] });
    const forwarded = await parseRaw(composed.raw);
    expect(forwarded.subject).toBe("I: Ordine 55");
    expect(forwarded.headers.get("x-mail-router-instance")).toBe("abc123");
    expect(forwarded.headers.get("auto-submitted")).toBe("auto-generated");
    expect(forwarded.replyTo?.value[0]?.address).toBe("risposte@fornitore.it");
    expect(forwarded.references).toContain("<orig-1@fornitore.it>");
    expect(forwarded.text).toContain("Da gestire entro venerdì");
    expect(forwarded.text).toContain("Messaggio inoltrato");
    expect(forwarded.text).toContain("Da: Fornitore Srl <ordini@fornitore.it>");
    expect(forwarded.html).toContain("cid:logo1");
    expect(forwarded.attachments.map((attachment) => attachment.filename).sort()).toEqual(["logo.png", "ordine.pdf"]);
  });

  test("forward as attachment carries the original .eml", async () => {
    const { raw, parsed } = await original();
    const composed = await buildForward({
      original: parsed,
      originalRaw: raw,
      identity,
      to: ["a@azienda.it"],
      cc: ["b@azienda.it"],
      note: null,
      asAttachment: true,
      replyToSender: false,
      prefix: "I:",
      origin: "manual",
      automatic: false,
    });
    const forwarded = await parseRaw(composed.raw);
    expect(forwarded.attachments.map((attachment) => [attachment.filename, attachment.contentType])).toEqual([
      ["Ordine 55.eml", "message/rfc822"],
    ]);
    expect(forwarded.headers.get("auto-submitted")).toBeUndefined();
    expect(composed.envelope.to).toEqual(["a@azienda.it", "b@azienda.it"]);
  });

  test("prefix is not doubled", async () => {
    const { raw, parsed } = await original();
    parsed.subject = "I: Ordine 55";
    const composed = await buildForward({
      original: parsed, originalRaw: raw, identity, to: ["a@azienda.it"], cc: [], note: null,
      asAttachment: false, replyToSender: false, prefix: "I:", origin: "r", automatic: true,
    });
    expect(composed.subject).toBe("I: Ordine 55");
  });
});

describe("reply", () => {
  test("reply-all goes to Reply-To, copies the others but never the mailbox itself", async () => {
    const { parsed } = await original();
    const composed = await buildReply({
      original: parsed,
      identity,
      body: "Grazie, ricevuto.",
      replyAll: true,
      ownAddresses: ["info@azienda.it"],
      prefix: "R:",
    });
    expect(composed.subject).toBe("R: Ordine 55");
    expect(composed.envelope.to).toEqual(["risposte@fornitore.it", "commerciale@azienda.it"]);
    const reply = await parseRaw(composed.raw);
    expect(reply.inReplyTo).toBe("<orig-1@fornitore.it>");
    expect(reply.text).toContain("> Vi inviamo l'ordine.");
  });
});
