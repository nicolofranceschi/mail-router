import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";

import type { Role } from "../auth";
import { VERSION } from "../config";
import { errorMessage, log } from "../log";
import type { Scope } from "../scope";
import type { App } from "../service/app";
import { RULE_GUIDE } from "./guide";
import { registerDataTools } from "./tools/data";
import { registerEngineTools } from "./tools/engine";
import { registerMailboxTools } from "./tools/mailbox";
import { registerRuleTools } from "./tools/rules";

/**
 * Tools that act on the whole service, every mailbox at once: administrators
 * only. Operators switch their own rules on and off instead of the engine.
 */
export const ADMIN_TOOLS = new Set(["set_account_options", "set_mode", "get_logs"]);

export function toolAllowed(name: string, role: Role): boolean {
  return role === "admin" || !ADMIN_TOOLS.has(name);
}

/** Every tool gets the caller's scope: it only reaches the mailboxes the caller may see. */
function registerAll(server: McpServer, app: App, scope: Scope): void {
  registerEngineTools(server, app, scope);
  registerRuleTools(server, app, scope);
  registerDataTools(server, app, scope);
  registerMailboxTools(server, app, scope);
}

/** An operator's Claude does not even see the administrators' tools. */
function buildMcpServer(app: App, scope: Scope): McpServer {
  const server = new McpServer(
    { name: "mail-router", title: app.config.instanceName, version: VERSION },
    { instructions: RULE_GUIDE },
  );
  const register = server.registerTool.bind(server) as (name: string, ...rest: unknown[]) => unknown;
  const target = scope.isAdmin
    ? server
    : ({
        registerTool: (name: string, ...rest: unknown[]) => (toolAllowed(name, scope.role) ? register(name, ...rest) : undefined),
      } as unknown as McpServer);
  registerAll(target, app, scope);
  return server;
}

/** Stateless Streamable HTTP: one server and transport per request, JSON responses. */
export async function handleMcpRequest(app: App, request: Request, scope: Scope): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
  const server = buildMcpServer(app, scope);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    log.error(`MCP: richiesta non gestita: ${errorMessage(error)}`);
    return Response.json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, { status: 500 });
  } finally {
    void server.close().catch(() => undefined);
  }
}

// ---- the same tools, for the control panel -------------------------------

interface CollectedTool {
  inputSchema: ZodRawShape;
  callback: (args: unknown) => Promise<CallToolResult>;
}

/** Captures registerTool calls, so the panel runs exactly the code Claude runs. */
class ToolCollector {
  readonly tools = new Map<string, CollectedTool>();

  registerTool(name: string, config: { inputSchema?: ZodRawShape }, callback: (args: unknown) => Promise<CallToolResult>) {
    this.tools.set(name, { inputSchema: config.inputSchema ?? {}, callback });
  }
}

export type ToolCallResult = { ok: true; value: unknown } | { ok: false; status: number; error: string };

export function createToolRunner(app: App) {
  return async (name: string, args: unknown, scope: Scope): Promise<ToolCallResult> => {
    const collector = new ToolCollector();
    registerAll(collector as unknown as McpServer, app, scope);
    const tool = collector.tools.get(name);
    if (!tool) return { ok: false, status: 404, error: `Strumento sconosciuto: ${name}` };
    if (!toolAllowed(name, scope.role)) return { ok: false, status: 403, error: "Operazione riservata agli amministratori" };
    const parsed = z.object(tool.inputSchema).safeParse(args ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "argomenti"}: ${issue.message}`).join("; ");
      return { ok: false, status: 400, error: detail };
    }
    const result = await tool.callback(parsed.data);
    const first = result.content[0];
    const text = first && first.type === "text" ? first.text : "";
    if (result.isError) return { ok: false, status: 422, error: text };
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: true, value: text };
    }
  };
}
