'use strict';

/**
 * 涨停板结构 + K 线形态因子（A 股）
 *
 * ============================ 为什么要做这个模块 ============================
 * 原实现把 |涨跌幅| ≥ 9.8% 的个股整体剔除（「买不进也卖不出」）。这等于把
 * A 股信息密度最高的一类价格行为（涨停封板）整个丢出因子体系——而它恰恰是
 * 资金态度最极端的表达。本模块把涨停板从「噪音」改成「可量化的结构信号」，
 * 但绝不是简单加分：涨停是「强度」与「可成交性/回归风险」两维并存的，
 * 只加不减会系统性高估打板标的。
 *
 * ============================ 实证基线（不是拍脑袋） ============================
 * 以下权重方向来自公开的大样本统计，而非主观经验：
 *
 * 1) 大波浪数据 / limit-radar 全样本（2026-10 至 11 多日，样本 2 万+ 次涨停）：
 *    全市场次日连板率基线 ≈ 20%，各特征相对基线的超额（pp）：
 *      板型 一字板 61.1%(+39.6) > T字板 35.7%(+14.2) > 换手板 17.6%(-3.9)
 *      封板 早封 ≤09:35 37.3%(+15.8) > 晚封 15.4%(-6.1)
 *      封单 厚 >2% 38.4%(+16.9) > 薄 ≤2% 18.5%(-3.0)
 *      高度 连续板 38.6%(+17.1) > 断板重来 25.3%(+3.8) > 首板 16.3%(-5.2)
 *    两个「反直觉但重要」的结论：换手率高低对连板率无差别（24.0/20.3/20.9/20.6%），
 *    主力资金流对连板没有增量信息。→ 本模块不把换手率、主力净额当作涨停强度因子，
 *    这也解释了为什么单靠技术/资金分无法刻画打板质量。
 *
 * 2) 穿透 1694 次涨停的形态统计：换手板占 78.9%（首板次日连板率仅 12.3%）、
 *    一字板占 7.3%（连板率 66.7% 但启动期买不进）、分歧板（炸板回封）占 11.5%
 *    （连板率 29.7%，抗风险能力优于缩量秒板）；5 板以上多由重组/壳/股权变更驱动，
 *    与基本面脱钩。
 *
 * 3) quantskills/skill-alpha-a3-streak-leader-relay（连板龙头接力因子）权重：
 *    连板数 +0.18、题材龙头 +0.18、早封板 +0.13、封板强度 +0.09、
 *    炸板风险 -0.13、60 日位置 -0.09、涨停家数 z +0.10、炸板率 z -0.10；
 *    并披露 ≥3 板候选次日均值回归 -4.31%~-1.18%、一字板 31% 无法成交。
 *    → 本模块保留「≥3 板扣分」「60 日高位扣分」「炸板次数扣分」三个负向项。
 *
 * 4) K 线形态因子借鉴 microsoft/qlib Alpha158 的 9 个 Kbar 微结构因子
 *    （KMID/KLEN/KMID2/KUP/KUP2/KLOW/KLOW2/KSFT/KSFT2）与
 *    quantskills/skill-quant-factor-risk-pattern-alpha（288 个 OHLCV 形态因子，
 *    验证口径为 5 日 Rank IC / ICIR / Q5-Q1 差），以及 Xib1uvXi/AlphaSpike
 *    的实测形态检测器（BBC 涨停后高开大阴、放量长上影、放量滞涨、高位回落、
 *    缩量整固突破、多方炮、由强转弱）。
 *
 * ============================ 诚实边界 ============================
 * - 封板时间/封单额是**当日快照**，收盘后为终值；盘中会继续变化。
 * - 一字板的高连板率与「买不到」是同一件事的两面，本模块同时输出 fillable
 *   可成交性，避免把不可交易的信号当成机会。
 * - 涨停强度的历史统计是市场状态相关的（quantskills 披露 IS IC 0.054 / OOS 0.179），
 *   退潮期整体失效，因此用情绪周期系数整体打折。
 * - 不预测次日是否涨停。输出的是「该涨停的结构在历史上处于什么位置」。
 */

const fs = require('node:fs');
const path = require('node:path');
const { UA } = require('./sources');

const UT = '7eea3edcaed734bea9cbfc24409ed989';
const ZT_URL = 'https://push2ex.eastmoney.com/getTopicZTPool';
const ZB_URL = 'https://push2ex.eastmoney.com/getTopicZBPool';
const DT_URL = 'https://push2ex.eastmoney.com/getTopicDTPool';
const POOL_FILE = path.join(__dirname, '..', 'data', 'limitup-cache.json');
const HIST_FILE = path.join(__dirname, '..', 'data', 'limitup-history.json');
const MAX_HIST_DAYS = 40;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round = (v, n = 1) => +Number(v).toFixed(n);
const finite = v => (Number.isFinite(+v) ? +v : null);

function beijingDate() {
  const d = new Date(Date.now() + 8 * 3600000);
  return {
    date: d.toISOString().slice(0, 10),
    ymd: d.toISOString().slice(0, 10).replace(/-/g, ''),
    hhmm: d.getUTCHours() * 60 + d.getUTCMinutes()
  };
}

/* ------------------------------- 采集 ------------------------------- */

function fmtSeal(v) {
  if (!Number.isFinite(+v) || +v <= 0) return null;
  const s = String(Math.round(+v)).padStart(6, '0');
  return s.slice(0, 2) + ':' + s.slice(2, 4) + ':' + s.slice(4, 6);
}

/** 封板时刻转为「距 09:30 的分钟数」，集合竞价（09:15–09:25）统一记 0 */
function sealMinute(v) {
  if (!Number.isFinite(+v) || +v <= 0) return null;
  const s = String(Math.round(+v)).padStart(6, '0');
  const m = +s.slice(0, 2) * 60 + +s.slice(2, 4);
  return Math.max(0, m - 570);
}

async function fetchPool(url, ymd, pageSize = 400) {
  const u = url + '?ut=' + UT + '&dpt=wz.ztzt&Pageindex=0&pagesize=' + pageSize +
    '&sort=fbt%3Aasc&date=' + ymd + '&_=' + Date.now();
  const res = await fetch(u, {
    headers: {
      'User-Agent': UA, 'Accept': '*/*',
      'Referer': 'https://quote.eastmoney.com/ztb/detail'
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const d = j && j.data;
  return {
    tc: (d && d.tc) || 0,
    qdate: (d && d.qdate) || +ymd,
    pool: (d && Array.isArray(d.pool)) ? d.pool : []
  };
}

/** 涨停池字段归一化：p/ztp 单位是「厘」，需 /1000；fund/ltsz 单位为元 */
function normZT(x) {
  const floatCap = finite(x.ltsz);
  const fund = finite(x.fund);
  return {
    code: String(x.c || ''),
    name: String(x.n || ''),
    price: finite(x.p) === null ? null : finite(x.p) / 1000,
    pct: finite(x.zdp),
    amount: finite(x.amount),
    floatCap,
    turnover: finite(x.hs),
    boards: finite(x.lbc) || 1,
    firstSeal: finite(x.fbt),
    firstSealLabel: fmtSeal(x.fbt),
    firstSealMin: sealMinute(x.fbt),
    lastSeal: finite(x.lbt),
    lastSealLabel: fmtSeal(x.lbt),
    sealFund: fund,
    sealRatio: floatCap && fund ? round((fund / floatCap) * 100, 2) : null,
    breakCount: finite(x.zbc) || 0,
    industry: String(x.hybk || '未分类'),
    statDays: x.zttj ? finite(x.zttj.days) : null,
    statBoards: x.zttj ? finite(x.zttj.ct) : null
  };
}

function normZB(x) {
  const ztp = finite(x.ztp);
  const price = finite(x.p);
  return {
    code: String(x.c || ''),
    name: String(x.n || ''),
    price: price === null ? null : price / 1000,
    limitPrice: ztp === null ? null : ztp / 1000,
    pct: finite(x.zdp),
    amount: finite(x.amount),
    floatCap: finite(x.ltsz),
    turnover: finite(x.hs),
    firstSeal: finite(x.fbt),
    firstSealLabel: fmtSeal(x.fbt),
    firstSealMin: sealMinute(x.fbt),
    breakCount: finite(x.zbc) || 0,
    amplitude: finite(x.zf),
    boards: x.zttj ? (finite(x.zttj.ct) || 0) : 0,
    statDays: x.zttj ? finite(x.zttj.days) : null,
    industry: String(x.hybk || '未分类'),
    // 收盘价距涨停价的差距（%），越大说明尾盘越弱
    failDepth: (price !== null && ztp !== null && ztp > 0)
      ? round(((ztp - price) / ztp) * 100, 2) : null
  };
}

/**
 * 拉取当日三个池：涨停池 / 炸板池 / 跌停池。
 * 跌停池接口只稳定返回 tc 计数（pool 常为空），因此跌停以计数为主。
 */
async function fetchPools(opts = {}) {
  const bj = beijingDate();
  const ymd = opts.date || bj.ymd;
  const out = { date: ymd, zt: [], zb: [], dt: [], dtCount: 0, ok: false, warnings: [] };

  const tasks = [
    ['zt', ZT_URL],
    ['zb', ZB_URL],
    ['dt', DT_URL]
  ];
  for (const [key, url] of tasks) {
    try {
      const r = await fetchPool(url, ymd);
      if (key === 'dt') { out.dtCount = r.tc || r.pool.length; out.dt = r.pool.map(normZB); }
      else out[key] = r.pool.map(key === 'zt' ? normZT : normZB);
    } catch (e) {
      out.warnings.push((key === 'zt' ? '涨停池' : key === 'zb' ? '炸板池' : '跌停池') + '：' + e.message);
    }
    await new Promise(r => setTimeout(r, 120));
  }
  out.ok = out.zt.length > 0;
  return out;
}

/* ------------------------------- 历史与晋级率 ------------------------------- */

function loadHistory() {
  try {
    if (fs.existsSync(HIST_FILE)) {
      const o = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8'));
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    }
  } catch (_) { /* 忽略损坏的历史 */ }
  return {};
}

function saveHistory(date, codes) {
  try {
    const h = loadHistory();
    h[date] = Array.from(new Set(codes));
    const keys = Object.keys(h).sort();
    while (keys.length > MAX_HIST_DAYS) delete h[keys.shift()];
    fs.writeFileSync(HIST_FILE, JSON.stringify(h), 'utf8');
  } catch (e) { console.warn('[limitup] 历史写入失败:', e.message); }
}

/** 昨日（上一记录日）涨停股今日的晋级情况 */
function advancement(date, todaySet) {
  const h = loadHistory();
  const prevKeys = Object.keys(h).filter(k => k < date).sort();
  if (!prevKeys.length) return { prevDate: null, prevCount: 0, promoted: 0, rate: null };
  const prevDate = prevKeys[prevKeys.length - 1];
  const prev = h[prevDate] || [];
  if (!prev.length) return { prevDate, prevCount: 0, promoted: 0, rate: null };
  const promoted = prev.filter(c => todaySet.has(c)).length;
  return {
    prevDate, prevCount: prev.length, promoted,
    rate: round(promoted / prev.length, 3)
  };
}

/* ------------------------------- 板型识别 ------------------------------- */

/**
 * 用当日日线 OHLC 判定涨停板形态。
 * 涨停时收盘价即涨停价，因此与 close 比较即可，无需反推板块涨跌幅上限。
 * @returns {key,label,fillable,note}
 */
function boardTypeOf(bar, limitPrice) {
  if (!bar) return { key: 'unknown', label: '—', fillable: null, note: '' };
  const c = limitPrice || bar.close;
  const eps = Math.max(0.011, c * 0.0012); // 一分钱与千分之一取大，兼容高价股
  const atLimit = Math.abs(bar.close - c) <= eps;
  if (!atLimit) {
    const near = bar.high >= c - eps;
    return near
      ? { key: 'fail', label: '炸板未回封', fillable: '高', note: '盘中触及涨停但收盘未封住，封单已被消化' }
      : { key: 'none', label: '未涨停', fillable: null, note: '' };
  }
  const openAtLimit = Math.abs(bar.open - c) <= eps;
  const lowAtLimit = bar.low >= c - eps;
  if (openAtLimit && lowAtLimit) {
    return {
      key: 'oneWord', label: '一字板', fillable: '低',
      note: '全天无低于涨停价的成交，启动期基本无法买入（全样本连板率约 61%，但 31% 一字板不可成交）'
    };
  }
  if (openAtLimit && !lowAtLimit) {
    return {
      key: 'tShape', label: 'T 字板', fillable: '中高',
      note: '开盘即涨停、盘中开板后回封，经过一次筹码换手（全样本连板率约 36%）'
    };
  }
  const bodyPct = Math.abs(bar.close - bar.open) / Math.max(bar.open, 1e-6);
  if (bodyPct < 0.005) {
    return { key: 'tShape', label: '准一字板', fillable: '中', note: '开盘价与收盘价几乎相同，盘中仅小幅开板' };
  }
  return {
    key: 'turnover', label: '换手板', fillable: '高',
    note: '盘中拉升封板，筹码充分换手（全样本首板次日连板率约 12%，是最需要区分强弱的一类）'
  };
}

/* ------------------------------- K 线形态 ------------------------------- */

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function hhv(a, n) { return Math.max(...a.slice(-n)); }
function llv(a, n) { return Math.min(...a.slice(-n)); }

/**
 * qlib Alpha158 的 9 个 Kbar 微结构因子（单根 K 线内的多空结构，无窗口参数）。
 * 全部用最新一根（或指定 index）计算，均为无量纲比值，可跨股票横截面比较。
 */
function kbarFactors(bars) {
  const n = bars.length;
  if (n < 2) return null;
  const b = bars[n - 1], p = bars[n - 2];
  // 一字板 high == low（振幅为 0），若用极小值兜底会让比值爆炸。
  // 以收盘价的 0.2% 作为振幅下界：既保住比值语义，又让一字板的影线类因子归零。
  const rng = Math.max(b.high - b.low, b.close * 0.002);
  const oc = Math.max(b.open, b.close), ol = Math.min(b.open, b.close);
  return {
    kmid: round((b.close - b.open) / b.open, 5),          // 实体中点偏移：正=阳线
    klen: round((b.high - b.low) / b.open, 5),            // 振幅
    kmid2: round(clamp((b.close - b.open) / rng, -1, 1), 4),   // 收盘在当日区间的位置（1=极强收盘）
    kup: round((b.high - oc) / b.open, 5),                // 上影线占开盘价
    kup2: round(clamp((b.high - oc) / rng, 0, 1), 4),     // 上影线占振幅
    klow: round((ol - b.low) / b.open, 5),                // 下影线占开盘价
    klow2: round(clamp((ol - b.low) / rng, 0, 1), 4),     // 下影线占振幅
    ksft: round((b.open - p.close) / p.close, 5),         // 跳空幅度（开盘相对昨收）
    ksft2: round(clamp((b.open - p.close) / rng, -5, 5), 4) // 跳空占振幅（一字板放宽到 ±5）
  };
}

/**
 * 形态识别：只收录「有实证依据或经典定义明确」的形态，且每条带方向与强度。
 * 强度单位约定为「分」，最终由 patternScore 换算到 0–100。
 */
function detectPatterns(bars) {
  const n = bars.length;
  if (n < 25) return null;
  const b = bars[n - 1], p1 = bars[n - 2], p2 = bars[n - 3];
  const closes = bars.map(x => x.close);
  const vols = bars.map(x => x.volume);
  const ma5 = mean(closes.slice(-5));
  const ma10 = mean(closes.slice(-10));
  const ma20 = mean(closes.slice(-20));
  const vMa5 = mean(vols.slice(-6, -1));
  const vMa10 = mean(vols.slice(-11, -1));
  const k = kbarFactors(bars);
  const flags = [];
  const add = (key, label, side, strength, note) => flags.push({ key, label, side, strength, note });

  const rng = Math.max(b.high - b.low, 1e-9);
  const body = Math.abs(b.close - b.open);
  const hh20 = hhv(bars.map(x => x.high), 21); // 含今日，取前 20 日基线时用 slice
  const hh20Prev = hhv(bars.slice(0, -1).map(x => x.high), 20);
  const ll20Prev = llv(bars.slice(0, -1).map(x => x.low), 20);
  const hh60 = hhv(bars.map(x => x.high), 60);
  const ll60 = llv(bars.map(x => x.low), 60);
  const position60 = hh60 > ll60 ? round(((b.close - ll60) / (hh60 - ll60)) * 100, 1) : 50;

  // ---- A. 涨停后的接力 / 失败形态（A 股特有，权重最高） ----
  const lastLimitIdx = (() => {
    for (let i = n - 1; i >= Math.max(0, n - 11); i--) if ((bars[i].pct || 0) >= 9.5) return i;
    return -1;
  })();
  const lastLimit = lastLimitIdx >= 0 ? bars[lastLimitIdx] : null;

  // BBC：涨停次日跳空高开却收大阴（AlphaSpike 的 Big Bearish Candle）→ 接力失败
  const gapUpBigBear = p1 && (p1.pct || 0) >= 9.5 && b.open > p1.close * 1.001 &&
    b.close < b.open && (b.open - b.close) / rng >= 0.45;
  if (gapUpBigBear) add('bbc', '涨停后高开大阴', 'bear', -13, '前一交易日涨停，今日跳空高开后收长阴，封单被反手砸掉，典型接力失败');

  // 由强转弱：连续涨停后跳空走弱
  const streakBefore = (() => {
    let c = 0;
    for (let i = n - 1; i >= 0; i--) { if ((bars[i].pct || 0) >= 9.5) c++; else break; }
    return c;
  })();
  if (streakBefore >= 2 && b.open < p1.close && b.close < p1.open) {
    add('weakToStrong', '连板后跳空走弱', 'bear', -10, '连续 ' + streakBefore + ' 板后今日低开低走，接力资金离场');
  }

  // 单阳不破：涨停后回调不破涨停日开盘价
  if (lastLimit && lastLimitIdx < n - 1 && lastLimitIdx >= n - 9) {
    const after = bars.slice(lastLimitIdx + 1);
    if (after.length && Math.min(...after.map(x => x.low)) >= lastLimit.open * 0.995) {
      add('singleYangHold', '单阳不破', 'bull', 7,
        '涨停后 ' + after.length + ' 日回调未跌破涨停日开盘价 ' + lastLimit.open.toFixed(2) + '，主力未离场');
    }
    // 缩量回调：量能缩至涨停日 50% 以下
    const shrink = after.length && after.every(x => x.volume < lastLimit.volume * 0.7);
    if (shrink && b.close > lastLimit.open) {
      add('shrinkPullback', '涨停后缩量回调', 'bull', 6, '涨停后量能持续萎缩至 50%~70%，抛压衰减');
    }
  }

  // ---- B. 单根/双根经典形态 ----
  if (k.kup2 >= 0.45 && b.volume > vMa10 * 1.2 && b.close > ma10) {
    add('volUpperShadow', '放量长上影', 'bear', -7,
      '上影线占振幅 ' + Math.round(k.kup2 * 100) + '% 且放量，上方抛压明显');
  }
  if (b.volume > vMa10 * 1.5 && Math.abs(b.pct || 0) < 2 && Math.abs(p1.pct || 0) < 2.5) {
    add('volStagnation', '放量滞涨', 'bear', -6, '成交显著放大但价格不涨，资金承接乏力');
  }
  if (b.high >= hh20Prev * 0.995 && k.kmid2 < 0 && b.high > b.close * 1.02) {
    add('highRetrace', '冲高回落', 'bear', -6,
      '触及 20 日高点 ' + hh20Prev.toFixed(2) + ' 后回落，长上影 ' + Math.round(k.kup2 * 100) + '%');
  }
  if (k.klow2 >= 0.5 && k.kmid2 > -0.15 && b.close > ma20) {
    add('longLowerShadow', '长下影承接', 'bull', 5, '下影线占振幅 ' + Math.round(k.klow2 * 100) + '%，低位有买盘承接');
  }
  if (Math.abs(k.kmid2) < 0.12 && k.klen > 0.02) {
    add('doji', '十字星', 'neutral', 0, '多空均衡，方向待选择');
  }
  // 看涨/看跌吞没
  const bullEngulf = p1.close < p1.open && b.close > b.open &&
    b.close >= p1.open && b.open <= p1.close && body > Math.abs(p1.close - p1.open);
  const bearEngulf = p1.close > p1.open && b.close < b.open &&
    b.close <= p1.open && b.open >= p1.close && body > Math.abs(p1.close - p1.open);
  if (bullEngulf) add('bullEngulf', '看涨吞没', 'bull', 6, '今日阳线完全吞没前一日阴线实体');
  if (bearEngulf) add('bearEngulf', '看跌吞没', 'bear', -6, '今日阴线完全吞没前一日阳线实体');

  // ---- C. 突破与量价配合 ----
  const hh10Prev = hhv(bars.slice(0, -1).map(x => x.high), 10);
  const ll10Prev = llv(bars.slice(0, -1).map(x => x.low), 10);
  const tight = hh10Prev > 0 && (hh10Prev - ll10Prev) / hh10Prev < 0.09;
  if (tight && b.volume > vMa10 * 1.5 && b.close > hh10Prev) {
    add('consolidationBreak', '缩量整固后放量突破', 'bull', 11,
      '前 10 日振幅收窄至 ' + round(((hh10Prev - ll10Prev) / hh10Prev) * 100, 1) + '% 后放量突破 10 日高点 ' + hh10Prev.toFixed(2));
  }
  const doubleVolYang = b.volume >= vMa5 * 2 && (b.pct || 0) >= 1 && (b.pct || 0) <= 7 && b.close > b.open;
  if (doubleVolYang) add('doubleVolumeYang', '倍量阳线', 'bull', 5,
    '成交量放大至 5 日均量 ' + round(b.volume / Math.max(vMa5, 1), 1) + ' 倍且收阳（主力显性进场）');

  // 多方炮：day0 强阳 + 1~3 日小实体整理不破 day0 开盘 + 今日创新高
  for (let back = 2; back <= 4; back++) {
    const d0 = bars[n - 1 - back];
    if (!d0 || (d0.pct || 0) < 7) continue;
    const mid = bars.slice(n - back, n - 1);
    const holds = mid.every(x => x.close >= d0.open * 0.99);
    const smallBodies = mid.every(x => Math.abs(x.close - x.open) / Math.max(x.open, 1) < 0.05);
    if (holds && smallBodies && b.close > Math.max(...mid.map(x => x.high))) {
      add('bullishCannon', '多方炮', 'bull', 9,
        '强阳（+' + d0.pct.toFixed(1) + '%）后 ' + mid.length + ' 日缩量整理不破其开盘价，今日突破整理高点');
      break;
    }
  }

  // ---- D. 缺口 ----
  let gap = null;
  for (let i = n - 1; i >= Math.max(1, n - 6); i--) {
    const x = bars[i], y = bars[i - 1];
    if (x.low > y.high * 1.002) { gap = { dir: 'up', date: x.date, from: y.high, to: x.low, idx: i }; break; }
    if (x.high < y.low * 0.998) { gap = { dir: 'down', date: x.date, from: y.low, to: x.high, idx: i }; break; }
  }
  if (gap) {
    const after = bars.slice(gap.idx + 1);
    gap.filled = gap.dir === 'up'
      ? after.some(x => x.low <= gap.from)
      : after.some(x => x.high >= gap.from);
    gap.days = after.length;
    if (gap.dir === 'up' && !gap.filled && gap.days <= 5) {
      add('gapUpOpen', '向上跳空未回补', 'bull', 4,
        gap.date + ' 跳空缺口 ' + gap.from.toFixed(2) + '–' + gap.to.toFixed(2) + '，' + gap.days + ' 日未回补（支撑有效）');
    }
    if (gap.dir === 'down' && !gap.filled && gap.days <= 3) {
      add('gapDownOpen', '向下跳空未回补', 'bear', -5,
        gap.date + ' 向下跳空缺口未回补，上方形成压力');
    }
  }

  const bull = flags.filter(f => f.side === 'bull').reduce((s, f) => s + f.strength, 0);
  const bear = flags.filter(f => f.side === 'bear').reduce((s, f) => s + Math.abs(f.strength), 0);
  const patternScore = clamp(50 + (bull - bear) * 2.2, 0, 100);

  return {
    kbar: k,
    flags: flags.filter(f => f.strength !== 0),
    labels: flags.map(f => f.label),
    bullScore: bull, bearScore: bear,
    patternScore: Math.round(patternScore),
    position60,
    lastLimit: lastLimit ? {
      date: lastLimit.date, boards: streakBefore, open: lastLimit.open,
      daysAgo: n - 1 - lastLimitIdx
    } : null,
    gap: gap ? {
      dir: gap.dir, date: gap.date, from: round(gap.from, 2), to: round(gap.to, 2),
      filled: gap.filled, days: gap.days
    } : null,
    ma: { ma5: round(ma5, 2), ma10: round(ma10, 2), ma20: round(ma20, 2) }
  };
}

/* ------------------------------- 情绪周期 ------------------------------- */

const CYCLE_FACTOR = { 冰点: 0.62, 退潮: 0.58, 修复: 0.85, 启动: 1.0, 主升: 1.15, 高潮: 0.9 };

/**
 * 市场情绪周期（参考 shy3130/tick-stock-panel 的六阶段：冰点/启动/主升/高潮/退潮/修复，
 * 以连板梯队驱动）。本实现只依赖三池计数与晋级率，不引入平滑状态机——
 * quantskills 的 ablation 显示连板状态机反而让胜率下降。
 */
function buildSentiment(pools, opts = {}) {
  const ztList = pools.zt || [];
  const ztCount = ztList.length;
  const dtCount = pools.dtCount || 0;
  const zbCount = (pools.zb || []).length;
  const zbRate = (ztCount + zbCount) > 0 ? zbCount / (ztCount + zbCount) : 0;
  const ladder = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let maxBoards = 0;
  for (const x of ztList) {
    const b = x.boards || 1;
    maxBoards = Math.max(maxBoards, b);
    if (b >= 5) ladder[5]++; else ladder[b] = (ladder[b] || 0) + 1;
  }
  // 题材共振：同行业涨停家数
  const industryCount = new Map();
  for (const x of ztList) industryCount.set(x.industry, (industryCount.get(x.industry) || 0) + 1);
  const hotIndustries = Array.from(industryCount.entries())
    .filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([name, count]) => ({ name, count }));

  const todaySet = new Set(ztList.map(x => x.code));
  const adv = advancement(pools.date, todaySet);
  saveHistory(pools.date, Array.from(todaySet));

  // 情绪周期判定：跌停远多于涨停是冰点的硬条件（涨停家数单一指标会误判）
  let stage;
  if (dtCount >= ztCount * 1.5 && ztCount < 45) stage = '冰点';
  else if (zbRate >= 0.45 && ztCount < 55) stage = '退潮';
  else if (ztCount >= 70 && zbRate <= 0.3 && maxBoards >= 5) stage = '高潮';
  else if (ztCount >= 45 && maxBoards >= 4) stage = '主升';
  else if (adv.rate !== null && adv.rate >= 0.28) stage = '启动';
  else if (ztCount >= 28) stage = '修复';
  else stage = '冰点';

  const factor = opts.cycleEnabled === false ? 1 : (CYCLE_FACTOR[stage] || 0.8);

  const notes = [];
  notes.push('涨停 ' + ztCount + ' 家 / 跌停 ' + dtCount + ' 家，炸板 ' + zbCount + ' 家（炸板率 ' +
    Math.round(zbRate * 100) + '%）');
  notes.push('连板梯队 ' + [1, 2, 3, 4, 5].map(k => k === 5 ? '5+:' + ladder[5] : k + '板:' + ladder[k]).join(' / ') +
    '，最高 ' + (maxBoards || 0) + ' 板');
  if (adv.rate !== null) notes.push('昨日 ' + adv.prevCount + ' 家涨停今日晋级 ' + adv.promoted +
    ' 家（晋级率 ' + Math.round(adv.rate * 100) + '%）');
  else notes.push('晋级率需至少两个交易日的记录，当前累积中');
  if (hotIndustries.length) notes.push('涨停集中行业：' + hotIndustries.slice(0, 3).map(x => x.name + '(' + x.count + ')').join('、'));

  return {
    stage, factor,
    ztCount, dtCount, zbCount,
    zbRate: round(zbRate * 100, 1),
    ladder, maxBoards,
    advancement: adv,
    hotIndustries,
    industryCount: Array.from(industryCount.entries()).map(([name, count]) => ({ name, count })),
    notes,
    date: pools.date
  };
}

/* ------------------------------- 涨停结构评分 ------------------------------- */

/**
 * 涨停结构评分：以全市场基线（次日连板率 ≈20%、对应 50 分）为原点，
 * 按实证超额（pp）赋值。正负两侧都给，避免「涨停即高分」的偏差。
 */
function scoreStructure(p) {
  const parts = [];
  const add = (label, v, note) => { if (v !== 0) parts.push({ label, value: v, note }); };

  // 板型（按全样本次日连板率相对 20% 基线的超额映射：一字 +41pp→+26、T字 +16pp→+12、
  // 回封/分歧 +10pp→+7、换手 -2pp→0、炸板未回封 明显为负→-18）
  const bt = { oneWord: 26, tShape: 12, reseal: 7, turnover: 0, fail: -18, none: 0, unknown: 0 }[p.board.key] || 0;
  add('板型', bt, p.board.label + '（全样本次日连板率：一字 61% / T字 36% / 回封分歧 30% / 换手 18% / 炸板未回封更低）');

  // 封板时间
  const sm = p.firstSealMin;
  let st = 0;
  if (sm !== null && p.board.key !== 'fail') {
    st = sm <= 5 ? 16 : sm <= 60 ? 6 : sm <= 270 ? -4 : sm <= 300 ? -10 : -14;
    add('封板时间', st, p.firstSealLabel + ' 封板' + (sm <= 5 ? '（集合竞价/开盘即封，最强）' : sm <= 60 ? '（早盘封板）' : sm <= 270 ? '（午后封板）' : '（尾盘偷袭，承接力弱）'));
  }

  // 封单厚度
  let sr = 0;
  if (p.sealRatio !== null && p.board.key !== 'fail') {
    sr = p.sealRatio > 2 ? 16 : p.sealRatio > 1 ? 8 : p.sealRatio > 0.5 ? 1 : -6;
    add('封单厚度', sr, '封单占流通市值 ' + p.sealRatio + '%（厚 >2% 连板率 38% / 薄 ≤2% 18%）');
  }

  // 连板高度：首板偏弱但空间大，3 板以上均值回归（quantskills: ≥3 板次日 -1.18%~-4.31%）
  let bb = 0;
  if (p.board.key !== 'fail') {
    const b = p.boards || 1;
    bb = b === 1 ? -4 : b === 2 ? 9 : b === 3 ? 6 : b === 4 ? 2 : -8;
    add('连板高度', bb, b === 1 ? '首板（次日连板率约 16%，低于基线，但上行空间最大）'
      : b >= 5 ? b + ' 板（高位博弈，缺口与核按钮风险显著）'
        : b + ' 板（连续板晋级率约 39%，但 3 板起次日收益均值回归）');
  }

  // 炸板次数
  let zb = 0;
  if (p.breakCount > 0) {
    zb = p.breakCount <= 2 ? -4 : p.breakCount <= 5 ? -9 : -15;
    add('盘中开板', zb, '盘中开板 ' + p.breakCount + ' 次' + (p.breakCount > 5 ? '（反复开板，封单极不稳定）' : ''));
  }

  // 60 日位置（quantskills position_60d 权重 -0.09）
  let pos = 0;
  if (p.position60 !== null) {
    pos = p.position60 >= 90 ? -9 : p.position60 >= 75 ? -5 : p.position60 <= 30 ? 3 : 0;
    if (pos) add('60 日位置', pos, '处于 60 日区间 ' + p.position60 + '% 分位' + (pos < 0 ? '（高位，追高风险）' : '（低位启动）'));
  }

  // 题材共振
  let ind = 0;
  if (p.industryZt >= 6) { ind = 8; add('题材共振', ind, '同行业（' + p.industry + '）当日 ' + p.industryZt + ' 家涨停，板块效应显著'); }
  else if (p.industryZt >= 3) { ind = 5; add('题材共振', ind, '同行业（' + p.industry + '）当日 ' + p.industryZt + ' 家涨停'); }

  const raw = 50 + parts.reduce((s, x) => s + x.value, 0);
  return { score: Math.round(clamp(raw, 0, 100)), parts };
}

/**
 * 单只个股的涨停结构分析。
 * @param {object} base  { code, name, industry, floatCap }
 * @param {object} bar    当日日线 { open, high, low, close, pct, volume }
 * @param {object} pools  { zt: Map, zb: Map, sentiment }
 * @param {object} pattern detectPatterns 结果（用于 60 日位置）
 */
function analyzeLimit(base, bar, pools, pattern, opts = {}) {
  const maxAdjust = clamp(Number(opts.maxAdjust) || 12, 0, 20);
  const code = String(base.code || '');
  const zt = pools && pools.zt ? pools.zt.get(code) : null;
  const zb = pools && pools.zb ? pools.zb.get(code) : null;
  if (!zt && !zb) {
    return {
      active: false, isLimitUp: false, isFailed: false,
      adjust: 0, score: null, board: { key: 'none', label: '未涨停', fillable: null, note: '' },
      parts: [], chaseRisk: 0, note: '当日未涨停，未触发涨停结构因子'
    };
  }
  const source = zt || zb;
  // 涨停价：涨停池的 price 即收盘价（=涨停价）；炸板池单独给 ztp
  const limitPrice = zt ? (zt.price || null) : (zb.limitPrice || null);
  const eps = limitPrice ? Math.max(0.011, limitPrice * 0.0012) : 0;
  // 关键：是否「收盘涨停」应由收盘价与涨停价的比较决定，而不是「在哪个池」。
  // 炸板池里存在「盘中炸板、尾盘回封」的标的（分歧板），其次日连板率约 29.7%，
  // 显著优于缩量换手板（17.6%），不能与「炸板未回封」混为一谈。
  const closeAtLimit = !!(bar && limitPrice && Math.abs(bar.close - limitPrice) <= eps);
  const isLimitUp = !!zt || closeAtLimit;
  let board = boardTypeOf(bar, limitPrice);
  if (zb && closeAtLimit && board.key !== 'oneWord') {
    board = {
      key: 'reseal', label: '回封板', fillable: '中高',
      note: '盘中炸板后收盘回封（分歧板），次日连板率约 29.7%，优于缩量换手板；但反复开板说明筹码不稳'
    };
  }
  const boards = zt ? (zt.boards || 1) : (zb.boards || (closeAtLimit ? 1 : 0));
  const industryZt = pools.sentiment && pools.sentiment.industryCount
    ? (pools.sentiment.industryCount.find(x => x.name === source.industry) || {}).count || 0
    : 0;

  const prof = {
    code, name: base.name, industry: source.industry,
    boards,
    firstSealLabel: source.firstSealLabel,
    firstSealMin: source.firstSealMin,
    sealRatio: isLimitUp ? (zt ? zt.sealRatio : null) : null,
    sealFund: isLimitUp ? (zt ? zt.sealFund : null) : null,
    breakCount: source.breakCount || 0,
    board,
    position60: pattern ? pattern.position60 : null,
    industryZt,
    isLimitUp, isFailed: !isLimitUp
  };

  const s = scoreStructure(prof);
  const cycleFactor = (pools.sentiment && pools.sentiment.factor) || 1;
  // 情绪周期对正向与负向不对称：
  //   弱势环境（冰点/退潮）里「涨停溢价」整体缩水 → 正偏离打折；
  //   但「烂板/炸板」的惩罚不该跟着缩水，否则退潮期反而美化差标的 → 负偏离至少 ×1.05 放大。
  const dev0 = s.score - 50;
  const asym = dev0 >= 0 ? cycleFactor : Math.max(cycleFactor, 1.05);
  const adjust = round(clamp((dev0 * asym / 50) * maxAdjust, -maxAdjust, maxAdjust), 1);

  // 可成交性折扣：一字板买不到 → 信号价值打折（不是归零，可排板/次日接力）
  const fillFactor = board.key === 'oneWord' ? 0.85 : board.key === 'fail' ? 0.7 : 1;
  const finalAdjust = round(adjust * fillFactor, 1);

  // 追高风险：高位 + 高板 + 反复开板 + 一字（买不进却容易砸）
  const chaseRisk = Math.round(clamp(
    (prof.boards >= 5 ? 38 : prof.boards === 4 ? 28 : prof.boards === 3 ? 18 : 0) +
    (prof.position60 !== null && prof.position60 >= 90 ? 26 : prof.position60 !== null && prof.position60 >= 75 ? 14 : 0) +
    (prof.breakCount > 5 ? 20 : prof.breakCount > 2 ? 10 : 0) +
    (board.key === 'oneWord' ? 14 : 0) +
    (isLimitUp ? 0 : 16) + (zt && zt.boards >= 3 ? 10 : 0), 0, 100));

  const reasons = s.parts.slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 4).map(x => x.label + ' ' + (x.value > 0 ? '+' : '') + x.value);

  const noteBits = [];
  noteBits.push(board.label + (prof.boards ? ' · ' + prof.boards + ' 板' : ''));
  if (prof.firstSealLabel) noteBits.push(prof.firstSealLabel + ' 封板');
  if (prof.sealRatio !== null) noteBits.push('封单 ' + prof.sealRatio + '% 流通市值');
  if (prof.breakCount) noteBits.push('开板 ' + prof.breakCount + ' 次');
  noteBits.push('结构分 ' + s.score + '/100 → 修正 ' + (finalAdjust > 0 ? '+' : '') + finalAdjust);

  return {
    active: true,
    isLimitUp, isFailed: !isLimitUp,
    date: pools.date,
    board,
    boards: prof.boards,
    statLabel: (source.statDays && source.statBoards) ? source.statDays + ' 天 ' + source.statBoards + ' 板'
      : (prof.boards ? prof.boards + ' 板' : null),
    firstSealLabel: prof.firstSealLabel,
    lastSealLabel: source.lastSealLabel,
    sealRatio: prof.sealRatio,
    sealFundYi: prof.sealFund ? round(prof.sealFund / 1e8, 2) : null,
    breakCount: prof.breakCount,
    failDepth: !isLimitUp ? (zb.failDepth || null) : null,
    industry: prof.industry,
    industryZt,
    position60: prof.position60,
    score: s.score,
    parts: s.parts,
    cycleStage: pools.sentiment ? pools.sentiment.stage : null,
    cycleFactor: round(cycleFactor, 2),
    fillFactor: round(fillFactor, 2),
    fillable: board.fillable,
    adjust: finalAdjust,
    rawAdjust: adjust,
    chaseRisk,
    reasons,
    note: noteBits.join(' · ')
  };
}

/* ------------------------------- 视图与缓存 ------------------------------- */

function buildView(pools, opts = {}) {
  const sentiment = buildSentiment(pools, opts);
  const ztMap = new Map(pools.zt.map(x => [x.code, x]));
  const zbMap = new Map(pools.zb.map(x => [x.code, x]));
  const sorted = pools.zt.slice().sort((a, b) => (b.boards - a.boards) || (b.sealRatio || 0) - (a.sealRatio || 0));
  return {
    ok: !!pools.ok,
    date: pools.date,
    fetchedAt: Date.now(),
    sentiment,
    counts: {
      limitUp: pools.zt.length, failed: pools.zb.length, limitDown: pools.dtCount || 0,
      resealed: pools.zb.filter(x => x.failDepth !== null && x.failDepth <= 0.15).length
    },
    ladder: sorted.slice(0, 20).map(x => ({
      code: x.code, name: x.name, boards: x.boards,
      statLabel: x.statDays && x.statBoards ? x.statDays + ' 天 ' + x.statBoards + ' 板' : x.boards + ' 板',
      industry: x.industry, firstSealLabel: x.firstSealLabel,
      sealRatio: x.sealRatio, sealFundYi: x.sealFund ? round(x.sealFund / 1e8, 2) : null,
      breakCount: x.breakCount, turnover: x.turnover === null ? null : round(x.turnover, 2)
    })),
    failed: pools.zb.slice().sort((a, b) => (b.breakCount || 0) - (a.breakCount || 0)).slice(0, 12).map(x => ({
      code: x.code, name: x.name, industry: x.industry,
      pct: x.pct, failDepth: x.failDepth, breakCount: x.breakCount,
      // 距涨停价 0.15% 以内视为尾盘回封（分歧板），与真正的「炸板未回封」区别对待
      resealed: x.failDepth !== null && x.failDepth <= 0.15,
      firstSealLabel: x.firstSealLabel, turnover: x.turnover
    })),
    methods: {
      board: '板型由当日 OHLC 与涨停价比较判定：一字板（最低价=涨停价）、T 字板（开盘即涨停、盘中开板后回封）、换手板（盘中拉升封板）、炸板未回封（触及但收盘未封住）。',
      empirical: '全样本次日连板率基线约 20%；一字板 61%、T 字板 36%、换手板 18%；早封（≤09:35）37%、尾盘 15%；封单 >2% 流通市值 38%、≤2% 18%；连续板 39%、首板 16%。换手率与主力资金流对连板率无增量信息，故未纳入涨停强度因子。',
      score: '结构分以 50 为基线，按上述超额赋值：板型（一字+26 / T字+12 / 换手 0 / 炸板-18）、封板时间（开盘+16 / 早盘+6 / 午后-4 / 尾盘-14）、封单（>2% +16 / >1% +8 / <0.5% -6）、连板（首板-4 / 2板+9 / 3板+6 / ≥5板-8）、开板次数（-4/-9/-15）、60 日位置（≥90% 分位-9）、题材共振（≥6 家+8）。再乘情绪周期系数与可成交性折扣，映射到 ±12 分修正。',
      cycle: '情绪周期六阶段（冰点/退潮/修复/启动/主升/高潮）：跌停数≥涨停数 1.5 倍判冰点；炸板率≥45% 且涨停<55 家判退潮；涨停≥70 家且炸板率≤30% 且最高板≥5 判高潮；晋级率≥28% 判启动。周期系数 0.42~1.15 作用于涨停强度偏离。',
      caution: '涨停结构是「强度」与「可成交性」两面。一字板连板率最高但约 31% 无法成交；≥3 板次日收益均值回归；炸板率高的退潮期整体失效。结构分不预测次日是否涨停。'
    }
  };
}

function readCache() {
  try {
    if (fs.existsSync(POOL_FILE)) {
      const o = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
      if (o && Array.isArray(o.zt)) return o;
    }
  } catch (_) { /* 忽略 */ }
  return null;
}

function writeCache(pools) {
  try {
    const tmp = POOL_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(pools), 'utf8');
    fs.renameSync(tmp, POOL_FILE);
  } catch (e) { console.warn('[limitup] 缓存写入失败:', e.message); }
}

/** 供外部（stocks.js / server.js）使用的 Map 化上下文 */
function toContext(pools) {
  const sentiment = buildSentiment(pools);
  return {
    date: pools.date,
    ok: !!pools.ok,
    zt: new Map(pools.zt.map(x => [x.code, x])),
    zb: new Map(pools.zb.map(x => [x.code, x])),
    dtCount: pools.dtCount || 0,
    sentiment,
    signature: [pools.date, pools.zt.length, pools.zb.length, pools.dtCount || 0,
      sentiment.stage, sentiment.maxBoards, Math.round(sentiment.zbRate)].join('-')
  };
}

module.exports = {
  fetchPools, buildView, toContext, readCache, writeCache,
  detectPatterns, kbarFactors, boardTypeOf, analyzeLimit,
  buildSentiment, scoreStructure,
  CYCLE_FACTOR, POOL_FILE, HIST_FILE
};
