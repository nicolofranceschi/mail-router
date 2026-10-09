import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { errorMessage, log } from "../log";

export function ok(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Every tool body goes through here: errors become readable tool errors, never protocol failures. */
export function handler<A>(name: string, body: (args: A) => Promise<unknown> | unknown) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await body(args));
    } catch (error) {
      log.warn(`tool ${name}: ${errorMessage(error)}`);
      return fail(errorMessage(error));
    }
  };
}
