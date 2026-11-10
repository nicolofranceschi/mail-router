import { existsSync } from "node:fs";
import path from "node:path";

import { connectInstructions } from "./access";
import { hasToken, rotateToken } from "./auth";
import { runBridge } from "./bridge";
import { verifyAccount } from "./check";
import { ConfigError, configPath, DB_FILE, defaultHome, loadConfig, VERSION } from "./config";
import { reportFailure } from "./crash";
import { UserFacingError } from "./errors";
import { errorMessage, log } from "./log";
import { CONTAINER_PORT, exportForDocker, importExport } from "./migrate";
import { generateMasterKey, MasterKeyError, protectSecret, requireMasterKey } from "./secrets";
import { App } from "./service/app";
import { Store } from "./store";
import { startServer } from "./web/server";
import { startSetupServer } from "./web/setup";

const HELP = `Mail Router ${VERSION} — inoltro automatico della posta con regole gestite da Claude via MCP

Uso: mail-router <comando> [--home <cartella dati>]

Nel container:
  serve           avvia pannello, server MCP e smistamento (predefinito);
                  senza configurazione apre prima la procedura guidata
  check           verifica accesso IMAP, cartelle e invio SMTP
  status          mostra se il servizio risponde
  health          come status, in silenzio (per l'healthcheck di Docker)
  token           genera una nuova chiave di accesso (la precedente smette di funzionare)
  encrypt         cifra una password (letta da stdin) per config.json
  import <dir>    importa un'esportazione di export-docker in una cartella dati vuota
  genkey          genera una chiave master per MAIL_ROUTER_MASTER_KEY

Su un PC Windows:
  bridge          ponte per l'app Claude: --url http://IP:8787/mcp, chiave in MAIL_ROUTER_KEY
  export-docker   esporta la vecchia installazione Windows per il container
                  (--out <cartella>, --key <chiave master>; da amministratore)

  version         versione

Cartella dati predefinita: ${defaultHome()}
`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
      const next = argv[index + 1];
      if (inline !== undefined) flags.set(name, inline);
      else if (next !== undefined && !next.startsWith("--") && ["home", "out", "url", "key"].includes(name)) {
        flags.set(name, next);
        index++;
      } else flags.set(name, true);
    } else positional.push(arg);
  }
  return { command: positional[0] ?? "serve", args: positional.slice(1), flags };
}

/** Configuration errors of the background service must land in the log file, not only on a console nobody sees. */
function logged<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    log.error(errorMessage(error));
    throw error;
  }
}

/** While there is no config.json the port serves the setup wizard; its code goes to the container log. */
async function runSetupWizard(home: string): Promise<void> {
  const code = process.env.MAIL_ROUTER_SETUP_CODE?.trim() || undefined;
  const setup = startSetupServer(home, { port: CONTAINER_PORT, code });
  const base = process.env.MAIL_ROUTER_PUBLIC_URL?.replace(/\/+$/, "") ?? `http://<IP-DEL-SERVER>:${CONTAINER_PORT}`;
  log.info(
    [
      "nessuna configurazione: procedura guidata attiva.",
      `  Apri ${base}/?once=${setup.code}`,
      `  (codice di configurazione: ${setup.code})`,
    ].join("\n"),
  );
  await setup.done;
}

async function runServe(home: string): Promise<void> {
  log.attachDirectory(home);
  logged(() => requireMasterKey());
  if (!existsSync(configPath(home))) await runSetupWizard(home);

  let current: { app: App; server: ReturnType<typeof startServer> } | null = null;
  const start = async () => {
    const config = logged(() => loadConfig(home));
    const app = await App.open(home, config).catch((error) => {
      log.error(`avvio non riuscito: ${errorMessage(error)}`);
      throw error;
    });
    if (!hasToken(app.store)) log.warn("nessuna chiave di accesso: generane una con «mail-router token»");
    const server = startServer(app);
    app.startBackground();
    app.onRestartRequest = () => void restart();
    current = { app, server };
  };
  const stopCurrent = async () => {
    const running = current;
    current = null;
    if (!running) return;
    await running.server.stop(true);
    await running.app.stop().catch(() => undefined);
  };
  // New settings from the panel: reopen in-process, so no restart policy is needed.
  const restart = async () => {
    await stopCurrent();
    try {
      await start();
    } catch {
      process.exit(1); // the error is logged; Docker's restart policy takes over
    }
  };

  let stopping = false;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`arresto (${reason})`);
    await stopCurrent();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (error) => log.error("promessa rifiutata non gestita", error));
  process.on("uncaughtException", (error) => {
    log.error("errore non gestito: il container verrà riavviato", error);
    process.exit(1);
  });

  await start();
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    const value = prompt("Password da cifrare (visibile):");
    return value ?? "";
  }
  return (await Bun.stdin.text()).replace(/\r?\n$/, "");
}

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv.slice(2));
  const homeFlag = flags.get("home");
  const home = typeof homeFlag === "string" ? path.resolve(homeFlag) : defaultHome();

  switch (command) {
    case "serve":
    case "worker":
      return runServe(home);
    case "bridge": {
      // For the Claude desktop app: a local stdio MCP server relaying to the service on the LAN.
      const url = flags.get("url");
      const key = flags.get("key") ?? process.env.MAIL_ROUTER_KEY;
      if (typeof key !== "string" || !key) throw new Error("bridge: manca la chiave (variabile MAIL_ROUTER_KEY o --key)");
      return runBridge(typeof url === "string" ? url : "http://127.0.0.1:8787/mcp", key);
    }
    case "check": {
      const config = loadConfig(home);
      let failed = false;
      for (const account of config.accounts) {
        const problems = await verifyAccount(config, account.id);
        console.log(problems.length ? `✗ ${account.id}` : `✓ ${account.id}: IMAP, cartelle${account.smtp ? " e SMTP" : ""} a posto`);
        for (const problem of problems) console.log(`    ${problem}`);
        failed ||= problems.length > 0;
      }
      process.exitCode = failed ? 1 : 0;
      return;
    }
    case "status":
      return printStatus(home);
    case "health":
      return printStatus(home, { quiet: true });
    case "token": {
      const config = loadConfig(home);
      const store = new Store(path.join(home, DB_FILE));
      const token = rotateToken(store);
      store.close();
      console.log(connectInstructions(token, config.mcp));
      console.log("\nLa chiave precedente non è più valida: aggiorna la connessione in Claude.");
      return;
    }
    case "encrypt": {
      requireMasterKey();
      const value = await readStdin();
      if (!value) throw new UserFacingError("Password vuota");
      console.log(protectSecret(value));
      return;
    }
    case "genkey":
      console.log(generateMasterKey());
      return;
    case "import": {
      const source = args[0];
      if (!source) throw new UserFacingError("import: indica la cartella esportata, es. mail-router import /import");
      requireMasterKey();
      return importExport(path.resolve(source), home, { force: flags.has("force") });
    }
    case "export-docker": {
      const out = flags.get("out");
      const key = flags.get("key");
      return exportForDocker({
        home,
        out: path.resolve(typeof out === "string" ? out : "mail-router-docker"),
        ...(typeof key === "string" ? { key } : {}),
        force: flags.has("force"),
      });
    }
    case "version":
      console.log(VERSION);
      return;
    default:
      console.log(HELP);
  }
}

async function printStatus(home: string, options: { quiet?: boolean } = {}): Promise<void> {
  const config = existsSync(configPath(home)) ? loadConfig(home) : null;
  const tls = Boolean(config?.mcp.tls);
  const port = config?.mcp.port ?? CONTAINER_PORT;
  try {
    const response = await fetch(`${tls ? "https" : "http"}://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5000),
      ...(tls ? { tls: { rejectUnauthorized: false } } : {}),
    });
    const health = (await response.json()) as { version: string; mode: string };
    if (!options.quiet) console.log(`Il servizio risponde: versione ${health.version}, modalità ${health.mode.toUpperCase()}`);
  } catch {
    if (!options.quiet) console.log(`Il servizio non risponde sulla porta ${port}. Log: ${path.join(home, "logs")}`);
    process.exitCode = 1;
  }
}

main().then(
  () => undefined,
  (error) => {
    reportFailure("comando", error, error instanceof ConfigError || error instanceof UserFacingError || error instanceof MasterKeyError);
    process.exit(1);
  },
);
