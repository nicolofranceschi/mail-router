import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Scope } from "../../scope";
import type { App } from "../../service/app";
import { handler } from "../format";

const KEY = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "letters, digits and _ (a valid JS identifier)");

const where = {
  account: z.string().optional().describe("Mailbox id (default: your first mailbox, see get_status)"),
  shared: z
    .boolean()
    .optional()
    .describe("Administrators only: the old entries from before mailboxes had their own data, seen by every mailbox's rules"),
};

/** Reference data belong to one mailbox; "" is the old shared set, administrators only. */
function dataAccount(app: App, scope: Scope, args: { account?: string; shared?: boolean }): string {
  if (args.shared) {
    if (!scope.isAdmin) throw new Error("I dati comuni a tutte le caselle sono riservati agli amministratori");
    return "";
  }
  return scope.accountId(app, args.account);
}

export function registerDataTools(server: McpServer, app: App, scope: Scope): void {
  server.registerTool(
    "list_data",
    {
      title: "Dati di riferimento",
      description:
        "Lists a mailbox's reference data entries, which that mailbox's rules receive as `data` (e.g. staff directory, office addresses, supplier → office mappings). Every mailbox has its own.",
      inputSchema: { ...where, includeValues: z.boolean().optional() },
    },
    handler("list_data", (args: { account?: string; shared?: boolean; includeValues?: boolean }) => {
      const account = dataAccount(app, scope, args);
      const entries = app.store.listData(account).map((row) => ({
        key: row.key,
        description: row.description,
        updatedAt: row.updated_at,
        ...(args.includeValues ? { value: JSON.parse(row.value) } : { size: row.value.length }),
      }));
      const sharedCount = scope.isAdmin && account ? app.store.listData("").length : 0;
      return { account: account || null, entries, ...(sharedCount ? { sharedOldEntries: sharedCount } : {}) };
    }),
  );

  server.registerTool(
    "get_data",
    {
      title: "Leggi dato",
      description: "Returns one reference data entry of a mailbox.",
      inputSchema: { ...where, key: KEY },
    },
    handler("get_data", (args: { account?: string; shared?: boolean; key: string }) => {
      const row = app.store.getData(dataAccount(app, scope, args), args.key);
      if (!row) throw new Error(`Nessun dato con chiave ${args.key}`);
      return { key: row.key, account: row.account || null, description: row.description, updatedAt: row.updated_at, value: JSON.parse(row.value) };
    }),
  );

  server.registerTool(
    "set_data",
    {
      title: "Salva dato",
      description:
        "Creates or replaces a reference data entry of a mailbox, available to that mailbox's rules as data.<key>. Use it for lists the user may change (people, offices, addresses, keywords) instead of hard-coding them in rules. Takes effect on the next message.",
      inputSchema: {
        ...where,
        key: KEY,
        value: z.unknown().describe("Any JSON value: object, array, string, number"),
        description: z.string().max(1000).optional(),
      },
    },
    handler("set_data", (args: { account?: string; shared?: boolean; key: string; value: unknown; description?: string }) => {
      if (args.value === undefined) throw new Error("value è obbligatorio");
      const serialized = JSON.stringify(args.value);
      if (serialized.length > 1_000_000) throw new Error("Valore troppo grande (massimo 1 MB)");
      const account = dataAccount(app, scope, args);
      const previous = app.store.getData(account, args.key);
      app.store.setData(account, args.key, args.value, args.description ?? previous?.description ?? "");
      return { saved: args.key, account: account || null, replaced: Boolean(previous) };
    }),
  );

  server.registerTool(
    "delete_data",
    {
      title: "Elimina dato",
      description: "Deletes a reference data entry of a mailbox. Check with list_rules (includeCode) that no rule of that mailbox still reads it.",
      inputSchema: { ...where, key: KEY },
    },
    handler("delete_data", (args: { account?: string; shared?: boolean; key: string }) => {
      const account = dataAccount(app, scope, args);
      if (!app.store.deleteData(account, args.key)) throw new Error(`Nessun dato con chiave ${args.key}`);
      const readers = (account ? app.store.rulesForAccount(account) : app.store.listRules())
        .filter((rule) => rule.code.includes(args.key))
        .map((rule) => rule.name);
      return {
        deleted: args.key,
        ...(readers.length ? { warning: `Regole che citano ancora "${args.key}": ${readers.join(", ")}` } : {}),
      };
    }),
  );
}
