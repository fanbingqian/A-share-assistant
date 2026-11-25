' GlobalMarketMonitor - hidden watchdog launcher (no console window)
' Placed in the Windows Startup folder as a shortcut; the real scripts live on D:.
Dim ws, root, ps1, cmd
Set ws = CreateObject("WScript.Shell")
root = "D:\WorkBuddy\projects\GlobalMarketMonitor"
ps1 = root & "\scripts\watchdog.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & ps1 & Chr(34)
ws.CurrentDirectory = root
ws.Run cmd, 0, False
