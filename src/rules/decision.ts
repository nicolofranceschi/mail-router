import { z } from "zod";

/** What a matching rule asks for, after validation and normalisation. */
export interface Decision {
  forward: ForwardRequest | null;
  flags: string[];
  markRead: boolean;
  moveTo: string | null;
  stop: boolean;
  reason: string | null;
}

export interface ForwardRequest {
  to: string[];
  cc: string[];
  note: string | null;
  /** null: use the account setting. */
  asAttachment: boolean | null;
  replyToSender: boolean;
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
/** IMAP keywords, plus the one system flag a rule may set. */
const FLAG = /^(\$?[A-Za-z0-9_.-]{1,64}|\\Flagged)$/;

export function normalizeAddress(value: string): string {
  const bracketed = /<([^>]+)>/.exec(value);
  return (bracketed ? bracketed[1]! : value).trim().toLowerCase();
}

const addressList = z
  .union([z.string(), z.array(z.string())])
  .transform((value, ctx) => {
    const parts = (Array.isArray(value) ? value : [value])
      .flatMap((entry) => entry.split(/[;,]/))
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(normalizeAddress);
    for (const address of parts) {
      if (!EMAIL.test(address)) ctx.addIssue({ code: "custom", message: `indirizzo non valido: ${address}` });
    }
    return [...new Set(parts)];
  });

/** `forward` accepts a bare address (list) as shorthand for `{ to }`. */
const forwardSchema = z.preprocess(
  (value) => (typeof value === "string" || Array.isArray(value) ? { to: value } : value),
  z
    .object({
      to: addressList,
      cc: addressList.optional(),
      note: z.string().max(4000).optional(),
      asAttachment: z.boolean().optional(),
      replyToSender: z.boolean().optional(),
    })
    .strict(),
);

const decisionSchema = z
  .object({
    forward: forwardSchema.optional(),
    flags: z
      .union([z.string(), z.array(z.string())])
      .transform((value) => (Array.isArray(value) ? value : [value]))
      .pipe(z.array(z.string().regex(FLAG, "flag IMAP non valido (usa parole come $Fatture o \\Flagged)")).max(10))
      .optional(),
    markRead: z.boolean().optional(),
    moveTo: z.string().trim().min(1).optional(),
    stop: z.boolean().optional(),
    reason: z.string().max(1000).optional(),
  })
  .strict();

export type ParsedDecision = { matched: false } | { matched: true; decision: Decision };

/**
 * `null`, `undefined` and `false` mean "not my message". Anything else must be
 * a decision object; mistakes are reported to the rule author, not guessed at.
 */
export function parseDecision(value: unknown): ParsedDecision {
  if (value === null || value === undefined || value === false) return { matched: false };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `La regola deve restituire null oppure un oggetto decisione, non ${JSON.stringify(value)?.slice(0, 80)}`,
    );
  }
  const result = decisionSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "decisione"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Decisione non valida — ${detail}`);
  }
  const parsed = result.data;
  const forward = parsed.forward;
  return {
    matched: true,
    decision: {
      forward: forward
        ? {
            to: forward.to,
            cc: (forward.cc ?? []).filter((address) => !forward.to.includes(address)),
            note: forward.note?.trim() || null,
            asAttachment: forward.asAttachment ?? null,
            replyToSender: forward.replyToSender === true,
          }
        : null,
      flags: [...new Set(parsed.flags ?? [])],
      markRead: parsed.markRead === true,
      moveTo: parsed.moveTo ?? null,
      stop: parsed.stop === true,
      reason: parsed.reason ?? null,
    },
  };
}

export function isValidEmail(address: string): boolean {
  return EMAIL.test(address);
}
