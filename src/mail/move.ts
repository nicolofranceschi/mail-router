import type { ImapFlow } from "imapflow";

import { log } from "../log";

export type MoveResult = { moved: true; target: string; newUid: number | null; folderCreated: boolean } | { moved: false; reason: "missing" };

/** STATUS on a missing folder throws NotFound (imapflow double-checks with LIST); other refusals count as "exists". */
export async function folderExists(client: ImapFlow, path: string): Promise<boolean> {
  try {
    await client.status(path, { messages: true });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "NotFound") return false;
    throw error;
  }
}

/**
 * Moves one message out of the currently selected folder without ever losing it.
 *
 * imapflow's messageMove() answers `false` on any failure (so a missing
 * destination looks like success unless checked), and on servers without
 * MOVE it emulates COPY + delete even when the COPY failed. Here the
 * destination is created first, the message must exist, the copy must
 * succeed before the original is touched, and without UIDPLUS no plain
 * EXPUNGE is sent — it would also purge messages another client (Outlook)
 * merely marked as deleted.
 */
export async function safeMove(client: ImapFlow, uid: number, target: string): Promise<MoveResult> {
  // Create only when missing: some servers answer CREATE on an existing folder with a bare NO.
  let folderCreated = false;
  if (!(await folderExists(client, target))) {
    await client.mailboxCreate(target);
    folderCreated = true;
    log.info(`cartella «${target}» creata`);
  }

  const present = await client.fetchOne(String(uid), { uid: true }, { uid: true });
  if (!present) return { moved: false, reason: "missing" };

  if (client.capabilities.has("MOVE")) {
    const moved = await client.messageMove(String(uid), target, { uid: true });
    if (!moved) throw new Error(`Spostamento in «${target}» rifiutato dal server`);
    return { moved: true, target, newUid: moved.uidMap?.get(uid) ?? null, folderCreated };
  }

  const copied = await client.messageCopy(String(uid), target, { uid: true });
  if (!copied) throw new Error(`Copia in «${target}» rifiutata dal server: il messaggio resta dov'è`);
  if (client.capabilities.has("UIDPLUS")) {
    await client.messageDelete(String(uid), { uid: true });
  } else {
    await client.messageFlagsAdd(String(uid), ["\\Deleted"], { uid: true });
    log.warn(`il server non supporta UIDPLUS: l'originale UID ${uid} è segnato come eliminato ma non rimosso`);
  }
  return { moved: true, target, newUid: copied.uidMap?.get(uid) ?? null, folderCreated };
}
