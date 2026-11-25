'use strict';

/**
 * 当日观察池（A 股横截面多因子评分）。
 *
 * 【技术逻辑来源：GitHub 上 2025–2026 年仍在维护的开源项目，本机已核对 README】
 *  1. SiD-array/StockView（2026-06 更新）：SMA / RSI / MACD / 布林带 / ATR、Z-score 异常检测、
 *     VADER 新闻情绪；其「时序 80/20 切分、不打乱、避免前视偏差」的回测框架显示
 *     随机森林 / LightGBM / XGBoost / 线性回归在 5 只美股上的平均 R² 为 -1.02 ~ -2.93。
 *     → 因此本模块【不做任何价格预测】，只做可解释的横截面评分与风险度量。
 *  2. amelitasantiago/ai-stock-watcher（NUS-ISS 2025）：价格 / 成交量 / 情绪多信号融合。
 *  3. Jay7751/QuantFusionAI（2026-01）：可解释信号、置信度、基于 ATR 的风险度量。
 *  4. ramhee98/StockSentimentAlpha（2025-10）：每标的按日聚合 Sentiment Index（VADER + FinBERT），
 *     情绪 30% / RSI 25% / MACD 25% / 趋势 20% 的加权信号 → 本模块采用「情绪独立成组 + 置信度」。
 *  5. sansan0/TrendRadar（2026 活跃）：多平台热榜聚合、排名变化与出现频次 → 本模块的热度合成。
 *  6. Open-Dev-Society/OpenStock：跨源情绪卡与分歧度可见 → 单源/双源置信度表达。
 *  7. Jsoned/autowealth-ai：加权投票；Creeper998/daily_stock_analysis（2026-05）：中文决策仪表盘。
 *
 * 【本模块实际实现】零第三方依赖的 Node 版本「可解释子集」：
 *   五个榜单（行情三榜 + 人气两榜）分层构建候选池 → 60 日前复权日线 → 12 项指标 →
 *   「技术 40% + 资金 28% + 舆情热度 32%」加权投票 + 外围市场联动修正 − 风险惩罚 →
 *   0-100 评分 + 信号 + 置信度 + 理由清单 + 风险提示。
 *
 * 【实时联动】重计算（拉日线）按 refreshMin 节流；新闻解读、热榜或外围行情任一变化时，
 *   复用已缓存的技术/资金指标做「轻量重评分」（无网络请求），因此消息面与外围波动可近实时反映到排序。
 *
 * 【诚实边界】候选池来自公开榜单而非全市场扫描；评分为同一时点的横截面相对排序，不是涨跌预测；
 *   周末与节假日显示最近交易日数据并明确标注；热度是关注度而非资金流向。
 */

const fs = require('node:fs');
const path = require('node:path');
const { UA } = require('./sources');
const { marketAdjustFor } = require('./attention');
const { styleForStock } = require('./marketStyle');
const events = require('./events');
const limitup = require('./limitup');
const journal = require('./journal');
const emtx = require('./emtx'); // 行情故障转移：东财不可达时自动切腾讯/新浪（口径见 emtx.js 头注）

const CACHE_FILE = path.join(__dirname, '..', 'data', 'stocks-cache.json');
const EM_CLIST = 'https://push2.eastmoney.com/api/qt/clist/get';
const EM_ULIST = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
const EM_KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const UNIVERSE = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23'; // 沪深主板 + 创业板 + 科创板
// f21 流通市值：用于把个股归入微盘 / 小盘 / 中盘 / 大盘，进而套用量能风格因子
const FIELDS = 'f12,f14,f2,f3,f4,f5,f6,f8,f9,f10,f15,f16,f18,f20,f21,f23,f62,f100,f184';

const RANKS = [
  { fid: 'f3', label: '涨幅榜' },
  { fid: 'f6', label: '成交额榜' },
  { fid: 'f62', label: '主力净流入榜' }
];

const DEFAULT_SENTIMENT = {
  index: 0, score: 50, emotionScore: 50, coverageScore: 30,
  label: '无舆情覆盖', hitCount: 0, individualHits: 0,
  ownNewsCount: 0, ownSpecificCount: 0,
  confidence: '无', headlines: [], note: '暂无舆情数据，按中性计'
};

let memCache = null;

/* ------------------------------- 工具 ------------------------------- */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const finite = v => Number.isFinite(+v) ? +v : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = (v, n = 1) => +Number(v).toFixed(n);

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function beijing() {
  const d = new Date(Date.now() + 8 * 3600000);
  return {
    date: d.toISOString().slice(0, 10),
    day: d.getUTCDay(),
    hhmm: d.getUTCHours() * 60 + d.getUTCMinutes()
  };
}

function isTradingSession(bj) {
  if (bj.day === 0 || bj.day === 6) return false;
  return (bj.hhmm >= 570 && bj.hhmm <= 690) || (bj.hhmm >= 780 && bj.hhmm <= 900);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(11000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/* ------------------------------- 候选池 ------------------------------- */

function secidOf(code) { return (/^6/.test(code) ? '1.' : '0.') + code; }

/**
 * 候选过滤。
 *
 * 【涨停处理已变更】原实现把 pct ≥ 9.8% 与 pct ≤ -9.5% 整体剔除（「买不进也卖不出」），
 * 等于把 A 股信息密度最高的一类价格行为整个丢出因子体系。现在：
 *  - 涨停股不再剔除，改由 limitup 模块单独产出「涨停结构因子」
 *    （板型 / 封板时间 / 封单厚度 / 连板高度 / 开板次数 / 可成交性 / 回归风险）；
 *  - 成交额门槛对涨停股放宽到 3000 万：一字板缩量是常态，1 亿门槛会把最典型的一字板全部误杀；
 *  - 换手率上限对涨停股放宽到 45%：反复开板的高换手是打板股的正常状态；
 *  - 跌停仍剔除：A 股无法卖出（跌停封死），且连续跌停的尾部风险不对称。
 */
function eligible(r, limitSet) {
  const code = String(r.f12 || '');
  const name = String(r.f14 || '');
  const price = finite(r.f2), pct = finite(r.f3), amount = finite(r.f6);
  const turnover = finite(r.f8), mcap = finite(r.f20);
  const isLimitUp = !!(limitSet && limitSet.has(code));
  if (!/^\d{6}$/.test(code) || !name || !price) return false;
  if (/ST|退|\*/i.test(name)) return false;                 // 风险警示 / 退市
  if (/^(4|8|9)/.test(code)) return false;                  // 北交所 / B 股，规则差异
  if (price < 3 || price > 1000) return false;              // 极低价 / 超高价失真
  if (mcap !== null && (mcap < 3e9 || mcap > 8e11)) return false; // 30 亿 ~ 8000 亿
  if (amount === null || amount < (isLimitUp ? 3e7 : 1e8)) return false;
  if (pct === null || pct <= -9.5) return false;            // 跌停不纳入
  if (turnover !== null && turnover > (isLimitUp ? 45 : 30)) return false;
  return true;
}

/**
 * 热榜成分股批量补报价：同花顺热榜与东财人气榜只给代码/名次，
 * 需要补齐成交额、资金流、行业等评分字段（东财 ulist.np 一次可查 50 只）。
 */
async function fetchHotQuotes(attention, limit = 125, limitSet = null) {
  const all = Object.values((attention && attention.items) || {});
  if (!all.length) return { rows: [], note: '无热榜数据' };
  const codes = all.sort((a, b) => (b.heatScore || 0) - (a.heatScore || 0))
    .slice(0, limit).map(x => x.code);
  const rankMap = new Map(all.map(x => [x.code, x]));
  const rows = [];
  for (let i = 0; i < codes.length; i += 50) {
    const secids = codes.slice(i, i + 50).map(secidOf).join(',');
    try {
      const j = await emtx.fetchUList(secids, FIELDS);
      const diff = (j && j.data && Array.isArray(j.data.diff)) ? j.data.diff : [];
      for (const r of diff) {
        if (!eligible(r, limitSet)) continue;
        const h = rankMap.get(String(r.f12));
        rows.push({ row: r, heat: h ? h.heatScore : null });
      }
    } catch (e) { /* 单批失败不影响其它批 */ }
    if (i + 50 < codes.length) await sleep(180);
  }
  return { rows, note: '热榜 ' + codes.length + ' 只 → 通过风控过滤 ' + rows.length + ' 只' };
}

/** 按代码批量补实时报价（涨停池只有价格/涨幅/封单等字段，缺行业、PE、主力净额） */
async function fetchQuotesByCodes(codes) {
  const rows = [];
  for (let i = 0; i < codes.length; i += 50) {
    const secids = codes.slice(i, i + 50).map(secidOf).join(',');
    try {
      const j = await emtx.fetchUList(secids, FIELDS);
      const diff = (j && j.data && Array.isArray(j.data.diff)) ? j.data.diff : [];
      rows.push(...diff);
    } catch (e) { /* 忽略单批失败 */ }
    if (i + 50 < codes.length) await sleep(160);
  }
  return rows;
}

async function fetchCandidatePool(perRank = 25, attention = null, limitPools = null) {
  const map = new Map();
  const rankInfo = [];
  const limitSet = limitPools && limitPools.zt ? new Set(limitPools.zt.keys()) : null;
  // 串行请求：本机实测东财对同一时刻的并发请求会限流
  for (const rk of RANKS) {
    try {
      const j = await emtx.fetchCListRank(rk.fid, perRank);
      const diff = (j && j.data && Array.isArray(j.data.diff)) ? j.data.diff : [];
      rankInfo.push({ label: rk.label, got: diff.length, src: j && j._source || 'eastmoney' });
      for (const r of diff) {
        if (!eligible(r, limitSet)) continue;
        const code = String(r.f12);
        if (!map.has(code)) map.set(code, { row: r, ranks: [], heatScore: null });
        map.get(code).ranks.push(rk.label);
      }
    } catch (e) {
      rankInfo.push({ label: rk.label, error: e.message });
    }
    await sleep(180);
  }

  // 涨停池作为独立候选来源：涨停股在涨幅榜里只占少数且容易被成交额门槛漏掉，
  // 单独挂钩可保证「当日最强的一批标的」稳定进入观察池。
  if (limitSet && limitSet.size) {
    try {
      const rows = await fetchQuotesByCodes(Array.from(limitSet));
      let kept = 0;
      for (const row of rows) {
        if (!eligible(row, limitSet)) continue;
        kept++;
        const code = String(row.f12);
        if (!map.has(code)) map.set(code, { row, ranks: [], heatScore: null });
        const c = map.get(code);
        if (!c.ranks.includes('涨停池')) c.ranks.push('涨停池');
      }
      rankInfo.push({
        label: '涨停池（东财 ztb）', got: rows.length, kept,
        note: '涨停股不再剔除，改由涨停结构因子（板型/封板时间/封单/连板/开板次数）刻画'
      });
    } catch (e) { rankInfo.push({ label: '涨停池', error: e.message }); }
    await sleep(160);
  }

  // 人气热榜作为独立候选来源（关注度，不等于资金流向）
  if (attention && attention.ok) {
    try {
      const hot = await fetchHotQuotes(attention, 125, limitSet);
      rankInfo.push({ label: '人气热榜（东财+同花顺）', got: hot.rows.length, note: hot.note });
      for (const { row, heat } of hot.rows) {
        const code = String(row.f12);
        if (!map.has(code)) map.set(code, { row, ranks: [], heatScore: heat });
        const c = map.get(code);
        if (!c.ranks.includes('人气热榜')) c.ranks.push('人气热榜');
        if (c.heatScore === null) c.heatScore = heat;
      }
    } catch (e) {
      rankInfo.push({ label: '人气热榜', error: e.message });
    }
  }
  return { candidates: Array.from(map.values()), rankInfo };
}

/* ------------------------------- 日线与指标 ------------------------------- */

function parseKline(j) {
  const d = j && j.data;
  if (!d || !Array.isArray(d.klines)) return null;
  const bars = [];
  for (const line of d.klines) {
    const f = line.split(',');
    const close = +f[2], high = +f[3], low = +f[4], volume = +f[5];
    if (![close, high, low].every(Number.isFinite) || close <= 0) continue;
    bars.push({
      date: f[0], open: +f[1], close, high, low, volume,
      amount: +f[6], pct: +f[8], turnover: +f[10]
    });
  }
  return bars.length >= 35 ? { name: d.name, bars } : null;
}

async function fetchDaily(code) {
  return parseKline(await emtx.fetchKline(secidOf(code), 80));
}

function sma(a, n) { return a.length < n ? null : a.slice(-n).reduce((s, x) => s + x, 0) / n; }
function std(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function emaSeries(a, n) {
  const k = 2 / (n + 1); const out = []; let prev = a[0];
  for (let i = 0; i < a.length; i++) { prev = i === 0 ? a[0] : a[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}
function rsi(close, n = 14) {
  if (close.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = close[i] - close[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    g = (g * (n - 1) + Math.max(0, d)) / n;
    l = (l * (n - 1) + Math.max(0, -d)) / n;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
function atr(bars, n = 14) {
  if (bars.length <= n) return null;
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    const b = bars[i], pc = bars[i - 1].close;
    sum += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  let a = sum / n;
  for (let i = n + 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    a = (a * (n - 1) + tr) / n;
  }
  return a;
}
function maxDrawdown(close, n = 20) {
  const a = close.slice(-n); if (a.length < 2) return 0;
  let peak = a[0], dd = 0;
  for (const v of a) { if (v > peak) peak = v; dd = Math.min(dd, (v - peak) / peak); }
  return dd * 100;
}

function computeIndicators(bars) {
  const close = bars.map(b => b.close);
  const vol = bars.map(b => b.volume);
  const last = close[close.length - 1];
  const ma5 = sma(close, 5), ma10 = sma(close, 10), ma20 = sma(close, 20), ma60 = sma(close, 60);
  const ma20Prev = close.length >= 25 ? sma(close.slice(0, -5), 20) : null;

  const e12 = emaSeries(close, 12), e26 = emaSeries(close, 26);
  const dif = e12.map((v, i) => v - e26[i]);
  const dea = emaSeries(dif, 9);
  const hist = dif.map((v, i) => 2 * (v - dea[i]));

  const sd20 = std(close.slice(-20));
  const mean20 = sma(close, 20) || last;
  const bollUp = mean20 + 2 * sd20, bollLow = mean20 - 2 * sd20;
  const bollPos = bollUp > bollLow ? (last - bollLow) / (bollUp - bollLow) : 0.5;

  const rets = [];
  for (let i = Math.max(1, close.length - 20); i < close.length; i++) rets.push((close[i] - close[i - 1]) / close[i - 1]);
  const volatility = std(rets) * Math.sqrt(250) * 100;
  const a = atr(bars) || 0;
  const vol5 = sma(vol.slice(0, -1), 5) || vol[vol.length - 1];
  const volRatio5 = vol5 ? vol[vol.length - 1] / vol5 : 1;
  const pcts = bars.slice(-20).map(b => b.pct);
  const pctStd = std(pcts) || 1;
  const zScore = sd20 ? (last - mean20) / sd20 : 0;
  const retZ = pcts.length ? pcts[pcts.length - 1] / pctStd : 0;

  return {
    last, ma5, ma10, ma20, ma60, ma20Prev,
    dif: dif[dif.length - 1], dea: dea[dea.length - 1],
    hist: hist[hist.length - 1], histPrev: hist[hist.length - 2],
    rsi14: rsi(close) || 50, bollUp, bollLow, bollPos,
    atr: a, atrPct: last ? (a / last) * 100 : 0,
    volatility, maxDD: maxDrawdown(close),
    volRatio5, zScore, retZ,
    mom5: close.length > 5 ? (last / close[close.length - 6] - 1) * 100 : 0,
    mom20: close.length > 20 ? (last / close[close.length - 21] - 1) * 100 : 0,
    high20: Math.max(...bars.slice(-20).map(b => b.high)),
    bars: close.length,
    tradingDate: bars[bars.length - 1].date
  };
}

/* ------------------------------- 评分：可缓存的「基础分」 ------------------------------- */

function subScores(ind, row) {
  const S = {};
  let t = 50;
  t += ind.last > ind.ma5 ? 10 : -10;
  t += ind.last > ind.ma10 ? 8 : -8;
  t += ind.last > ind.ma20 ? 12 : -12;
  t += ind.ma5 > ind.ma10 ? 8 : -8;
  t += ind.ma10 > ind.ma20 ? 8 : -8;
  if (ind.ma20Prev) t += ind.ma20 > ind.ma20Prev ? 6 : -6;
  S.trend = clamp(t, 0, 100);

  const m5 = clamp(50 + ind.mom5 * 3.2, 0, 100) - (ind.mom5 > 20 ? (ind.mom5 - 20) * 2 : 0);
  const m20 = clamp(50 + ind.mom20 * 1.6, 0, 100) - (ind.mom20 > 40 ? (ind.mom20 - 40) * 1.2 : 0);
  S.momentum = clamp(0.6 * m5 + 0.4 * m20, 0, 100);

  let m = 50;
  m += ind.dif > ind.dea ? 20 : -20;
  m += ind.hist > 0 ? 10 : -10;
  m += ind.hist > ind.histPrev ? 10 : -10;
  m += ind.dif > 0 ? 8 : -8;
  S.macd = clamp(m, 0, 100);

  const r = ind.rsi14;
  S.rsi = r >= 45 && r <= 65 ? 88 : r > 65 && r <= 72 ? 68 : r >= 35 && r < 45 ? 62
    : r > 72 && r <= 78 ? 42 : r > 78 ? 25 : 40;

  const p = ind.bollPos;
  S.boll = p >= 0.45 && p <= 0.82 ? 86 : p > 0.82 && p <= 0.95 ? 60 : p >= 0.2 && p < 0.45 ? 62
    : p > 0.95 ? 34 : 40;

  S.volumePrice = (ind.volRatio5 >= 1.1 && ind.volRatio5 <= 2.8 && ind.mom5 > 0) ? 86
    : ind.volRatio5 > 4 ? 48 : ind.volRatio5 < 0.8 ? 42 : 62;

  const amount = finite(row.f6) || 0;
  const flow = finite(row.f62) || 0;
  const flowRatio = amount ? flow / amount : 0;
  S.flow = clamp(50 + flowRatio * 260, 0, 100);
  const vr = finite(row.f10) || 1;
  S.volRatio = vr >= 1.0 && vr <= 2.5 ? 82 : vr > 2.5 && vr <= 4 ? 66 : vr > 4 ? 44 : 42;
  const to = finite(row.f8) || 0;
  S.turnover = to >= 3 && to <= 12 ? 86 : to >= 1 && to < 3 ? 62 : to > 12 && to <= 22 ? 58 : to > 22 ? 34 : 40;
  S.amount = clamp(((Math.log10(Math.max(amount, 1e7)) - 8) / 1.5) * 100, 0, 100);
  // 附加的原始金额字段必须改名，否则会覆盖同名的 0-100 评分导致数量级失真
  return { ...S, flowRatio, vr, to, amountRaw: amount, flowRaw: flow };
}

function riskAssessment(ind, s) {
  let penalty = 0; const notes = [];
  if (ind.volatility > 90) { penalty += 14; notes.push('年化波动率 ' + ind.volatility.toFixed(0) + '%，波动显著偏高'); }
  else if (ind.volatility > 60) { penalty += 8; notes.push('年化波动率 ' + ind.volatility.toFixed(0) + '%，波动偏高'); }
  if (Math.abs(ind.zScore) > 2.5) { penalty += 8; notes.push('价格偏离 20 日均线 ' + ind.zScore.toFixed(1) + ' 个标准差（Z-score 异常）'); }
  if (ind.mom5 > 20) { penalty += 8; notes.push('近 5 日涨幅 ' + ind.mom5.toFixed(1) + '%，短线追高风险'); }
  if (ind.rsi14 > 75) { penalty += 6; notes.push('RSI ' + ind.rsi14.toFixed(0) + ' 进入超买区'); }
  if (s.flowRatio < -0.05) { penalty += 6; notes.push('主力资金净流出占成交额 ' + (s.flowRatio * 100).toFixed(1) + '%'); }
  if (s.to > 22) { penalty += 5; notes.push('换手率 ' + s.to.toFixed(1) + '%，交易过热'); }
  if (ind.maxDD < -15) { penalty += 4; notes.push('近 20 日最大回撤 ' + ind.maxDD.toFixed(1) + '%'); }
  if (!notes.length) notes.push('未触发高波动 / 异常偏离 / 资金流出等风险项');
  return { penalty: Math.min(30, penalty), notes };
}

/** 只依赖日线与榜单快照，缓存后可在消息面/外围变化时免网络重算 */
function computeBase(cand, daily) {
  const row = cand.row;
  const ind = computeIndicators(daily.bars);
  const s = subScores(ind, row);
  const techCore = 0.30 * s.trend + 0.20 * s.momentum + 0.20 * s.macd +
    0.15 * s.rsi + 0.10 * s.boll + 0.05 * s.volumePrice;
  // K 线形态分（qlib Alpha158 Kbar 9 因子 + 14 种经典/实证形态）作为技术组的结构补充：
  // 涨停日的 K 线被涨停截断（收盘=最高价 → 上影恒为 0、kmid2 恒为 1），
  // 均线类指标对这类标的失真严重，形态分提供了一组正交的多空结构信息。
  const pattern = limitup.detectPatterns(daily.bars);
  const patternScore = pattern ? pattern.patternScore : 50;
  const tech = 0.86 * techCore + 0.14 * patternScore;
  const fund = 0.40 * s.flow + 0.25 * s.volRatio + 0.20 * s.turnover + 0.15 * s.amount;
  const risk = riskAssessment(ind, s);
  const lastBar = daily.bars[daily.bars.length - 1];
  return {
    code: String(row.f12), name: String(row.f14),
    industry: String(row.f100 || '未分类'),
    price: finite(row.f2) || ind.last, changePct: finite(row.f3),
    turnover: finite(row.f8), volRatio: finite(row.f10), amount: finite(row.f6),
    mainFlow: finite(row.f62), mainFlowPct: finite(row.f184), marketCap: finite(row.f20),
    floatCap: finite(row.f21) || finite(row.f20),
    pe: finite(row.f9), pb: finite(row.f23),
    ranks: cand.ranks,
    ind, s, tech, techCore, fund, risk, pattern, patternScore,
    bar: lastBar,
    indicators: {
      ma5: +ind.ma5.toFixed(2), ma20: +ind.ma20.toFixed(2),
      rsi14: +ind.rsi14.toFixed(1), macdHist: +ind.hist.toFixed(3),
      atrPct: +ind.atrPct.toFixed(2), volatility: +ind.volatility.toFixed(1),
      zScore: +ind.zScore.toFixed(2), mom5: +ind.mom5.toFixed(2), mom20: +ind.mom20.toFixed(2),
      bollPos: +ind.bollPos.toFixed(2), maxDrawdown: +ind.maxDD.toFixed(1)
    },
    atrStopRef: +(ind.last - 2 * ind.atr).toFixed(2),
    bars: ind.bars,
    source: '东方财富 · 日线(前复权) / 实时榜单 / 主力资金',
    tradingDate: ind.tradingDate
  };
}

/* ------------------------------- 评分：随上下文变化的「消息/热度/外围」 ------------------------------- */

function newsScoreFor(industry, briefing) {
  if (!briefing) return { score: 50, matched: [], note: '暂无消息面数据，按中性计' };
  const biases = Array.isArray(briefing.sectorBias) ? briefing.sectorBias : [];
  const matched = biases.filter(b => industry && (industry.includes(b.sector) || b.sector.includes(industry)))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const sector = matched.length ? matched[0].score : 0;
  const market = (briefing.sentimentAvg || 0) * 0.18;
  const riskDrag = (briefing.riskTemperature || 0) > 60 ? -8 : 0;
  return {
    score: clamp(50 + sector * 0.35 + market + riskDrag, 0, 100),
    matched: matched.slice(0, 2).map(b => ({ sector: b.sector, score: b.score, themes: b.themes })),
    note: matched.length
      ? '行业「' + industry + '」命中消息面主题' + matched.slice(0, 2).map(b => b.themes.join('/')).join('、')
      : '行业「' + (industry || '未分类') + '」当日无显著消息面催化，按中性计'
  };
}

function buildReasons(base, ns, sent, heat, adj, sf, ev, macro, lu) {
  const ind = base.ind, s = base.s;
  const rows = [];
  const add = (w, text) => rows.push({ w, text });
  const sg = v => (v > 0 ? '+' : '') + v;
  if (lu && lu.active) {
    add(13, '涨停结构：' + lu.note +
      (lu.parts.length ? '｜' + lu.parts.slice(0, 3).map(p => p.label + ' ' + sg(p.value)).join('、') : '') +
      (lu.isFailed ? '｜' + lu.board.note : ''));
  }
  if (ev && ev.available && Math.abs(ev.adjustment) >= 0.5) {
    add(12, '事件驱动：' + (ev.watchItem
      ? ev.watchItem.label + '（' + ev.watchItem.polarity + '）'
      : (ev.spilloverFrom ? ev.spilloverFrom + ' 龙头业绩板块联动' : '事件板块倾向')) +
      '，修正 ' + sg(ev.adjustment) + ' 分｜' + (ev.reasons[0] || ''));
  }
  if (macro && macro.available && Math.abs(macro.adjustment) >= 0.5) {
    add(11.2, '宏观状态：' + macro.volumeRegime + ' · 避险 ' + macro.riskOffLevel +
      '（' + macro.riskOffScore + '/100）· ' + macro.bucketLabel + '，修正 ' + sg(macro.adjustment) + ' 分｜' +
      (macro.reasons[0] || ''));
  }
  if (sf && sf.available && Math.abs(sf.adjustment) >= 1) {
    add(11, '量能风格：' + sf.label + '（流通市值 ' + sf.capLabel + '，代理 ' + sf.index + '）风格分 ' +
      (sf.score >= 0 ? '+' : '') + sf.score + ' / 四层第 ' + sf.rank + '，修正 ' +
      (sf.adjustment >= 0 ? '+' : '') + sf.adjustment + ' 分｜成交占比 ' + sf.share + '%（' +
      (sf.shareZ >= 0 ? '+' : '') + sf.shareZ + 'σ）、层内宽度 ' + sf.upRatio + '%' +
      (sf.volBoost ? '，量比传导 ×' + (1 + sf.volBoost).toFixed(2) : ''));
  }
  if (sent.hitCount) {
    add(10, '舆情：' + sent.label + '｜个股相关资讯 ' + (sent.ownNewsCount || 0) +
      ' 条（标题点名 ' + (sent.ownSpecificCount || 0) + ' 条），情绪指数 ' + sent.index +
      '、资讯覆盖 ' + (sent.coverageScore || 0) + '/100');
  }
  if (heat) {
    add(9, '热度：' + heat.heatLevel + ' ' + heat.heatScore + ' 分（' + heat.sourceLabel +
      '，东财第 ' + (heat.emRank || '—') + ' / 同花顺第 ' + (heat.thsRank || '—') + ' 名）');
  }
  if (Math.abs(adj.adjustment) >= 1) {
    add(8, '外围联动：' + adj.regime + ' ' + (adj.adjustment > 0 ? '+' : '') + adj.adjustment + ' 分｜' + adj.reasons[0]);
  }
  if (s.flow >= 65) {
    const abs = Math.abs(s.flowRaw);
    add(7, '主力净流入 ' + (abs >= 1e8 ? (abs / 1e8).toFixed(2) + ' 亿元' : (abs / 1e4).toFixed(0) + ' 万元') +
      '，占成交额 ' + (s.flowRatio * 100).toFixed(1) + '%');
  } else if (s.flow <= 38) add(6, '主力资金呈净流出，资金面偏弱');
  if (ns.matched.length) add(6, '消息面：' + ns.note);
  else add(3, '消息面：' + ns.note);
  if (s.trend >= 65) add(5, '站上 5/10/20 日均线且均线多头排列，趋势偏强');
  else if (s.trend <= 40) add(5, '价低于关键均线，趋势偏弱');
  if (s.macd >= 70) add(4, 'MACD 位于信号线上方且红柱走强');
  else if (s.macd <= 35) add(4, 'MACD 走弱，动能不足');
  if (ind.rsi14 >= 45 && ind.rsi14 <= 65) add(3, 'RSI ' + ind.rsi14.toFixed(0) + ' 处于健康区间，未超买');
  if (s.volRatio >= 75) add(2, '量比 ' + s.vr.toFixed(2) + '，成交温和放大');
  if (s.momentum >= 65) add(2, '5 日动量 ' + ind.mom5.toFixed(1) + '%、20 日动量 ' + ind.mom20.toFixed(1) + '%');
  return rows.sort((a, b) => b.w - a.w).slice(0, 8).map(r => r.text);
}

/** 把缓存的基础分与最新上下文融合成最终评分（无网络请求，可高频调用） */
/* --------------------------- 阶段感知权重与价值陷阱 --------------------------- */

/**
 * 阶段感知权重（参考 muntazirabidi/stock-picker 的分阶段权重思路，按 A 股市值层重设）：
 * 微盘/小盘的边际定价来自情绪与少量流动性，舆情热度权重更高、技术权重更低；
 * 大盘由机构资金与中期趋势主导，技术/资金权重更高、散户情绪权重更低。
 */
const STAGE_WEIGHTS = {
  micro: { tech: 0.34, fund: 0.24, buzz: 0.42 },
  small: { tech: 0.36, fund: 0.26, buzz: 0.38 },
  mid: { tech: 0.42, fund: 0.29, buzz: 0.29 },
  large: { tech: 0.46, fund: 0.32, buzz: 0.22 }
};
const BASE_WEIGHTS = { tech: 0.40, fund: 0.28, buzz: 0.32 };

function weightsFor(bucket, enabled) {
  if (!enabled || !STAGE_WEIGHTS[bucket]) return BASE_WEIGHTS;
  return STAGE_WEIGHTS[bucket];
}

/**
 * 价值陷阱过滤（参考 SaChIn5419/stock-screener 的 Value Trap Filter）：
 * 「便宜」不是买入理由，低估值 + 盈利恶化同时出现才是陷阱。
 * A 股口径：动态 PE ≤ 25 视为低估值；业绩预减 / 首亏 / 续亏 / 下修 / 亏损视为盈利恶化。
 */
function valueTrapCheck(base, ev, enabled) {
  const pe = finite(base.pe);
  const cheap = pe !== null && pe > 0 && pe <= 25;
  if (!enabled) return { penalty: 0, cheap, pe, pb: finite(base.pb), notes: [] };
  const bad = ((ev && ev.hits) || []).filter(h =>
    h.polarity === '利空' &&
    /预减|首亏|续亏|不及预期|下修|亏损/.test(String(h.label || '') + ' ' + String(h.title || '')));
  if (cheap && bad.length) {
    return {
      penalty: 6, cheap, pe, pb: finite(base.pb),
      notes: ['价值陷阱嫌疑：动态 PE ' + pe.toFixed(1) + ' 属低估值，但同期出现「' + bad[0].label +
        '」→ 扣 6 分（低估值可能是盈利下滑的定价，而非错杀）']
    };
  }
  if (cheap && base.risk.penalty >= 18) {
    return {
      penalty: 3, cheap, pe, pb: finite(base.pb),
      notes: ['低估值（动态 PE ' + pe.toFixed(1) + '）但技术面风险项偏多，小幅扣 3 分防「便宜但趋势向下」']
    };
  }
  return { penalty: 0, cheap, pe, pb: finite(base.pb), notes: [] };
}

function finalize(base, ctx) {
  const ns = newsScoreFor(base.industry, ctx.briefing);
  const sent = (ctx.sentiment && ctx.sentiment.get(base.code)) || DEFAULT_SENTIMENT;
  const heat = (ctx.attention && ctx.attention.items && ctx.attention.items[base.code]) || null;
  const adj = marketAdjustFor(base.industry, ctx.market);
  const heatScore = heat ? heat.heatScore : 50;
  // 大盘量能 / 市值风格因子：按流通市值归层，风格分 × 置信度 × 个股量比传导
  const sf = styleForStock(ctx.style, base.floatCap,
    { volRatio: base.volRatio }, ctx.maxStyleAdjust || 12);
  // 公司事件 / 业绩超预期 / 龙头板块联动
  const ev = events.eventAdjustFor(base, ctx.events, {
    maxAdjust: ctx.maxEventAdjust || 12,
    lookbackDays: ctx.eventLookbackDays || 14
  });
  // 存量博弈下的微小盘资金弹性 + 机构避险状态
  const macro = events.macroAdjustFor(base, ctx.macro, {
    macroMaxAdjust: ctx.macroMaxAdjust || 10
  });
  // 涨停结构：板型 / 封板时间 / 封单厚度 / 连板高度 / 开板次数 / 60 日位置 / 题材共振，
  // 再乘情绪周期系数与可成交性折扣（一字板买不到 → 打折而非加分）
  const lu = limitup.analyzeLimit(base, base.bar, ctx.limit, base.pattern, {
    maxAdjust: ctx.maxLimitAdjust || 12
  });

  // 闭环回流：经验库中「已审核通过」的规则以有界乘数微调涨停结构修正。
  // 边界：单股最多 ±2 分、不翻转符号、乘数限制在 [0.8, 1.25]——
  // 经验可以微调判断，但不能接管判断；无规则时乘数为 1，链路与原先完全一致。
  let lessonBias = null;
  if (lu.active && ctx.lessons !== false) {
    lessonBias = journal.biasFor({
      stage: lu.cycleStage, board: lu.board && lu.board.key,
      chaseRisk: lu.chaseRisk, boards: lu.boards
    });
    if (lessonBias.mult !== 1) {
      const cap = ctx.maxLimitAdjust || 12;
      const bounded = round(clamp(
        lu.adjust * lessonBias.mult,
        Math.max(-cap, lu.adjust - journal.MAX_BIAS),
        Math.min(cap, lu.adjust + journal.MAX_BIAS)
      ), 1);
      if (bounded !== lu.adjust) {
        lu.adjust = bounded;
        lu.reasons = lu.reasons || [];
        lu.reasons.push('经验库回流：' + lessonBias.notes.join('；') + '（' + lu.adjust + ' 分，变动 ≤ ' + journal.MAX_BIAS + '）');
      }
    }
  }

  // 五个方向性修正可能同向叠加（外围 / 市值风格 / 公司事件 / 宏观状态 / 涨停结构），
  // 用组合上限抑制共线信号主导总分；各因子仍保留自身可解释的修正分与理由。
  const adjustParts = {
    market: adj.adjustment, style: sf.adjustment,
    event: ev.adjustment, macro: macro.adjustment, limit: lu.adjust
  };
  const adjustSum = round(Object.values(adjustParts).reduce((a, b) => a + b, 0), 1);
  const adjustCap = clamp(Number(ctx.maxTotalAdjust) || 22, 0, 40);
  const adjustApplied = round(clamp(adjustSum, -adjustCap, adjustCap), 1);

  // 舆情热度组：个股舆情 45% + 关注度热度 35% + 行业消息面 20%
  const buzz = 0.45 * sent.score + 0.35 * heatScore + 0.20 * ns.score;
  // 阶段感知权重：按该股所属市值层切换三组权重结构（微盘偏情绪、大盘偏趋势与资金）
  const w = weightsFor(sf.key, ctx.stageWeights !== false);
  // 价值陷阱过滤：低估值 + 盈利恶化才扣分，纯低估值不扣
  const trap = valueTrapCheck(base, ev, ctx.valueTrapEnabled !== false);
  const totalPenalty = round(base.risk.penalty + trap.penalty, 1);
  // 技术/资金/舆情热度三组加权 + 四项修正的封顶合计 − 风险惩罚（含价值陷阱）
  const raw = w.tech * base.tech + w.fund * base.fund + w.buzz * buzz +
    adjustApplied - totalPenalty;
  const score = Math.round(clamp(raw, 0, 100));

  const group = [base.tech, base.fund, buzz];
  const gMean = group.reduce((a, b) => a + b, 0) / 3;
  const gStd = Math.sqrt(group.reduce((a, b) => a + (b - gMean) ** 2, 0) / 3);
  let confidence = gStd < 12 ? '高' : gStd < 24 ? '中' : '低';
  // 数据覆盖不足时下调置信度，避免「无舆情/无热度」却给出高置信
  if (!heat || !sent.hitCount) confidence = confidence === '高' ? '中' : '低';

  let signal = (score >= 70 && totalPenalty <= 12) ? '重点关注'
    : score >= 58 ? '观察' : score >= 44 ? '中性' : '谨慎';
  // 结构性强度与可交易性是两件事：追高风险过高（≥3 板高位、反复开板、一字买不进）时
  // 不推成「重点关注」，避免把「买不到 / 容易被砸」的标的放在首位。
  if (lu.active && lu.chaseRisk >= 65 && signal === '重点关注') signal = '观察';

  const risks = base.risk.notes.slice();
  trap.notes.forEach(n => risks.push(n));
  if (heat && heat.popularityTag && /连板|\d+天\d+板/.test(heat.popularityTag))
    risks.push('热榜标记「' + heat.popularityTag + '」，短线情绪过热，注意回撤');
  if (lu.active && lu.isLimitUp) {
    if (lu.board.key === 'oneWord')
      risks.push('一字板：全样本次日连板率约 61% 为最高，但约 31% 一字板无法成交，竞价排板存在买不到的执行风险');
    if (lu.boards >= 3)
      risks.push(lu.boards + ' 连板处于高位：A 股 ≥3 板候选次日收益均值回归（约 -1.2%~-4.3%），且开板即核按钮风险显著');
    if (lu.breakCount > 2)
      risks.push('盘中开板 ' + lu.breakCount + ' 次，封单不稳定，随时可能炸板');
    if (lu.chaseRisk >= 65)
      risks.push('涨停追高风险 ' + lu.chaseRisk + '/100（高位 / 高板 / 反复开板叠加），已因此下调信号等级');
  }
  if (lu.active && lu.isFailed)
    risks.push('今日触及涨停但收盘未封住（距涨停价 ' + (lu.failDepth || 0) + '%），封单被消化，属接力失败信号');
  if (ctx.limit && ctx.limit.sentiment && ctx.limit.sentiment.stage === '冰点')
    risks.push('市场情绪处于「冰点」（涨停 ' + ctx.limit.sentiment.ztCount + ' 家 / 跌停 ' +
      ctx.limit.sentiment.dtCount + ' 家，炸板率 ' + ctx.limit.sentiment.zbRate + '%），涨停溢价整体缩水，打板胜率下降');
  if (heat && heat.heatScore >= 80 && (base.s.to || 0) > 15)
    risks.push('高热关注 + 换手率 ' + base.s.to.toFixed(1) + '%，存在情绪退潮风险');
  if (sent.index <= -25) risks.push('个股舆情偏冷（情绪指数 ' + sent.index + '），需核对原始新闻');
  if (ctx.market && ctx.market.score <= -25) risks.push('外围环境' + ctx.market.regime + '，系统性风险偏好受压');
  if (sf.available && sf.score <= -30) risks.push('所属「' + sf.label + '」市值层资金倾向偏弱（风格分 ' +
    sf.score + '），存在市值风格逆风');
  if (sf.available && sf.key === 'micro') risks.push('微盘股壳价值与退市风险噪声较大（CH-3 模型建议剔除最小 30%），风格分仅作横截面相对参考');
  if (ev.available && ev.watchItem && ev.watchItem.polarity === '利空')
    risks.push('公司存在「' + ev.watchItem.label + '」类负面事件，公告标题仅为线索，需核对公告原文与后续进展');
  if (ev.available && ev.isBeat)
    risks.push('业绩超预期不等于股价上涨：A 股 PEAD 样本外方向不稳健，需防「利好出尽」与一次性损益失真');
  if (macro.available && macro.riskOffLevel === '高' && macro.bucket === 'micro')
    risks.push('机构避险温度 ' + macro.riskOffScore + '/100，微盘股流动性收缩与波动放大风险显著');
  if (adjustSum !== adjustApplied)
    risks.push('四项方向性修正合计 ' + adjustSum + ' 分，已按组合上限 ±' + adjustCap +
      ' 封顶为 ' + adjustApplied + ' 分（避免共线信号叠加过度）');

  return {
    code: base.code, name: base.name, industry: base.industry,
    price: base.price, changePct: base.changePct, turnover: base.turnover,
    volRatio: base.volRatio, amount: base.amount, mainFlow: base.mainFlow,
    mainFlowPct: base.mainFlowPct, marketCap: base.marketCap, floatCap: base.floatCap,
    ranks: base.ranks, score, signal, confidence,
    pe: base.pe, pb: base.pb,
    valuation: {
      pe: base.pe, pb: base.pb, cheap: trap.cheap,
      valueTrap: trap.penalty > 0, valueTrapPenalty: trap.penalty,
      note: trap.notes[0] || (trap.cheap ? '动态 PE ' + (trap.pe != null ? trap.pe.toFixed(1) : '—') + '，估值偏低且未检出盈利恶化' : '')
    },
    groups: {
      technical: Math.round(base.tech), capital: Math.round(base.fund),
      buzz: Math.round(buzz), news: Math.round(buzz),
      techCore: Math.round(base.techCore !== undefined ? base.techCore : base.tech),
      pattern: base.patternScore === undefined ? null : base.patternScore,
      weights: { technical: w.tech, capital: w.fund, buzz: w.buzz, bucket: sf.key || null },
      sentimentIndex: sent.index, heat: heat ? heat.heatScore : null,
      sectorNews: Math.round(ns.score),
      marketAdjust: adj.adjustment, styleAdjust: sf.adjustment,
      styleScore: sf.score, eventAdjust: ev.adjustment, macroAdjust: macro.adjustment,
      limitAdjust: lu.adjust, chaseRisk: lu.active ? lu.chaseRisk : null,
      board: lu.board.key, boardLabel: lu.board.label, boards: lu.boards || 0,
      adjustParts, adjustSum, adjustApplied, adjustCap,
      riskPenalty: base.risk.penalty, valueTrapPenalty: trap.penalty, totalPenalty
    },
    indicators: base.indicators,
    reasons: buildReasons(base, ns, sent, heat, adj, sf, ev, macro, lu),
    risks,
    atrStopRef: base.atrStopRef,
    newsNote: ns.note,
    attention: heat ? {
      heatScore: heat.heatScore, heatLevel: heat.heatLevel,
      emRank: heat.emRank, emRankDelta: heat.emRankDelta,
      thsRank: heat.thsRank, thsRankDelta: heat.thsRankDelta,
      sourceLabel: heat.sourceLabel, confidence: heat.confidence,
      conceptTags: heat.conceptTags, popularityTag: heat.popularityTag, catalyst: heat.catalyst
    } : null,
    sentiment: {
      index: sent.index, label: sent.label, score: sent.score,
      emotionScore: sent.emotionScore, coverageScore: sent.coverageScore,
      hitCount: sent.hitCount, individualHits: sent.individualHits,
      ownNewsCount: sent.ownNewsCount, ownSpecificCount: sent.ownSpecificCount,
      confidence: sent.confidence, note: sent.note, headlines: sent.headlines
    },
    marketLink: {
      adjustment: adj.adjustment, regime: adj.regime,
      matched: adj.matched, reasons: adj.reasons
    },
    styleLink: {
      available: sf.available, bucket: sf.key, label: sf.label, index: sf.index,
      capLabel: sf.capLabel, capValue: base.floatCap, score: sf.score, rank: sf.rank,
      adjustment: sf.adjustment, confidence: sf.confidence, volBoost: sf.volBoost,
      dominant: sf.dominant, share: sf.share, shareZ: sf.shareZ,
      ret5: sf.ret5, upRatio: sf.upRatio, reasons: sf.reasons
    },
    eventLink: {
      available: ev.available, adjustment: ev.adjustment, polarity: ev.polarity,
      own: ev.own, spillover: ev.spillover, sector: ev.sector,
      hitCount: ev.hitCount, isBeat: ev.isBeat, isLeader: ev.isLeader,
      watchItem: ev.watchItem, spilloverFrom: ev.spilloverFrom,
      hits: ev.hits, reasons: ev.reasons
    },
    macroLink: {
      available: macro.available, adjustment: macro.adjustment,
      bucket: macro.bucket, bucketLabel: macro.bucketLabel,
      bucketAdjust: macro.bucketAdjust, sectorAdjust: macro.sectorAdjust,
      volumeRegime: macro.volumeRegime, riskOffScore: macro.riskOffScore,
      riskOffLevel: macro.riskOffLevel, reasons: macro.reasons
    },
    limitLink: lu.active ? {
      active: true, isLimitUp: lu.isLimitUp, isFailed: lu.isFailed,
      board: lu.board, boards: lu.boards, statLabel: lu.statLabel,
      firstSealLabel: lu.firstSealLabel, lastSealLabel: lu.lastSealLabel,
      sealRatio: lu.sealRatio, sealFundYi: lu.sealFundYi, breakCount: lu.breakCount,
      failDepth: lu.failDepth, industry: lu.industry, industryZt: lu.industryZt,
      position60: lu.position60, score: lu.score, parts: lu.parts,
      cycleStage: lu.cycleStage, cycleFactor: lu.cycleFactor,
      fillable: lu.fillable, adjust: lu.adjust, chaseRisk: lu.chaseRisk,
      reasons: lu.reasons, note: lu.note
    } : { active: false },
    patternLink: base.pattern ? {
      score: base.pattern.patternScore,
      kbar: base.pattern.kbar,
      flags: base.pattern.flags.map(f => ({ key: f.key, label: f.label, side: f.side, strength: f.strength, note: f.note })),
      position60: base.pattern.position60,
      lastLimit: base.pattern.lastLimit,
      gap: base.pattern.gap
    } : null,
    coverage: {
      heat: !!heat, news: sent.hitCount > 0, market: adj.matched > 0, style: sf.available,
      event: ev.available && (ev.hitCount > 0 || ev.spillover > 0 || ev.sector !== 0),
      macro: macro.available,
      limit: lu.active, pattern: !!base.pattern
    },
    bars: base.bars,
    source: base.source,
    tradingDate: base.tradingDate
  };
}

/* ------------------------------- 上下文指纹与缓存 ------------------------------- */

/** 内容指纹：只取真正影响评分的字段，避免时间戳变化引发无谓重算 */
function contextSignature(ctx = {}) {
  const b = ctx.briefing || {}, a = ctx.attention || {}, m = ctx.market || {}, st = ctx.style || {};
  const ev = ctx.events || {}, mc = ctx.macro || {};
  const lm = ctx.limit || {};
  const heatTop = a.items
    ? Object.values(a.items).sort((x, y) => (y.heatScore || 0) - (x.heatScore || 0))
      .slice(0, 15).map(x => x.code + ':' + x.heatScore).join(',')
    : '';
  const sentSum = ctx.sentiment instanceof Map
    ? Array.from(ctx.sentiment.values()).reduce((s, x) => s + (x.hitCount || 0) * 10 + (x.index || 0), 0) : 0;
  return hash([
    b.sentimentAvg || 0, b.riskTemperature || 0, (b.counts && b.counts.total) || 0,
    (b.sectorBias || []).slice(0, 8).map(x => x.sector + ':' + x.score).join(','),
    hash(heatTop), a.poolSize || 0, a.stale ? 1 : 0,
    m.signature || '', sentSum, hash(ctx.newsFingerprint || ''), ctx.stockNewsFingerprint || '',
    st.signature || '', st.dominant || '', st.confidence || 0, ctx.maxStyleAdjust || 12,
    ev.signature || '', (ev.counts && ev.counts.total) || 0,
    mc.signature || '', ctx.maxEventAdjust || 12, ctx.macroMaxAdjust || 10, ctx.maxTotalAdjust || 22,
    lm.signature || '', ctx.maxLimitAdjust || 12
  ].join('|'));
}

function readCache() {
  if (memCache) return memCache;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const o = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const bases = o._bases || null;
      delete o._bases;
      Object.defineProperty(o, '_bases', { value: bases, enumerable: false, writable: true });
      memCache = o;
    }
  } catch (_) { memCache = null; }
  return memCache;
}

function writeCache(data) {
  memCache = data;
  try {
    const tmp = CACHE_FILE + '.tmp';
    // _bases 是非枚举属性，写盘时需显式带上；前端 SSE 推的仍是剔除后的干净对象
    fs.writeFileSync(tmp, JSON.stringify({ ...data, _bases: data._bases || null }), 'utf8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) { console.warn('[stocks] 缓存写入失败:', e.message); }
}

function buildContextMeta(ctx, rescoreOnly, fullRunAt) {
  const a = ctx.attention || {}, m = ctx.market || {}, b = ctx.briefing || {}, st = ctx.style || {};
  const ev = ctx.events || {}, mc = ctx.macro || {}, lm = ctx.limit || {};
  return {
    rescoreOnly: !!rescoreOnly,
    fullRunAt: fullRunAt || Date.now(),
    marketRegime: m.regime || '无行情数据',
    marketScore: m.score || 0,
    marketNote: m.note || '',
    styleDominant: st.dominantLabel || (st.ok === false ? '数据不可用' : '等待量能数据'),
    styleConfidence: st.confidence || 0,
    styleVolumeState: (st.volume && st.volume.state) || '',
    styleTradingDate: st.tradingDate || '',
    volumeRegime: (mc.volume && mc.volume.regime) || '',
    volumeAmountYi: (mc.volume && mc.volume.amountYi) || 0,
    volumeThresholdYi: (mc.volume && mc.volume.thresholdYi) || 0,
    riskOffScore: (mc.riskOff && mc.riskOff.score) || 0,
    riskOffLevel: (mc.riskOff && mc.riskOff.level) || '',
    eventTotal: (ev.counts && ev.counts.total) || 0,
    eventFocus: (ev.counts && ev.counts.focus) || 0,
    eventBeats: (ev.counts && ev.counts.earningsBeats) || 0,
    leaderBeats: (ev.counts && ev.counts.leaderBeats) || 0,
    eventSpillovers: (ev.spillovers || []).length,
    // 涨停池 / 情绪周期
    limitUpCount: lm.zt ? lm.zt.size : 0,
    limitFailedCount: lm.zb ? lm.zb.size : 0,
    limitDownCount: lm.dtCount || 0,
    sentimentStage: (lm.sentiment && lm.sentiment.stage) || '',
    sentimentFactor: (lm.sentiment && lm.sentiment.factor) || 1,
    sentimentMaxBoards: (lm.sentiment && lm.sentiment.maxBoards) || 0,
    sentimentZbRate: (lm.sentiment && lm.sentiment.zbRate) || 0,
    sentimentAdvanceRate: (lm.sentiment && lm.sentiment.advancement) ? lm.sentiment.advancement.rate : null,
    sentimentDate: (lm.sentiment && lm.sentiment.date) || '',
    attentionOk: !!a.ok,
    attentionSources: a.sources || {},
    attentionNote: a.note || '',
    attentionFetchedAtLabel: a.fetchedAtLabel || '',
    newsAnalyzed: (b.counts && b.counts.total) || 0,
    linkage: '新闻解读、公司公告与业绩事件、人气热榜、外围行情、大盘量能或涨停池任一变化时自动重新融合评分（复用已缓存技术指标与形态分，无额外日线请求）'
  };
}

function summarize(items) {
  const coveredHeat = items.filter(x => x.coverage.heat);
  const coveredNews = items.filter(x => x.coverage.news);
  return {
    avgScore: Math.round(items.reduce((s, x) => s + x.score, 0) / items.length),
    focus: items.filter(x => x.signal === '重点关注').length,
    watch: items.filter(x => x.signal === '观察').length,
    caution: items.filter(x => x.signal === '谨慎').length,
    topIndustry: mostCommon(items.slice(0, 6).map(x => x.industry)),
    heatCovered: coveredHeat.length,
    sentimentCovered: coveredNews.length,
    styleCovered: items.filter(x => x.coverage && x.coverage.style).length,
    eventCovered: items.filter(x => x.coverage && x.coverage.event).length,
    macroCovered: items.filter(x => x.coverage && x.coverage.macro).length,
    valueTraps: items.filter(x => x.valuation && x.valuation.valueTrap).length,
    limitUp: items.filter(x => x.limitLink && x.limitLink.isLimitUp).length,
    limitFailed: items.filter(x => x.limitLink && x.limitLink.isFailed).length,
    multiBoard: items.filter(x => x.limitLink && x.limitLink.boards >= 2).length,
    oneWord: items.filter(x => x.limitLink && x.limitLink.board && x.limitLink.board.key === 'oneWord').length,
    patternCovered: items.filter(x => x.coverage && x.coverage.pattern).length,
    avgHeat: coveredHeat.length ? Math.round(coveredHeat.reduce((s, x) => s + x.groups.heat, 0) / coveredHeat.length) : null
  };
}

/** 舆情按「本轮实际入选的标的」计算，避免首次运行或候选池变化时对不上号 */
async function withSentiment(ctx, bases) {
  if (typeof ctx.sentiment !== 'function') return ctx;
  const list = bases.map(b => ({ code: b.code, name: b.name, industry: b.industry }));
  let sentiment = ctx.sentiment(list);
  if (sentiment && typeof sentiment.then === 'function') sentiment = await sentiment;
  return { ...ctx, sentiment };
}

/** 上下文变化时的轻量重评分：不拉日线，直接复用 bases */
async function rescore(cached, ctx, signature) {
  const effCtx = await withSentiment(ctx, cached._bases);
  const items = cached._bases.map(b => finalize(b, effCtx));
  items.sort((a, b) => b.score - a.score || (b.mainFlow || 0) - (a.mainFlow || 0));
  const fullRunAt = cached.fullRunAt || cached.generatedAt;
  const result = {
    ...cached,
    items, top: items.slice(0, Math.min(10, items.length)),
    summary: summarize(items),
    generatedAt: Date.now(), fullRunAt,
    signature, fromCache: false, rescoreOnly: true,
    contextMeta: buildContextMeta(ctx, true, fullRunAt)
  };
  Object.defineProperty(result, '_bases', { value: cached._bases, enumerable: false, writable: true });
  writeCache(result);
  return result;
}

/* ------------------------------- 主流程 ------------------------------- */

/**
 * @param {object} ctx   { briefing, attention, sentiment(Map), market, news }
 * @param {object} opts  { force, maxStocks, refreshMin }
 */
async function analyzeStocks(ctx = {}, opts = {}) {
  const bj = beijing();
  const trading = isTradingSession(bj);
  const refreshMin = clamp(Number(opts.refreshMin) || (trading ? 5 : 60), 1, 240);
  const ttl = refreshMin * 60000;
  const signature = contextSignature(ctx);
  const cached = readCache();

  if (!opts.force && cached && cached.items && cached.items.length) {
    const lastFull = cached.fullRunAt || cached.generatedAt;
    const expired = Date.now() - lastFull >= ttl;
    if (!expired && cached.signature === signature) return { ...cached, fromCache: true, signature };
    if (!expired && cached.signature !== signature && cached._bases && cached._bases.length) {
      return rescore(cached, ctx, signature);
    }
  }

  const maxStocks = clamp(Number(opts.maxStocks) || 18, 8, 30);
  const perRank = Math.max(20, Math.round(maxStocks * 1.6));
  const pool = await fetchCandidatePool(perRank, ctx.attention, ctx.limit);
  if (!pool.candidates.length) throw new Error('候选池为空（数据源不可达或全部被过滤）');

  const scoreOf = c => c.ranks.length * 2 + (finite(c.row.f184) || 0) / 10 +
    Math.log10(Math.max(1, finite(c.row.f6) || 1)) / 5;
  pool.candidates.sort((a, b) => scoreOf(b) - scoreOf(a));

  // 分层配额：关注度（人气热榜）与涨停强度（涨停池）各占约 40%，其余给行情三榜。
  // 目的：涨停股不再被剔除，但也不让它垄断观察池——18 个名额里既有「当日最强的封板结构」，
  // 也有「没涨停但趋势/资金在改善」的标的，两类信号互补而非互相挤压。
  const hot = pool.candidates.filter(c => c.ranks.includes('人气热榜'))
    .sort((a, b) => (b.heatScore || 0) - (a.heatScore || 0) || scoreOf(b) - scoreOf(a));
  const limitList = pool.candidates.filter(c => c.ranks.includes('涨停池'))
    .sort((a, b) => scoreOf(b) - scoreOf(a));
  const hotQuota = Math.round(maxStocks * 0.4);
  const limitQuota = Math.round(maxStocks * 0.4);
  const picked = [];
  const pickedSet = new Set();
  const take = (arr, n) => {
    let k = 0;
    for (const c of arr) {
      if (k >= n || picked.length >= maxStocks) break;
      if (pickedSet.has(c)) continue;
      pickedSet.add(c); picked.push(c); k++;
    }
  };
  take(hot, hotQuota);
  take(limitList, limitQuota);
  // 剩余名额按综合分补齐（行情三榜来源在此进入）
  const rest = pool.candidates.slice().sort((a, b) => scoreOf(b) - scoreOf(a));
  take(rest, maxStocks - picked.length);

  const bases = [];
  const failures = [];
  for (let i = 0; i < picked.length; i += 4) {
    const batch = picked.slice(i, i + 4);
    const res = await Promise.allSettled(batch.map(async c => {
      const daily = await fetchDaily(String(c.row.f12));
      if (!daily) throw new Error('日线不足');
      return computeBase(c, daily);
    }));
    res.forEach((r, k) => {
      if (r.status === 'fulfilled') bases.push(r.value);
      else failures.push(String(batch[k].row.f12) + ': ' + (r.reason && r.reason.message));
    });
    if (i + 4 < picked.length) await sleep(160);
  }
  if (!bases.length) throw new Error('所有候选股日线获取失败');

  const effCtx = await withSentiment(ctx, bases);
  const items = bases.map(b => finalize(b, effCtx));
  items.sort((a, b) => b.score - a.score || (b.mainFlow || 0) - (a.mainFlow || 0));

  const tradingDate = items[0].tradingDate;
  const isStaleDate = tradingDate !== bj.date;
  const generatedAt = Date.now();

  const result = {
    version: 2,
    generatedAt, fullRunAt: generatedAt,
    tradingDate,
    market: 'A股（沪深主板 / 创业板 / 科创板）',
    session: trading ? '交易时段' : (isStaleDate ? '非交易时段 · 显示最近交易日数据' : '非交易时段 · 当日收盘数据'),
    isTrading: trading,
    isStaleDate,
    note: isStaleDate
      ? '当前为非交易日或尚未开盘，价格与资金流为 ' + tradingDate + ' 收盘数据，指标不构成次日开盘依据。'
      : '数据来自东方财富公开接口，盘中为最新快照，收盘后为当日收盘值。',
    universe: {
      source: '东方财富行情三榜（涨幅/成交额/主力净流入）+ 涨停池 + 人气两榜（东财人气/同花顺热榜），按「人气热榜 40% / 涨停池 40% / 行情三榜补齐」分层抽样',
      rankInfo: pool.rankInfo,
      poolSize: pool.candidates.length,
      analyzed: items.length,
      failures,
      filters: '剔除 ST / 退市 / 北交所 / 跌停 / 市值<30亿或>8000亿 / 价格<3元或>1000元；涨停股不再剔除（成交额门槛放宽至 3000 万、换手上限放宽至 45%），改由涨停结构因子刻画；非涨停股仍要求成交额≥1亿、换手≤30%'
    },
    items,
    top: items.slice(0, Math.min(10, items.length)),
    summary: summarize(items),
    contextMeta: buildContextMeta(ctx, false, generatedAt),
    signature,
    fromCache: false,
    rescoreOnly: false,
    methodology: {
      indicators: 'MA5/10/20/60、EMA12/26、MACD(DIF/DEA/柱)、RSI14、布林带(20,2)、ATR14、量比、5/20日动量、20日波动率、Z-score、最大回撤（参考 StockView / QuantFusionAI / StockSentimentAlpha）',
      fusion: '三组基础分：技术（趋势30/动量20/MACD20/RSI15/布林10/量价5，其中 86% 为指标分、14% 为 K 线形态分）+ 资金（主力净流入40/量比25/换手20/成交额15）+ 舆情热度（个股舆情45/关注度热度35/行业消息面20）。权重按市值层切换（阶段感知）：微盘 34/24/42、小盘 36/26/38、中盘 42/29/29、大盘 46/32/22（微盘情绪主导、大盘趋势与资金主导）。再叠加五项方向性修正（外围 ±12 / 量能风格 ±12 / 公司事件 ±12 / 宏观状态 ±10 / 涨停结构 ±12，合计按 ±22 封顶）与风险惩罚（含价值陷阱）。权重结构参考 StockSentimentAlpha（情绪30/RSI25/MACD25/趋势20）、AutoWealth 加权投票与 stock-picker 分阶段权重，按 A 股口径重设',
      limitUp: '涨停板纳入量化（不再作为噪音剔除）：板型由当日 OHLC 与涨停价比较判定为 一字板 / T 字板 / 换手板 / 炸板未回封；结构分以全市场次日连板率基线（约 20%）对应 50 分为原点，按实证超额赋值——板型（一字 +26 / T字 +12 / 换手 0 / 炸板 -18）、封板时间（开盘即封 +16 / 早盘 +6 / 午后 -4 / 尾盘 -14）、封单占流通市值（>2% +16 / >1% +8 / <0.5% -6）、连板高度（首板 -4 / 2板 +9 / 3板 +6 / ≥5板 -8，对齐 ≥3 板次日均值回归）、盘中开板次数（-4/-9/-15）、60 日位置（≥90% 分位 -9）、题材共振（同行业涨停 ≥6 家 +8）。再乘「市场情绪周期系数」与「可成交性折扣」（一字板 ×0.85，因约 31% 无法成交），映射为 ±12 分修正。注意：换手率与主力资金流对连板率无增量信息（全样本 24.0/20.3/20.9/20.6% 无差别），故未纳入涨停强度因子',
      klinePattern: 'K 线形态因子：① qlib Alpha158 的 9 个 Kbar 微结构因子（KMID 实体偏移 / KLEN 振幅 / KMID2 收盘区间位置 / KUP·KUP2 上影 / KLOW·KLOW2 下影 / KSFT·KSFT2 跳空）；② 涨停接力形态——涨停后高开大阴（BBC，-13）、连板后跳空走弱（-10）、单阳不破（+7）、涨停后缩量回调（+6）；③ 经典形态——放量长上影（-7）、放量滞涨（-6）、冲高回落（-6）、长下影承接（+5）、看涨/看跌吞没（±6）、十字星（中性）；④ 突破与量价——缩量整固后放量突破（+11）、倍量阳（+5）、多方炮（+9）、向上/向下跳空未回补（+4/-5）。形态净分 = 50 + (多头强度 − 空头强度) × 2.2，截断 0–100。涨停日 K 线被涨停截断（收盘=最高价→上影恒为 0），形态分对此类标的提供了正交信息',
      sentimentCycle: '市场情绪周期（供涨停结构因子使用）：以涨停家数 / 跌停家数 / 炸板率 / 连板梯队高度 / 昨日涨停晋级率判定六阶段——冰点（跌停≥涨停 1.5 倍且涨停<45 家）、退潮（炸板率≥45% 且涨停<55 家）、高潮（涨停≥70 家、炸板率≤30%、最高板≥5）、主升（涨停≥45 家且最高板≥4）、启动（晋级率≥28%）、修复。周期系数 0.58–1.15 只作用于涨停强度的正向偏离（弱势环境涨停溢价缩水），负向偏离至少 ×1.05 放大（退潮期不美化烂板）。参考 shy3130/tick-stock-panel 的六阶段，但不引入状态机——quantskills 的 ablation 显示连板状态机会降低胜率',
      valueTrap: '价值陷阱过滤（参考 SaChIn5419/stock-screener）：动态 PE ≤ 25 判为低估值，若同期存在业绩预减 / 首亏 / 续亏 / 下修 / 亏损类事件，扣 6 分并提示「低估值可能是盈利下滑的定价」；低估值但技术风险项 ≥18 时扣 3 分。纯低估值不加分也不扣分——便宜不是买入理由',
      stageWeights: '分层权重依据 A 股风格事实：微盘/小盘的边际定价更多来自情绪与少量流动性（因此舆情热度权重 42%/38%），大盘由机构资金与中期趋势主导（技术 46% + 资金 32%）。与量能风格修正叠加时可能出现方向冲突，故风格修正单独封顶 ±12',
      evaluation: '评分有效性自检（server/ic.js）：每个交易日 14:50 定格一次评分快照，用冻结后的真实日线计算 T+1/3/5/10 交易日前瞻收益，逐日计算横截面 Spearman Rank IC，滚动 20 个快照日聚合 IC 均值、ICIR、正 IC 占比与 t 值，并给出 12 个因子组的独立 IC、得分三分位收益差与存量/增量市场分层 IC。结论写入 data/ic-lessons.md 经验库。参考 microsoft/qlib 的 IC/RankIC 与 quantopian/alphalens 的因子分层检验',
      sentiment: '个股舆情：东财个股中文资讯（标题点名个股名/代码者权重 1.5，栏目关联资讯 0.4）+ 全球新闻按个股名/行业/概念命中 → VADER 式双语情感分 × 12 小时半衰期 × 重要度 → 情绪指数；再以「情绪 65% + 资讯覆盖度 35%」合成。覆盖度只反映信息流关注，不代表利好。参考 StockSentimentAlpha 的 per-ticker daily sentiment index；未采用 FinBERT（需 PyTorch/GPU，与零依赖 Node 冲突）',
      heat: '关注度热度：东财人气榜 + 同花顺热榜双源交叉，名次归一化 100−(名次−1)×0.9、log 热度值分位、双榜加成与排名变动；单源标注「中」置信度。参考 TrendRadar 多平台排名/排名变化聚合与 OpenStock 跨源情绪卡',
      marketLink: '外围联动：黄金/原油/美债10Y/美元指数日内变动 → 风险偏好状态 → 行业敏感度规则（贵金属、能源、运输、成长、金融、地产、出口链）→ ±12 分修正。方向为规则推理，不是因果结论',
      eventDriven: '公司事件：东财公告（重组 / 拟收购 / 回购 / 重要股东减持 / 增持 / 重大合同 / 解禁 / 立案 / 质押 / 审批等 17 类）+ 业绩预告 / 快报（预告类型 + 同比中值非线性幅度 + 超预期文本 + 损益质量）→ 利多/利空判定与 ±12 分修正；龙头超预期业绩按行业内信息溢出给同板块标的加分（同行业只取最强一条、15 天半衰期）；宏观新闻按 12 组规则给出受益 / 受损板块。依据 PEAD（Ball & Brown 1968、Bernard & Thomas 1989，A 股方向不稳健）、A 股减持事件研究、intra-industry information transfer（Firth 1976 / Ramnath 2002）',
      macroRegime: '宏观状态：① 两市成交额低于 2.5 万亿锚（并用 70 日历史分位校准）判为存量博弈 / 板块轮动，用 Amihud(2002) ILLIQ 与 Kyle(1985) λ 的层级化近似实测四层「单位资金价格冲击」，微盘/小盘因少量资金即可推动获得弹性加成（双向：砸盘也容易）；② 全球经济不确定性 → 机构避险温度（新闻风险温度 / 高风险主题 / 外围 regime / 黄金美元动量），偏好大盘与防御、回避微盘高波动，并抑制弹性加成。两者合成 ±10 分修正。参考华泰金工市值择时(2025)、Ang et al.(2006) 低波异象、flight-to-quality',
      volumeStyle: '大盘量能：上证+深证成交额 / 20 日均量（稳健 z-score）判断放量缩量，叠加全市场上涨家数占比判断量价配合。市值风格：以沪深300 / 中证500 / 中证1000 / 中证2000 分别代理大盘 / 中盘 / 小盘 / 微盘，用 ① 成交额占比相对 20 日的稳健 z-score（28%）② 5/20 日横截面相对动量（26%）③ 近 3 日带符号量价配合（20%）④ 份额‑收益弹性（12%，Amihud 单位资金冲击的层级化近似）⑤ 层内上涨宽度（14%）− 换手率 60 日分位 >80% 的拥挤度惩罚，融合成四层风格分。个股按流通市值归层（<50亿 / 50–150亿 / 150–500亿 / >500亿），风格分 × 模型置信度 × 个股量比传导 → ±12 分修正。方法依据：华泰金工市值因子择时(2025)、Liu/Stambaugh/Yuan(2019) CH-3/CH-4、Amihud(2002)、High-Volume Return Premium(2001)，横截面标准化参考 microsoft/qlib 的 CSZScoreNorm',
      realtime: '日线重算按 refreshMin 节流；新闻解读、热榜或外围行情任一变化触发「轻量重评分」（复用缓存基础分、无额外行情请求），消息面与外围波动可近实时反映到排序',
      explainability: '每只标的输出分组得分、命中理由、风险项、热度来源、舆情命中标题与置信度；无舆情/无热度数据时按中性 50 计并下调置信度',
      risk: '基于 ATR 的波动参考位 = 收盘价 − 2×ATR14，仅刻画波动幅度，不是止损建议（参考 QuantFusionAI）',
      noForecast: '不输出目标价与涨跌预测。StockView 公开的时序 80/20 回测显示主流 ML 模型样本外平均 R² 为负；katsav21/NVDA_Sentiment_Analysis 实测社媒情绪与股价相关系数仅 -0.112，故舆情只作横截面相对因子',
      references: [
        'github.com/SiD-array/StockView（2026-06，指标 / Z-score / VADER / 时序回测）',
        'github.com/ramhee98/StockSentimentAlpha（2025-10，每标的情绪指数 / VADER+FinBERT / 信号权重）',
        'github.com/sansan0/TrendRadar（2026，多平台热榜 / 排名变化 / 出现频次）',
        'github.com/Open-Dev-Society/OpenStock（2025–2026，跨源情绪卡 / 分歧度）',
        'github.com/amelitasantiago/ai-stock-watcher（NUS-ISS 2025，多信号融合）',
        'github.com/Jay7751/QuantFusionAI（2026-01，可解释信号 / ATR 风控）',
        'github.com/Jsoned/autowealth-ai（加权投票）',
        'github.com/Creeper998/daily_stock_analysis（2026-05，中文决策仪表盘）',
        'github.com/microsoft/qlib（Alpha158/360、CSZScoreNorm/CSRankNorm、IC/RankIC、CSI300/500/1000 股票池）',
        'github.com/quantopian/alphalens（IC 与分位分层一致性检验）、github.com/akfamily/akshare（东财 push2 接口口径）',
        'github.com/SaChIn5419/stock-screener（价值陷阱过滤器：便宜但盈利萎缩扣分）、github.com/muntazirabidi/stock-picker（分阶段权重：复利型/成熟/成长/投机不同权重）、GitHub 2026 量化打分横评（qlib 基准 Rank IC 0.04–0.05）',
        '华泰金工《基于趋势和拐点的市值因子择时模型》(2025)、Liu/Stambaugh/Yuan (2019) CH-3/CH-4、Amihud (2002) ILLIQ',
        'github.com/virattt/ai-hedge-fund（signals/pead.py）、github.com/aniketnmishra/PEAD、github.com/simonlin1212/a-stock-data（A股公告/事件数据层）、github.com/hzzqq/StockSignal（事件驱动回溯）',
        'Kyle (1985) λ、Ang/Hodrick/Xing/Zhang (2006) 低波异象、Ball & Brown (1968) / Bernard & Thomas (1989) PEAD、Firth (1976) / Ramnath (2002) 行业信息溢出、华泰金工《金工：小盘或率先开展反弹》(2026)',
        'github.com/quantskills/skill-alpha-a3-streak-leader-relay（连板龙头接力因子：连板数 +0.18 / 题材龙头 +0.18 / 早封板 +0.13 / 封板强度 +0.09 / 炸板风险 -0.13 / 60 日位置 -0.09；≥3 板次日均值回归 -1.18%~-4.31%、一字板 31% 不可成交、IS/OOS IC 0.054/0.179）',
        'github.com/quantskills/skill-quant-factor-risk-pattern-alpha（288 个 OHLCV 风险与形态因子，含 96 个 K 线形态/缺口/影线因子，验证口径为 5 日 Rank IC、ICIR、Q5-Q1 与无未来函数检查）',
        'github.com/Xib1uvXi/AlphaSpike（BBC 涨停后高开大阴、放量长上影、放量滞涨、高位回落、缩量整固突破、多方炮、由强转弱七类形态检测器）、github.com/shy3130/tick-stock-panel（情绪周期六阶段、连板梯队、封单监控）、github.com/benbenlijie/stock_quant_tool（连板选股：市场情绪 + 筹码集中度 + 龙虎榜 + 题材共振）',
        '大波浪数据 limit-radar 全样本涨停统计（2026-10~11，样本 2 万+ 次涨停：一字板次日连板率 61.1% / T 字板 35.7% / 换手板 17.6%；早封 37.3% / 晚封 15.4%；封单厚 38.4% / 薄 18.5%；连续板 38.6% / 首板 16.3%；换手率与主力资金流对连板率无增量信息）、穿透 1694 次涨停的形态统计（换手板占 78.9% 且首板次日连板率仅 12.3%，分歧板 29.7%，一字板 7.3% 但连板率 66.7%）',
        'qlib Alpha158 Kbar 9 因子（KMID / KLEN / KMID2 / KUP / KUP2 / KLOW / KLOW2 / KSFT / KSFT2）与 TA-Lib CDL 系列（吞没、十字星、锤子线等经典单/双根形态定义）',
        '未采用：Ayushs6/StockWatch、AjayParthibha/Market-Sentiment-Analyzer、katsav21/NVDA_Sentiment_Analysis（Reddit/FinBERT 需 API key 与 GPU，本机数据源不可达）'
      ]
    },
    disclaimer: '本观察池为量化规则的横截面筛选结果，不是全市场扫描，不构成投资建议、买卖信号或收益承诺。热度反映关注度而非资金流向；个股资讯为东财个股页栏目（个股新闻与板块资讯混合），舆情为关键词与情感词典的规则推理；外围联动与量能风格均为方向修正而非因果判断或资金流测量——四个规模指数成分非完全互斥、成交额口径与两市总额不同，60~70 根日线不足以估多年分位，全市场快照分页存在跨页时点差；风格分只表示同一时点四层的相对倾向，极端单边行情下更多反映避险与抛压。微盘股壳价值与退市风险噪声大。公司事件为公告标题与栏目的规则判读，公告标题不等于事实（重组可能终止、回购可能不执行、预增可能来自政府补助或低基数），且同一报告期已做去重；A 股 PEAD 样本外方向不稳健，业绩超预期不等于股价上涨，需防「利好出尽」。宏观状态中的 2.5 万亿为绝对锚，会随上市公司数量与总市值膨胀漂移，已用 70 日成交额分位校准但样本仍偏短；单位资金价格冲击为代理指数相对口径，弹性是双向的（少量资金可拉升，同样容易砸盘）。五项方向性修正合计按 ±22 封顶。涨停结构因子基于公开的大样本历史连板率统计，但该统计是市场状态相关的（退潮/冰点期整体失效，故用情绪周期系数打折）；封板时间与封单额是当日快照，盘中仍在变化；一字板的高连板率与「约 31% 无法成交」是同一件事的两面，系统同时给出可成交性与追高风险，未把不可交易的信号当作机会；≥3 板次日收益均值回归，涨停股不构成打板建议。K 线形态为规则识别（qlib Alpha158 Kbar 9 因子与经典形态定义），不含主观画线，形态分不预测次日涨跌。A股 T+1 且有涨跌停限制，请结合原始公告、原文与实时行情独立判断。'
  };
  Object.defineProperty(result, '_bases', { value: bases, enumerable: false, writable: true });
  writeCache(result);
  return result;
}

function mostCommon(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
}

module.exports = {
  analyzeStocks, computeIndicators, fetchCandidatePool, computeBase, finalize,
  contextSignature, scoreOne: (c, d, ctx) => finalize(computeBase(c, d), ctx || {}),
  CACHE_FILE
};
