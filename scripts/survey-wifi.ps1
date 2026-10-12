# ============================================================
# SURVEI KUALITAS WIFI DI ATAS CRANE - jalankan di laptop Windows yang dibawa ke tiap titik
# ============================================================
# Per titik (mis. 0m, 25m, 50m, ...), ukur selama -Detik:
#   - sinyal WiFi laptop (RSSI perkiraan), access point (BSSID), channel, band, kecepatan link
#   - kehilangan paket + waktu balasan (ping) ke -Target (PC server / gateway)
# Hasilnya dinilai BAIK / CUKUP / BURUK dan ditambahkan ke survey-wifi.csv (folder proyek).
#
# Contoh (PowerShell, dari folder proyek):
#   powershell -ExecutionPolicy Bypass -File scripts\survey-wifi.ps1 -Titik "25m-tengah" -Target 192.168.150.95
#   powershell -ExecutionPolicy Bypass -File scripts\survey-wifi.ps1 -Titik "50m-kiri" -Target 192.168.150.95 -Detik 90
#
# Catatan: ukur di KETINGGIAN pasang alat (di jembatan crane), bukan di lantai. Antena laptop beda dari
# ESP32 (biasanya lebih bagus), jadi anggap hasil ini batas ATAS: kalau di sini sudah jelek, di ESP32 lebih jelek.
# Ambang nilai (RSSI perkiraan = persen sinyal/2 - 100):
#   BAIK  : sinyal >= -67 dBm, paket hilang <= 1%, balasan rata-rata < 50 ms
#   CUKUP : sinyal >= -75 dBm, paket hilang <= 5%
#   BURUK : di bawah itu (tambah access point / pindahkan posisi / antena luar)
param(
    [Parameter(Mandatory = $true)][string]$Titik,
    [string]$Target = '192.168.150.254',
    [int]$Detik = 60
)

function Get-Wifi {
    $o = netsh wlan show interfaces
    $get = { param($re) $m = $o | Select-String -Pattern $re | Select-Object -First 1; if ($m) { ($m.Line -split ':', 2)[1].Trim() } else { $null } }
    [pscustomobject]@{
        Signal  = & $get '^\s*Signal\s*:'
        Bssid   = & $get '^\s*(AP )?BSSID\s*:'   # Windows 11 menulis "AP BSSID"
        Channel = & $get '^\s*Channel\s*:'
        Band    = & $get '^\s*Band\s*:'
        Rx      = & $get '^\s*Receive rate'
        Ssid    = & $get '^\s*SSID\s*:'
    }
}

Write-Host "Titik '$Titik' - mengukur $Detik detik, ping ke $Target ..." -ForegroundColor Cyan
$sig = New-Object System.Collections.Generic.List[double]
$lat = New-Object System.Collections.Generic.List[double]
$bssids = New-Object System.Collections.Generic.HashSet[string]
$chans = New-Object System.Collections.Generic.HashSet[string]
$band = ''; $ssid = ''; $rxrate = ''
$kirim = 0; $hilang = 0
$sw = [Diagnostics.Stopwatch]::StartNew()
$nextWifi = 0
while ($sw.Elapsed.TotalSeconds -lt $Detik) {
    if ($sw.Elapsed.TotalSeconds -ge $nextWifi) {
        $nextWifi += 2
        $w = Get-Wifi
        if ($w.Signal -match '(\d+)') { $sig.Add([double]($Matches[1]) / 2 - 100) }
        if ($w.Bssid) { [void]$bssids.Add($w.Bssid) }
        if ($w.Channel) { [void]$chans.Add($w.Channel) }
        if ($w.Band) { $band = $w.Band }
        if ($w.Ssid) { $ssid = $w.Ssid }
        if ($w.Rx) { $rxrate = $w.Rx }
    }
    $kirim++
    $p = ping -n 1 -w 1000 $Target | Select-String -Pattern 'time[=<](\d+)'
    if ($p) { $lat.Add([double]$p.Matches[0].Groups[1].Value) } else { $hilang++ }
    Start-Sleep -Milliseconds 700
}

$rssiAvg = if ($sig.Count) { [math]::Round(($sig | Measure-Object -Average).Average, 0) } else { $null }
$rssiMin = if ($sig.Count) { [math]::Round(($sig | Measure-Object -Minimum).Minimum, 0) } else { $null }
$loss = if ($kirim) { [math]::Round(100.0 * $hilang / $kirim, 1) } else { 100 }
$latAvg = if ($lat.Count) { [math]::Round(($lat | Measure-Object -Average).Average, 0) } else { $null }
$latMax = if ($lat.Count) { [math]::Round(($lat | Measure-Object -Maximum).Maximum, 0) } else { $null }

$nilai = 'BURUK'
if ($null -ne $rssiAvg) {
    if ($rssiAvg -ge -67 -and $loss -le 1 -and $latAvg -lt 50) { $nilai = 'BAIK' }
    elseif ($rssiAvg -ge -75 -and $loss -le 5) { $nilai = 'CUKUP' }
}

$csv = Join-Path $PSScriptRoot '..\survey-wifi.csv'
if (-not (Test-Path $csv)) { 'waktu,titik,nilai,rssi_rata,rssi_min,paket_hilang_persen,ping_rata_ms,ping_maks_ms,ap_terlihat,channel,band,ssid,rx_mbps,jumlah_ping' | Out-File $csv -Encoding utf8 }
$row = '{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10},{11},{12},{13}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Titik, $nilai, $rssiAvg, $rssiMin, $loss, $latAvg, $latMax, (($bssids -join '|')), (($chans -join '|')), $band, $ssid, $rxrate, $kirim
Add-Content -Path $csv -Value $row -Encoding utf8

$warna = @{ 'BAIK' = 'Green'; 'CUKUP' = 'Yellow'; 'BURUK' = 'Red' }[$nilai]
Write-Host ''
Write-Host ("  Titik        : {0}" -f $Titik)
Write-Host ("  Nilai        : {0}" -f $nilai) -ForegroundColor $warna
Write-Host ("  Sinyal       : rata-rata {0} dBm, terlemah {1} dBm" -f $rssiAvg, $rssiMin)
Write-Host ("  Paket hilang : {0}% dari {1} ping (ke {2})" -f $loss, $kirim, $Target)
Write-Host ("  Balasan      : rata-rata {0} ms, terlama {1} ms" -f $latAvg, $latMax)
Write-Host ("  Access point : {0}  (channel {1}, {2})" -f ($bssids -join ', '), ($chans -join ','), $band)
if ($bssids.Count -gt 1) { Write-Host '  ! Laptop berpindah access point selama pengukuran (area perbatasan 2 AP)' -ForegroundColor Yellow }
Write-Host ("  Disimpan ke  : {0}" -f (Resolve-Path $csv))
