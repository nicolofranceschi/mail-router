import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { App } from "../src/service/app";
import { Executor } from "../src/service/executor";
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
    type: "seen",
    payload: {},
    status: "pending",
    origin: "rule",
    ...partial,
  };
}

/** Runs one evaluation; anything that reaches for the mailbox fails the test through the app stub. */
async function run(evaluationId: number): Promise<void> {
  const app = {
    store,
    mode: "live",
    config: { engine: { maxAttempts: 3 } },
    account() {
      throw new Error("non doveva toccare la casella");
    },
  } as unknown as App;
  await (new Executor(app) as unknown as { runEvaluation(id: number): Promise<boolean> }).runEvaluation(evaluationId);
}

describe("a forward that did not go out", () => {
  for (const status of ["error", "blocked"] as const) {
    test(`${status}: the message is not moved, not read and not $Forwarded`, async () => {
      const id = store.recordEvaluation(evaluation, [], [
        action({ type: "forward", payload: { to: ["a@azienda.it"], cc: [] }, status, lastError: "no" }),
        action({ seq: 1, ruleId: null, type: "flags", payload: { flags: ["$Forwarded"] } }),
        action({ seq: 2, type: "seen" }),
        action({ seq: 3, type: "move", payload: { target: "Archivio", markRead: true } }),
      ]);
      await run(id);
      const held = store.actionsForEvaluation(id).slice(1);
      expect(held.map((row) => [row.type, row.status, row.last_error])).toEqual([
        ["flags", "skipped", HELD_BY_FAILED_FORWARD],
        ["seen", "skipped", HELD_BY_FAILED_FORWARD],
        ["move", "skipped", HELD_BY_FAILED_FORWARD],
      ]);
    });
  }

  test("a rule's own keyword is still applied", async () => {
    const id = store.recordEvaluation(evaluation, [], [
      action({ type: "forward", payload: { to: ["a@azienda.it"], cc: [] }, status: "blocked", lastError: "no" }),
      action({ seq: 1, type: "flags", payload: { flags: ["$Paghe"] } }),
    ]);
    await run(id);
    // It tries the mailbox, which the stub refuses: what matters is that the keyword was not held back.
    const [, flags] = store.actionsForEvaluation(id);
    expect(flags!.last_error).not.toBe(HELD_BY_FAILED_FORWARD);
  });
});
