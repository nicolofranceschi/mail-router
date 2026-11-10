/**
 * Mailbox passwords in config.json are stored as `aes:<base64url>`: AES-256-GCM
 * with a master key that reaches the container from outside (environment
 * variable or Docker secret file) and is never written next to the data. A
 * copy of the data volume without the key is useless.
 *
 * Other accepted forms: `env:NAME` (read from the environment at start-up),
 * `plain:<value>` (development only) and `dpapi:<base64>`, the format of the
 * old Windows installation — decrypted only on that PC, by `export-docker`.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { runPowerShell } from "./powershell";

const AES_PREFIX = "aes:";
const DPAPI_PREFIX = "dpapi:";
const ENV_PREFIX = "env:";
const PLAIN_PREFIX = "plain:";

export const MASTER_KEY_ENV = "MAIL_ROUTER_MASTER_KEY";
export const MASTER_KEY_FILE_ENV = "MAIL_ROUTER_MASTER_KEY_FILE";
const MIN_KEY_LENGTH = 32;

export class MasterKeyError extends Error {}

/** A new master key to put in the container's environment. */
export function generateMasterKey(): string {
  return randomBytes(32).toString("base64url");
}

function keyFromText(text: string, source: string): Buffer {
  const trimmed = text.trim();
  if (trimmed.length < MIN_KEY_LENGTH) {
    throw new MasterKeyError(`${source}: la chiave master deve avere almeno ${MIN_KEY_LENGTH} caratteri (generane una con «mail-router genkey»)`);
  }
  return createHash("sha256").update(`mail-router/aes-256-gcm\0${trimmed}`).digest();
}

/** The configured master key, or null when none is set. */
export function masterKey(): Buffer | null {
  const file = process.env[MASTER_KEY_FILE_ENV];
  if (file) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      throw new MasterKeyError(`${MASTER_KEY_FILE_ENV}: impossibile leggere ${file} (${(error as Error).message})`);
    }
    return keyFromText(text, file);
  }
  const value = process.env[MASTER_KEY_ENV];
  return value ? keyFromText(value, MASTER_KEY_ENV) : null;
}

export function requireMasterKey(): Buffer {
  const key = masterKey();
  if (!key) {
    throw new MasterKeyError(
      `Chiave master mancante: imposta ${MASTER_KEY_ENV} (o ${MASTER_KEY_FILE_ENV} con un Docker secret). ` +
        "Ne generi una con «mail-router genkey»; conservala: senza, le password salvate non si decifrano.",
    );
  }
  return key;
}

export function encryptWithKey(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return AES_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

function decryptWithKey(value: string, key: Buffer, label: string): string {
  const raw = Buffer.from(value, "base64url");
  if (raw.length < 29) throw new Error(`${label}: segreto aes: non valido`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new MasterKeyError(`${label}: impossibile decifrare la password, la chiave master non è quella usata per cifrarla`);
  }
}

/** Encrypts a password typed in the panel. Without a master key only MAIL_ROUTER_ALLOW_PLAIN=1 (development) lets it through. */
export function protectSecret(plain: string): string {
  const key = masterKey();
  if (key) return encryptWithKey(plain, key);
  if (process.env.MAIL_ROUTER_ALLOW_PLAIN === "1") return `${PLAIN_PREFIX}${plain}`;
  return encryptWithKey(plain, requireMasterKey());
}

export function resolveSecret(value: string, label: string): string {
  if (value.startsWith(AES_PREFIX)) return decryptWithKey(value.slice(AES_PREFIX.length), requireMasterKey(), label);
  if (value.startsWith(DPAPI_PREFIX)) {
    if (process.platform !== "win32") {
      throw new Error(
        `${label}: la password è ancora nel formato dpapi: della vecchia installazione Windows. ` +
          "Esportala con «mail-router export-docker» su quel PC, oppure reinseriscila dal pannello.",
      );
    }
    return unprotectDpapi(value.slice(DPAPI_PREFIX.length));
  }
  if (value.startsWith(ENV_PREFIX)) {
    const name = value.slice(ENV_PREFIX.length);
    const resolved = process.env[name];
    if (!resolved) throw new Error(`${label}: variabile d'ambiente ${name} non impostata`);
    return resolved;
  }
  if (value.startsWith(PLAIN_PREFIX)) return value.slice(PLAIN_PREFIX.length);
  return value;
}

/** True for a value that only the old Windows installation can read. */
export function isDpapiSecret(value: string): boolean {
  return value.startsWith(DPAPI_PREFIX);
}

const UNPROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$enc = [Convert]::FromBase64String($env:MAIL_ROUTER_SECRET)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'LocalMachine')
[Console]::Out.Write([Convert]::ToBase64String($bytes))
`;

/** DPAPI (LocalMachine scope) through PowerShell; the secret travels in an environment variable, never on a command line. */
function unprotectDpapi(base64: string): string {
  const result = runPowerShell(UNPROTECT_SCRIPT, { MAIL_ROUTER_SECRET: base64 });
  if (!result.ok) throw new Error(`PowerShell non riuscito: ${result.err || result.out || `codice ${result.exitCode}`}`);
  return Buffer.from(result.out, "base64").toString("utf8");
}
