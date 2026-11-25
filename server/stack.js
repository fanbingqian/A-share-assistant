'use strict';

/**
 * 多因素叠加识别（需求 3）
 *
 * 【要回答的问题】
 * 当一只股票同时被多个独立维度指向同一方向时（板块主线 + 市值重估 + 周期阶段 +
 * 涨停结构 + 事件 + 风格 + 资金 + 避险 + 外围），系统要能识别这种「共振」、
 * 也要能识别「信号互相打架」的分歧，而不是让各修正项简单线性相加。
 *
 * 【最重要的设计决策：叠加不改分】
 * 现有 stocks.js 已把 5 项方向性修正用 ±22 组合上限抑制共线放大。
 * 如果再因为「因子多」额外加分，就是「设计胜率」——用主观设定替代统计验证。
 * 因此本模块只做三件事：
 *   ① 把每只标的身上真实命中的因子逐条列出（含数值与来源，不做推测）；
 *   ② 判定叠加形态（共振 / 部分共振 / 分歧 / 单因子 / 无信号）并给出可证伪的指纹；
 *   ③ 把指纹写入 journal 定格存证，作为第 7 个复盘维度，
 *      由「定格 → T+1 复盘 → n≥8 归纳 → 人工审核」统计裁决共振组是否真有超额。
 * 叠加维度的经验只产出观察结论，不自动回流评分（observeOnly）。
 *
 * 【反幻觉】
 *  - 每个因子都来自系统已采集的真实数据；无数据的因子记 dir=0 且不算入命中数；
 *  - 不编造「共振胜率」——那是复盘统计才回答的问题；
 *  - 分歧形态明确标注「多空信号并存，置信度应下调」，但不擅自改 stocks 的 confidence。
 */

const { boardOf } = require('./strength');

function round(x, n = 2) { if (!Number.isFinite(x)) return null; const p = Math.pow(10, n); return Math.round(x * p) / p; }
function beijing(ts = Date.now()) { return new Date(ts + 8 * 3600000).toISOString().slice(0, 10); }

const FACTOR_DEFS = {
  strength: '板块相对强弱（当前主线）',
  revaluation: '市值重估事件（重组/并购/回购）',
  cycleEvent: '周期事件阶段（事件前/中/后）',
  pricePhase: '板块价格周期阶段（启动/加速/高位/退潮）',
  limitStructure: '涨停结构（板型/连板/封单）',
  eventPolarity: '公司事件方向',
  styleTailwind: '市值风格顺风/逆风',
  capitalFlow: '资金主体倾向',
  riskoffEnv: '避险环境（全局）',
  overseas: '外围股市（全局）'
};

/* --------------------------- 单因子提取（全部真实数值） --------------------------- */
function fStrength(it, ctx) {
  const b = boardOf(ctx.strength, it.industry);
  if (!b || b.ex5 == null) return { key: 'strength', label: FACTOR_DEFS.strength, dir: 0, value: '无板块强弱数据', source: 'strength.js' };
  const dir = b.ex5 > 0 && (b.rank || 999) <= 40 ? 1 : (b.ex5 < -2 || (b.rank || 0) > 400) ? -1 : 0;
  return {
    key: 'strength', label: FACTOR_DEFS.strength, dir,
    value: b.name + ' 5日超额 ' + b.ex5 + '%，排名 ' + (b.rank || '—') + '/' + (ctx.strength.counts ? ctx.strength.counts.total : '—'),
    crowded: !!b.crowded, source: 'strength.js · 板块横截面'
  };
}

function fRevaluation(it, ctx) {
  const list = (ctx.valuation && ctx.valuation.candidates) || [];
  const hit = list.find(c => c.code === it.code);
  if (!hit) return { key: 'revaluation', label: FACTOR_DEFS.revaluation, dir: 0, value: '非重估候选', source: 'valuation.js' };
  const dir = hit.verdict === 'veto' ? -1 : (hit.verdict === 'ready' || hit.verdict === 'partial') ? 1 : 0;
  return {
    key: 'revaluation', label: FACTOR_DEFS.revaluation, dir,
    value: hit.typeLabel + '｜' + hit.verdictLabel + '（条件齐备度 ' + hit.score + '/100，阶段：' + hit.stageLabel + '）',
    source: 'valuation.js · 公告标题推断'
  };
}

function fCycleEvent(it, ctx) {
  const alerts = (ctx.cycle && ctx.cycle.boardAlerts) || [];
  const bp = (ctx.cycle && ctx.cycle.boardPhase) || [];
  const board = boardOf(ctx.strength, it.industry);
  const name = board ? board.name : null;
  const hit = name ? alerts.find(a => a.board === name) : null;
  if (hit) {
    return {
      key: 'cycleEvent', label: FACTOR_DEFS.cycleEvent, dir: hit.avg > 0 ? 1 : 0,
      value: hit.event + ' ' + hit.daysTo + ' 天后，' + name + ' 历史占优阶段「' + hit.stage + '」平均超额 +' + hit.avg + '%（n=' + hit.n + '）',
      source: 'cycle.js · 事件三段 CAR'
    };
  }
  const q = name ? bp.find(x => x.board === name && x.qualified) : null;
  if (q) return { key: 'cycleEvent', label: FACTOR_DEFS.cycleEvent, dir: 0, value: name + ' 历史在' + q.best.label + '占优（+' + q.best.avg + '%），但当前无临近事件', source: 'cycle.js' };
  return { key: 'cycleEvent', label: FACTOR_DEFS.cycleEvent, dir: 0, value: '无该板块的事件阶段结论（样本不足亦不推断）', source: 'cycle.js' };
}

function fPricePhase(it, ctx) {
  const board = boardOf(ctx.strength, it.industry);
  const boards = (ctx.phase && ctx.phase.boards) || [];
  // phase 的研究名单含「观察池实际行业」，其名称可能与 strength 的精确板块名不同，
  // 故先按板块名精确匹配，再按行业名做包含匹配兜底（仍只在真实已有研究的板块中查找）。
  let hit = board ? boards.find(b => b.name === board.name) : null;
  if (!hit && it.industry) {
    const key = String(it.industry).replace(/[ⅠⅡⅢⅣ]+$/, '').trim();
    hit = boards.find(b => b.name === key) ||
      boards.filter(b => b.name.includes(key) || key.includes(b.name))
        .sort((a, b) => b.samples - a.samples)[0] || null;
  }
  const ref = board || hit;
  if (!hit) return { key: 'pricePhase', label: FACTOR_DEFS.pricePhase, dir: 0, value: '无该板块价格周期阶段数据', source: 'phase.js' };
  // 当前板块所处阶段由 strength 的 ex5/ex10 代理判定（与 phase.js 口径一致）
  const ex5 = ref && ref.ex5, ex10 = ref && ref.ex10;
  const cur = (ex5 > 0 && ex10 > 0) ? 'accel'
    : (ex5 > 0 && ex10 <= 0) ? 'start'
    : (ex5 < 0 && ex10 > 0) ? 'fade' : 'weak';
  const s = hit.stats.find(x => x.key === cur);
  const dir = s && s.n >= 8 && s.avg >= 1 ? 1 : s && s.n >= 8 && s.avg <= -1 ? -1 : 0;
  return {
    key: 'pricePhase', label: FACTOR_DEFS.pricePhase, dir,
    value: hit.name + ' 当前近似处于「' + (s ? s.label : cur) + '」，该阶段历史后 5 日平均超额 ' +
      (s ? s.avg : '无数据') + '%（n=' + (s ? s.n : 0) + '）',
    source: 'phase.js · 280 根日 K 不重叠窗口'
  };
}

function fLimit(it) {
  const g = it.groups || {};
  const adj = Number(g.limitAdjust) || 0;
  const dir = adj >= 3 ? 1 : adj <= -3 ? -1 : 0;
  return {
    key: 'limitStructure', label: FACTOR_DEFS.limitStructure, dir,
    value: '涨停结构修正 ' + (adj > 0 ? '+' : '') + adj + ' 分｜板型 ' + (g.boardLabel || '—') +
      '｜连板 ' + (g.boards || 0) + '｜追高风险 ' + (g.chaseRisk == null ? '—' : g.chaseRisk),
    source: 'stocks.js / limitup.js'
  };
}

function fEvent(it, ctx) {
  const g = it.groups || {};
  const adj = Number(g.eventAdjust) || 0;
  const pol = it.eventPolarity || null;
  const dir = adj >= 3 ? 1 : adj <= -3 ? -1 : 0;
  return {
    key: 'eventPolarity', label: FACTOR_DEFS.eventPolarity, dir,
    value: '事件修正 ' + (adj > 0 ? '+' : '') + adj + ' 分' + (pol ? '｜' + pol + '：' + (it.eventLabel || '—') : '｜无重点事件'),
    source: 'events.js · 公司公告'
  };
}

function fStyle(it, ctx) {
  const g = it.groups || {};
  const adj = Number(g.styleAdjust) || 0;
  const dir = adj >= 3 ? 1 : adj <= -3 ? -1 : 0;
  return {
    key: 'styleTailwind', label: FACTOR_DEFS.styleTailwind, dir,
    value: '市值风格修正 ' + (adj > 0 ? '+' : '') + adj + ' 分｜所属层 ' + (it.bucket || (g.weights && g.weights.bucket) || '—') +
      '｜当前主导 ' + ((ctx.style && ctx.style.dominant) || '—'),
    source: 'marketStyle.js'
  };
}

function fCapital(it, ctx) {
  const t = ctx.flow && ctx.flow.tilt;
  if (!t) return { key: 'capitalFlow', label: FACTOR_DEFS.capitalFlow, dir: 0, value: '资金主体倾向无数据', source: 'flow.js' };
  const bucket = it.bucket || (it.groups && it.groups.weights && it.groups.weights.bucket) || null;
  const top = t.top || null, bottom = t.bottom || null;
  let dir = 0;
  if (bucket && bucket === top) dir = 1;
  else if (bucket && bucket === bottom) dir = -1;
  const txt = t.text || (typeof t === 'string' ? t : '');
  return {
    key: 'capitalFlow', label: FACTOR_DEFS.capitalFlow, dir,
    value: '该股所属「' + (bucket || '未分层') + '」层｜近 20 日资金最偏好 ' + (top || '—') +
      '、最弱 ' + (bottom || '—') + (dir ? (dir > 0 ? ' → 顺风' : ' → 逆风') : ' → 中性') +
      '｜' + String(txt).slice(0, 60),
    source: 'flow.js · 龙虎榜按市值层净买'
  };
}

function fRiskoff(it, ctx) {
  const r = ctx.riskoff || null;
  if (!r || !r.form) return { key: 'riskoffEnv', label: FACTOR_DEFS.riskoffEnv, dir: 0, value: '避险识别无数据', source: 'riskoff.js' };
  const form = String(r.form);
  const severe = /L3|L4/.test(form);
  // L2 风格避险是「资金从小市值搬到大市值/防御」：对大盘是顺风、对微盘是逆风，
  // 按个股市值层区分，比一刀切记为中性更贴合七项证据链的结论。
  const bucket = it.bucket || (it.groups && it.groups.weights && it.groups.weights.bucket) || null;
  let dir = 0;
  if (severe) dir = -1;
  else if (/L2/.test(form) && bucket) dir = (bucket === 'large' || bucket === 'mid') ? 1 : (bucket === 'micro' || bucket === 'small') ? -1 : 0;
  return {
    key: 'riskoffEnv', label: FACTOR_DEFS.riskoffEnv, dir,
    value: form + '｜' + (r.answer || '').slice(0, 42) +
      (dir && !severe ? '｜该股 ' + bucket + ' 层' + (dir > 0 ? '为承接方' : '为流出方') : ''),
    global: severe, source: 'riskoff.js · 七项证据链'
  };
}

function fOverseas(ctx) {
  const qs = (ctx.quotes && ctx.quotes.filter) ? ctx.quotes.filter(q => q.group === 'overseas' && q.changePct != null) : [];
  const us = qs.filter(q => /道琼斯|标普|纳斯达克/.test(q.short || ''));
  if (us.length < 2) return { key: 'overseas', label: FACTOR_DEFS.overseas, dir: 0, value: '美股报价不足 2 个', source: 'sources.js · 外围股指' };
  const avg = round(us.reduce((a, b) => a + b.changePct, 0) / us.length);
  return {
    key: 'overseas', label: FACTOR_DEFS.overseas, dir: avg <= -1.5 ? -1 : avg >= 1.5 ? 1 : 0,
    value: '美股三指数均值 ' + avg + '%（' + us.map(q => q.short + ' ' + q.changePct + '%').join(' / ') + '）',
    global: true, source: 'sources.js · 外围股指'
  };
}

/* ------------------------------ 叠加形态判定 ------------------------------ */
function classifyStack(factors) {
  const pos = factors.filter(f => f.dir > 0);
  const neg = factors.filter(f => f.dir < 0);
  const neutral = factors.filter(f => f.dir === 0);
  let form, label, note;
  if (pos.length >= 4 && neg.length === 0) {
    form = 'resonance'; label = '多重共振';
    note = pos.length + ' 个独立维度同向为正、无反向信号。注意：共振是「信号一致性」描述，不代表胜率更高，须由经验库复盘统计验证。';
  } else if (pos.length >= 3 && pos.length > neg.length) {
    form = 'partial'; label = '部分共振';
    note = pos.length + ' 个正向 / ' + neg.length + ' 个反向，方向偏多但仍存在分歧。';
  } else if (pos.length === 2 && neg.length === 0) {
    form = 'lean'; label = '弱共振（偏多）';
    note = '2 个维度同向为正、无反向信号，但交叉验证不足，属弱一致，不宜按共振对待。';
  } else if (pos.length >= 1 && neg.length >= 1) {
    form = 'divergence'; label = '信号分歧';
    note = '多空信号并存（' + pos.length + ' 正 / ' + neg.length + ' 负），此类标的判断置信度应下调，不建议仅凭评分决策。';
  } else if (neg.length >= 2 && pos.length === 0) {
    form = 'bearish'; label = '多重承压';
    note = neg.length + ' 个维度同向为负，风险叠加。';
  } else if (pos.length + neg.length <= 1) {
    form = 'single'; label = '单因子/弱信号';
    note = '独立命中因子 ≤1，缺乏交叉验证。';
  } else {
    form = 'mixed'; label = '混合';
    note = pos.length + ' 正 / ' + neg.length + ' 负 / ' + neutral.length + ' 中性，未形成一致方向。';
  }
  const fingerprint = (pos.length ? '+' : '') + pos.map(f => f.key).sort().join('+') +
    (neg.length ? ' / -' + neg.map(f => f.key).sort().join('-') : '');
  return {
    form, label, note, fingerprint,
    posCount: pos.length, negCount: neg.length, neutralCount: neutral.length,
    alignment: (pos.length + neg.length) ? Math.round(pos.length / (pos.length + neg.length) * 100) : null,
    confidenceHint: form === 'divergence' ? '下调' : form === 'resonance' ? '待验证' : '维持'
  };
}

/* ------------------------------ 主构建 ------------------------------ */
function buildStack(opts = {}) {
  const ctx = opts.ctx || {};
  const items = (ctx.stocks && ctx.stocks.items) || [];
  const rows = items.map(it => {
    const factors = [
      fStrength(it, ctx), fRevaluation(it, ctx), fCycleEvent(it, ctx), fPricePhase(it, ctx),
      fLimit(it), fEvent(it, ctx), fStyle(it, ctx), fCapital(it, ctx),
      fRiskoff(it, ctx), fOverseas(ctx)
    ];
    const stack = classifyStack(factors);
    return {
      code: it.code, name: it.name, industry: it.industry,
      score: it.score, signal: it.signal,
      ...stack, factors,
      // 写入 journal 定格存证的精简字段（避免把整份因子列表塞进 JSONL）
      journalTag: { form: stack.form, label: stack.label, fingerprint: stack.fingerprint, pos: stack.posCount, neg: stack.negCount }
    };
  });

  const byForm = {};
  for (const r of rows) byForm[r.form] = (byForm[r.form] || 0) + 1;
  const top = rows.slice().sort((a, b) => b.posCount - a.posCount || a.negCount - b.negCount || (b.score || 0) - (a.score || 0));

  return {
    ok: true, builtAt: Date.now(), date: beijing(),
    items: rows, top: top.slice(0, 12), byForm,
    counts: {
      total: rows.length, resonance: byForm.resonance || 0, partial: byForm.partial || 0,
      divergence: byForm.divergence || 0, bearish: byForm.bearish || 0
    },
    // 全局因子展示用「未分层」口径，避免在无个股上下文时误判方向
    globalFactors: [fRiskoff({}, ctx), fOverseas(ctx)],
    methodology: {
      factors: '10 个独立维度：板块强弱 / 市值重估 / 周期事件阶段 / 板块价格阶段 / 涨停结构 / 公司事件 / 市值风格 / 资金主体 / 避险环境 / 外围股市',
      dir: '每个因子依真实数值判 +1 / -1 / 0；无数据记 0 且不计入命中数，绝不用猜测填充',
      form: '共振=正向≥4且无反向；部分共振=正向≥3且多于反向；弱共振=2正向且无反向；分歧=有正有负；多重承压=负向≥2且无正向；其余为单因子/混合',
      noScoreChange: '叠加结论不修改任何评分或修正项。共振是否真提升胜率，由 journal 定格→T+1 复盘→n≥8 归纳→人工审核统计裁决；该维度经验仅作观察，不自动回流',
      fingerprint: '指纹记录同向 / 反向因子组合，用于复盘分组；形态用于粗分组以保证样本量可达 n≥8'
    },
    disclaimer: '叠加是「多个维度恰好同向」的描述，不是概率、不是胜率、不是买入建议。历史上共振组是否跑赢，须由经验库复盘统计回答；在此之前不因共振加分。'
  };
}

module.exports = { buildStack, classifyStack, FACTOR_DEFS };
