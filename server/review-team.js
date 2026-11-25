'use strict';

/* ==========================================================================
 * review-team.js — 盘后复盘专家团（只读 + 按需智能体叙述）
 *
 * 用户规格 #6：
 *   「在项目里需要智能体，但不是用来做预判的，预判主要采用量化评估；
 *     他们是作为专家团队做当日选取的重点关注股票和我们已经买入的股票
 *     进行盘后复盘（实时复盘要结合当下新闻情况）。」
 *
 * 【职责边界 · 硬约束】
 *   - 预判 / 评分 / 选股全部由既有确定性量化模块完成，本模块不改动任何分数；
 *   - 智能体只在用户点击「盘后复盘」时按需调用，且只叙述「已经发生的事实」；
 *   - 四个专家角色：技术面 / 资金面 / 消息面 / 风控，各自只输出可核验事实；
 *   - 实时复盘注入「当下真实新闻」，新闻来自内存 latest.news / news-pulse 快照；
 *   - 智能体不可用（Hermes 未就绪、无 Key、超时）→ 降级为纯程序结构化复盘，
 *     明确标注 degraded，绝不编造模型输出。
 *
 * 【反幻觉纪律】
 *   - 所有事实取自本地真实快照，缺数据写「不可得」，不填 0 / 不臆测；
 *   - 不写「因为 X 所以涨」的因果句，不给买卖指令，不预测涨跌；
 *   - 提示词与注入快照随响应返回，便于逐条追溯。
 * ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const DATA = path.join(__dirname, '..', 'data');

const readJson = f => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); }
  catch (_) { return null; }
};
const s = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 200);
const bjHM = ts => new Date(Number(ts) + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const nowLabel = () => bjHM(Date.now());

/** 从若干可能的缓存结构里取数组，缺失返回空数组并标注来源 */
function arrOf(obj, keys) {
  for (const k of keys) {
    if (Array.isArray(obj && obj[k])) return obj[k];
  }
  return [];
}

/** 收集当日重点关注股（选股池 / 预测池）与持仓 */
function collectScope(latest) {
  const focus = [];
  const seen = new Set();
  const add = (x, from) => {
    const code = s(x && (x.code || x.symbol), 12);
    if (!code || seen.has(code)) return;
    seen.add(code);
    focus.push({
      code, name: s(x.name || x.short, 24) || code,
      score: x.scoreAdjusted != null ? x.scoreAdjusted : (x.score != null ? x.score : null),
      kind: s(x.kindLabel || x.kind || (Array.isArray(x.classes) ? x.classes.join('/') : ''), 24),
      industry: s(x.industry, 24), from
    });
  };
  const pi = readJson('pick-insight.json');
  arrOf(pi, ['items', 'focus', 'leaders']).slice(0, 20).forEach(x => add(x, '当日选股'));
  const pp = readJson('pick-pool-state.json');
  arrOf(pp, ['items', 'pool', 'frozen']).slice(0, 20).forEach(x => add(x, '09:05 预测池'));
  const trend = readJson('trend-screen.json');
  arrOf(trend, ['items', 'top', 'picks']).slice(0, 12).forEach(x => add(x, '四类选股'));

  const holdings = [];
  const hs = readJson('holdings.json');
  arrOf(hs, ['items', 'holdings', 'positions']).forEach(x => holdings.push({
    code: s(x.code, 12), name: s(x.name, 24),
    qty: x.qty != null ? x.qty : null,
    cost: x.cost != null ? x.cost : (x.buyPrice != null ? x.buyPrice : null),
    pnlPct: x.pnlPct != null ? x.pnlPct : null,
    note: s(x.note, 60)
  }));
  const mp = readJson('my-picks.json');
  arrOf(mp, ['items', 'picks']).slice(0, 12).forEach(x => add(x, '我的选股'));
  return { focus: focus.slice(0, 24), holdings: holdings.slice(0, 20) };
}

/** 当下真实新闻：优先内存 latest.news，其次 news-pulse 快照 */
function collectNews(latest, limit = 12) {
  const out = [];
  const seen = new Set();
  const push = (n) => {
    const t = s(n && (n.title || n.headline || n.text), 160);
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push({
      title: t,
      source: s(n.source || n.feed || '来源未注明', 40),
      time: s(n.time || (n.ts ? bjHM(n.ts) : ''), 24) || '时点未注明',
      sentiment: n.sentiment == null ? null : Number(n.sentiment),
      label: s(n.sentimentLabel, 12)
    });
  };
  const raw = arrOf(latest, ['news']).slice(0, 40);
  raw.forEach(push);
  if (out.length < limit) {
    const np = readJson('news-pulse.json');
    arrOf(np, ['policyNews', 'companyNews', 'items']).slice(0, 30).forEach(push);
  }
  return out.slice(0, limit);
}

/** 四角色事实清单（全部来自真实快照） */
function buildFacts(latest) {
  const scope = collectScope(latest);
  const news = collectNews(latest);
  const tech = readJson('technical-cache.json');
  const style = readJson('market-style.json');
  const strength = readJson('strength-cache.json');
  const senti = readJson('sentiment.json');
  const techItems = arrOf(tech, ['items']);
  const regime = (tech && tech.regime) || null;

  /* 技术面：逐只取该系统已算出的确定性因子命中，只列已命中项 */
  const techRows = [];
  for (const x of scope.focus.slice(0, 12)) {
    const t = techItems.find(y => String(y.code) === String(x.code));
    if (!t || !t.calc) { techRows.push({ ...x, state: '技术标注不可得' }); continue; }
    const hits = (t.calc.factors || []).filter(f => f.hit === true).map(f => f.label);
    const patHits = (t.calc.patterns && Array.isArray(t.calc.patterns.rules) ? t.calc.patterns.rules : [])
      .filter(r => r.hit === true).slice(0, 4).map(r => r.name);
    techRows.push({
      ...x, state: '已算',
      kdj: t.calc.factors && t.calc.factors.find(f => f.key === 'kdj'),
      macd: t.calc.macd || null,
      lastClose: t.calc.lastClose, lastPct: t.calc.lastPct,
      hits, patHits, patUnavailable: t.calc.patterns ? t.calc.patterns.unavailable : null,
      bars: t.calc.bars
    });
  }

  /* 资金面：两市量能 + 市值分层 + 板块贡献（均为快照事实） */
  const vol = (style && style.volume) || {};
  const buckets = arrOf(style, ['buckets']).map(b => ({
    name: s(b.name, 16), pct1: b.pct1 != null ? b.pct1 : null, ret5: b.ret5 != null ? b.ret5 : null
  }));
  const boards = arrOf(strength, ['boards']).slice().sort((a, b) => (Number(b.chg1) || 0) - (Number(a.chg1) || 0));
  const boardTop = boards.slice(0, 5).map(b => ({ name: s(b.name, 20), chg1: b.chg1 != null ? b.chg1 : null }));
  const boardBottom = boards.slice(-5).reverse().map(b => ({ name: s(b.name, 20), chg1: b.chg1 != null ? b.chg1 : null }));
  const capital = {
    amountYi: vol.amountYi != null ? vol.amountYi : (vol.amount != null ? vol.amount : null),
    volRatio20: vol.volRatio20 != null ? vol.volRatio20 : null,
    upRatio: vol.upRatio != null ? vol.upRatio : null,
    conclusion: s(vol.conclusion || (style && style.conclusion), 120),
    buckets, boardTop, boardBottom,
    leadership: regime && regime.boardLeadership ? regime.boardLeadership : null,
    barbell: regime && regime.barbell ? regime.barbell : null
  };

  /* 消息面：当下真实新闻 + 消息面脉冲 + 板块消息排名（如有） */
  const pulse = readJson('news-pulse.json');
  const message = {
    newsCount: news.length,
    news,
    pulseAt: pulse && pulse.at ? s(pulse.at, 24) : '不可得',
    sentiment: senti ? {
      date: s(senti.date, 20),
      moneyEffect: senti.moneyEffect || null,
      boardHeight: senti.boardHeight || null,
      breakRate: senti.breakRate || null
    } : null,
    experience: regime && regime.experience ? regime.experience : null,
    buyback: regime && regime.buyback ? {
      count: regime.buyback.count, highlighted: regime.buyback.highlighted,
      missingPrice: regime.buyback.missingPrice,
      items: (regime.buyback.items || []).filter(x => x.highlight).slice(0, 5)
    } : null
  };

  /* 风控：双池冲突、破位标注、回购偏离、非当日快照提示、持仓集中度 */
  const pool = readJson('pick-pool-state.json');
  const conflicts = arrOf(pool, ['conflicts']).map(c => ({ code: s(c.code, 12), name: s(c.name, 24) }));
  const risk = {
    conflicts,
    breakMa5: techRows.filter(x => (x.hits || []).some(h => /破 MA5|趋势结束/.test(h))).map(x => x.code + ' ' + x.name),
    buybackHighlighted: message.buyback ? message.buyback.items : [],
    breadthStale: !!(tech && tech.breadth && tech.breadth.isToday === false),
    holdingsCount: scope.holdings.length,
    note: '风控只列已发生的风险标注与数据缺口，不给出减仓/清仓指令。'
  };

  return {
    at: nowLabel(),
    tradingDate: style && style.tradingDate ? s(style.tradingDate, 20) : null,
    scope, technical: techRows, capital, message, risk,
    dataGaps: [
      tech ? null : 'technical-cache.json 不可得',
      style ? null : 'market-style.json 不可得',
      strength ? null : 'strength-cache.json 不可得',
      scope.holdings.length ? null : '持仓快照为空或不可得（未买入 / 未录入）',
      news.length ? null : '当下新闻快照不可得'
    ].filter(Boolean)
  };
}

/** 把事实清单压成给模型的纯文本（同时作为降级时的可读输出） */
function factsText(f) {
  const L = [];
  L.push('【复盘时点】' + f.at + (f.tradingDate ? ' · 数据交易日 ' + f.tradingDate : ''));
  L.push('【范围】当日重点关注 ' + f.scope.focus.length + ' 只 · 已买入持仓 ' + f.scope.holdings.length + ' 只 · 当下新闻 ' + f.message.newsCount + ' 条');
  L.push('');
  L.push('■ 技术面专家（系统已算出的确定性因子，逐只可复算）');
  if (!f.technical.length) L.push('- 无可复核标的');
  f.technical.forEach(x => {
    const kdj = x.kdj && x.kdj.value ? ('KDJ ' + x.kdj.value.cross + '(K=' + x.kdj.value.k + ',D=' + x.kdj.value.d + ')') : 'KDJ 不可得';
    L.push('- ' + x.name + '(' + x.code + ') 评分 ' + (x.score == null ? '--' : x.score) + ' · ' + x.state +
      ' · ' + kdj + ' · 收盘 ' + (x.lastClose == null ? '--' : x.lastClose) +
      ' · 命中因子：' + ((x.hits || []).join('、') || '无') +
      ' · 形态命中：' + ((x.patHits || []).join('、') || '无') +
      (x.patUnavailable ? '（' + x.patUnavailable + ' 条判据不可得）' : ''));
  });
  L.push('');
  L.push('■ 资金面专家（成交额加权近似，非真实指数权重分解）');
  L.push('- 两市成交额 ' + (f.capital.amountYi == null ? '不可得' : f.capital.amountYi + ' 亿') +
    ' · 量比20 ' + (f.capital.volRatio20 == null ? '不可得' : f.capital.volRatio20) +
    ' · 上涨占比 ' + (f.capital.upRatio == null ? '不可得' : f.capital.upRatio + '%'));
  if (f.capital.conclusion) L.push('- 量能结论：' + f.capital.conclusion);
  if (f.capital.buckets.length) L.push('- 市值分层：' + f.capital.buckets.map(b => b.name + ' 当日 ' + (b.pct1 == null ? '--' : b.pct1)).join(' / '));
  if (f.capital.boardTop.length) L.push('- 领涨板块：' + f.capital.boardTop.map(b => b.name + ' ' + (b.chg1 == null ? '--' : b.chg1 + '%')).join('、'));
  if (f.capital.boardBottom.length) L.push('- 靠后板块：' + f.capital.boardBottom.map(b => b.name + ' ' + (b.chg1 == null ? '--' : b.chg1 + '%')).join('、'));
  if (f.capital.barbell && f.capital.barbell.ok) {
    const g = f.capital.barbell.global || {};
    L.push('- 哑铃特征 ' + (f.capital.barbell.isBarbell == null ? '不可得' : (f.capital.barbell.isBarbell ? '命中' : '未命中')) +
      ' · 两端-中间当日差 ' + (f.capital.barbell.spread1 == null ? '--' : f.capital.barbell.spread1) +
      ' · 全球倾向 ' + (g.tilt || 'unknown') + (g.note ? '（' + g.note + '）' : ''));
  }
  L.push('');
  L.push('■ 消息面专家（当下真实新闻，实时复盘结合项）');
  if (!f.message.news.length) L.push('- 当下新闻快照不可得');
  f.message.news.slice(0, 10).forEach((n, i) => L.push('  ' + (i + 1) + '. [' + n.time + '] ' + n.title + '（' + n.source +
    (n.sentiment == null ? '' : ' · 情感分 ' + n.sentiment + '/' + n.label) + '）'));
  if (f.message.experience && f.message.experience.ok) {
    const e = f.message.experience;
    L.push('- 经验校验：' + s(e.userClaim, 60) + ' → ' + s(e.claimStatus, 30) +
      '；当日领涨 ' + (e.topBoards || []).slice(0, 3).map(b => b.name + ' ' + b.chg1 + '%').join('、'));
  }
  if (f.message.buyback) {
    L.push('- 回购公告 ' + f.message.buyback.count + ' 条，重点标注 ' + f.message.buyback.highlighted +
      ' 条，标题未含价格 ' + f.message.buyback.missingPrice + ' 条（需公告正文）');
  }
  L.push('');
  L.push('■ 风控专家（只列已发生标注与数据缺口）');
  L.push('- 双池重叠 ' + f.risk.conflicts.length + ' 只：' + (f.risk.conflicts.map(c => c.name + '(' + c.code + ')').join('、') || '无'));
  L.push('- 破 MA5 / 趋势结束标注：' + (f.risk.breakMa5.join('、') || '无'));
  L.push('- 全市场宽度快照' + (f.risk.breadthStale ? '非当日（抗压判据仅供参考）' : '为当日'));
  if (f.dataGaps.length) L.push('- 数据缺口：' + f.dataGaps.join('；'));
  return L.join('\n');
}

/** 把智能体 / 程序叙述文本切成按角色分段的结构化数组（不改动原文，不补内容）。
 *  兼容「■ 技术面专家（…）」「【技术面】正文」「一、技术面」「技术面：」等常见写法；
 *  【复盘时点】【范围】这类元信息归入「复盘概述」的内容行，不吞掉同行正文。 */
function structureNarrative(text) {
  const ROLE_OF = t => /技术面/.test(t) ? 'tech'
    : /资金面/.test(t) ? 'capital'
      : /消息面/.test(t) ? 'news'
        : /风控/.test(t) ? 'risk'
          : /数据缺口|证伪|缺口/.test(t) ? 'gap'
            : /复盘时点|范围|概览/.test(t) ? 'overview' : 'other';
  const isHead = line => {
    const t = String(line || '').trim();
    if (!t || t.startsWith('- ') || t.startsWith('•') || /^\d+[.、)]/.test(t) || t.length > 48) return false;
    if (/^■|^◆|^●|^#|^[一二三四五六][、.]/.test(t)) return true;
    return /技术面|资金面|消息面|风控|数据缺口|证伪条件/.test(t);
  };
  const out = []; let cur = null;
  const ensure = () => { if (!cur) { cur = { key: 'overview', title: '复盘概述', lines: [] }; out.push(cur); } return cur; };
  String(text || '').split('\n').forEach(raw => {
    const line = String(raw || '').replace(/\s+$/, '');
    if (!line.trim()) return;
    const m = line.match(/^[■◆●\s]*【([^】]+)】\s*(.*)$/);
    if (m) {
      if (/技术面|资金面|消息面|风控|数据缺口|证伪/.test(m[1])) {
        cur = { key: ROLE_OF(m[1]), title: m[1].trim(), lines: m[2].trim() ? [m[2].trim()] : [] };
        out.push(cur);
      } else ensure().lines.push(line);
      return;
    }
    if (isHead(line)) {
      cur = { key: ROLE_OF(line), title: line.replace(/^[■◆●#\s]+/, '').trim(), lines: [] };
      out.push(cur);
    } else ensure().lines.push(line);
  });
  return out;
}

const SYSTEM = [
  '你是 A 股量化系统的「盘后复盘专家团」，由技术面、资金面、消息面、风控四位专家组成。',
  '【硬约束】预判与选股由系统既有量化评分完成，你不参与预判、不预测涨跌、不给买入/卖出/仓位指令、不修改任何评分。',
  '你的唯一任务是复盘「已经发生的事实」：对上述当日重点关注股票与已买入持仓，按四角色做结构化文字叙述。',
  '【实时复盘要求】消息面部分必须结合注入的「当下真实新闻」清单，只引用清单里的条目，不补充清单外的新闻。',
  '【反幻觉纪律】只使用注入快照里的数值与标题；数据标「不可得」就如实说不可得，不得估算、不得编造、不得写「因为 X 所以涨」的因果句。',
  '形态命中、回购偏离、哑铃特征都只是技术条件标注，不得表述成上涨保证或买卖点。',
  '输出中文，按「技术面 / 资金面 / 消息面 / 风控」四段，每段 2–4 句，最后单列「数据缺口与证伪条件」一段。',
  '红涨绿跌遵循 A 股习惯；不替用户下单。'
].join('\n');

function buildPrompt(f) {
  return [
    SYSTEM,
    '',
    '【系统注入的真实数据快照（逐字使用，禁止扩写）】',
    factsText(f),
    '',
    '【任务】基于上面的事实快照写一份盘后复盘专家团报告。只叙述已发生事实与可复核标注，不预判、不荐股、不改分。'
  ].join('\n');
}

/** 叙述文本结构化 + 来源标注（所有返回分支统一走这里，保证新旧字段都齐） */
function finalize(out) {
  out.narrative = structureNarrative(out.text || out.factsText || '');
  out.narrativeSource = (out.ai && out.ai.ok) ? 'ai' : 'program';
  return out;
}

/** 主入口：程序事实恒返回；智能体按需调用，失败降级 */
async function run(cfg, hermes, latest, opts = {}) {
  const facts = buildFacts(latest);
  const prompt = buildPrompt(facts);
  const sections = [
    { role: '技术面', key: 'tech', tone: 'tech', idx: '01', summary: '确定性因子与形态命中（可复算）', count: facts.technical.length, statLabel: '只标的' },
    { role: '资金面', key: 'capital', tone: 'capital', idx: '02', summary: '两市量能、市值分层、板块贡献与哑铃特征', count: facts.capital.buckets.length, statLabel: '层市值' },
    { role: '消息面', key: 'news', tone: 'news', idx: '03', summary: '当下真实新闻 + 经验校验 + 回购提醒', count: facts.message.newsCount, statLabel: '条新闻' },
    { role: '风控', key: 'risk', tone: 'risk', idx: '04', summary: '双池重叠、破位标注、数据缺口', count: facts.risk.conflicts.length, statLabel: '处重叠' }
  ];
  const out = {
    ok: true,
    at: facts.at,
    tradingDate: facts.tradingDate,
    mode: '盘后复盘专家团（智能体不参与预判）',
    sections,
    facts,
    factsText: factsText(facts),
    prompt,
    ai: null,
    degraded: false,   // 智能体调用失败 → 降级为纯程序事实
    aiSkipped: false,  // 用户主动选择「仅程序事实」→ 不是降级，不做误导性标注
    text: '',
    narrative: [],        // 叙述按角色分段（结构化输出，前端不再靠纯文本排版）
    narrativeSource: 'program',
    disclaimer: [
      '预判与选股由既有确定性量化模块完成，本模块只读、不改任何评分与选股结果。',
      '智能体仅在用户主动点击时按需调用，只叙述已发生事实，不预测涨跌、不给买卖建议。',
      '板块贡献为成交额加权近似分解，哑铃效应为横截面观察，均不认定因果。',
      '回购价格区间来自公告标题，可能不完整；「低于区间」仅为价格偏离事实标注，不构成涨跌保证。',
      '智能体不可用时降级为纯程序结构化复盘，响应中明确标注 degraded，不编造模型输出。'
    ]
  };

  if (opts.noAI === true) {
    out.aiSkipped = true;
    out.text = out.factsText;
    out.ai = { ok: false, backend: 'program-only', error: '按请求跳过智能体' };
    return finalize(out);
  }
  try {
    const r = await hermes.ask(cfg, 'daily-review-team', prompt,
      { task: '盘后复盘专家团（四角色结构化叙述）', maxTokens: 1400, temperature: 0.25 });
    if (r && r.ok && r.text) {
      out.ai = { ok: true, backend: r.backend || 'hermes', model: r.model || null };
      out.text = String(r.text).trim();
    } else {
      out.degraded = true;
      out.text = out.factsText;
      out.ai = { ok: false, backend: (r && r.backend) || 'unavailable', error: (r && r.error) || '模型未返回文本' };
    }
  } catch (e) {
    out.degraded = true;
    out.text = out.factsText;
    out.ai = { ok: false, backend: 'error', error: e.message || String(e) };
  }
  return finalize(out);
}

module.exports = { run, buildFacts, factsText, buildPrompt, structureNarrative, SYSTEM };
