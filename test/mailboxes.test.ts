/**
 * Each mailbox has its own rules and reference data, and an operator only
 * reaches the mailboxes assigned to them, through the panel and Claude alike.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseConfig } from "../src/config";
import { createToolRunner } from "../src/mcp/server";
import { Scope } from "../src/scope";
import { App } from "../src/service/app";
import { MIGRATIONS, Store } from "../src/store";

const home = mkdtempSync(path.join(os.tmpdir(), "mail-router-mailboxes-"));
let app: App;
let runTool: ReturnType<typeof createToolRunner>;

const admin = Scope.admin("Silvia");
const anna = Scope.operator(["posta"], "Anna");
const nobody = Scope.operator([], "Nuovo");
const CODE = "function rule(email) { return null }";

async function call(scope: Scope, name: string, args: Record<string, unknown> = {}) {
  const result = await runTool(name, args, scope);
  if (!result.ok) throw new Error(result.error);
  return result.value as any;
}

async function refused(scope: Scope, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await runTool(name, args, scope);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error;
}

beforeAll(async () => {
  app = await App.open(
    home,
    parseConfig({
      accounts: [
        { id: "posta", imap: { host: "127.0.0.1", port: 1, secure: false, user: "anna@azienda.it", password: "plain:x" } },
        { id: "pec", imap: { host: "127.0.0.1", port: 1, secure: false, user: "azienda@pec.it", password: "plain:y" } },
      ],
      mcp: { host: "127.0.0.1", port: 18795 },
    }),
  );
  runTool = createToolRunner(app);
});

afterAll(async () => {
  await app.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("rules belong to a mailbox", () => {
  test("an operator creates rules in their own mailbox only", async () => {
    const created = await call(anna, "create_rule", { name: "Fatture", description: "", code: CODE });
    expect(created.created.account).toBe("posta");
    expect(await refused(anna, "create_rule", { account: "pec", name: "X", description: "", code: CODE })).toContain(
      "Non hai accesso alla casella pec",
    );
  });

  test("with several mailboxes the rule's mailbox must be named", async () => {
    expect(await refused(admin, "create_rule", { name: "X", description: "", code: CODE })).toContain("Indica la casella");
    const created = await call(admin, "create_rule", { account: "pec", name: "Ricevute", description: "", code: CODE });
    expect(created.created.account).toBe("pec");
  });

  test("someone else's rules are invisible and untouchable", async () => {
    const pecRule = app.store.listRules({ accounts: ["pec"] })[0]!;
    const own = (await call(anna, "list_rules")).rules.map((rule: any) => rule.name);
    expect(own).toEqual(["Fatture"]);
    for (const [tool, args] of [
      ["get_rule", { id: pecRule.id }],
      ["update_rule", { id: pecRule.id, mode: "enabled" }],
      ["delete_rule", { id: pecRule.id }],
      ["restore_rule", { id: pecRule.id, version: 1 }],
      ["test_rules", { ruleIds: [pecRule.id] }],
    ] as const) {
      expect(await refused(anna, tool, args)).toContain("non trovata");
    }
    expect(app.store.getRule(pecRule.id)?.mode).toBe("shadow");
    // Nor can a rule be moved into a mailbox the operator does not have.
    const mine = app.store.listRules({ accounts: ["posta"] })[0]!;
    expect(await refused(anna, "update_rule", { id: mine.id, account: "pec" })).toContain("Non hai accesso");
  });

  test("the administrator sees every mailbox's rules", async () => {
    const names = (await call(admin, "list_rules")).rules.map((rule: any) => `${rule.account}:${rule.name}`);
    expect(names.sort()).toEqual(["pec:Ricevute", "posta:Fatture"]);
  });

  test("a message only goes through the rules of its mailbox", () => {
    expect(app.engineRules("posta").map((rule) => rule.name)).toEqual(["Fatture"]);
    expect(app.engineRules("pec").map((rule) => rule.name)).toEqual(["Ricevute"]);
  });
});

describe("reference data belong to a mailbox", () => {
  test("each mailbox's rules see only their own data", async () => {
    await call(anna, "set_data", { key: "uffici", value: { paghe: "paghe@azienda.it" } });
    await call(admin, "set_data", { account: "pec", key: "uffici", value: { legale: "legale@azienda.it" } });
    expect(app.store.dataObject("posta")).toEqual({ uffici: { paghe: "paghe@azienda.it" } });
    expect(app.store.dataObject("pec")).toEqual({ uffici: { legale: "legale@azienda.it" } });
    expect((await call(anna, "list_data")).entries.map((entry: any) => entry.key)).toEqual(["uffici"]);
    expect(await refused(anna, "get_data", { account: "pec", key: "uffici" })).toContain("Non hai accesso");
    expect(await refused(anna, "list_data", { shared: true })).toContain("amministratori");
  });
});

describe("what an operator sees of the service", () => {
  test("status, activity and queue show only their mailboxes", async () => {
    const evaluation = (account: string, uid: number) =>
      app.store.recordEvaluation(
        {
          account,
          folder: "INBOX",
          uidValidity: "1",
          uid,
          messageId: null,
          subject: `messaggio ${account}`,
          fromAddress: null,
          fromName: null,
          date: null,
          origin: "watch",
          engineMode: "shadow",
          matched: false,
        },
        [],
        [],
      );
    evaluation("posta", 1);
    evaluation("pec", 2);
    const status = await call(anna, "get_status");
    expect(status.accounts.map((account: any) => account.id)).toEqual(["posta"]);
    expect(status.rules.total).toBe(1);
    const activity = (await call(anna, "list_activity")).activity.map((entry: any) => entry.message.account);
    expect(activity).toEqual(["posta"]);
    expect(await refused(anna, "list_activity", { account: "pec" })).toContain("Non hai accesso");
    expect((await call(admin, "list_activity")).activity).toHaveLength(2);
  });

  test("the engine mode and the log are for administrators", async () => {
    expect(await refused(anna, "set_mode", { mode: "live" })).toContain("amministratori");
    expect(await refused(anna, "get_logs")).toContain("amministratori");
    expect(app.mode).toBe("shadow");
  });

  test("an operator without mailboxes is told to ask for one", async () => {
    expect(await refused(nobody, "create_rule", { name: "X", description: "", code: CODE })).toContain("Non hai caselle");
    expect((await call(nobody, "list_rules")).rules).toEqual([]);
    expect((await call(nobody, "get_status")).accounts).toEqual([]);
  });
});

describe("upgrading a database from before mailboxes had own rules", () => {
  test("old rules and data stay shared, and a single mailbox adopts them", () => {
    const file = path.join(home, "old.db");
    const old = new Database(file, { create: true });
    for (const version of [1, 2, 3]) old.exec(MIGRATIONS[version]!);
    old.exec("PRAGMA user_version = 3");
    old.exec(`INSERT INTO rules (id, name, description, code, mode, priority, version, created_at, updated_at)
              VALUES ('r_old', 'Vecchia', '', '${CODE}', 'enabled', 10, 1, '2026-01-01', '2026-01-01')`);
    old.exec(`INSERT INTO rule_versions (rule_id, version, change, name, description, code, mode, priority, saved_at)
              VALUES ('r_old', 1, 'created', 'Vecchia', '', '${CODE}', 'enabled', 10, '2026-01-01')`);
    old.exec(`INSERT INTO data_entries (key, value, description, updated_at) VALUES ('uffici', '{"a":1}', '', '2026-01-01')`);
    old.close();

    const store = new Store(file);
    try {
      // Shared: every mailbox still runs the old rule and reads the old data.
      expect(store.rulesForAccount("posta").map((rule) => rule.id)).toEqual(["r_old"]);
      expect(store.rulesForAccount("pec").map((rule) => rule.id)).toEqual(["r_old"]);
      expect(store.dataObject("pec")).toEqual({ uffici: { a: 1 } });
      expect(store.listRules({ accounts: ["posta"] })).toEqual([]);

      expect(store.adoptShared("posta")).toEqual({ rules: 1, data: 1 });
      expect(store.getRule("r_old")?.account).toBe("posta");
      expect(store.ruleVersions("r_old")[0]?.account).toBe("posta");
      expect(store.rulesForAccount("pec")).toEqual([]);
      expect(store.dataObject("pec")).toEqual({});
      expect(store.dataObject("posta")).toEqual({ uffici: { a: 1 } });
    } finally {
      store.close();
    }
  });

  test("a user's mailboxes go away with the user", () => {
    const store = new Store(":memory:");
    try {
      store.createUser({ id: "u_1", name: "Anna", role: "operator", keyHash: "h", keyHint: "" });
      store.setUserAccounts("u_1", ["posta", "pec", "posta"]);
      expect(store.userAccounts("u_1")).toEqual(["pec", "posta"]);
      store.deleteUser("u_1");
      expect(store.db.query("SELECT COUNT(*) AS n FROM user_accounts").get()).toEqual({ n: 0 });
    } finally {
      store.close();
    }
  });
});
