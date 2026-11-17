param(
  [int]$Port = 3000,
  [int]$ServerPid = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies @('System.Windows.Forms.dll', 'System.Drawing.dll') -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class HotkeyWindow : Form {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    public event Action HotkeyPressed;
    private const int WM_HOTKEY = 0x0312;

    public HotkeyWindow() {
        this.ShowInTaskbar = false;
        this.WindowState = FormWindowState.Minimized;
        this.Opacity = 0;
    }

    protected override void SetVisibleCore(bool value) {
        base.SetVisibleCore(false);
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_HOTKEY && HotkeyPressed != null) {
            HotkeyPressed();
        }
        base.WndProc(ref m);
    }
}
"@

$win = New-Object HotkeyWindow
$handle = $win.Handle
$registered = @()
$timer = $null

$win.add_HotkeyPressed({
  try {
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/device/release" -Headers @{ 'X-Oxigenio-Hotkey' = $env:OXIGENIO_HOTKEY_TOKEN } -ContentType "application/json" -Body '{"direction":"entry"}' -TimeoutSec 30 | Out-Null
    [System.Media.SystemSounds]::Asterisk.Play()
  } catch {
    [Console]::Error.WriteLine("[ATALHO GLOBAL] Falha ao liberar entrada: " + $_.Exception.Message)
    [System.Media.SystemSounds]::Hand.Play()
  }
})

try {
  foreach ($key in @(
    @{ Id = 1; Label = 'F9'; Modifiers = 0x4000; Vk = 0x78 }
    @{ Id = 2; Label = 'Ctrl+Alt+L'; Modifiers = 0x4003; Vk = 0x4C }
  )) {
    if ([HotkeyWindow]::RegisterHotKey($handle, $key.Id, $key.Modifiers, $key.Vk)) {
      $registered += $key.Id
      [Console]::WriteLine("[ATALHO GLOBAL] $($key.Label) ativo.")
    } else {
      $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      [Console]::Error.WriteLine("[ATALHO GLOBAL] $($key.Label) indisponivel (Windows: $code).")
    }
  }
  if ($registered.Count -eq 0) { exit 1 }
  if ($ServerPid -gt 0) {
    $server = Get-Process -Id $ServerPid -ErrorAction SilentlyContinue
    if (-not $server) { return }
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 1000
    $timer.add_Tick({ if ($server.HasExited) { $win.Close() } })
    $timer.Start()
  }
  [System.Windows.Forms.Application]::Run($win)
} finally {
  if ($timer) { $timer.Dispose() }
  foreach ($id in $registered) { [void][HotkeyWindow]::UnregisterHotKey($handle, $id) }
  $win.Dispose()
}
