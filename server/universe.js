'use strict';
/**
 * universe.js — 全市场股票列表（回答「能否拿到整个大盘的股票信息」）
 *
 * 数据源：新浪财经行情中心 hs_a 节点（含沪深主板/创业/科创/北交所），东财 clist 作可选主源。
 * 能力：分页拉取全 A 列表（代码/名称/价格/涨跌幅/成交额/市值/换手），落盘 data/universe-all.json。
 * 注意：这是「快照级列表 + 行情」；要按用户规则逐股算日线（MA5/下影/ATR）仍需对入选候选拉 K 线，
 *       全市场 5500+ 只逐只拉日线在免费源限流下不现实，因此选股默认在「候选池 + 全市场筛选后的扩大池」内进行。
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA, 'universe-all.json');
const TTL = 30 * 60 * 1000; // 30 分钟缓存
const PAGE = 100;
const SINA_COUNT = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=hs_a';
const SINA_LIST = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
  '?page={p}&num=' + PAGE + '&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page';
const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn' };

function readJson(f) { try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} return null; }
function writeJson(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2), 'utf8'); fs.renameSync(t, f); }
function bjNow() { return new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function num(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

async function fetchJson(url, timeout = 9000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    return JSON.parse(txt);
  } finally { clearTimeout(t); }
}

function mapRow(x) {
  return {
    code: String(x.code || '').replace(/^(sh|sz|bj)/, ''),
    symbol: x.symbol || null,
    name: x.name || null,
    price: num(x.trade),
    change: num(x.pricechange),
    pct: num(x.changepercent),
    open: num(x.open), high: num(x.high), low: num(x.low),
    preClose: num(x.settlement),
    amount: num(x.amount),       // 成交额（元）
    volume: num(x.volume),       // 成交量（股）
    marketCap: num(x.mktcap),    // 总市值（万元，新浪口径）
    nav: num(x.nav),
    turnover: num(x.turnoverratio)
  };
}

/** 全量拉取，分批 + 节流，失败页重试一次 */
async function fetchAll({ concurrency = 3, gapMs = 120, maxPages = 0 } = {}) {
  const countRaw = await fetchJson(SINA_COUNT);
  const total = Number(String(countRaw).replace(/"/g, '').trim());
  if (!Number.isFinite(total) || total <= 0) throw new Error('无法获取全市场股票总数');
  const pages = Math.min(maxPages || Math.ceil(total / PAGE), Math.ceil(total / PAGE));
  const rows = [];
  let donePages = 0, failedPages = 0;
  const errors = [];
  let cursor = 1;
  async function worker() {
    while (cursor <= pages) {
      const p = cursor++;
      try {
        const arr = await fetchJson(SINA_LIST.replace('{p}', p));
        if (Array.isArray(arr)) for (const x of arr) { const m = mapRow(x); if (m.code && /^\d{6}$/.test(m.code)) rows.push(m); }
        donePages++;
      } catch (e) {
        // 重试一次
        try {
          await sleep(250);
          const arr = await fetchJson(SINA_LIST.replace('{p}', p));
          if (Array.isArray(arr)) for (const x of arr) { const m = mapRow(x); if (m.code && /^\d{6}$/.test(m.code)) rows.push(m); }
          donePages++;
        } catch (e2) {
          failedPages++;
          if (errors.length < 10) errors.push({ page: p, error: e2.message });
        }
      }
      if (gapMs) await sleep(gapMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pages) }, () => worker()));
  // 去重
  const byCode = new Map();
  for (const r of rows) byCode.set(r.code, r);
  const items = Array.from(byCode.values()).sort((a, b) => a.code.localeCompare(b.code));
  return {
    ok: items.length > 0,
    at: bjNow(), generatedAt: Date.now(),
    total, pages, donePages, failedPages,
    count: items.length,
    coverage: total ? Math.round(items.length / total * 1000) / 10 : 0,
    source: '新浪财经行情中心 hs_a 全市场分页（含沪深主板/创业/科创/北交所）',
    errors, items
  };
}

/** 刷新全市场缓存；force=true 忽略 TTL */
async function refresh(opts = {}) {
  const cached = readJson(FILE);
  if (!opts.force && cached && cached.ok && Date.now() - (cached.generatedAt || 0) < TTL) {
    return { ...cached, fromCache: true, count: (cached.items || []).length };
  }
  const data = await fetchAll(opts);
  writeJson(FILE, data);
  return { ...data, fromCache: false };
}

/** 从缓存读全市场列表 */
function latest() { return readJson(FILE); }

/** 筛选：排除 ST/退市，可选排除北交所，按价格/成交额门槛过滤；用于扩大选股池 */
function filtered({ excludeBJ = true, minPrice = 2, minAmount = 5e7, limit = 0 } = {}) {
  const j = readJson(FILE);
  if (!j || !j.items) return { ok: false, error: '全市场列表尚未生成', items: [] };
  const items = j.items.filter(x => {
    if (/ST|退|\*/.test(x.name || '')) return false;
    if (excludeBJ && /^(4|8|92)/.test(x.code)) return false;
    if (minPrice && x.price != null && x.price < minPrice) return false;
    if (minAmount && x.amount != null && x.amount < minAmount) return false;
    return true;
  }).sort((a, b) => (b.amount || 0) - (a.amount || 0));
  return {
    ok: true, at: j.at, source: j.source,
    total: j.count, filtered: items.length,
    items: limit ? items.slice(0, limit) : items
  };
}

/** 给 screener 提供扩大候选池（代码+名称+行业占位） */
function screenerUniverse({ limit = 300 } = {}) {
  const f = filtered({ limit });
  return f.items.map(x => ({ code: x.code, name: x.name, industry: null, source: 'universe-all' }));
}

function status() {
  const j = readJson(FILE);
  return {
    ok: true,
    at: j ? j.at : null, generatedAt: j ? j.generatedAt : null,
    count: j ? j.count : 0, coverage: j ? j.coverage : 0,
    source: j ? j.source : null, file: FILE,
    note: '列表级全市场快照已可获取（新浪 hs_a）；逐股日线筛选仍在候选/扩大池内进行，避免免费源限流。'
  };
}

module.exports = { refresh, latest, filtered, screenerUniverse, status, fetchAll, FILE };
