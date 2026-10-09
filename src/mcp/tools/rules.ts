import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { EngineRule } from "../../rules/engine";
import type { App } from "../../service/app";
import { fetchForAnalysis, type SearchCriteria } from "../../service/mailbox";
import { simulateMessage } from "../../service/processor";
import type { RuleMode, RuleRow } from "../../store";
import { handler } from "../format";
import { RULE_GUIDE } from "../guide";
import { accountArg, folderArg, searchShape } from "./shared";

const modeEnum = z.enum(["enabled", "shadow", "disabled"]);

function ruleSummary(rule: RuleRow, stats?: { evaluated: number; matched: number; errors: number; lastMatchAt: string | null }) {
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    mode: rule.mode,
    priority: rule.priority,
    version: rule.version,
    updatedAt: rule.updated_at,
    last30Days: stats ?? { evaluated: 0, matched: 0, errors: 0, lastMatchAt: null },
  };
}

/** Rejects code that does not compile or does not define rule(). */
function checkCode(app: App, code: string): void {
  const compiled = app.sandbox.check(code);
  if (!compiled.ok) throw new Error(`Codice non valido (${compiled.kind}): ${compiled.error}`);
}

export function registerRuleTools(server: McpServer, app: App): void {
  server.registerTool(
    "get_rule_guide",
    {
      title: "Guida alle regole",
      description: "Returns the full guide: rule code contract, decision format, helpers, engine modes and the recommended workflow. Read it before writing rules if the server instructions were not shown to you.",
      inputSchema: {},
    },
    handler("get_rule_guide", () => RULE_GUIDE),
  );

  server.registerTool(
    "list_rules",
    {
      title: "Elenco regole",
      description: "Lists the forwarding rules in evaluation order (ascending priority) with mode and 30-day match statistics.",
      inputSchema: { includeCode: z.boolean().optional().describe("Include each rule's source code") },
    },
    handler("list_rules", ({ includeCode }: { includeCode?: boolean }) => {
      const stats = app.store.ruleStats(new Date(Date.now() - 30 * 86_400_000).toISOString());
      const rules = app.store.listRules().map((rule) => ({
        ...ruleSummary(rule, stats.get(rule.id)),
        ...(includeCode ? { code: rule.code } : {}),
      }));
      const deleted = app.store.deletedRules().map((version) => ({
        id: version.rule_id,
        name: version.name,
        deletedAt: version.saved_at,
        version: version.version,
      }));
      return { engineMode: app.mode, rules, ...(deleted.length ? { deletedRules: deleted } : {}) };
    }),
  );

  server.registerTool(
    "get_rule",
    {
      title: "Dettaglio regola",
      description: "Returns one rule with its code; with includeHistory, also every saved version (restorable with restore_rule).",
      inputSchema: { id: z.string(), includeHistory: z.boolean().optional() },
    },
    handler("get_rule", ({ id, includeHistory }: { id: string; includeHistory?: boolean }) => {
      const rule = app.store.getRule(id);
      if (!rule) throw new Error(`Regola ${id} non trovata (list_rules mostra anche quelle eliminate)`);
      const stats = app.store.ruleStats(new Date(Date.now() - 30 * 86_400_000).toISOString());
      return {
        ...ruleSummary(rule, stats.get(rule.id)),
        code: rule.code,
        ...(includeHistory
          ? {
              history: app.store.ruleVersions(id).map((version) => ({
                version: version.version,
                change: version.change,
                savedAt: version.saved_at,
                name: version.name,
                mode: version.mode,
                priority: version.priority,
                code: version.code,
              })),
            }
          : {}),
      };
    }),
  );

  server.registerTool(
    "create_rule",
    {
      title: "Crea regola",
      description:
        "Creates a forwarding rule. `code` must define `function rule(email, data, h)` returning null or a decision (see get_rule_guide). New rules start in mode 'shadow' (decisions logged, nothing executed) unless the user explicitly asked to enable them. Test the code with test_rules first.",
      inputSchema: {
        name: z.string().min(1).max(120).describe("Short name, in the user's language"),
        description: z.string().max(2000).describe("What the rule does and why, in plain words"),
        code: z.string().min(1).max(100_000),
        priority: z.number().int().min(0).max(100_000).optional().describe("Lower runs first (default 100)"),
        mode: modeEnum.optional().describe("Default 'shadow'"),
      },
    },
    handler(
      "create_rule",
      (args: { name: string; description: string; code: string; priority?: number; mode?: RuleMode }) => {
        checkCode(app, args.code);
        const rule = app.store.createRule({
          name: args.name,
          description: args.description,
          code: args.code,
          priority: args.priority ?? 100,
          mode: args.mode ?? "shadow",
        });
        return {
          created: ruleSummary(rule),
          engineMode: app.mode,
          note:
            rule.mode === "enabled" && app.mode === "live"
              ? "La regola è attiva: agisce sui prossimi messaggi."
              : "La regola registra le decisioni senza eseguirle finché regola e motore non sono attivi.",
        };
      },
    ),
  );

  server.registerTool(
    "update_rule",
    {
      title: "Modifica regola",
      description:
        "Changes a rule's code, name, description, priority or mode ('enabled' | 'shadow' | 'disabled'). Every change is versioned. Only set mode 'enabled' when the user asked for it.",
      inputSchema: {
        id: z.string(),
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(2000).optional(),
        code: z.string().min(1).max(100_000).optional(),
        priority: z.number().int().min(0).max(100_000).optional(),
        mode: modeEnum.optional(),
      },
    },
    handler(
      "update_rule",
      (args: { id: string; name?: string; description?: string; code?: string; priority?: number; mode?: RuleMode }) => {
        if (args.code !== undefined) checkCode(app, args.code);
        const { id, ...patch } = args;
        const rule = app.store.updateRule(id, patch);
        return { updated: ruleSummary(rule), engineMode: app.mode };
      },
    ),
  );

  server.registerTool(
    "delete_rule",
    {
      title: "Elimina regola",
      description: "Deletes a rule. Its versions are kept, so restore_rule can bring it back.",
      inputSchema: { id: z.string() },
    },
    handler("delete_rule", ({ id }: { id: string }) => {
      const rule = app.store.deleteRule(id);
      return { deleted: { id: rule.id, name: rule.name }, restorable: true };
    }),
  );

  server.registerTool(
    "restore_rule",
    {
      title: "Ripristina versione",
      description: "Restores a rule to a saved version (see get_rule includeHistory or list_rules deletedRules), including deleted rules.",
      inputSchema: { id: z.string(), version: z.number().int().positive() },
    },
    handler("restore_rule", ({ id, version }: { id: string; version: number }) => {
      const rule = app.store.restoreRule(id, version);
      return { restored: ruleSummary(rule), fromVersion: version };
    }),
  );

  server.registerTool(
    "test_rules",
    {
      title: "Prova regole",
      description:
        "Dry-runs rules on real messages without sending or changing anything. Pass `code` to test a draft (alone, or among the saved rules with withExistingRules), `ruleIds` to test specific saved rules, or nothing to test every non-disabled rule. Messages: explicit `uids`, or the newest `last` (default 50, max 300) optionally filtered with search criteria. Shadow rules are treated as enabled to show what would happen. Returns only matches and errors unless showAll.",
      inputSchema: {
        ...accountArg,
        ...folderArg,
        code: z.string().max(100_000).optional(),
        draftPriority: z.number().int().optional().describe("Priority of the draft among existing rules (default 100)"),
        withExistingRules: z.boolean().optional(),
        ruleIds: z.array(z.string()).optional(),
        uids: z.array(z.number().int().positive()).max(300).optional(),
        last: z.number().int().min(1).max(300).optional(),
        search: z.object(searchShape).optional(),
        showAll: z.boolean().optional(),
      },
    },
    handler(
      "test_rules",
      async (args: {
        account?: string;
        folder?: string;
        code?: string;
        draftPriority?: number;
        withExistingRules?: boolean;
        ruleIds?: string[];
        uids?: number[];
        last?: number;
        search?: SearchCriteria;
        showAll?: boolean;
      }) => {
        const saved = app.store.listRules();
        let rules: (EngineRule & { priority: number })[];
        if (args.code !== undefined) {
          checkCode(app, args.code);
          const draft = { id: "bozza", name: "bozza", code: args.code, mode: "enabled" as const, version: 0, priority: args.draftPriority ?? 100 };
          rules = args.withExistingRules
            ? [...saved.filter((rule) => rule.mode !== "disabled"), draft].sort((a, b) => a.priority - b.priority)
            : [draft];
        } else if (args.ruleIds?.length) {
          rules = args.ruleIds.map((id) => {
            const rule = saved.find((candidate) => candidate.id === id);
            if (!rule) throw new Error(`Regola ${id} non trovata`);
            return { ...rule, mode: rule.mode === "disabled" ? ("enabled" as const) : rule.mode };
          });
        } else {
          rules = saved.filter((rule) => rule.mode !== "disabled");
        }
        if (!rules.length) throw new Error("Nessuna regola da provare");

        const account = app.account(args.account);
        const folder = args.folder ?? app.defaultFolder(account);
        const results: unknown[] = [];
        let tested = 0;
        let matched = 0;
        let errors = 0;
        const perRule = new Map<string, number>();
        const { skipped } = await fetchForAnalysis(
          account,
          folder,
          { uids: args.uids, last: args.last ?? 50, criteria: args.search },
          async (message) => {
            tested++;
            try {
              const { email, outcomes, plan } = await simulateMessage(app, message, rules);
              const hit = outcomes.some((outcome) => outcome.matched);
              const failed = outcomes.some((outcome) => outcome.error);
              if (hit) matched++;
              if (failed) errors++;
              for (const outcome of outcomes) {
                if (outcome.matched) perRule.set(outcome.ruleName, (perRule.get(outcome.ruleName) ?? 0) + 1);
              }
              if (!hit && !failed && !args.showAll) return;
              results.push({
                uid: email.uid,
                date: email.date ?? email.receivedAt,
                from: email.from?.address ?? null,
                to: email.to.map((entry) => entry.address),
                cc: email.cc.map((entry) => entry.address),
                subject: email.subject,
                rules: outcomes
                  .filter((outcome) => outcome.matched || outcome.error || args.showAll)
                  .map((outcome) => ({
                    rule: outcome.ruleName,
                    ...(outcome.error ? { error: outcome.error } : { matched: outcome.matched }),
                    ...(outcome.decision ? { decision: outcome.decision } : {}),
                  })),
                wouldDo: plan.map((action) => ({
                  type: action.type,
                  status: action.status === "pending" ? "eseguirebbe" : action.status,
                  ...action.payload,
                  ...(action.note ? { note: action.note } : {}),
                })),
              });
            } catch (error) {
              errors++;
              results.push({ uid: message.uid, error: (error as Error).message });
            }
          },
        );
        return {
          folder,
          tested,
          matched,
          errors,
          matchesPerRule: Object.fromEntries(perRule),
          ...(skipped.length ? { skippedTooLarge: skipped } : {}),
          results,
        };
      },
    ),
  );
}
