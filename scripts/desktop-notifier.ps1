param(
  [int]$ServerPid = 0,
  [string]$IconPath = '',
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.Windows.Forms.dll', 'System.Drawing.dll') -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class NativeWinHelper {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateRoundRectRgn(int nLeftRect, int nTopRect, int nRightRect, int nBottomRect, int nWidthEllipse, int nHeightEllipse);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}

public static class StdinLineQueue {
    private static readonly ConcurrentQueue<string> _queue = new ConcurrentQueue<string>();
    private static volatile bool _closed = false;

    public static bool IsClosed { get { return _closed; } }

    public static void Start() {
        Thread t = new Thread(() => {
            try {
                using (var stream = Console.OpenStandardInput())
                using (var reader = new StreamReader(stream, new UTF8Encoding(false))) {
                    string line;
                    while ((line = reader.ReadLine()) != null) {
                        if (!string.IsNullOrWhiteSpace(line)) {
                            _queue.Enqueue(line);
                        }
                    }
                }
            } catch {
            } finally {
                _closed = true;
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    public static bool TryDequeue(out string line) {
        return _queue.TryDequeue(out line);
    }
}

public class ToastPopupForm : Form {
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_TOPMOST = 0x00000008;
    private const int WS_EX_TOOLWINDOW = 0x00000080;

    protected override bool ShowWithoutActivation {
        get { return true; }
    }

    protected override CreateParams CreateParams {
        get {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_TOOLWINDOW;
            return cp;
        }
    }

    public ToastPopupForm() {
        this.FormBorderStyle = FormBorderStyle.None;
        this.ShowInTaskbar = false;
        this.TopMost = true;
        this.StartPosition = FormStartPosition.Manual;
        this.BackColor = Color.FromArgb(15, 23, 42);
        this.Size = new Size(360, 88);
        this.DoubleBuffered = true;
    }

    public void ApplyRoundedCorners(int radius) {
        IntPtr rgn = NativeWinHelper.CreateRoundRectRgn(0, 0, this.Width + 1, this.Height + 1, radius, radius);
        this.Region = Region.FromHrgn(rgn);
    }
}
"@

$hostForm = New-Object System.Windows.Forms.Form
$hostForm.ShowInTaskbar = $false
$hostForm.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$hostForm.Opacity = 0
$hostForm.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow

$customIconHandle = [IntPtr]::Zero
$trayIcon = [System.Drawing.SystemIcons]::Information
$logoImage = $null
if ($IconPath -and (Test-Path -LiteralPath $IconPath)) {
  try {
    $srcImg = [System.Drawing.Image]::FromFile($IconPath)
    $logoImage = New-Object System.Drawing.Bitmap($srcImg, 44, 44)
    $bmp = New-Object System.Drawing.Bitmap($srcImg, 32, 32)
    $srcImg.Dispose()
    $customIconHandle = $bmp.GetHicon()
    $trayIcon = [System.Drawing.Icon]::FromHandle($customIconHandle)
    $bmp.Dispose()
  } catch {
    $trayIcon = [System.Drawing.SystemIcons]::Information
  }
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = $trayIcon
$notifyIcon.Text = 'Academia Oxigenio - Catraca'
$notifyIcon.Visible = $true

$openSystem = {
  try {
    Start-Process "http://127.0.0.1:$Port" | Out-Null
  } catch {
  }
}
$notifyIcon.add_DoubleClick($openSystem)

$activePopups = New-Object System.Collections.Generic.List[object]

function Reposition-Popups {
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $marginRight = 16
  $marginBottom = 16
  $gap = 10
  $y = $wa.Bottom - $marginBottom
  for ($i = $activePopups.Count - 1; $i -ge 0; $i--) {
    $p = $activePopups[$i]
    if ($p.IsDisposed) {
      $activePopups.RemoveAt($i)
      continue
    }
    $y -= $p.Height
    $p.Location = New-Object System.Drawing.Point(($wa.Right - $p.Width - $marginRight), $y)
    $y -= $gap
  }
}

function Show-DesktopToast {
  param(
    [string]$Title,
    [string]$Body,
    [int]$TimeoutMs = 6000,
    [string]$Level = 'info'
  )

  while ($activePopups.Count -ge 4) {
    $oldest = $activePopups[0]
    $activePopups.RemoveAt(0)
    try { $oldest.Close(); $oldest.Dispose() } catch {}
  }

  $isError = ($Level -eq 'error')
  $accentColor = if ($isError) { [System.Drawing.Color]::FromArgb(239, 68, 68) } else { [System.Drawing.Color]::FromArgb(16, 185, 129) }
  $titleColor = if ($isError) { [System.Drawing.Color]::FromArgb(248, 113, 113) } else { [System.Drawing.Color]::FromArgb(52, 211, 153) }

  $popup = New-Object ToastPopupForm
  $popup.ApplyRoundedCorners(12)

  $accent = New-Object System.Windows.Forms.Panel
  $accent.BackColor = $accentColor
  $accent.Dock = [System.Windows.Forms.DockStyle]::Left
  $accent.Width = 5
  $popup.Controls.Add($accent)

  $textLeft = 16
  if ($logoImage) {
    $pic = New-Object System.Windows.Forms.PictureBox
    $pic.Image = $logoImage
    $pic.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::StretchImage
    $pic.Size = New-Object System.Drawing.Size(44, 44)
    $pic.Location = New-Object System.Drawing.Point(16, 22)
    $pic.Cursor = [System.Windows.Forms.Cursors]::Hand
    $pic.add_Click($openSystem)
    $popup.Controls.Add($pic)
    $textLeft = 72
  }

  $lines = @($Body -split "`r?`n")
  $mainName = if ($lines.Count -ge 1 -and $lines[0]) { $lines[0] } else { 'Catraca liberada' }
  $metaLine = if ($lines.Count -ge 2 -and $lines[1]) { $lines[1] } else { 'Academia Oxigenio' }

  $lblTitle = New-Object System.Windows.Forms.Label
  $lblTitle.Text = $Title
  $lblTitle.ForeColor = $titleColor
  $lblTitle.Font = New-Object System.Drawing.Font('Segoe UI', 8.5, [System.Drawing.FontStyle]::Bold)
  $lblTitle.Location = New-Object System.Drawing.Point($textLeft, 12)
  $lblTitle.Size = New-Object System.Drawing.Size((330 - $textLeft), 16)
  $lblTitle.AutoEllipsis = $true
  $lblTitle.Cursor = [System.Windows.Forms.Cursors]::Hand
  $lblTitle.add_Click($openSystem)
  $popup.Controls.Add($lblTitle)

  $lblName = New-Object System.Windows.Forms.Label
  $lblName.Text = $mainName
  $lblName.ForeColor = [System.Drawing.Color]::White
  $lblName.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
  $lblName.Location = New-Object System.Drawing.Point($textLeft, 31)
  $lblName.Size = New-Object System.Drawing.Size((342 - $textLeft), 24)
  $lblName.AutoEllipsis = $true
  $lblName.Cursor = [System.Windows.Forms.Cursors]::Hand
  $lblName.add_Click($openSystem)
  $popup.Controls.Add($lblName)

  $lblMeta = New-Object System.Windows.Forms.Label
  $lblMeta.Text = $metaLine
  $lblMeta.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
  $lblMeta.Font = New-Object System.Drawing.Font('Segoe UI', 8.5, [System.Drawing.FontStyle]::Regular)
  $lblMeta.Location = New-Object System.Drawing.Point($textLeft, 57)
  $lblMeta.Size = New-Object System.Drawing.Size((342 - $textLeft), 18)
  $lblMeta.AutoEllipsis = $true
  $lblMeta.Cursor = [System.Windows.Forms.Cursors]::Hand
  $lblMeta.add_Click($openSystem)
  $popup.Controls.Add($lblMeta)

  $btnClose = New-Object System.Windows.Forms.Label
  $btnClose.Text = '×'
  $btnClose.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
  $btnClose.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
  $btnClose.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
  $btnClose.Location = New-Object System.Drawing.Point(332, 6)
  $btnClose.Size = New-Object System.Drawing.Size(22, 22)
  $btnClose.Cursor = [System.Windows.Forms.Cursors]::Hand
  $popup.Controls.Add($btnClose)

  $closeTimer = New-Object System.Windows.Forms.Timer
  $closeTimer.Interval = [Math]::Max(1500, $TimeoutMs)

  $closePopup = {
    $closeTimer.Stop()
    $closeTimer.Dispose()
    [void]$activePopups.Remove($popup)
    if (-not $popup.IsDisposed) {
      $popup.Close()
      $popup.Dispose()
    }
    Reposition-Popups
  }.GetNewClosure()

  $btnClose.add_Click($closePopup)
  $closeTimer.add_Tick($closePopup)
  $popup.add_Click($openSystem)

  $activePopups.Add($popup)
  Reposition-Popups
  $popup.Show()
  [void][NativeWinHelper]::SetWindowPos($popup.Handle, [IntPtr](-1), 0, 0, 0, 0, (0x0001 -bor 0x0002 -bor 0x0010 -bor 0x0040))
  $closeTimer.Start()
}

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $contextMenu.Items.Add('Abrir sistema')
$openItem.add_Click($openSystem)
$testItem = $contextMenu.Items.Add('Testar notificacao')
$testItem.add_Click({
  $now = (Get-Date).ToString('HH:mm:ss')
  Show-DesktopToast -Title "Catraca liberada · $now" -Body "Teste de notificacao`nAcademia Oxigenio" -TimeoutMs 5000
})
$notifyIcon.ContextMenuStrip = $contextMenu

[StdinLineQueue]::Start()

$serverProcess = $null
if ($ServerPid -gt 0) {
  $serverProcess = Get-Process -Id $ServerPid -ErrorAction SilentlyContinue
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 80
$timer.add_Tick({
  $raw = $null
  while ([StdinLineQueue]::TryDequeue([ref]$raw)) {
    try {
      $payload = $raw | ConvertFrom-Json
      $title = [string]($payload.title)
      $body = [string]($payload.body)
      if (-not $title) { $title = 'Academia Oxigenio' }
      if (-not $body) { $body = 'Evento registrado.' }
      $timeoutMs = if ($payload.timeoutMs) { [int]$payload.timeoutMs } else { 6000 }
      $level = if ($payload.level) { [string]$payload.level } else { 'info' }
      Show-DesktopToast -Title $title -Body $body -TimeoutMs $timeoutMs -Level $level
    } catch {
      [Console]::Error.WriteLine($_.Exception.Message)
    }
  }

  if ([StdinLineQueue]::IsClosed -or ($serverProcess -and $serverProcess.HasExited)) {
    $timer.Stop()
    $hostForm.Close()
  }
})
$timer.Start()

try {
  [System.Windows.Forms.Application]::Run($hostForm)
} finally {
  if ($timer) { $timer.Dispose() }
  foreach ($p in $activePopups.ToArray()) {
    try { if (-not $p.IsDisposed) { $p.Close(); $p.Dispose() } } catch {}
  }
  if ($notifyIcon) {
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
  }
  if ($contextMenu) { $contextMenu.Dispose() }
  if ($logoImage) { $logoImage.Dispose() }
  if ($customIconHandle -ne [IntPtr]::Zero) {
    [void][NativeWinHelper]::DestroyIcon($customIconHandle)
  }
  if ($hostForm) { $hostForm.Dispose() }
}
