/**
 * Moving an existing Windows installation into the container.
 *
 *   export-docker (on the old Windows PC, as administrator): decrypts the DPAPI
 *   passwords, re-encrypts them with the container's master key and takes a
 *   consistent copy of the database into a folder.
 *   import (inside the container): copies that folder into the data volume,
 *   after checking that the master key opens every password.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CONFIG_FILE, configPath, DB_FILE, loadConfig, type Config } from "./config";
import { encryptWithKey, generateMasterKey, isDpapiSecret, MASTER_KEY_ENV, masterKey, resolveSecret } from "./secrets";
import { UserFacingError } from "./errors";

/** The port the container listens on; docker compose publishes it. */
export const CONTAINER_PORT = 8787;

async function serviceAnswers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

function keyFrom(text: string): Buffer {
  const previous = process.env[MASTER_KEY_ENV];
  process.env[MASTER_KEY_ENV] = text;
  try {
    return masterKey()!;
  } finally {
    if (previous === undefined) delete process.env[MASTER_KEY_ENV];
    else process.env[MASTER_KEY_ENV] = previous;
  }
}

export async function exportForDocker(options: { home: string; out: string; key?: string; force?: boolean }): Promise<void> {
  const { home, out } = options;
  let config: Config;
  try {
    config = loadConfig(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
      throw new UserFacingError(`Non riesco a leggere ${home}: apri il terminale come amministratore e riprova.`);
    }
    throw error;
  }
  const dbFile = path.join(home, DB_FILE);
  if (!existsSync(dbFile)) throw new UserFacingError(`Database non trovato: ${dbFile}`);

  if (!options.force && (await serviceAnswers(config.mcp.port))) {
    throw new UserFacingError(
      "Il servizio Windows è ancora in funzione. Fermalo prima di esportare, altrimenti la posta arrivata nel frattempo " +
        "verrebbe smistata due volte (dal PC e dal container):\n" +
        '  "C:\\Program Files\\MailRouter\\mail-router.exe" uninstall\n' +
        "(i dati restano), poi rilancia questo comando.",
    );
  }

  if (existsSync(out) && readdirSync(out).length > 0) throw new UserFacingError(`La cartella ${out} esiste e non è vuota: scegline un'altra con --out`);
  mkdirSync(out, { recursive: true });

  const keyText = options.key ?? generateMasterKey();
  const key = keyFrom(keyText);
  const notes: string[] = [];

  const reencrypt = (value: string, label: string): string => {
    if (value.startsWith("env:")) {
      notes.push(`${label}: resta ${value}, imposta quella variabile anche nel container`);
      return value;
    }
    return encryptWithKey(resolveSecret(value, label), key);
  };

  const converted: Config = {
    ...config,
    accounts: config.accounts.map((account) => ({
      ...account,
      imap: { ...account.imap, password: reencrypt(account.imap.password, `${account.id}.imap.password`) },
      ...(account.smtp ? { smtp: { ...account.smtp, password: reencrypt(account.smtp.password, `${account.id}.smtp.password`) } } : {}),
    })),
    mcp: { ...config.mcp, host: "0.0.0.0", port: CONTAINER_PORT },
  };
  if (config.mcp.tls) {
    delete converted.mcp.tls;
    notes.push("TLS tolto: i certificati erano file di questo PC; nel container metti davanti un reverse proxy https");
  }
  if (config.mcp.port !== CONTAINER_PORT) notes.push(`la porta era ${config.mcp.port}: nel container è ${CONTAINER_PORT}, pubblicala come preferisci nel compose`);

  writeFileSync(path.join(out, CONFIG_FILE), `${JSON.stringify(converted, null, 2)}\n`);
  // VACUUM INTO gives a consistent single-file copy, WAL included.
  const db = new Database(dbFile, { readonly: true });
  try {
    db.run(`VACUUM INTO '${path.join(out, DB_FILE).replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }

  console.log(`✓ esportati configurazione e database in ${out}`);
  for (const note of notes) console.log(`  ! ${note}`);
  console.log("");
  if (!options.key) {
    console.log("Chiave master del container (mettila nel file .env accanto a compose.yaml; non perderla):");
    console.log(`  ${MASTER_KEY_ENV}=${keyText}`);
    console.log("");
  }
  console.log("Sul server Docker, con la cartella copiata accanto a compose.yaml:");
  console.log(`  docker compose run --rm -v ./${path.basename(out)}:/import:ro mail-router import /import`);
  console.log("  docker compose up -d");
}

/** Copies an export into the data folder (an empty volume) after checking that every password opens. */
export function importExport(source: string, home: string, options: { force?: boolean } = {}): void {
  const sourceConfig = path.join(source, CONFIG_FILE);
  const sourceDb = path.join(source, DB_FILE);
  if (!existsSync(sourceConfig) || !existsSync(sourceDb)) {
    throw new UserFacingError(`In ${source} servono ${CONFIG_FILE} e ${DB_FILE} (prodotti da «mail-router export-docker»)`);
  }
  if (existsSync(configPath(home)) && !options.force) {
    throw new UserFacingError(`${home} contiene già una configurazione: non la sovrascrivo (usa --force se sei sicuro)`);
  }
  const config = loadConfig(source);
  for (const account of config.accounts) {
    for (const [label, value] of [
      [`${account.id}.imap.password`, account.imap.password],
      [`${account.id}.smtp.password`, account.smtp?.password],
    ] as const) {
      if (!value) continue;
      if (isDpapiSecret(value)) throw new UserFacingError(`${label} è ancora cifrata con DPAPI: rifai l'esportazione con «mail-router export-docker»`);
      resolveSecret(value, label); // throws when the master key is not the one used for the export
    }
  }
  mkdirSync(home, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path.join(home, DB_FILE + suffix), { force: true });
  copyFileSync(sourceDb, path.join(home, DB_FILE));
  copyFileSync(sourceConfig, configPath(home));
  console.log(`✓ importati configurazione e database in ${home}`);
  console.log("Avvia il servizio con: docker compose up -d");
}
