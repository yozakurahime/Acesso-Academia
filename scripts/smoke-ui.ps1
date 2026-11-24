$ErrorActionPreference = 'Stop'
$tmpData = Join-Path $env:TEMP ("oxigenio-smoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpData -Force | Out-Null

$port = 3994
$env:PORT = "$port"
$env:DATA_DIR = $tmpData
$proc = Start-Process -FilePath "node" -ArgumentList "src/server.js" -PassThru -WindowStyle Hidden

try {
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      if ((Invoke-WebRequest "http://127.0.0.1:$port/api/auth/status" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) {
        $ready = $true
        break
      }
    } catch { Start-Sleep -Milliseconds 300 }
  }
  if (-not $ready) { throw "Servidor smoke nao respondeu na porta $port" }

  playwright-cli open "http://127.0.0.1:$port/" | Out-Null
  playwright-cli resize 1440 900 | Out-Null
  Start-Sleep -Milliseconds 500

  $tabs = @('balcao', 'members', 'billing', 'cash', 'logs')
  foreach ($t in $tabs) {
    playwright-cli eval "() => { document.querySelector('.tab[data-tab=' + JSON.stringify('$t') + ']')?.click(); }" | Out-Null
    Start-Sleep -Milliseconds 350
    $overflow = playwright-cli eval "() => document.documentElement.scrollWidth - window.innerWidth"
    Write-Output "TAB ${t}: $overflow"
  }

  $errors = playwright-cli console error
  Write-Output $errors
  if ($errors -match 'Errors:\s*[1-9]') {
    throw "Foram encontrados erros no console durante o smoke test."
  }
} finally {
  playwright-cli close 2>$null | Out-Null
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $tmpData -Recurse -Force -ErrorAction SilentlyContinue
}
