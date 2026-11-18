@echo off
setlocal
cd /d "%~dp0"

set "PORT=3000"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /i "%%A"=="PORT" if not "%%B"=="" set "PORT=%%B"
  )
)

echo Reiniciando Sistema Academia Oxigenio - porta %PORT%...

powershell -NoProfile -Command "$p = '%PORT%'; $pids = @(); try { $pids += (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess) } catch {}; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { ($pids -contains $_.ProcessId) -or $_.CommandLine -like '*edge-runner.js*' -or $_.CommandLine -like '*src/server.js*' -or $_.CommandLine -like '*src\server.js*' } | ForEach-Object { Write-Host ('Encerrando servidor anterior PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" | Where-Object { $_.CommandLine -like '*academia-oxigenio*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

timeout /t 2 /nobreak >nul
echo Atualizando codigo (se houver internet)...
git pull --ff-only origin main || echo Aviso: nao foi possivel atualizar via git pull.
echo Iniciando sincronizador com auto-atualizacao...
call npm run runner
if errorlevel 1 pause
