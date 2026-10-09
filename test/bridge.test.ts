import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { rotateToken } from "../src/auth";
import { parseConfig } from "../src/config";
import { App } from "../src/service/app";
import { startServer } from "../src/web/server";

const PORT = 18794;
const ENTRY = path.join(import.meta.dir, "..", "src", "entry.ts");
const home = mkdtempSync(path.join(os.tmpdir(), "mail-router-bridge-"));
let app: App;
let server: ReturnType<typeof startServer>;
let key = "";

beforeAll(async () => {
  // The service without mailbox watchers: the bridge only needs its MCP endpoint.
  app = await App.open(
    home,
    parseConfig({
      accounts: [{ id: "posta", imap: { host: "127.0.0.1", port: 1, secure: false, user: "info@azienda.it", password: "plain:x" } }],
      mcp: { host: "127.0.0.1", port: PORT },
    }),
  );
  key = rotateToken(app.store);
  server = startServer(app);
});

afterAll(async () => {
  void server.stop(true);
  await app.stop();
  rmSync(home, { recursive: true, force: true });
});

function bridgeClient(withKey: string) {
  // MAIL_ROUTER_BRIDGE_BIN=dist/mail-router runs the same test against the compiled executable.
  const binary = process.env.MAIL_ROUTER_BRIDGE_BIN;
  const transport = new StdioClientTransport({
    command: binary ? path.resolve(binary) : process.execPath,
    args: [...(binary ? [] : [ENTRY]), "bridge", "--url", `http://127.0.0.1:${PORT}/mcp`],
    env: { ...(process.env as Record<string, string>), MAIL_ROUTER_KEY: withKey },
    stderr: "pipe",
  });
  return { client: new Client({ name: "desktop", version: "1.0.0" }), transport };
}

describe("stdio bridge for the Claude desktop app", () => {
  test("tools, instructions and calls pass through the bridge", async () => {
    const { client, transport } = bridgeClient(key);
    await client.connect(transport);
    expect(client.getInstructions()).toContain("function rule(email, data, h)");
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["create_rule", "get_status", "forward_email"]));
    const created = await client.callTool({
      name: "create_rule",
      arguments: { name: "Ponte", description: "", code: "function rule(){ return null }" },
    });
    expect(JSON.parse((created.content as { text: string }[])[0]!.text).created.mode).toBe("shadow");
    await client.close();
  });

  test("a wrong key is reported to the app in plain words", async () => {
    const { client, transport } = bridgeClient("mr_sbagliata");
    await expect(client.connect(transport)).rejects.toThrow("chiave di accesso non valida");
    await client.close().catch(() => undefined);
  });
});
