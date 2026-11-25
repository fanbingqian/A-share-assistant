'use strict';

/* ==========================================================================
 * market-regime.js — 市场级量化标注层（只读）
 *
 * 对应用户新增需求：
 *   #7  哪些板块带动指标上涨、哪些是「指标涨但板块不涨」
 *   #8  震荡期间的哑铃效应，结合「全球市场当下什么最赚钱」判别
 *   #9  经验：用户口述「昨天化学电子品主要上涨」→ 用真实板块数据校验
 *   #10 大盘层面的哑铃效应
 *   #11 股份回购价格区间 vs 现价对比、重点标注、实时提醒
 *
 * 【反幻觉纪律】
 *   - 板块贡献是「成交额加权的近似分解」，不是真实指数权重分解，明确标注；
 *   - 哑铃效应是风格横截面观察，不做涨跌预测、不给配置建议；
 *   - 回购公告标题 ≠ 事实（回购可能不执行、价格区间常需公告正文），
 *     「低于区间肯定上涨」改写为「价格偏离事实标注」，不构成涨跌保证；
 *   - 任何数据缺失都标「不可得」，不编造。
 * ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const DATA = path.join(__dirname, '..', 'data');

const readJson = f => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (_) { return null; } };
const r2 = v => Number.isFinite(Number(v)) ? +Number(v).toFixed(2) : null;
const bjHM = ts => new Date(Number(ts) + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');

/* ----------------------------------------------------------------------
 * #7 板块带动：贡献度 = 板块当日涨跌 × 成交额（近似，非真实指数权重）
 *   「指标涨但板块不涨」= 大盘指数收涨、而该板块当日涨跌 ≤0 或显著跑输
 * -------------------------------------------------------------------- */
function boardLeadership(style, strength) {
  const boards = (strength && Array.isArray(strength.boards)) ? strength.boards : [];
  if (!boards.length) return { ok: false, note: '板块强度快照不可得，无法计算带动关系' };
  const indexPct = style && style.volume && Number.isFinite(Number(style.volume.indexPct))
    ? Number(style.volume.indexPct) : (style && style.volume && Number(style.volume.shPct));
  const totalAmt = boards.reduce((s, x) => s + (Number(x.amountYi) || 0), 0);
  const rows = boards.map(b => {
    const chg = Number(b.chg1);
    const amt = Number(b.amountYi) || 0;
    const weight = totalAmt > 0 ? r2(amt / totalAmt * 100) : null;
    return {
      code: b.code, name: b.name, chg1: Number.isFinite(chg) ? r2(chg) : null,
      amountYi: r2(amt), weightPct: weight,
      contrib: Number.isFinite(chg) ? r2(chg * amt / 100) : null,
      up: b.up, down: b.down, breadth: b.breadth
    };
  }).filter(x => x.chg1 != null);
  const driving = rows.filter(x => x.chg1 > 0).sort((a, b) => (b.contrib || 0) - (a.contrib || 0)).slice(0, 8);
  const lagging = indexPct != null
    ? rows.filter(x => x.chg1 <= 0 || (indexPct > 0 && x.chg1 < indexPct * 0.3))
      .sort((a, b) => a.chg1 - b.chg1).slice(0, 8)
    : [];
  return {
    ok: true,
    indexPct: indexPct == null ? null : r2(indexPct),
    indexUp: indexPct != null ? indexPct > 0 : null,
    boardCount: rows.length,
    driving, lagging,
    basis: '贡献度 ≈ 板块当日涨跌(%) × 板块成交额(亿) / 100；按成交额加权排序，非交易所真实权重分解。',
    note: indexPct == null
      ? '指数当日涨跌幅不可得，「指标涨但板块不涨」仅按 chg1≤0 列出'
      : (indexPct > 0
        ? '指数收涨：lagging 为当日未涨或显著跑输指数的板块'
        : '指数未收涨：lagging 为当日下跌板块（不适用「指数涨板块不涨」口径）')
  };
}

/* ----------------------------------------------------------------------
 * #8 / #10 哑铃效应：市值层两端（微盘 + 大盘）vs 中间（小盘 + 中盘）
 *   全球端：风险资产（纳指/标普/BTC）vs 避险资产（黄金/美元/美债）
 * -------------------------------------------------------------------- */
const RISK_IDS = ['ndx', 'spx', 'dji', 'btc', 'n225'];
const SAFE_IDS = ['gold', 'xau', 'dxy', 'ust10y', 'ust30y'];

function barbell(style, quotes) {
  const buckets = (style && Array.isArray(style.buckets)) ? style.buckets : [];
  const find = kw => buckets.find(b => String(b.name || '').indexOf(kw) >= 0) || null;
  const micro = find('微盘'), small = find('小盘'), mid = find('中盘'), big = find('大盘');
  const usable = [micro, small, mid, big].filter(Boolean);
  if (usable.length < 4) return { ok: false, note: '市值分层快照不足 4 层，哑铃判据不可得' };
  const pick = (b, key) => Number.isFinite(Number(b && b[key])) ? Number(b[key]) : null;
  const ends = [micro, big], middle = [small, mid];
  const meanOf = (arr, key) => {
    const v = arr.map(b => pick(b, key)).filter(x => x != null);
    return v.length ? r2(v.reduce((a, c) => a + c, 0) / v.length) : null;
  };
  const ends1 = meanOf(ends, 'pct1'), mid1 = meanOf(middle, 'pct1');
  const ends5 = meanOf(ends, 'ret5'), mid5 = meanOf(middle, 'ret5');
  const spread1 = ends1 != null && mid1 != null ? r2(ends1 - mid1) : null;
  const spread5 = ends5 != null && mid5 != null ? r2(ends5 - mid5) : null;
  const isBarbell = spread1 != null && spread5 != null ? (spread1 > 0.15 || spread5 > 0.8) : null;

  const q = Array.isArray(quotes) ? quotes : [];
  const byId = new Map(q.map(x => [x.id, x]));
  const chgOf = id => {
    const x = byId.get(id);
    const v = Number(x && x.changePct);
    return Number.isFinite(v) ? v : null;
  };
  const risk = RISK_IDS.map(id => ({ id, chg: chgOf(id) })).filter(x => x.chg != null);
  const safe = SAFE_IDS.map(id => ({ id, chg: chgOf(id) })).filter(x => x.chg != null);
  const riskAvg = risk.length ? r2(risk.reduce((s, x) => s + x.chg, 0) / risk.length) : null;
  const safeAvg = safe.length ? r2(safe.reduce((s, x) => s + x.chg, 0) / safe.length) : null;
  let globalTilt = 'unknown';
  if (riskAvg != null && safeAvg != null) {
    if (riskAvg > safeAvg + 0.3) globalTilt = 'risk-on';
    else if (safeAvg > riskAvg + 0.3) globalTilt = 'risk-off';
    else globalTilt = 'mixed';
  }
  const best = q.filter(x => Number.isFinite(Number(x.changePct)))
    .sort((a, b) => Number(b.changePct) - Number(a.changePct)).slice(0, 3)
    .map(x => ({ id: x.id, name: x.short || x.name || x.id, chg: r2(x.changePct) }));

  const tiltNote = globalTilt === 'risk-on'
    ? '全球风险资产相对占优 → 哑铃的题材/微盘端更容易获得风险偏好支撑（横截面观察，非预测）'
    : globalTilt === 'risk-off'
      ? '全球避险资产相对占优 → 哑铃的大盘/价值端更容易获得防御性资金支撑（横截面观察，非预测）'
      : globalTilt === 'mixed' ? '全球风险与避险资产方向不显著，哑铃两端判别力弱'
        : '全球行情不可得，无法按「当下什么最赚钱」判别哑铃端';

  return {
    ok: true,
    isBarbell, spread1, spread5,
    layers: [micro, small, mid, big].map(b => ({ name: b.name, pct1: pick(b, 'pct1'), ret5: pick(b, 'ret5'), amountYi: pick(b, 'amountYi') })),
    ends: { pct1: ends1, ret5: ends5 }, middle: { pct1: mid1, ret5: mid5 },
    global: { tilt: globalTilt, riskAvg, safeAvg, best, note: tiltNote,
      basis: '风险端取纳指/标普/道指/BTC/日经当日涨跌均值；避险端取黄金/现货金/美元指数/美债10Y/30Y均值。' },
    basis: '两端 = 微盘股 + 大盘股；中间 = 小盘股 + 中盘股。spread = 两端均值 − 中间均值；当日 >0.15pct 或 5日 >0.8pct 记为哑铃特征。',
    note: '哑铃效应是市值层横截面相对强弱的观察标注，不代表涨跌预测，也不构成配置建议。'
  };
}

/* ----------------------------------------------------------------------
 * #9 经验校验：用户口述「昨天化学电子品主要上涨」→ 用真实板块涨跌核对
 * -------------------------------------------------------------------- */
function experience(style, strength) {
  const boards = (strength && Array.isArray(strength.boards)) ? strength.boards : [];
  if (!boards.length) return { ok: false, note: '板块快照不可得，经验条目无法校验' };
  const sorted = boards.filter(b => Number.isFinite(Number(b.chg1)))
    .slice().sort((a, b) => Number(b.chg1) - Number(a.chg1));
  const top = sorted.slice(0, 6).map(b => ({ name: b.name, chg1: r2(b.chg1), amountYi: r2(b.amountYi) }));
  const chem = boards.filter(b => /化学|化工|电子化学|化学品/.test(String(b.name || '')))
    .map(b => ({ name: b.name, chg1: Number.isFinite(Number(b.chg1)) ? r2(b.chg1) : null,
      rank: sorted.findIndex(x => x.name === b.name) + 1, total: sorted.length }))
    .sort((a, b) => (a.rank || 999) - (b.rank || 999)).slice(0, 6);
  const chemTop = chem.length ? chem[0] : null;
  const verified = chemTop ? (chemTop.chg1 != null && chemTop.chg1 > 0 && chemTop.rank <= Math.ceil(sorted.length * 0.3)) : null;
  return {
    ok: true,
    userClaim: '用户经验：昨天化学电子品主要上涨',
    claimStatus: verified === null ? '无法校验' : verified ? '与真实板块数据方向一致' : '与真实板块数据不一致',
    topBoards: top,
    chemBoards: chem,
    tradingDate: strength && strength.date ? strength.date : null,
    note: '经验条目只作事实核对：以本地板块快照的当日涨跌与横截面排名为准，不把用户口述写成系统结论。'
  };
}

/* ----------------------------------------------------------------------
 * #11 股份回购价格区间 vs 现价
 *   公告标题常不含价格 → 显式标「需公告正文」，不编造区间。
 * -------------------------------------------------------------------- */
const BUYBACK_KW = /回购股份|回购预案|回购报告书|回购进展|股份回购|集中竞价回购|回购方案|回购公司股份|回购A股/;

function parsePrice(title) {
  const t = String(title || '');
  let m = t.match(/([\d.]+)\s*元\/股\s*(?:至|—|-|~|到)\s*([\d.]+)\s*元\/股/);
  if (m) return { low: Number(m[1]), high: Number(m[2]), kind: 'range' };
  m = t.match(/(?:回购)?价格\s*(?:区间)?\s*([\d.]+)\s*(?:元)?\s*(?:至|—|-|~|到)\s*([\d.]+)\s*元/);
  if (m) return { low: Number(m[1]), high: Number(m[2]), kind: 'range' };
  m = t.match(/(?:不超过|上限为|上限|不高于)\s*([\d.]+)\s*元(?:\/股)?/);
  if (m) return { low: null, high: Number(m[1]), kind: 'upperOnly' };
  return { low: null, high: null, kind: 'missing' };
}

function priceMap() {
  const out = new Map();
  const st = readJson('stocks-cache.json');
  (st && Array.isArray(st.items) ? st.items : []).forEach(x => {
    if (x.code && Number.isFinite(Number(x.price))) out.set(String(x.code), { price: Number(x.price), mom20: x.indicators && x.indicators.mom20, maxDrawdown: x.indicators && x.indicators.maxDrawdown, rsi14: x.indicators && x.indicators.rsi14 });
  });
  const uni = readJson('universe-all.json');
  (uni && Array.isArray(uni.items) ? uni.items : []).forEach(x => {
    if (x.code && !out.has(String(x.code)) && Number.isFinite(Number(x.price))) out.set(String(x.code), { price: Number(x.price) });
  });
  return out;
}

function buybackAlerts() {
  const ev = readJson('events-cache.json');
  const anns = (ev && ev.raw && Array.isArray(ev.raw.announcements)) ? ev.raw.announcements : [];
  const pm = priceMap();
  const seen = new Set();
  const rows = [];
  for (const a of anns) {
    if (!BUYBACK_KW.test(a.title || '') || !/^\d{6}$/.test(String(a.code || ''))) continue;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const p = parsePrice(a.title);
    const q = pm.get(String(a.code)) || null;
    const price = q ? q.price : null;
    const low = p.low, high = p.high;
    const belowRange = low != null && price != null ? price < low : null;
    const withinRange = low != null && high != null && price != null ? (price >= low && price <= high) : null;
    const oversold = q && (Number(q.mom20) < -10 || Number(q.maxDrawdown) < -15 || Number(q.rsi14) < 30);
    const tags = [];
    if (p.kind === 'missing') tags.push('价格区间待补正文');
    if (belowRange) tags.push('现价低于回购下沿');
    if (p.kind === 'upperOnly') tags.push('仅披露上限');
    if (p.kind === 'upperOnly' && oversold) tags.push('仅上限 + 超跌');
    const notes = [];
    if (p.kind === 'missing') notes.push('公告标题未含回购价格区间，需查看公告正文；系统不臆测区间。');
    if (belowRange) notes.push('现价 ' + price + ' 低于区间下沿 ' + low + '，属价格偏离事实标注；回购可能不执行，不构成涨跌保证。');
    if (p.kind === 'upperOnly' && oversold) notes.push('仅披露价格上限而未写下限，且个股 20 日动量/回撤/RSI 呈超跌特征 → 标为重点观察，需核实公告正文与回购进度。');
    if (!notes.length && price != null) notes.push('现价 ' + price + ' 与已披露区间（' + (low == null ? '未披露下沿' : low) + ' ~ ' + (high == null ? '未披露' : high) + '）对比见左，未触发偏离标注。');
    rows.push({
      id: a.id, code: a.code, name: a.name, title: a.title, link: a.link || null,
      time: a.ts ? bjHM(a.ts) : null, ts: a.ts || null,
      priceKind: p.kind, priceLow: low, priceHigh: high, currentPrice: price,
      belowRange, withinRange, oversold: !!oversold,
      tags, notes, highlight: !!(belowRange || (p.kind === 'upperOnly' && oversold)),
      source: '东财公告标题（events-cache.raw.announcements）'
    });
  }
  rows.sort((x, y) => (y.ts || 0) - (x.ts || 0));
  return {
    ok: true,
    count: rows.length,
    highlighted: rows.filter(x => x.highlight).length,
    missingPrice: rows.filter(x => x.priceKind === 'missing').length,
    items: rows.slice(0, 40),
    basis: '从公告标题解析「A~B 元/股」「不超过 X 元/股」；现价取 stocks-cache / universe-all 快照。标题不含价格时标「待补正文」。',
    disclaimer: '公告标题 ≠ 事实：回购可能不执行、区间可能调整、现价为快照值。原话「低于区间肯定会上涨」已改为「价格偏离事实标注」，不构成涨跌保证或买卖建议。'
  };
}

/* 新公告实时提醒：内部维护已见集合，供服务端定时轮询后 SSE 广播 */
const _seen = new Set();
let _init = false;
function pollNewAlerts() {
  const cur = buybackAlerts();
  if (!_init) { cur.items.forEach(x => _seen.add(x.id)); _init = true; return []; }
  const fresh = cur.items.filter(x => !_seen.has(x.id));
  fresh.forEach(x => _seen.add(x.id));
  return fresh.filter(x => x.priceKind !== 'missing' || x.highlight);
}

function build(latest) {
  const style = readJson('market-style.json');
  const strength = readJson('strength-cache.json');
  const quotes = latest && Array.isArray(latest.quotes) ? latest.quotes : [];
  return {
    ok: true,
    at: bjHM(Date.now()),
    tradingDate: style && style.tradingDate ? style.tradingDate : null,
    boardLeadership: boardLeadership(style, strength),
    barbell: barbell(style, quotes),
    experience: experience(style, strength),
    buyback: buybackAlerts(),
    disclaimer: '市场级标注均由本地真实快照计算，只描述横截面事实与可核验偏离，不预测涨跌、不认定因果、不构成投资建议。'
  };
}

module.exports = { build, boardLeadership, barbell, experience, buybackAlerts, pollNewAlerts, parsePrice, METHODOLOGY: null };
