import path from "node:path";

import { verifyAccount } from "./check";
import { ConfigError, DB_FILE, defaultHome, loadConfig, VERSION } from "./config";
import { reportFailure } from "./crash";
import { errorMessage, log } from "./log";
import { hasToken, rotateToken } from "./auth";
import { runBridge } from "./bridge";
import { openUi, runUiHelper, UserFacingError } from "./launcher";
import { connectInstructions, runSetup } from "./setup";
import { promptProtectedSecret } from "./secrets";
import { App } from "./service/app";
import { assertAdmin, installService, uninstallService } from "./service/windows";
import { selfCommand } from "./self";
import { Store } from "./store";
import { startServer } from "./web/server";

const HELP = `Mail Router ${VERSION} — inoltro automatico della posta con regole gestite da Claude via MCP

Uso: mail-router <comando> [--home <cartella dati>]

  (nessuno)   apre il pannello di controllo (al primo avvio: la procedura guidata)
  setup       procedura guidata di configurazione (--terminale per la versione testuale)
  check       verifica accesso IMAP, cartelle e invio SMTP
  install     installa e avvia il servizio in background (Windows, da amministratore)
              opzione --firewall <indirizzi>: chi può raggiungere la porta MCP (predefinito LocalSubnet)
  uninstall   rimuove il servizio (i dati restano); --remove-program elimina anche il programma
  run         avvia il servizio in primo piano, con riavvio automatico in caso di errore
  status      mostra se il servizio locale risponde
  token       genera un nuovo token MCP (il precedente smette di funzionare)
  bridge      ponte per l'app Claude: --url http://IP:8787/mcp, chiave in MAIL_ROUTER_KEY
  encrypt     cifra una password per config.json (Windows: DPAPI)
  version     versione

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
      else if (next !== undefined && !next.startsWith("--") && ["home", "firewall", "out", "url", "key"].includes(name)) {
        flags.set(name, next);
        index++;
      } else flags.set(name, true);
    } else positional.push(arg);
  }
  return { command: positional[0] ?? "ui", flags };
}

/** Configuration errors of the background service must land in the log file, not only on a console nobody sees. */
function loadConfigLogged(home: string) {
  try {
    return loadConfig(home);
  } catch (error) {
    log.error(errorMessage(error));
    throw error;
  }
}

async function runWorker(home: string): Promise<void> {
  log.attachDirectory(home);
  const config = loadConfigLogged(home);
  const app = await App.open(home, config).catch((error) => {
    log.error(`avvio non riuscito: ${errorMessage(error)}`);
    throw error;
  });
  if (!hasToken(app.store)) {
    log.warn("nessun token MCP configurato: genera un token con «mail-router token» per collegare Claude");
  }
  const server = startServer(app);
  app.startBackground();

  let stopping = false;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`arresto (${reason})`);
    void server.stop(true);
    await app.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (error) => log.error("promessa rifiutata non gestita", error));
  process.on("uncaughtException", (error) => {
    log.error("errore non gestito: il servizio verrà riavviato", error);
    process.exit(1);
  });

  if (process.env.MAIL_ROUTER_SUPERVISED === "1") {
    // The supervisor holds our stdin: when it goes away, so do we.
    process.stdin.on("end", () => void shutdown("supervisore terminato"));
    process.stdin.on("close", () => void shutdown("supervisore terminato"));
    process.stdin.resume();
    const parent = process.ppid;
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") void shutdown("supervisore terminato");
      }
    }, 15_000).unref();
  }
}

async function runSupervisor(home: string): Promise<void> {
  log.attachDirectory(home);
  loadConfigLogged(home); // fail fast on a broken configuration
  const command = [...selfCommand(), "worker", "--home", home];
  let stopping = false;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  const stop = () => {
    stopping = true;
    child?.kill();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let backoff = 1000;
  while (!stopping) {
    const started = Date.now();
    child = Bun.spawn(command, {
      stdin: "pipe",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, MAIL_ROUTER_SUPERVISED: "1" },
    });
    const code = await child.exited;
    if (stopping) break;
    if (Date.now() - started > 60_000) backoff = 1000;
    log.error(`il servizio si è fermato (codice ${code}): riavvio tra ${Math.round(backoff / 1000)} s`);
    await Bun.sleep(backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const homeFlag = flags.get("home");
  const home = typeof homeFlag === "string" ? path.resolve(homeFlag) : defaultHome();

  switch (command) {
    case "worker":
      return runWorker(home);
    case "run":
      return runSupervisor(home);
    case "ui":
      return openUi(home);
    case "bridge": {
      // For the Claude desktop app: a local stdio MCP server relaying to the service on the LAN.
      const url = flags.get("url");
      const key = flags.get("key") ?? process.env.MAIL_ROUTER_KEY;
      if (typeof key !== "string" || !key) throw new Error("bridge: manca la chiave (variabile MAIL_ROUTER_KEY o --key)");
      return runBridge(typeof url === "string" ? url : "http://127.0.0.1:8787/mcp", key);
    }
    case "ui-helper": {
      const out = flags.get("out");
      if (typeof out !== "string") throw new Error("ui-helper: manca --out");
      log.attachDirectory(home);
      return runUiHelper(home, out);
    }
    case "setup":
      return flags.has("terminale") ? runSetup(home) : openUi(home);
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
    case "install": {
      const firewall = flags.get("firewall");
      const steps = await installService({
        home,
        firewallRemote: typeof firewall === "string" ? firewall.split(",").map((value) => value.trim()) : ["LocalSubnet"],
      });
      for (const step of steps) console.log(`✓ ${step}`);
      console.log("Attendo che il servizio risponda…");
      await printStatus(home, 45_000);
      return;
    }
    case "uninstall": {
      for (const step of uninstallService({ removeProgram: flags.has("remove-program") })) console.log(`✓ ${step}`);
      console.log(`I dati (configurazione, regole, storico) restano in ${home}`);
      return;
    }
    case "status":
      return printStatus(home);
    case "token": {
      if (process.platform === "win32") assertAdmin();
      const config = loadConfig(home);
      const store = new Store(path.join(home, DB_FILE));
      const token = rotateToken(store);
      store.close();
      console.log(connectInstructions(token, config.mcp));
      console.log("\nIl token precedente non è più valido: aggiorna la connessione in Claude.");
      return;
    }
    case "encrypt":
      console.log(promptProtectedSecret("Password da cifrare"));
      return;
    case "version":
      console.log(VERSION);
      return;
    default:
      console.log(HELP);
  }
}

async function printStatus(home: string, waitMs = 0): Promise<void> {
  const config = loadConfig(home);
  const scheme = config.mcp.tls ? "https" : "http";
  const host = config.mcp.host === "0.0.0.0" || config.mcp.host === "::" ? "127.0.0.1" : config.mcp.host;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const response = await fetch(`${scheme}://${host}:${config.mcp.port}/health`, {
        signal: AbortSignal.timeout(5000),
        ...(config.mcp.tls ? { tls: { rejectUnauthorized: false } } : {}),
      });
      const health = (await response.json()) as { version: string; mode: string };
      console.log(`Il servizio risponde: versione ${health.version}, modalità ${health.mode.toUpperCase()}`);
      return;
    } catch {
      if (Date.now() < deadline) {
        await Bun.sleep(1500);
        continue;
      }
      console.log(`Il servizio non risponde sulla porta ${config.mcp.port}. Log: ${path.join(home, "logs")}`);
      process.exitCode = 1;
      return;
    }
  }
}

main().then(
  () => undefined,
  (error) => {
    reportFailure("comando", error, error instanceof ConfigError || error instanceof UserFacingError);
    process.exit(1);
  },
);
