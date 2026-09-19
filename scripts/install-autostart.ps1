<#
============================================================
 AUTOSTART - jalankan run-all.js otomatis setiap PC menyala
============================================================
 Mendaftarkan task "Monitoring Gearbox Karawang" di Windows Task Scheduler:
   - jalan saat PC booting (sebelum ada yang login), di belakang layar
   - sebagai akun SYSTEM, jadi tetap jalan walau user logout
   - kalau run-all.js sendiri mati, Task Scheduler menyalakannya lagi tiap 1 menit
 Juga membuka Windows Firewall untuk port 1883 (ESP32), 9001 (dashboard
 real-time), dan 8080 (halaman dashboard) di jaringan Private/Domain.

 CARA PAKAI (PowerShell "Run as administrator", dari folder project):
     powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
 Tanpa mengubah firewall:
     powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -SkipFirewall
 Menghapus lagi:
     powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1

 Output semua layanan ada di folder service-logs\.
#>
param([switch]$SkipFirewall)

$ErrorActionPreference = 'Stop'
$TaskName = 'Monitoring Gearbox Karawang'
$Root = Split-Path -Parent $PSScriptRoot

$principalNow = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principalNow.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Jalankan PowerShell sebagai Administrator (klik kanan > Run as administrator).' -ForegroundColor Red
    exit 1
}

foreach ($required in @('run-all.js', 'service-config.json', 'node_modules', 'vendor')) {
    if (-not (Test-Path (Join-Path $Root $required))) {
        Write-Host "File/folder '$required' belum ada. Jalankan dulu: npm install lalu npm run vendor" -ForegroundColor Red
        exit 1
    }
}
$serviceConfig = Get-Content (Join-Path $Root 'service-config.json') -Raw | ConvertFrom-Json
if ($serviceConfig.mqttAuth -eq $true -and -not (Test-Path (Join-Path $Root 'mqtt\passwd'))) {
    Write-Host 'mqttAuth aktif tapi mqtt\passwd belum ada. Jalankan dulu: npm run setup-mqtt' -ForegroundColor Red
    exit 1
}

$node = (Get-Command node -ErrorAction Stop).Source

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$Root\run-all.js`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description 'Broker MQTT + logger + web dashboard Monitoring Suhu Gearbox (run-all.js)' -Force | Out-Null
Write-Host "Task '$TaskName' terdaftar (jalan otomatis saat PC menyala)." -ForegroundColor Green

if (-not $SkipFirewall) {
    $rules = @(
        @{ Name = 'Monitoring Gearbox - MQTT (ESP32)';      Port = 1883 },
        @{ Name = 'Monitoring Gearbox - MQTT WebSocket';    Port = 9001 },
        @{ Name = 'Monitoring Gearbox - Dashboard';         Port = 8080 }
    )
    foreach ($rule in $rules) {
        Remove-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
        New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -Protocol TCP -LocalPort $rule.Port `
            -Action Allow -Profile Domain, Private | Out-Null
    }
    Write-Host 'Firewall dibuka untuk port 1883, 9001, 8080 (jaringan Private/Domain).' -ForegroundColor Green
    Write-Host 'Catatan: kalau jaringan pabrik terdeteksi "Public" di Windows, ubah jadi Private supaya aturan ini berlaku.'
}

# Jangan langsung start kalau port masih dipakai (mis. masih ada jendela manual yang jalan)
$busy = Get-NetTCPConnection -State Listen -LocalPort 1883, 9001, 8080 -ErrorAction SilentlyContinue
if ($busy) {
    Write-Host 'Port 1883/9001/8080 masih dipakai program lain (mungkin jendela run-all / mosquitto manual).' -ForegroundColor Yellow
    Write-Host "Tutup dulu, lalu jalankan: Start-ScheduledTask -TaskName '$TaskName'  (atau restart PC)."
} else {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host 'Task dijalankan sekarang. Buka http://localhost:8080 untuk cek.' -ForegroundColor Green
}
