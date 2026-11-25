'use strict';

/**
 * 资金避险识别与去向判定
 *
 * 【先把定义说清楚】
 * 「资金避险」不是单一状态，至少有四种形态，对应的操作含义完全不同：
 *   L1 板块内轮动：钱没离开股市，只是从高波动板块（科技/军工/微盘题材）
 *      搬到防御板块（银行/电力/黄金/红利）。指数可能不跌甚至上涨。
 *   L2 风格避险：仍是场内搬家，但维度是市值与风格——小盘 → 大盘、成长 → 价值。
 *   L3 离场避险（出股市）：钱真的离开权益市场，典型去向是债券（股债跷跷板）
 *      与货币/理财。特征是：缩量 + 融资余额下降 + 国债 ETF 上涨 + 无防御板块承接。
 *   L4 离境避险：资金离开本币资产。特征是：人民币快速贬值 + 黄金（全球避险资产）上涨。
 *
 * 【判定逻辑（每一项都可核对）】
 *   1. 防御承接  ：银行/电力/贵金属 5 日收益 − 沪深300 5 日 > +2% → L1 证据
 *   2. 微盘失血  ：中证2000 5 日 − 沪深300 5 日 < −3% → L2 证据
 *   3. 股债跷跷板：十年国债ETF 5 日 > +0.3% 且 沪深300 5 日 < −1% → L3 证据
 *   4. 量能萎缩  ：两市成交额 20 日分位 < 30%（出逃避险的资金不再回来交易）→ L3 证据
 *   5. 杠杆退潮  ：融资余额 5 日净变化 < 0 → L3 证据
 *   6. 汇率压力  ：USDCNH 5 日涨幅 > +0.5%（贬值）→ L4 证据
 *   7. 全球避险  ：黄金 5 日 > +2% → L4 证据（共振项）
 *
 * 【输出口径】
 * 每个维度给出「证据强度 + 原始数值」，最终输出一个明确的去向结论
 * （轮动避险 / 风格避险 / 流向债市 / 观望离场 / 离境），而不是一个模糊的分数。
 * 所有阈值都写在本文件顶部，调参即改这里，不在别处散落魔法数字。
 */

const cycle = require('./cycle');

/* --------------------------------- 阈值 --------------------------------- */

const TH = {
  defensiveGap: 2.0,     // 防御板块相对沪深300 的 5 日超额（%）
  microGap: -3.0,        // 中证2000 相对沪深300 的 5 日差（%）
  bondUp: 0.3,           // 十年国债ETF 5 日涨幅（%）
  equityDown: -1.0,      // 沪深300 5 日跌幅（%）
  volumePctl: 30,        // 成交额 20 日分位（%）低于此为萎缩
  fxDep: 0.5,            // USDCNH 5 日涨幅（%）高于此为贬值压力
  goldUp: 2.0            // 黄金 5 日涨幅（%）
};

const DEFENSIVE_BOARDS = ['银行', '电力', '贵金属'];
const CACHE_FILE = require('node:path').join(__dirname, '..', 'data', 'riskoff-cache.json');
const TTL = 10 * 60 * 1000;

/* --------------------------------- 工具 --------------------------------- */

function round(x, n = 2) { if (!Number.isFinite(x)) return null; const p = Math.pow(10, n); return Math.round(x * p) / p; }
function beijing(ts = Date.now()) { return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function fetchJson(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const req = https.get(url, { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' }, timeout }, res => {
      let buf = [];
      res.on('data', d => buf.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(buf).toString('utf8'))); } catch (e) { reject(new Error('JSON 解析失败')); } });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

/** ETF/指数/外汇实时快照（东财 push2）。scale: 价格放大倍数（ETF 1000 / 汇率 10000 / 指数 100） */
async function quote(secid, scale) {
  const j = await fetchJson('https://push2.eastmoney.com/api/qt/stock/get?secid=' + secid + '&fields=f43,f57,f58,f60,f169,f170').catch(() => null);
  const d = j && j.data;
  if (!d || d.f43 == null) return null;
  return { name: d.f58, price: round(d.f43 / scale, 4), prevClose: round((d.f60 || d.f43) / scale, 4), pct: round(d.f170 / 100, 2) };
}

/* ------------------------------ 核心计算 ------------------------------ */

async function buildRiskOff(opts = {}) {
  const today = beijing();

  // 1) 指数与板块的 5 日收益（用日K，比实时价稳定；kline 已带 6h 缓存）
  const idxBars = await cycleBoardKline('1.000300', 10).catch(() => []);
  const ret5 = bars => (bars && bars.length >= 6) ? round((bars[bars.length - 1].c / bars[bars.length - 6].c - 1) * 100) : null;
  const hs300 = ret5(idxBars);

  const microBars = await cycleBoardKline('2.932000', 10).catch(() => []);
  const microRet = ret5(microBars);

  // 防御板块（取三个中表现最强的——避险时通常至少有一个被明显买入）
  const boards = await cycle.boardMap().catch(() => []);
  const defRets = [];
  for (const name of DEFENSIVE_BOARDS) {
    const r = cycle.resolveBoards(boards, [name]);
    if (!r.boards.length) continue;
    const b = await cycleBoardKline('90.' + r.boards[0].code, 10).catch(() => []);
    const x = ret5(b);
    if (x != null) defRets.push({ name: r.boards[0].name, ret: x });
  }
  const bestDef = defRets.length ? defRets.reduce((a, b) => (b.ret > a.ret ? b : a)) : null;

  // 2) 债与汇（实时快照只有当日，5 日收益用日K）
  const bondBars = await cycleBoardKline('1.511260', 10).catch(() => []);
  const bondRet = ret5(bondBars);
  const fxBars = await cycleBoardKline('133.USDCNH', 10).catch(() => []);
  const fxRet = ret5(fxBars);

  // 黄金 5 日（COMEX 主连，全球避险资产定价锚）
  const goldBars = await cycleBoardKline('101.GC00Y', 10).catch(() => []);
  const goldRetLocal = ret5(goldBars);
  const goldRet = goldRetLocal != null ? goldRetLocal : (opts.goldRet != null ? opts.goldRet : null);

  // 3) 外部传入：量能与两融（单一数据源，分别来自 marketStyle 与 flow）
  const volume = opts.volumeYi != null ? { volumeYi: opts.volumeYi, percentile: opts.volumePercentile } : null;
  const margin = opts.marginTrend || null; // { latest:{rzYi}, yearChange, ... } 或 flow 的 5 日变化

  /* ---------------- 各维度证据 ---------------- */
  const ev = [];

  if (bestDef && hs300 != null) {
    const gap = round(bestDef.ret - hs300);
    ev.push({
      key: 'defensive', label: '防御板块承接',
      value: gap, threshold: TH.defensiveGap,
      hit: gap > TH.defensiveGap,
      detail: bestDef.name + ' 5 日 ' + bestDef.ret + '% vs 沪深300 ' + hs300 + '%（差 ' + gap + '%）',
      direction: 'sector'
    });
  }

  if (microRet != null && hs300 != null) {
    const gap = round(microRet - hs300);
    ev.push({
      key: 'micro', label: '微盘相对失血',
      value: gap, threshold: TH.microGap,
      hit: gap < TH.microGap,
      detail: '中证2000 5 日 ' + microRet + '% vs 沪深300 ' + hs300 + '%（差 ' + gap + '%）',
      direction: 'style'
    });
  }

  if (bondRet != null && hs300 != null) {
    const hit = bondRet > TH.bondUp && hs300 < TH.equityDown;
    ev.push({
      key: 'seesaw', label: '股债跷跷板',
      value: round(bondRet - hs300), threshold: null, hit,
      detail: '十年国债ETF 5 日 ' + bondRet + '%，沪深300 ' + hs300 + '%——' + (hit ? '债涨股跌，资金流向债市' : '未见典型跷跷板形态'),
      direction: 'bond'
    });
  }

  if (volume && volume.percentile != null) {
    ev.push({
      key: 'volume', label: '量能萎缩',
      value: volume.percentile, threshold: TH.volumePctl,
      hit: volume.percentile < TH.volumePctl,
      detail: '两市成交额 ' + volume.volumeYi + ' 亿，20 日分位 ' + volume.percentile + '%',
      direction: 'exit'
    });
  }

  if (margin && margin.rz5d != null) {
    ev.push({
      key: 'margin', label: '杠杆退潮',
      value: margin.rz5d, threshold: 0,
      hit: margin.rz5d < 0,
      detail: '融资余额 5 日净变化 ' + margin.rz5d + ' 亿（当前 ' + margin.rzYi + ' 亿）',
      direction: 'exit'
    });
  }

  if (fxRet != null) {
    ev.push({
      key: 'fx', label: '汇率贬值压力',
      value: fxRet, threshold: TH.fxDep,
      hit: fxRet > TH.fxDep,
      detail: 'USDCNH 5 日 ' + (fxRet > 0 ? '+' : '') + fxRet + '%（' + (fxRet > 0 ? '人民币贬值方向' : '人民币稳定或升值') + '）',
      direction: 'offshore'
    });
  }

  if (goldRet != null) {
    ev.push({
      key: 'gold', label: '全球避险共振',
      value: goldRet, threshold: TH.goldUp,
      hit: goldRet > TH.goldUp,
      detail: '黄金 5 日 ' + (goldRet > 0 ? '+' : '') + goldRet + '%',
      direction: 'offshore'
    });
  }

  /* ---------------- 去向判定 ---------------- */
  const byDir = d => ev.filter(x => x.direction === d && x.hit);
  const sector = byDir('sector').length, style = byDir('style').length;
  const bond = byDir('bond').length, exitN = byDir('exit').length, offshore = byDir('offshore').length;

  // 判定优先级：离境 > 离场 > 债市 > 风格 > 板块轮动。
  // 逻辑：越往后（留在场内）越温和；同时命中多个时按最严重的形态报告，并附次要形态。
  let form, actions = [];
  if (offshore >= 1 && (exitN >= 1 || bond >= 1)) {
    form = 'L4 离境避险';
    actions.push('资金离开本币资产的迹象明显（汇率贬值' + (goldRet > TH.goldUp ? ' + 黄金上涨' : '') + '），降低权益仓位是合理防御');
  } else if (exitN >= 2 || (exitN >= 1 && bond >= 1)) {
    form = 'L3 离场避险（资金离开股市）';
    actions.push('缩量 + 杠杆退潮' + (bond >= 1 ? ' + 流向债市' : '') + '：资金在离场而非轮动，不宜把防御板块的强势当作题材切换');
  } else if (bond >= 1) {
    form = 'L3 离场避险（流向债市）';
    actions.push('股债跷跷板成立，资金从股市流向债券');
  } else if (style >= 1 && sector >= 1) {
    form = 'L2 风格避险 + L1 板块轮动';
    actions.push('资金仍在场内，但从小盘流向大盘防御——这是躲雨不是清仓');
  } else if (style >= 1) {
    form = 'L2 风格避险';
    actions.push('市值风格切换中，微盘高位题材股风险大于指数本身');
  } else if (sector >= 1) {
    form = 'L1 板块内轮动避险';
    actions.push('资金搬向防御板块，指数层面未必走弱——减仓进攻板块而非全部');
  } else {
    form = '无显著避险形态';
    actions.push(ev.some(x => x.key === 'volume' && !x.hit && x.value > 70) ? '量能处于高位，属进攻形态' : '各项避险证据均未触发');
  }

  const score = Math.round(ev.filter(x => x.hit).reduce((s, x) => s + (x.direction === 'offshore' ? 30 : x.direction === 'exit' ? 25 : x.direction === 'bond' ? 20 : 15), 0));

  return {
    ok: true, date: today, form, score: Math.min(100, score),
    evidence: ev,
    direction: { sector, style, bond, exit: exitN, offshore },
    actions,
    // 直接回答「避险 = 去了其他板块还是出了股市」
    answer: form.includes('L1') || form.includes('L2')
      ? '资金仍在股市内部：从高波动板块/小市值搬到防御板块/大市值，属于「躲雨」不是「离场」'
      : form.includes('L3') ? '资金正在离开股市：' + (bond >= 1 ? '主要流向债券市场（股债跷跷板）' : '呈现观望离场特征（缩量+去杠杆），去向可能是货基/理财') + '，与板块轮动的操作含义完全不同'
        : form.includes('L4') ? '资金离开本币资产：汇率与黄金同时发出信号，属系统性离境避险'
          : '当前无显著避险，资金行为以进攻或中性为主',
    definitions: {
      L1: '板块内轮动：防御板块相对走强但指数不弱，资金未离场',
      L2: '风格避险：小盘/成长资金流向大盘/价值，仍是场内搬家',
      L3: '离场避险：缩量+去杠杆(+流向债券)，资金离开权益市场',
      L4: '离境避险：本币贬值+黄金上涨，资金离开本币资产'
    },
    thresholds: TH
  };
}

/* --------------------------- kline 直连（避免循环依赖） --------------------------- */

async function cycleBoardKline(secid, lmt = 10) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid +
    '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=' + lmt;
  const j = await fetchJson(url);
  const lines = (j && j.data && j.data.klines) || [];
  return lines.map(s => {
    const p = String(s).split(',');
    return { d: p[0], c: +p[2] };
  }).filter(b => b.d && b.c);
}

/* --------------------------------- 缓存 --------------------------------- */

let memCache = { at: 0, view: null };

async function getRiskOff(force = false, opts = {}) {
  if (!force && memCache.view && Date.now() - memCache.at < TTL) return memCache.view;
  try {
    const fs = require('node:fs');
    if (!force && fs.existsSync(CACHE_FILE)) {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Date.now() - (c.builtAt || 0) < TTL) { memCache = { at: Date.now(), view: c }; return c; }
    }
  } catch (_) {}
  const view = await buildRiskOff(opts);
  if (view.ok) {
    view.builtAt = Date.now();
    memCache = { at: Date.now(), view };
    try { require('node:fs').writeFileSync(CACHE_FILE, JSON.stringify(view), 'utf8'); } catch (_) {}
  }
  return view;
}

module.exports = { getRiskOff, buildRiskOff, TH, DEFENSIVE_BOARDS, CACHE_FILE };
