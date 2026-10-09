import { beforeAll, describe, expect, test } from "bun:test";

import { sampleRuleEmail } from "../src/mail/parse";
import { parseDecision } from "../src/rules/decision";
import { evaluateRules, planActions, type EngineRule, type PlanContext } from "../src/rules/engine";
import { RuleSandbox } from "../src/rules/sandbox";

let sandbox: RuleSandbox;
beforeAll(async () => {
  sandbox = await RuleSandbox.create();
});

const email = {
  ...sampleRuleEmail(),
  subject: "Avviso di PAGAMENTO — Fattura n. 12",
  from: { name: "Cassa Edile", address: "notifiche@pec.cassaedile.it" },
  cc: [{ name: "", address: "m.rossi@azienda.it" }],
  text: "Si comunica l'avvenuto versamento. Perché è così?",
};

function run(code: string, data: Record<string, unknown> = {}, timeoutMs = 250) {
  return sandbox.run(code, { email, data }, timeoutMs);
}

describe("sandbox", () => {
  test("helpers normalise case, accents, domains and words", () => {
    const result = run(`function rule(email, data, h) {
      return {
        fromDomain: h.isFrom(email, "cassaedile.it"),
        fromOther: h.isFrom(email, "edile.it"),
        exact: h.isFrom(email, "notifiche@pec.cassaedile.it"),
        sentTo: h.sentTo(email, ["azienda.it"]),
        accent: h.has(email.text, "perche"),
        word: h.hasWord(email.subject, "pagamento"),
        partialWord: h.hasWord(email.subject, "paga"),
        attachment: h.hasAttachment(email, ".PDF"),
        data: data.uffici.paghe,
      };
    }`, { uffici: { paghe: "paghe@azienda.it" } });
    expect(result).toMatchObject({
      ok: true,
      value: {
        fromDomain: true,
        fromOther: false,
        exact: true,
        sentTo: true,
        accent: true,
        word: true,
        partialWord: false,
        attachment: true,
        data: "paghe@azienda.it",
      },
    });
  });

  test("a rule cannot reach the host", () => {
    const result = run(`function rule() {
      return [typeof require, typeof process, typeof fetch, typeof Bun, typeof std, typeof os].join(",");
    }`);
    expect(result).toMatchObject({ ok: true, value: "undefined,undefined,undefined,undefined,undefined,undefined" });
  });

  test("input is frozen", () => {
    const result = run(`"use strict"; function rule(email) { email.subject = "x"; return null; }`);
    expect(result.ok).toBe(false);
  });

  test("infinite loops are interrupted", () => {
    const result = run("function rule() { for (;;) {} }", {}, 50);
    expect(result).toMatchObject({ ok: false, kind: "timeout" });
  });

  test("syntax errors and missing rule() are reported", () => {
    expect(run("function rule( {")).toMatchObject({ ok: false, kind: "syntax" });
    expect(run("const x = 1;")).toMatchObject({ ok: false, kind: "runtime" });
    expect(sandbox.check("function rule() { return null }").ok).toBe(true);
    expect(sandbox.check("function nope() {}").ok).toBe(false);
  });

  test("async rules are rejected", () => {
    const result = run("async function rule() { return null }");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("sincrona");
  });
});

describe("decisions", () => {
  test("null-ish means no match", () => {
    expect(parseDecision(null)).toEqual({ matched: false });
    expect(parseDecision(undefined)).toEqual({ matched: false });
    expect(parseDecision(false)).toEqual({ matched: false });
  });

  test("forward shorthand and object forms are normalised", () => {
    const short = parseDecision({ forward: "Mario <M.Rossi@Azienda.it>, paghe@azienda.it" });
    expect(short.matched && short.decision.forward).toEqual({
      to: ["m.rossi@azienda.it", "paghe@azienda.it"],
      cc: [],
      note: null,
      asAttachment: null,
      replyToSender: false,
    });
    const full = parseDecision({ forward: { to: ["a@b.it"], cc: "c@b.it", note: "Vedi", replyToSender: true }, stop: true });
    expect(full.matched && full.decision).toMatchObject({
      forward: { to: ["a@b.it"], cc: ["c@b.it"], note: "Vedi", replyToSender: true },
      stop: true,
    });
  });

  test("invalid decisions explain the problem", () => {
    expect(() => parseDecision(true)).toThrow("oggetto decisione");
    expect(() => parseDecision({ forward: "not-an-address" })).toThrow("indirizzo non valido");
    expect(() => parseDecision({ forwrd: "a@b.it" })).toThrow();
    expect(() => parseDecision({ flags: ["\\Deleted"] })).toThrow("flag IMAP");
  });
});

function rule(id: string, code: string, mode: EngineRule["mode"] = "enabled"): EngineRule {
  return { id, name: id, code, mode, version: 1 };
}

const context: PlanContext = {
  engineMode: "live",
  allowedDomains: ["azienda.it"],
  ownAddresses: ["info@azienda.it"],
  alreadyForwarded: new Set(),
  markForwarded: true,
};

describe("engine", () => {
  test("rules run in order, stop ends evaluation, errors do not block others", () => {
    const outcomes = evaluateRules(
      sandbox,
      [
        rule("broken", "function rule() { throw new Error('boom') }"),
        rule("first", "function rule() { return { forward: 'paghe@azienda.it', stop: true } }"),
        rule("never", "function rule() { return { forward: 'altro@azienda.it' } }"),
      ],
      email,
      {},
      250,
    );
    expect(outcomes.map((outcome) => [outcome.ruleId, outcome.matched, Boolean(outcome.error)])).toEqual([
      ["broken", false, true],
      ["first", true, false],
    ]);
  });

  test("plan: live vs shadow, dedupe, loop guard, allowlist, ordering", () => {
    const outcomes = evaluateRules(
      sandbox,
      [
        rule("move", "function rule() { return { moveTo: 'Archivio', flags: ['$Smistata'] } }"),
        rule("a", "function rule() { return { forward: ['paghe@azienda.it', 'info@azienda.it', 'x@esterno.com'] } }"),
        rule("b", "function rule() { return { forward: 'paghe@azienda.it' } }"),
        rule("shadow", "function rule() { return { forward: 'nuovo@azienda.it', markRead: true } }", "shadow"),
      ],
      email,
      {},
      250,
    );
    const plan = planActions(outcomes, context);
    expect(plan.map((action) => [action.type, action.ruleId, action.status])).toEqual([
      ["forward", "a", "pending"],
      ["forward", "a", "blocked"],
      ["forward", "b", "skipped"],
      ["forward", "shadow", "simulated"],
      ["flags", "move", "pending"],
      ["flags", null, "pending"],
      ["seen", "shadow", "simulated"],
      ["move", "move", "pending"],
    ]);
    expect(plan[0]!.payload.to).toEqual(["paghe@azienda.it"]);
    expect(plan[1]!.payload.to).toEqual(["x@esterno.com"]);
    expect(plan[5]!.payload.flags).toEqual(["$Forwarded"]);
  });

  test("shadow engine simulates everything and adds no $Forwarded", () => {
    const outcomes = evaluateRules(sandbox, [rule("a", "function rule() { return { forward: 'paghe@azienda.it' } }")], email, {}, 250);
    const plan = planActions(outcomes, { ...context, engineMode: "shadow" });
    expect(plan.map((action) => action.status)).toEqual(["simulated"]);
  });

  test("recipients already reached are not forwarded again", () => {
    const outcomes = evaluateRules(sandbox, [rule("a", "function rule() { return { forward: 'paghe@azienda.it' } }")], email, {}, 250);
    const plan = planActions(outcomes, { ...context, alreadyForwarded: new Set(["paghe@azienda.it"]) });
    expect(plan.map((action) => action.status)).toEqual(["skipped"]);
  });
});
