/* ==========================================================================
 * technical.js — P0 八项确定性技术因子（只读标注层）
 *
 * 用户规格（选股方法论 P0）：
 *   1 KDJ(9,3,3) 金叉/死叉
 *   2 连续两日收盘在 5 日线以下 → 上涨趋势结束
 *   3 不破 5 日线 + 上影线突破新高 → 去弱留强 / 持续观察
 *   4 抗压能力（大盘下跌家数 > 4000 时，个股不破 5 日线 / 翻红 / 带上影）
 *   5 小区域横盘（窄幅 + MA5 向上 + 红多绿少 + 期间创近期新高 + 不连续两日破 MA5）
 *   6 阶段量能对比（上升阶段量能是否明显高于前一阶段）
 *   7 行业市值分位（相对同行业本地样本均值，非全市场）
 *   8 复盘触发标注（把 1–7 映射为复盘规则候选，只读，不写 outcomes.jsonl）
 *
 * 扩展（用户 2026-11-25 新增规格，仍为只读标注层）：
 *   9  年线 / 半年线位置与上方套牢压力（需 250 根日线，不足标不可得）
 *   10 股份回购价格区间 vs 现价（标题无价格时标「待补正文」，不臆测）
 *   11 收购 / 重组事件下的「市值分层连板参照」（历史横截面统计，非连板预测）
 *   12 绝招形态库命中（patterns.js：民间口诀 → 可复算条件 + 失效条件）
 *
 * 【反幻觉纪律 / 不变式】
 *  - 只复用 ic.fetchKline() 拿真实前复权日线；不改动 stocks.js / journal.js /
 *    limitup.js / marketStyle.js 任何既有逻辑，不新增依赖。
 *  - 每项因子由日线逐条算出，输出 trace（验算依据），可独立复算。
 *  - 数据不可得时 hit=null、value=null 并写明原因，绝不编造数值。
 *  - 不写「因为 X 所以涨」的因果句；不接入 scoring；不构成投资建议。
 *  - 抗压环境判据来自 market-breadth.json 快照，非当日则标「仅供参考」。
 *  - 行业市值分位仅基于本地关注池样本，样本不足显式标注。
 *  - 东财接口有限流：只对关注池定向拉（≤14 只）+ 串行限速 + 30 分钟缓存，
 *    绝不做全市场扫描。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const ic = require('./ic');
const patterns = require('./patterns');
const marketRegime = require('./market-regime');

const DATA = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA, 'technical-cache.json');
const BREADTH_FILE = path.join(DATA, 'market-breadth.json');
const STOCKS_FILE = path.join(DATA, 'stocks-cache.json');
const MYPICKS_FILE = path.join(DATA, 'my-picks.json');
const HOLDINGS_FILE = path.join(DATA, 'holdings.json');
const PICK_INSIGHT_FILE = path.join(DATA, 'pick-insight.json');
const PICK_POOL_FILE = path.join(DATA, 'pick-pool-state.json');
const TREND_SCREEN_FILE = path.join(DATA, 'trend-screen.json');

const TTL = 30 * 60 * 1000;     // 日线缓存 30 分钟
/* 覆盖复盘范围：当日重点关注 24 只 + 持仓 + 观察池，串行限速抓取，不做全市场扫描 */
const MAX_CODES = 40;
const GAP_MS = 220;            // 串行限速
const MIN_BARS = 25;           // 计算所需最少日线根数（与 limitup.detectPatterns 一致）
const FETCH_LMT = 260;         // 每只拉 260 根前复权日线（年线 250 根所需；仍只定向拉关注池）

/* ------------------------------ 基础工具 ------------------------------ */

const round = (v, n = 2) => Number.isFinite(v) ? +Number(v).toFixed(n) : null;
const mean = a => (a && a.length) ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function withTimeout(p, ms = 9000) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('日线请求超时')), ms))
  ]);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function atomicWrite(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}

function F(key, label, hit, value, note, trace) {
  return {
    key, label,
    hit: hit === null ? null : !!hit,
    value: value == null ? null : value,
    note: note || '',
    trace: trace || {}
  };
}

/* ----------------------------------------------------------------------
 * 日线规范化：ic.fetchKline → {d,o,c,h,l,v,a}（简写）
 * 转为 {date,open,close,high,low,volume,amount,pct}（全称），pct 由相邻收盘算出。
 * -------------------------------------------------------------------- */
function normalizeBars(raw) {
  const out = [];
  let prevClose = null;
  for (const r of (raw || [])) {
    if (![r.o, r.c, r.h, r.l, r.v].every(Number.isFinite) || r.c <= 0) continue;
    out.push({
      date: r.d,
      open: r.o, close: r.c, high: r.h, low: r.l,
      volume: r.v, amount: Number.isFinite(r.a) ? r.a : null,
      pct: prevClose ? round((r.c - prevClose) / prevClose * 100, 2) : null
    });
    prevClose = r.c;
  }
  return out;
}

/* ----------------------------------------------------------------------
 * KDJ(9,3,3)：标准递推
 *   RSV = (C - LLV(L,9)) / (HHV(H,9) - LLV(L,9)) * 100
 *   K = SMA(RSV,3,1) = 2/3*K' + 1/3*RSV
 *   D = SMA(K,3,1)   = 2/3*D' + 1/3*K
 *   J = 3K - 2D
 *   初值 K=D=50；金叉 = K 上穿 D，死叉 = K 下穿 D。
 * -------------------------------------------------------------------- */
function kdj(bars, n = 9) {
  if (!bars || bars.length < n) return null;
  let K = 50, D = 50;
  const series = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < n - 1) { series.push(null); continue; }
    const w = bars.slice(i - n + 1, i + 1);
    const hh = Math.max(...w.map(b => b.high));
    const ll = Math.min(...w.map(b => b.low));
    const rsv = hh > ll ? (bars[i].close - ll) / (hh - ll) * 100 : 50;
    K = (2 / 3) * K + (1 / 3) * rsv;
    D = (2 / 3) * D + (1 / 3) * K;
    // 序列保留 4 位，便于逐条复算；前端展示时再格式化为 2 位
    series.push({ k: round(K, 4), d: round(D, 4), j: round(3 * K - 2 * D, 4), rsv: round(rsv, 4) });
  }
  const last = series[series.length - 1];
  const prev = series[series.length - 2];
  let cross = 'none';
  if (last && prev) {
    if (prev.k <= prev.d && last.k > last.d) cross = 'gold';
    else if (prev.k >= prev.d && last.k < last.d) cross = 'dead';
  }
  return { last, prev, cross, series, params: { n, m1: 3, m2: 3 } };
}

/** 每日 MA(n) 序列（不足 n 根为 null），用于「连续两日破 MA5」等逐日判断 */
function maSeries(bars, n = 5) {
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    out.push(i >= n - 1 ? round(mean(bars.slice(i - n + 1, i + 1).map(b => b.close)), 4) : null);
  }
  return out;
}

/** MACD(12,26,9)：EMA 递推，供 patterns.js 的「穿越 0 轴」判据复用 */
function macdOf(bars) {
  if (!bars || bars.length < 35) return null;
  const ema = (arr, n) => {
    const a = 2 / (n + 1);
    let e = arr[0];
    const out = [e];
    for (let i = 1; i < arr.length; i++) { e = arr[i] * a + e * (1 - a); out.push(e); }
    return out;
  };
  const c = bars.map(x => x.close);
  const e12 = ema(c, 12), e26 = ema(c, 26);
  const dif = c.map((_, i) => e12[i] - e26[i]);
  const dea = ema(dif, 9);
  const i = c.length - 1;
  return { dif: round(dif[i], 4), dea: round(dea[i], 4), hist: round((dif[i] - dea[i]) * 2, 4) };
}

/** 从公告缓存里按代码聚合「收购/重组」与「回购」事件（只读，标题层面的事实） */
function eventTags() {
  const out = { byCode: {}, buybackByCode: {}, mnaCount: 0, buybackCount: 0 };
  try {
    const ev = readJson(path.join(DATA, 'events-cache.json'));
    const anns = ev && ev.raw && Array.isArray(ev.raw.announcements) ? ev.raw.announcements : [];
    for (const a of anns) {
      const code = String(a.code || '');
      if (!/^\d{6}$/.test(code)) continue;
      const t = String(a.title || '');
      if (/收购|重组|并购|借壳|资产注入|控制权变更/.test(t)) {
        if (!out.byCode[code]) out.byCode[code] = [];
        out.byCode[code].push(t.slice(0, 120));
        out.mnaCount++;
      }
      if (/回购/.test(t)) {
        if (!out.buybackByCode[code]) out.buybackByCode[code] = [];
        out.buybackByCode[code].push(t.slice(0, 120));
        out.buybackCount++;
      }
    }
  } catch (_) {}
  return out;
}

/* ----------------------------------------------------------------------
 * 因子主计算（纯函数，bars 为规范化日线）
 * ctx = { breadth, floatCap, industry, industryStats, code, turnover,
 *         eventTags, buyback, quotes }
 * -------------------------------------------------------------------- */
function computeFactors(bars, ctx = {}) {
  const n = bars.length;
  if (n < MIN_BARS) return null;

  const b = bars[n - 1];
  const ma5 = maSeries(bars, 5);
  const k = kdj(bars);
  const closes = bars.map(x => x.close);
  const highs = bars.map(x => x.high);
  const vols = bars.map(x => x.volume);

  /* ---- 1. KDJ ---- */
  const kLast = k && k.last;
  const f1 = F('kdj', 'KDJ(9,3,3) 金叉/死叉',
    kLast ? (k.cross !== 'none') : null,
    kLast ? ({ k: kLast.k, d: kLast.d, j: kLast.j, cross: k.cross }) : null,
    kLast ? (k.cross === 'gold' ? 'K 上穿 D：金叉' : k.cross === 'dead' ? 'K 下穿 D：死叉' : 'K/D 未发生交叉')
      : '日线不足以计算 KDJ',
    kLast ? { prevK: k.prev && k.prev.k, prevD: k.prev && k.prev.d, rsv: kLast.rsv, bars: n } : { bars: n });

  /* ---- 2. 连续两日收盘在 5 日线以下 → 上涨趋势结束 ---- */
  const below = i => ma5[i] != null && closes[i] < ma5[i];
  const breakTwo = below(n - 1) && below(n - 2);
  const f2 = F('breakMa5Two', '连续两日收盘破 MA5',
    breakTwo,
    { todayClose: round(b.close), todayMa5: ma5[n - 1], prevClose: round(closes[n - 2]), prevMa5: ma5[n - 2] },
    breakTwo ? '近两日收盘价均低于各自 MA5 → 按用户规则，上涨趋势基本结束'
      : '未出现连续两日收盘破 MA5',
    { todayBelow: below(n - 1), prevBelow: below(n - 2) });

  /* ---- 3. 不破 5 日线 + 上影线突破新高（去弱留强 / 持续观察） ---- */
  const win5 = bars.slice(-5);
  const ma5w = ma5.slice(-5);
  const noTwoBreakIn5 = !(win5.some((_, i) => i > 0 && below(n - 5 + i) && below(n - 5 + i - 1)));
  const holdAll5 = win5.every((x, i) => ma5w[i] != null && x.close >= ma5w[i]);
  const high20Prev = Math.max(...highs.slice(-21, -1));           // 前 20 日最高价
  const upperShadow = round(b.high - Math.max(b.open, b.close), 4);
  const breakNewHigh = b.high > high20Prev;
  const f3hit = (noTwoBreakIn5 || holdAll5) && breakNewHigh && upperShadow > 0;
  const f3 = F('holdMa5NewHigh', '不破5日线 + 上影线创新高',
    f3hit,
    { high20Prev: round(high20Prev), todayHigh: round(b.high), upperShadow, noTwoBreakIn5, holdAll5 },
    f3hit ? '未连续两日破 MA5，且当日最高价突破前 20 日高点并带上影 → 可去弱留强 / 持续观察'
      : '未同时满足「不破 MA5 + 上影线创新高」',
    { breakNewHigh, upperShadowGt0: upperShadow > 0 });

  /* ---- 4. 抗压能力：环境判据 + 趋势位置 + 个股承压表现 ----
   * 用户原话：「位于上升趋势的中段或高端位置，再当天基本上没有跌破 5 天线
   * 或还能翻红或尾盘能出现上引线」→ 必须先满足趋势位置，再满足当日表现，
   * 否则上影线 > 0 几乎恒真，判据会退化成「全部命中」（等于编造）。
   */
  const br = ctx.breadth || null;
  const ma20 = maSeries(bars, 20);
  const envHit = !!(br && br.down > 4000);
  const envStale = !!(br && !br.isToday);
  const uptrendPos = ma5[n - 1] != null && ma20[n - 1] != null && ma5[n - 1] >= ma20[n - 1];
  const dayHold = !below(n - 1) || (b.pct != null && b.pct >= 0) || upperShadow > 0;
  const stockHold = uptrendPos && dayHold;
  const f4hit = envHit && stockHold;
  const f4 = F('resilience', '抗压能力（大盘普跌）',
    br ? (envHit ? f4hit : false) : null,
    br ? ({ envDown: br.down, envUp: br.up, envDate: br.dateLabel, envStale, uptrendPos, dayHold, stockHold, todayPct: b.pct }) : null,
    !br ? '缺少全市场涨跌家数快照，判据不可得'
      : (envStale ? '⚠ 环境快照非当日，抗压判定仅供参考，不代表今日盘面；' : '')
        + (envHit ? '下跌家数 > 4000 命中；' : '下跌家数未达 4000，环境判据未触发；')
        + (!uptrendPos ? 'MA5 < MA20，未处于上升趋势中段/高端，抗压前提不成立'
          : dayHold ? '趋势位置成立且当日未破 MA5 / 翻红 / 带上影 → 承压表现较好'
            : '趋势位置成立但当日破 MA5 且收跌 → 承压表现不足'),
    { envHit, envStale: envStale || null, uptrendPos, dayHold, stockHold });

  /* ---- 5. 小区域横盘 ---- */
  const w8 = bars.slice(-8);
  const bandHigh = Math.max(...w8.map(x => x.high));
  const bandLow = Math.min(...w8.map(x => x.low));
  const bandPct = bandLow > 0 ? (bandHigh - bandLow) / bandLow * 100 : null;
  const narrow = bandPct != null && bandPct <= 10;
  const ma5Up = ma5[n - 1] != null && ma5[n - 6] != null && ma5[n - 1] >= ma5[n - 6];
  const red = w8.filter(x => x.close >= x.open).length;
  const green = w8.length - red;
  const redMore = red > green;
  const madeNewHigh = Math.max(...w8.map(x => x.high)) >= high20Prev;
  const f5hit = narrow && ma5Up && noTwoBreakIn5 && redMore && madeNewHigh;
  const f5 = F('tightRange', '小区域横盘（蓄势）',
    f5hit,
    { bandPct: round(bandPct), ma5Up, red, green, noTwoBreakIn5, madeNewHigh },
    f5hit ? '近 8 日窄幅横盘、MA5 向上、红多绿少、期间创近期新高且未连续两日破 MA5 → 可在 5 日线附近观察'
      : '未同时满足横盘蓄势全部条件',
    { narrow, ma5Up, redMore, madeNewHigh });

  /* ---- 6. 阶段量能对比（近 5 日均量 / 前 5 日均量） ---- */
  const vol5 = mean(vols.slice(-5));
  const volPrev5 = mean(vols.slice(-10, -5));
  const volRatio = (vol5 != null && volPrev5 > 0) ? round(vol5 / volPrev5, 2) : null;
  const priceUp = ma5[n - 1] != null && ma5[n - 6] != null && ma5[n - 1] > ma5[n - 6];
  const volExpanded = volRatio != null && volRatio >= 1.2;
  const f6 = F('phaseVolume', '阶段量能对比',
    volRatio != null,
    { vol5: round(vol5, 0), volPrev5: round(volPrev5, 0), ratio: volRatio, priceUp },
    volRatio == null ? '量能数据不可得'
      : (volExpanded && priceUp ? 'MA5 上行且近 5 日均量 ≥ 前 5 日 1.2 倍 → 有资金进场迹象'
        : volExpanded ? '量能放大，但 MA5 未上行' : '量能未明显放大'),
    { volExpanded, priceUp });

  /* ---- 7. 行业市值分位（本地样本，非全市场） ---- */
  const st = ctx.industryStats && ctx.industry ? ctx.industryStats[ctx.industry] : null;
  let f7;
  if (!Number.isFinite(ctx.floatCap)) {
    f7 = F('capPercentile', '行业市值分位', null, null, '该标的本地无流通市值数据，判据不可得', {});
  } else if (!st || st.n < 2) {
    f7 = F('capPercentile', '行业市值分位', null,
      { floatCapYi: round(ctx.floatCap / 1e8), sampleN: st ? st.n : 0 },
      '同行业本地样本不足（n<2），无法给出分位；不编造全市场行业均值', {});
  } else {
    const belowCount = st.caps.filter(x => x <= ctx.floatCap).length;
    const pctile = round(belowCount / st.n * 100, 1);
    const rel = ctx.floatCap < st.mean ? '低于' : '高于';
    f7 = F('capPercentile', '行业市值分位', true,
      { floatCapYi: round(ctx.floatCap / 1e8), industryMeanYi: round(st.mean / 1e8), percentile: pctile, sampleN: st.n, relation: rel },
      rel + '本地同行业样本均值（n=' + st.n + '，仅关注池，非全市场）；市值不作优选，仅收购/重组时作连板测算参考',
      { sampleCapsYi: st.caps.map(x => round(x / 1e8, 1)) });
  }

  /* ---- 8. 年线 / 半年线位置（上方套牢压力，需 120 / 250 根日线） ----
   * 用户原话：「年线和半年线位于靠下的位置，股票上涨更容易，上部压力较小」。
   * 量化为「现价相对 MA120 / MA250 的偏离度」：偏离越小越贴近长期成本区，
   * 但这是横截面事实标注，不推断「一定更容易涨」。日线不足则 hit=null。
   */
  const ma120 = maSeries(bars, 120);
  const ma250 = maSeries(bars, 250);
  const distTo = m => (m && m[n - 1] != null && m[n - 1] > 0)
    ? round((b.close - m[n - 1]) / m[n - 1] * 100, 2) : null;
  const d120 = distTo(ma120), d250 = distTo(ma250);
  const belowYear = d250 != null ? d250 < 0 : null;
  const lowPressure = d250 == null ? null : (d250 <= 25 && (d120 == null || d120 <= 15));
  const f8 = F('longMa', '年线 / 半年线位置（上方压力）',
    d250 == null ? null : lowPressure,
    d250 == null ? null : ({ ma120: ma120[n - 1], ma250: ma250[n - 1], distHalfPct: d120,
      distYearPct: d250, belowYear, lastClose: round(b.close), bars: n }),
    d250 == null ? '日线不足 250 根，年线判据不可得（不编造）'
      : '现价偏离半年线 ' + d120 + '%、偏离年线 ' + d250 + '%' + (belowYear ? '（位于年线下方）' : '') +
        '；' + (lowPressure ? '贴近长期均线，上方套牢区相对较近' : '已明显高于长期均线，上方空间与压力并存') +
        '。仅作位置标注，不推断涨跌难易',
    { bars: n, hasHalf: ma120[n - 1] != null, hasYear: ma250[n - 1] != null });

  /* ---- 9. 股份回购价格区间 vs 现价（重点标注，标题无价格则标待补正文） ---- */
  const bb = ctx.buyback || null;
  const bbTitles = ctx.eventTags && ctx.eventTags.buybackByCode
    ? (ctx.eventTags.buybackByCode[String(ctx.code)] || []) : [];
  let f9;
  if (!bb || !bb.ok) {
    f9 = F('buybackPrice', '回购价格区间 vs 现价', null, null, '回购公告快照不可得', {});
  } else {
    const row = (bb.items || []).find(x => String(x.code) === String(ctx.code)) || null;
    if (!row) {
      f9 = F('buybackPrice', '回购价格区间 vs 现价', false,
        { announcements: bbTitles.slice(0, 2) },
        bbTitles.length ? '检测到回购公告，但标题未含可解析价格区间；需公告正文，系统不臆测'
          : '未检测到该标的回购公告（不臆测）', {});
    } else if (row.priceKind === 'missing') {
      f9 = F('buybackPrice', '回购价格区间 vs 现价', null,
        { title: row.title, currentPrice: row.currentPrice, priceKind: 'missing' },
        '公告标题未披露价格区间，需查看公告正文；系统不臆测上下限', {});
    } else {
      const hit = !!row.highlight;
      f9 = F('buybackPrice', '回购价格区间 vs 现价', hit,
        { priceLow: row.priceLow, priceHigh: row.priceHigh, currentPrice: row.currentPrice,
          priceKind: row.priceKind, belowRange: row.belowRange, withinRange: row.withinRange,
          oversold: row.oversold, tags: row.tags, title: row.title },
        (row.notes || []).join(' ') || '现价与已披露区间对比见左；未触发偏离标注',
        { source: row.source });
    }
  }

  /* ---- 10. 收购 / 重组 + 市值分层连板参照 ----
   * 用户原话：「市值判定不作为优选，但如果有收购、重组，市值是重要的计算涨多少个连板的技术指标」。
   * 系统改为：命中事件 → 用本地同行业市值分位给「弹性参照」，明确不是连板数量预测。
   */
  const mna = ctx.eventTags && ctx.eventTags.byCode
    ? (ctx.eventTags.byCode[String(ctx.code)] || []) : [];
  const capVal = f7.value || null;
  const f10 = F('mnaCapRef', '收购 / 重组 + 市值分层参照',
    mna.length ? true : (ctx.eventTags ? false : null),
    mna.length ? ({ events: mna.slice(0, 3), relation: capVal && capVal.relation,
      percentile: capVal && capVal.percentile, sampleN: capVal && capVal.sampleN,
      floatCapYi: capVal && capVal.floatCapYi }) : null,
    !mna.length ? (ctx.eventTags ? '未检测到该标的收购/重组公告' : '公告快照不可得')
      : '命中 ' + mna.length + ' 条收购/重组类公告' +
        (capVal ? '；本地同行业市值分位 ' + capVal.percentile + '%（' + capVal.relation + '样本均值，n=' + capVal.sampleN + '）' : '；本地市值样本不足，分位不可得') +
        '。此处仅给市值分层参照，不计算也不预测连板数量；回购可能不执行，事件不构成涨跌保证',
    { eventCount: mna.length, capAvailable: !!capVal });

  /* ---- 11. 绝招形态库（patterns.js：24 条可复算条件 + 失效条件） ---- */
  const macd = macdOf(bars);
  const pat = patterns.evaluate(bars, {
    turnover: ctx.turnover == null ? null : Number(ctx.turnover),
    macd, floatCap: ctx.floatCap, events: mna, buyback: bb
  });

  const factors = [f1, f2, f3, f4, f5, f6, f7, f8, f9, f10];

  /* ---- 12. 复盘触发标注（只读候选，不写 outcomes.jsonl / 不改 journal.js） ---- */
  const rules = reviewTriggers(factors);

  return {
    bars: n,
    lastDate: b.date,
    lastClose: round(b.close),
    lastPct: b.pct,
    ma5: ma5[n - 1],
    macd,
    factors,
    patterns: pat,
    rules
  };
}

/* ----------------------------------------------------------------------
 * 复盘规则候选：把技术标注映射为用户规格里的复盘口径。
 * 【只读】只输出规则命中情况，不写 outcomes.jsonl，不修改 journal.js。
 * -------------------------------------------------------------------- */
function reviewTriggers(factors) {
  const by = {};
  factors.forEach(f => { by[f.key] = f; });
  const R = (id, label, hit, basis, spec) => ({
    id, label,
    hit: hit === null ? null : !!hit,
    basis: basis || '',
    spec: spec || ''
  });
  return [
    R('trendEnd', '连续两日收盘破 MA5 → 上涨趋势结束',
      by.breakMa5Two ? by.breakMa5Two.hit : null,
      by.breakMa5Two ? by.breakMa5Two.note : '因子不可得', '复盘 #5'),
    R('noNewHighInRange', '横盘期间未创近期新高 → 不续持',
      by.tightRange ? (by.tightRange.trace && by.tightRange.trace.madeNewHigh === false ? true : false) : null,
      by.tightRange ? ('期间创近期新高=' + !!(by.tightRange.trace && by.tightRange.trace.madeNewHigh)) : '因子不可得', '复盘 #5'),
    R('weakToStrong', '不破 5 日线 + 上影线创新高 → 去弱留强 / 持续观察',
      by.holdMa5NewHigh ? by.holdMa5NewHigh.hit : null,
      by.holdMa5NewHigh ? by.holdMa5NewHigh.note : '因子不可得', '复盘 #4'),
    R('resilience', '大盘普跌 >4000 家时的抗压表现',
      by.resilience ? by.resilience.hit : null,
      by.resilience ? by.resilience.note : '因子不可得', '个股 #12'),
    R('kbarVolume', 'MA5 上行且阶段量能放大 → 资金进场',
      by.phaseVolume ? (by.phaseVolume.trace && by.phaseVolume.trace.volExpanded && by.phaseVolume.trace.priceUp) : null,
      by.phaseVolume ? by.phaseVolume.note : '因子不可得', '个股 #9'),
    R('kdjCross', 'KDJ 金叉 / 死叉事件标注',
      by.kdj && by.kdj.value ? (by.kdj.value.cross !== 'none') : null,
      by.kdj && by.kdj.value ? ('cross=' + by.kdj.value.cross + ', K=' + by.kdj.value.k + ', D=' + by.kdj.value.d) : '因子不可得',
      '个股 #11'),
    R('longMaLow', '贴近年线 / 半年线（上方压力较小）',
      by.longMa ? by.longMa.hit : null,
      by.longMa ? by.longMa.note : '因子不可得', '个股 #12'),
    R('buybackDeviation', '回购价格区间偏离 / 仅上限+超跌',
      by.buybackPrice ? by.buybackPrice.hit : null,
      by.buybackPrice ? by.buybackPrice.note : '因子不可得', '个股 #11'),
    R('mnaEvent', '收购 / 重组事件 + 市值分层参照',
      by.mnaCapRef ? by.mnaCapRef.hit : null,
      by.mnaCapRef ? by.mnaCapRef.note : '因子不可得', '个股 #1')
  ];
}

/* ------------------------------ 标的池 ------------------------------ */

function arrOf(obj, keys) {
  for (const k of keys) if (Array.isArray(obj && obj[k])) return obj[k];
  return [];
}

/**
 * 标的池与 review-team.collectScope 对齐：当日重点关注（当日选股 / 09:05 预测池 / 四类选股）
 * → 持仓 → 我的选股 → 观察池。这样盘后复盘里的每只重点股都能拿到确定性技术标注，
 * 而不是大面积「技术标注不可得」。行业 / 流通市值优先用 stocks-cache 索引补全。
 */
function collectCodes() {
  const map = new Map();
  const st = readJson(STOCKS_FILE) || {};
  const stockIdx = new Map();
  (Array.isArray(st.items) ? st.items : []).forEach(x => {
    if (x && x.code) stockIdx.set(String(x.code), x);
  });

  const add = (code, name, industry, floatCap, from) => {
    const c = String(code || '').trim();
    if (!/^\d{6}$/.test(c)) return;
    const ref = stockIdx.get(c) || {};
    if (!map.has(c)) map.set(c, {
      code: c,
      // 部分快照（holdings / trend-screen）本身 name=null，回退到代码而不是编造名称
      name: name || ref.name || c,
      industry: industry || ref.industry || null,
      floatCap: Number.isFinite(floatCap) ? floatCap
        : (Number.isFinite(Number(ref.floatCap)) ? Number(ref.floatCap)
          : (Number.isFinite(Number(ref.marketCap)) ? Number(ref.marketCap) : null)),
      from: []
    });
    const o = map.get(c);
    if (!o.from.includes(from)) o.from.push(from);
    if (!o.name && name) o.name = name;
    if (!o.industry && industry) o.industry = industry;
    if (!Number.isFinite(o.floatCap) && Number.isFinite(floatCap)) o.floatCap = floatCap;
  };

  arrOf(readJson(PICK_INSIGHT_FILE), ['items', 'focus', 'leaders']).slice(0, 20)
    .forEach(x => add(x.code || x.symbol, x.name || x.short, x.industry, null, '当日选股'));
  arrOf(readJson(PICK_POOL_FILE), ['items', 'pool', 'frozen']).slice(0, 20)
    .forEach(x => add(x.code || x.symbol, x.name || x.short, x.industry, null, '09:05 预测池'));
  arrOf(readJson(TREND_SCREEN_FILE), ['items', 'top', 'picks']).slice(0, 12)
    .forEach(x => add(x.code || x.symbol, x.name || x.short, x.industry, null, '四类选股'));
  arrOf(readJson(HOLDINGS_FILE), ['positions', 'items', 'holdings'])
    .forEach(x => add(x.code, x.name, null, null, '持仓'));
  arrOf(readJson(MYPICKS_FILE), ['items', 'picks']).slice(0, 12)
    .forEach(x => add(x.code || x.symbol, x.name || x.short, x.industry, null, '我的选股'));
  (Array.isArray(st.items) ? st.items : [])
    .forEach(x => add(x.code, x.name, x.industry, x.floatCap || x.marketCap, '观察池'));

  return Array.from(map.values()).slice(0, MAX_CODES);
}

function industryStats(codes) {
  const g = {};
  codes.forEach(c => {
    if (c.industry && Number.isFinite(c.floatCap)) (g[c.industry] = g[c.industry] || []).push(c.floatCap);
  });
  const out = {};
  Object.keys(g).forEach(k => {
    const caps = g[k].slice().sort((a, b) => a - b);
    out[k] = { n: caps.length, mean: mean(caps), caps };
  });
  return out;
}

/* --------------------------- 市场环境快照 --------------------------- */

function readBreadth() {
  const b = readJson(BREADTH_FILE);
  if (!b || !Number.isFinite(b.down)) return null;
  const t = Number(b.generatedAt) || 0;
  const d = t ? new Date(t) : null;
  const dateLabel = d ? d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未知';
  const isToday = d ? d.toDateString() === new Date().toDateString() : false;
  return {
    up: b.up, down: b.down, flat: b.flat,
    valid: b.valid, got: b.got, total: b.total,
    coverage: b.coverage, generatedAt: t, dateLabel, isToday,
    note: b.note || ''
  };
}

/* ------------------------------- 构建 ------------------------------- */

async function build(opts = {}) {
  const force = !!opts.force;
  if (!force) {
    const c = readCache();
    if (c && Date.now() - (c.builtAt || 0) < TTL) return c;
  }

  const codes = collectCodes();
  const breadth = readBreadth();
  const stats = industryStats(codes);
  const evTags = eventTags();
  let buyback = { ok: false };
  try { buyback = marketRegime.buybackAlerts() || { ok: false }; } catch (e) { buyback = { ok: false, error: e.message }; }
  const turnoverByCode = new Map();
  try {
    const st = readJson(STOCKS_FILE);
    (st && Array.isArray(st.items) ? st.items : []).forEach(x => {
      const t = x.turnover != null ? x.turnover : (x.indicators && x.indicators.turnover);
      if (x.code && Number.isFinite(Number(t))) turnoverByCode.set(String(x.code), Number(t));
    });
  } catch (_) {}
  let items = [];
  let barsOk = 0, barsFail = 0;
  const errors = [];

  for (const c of codes) {
    let raw = [], err = null;
    try { raw = await withTimeout(ic.fetchKline(c.code, FETCH_LMT), 9000); }
    catch (e) { err = e.message; }
    const bars = normalizeBars(raw);
    let calc = null;
    if (bars.length >= MIN_BARS) {
      calc = computeFactors(bars, { breadth, floatCap: c.floatCap, industry: c.industry,
        industryStats: stats, code: c.code, turnover: turnoverByCode.get(c.code),
        eventTags: evTags, buyback, quotes: opts.quotes || [] });
      barsOk++;
    } else {
      barsFail++;
      if (!err) err = '日线不足 ' + MIN_BARS + ' 根（实得 ' + bars.length + '）';
    }
    if (err) errors.push({ code: c.code, error: err });
    items.push({
      code: c.code, name: c.name, industry: c.industry, floatCap: c.floatCap,
      from: c.from, bars: bars.length,
      status: calc ? 'ok' : 'unavailable',
      error: calc ? null : err,
      calc
    });
    await sleep(GAP_MS);
  }

  const ruleStat = [];
  if (barsOk) {
    const labels = [
      ['trendEnd', '连续两日破 MA5 → 趋势结束'],
      ['noNewHighInRange', '横盘未创新高 → 不续持'],
      ['weakToStrong', '不破 MA5 + 上影创新高 → 去弱留强'],
      ['resilience', '大盘普跌时的抗压表现'],
      ['kbarVolume', 'MA5 上行 + 阶段量能放大'],
      ['kdjCross', 'KDJ 金叉 / 死叉'],
      ['longMaLow', '贴近年线 / 半年线'],
      ['buybackDeviation', '回购区间偏离 / 仅上限+超跌'],
      ['mnaEvent', '收购 / 重组 + 市值分层']
    ];
    labels.forEach(([id, label]) => {
      const hits = items.filter(x => x.calc && (x.calc.rules || []).some(r => r.id === id && r.hit === true)).length;
      const avail = items.filter(x => x.calc && (x.calc.rules || []).some(r => r.id === id && r.hit !== null)).length;
      ruleStat.push({ id, label, hits, avail });
    });
  }

  const industrySample = Object.keys(stats).map(k => ({
    industry: k, n: stats[k].n, meanYi: round(stats[k].mean / 1e8, 1)
  })).sort((a, b) => b.n - a.n);

  /* 上游日线整体不可达时，不能用「全 unavailable」覆盖上一次成功快照。
   * 沿用旧 items 并逐条标 stale；barsOk/barsFail/errors 仍保留本次真实统计，不伪造成功。 */
  let degraded = false;
  if (barsOk === 0) {
    try {
      const prev = readCache();
      if (prev && Array.isArray(prev.items) && prev.items.some(x => x && x.calc)) {
        items = prev.items.map(x => ({ ...x, stale: true }));
        degraded = true;
      }
    } catch (_) {}
  }

  const view = {
    ok: true,
    builtAt: Date.now(),
    builtAtLabel: new Date().toLocaleString('zh-CN'),
    date: items.length && items[0].calc ? items[0].calc.lastDate : null,
    universe: { count: codes.length, barsOk, barsFail, maxCodes: MAX_CODES,
      sources: ['当日选股', '09:05 预测池', '四类选股', '持仓', '我的选股', '观察池'] },
    klineSource: degraded ? '沿用上次成功快照' : ic.klineSource(),
    degraded,
    degradedNote: degraded
      ? '本次日线抓取全部失败（上游不可达），个股技术标注沿用上一次成功快照并逐条标 stale；市场级标注仍为本次真实本地快照计算。'
      : null,
    staleItems: degraded ? items.filter(x => x.stale).length : 0,
    breadth,
    industrySample,
    items,
    ruleStat,
    errors,
    regime: (() => {
      try { return marketRegime.build({ quotes: Array.isArray(opts.quotes) ? opts.quotes : [] }); }
      catch (e) { return { ok: false, error: e.message }; }
    })(),
    patternsMethodology: patterns.METHODOLOGY,
    methodology: {
      kline: '复用 ic.fetchKline → emtx 多源降级：主源东方财富 push2his 前复权（klt=101,fqt=1），不可达时自动切腾讯 qfq 前复权，字段顺序一致；每只 260 根（年线所需）；pct 由相邻收盘价推算。本次实际来源见顶层 klineSource 字段',
      kdj: 'KDJ(9,3,3)：RSV=(C-LLV(L,9))/(HHV(H,9)-LLV(L,9))*100，K=2/3K\'+1/3RSV，D=2/3D\'+1/3K，J=3K-2D，初值 K=D=50',
      ma5: 'MA5 为当日及前 4 根收盘均值，逐日计算；「连续两日破」按各自当日 MA5 比较',
      newHigh: '前 20 日最高价（不含当日）；上影线 = high - max(open, close)',
      tightRange: '近 8 日 (最高-最低)/最低 ≤ 10%，且 MA5 不降、阳线数>阴线数、期间创近期新高、无连续两日破 MA5',
      phaseVolume: '近 5 日均量 / 前 5 日均量；≥1.2 且 MA5 上行视为放量',
      breadth: 'market-breadth.json 全市场涨跌家数快照；非当日则抗压判据仅供参考',
      capPercentile: '仅基于本地关注池同 industry 样本的 floatCap 均值与分位，样本 n<2 时标注不可得',
      longMa: 'MA120 半年线 / MA250 年线；偏离度=(收盘−均线)/均线×100，≤15%/≤25% 视为贴近长期成本区；不足 250 根标不可得',
      macd: 'MACD(12,26,9) EMA 递推，DIF/DEA/柱注入形态库，用于「穿越 0 轴后首次回调」判据',
      buyback: '从公告标题解析「A~B 元/股」「不超过 X 元/股」，现价取 stocks-cache / universe-all 快照；标题无价格标「待补正文」',
      mna: '收购/重组/并购/借壳类公告按代码聚合，结合本地行业市值分位给弹性参照；不计算也不预测连板数量',
      patterns: 'patterns.js 24 条形态：唐奇安上轨/BIAS 乖离/斐波那契回撤/MACD 0 轴/均线多头排列/量比 VR/蜡烛形态/换手率分级；原文买卖点转为「触发依据 + 失效条件」',
      regime: 'market-regime.js：板块成交额加权贡献（非真实指数权重）、市值两端 vs 中间的哑铃特征、全球风险/避险 tilt、经验条目事实核对、回购价格偏离'
    },
    disclaimer: [
      '本模块为只读标注层：所有因子由真实前复权日线计算，不接入 stocks.js 评分，不改变任何现有选股结果。',
      '日线实际来源见 klineSource：主源东财不可达时自动切腾讯前复权备用源，备用源成交额为四价均值×量估算（已在 emtx 标注），不是编造数值。',
      '复盘触发规则为只读候选，未写入 outcomes.jsonl、未修改 journal.js 复盘逻辑。',
      '抗压环境判据来自 market-breadth.json 快照，若非当日则标注「仅供参考」，不代表今日盘面。',
      '行业市值分位仅基于本地关注池样本，非全市场行业分位；样本不足时显式标注不可得。',
      '绝招形态库把民间口诀的「买点/卖点/必涨」统一改写为「形态命中 + 量化依据 + 失效条件」，不含涨跌预测与买卖指令。',
      '回购价格区间来自公告标题而非正文，可能不完整或被修订；「低于区间肯定上涨」已改为「价格偏离事实标注」，不构成涨跌保证；收购/重组仅给市值分层参照，不预测连板数量。',
      '板块带动为成交额加权近似分解，哑铃效应为横截面相对强弱观察，均不认定因果、不构成配置建议。',
      '本模块只做技术条件命中判定，不做因果推断、不认定涨跌原因，不构成投资建议。'
    ]
  };

  try { atomicWrite(CACHE_FILE, view); }
  catch (e) { view.persistError = e.message; }
  return view;
}

function readCache() {
  const v = readJson(CACHE_FILE);
  return v && v.ok ? v : null;
}

module.exports = {
  build, readCache, computeFactors, kdj, maSeries, macdOf, eventTags,
  normalizeBars, reviewTriggers, collectCodes, industryStats, readBreadth,
  CACHE_FILE, MIN_BARS
};
