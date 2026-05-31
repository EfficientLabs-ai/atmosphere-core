<#
  Atmosphere Ghost Node — WINDOWS Installer (PowerShell)
  ------------------------------------------------------
  Production install: copies the node to a stable local folder (so you can remove the USB),
  registers a private "secret command", and OPTIONALLY auto-starts it on every logon so the
  machine permanently rejoins the Atmosphere mesh.

  The node joins the fleet's PRIVATE topic over the public Hyperswarm DHT via NAT hole-punch
  (no inbound port) and runs a skill ONLY if its ML-DSA-65 + Ed25519 seal verifies against the
  pinned origin key in config.json. Windows-only by design (separate macOS / Linux installers).

  Usage (from the unzipped folder, e.g. on a USB):
     powershell -ExecutionPolicy Bypass -File .\install-windows.ps1                 # name 'atmos', + auto-start
     powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Name myname -NoAutoStart
#>
param([string]$Name = "atmos", [switch]$NoAutoStart)

$ErrorActionPreference = "Stop"
if (-not $IsWindows -and $env:OS -notmatch "Windows") {
  Write-Host "X  This is the WINDOWS installer. Use install-unix.sh on macOS / Linux." -ForegroundColor Red; exit 1
}

$Src     = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $env:LOCALAPPDATA "AtmosphereGhost"
$NodeExe = Join-Path $InstallDir "node.exe"
$Entry   = Join-Path $InstallDir "atmos-ghost.mjs"

Write-Host "👻 Atmosphere Ghost Node — Windows (production install)" -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $Src "node.exe"))) { Write-Host "X  node.exe missing — re-extract the full zip." -ForegroundColor Red; exit 1 }

# 1. Copy the node to a stable local dir so the USB can be removed.
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $Src "*") -Destination $InstallDir -Recurse -Force -Exclude @("install-windows.ps1","install-unix.sh")
Write-Host "   installed to : $InstallDir"

# 2. Register the private 'secret command' in the PowerShell profile.
$marker = "# >>> atmosphere-ghost ($Name) >>>"
$block  = "$marker`nfunction $Name { & `"$NodeExe`" `"$Entry`" @args }`n# <<< atmosphere-ghost ($Name) <<<"
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
$cur = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
if ($cur -match [regex]::Escape($marker)) {
  Set-Content -Path $PROFILE -Value ([regex]::Replace($cur, "(?s)$([regex]::Escape($marker)).*?# <<< atmosphere-ghost \($Name\) <<<", $block))
} else { Add-Content -Path $PROFILE -Value "`n$block" }
Write-Host "   secret command: $Name" -ForegroundColor Green

# 3. Auto-start on every logon (daemon mode — stays connected), via a hidden Scheduled Task.
if (-not $NoAutoStart) {
  $taskName = "AtmosphereGhost"
  $action  = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$Entry`"" -WorkingDirectory $InstallDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden
  try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $set -Force -RunLevel Limited | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Host "   auto-start    : enabled (Scheduled Task '$taskName', running now + every logon)" -ForegroundColor Green
  } catch { Write-Host "   auto-start    : could not register task ($($_.Exception.Message)) — secret command still works." -ForegroundColor Yellow }
} else { Write-Host "   auto-start    : skipped (-NoAutoStart)" -ForegroundColor DarkGray }

Write-Host "`n✅ Done. This machine is a permanent Atmosphere mesh node." -ForegroundColor Green
Write-Host "   Verify once now:  $Name --once"
