param([string]$PayloadB64)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not $PayloadB64) {
  @{ ok = $false; reason = 'empty_payload'; matched = 0; killedProcs = 0; screenCount = ([System.Windows.Forms.Screen]::AllScreens).Length; titles = @() } | ConvertTo-Json -Compress
  exit 0
}

$cfgJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($PayloadB64))
$cfg = $cfgJson | ConvertFrom-Json

$csharp = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Windows.Forms;

public class IrisWinCtrl {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X, Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct WINDOWPLACEMENT {
    public int length;
    public int flags;
    public int showCmd;
    public POINT ptMinPosition;
    public POINT ptMaxPosition;
    public RECT rcNormalPosition;
  }

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumThreadWindows(uint dwThreadId, EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  public class WinEntry {
    public IntPtr Handle;
    public int Pid;
    public string ProcName;
    public string Title;
    public string ClassName;
    public bool IsVisible;
    public bool IsMinimized;
    public long Area;
    public int Score;
  }

  private static string Norm(string s) {
    if (string.IsNullOrEmpty(s)) return "";
    return s.ToLowerInvariant().Trim();
  }

  private static bool IsHelperTitleOrClass(string title, string cls) {
    if (title == "Program Manager" || title == "Default IME" || title == "MSCTFIME UI" ||
        title == "SystemTray_Main" || title == "MediaContextNotificationWindow" ||
        title == "Hidden Window" || title == "OleMainThreadWndName" ||
        title.StartsWith("GDI+ Window", StringComparison.OrdinalIgnoreCase) ||
        title.StartsWith(".NET-BroadcastEventWindow", StringComparison.OrdinalIgnoreCase)) {
      return true;
    }
    if (cls == "Progman" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd" ||
        cls == "Windows.UI.Core.CoreWindow" || cls == "WorkerW" || cls == "tooltips_class32" ||
        cls == "IME" || cls == "MSCTFIME UI" || cls == "EdgeUiInputTopWndClass" ||
        cls == "DummyDWMListenerWindow" || cls == "ForegroundStaging" ||
        cls == "Chrome_SystemMessageWindow") {
      return true;
    }
    if (cls == "ApplicationFrameWindow" && string.IsNullOrEmpty(title)) {
      return true;
    }
    return false;
  }

  public static List<WinEntry> FindMatchingWindows(string[] procCandidates, string[] titleCandidates, bool isActiveTarget, bool includeTray, int irisPid) {
    var candidateHandles = new HashSet<long>();
    var procNames = new Dictionary<int, string>();
    Process[] allProcs = new Process[0];
    try { allProcs = Process.GetProcesses(); } catch {}

    for (int i = 0; i < allProcs.Length; i++) {
      Process p = allProcs[i];
      try { procNames[p.Id] = p.ProcessName; } catch {}
    }

    EnumWindowsProc collectCb = delegate(IntPtr hWnd, IntPtr lParam) {
      if (hWnd != IntPtr.Zero) candidateHandles.Add(hWnd.ToInt64());
      return true;
    };

    try { EnumWindows(collectCb, IntPtr.Zero); } catch {}
    try { EnumDesktopWindows(IntPtr.Zero, collectCb, IntPtr.Zero); } catch {}

    // Also inspect windows owned by processes matching procCandidates via MainWindowHandle + EnumThreadWindows
    if (!isActiveTarget && procCandidates != null && procCandidates.Length > 0) {
      for (int i = 0; i < allProcs.Length; i++) {
        Process p = allProcs[i];
        string pNorm = "";
        try { pNorm = Norm(p.ProcessName); } catch { continue; }
        if (string.IsNullOrEmpty(pNorm) || p.Id == irisPid) continue;

        bool procHits = false;
        for (int j = 0; j < procCandidates.Length; j++) {
          string tok = Norm(procCandidates[j]);
          if (string.IsNullOrEmpty(tok) || tok.StartsWith("__")) continue;
          if (pNorm == tok || pNorm.Contains(tok)) { procHits = true; break; }
        }
        if (!procHits) continue;

        try {
          IntPtr mh = p.MainWindowHandle;
          if (mh != IntPtr.Zero) candidateHandles.Add(mh.ToInt64());
        } catch {}

        try {
          ProcessThreadCollection threads = p.Threads;
          for (int t = 0; t < threads.Count; t++) {
            try {
              EnumThreadWindows((uint)threads[t].Id, collectCb, IntPtr.Zero);
            } catch {}
          }
        } catch {}
      }
    }

    var allVisible = new List<WinEntry>();
    var matchedVisible = new List<WinEntry>();
    var matchedTray = new List<WinEntry>();

    foreach (long hVal in candidateHandles) {
      IntPtr hWnd = new IntPtr(hVal);
      if (!IsWindow(hWnd)) continue;
      if (GetParent(hWnd) != IntPtr.Zero) continue;
      if (GetWindow(hWnd, 4) != IntPtr.Zero) continue; // GW_OWNER: skip owned popups/helpers

      int style = GetWindowLong(hWnd, -16);
      if ((style & 0x40000000) != 0) continue; // WS_CHILD

      int exStyle = GetWindowLong(hWnd, -20);
      if ((exStyle & 0x00000080) != 0) continue; // WS_EX_TOOLWINDOW
      if ((exStyle & 0x08000000) != 0) continue; // WS_EX_NOACTIVATE

      uint pid = 0;
      GetWindowThreadProcessId(hWnd, out pid);
      if ((int)pid == irisPid) continue;

      var sbTitle = new StringBuilder(512);
      GetWindowText(hWnd, sbTitle, 512);
      string title = sbTitle.ToString().Trim();
      if (title.StartsWith("I.R.I.S.", StringComparison.OrdinalIgnoreCase)) continue;

      var sbClass = new StringBuilder(256);
      GetClassName(hWnd, sbClass, 256);
      string cls = sbClass.ToString();

      if (IsHelperTitleOrClass(title, cls)) continue;

      string procName = "";
      if (!procNames.TryGetValue((int)pid, out procName)) {
        try { procName = Process.GetProcessById((int)pid).ProcessName; } catch {}
      }

      bool vis = IsWindowVisible(hWnd);
      bool min = IsIconic(hWnd);

      RECT r;
      int rw = 0, rh = 0;
      if (GetWindowRect(hWnd, out r)) {
        rw = Math.Max(0, r.Right - r.Left);
        rh = Math.Max(0, r.Bottom - r.Top);
      }

      WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
      wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
      int nrw = 0, nrh = 0;
      if (GetWindowPlacement(hWnd, ref wp)) {
        nrw = Math.Max(0, wp.rcNormalPosition.Right - wp.rcNormalPosition.Left);
        nrh = Math.Max(0, wp.rcNormalPosition.Bottom - wp.rcNormalPosition.Top);
      }

      long area = Math.Max((long)rw * rh, (long)nrw * nrh);

      WinEntry entry = new WinEntry {
        Handle = hWnd,
        Pid = (int)pid,
        ProcName = procName,
        Title = title,
        ClassName = cls,
        IsVisible = vis,
        IsMinimized = min,
        Area = area,
        Score = (cls == "Chrome_WidgetWin_1" ? 100 : (cls == "ApplicationFrameWindow" ? 90 : 50)) + (!string.IsNullOrEmpty(title) ? 40 : 0) + (vis ? 200 : 0)
      };

      if (vis && !string.IsNullOrEmpty(title) && (min || (rw >= 80 && rh >= 40))) {
        allVisible.Add(entry);
      }

      if (isActiveTarget) continue;

      string pNorm = Norm(procName);
      string tNorm = Norm(title);
      bool procMatched = false;
      bool titleMatched = false;

      if (procCandidates != null) {
        for (int j = 0; j < procCandidates.Length; j++) {
          string tok = Norm(procCandidates[j]);
          if (string.IsNullOrEmpty(tok)) continue;
          if (tok == "__explorer_window__") {
            if (pNorm == "explorer" && (cls == "CabinetWClass" || cls == "ExploreWClass")) {
              procMatched = true;
              break;
            }
          } else if (!string.IsNullOrEmpty(pNorm) && (pNorm == tok || pNorm.Contains(tok))) {
            procMatched = true;
            break;
          }
        }
      }

      if (!procMatched && titleCandidates != null && !string.IsNullOrEmpty(tNorm)) {
        for (int j = 0; j < titleCandidates.Length; j++) {
          string tok = Norm(titleCandidates[j]);
          if (string.IsNullOrEmpty(tok) || tok.StartsWith("__")) continue;
          if (tNorm.Contains(tok)) {
            titleMatched = true;
            break;
          }
        }
      }

      if (!procMatched && !titleMatched) continue;
      if (procMatched) entry.Score += 300;
      if (string.IsNullOrEmpty(title)) continue;

      bool hasFrameOrApp = cls == "Chrome_WidgetWin_1" || cls == "ApplicationFrameWindow" || (style & 0x00C40000) != 0;
      if (vis && (min || (rw >= 200 && rh >= 120))) {
        matchedVisible.Add(entry);
      } else if (includeTray && !vis && procMatched && hasFrameOrApp && nrw >= 300 && nrh >= 200) {
        matchedTray.Add(entry);
      }
    }

    if (isActiveTarget) {
      var res = new List<WinEntry>();
      IntPtr fg = GetForegroundWindow();
      for (int i = 0; i < allVisible.Count; i++) {
        if (allVisible[i].Handle == fg) { res.Add(allVisible[i]); return res; }
      }
      if (allVisible.Count > 0) res.Add(allVisible[0]);
      return res;
    }

    Comparison<WinEntry> cmp = delegate(WinEntry a, WinEntry b) {
      int s = b.Score.CompareTo(a.Score);
      if (s != 0) return s;
      return b.Area.CompareTo(a.Area);
    };

    if (matchedVisible.Count > 0) {
      matchedVisible.Sort(cmp);
      return matchedVisible;
    }

    if (includeTray && matchedTray.Count > 0) {
      matchedTray.Sort(cmp);
      var single = new List<WinEntry>();
      single.Add(matchedTray[0]);
      return single;
    }

    return matchedVisible;
  }

  public static Screen ResolveTargetScreen(IntPtr hWnd, string monitorSpec) {
    Screen[] screens = Screen.AllScreens;
    if (screens == null || screens.Length == 0) return Screen.PrimaryScreen;
    if (screens.Length == 1) return screens[0];

    Screen current = Screen.FromHandle(hWnd);
    string spec = Norm(monitorSpec);

    if (spec == "1" || spec == "primary") {
      for (int i = 0; i < screens.Length; i++) if (screens[i].Primary) return screens[i];
      return screens[0];
    }
    if (spec == "2" || spec == "secondary") {
      for (int i = 0; i < screens.Length; i++) if (!screens[i].Primary) return screens[i];
      return screens[screens.Length > 1 ? 1 : 0];
    }
    if (spec == "left") {
      Screen best = screens[0];
      for (int i = 1; i < screens.Length; i++) if (screens[i].Bounds.X < best.Bounds.X) best = screens[i];
      return best;
    }
    if (spec == "right") {
      Screen best = screens[0];
      for (int i = 1; i < screens.Length; i++) if (screens[i].Bounds.X > best.Bounds.X) best = screens[i];
      return best;
    }
    if (spec == "other" || string.IsNullOrEmpty(spec)) {
      for (int i = 0; i < screens.Length; i++) if (screens[i].DeviceName != current.DeviceName) return screens[i];
      return screens[0];
    }
    return screens[0];
  }

  public static void ActivateWindow(IntPtr hWnd) {
    BringWindowToTop(hWnd);
    SetForegroundWindow(hWnd);
  }

  public static void BringToFront(IntPtr hWnd) {
    ShowWindow(hWnd, 5); // SW_SHOW
    ActivateWindow(hWnd);
  }

  public static bool MoveToMonitor(IntPtr hWnd, string monitorSpec) {
    Screen[] screens = Screen.AllScreens;
    if (screens == null || screens.Length < 2) return false;

    WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
    wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
    bool hasWp = GetWindowPlacement(hWnd, ref wp);

    bool wasHidden = !IsWindowVisible(hWnd);
    bool wasMin = IsIconic(hWnd);
    bool shouldMaximize = IsZoomed(hWnd) || (hasWp && (wp.showCmd == 3 || (wp.flags & 0x0002) != 0));

    if (wasHidden || wasMin) {
      ShowWindow(hWnd, 9); // SW_RESTORE
      System.Threading.Thread.Sleep(220);
    }
    if (IsZoomed(hWnd)) {
      shouldMaximize = true;
    }

    Screen src = Screen.FromHandle(hWnd);
    Screen dst = ResolveTargetScreen(hWnd, monitorSpec);

    if (src.DeviceName == dst.DeviceName) {
      if (shouldMaximize && !IsZoomed(hWnd)) {
        ShowWindow(hWnd, 3); // SW_MAXIMIZE
        System.Threading.Thread.Sleep(80);
      }
      ActivateWindow(hWnd);
      return true;
    }

    if (IsZoomed(hWnd)) {
      ShowWindow(hWnd, 9); // SW_RESTORE
      System.Threading.Thread.Sleep(180);
    }

    RECT rc;
    GetWindowRect(hWnd, out rc);
    int rawW = rc.Right - rc.Left;
    int rawH = rc.Bottom - rc.Top;
    if ((rawW < 300 || rawH < 200) && hasWp) {
      int wpW = wp.rcNormalPosition.Right - wp.rcNormalPosition.Left;
      int wpH = wp.rcNormalPosition.Bottom - wp.rcNormalPosition.Top;
      if (wpW >= 300 && wpH >= 200) {
        rawW = wpW;
        rawH = wpH;
      }
    }

    Rectangle dstArea = dst.WorkingArea;
    int w = (rawW >= 300) ? Math.Min(rawW, dstArea.Width) : (int)(dstArea.Width * 0.8);
    int h = (rawH >= 200) ? Math.Min(rawH, dstArea.Height) : (int)(dstArea.Height * 0.8);

    int newX = dstArea.Left + Math.Max(0, (dstArea.Width - w) / 2);
    int newY = dstArea.Top + Math.Max(0, (dstArea.Height - h) / 2);

    uint swpFlags = 0x0004 | 0x0040; // SWP_NOZORDER | SWP_SHOWWINDOW
    SetWindowPos(hWnd, IntPtr.Zero, newX, newY, w, h, swpFlags);
    System.Threading.Thread.Sleep(120);

    if (Screen.FromHandle(hWnd).DeviceName != dst.DeviceName) {
      SetWindowPos(hWnd, IntPtr.Zero, newX, newY, w, h, swpFlags);
      MoveWindow(hWnd, newX, newY, w, h, true);
      System.Threading.Thread.Sleep(100);
    }

    if (shouldMaximize) {
      System.Threading.Thread.Sleep(80);
      ShowWindow(hWnd, 3); // SW_MAXIMIZE
    }
    ActivateWindow(hWnd);
    return true;
  }

  public static void SnapSide(IntPtr hWnd, bool leftSide) {
    if (!IsWindowVisible(hWnd) || IsZoomed(hWnd) || IsIconic(hWnd)) {
      ShowWindow(hWnd, 9);
      System.Threading.Thread.Sleep(60);
    }
    Rectangle area = Screen.FromHandle(hWnd).WorkingArea;
    int halfW = area.Width / 2;
    int x = leftSide ? area.Left : area.Left + halfW;
    SetWindowPos(hWnd, IntPtr.Zero, x, area.Top, halfW, area.Height, 0x0004 | 0x0020 | 0x0040);
    MoveWindow(hWnd, x, area.Top, halfW, area.Height, true);
    BringToFront(hWnd);
  }
}
"@

if (-not ("IrisWinCtrl" -as [type])) {
  Add-Type -ReferencedAssemblies @("System.Windows.Forms", "System.Drawing") -TypeDefinition $csharp
}

$procArr = @()
if ($cfg.procCandidates) {
  foreach ($t in $cfg.procCandidates) { $procArr += [string]$t }
} elseif ($cfg.tokens) {
  foreach ($t in $cfg.tokens) { $procArr += [string]$t }
}

$titleArr = @()
if ($cfg.titleCandidates) {
  foreach ($t in $cfg.titleCandidates) { $titleArr += [string]$t }
} elseif ($cfg.tokens) {
  foreach ($t in $cfg.tokens) { $titleArr += [string]$t }
}

$targetSpec = if ($cfg.target) { [string]$cfg.target } elseif ($cfg.monitor) { [string]$cfg.monitor } else { "2" }
$includeTray = [bool]$cfg.includeTray
$wins = [IrisWinCtrl]::FindMatchingWindows([string[]]$procArr, [string[]]$titleArr, [bool]$cfg.isActiveTarget, $includeTray, [int]$cfg.irisPid)
$screenCount = ([System.Windows.Forms.Screen]::AllScreens).Length
$titles = @()
$acted = 0
if ($cfg.action -eq "close") {
  $targetWins = $wins
} elseif ($wins.Count -gt 0) {
  $targetWins = @($wins[0])
} else {
  $targetWins = @()
}

foreach ($w in $targetWins) {
  if ($w.Title) { $titles += $w.Title }
  $h = $w.Handle
  switch ($cfg.action) {
    "close" {
      [IrisWinCtrl]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
      $acted++
    }
    "minimize" {
      [IrisWinCtrl]::ShowWindowAsync($h, 6) | Out-Null
      $acted++
    }
    "maximize" {
      if (-not $w.IsVisible -or [IrisWinCtrl]::IsIconic($h)) {
        [IrisWinCtrl]::ShowWindow($h, 9) | Out-Null
        Start-Sleep -Milliseconds 50
      }
      [IrisWinCtrl]::ShowWindow($h, 3) | Out-Null
      [IrisWinCtrl]::BringToFront($h)
      $acted++
    }
    "restore" {
      if (-not $w.IsVisible -or [IrisWinCtrl]::IsIconic($h)) {
        [IrisWinCtrl]::ShowWindow($h, 9) | Out-Null
      }
      [IrisWinCtrl]::BringToFront($h)
      $acted++
    }
    "focus" {
      if (-not $w.IsVisible -or [IrisWinCtrl]::IsIconic($h)) {
        [IrisWinCtrl]::ShowWindow($h, 9) | Out-Null
      }
      [IrisWinCtrl]::BringToFront($h)
      $acted++
    }
    "move_monitor" {
      if ($screenCount -ge 2) {
        if ([IrisWinCtrl]::MoveToMonitor($h, $targetSpec)) { $acted++ }
      }
    }
    "snap_left" {
      [IrisWinCtrl]::SnapSide($h, $true)
      $acted++
    }
    "snap_right" {
      [IrisWinCtrl]::SnapSide($h, $false)
      $acted++
    }
  }
}

$killedProcs = 0
if ($cfg.action -eq "close" -and [bool]$cfg.allowKillByProcess -and -not [bool]$cfg.isActiveTarget) {
  Start-Sleep -Milliseconds 250
  $procs = Get-Process -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    if ($p.Id -eq [int]$cfg.irisPid) { continue }
    $pLow = $p.ProcessName.ToLowerInvariant()
    if ($pLow -eq "explorer") { continue }
    foreach ($t in $procArr) {
      $tLow = $t.ToLowerInvariant()
      if ($tLow -and -not $tLow.StartsWith("__") -and ($pLow -eq $tLow -or ($tLow.Length -ge 4 -and $pLow.Contains($tLow)))) {
        try {
          Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
          $killedProcs++
        } catch {}
        break
      }
    }
  }
}

$ok = ($acted -gt 0 -or $killedProcs -gt 0)
$reason = if ($ok) { "ok" } elseif ($cfg.action -eq "move_monitor" -and $screenCount -lt 2) { "single_monitor" } else { "not_found" }

@{
  ok = $ok
  reason = $reason
  matched = $acted
  killedProcs = $killedProcs
  screenCount = $screenCount
  titles = $titles
} | ConvertTo-Json -Compress
