'use strict';

/**
 * watchers.js — 事件感知层的「观察者」：自选池公告增量检测（零依赖、零 LLM）
 *
 * 【感知三要素（v9 方案）】
 *   观察者（本模块，定时轮询公告接口）
 *     → 变化检测（与 watch-last.json 里的已见幂等键 diff）
 *     → 触发（增量追加写入 events-feed.jsonl）
 *
 * 【边界纪律——本模块只负责「发现新增」，不做任何解读】
 *   - 不调 LLM、不算分、不归类、不判断利好利空——解读属于后续智能体层（A1），
 *     且必须经确定性网关校验后进待审区；观察者永远只产「事实增量」。
 *   - 标题 ≠ 事实：东财为转载源（sourceGrade B），每条都带巨潮核对提示。
 *   - 本模块挂掉或抛错不影响 8777 主服务任何功能（server.js 侧已捕获）。
 *
 * 【观察范围】「我的选股」(my-picks.json) ∪ 「持仓」(holdings.json) 的代码并集。
 *   自选池为空时直接跳过，不发任何请求。
 *
 * 【幂等与基线】
 *   - 幂等键 = 'ann:' + art_code（与 events.js 同一数据源同一键空间）；
 *   - 首轮运行（seenIds 为空）只建立基线、不写流水——防止把历史公告一次性倒灌进账本；
 *   - 手动删除 watch-last.json 可强制重建基线（同样不产生历史倒灌）。
 *
 * 【存储】
 *   data/journal/events-feed.jsonl  事件流水（只追加，超 3000 行裁剪最旧）
 *   data/journal/watch-last.json    已见幂等键 + 运行状态（滚动覆写）
 */

const fs = require('node:fs');
const path = require('node:path');
const { UA } = require('./sources');
const mypicks = require('./mypicks');
const holdings = require('./holdings');

const DIR = path.join(__dirname, '..', 'data', 'journal');
const FEED = path.join(DIR, 'events-feed.jsonl');
const LAST = path.join(DIR, 'watch-last.json');

/* 与 events.js 完全相同的公告端点（市场级最新公告流，按时间倒序），
 * 只取前 2 页（200 条）：10 分钟间隔下足够覆盖自选池标的的公告增量。 */
const EM_ANN = 'https://np-anotice-stock.eastmoney.com/api/security/ann';
const PAGES = 2;
const SEEN_CAP = 4000;   // 已见幂等键上限（约 2-3 个月自选池公告量）
const MAX_FEED = 3000;   // 事件流水行数上限
/* 基线轮冷启动保护：观察池标的长期无公告时 seenIds 一直为空、基线轮会一直延续，
 * 若不区分新旧，第一只票的第一条「真增量」会被基线吞掉。
 * 规则：公告时间距当前 ≤ 30 分钟的，即使在基线轮也作为增量写入流水；更老的只播种为已见。 */
const BASELINE_FRESH_MS = 30 * 60 * 1000;

/* ---------------------------------- 工具 ---------------------------------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

/** 东财时间字段 → 毫秒时间戳；解析不了返回 null（不编造时间） */
function parseEMTime(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) { const n = +s; return n > 1e12 ? n : n * 1000; }
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + '+08:00');
  return Number.isFinite(t) ? t : null;
}

/* ------------------------------ 观察池（并集） ------------------------------ */

function readWatchlist() {
  const map = new Map();
  try {
    for (const it of (mypicks.load().items || [])) {
      if (it && /^\d{6}$/.test(String(it.code))) map.set(String(it.code), { code: String(it.code), name: it.name || '' });
    }
  } catch (_) { /* 读不到就当空，不阻断 */ }
  try {
    const doc = holdings.load() || {};
    for (const p of (doc.positions || [])) {
      if (p && /^\d{6}$/.test(String(p.code)) && !map.has(String(p.code))) {
        map.set(String(p.code), { code: String(p.code), name: p.name || '' });
      }
    }
  } catch (_) { /* 同上 */ }
  return [...map.values()];
}

/* -------------------------------- 状态与流水 -------------------------------- */

function loadLast() {
  try {
    if (fs.existsSync(LAST)) {
      const d = JSON.parse(fs.readFileSync(LAST, 'utf8'));
      if (d && Array.isArray(d.seenIds)) return d;
    }
  } catch (_) { /* 损坏则重建基线 */ }
  return { version: 1, updatedAt: 0, lastRunAt: 0, lastNew: 0, seenIds: [] };
}

function saveLast(doc) {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  const tmp = LAST + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc), 'utf8');
  fs.renameSync(tmp, LAST);
}

function appendFeed(obj) {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(FEED, JSON.stringify(obj) + '\n', 'utf8');
}

function pruneFeed() {
  if (!fs.existsSync(FEED)) return;
  const lines = fs.readFileSync(FEED, 'utf8').split('\n').filter(x => x.trim());
  if (lines.length <= MAX_FEED) return;
  fs.writeFileSync(FEED, lines.slice(-MAX_FEED).join('\n') + '\n', 'utf8');
}

function readFeed({ limit = 50, code } = {}) {
  if (!fs.existsSync(FEED)) return [];
  let rows = [];
  for (const line of fs.readFileSync(FEED, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch (_) { /* 半行跳过 */ }
  }
  if (code) rows = rows.filter(r => r.code === code);
  return rows.slice(-limit).reverse();
}

/* -------------------------------- 公告抓取 -------------------------------- */

/** 与 events.js normalizeAnn 同构：codes[0] 取 6 位代码标的，title 缺失的行丢弃 */
function normalizeAnn(j) {
  const list = (j && j.data && j.data.list) || [];
  return list.map(a => {
    const c = (a.codes || []).find(x => /^\d{6}$/.test(String(x.stock_code || ''))) || (a.codes || [])[0] || {};
    return {
      id: 'ann:' + (a.art_code || String(a.title_ch || a.title || '').slice(0, 40)),
      code: String(c.stock_code || ''),
      name: String(c.short_name || ''),
      title: String(a.title_ch || a.title || ''),
      columns: (a.columns || []).map(x => String(x.column_name || '')),
      ts: parseEMTime(a.display_time || a.notice_date),
      link: 'https://data.eastmoney.com/notices/detail/' + String(c.stock_code || '') + '/' + String(a.art_code || '') + '.html'
    };
  }).filter(a => a.title && a.code);
}

/* --------------------------------- 主流程 --------------------------------- */

/**
 * 跑一轮观察：抓最新公告 → 过滤自选池 → diff → 增量写流水。
 * 首轮（无基线）只播种 seenIds，不写流水。
 * 任何单页失败只记警告，不中断本轮。
 */
async function runOnce() {
  const watch = readWatchlist();
  if (!watch.length) {
    const last = loadLast();
    last.lastRunAt = Date.now();
    saveLast(last);
    return { ok: true, skipped: '观察池为空（我的选股与持仓均无标的）', watchlist: 0, added: 0 };
  }
  const byCode = new Map(watch.map(w => [w.code, w]));
  const last = loadLast();
  const seen = new Set(last.seenIds);
  const baseline = seen.size === 0;
  const fresh = [];

  for (let p = 1; p <= PAGES; p++) {
    const url = EM_ANN + '?sr=-1&page_size=100&page_index=' + p + '&ann_type=A&client_source=web&_=' + Date.now();
    let rows = [];
    try { rows = normalizeAnn(await fetchJson(url)); }
    catch (e) { console.warn('[watchers] 公告第 ' + p + ' 页失败: ' + e.message); }
    for (const r of rows) {
      const w = byCode.get(r.code);
      if (!w) continue;                 // 只关心自选池标的
      // 基线轮：老公告只播种为已见；30 分钟内的新公告仍作为增量写入（防首条真增量被吞）
      const isFresh = r.ts != null && Date.now() - r.ts <= BASELINE_FRESH_MS;
      if (baseline && !isFresh) { seen.add(r.id); continue; }
      if (seen.has(r.id)) continue;     // 已见增量：跳过
      seen.add(r.id);
      fresh.push({
        feedId: r.id,                   // 幂等键
        kind: 'announcement',
        code: r.code,
        name: r.name || w.name || '',
        title: r.title,
        columns: r.columns,
        annAt: r.ts,
        link: r.link,
        sourceGrade: 'B',
        sourceName: '东方财富公告接口（转载）',
        verifyHint: '标题为转载口径，事实以巨潮资讯网原文为准',
        interpreted: false,             // 智能体层（A1）解读后置 true；观察者永不解读
        affectsScore: false,            // 感知层不改分
        fetchedAt: Date.now()
      });
    }
    if (p < PAGES) await sleep(420);
  }

  for (const f of fresh) appendFeed(f);
  pruneFeed();

  // seenIds 用数组保序存储，超限裁掉最旧的一段
  let ids = [...seen];
  if (ids.length > SEEN_CAP) ids = ids.slice(ids.length - SEEN_CAP);
  saveLast({ version: 1, updatedAt: Date.now(), lastRunAt: Date.now(), lastNew: fresh.length, seenIds: ids });

  if (fresh.length) {
    console.log('[watchers] 自选池新增公告 ' + fresh.length + ' 条（观察池 ' + watch.length + ' 只）：' +
      fresh.slice(0, 3).map(f => f.name + '《' + f.title.slice(0, 24) + '》').join('；'));
  }
  return { ok: true, watchlist: watch.length, baseline, added: fresh.length, seen: ids.length };
}

function status() {
  const last = loadLast();
  const feedRows = fs.existsSync(FEED)
    ? fs.readFileSync(FEED, 'utf8').split('\n').filter(x => x.trim()).length : 0;
  return {
    ok: true,
    watchlist: readWatchlist(),
    seenIds: (last.seenIds || []).length,
    lastRunAt: last.lastRunAt || null,
    lastNew: last.lastNew || 0,
    feedRows,
    pages: PAGES,
    note: '观察者只发现新增公告、不做解读；解读由智能体层（A1）经确定性网关后写入待审区。首轮只建基线不写流水。'
  };
}

module.exports = { runOnce, status, readFeed, readWatchlist, FEED, LAST, EM_ANN };
