<#
  Atmosphere Ghost Node — WINDOWS Installer (PowerShell)
  ------------------------------------------------------
  Joins the sovereign Atmosphere mesh over the public Hyperswarm DHT via NAT hole-punching:
  NO inbound port is opened, NO public internet surface is exposed. The node runs a compute
  skill ONLY if its post-quantum seal (ML-DSA-65 + Ed25519) verifies against the pinned
  origin key baked into config.json.

  This installer is Windows-only by design (separate macOS / Linux installers exist). It
  registers a private "secret command" you can run anytime to connect.

  Usage (from this folder):
     powershell -ExecutionPolicy Bypass -File .\install-windows.ps1            # default command name: atmos
     powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -Name myhandle
#>
param([string]$Name = "atmos")

$ErrorActionPreference = "Stop"
if (-not $IsWindows -and $env:OS -notmatch "Windows") {
  Write-Host "X  This is the WINDOWS installer. Use install-macos.sh / install-linux.sh on other systems." -ForegroundColor Red
  exit 1
}

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeExe = Join-Path $Here "node.exe"
$Entry   = Join-Path $Here "atmos-ghost.mjs"
if (-not (Test-Path $NodeExe)) { Write-Host "X  node.exe missing from bundle — re-extract the full zip." -ForegroundColor Red; exit 1 }

Write-Host "👻 Atmosphere Ghost Node — Windows" -ForegroundColor Cyan
Write-Host "   install dir : $Here"
Write-Host "   runtime     : bundled node.exe (no system Node required)"

# Register the private 'secret command' as a function in the PowerShell profile.
$invocation = "& `"$NodeExe`" `"$Entry`" @args"
$marker = "# >>> atmosphere-ghost ($Name) >>>"
$block  = @"
$marker
function $Name { $invocation }
# <<< atmosphere-ghost ($Name) <<<
"@

if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
$current = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
if ($current -match [regex]::Escape($marker)) {
  $current = [regex]::Replace($current, "(?s)$([regex]::Escape($marker)).*?# <<< atmosphere-ghost \($Name\) <<<", $block.TrimEnd())
  Set-Content -Path $PROFILE -Value $current
} else {
  Add-Content -Path $PROFILE -Value "`n$block"
}

Write-Host ""
Write-Host "✅ Installed. Your private command is:  $Name" -ForegroundColor Green
Write-Host "   Open a NEW PowerShell window, then run:" -ForegroundColor Green
Write-Host "       $Name              # join the mesh and stand by for verified skills"
Write-Host "       $Name --once       # run one verified skill and exit (proof mode)"
Write-Host ""
Write-Host "   (Running right now from this window:)" -ForegroundColor DarkGray
& $NodeExe $Entry --once
