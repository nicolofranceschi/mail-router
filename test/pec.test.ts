import { beforeAll, describe, expect, test } from "bun:test";

import { buildForward } from "../src/mail/compose";
import { parseRaw } from "../src/mail/parse";
import { extractPec } from "../src/mail/pec";
import { evaluateRules, planActions } from "../src/rules/engine";
import { RuleSandbox } from "../src/rules/sandbox";
import { buildRuleEmail } from "../src/mail/parse";
import { build, samplePec } from "./fixtures/pec";

let sandbox: RuleSandbox;
beforeAll(async () => {
  sandbox = await RuleSandbox.create();
});

describe("PEC", () => {
  test("the envelope is unpacked: type, original sender, subject, text and attachments", async () => {
    const pec = await extractPec(await parseRaw(await samplePec()), 20_000);
    expect(pec).toMatchObject({
      tipo: "posta-certificata",
      isReceipt: false,
      isAnomaly: false,
      sender: "studio.bianchi@pec.it",
      subject: "Diffida pagamento fattura 123 & interessi",
      gestore: "ARUBA PEC S.p.A.",
      identificativo: "opec210312.20261008111500.123456.789.1.53@pec.aruba.it",
    });
    expect(pec?.original?.from?.address).toBe("studio.bianchi@pec.it");
    expect(pec?.original?.text).toContain("diffida al pagamento");
    expect(pec?.original?.attachments.map((attachment) => attachment.filename)).toEqual(["diffida.pdf"]);
  });

  test("receipts are recognised, ordinary mail has no PEC view", async () => {
    const receipt = await extractPec(await parseRaw(await samplePec("avvenuta-consegna")), 20_000);
    expect(receipt).toMatchObject({ tipo: "avvenuta-consegna", isReceipt: true, original: null });
    const plain = await extractPec(await parseRaw(await build({ from: "a@b.it", to: "c@d.it", subject: "x", text: "y" })), 20_000);
    expect(plain).toBeNull();
  });

  test("rules read the original and stop receipts", async () => {
    const meta = { account: "pec", folder: "INBOX", uid: 1, flags: [], size: 1, internalDate: new Date() };
    const rules = [
      { id: "ricevute", name: "ricevute", version: 1, mode: "enabled" as const, code: "function rule(email) { return email.pec && email.pec.isReceipt ? { stop: true, reason: 'ricevuta' } : null }" },
      { id: "legale", name: "legale", version: 1, mode: "enabled" as const, code: "function rule(email, data, h) { return email.pec && h.has(email.pec.original.text, 'diffida') ? { forward: 'legale@azienda.it' } : null }" },
    ];
    const message = await buildRuleEmail(await parseRaw(await samplePec()), meta, 20_000);
    expect(evaluateRules(sandbox, rules, message, {}, 250).map((outcome) => [outcome.ruleId, outcome.matched])).toEqual([
      ["ricevute", false],
      ["legale", true],
    ]);
    const receipt = await buildRuleEmail(await parseRaw(await samplePec("avvenuta-consegna")), meta, 20_000);
    expect(evaluateRules(sandbox, rules, receipt, {}, 250).map((outcome) => [outcome.ruleId, outcome.matched])).toEqual([["ricevute", true]]);
  });

  test("forwarding attaches the whole PEC and summarises the original", async () => {
    const raw = await samplePec();
    const parsed = await parseRaw(raw);
    const composed = await buildForward({
      original: parsed,
      originalRaw: raw,
      identity: { from: "Smistamento PEC <smistamento@azienda.it>", timeZone: "Europe/Rome", instanceId: "x" },
      to: ["legale@azienda.it"],
      cc: [],
      note: null,
      asAttachment: true,
      replyToSender: false,
      prefix: "I:",
      origin: "r",
      automatic: true,
      pec: await extractPec(parsed, 20_000),
    });
    const forwarded = await parseRaw(composed.raw);
    expect(composed.envelope.from).toBe("smistamento@azienda.it");
    expect(forwarded.text).toContain("Mittente PEC: studio.bianchi@pec.it");
    expect(forwarded.text).toContain("Oggetto: Diffida pagamento fattura 123 & interessi");
    expect(forwarded.text).toContain("Allegati: diffida.pdf");
    const attachment = forwarded.attachments[0]!;
    expect(attachment.filename).toBe("PEC - Diffida pagamento fattura 123 & interessi.eml");
    expect(attachment.content.equals(raw)).toBe(true);
  });

  test("after a forward the original is moved, also in the simulation", () => {
    const outcome = {
      ruleId: "legale",
      ruleName: "legale",
      ruleVersion: 1,
      ruleMode: "enabled" as const,
      matched: true,
      error: null,
      durationMs: 1,
      decision: { forward: { to: ["legale@azienda.it"], cc: [], note: null, asAttachment: null, replyToSender: false }, flags: [], markRead: false, moveTo: null, stop: false, reason: null },
    };
    const context = { allowedDomains: ["azienda.it"], ownAddresses: [], alreadyForwarded: new Set<string>(), markForwarded: true, moveAfterForward: "Inoltrate" };
    const live = planActions([outcome], { ...context, engineMode: "live" });
    expect(live.map((action) => [action.type, action.status, action.payload.target ?? null])).toEqual([
      ["forward", "pending", null],
      ["flags", "pending", null],
      ["move", "pending", "Inoltrate"],
    ]);
    const shadow = planActions([outcome], { ...context, engineMode: "shadow" });
    expect(shadow.map((action) => [action.type, action.status])).toEqual([
      ["forward", "simulated"],
      ["move", "simulated"],
    ]);
    const explicitMove = { ...outcome, decision: { ...outcome.decision, moveTo: "Legale" } };
    expect(planActions([explicitMove], { ...context, engineMode: "live" }).filter((action) => action.type === "move").map((action) => action.payload.target)).toEqual(["Legale"]);
  });
});
