/**
 * Windows integration: the service runs as a Task Scheduler task under SYSTEM,
 * started at boot, restarted by Task Scheduler if the supervisor itself dies.
 * A plain executable cannot talk to the Service Control Manager, and a task
 * needs no third-party wrapper. PowerShell receives every value through
 * environment variables, so nothing has to be quoted into a command line.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { APP_NAME, loadConfig } from "../config";
import { runPowerShell } from "../powershell";

export const TASK_NAME = APP_NAME;
const FIREWALL_RULE = `${APP_NAME} MCP`;
const EXE_NAME = "mail-router.exe";

function powershell(script: string, env: Record<string, string> = {}) {
  return runPowerShell(script, env);
}

function must(result: { ok: boolean; out: string; err: string }, what: string): string {
  if (!result.ok) throw new Error(`${what}: ${result.err || result.out || "errore sconosciuto"}`);
  return result.out;
}

export function assertWindows(): void {
  if (process.platform !== "win32") throw new Error("Questo comando funziona solo su Windows");
}

export function isAdmin(): boolean {
  const result = powershell(
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  );
  return result.ok && result.out.toLowerCase() === "true";
}

export function assertAdmin(): void {
  if (!isAdmin()) {
    throw new Error("Serve un prompt dei comandi aperto come amministratore (tasto destro → Esegui come amministratore)");
  }
}

export function installDir(): string {
  return path.join(process.env.ProgramFiles ?? "C:\\Program Files", APP_NAME);
}

function stopRunning(): void {
  powershell(
    `
    Stop-ScheduledTask -TaskName $env:MR_TASK -ErrorAction SilentlyContinue
    Get-Process -Name 'mail-router' -ErrorAction SilentlyContinue |
      Where-Object { $_.Id -ne [int]$env:MR_SELF } |
      Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    `,
    { MR_TASK: TASK_NAME, MR_SELF: String(process.pid) },
  );
}

/** Only SYSTEM and Administrators may read the data folder (config, database, logs). */
export function restrictDataFolder(home: string): void {
  // icacls /inheritance:r on a shared folder would lock everybody else out of it.
  const resolved = path.resolve(home);
  const shared = [path.parse(resolved).root, process.env.ProgramData, process.env.ProgramFiles, process.env.SystemRoot, process.env.USERPROFILE, process.env.PUBLIC]
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => path.resolve(entry).toLowerCase());
  if (shared.includes(resolved.toLowerCase()) || path.basename(resolved).toLowerCase() === "users") {
    throw new Error(`${resolved} non è una cartella dedicata: usa una cartella solo per Mail Router (--home)`);
  }
  mkdirSync(home, { recursive: true });
  const result = Bun.spawnSync(
    [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), home, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "/T", "/Q"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`icacls non riuscito: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`);
  }
}

export interface InstallOptions {
  home: string;
  /** Firewall RemoteAddress values, e.g. LocalSubnet or 192.168.1.0/24. */
  firewallRemote: string[];
}

export async function installService(options: InstallOptions): Promise<string[]> {
  assertWindows();
  assertAdmin();
  const config = loadConfig(options.home);
  const steps: string[] = [];

  stopRunning();
  const dir = installDir();
  const exe = path.join(dir, EXE_NAME);
  mkdirSync(dir, { recursive: true });
  if (path.resolve(process.execPath).toLowerCase() !== path.resolve(exe).toLowerCase()) {
    copyFileSync(process.execPath, exe);
    steps.push(`programma copiato in ${exe}`);
  }

  restrictDataFolder(options.home);
  steps.push(`cartella dati ${options.home} accessibile solo a SYSTEM e Administrators`);

  must(
    powershell(
      `
      $ErrorActionPreference = 'Stop'
      $arguments = 'run --home "' + $env:MR_HOME + '"'
      $action = New-ScheduledTaskAction -Execute $env:MR_EXE -Argument $arguments -WorkingDirectory $env:MR_DIR
      $trigger = New-ScheduledTaskTrigger -AtStartup
      $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable \`
        -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
      Register-ScheduledTask -TaskName $env:MR_TASK -Description 'Mail Router: inoltro automatico della posta e server MCP' \`
        -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
      `,
      { MR_EXE: exe, MR_DIR: dir, MR_HOME: options.home, MR_TASK: TASK_NAME },
    ),
    "registrazione dell'attività pianificata",
  );
  steps.push(`attività pianificata "${TASK_NAME}" (all'avvio di Windows, utente SYSTEM, riavvio automatico)`);

  must(
    powershell(
      `
      $ErrorActionPreference = 'Stop'
      Remove-NetFirewallRule -DisplayName $env:MR_RULE -ErrorAction SilentlyContinue
      New-NetFirewallRule -DisplayName $env:MR_RULE -Direction Inbound -Action Allow -Protocol TCP \`
        -LocalPort ([int]$env:MR_PORT) -RemoteAddress ($env:MR_REMOTE -split ',') -Program $env:MR_EXE | Out-Null
      `,
      {
        MR_RULE: FIREWALL_RULE,
        MR_PORT: String(config.mcp.port),
        MR_REMOTE: options.firewallRemote.join(","),
        MR_EXE: exe,
      },
    ),
    "regola del firewall",
  );
  steps.push(`firewall: porta TCP ${config.mcp.port} aperta per ${options.firewallRemote.join(", ")}`);

  createShortcuts(exe, dir);
  steps.push("collegamenti «Mail Router» sul Desktop e nel menu Start");

  must(powershell("Start-ScheduledTask -TaskName $env:MR_TASK", { MR_TASK: TASK_NAME }), "avvio del servizio");
  steps.push("servizio avviato");
  return steps;
}

const SHORTCUT_FOLDERS = "@([Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('CommonPrograms'))";

/** Desktop and Start menu shortcuts for every user; minimized, since the launcher console only flashes. */
function createShortcuts(exe: string, dir: string): void {
  powershell(
    `
    $shell = New-Object -ComObject WScript.Shell
    foreach ($folder in ${SHORTCUT_FOLDERS}) {
      if (-not $folder) { continue }
      $link = $shell.CreateShortcut((Join-Path $folder 'Mail Router.lnk'))
      $link.TargetPath = $env:MR_EXE
      $link.WorkingDirectory = $env:MR_DIR
      $link.WindowStyle = 7
      $link.Description = 'Mail Router: inoltro automatico della posta'
      $link.Save()
    }
    `,
    { MR_EXE: exe, MR_DIR: dir },
  );
}

function removeShortcuts(): void {
  powershell(`
    foreach ($folder in ${SHORTCUT_FOLDERS}) {
      if ($folder) { Remove-Item -LiteralPath (Join-Path $folder 'Mail Router.lnk') -ErrorAction SilentlyContinue }
    }
  `);
}

export function serviceTaskExists(): boolean {
  const result = powershell("if (Get-ScheduledTask -TaskName $env:MR_TASK -ErrorAction SilentlyContinue) { 'yes' }", {
    MR_TASK: TASK_NAME,
  });
  return result.out === "yes";
}

export function startServiceTask(): void {
  must(powershell("Start-ScheduledTask -TaskName $env:MR_TASK", { MR_TASK: TASK_NAME }), "avvio del servizio");
}

/**
 * Starts this program again with administrator rights (UAC prompt).
 * The argument line is passed verbatim: quote paths yourself. Returns false when the user says no.
 */
export function relaunchElevated(argumentLine: string): boolean {
  const result = powershell(
    "Start-Process -FilePath $env:MR_EXE -ArgumentList $env:MR_ARGS -Verb RunAs -WindowStyle Hidden",
    { MR_EXE: process.execPath, MR_ARGS: argumentLine },
  );
  return result.ok;
}

/** Opens the panel in an app-style Edge window (no tabs or address bar), or the default browser. */
export function openAppWindow(url: string): void {
  powershell(
    `
    try {
      Start-Process -FilePath 'msedge.exe' -ArgumentList @(('--app=' + $env:MR_URL), '--window-size=1280,860') -ErrorAction Stop
    } catch {
      Start-Process $env:MR_URL
    }
    `,
    { MR_URL: url },
  );
}

/**
 * From an elevated process a browser would run elevated too: explorer.exe hands
 * the URL to the user's normal session instead.
 */
export function openFromElevated(url: string): void {
  Bun.spawn([path.join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe"), url], { stdout: "ignore", stderr: "ignore" });
}

export function uninstallService(options: { removeProgram: boolean }): string[] {
  assertWindows();
  assertAdmin();
  const steps: string[] = [];
  stopRunning();
  powershell("Unregister-ScheduledTask -TaskName $env:MR_TASK -Confirm:$false -ErrorAction SilentlyContinue", {
    MR_TASK: TASK_NAME,
  });
  steps.push(`attività pianificata "${TASK_NAME}" rimossa`);
  powershell("Remove-NetFirewallRule -DisplayName $env:MR_RULE -ErrorAction SilentlyContinue", { MR_RULE: FIREWALL_RULE });
  steps.push("regola del firewall rimossa");
  removeShortcuts();
  steps.push("collegamenti rimossi");
  if (options.removeProgram) {
    const dir = installDir();
    const running = path.resolve(process.execPath).toLowerCase().startsWith(path.resolve(dir).toLowerCase());
    if (running) {
      steps.push(`il programma in ${dir} è quello in esecuzione: eliminalo a mano dopo l'uscita`);
    } else if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      steps.push(`${dir} eliminata`);
    }
  }
  return steps;
}
