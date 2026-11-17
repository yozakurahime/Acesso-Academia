@echo off
setlocal
cd /d "%~dp0"

set "PORT=3000"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /i "%%A"=="PORT" if not "%%B"=="" set "PORT=%%B"
  )
)

echo Reiniciando Sistema Academia Oxigenio (porta %PORT%)...

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R ":%PORT% .*LISTENING"') do (
  if not "%%P"=="0" (
    echo Encerrando servidor anterior (PID %%P)...
    taskkill /PID %%P /T /F >nul 2>&1
  )
)

powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Where-Object { $_.CommandLine -like '*academia-oxigenio*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

timeout /t 2 /nobreak >nul
echo Atualizando codigo (se houver internet)...
git pull --ff-only origin main 2>nul
echo Iniciando servidor novamente...
npm start
