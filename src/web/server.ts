import { bearerToken, FailureLimiter, ipAllowed, parseNetworks, tokenMatches } from "../auth";
import { APP_NAME, VERSION } from "../config";
import { log } from "../log";
import { createToolRunner, handleMcpRequest } from "../mcp/server";
import type { App } from "../service/app";
import indexHtml from "../ui/index.html";
import { handleApi } from "./api";

/**
 * One port for everything: the control panel (static page + /api), Claude's
 * MCP endpoint (/mcp) and /health. Outside the allowed networks only the
 * health check and the page assets answer.
 */
export function startServer(app: App): ReturnType<typeof Bun.serve> {
  const { mcp } = app.config;
  const networks = parseNetworks(mcp.allowedNetworks);
  const limiter = new FailureLimiter();
  const runTool = createToolRunner(app);

  const server = Bun.serve({
    hostname: mcp.host,
    port: mcp.port,
    development: false,
    // Long tool calls (test_rules on hundreds of messages) must not be cut.
    idleTimeout: 255,
    ...(mcp.tls ? { tls: { cert: Bun.file(mcp.tls.cert), key: Bun.file(mcp.tls.key) } } : {}),
    routes: { "/": indexHtml },
    async fetch(request, srv) {
      const { pathname } = new URL(request.url);
      if (pathname === "/health") {
        return Response.json({ ok: true, name: APP_NAME, version: VERSION, mode: app.mode });
      }
      const ip = srv.requestIP(request)?.address ?? "";
      if (!ipAllowed(networks, ip)) {
        log.warn(`richiesta rifiutata da ${ip || "indirizzo sconosciuto"} (fuori da mcp.allowedNetworks)`);
        return new Response("Forbidden", { status: 403 });
      }

      if (pathname === "/mcp") {
        if (limiter.blocked(ip)) return new Response("Too many attempts", { status: 429 });
        if (!tokenMatches(app.store, bearerToken(request))) {
          limiter.fail(ip);
          log.warn(`MCP: chiave non valida da ${ip}`);
          return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="mail-router"' } });
        }
        limiter.reset(ip);
        return handleMcpRequest(app, request);
      }

      if (pathname.startsWith("/api/")) return handleApi(app, request, { ip, limiter, runTool });
      return new Response("Not found", { status: 404 });
    },
  });
  const scheme = mcp.tls ? "https" : "http";
  log.info(`pannello e server MCP in ascolto su ${scheme}://${mcp.host}:${mcp.port} (MCP: /mcp)`);
  return server;
}
