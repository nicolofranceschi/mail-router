import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { AccountRuntime } from "../src/mail/clients";
import { describeSmtpError, sendRaw, verifySmtp } from "../src/mail/clients";

/** Minimal SMTP server: greets, accepts AUTH and one message per session. */
function fakeSmtp() {
  const received: string[] = [];
  const server = Bun.listen<{ data: boolean; buffer: string }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { data: false, buffer: "" };
        socket.write("220 fake ESMTP\r\n");
      },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        let index: number;
        while ((index = socket.data.buffer.indexOf("\r\n")) >= 0) {
          const line = socket.data.buffer.slice(0, index);
          socket.data.buffer = socket.data.buffer.slice(index + 2);
          if (socket.data.data) {
            if (line === ".") {
              socket.data.data = false;
              socket.write("250 queued\r\n");
            } else received.push(line);
            continue;
          }
          const command = line.toUpperCase();
          if (command.startsWith("EHLO") || command.startsWith("HELO")) socket.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (command.startsWith("AUTH")) socket.write("235 ok\r\n");
          else if (command.startsWith("DATA")) {
            socket.data.data = true;
            socket.write("354 go\r\n");
          } else if (command.startsWith("QUIT")) {
            socket.write("221 bye\r\n");
            socket.end();
          } else socket.write("250 ok\r\n");
        }
      },
    },
  });
  return { port: server.port, received, stop: () => server.stop(true) };
}

function runtime(port: number): AccountRuntime {
  return {
    config: {
      id: "posta",
      imap: { host: "127.0.0.1", port: 1, secure: false, user: "u", password: "-", rejectUnauthorized: true },
      smtp: {
        host: "127.0.0.1",
        port,
        secure: false,
        requireTls: false,
        user: "smistamento@azienda.it",
        password: "-",
        rejectUnauthorized: true,
        from: "smistamento@azienda.it",
      },
      watch: ["INBOX"],
      ownAddresses: [],
      markForwarded: true,
      forwardAsAttachment: false,
    },
    imapPassword: "x",
    smtpPassword: "secret",
  };
}

const CLOSED_PORT = 1;
let fake: ReturnType<typeof fakeSmtp>;
beforeAll(() => {
  fake = fakeSmtp();
});
afterAll(() => fake.stop());

describe("SMTP settings", () => {
  test("a test uses the port in the form, not the one tried before", async () => {
    await expect(verifySmtp(runtime(CLOSED_PORT))).rejects.toThrow(`127.0.0.1:${CLOSED_PORT}`);
    await verifySmtp(runtime(fake.port));
  });

  test("sending follows changed settings for the same account", async () => {
    const raw = Buffer.from("From: a@azienda.it\r\nTo: b@azienda.it\r\nSubject: prova\r\n\r\nciao\r\n");
    const envelope = { from: "a@azienda.it", to: ["b@azienda.it"] };
    await expect(sendRaw(runtime(CLOSED_PORT), raw, envelope)).rejects.toThrow("Connessione rifiutata");
    const sent = await sendRaw(runtime(fake.port), raw, envelope);
    expect(sent.accepted).toEqual(["b@azienda.it"]);
    expect(fake.received).toContain("Subject: prova");
  });

  test("errors say where and what to change", () => {
    const where = { host: "smtp.azienda.it", port: 587 };
    expect(describeSmtpError(new Error("connect ECONNREFUSED 1.2.3.4:587"), where)).toContain("porta chiusa");
    expect(describeSmtpError(new Error("Connection timeout"), where)).toContain("firewall");
    expect(describeSmtpError(new Error("ssl3_get_record:wrong version number"), where)).toContain("togli «SSL diretto»");
    expect(describeSmtpError(Object.assign(new Error("Invalid login: 535 5.7.8"), { code: "EAUTH" }), where)).toContain("password");
    expect(describeSmtpError(new Error("getaddrinfo ENOTFOUND smtp.azienda.it"), where)).toContain("non trovato");
  });
});
