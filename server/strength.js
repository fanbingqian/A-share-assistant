'use strict';

/**
 * 板块相对强弱 / 主线识别（对应《核心命题分析》P1）
 *
 * 【要回答的问题】
 * 「此刻谁最赚钱」不是绝对涨幅，而是相对同市场基准的超额。
 * 本模块对全市场行业板块做横截面排名，识别「正在变强」的主线，
 * 并给出拥挤度提示（全市场都知道谁最强时，超额开始衰减）。
 *
 * 【数据源与口径（全部实测校验，不猜字段）】
 *  东财 clist 全量行业板块（翻页 5 次取全 496 个）：
 *    f3 当日涨跌幅 / f109 5 日 / f160 10 日 / f24 60 日 / f6 成交额 / f8 换手率 /
 *    f104 上涨家数 / f105 下跌家数 / f12 板块代码 / f14 板块名
 *  字段周期已用板块真实日 K 校验（电子 BK1201：接口 5 日 -11.31 vs 日 K -11.39，
 *    10 日 -6.07 vs -6.15，60 日 -27.38 vs -27.44，误差 < 0.1pct）。
 *  基准：沪深300 日 K（1.000300，fqt=1 前复权，与板块同口径）算 5/10/60 日涨幅；
 *        板块涨幅 − 基准涨幅 = 相对超额。不减基准会把大盘 beta 误当 alpha。
 *
 * 【反幻觉边界】
 *  - 板块分类表是静态人工映射，只用于聚合展示，不参与打分，输出中显式标注。
 *  - 拥挤度分两个口径分别标注：横截面分位（当日 496 板块之间比）与
 *    时间序列分位（该板块自身 60 日成交额序列，仅对 Top 板块拉取）。
 *  - 主线是横截面统计描述，不是收益预测；不输出「预计涨 X%」。
 *  - 接口缺失的字段一律置 null 并标注「无数据」，绝不用 0 或估值填充。
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'strength-cache.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TTL = 10 * 60 * 1000;

function round(x, n = 2) { if (!Number.isFinite(x)) return null; const p = Math.pow(10, n); return Math.round(x * p) / p; }
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function beijing(ts = Date.now()) { return new Date(ts + 8 * 3600000).toISOString().slice(0, 10); }
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

function fetchJson(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const req = https.get(url, { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' }, timeout }, res => {
      const buf = [];
      res.on('data', d => buf.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(buf).toString('utf8'))); } catch (e) { reject(new Error('JSON 解析失败')); } });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

/* --------------------------- 静态板块分类表（人工） --------------------------- */
/** 只用于「周期 / 科技 / 消费 / 防御 / 金融」聚合展示，不参与任何打分。 */
const CATEGORY = [
  ['周期', ['煤炭', '石油', '有色', '钢铁', '化学', '化工', '建材', '水泥', '玻璃', '电力', '燃气', '航运', '港口', '工程', '机械', '采掘', '稀土', '锂', '光伏', '电池', '农牧', '造纸', '橡胶', '化纤', '农化', '小金属', '贵金属']],
  ['科技', ['半导体', '电子', '计算机', '软件', '通信', '互联网', '游戏', '传媒', '影视', '文化', '消费电子', '光学', '元件', 'IT', '数据', '算力', '人工智能', '机器人', '航空', '航天', '军工', '国防', '电信运营商', '运营商']],
  ['消费', ['酿酒', '食品', '饮料', '家电', '冰洗', '彩电', '小家电', '商业', '百货', '零售', '旅游', '酒店', '餐饮', '纺织', '服装', '美容', '护理', '家居', '汽车', '摩托', '教育', '体育', '宠物', '珠宝', '免税', '厨电']],
  ['防御', ['银行', '医药', '中药', '生物', '医疗', '公用', '水务', '环保', '高速公路', '铁路', '公路', '电力', '燃气', '国有大型', '股份制', '城商行', '农商行']],
  ['金融', ['证券', '保险', '多元金融', '房地产', '银行', '信托', '期货']]
];
function categoryOf(name) {
  const n = String(name || '');
  for (const [cat, keys] of CATEGORY) if (keys.some(k => n.includes(k))) return cat;
  return '其他';
}

/* ------------------------------ 全量板块列表 ------------------------------ */
const BOARD_FIELDS = 'f12,f14,f3,f6,f8,f24,f109,f160,f104,f105';

async function fetchBoards() {
  const out = [];
  for (let p = 1; p <= 6; p++) {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=' + p +
      '&pz=100&po=1&np=1&fltt=2&invt=2&fid=f6&fs=m:90+t:2&fields=' + BOARD_FIELDS;
    const j = await fetchJson(url);
    const rows = (j && j.data && j.data.diff) || [];
    out.push(...rows);
    if (rows.length < 100) break;
    await sleep(80);
  }
  return out;
}

/* ------------------------------ 日 K（基准 / 拥挤度） ------------------------------ */
const klineCache = new Map();

async function kline(secid, lmt = 70) {
  const key = secid + ':' + lmt;
  const hit = klineCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.bars;
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid +
    '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=' + lmt;
  try {
    const j = await fetchJson(url);
    const bars = ((j && j.data && j.data.klines) || []).map(s => {
      const p = String(s).split(',');
      return { d: p[0], c: num(p[2]), amount: num(p[6]) };
    }).filter(b => b.d && b.c);
    klineCache.set(key, { at: Date.now(), bars });
    await sleep(70);
    return bars;
  } catch (_) {
    klineCache.set(key, { at: Date.now(), bars: [] });
    return [];
  }
}

/** 用日 K 算 N 日前至今涨幅（%） */
function retN(bars, n) {
  if (!bars || bars.length < n + 1) return null;
  const a = bars[bars.length - 1 - n], b = bars[bars.length - 1];
  return a && b && a.c ? round((b.c / a.c - 1) * 100) : null;
}

/** 时间序列分位：当前值在最近 values 中的百分位（0-100） */
function pctl(values, cur) {
  const arr = values.filter(Number.isFinite);
  if (!arr.length || !Number.isFinite(cur)) return null;
  return round(arr.filter(v => v <= cur).length / arr.length * 100, 0);
}

/* ------------------------------ 主构建 ------------------------------ */
async function buildStrength(opts = {}) {
  const force = !!opts.force;
  if (!force && fs.existsSync(CACHE_FILE)) {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (c.ok && Date.now() - (c.builtAt || 0) < TTL) return c;
    } catch (_) {}
  }

  const rows = await fetchBoards();
  if (!rows.length) return { ok: false, error: '板块列表不可达', builtAt: Date.now() };

  const benchBars = await kline('1.000300', 70);
  if (benchBars.length < 61) return { ok: false, error: '沪深300 日线不足 61 根，无法计算相对超额', builtAt: Date.now() };
  const bench = {
    name: '沪深300', date: benchBars[benchBars.length - 1].d,
    r5: retN(benchBars, 5), r10: retN(benchBars, 10), r60: retN(benchBars, 60)
  };
  if (bench.r5 == null || bench.r10 == null || bench.r60 == null)
    return { ok: false, error: '沪深300 多周期收益计算失败', builtAt: Date.now() };

  const amounts = rows.map(r => num(r.f6)).filter(Number.isFinite).sort((a, b) => a - b);
  const boards = rows.map(r => {
    const name = String(r.f14 || '');
    const chg1 = num(r.f3), chg5 = num(r.f109), chg10 = num(r.f160), chg60 = num(r.f24);
    const amount = num(r.f6);
    return {
      code: String(r.f12 || ''), name, category: categoryOf(name),
      chg1, chg5, chg10, chg60,
      ex5: chg5 == null ? null : round(chg5 - bench.r5),
      ex10: chg10 == null ? null : round(chg10 - bench.r10),
      ex60: chg60 == null ? null : round(chg60 - bench.r60),
      amountYi: amount == null ? null : round(amount / 1e8, 1),
      turnover: num(r.f8), up: num(r.f104), down: num(r.f105),
      breadth: (num(r.f104) != null && num(r.f105) != null && (r.f104 + r.f105) > 0)
        ? round(r.f104 / (r.f104 + r.f105) * 100, 0) : null,
      // 横截面拥挤度：当日成交额在全部板块中的分位
      crowdCross: amount == null ? null : round(amounts.filter(v => v <= amount).length / amounts.length * 100, 0)
    };
  }).filter(b => b.code && b.name && b.ex5 != null);

  // 主线分：近期权重更高，对应「正在变强」而非「已经最强」
  for (const b of boards) {
    b.momentum = round(0.5 * b.ex5 + 0.3 * b.ex10 + 0.2 * b.ex60, 2);
  }
  const ranked = boards.slice().sort((a, b) => b.momentum - a.momentum);
  ranked.forEach((b, i) => { b.rank = i + 1; });

  // 东财把一/二/三级行业混排（银行 / 银行Ⅱ / 国有大型银行Ⅲ），同一板块族的多条记录
  // 超额高度相关，会在榜单里重复占位。这里给「罗马数字变体」打上去重标记：
  // baseName 与某个一级板块原名相同的，标 dupOf 并在主线榜里折叠，避免把同一条主线数成三次。
  const baseName = n => String(n || '').replace(/[ⅠⅡⅢⅣ]+$/, '').trim();
  const primaryNames = new Set(boards.map(b => b.name));
  for (const b of boards) {
    const base = baseName(b.name);
    b.family = base;
    b.dupOf = (base !== b.name && primaryNames.has(base)) ? base : null;
  }

  const leaders = ranked.slice(0, 12);
  const laggards = ranked.slice(-8).reverse();

  // 时间序列拥挤度：只对前 12 个主线板块拉 60 日成交额序列
  for (const b of leaders) {
    const bars = await kline('90.' + b.code, 70);
    b.crowdSeries = pctl(bars.map(x => x.amount), bars.length ? bars[bars.length - 1].amount : null);
  }

  function stageOf(b) {
    if (b.ex5 > 0 && b.ex10 > 0 && b.ex60 > 0) return { key: 'trend', label: '趋势主线', note: '5/10/60 日超额同向为正，趋势已被资金确认' };
    if (b.ex5 > 0 && b.ex10 > 0) return { key: 'accel', label: '加速中', note: '近 5/10 日超额为正，中期尚未转正，属正在变强' };
    if (b.ex5 > 0 && b.ex10 <= 0) return { key: 'start', label: '刚转强', note: '仅近 5 日超额为正，需下一周期确认，避免把反弹当主线' };
    if (b.ex5 <= 0 && b.ex60 > 0) return { key: 'fade', label: '高位退潮', note: '中期仍强但近 5 日跑输，超额正在衰减' };
    return { key: 'weak', label: '弱势', note: '近中期超额均为负' };
  }

  const mainlines = leaders.filter(b => !b.dupOf).slice(0, 8).map(b => {
    const st = stageOf(b);
    const crowded = (b.crowdCross != null && b.crowdCross >= 95) || (b.crowdSeries != null && b.crowdSeries >= 90);
    const seriesNote = b.crowdSeries == null ? '自身 60 日分位无数据' :
      b.crowdSeries >= 90 ? '自身 60 日分位 ' + b.crowdSeries + '%（放量）' :
      b.crowdSeries <= 20 ? '自身 60 日分位 ' + b.crowdSeries + '%（缩量）' :
      '自身 60 日分位 ' + b.crowdSeries + '%';
    return {
      ...b, ...st, crowded,
      crowdNote: (crowded ? '⚠ 拥挤度偏高，警惕最后一棒：' : '') +
        '当日成交额横截面分位 ' + (b.crowdCross != null ? b.crowdCross + '%' : '无数据') + '，' + seriesNote
    };
  });

  // 分类聚合：只看各类别主线的数量与平均超额，描述风格倾向
  const cats = {};
  for (const b of boards) {
    const c = cats[b.category] || (cats[b.category] = { category: b.category, n: 0, avgEx5: 0, leaders: 0 });
    c.n++; c.avgEx5 += b.ex5;
    if (b.rank <= 20) c.leaders++;
  }
  const categories = Object.values(cats).map(c => ({
    category: c.category, n: c.n, leaders: c.leaders, avgEx5: round(c.avgEx5 / c.n)
  })).sort((a, b) => b.leaders - a.leaders || b.avgEx5 - a.avgEx5);

  const view = {
    ok: true, builtAt: Date.now(), date: beijing(),
    benchmark: bench,
    counts: { total: boards.length, leaders: leaders.length },
    leaders, laggards, mainlines, categories, boards: ranked,
    methodology: {
      source: '东财行业板块全量列表（翻页取全）+ 沪深300 日 K（同口径前复权）',
      excess: '板块 5/10/60 日涨幅 − 沪深300 同期涨幅 = 相对超额，剔除大盘 beta',
      momentum: '0.5×5日超额 + 0.3×10日超额 + 0.2×60日超额（近期权重更高，识别「正在变强」）',
      crowd: '横截面分位=当日成交额在 496 板块中的分位；时间序列分位=该板块自身近 60 日成交额分位（仅主线板块计算）',
      category: '周期/科技/消费/防御/金融为静态人工分类表，仅用于聚合展示，不参与打分',
      limit: '横截面统计描述，不是收益预测；板块一/二/三级混排，同名多层级可能重复计入，已在板块名与代码上区分'
    },
    disclaimer: '本榜回答「哪些板块此刻相对更强」，不回答「明天会涨多少」。主线判定与拥挤度只是统计描述，需由经验库定格-复盘统计其真实胜率后才能作为判断依据。'
  };

  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(view), 'utf8'); } catch (_) {}
  return view;
}

/** 供重估/叠加模块按行业名查板块强弱（模糊匹配，取匹配度最高且排名最靠前的一条） */
function boardOf(view, industry) {
  if (!view || !view.ok || !industry) return null;
  const key = String(industry).replace(/[ⅠⅡⅢⅣ]+$/, '').replace(/行业|板块|制造|及|与/g, '').trim();
  if (!key) return null;
  const pool = view.boards || view.leaders || [];
  const hits = pool.filter(b => b.name.includes(key) || key.includes(b.name));
  if (!hits.length) return null;
  // 精确同名（或仅差罗马数字层级后缀）优先，避免「银行」被细分「国有大型银行Ⅲ」抢走、
  // 「煤炭」被「煤炭开采」抢走；同优先级的再取排名最靠前者。
  const exact = hits.filter(b => b.name === key || b.family === key);
  const chosen = (exact.length ? exact : hits).sort((a, b) => (a.rank || 999) - (b.rank || 999))[0];
  return chosen;
}

module.exports = { buildStrength, boardOf, categoryOf, kline, retN, CACHE_FILE, TTL };
