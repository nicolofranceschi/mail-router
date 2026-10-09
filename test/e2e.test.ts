/**
 * End-to-end run against a real IMAP/SMTP server (GreenMail):
 *
 *   docker run -d --rm --name mail-router-e2e -p 127.0.0.1:13025:3025 -p 127.0.0.1:13143:3143 \
 *     -e GREENMAIL_OPTS='-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0
 *       -Dgreenmail.users=info:secret@azienda.it,paghe:secret@azienda.it,ufficio:secret@azienda.it,smistamento:secret@azienda.it
 *       -Dgreenmail.users.login=email' greenmail/standalone:2.1.3
 *   MAIL_ROUTER_E2E=1 bun test test/e2e.test.ts
 *
 * The service, the MCP server and an MCP client all run in this process; mail
 * really travels through the server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

import { parseConfig, type ConfigInput } from "../src/config";
import { rotateToken } from "../src/auth";
import { startServer } from "../src/web/server";
import { App } from "../src/service/app";

const E2E = process.env.MAIL_ROUTER_E2E === "1";
const IMAP_PORT = 13143;
const SMTP_PORT = 13025;
const MCP_PORT = 18787;
const suite = E2E ? describe : describe.skip;

let home = "";
let app: App;
let server: ReturnType<typeof startServer>;
let client: Client;
let token = "";

async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = result.content[0]?.text ?? "";
  if (result.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

async function until<T>(what: string, probe: () => Promise<T | undefined | null | false>, timeoutMs = 40_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await Bun.sleep(500);
  }
}

const external = nodemailer.createTransport({ host: "127.0.0.1", port: SMTP_PORT, secure: false, ignoreTLS: true });

function send(options: nodemailer.SendMailOptions) {
  return external.sendMail({ to: "info@azienda.it", ...options });
}

async function mailbox<T>(user: string, folder: string, fn: (imap: ImapFlow) => Promise<T>): Promise<T> {
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
  return mailbox(user, folder, async (imap) => {
    const out: string[] = [];
    if (!imap.mailbox || imap.mailbox.exists === 0) return out;
    for await (const message of imap.fetch("1:*", { envelope: true })) out.push(message.envelope?.subject ?? "");
    return out;
  });
}

suite("end to end (GreenMail)", () => {
  beforeAll(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "mail-router-e2e-"));
    // Start from empty mailboxes, so the run is repeatable on the same server.
    for (const user of ["info@azienda.it", "paghe@azienda.it", "ufficio@azienda.it"]) {
      const setup = new ImapFlow({ host: "127.0.0.1", port: IMAP_PORT, secure: false, auth: { user, pass: "secret" }, logger: false });
      await setup.connect();
      if (user === "info@azienda.it") {
        for (const folder of ["Archivio", "Sent", "Trash"]) await setup.mailboxCreate(folder).catch(() => undefined);
      }
      for (const folder of user === "info@azienda.it" ? ["INBOX", "Archivio", "Sent", "Trash"] : ["INBOX"]) {
        const lock = await setup.getMailboxLock(folder);
        try {
          if (setup.mailbox && setup.mailbox.exists > 0) await setup.messageDelete("1:*");
        } finally {
          lock.release();
        }
      }
      await setup.logout();
    }

    const config: ConfigInput = {
      instanceName: "Test",
      accounts: [
        {
          id: "posta",
          imap: { host: "127.0.0.1", port: IMAP_PORT, secure: false, user: "info@azienda.it", password: "plain:secret" },
          smtp: {
            host: "127.0.0.1",
            port: SMTP_PORT,
            secure: false,
            requireTls: false,
            user: "info@azienda.it",
            password: "env:MR_TEST_SMTP_PASSWORD",
            from: "Smistamento <info@azienda.it>",
          },
          watch: ["INBOX"],
          ownAddresses: ["info@azienda.it"],
          sentFolder: "Sent",
          trashFolder: "Trash",
        },
      ],
      outbound: { allowedDomains: ["azienda.it"] },
      mcp: { host: "127.0.0.1", port: MCP_PORT },
      engine: { pollSeconds: 15 },
    };
    process.env.MR_TEST_SMTP_PASSWORD = "secret";
    writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
    app = await App.open(home, parseConfig(config));
    token = rotateToken(app.store);
    server = startServer(app);
    app.startBackground();
    await until("watcher connected", async () => app.watchers[0]?.snapshot().connected);

    client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    void server?.stop(true);
    await app?.stop().catch(() => undefined);
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("the endpoint requires the bearer token", async () => {
    const anonymous = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, { method: "POST", body: "{}" });
    expect(anonymous.status).toBe(401);
    const wrong = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
      method: "POST",
      body: "{}",
      headers: { Authorization: "Bearer mr_wrong" },
    });
    expect(wrong.status).toBe(401);
    const health = (await (await fetch(`http://127.0.0.1:${MCP_PORT}/health`)).json()) as { mode: string };
    expect(health.mode).toBe("shadow");
  });

  test("tools are listed with the guide as instructions", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("create_rule");
    expect(client.getInstructions()).toContain("function rule(email, data, h)");
  });

  let ruleId = "";

  test("shadow mode: a new rule decides but nothing is sent", async () => {
    await call("set_data", { key: "uffici", value: { paghe: "paghe@azienda.it" }, description: "Caselle degli uffici" });
    const created = await call("create_rule", {
      name: "Cassa Edile → paghe",
      description: "Avvisi della Cassa Edile all'ufficio paghe",
      priority: 10,
      code: `function rule(email, data, h) {
        if (!h.isFrom(email, "cassaedile.it")) return null;
        return { forward: { to: data.uffici.paghe, note: "Inoltro automatico" }, flags: ["$Paghe"], reason: "Cassa Edile" };
      }`,
    });
    ruleId = created.created.id;
    expect(created.created.mode).toBe("shadow");

    await send({ from: "Cassa Edile <avvisi@cassaedile.it>", subject: "Avviso versamento settembre", text: "Contributi" });
    const activity = await until("shadow evaluation", async () => {
      const result = await call("list_activity", { onlyMatched: true });
      return result.activity.find((entry: any) => entry.message.subject === "Avviso versamento settembre");
    });
    expect(activity.actions.map((action: any) => [action.type, action.status])).toEqual([
      ["forward", "simulated"],
      ["flags", "simulated"],
    ]);
    expect(await subjects("paghe@azienda.it")).toEqual([]);
  });

  test("test_rules dry-runs a draft on the real folder", async () => {
    await send({ from: "Newsletter <news@marketing.com>", subject: "Offerte di ottobre", text: "Sconti", headers: { "List-Unsubscribe": "<mailto:x@marketing.com>" } });
    await until("newsletter evaluated", async () => {
      const result = await call("list_activity", {});
      return result.activity.some((entry: any) => entry.message.subject === "Offerte di ottobre");
    });
    const report = await call("test_rules", {
      code: "function rule(email) { return email.bulk ? { moveTo: 'Archivio', stop: true, reason: 'newsletter' } : null }",
      last: 10,
    });
    expect(report.tested).toBe(2);
    expect(report.matched).toBe(1);
    expect(report.results[0].subject).toBe("Offerte di ottobre");
    expect(report.results[0].wouldDo).toEqual([{ type: "move", status: "eseguirebbe", target: "Archivio" }]);
  });

  test("live mode: forward is sent, flags set, copy saved, original untouched otherwise", async () => {
    await call("update_rule", { id: ruleId, mode: "enabled" });
    await call("create_rule", {
      name: "Newsletter in archivio",
      description: "Sposta le newsletter",
      priority: 1,
      mode: "enabled",
      code: "function rule(email) { return email.bulk ? { moveTo: 'Archivio', stop: true, reason: 'newsletter' } : null }",
    });
    await call("set_mode", { mode: "live" });

    await send({ from: "Cassa Edile <avvisi@cassaedile.it>", subject: "Avviso versamento ottobre", text: "Contributi di ottobre", attachments: [{ filename: "distinta.pdf", content: "PDF" }] });
    await send({ from: "Newsletter <news@marketing.com>", subject: "Offerte di novembre", text: "Sconti", headers: { "List-Unsubscribe": "<mailto:x@marketing.com>" } });

    await until("forward delivered", async () => (await subjects("paghe@azienda.it")).includes("I: Avviso versamento ottobre"));
    const activity = await until("actions done", async () => {
      const result = await call("list_activity", { onlyMatched: true });
      const entry = result.activity.find((item: any) => item.message.subject === "Avviso versamento ottobre");
      return entry && entry.actions.every((action: any) => action.status === "done") ? entry : null;
    });
    expect(activity.actions.map((action: any) => action.type)).toEqual(["forward", "flags", "flags"]);

    const flags = await mailbox("info@azienda.it", "INBOX", async (imap) => {
      const uids = (await imap.search({ subject: "Avviso versamento ottobre" }, { uid: true })) || [];
      const message = await imap.fetchOne(String(uids[0]), { flags: true }, { uid: true });
      return message ? [...(message.flags ?? [])] : [];
    });
    expect(flags).toContain("$Forwarded");
    expect(flags).toContain("$Paghe");
    expect(flags).not.toContain("\\Seen");

    expect(await subjects("info@azienda.it", "Sent")).toContain("I: Avviso versamento ottobre");
    await until("newsletter archived", async () => (await subjects("info@azienda.it", "Archivio")).includes("Offerte di novembre"));
    expect(await subjects("info@azienda.it")).not.toContain("Offerte di novembre");

    const forwarded = await mailbox("paghe@azienda.it", "INBOX", async (imap) => {
      const message = await imap.fetchOne("*", { source: true, bodyStructure: true });
      return message ? message.source!.toString() : "";
    });
    expect(forwarded).toContain("X-Mail-Router-Instance");
    expect(forwarded).toContain("distinta.pdf");
    expect(forwarded).toContain("Inoltro automatico");
  });

  test("reprocessing does not forward the same message twice", async () => {
    const found = await call("search_emails", { subject: "Avviso versamento ottobre" });
    const uid = found.messages[0].uid;
    const result = await call("reprocess_email", { uid, execute: true });
    const forward = result.actions.find((action: any) => action.type === "forward");
    expect(forward.status).toBe("skipped");
    await Bun.sleep(1500);
    expect((await subjects("paghe@azienda.it")).filter((subject) => subject === "I: Avviso versamento ottobre")).toHaveLength(1);
  });

  test("mailbox tools read without marking as read and act on request", async () => {
    await send({ from: "Cliente <mario@cliente.it>", subject: "Richiesta preventivo", text: "Buongiorno, serve un preventivo." });
    const listed = await until("message listed", async () => {
      const result = await call("list_emails", { limit: 10 });
      return result.messages.find((message: any) => message.subject === "Richiesta preventivo");
    });
    await until("message evaluated", async () => {
      const result = await call("list_activity", { uid: listed.uid });
      return result.activity.length > 0;
    });
    const detail = await call("get_email", { uid: listed.uid });
    expect(detail.text).toContain("serve un preventivo");
    expect(detail.flags).not.toContain("\\Seen");
    expect(detail.routerHistory.length).toBeGreaterThan(0);

    const forwarded = await call("forward_email", { uid: listed.uid, to: "ufficio@azienda.it", note: "Puoi rispondere tu?", replyToSender: true });
    expect(forwarded.accepted).toEqual(["ufficio@azienda.it"]);
    await until("manual forward delivered", async () => (await subjects("ufficio@azienda.it")).includes("I: Richiesta preventivo"));

    const flagged = await call("set_flags", { uid: listed.uid, add: ["\\Seen", "\\Flagged"] });
    expect(flagged.flags).toEqual(expect.arrayContaining(["\\Seen", "\\Flagged", "$Forwarded"]));

    const trashed = await call("delete_email", { uid: listed.uid });
    expect(trashed.trashed).toBe(true);
    expect(await subjects("info@azienda.it", "Trash")).toContain("Richiesta preventivo");

    const outbox = await call("list_outbox", { limit: 10 });
    expect(outbox.some((action: any) => action.origin === "manual" && action.type === "forward" && action.status === "done")).toBe(true);
  });

  test("blocked domains are never contacted, and leaving live cancels the queue", async () => {
    await call("create_rule", {
      name: "Esterno",
      description: "Prova del blocco domini",
      priority: 5,
      mode: "enabled",
      code: "function rule(email) { return email.subject.includes('Esterno') ? { forward: 'qualcuno@esterno.com' } : null }",
    });
    await send({ from: "x@altro.it", subject: "Esterno 1", text: "x" });
    const entry = await until("blocked recorded", async () => {
      const result = await call("list_activity", { onlyMatched: true });
      return result.activity.find((item: any) => item.message.subject === "Esterno 1");
    });
    expect(entry.actions).toEqual([expect.objectContaining({ type: "forward", status: "blocked" })]);

    const mode = await call("set_mode", { mode: "shadow" });
    expect(mode.previous).toBe("live");
    const status = await call("get_status");
    expect(status.mode).toBe("shadow");
    expect(status.watchers[0].connected).toBe(true);
  });

  test("rules can be deleted and restored", async () => {
    await call("delete_rule", { id: ruleId });
    const listed = await call("list_rules");
    expect(listed.rules.some((rule: any) => rule.id === ruleId)).toBe(false);
    const deleted = listed.deletedRules.find((rule: any) => rule.id === ruleId);
    const restored = await call("restore_rule", { id: ruleId, version: deleted.version });
    expect(restored.restored.mode).toBe("enabled");
  });
});
