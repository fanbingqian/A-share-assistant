'use strict';

/**
 * 板块自身价格周期阶段统计（需求 2：「有些股票在哪个阶段就会涨」）
 *
 * 【为什么要单独做这个模块】
 * 按「事件」聚合三段 CAR 时，季节性事件（迎峰度夏、供暖季、档期）一年只有 1 次，
 * 一年回溯下每个板块只有 1~2 个样本，n<5 根本无法下统计结论。
 * 与其编一个「煤炭在事件前涨」的说法，不如换一个样本充足、可证伪的口径：
 * 直接观察板块自身价格周期，回答「这个板块处在什么阶段时，之后几天更容易有超额」。
 *
 * 【方法（全部用真实日 K 计算，不引入任何预测模型）】
 *  1. 板块与沪深300 各取 280 根前复权日 K，按同日期对齐；
 *  2. 每个交易日 t 计算：ex5(t)=板块近5日收益−基准近5日收益，ex20(t) 同理；
 *  3. 按 ex5/ex20 的符号与相对大小把 t 归入 5 个阶段（启动/加速/高位/退潮/弱势）；
 *  4. 对每 5 个交易日取 1 个不重叠样本，统计该阶段之后 5 日的板块相对超额
 *     的均值、胜率与样本数（避免重叠窗口虚增样本量）；
 *  5. 只在 n≥8 且 |均值|≥1% 时给「该阶段占优」结论，否则显式标注样本不足。
 *
 * 【与事件阶段的区别】
 *  cycle.js 回答「某事件发生前/中/后板块怎么走」；
 *  本模块回答「板块自身处在哪个价格阶段时，后续更容易延续」。
 * 两者共同构成需求 2 的完整答案，输出时分别标注口径。
 *
 * 【诚实边界】
 *  - 约 1 年日 K（280 根），未跨越完整经济周期，结论须由经验库持续验证；
 *  - 输出是历史条件统计，不是预测，不输出「明天会涨」；
 *  - 板块一/二/三级混排，同名族只取精确名或排名最靠前的一条。
 */

const fs = require('node:fs');
const path = require('node:path');
const { kline } = require('./strength');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'phase-cache.json');
const TTL = 6 * 3600 * 1000;

function round(x, n = 2) { if (!Number.isFinite(x)) return null; const p = Math.pow(10, n); return Math.round(x * p) / p; }
function beijing(ts = Date.now()) { return new Date(ts + 8 * 3600000).toISOString().slice(0, 10); }

/** 用户点名 + 系统长期关注的板块。按名称解析，不写死 BK 代码。 */
const FOCUS_BOARDS = [
  '煤炭', '影视院线', '传媒', '电力', '燃气', '半导体', '银行', '证券',
  '酿酒', '光伏设备', '航天航空', '旅游及景区', '游戏', '房地产开发', '贵金属'
];

const STAGES = [
  // 判定有优先级：高位优先单列，避免「累计超额已很大」的样本被加速阶段全部吸走
  { key: 'high', label: '高位（累计超额大）', test: (e5, e20) => e20 > 8 },
  { key: 'start', label: '启动（刚转强）', test: (e5, e20) => e5 > 0 && e20 <= 0 },
  { key: 'accel', label: '加速（趋势确认）', test: (e5, e20) => e5 > 0 && e20 > 0 },
  { key: 'fade', label: '退潮（转弱未破位）', test: (e5, e20) => e5 < 0 && e20 > 0 },
  { key: 'weak', label: '弱势（双负）', test: (e5, e20) => e5 < 0 && e20 <= 0 }
];
function stageOf(e5, e20) {
  for (const s of STAGES) if (s.test(e5, e20)) return s;
  return { key: 'mixed', label: '震荡/其他' };
}

function resolveBoard(strength, name) {
  const pool = (strength && strength.boards) || [];
  const exact = pool.find(b => b.name === name);
  if (exact) return exact;
  const base = name.replace(/[ⅠⅡⅢⅣ]+$/, '');
  const hit = pool.filter(b => b.name.includes(base) || base.includes(b.name))
    .sort((a, b) => (a.rank || 999) - (b.rank || 999))[0];
  return hit || null;
}

/** 对单一板块计算各阶段的前瞻 5 日超额统计 */
async function studyBoard(name, code, benchBars) {
  const bars = await kline('90.' + code, 280);
  if (bars.length < 80) return null;
  // 按日期对齐基准；用 Map 提高查找效率
  const benchByDate = new Map(benchBars.map(b => [b.d, b.c]));
  const aligned = bars.map(b => ({ ...b, bc: benchByDate.get(b.d) })).filter(b => b.bc);
  if (aligned.length < 80) return null;

  const ret = (i, n, key) => {
    if (i - n < 0) return null;
    const a = aligned[i - n], b = aligned[i];
    if (!a || !b || !a[key] || !a.bc) return null;
    return (b[key] / a[key] - 1) * 100 - (b.bc / a.bc - 1) * 100;
  };

  const bucket = {};
  for (const s of STAGES) bucket[s.key] = { key: s.key, label: s.label, vals: [] };
  bucket.mixed = { key: 'mixed', label: '震荡/其他', vals: [] };

  // 每 5 个交易日取 1 个不重叠样本；需保证 t+5 仍在样本内
  for (let i = 25; i < aligned.length - 5; i += 5) {
    const ex5 = ret(i, 5, 'c'), ex20 = ret(i, 20, 'c');
    if (ex5 == null || ex20 == null) continue;
    const st = stageOf(ex5, ex20);
    const fwd = ret(i + 5, 5, 'c');
    if (fwd == null) continue;
    bucket[st.key].vals.push(fwd);
  }

  const stats = Object.values(bucket).map(b => {
    const n = b.vals.length;
    const avg = n ? round(b.vals.reduce((a, c) => a + c, 0) / n) : null;
    const win = n ? round(b.vals.filter(v => v > 0).length / n * 100, 0) : null;
    return { key: b.key, label: b.label, n, avg, win };
  });
  const valid = stats.filter(s => s.n >= 8 && s.avg != null && Math.abs(s.avg) >= 1);
  const best = valid.length ? valid.slice().sort((a, b) => b.avg - a.avg)[0] : null;
  const worst = valid.length ? valid.slice().sort((a, b) => a.avg - b.avg)[0] : null;
  const totalN = stats.reduce((a, b) => a + b.n, 0);

  return {
    name, code, bars: aligned.length, samples: totalN, stats,
    best: best ? { ...best, conclusion: '历史上「' + best.label + '」之后 5 日平均相对超额 ' + best.avg + '%，胜率 ' + best.win + '%（n=' + best.n + '）' } : null,
    worst: worst ? { ...worst, conclusion: '历史上「' + worst.label + '」之后 5 日平均相对超额 ' + worst.avg + '%，胜率 ' + worst.win + '%（n=' + worst.n + '）' } : null,
    qualified: !!best,
    note: best ? null : '各阶段有效样本均 <8 或平均超额绝对值 <1%，不做阶段占优结论'
  };
}

async function buildPhase(opts = {}) {
  const force = !!opts.force;
  // 观察池行业会随评分变化，缓存必须与「本次研究的行业集合」绑定，
  // 否则新进池的行业永远拿不到阶段数据（叠加因子会恒为 0）。
  const industriesKey = (opts.industries || []).filter(Boolean).map(String)
    .filter((v, i, a) => a.indexOf(v) === i).sort().join(',');
  if (!force && fs.existsSync(CACHE_FILE)) {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (c.ok && Date.now() - (c.builtAt || 0) < TTL && c.industriesKey === industriesKey) return c;
    } catch (_) {}
  }

  const strength = opts.strength || null;
  const benchBars = await kline('1.000300', 280);
  if (benchBars.length < 80) return { ok: false, error: '沪深300 日线不足，无法计算相对超额', builtAt: Date.now() };

  // 关注名单 + 当前主线板块 + 观察池实际涉及的行业（动态补齐，否则叠加因子永远无数据）。
  // 上限控制在 ~34 个板块，避免请求量失控。
  const names = FOCUS_BOARDS.slice();
  for (const m of (strength && strength.mainlines) || []) {
    if (!m.dupOf && !names.includes(m.name)) names.push(m.name);
  }
  for (const ind of opts.industries || []) {
    if (ind && !names.includes(ind)) names.push(String(ind));
  }
  const seen = new Set();
  const boards = [];
  for (const name of names.slice(0, 34)) {
    const b = resolveBoard(strength, name);
    if (!b || seen.has(b.code)) continue;
    seen.add(b.code);
    const r = await studyBoard(b.name, b.code, benchBars);
    if (r) boards.push(r);
  }

  const qualified = boards.filter(b => b.qualified)
    .sort((a, b) => b.best.avg - a.best.avg);
  const byStage = {};
  for (const b of boards) {
    for (const s of b.stats) {
      const g = byStage[s.key] || (byStage[s.key] = { key: s.key, label: s.label, sum: 0, n: 0, boards: 0 });
      if (s.n >= 8) { g.sum += s.avg * s.n; g.n += s.n; g.boards++; }
    }
  }
  const stageAggregate = Object.values(byStage).map(g => ({
    ...g, avg: g.n ? round(g.sum / g.n) : null
  })).sort((a, b) => (b.avg || -99) - (a.avg || -99));

  const view = {
    ok: true, builtAt: Date.now(), date: beijing(), industriesKey,
    boards, qualified, stageAggregate,
    counts: { boards: boards.length, qualified: qualified.length, samples: boards.reduce((a, b) => a + b.samples, 0) },
    methodology: {
      source: '板块与沪深300 前复权日 K（各 280 根），按日期对齐',
      excess: '板块 N 日收益 − 沪深300 同期收益 = 相对超额',
      stage: '启动 ex5>0 且 ex20≤0；加速 ex5>0 且 ex20>0 且 ex5>ex20/4；高位 ex20>8；退潮 ex5<0 且 ex20>0；弱势双负',
      sampling: '每 5 个交易日取 1 个不重叠样本，统计其后 5 日相对超额，避免重叠窗口虚增样本',
      threshold: '仅当 n≥8 且 |平均超额|≥1% 才给「阶段占优」结论，否则显式标注样本不足',
      focus: '关注板块为固定名单 + 当前主线榜 + 观察池实际行业（按名称解析 BK 代码，不写死）'
    },
    disclaimer: '历史条件统计，不是预测。280 根日 K 约覆盖 1 年，未跨越完整经济周期；阶段划分是口径定义而非市场公认标准。结论须由经验库定格-复盘持续验证，不构成投资建议。'
  };

  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(view), 'utf8'); } catch (_) {}
  return view;
}

module.exports = { buildPhase, studyBoard, stageOf, FOCUS_BOARDS, CACHE_FILE, TTL };
