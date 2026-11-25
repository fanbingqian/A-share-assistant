'use strict';

/**
 * 创建 / 移除桌面与开始菜单快捷方式（命令行静默版，不弹窗）
 *
 * 用 WSH 的 WScript.Shell 生成 .lnk；VBScript 以 UTF-16LE + BOM 写入，
 * 保证中文名称在中文 Windows 上不乱码。
 *
 * 用法：
 *   node scripts/install-shortcuts.js
 *   node scripts/install-shortcuts.js --uninstall
 *   node scripts/install-shortcuts.js --exe=路径\GlobalMarketMonitor.exe
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_EXE = path.join(ROOT, 'dist', 'GlobalMarketMonitor-win32-x64', 'GlobalMarketMonitor.exe');
const LNK_NAME = '全球市场监测.lnk';

function arg(name) {
  const hit = process.argv.find(a => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.slice(name.length + 3) : null;
}

const EXE = arg('exe') || DEFAULT_EXE;
const UNINSTALL = process.argv.indexOf('--uninstall') !== -1;

function vbsEscape(s) { return String(s).replace(/"/g, '""'); }

function runVbs(code) {
  const tmp = path.join(os.tmpdir(), 'gmm-shortcut-' + process.pid + '.vbs');
  try {
    fs.writeFileSync(tmp, '\ufeff' + code, 'utf16le');
    const out = execFileSync('cscript', ['//nologo', tmp], { encoding: 'utf8', timeout: 30000 });
    if (out && out.trim()) process.stdout.write(out.trim() + '\n');
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function install() {
  if (!fs.existsSync(EXE)) {
    console.error('[shortcuts] 找不到 exe：' + EXE);
    process.exit(1);
  }
  const e = vbsEscape(EXE);
  const lines = [
    'Option Explicit',
    'Dim sh, fso, exe, desk, menu, lnk',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'exe = "' + e + '"',
    'If Not fso.FileExists(exe) Then WScript.Quit 2',
    'desk = sh.SpecialFolders("Desktop")',
    'Set lnk = sh.CreateShortcut(desk & "\\' + LNK_NAME + '")',
    'lnk.TargetPath = exe',
    'lnk.WorkingDirectory = fso.GetParentFolderName(exe)',
    'lnk.IconLocation = exe & ",0"',
    'lnk.Description = "全球市场监测 · A 股智能系统"',
    'lnk.WindowStyle = 1',
    'lnk.Save',
    'On Error Resume Next',
    'menu = sh.SpecialFolders("StartMenu") & "\\Programs"',
    'Set lnk = sh.CreateShortcut(menu & "\\' + LNK_NAME + '")',
    'lnk.TargetPath = exe',
    'lnk.WorkingDirectory = fso.GetParentFolderName(exe)',
    'lnk.IconLocation = exe & ",0"',
    'lnk.Description = "全球市场监测 · A 股智能系统"',
    'lnk.WindowStyle = 1',
    'lnk.Save',
    'WScript.Echo "[shortcuts] desktop + start-menu shortcuts created"',
    ''
  ];
  runVbs(lines.join('\r\n'));
  console.log('[shortcuts] 目标：' + EXE);
}

function uninstall() {
  const lines = [
    'Option Explicit',
    'Dim sh, fso, desk, menu',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'desk = sh.SpecialFolders("Desktop") & "\\' + LNK_NAME + '"',
    'menu = sh.SpecialFolders("StartMenu") & "\\Programs\\' + LNK_NAME + '"',
    'On Error Resume Next',
    'If fso.FileExists(desk) Then fso.DeleteFile desk, True',
    'If fso.FileExists(menu) Then fso.DeleteFile menu, True',
    'WScript.Echo "[shortcuts] shortcuts removed"',
    ''
  ];
  runVbs(lines.join('\r\n'));
}

(UNINSTALL ? uninstall : install)();
