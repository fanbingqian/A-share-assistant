' ============================================================
' Hermes 桥接 WSL 开机自启（静默，无黑窗）
' 作用：Windows 登录后唤醒 Ubuntu 发行版；WSL 内 systemd user
'       服务 hermes-bridge.service（已 enable + Linger=yes）会
'       自动拉起 8765 桥接，让官方 Hermes 通道开机即用。
' 原理：不直接调 python，只唤醒发行版，避免重复启动进程。
' 安装：把本文件复制到「启动」文件夹：
'   C:\Users\58451\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup
' 卸载：从启动文件夹删除本文件即可（不影响桥接本身）。
' ============================================================
Option Explicit
Dim ws, cmd
Set ws = CreateObject("Wscript.Shell")

' 先给系统一点时间完成登录初始化
WScript.Sleep 5000

' 静默唤醒 Ubuntu（窗口样式 0 = 隐藏）。--exec true 保持发行版运行不立即回收。
cmd = """C:\Windows\System32\wsl.exe"" -d Ubuntu --exec sh -c ""echo hermes-bridge autostart"" "
ws.Run cmd, 0, False

WScript.Quit 0
