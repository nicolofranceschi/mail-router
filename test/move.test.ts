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
}) {
  const calls: string[] = [];
  const folders = new Set(options.folders);
  const client = {
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
      return !options.emptyFetch && options.uids.includes(Number(uid)) ? { uid: Number(uid) } : false;
    },
    async search(query: { uid: string }) {
      calls.push(`SEARCH UID ${query.uid}`);
      if (options.searchFails) return false;
      return options.uids.filter((uid) => uid === Number(query.uid));
    },
    async messageMove(uid: string, target: string) {
      calls.push(`MOVE ${uid} ${target}`);
      if (!folders.has(target)) return false;
      return { path: "INBOX", destination: target, uidMap: new Map([[Number(uid), 7]]) };
    },
  };
  return { client: client as unknown as ImapFlow, calls, folders };
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
});
