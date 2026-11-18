param(
    [ValidateRange(1, 65535)][int]$Port = 3000,
    [string]$PanelUrl = 'https://sistema.academiaoxigenio.com',
    [switch]$SomenteCatraca
)

$ErrorActionPreference = 'Stop'
$baseUrl = "http://localhost:$Port"
if (-not $SomenteCatraca -and $PanelUrl) {
    Start-Process -FilePath $PanelUrl
}

$lock = [System.Threading.Mutex]::new($false, "Local\OxigenioTelaCatraca-$Port")
$ownsLock = $false
try {
    try { $ownsLock = $lock.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $ownsLock = $true }
    if (-not $ownsLock) { return }

    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class OxigenioWindow {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect {
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter,
        int x, int y, int width, int height, uint flags);
}
'@
    [void][OxigenioWindow]::SetProcessDpiAwarenessContext([IntPtr](-4))
    Add-Type -AssemblyName System.Windows.Forms
    $screens = [System.Windows.Forms.Screen]::AllScreens
    $screen = $screens | Where-Object { $_.DeviceName.EndsWith('\DISPLAY2') } | Select-Object -First 1
    if (-not $screen) {
        $screen = $screens | Where-Object { -not $_.Primary } | Select-Object -First 1
    }
    if (-not $screen) {
        Write-Warning 'Segundo monitor indisponivel. A recepcao continua disponivel.'
        return
    }

    $edge = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA) |
        Where-Object { $_ } |
        ForEach-Object { Join-Path $_ 'Microsoft\Edge\Application\msedge.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    if (-not $edge) { throw 'Microsoft Edge nao encontrado.' }

    $bounds = $screen.Bounds
    $profile = Join-Path $env:LOCALAPPDATA "Academia Oxigenio\Tela Catraca\$Port"
    $browser = Start-Process -FilePath $edge -ArgumentList @(
        "--user-data-dir=`"$profile`"", '--no-first-run', '--no-default-browser-check',
        "--window-position=$($bounds.X),$($bounds.Y)", "--window-size=$($bounds.Width),$($bounds.Height)",
        '--kiosk', "$baseUrl/catraca.html", '--edge-kiosk-type=fullscreen'
    ) -PassThru

    $window = [IntPtr]::Zero
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $browser.Refresh()
        if ($browser.HasExited) { break }
        $window = $browser.MainWindowHandle
        if ($window -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 150 }
    } while ($window -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline)
    if ($window -eq [IntPtr]::Zero) { throw 'A janela da catraca nao foi encontrada.' }

    $rect = New-Object OxigenioWindow+Rect
    $positioned = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        # Espera o Edge concluir a transicao do modo quiosque antes de validar.
        Start-Sleep -Milliseconds 150
        if ([OxigenioWindow]::GetWindowRect($window, [ref]$rect) -and
            $rect.Left -eq $bounds.Left -and $rect.Top -eq $bounds.Top -and
            $rect.Right -eq $bounds.Right -and $rect.Bottom -eq $bounds.Bottom) {
            $positioned = $true
            break
        }
        # SWP_NOZORDER | SWP_NOACTIVATE
        [void][OxigenioWindow]::SetWindowPos($window, [IntPtr]::Zero,
            $bounds.X, $bounds.Y, $bounds.Width, $bounds.Height, 0x0014)
    }
    if (-not $positioned) { throw 'Nao foi possivel confirmar a janela em tela cheia no segundo monitor.' }

    Write-Host "[TELAS] Catraca em tela cheia em $($screen.DeviceName) ($bounds)."
    $browser.WaitForExit()
} catch {
    Write-Warning "[TELAS] $($_.Exception.Message)"
} finally {
    if ($ownsLock) { $lock.ReleaseMutex() }
    $lock.Dispose()
}
