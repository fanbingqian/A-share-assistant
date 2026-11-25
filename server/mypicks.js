'use strict';
/**
 * mypicks.js — 「我的选股」：用户手动维护的自选股清单
 *
 * 与系统自动生成的「当日观察池」严格区分：
 *   - 当日观察池 = stocks.js 评分后自动选出的候选（系统选股）
 *   - 我的选股   = 用户手工加入的标的（人工选股）
 * 两者都要能被复盘，但目前只有观察池进入了 journal 五段式闭环；
 * 我的选股的复盘对比只读 journal.outcomes，不写回评分、不改任何规则。
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'my-picks.json');
const STOCKS_CACHE = path.join(DATA_DIR, 'stocks-cache.json');
const POOL_CACHE = path.join(DATA_DIR, 'limitup-cache.json');
const HOLDINGS = path.join(DATA_DIR, 'holdings.json');
const OUTCOMES = path.join(DATA_DIR, 'journal', 'outcomes.jsonl');

const CODE_RE = /^[0-9]{6}$/;

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return fallback; }
}

function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function load() {
  const d = readJson(FILE, null);
  if (d && Array.isArray(d.items)) {
    return { items: d.items, updatedAt: d.updatedAt || 0 };
  }
  const empty = { items: [], updatedAt: 0 };
  writeJson(FILE, empty);
  return empty;
}

/* 名称补全：只从本地已有缓存里查，查不到就留空，绝不联网猜、绝不编造 */
function lookupName(code) {
  const st = readJson(STOCKS_CACHE, null);
  if (st) {
    const arr = st.items || (st.data && st.data.items) || [];
    const hit = arr.find(x => String(x.code || x.c) === code);
    if (hit && (hit.name || hit.n)) return String(hit.name || hit.n);
  }
  const pool = readJson(POOL_CACHE, null);
  if (pool) {
    for (const k of ['zt', 'zb', 'dt']) {
      const hit = (pool[k] || []).find(x => String(x.code) === code);
      if (hit && hit.name) return String(hit.name);
    }
  }
  const hd = readJson(HOLDINGS, null);
  if (hd) {
    const arr = hd.positions || hd.items || [];
    const hit = arr.find(x => String(x.code) === code);
    if (hit && hit.name) return String(hit.name);
  }
  return '';
}

function todayPicks() {
  const st = readJson(STOCKS_CACHE, null);
  if (!st) return [];
  const arr = st.items || (st.data && st.data.items) || [];
  return arr.map(x => String(x.code || x.c || '')).filter(Boolean);
}

function outcomeSummary(codes) {
  const set = new Set(codes);
  const out = [];
  try {
    if (!fs.existsSync(OUTCOMES)) return out;
    const lines = fs.readFileSync(OUTCOMES, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let o;
      try { o = JSON.parse(line); } catch (_) { continue; }
      const code = String(o.code || '');
      if (!set.has(code) || out.length >= 40) continue;
      out.push({
        code,
        date: o.date || o.pickDate || null,
        ret: (o.ret !== undefined ? o.ret : (o.excess !== undefined ? o.excess : null)),
        win: o.win !== undefined ? o.win : null
      });
    }
  } catch (e) { /* 复盘文件不可读时不编造，返回空 */ }
  return out;
}

function view() {
  const d = load();
  const codes = d.items.map(x => x.code);
  const pool = todayPicks();
  const overlap = codes.filter(c => pool.includes(c));
  return {
    ok: true,
    count: d.items.length,
    updatedAt: d.updatedAt,
    items: d.items,
    overlap,
    poolCount: pool.length,
    outcomes: outcomeSummary(codes),
    note: '我的选股为用户手工清单，不参与 stocks.js 评分；与观察池的交集仅作展示。'
  };
}

function add(body) {
  const code = String((body && body.code) || '').trim();
  if (!CODE_RE.test(code)) return { ok: false, error: '股票代码必须是 6 位数字' };
  const d = load();
  if (d.items.some(x => x.code === code)) return { ok: false, error: '该股票已在「我的选股」中' };
  const known = lookupName(code);
  d.items.push({
    code,
    name: String((body && body.name) || known || '').trim(),
    note: String((body && body.note) || '').slice(0, 120),
    addedAt: Date.now(),
    source: 'manual'
  });
  d.updatedAt = Date.now();
  writeJson(FILE, d);
  return { ok: true, data: view() };
}

function remove(body) {
  const code = String((body && body.code) || '').trim();
  if (!CODE_RE.test(code)) return { ok: false, error: '股票代码必须是 6 位数字' };
  const d = load();
  const before = d.items.length;
  d.items = d.items.filter(x => x.code !== code);
  if (d.items.length === before) return { ok: false, error: '该股票不在清单中' };
  d.updatedAt = Date.now();
  writeJson(FILE, d);
  return { ok: true, data: view() };
}

function clear() {
  const empty = { items: [], updatedAt: Date.now() };
  writeJson(FILE, empty);
  return { ok: true, data: view() };
}

module.exports = { view, add, remove, clear, FILE };
