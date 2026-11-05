# Updates an installed Mail Router in place and keeps the firewall rule as it is:
# a bare "mail-router install" resets it to LocalSubnet, which locks out panels
# and Claude on other subnets. The service stops for a few seconds.
#
# Put this script next to the new mail-router.exe and run it as administrator:
#   powershell -NoProfile -ExecutionPolicy Bypass -File update-windows.ps1

$ErrorActionPreference = 'Stop'

$new = Join-Path $PSScriptRoot 'mail-router.exe'
$installed = Join-Path $env:ProgramFiles 'MailRouter\mail-router.exe'
$ruleName = 'MailRouter MCP'
$taskName = 'MailRouter'
$logs = Join-Path $env:ProgramData 'MailRouter\logs'

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this as administrator. Nothing was changed.'
}
foreach ($file in @($new, $installed)) {
  if (-not (Test-Path -LiteralPath $file)) { throw "Not found: $file. Nothing was changed." }
}

$rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if (-not $rule) { throw "Firewall rule '$ruleName' not found. Nothing was changed." }
$remote = @(($rule | Get-NetFirewallAddressFilter).RemoteAddress) -join ','
$port = ($rule | Get-NetFirewallPortFilter).LocalPort

# Before touching the service: the new program must at least start on this PC.
$newVersion = (& $new version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $newVersion) { throw 'The new mail-router.exe does not start on this PC. Nothing was changed.' }
$oldVersion = (& $installed version | Out-String).Trim()

$backup = Join-Path $PSScriptRoot "mail-router-backup-$oldVersion.exe"
Copy-Item -LiteralPath $installed -Destination $backup -Force
Write-Output "Installed: $oldVersion. New: $newVersion. Firewall stays: $remote (port $port)."
Write-Output "Backup of the current program: $backup"

& $new install --firewall $remote

$health = $null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3 } catch { $health = $null }
  if ($health -and $health.version -eq $newVersion) { break }
  Start-Sleep -Seconds 2
}

if ($health -and $health.version -eq $newVersion) {
  Write-Output "OK: the service answers with version $($health.version), mode $($health.mode)."
  exit 0
}

Write-Output "FAILED: the service does not answer with version $newVersion."
try { Get-ScheduledTaskInfo -TaskName $taskName | Format-List LastRunTime, LastTaskResult | Out-String | Write-Output } catch { Write-Output "Task info unavailable: $_" }
try {
  Get-ChildItem -LiteralPath $logs -Filter 'mail-router-*.log' | Sort-Object LastWriteTime | Select-Object -Last 1 | Get-Content -Tail 20 | Write-Output
} catch { Write-Output "Logs unavailable: $_" }
Write-Output 'To go back to the previous version, run as administrator:'
Write-Output "  & '$backup' install --firewall $remote"
exit 1
