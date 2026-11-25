'use strict';

/**
 * stock-analysis.js — 个股「常规量化评分 + 技术指标」解释层
 *
 * 目标：让「个股分析」不再只看单一筛选规则或智能体自由文本，而是给出一套可复算的
 * 0–100 量化评分、分项权重、技术指标原值与风险提示。该评分属于【新增的个股解释分】，
 * 不修改 stocks.js 原有观察池评分，也不改三类选股的入选规则。
 *
 * 数据来源：
 *   - 东财前复权日线（emtx.fetchKline）→ 腾讯 qfq → 新浪日K 兜底；
 *   - 系统已有快照：stocks.js 综合评分、三类选股标签、事件库、消息面脉冲、市值重估候选。
 *
 * 反幻觉纪律：
 *   - 所有指标均由真实 K 线计算，缺数据标 null 并说明，不用 0 填充；
 *   - 评分为横截面相对强弱的解释性打分，不预测涨跌、不输出目标价、不给买卖建议；
 *   - 消息面 / 事件 / 系统原有评分仅作为上下文展示，默认不混入本次技术量化总分。
 */

const fs = require('node:fs');
const path = require('node:path');
const emtx = require('./emtx');
const stocks = require('./stocks');
const technical = require('./technical');
const newsPulse = require('./news-pulse');

const DATA = path.join(__dirname, '..', 'data');
const BARS = 80;
const TTL = 5 * 60 * 1000;
const CACHE = new Map();

function round(v, n = 2) {
  if (!Number.isFinite(Number(v))) return null;
  const p = Math.pow(10, n);
  return Math.round(Number(v) * p) / p;
}
function clamp(v, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo)); }
function scoreRange(x, bad, good, max = 100) {
  if (x == null || !Number.isFinite(Number(x))) return 0;
  const v = Number(x);
  if (good > bad) {
    if (v <= bad) return 0;
    if (v >= good) return max;
    return Math.round((v - bad) / (good - bad) * max);
  }
  if (v >= bad) return 0;
  if (v <= good) return max;
  return Math.round((bad - v) / (good - bad) * max);
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}
function secidOf(code) { return (/^6/.test(code) ? '1.' : '0.') + code; }
/** technical.js 的 normalizeBars 使用短字段名 o/c/h/l/v/a，这里做一次显式映射。 */
function shortBars(bars) {
  return (bars || []).map(b => ({ d: b.date, o: b.open, c: b.close, h: b.high, l: b.low, v: b.volume, a: b.amount }));
}

/* ------------------------------ 日线获取 ------------------------------ */

function parseKline(j) {
  const d = j && j.data;
  if (!d || !Array.isArray(d.klines)) return null;
  const bars = [];
  let prevClose = null;
  for (const line of d.klines) {
    const f = String(line).split(',');
    const bar = {
      date: f[0],
      open: Number(f[1]), close: Number(f[2]), high: Number(f[3]), low: Number(f[4]),
      volume: Number(f[5]), amount: Number(f[6]),
      pct: Number.isFinite(Number(f[8])) && Number(f[8]) !== 0 ? Number(f[8]) : null,
      turnover: Number(f[10]) || null
    };
    if (!bar.date || ![bar.open, bar.close, bar.high, bar.low, bar.volume].every(Number.isFinite) || bar.close <= 0) continue;
    if (bar.pct == null && prevClose) bar.pct = round((bar.close / prevClose - 1) * 100, 2);
    prevClose = bar.close;
    bars.push(bar);
  }
  return bars.length >= 25 ? { name: d.name || null, bars, source: j._source || 'emtx' } : null;
}

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
    const bars = [];
    let prevClose = null;
    for (const x of arr.slice(-BARS)) {
      const bar = {
        date: String(x.day || '').slice(0, 10),
        open: Number(x.open), close: Number(x.close), high: Number(x.high), low: Number(x.low),
        volume: Number(x.volume), amount: null, pct: null, turnover: null
      };
      if (!bar.date || ![bar.open, bar.close, bar.high, bar.low, bar.volume].every(Number.isFinite)) continue;
      if (prevClose) bar.pct = round((bar.close / prevClose - 1) * 100, 2);
      prevClose = bar.close;
      bars.push(bar);
    }
    if (bars.length < 25) throw new Error('sina 日线不足');
    return { name: null, bars, source: 'sina(不复权)' };
  } finally { clearTimeout(timer); }
}

async function fetchBars(code) {
  let lastErr = null;
  // 北交所 secid 口径不稳定，直接走新浪；沪深走东财/腾讯故障转移。
  if (!/^(4|8)/.test(code)) {
    try {
      const parsed = parseKline(await emtx.fetchKline(secidOf(code), BARS));
      if (parsed) return parsed;
      throw new Error('K线解析为空');
    } catch (e) { lastErr = e; }
  }
  try { return await fetchSinaBars(code); }
  catch (e2) { throw new Error('emtx=' + (lastErr && lastErr.message || 'skip') + '; sina=' + e2.message); }
}

/* ------------------------------ 指标与评分 ------------------------------ */

function maSeries(closes, n) {
  const out = [];
  for (let i = 0; i < closes.length; i++) {
    out.push(i >= n - 1 ? round(closes.slice(i - n + 1, i + 1).reduce((s, x) => s + x, 0) / n, 3) : null);
  }
  return out;
}

function buildTechnical(bars, ind, kdjObj) {
  const closes = bars.map(b => b.close);
  const last = bars[bars.length - 1];
  const ma5Series = maSeries(closes, 5);
  let holdMa5 = 0;
  for (let i = ma5Series.length - 1; i >= 0; i--) {
    if (ma5Series[i] != null && closes[i] >= ma5Series[i]) holdMa5++;
    else break;
  }
  const w60 = bars.slice(-60);
  const high60 = Math.max(...w60.map(b => b.high));
  const low60 = Math.min(...w60.map(b => b.low));
  const pos60 = high60 > low60 ? round((last.close - low60) / (high60 - low60) * 100, 1) : 50;
  const range = last.high - last.low;
  const upperPct = last.close ? round((last.high - Math.max(last.open, last.close)) / last.close * 100, 2) : null;
  const lowerPct = last.close ? round((Math.min(last.open, last.close) - last.low) / last.close * 100, 2) : null;
  return {
    last: round(last.close), tradingDate: last.date,
    ma: { ma5: round(ind.ma5), ma10: round(ind.ma10), ma20: round(ind.ma20), ma60: round(ind.ma60 != null ? ind.ma60 : null) },
    macd: { dif: round(ind.dif, 4), dea: round(ind.dea, 4), hist: round(ind.hist, 4), histPrev: round(ind.histPrev, 4) },
    rsi14: round(ind.rsi14, 1),
    boll: { up: round(ind.bollUp), low: round(ind.bollLow), pos: round(ind.bollPos, 3) },
    kdj: kdjObj && kdjObj.last ? { k: round(kdjObj.last.k, 2), d: round(kdjObj.last.d, 2), j: round(kdjObj.last.j, 2), cross: kdjObj.cross } : null,
    atr14: round(ind.atr, 3), atrPct: round(ind.atrPct, 2),
    volatility: round(ind.volatility, 1), maxDD: round(ind.maxDD, 2),
    volRatio5: round(ind.volRatio5, 2), zScore: round(ind.zScore, 2), retZ: round(ind.retZ, 2),
    mom5: round(ind.mom5, 2), mom20: round(ind.mom20, 2),
    pos60, high60: round(high60), low60: round(low60), high20: round(ind.high20),
    holdMa5Days: holdMa5,
    shadow: { upperPct, lowerPct, rangePct: round(range && last.close ? range / last.close * 100 : null, 2) },
    volume: { last: round(last.volume, 0), amount: Number.isFinite(last.amount) ? round(last.amount, 0) : null, turnover: last.turnover != null ? round(last.turnover, 2) : null }
  };
}

function scoreParts(ind, t, row) {
  const parts = [];
  const add = (key, label, weight, score, desc) => parts.push({
    key, label, weight, score: clamp(Math.round(score)), weighted: round(clamp(score) * weight / 100, 1), desc
  });

  let trend = 50;
  trend += t.last > t.ma.ma5 ? 10 : -10;
  trend += t.last > t.ma.ma10 ? 8 : -8;
  trend += t.last > t.ma.ma20 ? 12 : -12;
  trend += t.ma.ma5 > t.ma.ma10 ? 8 : -8;
  trend += t.ma.ma10 > t.ma.ma20 ? 8 : -8;
  if (ind.ma20Prev) trend += ind.ma20 > ind.ma20Prev ? 6 : -6;
  add('trend', '趋势结构', 20, trend,
    '收盘 ' + t.last + '，MA5/10/20=' + [t.ma.ma5, t.ma.ma10, t.ma.ma20].join('/') +
    '；连续站上MA5 ' + t.holdMa5Days + ' 日');

  const m5 = clamp(50 + t.mom5 * 3.2 - Math.max(0, t.mom5 - 20) * 2);
  const m20 = clamp(50 + t.mom20 * 1.6 - Math.max(0, t.mom20 - 40) * 1.2);
  const momentum = 0.6 * m5 + 0.4 * m20;
  add('momentum', '动量强度', 14, momentum,
    '近5日 ' + (t.mom5 > 0 ? '+' : '') + t.mom5 + '%，近20日 ' + (t.mom20 > 0 ? '+' : '') + t.mom20 + '%（短线过热会回扣）');

  let macd = 50;
  macd += t.macd.dif > t.macd.dea ? 20 : -20;
  macd += t.macd.hist > 0 ? 10 : -10;
  macd += t.macd.hist > t.macd.histPrev ? 10 : -10;
  macd += t.macd.dif > 0 ? 8 : -8;
  add('macd', 'MACD', 10, macd,
    'DIF ' + t.macd.dif + ' / DEA ' + t.macd.dea + ' / 柱 ' + t.macd.hist +
    '（' + (t.macd.dif > t.macd.dea ? '多头排列' : '空头排列') + '）');

  const r = t.rsi14;
  const rsi = r >= 45 && r <= 65 ? 88 : r > 65 && r <= 72 ? 68 : r >= 35 && r < 45 ? 62
    : r > 72 && r <= 78 ? 42 : r > 78 ? 25 : 40;
  add('rsi', 'RSI 位置', 8, rsi, 'RSI14=' + r + '（45–65 为常态强势区，>78 超买、<35 偏弱）');

  const p = t.boll.pos;
  const boll = p >= 0.45 && p <= 0.82 ? 86 : p > 0.82 && p <= 0.95 ? 60 : p >= 0.2 && p < 0.45 ? 62
    : p > 0.95 ? 34 : 40;
  add('boll', '布林位置', 6, boll, '收盘位于布林带 ' + round(p * 100, 1) + '% 分位（上轨 ' + t.boll.up + ' / 下轨 ' + t.boll.low + '）');

  let kdjScore = 50;
  const kdj = t.kdj;
  if (kdj) {
    kdjScore += kdj.k > kdj.d ? 10 : -10;
    kdjScore += kdj.cross === 'gold' ? 12 : kdj.cross === 'dead' ? -12 : 0;
    kdjScore += kdj.j < 10 ? 6 : kdj.j > 95 ? -12 : 0;
    kdjScore += kdj.k >= 35 && kdj.k <= 80 ? 8 : -5;
    add('kdj', 'KDJ(9,3,3)', 8, kdjScore,
      'K/D/J=' + kdj.k + '/' + kdj.d + '/' + kdj.j + '，' + (kdj.cross === 'gold' ? '金叉' : kdj.cross === 'dead' ? '死叉' : '无交叉'));
  } else add('kdj', 'KDJ(9,3,3)', 8, 50, '日线不足，KDJ 不可得，按中性处理并降低可信度');

  const vr = t.volRatio5;
  const vol = vr >= 1.1 && vr <= 2.8 && t.mom5 > 0 ? 86 : vr > 4 ? 48 : vr < 0.8 ? 42 : 62;
  add('volume', '量价配合', 10, vol,
    '最新量/前5日均量=' + vr + '，近5日收益 ' + (t.mom5 > 0 ? '+' : '') + t.mom5 + '%');

  let posScore = scoreRange(t.pos60, 10, 70);
  if (t.pos60 > 92) posScore = Math.min(posScore, 38);
  if (Math.abs(t.zScore) > 2.5) posScore = Math.min(posScore, 40);
  add('position', '60日位置', 8, posScore,
    '处于近60日 ' + t.pos60 + '% 分位；Z-score=' + t.zScore + '（高位拥挤/异常偏离会降分）');

  let risk = 100;
  const riskNotes = [];
  if (t.volatility > 90) { risk -= 25; riskNotes.push('年化波动率 ' + t.volatility + '% 偏高'); }
  else if (t.volatility > 60) { risk -= 14; riskNotes.push('年化波动率 ' + t.volatility + '% 偏高'); }
  if (t.maxDD < -20) { risk -= 15; riskNotes.push('近20日最大回撤 ' + t.maxDD + '%'); }
  else if (t.maxDD < -10) { risk -= 8; riskNotes.push('近20日最大回撤 ' + t.maxDD + '%'); }
  if (t.atrPct > 7) { risk -= 12; riskNotes.push('ATR 占股价 ' + t.atrPct + '%'); }
  else if (t.atrPct > 4) { risk -= 6; riskNotes.push('ATR 占股价 ' + t.atrPct + '%'); }
  if (!riskNotes.length) riskNotes.push('波动率、ATR 与近20日回撤未触发明显风险阈值');
  add('risk', '波动与回撤', 10, risk, riskNotes.join('；'));

  const amountYi = row && Number.isFinite(Number(row.f6)) ? Number(row.f6) / 1e8 :
    (t.volume.amount ? t.volume.amount / 1e8 : null);
  const turnover = t.volume.turnover != null ? t.volume.turnover : (row && Number.isFinite(Number(row.f8)) ? Number(row.f8) : null);
  let liq = amountYi == null ? 50 : amountYi >= 5 ? 85 : amountYi >= 1 ? 65 : amountYi >= 0.5 ? 50 : 35;
  if (turnover != null) liq = 0.7 * liq + 0.3 * (turnover >= 3 && turnover <= 12 ? 85 : turnover >= 1 && turnover < 3 ? 65 : turnover > 22 ? 35 : 52);
  add('liquidity', '流动性与活跃度', 6, liq,
    '成交额 ' + (amountYi != null ? round(amountYi, 2) + '亿' : '无数据') + '，换手率 ' + (turnover != null ? turnover + '%' : '无数据'));

  const score = Math.round(parts.reduce((s, p) => s + p.score * p.weight, 0) / 100);
  return { score, parts, riskNotes };
}

function levelOf(score) {
  if (score >= 78) return { label: '强', note: '多项技术维度同向偏强，仍非涨跌预测。' };
  if (score >= 60) return { label: '偏强', note: '多数维度偏强，但有分项制约。' };
  if (score >= 42) return { label: '中性', note: '多空信号混杂，缺少一致方向。' };
  if (score >= 25) return { label: '偏弱', note: '多数维度偏弱，风险项需优先看。' };
  return { label: '弱', note: '技术结构明显偏弱，不把低分等同于马上会跌。' };
}

function buildSignals(t, parts) {
  const out = [];
  const push = (type, label, detail) => out.push({ type, label, detail });
  if (t.last > t.ma.ma20 && t.ma.ma5 > t.ma.ma20) push('positive', '均线多头', '收盘在 MA20 上方且 MA5 > MA20');
  if (t.macd.dif > t.macd.dea && t.macd.hist > 0) push('positive', 'MACD 多头', 'DIF 在 DEA 上方且柱体为正');
  if (t.kdj && t.kdj.cross === 'gold') push('positive', 'KDJ 金叉', 'K 上穿 D');
  if (t.kdj && t.kdj.cross === 'dead') push('negative', 'KDJ 死叉', 'K 下穿 D');
  if (t.rsi14 > 78) push('negative', 'RSI 超买', 'RSI14=' + t.rsi14 + '，短线拥挤');
  if (t.rsi14 < 30) push('negative', 'RSI 偏弱', 'RSI14=' + t.rsi14 + '，动量不足（不等于一定继续跌）');
  if (t.pos60 > 92) push('negative', '60日高位', '收盘接近近60日最高区间，追高风险上升');
  if (t.pos60 < 12) push('negative', '60日低位', '收盘接近近60日最低区间，趋势仍弱');
  if (t.volatility > 60) push('negative', '高波动', '年化波动率 ' + t.volatility + '%');
  if (t.volRatio5 > 1.1 && t.mom5 > 0) push('positive', '量价配合', '上涨伴随温和放量');
  if (t.shadow.lowerPct != null && t.shadow.lowerPct >= 2) push('positive', '长下影', '当日下影约 ' + t.shadow.lowerPct + '%');
  if (t.shadow.upperPct != null && t.shadow.upperPct >= 2) push('negative', '长上影', '当日上影约 ' + t.shadow.upperPct + '%');
  for (const p of parts) {
    if (p.score >= 82 && !out.some(x => x.label === p.label)) push('positive', p.label, p.desc);
    else if (p.score <= 30 && !out.some(x => x.label === p.label)) push('negative', p.label, p.desc);
  }
  return out.slice(0, 12);
}

/* ------------------------------ 交易参考（技术测算） ------------------------------ */

/**
 * 由真实日线推导「技术交易参考位」：回踩买入区间、上方止盈/承压位、风险控制位。
 * 全部为技术测算区间，不是价格预测也不是买卖指令；用户要求展示，但必须带安全提示。
 */
function buildTradePlan(t, score) {
  const p = Number(t && t.last);
  if (!Number.isFinite(p) || p <= 0) return null;
  const atr = Number.isFinite(t.atr14) && t.atr14 > 0 ? t.atr14 : round(p * 0.02, 3);
  const below = [], above = [];
  const addLevel = (label, v) => {
    if (!Number.isFinite(Number(v)) || Number(v) <= 0) return;
    const price = round(Number(v), 2);
    if (price < p) below.push({ label, price, pct: round((price / p - 1) * 100, 2) });
    else if (price > p) above.push({ label, price, pct: round((price / p - 1) * 100, 2) });
  };
  addLevel('MA5', t.ma && t.ma.ma5);
  addLevel('MA10', t.ma && t.ma.ma10);
  addLevel('MA20', t.ma && t.ma.ma20);
  addLevel('MA60', t.ma && t.ma.ma60);
  addLevel('布林下轨', t.boll && t.boll.low);
  addLevel('布林上轨', t.boll && t.boll.up);
  addLevel('60日低点', t.low60);
  addLevel('60日高点', t.high60);
  addLevel('20日高点', t.high20);
  below.sort((a, b) => b.price - a.price);
  above.sort((a, b) => a.price - b.price);
  // 同价位（差 <0.5%）合并标签，避免「60日高点/20日高点」被算成两档不同目标
  const dedupe = arr => arr.reduce((out, x) => {
    const last = out[out.length - 1];
    if (last && Math.abs(last.price - x.price) / Math.max(last.price, 1) < 0.005) {
      if (!last.label.includes(x.label)) last.label += '/' + x.label;
      return out;
    }
    out.push(x);
    return out;
  }, []);
  const supports = dedupe(below);
  const resistances = dedupe(above);

  // 回踩买入参考：最近支撑与 1.5 ATR 之间，不高于现价
  const s1 = supports[0] ? supports[0].price : round(p - atr, 2);
  const buyLow = round(Math.max(s1, p - 2.2 * atr), 2);
  const buyHigh = round(Math.min(p, s1 + 0.6 * atr), 2);
  // 突破买入参考：站稳第一压力位即确认，不用外推价覆盖真实压力位
  const r1 = resistances[0] ? resistances[0].price : round(p + 1.5 * atr, 2);
  const breakHigh = round(r1, 2);

  // 止盈参考：取最近两档压力；不足时用 ATR 倍数外推
  const take1 = resistances[0] ? resistances[0].price : round(p + 1.5 * atr, 2);
  const take2 = resistances[1] ? resistances[1].price : round(p + 3 * atr, 2);
  // 风险控制位：第二支撑与 2 ATR 取更低，避免把止损放在过近的噪音区
  const s2 = supports[1] ? supports[1].price : round(p - 2 * atr, 2);
  const stop = round(Math.min(s2, p - 1.8 * atr), 2);

  const pct = v => round((v / p - 1) * 100, 2);
  // 仓位上限参考：技术分分档 + 高波动/高回撤折减，只作为风险预算示意
  let positionMax = score >= 78 ? 30 : score >= 60 ? 20 : score >= 42 ? 10 : 0;
  if (t.volatility > 70 || (t.maxDD != null && t.maxDD < -18)) positionMax = Math.min(positionMax, 10);
  if (t.pos60 > 92) positionMax = Math.min(positionMax, 10);

  return {
    last: round(p, 2),
    atr: round(atr, 3), atrPct: round(atr / p * 100, 2),
    buyZone: {
      label: '回踩买入参考区',
      low: buyLow, high: buyHigh,
      pctLow: pct(buyLow), pctHigh: pct(buyHigh),
      basis: supports[0] ? ('下方最近支撑 ' + supports[0].label + ' ' + supports[0].price + '，叠加约 1.5 ATR') : ('按约 1.5–2.2 ATR 外推')
    },
    breakout: {
      label: '突破确认参考位',
      price: breakHigh, pct: pct(breakHigh),
      basis: resistances[0] ? ('上方最近压力 ' + resistances[0].label + ' ' + resistances[0].price + '，站稳后再看') : ('按约 1.5 ATR 外推')
    },
    takeProfit: [
      { label: '第一目标（近压力）', price: round(take1, 2), pct: pct(take1),
        basis: resistances[0] ? resistances[0].label : '1.5 ATR' },
      { label: '第二目标（次压力）', price: round(take2, 2), pct: pct(take2),
        basis: resistances[1] ? resistances[1].label : '3 ATR' }
    ],
    pressure: resistances.slice(0, 4).map(x => ({ label: x.label, price: x.price, pct: x.pct })),
    support: supports.slice(0, 4).map(x => ({ label: x.label, price: x.price, pct: x.pct })),
    stopLoss: {
      label: '风险控制参考位',
      price: stop, pct: pct(stop),
      basis: supports[1] ? ('第二支撑 ' + supports[1].label + ' ' + supports[1].price + ' 与 1.8 ATR 取低') : ('按约 1.8 ATR 外推')
    },
    positionMaxPct: positionMax,
    positionBasis: '仅按技术分档与波动/回撤折减给出的单一标的风险预算上限示意，不代表应持仓比例。',
    safetyNotice: '安全提示：以上价位与百分比均由历史日线按固定公式测算，不是涨跌预测、不是买卖指令，也不构成投资建议。跳空、停牌、涨跌停、除权除息或突发消息都可能使技术位失效；请结合最新公告、自身风险承受能力与资金安排独立决策，并严格控制单一标的仓位。'
  };
}

/* ------------------------------ 上下文信息 ------------------------------ */

function findScreenTags(code) {
  const files = [
    { kind: '趋势', file: 'trend-screen.json' },
    { kind: '反弹', file: 'rebound-screen.json' },
    { kind: '热度/独立行情', file: 'hot-screen.json' }
  ];
  const out = [];
  for (const f of files) {
    const j = readJson(path.join(DATA, f.file));
    const item = j && Array.isArray(j.items) ? j.items.find(x => x.code === code) : null;
    if (item) out.push({ kind: f.kind, score: item.score != null ? item.score : null, reason: item.reason || item.rule || null });
  }
  return out;
}

function buildContext(code, name, opts) {
  const latest = opts.latest || {};
  const sys = Array.isArray(latest.stocks && latest.stocks.items)
    ? latest.stocks.items.find(x => x.code === code) : null;
  const pulse = newsPulse.latest();
  const att = readJson(path.join(DATA, 'attention-cache.json'));
  const tags = [name, (att && att.items && att.items[code] && att.items[code].industry)].filter(Boolean)
    .concat((att && att.items && att.items[code] && att.items[code].conceptTags) || []);
  let bias = null;
  if (pulse) {
    for (const tag of tags) {
      bias = newsPulse.matchSectorBias(tag, pulse.sectors || []);
      if (bias) break;
    }
  }
  const events = ((latest.events && latest.events.items) || []).filter(x => x.code === code).slice(0, 5)
    .map(e => ({ type: e.type, label: e.label || e.type, title: e.title, ts: e.ts }));
  const val = readJson(path.join(DATA, 'valuation-cache.json'));
  const valuation = val && Array.isArray(val.candidates) ? val.candidates.find(x => x.code === code) : null;
  return {
    systemScore: sys ? { score: sys.score, signal: sys.signal, reason: sys.reason || null } : null,
    screenTags: findScreenTags(code),
    newsBias: bias ? { sector: bias.sector, score: bias.score, direction: bias.direction, themes: bias.themes || [] } : null,
    events,
    valuation: valuation ? { score: valuation.score, verdict: valuation.verdictLabel, type: valuation.typeLabel, title: valuation.title } : null,
    note: '系统原评分、三类选股、消息面、事件与市值重估候选仅作为上下文展示，不并入本次通用技术量化总分。'
  };
}

/* ------------------------------ 主入口 ------------------------------ */

async function analyzeOne(code, opts = {}) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return { ok: false, error: '请输入 6 位数字股票代码' };
  const key = c + '|' + (opts.force ? 'force' : 'cache');
  if (!opts.force && !opts.noCache) {
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.at < TTL) return { ...hit.value, fromCache: true };
  }

  let lookup = null;
  try { lookup = await emtx.lookupCode(c); } catch (_) {}
  let fetched;
  try { fetched = await fetchBars(c); }
  catch (e) { return { ok: false, code: c, name: lookup && lookup.name ? lookup.name : null, error: e.message }; }

  const bars = fetched.bars;
  const ind = stocks.computeIndicators(bars);
  const normalized = technical.normalizeBars(shortBars(bars));
  const kdjObj = technical.kdj(normalized);
  const t = buildTechnical(bars, ind, kdjObj);
  const row = (opts.latest && Array.isArray(opts.latest.quotes)) ? opts.latest.quotes.find(q => q.code === c) : null;
  const { score, parts, riskNotes } = scoreParts(ind, t, row);
  const level = levelOf(score);
  const signals = buildSignals(t, parts);
  const tradePlan = buildTradePlan(t, score);

  let p0Factors = null;
  try {
    const calc = technical.computeFactors(normalized, {
      breadth: technical.readBreadth(), floatCap: row && row.floatCap ? row.floatCap : null,
      industry: null, industryStats: {}
    });
    p0Factors = calc ? { lastDate: calc.lastDate, factors: calc.factors, rules: calc.rules } : null;
  } catch (_) {}

  const value = {
    ok: true,
    code: c,
    name: (lookup && lookup.name) || fetched.name || (row && row.name) || c,
    generatedAt: Date.now(),
    tradingDate: t.tradingDate,
    quote: lookup && lookup.ok ? { price: lookup.price, changePct: lookup.changePct, market: lookup.market, source: lookup.source } : null,
    score,
    level: level.label,
    levelNote: level.note,
    scoreParts: parts,
    technical: t,
    signals,
    riskNotes,
    tradePlan,
    p0Factors,
    context: buildContext(c, (lookup && lookup.name) || fetched.name || (row && row.name), opts),
    dataQuality: {
      bars: bars.length,
      source: fetched.source,
      note: fetched.source === 'sina(不复权)' ? '腾讯/东财日线不可用，使用新浪不复权日K；复权口径差异会影响长周期位置类指标。' : '前复权日线，指标可复算。'
    },
    methodology: {
      score: '0–100 加权：趋势结构20 / 动量14 / MACD10 / RSI8 / 布林6 / KDJ8 / 量价10 / 60日位置8 / 波动回撤10 / 流动性6。分项均由真实日线计算，过热与高位拥挤会回扣。',
      indicators: 'MA5/10/20/60、MACD(12,26,9)、RSI14、布林(20,2)、KDJ(9,3,3)、ATR14、年化波动率、20日最大回撤、量比5、5/20日收益、Z-score、60日位置、上下影线与连续站上MA5天数。',
      boundary: '该评分是个股技术面解释分，不修改 stocks.js 原评分、不改三类选股入选规则；消息面/事件/系统原评分仅作上下文，不并入总分。',
      noForecast: '交易参考位由均线、布林带、60日高低点与 ATR 按固定公式测算，是技术区间而非涨跌预测；分档只代表当前技术结构相对状态。'
    },
    disclaimer: '技术指标基于历史价格，存在滞后与失效可能；复权口径、停牌、涨跌停与数据源差异都会影响结果。本页为技术测算信息，不构成投资建议。'
  };
  if (!opts.noCache) CACHE.set(key, { at: Date.now(), value });
  return value;
}

function status() {
  return { ok: true, cache: CACHE.size, ttlMs: TTL, bars: BARS };
}

module.exports = { analyzeOne, status, fetchBars, buildTechnical, scoreParts, levelOf };
