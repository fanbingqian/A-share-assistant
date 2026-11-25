'use strict';

/**
 * 打包桌面端（Windows x64 绿色版）
 *
 * 关键设计：
 * - asar = false：把 server/ web/ data/ 原样放进 resources/app，
 *   server 内部 `path.join(__dirname, '..', 'data')` 语义保持不变，数据目录可写。
 * - 升级保留数据：打包前把旧包里的 data 备份，打包后回填，避免覆盖用户持仓/配置/日历。
 * - 产物附带「创建/卸载桌面快捷方式」脚本与使用说明。
 *
 * 用法：node scripts/build-desktop.js [--no-archive-data]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP_NAME = 'GlobalMarketMonitor';
const OUT_DIR = path.join(ROOT, 'dist');
const PKG_DIR = path.join(OUT_DIR, APP_NAME + '-win32-x64');
const APP_RES = path.join(PKG_DIR, 'resources', 'app');
const DATA_BACKUP = path.join(OUT_DIR, '.data-backup');
const PREV_PREFIX = '.prev-';

/**
 * 打包器在 overwrite=true 时会整目录删除旧版本（数百 MB），某些环境下
 * 删除/回收站操作会失败。改为先把旧版本 rename 到 .prev-*，让本次打包
 * 面对一个不存在的目标目录，再用 overwrite=false 构建，稳定性更好。
 */
function retireOldPackage() {
  if (!fs.existsSync(PKG_DIR)) return true;
  const prev = path.join(OUT_DIR, PREV_PREFIX + Date.now());
  try {
    fs.renameSync(PKG_DIR, prev);
    console.log('[build] 旧版本已移到 ' + path.basename(prev) + '（确认新版可用后可删除）');
  } catch (e) {
    console.log('[build] 无法移走旧版本目录（' + (e && e.message) + '）');
    return false;
  }
  // 更早的备份尽力清理；删不掉也不影响本次构建
  try {
    for (const name of fs.readdirSync(OUT_DIR)) {
      if (name.indexOf(PREV_PREFIX) !== 0) continue;
      const full = path.join(OUT_DIR, name);
      if (full === prev) continue;
      try { fs.rmSync(full, { recursive: true, force: true }); } catch (_) {}
    }
  } catch (_) {}
  return true;
}

/** 尽力清理历次构建留下的备份目录；删不掉不影响构建，交给用户自行清理 */
function cleanupBuildLeftovers() {
  try {
    for (const name of fs.readdirSync(OUT_DIR)) {
      if (name !== '.data-backup' && name.indexOf(PREV_PREFIX) !== 0) continue;
      try { fs.rmSync(path.join(OUT_DIR, name), { recursive: true, force: true }); } catch (_) {}
    }
  } catch (_) {}
}

/** 增量构建：只把源码同步进已有成品的 resources/app，不触碰 exe 与 data */
function syncAppFiles() {
  const dirs = ['server', 'web', 'desktop', 'hermes-bridge', 'scripts'];
  const files = ['package.json', 'app-icon.ico', 'app-icon.png', 'README.md'];
  let n = 0;
  for (const d of dirs) {
    const src = path.join(ROOT, d);
    if (!fs.existsSync(src)) continue;
    copyDir(src, path.join(APP_RES, d));
    n++;
  }
  for (const f of files) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(APP_RES, f));
    n++;
  }
  console.log('[build] 增量更新完成（' + n + ' 个源码项），data 目录原样保留');
}

function loadPackager() {
  let mod;
  try {
    mod = require('@electron/packager');
  } catch (e) {
    console.error('[build] 未安装 @electron/packager，请先执行 npm install');
    process.exit(1);
  }
  return typeof mod === 'function' ? mod : (mod.packager || mod.default);
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true, errorOnExist: false });
}

function dirSize(dir) {
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
    for (const en of entries) {
      const full = path.join(cur, en.name);
      if (en.isDirectory()) stack.push(full);
      else if (en.isFile()) {
        try { total += fs.statSync(full).size; files++; } catch (_) {}
      }
    }
  }
  return { bytes: total, files: files };
}

function mb(n) { return (n / 1024 / 1024).toFixed(1) + ' MB'; }

/* 运行时产物与开发资料不打包，减小体积、避免把调试缓存带出去 */
const IGNORE = [
  /^\/dist($|\/)/,
  /^\/node_modules($|\/)/,
  /^\/preview($|\/)/,
  /^\/docs($|\/)/,
  /^\/\.backup($|\/)/,
  /^\/\.workbuddy($|\/)/,
  /^\/package-lock\.json$/,
  /^\/_verify_tech\.js$/,
  /^\/界面预览\.png$/,
  /^\/交互页面与整体结构设计：合并为一个程序\.md$/,
  /^\/升级方案梳理\.md$/,
  /^\/架构与模块详解\.md$/,
  /^\/核心命题分析：预期与相对强弱\.md$/,
  /^\/系统现状诊断：自动化、数据、经验回流与事件归因\.md$/,
  /^\/设计方案：因子池与智能体复盘经验池\.md$/,
  /^\/选股方法论规格与程序覆盖矩阵\.md$/,
  /^\/项目结构与数据库说明\.md$/,
  /^\/data\/tmp($|\/)/,
  /^\/data\/chrome-check-profile($|\/)/,
  /^\/data\/chrome-final-check($|\/)/,
  /^\/data\/edge-check-profile($|\/)/,
  /^\/data\/[^/]+\.log$/,
  /^\/data\/desktop-selftest\.json$/,
  /^\/data\/alerts\.jsonl$/,
  /^\/data\/flow-state\.json$/,
  /^\/data\/index\.html$/,
  /^\/data\/node_modules($|\/)/,
  /^\/启动监控\.bat$/   // 桌面版自带 Node 运行时，旧的网页版 bat 不再需要
];

function writeShortcutScripts() {
  /* VBScript 以 UTF-16LE + BOM 写入，WSH 原生识别中文，避免 GBK/UTF-8 乱码 */
  const create = [
    'Option Explicit',
    'Dim sh, fso, base, desk, menu, lnk',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'base = fso.GetParentFolderName(WScript.ScriptFullName)',
    'If Not fso.FileExists(base & "\\' + APP_NAME + '.exe") Then',
    '  MsgBox "未找到 ' + APP_NAME + '.exe，请把本脚本放在程序目录内运行。", 16, "创建快捷方式"',
    '  WScript.Quit 1',
    'End If',
    'desk = sh.SpecialFolders("Desktop")',
    'Set lnk = sh.CreateShortcut(desk & "\\全球市场监测.lnk")',
    'lnk.TargetPath = base & "\\' + APP_NAME + '.exe"',
    'lnk.WorkingDirectory = base',
    'lnk.IconLocation = base & "\\' + APP_NAME + '.exe,0"',
    'lnk.Description = "全球市场监测 · A 股智能系统"',
    'lnk.WindowStyle = 1',
    'lnk.Save',
    'On Error Resume Next',
    'menu = sh.SpecialFolders("StartMenu") & "\\Programs"',
    'Set lnk2 = sh.CreateShortcut(menu & "\\全球市场监测.lnk")',
    'lnk2.TargetPath = base & "\\' + APP_NAME + '.exe"',
    'lnk2.WorkingDirectory = base',
    'lnk2.IconLocation = base & "\\' + APP_NAME + '.exe,0"',
    'lnk2.Description = "全球市场监测 · A 股智能系统"',
    'lnk2.Save',
    'MsgBox "已创建桌面快捷方式：全球市场监测" & vbCrLf & "（开始菜单同步添加）", 64, "完成"',
    ''
  ].join('\r\n');

  const remove = [
    'Option Explicit',
    'Dim sh, fso, desk, menu, n',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'desk = sh.SpecialFolders("Desktop") & "\\全球市场监测.lnk"',
    'menu = sh.SpecialFolders("StartMenu") & "\\Programs\\全球市场监测.lnk"',
    'On Error Resume Next',
    'If fso.FileExists(desk) Then fso.DeleteFile desk, True',
    'If fso.FileExists(menu) Then fso.DeleteFile menu, True',
    'n = MsgBox("已移除快捷方式。" & vbCrLf & vbCrLf & "是否同时删除程序目录中的运行数据（data 文件夹）？" & vbCrLf & "选择「否」可保留持仓、配置与历史快照。", 36, "卸载")',
    'If n = 6 Then',
    '  Dim base',
    '  base = fso.GetParentFolderName(WScript.ScriptFullName)',
    '  If fso.FolderExists(base & "\\resources\\app\\data") Then fso.DeleteFolder base & "\\resources\\app\\data", True',
    '  MsgBox "已删除运行数据。", 64, "卸载"',
    'End If',
    ''
  ].join('\r\n');

  fs.writeFileSync(path.join(PKG_DIR, '创建桌面快捷方式.vbs'), '\ufeff' + create, 'utf16le');
  fs.writeFileSync(path.join(PKG_DIR, '卸载快捷方式.vbs'), '\ufeff' + remove, 'utf16le');
}

function writeReadme(version) {
  const lines = [
    '全球市场监测 · A 股智能系统（桌面端 v' + version + '）',
    '',
    '一、怎么用',
    '  1. 双击 GlobalMarketMonitor.exe 即可启动，无需安装 Node、无需命令行。',
    '  2. 首次启动会在本机拉起内置数据服务，冷启动约 10-40 秒（要抓行情/新闻）。',
    '  3. 想放到桌面：双击「创建桌面快捷方式.vbs」，会同时加进开始菜单。',
    '',
    '二、窗口与托盘',
    '  · 点窗口右上角关闭 = 收进系统托盘，后台采集与定时任务继续运行。',
    '  · 右键托盘图标可：打开主界面 / 在浏览器打开 / 重启后台服务 / 打开数据目录 / 退出。',
    '  · 托盘「退出」会同时停止本应用拉起的后台服务。',
    '  · 快捷键：F5 或 Ctrl+R 刷新，F12 开发者工具，Ctrl+Q 退出。',
    '',
    '三、数据放在哪',
    '  安装目录\\resources\\app\\data\\',
    '  · config.json       智能体与数据源配置',
    '  · holdings.json     持仓',
    '  · my-picks.json     我的选股',
    '  · calendar\\         日程与事件',
    '  · daily\\            每日选股 / 复盘快照',
    '  · desktop.log       桌面端日志（启动失败先看这里）',
    '  · desktop-server.log 后台服务日志',
    '',
    '四、与 Windows 计划任务的关系',
    '  如果之前配过 GlobalMarketMonitor-Watchdog 常驻任务，两者会共用 8777 端口：',
    '  · 任务先占端口 → 本应用直接复用，不重复启动；',
    '  · 本应用先启动 → 任务检测到健康检查通过，不会重复拉起。',
    '  只想用桌面端时，可在「任务计划程序」中停用该任务，改由桌面端 + 托盘常驻承担。',
    '',
    '五、升级',
    '  用新版覆盖安装目录即可，运行数据可保留（重新打包时脚本会自动备份并回填 data）。',
    '',
    '六、卸载',
    '  双击「卸载快捷方式.vbs」移除快捷方式；如不再使用，直接删除整个程序目录。',
    '  程序不写注册表、不装服务、不联网上报，数据全部留在本机。',
    '',
    '免责声明：本软件为个人研究工具，所有内容基于公开数据与确定性计算，',
    '仅供参考，不构成投资建议。市场有风险，投资需谨慎。',
    ''
  ].join('\r\n');
  fs.writeFileSync(path.join(PKG_DIR, '使用说明.txt'), '\ufeff' + lines, 'utf8');
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const packager = loadPackager();

  if (!fs.existsSync(path.join(ROOT, 'app-icon.ico'))) {
    console.error('[build] 缺少 app-icon.ico');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron'))) {
    console.error('[build] 缺少 electron 依赖，请先执行 npm install');
    process.exit(1);
  }

  const exePath = path.join(PKG_DIR, APP_NAME + '.exe');
  const wantFull = process.argv.indexOf('--full') !== -1;
  const havePackage = fs.existsSync(exePath) && fs.existsSync(APP_RES);

  if (havePackage && !wantFull) {
    // 常规升级：只同步源码，保留 exe 与 data，避免整目录删除被系统锁定
    console.log('[build] 已有成品，走增量更新（完整重建请加 --full）');
    syncAppFiles();
  } else {
    // 完整构建：先备份 data，再把旧包移开，最后让打包器面对一个空目标
    const oldData = path.join(APP_RES, 'data');
    const keepData = process.argv.indexOf('--no-archive-data') === -1;
    if (keepData && fs.existsSync(oldData)) {
      rmrf(DATA_BACKUP);
      copyDir(oldData, DATA_BACKUP);
      const s = dirSize(DATA_BACKUP);
      console.log('[build] 已备份旧运行数据 ' + s.files + ' 个文件 / ' + mb(s.bytes));
    }

    const retired = retireOldPackage();
    if (!retired) {
      console.log('[build] 旧目录被占用，自动降级为增量更新（数据不受影响）');
      syncAppFiles();
      rmrf(DATA_BACKUP);
    } else {
      console.log('[build] 开始完整打包 ' + APP_NAME + ' v' + pkg.version + ' ...');
      const t0 = Date.now();
      const paths = await packager({
        dir: ROOT,
        name: APP_NAME,
        platform: 'win32',
        arch: 'x64',
        out: OUT_DIR,
        overwrite: false,
        icon: path.join(ROOT, 'app-icon.ico'),
        asar: false,
        prune: true,
        appVersion: pkg.version,
        appCopyright: 'Local personal research tool',
        ignore: IGNORE,
        win32metadata: {
          CompanyName: 'Local',
          FileDescription: '全球市场监测 · A 股智能系统',
          ProductName: '全球市场监测',
          InternalName: APP_NAME,
          OriginalFilename: APP_NAME + '.exe',
          'requested-execution-level': 'asInvoker'
        }
      });
      console.log('[build] 打包完成，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
      console.log('[build] 输出：' + paths.join(', '));

      if (keepData && fs.existsSync(DATA_BACKUP)) {
        const newData = path.join(APP_RES, 'data');
        rmrf(newData);
        copyDir(DATA_BACKUP, newData);
        rmrf(DATA_BACKUP);
        console.log('[build] 已回填旧运行数据到新包');
      }
    }
  }

  if (!fs.existsSync(path.join(PKG_DIR, APP_NAME + '.exe'))) {
    console.error('[build] 未找到生成的 exe：' + PKG_DIR);
    process.exit(1);
  }

  // 4) 清理自检/日志残留（升级时可能被旧数据备份带回来）
  ['desktop-selftest.json', 'desktop.log', 'desktop-server.log'].forEach(name => {
    try { fs.unlinkSync(path.join(APP_RES, 'data', name)); } catch (_) {}
  });

  // 5) 附带分发脚本
  writeShortcutScripts();
  writeReadme(pkg.version);

  cleanupBuildLeftovers();

  const total = dirSize(PKG_DIR);
  const exeSize = fs.statSync(path.join(PKG_DIR, APP_NAME + '.exe')).size;
  console.log('[build] exe ' + mb(exeSize) + ' · 整包 ' + total.files + ' 文件 / ' + mb(total.bytes));
  console.log('[build] 目录：' + PKG_DIR);
}

main().catch(e => {
  console.error('[build] 失败：' + (e && e.stack || e));
  process.exit(1);
});
