import {
  createSession,
  FailureLimiter,
  readCookie,
  rotateToken,
  SESSION_COOKIE,
  sessionCookie,
  sha256Hex,
  tokenMatches,
  bearerToken,
} from "../auth";
import { VERSION } from "../config";
import { errorMessage, log } from "../log";
import type { createToolRunner } from "../mcp/server";
import type { App } from "../service/app";
import { buildConfig, parseImapForm, parseSmtpForm, publicSettings, settingsForm, testImap, testSmtp, writeConfig } from "../settings";
import { accessInfo } from "../setup";
import { errorJson, errorResponse, json, readJson } from "./http";

export interface ApiContext {
  ip: string;
  limiter: FailureLimiter;
  runTool: ReturnType<typeof createToolRunner>;
}

function isAuthenticated(app: App, request: Request): boolean {
  const session = readCookie(request, SESSION_COOKIE);
  if (session && app.store.hasUiToken(sha256Hex(session), "session")) return true;
  const bearer = bearerToken(request);
  return Boolean(bearer) && tokenMatches(app.store, bearer);
}

function withSession(app: App, body: unknown): Response {
  const session = createSession(app.store);
  return json(body, { headers: { "Set-Cookie": sessionCookie(session) } });
}

/** Writing the config needs a restart: the supervisor brings the service back up. */
function scheduleRestart(): boolean {
  if (process.env.MAIL_ROUTER_SUPERVISED !== "1") return false;
  setTimeout(() => {
    log.info("riavvio per applicare le nuove impostazioni");
    process.exit(0);
  }, 800);
  return true;
}

export async function handleApi(app: App, request: Request, ctx: ApiContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;
  try {
    if (pathname === "/api/bootstrap" && method === "GET") {
      return json({
        mode: "service",
        authenticated: isAuthenticated(app, request),
        instanceName: app.config.instanceName,
        version: VERSION,
      });
    }

    if (pathname === "/api/session/once" && method === "POST") {
      const { once } = await readJson(request);
      if (typeof once !== "string" || !app.store.consumeUiToken(sha256Hex(once), "once")) {
        return errorJson(401, "Collegamento scaduto o già usato: riapri Mail Router dal PC");
      }
      return withSession(app, { ok: true });
    }

    if (pathname === "/api/session/key" && method === "POST") {
      if (ctx.limiter.blocked(ctx.ip)) return errorJson(429, "Troppi tentativi: riprova tra un minuto");
      const { key } = await readJson(request);
      if (typeof key !== "string" || !tokenMatches(app.store, key.trim())) {
        ctx.limiter.fail(ctx.ip);
        log.warn(`pannello: chiave errata da ${ctx.ip}`);
        return errorJson(401, "Chiave di accesso non valida");
      }
      ctx.limiter.reset(ctx.ip);
      return withSession(app, { ok: true });
    }

    if (pathname === "/api/session/logout" && method === "POST") {
      const session = readCookie(request, SESSION_COOKIE);
      if (session) app.store.removeUiToken(sha256Hex(session));
      return json({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", 0) } });
    }

    if (!isAuthenticated(app, request)) return errorJson(401, "Accesso richiesto");

    const tool = /^\/api\/tools\/([a-z_]+)$/.exec(pathname);
    if (tool && method === "POST") {
      const { args } = await readJson(request);
      const result = await ctx.runTool(tool[1]!, args ?? {});
      return result.ok ? json(result.value) : errorJson(result.status, result.error);
    }

    if (pathname === "/api/settings" && method === "GET") {
      return json({ settings: publicSettings(app.config), access: accessInfo(app.config.mcp) });
    }

    if (pathname === "/api/settings/test-imap" && method === "POST") {
      const body = await readJson(request);
      const folders = await testImap(parseImapForm(body.imap), app.config);
      return json({ folders });
    }

    if (pathname === "/api/settings/test-smtp" && method === "POST") {
      const body = await readJson(request);
      await testSmtp(parseImapForm(body.imap), parseSmtpForm(body.smtp), app.config);
      return json({ ok: true });
    }

    if (pathname === "/api/settings" && method === "POST") {
      const body = await readJson(request);
      const form = settingsForm.parse(body.settings);
      // Never save settings that cannot log in: the service would come back unusable.
      await testImap(form.imap, app.config);
      if (form.smtp) await testSmtp(form.imap, form.smtp, app.config);
      const next = buildConfig(form, app.config);
      writeConfig(app.home, next);
      log.info(`impostazioni aggiornate dal pannello (${ctx.ip})`);
      return json({ saved: true, restarting: scheduleRestart() });
    }

    if (pathname === "/api/access/rotate" && method === "POST") {
      const key = rotateToken(app.store);
      log.info(`chiave di accesso rigenerata dal pannello (${ctx.ip})`);
      return json({ key, ...accessInfo(app.config.mcp, key) });
    }

    return errorJson(404, "Risorsa non trovata");
  } catch (error) {
    return errorResponse(error, (unexpected) => {
      log.warn(`pannello ${pathname}: ${errorMessage(unexpected)}`);
      return errorMessage(unexpected);
    });
  }
}
