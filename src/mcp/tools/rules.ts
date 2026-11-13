import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { EngineRule } from "../../rules/engine";
import type { Scope } from "../../scope";
import type { App } from "../../service/app";
import { fetchForAnalysis, listFolders, type SearchCriteria } from "../../service/mailbox";
import { simulateMessage } from "../../service/processor";
import type { EngineMode, RuleMode, RuleRow } from "../../store";
import { handler } from "../format";
import { RULE_GUIDE } from "../guide";
import { accountArg, folderArg, searchShape } from "./shared";

const modeEnum = z.enum(["enabled", "shadow", "disabled"]);

type RuleEffect = "live" | "simulated" | "off";

/** What a rule does right now: its own mode alone does not say, the engine mode counts too. */
function ruleEffect(mode: RuleMode, engineMode: EngineMode): RuleEffect {
  if (mode === "disabled" || engineMode === "paused") return "off";
  return mode === "enabled" && engineMode === "live" ? "live" : "simulated";
}

const EFFECT_NOTE: Record<RuleEffect, string> = {
  live: "La regola è attiva: agisce sui prossimi messaggi.",
  simulated: "La regola registra le decisioni senza eseguirle finché regola e motore non sono attivi.",
  off: "La regola non gira: è disattivata oppure il motore è in pausa.",
};

function ruleSummary(
  rule: RuleRow,
  engineMode: EngineMode,
  stats?: { evaluated: number; matched: number; errors: number; lastMatchAt: string | null },
) {
  return {
    id: rule.id,
    account: rule.account,
    name: rule.name,
    description: rule.description,
    mode: rule.mode,
    effect: ruleEffect(rule.mode, engineMode),
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

/** The mailbox a new rule goes to: the one named, or the caller's only one. */
function targetAccount(app: App, scope: Scope, requested?: string): string {
  if (requested) return scope.accountId(app, requested);
  const mine = scope.accountIds(app);
  if (mine.length > 1) throw new Error(`Indica la casella della regola con account (una di: ${mine.join(", ")})`);
  return scope.accountId(app);
}

export function registerRuleTools(server: McpServer, app: App, scope: Scope): void {
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
      description:
        "Lists the rules of your mailboxes in evaluation order (ascending priority) with their mailbox (`account`), mode, 30-day match statistics and `effect`: 'live' (executing now: rule enabled and engine live), 'simulated' (decisions logged only) or 'off'. Each mailbox has its own rules: a message only goes through the rules of its mailbox. onlyActive returns just the 'live' ones. account: only that mailbox's rules.",
      inputSchema: {
        account: z.string().optional().describe("Only the rules of this mailbox (default: all your mailboxes)"),
        includeCode: z.boolean().optional().describe("Include each rule's source code"),
        onlyActive: z.boolean().optional().describe("Only the rules executing right now"),
      },
    },
    handler("list_rules", ({ account, includeCode, onlyActive }: { account?: string; includeCode?: boolean; onlyActive?: boolean }) => {
      const stats = app.store.ruleStats(new Date(Date.now() - 30 * 86_400_000).toISOString());
      const accounts = account ? [scope.accountId(app, account)] : scope.accountFilter(app);
      const rules = app.store
        .listRules(accounts ? { accounts, includeShared: scope.isAdmin } : {})
        .map((rule) => ({
          ...ruleSummary(rule, app.mode, stats.get(rule.id)),
          ...(includeCode ? { code: rule.code } : {}),
        }))
        .filter((rule) => !onlyActive || rule.effect === "live");
      const deleted = app.store.deletedRules(accounts ? { accounts } : {}).map((version) => ({
        id: version.rule_id,
        account: version.account,
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
      scope.requireRuleAccess(app, id);
      const rule = app.store.getRule(id);
      if (!rule) throw new Error(`Regola ${id} non trovata (list_rules mostra anche quelle eliminate)`);
      const stats = app.store.ruleStats(new Date(Date.now() - 30 * 86_400_000).toISOString());
      return {
        ...ruleSummary(rule, app.mode, stats.get(rule.id)),
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
        "Creates a rule in one mailbox: it only sees that mailbox's messages and reference data. `code` must define `function rule(email, data, h)` returning null or a decision (see get_rule_guide). New rules start in mode 'shadow' (decisions logged, nothing executed) unless the user explicitly asked to enable them. Test the code with test_rules first.",
      inputSchema: {
        account: z.string().optional().describe("Mailbox id the rule belongs to (required when you have more than one, see get_status)"),
        name: z.string().min(1).max(120).describe("Short name, in the user's language"),
        description: z.string().max(2000).describe("What the rule does and why, in plain words"),
        code: z.string().min(1).max(100_000),
        priority: z.number().int().min(0).max(100_000).optional().describe("Lower runs first (default 100)"),
        mode: modeEnum.optional().describe("Default 'shadow'"),
      },
    },
    handler(
      "create_rule",
      (args: { account?: string; name: string; description: string; code: string; priority?: number; mode?: RuleMode }) => {
        const account = targetAccount(app, scope, args.account);
        checkCode(app, args.code);
        const rule = app.store.createRule({
          account,
          name: args.name,
          description: args.description,
          code: args.code,
          priority: args.priority ?? 100,
          mode: args.mode ?? "shadow",
        });
        return {
          created: ruleSummary(rule, app.mode),
          engineMode: app.mode,
          note: EFFECT_NOTE[ruleEffect(rule.mode, app.mode)],
        };
      },
    ),
  );

  server.registerTool(
    "update_rule",
    {
      title: "Modifica regola",
      description:
        "Changes a rule's code, name, description, priority, mode or mailbox. This is how a rule is published (mode 'enabled'), sent back to observation ('shadow') or switched off ('disabled'). Every change is versioned. Only set mode 'enabled' when the user asked for it. New code on an enabled rule applies from the next message: try it with test_rules first.",
      inputSchema: {
        id: z.string(),
        account: z.string().optional().describe("Move the rule to this mailbox (one of yours)"),
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(2000).optional(),
        code: z.string().min(1).max(100_000).optional(),
        priority: z.number().int().min(0).max(100_000).optional(),
        mode: modeEnum.optional(),
      },
    },
    handler(
      "update_rule",
      (args: { id: string; account?: string; name?: string; description?: string; code?: string; priority?: number; mode?: RuleMode }) => {
        scope.requireRuleAccess(app, args.id);
        if (args.account !== undefined) scope.accountId(app, args.account);
        if (args.code !== undefined) checkCode(app, args.code);
        const { id, ...patch } = args;
        const rule = app.store.updateRule(id, patch);
        return { updated: ruleSummary(rule, app.mode), engineMode: app.mode, note: EFFECT_NOTE[ruleEffect(rule.mode, app.mode)] };
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
      scope.requireRuleAccess(app, id);
      const rule = app.store.deleteRule(id);
      return { deleted: { id: rule.id, name: rule.name }, restorable: true };
    }),
  );

  server.registerTool(
    "restore_rule",
    {
      title: "Ripristina versione",
      description: "Restores a rule to a saved version (see get_rule includeHistory or list_rules deletedRules), including deleted rules. The version's mode comes back too: a version that was enabled is live again at once.",
      inputSchema: { id: z.string(), version: z.number().int().positive() },
    },
    handler("restore_rule", ({ id, version }: { id: string; version: number }) => {
      scope.requireRuleAccess(app, id);
      const snapshot = app.store.ruleVersions(id).find((entry) => entry.version === version);
      // An old version may belong to a mailbox the caller cannot see: restoring it there would act on someone else's mail.
      if (snapshot && !scope.canSee(snapshot.account)) throw new Error(`La versione ${version} appartiene a un'altra casella`);
      const rule = app.store.restoreRule(id, version);
      return { restored: ruleSummary(rule, app.mode), fromVersion: version, engineMode: app.mode, note: EFFECT_NOTE[ruleEffect(rule.mode, app.mode)] };
    }),
  );

  server.registerTool(
    "test_rules",
    {
      title: "Prova regole",
      description:
        "Dry-runs rules on real messages of one mailbox without sending or changing anything. Pass `code` to test a draft (alone, or among that mailbox's saved rules with withExistingRules), `ruleIds` to test specific saved rules, or nothing to test every non-disabled rule of the mailbox. Messages: explicit `uids`, or the newest `last` (default 50, max 300) optionally filtered with search criteria. Shadow rules are treated as enabled to show what would happen. Returns only matches and errors unless showAll. foldersToBeCreated lists moveTo targets that do not exist yet: a real move would create them, so check them for typos.",
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
        const account = scope.account(app, args.account);
        const saved = app.store.rulesForAccount(account.config.id);
        let rules: (EngineRule & { priority: number })[];
        if (args.code !== undefined) {
          checkCode(app, args.code);
          const draft = { id: "bozza", name: "bozza", code: args.code, mode: "enabled" as const, version: 0, priority: args.draftPriority ?? 100 };
          rules = args.withExistingRules
            ? [...saved.filter((rule) => rule.mode !== "disabled"), draft].sort((a, b) => a.priority - b.priority)
            : [draft];
        } else if (args.ruleIds?.length) {
          rules = args.ruleIds.map((id) => {
            scope.requireRuleAccess(app, id);
            const rule = app.store.getRule(id);
            if (!rule) throw new Error(`Regola ${id} non trovata`);
            return { ...rule, mode: rule.mode === "disabled" ? ("enabled" as const) : rule.mode };
          });
        } else {
          rules = saved.filter((rule) => rule.mode !== "disabled");
        }
        if (!rules.length) throw new Error("Nessuna regola da provare");

        const folder = args.folder ?? app.defaultFolder(account);
        const results: unknown[] = [];
        let tested = 0;
        let matched = 0;
        let errors = 0;
        const perRule = new Map<string, number>();
        const moveTargets = new Set<string>();
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
              for (const action of plan) {
                if (action.type === "move" && action.status === "pending") moveTargets.add(action.payload.target as string);
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
        const existing = new Set(moveTargets.size ? (await listFolders(account)).map((entry) => entry.path) : []);
        const foldersToBeCreated = [...moveTargets].filter((target) => !existing.has(target));
        return {
          folder,
          tested,
          matched,
          errors,
          matchesPerRule: Object.fromEntries(perRule),
          ...(skipped.length ? { skippedTooLarge: skipped } : {}),
          ...(foldersToBeCreated.length ? { foldersToBeCreated } : {}),
          results,
        };
      },
    ),
  );
}
