import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Store, type ActionInput, type EvaluationInput } from "../src/store";

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
    const created = store.createRule({ name: "Paghe", description: "", code: "function rule(){return null}", mode: "shadow", priority: 10 });
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
    store.createRule({ name: "b", description: "", code: "x", mode: "enabled", priority: 50 });
    store.createRule({ name: "a", description: "", code: "x", mode: "enabled", priority: 5 });
    expect(store.listRules().map((row) => row.name)).toEqual(["a", "b"]);
  });
});

describe("data", () => {
  test("values round-trip as JSON", () => {
    store.setData("uffici", { paghe: ["p@azienda.it"] }, "Uffici");
    expect(store.dataObject()).toEqual({ uffici: { paghe: ["p@azienda.it"] } });
    expect(store.deleteData("uffici")).toBe(true);
    expect(store.dataObject()).toEqual({});
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
