'use strict';
/**
 * screener.js — 用户定义的三类选股数据生成器（P0）
 *
 * 生成：
 *   data/trend-screen.json   趋势股：规则A 连续3日 close>=MA5；规则B 5日内≤1日破MA5 且期间创新高
 *   data/rebound-screen.json 强势反弹股：超跌 + 尾盘长下影（日线代理，标注口径）
 *   data/hot-screen.json     热度/独立行情牛股：个股超额独立性 + 涨停热度
 *   data/ma5-screen.json     兼容旧接口（由趋势股数据转换）
 *
 * 纪律：只算程序可观测事实，不打分、不推荐、不改 stocks.js 评分。
 * 数据源：emtx.fetchKline（东财主源 → 腾讯前复权备用源），K 线取前复权日线。
 */

const fs = require('node:fs');
const path = require('node:path');
const emtx = require('./emtx');

const DATA = path.join(__dirname, '..', 'data');
const F_TREND = path.join(DATA, 'trend-screen.json');
const F_REBOUND = path.join(DATA, 'rebound-screen.json');
const F_HOT = path.join(DATA, 'hot-screen.json');
const F_MA5 = path.join(DATA, 'ma5-screen.json');
// 四类选股：趋势 / 低吸 / 打板 / 趋势突破
const F_DIP = path.join(DATA, 'dip-screen.json');
const F_BOARD = path.join(DATA, 'board-screen.json');
const F_BREAKOUT = path.join(DATA, 'breakout-screen.json');

const LIMIT = Math.max(10, Math.min(300, Number(process.env.SCREEN_LIMIT || 120)));
const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.SCREEN_CONCURRENCY || 2)));
const REQUEST_GAP_MS = Math.max(0, Math.min(2000, Number(process.env.SCREEN_GAP_MS || 150)));
const BARS = 45;

function readJson(file) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return null;
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function bjNow() { return new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); }
function secidOf(code) { return (/^6/.test(code) ? '1.' : '0.') + code; }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }

/* ------------------------------ 候选池 ------------------------------ */

function collectUniverse() {
  const map = new Map();
  const add = (code, name, industry) => {
    const c = String(code || '').trim();
    if (!/^\d{6}$/.test(c) || map.has(c)) return;
    map.set(c, {
      code: c,
      name: String(name || '').trim() || null,
      industry: String(industry || '').trim() || null
    });
  };
  const sc = readJson(path.join(DATA, 'stocks-cache.json'));
  for (const x of (sc && sc.items) || []) add(x.code, x.name, x.industry);
  const att = readJson(path.join(DATA, 'attention-cache.json'));
  if (att && att.items) {
    for (const x of Object.values(att.items)) add(x.code, x.name, null);
  }
  const picks = readJson(path.join(DATA, 'my-picks.json'));
  for (const x of (picks && picks.items) || []) add(x.code, x.name, null);
  const hold = readJson(path.join(DATA, 'holdings.json'));
  for (const x of (hold && hold.positions) || []) add(x.code, x.name, null);
  const ma5 = readJson(F_MA5);
  for (const x of (ma5 && ma5.results) || []) add(x.code, x.name, null);
  const lk = readJson(path.join(DATA, 'limitup-cache.json'));
  for (const x of (lk && lk.zt) || []) add(x.code, x.name, x.industry);
  // 可选：用全市场列表扩大候选池（SCREEN_UNIVERSE=all）。默认关闭，避免免费源逐股拉日线被限流。
  if (String(process.env.SCREEN_UNIVERSE || '').toLowerCase() === 'all') {
    const ua = readJson(path.join(DATA, 'universe-all.json'));
    for (const x of (ua && ua.items) || []) {
      if (/ST|退|\*/.test(x.name || '')) continue;
      add(x.code, x.name, null);
    }
  }
  return Array.from(map.values()).slice(0, LIMIT);
}

/* ------------------------------ K 线与指标 ------------------------------ */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 新浪日 K 备用源：腾讯 qfq 被限流（HTTP 501）时接管。返回不复权日线，已在 source 标注。 */
async function fetchSinaBars(code) {
  const prefix = /^6/.test(code) ? 'sh' : (/^(4|8)/.test(code) ? 'bj' : 'sz');
  const url = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData' +
    '?symbol=' + prefix + code + '&scale=240&ma=no&datalen=' + (BARS + 5);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 9000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn' }, signal: ac.signal });
    if (!res.ok) throw new Error('sina HTTP ' + res.status);
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) throw new Error('sina 空数据');
    const bars = arr.slice(-BARS).map(x => ({
      d: String(x.day || '').slice(0, 10), o: n(x.open), c: n(x.close), h: n(x.high), l: n(x.low), v: n(x.volume)
    })).filter(x => x.d && x.c != null && x.h != null && x.l != null && x.o != null);
    if (!bars.length) throw new Error('sina 解析为空');
    return { bars, source: 'sina(不复权)', name: null };
  } finally { clearTimeout(timer); }
}

async function fetchBars(code) {
  let lastErr = null;
  try {
    const j = await emtx.fetchKline(secidOf(code), BARS);
    const rows = (j && j.data && j.data.klines) || [];
    const bars = [];
    for (const line of rows) {
      const p = String(line).split(',');
      if (p.length < 6) continue;
      const bar = { d: p[0], o: n(p[1]), c: n(p[2]), h: n(p[3]), l: n(p[4]), v: n(p[5]) };
      if (bar.c == null || bar.h == null || bar.l == null || bar.o == null) continue;
      bars.push(bar);
    }
    if (bars.length) return { bars, source: j._source || 'emtx', name: (j && j.data && j.data.name) || null };
    throw new Error('空K线');
  } catch (e) { lastErr = e; }
  try { return await fetchSinaBars(code); }
  catch (e2) { throw new Error('emtx=' + (lastErr && lastErr.message) + '; sina=' + e2.message); }
}

function ma(arr, i, len) {
  if (i + 1 < len) return null;
  let s = 0;
  for (let k = i - len + 1; k <= i; k++) s += arr[k].c;
  return Math.round(s / len * 1000) / 1000;
}

function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let up = 0, down = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) up += d; else down -= d;
  }
  if (down === 0) return up === 0 ? 50 : 100;
  const rs = (up / period) / (down / period);
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

function atr(bars, period = 14) {
  if (bars.length <= period) return null;
  let s = 0, cnt = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    s += tr; cnt++;
  }
  return cnt ? Math.round(s / cnt * 1000) / 1000 : null;
}

function retPct(bars, days) {
  if (bars.length <= days) return null;
  const a = bars[bars.length - 1 - days].c, b = bars[bars.length - 1].c;
  if (!a || !b) return null;
  return Math.round((b / a - 1) * 10000) / 100;
}

/* ------------------------------ 量化评分 ------------------------------ */
/** 分段线性打分：把 x 映射到 0..max，x 越接近/超过 good 得分越高 */
function scoreRange(x, bad, good, max = 100) {
  if (x == null || !Number.isFinite(x)) return 0;
  if (good > bad) {
    if (x <= bad) return 0;
    if (x >= good) return max;
    return Math.round((x - bad) / (good - bad) * max);
  }
  if (x >= bad) return 0;
  if (x <= good) return max;
  return Math.round((bad - x) / (good - bad) * max);
}
function clampScore(v) { return Math.max(0, Math.min(100, Math.round(v))); }
/** 组合分项为总分（0-100），parts 为 [{k,label,score,weight,desc}] */
function compose(parts) {
  let s = 0, w = 0;
  for (const p of parts) { s += (p.score || 0) * (p.weight || 0); w += (p.weight || 0); }
  return {
    score: w ? clampScore(s / w) : 0,
    parts: parts.map(p => ({ k: p.k, label: p.label, score: clampScore(p.score || 0), weight: p.weight, desc: p.desc || null }))
  };
}

/* ------------------------------ 三类判定 ------------------------------ */

function judgeTrend(bars) {
  if (bars.length < 25) return null;
  const m5 = bars.map((_, i) => ma(bars, i, 5));
  const last = bars[bars.length - 1];
  const last5 = bars.slice(-5);
  const last5m5 = m5.slice(-5);
  const belowFlags = last5.map((b, i) => b.c < last5m5[i]);
  const breaks = belowFlags.filter(Boolean).length;

  // 规则 A：最近 3 个连续交易日不破 MA5
  const ruleA = belowFlags.slice(-3).every(x => x === false);
  // 规则 B：5 日内至多 1 日破 MA5，且窗口内最高价 > 此前 20 日最高价（创新高）
  const prior20 = bars.slice(-25, -5);
  const priorHigh = prior20.length ? Math.max(...prior20.map(b => b.h)) : null;
  const windowHigh = Math.max(...last5.map(b => b.h));
  const newHigh = priorHigh != null && windowHigh > priorHigh;
  const ruleB = breaks <= 1 && newHigh;
  if (!ruleA && !ruleB) return null;
  const ret5 = retPct(bars, 5);
  const highBreak = priorHigh ? Math.round((windowHigh / priorHigh - 1) * 10000) / 100 : null;
  // 量能配合：最后一日成交量 / 前5日均量
  const avg5Vol = bars.slice(-6, -1).reduce((s, b) => s + (b.v || 0), 0) / 5;
  const volRatio = avg5Vol > 0 && last.v ? Math.round(last.v / avg5Vol * 100) / 100 : null;
  const sc = compose([
    { k: 'rule', label: '规则强度', weight: 0.30, score: ruleA && ruleB ? 100 : ruleA ? 80 : 70, desc: ruleA && ruleB ? '同时满足连续3日不破MA5+创新高' : (ruleA ? '满足连续3日不破MA5' : '满足5日内≤1日破且创新高') },
    { k: 'hold', label: '不破MA5天数', weight: 0.20, score: scoreRange(5 - breaks, 2, 5), desc: '近5日中未跌破MA5的天数=' + (5 - breaks) + '天' },
    { k: 'newHigh', label: '创新高幅度', weight: 0.20, score: highBreak == null ? 0 : scoreRange(highBreak, 0, 5), desc: highBreak == null ? '无此前20日高点参照' : ('窗口最高价较此前20日高点+' + highBreak + '%') },
    { k: 'ret5', label: '近5日收益', weight: 0.20, score: scoreRange(ret5, -5, 12), desc: '近5日收益' + (ret5 == null ? '待补充' : (ret5 > 0 ? '+' : '') + ret5 + '%') },
    { k: 'vol', label: '量能配合', weight: 0.10, score: scoreRange(volRatio, 0.6, 1.5), desc: volRatio == null ? '量能数据缺失' : ('最新量/前5日均量=' + volRatio) }
  ]);
  return {
    code: null, name: null,
    rule: ruleA && ruleB ? 'A+B' : ruleA ? 'A' : 'B',
    last: last.c, ma5: m5[m5.length - 1],
    breaks, consecutiveHold3: ruleA, newHigh, ret5, highBreak, volRatio,
    score: sc.score, scoreParts: sc.parts,
    reason: '趋势股·规则' + (ruleA && ruleB ? 'A+B' : ruleA ? 'A' : 'B') + '：' + sc.parts.filter(p => p.score >= 60).map(p => p.desc).join('；') + '。',
    windowHigh: Math.round(windowHigh * 100) / 100,
    prior20High: priorHigh == null ? null : Math.round(priorHigh * 100) / 100,
    days: last5.map((b, i) => ({ d: b.d, c: b.c, ma5: last5m5[i], below: belowFlags[i], h: b.h }))
  };
}

function judgeRebound(bars) {
  if (bars.length < 21) return null;
  const last = bars[bars.length - 1];
  const closes = bars.map(b => b.c);
  const m20 = ma(bars, bars.length - 1, 20);
  const r14 = rsi(closes, 14);
  const a14 = atr(bars, 14);
  const ret20 = retPct(bars, 20);
  const dev20 = m20 ? Math.round((last.c / m20 - 1) * 10000) / 100 : null;
  const oversoldReasons = [];
  if (ret20 != null && ret20 <= -15) oversoldReasons.push('20日收益' + ret20 + '%≤-15%');
  if (r14 != null && r14 <= 30) oversoldReasons.push('RSI14=' + r14 + '≤30');
  if (dev20 != null && dev20 <= -10) oversoldReasons.push('偏离MA20=' + dev20 + '%≤-10%');
  if (!oversoldReasons.length) return null;

  const lowerShadow = Math.min(last.o, last.c) - last.l;
  const range = last.h - last.l;
  const shadowPct = last.c ? Math.round(lowerShadow / last.c * 10000) / 100 : null;
  const closePos = range > 0 ? Math.round((last.c - last.l) / range * 1000) / 10 : null;
  const shadowOk = a14 != null ? lowerShadow >= 2 * a14 : (shadowPct != null && shadowPct >= 2.0);
  const closeOk = closePos != null && closePos >= 60;
  if (!shadowOk || !closeOk) return null;

  const avg5Vol = bars.slice(-6, -1).reduce((s, b) => s + (b.v || 0), 0) / 5;
  const volState = avg5Vol > 0 ? (last.v < avg5Vol * 0.9 ? '缩量' : last.v > avg5Vol * 1.3 ? '放量' : '平量') : '未知';
  const sc = compose([
    { k: 'oversold', label: '超跌幅度', weight: 0.30, score: Math.max(scoreRange(ret20, -8, -22), scoreRange(r14, 45, 22), scoreRange(dev20, -4, -15)), desc: oversoldReasons.join('；') },
    { k: 'shadow', label: '下影长度', weight: 0.30, score: scoreRange(shadowPct, 1.5, 6), desc: '下影/股价=' + (shadowPct == null ? '待补充' : shadowPct + '%') + '，' + (a14 != null ? ('约' + (lowerShadow / a14).toFixed(1) + '倍ATR14') : '无ATR') },
    { k: 'closePos', label: '收盘位置', weight: 0.25, score: scoreRange(closePos, 60, 95), desc: '收盘位于当日振幅' + (closePos == null ? '待补充' : closePos + '%') + '分位' },
    { k: 'vol', label: '量能状态', weight: 0.15, score: volState === '放量' ? 85 : volState === '平量' ? 65 : volState === '缩量' ? 45 : 30, desc: '成交量状态：' + volState }
  ]);
  return {
    code: null, name: null,
    last: last.c, ret20, rsi14: r14, ma20: m20, dev20,
    atr14: a14, lowerShadow: Math.round(lowerShadow * 1000) / 1000,
    shadowPct, closePos, volumeState: volState,
    score: sc.score, scoreParts: sc.parts,
    reason: '反弹股·超跌+长下影：' + oversoldReasons.join('；') + '；下影' + (shadowPct == null ? '?' : shadowPct + '%') +
      '、收盘位于振幅' + (closePos == null ? '?' : closePos + '%') + '、量能' + volState + '。',
    oversoldReason: oversoldReasons.join('；'),
    tailProxy: true,
    note: '尾盘限定需要分钟数据；当前用日线收盘位置≥60%作代理，已标注 tailProxy=true。'
  };
}

/**
 * 独立行情牛股：行业收益用人气榜 conceptTags 的同标签同伴平均 5 日收益近似，
 * 取最强同伴组作为「行业基准」；没有同伴数据的标的不入选，避免编造行业收益。
 */
function judgeHot(code, ctx) {
  const ret5 = ctx.ret5ByCode.get(code);
  if (ret5 == null || ctx.marketRet5 == null) return null;
  const tags = (ctx.attentionByCode.get(code) || {}).conceptTags || [];
  let industryRet5 = null, matchedTag = null;
  for (const tag of tags) {
    const peers = (ctx.tagToCodes.get(String(tag)) || []).filter(c => c !== code && ctx.ret5ByCode.has(c));
    if (peers.length < 2) continue;
    const avg = peers.reduce((s, c) => s + ctx.ret5ByCode.get(c), 0) / peers.length;
    const rounded = Math.round(avg * 100) / 100;
    if (industryRet5 == null || rounded > industryRet5) { industryRet5 = rounded; matchedTag = String(tag); }
  }
  if (industryRet5 == null) return null;
  const independent = Math.round((ret5 - industryRet5 - ctx.marketRet5) * 100) / 100;
  const zt = ctx.limitUpByCode.get(code);
  const att = ctx.attentionByCode.get(code);
  const heat = zt
    ? Math.round(((zt.boards || 1) * 10 + (zt.sealRatio || 0) * 2 - (zt.breakCount || 0) * 3 +
        (zt.firstSealMin != null && zt.firstSealMin <= 30 ? 5 : 0)) * 10) / 10
    : (att && att.heatScore != null ? att.heatScore : null);
  if (heat == null || independent <= 3 || industryRet5 >= 8) return null;
  const sc = compose([
    { k: 'independent', label: '独立超额', weight: 0.40, score: scoreRange(independent, 3, 20), desc: '相对行业+大盘独立超额' + (independent > 0 ? '+' : '') + independent + '%' },
    { k: 'ret5', label: '近5日收益', weight: 0.20, score: scoreRange(ret5, 0, 20), desc: '近5日收益' + (ret5 > 0 ? '+' : '') + ret5 + '%' },
    { k: 'heat', label: '热度分', weight: 0.30, score: scoreRange(heat, 15, 80), desc: '热度分' + heat + '（' + (zt ? '涨停结构' : '人气榜') + '）' },
    { k: 'excl', label: '独立性强', weight: 0.10, score: (zt ? 100 : 60), desc: '同期行业涨幅' + (industryRet5 > 0 ? '+' : '') + industryRet5 + '%，个股' + (industryRet5 < 3 ? '非行业普涨、独立性强' : '独立性一般') }
  ]);
  return {
    code, name: ctx.nameOf(code), industry: matchedTag,
    ret5, industryRet5, marketRet5: ctx.marketRet5, independent,
    heat, heatSource: zt ? '涨停结构' : '人气榜',
    boards: zt ? zt.boards : null,
    firstSealLabel: zt ? zt.firstSealLabel : null,
    peerCount: ((ctx.tagToCodes.get(matchedTag) || []).length - 1),
    score: sc.score, scoreParts: sc.parts,
    reason: '独立行情热度股：' + (matchedTag || '未分类') + '同期' + (industryRet5 > 0 ? '+' : '') + industryRet5 +
      '%，该股' + (ret5 > 0 ? '+' : '') + ret5 + '%，独立超额' + (independent > 0 ? '+' : '') + independent +
      '%（>3pct门槛）；' + (zt ? '有连板/封单热度证据' : '人气榜热度' + heat) + '。'
  };
}

/* ------------------------------ 四类选股新增判定 ------------------------------ */
/**
 * 低吸 dip：上升趋势中回踩短期均线、缩量不破位、收盘收回。
 * 与 rebound（超跌反弹）区分：低吸要求中期趋势仍向上（MA20 上行、收盘在 MA20 上方附近），
 * 回踩幅度温和（-1%~-8%），且回调缩量、收盘收在当日中上位置。
 */
function judgeDip(bars) {
  if (bars.length < 25) return null;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const m5 = ma(bars, bars.length - 1, 5);
  const m10 = ma(bars, bars.length - 1, 10);
  const m20 = ma(bars, bars.length - 1, 20);
  const m20Prev = ma(bars, bars.length - 2, 20);
  const m20Prev5 = ma(bars, bars.length - 6, 20);
  if (m5 == null || m10 == null || m20 == null || m20Prev == null || m20Prev5 == null) return null;
  // 中期趋势向上：MA20 连续走高
  const ma20Up = m20 > m20Prev && m20Prev >= m20Prev5;
  // 回踩：昨日或今日盘中触及 MA5/MA10 附近，收盘仍站上或贴近
  const touchedMa = Math.min(prev.l, last.l) <= m10 * 1.02 && Math.min(prev.l, last.l) >= m20 * 0.95;
  const closeAboveMa20 = last.c >= m20 * 0.99;
  if (!ma20Up || !touchedMa || !closeAboveMa20) return null;
  // 回踩幅度温和
  const ret5 = retPct(bars, 5);
  const ret20 = retPct(bars, 20);
  if (ret5 == null || ret20 == null || ret5 < -8 || ret20 < -3) return null;
  // 缩量回调：最近一日量 < 前5日均量
  const avg5Vol = bars.slice(-6, -1).reduce((s, b) => s + (b.v || 0), 0) / 5;
  const volShrink = avg5Vol > 0 && last.v ? Math.round(last.v / avg5Vol * 100) / 100 : null;
  if (volShrink == null || volShrink > 1.15) return null;
  // 收盘收回：收盘在当日振幅中上位
  const range = last.h - last.l;
  const closePos = range > 0 ? Math.round((last.c - last.l) / range * 1000) / 10 : null;
  if (closePos == null || closePos < 45) return null;
  const devMa10 = Math.round((last.c / m10 - 1) * 10000) / 100;
  const devMa20 = Math.round((last.c / m20 - 1) * 10000) / 100;
  const r14 = rsi(bars.map(b => b.c), 14);
  const sc = compose([
    { k: 'trend', label: '中期趋势', weight: 0.25, score: ma20Up ? 90 : 30, desc: 'MA20 连续走高（' + m20Prev5 + '→' + m20Prev + '→' + m20 + '）' },
    { k: 'pullback', label: '回踩幅度', weight: 0.25, score: scoreRange(ret5, -8, -1), desc: '近5日回撤' + (ret5 > 0 ? '+' : '') + ret5 + '%（温和回踩）' },
    { k: 'shrink', label: '缩量程度', weight: 0.25, score: scoreRange(volShrink, 1.15, 0.6), desc: '最新量/前5日均量=' + volShrink + '（缩量）' },
    { k: 'reclaim', label: '收盘收回', weight: 0.25, score: scoreRange(closePos, 45, 90), desc: '收盘位于当日振幅' + closePos + '%分位' }
  ]);
  return {
    code: null, name: null, last: last.c,
    ma5: m5, ma10: m10, ma20: m20, ma20Up, devMa10, devMa20,
    ret5, ret20, volShrink, closePos, rsi14: r14,
    touch: '回踩MA10附近（' + m10 + '），未破MA20（' + m20 + '）',
    score: sc.score, scoreParts: sc.parts,
    reason: '低吸·上升途中的缩量回踩：MA20 上行、近5日回撤' + (ret5 > 0 ? '+' : '') + ret5 +
      '%、量比' + volShrink + '、收盘位于振幅' + closePos + '%分位。',
    note: '低吸=趋势未破坏时的回踩关注，非抄底；是否延续取决于后续量价确认。'
  };
}

/**
 * 趋势突破 breakout：放量突破近 20 日平台/前高，均线多头排列。
 * 与 trend 规则B 区分：突破强调"当日放量有效站上前高 + 均线多头"，规则更严。
 */
function judgeBreakout(bars) {
  if (bars.length < 25) return null;
  const last = bars[bars.length - 1];
  const m5 = ma(bars, bars.length - 1, 5);
  const m10 = ma(bars, bars.length - 1, 10);
  const m20 = ma(bars, bars.length - 1, 20);
  if (m5 == null || m10 == null || m20 == null) return null;
  const maAlign = m5 > m10 && m10 > m20; // 多头排列
  if (!maAlign || last.c < m20) return null;
  // 前高：最近 20 日（不含今日）最高价
  const prior20 = bars.slice(-21, -1);
  const priorHigh = prior20.length ? Math.max(...prior20.map(b => b.h)) : null;
  if (priorHigh == null || last.c <= priorHigh) return null;
  const breakPct = Math.round((last.c / priorHigh - 1) * 10000) / 100;
  if (breakPct > 12) return null; // 过度偏离不追
  // 放量：当日量 > 前5日均量 1.3 倍
  const avg5Vol = bars.slice(-6, -1).reduce((s, b) => s + (b.v || 0), 0) / 5;
  const volBurst = avg5Vol > 0 && last.v ? Math.round(last.v / avg5Vol * 100) / 100 : null;
  if (volBurst == null || volBurst < 1.3) return null;
  // 实体阳线
  const isYang = last.c > last.o;
  if (!isYang) return null;
  const ret5 = retPct(bars, 5);
  const ret20 = retPct(bars, 20);
  const sc = compose([
    { k: 'break', label: '突破幅度', weight: 0.30, score: scoreRange(breakPct, 0, 6), desc: '收盘突破近20日高点' + breakPct + '%' },
    { k: 'vol', label: '放量程度', weight: 0.30, score: scoreRange(volBurst, 1.3, 2.5), desc: '当日量/前5日均量=' + volBurst },
    { k: 'align', label: '均线多头', weight: 0.25, score: 90, desc: 'MA5(' + m5 + ')>MA10(' + m10 + ')>MA20(' + m20 + ')' },
    { k: 'trend', label: '阶段强度', weight: 0.15, score: Math.max(scoreRange(ret5, 0, 15), scoreRange(ret20, 0, 30)), desc: '近5日' + (ret5 > 0 ? '+' : '') + ret5 + '%、近20日' + (ret20 > 0 ? '+' : '') + ret20 + '%' }
  ]);
  return {
    code: null, name: null, last: last.c,
    ma5: m5, ma10: m10, ma20: m20, maAlign,
    priorHigh: Math.round(priorHigh * 100) / 100, breakPct, volBurst,
    ret5, ret20, isYang,
    score: sc.score, scoreParts: sc.parts,
    reason: '趋势突破·放量站上近20日高点：突破' + breakPct + '%、量比' + volBurst +
      '、MA5>MA10>MA20 多头排列、收阳线。',
    note: '突破需次日站稳确认；高开低走或缩量回踩前高失败则形态失效。'
  };
}

/**
 * 打板 board：从涨停池中筛"早封 + 厚封单 + 可成交 + 追高风险可控"的标的。
 * 依赖 limitup-cache.json 的 zt[]（含 boards/sealRatio/breakCount/firstSealMin/chaseRisk/fillable）。
 * 数据缺失返回空数组，不编造。
 */
function judgeBoardFromCache(ctx) {
  const out = [];
  for (const z of (ctx.limitUpList || [])) {
    const boards = n(z.boards) || 1;
    const sealRatio = n(z.sealRatio);
    const breakCount = n(z.breakCount);
    const firstSealMin = n(z.firstSealMin);
    const chaseRisk = n(z.chaseRisk);
    // 早封（首封≤60分钟或标注早盘）、封单厚（sealRatio≥1）、开板少（≤1）、追高风险不过高
    const early = firstSealMin != null ? firstSealMin <= 60 : /早盘|秒板|一字/.test(z.firstSealLabel || '');
    const thick = sealRatio != null ? sealRatio >= 1 : false;
    const stable = breakCount != null ? breakCount <= 1 : false;
    if (!early || !thick || !stable) continue;
    if (chaseRisk != null && chaseRisk >= 80) continue;
    const sc = compose([
      { k: 'seal', label: '封单厚度', weight: 0.30, score: scoreRange(sealRatio, 1, 8), desc: '封单/流通市值=' + (sealRatio == null ? '?' : sealRatio) + '%' },
      { k: 'early', label: '首封时间', weight: 0.25, score: firstSealMin != null ? scoreRange(firstSealMin, 60, 5) : 70, desc: '首封' + (z.firstSealLabel || (firstSealMin != null ? firstSealMin + '分钟' : '?')) },
      { k: 'stable', label: '封板稳定', weight: 0.25, score: scoreRange(breakCount, 2, 0), desc: '开板次数' + (breakCount == null ? '?' : breakCount) },
      { k: 'risk', label: '追高风险', weight: 0.20, score: chaseRisk != null ? scoreRange(chaseRisk, 80, 20) : 50, desc: '追高风险' + (chaseRisk == null ? '未知' : chaseRisk) }
    ]);
    out.push({
      code: z.code, name: z.name || ctx.nameOf(z.code), industry: z.industry || null,
      boards, sealRatio, breakCount, firstSealMin,
      firstSealLabel: z.firstSealLabel || null, chaseRisk,
      fillable: z.fillable != null ? z.fillable : null,
      score: sc.score, scoreParts: sc.parts,
      reason: '打板·早封厚单：' + (z.firstSealLabel || '早盘首封') + '、封单比' + (sealRatio == null ? '?' : sealRatio) +
        '、开板' + (breakCount == null ? '?' : breakCount) + '次' + (boards > 1 ? '、' + boards + '连板' : '') + '。',
      note: '打板为高风险短线策略；一字/缩量秒板往往无法成交，fillable 为程序估算的可成交性，不保证成交。'
    });
  }
  out.sort((a, b) => (b.score - a.score) || ((a.breakCount || 0) - (b.breakCount || 0)));
  return out;
}

/* ------------------------------ 主流程 ------------------------------ */

async function refresh(opts = {}) {
  const universe = (opts.universe || collectUniverse());
  const st = readJson(path.join(DATA, 'strength-cache.json'));
  const industryByName = new Map();
  for (const x of (st && st.leaders) || []) {
    if (x.name && x.chg5 != null) industryByName.set(String(x.name), n(x.chg5));
  }
  const lk = readJson(path.join(DATA, 'limitup-cache.json'));
  const limitUpByCode = new Map();
  for (const x of (lk && lk.zt) || []) limitUpByCode.set(x.code, x);
  const att = readJson(path.join(DATA, 'attention-cache.json'));
  const attentionByCode = new Map();
  if (att && att.items) for (const [k, v] of Object.entries(att.items)) attentionByCode.set(k, v);

  // 市场 5 日收益：上证指数日 K（腾讯 sh000001 走 emtx 的 1.000001）
  let marketRet5 = null;
  try {
    const idx = await emtx.fetchKline('1.000001', BARS);
    const klines = (idx && idx.data && idx.data.klines) || [];
    if (klines.length > 6) {
      const a = n(String(klines[klines.length - 6]).split(',')[2]);
      const b = n(String(klines[klines.length - 1]).split(',')[2]);
      if (a && b) marketRet5 = Math.round((b / a - 1) * 10000) / 100;
    }
  } catch (_) {}
  if (marketRet5 == null) {
    try {
      const r = await fetch('https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=sh000001&scale=240&ma=no&datalen=12',
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn' }, signal: AbortSignal.timeout(9000) });
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length > 6) {
        const a = n(arr[arr.length - 6].close), b = n(arr[arr.length - 1].close);
        if (a && b) marketRet5 = Math.round((b / a - 1) * 10000) / 100;
      }
    } catch (_) {}
  }

  const byCode = new Map(universe.map(x => [x.code, x]));
  const nameOf = c => (byCode.get(c) || {}).name || (limitUpByCode.get(c) || {}).name || null;
  const sectorNames = Array.from(industryByName.keys());
  const industryOf = (c) => {
    const raw = (byCode.get(c) || {}).industry;
    if (raw && raw !== '未分类') return raw;
    // 用人气榜 conceptTags 匹配细分行业名，作为未分类标的的近似归属
    const tags = ((attentionByCode.get(c) || {}).conceptTags) || [];
    for (const tag of tags) {
      const hit = sectorNames.find(s => String(tag).includes(s) || String(s).includes(String(tag)));
      if (hit) return hit;
    }
    return raw || null;
  };
  const ret5ByCode = new Map();
  const tagToCodes = new Map();
  const universeCodes = new Set(universe.map(x => x.code));
  for (const [code, v] of attentionByCode) {
    if (!universeCodes.has(code)) continue;
    for (const tag of (v.conceptTags || [])) {
      const k = String(tag);
      if (!tagToCodes.has(k)) tagToCodes.set(k, []);
      tagToCodes.get(k).push(code);
    }
  }
  const limitUpList = Array.isArray(lk && lk.zt) ? lk.zt : [];
  const ctx = { industryByName, limitUpByCode, attentionByCode, nameOf, industryOf, marketRet5, ret5ByCode, tagToCodes, limitUpList };

  const trend = [], rebound = [], hot = [], dip = [], breakout = [];
  let fetched = 0, failed = 0;
  let cursor = 0;
  const errors = [];
  async function worker() {
    while (cursor < universe.length) {
      const item = universe[cursor++];
      try {
        if (REQUEST_GAP_MS) await sleep(REQUEST_GAP_MS);
        const { bars, source } = await fetchBars(item.code);
        fetched++;
        const t = judgeTrend(bars);
        if (t) trend.push({ ...t, code: item.code, name: item.name || nameOf(item.code), source });
        const r = judgeRebound(bars);
        if (r) rebound.push({ ...r, code: item.code, name: item.name || nameOf(item.code), source });
        const d = judgeDip(bars);
        if (d) dip.push({ ...d, code: item.code, name: item.name || nameOf(item.code), source });
        const bo = judgeBreakout(bars);
        if (bo) breakout.push({ ...bo, code: item.code, name: item.name || nameOf(item.code), source });
        const r5 = retPct(bars, 5);
        if (r5 != null) ret5ByCode.set(item.code, r5);
      } catch (e) {
        failed++;
        if (errors.length < 12) errors.push({ code: item.code, error: String(e.message || e).slice(0, 160) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, universe.length) }, () => worker()));

  for (const item of universe) {
    try { const h = judgeHot(item.code, ctx); if (h) hot.push(h); } catch (_) {}
  }
  // 打板：直接来自涨停池结构数据，不额外拉 K 线
  let board = [];
  try { board = judgeBoardFromCache(ctx); } catch (e) { console.warn('[screener][board]', e.message); }
  // 人气榜只给代码：对入选的热度股补一次名称查询（数量很少）
  for (const h of hot) {
    if (h.name) continue;
    try { const lk = await emtx.lookupCode(h.code); if (lk.ok) h.name = lk.name; } catch (_) {}
  }

  // 按量化评分降序排序，同分再按原口径（破MA5次数/下影/独立超额）排序
  trend.sort((a, b) => (b.score - a.score) || (a.breaks - b.breaks) || (String(a.code).localeCompare(String(b.code))));
  rebound.sort((a, b) => (b.score - a.score) || ((b.shadowPct || 0) - (a.shadowPct || 0)));
  hot.sort((a, b) => (b.score - a.score) || ((b.independent || 0) - (a.independent || 0)));
  dip.sort((a, b) => (b.score - a.score) || ((a.volShrink || 9) - (b.volShrink || 9)));
  breakout.sort((a, b) => (b.score - a.score) || ((b.volBurst || 0) - (a.volBurst || 0)));
  const focusN = Math.max(3, Math.min(10, Number(process.env.SCREEN_FOCUS_N || 5)));
  const focusOf = (arr, kind) => arr.slice(0, focusN).map(x => ({
    code: x.code, name: x.name, score: x.score,
    rule: x.rule || null, reason: x.reason || null,
    keyMetric: kind === 'dip' ? ('回撤' + (x.ret5 > 0 ? '+' : '') + x.ret5 + '%·量比' + x.volShrink) :
      kind === 'breakout' ? ('突破' + x.breakPct + '%·量比' + x.volBurst) :
      kind === 'board' ? ((x.boards || 1) + '板·封单' + (x.sealRatio == null ? '?' : x.sealRatio)) :
      x.rule ? ('规则' + x.rule + '·破MA5 ' + x.breaks + '次') :
      (x.ret20 != null ? ('20日' + x.ret20 + '%·下影' + x.shadowPct + '%') :
        ('独立超额' + (x.independent > 0 ? '+' : '') + x.independent + '%'))
  }));

  const common = {
    generatedAt: bjNow(),
    source: 'emtx.fetchKline（东财 → 腾讯 qfq）→ 新浪日K（限流时接管，不复权）',
    universe: { total: universe.length, fetched, failed },
    marketRet5, errors
  };
  const SCORING_NOTE = '量化评分 0–100：由各分项按权重加权（分项含规则强度/超额/超跌幅度/下影/收盘位置/量能等），仅为筛选排序的相对强弱，不是涨跌预测、不是买卖建议。';
  const trendOut = {
    ...common,
    rule: '规则A：最近3个交易日 close≥MA5；规则B：近5日 close<MA5 不超过1天，且窗口内最高价>此前20日最高价（创新高）。满足 A 或 B 即入选。',
    scoring: SCORING_NOTE,
    focus: focusOf(trend),
    items: trend
  };
  const reboundOut = {
    ...common,
    rule: '超跌（20日收益≤-15% 或 RSI14≤30 或 收盘偏离MA20≤-10%）+ 长下影（下影≥2×ATR14 且≥1.5%股价）+ 收盘位于当日振幅上40%。无分钟数据时尾盘用日线代理。',
    scoring: SCORING_NOTE,
    focus: focusOf(rebound),
    items: rebound
  };
  const hotOut = {
    ...common,
    rule: '独立行情：个股近5日收益 − 同名行业近5日涨幅 − 上证近5日收益 > 3pct，且行业未整体大涨(<8%)，并有涨停结构或人气榜热度证据。行业未匹配时不入选。',
    note: '行业收益用人气榜 conceptTags 的同标签同伴平均5日收益近似，取最强同伴组为基准；同伴<2只则不入选，避免编造行业收益。',
    scoring: SCORING_NOTE,
    focus: focusOf(hot),
    items: hot
  };
  const dipOut = {
    ...common,
    kind: 'dip', kindLabel: '低吸',
    rule: '上升趋势中的缩量回踩：MA20 连续走高、回踩至 MA10 附近未破 MA20、近5日回撤 -1%~-8%、量比≤1.15、收盘位于当日振幅≥45%分位。',
    scoring: SCORING_NOTE,
    focus: focusOf(dip, 'dip'),
    items: dip
  };
  const boardOut = {
    ...common,
    kind: 'board', kindLabel: '打板',
    rule: '来自当日涨停池：首封≤60分钟（或早盘/秒板）、封单比≥1%、开板≤1次、追高风险<80。数据缺失不编造。',
    scoring: SCORING_NOTE,
    note: '打板为高风险短线策略；一字/秒板可能无法成交，fillable 为程序估算，不保证成交。',
    focus: focusOf(board, 'board'),
    items: board
  };
  const breakoutOut = {
    ...common,
    kind: 'breakout', kindLabel: '趋势突破',
    rule: '放量突破：收盘站上近20日最高价（突破≤12%）、当日量/前5日均量≥1.3、MA5>MA10>MA20 多头排列、收阳线。',
    scoring: SCORING_NOTE,
    note: '突破需次日站稳确认；高开低走或缩量回踩前高失败则形态失效。',
    focus: focusOf(breakout, 'breakout'),
    items: breakout
  };

  writeJson(F_TREND, trendOut);
  writeJson(F_REBOUND, reboundOut);
  writeJson(F_HOT, hotOut);
  writeJson(F_DIP, dipOut);
  writeJson(F_BOARD, boardOut);
  writeJson(F_BREAKOUT, breakoutOut);
  // 生成行业/上涨原因/领跑跟随解释层（失败不阻塞选股主流程）
  let insight = null;
  try {
    const pickInsight = require('./pick-insight');
    insight = pickInsight.build();
  } catch (e) { console.warn('[screener][pick-insight]', e.message); }
  // 四类合并视图 + 次日备选观察池/风险规避池：随选股刷新同步重建，保证前端/复盘/智能体读到同一版
  try { require('./strategy').build(); }
  catch (e) { console.warn('[screener][strategy]', e.message); }
  // 兼容旧 ma5-screen.json 消费者
  writeJson(F_MA5, {
    generatedAt: Date.now(),
    days: 5,
    rule: trendOut.rule,
    source: common.source,
    results: trend.map(x => ({
      code: x.code, name: x.name, score: null,
      breaks: x.breaks, days: x.days, last: x.last,
      rule: x.rule, newHigh: x.newHigh, src: x.source
    }))
  });
  return {
    ok: true, generatedAt: common.generatedAt,
    universe: common.universe,
    counts: {
      trend: trend.length, rebound: rebound.length, hot: hot.length,
      dip: dip.length, board: board.length, breakout: breakout.length,
      fourClass: { trend: trend.length, dip: dip.length, board: board.length, breakout: breakout.length }
    },
    insight: insight ? { items: insight.items.length, leaders: insight.leaders.length } : null,
    marketRet5, errors: errors.length
  };
}

function status() {
  const read = f => {
    const j = readJson(f);
    return j ? { generatedAt: j.generatedAt, count: (j.items || j.results || []).length, rule: j.rule || null } : null;
  };
  return {
    ok: true, trend: read(F_TREND), rebound: read(F_REBOUND), hot: read(F_HOT),
    dip: read(F_DIP), board: read(F_BOARD), breakout: read(F_BREAKOUT),
    ma5: read(F_MA5), limit: LIMIT
  };
}

module.exports = {
  refresh, status, collectUniverse,
  judgeTrend, judgeRebound, judgeHot, judgeDip, judgeBreakout, judgeBoardFromCache,
  F_TREND, F_REBOUND, F_HOT, F_DIP, F_BOARD, F_BREAKOUT
};
