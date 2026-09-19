<#
 Menghapus autostart yang dipasang scripts\install-autostart.ps1:
 menghentikan broker/logger/web, menghapus task Task Scheduler, dan menghapus
 aturan firewall-nya. Data (logs, state.json, excel) TIDAK dihapus.

 CARA PAKAI (PowerShell "Run as administrator", dari folder project):
     powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1
#>
$ErrorActionPreference = 'Stop'
$TaskName = 'Monitoring Gearbox Karawang'
$Root = Split-Path -Parent $PSScriptRoot

$principalNow = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principalNow.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Jalankan PowerShell sebagai Administrator (klik kanan > Run as administrator).' -ForegroundColor Red
    exit 1
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Task '$TaskName' dihapus." -ForegroundColor Green
} else {
    Write-Host "Task '$TaskName' memang tidak terdaftar."
}

# Stop-ScheduledTask cuma mematikan run-all.js; matikan juga broker/logger/web-nya
$lock = Join-Path $Root 'run-all.lock'
if (Test-Path $lock) {
    $runAllPid = Get-Content $lock
    taskkill /PID $runAllPid /T /F 2>$null | Out-Null
}
$childrenFile = Join-Path $Root 'run-all.children.json'
if (Test-Path $childrenFile) {
    foreach ($childPid in (Get-Content $childrenFile | ConvertFrom-Json)) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$childPid" -ErrorAction SilentlyContinue
        if ($proc -and $proc.CommandLine -match 'mosquitto\.exe|mqtt_logger\.js|server\.js') {
            taskkill /PID $childPid /T /F 2>$null | Out-Null
        }
    }
}
Remove-Item $lock, $childrenFile, (Join-Path $Root 'logger.lock') -ErrorAction SilentlyContinue

Get-NetFirewallRule -DisplayName 'Monitoring Gearbox - *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host 'Aturan firewall Monitoring Gearbox dihapus.' -ForegroundColor Green
