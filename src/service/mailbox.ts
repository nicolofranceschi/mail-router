import type { FetchMessageObject, ImapFlow, MessageStructureObject, SearchObject } from "imapflow";

import { withImap, type AccountRuntime } from "../mail/clients";
import { safeMove } from "../mail/move";
import type { FetchedMessage } from "./processor";

export interface MessageSummary {
  uid: number;
  date: string | null;
  receivedAt: string | null;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  flags: string[];
  size: number;
  hasAttachments: boolean;
}

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  since?: string;
  before?: string;
  unseen?: boolean;
  flagged?: boolean;
  keyword?: string;
  notKeyword?: string;
}

/** Folders above this size are not downloaded for analysis; their headers still are. */
export const MAX_ANALYSIS_BYTES = 15 * 1024 * 1024;

function iso(value: Date | string | undefined | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function addresses(list: { name?: string; address?: string }[] | undefined): string {
  return (list ?? [])
    .map((entry) => (entry.name ? `${entry.name} <${entry.address ?? ""}>` : (entry.address ?? "")))
    .filter(Boolean)
    .join(", ");
}

function hasAttachments(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.disposition === "attachment") return true;
  if (node.dispositionParameters?.filename && node.disposition !== "inline") return true;
  return (node.childNodes ?? []).some(hasAttachments);
}

function summarize(message: FetchMessageObject): MessageSummary {
  const envelope = message.envelope;
  const cc = addresses(envelope?.cc);
  return {
    uid: message.uid,
    date: iso(envelope?.date),
    receivedAt: iso(message.internalDate),
    from: addresses(envelope?.from),
    to: addresses(envelope?.to),
    ...(cc ? { cc } : {}),
    subject: envelope?.subject ?? "",
    flags: [...(message.flags ?? [])],
    size: message.size ?? 0,
    hasAttachments: hasAttachments(message.bodyStructure),
  };
}

async function summaries(client: ImapFlow, uids: number[]): Promise<MessageSummary[]> {
  if (!uids.length) return [];
  const out: MessageSummary[] = [];
  for await (const message of client.fetch(
    uids.join(","),
    { uid: true, envelope: true, flags: true, size: true, internalDate: true, bodyStructure: true },
    { uid: true },
  )) {
    out.push(summarize(message));
  }
  return out.sort((a, b) => b.uid - a.uid);
}

export async function listFolders(account: AccountRuntime) {
  return withImap(account, "elenco cartelle", async (client) => {
    const folders = await client.list();
    return folders.map((folder) => ({
      path: folder.path,
      name: folder.name,
      delimiter: folder.delimiter,
      specialUse: folder.specialUse ?? null,
      subscribed: folder.subscribed,
    }));
  });
}

export function toSearchObject(criteria: SearchCriteria): SearchObject {
  const query: SearchObject = {};
  if (criteria.from) query.from = criteria.from;
  if (criteria.to) query.to = criteria.to;
  if (criteria.subject) query.subject = criteria.subject;
  if (criteria.body) query.body = criteria.body;
  if (criteria.since) query.since = new Date(criteria.since);
  if (criteria.before) query.before = new Date(criteria.before);
  if (criteria.unseen) query.seen = false;
  if (criteria.flagged !== undefined) query.flagged = criteria.flagged;
  if (criteria.keyword) query.keyword = criteria.keyword;
  if (criteria.notKeyword) query.unKeyword = criteria.notKeyword;
  if (!Object.keys(query).length) query.all = true;
  return query;
}

/** Newest-first summaries of the messages matching the criteria. */
export async function searchMessages(
  account: AccountRuntime,
  folder: string,
  criteria: SearchCriteria,
  options: { limit: number; beforeUid?: number },
): Promise<{ total: number; messages: MessageSummary[] }> {
  return withImap(account, "ricerca", async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const found = (await client.search(toSearchObject(criteria), { uid: true })) || [];
      const eligible = found
        .filter((uid) => options.beforeUid === undefined || uid < options.beforeUid)
        .sort((a, b) => a - b);
      const picked = eligible.slice(-options.limit);
      return { total: eligible.length, messages: await summaries(client, picked) };
    } finally {
      lock.release();
    }
  });
}

/** Downloads one message without changing its flags (BODY.PEEK). */
export async function fetchMessage(account: AccountRuntime, folder: string, uid: number): Promise<FetchedMessage> {
  return withImap(account, "lettura messaggio", async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const message = await client.fetchOne(
        String(uid),
        { uid: true, flags: true, size: true, internalDate: true, source: true },
        { uid: true },
      );
      if (!message || !message.source) throw new Error(`Messaggio UID ${uid} non trovato in ${folder}`);
      return {
        account,
        folder,
        uidValidity: String(client.mailbox ? client.mailbox.uidValidity : ""),
        uid,
        flags: message.flags ?? new Set<string>(),
        size: message.size ?? message.source.length,
        internalDate: message.internalDate,
        raw: message.source,
      };
    } finally {
      lock.release();
    }
  });
}

/**
 * Streams messages for rule testing: either explicit UIDs or the newest
 * `last` matching the criteria. Oversized messages are reported, not loaded.
 */
export async function fetchForAnalysis(
  account: AccountRuntime,
  folder: string,
  selection: { uids?: number[]; last?: number; criteria?: SearchCriteria },
  onMessage: (message: FetchedMessage) => Promise<void>,
): Promise<{ skipped: { uid: number; size: number }[] }> {
  return withImap(account, "analisi", async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      let uids = selection.uids;
      if (!uids) {
        const found = (await client.search(toSearchObject(selection.criteria ?? {}), { uid: true })) || [];
        uids = found.sort((a, b) => a - b).slice(-(selection.last ?? 50));
      }
      if (!uids.length) return { skipped: [] };
      const sizes = new Map<number, number>();
      for await (const message of client.fetch(uids.join(","), { uid: true, size: true }, { uid: true })) {
        sizes.set(message.uid, message.size ?? 0);
      }
      const skipped: { uid: number; size: number }[] = [];
      const wanted = [...sizes.entries()]
        .filter(([uid, size]) => {
          if (size > MAX_ANALYSIS_BYTES) skipped.push({ uid, size });
          return size <= MAX_ANALYSIS_BYTES;
        })
        .map(([uid]) => uid)
        .sort((a, b) => b - a);
      const uidValidity = String(client.mailbox ? client.mailbox.uidValidity : "");
      for (const uid of wanted) {
        const message = await client.fetchOne(
          String(uid),
          { uid: true, flags: true, size: true, internalDate: true, source: true },
          { uid: true },
        );
        if (!message || !message.source) continue;
        await onMessage({
          account,
          folder,
          uidValidity,
          uid,
          flags: message.flags ?? new Set<string>(),
          size: message.size ?? message.source.length,
          internalDate: message.internalDate,
          raw: message.source,
        });
      }
      return { skipped };
    } finally {
      lock.release();
    }
  });
}

export async function updateFlags(
  account: AccountRuntime,
  folder: string,
  uid: number,
  add: string[],
  remove: string[],
): Promise<string[]> {
  return withImap(account, "flag", async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      if (add.length) await client.messageFlagsAdd(String(uid), add, { uid: true });
      if (remove.length) await client.messageFlagsRemove(String(uid), remove, { uid: true });
      const message = await client.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
      if (!message) throw new Error(`Messaggio UID ${uid} non trovato in ${folder}`);
      return [...(message.flags ?? [])];
    } finally {
      lock.release();
    }
  });
}

export async function moveMessage(account: AccountRuntime, folder: string, uid: number, target: string) {
  return withImap(account, "spostamento", async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const result = await safeMove(client, uid, target);
      if (!result.moved) throw new Error(`Messaggio UID ${uid} non trovato in ${folder}`);
      return { movedTo: result.target, newUid: result.newUid, ...(result.folderCreated ? { folderCreated: true } : {}) };
    } finally {
      lock.release();
    }
  });
}
