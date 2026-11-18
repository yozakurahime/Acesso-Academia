@echo off
cd /d "%~dp0"
git pull --ff-only origin main >nul 2>&1
start "" powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\edge-tray.ps1"
exit /b 0
