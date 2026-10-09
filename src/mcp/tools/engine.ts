import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { log } from "../../log";
import type { App } from "../../service/app";
import { fetchMessage } from "../../service/mailbox";
import { processMessage, simulateMessage } from "../../service/processor";
import type { ActionRow, ActionStatus, EngineMode, EvaluationRow } from "../../store";
import { handler } from "../format";
import { accountArg, folderArg, uidArg } from "./shared";

function actionView(action: ActionRow) {
  const payload = JSON.parse(action.payload) as Record<string, unknown>;
  delete payload.envelope;
  return {
    id: action.id,
    type: action.type,
    status: action.status,
    ruleId: action.rule_id,
    ...payload,
    ...(action.attempts ? { attempts: action.attempts } : {}),
    ...(action.last_error ? { detail: action.last_error } : {}),
    ...(action.next_attempt_at && action.status === "pending" ? { retryAt: action.next_attempt_at } : {}),
    ...(action.result ? { result: JSON.parse(action.result) } : {}),
  };
}

export function activityFor(app: App, evaluations: EvaluationRow[]) {
  const ids = evaluations.map((evaluation) => evaluation.id);
  const results = app.store.ruleResultsFor(ids);
  const actions = app.store.actionsFor(ids);
  return evaluations.map((evaluation) => ({
    evaluationId: evaluation.id,
    at: evaluation.created_at,
    origin: evaluation.origin,
    engineMode: evaluation.engine_mode,
    message: {
      account: evaluation.account,
      folder: evaluation.folder,
      uid: evaluation.uid,
      date: evaluation.date,
      from: evaluation.from_name ? `${evaluation.from_name} <${evaluation.from_address}>` : evaluation.from_address,
      subject: evaluation.subject,
    },
    ...(evaluation.note ? { note: evaluation.note } : {}),
    rules: results
      .filter((result) => result.evaluation_id === evaluation.id && (result.matched || result.error))
      .map((result) => ({
        rule: result.rule_name,
        ruleId: result.rule_id,
        mode: result.rule_mode,
        ...(result.error ? { error: result.error } : {}),
        ...(result.decision ? { reason: (JSON.parse(result.decision) as { reason?: string }).reason ?? null } : {}),
      })),
    actions: actions.filter((action) => action.evaluation_id === evaluation.id).map(actionView),
  }));
}

export function registerEngineTools(server: McpServer, app: App): void {
  server.registerTool(
    "get_status",
    {
      title: "Stato del servizio",
      description:
        "Service status: engine mode, watched folders (connection, last check, errors), outbox counts, rule counts, accounts and the forward-domain allowlist.",
      inputSchema: {},
    },
    handler("get_status", () => app.status()),
  );

  server.registerTool(
    "set_mode",
    {
      title: "Modalità del motore",
      description:
        "Sets the engine mode: 'live' executes enabled rules, 'shadow' only logs decisions, 'paused' stops processing new messages. Leaving live cancels queued automatic actions. skipBacklog moves past messages that arrived while paused instead of processing them. Only switch to live when the user explicitly asks.",
      inputSchema: {
        mode: z.enum(["live", "shadow", "paused"]),
        skipBacklog: z.boolean().optional(),
      },
    },
    handler("set_mode", ({ mode, skipBacklog }: { mode: EngineMode; skipBacklog?: boolean }) => {
      const result = app.setMode(mode, { skipBacklog });
      return { mode, previous: result.previous, cancelledQueuedActions: result.cancelled };
    }),
  );

  server.registerTool(
    "list_activity",
    {
      title: "Attività",
      description:
        "What the router did, newest first: each processed message with the rules that matched (or failed) and the actions with their status (done, pending, error, simulated, blocked, skipped, cancelled).",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Default 30"),
        sinceHours: z.number().positive().optional(),
        onlyMatched: z.boolean().optional(),
        ruleId: z.string().optional().describe("Only messages this rule matched"),
        ...accountArg,
        folder: z.string().optional(),
        uid: z.number().int().positive().optional(),
      },
    },
    handler(
      "list_activity",
      (args: { limit?: number; sinceHours?: number; onlyMatched?: boolean; ruleId?: string; account?: string; folder?: string; uid?: number }) => {
        const evaluations = app.store.listEvaluations({
          limit: args.limit ?? 30,
          sinceIso: args.sinceHours ? new Date(Date.now() - args.sinceHours * 3_600_000).toISOString() : undefined,
          onlyMatched: args.onlyMatched,
          ruleId: args.ruleId,
          account: args.account,
          folder: args.folder,
          uid: args.uid,
        });
        return { engineMode: app.mode, activity: activityFor(app, evaluations) };
      },
    ),
  );

  server.registerTool(
    "list_outbox",
    {
      title: "Coda azioni",
      description: "Lists queued, failed or recent actions (automatic and manual), newest first.",
      inputSchema: {
        status: z.enum(["pending", "running", "done", "error", "simulated", "blocked", "skipped", "cancelled"]).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    handler("list_outbox", ({ status, limit }: { status?: ActionStatus; limit?: number }) =>
      app.store.listActions({ status, limit: limit ?? 30 }).map((action) => ({
        ...actionView(action),
        account: action.account,
        folder: action.folder,
        uid: action.uid,
        origin: action.origin,
        createdAt: action.created_at,
      })),
    ),
  );

  server.registerTool(
    "retry_failed",
    {
      title: "Riprova azioni fallite",
      description: "Puts failed automatic actions (status 'error') back in the queue — one by id, or all. They run when the engine is live.",
      inputSchema: { actionId: z.number().int().positive().optional() },
    },
    handler("retry_failed", ({ actionId }: { actionId?: number }) => {
      const requeued = app.store.retryErroredActions(actionId);
      if (requeued) app.executor.kick();
      return { requeued, engineMode: app.mode };
    }),
  );

  server.registerTool(
    "reprocess_email",
    {
      title: "Rielabora messaggio",
      description:
        "Runs the current rules on an existing message. With execute=false (default) it only shows what would happen. With execute=true the result is recorded and, if the engine is live, enabled rules' actions are executed — recipients already reached for this message are not forwarded again.",
      inputSchema: { ...accountArg, ...folderArg, ...uidArg, execute: z.boolean().optional() },
    },
    handler(
      "reprocess_email",
      async (args: { account?: string; folder?: string; uid: number; execute?: boolean }) => {
        const account = app.account(args.account);
        const folder = args.folder ?? app.defaultFolder(account);
        const message = await fetchMessage(account, folder, args.uid);
        if (!args.execute) {
          const { email, outcomes, plan } = await simulateMessage(app, message, app.engineRules());
          return {
            simulated: true,
            subject: email.subject,
            rules: outcomes.map((outcome) => ({
              rule: outcome.ruleName,
              mode: outcome.ruleMode,
              matched: outcome.matched,
              ...(outcome.error ? { error: outcome.error } : {}),
              ...(outcome.decision ? { decision: outcome.decision } : {}),
            })),
            wouldDo: plan,
          };
        }
        const result = await processMessage(app, message, "reprocess");
        log.info(`rielaborazione manuale UID ${args.uid} in ${folder} (valutazione ${result.evaluationId})`);
        const [evaluation] = app.store.listEvaluations({ limit: 1, uid: args.uid, folder, account: account.config.id });
        return { engineMode: app.mode, ...(evaluation ? activityFor(app, [evaluation])[0] : {}) };
      },
    ),
  );

  server.registerTool(
    "get_logs",
    {
      title: "Log del servizio",
      description: "Last lines of the service log (since the last restart), for diagnosing connection or delivery problems.",
      inputSchema: {
        lines: z.number().int().min(1).max(1000).optional(),
        level: z.enum(["debug", "info", "warn", "error"]).optional(),
      },
    },
    handler("get_logs", ({ lines, level }: { lines?: number; level?: "debug" | "info" | "warn" | "error" }) =>
      log.tail(lines ?? 100, level ?? "info").join("\n") || "(log vuoto)",
    ),
  );
}
