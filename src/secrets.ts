/**
 * Mailbox passwords never sit in config.json in clear text on Windows: `setup`
 * stores them as `dpapi:<base64>`, encrypted with DPAPI in LocalMachine scope
 * so the service (running as SYSTEM) can decrypt them while a copy of the file
 * taken to another machine is useless. PowerShell does the DPAPI work because
 * it ships with every Windows install; the secret travels through environment
 * variables and stdout pipes, never through a command line.
 */

import { runPowerShell } from "./powershell";

const DPAPI_PREFIX = "dpapi:";
const ENV_PREFIX = "env:";
const PLAIN_PREFIX = "plain:";

const PROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$bytes = [Text.Encoding]::UTF8.GetBytes($env:MAIL_ROUTER_SECRET)
$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'LocalMachine')
[Convert]::ToBase64String($enc)
`;

const UNPROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$enc = [Convert]::FromBase64String($env:MAIL_ROUTER_SECRET)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'LocalMachine')
[Console]::Out.Write([Convert]::ToBase64String($bytes))
`;

/** Reads a password from the console without echo and returns it DPAPI-protected. */
const PROMPT_PROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$secure = Read-Host -AsSecureString $env:MAIL_ROUTER_PROMPT
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if ([string]::IsNullOrEmpty($plain)) { exit 3 }
$enc = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), $null, 'LocalMachine')
[Console]::Out.Write([Convert]::ToBase64String($enc))
`;

function powershell(script: string, env: Record<string, string>, interactive = false): string {
  const result = runPowerShell(script, env, { interactive });
  if (!result.ok) {
    if (interactive && result.exitCode === 3) throw new Error("Password vuota");
    throw new Error(`PowerShell non riuscito: ${result.err || result.out || `codice ${result.exitCode}`}`);
  }
  return result.out;
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function protectSecret(plain: string): string {
  if (!isWindows()) return `${PLAIN_PREFIX}${plain}`;
  return DPAPI_PREFIX + powershell(PROTECT_SCRIPT, { MAIL_ROUTER_SECRET: plain });
}

/**
 * Asks for a password on the console. On Windows the value never reaches this
 * process in clear text: PowerShell reads it hidden and returns it encrypted.
 */
export function promptProtectedSecret(label: string): string {
  if (isWindows()) {
    return DPAPI_PREFIX + powershell(PROMPT_PROTECT_SCRIPT, { MAIL_ROUTER_PROMPT: label }, true);
  }
  const value = prompt(`${label} (visibile: solo per sviluppo fuori da Windows):`);
  if (!value) throw new Error("Password vuota");
  return `${PLAIN_PREFIX}${value}`;
}

export function resolveSecret(value: string, label: string): string {
  if (value.startsWith(DPAPI_PREFIX)) {
    if (!isWindows()) throw new Error(`${label}: un segreto dpapi: si decifra solo sul PC Windows che l'ha creato`);
    const base64 = powershell(UNPROTECT_SCRIPT, { MAIL_ROUTER_SECRET: value.slice(DPAPI_PREFIX.length) });
    return Buffer.from(base64, "base64").toString("utf8");
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
