@echo off
setlocal
cd /d "%~dp0"

echo Instalando Sincronizador Academia Oxigenio na Bandeja do Windows...
echo (Inicia sozinho ao ligar o PC, fica no icone da bandeja e reconecta catraca/leitor/host)
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = (Get-Location).Path; " ^
  "$trayScript = Join-Path $root 'scripts\edge-tray.ps1'; " ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*edge-runner.js*' -or $_.CommandLine -like '*src/server.js*' -or $_.CommandLine -like '*src\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; " ^
  "$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File \"' + $trayScript + '\"') -WorkingDirectory $root; " ^
  "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; " ^
  "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1); " ^
  "Register-ScheduledTask -TaskName 'OxigenioSincronizador' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null; " ^
  "Start-ScheduledTask -TaskName 'OxigenioSincronizador'; " ^
  "Write-Host 'Sincronizador instalado na bandeja e iniciado com sucesso!' -ForegroundColor Green; " ^
  "Write-Host ('Logs em: ' + (Join-Path $root 'data\edge-runner.log'))"

if errorlevel 1 (
  echo.
  echo Falha ao instalar na Tarefa Agendada. Criando atalho na pasta Inicializar...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$root = (Get-Location).Path; " ^
    "$trayScript = Join-Path $root 'scripts\edge-tray.ps1'; " ^
    "$startup = [Environment]::GetFolderPath('Startup'); " ^
    "$wsh = New-Object -ComObject WScript.Shell; " ^
    "$sc = $wsh.CreateShortcut((Join-Path $startup 'OxigenioSincronizador.lnk')); " ^
    "$sc.TargetPath = 'powershell.exe'; " ^
    "$sc.Arguments = ('-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File \"' + $trayScript + '\"'); " ^
    "$sc.WorkingDirectory = $root; " ^
    "$sc.WindowStyle = 7; " ^
    "$sc.Save(); " ^
    "Start-Process powershell.exe -ArgumentList @('-WindowStyle','Hidden','-NoProfile','-ExecutionPolicy','Bypass','-File',$trayScript) -WorkingDirectory $root -WindowStyle Hidden; " ^
    "Write-Host 'Atalho de inicializacao criado e bandeja iniciada!' -ForegroundColor Green"
)

echo.
pause
