import { mkdirSync } from "node:fs";
import path from "node:path";

import { createOnceToken, randomToken, readCookie, rotateToken } from "../auth";
import { DB_FILE, VERSION } from "../config";
import { errorMessage, log } from "../log";
import { installService, restrictDataFolder } from "../service/windows";
import { buildConfig, parseImapForm, parseSmtpForm, settingsForm, testImap, testSmtp, writeConfig } from "../settings";
import { accessInfo } from "../setup";
import { Store } from "../store";
import indexHtml from "../ui/index.html";
import { errorJson, errorResponse, json, readJson } from "./http";

const IDLE_LIMIT_MS = 60 * 60_000;
const SETUP_COOKIE = "mr_setup";

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(1000);
  }
  return false;
}

/**
 * First-run wizard, served only on 127.0.0.1 by an elevated process. The page
 * gets in with the one-time token in its URL; finishing writes the config,
 * creates the access key, installs and starts the service, and hands the
 * browser a one-time link into the real panel.
 */
export function startSetupServer(home: string): { url: string; done: Promise<void> } {
  let once: string | null = randomToken();
  let session: string | null = null;
  let finished = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => (resolveDone = resolve));
  let idle = setTimeout(() => stop("nessuna attività"), IDLE_LIMIT_MS);

  const stop = (reason: string) => {
    log.info(`procedura guidata chiusa (${reason})`);
    clearTimeout(idle);
    void server.stop(true);
    resolveDone();
  };

  // Its own cookie name: cookies ignore ports, and the panel on 127.0.0.1 uses mr_session.
  const authenticated = (request: Request) => Boolean(session) && readCookie(request, SETUP_COOKIE) === session;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    idleTimeout: 255,
    routes: { "/": indexHtml },
    async fetch(request) {
      clearTimeout(idle);
      idle = setTimeout(() => stop("nessuna attività"), IDLE_LIMIT_MS);
      const { pathname } = new URL(request.url);
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
          const body = await readJson(request);
          if (!once || body.once !== once) return errorJson(401, "Collegamento scaduto: riapri Mail Router");
          once = null;
          session = randomToken();
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
          if (finished) return errorJson(409, "Installazione già completata");
          const body = await readJson(request);
          const form = settingsForm.parse(body.settings);
          await testImap(form.imap);
          if (form.smtp) await testSmtp(form.imap, form.smtp);

          mkdirSync(home, { recursive: true });
          if (process.platform === "win32") restrictDataFolder(home);
          const config = buildConfig(form);
          writeConfig(home, config);
          const store = new Store(path.join(home, DB_FILE));
          const key = rotateToken(store);
          store.close();

          const steps: string[] = [`configurazione salvata in ${home}`];
          let running = false;
          if (process.platform === "win32") {
            steps.push(...(await installService({ home, firewallRemote: ["LocalSubnet"] })));
            running = await waitForHealth(config.mcp.port, 60_000);
          } else {
            steps.push(`avvia il servizio con: mail-router run --home "${home}"`);
          }
          const panelStore = new Store(path.join(home, DB_FILE));
          const panelOnce = createOnceToken(panelStore);
          panelStore.close();
          finished = true;
          // The wizard page keeps showing the key; the server can go a little later.
          setTimeout(() => stop("installazione completata"), 10 * 60_000);
          return json({
            key,
            steps,
            running,
            openUrl: `http://127.0.0.1:${config.mcp.port}/?once=${panelOnce}`,
            access: accessInfo(config.mcp, key),
          });
        }
        if (pathname === "/api/setup/close" && request.method === "POST") {
          setTimeout(() => stop("chiusa dall'utente"), 2000);
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

  const url = `http://127.0.0.1:${server.port}/?once=${once}`;
  log.info(`procedura guidata pronta su http://127.0.0.1:${server.port}/`);
  return { url, done };
}
