import { z } from "zod";

import {
  authenticateKey,
  bearerToken,
  createSession,
  createUser,
  FailureLimiter,
  readCookie,
  ROLE_LABEL,
  rotateUserKey,
  SESSION_COOKIE,
  sessionCookie,
  sha256Hex,
  type User,
} from "../auth";
import { loadConfig, VERSION } from "../config";
import { errorMessage, log } from "../log";
import type { createToolRunner } from "../mcp/server";
import type { App } from "../service/app";
import {
  accountForm,
  applyGeneral,
  buildConfig,
  generalForm,
  parseImapForm,
  parseSmtpForm,
  publicAccount,
  publicGeneral,
  publicSettings,
  removeAccount,
  saveAccount,
  settingsForm,
  storedAccount,
  testImap,
  testSmtp,
  writeConfig,
} from "../settings";
import { accessInfo } from "../access";
import { errorJson, errorResponse, HttpError, json, readJson } from "./http";

export interface ApiContext {
  ip: string;
  limiter: FailureLimiter;
  runTool: ReturnType<typeof createToolRunner>;
}

const roleSchema = z.enum(["admin", "operator"]);
const userName = z.string().trim().min(1, "nome obbligatorio").max(60);

/** The user behind the panel session cookie, or behind a Bearer key (scripts). */
function currentUser(app: App, request: Request): User | null {
  const session = readCookie(request, SESSION_COOKIE);
  if (session) {
    const user = app.store.uiTokenUser(sha256Hex(session), "session");
    if (user) return user;
  }
  const bearer = bearerToken(request);
  return bearer ? authenticateKey(app.store, bearer) : null;
}

function publicUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    keyHint: user.key_hint ? `mr_…${user.key_hint}` : null,
    createdAt: user.created_at,
    lastUsedAt: user.last_used_at,
  };
}

function withSession(app: App, user: User, body: unknown): Response {
  const session = createSession(app.store, user.id);
  return json(body, { headers: { "Set-Cookie": sessionCookie(session) } });
}

/** Writing the config needs a restart: the worker reopens the service in-process, after the response has left. */
function scheduleRestart(app: App): boolean {
  const restart = app.onRestartRequest;
  if (!restart) return false;
  setTimeout(() => {
    log.info("riavvio per applicare le nuove impostazioni");
    restart();
  }, 800);
  return true;
}

/** The config on disk: it may already hold changes saved a moment ago and not yet applied by the restart. */
function diskConfig(app: App) {
  return loadConfig(app.home);
}

/** The last administrator can be neither removed nor turned into an operator: nobody could manage the service any more. */
function guardLastAdmin(app: App, target: User, change: "delete" | "demote"): void {
  if (target.role === "admin" && app.store.countUsers("admin") <= 1) {
    throw new HttpError(
      409,
      change === "delete"
        ? "È l'unico amministratore: nomina un altro amministratore prima di eliminarlo"
        : "È l'unico amministratore: nomina un altro amministratore prima di cambiargli ruolo",
    );
  }
}

function targetUser(app: App, id: unknown): User {
  const user = typeof id === "string" ? app.store.getUser(id) : null;
  if (!user) throw new HttpError(404, "Utente non trovato");
  return user;
}

export async function handleApi(app: App, request: Request, ctx: ApiContext): Promise<Response> {
  const { pathname, origin } = new URL(request.url);
  const method = request.method;
  try {
    if (pathname === "/api/bootstrap" && method === "GET") {
      const user = currentUser(app, request);
      return json({
        mode: "service",
        authenticated: Boolean(user),
        user: user ? publicUser(user) : null,
        instanceName: app.config.instanceName,
        version: VERSION,
      });
    }

    if (pathname === "/api/session/once" && method === "POST") {
      const { once } = await readJson(request);
      const user = typeof once === "string" ? app.store.consumeUiToken(sha256Hex(once), "once") : null;
      if (!user) return errorJson(401, "Collegamento scaduto o già usato: accedi con la chiave");
      return withSession(app, user, { ok: true });
    }

    if (pathname === "/api/session/key" && method === "POST") {
      if (ctx.limiter.blocked(ctx.ip)) return errorJson(429, "Troppi tentativi: riprova tra un minuto");
      const { key } = await readJson(request);
      const user = typeof key === "string" ? authenticateKey(app.store, key.trim()) : null;
      if (!user) {
        ctx.limiter.fail(ctx.ip);
        log.warn(`pannello: chiave errata da ${ctx.ip}`);
        return errorJson(401, "Chiave di accesso non valida");
      }
      ctx.limiter.reset(ctx.ip);
      log.info(`pannello: accesso di «${user.name}» (${ROLE_LABEL[user.role]}) da ${ctx.ip}`);
      return withSession(app, user, { ok: true });
    }

    if (pathname === "/api/session/logout" && method === "POST") {
      const session = readCookie(request, SESSION_COOKIE);
      if (session) app.store.removeUiToken(sha256Hex(session));
      return json({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", 0) } });
    }

    const user = currentUser(app, request);
    if (!user) return errorJson(401, "Accesso richiesto");

    const tool = /^\/api\/tools\/([a-z_]+)$/.exec(pathname);
    if (tool && method === "POST") {
      const { args } = await readJson(request);
      const result = await ctx.runTool(tool[1]!, args ?? {}, user.role);
      return result.ok ? json(result.value) : errorJson(result.status, result.error);
    }

    // ---- own access: every user ------------------------------------------

    if (pathname === "/api/access" && method === "GET") {
      return json({ user: publicUser(user), access: accessInfo(app.config.mcp, undefined, origin) });
    }

    if (pathname === "/api/access/rotate" && method === "POST") {
      const key = rotateUserKey(app.store, user.id);
      log.info(`chiave di «${user.name}» rigenerata dal pannello (${ctx.ip})`);
      return json({ key, ...accessInfo(app.config.mcp, key, origin) });
    }

    // ---- everything below: administrators only ----------------------------

    if (user.role !== "admin") return errorJson(403, "Operazione riservata agli amministratori");

    if (pathname === "/api/settings" && method === "GET") {
      return json({
        settings: publicSettings(app.config),
        general: publicGeneral(app.config),
        accounts: app.config.accounts.map(publicAccount),
        access: accessInfo(app.config.mcp, undefined, origin),
      });
    }

    if (pathname === "/api/settings/test-imap" && method === "POST") {
      const body = await readJson(request);
      const folders = await testImap(parseImapForm(body.imap), storedAccount(app.config, body.account ?? app.config.accounts[0]!.id));
      return json({ folders });
    }

    if (pathname === "/api/settings/test-smtp" && method === "POST") {
      const body = await readJson(request);
      await testSmtp(parseImapForm(body.imap), parseSmtpForm(body.smtp), storedAccount(app.config, body.account ?? app.config.accounts[0]!.id));
      return json({ ok: true });
    }

    // Older single-mailbox form (first mailbox + general settings).
    if (pathname === "/api/settings" && method === "POST") {
      const body = await readJson(request);
      const form = settingsForm.parse(body.settings);
      const config = diskConfig(app);
      // Never save settings that cannot log in: the service would come back unusable.
      await testImap(form.imap, config.accounts[0]);
      if (form.smtp) await testSmtp(form.imap, form.smtp, config.accounts[0]);
      writeConfig(app.home, buildConfig(form, config));
      log.info(`impostazioni aggiornate dal pannello da «${user.name}» (${ctx.ip})`);
      return json({ saved: true, restarting: scheduleRestart(app) });
    }

    if (pathname === "/api/settings/general" && method === "POST") {
      const body = await readJson(request);
      const form = generalForm.parse(body.general);
      writeConfig(app.home, applyGeneral(diskConfig(app), form));
      log.info(`impostazioni generali aggiornate da «${user.name}» (${ctx.ip})`);
      return json({ saved: true, restarting: scheduleRestart(app) });
    }

    if (pathname === "/api/accounts/save" && method === "POST") {
      const body = await readJson(request);
      const editing = typeof body.editing === "string" && body.editing ? body.editing : null;
      const form = accountForm.parse(body.account);
      const config = diskConfig(app);
      const stored = editing ? storedAccount(config, editing) : undefined;
      if (editing && !stored) throw new HttpError(404, `Casella sconosciuta: ${editing}`);
      // Never save a mailbox that cannot log in: the service would come back unusable.
      await testImap(form.imap, stored);
      if (form.smtp) await testSmtp(form.imap, form.smtp, stored);
      const saved = saveAccount(config, editing, form);
      writeConfig(app.home, saved.config);
      log.info(`casella «${saved.id}» ${editing ? "modificata" : "aggiunta"} da «${user.name}» (${ctx.ip})`);
      return json({ saved: true, id: saved.id, restarting: scheduleRestart(app) });
    }

    if (pathname === "/api/accounts/delete" && method === "POST") {
      const { id } = await readJson(request);
      if (typeof id !== "string") throw new HttpError(400, "Casella non indicata");
      writeConfig(app.home, removeAccount(diskConfig(app), id));
      log.info(`casella «${id}» eliminata da «${user.name}» (${ctx.ip})`);
      return json({ deleted: true, restarting: scheduleRestart(app) });
    }

    // ---- users ------------------------------------------------------------

    if (pathname === "/api/users" && method === "GET") {
      return json({ users: app.store.listUsers().map(publicUser), me: user.id });
    }

    if (pathname === "/api/users/create" && method === "POST") {
      const body = await readJson(request);
      const created = createUser(app.store, userName.parse(body.name), roleSchema.parse(body.role));
      log.info(`utente «${created.user.name}» (${ROLE_LABEL[created.user.role]}) creato da «${user.name}» (${ctx.ip})`);
      return json({ user: publicUser(created.user), key: created.key, ...accessInfo(app.config.mcp, created.key, origin) });
    }

    if (pathname === "/api/users/update" && method === "POST") {
      const body = await readJson(request);
      const target = targetUser(app, body.id);
      const name = body.name === undefined ? undefined : userName.parse(body.name);
      const role = body.role === undefined ? undefined : roleSchema.parse(body.role);
      if (role === "operator") guardLastAdmin(app, target, "demote");
      if (name && app.store.listUsers().some((other) => other.id !== target.id && other.name.toLowerCase() === name.toLowerCase())) {
        throw new HttpError(409, `Esiste già un utente di nome «${name}»`);
      }
      const updated = app.store.updateUser(target.id, { name, role })!;
      log.info(`utente «${updated.name}» aggiornato da «${user.name}» (${ROLE_LABEL[updated.role]})`);
      return json({ user: publicUser(updated) });
    }

    if (pathname === "/api/users/rotate" && method === "POST") {
      const body = await readJson(request);
      const target = targetUser(app, body.id);
      const key = rotateUserKey(app.store, target.id);
      log.info(`chiave di «${target.name}» rigenerata da «${user.name}» (${ctx.ip})`);
      return json({ key, ...accessInfo(app.config.mcp, key, origin) });
    }

    if (pathname === "/api/users/delete" && method === "POST") {
      const body = await readJson(request);
      const target = targetUser(app, body.id);
      if (target.id === user.id) throw new HttpError(409, "Non puoi eliminare te stesso: chiedi a un altro amministratore");
      guardLastAdmin(app, target, "delete");
      app.store.deleteUser(target.id);
      log.info(`utente «${target.name}» eliminato da «${user.name}» (${ctx.ip})`);
      return json({ deleted: true });
    }

    return errorJson(404, "Risorsa non trovata");
  } catch (error) {
    return errorResponse(error, (unexpected) => {
      log.warn(`pannello ${pathname}: ${errorMessage(unexpected)}`);
      return errorMessage(unexpected);
    });
  }
}
