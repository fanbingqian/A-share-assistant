'use strict';

/**
 * daily.js — 「每日行情」模块（v2）
 *
 * 三块内容：
 *   ① 两市预测与监控：量能比前一交易日（缩/放）、整体动力、预测今日涨跌方向 + 文字依据（Hermes）
 *   ② 板块监控：同花顺细分行业板块资金进出/持续性，提出长增长板块（复用 strength + 资金流）
 *   ③ 选股三类（用户定义口径）：热度/独立行情牛股 / 趋势股 / 超跌长下影反弹股
 *      由 screener.js 生成 hot-screen / trend-screen / rebound-screen，本模块只读取展示。
 *
 * 【纪律】
 *   - 预测是「依据数据 + 可证伪条件」的推测，不是点位承诺；由 Hermes 生成文字依据。
 *   - 所有数值来自既有确定性缓存与 screener 生成器，本模块不编造数字。
 *   - 智能体输出禁买卖建议（hermes.js 网关统一拦截），不改任何既有评分。
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data');
const F_MARKET = path.join(DATA, 'market-style.json');
const F_STRENGTH = path.join(DATA, 'strength-cache.json');
const F_LIMIT = path.join(DATA, 'limitup-cache.json');
const F_MA5 = path.join(DATA, 'ma5-screen.json');
const F_TREND = path.join(DATA, 'trend-screen.json');
const F_REBOUND = path.join(DATA, 'rebound-screen.json');
const F_HOT = path.join(DATA, 'hot-screen.json');
const F_INSIGHT = path.join(DATA, 'pick-insight.json');

function readJson(file) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return null;
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function bjHM(ts = Date.now()) { return new Date(ts + 8 * 3600e3).toISOString().slice(11, 16); }

/* ------------------------------ ① 两市监控与预测 ------------------------------ */

/**
 * 两市监控视图：量能状态 + 涨跌 + 宽度 + 动力结论。
 * 数据全部来自 market-style.json（由既有 marketStyle 模块定时计算）。
 */
function marketMonitor() {
  const ms = readJson(F_MARKET);
  if (!ms || !ms.volume) return { ok: false, note: '两市量能数据尚未就绪，等待 marketStyle 首次计算' };
  const v = ms.volume;
  const amountYi = v.totalAmountYi;
  const ratio = v.ratio20;
  const state = v.state || (ratio == null ? '未知' : ratio >= 1.05 ? '放量' : ratio <= 0.95 ? '缩量' : '平量');
  const breadth = v.breadth || {};
  // 整体动力：量能方向 × 价格方向 × 宽度（纯规则描述，不用 LLM）
  const priceUp = (v.indexPct || 0) > 0;
  const volUp = /放/.test(state);
  const upRatio = breadth.upRatio;
  let momentum;
  if (volUp && priceUp) momentum = '价涨量增 · 上行动能较足';
  else if (volUp && !priceUp) momentum = '价跌量增 · 抛压或换手加剧';
  else if (!volUp && priceUp) momentum = '价涨量缩 · 上行动能趋弱/惜售';
  else momentum = '价跌量缩 · 观望或缩量整理';
  if (upRatio != null) momentum += '（上涨占比 ' + upRatio + '%）';
  return {
    ok: true,
    at: bjHM(ms.generatedAt),
    tradingDate: ms.tradingDate,
    trading: ms.trading,
    amountYi, ma20Yi: v.ma20Yi, ratio20: ratio,
    changePct: v.changePct, state,
    indexPct: v.indexPct, shPct: v.shPct, szPct: v.szPct,
    priceVolume: v.priceVolume || momentum,
    momentum,
    breadth: { up: breadth.up, down: breadth.down, flat: breadth.flat, upRatio },
    // 15 分钟汇报由 server 定时器把本视图推到告警流 + SSE（见 server.js v2 定时器）
    reportHint: '每 15 分钟对比当前量能与前一交易日同期/上一交易日全天，输出缩量/放量与整体动力'
  };
}

/** 两市预测：把监控事实交给 Hermes，生成方向倾向 + 文字依据 + 证伪条件 */
async function marketForecast(cfg, hermes) {
  const m = marketMonitor();
  if (!m.ok) return { ok: false, note: m.note };
  const q = '基于以下两市监控事实（数字均由程序计算，禁止编造新数字），给出今日涨跌方向倾向与文字依据。' +
    '要求：1) 只说「偏强/偏弱/中性/需等待确认」，不预测点位和概率；2) 依据必须引用下面给出的数字；' +
    '3) 给出明确的证伪条件（看到什么就说明判断错了）；4) 末尾提醒这是推测不是建议。\n\n' +
    JSON.stringify({
      成交额亿: m.amountYi, '20日均量亿': m.ma20Yi, 量比20: m.ratio20,
      量能状态: m.state, 量能环比: m.changePct + '%',
      指数涨跌: m.indexPct + '%', 沪指: m.shPct + '%', 深成: m.szPct + '%',
      上涨占比: m.breadth.upRatio + '%', 动力描述: m.momentum,
      交易日: m.tradingDate
    });
  const ai = await hermes.ask(cfg, 'daily-market', q, { task: '两市方向预测与依据', maxTokens: 900, temperature: 0.3 });
  return { ok: true, monitor: m, forecast: ai.ok ? ai.text : null, forecastError: ai.ok ? null : (ai.error || '生成失败'), backend: ai.backend };
}

/* ------------------------------ ② 板块监控 ------------------------------ */

/**
 * 板块视图：复用 strength-cache（同花顺细分行业板块，含资金/动量/宽度），
 * 输出资金持续流入与「长增长」候选（相对沪深300 的 10/60 日超额为正 + 宽度高 + 拥挤度未极端）。
 */
function sectorMonitor() {
  const st = readJson(F_STRENGTH);
  if (!st || !Array.isArray(st.leaders)) return { ok: false, note: '板块强度数据尚未就绪，等待 strength 首次计算' };
  const leaders = st.leaders.map(x => ({
    code: x.code, name: x.name, family: x.family, category: x.category,
    chg1: x.chg1, chg5: x.chg5, chg10: x.chg10, chg60: x.chg60,
    ex5: x.ex5, ex10: x.ex10, ex60: x.ex60,
    amountYi: x.amountYi, breadth: x.breadth, crowdCross: x.crowdCross,
    momentum: x.momentum
  }));
  // 长增长候选：中期超额为正 + 宽度强 + 拥挤度不过热（<95）
  const longGrowth = leaders.filter(x =>
    (x.ex10 || 0) > 0 && (x.ex60 || 0) > 0 && (x.breadth || 0) >= 60 && (x.crowdCross || 0) < 95
  ).slice(0, 8);
  // 资金持续流入的近似：5日与10日相对强度同为正（strength 模块已做基准剥离）
  const sustained = leaders.filter(x => (x.ex5 || 0) > 0 && (x.ex10 || 0) > 0).slice(0, 10);
  return {
    ok: true,
    at: bjHM(st.builtAt), date: st.date,
    benchmark: st.benchmark,
    counts: st.counts,
    leaders: leaders.slice(0, 20),
    sustained,
    longGrowth,
    note: '板块来自同花顺细分行业分类；exN=相对沪深300 的 N 日超额收益（%），是相对强弱不是涨跌预测；资金持续性以多周期超额同向近似，真实主力净流入需接资金流数据源（见缺口清单）。'
  };
}

/** 板块资金/持续性智能体解读 */
async function sectorBrief(cfg, hermes) {
  const s = sectorMonitor();
  if (!s.ok) return { ok: false, note: s.note };
  const q = '基于以下同花顺细分行业板块数据（数字均由程序计算，禁止编造），分析：' +
    '1) 哪些板块呈现资金持续流入迹象、依据是什么；2) 哪些具备中长期相对强势（长增长）特征；' +
    '3) 每个判断给出证伪条件；4) 提示拥挤度过高的风险。不要给买卖建议。\n\n' +
    JSON.stringify({ 基准: s.benchmark, 持续流入候选: s.sustained, 长增长候选: s.longGrowth, 领涨板块: s.leaders.slice(0, 10) });
  const ai = await hermes.ask(cfg, 'daily-sector', q, { task: '板块资金持续性与长增长分析', maxTokens: 1200 });
  return { ok: true, sectors: s, analysis: ai.ok ? ai.text : null, analysisError: ai.ok ? null : (ai.error || '生成失败') };
}

/* ------------------------------ ③ 三类选股（用户定义口径） ------------------------------ */

/**
 * 三类选股统一读 screener.js 的生成器输出：
 *   hot-screen.json / trend-screen.json / rebound-screen.json
 * 生成器不存在时返回 ok:false + 明确提示，不回退到旧口径、不编造。
 */
function readScreen(file, label) {
  const d = readJson(file);
  if (!d || !Array.isArray(d.items)) {
    return { ok: false, note: label + '数据尚未生成，请先运行选股生成器（/api/v2/screener/run）' };
  }
  return {
    ok: true,
    at: d.generatedAt,
    source: d.source,
    rule: d.rule,
    note: d.note || null,
    universe: d.universe,
    marketRet5: d.marketRet5 != null ? d.marketRet5 : null,
    scoring: d.scoring || null,
    focus: Array.isArray(d.focus) ? d.focus : [],
    items: d.items
  };
}

/** 第一类：热度 / 独立行情牛股 */
function pickHotIndependent() {
  const r = readScreen(F_HOT, '独立行情热度');
  if (r.ok && !r.items.length) r.note = '本轮候选池中无标的满足「相对行业与大盘独立走强 + 有热度证据」；这是筛选结果，不是数据缺失。';
  return r;
}

/** 第二类：趋势股（连续3日不破MA5，或5日内≤1日破且期间创新高） */
function pickTrend() {
  const r = readScreen(F_TREND, '趋势股');
  if (r.ok) r.days = 5;
  return r;
}

/** 第三类：强势反弹股（超跌 + 尾盘长下影） */
function pickRebound() {
  const r = readScreen(F_REBOUND, '强势反弹股');
  if (r.ok && !r.items.length) r.note = '本轮候选池中无标的同时满足超跌与长下影；这是筛选结果，不是数据缺失。';
  return r;
}

/* 兼容旧调用名：pickHotLimit / pickResilient / pickDefensive 仍可调用，但口径已改为用户定义 */
function pickHotLimit() { return pickHotIndependent(); }
function pickResilient() { return pickTrend(); }
function pickDefensive() { return pickRebound(); }

/**
 * 统一选股板块：三类选股合并到一个板块内，每只股票只标注所属类别（kind/kindLabel）。
 * 行业、上涨驱动线索、领跑/跟随角色来自 pick-insight.json（由 screener 刷新后生成）。
 * 无 insight 时降级为原始三类合并，仍保证前端有数据可读。
 */
function picksUnified() {
  const insight = readJson(F_INSIGHT);
  if (insight && Array.isArray(insight.items)) {
    const items = insight.items.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
    return {
      ok: true,
      at: insight.generatedAt,
      source: 'pick-insight（行业/上涨线索/领跑判定）',
      note: insight.note,
      leaders: insight.leaders || [],
      followers: insight.followers || {},
      items,
      focus: items.filter(x => x.role === 'leader').slice(0, 10).map(x => ({
        code: x.code, name: x.name, score: x.score, industry: x.industry,
        leader: true, reason: x.driverSummary
      }))
    };
  }
  // 降级：无 insight 时把三类原始 items 合并并标注类别
  const groups = [
    { key: 'hot', label: '热度/独立行情', g: pickHotIndependent() },
    { key: 'trend', label: '趋势', g: pickTrend() },
    { key: 'rebound', label: '强势反弹', g: pickRebound() }
  ];
  const items = [];
  for (const x of groups) for (const it of (x.g.items || [])) {
    items.push({ ...it, kind: x.key, kindLabel: x.label, role: 'standalone', industry: it.industry || null });
  }
  items.sort((a, b) => (b.score || 0) - (a.score || 0));
  return { ok: true, at: bjHM(), source: '降级合并（pick-insight 未生成）', note: '上涨原因/领跑判定待选股刷新后生成', items, leaders: [], followers: {} };
}

function picks() {
  const hot = pickHotIndependent();
  const trend = pickTrend();
  const rebound = pickRebound();
  // 四类量化选股 + 次日双池（strategy.json，由 screener 刷新 / 定时任务生成）
  let strategyData = null;
  try { strategyData = require('./strategy').latest(); } catch (_) {}
  return {
    ok: true,
    at: bjHM(),
    unified: picksUnified(),
    fourClass: strategyData ? strategyData.fourClass : null,
    pools: strategyData ? strategyData.pools : null,
    hotIndependent: hot,
    trend,
    rebound,
    // 兼容旧前端字段
    hotLimit: hot,
    resilient: trend,
    defensive: rebound
  };
}

/** 三类选股的智能体总览（选股逻辑解读，不改分） */
async function picksBrief(cfg, hermes) {
  const p = picks();
  const q = '基于以下三类选股的结构化结果（数字均由程序计算，禁止编造），用简洁语言说明每类筛选当前呈现的特征与风险，' +
    '并提示每类的适用市场环境。不要给买卖建议，不要推荐具体标的。\n\n' + JSON.stringify({
    独立行情热度: { 数量: p.hotIndependent.items && p.hotIndependent.items.length, 规则: p.hotIndependent.rule },
    趋势股: { 数量: p.trend.items && p.trend.items.length, 规则: p.trend.rule },
    强势反弹股: { 数量: p.rebound.items && p.rebound.items.length, 规则: p.rebound.rule }
  });
  const ai = await hermes.ask(cfg, 'daily-picks', q, { task: '三类选股结构解读', maxTokens: 900 });
  return { ok: true, picks: p, analysis: ai.ok ? ai.text : null, analysisError: ai.ok ? null : (ai.error || '生成失败') };
}

module.exports = {
  marketMonitor, marketForecast,
  sectorMonitor, sectorBrief,
  pickHotIndependent, pickTrend, pickRebound,
  pickHotLimit, pickResilient, pickDefensive, picks, picksBrief
};
