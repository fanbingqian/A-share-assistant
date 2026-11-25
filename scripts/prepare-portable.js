#!/usr/bin/env node
'use strict';
/**
 * prepare-portable.js — 生成可公开分发的免安装包副本
 *
 * 背景：GitHub 仓库与 Release 附件都是公开的，而运行态 data/ 内含 API Key、
 *       个人持仓、日历、日志与行情缓存；hermes-bridge 的调试文本也曾写入明文 Key。
 *       本脚本把它们全部清除，只保留可启动的最小结构。
 *
 * 用法（均在项目根目录执行）：
 *   node scripts/prepare-portable.js              完整重建：从 dist 成品重新复制再清洗
 *   node scripts/prepare-portable.js --no-copy    只清洗现有副本（复制已完成时用）
 *   node scripts/prepare-portable.js --data-only  只重置 data/（自检跑完后会生成缓存，用它复原）
 *
 * 输出：dist/portable/GlobalMarketMonitor-win32-x64/
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'dist', 'GlobalMarketMonitor-win32-x64');
const OUT = path.join(ROOT, 'dist', 'portable', 'GlobalMarketMonitor-win32-x64');
const APP = path.join(OUT, 'resources', 'app');
const DATA = path.join(APP, 'data');
const KEY_RE = /sk-[A-Za-z0-9]{20,}\*{0,3}/g;
const TEXT_EXT = /\.(txt|md|json|js|css|html|ps1|bat|vbs|log|pid|py|sh)$/i;
const args = process.argv.slice(2);
const noCopy = args.indexOf('--no-copy') !== -1;
const dataOnly = args.indexOf('--data-only') !== -1;

function log(s) { console.log('[portable] ' + s); }
function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

/** 递归替换所有文本文件里的明文密钥，返回替换次数 */
function redact(dir, skipData) {
  let hits = 0;
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (skipData && p === DATA) continue;
    if (e.isDirectory()) {
      const r = redact(p, skipData);
      hits += r.hits; files.push(...r.files);
    } else if (TEXT_EXT.test(e.name)) {
      let s = fs.readFileSync(p, 'utf8');
      const m = s.match(KEY_RE);
      if (m) {
        s = s.replace(KEY_RE, 'sk-REDACTED');
        fs.writeFileSync(p, s, 'utf8');
        hits += m.length;
        files.push(path.relative(ROOT, p).replace(/\\/g, '/') + ' x' + m.length);
      }
    }
  }
  return { hits, files };
}

/** 只保留 config.json（脱敏）+ macro-expectations.json（内置静态数据）+ 说明 */
function resetData() {
  const srcCfg = path.join(SRC, 'resources', 'app', 'data', 'config.json');
  const srcMacro = path.join(SRC, 'resources', 'app', 'data', 'macro-expectations.json');
  const cfg = JSON.parse(fs.readFileSync(srcCfg, 'utf8'));
  cfg.agent.apiKey = '';
  cfg.agent._readme = '发行版已清空密钥。请填入自己的 DeepSeek API Key，或参照 config.example.json。';
  const macro = fs.readFileSync(srcMacro);
  const before = fs.readdirSync(DATA).length;

  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(DATA, 'macro-expectations.json'), macro);
  fs.writeFileSync(path.join(DATA, 'README.txt'), [
    '本目录为程序运行数据目录。',
    '',
    '发行版已清空 API Key、个人持仓、日历、日志与全部缓存快照，仅保留：',
    '  config.json              脱敏配置（agent.apiKey 为空，请填入自己的 Key）',
    '  macro-expectations.json  程序内置的机构预测静态快照（公开信息，请勿删除）',
    '',
    '其余文件会在首次运行后由程序自动生成。',
    '请勿把本目录提交进公开仓库，也不要把含密钥的 config.json 分发给他人。',
    ''
  ].join('\n'), 'utf8');
  log('data/ 已重置：原 ' + before + ' 项 → 3 个最小文件');
}

/** 同步最新文档，并在使用说明里追加首次配置提示 */
function syncDocs() {
  for (const f of ['README.md', 'config.example.json']) {
    const s = path.join(ROOT, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(APP, f));
  }
  const note = path.join(OUT, '使用说明.txt');
  if (!fs.existsSync(note)) return;
  let s = fs.readFileSync(note, 'utf8');
  if (s.indexOf('七、首次配置') !== -1) return;
  s = s.replace(/\s*$/, '') + '\r\n\r\n' + [
    '七、首次配置（发行版已脱敏）',
    '  · 本包已清空 API Key、持仓、日历、日志与缓存，首次运行会重新抓取生成数据。',
    '  · 需要 AI 解读：界面 → 设置 → 智能体 → 填入自己的 DeepSeek API Key；',
    '    或编辑 resources\\app\\data\\config.json 的 agent.apiKey（参照 config.example.json）。',
    '  · 不配置 Key 不影响行情、新闻、技术标注与复盘等其他功能。',
    '  · 首次运行若 SmartScreen 拦截，点「更多信息 → 仍要运行」（exe 未做代码签名）。',
    '  · 请解压整个文件夹到有写权限的目录（如 D:\\A股助手\\），不要放在 C:\\Program Files。',
    '  · 仅支持 Windows 10/11 64 位；macOS / Linux 需从源码自行构建。',
    ''
  ].join('\r\n');
  fs.writeFileSync(note, s, 'utf8');
  log('已同步 README / config.example.json 并追加首次配置说明');
}

/** 清理自检与运行残留 */
function cleanJunk() {
  const junk = /^(desktop-selftest\.json|.*\.log|.*\.pid|.*\.tmp)$/i;
  let n = 0;
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (junk.test(e.name)) { fs.rmSync(p, { force: true }); n++; }
    }
  }
  walk(OUT);
  log('清理运行残留 ' + n + ' 个文件');
}

/* ------------------------------ main ------------------------------ */
if (!fs.existsSync(SRC)) { console.error('[portable] 找不到成品目录：' + SRC); process.exit(1); }

if (!noCopy && !dataOnly) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  log('复制成品（约 363 MB）…');
  fs.cpSync(SRC, OUT, { recursive: true });
  log('复制完成');
}

if (!dataOnly) {
  const r = redact(OUT, true);
  log('明文密钥替换 ' + r.hits + ' 处');
  r.files.forEach(f => log('  ' + f));
  syncDocs();
}
cleanJunk();   // 自检会生成 desktop.log / desktop-server.log / desktop-selftest.json
resetData();

/* 全量复查：副本里不允许再有明文密钥或个人数据文件 */
let leak = 0;
function verify(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) verify(p);
    else if (TEXT_EXT.test(e.name) && fs.readFileSync(p, 'utf8').match(KEY_RE)) {
      console.error('[portable] 仍有密钥：' + p); leak++;
    }
  }
}
verify(OUT);
if (leak) { console.error('[portable] 脱敏失败，终止'); process.exit(1); }

const dataFiles = fs.readdirSync(DATA);
const bad = dataFiles.filter(f => !['config.json', 'macro-expectations.json', 'README.txt'].includes(f));
if (bad.length) { console.error('[portable] data/ 残留：' + bad.join(',')); process.exit(1); }

log('脱敏完成 ✓  data/ = ' + dataFiles.join(', '));
log('可压缩目录：' + OUT);
