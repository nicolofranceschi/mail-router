import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import { importExport } from "../src/migrate";
import { encryptWithKey, masterKey, protectSecret, resolveSecret } from "../src/secrets";

const KEY_A = "a".repeat(40);
const KEY_B = "b".repeat(40);
const saved = { ...process.env };

afterEach(() => {
  for (const name of ["MAIL_ROUTER_MASTER_KEY", "MAIL_ROUTER_MASTER_KEY_FILE", "MAIL_ROUTER_ALLOW_PLAIN"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("master-key secrets", () => {
  test("round trip, fresh IV every time", () => {
    process.env.MAIL_ROUTER_MASTER_KEY = KEY_A;
    const one = protectSecret("Pàssword!");
    const two = protectSecret("Pàssword!");
    expect(one).toStartWith("aes:");
    expect(one).not.toBe(two);
    expect(resolveSecret(one, "x")).toBe("Pàssword!");
  });

  test("the wrong key is refused, not silently wrong", () => {
    process.env.MAIL_ROUTER_MASTER_KEY = KEY_A;
    const value = protectSecret("segreto");
    process.env.MAIL_ROUTER_MASTER_KEY = KEY_B;
    expect(() => resolveSecret(value, "imap")).toThrow(/chiave master/);
  });

  test("no key: refuse to store passwords unless plain is allowed", () => {
    delete process.env.MAIL_ROUTER_MASTER_KEY;
    delete process.env.MAIL_ROUTER_ALLOW_PLAIN; // other test files run in the same process
    expect(() => protectSecret("x")).toThrow(/Chiave master mancante/);
    process.env.MAIL_ROUTER_ALLOW_PLAIN = "1";
    expect(protectSecret("x")).toBe("plain:x");
  });

  test("short keys are refused; a key file works like the variable", () => {
    process.env.MAIL_ROUTER_MASTER_KEY = "corta";
    expect(() => masterKey()).toThrow(/almeno 32/);
    const dir = mkdtempSync(path.join(os.tmpdir(), "mr-key-"));
    try {
      writeFileSync(path.join(dir, "key"), `${KEY_A}\n`);
      process.env.MAIL_ROUTER_MASTER_KEY_FILE = path.join(dir, "key");
      const fromFile = masterKey()!;
      delete process.env.MAIL_ROUTER_MASTER_KEY_FILE;
      process.env.MAIL_ROUTER_MASTER_KEY = KEY_A;
      expect(fromFile.equals(masterKey()!)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("import of a Windows export", () => {
  function makeExport(password: string) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mr-export-"));
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ accounts: [{ id: "posta", imap: { host: "h", user: "u", password } }] }),
    );
    const db = new Database(path.join(dir, "mail-router.db"));
    db.run("CREATE TABLE t (v TEXT)");
    db.run("INSERT INTO t VALUES ('dati veri')");
    db.close();
    return dir;
  }

  test("copies config and database when the key opens every password", () => {
    process.env.MAIL_ROUTER_MASTER_KEY = KEY_A;
    const source = makeExport(protectSecret("pw"));
    const home = mkdtempSync(path.join(os.tmpdir(), "mr-home-"));
    try {
      importExport(source, home);
      expect(readFileSync(path.join(home, "config.json"), "utf8")).toContain("aes:");
      const db = new Database(path.join(home, "mail-router.db"), { readonly: true });
      expect((db.query("SELECT v FROM t").get() as { v: string }).v).toBe("dati veri");
      db.close();
      expect(() => importExport(source, home)).toThrow(/già una configurazione/);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses an export made with another key, or still in DPAPI form", () => {
    const other = encryptWithKey("pw", Buffer.alloc(32, 7));
    process.env.MAIL_ROUTER_MASTER_KEY = KEY_A;
    for (const password of [other, "dpapi:AAAA"]) {
      const source = makeExport(password);
      const home = mkdtempSync(path.join(os.tmpdir(), "mr-home-"));
      try {
        expect(() => importExport(source, home)).toThrow();
      } finally {
        rmSync(source, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    }
  });
});
