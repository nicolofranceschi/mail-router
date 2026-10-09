/**
 * `mail-router bridge`: a local stdio MCP server that relays every message to
 * the service's HTTP endpoint on the LAN. The Claude desktop app reaches
 * "remote" connectors from Anthropic's cloud, which cannot see a private
 * network; servers declared in its config file run on the user's PC instead,
 * so this bridge — the same executable, no Node.js needed — makes the LAN
 * service available to it.
 *
 * Stdout carries the protocol only: diagnostics go to stderr.
 */
import { createInterface } from "node:readline";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  result?: { protocolVersion?: string };
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function failure(id: JsonRpcMessage["id"], message: string): void {
  if (id === undefined || id === null) return;
  writeMessage({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

function explainStatus(status: number, url: string): string {
  if (status === 401) return "Mail Router: chiave di accesso non valida (controlla MAIL_ROUTER_KEY)";
  if (status === 403) return `Mail Router: questo computer non è tra le reti ammesse da ${url}`;
  if (status === 429) return "Mail Router: troppi tentativi con una chiave errata, riprova tra un minuto";
  return `Mail Router: risposta ${status} da ${url}`;
}

/** Messages in a text/event-stream body (the service answers JSON, but stay tolerant). */
function eventStreamMessages(body: string): unknown[] {
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((data) => JSON.parse(data) as unknown);
}

export async function runBridge(url: string, key: string): Promise<void> {
  let protocolVersion: string | null = null;
  let pending = 0;
  let inputClosed = false;
  const maybeExit = () => {
    if (inputClosed && pending === 0) process.exit(0);
  };

  const relay = async (line: string) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      process.stderr.write(`ponte: messaggio non valido ignorato\n`);
      return;
    }
    pending++;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${key}`,
          ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
        },
        body: line,
        signal: AbortSignal.timeout(300_000),
      });
      if (response.status === 202) return;
      if (!response.ok) {
        failure(message.id, explainStatus(response.status, url));
        return;
      }
      const body = await response.text();
      const type = response.headers.get("content-type") ?? "";
      const parsed = type.includes("text/event-stream") ? eventStreamMessages(body) : [JSON.parse(body) as unknown];
      for (const entry of parsed.flat()) {
        const reply = entry as JsonRpcMessage;
        if (reply.result?.protocolVersion) protocolVersion = reply.result.protocolVersion;
        writeMessage(reply);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`ponte: ${reason}\n`);
      failure(message.id, `Mail Router non raggiungibile su ${url}: ${reason}`);
    } finally {
      pending--;
      maybeExit();
    }
  };

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (line.trim()) void relay(line);
  });
  input.on("close", () => {
    inputClosed = true;
    maybeExit();
  });
  await new Promise<void>(() => undefined);
}
