/**
 * First-run wizard and control panel over HTTP, against GreenMail (see e2e.test.ts):
 *   MAIL_ROUTER_E2E=1 bun test test/panel.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config";
import { App } from "../src/service/app";
import { startServer } from "../src/web/server";
import { startSetupServer } from "../src/web/setup";

const E2E = process.env.MAIL_ROUTER_E2E === "1";
const suite = E2E ? describe : describe.skip;
const PORT = 18790;

const home = mkdtempSync(path.join(os.tmpdir(), "mail-router-panel-"));
let app: App | null = null;
let server: ReturnType<typeof startServer> | null = null;

function cookieOf(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function post(base: string, route: string, body: unknown, cookie = "") {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

const settings = {
  instanceName: "Prova pannello",
  imap: { host: "127.0.0.1", port: 13143, secure: false, user: "info@azienda.it", password: "secret", rejectUnauthorized: true },
  smtp: {
    host: "127.0.0.1",
    port: 13025,
    secure: false,
    user: "info@azienda.it",
    sameAsImap: true,
    from: "Smistamento <info@azienda.it>",
    requireTls: false,
    rejectUnauthorized: true,
  },
  watch: ["INBOX"],
  sentFolder: null,
  trashFolder: null,
  ownAddresses: ["info@azienda.it"],
  allowedDomains: ["azienda.it"],
  markForwarded: true,
  mcpPort: PORT,
};

suite("wizard and panel", () => {
  afterAll(async () => {
    void server?.stop(true);
    await app?.stop().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  });

  let key = "";
  let openUrl = "";

  test("the wizard needs its one-time link, tests the mailbox and writes the config", async () => {
    const setup = startSetupServer(home);
    const base = new URL(setup.url).origin;
    const once = new URL(setup.url).searchParams.get("once")!;

    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');

    expect((await (await fetch(`${base}/api/bootstrap`)).json()).authenticated).toBe(false);
    expect((await post(base, "/api/setup/imap", { imap: settings.imap })).status).toBe(401);
    expect((await post(base, "/api/session/once", { once: "sbagliato" })).status).toBe(401);
    const login = await post(base, "/api/session/once", { once });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login);
    expect((await post(base, "/api/session/once", { once })).status).toBe(401);

    const imap = await (await post(base, "/api/setup/imap", { imap: settings.imap }, cookie)).json();
    expect(imap.folders.map((folder: { path: string }) => folder.path)).toContain("INBOX");
    const wrong = await post(base, "/api/setup/imap", { imap: { ...settings.imap, password: "no" } }, cookie);
    expect(wrong.status).toBe(422);
    expect((await post(base, "/api/setup/smtp", { imap: settings.imap, smtp: settings.smtp }, cookie)).status).toBe(200);

    const finish = await (await post(base, "/api/setup/finish", { settings }, cookie)).json();
    expect(finish.key).toStartWith("mr_");
    expect(finish.access.command).toContain(finish.key);
    expect(existsSync(path.join(home, "config.json"))).toBe(true);
    expect(readFileSync(path.join(home, "config.json"), "utf8")).not.toContain('"secret"');
    key = finish.key;
    openUrl = finish.openUrl;
    await post(base, "/api/setup/close", {}, cookie);
    await setup.done;
  });

  test("the panel opens with the one-time link or the access key, never without", async () => {
    app = await App.open(home, loadConfig(home));
    server = startServer(app);
    const base = `http://127.0.0.1:${PORT}`;

    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await post(base, "/api/tools/get_status", {})).status).toBe(401);
    const noJson = await fetch(`${base}/api/session/key`, { method: "POST", body: "key=x" });
    expect(noJson.status).toBe(415);
    expect((await post(base, "/api/session/key", { key: "mr_sbagliata" })).status).toBe(401);

    const once = new URL(openUrl).searchParams.get("once");
    const viaLink = await post(base, "/api/session/once", { once });
    expect(viaLink.status).toBe(200);
    const linkCookie = cookieOf(viaLink);
    expect((await (await fetch(`${base}/api/bootstrap`, { headers: { Cookie: linkCookie } })).json()).authenticated).toBe(true);

    const viaKey = await post(base, "/api/session/key", { key });
    expect(viaKey.status).toBe(200);
    const cookie = cookieOf(viaKey);

    const status = await (await post(base, "/api/tools/get_status", { args: {} }, cookie)).json();
    expect(status.mode).toBe("shadow");
    const bad = await post(base, "/api/tools/create_rule", { args: { name: "x" } }, cookie);
    expect(bad.status).toBe(400);
    const created = await (
      await post(base, "/api/tools/create_rule", { args: { name: "Prova", description: "", code: "function rule(){return null}" } }, cookie)
    ).json();
    expect(created.created.mode).toBe("shadow");

    const current = await (await fetch(`${base}/api/settings`, { headers: { Cookie: cookie } })).json();
    expect(JSON.stringify(current)).not.toContain("secret");
    expect(current.settings.imap.passwordSet).toBe(true);

    await post(base, "/api/session/logout", {}, cookie);
    expect((await post(base, "/api/tools/get_status", { args: {} }, cookie)).status).toBe(401);
  });
});
