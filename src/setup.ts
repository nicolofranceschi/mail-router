import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";

import { configPath, DB_FILE, parseConfig, PRIVATE_NETWORKS, toAccountId, type ConfigInput } from "./config";
import { listFoldersFor, verifyAccount } from "./check";
import { rotateToken } from "./auth";
import { promptProtectedSecret, resolveSecret } from "./secrets";
import { assertAdmin, installDir, restrictDataFolder } from "./service/windows";
import { Store } from "./store";
import path from "node:path";

function ask(question: string, fallback?: string): string {
  // Bun's prompt() answers null both for an empty line and for a closed input: give up after a few.
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = prompt(fallback ? `${question} [${fallback}]:` : `${question}:`)?.trim();
    if (answer) return answer;
    if (fallback !== undefined) return fallback;
    console.log("  (valore obbligatorio)");
  }
  throw new Error(`Nessuna risposta a «${question}»: configurazione interrotta`);
}

function askNumber(question: string, fallback: number): number {
  for (;;) {
    const value = Number(ask(question, String(fallback)));
    if (Number.isInteger(value) && value > 0) return value;
    console.log("  (serve un numero intero)");
  }
}

/** Checked here rather than at the end, where an invalid id would throw away every other answer. */
function askAccountId(): string {
  for (;;) {
    const answer = ask("Identificativo della casella (breve: lettere, numeri, - e _)", "posta");
    const id = toAccountId(answer);
    if (id) {
      if (id !== answer.toLowerCase()) console.log(`  (uso «${id}»)`);
      return id;
    }
    console.log("  (servono lettere o numeri)");
  }
}

function yes(question: string, fallback: boolean): boolean {
  const answer = ask(`${question} (s/n)`, fallback ? "s" : "n").toLowerCase();
  return answer.startsWith("s") || answer.startsWith("y");
}

function list(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry): entry is os.NetworkInterfaceInfo => Boolean(entry && entry.family === "IPv4" && !entry.internal))
    .map((entry) => entry.address);
}

/** Where this PC can be reached and the command that connects Claude Code. */
export function accessInfo(mcp: { host: string; port: number; tls?: unknown }, token = "<CHIAVE>") {
  const scheme = mcp.tls ? "https" : "http";
  const listensEverywhere = mcp.host === "0.0.0.0" || mcp.host === "::";
  const hosts = listensEverywhere ? lanAddresses() : [mcp.host];
  const host = hosts[0] ?? "<IP-del-PC>";
  const mcpUrl = `${scheme}://${host}:${mcp.port}/mcp`;
  // The Claude app reaches "connectors" from Anthropic's cloud, which cannot see the LAN:
  // a server in its config file runs on the PC, so it starts this executable as a local bridge.
  const executable = process.platform === "win32" ? path.join(installDir(), "mail-router.exe") : process.execPath;
  const desktopConfig = JSON.stringify(
    { mcpServers: { "mail-router": { command: executable, args: ["bridge", "--url", mcpUrl], env: { MAIL_ROUTER_KEY: token } } } },
    null,
    2,
  );
  return {
    hosts,
    panelUrl: `${scheme}://${host}:${mcp.port}/`,
    mcpUrl,
    command: `claude mcp add --transport http --scope user mail-router ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    desktopConfig,
  };
}

export function connectInstructions(token: string, mcp: { host: string; port: number; tls?: unknown }): string {
  const scheme = mcp.tls ? "https" : "http";
  const listensEverywhere = mcp.host === "0.0.0.0" || mcp.host === "::";
  const hosts = listensEverywhere ? lanAddresses() : [mcp.host];
  const host = hosts[0] ?? "<IP-del-PC>";
  const port = mcp.port;
  return [
    "Token MCP (viene mostrato solo ora: conservalo in un posto sicuro):",
    `  ${token}`,
    "",
    "Dal tuo PC, collega Claude Code a questo servizio con:",
    `  claude mcp add --transport http --scope user mail-router ${scheme}://${host}:${port}/mcp --header "Authorization: Bearer ${token}"`,
    ...(hosts.length > 1 ? ["", `Indirizzi di questo PC: ${hosts.join(", ")}`] : []),
  ].join("\n");
}

export async function runSetup(home: string): Promise<void> {
  console.log(`Configurazione di Mail Router — cartella dati: ${home}\n`);
  const file = configPath(home);
  if (existsSync(file) && !yes(`Esiste già ${file}. Sovrascriverla?`, false)) {
    console.log("Configurazione lasciata invariata.");
    return;
  }
  mkdirSync(home, { recursive: true });
  if (process.platform === "win32") {
    // Passwords end up in this folder: lock it down before writing anything.
    assertAdmin();
    restrictDataFolder(home);
  }

  const instanceName = ask("Nome del servizio (compare in Claude)", "Smistamento posta");
  const accountId = askAccountId();

  console.log("\n— Lettura (IMAP) —");
  const imapHost = ask("Server IMAP");
  const imapPort = askNumber("Porta IMAP", 993);
  const imapSecure = imapPort === 993 ? true : yes("Connessione SSL/TLS diretta?", false);
  const imapUser = ask("Utente IMAP (di solito l'indirizzo email)");
  const imapPassword = promptProtectedSecret("Password IMAP");
  const imapRejectUnauthorized = yes("Verificare il certificato del server? (rispondi n solo per server interni con certificato autofirmato)", true);

  const imap = {
    host: imapHost,
    port: imapPort,
    secure: imapSecure,
    user: imapUser,
    password: imapPassword,
    rejectUnauthorized: imapRejectUnauthorized,
  };
  const probeAccount = {
    config: { id: accountId, imap, watch: ["INBOX"], ownAddresses: [], markForwarded: true, forwardAsAttachment: false },
    imapPassword: resolveSecret(imapPassword, "password IMAP"),
    smtpPassword: null,
  };

  console.log("\nVerifica dell'accesso IMAP…");
  const folders = await listFoldersFor(probeAccount);
  console.log("Accesso riuscito. Cartelle disponibili:");
  folders.forEach((folder, index) => console.log(`  ${String(index + 1).padStart(3)}  ${folder.path}${folder.specialUse ? `  (${folder.specialUse})` : ""}`));

  const pick = (question: string, fallback?: string): string | undefined => {
    const answer = prompt(`${question}${fallback ? ` [${fallback}] (- = nessuna)` : ""}:`)?.trim() || fallback;
    if (!answer || answer === "-") return undefined;
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= folders.length) return folders[index - 1]!.path;
    return answer;
  };
  const watchAnswer = ask("Cartelle da monitorare (numeri separati da virgola)", "1");
  const watch = list(watchAnswer).map((entry) => {
    const index = Number(entry);
    return Number.isInteger(index) && index >= 1 && index <= folders.length ? folders[index - 1]!.path : entry;
  });
  const sentDefault = folders.find((folder) => folder.specialUse === "\\Sent")?.path;
  const trashDefault = folders.find((folder) => folder.specialUse === "\\Trash")?.path;
  const sentFolder = pick("Cartella dove salvare una copia di quanto inviato (numero, vuoto = nessuna)", sentDefault);
  const trashFolder = pick("Cartella cestino per delete_email (numero, vuoto = nessuna)", trashDefault);

  console.log("\n— Invio (SMTP) —");
  let smtp: ConfigInput["accounts"][number]["smtp"];
  if (yes("Configurare l'invio (serve per inoltrare)?", true)) {
    const smtpHost = ask("Server SMTP", imapHost);
    const smtpPort = askNumber("Porta SMTP (587 = STARTTLS, 465 = SSL)", 587);
    const smtpUser = ask("Utente SMTP", imapUser);
    const samePassword = smtpUser === imapUser && yes("Stessa password dell'IMAP?", true);
    const smtpPassword = samePassword ? imapPassword : promptProtectedSecret("Password SMTP");
    const from = ask("Mittente degli inoltri (es. Smistamento <info@azienda.it>)", imapUser);
    smtp = {
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      user: smtpUser,
      password: smtpPassword,
      rejectUnauthorized: imapRejectUnauthorized,
      from,
    };
  }

  console.log("\n— Sicurezza —");
  const ownAddresses = list(ask("Indirizzi di questa casella, separati da virgola (non verranno mai usati come destinatari)", imapUser));
  const allowedDomains = list(
    prompt("Domini a cui le regole possono inoltrare, separati da virgola (vuoto = qualsiasi; consigliato il dominio aziendale):")?.trim() ?? "",
  );
  const port = askNumber("Porta del server MCP", 8787);

  const config: ConfigInput = {
    instanceName,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Rome",
    accounts: [
      {
        id: accountId,
        imap,
        ...(smtp ? { smtp } : {}),
        watch,
        ownAddresses,
        ...(sentFolder ? { sentFolder } : {}),
        ...(trashFolder ? { trashFolder } : {}),
        markForwarded: true,
      },
    ],
    outbound: { allowedDomains },
    mcp: { host: "0.0.0.0", port, allowedNetworks: PRIVATE_NETWORKS },
  };
  const parsed = parseConfig(config);

  if (parsed.accounts[0]!.smtp) {
    console.log("\nVerifica dell'invio SMTP…");
    const problems = await verifyAccount(parsed, parsed.accounts[0]!.id);
    for (const problem of problems) console.log(`  ! ${problem}`);
    if (problems.length && !yes("Salvare comunque la configurazione?", false)) return;
  }

  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`\nConfigurazione salvata in ${file}`);

  const store = new Store(path.join(home, DB_FILE));
  const token = rotateToken(store);
  store.close();
  console.log(`\n${connectInstructions(token, parsed.mcp)}\n`);
  console.log(
    "Il servizio parte in modalità OMBRA: valuta le regole e registra le decisioni senza inviare nulla.\n" +
      "Passa a «live» da Claude quando le regole sono pronte.\n",
  );
  if (process.platform === "win32") {
    console.log("Prossimo passo: mail-router install   (installa il servizio in background e lo avvia)");
  } else {
    console.log("Prossimo passo: mail-router run   (avvia il servizio)");
  }
}
