import { describe, expect, test } from "bun:test";
import type { ImapFlow } from "imapflow";

import { folderExists, messagePresent, safeMove } from "../src/mail/move";

/** Just enough of ImapFlow for safeMove, with the answers a server can give. */
function fakeClient(options: {
  folders: string[];
  uids: number[];
  status?: "ok" | "refused";
  emptyFetch?: boolean;
  searchFails?: boolean;
  flags?: string[];
  storeRefused?: boolean;
  moveRefused?: boolean;
}) {
  const calls: string[] = [];
  const folders = new Set(options.folders);
  const flags = new Set(options.flags ?? []);
  const client = {
    async messageFlagsAdd(uid: string, added: string[]) {
      calls.push(`STORE ${uid} +${added.join(" ")}`);
      if (options.storeRefused) return false;
      for (const flag of added) flags.add(flag);
      return true;
    },
    async messageFlagsRemove(uid: string, removed: string[]) {
      calls.push(`STORE ${uid} -${removed.join(" ")}`);
      for (const flag of removed) flags.delete(flag);
      return true;
    },
    capabilities: new Set(["MOVE"]),
    async status(path: string) {
      calls.push(`STATUS ${path}`);
      if (options.status === "refused") return false;
      if (!folders.has(path)) throw Object.assign(new Error("Mailbox doesn't exist"), { code: "NotFound" });
      return { path, messages: 0 };
    },
    async list() {
      calls.push("LIST");
      return [...folders].map((path) => ({ path }));
    },
    async mailboxCreate(path: string) {
      calls.push(`CREATE ${path}`);
      folders.add(path);
      return { path, created: true };
    },
    async fetchOne(uid: string) {
      calls.push(`FETCH ${uid}`);
      return !options.emptyFetch && options.uids.includes(Number(uid)) ? { uid: Number(uid), flags } : false;
    },
    async search(query: { uid: string }) {
      calls.push(`SEARCH UID ${query.uid}`);
      if (options.searchFails) return false;
      return options.uids.filter((uid) => uid === Number(query.uid));
    },
    async messageMove(uid: string, target: string) {
      calls.push(`MOVE ${uid} ${target}`);
      if (options.moveRefused || !folders.has(target)) return false;
      return { path: "INBOX", destination: target, uidMap: new Map([[Number(uid), 7]]) };
    },
  };
  return { client: client as unknown as ImapFlow, calls, folders, flags };
}

describe("folderExists", () => {
  test("a refused STATUS is settled by LIST", async () => {
    const present = fakeClient({ folders: ["Archivio"], uids: [], status: "refused" });
    expect(await folderExists(present.client, "Archivio")).toBe(true);
    const missing = fakeClient({ folders: ["Archivio"], uids: [], status: "refused" });
    expect(await folderExists(missing.client, "Archivio/Pineapp")).toBe(false);
    expect(missing.calls).toEqual(["STATUS Archivio/Pineapp", "LIST"]);
  });
});

describe("messagePresent", () => {
  test("an empty FETCH is confirmed with UID SEARCH", async () => {
    expect(await messagePresent(fakeClient({ folders: [], uids: [42], emptyFetch: true }).client, 42)).toBe(true);
    expect(await messagePresent(fakeClient({ folders: [], uids: [], emptyFetch: true }).client, 42)).toBe(false);
  });

  test("a failed SEARCH is an error, not a missing message", async () => {
    const { client } = fakeClient({ folders: [], uids: [42], emptyFetch: true, searchFails: true });
    await expect(messagePresent(client, 42)).rejects.toThrow("non ha confermato");
  });
});

describe("safeMove", () => {
  test("creates the target when STATUS is refused and the folder is not listed", async () => {
    const { client, calls, folders } = fakeClient({ folders: ["INBOX"], uids: [42], status: "refused", emptyFetch: true });
    expect(await safeMove(client, 42, "INBOX/Pineapp")).toEqual({ moved: true, target: "INBOX/Pineapp", newUid: 7, folderCreated: true });
    expect(folders.has("INBOX/Pineapp")).toBe(true);
    expect(calls).toEqual(["FETCH 42", "SEARCH UID 42", "STATUS INBOX/Pineapp", "LIST", "CREATE INBOX/Pineapp", "MOVE 42 INBOX/Pineapp"]);
  });

  test("a message that is gone leaves the target folder alone", async () => {
    const { client, calls } = fakeClient({ folders: ["INBOX"], uids: [] });
    expect(await safeMove(client, 42, "INBOX/Pineapp")).toEqual({ moved: false, reason: "missing" });
    expect(calls).toEqual(["FETCH 42", "SEARCH UID 42"]);
  });

  test("markRead sets \\Seen right before the move", async () => {
    const { client, calls, flags } = fakeClient({ folders: ["Archivio"], uids: [42] });
    expect(await safeMove(client, 42, "Archivio", { markRead: true })).toMatchObject({ moved: true, markedRead: true });
    expect(flags.has("\\Seen")).toBe(true);
    expect(calls.slice(-2)).toEqual(["STORE 42 +\\Seen", "MOVE 42 Archivio"]);
  });

  test("without markRead the read state is left alone", async () => {
    const { client, calls, flags } = fakeClient({ folders: ["Archivio"], uids: [42] });
    expect(await safeMove(client, 42, "Archivio")).toEqual({ moved: true, target: "Archivio", newUid: 7, folderCreated: false });
    expect(flags.size).toBe(0);
    expect(calls.some((call) => call.startsWith("STORE"))).toBe(false);
  });

  test("a move that fails leaves the message unread again", async () => {
    const { client, flags } = fakeClient({ folders: ["Archivio"], uids: [42], moveRefused: true });
    await expect(safeMove(client, 42, "Archivio", { markRead: true })).rejects.toThrow("rifiutato");
    expect(flags.has("\\Seen")).toBe(false);
  });

  test("a move that fails does not unread what someone had already read", async () => {
    const { client, calls, flags } = fakeClient({ folders: ["Archivio"], uids: [42], moveRefused: true, flags: ["\\Seen"] });
    await expect(safeMove(client, 42, "Archivio", { markRead: true })).rejects.toThrow("rifiutato");
    expect(flags.has("\\Seen")).toBe(true);
    expect(calls.some((call) => call.startsWith("STORE"))).toBe(false);
  });

  test("a refused \\Seen does not stop the move, and is reported", async () => {
    const { client, calls } = fakeClient({ folders: ["Archivio"], uids: [42], storeRefused: true });
    expect(await safeMove(client, 42, "Archivio", { markRead: true })).toMatchObject({ moved: true, markedRead: false });
    expect(calls.at(-1)).toBe("MOVE 42 Archivio");
  });
});
