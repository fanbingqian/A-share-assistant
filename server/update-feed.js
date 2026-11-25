'use strict';
/**
 * update-feed.js — 各板块「真实更新事件」记录
 *
 * 设计原则（关键）：只记录真实发生的数据更新，绝不伪造。
 *  ① 主入口 observe(event, data) 挂在 server.js 的 broadcast() 上：
 *     每一条 SSE 广播都意味着服务端数据确实变了，因此事件与真实更新一一对应。
 *  ② 对不经过 SSE 的真实更新（调度任务、政策脉冲、未来事件扫描、报告生成），
 *     由调用方显式 record() 登记。
 *  ③ 高频事件（15 秒行情 tick 等）按窗口聚合：窗口内只累计次数、
 *     刷新最后时刻与摘要，不刷屏；内容指纹相同也不重复建条。
 *
 * 输出：data/update-feed.json（最近 MAX 条）+ update-feed-seen.json（每板块已读水位）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA = path.join(__dirname, '..', 'data');
const F_FEED = path.join(DATA, 'update-feed.json');
const F_SEEN = path.join(DATA, 'update-feed-seen.json');
const MAX = 400;

/** view 对应左侧导航的 data-view（newsflash = 新闻快讯，所有消息/公告类更新的归口） */
const VIEWS = ['calendar', 'newsflash', 'market', 'portfolio', 'chat', 'knowledge', 'settings'];

/**
 * SSE 事件 → 板块映射。未列入的事件不记录（避免噪音）。
 * minGapMs：同模块同标题在此窗口内聚合为一条（累计 count）。
 */
const MAP = {
  tick:          { view: 'market',   module: '行情报价', minGapMs: 5 * 60000 },
  history:       { view: 'market',   module: '指数走势', minGapMs: 30 * 60000 },
  news:          { view: 'newsflash', module: '新闻抓取', minGapMs: 3 * 60000 },
  analysis:      { view: 'newsflash', module: '新闻解读', minGapMs: 10 * 60000 },
  'news-pulse':  { view: 'newsflash', module: '政策快讯', minGapMs: 0 },
  events:        { view: 'newsflash', module: '公司公告 / 事件库', minGapMs: 5 * 60000 },
  'v2-calendar': { view: 'calendar', module: '日程提醒', minGapMs: 10 * 60000 },
  'v2-volume':   { view: 'market',   module: '量能播报', minGapMs: 15 * 60000 },
  macro:         { view: 'calendar', module: '宏观状态', minGapMs: 20 * 60000 },
  alert:         { view: 'newsflash', module: '风险告警', minGapMs: 0 },
  style:         { view: 'market',   module: '大盘风格', minGapMs: 10 * 60000 },
  limitup:       { view: 'market',   module: '涨停连板', minGapMs: 5 * 60000 },
  stocks:        { view: 'market',   module: '个股观察池', minGapMs: 5 * 60000 },
  ic:            { view: 'market',   module: '板块强度', minGapMs: 15 * 60000 },
  flow:          { view: 'market',   module: '资金流',   minGapMs: 10 * 60000 },
  cycle:         { view: 'market',   module: '周期状态', minGapMs: 30 * 60000 },
  riskoff:       { view: 'market',   module: '避险温度', minGapMs: 15 * 60000 },
  edge:          { view: 'market',   module: '边际信号', minGapMs: 15 * 60000 },
  attribution:   { view: 'market',   module: '事实归因', minGapMs: 30 * 60000 },
  technical:     { view: 'market',   module: '技术因子', minGapMs: 20 * 60000 },
  journal:       { view: 'portfolio',module: '复盘账本', minGapMs: 10 * 60000 },
  holdings:      { view: 'portfolio',module: '持仓刷新', minGapMs: 10 * 60000 },
  watchers:      { view: 'portfolio',module: '公告哨兵', minGapMs: 10 * 60000 },
  config:        { view: 'settings', module: '配置变更', minGapMs: 0 }
};

function readJson(f, fallback) {
  try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (_) {}
  return fallback;
}
function writeJson(f, o) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const t = f + '.tmp';
    fs.writeFileSync(t, JSON.stringify(o, null, 2), 'utf8');
    fs.renameSync(t, f);
  } catch (e) { console.warn('[update-feed] write:', e.message); }
}
function bjNow(ts = Date.now()) {
  return new Date(ts + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
}
function cap(s, n = 110) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }
function sig(s) { return crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 10); }

let state = readJson(F_FEED, null) || { events: [], version: 1 };
let seen = readJson(F_SEEN, null) || {};

/** 从各广播数据里提取可读的真实更新摘要（全部取自实际数据，不编造） */
function describe(event, d) {
  d = d || {};
  const n = x => (Array.isArray(x) ? x.length : 0);
  switch (event) {
    case 'tick': {
      const q = Array.isArray(d.quotes) ? d.quotes : [];
      const lead = q.find(x => x && x.changePct != null);
      return `${q.length} 个标的报价` + (lead ? ` · 领涨/跌 ${lead.name || lead.symbol || ''} ${lead.changePct > 0 ? '+' : ''}${lead.changePct}%` : '');
    }
    case 'history': return n(d.history) ? `已加载 ${n(d.history)} 组指数分时` : '指数分时数据刷新';
    case 'news': {
      const items = n(d.items);
      const fresh = n(d.freshPolicyAlerts);
      const first = (d.items && d.items[0] && (d.items[0].titleZh || d.items[0].title)) || '';
      return `${items} 条新闻快照` + (fresh ? ` · 新增高影响政策 ${fresh} 条` : '') + (first ? ` · 最新「${cap(first, 40)}」` : '');
    }
    case 'analysis': return `板块情绪简报更新 · ${n(d.sectorBias || d.sectors)} 个板块`;
    case 'news-pulse': return `政策快讯脉冲 · ${d.newsCount || 0} 条新闻 / 政策相关 ${d.policyCount || 0} 条`;
    case 'events': return `事件库刷新${d.count != null ? ' · ' + d.count + ' 条' : ''}`;
    case 'v2-calendar': return `日程到期提醒 ${n(d.items)} 条`;
    case 'v2-volume': return `两市量能 ${d.amountYi != null ? d.amountYi + '亿 · ' : ''}${d.state || ''} ${d.momentum || ''}`.trim();
    case 'alert': return cap((d[0] && d[0].title) || d.title || '风险告警', 90);
    case 'style': return `大盘风格 ${d.regime || ''}${d.score != null ? '（' + d.score + '）' : ''}`;
    case 'limitup': return `涨停 ${n(d.zt)} 只 · 炸板 ${n(d.zb)} 只${d.sentiment ? ' · 最高 ' + (d.sentiment.maxBoards || '?') + ' 板' : ''}`;
    case 'stocks': return n(d.items) ? `个股观察池 ${n(d.items)} 只重算` : '个股观察池重算';
    case 'flow': return `资金流快照${d.date ? ' · ' + d.date : ''}`;
    case 'technical': return `技术因子刷新${n(d.items) ? ' · ' + n(d.items) + ' 只' : ''}`;
    case 'journal': return `复盘账本更新${d.stats ? ' · ' + (d.stats.total || '') + ' 条' : ''}`;
    case 'holdings': return '持仓数据刷新';
    case 'watchers': return `自选公告检测${n(d.items) ? ' · ' + n(d.items) + ' 条新公告' : ''}`;
    case 'config': return '配置参数已更新';
    default: return `${event} 数据更新`;
  }
}

/**
 * 核心：写入一条真实更新事件。
 * 同模块同标题在 minGapMs 内聚合；内容指纹相同则不重复计数。
 */
function push(view, module, title, detail, opts = {}) {
  const now = Date.now();
  const at = bjNow(now);
  const fp = sig(module + '|' + title + '|' + detail);
  const events = state.events;
  const last = events.find(e => e.view === view && e.module === module && e.title === title);
  const gap = opts.minGapMs != null ? opts.minGapMs : 0;

  // 同一内容的极短时间内重复登记（如冷启动并发刷新）合并为一条，避免重复条目
  if (last && last.fp === fp && (now - last.ts) < 3000) {
    last.count = (last.count || 1) + 1;
    last.at = at; last.ts = now;
    save();
    return last;
  }
  if (last && (now - last.ts) < gap) {
    // 窗口内聚合：只累计次数、刷新时刻与最新摘要；指纹相同则连次数都不加
    if (last.fp !== fp) {
      last.count = (last.count || 1) + 1;
      last.detail = detail;
      last.fp = fp;
    }
    last.at = at; last.ts = now;
    save();
    return last;
  }
  const row = {
    id: 'u' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    ts: now, at, view, module, title,
    detail: cap(detail, 160), fp, count: 1,
    source: opts.source || 'sse-broadcast'
  };
  events.unshift(row);
  if (events.length > MAX) state.events = events.slice(0, MAX);
  save();
  return row;
}
function save() { writeJson(F_FEED, state); }

/** 挂在 broadcast() 上：每条 SSE 广播都是一次真实数据变更 */
function observe(event, data) {
  const m = MAP[event];
  if (!m) return null;
  try {
    return push(m.view, m.module, m.module + '更新', describe(event, data), {
      minGapMs: m.minGapMs, source: 'sse:' + event
    });
  } catch (e) { console.warn('[update-feed] observe:', e.message); return null; }
}

/** 供调度器 / 路由显式登记（不经过 SSE 的真实更新） */
function record(view, module, title, detail, source = 'task') {
  if (!VIEWS.includes(view)) view = 'market';
  return push(view, module, title, detail, { minGapMs: 0, source });
}

/** 各板块汇总：最后更新时刻、总条数、未读条数、最新一条 */
function summary() {
  const out = {};
  for (const v of VIEWS) {
    const list = state.events.filter(e => e.view === v);
    const since = Number(seen[v] || 0);
    const unseen = list.filter(e => e.ts > since);
    out[v] = {
      lastAt: list.length ? list[0].at : null,
      total: list.length,
      unseen: unseen.length,
      unseenCount: unseen.reduce((s, e) => s + (e.count || 1), 0),
      latest: list.length ? { title: list[0].title, detail: list[0].detail, at: list[0].at } : null,
      seenAt: since ? bjNow(since) : null
    };
  }
  return out;
}

function feed({ view, since, limit = 80 } = {}) {
  let list = state.events.slice();
  if (view && view !== 'all') list = list.filter(e => e.view === view);
  if (since) list = list.filter(e => e.ts > Number(since));
  const items = list.slice(0, Math.min(200, Number(limit) || 80)).map(e => ({
    ...e, isNew: e.ts > Number(seen[e.view] || 0)
  }));
  return { ok: true, items, total: list.length };
}

function markSeen(view, at = Date.now()) {
  if (view === 'all') { for (const v of VIEWS) seen[v] = at; }
  else if (VIEWS.includes(view)) seen[view] = at;
  else return { ok: false, error: 'unknown view' };
  writeJson(F_SEEN, seen);
  return { ok: true, seen, summary: summary() };
}

function status() {
  return { ok: true, events: state.events.length, seen, summary: summary(), file: F_FEED };
}

module.exports = { observe, record, summary, feed, markSeen, status, VIEWS, MAP };
