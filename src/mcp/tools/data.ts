import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { App } from "../../service/app";
import { handler } from "../format";

const KEY = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "letters, digits and _ (a valid JS identifier)");

export function registerDataTools(server: McpServer, app: App): void {
  server.registerTool(
    "list_data",
    {
      title: "Dati di riferimento",
      description:
        "Lists the reference data entries that every rule receives as `data` (e.g. staff directory, office addresses, supplier → office mappings).",
      inputSchema: { includeValues: z.boolean().optional() },
    },
    handler("list_data", ({ includeValues }: { includeValues?: boolean }) =>
      app.store.listData().map((row) => ({
        key: row.key,
        description: row.description,
        updatedAt: row.updated_at,
        ...(includeValues ? { value: JSON.parse(row.value) } : { size: row.value.length }),
      })),
    ),
  );

  server.registerTool(
    "get_data",
    {
      title: "Leggi dato",
      description: "Returns one reference data entry.",
      inputSchema: { key: KEY },
    },
    handler("get_data", ({ key }: { key: string }) => {
      const row = app.store.getData(key);
      if (!row) throw new Error(`Nessun dato con chiave ${key}`);
      return { key: row.key, description: row.description, updatedAt: row.updated_at, value: JSON.parse(row.value) };
    }),
  );

  server.registerTool(
    "set_data",
    {
      title: "Salva dato",
      description:
        "Creates or replaces a reference data entry, available to every rule as data.<key>. Use it for lists the user may change (people, offices, addresses, keywords) instead of hard-coding them in rules. Takes effect on the next message.",
      inputSchema: {
        key: KEY,
        value: z.unknown().describe("Any JSON value: object, array, string, number"),
        description: z.string().max(1000).optional(),
      },
    },
    handler("set_data", ({ key, value, description }: { key: string; value: unknown; description?: string }) => {
      if (value === undefined) throw new Error("value è obbligatorio");
      const serialized = JSON.stringify(value);
      if (serialized.length > 1_000_000) throw new Error("Valore troppo grande (massimo 1 MB)");
      const previous = app.store.getData(key);
      app.store.setData(key, value, description ?? previous?.description ?? "");
      return { saved: key, replaced: Boolean(previous) };
    }),
  );

  server.registerTool(
    "delete_data",
    {
      title: "Elimina dato",
      description: "Deletes a reference data entry. Check with list_rules (includeCode) that no rule still reads it.",
      inputSchema: { key: KEY },
    },
    handler("delete_data", ({ key }: { key: string }) => {
      if (!app.store.deleteData(key)) throw new Error(`Nessun dato con chiave ${key}`);
      const users = app.store.listRules().filter((rule) => rule.code.includes(key)).map((rule) => rule.name);
      return { deleted: key, ...(users.length ? { warning: `Regole che citano ancora "${key}": ${users.join(", ")}` } : {}) };
    }),
  );
}
