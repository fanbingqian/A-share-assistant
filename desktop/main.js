'use strict';

/**
 * 全球市场监测 · 桌面端主进程
 *
 * 设计要点：
 * 1. 内嵌运行：把现有 server/server.js 作为子进程拉起（Electron 自带 Node 运行时，
 *    打包后不依赖本机是否安装 Node）。
 * 2. 两种托管模式：
 *    - 端口上已有健康服务（例如 Windows 计划任务看门狗拉起的常驻实例）→ 直接复用，不重复启动；
 *    - 没有服务 → 自己 fork 一个，退出应用时才回收（外部托管的实例永不擅自杀掉）。
 * 3. 关闭窗口 = 隐藏到托盘，后台采集/定时任务继续跑；托盘「退出」才真正结束进程。
 */

const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { fork } = require('node:child_process');

const APP_ROOT = app.getAppPath();
const ICON = path.join(APP_ROOT, 'app-icon.ico');
const SERVER_ENTRY = path.join(APP_ROOT, 'server', 'server.js');
const DATA_DIR = path.join(APP_ROOT, 'data');
const DESKTOP_LOG = path.join(DATA_DIR, 'desktop.log');
const SERVER_LOG = path.join(DATA_DIR, 'desktop-server.log');

const PORT = Number(process.env.GMM_PORT || 8777);
const BASE = 'http://127.0.0.1:' + PORT;
const HOME_URL = BASE + '/';
const HEALTH_URL = '/api/health';

const BOOT_TIMEOUT = 60000;

let win = null;
let splash = null;
let tray = null;
let serverProc = null;
let ownsServer = false;      // true = 本应用拉起的服务，退出时回收
let externalServer = false;  // true = 端口上已有外部托管实例
let isQuitting = false;
let trayHinted = false;
let bootFailed = false;

/* ----------------------------- 日志 ----------------------------- */

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function rotate(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (st.size > maxBytes) {
      const old = file + '.1';
      try { fs.unlinkSync(old); } catch (_) {}
      fs.renameSync(file, old);
    }
  } catch (_) {}
}

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
  try {
    ensureDir(DATA_DIR);
    rotate(DESKTOP_LOG, 2 * 1024 * 1024);
    fs.appendFileSync(DESKTOP_LOG, line, 'utf8');
  } catch (_) {}
  try { process.stdout.write(line); } catch (_) {}
}

/* --------------------------- 服务探活 --------------------------- */

function probe(timeout) {
  return new Promise(resolve => {
    const req = http.get({
      host: '127.0.0.1',
      port: PORT,
      path: HEALTH_URL,
      timeout: timeout || 1500,
      headers: { 'User-Agent': 'gmm-desktop-probe' }
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitReady(totalMs) {
  const deadline = Date.now() + (totalMs || BOOT_TIMEOUT);
  while (Date.now() < deadline) {
    if (await probe(1200)) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

function httpGetText(url, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeout || 8000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: body }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/* --------------------------- 启动服务 --------------------------- */

function startServer() {
  if (serverProc) return;

  ensureDir(DATA_DIR);
  rotate(SERVER_LOG, 4 * 1024 * 1024);

  let stream = null;
  try {
    stream = fs.createWriteStream(SERVER_LOG, { flags: 'a' });
    stream.write('\n===== ' + new Date().toISOString() + ' desktop spawn =====\n');
  } catch (_) {}

  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    GMM_DESKTOP: '1',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: ''   // 宿主任意注入的 NODE_OPTIONS 不应影响内置服务
  });

  try {
    serverProc = fork(SERVER_ENTRY, ['--no-browser'], {
      cwd: APP_ROOT,
      env: env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    ownsServer = true;
    log('已拉起内置服务 pid=' + serverProc.pid + ' port=' + PORT);

    if (serverProc.stdout && stream) serverProc.stdout.pipe(stream, { end: false });
    if (serverProc.stderr) {
      serverProc.stderr.on('data', buf => {
        const text = buf.toString('utf8');
        try { if (stream) stream.write(text); } catch (_) {}
        if (/Error|error|失败|异常/.test(text)) log('server stderr: ' + text.trim().slice(0, 400));
      });
    }

    serverProc.on('exit', (code, signal) => {
      log('内置服务退出 code=' + code + ' signal=' + signal);
      serverProc = null;
      ownsServer = false;
      if (!isQuitting) refreshTray();
    });
    serverProc.on('error', e => {
      log('内置服务启动失败: ' + (e && e.message));
      serverProc = null;
      ownsServer = false;
    });
  } catch (e) {
    log('fork 失败，降级为主进程内运行: ' + (e && e.message));
    bootInProcess();
  }
}

function bootInProcess() {
  try {
    process.argv.push('--no-browser');
    require(SERVER_ENTRY);
    ownsServer = true;
    log('已在主进程内启动服务');
  } catch (e) {
    log('主进程内启动服务失败: ' + (e && e.message));
    bootFailed = true;
  }
}

function stopServer() {
  if (!serverProc) return;
  const pid = serverProc.pid;
  try { serverProc.kill(); } catch (_) {}
  // Windows 上 TerminateProcess 是硬杀，给 800ms 缓冲后再确认
  setTimeout(() => {
    try { if (serverProc && !serverProc.killed) serverProc.kill('SIGKILL'); } catch (_) {}
  }, 800);
  log('已停止内置服务 pid=' + pid);
  serverProc = null;
  ownsServer = false;
}

/* --------------------------- 窗口状态 --------------------------- */

function statePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  const def = { width: 1480, height: 960, x: undefined, y: undefined, maximized: false };
  let st = def;
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (raw && typeof raw === 'object') st = Object.assign(def, raw);
  } catch (_) {}

  // 防止把窗口恢复到已拔掉的显示器上
  try {
    const displays = screen.getAllDisplays();
    if (typeof st.x === 'number' && typeof st.y === 'number') {
      const visible = displays.some(d => {
        const b = d.workArea;
        return st.x >= b.x - 40 && st.y >= b.y - 40 &&
          st.x < b.x + b.width - 80 && st.y < b.y + b.height - 80;
      });
      if (!visible) { st.x = undefined; st.y = undefined; }
    }
  } catch (_) {}
  return st;
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    ensureDir(app.getPath('userData'));
    fs.writeFileSync(statePath(), JSON.stringify({
      width: b.width, height: b.height, x: b.x, y: b.y,
      maximized: win.isMaximized()
    }), 'utf8');
  } catch (_) {}
}

/* ---------------------------- 闪屏 ----------------------------- */

function showSplash() {
  splash = new BrowserWindow({
    width: 400, height: 232,
    frame: false,
    resizable: false,
    movable: false,
    show: false,
    center: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#101729',
    icon: ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  splash.once('ready-to-show', () => {
    if (splash && !splash.isDestroyed()) splash.show();
  });
  splash.on('closed', () => { splash = null; });
}

function closeSplash() {
  if (splash && !splash.isDestroyed()) {
    try { splash.close(); } catch (_) {}
  }
  splash = null;
}

/* ---------------------------- 主窗口 ---------------------------- */

function createWindow(silent) {
  const st = loadWindowState();

  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    x: st.x,
    y: st.y,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#f5f6f8',
    title: '全球市场监测 · A 股智能系统',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  if (st.maximized) win.maximize();

  win.once('ready-to-show', () => {
    closeSplash();
    if (!silent) {
      win.show();
      if (st.maximized) win.maximize();
    }
  });

  // 关闭 = 收进托盘（后台采集不停）
  win.on('close', e => {
    saveWindowState();
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
    hintTrayOnce();
  });

  win.on('resize', debounce(saveWindowState, 600));
  win.on('move', debounce(saveWindowState, 600));
  win.on('closed', () => { win = null; });

  // 外部链接交给系统浏览器，避免在应用内打开陌生页面
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(BASE)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(BASE)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });

  win.webContents.on('render-process-gone', (e, details) => {
    log('渲染进程异常: ' + JSON.stringify(details));
  });

  // 快捷键（去掉系统菜单后需要自己接管）
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = String(input.key || '').toLowerCase();
    if (k === 'f5' || (input.control && k === 'r')) {
      e.preventDefault(); win.webContents.reload();
    } else if (k === 'f12' || (input.control && input.shift && k === 'i')) {
      e.preventDefault(); win.webContents.toggleDevTools();
    } else if (input.control && k === 'q') {
      e.preventDefault(); quitApp();
    }
  });

  win.loadURL(HOME_URL).catch(err => {
    log('加载页面失败: ' + (err && err.message));
  });
}

function debounce(fn, ms) {
  let t = null;
  return function () {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    if (!bootFailed) createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hintTrayOnce() {
  if (trayHinted) return;
  trayHinted = true;
  if (tray && typeof tray.displayBalloon === 'function') {
    try {
      tray.displayBalloon({
        title: '仍在后台运行',
        content: '窗口已收进托盘，数据采集与定时任务继续。右键托盘图标可退出。',
        iconType: 'info'
      });
    } catch (_) {}
  }
}

/* ---------------------------- 托盘 ----------------------------- */

function statusLabel() {
  if (ownsServer) return '后台服务：本应用托管 · 端口 ' + PORT;
  if (externalServer) return '后台服务：常驻任务托管 · 端口 ' + PORT;
  return '后台服务：未运行 · 端口 ' + PORT;
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip('全球市场监测 · ' + statusLabel());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: showWindow },
    { label: '在浏览器中打开', click: () => shell.openExternal(HOME_URL).catch(() => {}) },
    { type: 'separator' },
    { label: statusLabel(), enabled: false },
    {
      label: ownsServer ? '重启后台服务' : '重启后台服务（由常驻任务托管，不可用）',
      enabled: ownsServer,
      click: () => restartServer(true)
    },
    { type: 'separator' },
    { label: '打开数据目录', click: openDataDir },
    { label: '打开桌面端日志', click: () => shell.openPath(DESKTOP_LOG).catch(() => {}) },
    { type: 'separator' },
    { label: '关于', click: showAbout },
    { label: '退出（停止服务）', click: quitApp }
  ]));
}

function createTray() {
  let img = nativeImage.createFromPath(ICON);
  if (img.isEmpty()) {
    img = nativeImage.createEmpty();
  }
  tray = new Tray(img);
  tray.setToolTip('全球市场监测 · 正在启动');
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  refreshTray();
}

function openDataDir() {
  try {
    ensureDir(DATA_DIR);
    shell.openPath(DATA_DIR);
  } catch (_) {}
}

function showAbout() {
  const detail = [
    '版本 ' + app.getVersion(),
    'Electron ' + process.versions.electron + ' · Chromium ' + process.versions.chrome,
    '',
    '本地服务：' + BASE,
    '数据目录：' + DATA_DIR,
    '',
    '预判与选股由确定性量化模块完成；智能体只在主动点击时按需复盘，不预测涨跌。'
  ].join('\n');
  dialog.showMessageBox(win || undefined, {
    type: 'info',
    title: '关于',
    message: '全球市场监测 · A 股智能系统',
    detail: detail,
    buttons: ['知道了']
  });
}

/* ------------------------ 启动流程 ---------------------------- */

/** 无界面自检：只验证「探活 → 必要时拉起服务 → 首页可访问 → 回收」，用于命令行验收 */
async function selfTest() {
  const aliveFirst = await probe(1200);
  console.log('[self-test] 初始探活=' + aliveFirst + ' port=' + PORT);
  if (aliveFirst) externalServer = true;
  else startServer();

  const ok = await waitReady(BOOT_TIMEOUT);
  let pageStatus = 0, pageLen = 0, title = '';
  if (ok) {
    try {
      const r = await httpGetText(HOME_URL, 10000);
      pageStatus = r.status;
      pageLen = r.body.length;
      const m = r.body.match(/<title>([^<]*)<\/title>/i);
      title = m ? m[1].trim() : '';
    } catch (e) {
      console.log('[self-test] 首页请求失败: ' + (e && e.message));
    }
  }
  const mode = externalServer ? 'reuse-external' : (ownsServer ? 'own-fork' : 'unknown');
  const pass = ok && pageStatus === 200 && pageLen > 2000;
  const report = {
    at: new Date().toISOString(), pass: pass, ready: ok, mode: mode,
    port: PORT, pageStatus: pageStatus, pageLen: pageLen, title: title,
    electron: process.versions.electron, appRoot: APP_ROOT
  };
  console.log('[self-test] ' + JSON.stringify(report));
  // Windows 下 electron.exe 是 GUI 子系统程序，stdout 未必能回到终端，结果同时落盘
  try {
    ensureDir(DATA_DIR);
    fs.writeFileSync(path.join(DATA_DIR, 'desktop-selftest.json'), JSON.stringify(report, null, 1), 'utf8');
  } catch (_) {}

  if (ownsServer) stopServer();
  setTimeout(() => app.exit(pass ? 0 : 1), 400);
}

/** 截图模式：加载真实页面后生成 PNG，用于核对窗口渲染效果 */
async function screenshot(file) {
  const aliveFirst = await probe(1200);
  if (aliveFirst) externalServer = true;
  else startServer();

  const ok = await waitReady(BOOT_TIMEOUT);
  if (!ok) {
    log('[shot] 服务未就绪，放弃截图');
    if (ownsServer) stopServer();
    setTimeout(() => app.exit(1), 200);
    return;
  }

  createWindow(true);
  win.webContents.once('did-finish-load', async () => {
    await new Promise(r => setTimeout(r, 3500));
    try {
      const img = await win.webContents.capturePage();
      const size = img.getSize();
      fs.writeFileSync(file, img.toPNG());
      log('[shot] saved ' + file + ' ' + size.width + 'x' + size.height);
    } catch (e) {
      log('[shot] 截图失败: ' + (e && e.message));
    }
    if (ownsServer) stopServer();
    setTimeout(() => app.exit(0), 300);
  });
}

async function boot() {
  app.setAppUserModelId('com.local.globalmarketmonitor');
  Menu.setApplicationMenu(null);

  if (process.argv.indexOf('--self-test') !== -1) return selfTest();

  const shotArg = process.argv.find(a => a.indexOf('--shot=') === 0);
  if (shotArg) return screenshot(shotArg.slice('--shot='.length));

  createTray();
  showSplash();

  const alive = await probe(1500);
  if (alive) {
    externalServer = true;
    log('检测到端口 ' + PORT + ' 上已有服务，直接复用');
  } else {
    startServer();
  }
  refreshTray();

  const ready = await waitReady(BOOT_TIMEOUT);

  if (!ready) {
    bootFailed = true;
    closeSplash();
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: '启动失败',
      message: '本地数据服务未能在 ' + Math.round(BOOT_TIMEOUT / 1000) + ' 秒内就绪',
      detail: '可能原因：端口 ' + PORT + ' 被其它程序占用，或首次抓取耗时过长。\n\n日志：' + SERVER_LOG,
      buttons: ['打开日志', '重试', '退出'],
      defaultId: 0,
      cancelId: 2
    });
    if (choice === 0) shell.openPath(SERVER_LOG).catch(() => {});
    if (choice === 1) {
      bootFailed = false;
      if (!serverProc) startServer();
      if (await waitReady(BOOT_TIMEOUT)) {
        createWindow();
        refreshTray();
        return;
      }
    }
    isQuitting = true;
    stopServer();
    app.quit();
    return;
  }

  createWindow();
  refreshTray();
  log('桌面端就绪，模式=' + (externalServer ? '复用外部服务' : '本应用托管'));
}

async function restartServer(showFeedback) {
  if (!ownsServer) {
    if (showFeedback) {
      dialog.showMessageBox(win || undefined, {
        type: 'info',
        title: '无法重启',
        message: '当前后台服务由 Windows 常驻任务托管',
        detail: '请在「任务计划程序」中重启 GlobalMarketMonitor-Watchdog，或停用该任务后由本应用托管。',
        buttons: ['知道了']
      });
    }
    return { ok: false, reason: 'external' };
  }
  log('手动重启后台服务');
  stopServer();
  await new Promise(r => setTimeout(r, 600));
  startServer();
  const ok = await waitReady(BOOT_TIMEOUT);
  refreshTray();
  if (ok && win && !win.isDestroyed()) win.webContents.reload();
  return { ok };
}

function quitApp() {
  isQuitting = true;
  saveWindowState();
  stopServer();
  app.quit();
}

/* --------------------------- 生命周期 --------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { showWindow(); });

  if (process.env.GMM_DISABLE_GPU === '1') app.disableHardwareAcceleration();

  app.whenReady().then(boot).catch(e => {
    log('启动异常: ' + (e && e.stack || e));
    dialog.showErrorBox('启动异常', String(e && e.message || e));
    app.quit();
  });

  app.on('window-all-closed', () => {
    // 托盘常驻：不因窗口全关而退出
  });

  app.on('before-quit', () => { isQuitting = true; });

  app.on('will-quit', () => { stopServer(); });

  process.on('uncaughtException', e => { log('uncaughtException: ' + (e && e.stack || e)); });
  process.on('unhandledRejection', e => { log('unhandledRejection: ' + e); });
}

/* ----------------------------- IPC ----------------------------- */

ipcMain.handle('gmm:info', () => ({
  isDesktop: true,
  version: app.getVersion(),
  port: PORT,
  url: HOME_URL,
  dataDir: DATA_DIR,
  ownsServer: ownsServer,
  externalServer: externalServer,
  electron: process.versions.electron
}));

ipcMain.handle('gmm:open-data', () => { openDataDir(); return true; });
ipcMain.handle('gmm:open-log', () => {
  shell.openPath(DESKTOP_LOG).catch(() => {});
  return true;
});
ipcMain.handle('gmm:restart-server', () => restartServer(false));
ipcMain.handle('gmm:show-window', () => { showWindow(); return true; });
