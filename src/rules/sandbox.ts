/**
 * Rule code is written by an AI and runs on every incoming message, so it is
 * executed inside QuickJS compiled to WebAssembly: no filesystem, network,
 * process or host objects, a memory cap and a wall-clock deadline. A rule is a
 * pure function from (email, data, h) to a decision; side effects are only
 * ever performed by the host, after the decision has been validated.
 */

import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import wasmPath from "@jitl/quickjs-wasmfile-release-sync/wasm" with { type: "file" };
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";

const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const STACK_LIMIT_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 100_000;

/** Helpers exposed to rules as the third argument `h`. Avoid `${` and backticks: this is a template. */
const PRELUDE = String.raw`
"use strict";
const __mr = (() => {
  const COMBINING = new RegExp("[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]", "g");
  const norm = (value) =>
    String(value == null ? "" : value).normalize("NFD").replace(COMBINING, "").toLowerCase();
  const list = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
  const addressOf = (entry) => norm(entry && typeof entry === "object" ? entry.address : entry).trim();
  const domain = (entry) => {
    const address = addressOf(entry);
    const at = address.lastIndexOf("@");
    return at >= 0 ? address.slice(at + 1) : "";
  };
  const escape = (text) =>
    text.split("").map((ch) => (/[a-z0-9 ]/.test(ch) ? ch : "\\" + ch)).join("");
  const matchesAddress = (entry, pattern) => {
    const wanted = norm(pattern).trim();
    if (!wanted) return false;
    if (wanted.indexOf("@") > 0) return addressOf(entry) === wanted;
    const wantedDomain = wanted.replace(/^@/, "");
    const actual = domain(entry);
    return actual === wantedDomain || actual.endsWith("." + wantedDomain);
  };
  const recipients = (email) => list(email.to).concat(list(email.cc));
  const helpers = {
    norm,
    domain,
    addresses: (entries) => list(entries).map(addressOf).filter(Boolean),
    recipients: (email) => recipients(email).map(addressOf).filter(Boolean),
    has: (text, needles) => {
      const haystack = norm(text);
      return list(needles).some((needle) => {
        const wanted = norm(needle);
        return wanted.length > 0 && haystack.includes(wanted);
      });
    },
    hasWord: (text, words) => {
      const haystack = norm(text);
      return list(words).some((word) => {
        const wanted = norm(word).trim();
        if (!wanted) return false;
        return new RegExp("(^|[^a-z0-9])" + escape(wanted) + "($|[^a-z0-9])").test(haystack);
      });
    },
    isFrom: (email, patterns) => list(patterns).some((pattern) => matchesAddress(email.from, pattern)),
    sentTo: (email, patterns) =>
      recipients(email).some((entry) => list(patterns).some((pattern) => matchesAddress(entry, pattern))),
    hasAttachment: (email, pattern) =>
      list(email.attachments).some((attachment) =>
        pattern == null ? true : norm(attachment.filename).includes(norm(pattern)),
      ),
  };
  const deepFreeze = (value) => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const key of Object.keys(value)) deepFreeze(value[key]);
    }
    return value;
  };
  return Object.freeze({ helpers: Object.freeze(helpers), deepFreeze });
})();
`;

const CALL = String.raw`
(() => {
  if (typeof rule !== "function") {
    throw new Error("Il codice deve definire: function rule(email, data, h) { ... }");
  }
  const input = __mr.deepFreeze(JSON.parse(globalThis.__mrInput));
  const result = rule(input.email, input.data, __mr.helpers);
  if (result && typeof result.then === "function") {
    throw new Error("rule() deve essere sincrona: niente async/await o Promise");
  }
  return JSON.stringify(result === undefined ? null : result);
})()
`;

const CHECK = String.raw`
(() => {
  if (typeof rule !== "function") {
    throw new Error("Il codice deve definire: function rule(email, data, h) { ... }");
  }
  return "ok";
})()
`;

export type SandboxFailureKind = "syntax" | "runtime" | "timeout" | "output";

export type SandboxResult =
  | { ok: true; value: unknown; durationMs: number }
  | { ok: false; kind: SandboxFailureKind; error: string; durationMs: number };

let modulePromise: Promise<QuickJSWASMModule> | null = null;

function loadModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(
    newVariant(RELEASE_SYNC, { wasmBinary: () => Bun.file(wasmPath).arrayBuffer() }),
  );
  return modulePromise;
}

export class RuleSandbox {
  private constructor(private readonly module: QuickJSWASMModule) {}

  static async create(): Promise<RuleSandbox> {
    return new RuleSandbox(await loadModule());
  }

  /** Compiles the code and checks that it defines `rule`, without calling it. */
  check(code: string, timeoutMs = 1000): SandboxResult {
    return this.execute(code, null, timeoutMs, CHECK);
  }

  run(code: string, input: { email: unknown; data: unknown }, timeoutMs: number): SandboxResult {
    return this.execute(code, input, timeoutMs, CALL);
  }

  private execute(code: string, input: unknown, timeoutMs: number, finalScript: string): SandboxResult {
    const started = performance.now();
    const elapsed = () => Math.round((performance.now() - started) * 100) / 100;
    const runtime = this.module.newRuntime();
    runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
    runtime.setMaxStackSize(STACK_LIMIT_BYTES);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
    const ctx = runtime.newContext();
    try {
      const inputHandle = ctx.newString(JSON.stringify(input ?? null));
      ctx.setProp(ctx.global, "__mrInput", inputHandle);
      inputHandle.dispose();

      const prelude = ctx.evalCode(PRELUDE, "prelude.js");
      if (prelude.error) {
        const failure = describe(ctx, prelude.error);
        return { ok: false, kind: "runtime", error: `prelude: ${failure.message}`, durationMs: elapsed() };
      }
      prelude.value.dispose();

      const defined = ctx.evalCode(code, "rule.js");
      if (defined.error) {
        const failure = describe(ctx, defined.error);
        return { ok: false, kind: failure.kind === "runtime" && failure.name === "SyntaxError" ? "syntax" : failure.kind, error: failure.message, durationMs: elapsed() };
      }
      defined.value.dispose();

      const called = ctx.evalCode(finalScript, "call.js");
      if (called.error) {
        const failure = describe(ctx, called.error);
        return { ok: false, kind: failure.kind, error: failure.message, durationMs: elapsed() };
      }
      const output = ctx.typeof(called.value) === "string" ? ctx.getString(called.value) : "null";
      called.value.dispose();
      if (output.length > MAX_OUTPUT_CHARS) {
        return { ok: false, kind: "output", error: "Risultato della regola troppo grande", durationMs: elapsed() };
      }
      if (finalScript === CHECK) return { ok: true, value: null, durationMs: elapsed() };
      return { ok: true, value: JSON.parse(output), durationMs: elapsed() };
    } catch (error) {
      // QuickJS raises host-side errors for memory exhaustion and similar.
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, kind: "runtime", error: message, durationMs: elapsed() };
    } finally {
      ctx.dispose();
      runtime.dispose();
    }
  }
}

function describe(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
): { kind: SandboxFailureKind; name: string; message: string } {
  let dumped: unknown;
  try {
    dumped = ctx.dump(handle);
  } finally {
    handle.dispose();
  }
  const error = (dumped ?? {}) as { name?: string; message?: string; stack?: string };
  const name = typeof error.name === "string" ? error.name : "Error";
  const message = typeof error.message === "string" ? error.message : String(dumped);
  if (name === "InternalError" && /interrupted/i.test(message)) {
    return { kind: "timeout", name, message: "Tempo massimo superato (ciclo infinito o regola troppo lenta)" };
  }
  const where = typeof error.stack === "string" ? firstRuleFrame(error.stack) : "";
  return { kind: "runtime", name, message: `${name}: ${message}${where}` };
}

function firstRuleFrame(stack: string): string {
  const frame = stack.split("\n").find((line) => line.includes("rule.js"));
  return frame ? ` (${frame.trim()})` : "";
}
