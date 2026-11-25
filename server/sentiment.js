'use strict';
/**
 * sentiment.js — 短线情绪指标：赚钱效应 / 连板高度 / 炸板率
 *
 * 只算程序可观测事实，不打分、不预测、不给买卖建议。
 * 数据源：data/limitup-cache.json（当日涨停/炸板/跌停快照）
 *         data/limitup-history.json（历史涨停代码集，用于昨日涨停今日收益=赚钱效应）
 * 落盘：data/sentiment.json（当日）  data/sentiment-history.jsonl（时序）
 */

const fs = require('node:fs');
const path = require('node:path');
const emtx = require('./emtx');

const DATA = path.join(__dirname, '..', 'data');
const F_CACHE = path.join(DATA, 'limitup-cache.json');
const F_HISTORY = path.join(DATA, 'limitup-history.json');
const F_OUT = path.join(DATA, 'sentiment.json');
const F_HIST = path.join(DATA, 'sentiment-history.jsonl');

function readJson(f) {
  try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  return null;
}
function writeJson(f, o) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = f + '.tmp';
  fs.writeFileSync(t, JSON.stringify(o, null, 2), 'utf8');
  fs.renameSync(t, f);
}
function bjNow() { return new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); }
function pct(a, b) { return a && b ? Math.round((b / a - 1) * 10000) / 100 : null; }
function secidOf(code) { return (/^6/.test(code) ? '1.' : (/^(4|8|9)/.test(code) ? '0.' : '0.')) + code; }
function isWeekend(key) {
  const y = Number(key.slice(0, 4)), m = Number(key.slice(4, 6)), d = Number(key.slice(6, 8));
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 || w === 6;
}
/** 取 todayKey 之前最近一个「工作日」的涨停快照日。
 *  history 里可能混入周末缓存（非交易日无涨停却写了空/旧样本），必须过滤，
 *  否则会把 prevDay 定位到周日、K线无此bar，赚钱效应全部取数落空。 */
function prevTradeDate(history, todayKey) {
  const keys = Object.keys(history || {}).filter(k => /^\d{8}$/.test(k) && k < todayKey && !isWeekend(k)).sort();
  return keys.length ? keys[keys.length - 1] : null;
}
/** 从 K 线里取指定交易日（YYYY-MM-DD）的收盘价 */
function closeOn(klines, day) {
  for (let i = klines.length - 1; i >= 0; i--) {
    const d = String(klines[i]).split(',')[0];
    if (d === day) return Number(String(klines[i]).split(',')[2]);
  }
  return null;
}
/** 多源 K 线：东财 → 新浪兜底，统一返回 emtx 风格的 klines 字符串数组 */
async function fetchKlines(code, bars = 12) {
  try {
    const j = await emtx.fetchKline(secidOf(code), bars);
    const kl = (j && j.data && j.data.klines) || [];
    if (kl.length >= 2) return kl;
  } catch (_) {}
  try {
    const prefix = /^6/.test(code) ? 'sh' : (/^(4|8)/.test(code) ? 'bj' : 'sz');
    const url = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData' +
      '?symbol=' + prefix + code + '&scale=240&ma=no&datalen=' + (bars + 2);
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn' }, signal: AbortSignal.timeout(9000) });
    const arr = await res.json();
    if (Array.isArray(arr) && arr.length) {
      return arr.slice(-bars).map(x => [String(x.day || '').slice(0, 10), x.open, x.close, x.high, x.low, x.volume].join(','));
    }
  } catch (_) {}
  return [];
}

/**
 * 赚钱效应：昨日涨停股今日的平均收益 / 上涨占比 / 涨停溢价
 * 用 K 线逐只取昨收→今收。样本不足或数据缺失时返回 null，不编造。
 */
async function moneyEffect(todayKey, prevKey, prevCodes, maxSample = 60) {
  const codes = (prevCodes || []).slice(0, maxSample);
  if (!codes.length || !prevKey) return { ok: false, reason: '无昨日涨停样本' };
  const prevDay = prevKey.slice(0, 4) + '-' + prevKey.slice(4, 6) + '-' + prevKey.slice(6, 8);
  const rets = [];
  let fetched = 0;
  for (const code of codes) {
    try {
      const kl = await fetchKlines(code, 12);
      if (kl.length < 2) continue;
      // 找昨收（prevDay）与其后的最新收盘
      const lastDay = String(kl[kl.length - 1]).split(',')[0];
      let p = closeOn(kl, prevDay);
      // 兜底：部分源缺失 prevDay 这一根（停牌/复权/口径差），退而取倒数第二根收盘
      if (p == null && kl.length >= 2) p = Number(String(kl[kl.length - 2]).split(',')[2]);
      let latest = Number(String(kl[kl.length - 1]).split(',')[2]);
      if (!p || !latest) continue;
      // 若最新bar就是prevDay本身，或数据陈旧（最新bar早于prevDay），说明今日未收盘/未更新，跳过
      if (lastDay === prevDay || lastDay < prevDay) continue;
      fetched++;
      const r = pct(p, latest);
      if (r != null) rets.push(r);
    } catch (_) {}
  }
  if (!rets.length) return { ok: false, reason: 'K线取数失败或样本过期', sample: 0, fetched };
  rets.sort((a, b) => a - b);
  const sum = rets.reduce((s, x) => s + x, 0);
  const up = rets.filter(x => x > 0).length;
  const limitUpAgain = rets.filter(x => x >= 9.5).length;
  return {
    ok: true,
    sample: rets.length, fetched,
    avgRet: Math.round(sum / rets.length * 100) / 100,
    medianRet: rets[Math.floor(rets.length / 2)],
    upRatio: Math.round(up / rets.length * 1000) / 10,
    againLimitRatio: Math.round(limitUpAgain / rets.length * 1000) / 10,
    basis: '昨日(' + prevDay + ')涨停股今日收盘相对昨收的收益分布',
    note: '样本为昨日涨停代码集前' + maxSample + '只，剔除K线缺失；非全量、非收益承诺。'
  };
}

/**
 * 连板高度：当日涨停梯队与最高板（复用 limitup 快照的 boards 字段）
 */
function boardHeight(ztList) {
  const ladder = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let maxBoards = 0;
  const leaders = [];
  for (const x of (ztList || [])) {
    const b = Number(x.boards) || 1;
    maxBoards = Math.max(maxBoards, b);
    if (b >= 5) ladder[5]++; else ladder[b] = (ladder[b] || 0) + 1;
    if (b >= 3) leaders.push({ code: x.code, name: x.name || null, boards: b, industry: x.industry || null });
  }
  leaders.sort((a, b) => b.boards - a.boards);
  const ladderText = [1, 2, 3, 4].map(k => k + '板:' + ladder[k]).join(' / ') + ' / 5+:' + ladder[5];
  return {
    ok: true,
    maxBoards,
    ladder,
    ladderText,
    heightLevel: maxBoards >= 7 ? '极高' : maxBoards >= 5 ? '高' : maxBoards >= 3 ? '中' : maxBoards >= 2 ? '低' : '无连板',
    leaders: leaders.slice(0, 12),
    basis: '当日涨停池 boards 字段统计；5板及以上合并为 5+ 档。'
  };
}

/**
 * 炸板率：炸板数 / (涨停数 + 炸板数)
 */
function breakRate(ztList, zbList, dtCount) {
  const zt = (ztList || []).length;
  const zb = (zbList || []).length;
  const denom = zt + zb;
  const rate = denom > 0 ? Math.round(zb / denom * 1000) / 10 : null;
  const failed = (zbList || []).slice(0, 12).map(x => ({
    code: x.code, name: x.name || null, industry: x.industry || null,
    pct: x.pct != null ? x.pct : null,
    failDepth: x.failDepth != null ? x.failDepth : null
  }));
  return {
    ok: denom > 0,
    ztCount: zt, zbCount: zb, dtCount: Number(dtCount) || 0,
    rate,
    level: rate == null ? '无样本' : rate >= 45 ? '极高' : rate >= 30 ? '偏高' : rate >= 18 ? '中等' : '偏低',
    failed,
    basis: '炸板率=炸板数/(收盘涨停数+炸板数)，反映触板未封的比例。',
    note: '基于收盘快照，不等同于盘中逐笔封板成功率。'
  };
}

async function build(opts = {}) {
  const cache = opts.cache || readJson(F_CACHE);
  if (!cache || !cache.date) return { ok: false, error: '缺少涨停缓存，请先运行涨停池刷新', generatedAt: bjNow() };
  const todayKey = String(cache.date).replace(/-/g, '');
  const zt = cache.zt || [];
  const zb = cache.zb || [];
  const history = readJson(F_HISTORY) || {};
  const prevKey = prevTradeDate(history, todayKey);

  const height = boardHeight(zt);
  const brk = breakRate(zt, zb, cache.dtCount);
  const money = opts.skipMoney
    ? { ok: false, reason: '本次跳过（opts.skipMoney=true）' }
    : await moneyEffect(todayKey, prevKey, prevKey ? history[prevKey] : []);

  const out = {
    ok: true,
    generatedAt: bjNow(),
    date: cache.date,
    moneyEffect: money,
    boardHeight: height,
    breakRate: brk,
    shortTerm: {
      money: money.ok ? money.avgRet : null,
      height: height.maxBoards,
      breakRate: brk.rate,
      summary: '赚钱效应' + (money.ok ? (money.avgRet > 0 ? '+' : '') + money.avgRet + '%（' + money.sample + '只样本）' : '数据不足') +
        ' · 连板高度' + height.maxBoards + '板(' + height.heightLevel + ')' +
        ' · 炸板率' + (brk.rate == null ? '无样本' : brk.rate + '%(' + brk.level + ')')
    },
    disclaimer: '以上为程序按公开行情与涨停快照计算的事实指标，非买卖建议、非涨跌预测。'
  };
  writeJson(F_OUT, out);
  // 时序追加（同日覆盖最后一条，避免重复膨胀）
  try {
    fs.mkdirSync(path.dirname(F_HIST), { recursive: true });
    let lines = [];
    if (fs.existsSync(F_HIST)) lines = fs.readFileSync(F_HIST, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
    const rec = {
      date: cache.date, generatedAt: out.generatedAt,
      money: money.ok ? money.avgRet : null,
      moneyUpRatio: money.ok ? money.upRatio : null,
      height: height.maxBoards,
      breakRate: brk.rate,
      ztCount: brk.ztCount, zbCount: brk.zbCount, dtCount: brk.dtCount
    };
    if (lines.length) {
      let last = null;
      try { last = JSON.parse(lines[lines.length - 1]); } catch (_) {}
      if (last && last.date === rec.date) lines[lines.length - 1] = JSON.stringify(rec);
      else lines.push(JSON.stringify(rec));
    } else lines.push(JSON.stringify(rec));
    fs.writeFileSync(F_HIST, lines.join('\n') + '\n', 'utf8');
  } catch (e) { console.warn('[sentiment-history]', e.message); }
  return out;
}

function latest() { return readJson(F_OUT); }
function history(limit = 60) {
  try {
    if (!fs.existsSync(F_HIST)) return [];
    return fs.readFileSync(F_HIST, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean).slice(-Math.max(1, Math.min(200, limit)));
  } catch (_) { return []; }
}

module.exports = { build, latest, history, F_OUT, F_HIST };
