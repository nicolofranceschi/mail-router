import type { ImapFlow } from "imapflow";

import { log } from "../log";

export type MoveResult = { moved: true; target: string; newUid: number | null; folderCreated: boolean } | { moved: false; reason: "missing" };

/**
 * STATUS on a missing folder throws NotFound (imapflow double-checks with LIST).
 * Any other refusal makes imapflow answer `false`, which says nothing about the
 * folder (a shared folder may refuse STATUS, a server may refuse it for a folder
 * that is not there), so the folder list decides.
 */
export async function folderExists(client: ImapFlow, path: string): Promise<boolean> {
  try {
    if (await client.status(path, { messages: true })) return true;
  } catch (error) {
    if ((error as { code?: string }).code === "NotFound") return false;
    throw error;
  }
  const folders = await client.list();
  return folders.some((folder) => folder.path === path);
}

/**
 * imapflow answers `false` for an empty FETCH, and MDaemon has returned an
 * empty FETCH for a message that was there: only a UID SEARCH that comes back
 * without the UID counts as "gone".
 */
export async function messagePresent(client: ImapFlow, uid: number): Promise<boolean> {
  if (await client.fetchOne(String(uid), { uid: true }, { uid: true })) return true;
  const found = await client.search({ uid: String(uid) }, { uid: true });
  if (!found) throw new Error(`Il server non ha confermato se il messaggio UID ${uid} è ancora nella cartella`);
  return found.includes(uid);
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
  // Look for the message before any command on another folder, and create nothing for a message that is gone.
  if (!(await messagePresent(client, uid))) return { moved: false, reason: "missing" };

  // Create only when missing: some servers answer CREATE on an existing folder with a bare NO.
  let folderCreated = false;
  if (!(await folderExists(client, target))) {
    await client.mailboxCreate(target);
    folderCreated = true;
    log.info(`cartella «${target}» creata`);
  }

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
