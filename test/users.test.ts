import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { authenticateKey, createOnceToken, createSession, createUser, rotateToken, rotateUserKey, sha256Hex } from "../src/auth";
import { parseConfig } from "../src/config";
import { toolAllowed } from "../src/mcp/server";
import { applyGeneral, newAccountId, removeAccount, saveAccount } from "../src/settings";
import { MIGRATIONS, Store } from "../src/store";

process.env.MAIL_ROUTER_ALLOW_PLAIN = "1";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

describe("users and keys", () => {
  test("each user has an own key; only its hash is stored", () => {
    const anna = createUser(store, "Anna", "admin");
    const bruno = createUser(store, "Bruno", "operator");
    expect(anna.key).not.toBe(bruno.key);
    expect(authenticateKey(store, anna.key)?.id).toBe(anna.user.id);
    expect(authenticateKey(store, bruno.key)?.role).toBe("operator");
    expect(authenticateKey(store, "mr_sbagliata")).toBeNull();
    expect(authenticateKey(store, "")).toBeNull();
    const raw = store.db.query("SELECT key_hash, key_hint FROM users WHERE id = $id").get({ id: bruno.user.id }) as { key_hash: string; key_hint: string };
    expect(raw.key_hash).toBe(sha256Hex(bruno.key));
    expect(bruno.key.endsWith(raw.key_hint)).toBe(true);
  });

  test("names are unique, regardless of case", () => {
    createUser(store, "Anna", "admin");
    expect(() => createUser(store, "anna", "operator")).toThrow("Esiste già");
  });

  test("a new key replaces the old one, other users are untouched", () => {
    const anna = createUser(store, "Anna", "admin");
    const bruno = createUser(store, "Bruno", "operator");
    const fresh = rotateUserKey(store, bruno.user.id);
    expect(authenticateKey(store, bruno.key)).toBeNull();
    expect(authenticateKey(store, fresh)?.id).toBe(bruno.user.id);
    expect(authenticateKey(store, anna.key)?.id).toBe(anna.user.id);
  });

  test("sessions belong to a user and die with them", () => {
    const bruno = createUser(store, "Bruno", "operator");
    const session = createSession(store, bruno.user.id);
    expect(store.uiTokenUser(sha256Hex(session), "session")?.name).toBe("Bruno");
    store.deleteUser(bruno.user.id);
    expect(store.uiTokenUser(sha256Hex(session), "session")).toBeNull();
  });

  test("the CLI key and the desktop link act as the main administrator, created when missing", () => {
    const key = rotateToken(store);
    const admin = authenticateKey(store, key)!;
    expect(admin.role).toBe("admin");
    const once = createOnceToken(store);
    expect(store.consumeUiToken(sha256Hex(once), "once")?.id).toBe(admin.id);
    expect(store.consumeUiToken(sha256Hex(once), "once")).toBeNull();
    // A second rotation changes that administrator's key instead of adding users.
    const again = rotateToken(store);
    expect(authenticateKey(store, key)).toBeNull();
    expect(authenticateKey(store, again)?.id).toBe(admin.id);
    expect(store.countUsers()).toBe(1);
  });

  test("operators do not get the configuration tools", () => {
    expect(toolAllowed("set_account_options", "operator")).toBe(false);
    expect(toolAllowed("set_account_options", "admin")).toBe(true);
    expect(toolAllowed("create_rule", "operator")).toBe(true);
  });
});

test("the single key of an older database becomes the first administrator", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mail-router-users-"));
  const file = path.join(dir, "old.db");
  try {
    // A version-2 database with the old single key and an open panel session.
    const legacy = new Database(file, { create: true, strict: true });
    legacy.exec(MIGRATIONS[1]!);
    legacy.exec(MIGRATIONS[2]!);
    legacy.exec("PRAGMA user_version = 2");
    legacy.query("INSERT INTO meta (key, value) VALUES ('mcp_token_sha256', $hash)").run({ hash: sha256Hex("mr_vecchia") });
    legacy
      .query("INSERT INTO ui_sessions (token_hash, kind, created_at, expires_at) VALUES ('s', 'session', '2026-01-01', '2999-01-01')")
      .run();
    legacy.close();

    const migrated = new Store(file);
    expect(migrated.uiTokenUser("s", "session")).toBeNull();
    const admin = authenticateKey(migrated, "mr_vecchia");
    expect(admin?.role).toBe("admin");
    expect(admin?.name).toBe("Amministratore");
    expect(migrated.getMeta("mcp_token_sha256")).toBeNull();
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("mailboxes from the panel", () => {
  const base = parseConfig({
    accounts: [
      { id: "posta", imap: { host: "imap.azienda.it", user: "info@azienda.it", password: "plain:uno" }, watch: ["INBOX"] },
    ],
  });
  const form = {
    imap: { host: "imap.pec.it", port: 993, secure: true, user: "azienda@pec.it", password: "due", rejectUnauthorized: true },
    smtp: null,
    watch: ["INBOX"],
    ownAddresses: ["azienda@pec.it"],
    markForwarded: true,
    forwardAsAttachment: true,
    markSortedRead: false,
  };

  test("adding one picks a free id from the name or the IMAP user", () => {
    // Another test file in the same run may have set a master key; this one checks the plain (development) format.
    const masterKey = process.env.MAIL_ROUTER_MASTER_KEY;
    delete process.env.MAIL_ROUTER_MASTER_KEY;
    let added: ReturnType<typeof saveAccount>;
    try {
      added = saveAccount(base, null, form);
    } finally {
      if (masterKey !== undefined) process.env.MAIL_ROUTER_MASTER_KEY = masterKey;
    }
    expect(added.id).toBe("azienda-pec-it");
    expect(added.config.accounts.map((account) => account.id)).toEqual(["posta", "azienda-pec-it"]);
    expect(added.config.accounts[1]!.imap.password).toBe("plain:due");
    expect(saveAccount(base, null, { ...form, id: "pec" }).id).toBe("pec");
    expect(() => saveAccount(base, null, { ...form, id: "posta" })).toThrow("Esiste già");
    expect(newAccountId(added.config, undefined, "azienda@pec.it")).toBe("azienda-pec-it-2");
  });

  test("editing keeps the id, the position and a blank password", () => {
    const { config } = saveAccount(base, null, { ...form, id: "pec" });
    const edited = saveAccount(config, "posta", {
      ...form,
      imap: { ...form.imap, host: "mail.azienda.it", user: "info@azienda.it", password: undefined },
    });
    expect(edited.config.accounts[0]!.id).toBe("posta");
    expect(edited.config.accounts[0]!.imap.host).toBe("mail.azienda.it");
    expect(edited.config.accounts[0]!.imap.password).toBe("plain:uno");
    expect(edited.config.accounts[1]!.id).toBe("pec");
  });

  test("the last mailbox cannot be removed", () => {
    expect(() => removeAccount(base, "posta")).toThrow("unica casella");
    const { config } = saveAccount(base, null, { ...form, id: "pec" });
    expect(removeAccount(config, "posta").accounts.map((account) => account.id)).toEqual(["pec"]);
  });

  test("general settings leave the mailboxes alone", () => {
    const next = applyGeneral(base, { instanceName: "Ufficio", allowedDomains: ["azienda.it"], mcpPort: 9000 });
    expect(next.instanceName).toBe("Ufficio");
    expect(next.outbound.allowedDomains).toEqual(["azienda.it"]);
    expect(next.mcp.port).toBe(9000);
    expect(next.accounts).toEqual(base.accounts);
  });

  test("watch positions of removed mailboxes are forgotten", () => {
    store.setWatchState("posta:INBOX", "1", 10);
    store.setWatchState("posta-2:INBOX", "1", 20);
    store.setWatchState("vecchia:INBOX", "1", 30);
    expect(store.forgetWatchStatesExcept(["posta", "posta-2"])).toBe(1);
    expect(store.getWatchState("posta:INBOX")).not.toBeNull();
    expect(store.getWatchState("vecchia:INBOX")).toBeNull();
  });
});
