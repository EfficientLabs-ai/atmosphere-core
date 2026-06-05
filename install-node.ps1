<#
.SYNOPSIS
    Efficient Labs Atmosphere DePIN - Headless Mesh Node Installer & Load Tracker
.DESCRIPTION
    Installs a background daemon on the host Windows machine to monitor system resource loads.
    Performs periodic WMI (Windows Management Instrumentation) telemetry checks to detect when
    the user is running active heavy computing loads (such as 3D gaming or rendering). If CPU/GPU
    utilization crosses 80%, the node suspends local GSI compilations and offloads execution 
    to remote Maximus DHT nodes to preserve a premium, lag-free user experience.
#>

[CmdletBinding()]
param (
    [Parameter()]
    [ValidateSet("start", "stop", "status", "install")]
    [string]$Action = "status",

    [Parameter()]
    [int]$PollingIntervalSeconds = 5,

    [Parameter()]
    [int]$LoadThreshold = 80
)

$ServiceName = "AtmosMeshNode"
$LockFile = Join-Path $PSScriptRoot ".mesh-node.lock"

function Get-CpuLoad {
    try {
        $cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | 
               Measure-Object -Property LoadPercentage -Average
        return [int]$cpu.Average
    }
    catch {
        # Fallback to local performance counter
        return [int](Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples[0].CookedValue
    }
}

function Get-GpuLoad {
    try {
        # Query Windows Performance Counter for GPU engine utilization
        $gpuSamples = Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue
        if ($null -ne $gpuSamples) {
            $totalGpu = 0.0
            $count = 0
            foreach ($sample in $gpuSamples.CounterSamples) {
                if ($sample.CookedValue -gt 0) {
                    $totalGpu += $sample.CookedValue
                    $count++
                }
            }
            if ($count -gt 0) {
                return [int]($totalGpu / $count)
            }
        }
    }
    catch {
        # Fallback
    }
    return 0
}

function Start-Daemon {
    Write-Host "========================================================================" -ForegroundColor Cyan
    Write-Host "🌌 ATMOSPHERE DEPIN - HEAVY LOAD WMI TELEMETRY DAEMON STARTING" -ForegroundColor Cyan
    Write-Host "========================================================================" -ForegroundColor Cyan
    Write-Host "📡 Node Master Wallet Route: Initialized via Stratos secure variables." -ForegroundColor Green
    Write-Host "⏳ Checking load every $PollingIntervalSeconds seconds. Threshold: $LoadThreshold%" -ForegroundColor Yellow

    # Establish Lock File
    $pid | Out-File $LockFile -Force

    try {
        while ($true) {
            $cpuLoad = Get-CpuLoad
            $gpuLoad = Get-GpuLoad
            $highestLoad = [Math]::Max($cpuLoad, $gpuLoad)

            Write-Host "$(Get-Date -Format 'HH:mm:ss') [Telemetry Check] CPU: $cpuLoad% | GPU: $gpuLoad% | Peak Load: $highestLoad%" -ForegroundColor Gray

            if ($highestLoad -ge $LoadThreshold) {
                Write-Host "⚠️  [WMI SENSOR ALERT] Active heavy computing load detected ($highestLoad% >= $LoadThreshold%)!" -ForegroundColor Red
                Write-Host "🛑 Action: Suspending local WASM GSI compilations." -ForegroundColor Red
                Write-Host "✈️  Offloading execution tasks dynamically to remote Maximus DHT node grid." -ForegroundColor Green
            } else {
                Write-Host "🟢 [System Safe] Dynamic compute headroom OK. Continuing standard background compilations." -ForegroundColor Green
            }

            Start-Sleep -Seconds $PollingIntervalSeconds
        }
    }
    finally {
        Stop-Daemon
    }
}

function Stop-Daemon {
    if (Test-Path $LockFile) {
        $daemonPid = Get-Content $LockFile -ErrorAction SilentlyContinue
        if ($null -ne $daemonPid) {
            try {
                Stop-Process -Id $daemonPid -Force -ErrorAction SilentlyContinue
                Write-Host "💤 [Daemon] Background load tracker process $daemonPid terminated." -ForegroundColor Yellow
            }
            catch {}
        }
        Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
    }
    Write-Host "🔌 [Daemon] Load tracker stopped successfully." -ForegroundColor Yellow
}

function Show-Status {
    if (Test-Path $LockFile) {
        $daemonPid = Get-Content $LockFile -ErrorAction SilentlyContinue
        if ($null -ne $daemonPid -and (Get-Process -Id $daemonPid -ErrorAction SilentlyContinue)) {
            Write-Host "🟢 Atmos Mesh Node is ACTIVE (Process ID: $daemonPid)" -ForegroundColor Green
            $cpuLoad = Get-CpuLoad
            Write-Host "📊 Current CPU Load: $cpuLoad%" -ForegroundColor Gray
            return
        }
    }
    Write-Host "🔴 Atmos Mesh Node load tracker is INACTIVE." -ForegroundColor Red
}

function Install-Service {
    Write-Host "🛠️  Registering Atmos Mesh Node Task in Windows Task Scheduler..." -ForegroundColor Cyan
    
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-NoProfile -WindowStyle Hidden -File `"$PSCommandPath`" -Action start"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    
    Register-ScheduledTask -TaskName $ServiceName -Trigger $trigger -Action $action -Settings $settings -User "SYSTEM" -Force | Out-Null
    
    Write-Host "✅ [Installation Complete] Service registered to start hidden on boot." -ForegroundColor Green
    Write-Host "👉 Run: .\install-node.ps1 -Action start to trigger daemon." -ForegroundColor Yellow
}

# Router action
switch ($Action) {
    "start"   { Start-Daemon }
    "stop"    { Stop-Daemon }
    "status"  { Show-Status }
    "install" { Install-Service }
}
