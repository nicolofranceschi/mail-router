import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorMessage, log } from "../../log";
import { appendToSent, sendRaw, type AccountRuntime } from "../../mail/clients";
import { buildForward, buildMessage, buildReply, type ComposedMessage } from "../../mail/compose";
import { buildRuleEmail, parseRaw } from "../../mail/parse";
import { extractPec } from "../../mail/pec";
import { isValidEmail, normalizeAddress } from "../../rules/decision";
import type { App } from "../../service/app";
import {
  fetchMessage,
  listFolders,
  moveMessage,
  searchMessages,
  updateFlags,
  type SearchCriteria,
} from "../../service/mailbox";
import type { ActionType } from "../../store";
import { handler } from "../format";
import { activityFor } from "./engine";
import { accountArg, folderArg, searchShape, uidArg } from "./shared";

const addressInput = z
  .union([z.string(), z.array(z.string())])
  .describe("One address, a comma-separated list or an array");

function addresses(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = (Array.isArray(value) ? value : [value])
    .flatMap((entry) => entry.split(/[;,]/))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeAddress);
  for (const address of list) if (!isValidEmail(address)) throw new Error(`Indirizzo non valido: ${address}`);
  return [...new Set(list)];
}

function record(
  app: App,
  account: AccountRuntime,
  entry: { type: ActionType; folder: string | null; uid: number | null; messageId?: string | null; payload: unknown },
  outcome: { ok: true; result: unknown } | { ok: false; error: string },
): void {
  app.store.insertAction(
    {
      seq: 0,
      ruleId: null,
      account: account.config.id,
      folder: entry.folder,
      uidValidity: null,
      uid: entry.uid,
      messageId: entry.messageId ?? null,
      type: entry.type,
      payload: entry.payload,
      status: outcome.ok ? "done" : "error",
      lastError: outcome.ok ? null : outcome.error,
      result: outcome.ok ? outcome.result : undefined,
      origin: "manual",
    },
    null,
  );
}

async function deliver(app: App, account: AccountRuntime, composed: ComposedMessage) {
  const sent = await sendRaw(account, composed.raw, composed.envelope);
  await appendToSent(account, composed.raw);
  return { subject: composed.subject, accepted: sent.accepted, rejected: sent.rejected, messageId: composed.messageId };
}

async function bestEffortFlag(account: AccountRuntime, folder: string, uid: number, flag: string): Promise<void> {
  try {
    await updateFlags(account, folder, uid, [flag], []);
  } catch (error) {
    log.warn(`flag ${flag} su UID ${uid} non impostato: ${errorMessage(error)}`);
  }
}

function requireSmtp(account: AccountRuntime): void {
  if (!account.config.smtp) throw new Error(`L'account ${account.config.id} non ha un server SMTP configurato`);
}

export function registerMailboxTools(server: McpServer, app: App): void {
  server.registerTool(
    "list_folders",
    {
      title: "Cartelle",
      description: "Lists the account's IMAP folders with their exact paths (use these paths in rules' moveTo and in the other tools).",
      inputSchema: { ...accountArg },
    },
    handler("list_folders", ({ account }: { account?: string }) => listFolders(app.account(account))),
  );

  server.registerTool(
    "list_emails",
    {
      title: "Messaggi",
      description: "Newest messages of a folder (summaries). Page backwards with beforeUid. Never marks messages as read.",
      inputSchema: {
        ...accountArg,
        ...folderArg,
        limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
        beforeUid: z.number().int().positive().optional(),
        unseenOnly: z.boolean().optional(),
      },
    },
    handler(
      "list_emails",
      async (args: { account?: string; folder?: string; limit?: number; beforeUid?: number; unseenOnly?: boolean }) => {
        const account = app.account(args.account);
        const folder = args.folder ?? app.defaultFolder(account);
        const result = await searchMessages(account, folder, args.unseenOnly ? { unseen: true } : {}, {
          limit: args.limit ?? 20,
          beforeUid: args.beforeUid,
        });
        return { folder, ...result };
      },
    ),
  );

  server.registerTool(
    "search_emails",
    {
      title: "Cerca messaggi",
      description:
        "Server-side IMAP search in one folder (from, to, subject, body text, date range, unseen, flagged, keyword such as $Forwarded). Returns the newest matches first.",
      inputSchema: {
        ...accountArg,
        ...folderArg,
        ...searchShape,
        limit: z.number().int().min(1).max(200).optional().describe("Default 30"),
        beforeUid: z.number().int().positive().optional(),
      },
    },
    handler(
      "search_emails",
      async (args: SearchCriteria & { account?: string; folder?: string; limit?: number; beforeUid?: number }) => {
        const { account: accountId, folder: folderArgValue, limit, beforeUid, ...criteria } = args;
        const account = app.account(accountId);
        const folder = folderArgValue ?? app.defaultFolder(account);
        const result = await searchMessages(account, folder, criteria, { limit: limit ?? 30, beforeUid });
        return { folder, ...result };
      },
    ),
  );

  server.registerTool(
    "get_email",
    {
      title: "Leggi messaggio",
      description:
        "Reads one message (the same view rules receive as `email`, with the text up to maxChars) plus what the router already did with it. Does not mark it as read.",
      inputSchema: {
        ...accountArg,
        ...folderArg,
        ...uidArg,
        maxChars: z.number().int().min(500).max(200_000).optional().describe("Default 20000"),
        includeHeaders: z.boolean().optional(),
      },
    },
    handler(
      "get_email",
      async (args: { account?: string; folder?: string; uid: number; maxChars?: number; includeHeaders?: boolean }) => {
        const account = app.account(args.account);
        const folder = args.folder ?? app.defaultFolder(account);
        const message = await fetchMessage(account, folder, args.uid);
        const parsed = await parseRaw(message.raw);
        const email = await buildRuleEmail(
          parsed,
          {
            account: account.config.id,
            folder,
            uid: args.uid,
            flags: message.flags,
            size: message.size,
            internalDate: message.internalDate,
          },
          args.maxChars ?? 20_000,
        );
        const { headers, ...rest } = email;
        const history = app.store.listEvaluations({ limit: 10, account: account.config.id, folder, uid: args.uid });
        return {
          ...rest,
          ...(args.includeHeaders ? { headers } : {}),
          routerHistory: activityFor(app, history),
        };
      },
    ),
  );

  server.registerTool(
    "forward_email",
    {
      title: "Inoltra",
      description:
        "Forwards a message now (inline with attachments, or as .eml attachment), with an optional note on top. Acts immediately: confirm recipients with the user first. Adds $Forwarded to the original.",
      inputSchema: {
        ...accountArg,
        ...folderArg,
        ...uidArg,
        to: addressInput,
        cc: addressInput.optional(),
        note: z.string().max(4000).optional(),
        asAttachment: z.boolean().optional().describe("Attach the original .eml (default: the account setting, on for PEC boxes)"),
        replyToSender: z.boolean().optional(),
      },
    },
    handler(
      "forward_email",
      async (args: {
        account?: string;
        folder?: string;
        uid: number;
        to: string | string[];
        cc?: string | string[];
        note?: string;
        asAttachment?: boolean;
        replyToSender?: boolean;
      }) => {
        const account = app.account(args.account);
        requireSmtp(account);
        const folder = args.folder ?? app.defaultFolder(account);
        const to = addresses(args.to);
        const cc = addresses(args.cc);
        if (!to.length) throw new Error("Serve almeno un destinatario");
        const message = await fetchMessage(account, folder, args.uid);
        const parsed = await parseRaw(message.raw);
        const entry = { type: "forward" as const, folder, uid: args.uid, messageId: parsed.messageId, payload: { to, cc, note: args.note ?? null } };
        try {
          const composed = await buildForward({
            original: parsed,
            originalRaw: message.raw,
            identity: app.identity(account),
            to,
            cc,
            note: args.note ?? null,
            asAttachment: args.asAttachment ?? account.config.forwardAsAttachment,
            replyToSender: args.replyToSender === true,
            prefix: app.config.outbound.forwardPrefix,
            origin: "manual",
            automatic: false,
            pec: await extractPec(parsed, app.config.engine.maxTextChars),
          });
          const result = await deliver(app, account, composed);
          record(app, account, entry, { ok: true, result });
          if (account.config.markForwarded) await bestEffortFlag(account, folder, args.uid, "$Forwarded");
          return { forwarded: true, ...result };
        } catch (error) {
          record(app, account, entry, { ok: false, error: errorMessage(error) });
          throw error;
        }
      },
    ),
  );

  server.registerTool(
    "reply_email",
    {
      title: "Rispondi",
      description: "Replies to a message now (to the sender, or to everyone with replyAll), quoting the original. Acts immediately: confirm the text with the user first.",
      inputSchema: {
        ...accountArg,
        ...folderArg,
        ...uidArg,
        body: z.string().min(1).max(50_000).describe("Plain text of the reply"),
        replyAll: z.boolean().optional(),
      },
    },
    handler(
      "reply_email",
      async (args: { account?: string; folder?: string; uid: number; body: string; replyAll?: boolean }) => {
        const account = app.account(args.account);
        requireSmtp(account);
        const folder = args.folder ?? app.defaultFolder(account);
        const message = await fetchMessage(account, folder, args.uid);
        const parsed = await parseRaw(message.raw);
        const entry = { type: "reply" as const, folder, uid: args.uid, messageId: parsed.messageId, payload: { replyAll: args.replyAll === true } };
        try {
          const composed = await buildReply({
            original: parsed,
            identity: app.identity(account),
            body: args.body,
            replyAll: args.replyAll === true,
            ownAddresses: app.ownAddresses(account),
            prefix: app.config.outbound.replyPrefix,
          });
          const result = await deliver(app, account, composed);
          record(app, account, { ...entry, payload: { ...entry.payload, to: composed.envelope.to } }, { ok: true, result });
          await bestEffortFlag(account, folder, args.uid, "\\Answered");
          return { replied: true, to: composed.envelope.to, ...result };
        } catch (error) {
          record(app, account, entry, { ok: false, error: errorMessage(error) });
          throw error;
        }
      },
    ),
  );

  server.registerTool(
    "send_email",
    {
      title: "Nuovo messaggio",
      description: "Sends a new plain-text message from the account. Acts immediately: confirm recipients and text with the user first.",
      inputSchema: {
        ...accountArg,
        to: addressInput,
        cc: addressInput.optional(),
        subject: z.string().min(1).max(500),
        body: z.string().min(1).max(50_000),
      },
    },
    handler(
      "send_email",
      async (args: { account?: string; to: string | string[]; cc?: string | string[]; subject: string; body: string }) => {
        const account = app.account(args.account);
        requireSmtp(account);
        const to = addresses(args.to);
        const cc = addresses(args.cc);
        if (!to.length) throw new Error("Serve almeno un destinatario");
        const entry = { type: "send" as const, folder: null, uid: null, payload: { to, cc, subject: args.subject } };
        try {
          const composed = await buildMessage({ identity: app.identity(account), to, cc, subject: args.subject, body: args.body });
          const result = await deliver(app, account, composed);
          record(app, account, entry, { ok: true, result });
          return { sent: true, ...result };
        } catch (error) {
          record(app, account, entry, { ok: false, error: errorMessage(error) });
          throw error;
        }
      },
    ),
  );

  server.registerTool(
    "move_email",
    {
      title: "Sposta",
      description: "Moves a message to another folder now (use list_folders for exact paths). The UID changes after a move.",
      inputSchema: { ...accountArg, ...folderArg, ...uidArg, target: z.string().min(1) },
    },
    handler("move_email", async (args: { account?: string; folder?: string; uid: number; target: string }) => {
      const account = app.account(args.account);
      const folder = args.folder ?? app.defaultFolder(account);
      const entry = { type: "move" as const, folder, uid: args.uid, payload: { target: args.target } };
      try {
        const result = await moveMessage(account, folder, args.uid, args.target);
        record(app, account, entry, { ok: true, result });
        return result;
      } catch (error) {
        record(app, account, entry, { ok: false, error: errorMessage(error) });
        throw error;
      }
    }),
  );

  server.registerTool(
    "set_flags",
    {
      title: "Flag e stato di lettura",
      description:
        "Adds or removes flags on a message: \\Seen (read), \\Flagged (starred), \\Answered, or keywords such as $Forwarded or $Fatture.",
      inputSchema: {
        ...accountArg,
        ...folderArg,
        ...uidArg,
        add: z.array(z.string().min(1)).optional(),
        remove: z.array(z.string().min(1)).optional(),
      },
    },
    handler(
      "set_flags",
      async (args: { account?: string; folder?: string; uid: number; add?: string[]; remove?: string[] }) => {
        const account = app.account(args.account);
        const folder = args.folder ?? app.defaultFolder(account);
        const add = args.add ?? [];
        const remove = args.remove ?? [];
        if (!add.length && !remove.length) throw new Error("Indica almeno un flag da aggiungere o togliere");
        const entry = { type: (add.length ? "flags" : "unflags") as ActionType, folder, uid: args.uid, payload: { add, remove } };
        try {
          const flags = await updateFlags(account, folder, args.uid, add, remove);
          record(app, account, entry, { ok: true, result: { flags } });
          return { uid: args.uid, flags };
        } catch (error) {
          record(app, account, entry, { ok: false, error: errorMessage(error) });
          throw error;
        }
      },
    ),
  );

  server.registerTool(
    "delete_email",
    {
      title: "Elimina",
      description: "Moves a message to the account's trash folder (configured trashFolder). Nothing is erased permanently.",
      inputSchema: { ...accountArg, ...folderArg, ...uidArg },
    },
    handler("delete_email", async (args: { account?: string; folder?: string; uid: number }) => {
      const account = app.account(args.account);
      const trash = account.config.trashFolder;
      if (!trash) throw new Error("Nessuna cartella cestino configurata (trashFolder): usa move_email verso una cartella esistente");
      const folder = args.folder ?? app.defaultFolder(account);
      if (folder === trash) throw new Error("Il messaggio è già nel cestino");
      const entry = { type: "move" as const, folder, uid: args.uid, payload: { target: trash, delete: true } };
      try {
        const result = await moveMessage(account, folder, args.uid, trash);
        record(app, account, entry, { ok: true, result });
        return { trashed: true, ...result };
      } catch (error) {
        record(app, account, entry, { ok: false, error: errorMessage(error) });
        throw error;
      }
    }),
  );
}
