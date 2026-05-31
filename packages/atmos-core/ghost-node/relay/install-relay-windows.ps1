<#
  Atmosphere KEYLESS RELAY — WINDOWS Installer
  Makes this machine a BACKUP MESH COORDINATOR. It holds NO private key — it re-broadcasts the
  pre-signed membership skill, onboards nodes, and dispatches jobs only if elected leader (i.e.
  when the primary/VPS is down). Self-installs locally + auto-starts every logon.
  Usage:  powershell -ExecutionPolicy Bypass -File .\install-relay-windows.ps1 [-NoAutoStart]
#>
param([switch]$NoAutoStart)
$ErrorActionPreference = "Stop"
if (-not $IsWindows -and $env:OS -notmatch "Windows") { Write-Host "X Windows installer only." -ForegroundColor Red; exit 1 }

$Src = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dir = Join-Path $env:LOCALAPPDATA "AtmosphereRelay"
$NodeExe = Join-Path $Dir "node.exe"
$Entry   = Join-Path $Dir "packages\atmos-core\mesh-demo.mjs"
if (-not (Test-Path (Join-Path $Src "node.exe"))) { Write-Host "X node.exe missing — re-extract the zip." -ForegroundColor Red; exit 1 }

Write-Host "🛰️  Atmosphere Keyless Relay — Windows (backup coordinator)" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Copy-Item -Path (Join-Path $Src "*") -Destination $Dir -Recurse -Force -Exclude @("install-relay-windows.ps1","install-relay-unix.sh")
Write-Host "   installed to : $Dir"

$relayArgs = "`"$Entry`" broadcast --topic-file `"$Dir\mesh-topic.txt`" --signed-skill `"$Dir\signed-skill.wasm`" --relay-id $env:COMPUTERNAME --job-interval 15 --job-max 40"
if (-not $NoAutoStart) {
  $action  = New-ScheduledTaskAction -Execute $NodeExe -Argument $relayArgs -WorkingDirectory $Dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
  try {
    Register-ScheduledTask -TaskName "AtmosphereRelay" -Action $action -Trigger $trigger -Settings $set -Force -RunLevel Limited | Out-Null
    Start-ScheduledTask -TaskName "AtmosphereRelay"
    Write-Host "   auto-start    : enabled (Scheduled Task 'AtmosphereRelay', running now + every logon)" -ForegroundColor Green
  } catch { Write-Host "   auto-start    : task registration failed ($($_.Exception.Message))" -ForegroundColor Yellow }
} else { Write-Host "   auto-start    : skipped" -ForegroundColor DarkGray }
Write-Host "`n✅ This machine is now a backup Atmosphere mesh coordinator (relay-id: $env:COMPUTERNAME)." -ForegroundColor Green
Write-Host "   Run manually: double-click run-relay.cmd"
