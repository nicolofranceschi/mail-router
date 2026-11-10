import { mkdirSync } from "node:fs";
import path from "node:path";

import { accessInfo } from "../access";
import { createOnceToken, FailureLimiter, ipAllowed, parseNetworks, randomToken, readCookie, rotateToken } from "../auth";
import { APP_NAME, DB_FILE, PRIVATE_NETWORKS, VERSION } from "../config";
import { errorMessage, log } from "../log";
import { buildConfig, parseImapForm, parseSmtpForm, settingsForm, testImap, testSmtp, writeConfig } from "../settings";
import { Store } from "../store";
import indexHtml from "../ui/index.html";
import { errorJson, errorResponse, json, readJson } from "./http";

const SETUP_COOKIE = "mr_setup";

export interface SetupServerOptions {
  hostname?: string;
  port?: number;
  /** Who may open the wizard (default: private networks). */
  allowedNetworks?: string[];
  /** The code that opens the wizard; random when omitted. */
  code?: string;
}

/**
 * First-run wizard, served by the container while there is no config.json.
 * The page gets in with the setup code printed in the container log (as
 * `?once=` in the address); finishing writes the config, creates the access
 * key and stops this server, so the real service can take the port.
 */
export function startSetupServer(home: string, options: SetupServerOptions = {}): { url: string; code: string; done: Promise<void> } {
  const code = options.code ?? randomToken();
  const networks = parseNetworks(options.allowedNetworks ?? PRIVATE_NETWORKS);
  const limiter = new FailureLimiter();
  const sessions = new Set<string>();
  let finished = false;
  let stopped = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => (resolveDone = resolve));

  const stop = (reason: string) => {
    if (stopped) return;
    stopped = true;
    log.info(`procedura guidata chiusa (${reason})`);
    void server.stop(true);
    resolveDone();
  };

  // Its own cookie name: cookies ignore ports, and the panel uses mr_session.
  const authenticated = (request: Request) => {
    const cookie = readCookie(request, SETUP_COOKIE);
    return Boolean(cookie && sessions.has(cookie));
  };

  const server = Bun.serve({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port ?? 0,
    development: false,
    idleTimeout: 255,
    routes: { "/": indexHtml },
    async fetch(request, srv) {
      const { pathname } = new URL(request.url);
      if (pathname === "/health") return json({ ok: true, name: APP_NAME, version: VERSION, mode: "setup" });
      const ip = srv.requestIP(request)?.address ?? "";
      if (!ipAllowed(networks, ip)) {
        log.warn(`procedura guidata: richiesta rifiutata da ${ip || "indirizzo sconosciuto"}`);
        return new Response("Forbidden", { status: 403 });
      }
      try {
        if (pathname === "/api/bootstrap") {
          return json({
            mode: "setup",
            authenticated: authenticated(request),
            version: VERSION,
            platform: process.platform,
            defaults: { instanceName: "Smistamento posta" },
          });
        }
        if (pathname === "/api/session/once" && request.method === "POST") {
          if (limiter.blocked(ip)) return errorJson(429, "Troppi tentativi: riprova tra un minuto");
          const body = await readJson(request);
          // The code stays valid until the setup is finished: closing the tab must not lock anyone out.
          if (finished || typeof body.once !== "string" || body.once.trim() !== code) {
            limiter.fail(ip);
            return errorJson(401, finished ? "Configurazione già completata: apri il pannello" : "Codice di configurazione non valido");
          }
          limiter.reset(ip);
          const session = randomToken();
          sessions.add(session);
          return json({ ok: true }, { headers: { "Set-Cookie": `${SETUP_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/` } });
        }
        if (!authenticated(request)) return errorJson(401, "Accesso richiesto");

        if (pathname === "/api/setup/imap" && request.method === "POST") {
          const body = await readJson(request);
          return json({ folders: await testImap(parseImapForm(body.imap)) });
        }
        if (pathname === "/api/setup/smtp" && request.method === "POST") {
          const body = await readJson(request);
          await testSmtp(parseImapForm(body.imap), parseSmtpForm(body.smtp));
          return json({ ok: true });
        }
        if (pathname === "/api/setup/finish" && request.method === "POST") {
          if (finished) return errorJson(409, "Configurazione già completata");
          const body = await readJson(request);
          const form = settingsForm.parse(body.settings);
          await testImap(form.imap);
          if (form.smtp) await testSmtp(form.imap, form.smtp);

          mkdirSync(home, { recursive: true });
          const config = buildConfig(form);
          writeConfig(home, config);
          const store = new Store(path.join(home, DB_FILE));
          const key = rotateToken(store);
          const panelOnce = createOnceToken(store);
          store.close();
          finished = true;
          sessions.clear();
          log.info("configurazione completata dalla procedura guidata: avvio del servizio");
          // Give the response time to leave, then free the port for the service.
          setTimeout(() => stop("configurazione completata"), 1500);
          return json({
            key,
            steps: [`configurazione salvata in ${home}`, "il servizio si avvia in modalità «in prova»"],
            running: true,
            openUrl: `/?once=${panelOnce}`,
            access: accessInfo(config.mcp, key, new URL(request.url).origin),
          });
        }
        if (pathname === "/api/setup/close" && request.method === "POST") {
          return json({ ok: true });
        }
        return errorJson(404, "Risorsa non trovata");
      } catch (error) {
        return errorResponse(error, (unexpected) => {
          log.warn(`procedura guidata ${pathname}: ${errorMessage(unexpected)}`);
          return errorMessage(unexpected);
        });
      }
    },
  });

  const url = `http://127.0.0.1:${server.port}/?once=${code}`;
  return { url, code, done };
}
