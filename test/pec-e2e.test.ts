/**
 * PEC inbox → satellite sender → .eml forward → original filed away, against GreenMail:
 *   (container as in e2e.test.ts, with the extra user smistamento:secret@azienda.it)
 *   MAIL_ROUTER_E2E=1 bun test test/pec-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

import { parseConfig } from "../src/config";
import { folderExists } from "../src/mail/move";
import { parseRaw } from "../src/mail/parse";
import { App } from "../src/service/app";
import { samplePec } from "./fixtures/pec";

const E2E = process.env.MAIL_ROUTER_E2E === "1";
const suite = E2E ? describe : describe.skip;
const IMAP_PORT = 13143;
const SMTP_PORT = 13025;

let home = "";
let app: App;
/** A folder that does not exist yet, so the automatic creation is exercised on every run. */
const FILED = `Inoltrate-${Date.now()}`;

async function withMailbox<T>(user: string, folder: string, fn: (imap: ImapFlow) => Promise<T>): Promise<T> {
  const imap = new ImapFlow({ host: "127.0.0.1", port: IMAP_PORT, secure: false, auth: { user, pass: "secret" }, logger: false });
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock(folder);
    try {
      return await fn(imap);
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout();
  }
}

async function subjects(user: string, folder = "INBOX"): Promise<string[]> {
  return withMailbox(user, folder, async (imap) => {
    const out: string[] = [];
    if (!imap.mailbox || imap.mailbox.exists === 0) return out;
    for await (const message of imap.fetch("1:*", { envelope: true })) out.push(message.envelope?.subject ?? "");
    return out;
  }).catch(() => []);
}

async function until<T>(what: string, probe: () => Promise<T | false | null | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await Bun.sleep(500);
  }
}

suite("PEC inbox with a satellite sender (GreenMail)", () => {
  beforeAll(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "mail-router-pec-"));
    for (const user of ["info@azienda.it", "paghe@azienda.it"]) {
      const imap = new ImapFlow({ host: "127.0.0.1", port: IMAP_PORT, secure: false, auth: { user, pass: "secret" }, logger: false });
      await imap.connect();
      const lock = await imap.getMailboxLock("INBOX");
      try {
        if (imap.mailbox && imap.mailbox.exists > 0) await imap.messageDelete("1:*");
      } finally {
        lock.release();
      }
      await imap.logout();
    }
    const config = parseConfig({
      instanceName: "PEC",
      accounts: [
        {
          id: "pec",
          imap: { host: "127.0.0.1", port: IMAP_PORT, secure: false, user: "info@azienda.it", password: "plain:secret" },
          smtp: {
            host: "127.0.0.1",
            port: SMTP_PORT,
            secure: false,
            requireTls: false,
            user: "smistamento@azienda.it",
            password: "plain:secret",
            from: "Smistamento PEC <smistamento@azienda.it>",
          },
          watch: ["INBOX"],
          ownAddresses: ["info@azienda.it"],
          forwardAsAttachment: true,
          moveAfterForward: FILED,
        },
      ],
      outbound: { allowedDomains: ["azienda.it"] },
      mcp: { host: "127.0.0.1", port: 18792 },
      engine: { pollSeconds: 15 },
    });
    app = await App.open(home, config);
    app.store.createRule({
      name: "Ricevute PEC",
      description: "",
      priority: 1,
      mode: "enabled",
      code: "function rule(email) { return email.pec && email.pec.isReceipt ? { stop: true, reason: 'ricevuta' } : null }",
    });
    app.store.createRule({
      name: "Diffide → legale",
      description: "",
      priority: 10,
      mode: "enabled",
      code: "function rule(email, data, h) { return email.pec && h.has(email.pec.original && email.pec.original.text, 'diffida') ? { forward: 'paghe@azienda.it', reason: 'diffida' } : null }",
    });
    app.setMode("live");
    app.startBackground();
    await until("watcher connected", async () => app.watchers[0]?.snapshot().connected);
  });

  afterAll(async () => {
    await app?.stop().catch(() => undefined);
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("the PEC is forwarded as .eml from the satellite and filed in a new folder; the receipt stays", async () => {
    await withMailbox("info@azienda.it", "INBOX", async (imap) => expect(await folderExists(imap, FILED)).toBe(false));
    const smtp = nodemailer.createTransport({ host: "127.0.0.1", port: SMTP_PORT, secure: false, ignoreTLS: true });
    const pec = await samplePec();
    const receipt = await samplePec("avvenuta-consegna");
    await smtp.sendMail({ envelope: { from: "posta-certificata@pec.aruba.it", to: ["info@azienda.it"] }, raw: pec });
    await smtp.sendMail({ envelope: { from: "posta-certificata@pec.aruba.it", to: ["info@azienda.it"] }, raw: receipt });

    await until("forward delivered", async () => (await subjects("paghe@azienda.it")).includes("I: POSTA CERTIFICATA: Diffida pagamento fattura 123"));
    await until("original filed", async () => (await subjects("info@azienda.it", FILED)).includes("POSTA CERTIFICATA: Diffida pagamento fattura 123"));
    expect(await subjects("info@azienda.it")).toEqual(["CONSEGNA: Diffida pagamento fattura 123"]);

    const forwarded = await withMailbox("paghe@azienda.it", "INBOX", async (imap) => {
      const message = await imap.fetchOne("*", { source: true });
      if (!message || !message.source) throw new Error("inoltro non trovato");
      return message.source;
    });
    const parsed = await parseRaw(forwarded);
    expect(parsed.from?.value[0]?.address).toBe("smistamento@azienda.it");
    expect(parsed.text).toContain("Mittente PEC: studio.bianchi@pec.it");
    const attached = parsed.attachments.find((attachment) => attachment.filename?.endsWith(".eml"));
    expect(attached?.contentType).toBe("message/rfc822");
    const inner = await parseRaw(attached!.content);
    expect(inner.subject).toBe("POSTA CERTIFICATA: Diffida pagamento fattura 123");
    expect(inner.attachments.map((attachment) => attachment.filename)).toContain("postacert.eml");

    const flags = await withMailbox("info@azienda.it", FILED, async (imap) => {
      const message = await imap.fetchOne("*", { flags: true });
      return message ? [...(message.flags ?? [])] : [];
    });
    expect(flags).toContain("$Forwarded");
    expect(flags).not.toContain("\\Seen");
  });
});
