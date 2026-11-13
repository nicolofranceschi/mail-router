import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HELD_BY_FAILED_FORWARD, Store, type ActionInput, type EvaluationInput } from "../src/store";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

const evaluation: EvaluationInput = {
  account: "posta",
  folder: "INBOX",
  uidValidity: "7",
  uid: 42,
  messageId: "<m1@x.it>",
  subject: "Ciao",
  fromAddress: "a@x.it",
  fromName: "A",
  date: null,
  origin: "watch",
  engineMode: "live",
  matched: true,
};

function action(partial: Partial<ActionInput>): ActionInput {
  return {
    seq: 0,
    ruleId: "r_1",
    account: "posta",
    folder: "INBOX",
    uidValidity: "7",
    uid: 42,
    messageId: "<m1@x.it>",
    type: "forward",
    payload: { to: ["paghe@azienda.it"], cc: [] },
    raw: new Uint8Array([1, 2, 3]),
    status: "pending",
    origin: "rule",
    ...partial,
  };
}

describe("rules", () => {
  test("create, update, delete and restore keep a version history", () => {
    const created = store.createRule({ account: "posta", name: "Paghe", description: "", code: "function rule(){return null}", mode: "shadow", priority: 10 });
    const updated = store.updateRule(created.id, { mode: "enabled", code: "function rule(){return {stop:true}}" });
    expect(updated.version).toBe(2);
    expect(store.getRule(created.id)?.mode).toBe("enabled");
    store.deleteRule(created.id);
    expect(store.getRule(created.id)).toBeNull();
    expect(store.deletedRules().map((row) => row.rule_id)).toEqual([created.id]);
    const restored = store.restoreRule(created.id, 1);
    expect(restored).toMatchObject({ id: created.id, mode: "shadow", code: "function rule(){return null}", version: 4 });
    expect(store.ruleVersions(created.id).map((row) => row.change)).toEqual(["created", "deleted", "updated", "created"]);
  });

  test("rules are listed by priority", () => {
    store.createRule({ account: "posta", name: "b", description: "", code: "x", mode: "enabled", priority: 50 });
    store.createRule({ account: "posta", name: "a", description: "", code: "x", mode: "enabled", priority: 5 });
    expect(store.listRules().map((row) => row.name)).toEqual(["a", "b"]);
  });
});

describe("data", () => {
  test("values round-trip as JSON", () => {
    store.setData("posta", "uffici", { paghe: ["p@azienda.it"] }, "Uffici");
    expect(store.dataObject("posta")).toEqual({ uffici: { paghe: ["p@azienda.it"] } });
    expect(store.deleteData("posta", "uffici")).toBe(true);
    expect(store.dataObject("posta")).toEqual({});
  });
});

describe("evaluations and outbox", () => {
  test("decision, actions and watermark are stored together", () => {
    const id = store.recordEvaluation(evaluation, [], [action({})], { watchId: "posta:INBOX", uidValidity: "7", lastUid: 42 });
    expect(store.getWatchState("posta:INBOX")).toEqual({ uidValidity: "7", lastUid: 42 });
    expect(store.dueEvaluationIds()).toEqual([id]);
    expect(store.forwardedRecipients("posta", "<m1@x.it>", "INBOX", 42)).toEqual(new Set(["paghe@azienda.it"]));
  });

  test("done actions drop their MIME; retries wait for their time", () => {
    const id = store.recordEvaluation(evaluation, [], [action({})]);
    const [first] = store.actionsForEvaluation(id);
    store.markActionRunning(first!.id);
    store.finishAction(first!.id, "pending", { error: "timeout", retryAt: new Date(Date.now() + 60_000).toISOString() });
    expect(store.dueEvaluationIds()).toEqual([]);
    store.finishAction(first!.id, "done", { result: { ok: true } });
    const done = store.getAction(first!.id)!;
    expect(done.status).toBe("done");
    expect(done.raw).toBeNull();
    expect(done.attempts).toBe(1);
  });

  test("leaving live cancels queued rule actions; crash recovery requeues running ones", () => {
    const id = store.recordEvaluation(evaluation, [], [action({}), action({ seq: 1, type: "move", payload: { target: "A" }, raw: null })]);
    const [first, second] = store.actionsForEvaluation(id);
    store.markActionRunning(first!.id);
    expect(store.recoverRunningActions()).toBe(1);
    expect(store.cancelPendingRuleActions("stop")).toBe(2);
    expect(store.getAction(second!.id)!.status).toBe("cancelled");
    expect(store.forwardedRecipients("posta", "<m1@x.it>", "INBOX", 42).size).toBe(0);
  });

  test("a rule's move is remembered by Message-ID and destination, a manual one is not", () => {
    const move = action({ type: "move", payload: { target: "Archivio" }, raw: null });
    const id = store.recordEvaluation(evaluation, [], [move]);
    expect(store.movedByRuleTo("posta", "<m1@x.it>", "Archivio")).toBe(true);
    expect(store.movedByRuleTo("posta", "<m1@x.it>", "Altra")).toBe(false);
    expect(store.movedByRuleTo("posta", "<altro@x.it>", "Archivio")).toBe(false);
    store.cancelPendingRuleActions("stop");
    expect(store.movedByRuleTo("posta", "<m1@x.it>", "Archivio")).toBe(false);
    expect(store.actionsForEvaluation(id)).toHaveLength(1);
    store.recordEvaluation(evaluation, [], [{ ...move, messageId: "<m2@x.it>", origin: "manual" }]);
    expect(store.movedByRuleTo("posta", "<m2@x.it>", "Archivio")).toBe(false);
  });

  test("retrying a failed forward brings back what it held back, and only that", () => {
    const id = store.recordEvaluation(evaluation, [], [
      action({}),
      action({ seq: 1, type: "seen", payload: {}, raw: null }),
      action({ seq: 2, type: "move", payload: { target: "A" }, raw: null, status: "skipped", lastError: "un'altra regola con priorità più alta sposta già il messaggio" }),
    ]);
    const [forward, seen, otherMove] = store.actionsForEvaluation(id);
    store.finishAction(forward!.id, "error", { error: "550" });
    store.finishAction(seen!.id, "skipped", { error: HELD_BY_FAILED_FORWARD });
    const unrelated = store.recordEvaluation({ ...evaluation, uid: 43 }, [], [action({ uid: 43, type: "seen", payload: {}, raw: null })]);
    store.finishAction(store.actionsForEvaluation(unrelated)[0]!.id, "skipped", { error: HELD_BY_FAILED_FORWARD });

    expect(store.retryErroredActions()).toBe(1);
    expect(store.getAction(forward!.id)!.status).toBe("pending");
    expect(store.getAction(seen!.id)!).toMatchObject({ status: "pending", last_error: null });
    expect(store.getAction(otherMove!.id)!.status).toBe("skipped");
    expect(store.actionsForEvaluation(unrelated)[0]!.status).toBe("skipped");
  });

  test("activity filters by rule and match", () => {
    const id = store.recordEvaluation(evaluation, [
      { ruleId: "r_1", ruleName: "Paghe", ruleVersion: 1, ruleMode: "enabled", matched: true, decision: { reason: "x" }, error: null, durationMs: 1 },
    ], []);
    store.recordEvaluation({ ...evaluation, uid: 43, matched: false }, [], []);
    expect(store.listEvaluations({ limit: 10, onlyMatched: true }).map((row) => row.id)).toEqual([id]);
    expect(store.listEvaluations({ limit: 10, ruleId: "r_1" }).map((row) => row.id)).toEqual([id]);
    expect(store.ruleStats("2000-01-01").get("r_1")).toMatchObject({ evaluated: 1, matched: 1, errors: 0 });
  });
});
