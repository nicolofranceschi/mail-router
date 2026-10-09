import type { ActionStatus, ActionType, EngineMode, RuleMode } from "../store";
import { normalizeAddress, parseDecision, type Decision } from "./decision";
import type { RuleSandbox } from "./sandbox";
import type { RuleEmail } from "./types";

export interface EngineRule {
  id: string;
  name: string;
  code: string;
  mode: RuleMode;
  version: number;
}

export interface RuleOutcome {
  ruleId: string;
  ruleName: string;
  ruleVersion: number;
  ruleMode: RuleMode;
  matched: boolean;
  decision: Decision | null;
  error: string | null;
  durationMs: number;
}

/**
 * Runs the rules in priority order (the caller passes them sorted). A rule
 * that throws or returns garbage is recorded as an error and skipped: one
 * broken rule must not stop the others.
 */
export function evaluateRules(
  sandbox: RuleSandbox,
  rules: EngineRule[],
  email: RuleEmail,
  data: Record<string, unknown>,
  timeoutMs: number,
): RuleOutcome[] {
  const outcomes: RuleOutcome[] = [];
  for (const rule of rules) {
    if (rule.mode === "disabled") continue;
    const base = { ruleId: rule.id, ruleName: rule.name, ruleVersion: rule.version, ruleMode: rule.mode };
    const result = sandbox.run(rule.code, { email, data }, timeoutMs);
    if (!result.ok) {
      outcomes.push({ ...base, matched: false, decision: null, error: result.error, durationMs: result.durationMs });
      continue;
    }
    try {
      const parsed = parseDecision(result.value);
      outcomes.push({
        ...base,
        matched: parsed.matched,
        decision: parsed.matched ? parsed.decision : null,
        error: null,
        durationMs: result.durationMs,
      });
      if (parsed.matched && parsed.decision.stop) break;
    } catch (error) {
      outcomes.push({
        ...base,
        matched: false,
        decision: null,
        error: (error as Error).message,
        durationMs: result.durationMs,
      });
    }
  }
  return outcomes;
}

export interface PlannedAction {
  seq: number;
  ruleId: string | null;
  type: ActionType;
  payload: Record<string, unknown>;
  status: Extract<ActionStatus, "pending" | "simulated" | "blocked" | "skipped">;
  note: string | null;
}

export interface PlanContext {
  engineMode: EngineMode;
  /** Treat shadow rules as enabled: used by test runs to show what *would* happen. */
  treatShadowAsEnabled?: boolean;
  allowedDomains: string[];
  ownAddresses: string[];
  alreadyForwarded: Set<string>;
  markForwarded: boolean;
  /** Folder the original goes to once forwarded (account setting). */
  moveAfterForward?: string | null;
}

const TYPE_ORDER: Record<string, number> = { forward: 0, flags: 1, seen: 2, move: 3 };

export function domainAllowed(address: string, allowedDomains: string[]): boolean {
  if (!allowedDomains.length) return true;
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return allowedDomains.some((allowed) => {
    const wanted = allowed.trim().toLowerCase().replace(/^@/, "");
    return domain === wanted || domain.endsWith(`.${wanted}`);
  });
}

/**
 * Turns rule decisions into an ordered action list. Forwards run first, then
 * flags, read state and finally the move (which changes the UID). Live actions
 * are `pending` (the executor sends them); shadow-mode ones are `simulated`.
 */
export function planActions(outcomes: RuleOutcome[], ctx: PlanContext): PlannedAction[] {
  const own = new Set(ctx.ownAddresses.map(normalizeAddress));
  const forwardedLive = new Set(ctx.alreadyForwarded);
  const forwardedSimulated = new Set<string>();
  const actions: Omit<PlannedAction, "seq">[] = [];
  let liveMove = false;
  let simulatedMove = false;

  for (const outcome of outcomes) {
    if (!outcome.matched || !outcome.decision) continue;
    const decision = outcome.decision;
    const live =
      ctx.engineMode === "live" &&
      (outcome.ruleMode === "enabled" || (ctx.treatShadowAsEnabled === true && outcome.ruleMode === "shadow"));
    const status = live ? "pending" : "simulated";

    if (decision.forward) {
      const seen = live ? forwardedLive : forwardedSimulated;
      const pick = (addresses: string[]) => {
        const kept: string[] = [];
        const blocked: string[] = [];
        const skipped: string[] = [];
        for (const address of addresses) {
          if (own.has(address)) skipped.push(address);
          else if (!domainAllowed(address, ctx.allowedDomains)) blocked.push(address);
          else if (seen.has(address)) skipped.push(address);
          else kept.push(address);
        }
        return { kept, blocked, skipped };
      };
      const to = pick(decision.forward.to);
      const cc = pick(decision.forward.cc.filter((address) => !decision.forward!.to.includes(address)));
      const blocked = [...to.blocked, ...cc.blocked];
      const skipped = [...to.skipped, ...cc.skipped];
      if (to.kept.length || cc.kept.length) {
        // With every To recipient filtered out, the remaining Cc become the To.
        const finalTo = to.kept.length ? to.kept : cc.kept;
        const finalCc = to.kept.length ? cc.kept : [];
        for (const address of [...finalTo, ...finalCc]) seen.add(address);
        actions.push({
          ruleId: outcome.ruleId,
          type: "forward",
          payload: {
            to: finalTo,
            cc: finalCc,
            note: decision.forward.note,
            asAttachment: decision.forward.asAttachment,
            replyToSender: decision.forward.replyToSender,
          },
          status,
          note: skipped.length ? `già inoltrata o indirizzo della casella: ${skipped.join(", ")}` : null,
        });
      } else if (skipped.length && !blocked.length) {
        actions.push({
          ruleId: outcome.ruleId,
          type: "forward",
          payload: { to: skipped, cc: [] },
          status: "skipped",
          note: "già inoltrata a questi destinatari (o indirizzo della casella stessa)",
        });
      }
      if (blocked.length) {
        actions.push({
          ruleId: outcome.ruleId,
          type: "forward",
          payload: { to: blocked, cc: [] },
          status: "blocked",
          note: `dominio non ammesso dalla configurazione (outbound.allowedDomains: ${ctx.allowedDomains.join(", ")})`,
        });
      }
    }

    if (decision.flags.length) {
      actions.push({ ruleId: outcome.ruleId, type: "flags", payload: { flags: decision.flags }, status, note: null });
    }
    if (decision.markRead) {
      actions.push({ ruleId: outcome.ruleId, type: "seen", payload: {}, status, note: null });
    }
    if (decision.moveTo) {
      const already = live ? liveMove : simulatedMove;
      if (already) {
        actions.push({
          ruleId: outcome.ruleId,
          type: "move",
          payload: { target: decision.moveTo },
          status: "skipped",
          note: "un'altra regola con priorità più alta sposta già il messaggio",
        });
      } else {
        if (live) liveMove = true;
        else simulatedMove = true;
        actions.push({ ruleId: outcome.ruleId, type: "move", payload: { target: decision.moveTo }, status, note: null });
      }
    }
  }

  const liveForward = actions.some((action) => action.type === "forward" && action.status === "pending");
  const simulatedForward = actions.some((action) => action.type === "forward" && action.status === "simulated");
  if (ctx.markForwarded && liveForward) {
    actions.push({ ruleId: null, type: "flags", payload: { flags: ["$Forwarded"] }, status: "pending", note: "inoltro automatico" });
  }
  // Once forwarded, the original leaves the inbox: whoever still works it by hand knows it is done.
  if (ctx.moveAfterForward) {
    if (liveForward && !liveMove) {
      actions.push({ ruleId: null, type: "move", payload: { target: ctx.moveAfterForward }, status: "pending", note: "dopo l'inoltro" });
    } else if (simulatedForward && !liveForward && !simulatedMove) {
      actions.push({ ruleId: null, type: "move", payload: { target: ctx.moveAfterForward }, status: "simulated", note: "dopo l'inoltro" });
    }
  }

  return actions
    .map((action, index) => ({ action, index }))
    .sort((a, b) => TYPE_ORDER[a.action.type]! - TYPE_ORDER[b.action.type]! || a.index - b.index)
    .map(({ action }, seq) => ({ ...action, seq }));
}
