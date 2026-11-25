' ============================================================
' Hermes official channel autostart (Windows-side bridge + wake WSL)
'
' Why: WSL2 Ubuntu may be reclaimed to "Stopped" by Windows. Then the WSL
'      systemd bridge on 8765 disappears and the app shows "fetch failed".
'      This script starts a Windows-side shim on 127.0.0.1:8765 which calls
'      the official Hermes CLI via wsl.exe (WSL is auto-woken on each call).
'
' Install: copy to shell:startup
' Uninstall: delete this file from the Startup folder.
' ============================================================
Option Explicit
Dim ws, fso, cmd, nodeExe, script

Set ws = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Give logon initialization a moment
WScript.Sleep 3000

' 1) Silently wake Ubuntu (window style 0 = hidden)
cmd = """C:\Windows\System32\wsl.exe"" -d Ubuntu --exec sh -c ""echo hermes-bridge autostart"" "
ws.Run cmd, 0, False

' 2) Start the Windows-side Hermes bridge. If 8765 is already taken by another
'    instance (or by WSL localhost forwarding), Node exits on EADDRINUSE - safe.
nodeExe = "C:\Users\58451\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "C:\Program Files\nodejs\node.exe"
script = "D:\WorkBuddy\projects\GlobalMarketMonitor\hermes-bridge\hermes-bridge-win.js"
cmd = """" & nodeExe & """ """ & script & """"
ws.Run cmd, 0, False

WScript.Quit 0
