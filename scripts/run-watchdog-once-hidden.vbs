' ============================================================
' Silent launcher for the per-minute scheduled health check.
' Why: powershell.exe is a console (CUI) program. When Task Scheduler
'      runs it with an Interactive logon token, Windows creates a
'      conhost window before PowerShell can apply -WindowStyle Hidden,
'      so a black terminal frame flashes on the desktop every minute.
'      wscript.exe is a GUI program (no console of its own); it then
'      starts PowerShell with SW_HIDE (0), so no window is ever shown.
' Install: Task Scheduler action = wscript.exe "<this file>"
' ============================================================
Option Explicit
Dim ws, root, ps1, cmd
Set ws = CreateObject("WScript.Shell")
root = "D:\WorkBuddy\projects\GlobalMarketMonitor"
ps1  = root & "\scripts\watchdog.ps1"
cmd  = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & ps1 & Chr(34) & " -Once"
ws.CurrentDirectory = root
ws.Run cmd, 0, False
WScript.Quit 0
