param(
  [string]$RootDir = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'SilentlyContinue'

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Global\OxigenioEdgeTrayMutex', [ref]$createdNew)
if (-not $createdNew) {
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

Set-Location -LiteralPath $RootDir

$port = '3000'
$cloudUrl = 'https://sistema.academiaoxigenio.com'
$envFile = Join-Path $RootDir '.env'
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*PORT\s*=\s*(.+?)\s*$') { $port = $matches[1].Trim('"').Trim("'") }
    if ($line -match '^\s*EDGE_CLOUD_URL\s*=\s*(.+?)\s*$') { $cloudUrl = $matches[1].Trim('"').Trim("'") }
  }
}
if (-not $cloudUrl -or $cloudUrl -match '^https?://(127\.0\.0\.1|localhost)(:\d+)?/?$') {
  $cloudUrl = 'https://sistema.academiaoxigenio.com'
}

$nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeCmd) {
  $candidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe"
  )
  $nodeCmd = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $nodeCmd) {
  [System.Windows.Forms.MessageBox]::Show('Node.js nao encontrado.', 'Academia Oxigenio') | Out-Null
  exit 1
}

$script:runnerProc = $null
$script:exiting = $false
$script:screensOpened = $false
$abrirTelasScript = Join-Path $RootDir 'scripts\abrir-telas.ps1'

function Open-CatracaAndPanel([switch]$SomenteCatraca) {
  if (-not (Test-Path $abrirTelasScript)) { return }
  $args = @('-WindowStyle', 'Hidden', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $abrirTelasScript, '-Port', $port, '-PanelUrl', $cloudUrl)
  if ($SomenteCatraca) { $args += '-SomenteCatraca' }
  Start-Process powershell.exe -ArgumentList $args -WorkingDirectory $RootDir -WindowStyle Hidden
}

function Stop-EdgeProcesses {
  if ($script:runnerProc -and -not $script:runnerProc.HasExited) {
    try { Stop-Process -Id $script:runnerProc.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*edge-runner.js*' -or $_.CommandLine -like '*src/server.js*' -or $_.CommandLine -like '*src\server.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-EdgeRunner {
  if ($script:exiting) { return }
  if ($script:runnerProc -and -not $script:runnerProc.HasExited) { return }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $nodeCmd
  $psi.Arguments = 'src/edge-runner.js'
  $psi.WorkingDirectory = $RootDir
  $psi.CreateNoWindow = $true
  $psi.UseShellExecute = $false
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $script:runnerProc = [System.Diagnostics.Process]::Start($psi)
}

Stop-EdgeProcesses
Start-Sleep -Milliseconds 500
Start-EdgeRunner

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$pngIconPath = Join-Path $RootDir 'public\icons\icon-192.png'
if (Test-Path $pngIconPath) {
  try {
    $bmp = [System.Drawing.Bitmap]::FromFile($pngIconPath)
    $notifyIcon.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  } catch {
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
  }
} else {
  $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
}
$notifyIcon.Text = 'Academia Oxigenio - Sincronizador'
$notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemStatus = $menu.Items.Add('Status: Iniciando...')
$itemStatus.Enabled = $false
$menu.Items.Add('-') | Out-Null

$itemOpenPanel = $menu.Items.Add('Abrir Painel (Nuvem)')
$itemOpenPanel.Add_Click({ Start-Process $cloudUrl })

$itemOpenCatraca = $menu.Items.Add('Abrir Tela da Catraca (Monitor 2)')
$itemOpenCatraca.Add_Click({ Open-CatracaAndPanel -SomenteCatraca })

$itemLogs = $menu.Items.Add('Ver Logs do Sincronizador')
$itemLogs.Add_Click({
  $logPath = Join-Path $RootDir 'data\edge-runner.log'
  if (-not (Test-Path $logPath)) { New-Item -ItemType File -Path $logPath -Force | Out-Null }
  Start-Process notepad.exe $logPath
})

$menu.Items.Add('-') | Out-Null

$itemRestart = $menu.Items.Add('Reiniciar Sincronizador')
$itemRestart.Add_Click({
  $itemStatus.Text = 'Status: Reiniciando...'
  Stop-EdgeProcesses
  Start-Sleep -Seconds 1
  Start-EdgeRunner
})

$itemExit = $menu.Items.Add('Sair')
$itemExit.Add_Click({
  $script:exiting = $true
  $timer.Stop()
  Stop-EdgeProcesses
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.Add_DoubleClick({ Start-Process $cloudUrl })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
  if ($script:exiting) { return }
  if (-not $script:runnerProc -or $script:runnerProc.HasExited) {
    Start-EdgeRunner
  }
  try {
    $res = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/edge/tray-status" -TimeoutSec 3
    if (-not $script:screensOpened) {
      $script:screensOpened = $true
      $timer.Interval = 8000
      Open-CatracaAndPanel
    }
    $h = if ($res.hostConnected) { 'OK' } else { 'Reconectando' }
    $r = if ($res.readerConnected) { 'OK' } else { 'Off' }
    $t = if ($res.turnstileConnected) { 'OK' } else { 'Off' }
    $itemStatus.Text = "Host: $h | Leitor: $r | Catraca: $t"
    $tip = "Oxigenio | Host:$h Leitor:$r Catraca:$t"
    if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
    $notifyIcon.Text = $tip
  } catch {
    $itemStatus.Text = 'Status: Iniciando / Reconectando...'
    $notifyIcon.Text = 'Academia Oxigenio - Reconectando...'
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
if ($mutex) {
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}
