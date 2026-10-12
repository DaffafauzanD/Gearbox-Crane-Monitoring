@echo off
rem ============================================================
rem  MONITORING GEARBOX - pemanggil untuk pintasan di Desktop
rem ============================================================
rem  Pintasan Desktop menjalankan file ini TANPA jendela CMD (conhost --headless).
rem  Semua logikanya ada di scripts\app.js. Kalau ada yang kurang, muncul kotak pesan
rem  (bukan diam saja).
rem  Kalau file ini diklik dua kali langsung, jendela CMD ikut terlihat - pakai
rem  pintasan Desktop supaya tanpa CMD.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show('Node.js tidak ditemukan. Pasang dulu dari https://nodejs.org lalu klik lagi.','Monitoring Gearbox Crane')"
    exit /b 1
)
if not exist "node_modules\mqtt" (
    powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show('Library belum terpasang. Buka terminal di folder project, jalankan: npm install lalu npm run vendor','Monitoring Gearbox Crane')"
    exit /b 1
)

node scripts\app.js
exit /b %errorlevel%