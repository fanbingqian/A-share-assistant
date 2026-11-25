@echo off
chcp 936 >nul
title 全球市场监测与报警系统
cd /d "%~dp0"

rem 若服务已在运行，则只打开界面，避免重复启动导致端口占用
netstat -ano | findstr ":8777" | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo 检测到监控服务已在运行，正在打开界面...
  start "" http://127.0.0.1:8777
  timeout /t 2 >nul
  exit /b 0
)

set "NODE_EXE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE_EXE=node"
if not defined NODE_EXE (
  if exist "C:\Users\58451\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" set "NODE_EXE=C:\Users\58451\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
)
if not defined NODE_EXE (
  echo 未找到 Node.js，请先安装 Node.js 18 或更高版本。
  echo 官网： https://nodejs.org/
  pause
  exit /b 1
)

echo.
echo   全球市场监测与报警系统
echo   ------------------------------------------------
echo   服务地址： http://127.0.0.1:8777
echo   启动后会自动打开独立应用窗口（Edge / Chrome）。
echo   保持本窗口开启即为持续监控；关闭窗口即停止。
echo   首次打开请点击页面任意处，以启用浏览器声音。
echo   ------------------------------------------------
echo.
echo   数据源： CNBC / 新浪财经 / 东方财富 / Yahoo Finance
echo   新闻源： Google News / BBC / Guardian / Al Jazeera / 中新网
echo.

"%NODE_EXE%" server\server.js %*

echo.
echo 服务已停止。
pause
