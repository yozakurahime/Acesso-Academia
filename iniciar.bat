@echo off
cd /d "%~dp0"
git pull --ff-only origin main >nul 2>&1
start "" wscript.exe //B //Nologo "%~dp0scripts\launch-tray.vbs"
exit /b 0
