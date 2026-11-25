' ============================================================
' Hermes 官方链路开机自启（Windows 侧桥接 + 唤醒 WSL）
'
' 背景：Hyper-V 防火墙默认入站 Block，Windows 无法访问 WSL 内 8765。
'       改为 Windows 侧 127.0.0.1:8765 监听，内部用 wsl.exe 调官方 Hermes CLI。
'
' 作用：
'   1) 静默唤醒 Ubuntu 发行版（让 Hermes CLI / 记忆 / 技能可用）
'   2) 启动 hermes-bridge-win.js（Windows 侧 OpenAI 兼容端点）
'
' 安装：复制到：
'   C:\Users\58451\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup
' 卸载：从启动文件夹删除本文件即可。
' ============================================================
Option Explicit
Dim ws, cmd, nodeExe, script

Set ws = CreateObject("Wscript.Shell")

' 给登录初始化留一点时间
WScript.Sleep 3000

' 1) 静默唤醒 WSL Ubuntu（窗口样式 0 = 隐藏）
cmd = """C:\Windows\System32\wsl.exe"" -d Ubuntu --exec sh -c ""echo hermes-bridge autostart"" "
ws.Run cmd, 0, False

' 2) 启动 Windows 侧 Hermes 桥接；若已在运行，Node 会因端口占用自行退出，无副作用
nodeExe = "C:\Program Files\nodejs\node.exe"
script = "D:\WorkBuddy\projects\GlobalMarketMonitor\hermes-bridge\hermes-bridge-win.js"
cmd = """" & nodeExe & """ """ & script & """"
ws.Run cmd, 0, False

WScript.Quit 0
