import type { ParsedMail } from "mailparser";

import { errorMessage } from "../log";
import { buildForward, LOOP_HEADER_KEY } from "../mail/compose";
import { buildRuleEmail, parseRaw } from "../mail/parse";
import { evaluateRules, planActions, type EngineRule, type PlannedAction, type RuleOutcome } from "../rules/engine";
import type { RuleEmail } from "../rules/types";
import type { ActionInput } from "../store";
import type { App } from "./app";
import type { AccountRuntime } from "../mail/clients";

export interface FetchedMessage {
  account: AccountRuntime;
  folder: string;
  uidValidity: string;
  uid: number;
  flags: Iterable<string>;
  size: number;
  internalDate: Date | string | null | undefined;
  raw: Buffer;
}

export interface ProcessResult {
  evaluationId: number;
  email: RuleEmail | null;
  outcomes: RuleOutcome[];
  actions: ActionInput[];
  note: string | null;
}

function isOwnOutput(app: App, parsed: ParsedMail): boolean {
  const header = parsed.headers.get(LOOP_HEADER_KEY);
  return typeof header === "string" && header.trim() === app.instanceId;
}

/**
 * Evaluates the rules on one message, prepares the outgoing MIME for every
 * live forward and stores decision + outbox (+ watermark) in one transaction.
 * Sending happens later, in the executor.
 */
export async function processMessage(
  app: App,
  message: FetchedMessage,
  origin: "watch" | "reprocess",
  watermark?: { watchId: string; uidValidity: string; lastUid: number },
): Promise<ProcessResult> {
  const accountConfig = message.account.config;
  const parsed = await parseRaw(message.raw);
  const base = {
    account: accountConfig.id,
    folder: message.folder,
    uidValidity: message.uidValidity,
    uid: message.uid,
    messageId: parsed.messageId ?? null,
    subject: parsed.subject ?? null,
    fromAddress: parsed.from?.value[0]?.address?.toLowerCase() ?? null,
    fromName: parsed.from?.value[0]?.name ?? null,
    date: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : null,
    origin,
    engineMode: app.mode,
  } as const;

  if (isOwnOutput(app, parsed)) {
    const note = "messaggio inviato da questo router: ignorato per evitare cicli";
    const evaluationId = app.store.recordEvaluation({ ...base, matched: false, note }, [], [], watermark);
    return { evaluationId, email: null, outcomes: [], actions: [], note };
  }

  const email = await buildRuleEmail(
    parsed,
    {
      account: accountConfig.id,
      folder: message.folder,
      uid: message.uid,
      flags: message.flags,
      size: message.size,
      internalDate: message.internalDate,
    },
    app.config.engine.maxTextChars,
  );
  const outcomes = evaluateRules(app.sandbox, app.engineRules(), email, app.store.dataObject(), app.config.engine.ruleTimeoutMs);
  const plan = planActions(outcomes, {
    engineMode: app.mode,
    allowedDomains: app.config.outbound.allowedDomains,
    ownAddresses: app.ownAddresses(message.account),
    alreadyForwarded: app.store.forwardedRecipients(accountConfig.id, email.messageId, message.folder, message.uid),
    markForwarded: accountConfig.markForwarded,
    moveAfterForward: accountConfig.moveAfterForward ?? null,
  });

  const actions: ActionInput[] = [];
  for (const planned of plan) {
    actions.push(await prepareAction(app, message, parsed, email, planned));
  }

  const evaluationId = app.store.recordEvaluation(
    { ...base, matched: outcomes.some((outcome) => outcome.matched) },
    outcomes.map((outcome) => ({
      ruleId: outcome.ruleId,
      ruleName: outcome.ruleName,
      ruleVersion: outcome.ruleVersion,
      ruleMode: outcome.ruleMode,
      matched: outcome.matched,
      decision: outcome.decision,
      error: outcome.error,
      durationMs: outcome.durationMs,
    })),
    actions,
    watermark,
  );
  if (actions.some((action) => action.status === "pending")) app.executor.kick();
  return { evaluationId, email, outcomes, actions, note: null };
}

async function prepareAction(
  app: App,
  message: FetchedMessage,
  parsed: ParsedMail,
  email: RuleEmail,
  planned: PlannedAction,
): Promise<ActionInput> {
  const action: ActionInput = {
    seq: planned.seq,
    ruleId: planned.ruleId,
    account: message.account.config.id,
    folder: message.folder,
    uidValidity: message.uidValidity,
    uid: message.uid,
    messageId: email.messageId,
    type: planned.type,
    payload: planned.payload,
    status: planned.status,
    lastError: planned.status === "pending" ? null : planned.note,
    origin: "rule",
  };
  if (planned.status === "pending" && planned.note) action.payload = { ...planned.payload, info: planned.note };
  if (planned.type !== "forward" || planned.status !== "pending") return action;

  if (!message.account.config.smtp) {
    return { ...action, status: "blocked", lastError: "account senza SMTP configurato: impossibile inoltrare" };
  }
  const payload = planned.payload as {
    to: string[];
    cc: string[];
    note: string | null;
    asAttachment: boolean | null;
    replyToSender: boolean;
  };
  try {
    const composed = await buildForward({
      original: parsed,
      originalRaw: message.raw,
      identity: app.identity(message.account),
      to: payload.to,
      cc: payload.cc,
      note: payload.note,
      asAttachment: payload.asAttachment ?? message.account.config.forwardAsAttachment,
      pec: email.pec,
      replyToSender: payload.replyToSender,
      prefix: app.config.outbound.forwardPrefix,
      origin: planned.ruleId ?? "rule",
      automatic: true,
    });
    return {
      ...action,
      payload: { ...action.payload as object, subject: composed.subject, messageId: composed.messageId, envelope: composed.envelope },
      raw: composed.raw,
    };
  } catch (error) {
    return { ...action, status: "error", lastError: `preparazione dell'inoltro non riuscita: ${errorMessage(error)}` };
  }
}

export interface SimulationResult {
  email: RuleEmail;
  outcomes: RuleOutcome[];
  plan: PlannedAction[];
}

/** Same evaluation as live processing, without persisting or sending anything. */
export async function simulateMessage(
  app: App,
  message: FetchedMessage,
  rules: EngineRule[],
): Promise<SimulationResult> {
  const parsed = await parseRaw(message.raw);
  const email = await buildRuleEmail(
    parsed,
    {
      account: message.account.config.id,
      folder: message.folder,
      uid: message.uid,
      flags: message.flags,
      size: message.size,
      internalDate: message.internalDate,
    },
    app.config.engine.maxTextChars,
  );
  const outcomes = evaluateRules(app.sandbox, rules, email, app.store.dataObject(), app.config.engine.ruleTimeoutMs);
  const plan = planActions(outcomes, {
    engineMode: "live",
    treatShadowAsEnabled: true,
    allowedDomains: app.config.outbound.allowedDomains,
    ownAddresses: app.ownAddresses(message.account),
    alreadyForwarded: new Set(),
    markForwarded: false,
    moveAfterForward: message.account.config.moveAfterForward ?? null,
  });
  return { email, outcomes, plan };
}
