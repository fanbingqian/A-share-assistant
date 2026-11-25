'use strict';

/**
 * A 股大盘量能检测 + 市值风格（微盘 / 小盘 / 中盘 / 大盘）资金倾向模型。
 *
 * 【要回答的问题】
 *   1) 两市现在是放量还是缩量？量价是否配合？
 *   2) 增量资金正在向哪个市值层迁移？根据是什么？置信度多高？
 *   3) 这个结论如何作为一个可解释因子，进入当日观察池的个股评分？
 *
 * 【方法学出处（详见 README 第六节）】
 *   - 华泰金工《基于趋势和拐点的市值因子择时模型》(2025)：用「微盘/沪深300 成交额之比」
 *     在 10~60 日窗口取历史分位刻画大小盘资金迁移 → 本模块扩展为四层成交额占比的稳健 z-score。
 *   - Liu / Stambaugh / Yuan (2019)《Size and Value in China》CH-3/CH-4：A 股 SMB 需剔除
 *     最小 30% 壳价值污染，并引入换手率因子 PMO → 本模块对最小市值层加噪声明与拥挤度惩罚。
 *   - Jegadeesh & Titman (1993) / Carhart (1997) / Ehsani & Linnainmaa《Factor Momentum》：
 *     横截面相对强弱与风格动量 → 本模块用 5/20 日相对收益的多窗投票。
 *   - Gervais / Kaniel / Mingelgrin (2001)《The High-Volume Return Premium》与
 *     Amihud (2002)《Illiquidity and Stock Returns》：成交量与价格的配合、单位资金价格冲击
 *     → 本模块用「带符号的量价配合」与「份额-收益弹性」作为层级化工程近似（非严格 ILLIQ）。
 *   - 《Herding for profits: Market breadth…》(2020)：宽度用于确认普涨而非少数权重拉动；
 *     宽度 < 40% 时下调置信度。A 股高换手组合次月收益显著更低（2024 实证）→ 拥挤度反向惩罚。
 *   - microsoft/qlib 的 CSZScoreNorm / CSRankNorm、quantopian/alphalens 的分层一致性检验：
 *     横截面标准化 + 子信号方向一致性做置信度；权重固定、不做参数寻优以免过拟合。
 *
 * 【诚实边界】四个规模指数成分并非完全互斥、成交额口径与两市总额不同；60~70 根日线
 *   不足以估多年分位；全市场快照分页存在跨页时点差。故输出的是「横截面相对倾向 + 置信度」，
 *   不是资金流的因果测量，也不是涨跌预测。A 股 T+1、涨跌停、微盘壳价值与退市风险另行提示。
 */

const fs = require('node:fs');
const path = require('node:path');
const { UA } = require('./sources');

const EM_KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const EM_CLIST = 'https://push2.eastmoney.com/api/qt/clist/get';
const EM_ULIST = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
const UNIVERSE = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'market-style.json');
const BREADTH_FILE = path.join(__dirname, '..', 'data', 'market-breadth.json');

/** 流通市值分档（元）。四层代理指数互不重叠，合起来近似覆盖全 A 市值谱系。 */
const BUCKETS = [
  { key: 'micro', name: '微盘股', index: '中证2000', secid: '2.932000', min: 0, max: 5e9, capLabel: '< 50 亿' },
  { key: 'small', name: '小盘股', index: '中证1000', secid: '1.000852', min: 5e9, max: 1.5e10, capLabel: '50 – 150 亿' },
  { key: 'mid', name: '中盘股', index: '中证500', secid: '1.000905', min: 1.5e10, max: 5e10, capLabel: '150 – 500 亿' },
  { key: 'large', name: '大盘股', index: '沪深300', secid: '1.000300', min: 5e10, max: Infinity, capLabel: '> 500 亿' }
];
const MARKET_INDEX = [
  { key: 'sh', name: '上证指数', secid: '1.000001' },
  { key: 'sz', name: '深证成指', secid: '0.399001' }
];
const WEIGHTS = { share: 0.28, momentum: 0.26, volumePrice: 0.20, elasticity: 0.12, breadth: 0.14 };

let memCache = null;
let busy = null;

/* ------------------------------- 工具 ------------------------------- */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = (v, n = 1) => +Number(v).toFixed(n);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const variance = a => a.length ? mean(a.map(x => (x - mean(a)) ** 2)) : 0;

function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function crossZ(arr) {
  const m = mean(arr), sd = Math.sqrt(variance(arr));
  if (sd < 1e-9) return arr.map(() => 0);
  return arr.map(v => clamp((v - m) / sd, -2.5, 2.5));
}

/** 稳健时序 z-score：历史窗口先按中位数 ±3×MAD 去极值，避免单日异常量能主导 */
function robustZ(series) {
  if (series.length < 8) return 0;
  const cur = series[series.length - 1];
  const hist = series.slice(0, -1);
  const med = median(hist);
  const mad = median(hist.map(v => Math.abs(v - med))) * 1.4826;
  const scale = mad > 1e-9 ? mad : (Math.sqrt(variance(hist)) || 1e-9);
  const wins = hist.map(v => clamp(v, med - 3 * scale, med + 3 * scale));
  const m = mean(wins), sd = Math.sqrt(variance(wins));
  return clamp((cur - m) / Math.max(sd, scale * 0.5, 1e-9), -3, 3);
}

function corr(a, b) {
  const n = Math.min(a.length, b.length, 20);
  if (n < 8) return 0;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const u = x[i] - mx, v = y[i] - my; num += u * v; dx += u * u; dy += v * v; }
  return dx > 1e-12 && dy > 1e-12 ? clamp(num / Math.sqrt(dx * dy), -1, 1) : 0;
}

function pctRank(series, v) {
  if (!series.length) return 0.5;
  return series.filter(x => x <= v).length / series.length;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://quote.eastmoney.com/' },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function beijing() {
  const d = new Date(Date.now() + 8 * 3600000);
  return { date: d.toISOString().slice(0, 10), day: d.getUTCDay(), hhmm: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function isTradingNow(bj) {
  if (bj.day === 0 || bj.day === 6) return false;
  return (bj.hhmm >= 570 && bj.hhmm <= 690) || (bj.hhmm >= 780 && bj.hhmm <= 900);
}

function bucketOf(floatCap) {
  const c = Number(floatCap);
  if (!Number.isFinite(c) || c <= 0) return null;
  return BUCKETS.find(b => c >= b.min && c < b.max) || BUCKETS[BUCKETS.length - 1];
}

/* ------------------------------- 数据采集 ------------------------------- */

function beginDate() {
  const d = new Date(Date.now() - 250 * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function fetchDaily(secid) {
  const url = EM_KLINE + '?secid=' + secid + '&klt=101&fqt=1&beg=' + beginDate() +
    '&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
    '&_=' + Date.now();
  const j = await fetchJson(url);
  const d = j && j.data;
  if (!d || !Array.isArray(d.klines)) throw new Error('日线为空 ' + secid);
  const bars = [];
  for (const line of d.klines) {
    const p = String(line).split(',');
    const close = +p[2], amount = +p[6];
    if (!Number.isFinite(close) || !Number.isFinite(amount) || amount <= 0) continue;
    bars.push({
      date: p[0], close, amount,
      pct: Number.isFinite(+p[8]) ? +p[8] : 0,
      turnover: Number.isFinite(+p[10]) ? +p[10] : 0
    });
  }
  return bars.slice(-72);
}

async function fetchSnapshot() {
  const secids = BUCKETS.concat(MARKET_INDEX).map(x => x.secid).join(',');
  const j = await fetchJson(EM_ULIST + '?fltt=2&secids=' + secids +
    '&fields=f2,f3,f6,f12,f14&_=' + Date.now());
  const out = {};
  for (const r of ((j && j.data && j.data.diff) || [])) {
    out[String(r.f12)] = { price: +r.f2, pct: +r.f3, amount: +r.f6, name: r.f14 };
  }
  return out;
}

/** 全市场横截面：按流通市值分档统计涨跌家数、成交额与主力净流入（100 条/页，低频缓存） */
async function fetchBreadth(force, trading) {
  const ttl = (trading ? 20 : 180) * 60000;
  let stale = null;
  try {
    if (fs.existsSync(BREADTH_FILE)) stale = JSON.parse(fs.readFileSync(BREADTH_FILE, 'utf8'));
  } catch (_) { stale = null; }
  if (!force && stale && stale.agg && Date.now() - stale.generatedAt < ttl) {
    return { ...stale, fromCache: true };
  }
  try {
  const fields = 'f12,f3,f6,f21,f62';
  const pageUrl = pg => EM_CLIST + '?pn=' + pg + '&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=' +
    UNIVERSE + '&fields=' + fields + '&_=' + Date.now();
  const first = await fetchJson(EM_CLIST + '?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=' +
    UNIVERSE + '&fields=' + fields + '&_=' + Date.now());
  const total = (first && first.data && first.data.total) || 0;
  if (!total) throw new Error('全市场快照为空');
  const pages = Math.ceil(total / 100);
  const rows = [];
  const push = j => {
    for (const r of ((j && j.data && j.data.diff) || [])) {
      rows.push({ code: String(r.f12), pct: +r.f3, amount: +r.f6, cap: +r.f21, flow: +r.f62 });
    }
  };
  push(first);
  // 2 个一批 + 失败页重试：本机实测东财并发过高会直接 fetch failed
  for (let p = 2; p <= pages; p += 2) {
    const batch = [p, p + 1].filter(x => x <= pages);
    const res = await Promise.allSettled(batch.map(pageUrl));
    const failed = res.map((r, i) => r.status === 'rejected' ? i : -1).filter(i => i >= 0);
    if (failed.length) {
      await sleep(320);
      const retry = await Promise.allSettled(failed.map(i => fetchJson(pageUrl(batch[i]))));
      failed.forEach((i, k) => { if (retry[k].status === 'fulfilled') res[i] = retry[k]; });
    }
    res.forEach(r => { if (r.status === 'fulfilled') push(r.value); });
    if (p + 2 <= pages) await sleep(180);
  }
  if (rows.length < total * 0.7) throw new Error('全市场分页仅取到 ' + rows.length + '/' + total + ' 条');
  const agg = {};
  BUCKETS.forEach(b => { agg[b.key] = { up: 0, down: 0, flat: 0, count: 0, amount: 0, flow: 0 }; });
  let up = 0, down = 0, flat = 0, valid = 0, flowTotal = 0, amountTotal = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.pct)) continue;
    valid++;
    if (r.pct > 0.05) up++; else if (r.pct < -0.05) down++; else flat++;
    const b = bucketOf(r.cap);
    if (!b) continue;
    const a = agg[b.key];
    a.count++;
    if (r.pct > 0.05) a.up++; else if (r.pct < -0.05) a.down++; else a.flat++;
    a.amount += Number.isFinite(r.amount) ? r.amount : 0;
    a.flow += Number.isFinite(r.flow) ? r.flow : 0;
    flowTotal += Number.isFinite(r.flow) ? r.flow : 0;
    amountTotal += Number.isFinite(r.amount) ? r.amount : 0;
  }
  const out = {
    generatedAt: Date.now(), total, got: rows.length, valid,
    coverage: total ? round(rows.length / total, 3) : 0,
    up, down, flat, flowTotal, amountTotal, agg,
    note: '东财全市场快照，' + pages + ' 页 × 100 条；跨页存在时点差，覆盖率低于 75% 时宽度信号降级'
  };
  try {
    const tmp = BREADTH_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
    fs.renameSync(tmp, BREADTH_FILE);
  } catch (e) { console.warn('[style] 宽度缓存写入失败: ' + e.message); }
  return out;
  } catch (e) {
    // 关键降级：东财限流时宁可用上一份快照，也不要让宽度项整体失效
    if (stale && stale.agg) {
      console.warn('[style] 全市场宽度重拉失败，降级使用上次快照: ' + e.message);
      return { ...stale, stale: true, error: e.message };
    }
    throw e;
  }
}

/* ------------------------------- 模型计算 ------------------------------- */

function computeVolume(marketSeries, dates) {
  const amounts = dates.map(d => (marketSeries.sh.get(d) ? marketSeries.sh.get(d).amount : 0) +
    (marketSeries.sz.get(d) ? marketSeries.sz.get(d).amount : 0));
  const hist = amounts.slice(0, -1);
  const last = amounts[amounts.length - 1];
  const ma20 = mean(hist.slice(-20));
  const ma5 = mean(hist.slice(-5));
  const ratio20 = ma20 > 0 ? last / ma20 : 1;
  const z20 = robustZ(amounts.slice(-21).map(v => Math.log(Math.max(v, 1))));
  // 绝对成交额阈值会随上市公司数量、总市值与通胀漂移，故同时给出近 70 个交易日的历史分位，
  // 供上层「存量博弈 / 增量行情」判定做稳健校准（华泰金工 2025 用 3~5 年分位，此处样本仅 70 日）。
  const sortedAmounts = amounts.slice(-70).filter(v => v > 0).sort((a, b) => a - b);
  const rank = sortedAmounts.findIndex(v => v >= last);
  const percentile = sortedAmounts.length > 1
    ? round((rank < 0 ? sortedAmounts.length - 1 : rank) / (sortedAmounts.length - 1) * 100, 1) : 50;
  const state = ratio20 >= 1.3 ? '显著放量' : ratio20 >= 1.12 ? '温和放量'
    : ratio20 >= 0.9 ? '平量' : ratio20 >= 0.75 ? '缩量' : '地量';
  const shPct = marketSeries.sh.get(dates[dates.length - 1]);
  const szPct = marketSeries.sz.get(dates[dates.length - 1]);
  const idxPct = (shPct && szPct) ? (shPct.pct + szPct.pct) / 2 : 0;
  const priceVolume = ratio20 >= 1.1 ? (idxPct > 0.2 ? '放量上涨 · 增量资金进场' : idxPct < -0.2 ? '放量下跌 · 抛压释放' : '放量滞涨 · 分歧加大')
    : ratio20 <= 0.9 ? (idxPct > 0.2 ? '缩量上涨 · 抛压较轻' : '缩量整理 · 观望为主') : '量价平稳';
  return {
    totalAmount: Math.round(last), totalAmountYi: round(last / 1e8, 0),
    ma20Yi: round(ma20 / 1e8, 0), ratio20: round(ratio20, 3),
    changePct: round((ratio20 - 1) * 100, 1), z20: round(z20, 2), percentile,
    historyDays: sortedAmounts.length,
    trend5v20: round(ma20 > 0 ? ma5 / ma20 : 1, 3),
    state, indexPct: round(idxPct, 2), priceVolume,
    shPct: shPct ? round(shPct.pct, 2) : null, szPct: szPct ? round(szPct.pct, 2) : null
  };
}

function buildStyle(dailies, snapshots, breadth, tradingDate, trading, warnings) {
  const maps = {};
  BUCKETS.forEach(b => { maps[b.key] = new Map(dailies[b.key].map(x => [x.date, x])); });
  const dates = Array.from(maps[BUCKETS[0].key].keys())
    .filter(d => BUCKETS.every(b => maps[b.key].has(d))).sort().slice(-70);
  if (dates.length < 25) throw new Error('对齐后的交易日不足 25 根，无法建立 20 日基线');

  const marketSeries = {
    sh: new Map(dailies.sh.map(x => [x.date, x])),
    sz: new Map(dailies.sz.map(x => [x.date, x]))
  };
  const volume = computeVolume(marketSeries, dates);

  // 每日四层成交额占比（分母统一为四层之和，规避总量放大造成的伪信号）
  const totals = dates.map(d => BUCKETS.reduce((s, b) => s + maps[b.key].get(d).amount, 0));
  const shares = {};
  BUCKETS.forEach(b => {
    shares[b.key] = dates.map((d, i) => Math.max(maps[b.key].get(d).amount / Math.max(totals[i], 1), 1e-6));
  });
  const last = dates.length - 1;
  const logShareSeries = {};
  BUCKETS.forEach(b => { logShareSeries[b.key] = shares[b.key].map(v => Math.log(v)); });

  const raw = BUCKETS.map(b => {
    const k = b.key, bars = dates.map(d => maps[k].get(d));
    const close = bars.map(x => x.close);
    const pct = bars.map(x => x.pct);
    const amount = bars.map(x => x.amount);
    const turnover = bars.map(x => x.turnover);
    const ret5 = last >= 5 ? (close[last] / close[last - 5] - 1) * 100 : 0;
    const ret20 = last >= 20 ? (close[last] / close[last - 20] - 1) * 100 : 0;

    // ① 量能份额偏移：log 占比的稳健时序 z-score（华泰 2025 思路的四层扩展）
    const shareZ = robustZ(logShareSeries[k].slice(-21));
    const shareMa20 = mean(shares[k].slice(-21, -1));
    // ② 自身放量程度
    const volZ = robustZ(amount.slice(-21).map(v => Math.log(Math.max(v, 1))));
    // ③ 带符号量价配合：近 3 日「占比偏离 × 当日涨跌方向」均值，要求持续同向
    let vp = 0;
    for (let t = last - 2; t <= last; t++) {
      if (t < 21) continue;
      const z = robustZ(logShareSeries[k].slice(t - 20, t + 1));
      vp += Math.sign(pct[t] || 0) * clamp(z, -2.5, 2.5) * clamp(Math.abs(pct[t] || 0) / 1.2, 0.2, 1);
    }
    vp = vp / 3;
    // ④ 份额-收益弹性：近 20 日 Δshare 与当日收益相关性（Amihud 单位资金冲击的层级化近似）
    const dShare = [], pct20 = [];
    for (let t = last - 19; t <= last; t++) {
      if (t < 1) continue;
      dShare.push(shares[k][t] - shares[k][t - 1]);
      pct20.push(pct[t]);
    }
    const elasticity = corr(dShare, pct20);
    // ⑤ 拥挤度：换手率在近 60 日的历史分位（A 股高换手次月收益显著更低）
    const crowdPct = pctRank(turnover.slice(-60, -1), turnover[last]);
    const crowdPenalty = crowdPct >= 0.9 ? 0.38 : crowdPct >= 0.8 ? 0.18 : 0;
    // ⑥ 单位资金价格冲击（Amihud 2002 ILLIQ = |R| / 成交额 的层级化近似）：
    //    近 20 日 |指数涨跌%| 均值 ÷ 该层代理指数成交额（亿元）。数值越大＝同样资金推动的价格变化越大，
    //    即「少量资金即可拉动」。这是四层相对口径（指数成交额≠成分股全部成交额），只用于横截面比较。
    const avgAmountYi = mean(amount.slice(-20)) / 1e8;
    const avgAbsPct = mean(pct.slice(-20).map(v => Math.abs(v)));
    const illiq = avgAmountYi > 0 ? round(avgAbsPct / avgAmountYi, 5) : 0;

    return {
      key: k, name: b.name, index: b.index, secid: b.secid, capLabel: b.capLabel,
      capMin: b.min, capMax: Number.isFinite(b.max) ? b.max : null,
      price: snapshots[b.secid.split('.')[1]] ? snapshots[b.secid.split('.')[1]].price : close[last],
      pct1: round(pct[last], 2), ret5: round(ret5, 2), ret20: round(ret20, 2),
      amount: Math.round(amount[last]), amountYi: round(amount[last] / 1e8, 0),
      share: round(shares[k][last] * 100, 2), shareMa20: round(shareMa20 * 100, 2),
      shareDelta: round((shares[k][last] - shareMa20) * 100, 2),
      shareZ: round(shareZ, 2), volZ: round(volZ, 2),
      volumePrice: round(vp, 2), elasticity: round(elasticity, 3),
      turnover: round(turnover[last], 2), crowdPct: round(crowdPct, 2), crowdPenalty,
      illiq, avgAmountYi: round(avgAmountYi, 1), avgAbsPct: round(avgAbsPct, 3),
      _raw: { share: shareZ, momentum: null, volumePrice: vp, elasticity: elasticity * 2, breadth: 0 }
    };
  });

  // ② 风格动量：相对收益做横截面标准化，5 日 60% + 20 日 40% 多窗投票
  const rel5 = raw.map(x => x.ret5), rel20 = raw.map(x => x.ret20);
  const z5 = crossZ(rel5), z20 = crossZ(rel20);
  const mean5 = mean(rel5);
  raw.forEach((x, i) => {
    x.rel5 = round(x.ret5 - mean5, 2);  // 横截面超额收益，文案与展示都用这个口径
    x._raw.momentum = 0.6 * z5[i] + 0.4 * z20[i];
  });
  // ⑤ 宽度：层内上涨家数占比，横截面去均值后标准化；覆盖不足则整体降级
  const breadthOk = breadth && breadth.coverage >= 0.75 && breadth.valid > 1000;
  const upRatios = raw.map(x => {
    if (!breadthOk) return 0.5;
    const a = breadth.agg[x.key];
    const n = a.up + a.down + a.flat;
    return n ? a.up / n : 0.5;
  });
  const bz = crossZ(upRatios.map(v => (v - 0.5) * 4));
  raw.forEach((x, i) => {
    x.upRatio = round(upRatios[i] * 100, 1);
    x.breadthCount = breadthOk ? breadth.agg[x.key].count : 0;
    x.breadthZ = round(bz[i], 2);
    x._raw.breadth = bz[i];
    x.mainFlowYi = breadthOk ? round(breadth.agg[x.key].flow / 1e8, 1) : null;
    x.breadthAmountYi = breadthOk ? round(breadth.agg[x.key].amount / 1e8, 0) : null;
  });
  if (!breadthOk) warnings.push('全市场宽度覆盖不足（' + (breadth ? round((breadth.coverage || 0) * 100, 0) : 0) + '%），宽度项按中性计入并下调置信度');

  // 融合：固定权重（不做参数寻优，避免过拟合），拥挤度作反向惩罚
  raw.forEach(x => {
    const c = x._raw;
    // 宽度缺失时按剩余权重重新归一化，避免降级状态下分数整体被压低而失去可比性
    const wSum = breadthOk ? 1 : (1 - WEIGHTS.breadth);
    const combined = (WEIGHTS.share * clamp(c.share, -3, 3) +
      WEIGHTS.momentum * clamp(c.momentum, -2.5, 2.5) +
      WEIGHTS.volumePrice * clamp(c.volumePrice, -2.5, 2.5) +
      WEIGHTS.elasticity * c.elasticity +
      (breadthOk ? WEIGHTS.breadth * c.breadth : 0)) / wSum - x.crowdPenalty;
    x.score = Math.round(clamp(combined * 58, -100, 100));
    x.components = {
      share: round(c.share, 2), momentum: round(c.momentum, 2),
      volumePrice: round(c.volumePrice, 2), elasticity: round(c.elasticity, 2),
      breadth: round(c.breadth, 2), crowdPenalty: -round(x.crowdPenalty, 2)
    };
    delete x._raw;
  });
  // 单位资金价格冲击的横截面比值：微盘/小盘相对大盘的倍数，用于「缩量时少量资金即可拉动」的实测依据
  const largeIlliq = (raw.find(x => x.key === 'large') || {}).illiq || 0;
  const baseIlliq = largeIlliq > 0 ? largeIlliq : Math.max(...raw.map(x => x.illiq), 1e-9);
  const capitalEfficiency = raw.map(x => ({
    key: x.key, name: x.name, index: x.index,
    illiq: x.illiq, avgAmountYi: x.avgAmountYi, avgAbsPct: x.avgAbsPct,
    ratioToLarge: round(x.illiq / baseIlliq, 2)
  }));

  const ranked = raw.slice().sort((a, b) => b.score - a.score);
  const spread = ranked[0].score - ranked[ranked.length - 1].score;
  const dominant = spread < 22 ? 'balanced' : ranked[0].key;
  const dominantLabel = dominant === 'balanced' ? '风格均衡' : ranked[0].name;
  raw.forEach(x => { x.rank = ranked.findIndex(y => y.key === x.key) + 1; });

  // 置信度：子信号方向一致性 × 样本长度 × 横截面覆盖率（Grinold-Kahn 的 breadth 思想）
  const lead = ranked[0];
  const signs = [lead.components.share, lead.components.momentum, lead.components.volumePrice,
    lead.components.elasticity, lead.components.breadth].filter(v => Math.abs(v) > 0.15);
  const agreement = signs.length ? Math.abs(signs.reduce((s, v) => s + Math.sign(v), 0)) / signs.length : 0.3;
  const sampleFactor = clamp(dates.length / 45, 0, 1);
  const coverageFactor = breadthOk ? clamp(breadth.coverage, 0, 1) : 0.4;
  let confidence = clamp(0.28 + 0.30 * agreement + 0.20 * sampleFactor + 0.22 * coverageFactor, 0.25, 0.95);
  if (!trading) confidence *= 0.92;
  // 极端单边行情（普跌/普涨）里，风格分更多反映避险与抛压，而非资金主动选择市值层
  const wholeUp = (breadthOk && breadth.valid) ? breadth.up / Math.max(breadth.up + breadth.down + breadth.flat, 1) * 100 : null;
  if (wholeUp !== null && (wholeUp < 35 || wholeUp > 65)) {
    confidence *= 0.9;
    warnings.push('全市场上涨家数占比 ' + round(wholeUp, 1) + '%，单边行情下风格分含较多避险/抛压成分，置信度已折减');
  }
  confidence = round(confidence, 2);
  const confidenceLabel = confidence >= 0.75 ? '高' : confidence >= 0.55 ? '中' : '低';

  const volumeText = '两市成交 ' + volume.totalAmountYi.toLocaleString('zh-CN') + ' 亿元，较 20 日均量 ' +
    (volume.changePct >= 0 ? '+' : '') + volume.changePct + '%（' + volume.state + '），' + volume.priceVolume;
  const styleText = dominant === 'balanced'
    ? '四层风格分差仅 ' + spread + ' 分，未形成明显的市值资金倾向'
    : '资金倾向「' + dominantLabel + '」：' + lead.index + ' 成交占比 ' + lead.share + '%（较 20 日均值 ' +
      (lead.shareDelta >= 0 ? '+' : '') + lead.shareDelta + 'pct，' + (lead.shareZ >= 0 ? '+' : '') + lead.shareZ +
      'σ），5 日横截面超额 ' + (lead.rel5 >= 0 ? '+' : '') + lead.rel5 + '%，层内上涨家数占比 ' + lead.upRatio + '%';
  const conclusion = volumeText + '。' + styleText + '。置信度' + confidenceLabel + '（' + confidence + '）' +
    (wholeUp !== null ? '；全市场上涨家数占比 ' + round(wholeUp, 1) + '%' : '') + '。';

  const signature = hash([
    tradingDate, volume.ratio20.toFixed(3), volume.totalAmountYi,
    dominant, confidence.toFixed(2), breadthOk ? 1 : 0,
    raw.map(x => x.key + ':' + x.score).join(',')
  ].join('|'));

  return {
    ok: true, generatedAt: Date.now(), tradingDate, trading, fromCache: false,
    source: '东方财富 · 规模指数日线 / 指数快照 / 全市场个股快照',
    volume: {
      ...volume,
      breadth: breadthOk ? {
        up: breadth.up, down: breadth.down, flat: breadth.flat,
        upRatio: round(breadth.up / Math.max(breadth.up + breadth.down + breadth.flat, 1) * 100, 1),
        coverage: breadth.coverage, got: breadth.got, total: breadth.total
      } : null
    },
    buckets: raw,
    capitalEfficiency,
    ranked: ranked.map(x => ({ key: x.key, name: x.name, score: x.score })),
    dominant, dominantLabel, spread, confidence, confidenceLabel,
    conclusion, signature, warnings,
    weights: WEIGHTS,
    methodology: {
      universe: '以沪深300 / 中证500 / 中证1000 / 中证2000 作为大盘 / 中盘 / 小盘 / 微盘的可交易代理；四层成交额之和为份额分母，两市（上证+深证）成交额为总量能口径，两者不混用',
      standard: 'log 成交额占比 → 20 日中位数 ±3×MAD 去极值 → 稳健 z-score；相对动量与宽度做横截面 z-score（qlib CSZScoreNorm 思路）',
      signals: '量能份额偏移 28% + 风格相对动量 26%（5日60%/20日40%）+ 带符号量价配合 20%（近3日同向确认）+ 份额‑收益弹性 12%（Amihud 层级化近似）+ 层内宽度 14% − 换手拥挤度惩罚',
      confidence: '子信号方向一致性 30% + 样本长度 20% + 横截面覆盖率 22% + 基线 28%；非交易时段 ×0.92；宽度 <40% 或覆盖 <75% 时降级',
      capitalEfficiency: '单位资金价格冲击 = 近20日 |指数涨跌%| 均值 ÷ 代理指数成交额（亿元），为 Amihud(2002) ILLIQ 与 Kyle(1985) λ 的层级化近似，只作四层相对比较；成交额同时给出近 70 日历史分位，用于校准 2.5 万亿等绝对阈值的漂移',
      capBuckets: BUCKETS.map(b => b.name + '：流通市值 ' + b.capLabel + '（代理 ' + b.index + '）').join('；'),
      limitation: '四规模指数成分非完全互斥；60~70 根日线不足估多年分位；全市场快照分页存在跨页时点差；结果为横截面相对倾向，不是资金流因果测量或涨跌预测。A 股 T+1、涨跌停、微盘壳价值与退市风险另行考虑',
      references: [
        '华泰金工《基于趋势和拐点的市值因子择时模型》(2025)',
        'Liu, Stambaugh & Yuan (2019) Size and Value in China, CH-3/CH-4',
        'Jegadeesh & Titman (1993) / Carhart (1997) / Ehsani & Linnainmaa Factor Momentum',
        'Gervais, Kaniel & Mingelgrin (2001) The High-Volume Return Premium',
        'Amihud (2002) Illiquidity and Stock Returns',
        'Herding for profits: Market breadth and the cross-section of global equity returns (2020)',
        'Expected return, volume, and mispricing: Evidence from China (2024)',
        'github.com/microsoft/qlib（CSZScoreNorm / Alpha158）、github.com/quantopian/alphalens（分层一致性）',
        'github.com/akfamily/akshare（东财 push2 接口口径）'
      ]
    }
  };
}

/* ------------------------------- 对外接口 ------------------------------- */

/**
 * 采集并计算风格状态。带 TTL 缓存：交易时段 refreshMin 分钟、非交易时段 ×6（下限 30 分钟）。
 * @param {object} opts { force, trading, refreshMin, breadthEnabled, maxAdjust }
 */
async function getMarketStyle(opts = {}) {
  const bj = beijing();
  const trading = opts.trading !== undefined ? !!opts.trading : isTradingNow(bj);
  const refreshMin = clamp(Number(opts.refreshMin) || 5, 1, 240);
  const ttl = (trading ? refreshMin : Math.max(30, refreshMin * 6)) * 60000;
  if (!opts.force && memCache && memCache.ok && Date.now() - memCache.generatedAt < ttl && memCache.tradingDate) {
    return { ...memCache, fromCache: true };
  }
  if (busy) return await busy;
  busy = (async () => {
    const warnings = [];
    try {
      const dailyKeys = BUCKETS.map(b => b.key).concat(MARKET_INDEX.map(m => m.key));
      const secids = BUCKETS.map(b => b.secid).concat(MARKET_INDEX.map(m => m.secid));
      // 分批请求：本机实测东财对同一时刻的高并发会限流，3 个一批 + 间隔最稳
      const dailies = {};
      for (let i = 0; i < secids.length; i += 3) {
        const res = await Promise.allSettled(secids.slice(i, i + 3).map(fetchDaily));
        res.forEach((r, k) => {
          const idx = i + k;
          if (r.status === 'fulfilled') dailies[dailyKeys[idx]] = r.value;
          else warnings.push(secids[idx] + ' 日线失败：' + r.reason.message);
        });
        if (i + 3 < secids.length) await sleep(180);
      }
      const missing = dailyKeys.filter(k => !dailies[k] || dailies[k].length < 25);
      if (missing.length) throw new Error('关键指数日线不足：' + missing.join(','));

      let snapshots = {};
      try { snapshots = await fetchSnapshot(); }
      catch (e) { warnings.push('指数快照失败：' + e.message); }

      let breadth = null;
      if (opts.breadthEnabled !== false) {
        try {
          breadth = await fetchBreadth(!!opts.forceBreadth, trading);
          if (breadth && breadth.stale) warnings.push('全市场宽度为上次快照（本次重拉被限流）：' + (breadth.error || ''));
        } catch (e) { warnings.push('全市场宽度采集失败：' + e.message); }
      } else warnings.push('全市场宽度已按配置关闭');

      const firstMap = new Map(dailies[BUCKETS[0].key].map(x => [x.date, x]));
      const tradingDate = Array.from(firstMap.keys()).sort().slice(-1)[0] || bj.date;
      const style = buildStyle(dailies, snapshots, breadth, tradingDate, trading, warnings);
      // buildStyle 与 getMarketStyle 共用同一个 warnings 数组，此处只复制，避免自拼接导致重复
      style.warnings = warnings.slice();
      memCache = style;
      try {
        const tmp = CACHE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(style), 'utf8');
        fs.renameSync(tmp, CACHE_FILE);
      } catch (e) { console.warn('[style] 缓存写入失败: ' + e.message); }
      return style;
    } catch (e) {
      const fail = {
        ok: false, generatedAt: Date.now(), trading, error: e.message,
        warnings, signature: 'error-' + e.message,
        volume: null, buckets: [], confidence: 0, confidenceLabel: '无',
        dominant: 'balanced', dominantLabel: '数据不足', spread: 0,
        conclusion: '量能风格数据不可用：' + e.message
      };
      // 采集失败时保留上一轮结果，避免评分因子突然抖动；但标记为 stale
      if (memCache && memCache.ok) return { ...memCache, stale: true, warnings: warnings.concat(e.message), signature: memCache.signature };
      return fail;
    }
  })();
  try { return await busy; } finally { busy = null; }
}

/**
 * 个股风格因子：按流通市值归层 → 取该层风格分 → 乘置信度 → 用个股量比调节传导强度。
 * 与外围联动修正并列，最大 ±maxAdjust 分，且始终输出可解释理由。
 */
function styleForStock(style, floatCap, row = {}, maxAdjust = 12) {
  const neutral = {
    key: null, label: '未分层', index: '', capLabel: '', score: 0,
    adjustment: 0, confidence: style && style.confidence ? style.confidence : 0,
    volBoost: 0, reasons: ['量能风格数据不可用或流通市值缺失，风格因子按中性 0 计'], available: false
  };
  if (!style || !style.ok || !Array.isArray(style.buckets) || !style.buckets.length) return neutral;
  const b = bucketOf(floatCap);
  if (!b) return neutral;
  const found = style.buckets.find(x => x.key === b.key);
  if (!found) return neutral;
  const vr = Number(row.volRatio);
  const volRatio = Number.isFinite(vr) && vr > 0 ? vr : 1;
  const volBoost = round(clamp((volRatio - 1) * 0.22, -0.22, 0.45), 2);
  const limit = clamp(Number(maxAdjust) || 12, 0, 20);
  const adjustment = Math.round(clamp(
    (found.score / 100) * limit * (style.confidence || 0) * (1 + volBoost), -limit, limit
  ));
  const reasons = [
    found.name + '（流通市值 ' + b.capLabel + '，代理 ' + found.index + '）｜风格分 ' +
      (found.score >= 0 ? '+' : '') + found.score + '，排名第 ' + found.rank + '/4',
    '成交占比 ' + found.share + '%（较20日 ' + (found.shareDelta >= 0 ? '+' : '') + found.shareDelta +
      'pct / ' + (found.shareZ >= 0 ? '+' : '') + found.shareZ + 'σ）、5日相对收益 ' +
      (found.ret5 >= 0 ? '+' : '') + found.ret5 + '%、宽度 ' + found.upRatio + '%',
    '风格修正 ' + (adjustment >= 0 ? '+' : '') + adjustment + ' 分 = 风格分 × 置信度 ' +
      (style.confidence || 0) + ' × 量比传导 ' + (1 + volBoost).toFixed(2) +
      '（量比 ' + volRatio.toFixed(2) + '，上下限 ±' + limit + '）'
  ];
  if (found.crowdPenalty > 0) reasons.push('该层换手处于近 60 日 ' + Math.round(found.crowdPct * 100) + '% 分位，已计入拥挤度反向惩罚');
  return {
    key: b.key, label: found.name, index: found.index, capLabel: b.capLabel,
    score: found.score, rank: found.rank, adjustment,
    confidence: style.confidence || 0, volBoost, reasons, available: true,
    dominant: dominantOf(style), share: found.share, shareZ: found.shareZ,
    ret5: found.ret5, upRatio: found.upRatio
  };
}

function dominantOf(style) {
  if (!style || !style.dominant || style.dominant === 'balanced') return '风格均衡';
  return (style.dominantLabel || '') + '占优';
}

function loadCached() {
  if (memCache) return memCache;
  try {
    if (fs.existsSync(CACHE_FILE)) memCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (_) { memCache = null; }
  return memCache;
}

module.exports = {
  getMarketStyle, styleForStock, bucketOf, dominantOf, loadCached,
  BUCKETS, WEIGHTS, CACHE_FILE, BREADTH_FILE
};
