@echo off
setlocal
cd /d "%~dp0"

echo Instalando Sincronizador Academia Oxigenio no Windows...
echo (Inicia sozinho ao ligar o PC e se atualiza automaticamente a cada 60s)
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = (Get-Location).Path; " ^
  "$node = (Get-Command node -ErrorAction Stop).Source; " ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*edge-runner.js*' -or $_.CommandLine -like '*src/server.js*' -or $_.CommandLine -like '*src\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; " ^
  "$action = New-ScheduledTaskAction -Execute $node -Argument 'src/edge-runner.js' -WorkingDirectory $root; " ^
  "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; " ^
  "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1); " ^
  "Register-ScheduledTask -TaskName 'OxigenioSincronizador' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null; " ^
  "Start-ScheduledTask -TaskName 'OxigenioSincronizador'; " ^
  "Write-Host 'Sincronizador instalado e iniciado com sucesso!' -ForegroundColor Green; " ^
  "Write-Host ('Logs em: ' + (Join-Path $root 'data\edge-runner.log'))"

if errorlevel 1 (
  echo.
  echo Falha ao instalar. Tente executar como Administrador ou use o iniciar.bat.
)

echo.
pause
