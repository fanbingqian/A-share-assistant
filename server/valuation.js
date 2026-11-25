'use strict';

/**
 * 市值重估事件分析（重组 / 回购 / 拟并购）
 *
 * 【要回答的问题】
 * 「这只股票因为重组/回购/并购，是否具备大幅提升市值的条件？」
 * 答案不是「会涨 X%」，而是「以下条件是否满足 / 不满足 / 无数据」——
 * 把判断拆成可核对的条件清单，是本项目反幻觉的核心手段。
 *
 * 【两类输入，全部真实可核对】
 *  A. 重组情况（来自 events.js 已分类的公司公告，字段为公告标题推断）：
 *     事件类型、公告标题、发布时间、是否进展性文件、是否栏目推断、
 *     同一代码同类型事件条数（推进度代理）、流通市值、所属行业。
 *  B. 外部环境（来自本系统已有实时模块，不额外造数）：
 *     板块相对强弱（strength.js）、情绪阶段（limitUp）、两市量能（marketStyle）、
 *     避险温度（events.macro）、外围股市均值（sources.fetchOverseas）。
 *
 * 【市值提升机制按类型区分，不混为一谈】
 *   重大资产重组 / 借壳 / 吸收合并 → 资产体量跃迁，营收利润口径改变
 *   拟收购 / 并购              → 外延并表 + 协同，取决于对价与标的盈利质量
 *   回购注销                  → 股本减少、EPS 提升
 *   普通回购（不注销）        → 主要是管理层低估信号，不直接改变市值口径
 *   重组终止 / 立案            → 一票否决（预期落空或合规风险）
 *
 * 【诚实边界（写进输出，不做暗示）】
 *  - 公告标题 ≠ 事实：交易金额、标的估值、协同效应、审批结果一律不猜，
 *    标题里没有就不写；没有结构化数据支撑的项标「无数据，未纳入判断」。
 *  - 事件阶段仅由标题关键词推断，未读取公告全文，输出标注「标题推断」。
 *  - 不输出目标价、预计涨幅、成功率；verdict 是「条件齐备度」分档，不是建议。
 */

const fs = require('node:fs');
const path = require('node:path');
const { boardOf } = require('./strength');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'valuation-cache.json');
const TTL = 5 * 60 * 1000;

function round(x, n = 1) { if (!Number.isFinite(x)) return null; const p = Math.pow(10, n); return Math.round(x * p) / p; }
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function beijing(ts = Date.now()) { return new Date(ts + 8 * 3600000).toISOString().slice(0, 10); }

const MONTH_MS = 30 * 86400000;

/* --------------------------- 事件类型 → 重估机制与强度 --------------------------- */
const TYPE_META = {
  reorg_stop: { label: '重组终止', mechanism: '重组预期落空，估值回吐', base: 0, veto: true },
  reorg: { label: '重大资产重组', mechanism: '资产注入 / 置换带来营收与利润体量跃迁', base: 30 },
  acquisition: { label: '拟收购 / 并购', mechanism: '外延并表 + 协同，取决于对价与标的盈利质量', base: 22 },
  buyback: { label: '股份回购', mechanism: '注销式回购减少股本提升 EPS；非注销式主要是低估信号', base: 14 }
};
const TARGET_TYPES = new Set(Object.keys(TYPE_META));
const BLOCK_TYPES = new Set(['reorg_stop', 'investigation', 'delist_risk']);

/** 由公告标题推断推进阶段。只认标题里真实出现的词，推断结果显式标注。 */
const STAGE_RULES = [
  { key: 'done', label: '实施 / 完成', score: 15, kw: ['实施完成', '过户完成', '交割完成', '完成收购', '回购完成', '实施完毕', '股份过户', '实施情况', '新增股份上市', '实施结果', '交割完毕'] },
  { key: 'approved', label: '审核通过', score: 14, kw: ['审核通过', '并购重组委', '过会', '注册生效', '同意注册', '证监会同意', '核准'] },
  { key: 'report', label: '报告书 / 草案', score: 12, kw: ['重组报告书', '交易报告书', '收购报告书', '报告书', '草案', '交易预案（修订稿）'] },
  { key: 'reply', label: '问询回复 / 修订', score: 10, kw: ['问询函回复', '反馈意见回复', '修订稿', '二次问询', '审核问询'] },
  { key: 'progress', label: '进展公告', score: 8, kw: ['重组进展', '回购进展', '收购进展', '进展公告', '进展'] },
  { key: 'plan', label: '预案 / 筹划', score: 6, kw: ['重组预案', '回购预案', '回购方案', '筹划', '提示性公告', '停牌', '意向'] }
];
function stageOf(title) {
  const t = String(title || '');
  for (const r of STAGE_RULES) if (r.kw.some(k => t.includes(k))) return r;
  return { key: 'unknown', label: '阶段未从标题识别', score: 5, kw: [] };
}

/** 标题里是否出现明确的规模线索（只提取，不推断金额） */
function scaleClue(title) {
  const t = String(title || '');
  const m = t.match(/(\d+(?:\.\d+)?)\s*(亿元|亿|万元|万)/);
  if (m) return { has: true, text: m[0], note: '标题含金额字样，但公告标题不等于交易对价，未据此估算市值增幅' };
  if (/重大资产|借壳|吸收合并|整体上市/.test(t)) return { has: true, text: '重大 / 借壳 / 吸收合并', note: '标题表明体量级事件，但无金额数字，不做量化' };
  return { has: false, text: null, note: '标题未提供交易规模信息' };
}

/* ------------------------------ 外部环境评估 ------------------------------ */
function externalOf(env) {
  const e = env || {};
  const items = [];
  const push = (key, label, val, ok, note) => items.push({ key, label, value: val, positive: ok, note });

  // 板块景气：真实相对超额，无数据则 null
  const b = e.board || null;
  if (b && b.ex5 != null) {
    push('sector', '所属板块相对强弱', b.name + ' 5 日超额 ' + b.ex5 + '%（排名 ' + (b.rank || '—') + '）',
      b.ex5 > 0, b.ex5 > 0 ? '板块处于相对强势，重估更容易被资金承接' : '板块跑输基准，重估缺乏板块效应配合');
  } else {
    push('sector', '所属板块相对强弱', '无数据', null, '板块强弱数据不可用，该项未纳入判断（不按 0 分填充）');
  }

  // 情绪阶段
  const st = String(e.sentimentStage || '');
  if (st) {
    const bad = /冰点|退潮|低迷/.test(st);
    push('sentiment', '市场情绪阶段', st, !bad, bad ? '情绪冰点期事件溢价整体缩水' : '情绪未处于冰点，事件驱动具备基础环境');
  } else push('sentiment', '市场情绪阶段', '无数据', null, '情绪阶段不可用，未纳入判断');

  // 量能制度
  if (e.volumeYi != null) {
    const inc = e.volumeYi >= (e.volumeThresholdYi || 25000);
    push('volume', '两市量能', e.volumeYi + ' 亿（' + (e.volumeRegime || (inc ? '增量' : '存量')) + '）',
      inc, inc ? '增量行情下市值重估更容易获得增量资金' : '存量博弈下资金更集中于少数主线，重估承接力受限');
  } else push('volume', '两市量能', '无数据', null, '量能数据不可用，未纳入判断');

  // 避险温度
  if (e.riskOffScore != null) {
    const hot = e.riskOffScore >= 65;
    push('riskoff', '避险温度', e.riskOffScore + '/100（' + (e.riskOffLevel || '—') + '）',
      !hot, hot ? '高避险温度下资金回避事件型不确定性' : '避险温度未达高位');
  } else push('riskoff', '避险温度', '无数据', null, '避险温度不可用，未纳入判断');

  // 外围股市（美股三指数均值，≥2 个报价才有效）
  if (e.overseasEquity != null) {
    const bad = e.overseasEquity <= -1.5;
    push('overseas', '外围股市（美股均值）', e.overseasEquity + '%', !bad,
      bad ? '隔夜美股显著下跌，风险偏好受压' : '外围未出现显著风险冲击');
  } else push('overseas', '外围股市（美股均值）', '无数据', null, '外围行情不可用，未纳入判断');

  const known = items.filter(x => x.positive !== null);
  const pos = known.filter(x => x.positive).length;
  // 无数据的项不参与打分，也不按 0 计；按已知项比例折算到 45 分
  const score = known.length ? round(45 * pos / known.length) : null;
  return { items, known: known.length, positive: pos, score };
}

/* ------------------------------ 候选构建 ------------------------------ */
function pickEvents(eventsView) {
  const src = (eventsView && (eventsView.items || eventsView.watchlist)) || [];
  const byKey = new Map();
  const blocks = new Map();
  for (const e of src) {
    if (!e || !e.code || !e.type) continue;
    if (BLOCK_TYPES.has(e.type)) {
      const cur = blocks.get(e.code);
      if (!cur || (e.ts || 0) > (cur.ts || 0)) blocks.set(e.code, e);
    }
    if (!TARGET_TYPES.has(e.type)) continue;
    const k = e.code + '|' + e.type;
    const cur = byKey.get(k);
    if (!cur || (e.ts || 0) > (cur.ts || 0)) byKey.set(k, { ...e, groupCount: 0 });
  }
  // 同一 code+type 的公告条数：作为「持续推进」的代理指标，按全部事件重新计数
  for (const e of src) {
    if (!e || !e.code || !TARGET_TYPES.has(e.type)) continue;
    const hit = byKey.get(e.code + '|' + e.type);
    if (hit) hit.groupCount = (hit.groupCount || 0) + 1;
  }
  return { list: Array.from(byKey.values()), blocks };
}

function buildCandidate(e, ctx) {
  const meta = TYPE_META[e.type] || TYPE_META.acquisition;
  const title = String(e.title || '');
  const stage = stageOf(title);
  const scale = scaleClue(title);
  const floatCapYi = Number.isFinite(e.floatCap) ? round(e.floatCap / 1e8, 1) : null;
  const block = ctx.blocks.get(e.code);
  const veto = !!meta.veto || !!block;

  const conditions = [];
  const add = (key, group, label, met, detail, source, value) => {
    const c = { key, group, label, met, detail, source, value: value == null ? null : value };
    conditions.push(c);
    return c;
  };

  // —— A. 重组情况（55 分）——
  const isScaleEvent = /借壳|吸收合并|发行股份购买资产|重大资产重组|重大资产置换|整体上市/.test(title);
  // 资产置出（出售 / 剥离）机制与资产注入相反：它收缩报表口径，
  // 不能当成「大幅提升市值」的跃迁类事件，须显式区分，避免把利空读成利好。
  const isDivest = /出售资产|资产出售|重大资产出售|剥离|转让.*股权|处置资产/.test(title) &&
    !/购买资产|发行股份购买|收购/.test(title);
  add('event', '重组情况', '事件属资产体量跃迁类', isScaleEvent && !isDivest,
    isDivest ? '标题为「资产出售 / 剥离」类，属资产置出而非注入，市值口径收缩，不按跃迁类计' :
    isScaleEvent ? '标题含「' + (title.match(/借壳|吸收合并|发行股份购买资产|重大资产重组|重大资产置换|整体上市/) || [''])[0] + '」，机制为资产注入带来的口径改变'
      : e.type === 'buyback' ? '回购不注入资产，市值提升路径为股本/信号而非体量跃迁'
      : '并购类事件，体量变化取决于标的规模（标题未提供，不推断）',
    '公告标题 + events.js 规则分类');

  add('progress', '重组情况', '已进入实质推进阶段', stage.score >= 10,
    '标题推断阶段：' + stage.label + '（依据「' + (stage.kw.find(k => title.includes(k)) || '无匹配关键词') + '」）；' +
    '同一代码同类型公告 ' + (e.groupCount || 1) + ' 条' + ((e.groupCount || 1) >= 3 ? '，呈持续推进' : ''),
    '公告标题关键词（未读取公告全文）');

  add('noblock', '重组情况', '无终止 / 立案等否决项', !block,
    block ? '检出「' + (block.label || block.type) + '」：' + String(block.title || '').slice(0, 40) : '未检出终止、立案、退市风险类事件',
    'events.js 公司事件规则表');

  add('confidence', '重组情况', '事件识别置信度可接受', e.confidence !== '低' && !e.viaColumn,
    e.viaColumn ? '按东财栏目推断（标题未直接点明），置信度低' :
    e.progressDowngrade ? '为进展/提示性文件，已降权' :
    '标题直接命中「' + (e.matchKw || '—') + '」',
    'events.js 事件对象字段');

  // —— B. 外部环境（45 分）——
  const ext = externalOf({
    board: boardOf(ctx.strength, e.industry),
    sentimentStage: ctx.env.sentimentStage,
    volumeYi: ctx.env.volumeYi, volumeRegime: ctx.env.volumeRegime,
    volumeThresholdYi: ctx.env.volumeThresholdYi,
    riskOffScore: ctx.env.riskOffScore, riskOffLevel: ctx.env.riskOffLevel,
    overseasEquity: ctx.env.overseasEquity
  });
  for (const it of ext.items) {
    add(it.key, '外部环境', it.label, it.positive, it.value + '｜' + it.note,
      it.key === 'sector' ? 'strength.js 板块相对强弱' : '系统实时环境模块', it.value);
  }

  // 打分：重组情况按条件命中计，外部环境按已知项比例
  const aScore =
    ((isScaleEvent && !isDivest) ? 18 : e.type === 'acquisition' ? 12 : 8) +
    Math.min(15, stage.score) +
    (block ? 0 : 12) +
    (e.confidence !== '低' && !e.viaColumn ? 10 : 4);
  const bScore = ext.score == null ? null : ext.score;
  const score = veto ? 0 : Math.round(clamp(aScore + (bScore == null ? 0 : bScore), 0, 100));

  // 关键条件与机制适配：防止「只靠外部环境好」就把提示性公告 / 回购判成条件齐备。
  // 回购不注入资产，机制上就不属于「大幅提升市值」的路径，判定上限压到「部分条件具备」。
  const keyOk = [isScaleEvent && !isDivest, stage.score >= 10, !block].filter(Boolean).length;
  const mechanismFit = e.type === 'reorg' || e.type === 'acquisition';
  let verdict;
  if (veto) verdict = 'veto';
  else if (!mechanismFit) verdict = score >= 60 ? 'partial' : score >= 40 ? 'weak' : 'none';
  else if (score >= 78 && keyOk >= 2 && ext.known >= 4) verdict = 'ready';
  else if (score >= 55) verdict = 'partial';
  else if (score >= 35) verdict = 'weak';
  else verdict = 'none';
  const VERDICT = {
    veto: '一票否决', ready: '条件较齐备', partial: '部分条件具备',
    weak: '条件不足', none: '暂不具备'
  };

  // 市值弹性：一般性口径假设，明确标注不是实证结论，不参与评分
  let elasticity = null;
  if (floatCapYi != null) {
    elasticity = {
      floatCapYi,
      note: floatCapYi < 50 ? '小市值基数，同等体量资产注入带来的相对弹性更大（一般性口径假设，非实证结论）' :
        floatCapYi < 150 ? '中小市值基数，重估弹性中等' :
        floatCapYi < 500 ? '中市值基数，重估需更大规模资产' : '大市值基数，单一事件对总市值的相对影响通常有限',
      caveat: '未取得交易对价与标的资产规模，不做任何市值增幅测算'
    };
  }

  const counterEvidence = [
    '公告标题不等于事实：重组可能终止、回购可能不执行、并购可能未过会',
    '未取得交易对价、标的估值与盈利承诺，无法判断协同效应或商誉风险',
    '事件型标的常出现公告前已透支、T+1 一字板无法成交的执行风险',
    block ? '已检出否决项：' + (block.label || block.type) : '审批节奏与监管口径不由本系统推断'
  ];
  if (ext.items.some(x => x.key === 'sector' && x.positive === false))
    counterEvidence.push('所属板块当前跑输基准，缺少板块效应配合');

  return {
    code: e.code, name: e.name || e.code, industry: e.industry || null, floatCapYi,
    type: e.type, typeLabel: meta.label, mechanism: meta.mechanism,
    mechanismFit, mechanismNote: mechanismFit
      ? '该类型具备资产体量变化路径，才谈得上「大幅提升市值」'
      : '回购不注入资产，市值提升主要通过股本/信号，不属体量跃迁，故判定上限为「部分条件具备」',
    title, publishedAt: e.ts ? new Date(e.ts + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : null,
    link: e.link || null, source: e.source || '东方财富 · 公司公告',
    stage: stage.key, stageLabel: stage.label, stageInferredFromTitle: true,
    groupCount: e.groupCount || 1, scale, elasticity,
    conditions, external: ext, score, verdict, verdictLabel: VERDICT[verdict],
    block: block ? { type: block.type, label: block.label || block.type, title: block.title } : null,
    counterEvidence,
    horizon: '事件驱动型：窗口取决于审核 / 实施进度，系统不设固定持有天数，也不预测涨幅'
  };
}

/* ------------------------------ 主构建 ------------------------------ */
function buildValuation(opts = {}) {
  const eventsView = opts.events || null;
  const strength = opts.strength || null;
  const env = opts.env || {};
  const now = Date.now();

  const picked = pickEvents(eventsView);
  const candidates = picked.list
    .map(e => buildCandidate(e, { blocks: picked.blocks, strength, env }))
    .filter(c => !opts.recentDays || !c.publishedAt || (now - (Date.parse(c.publishedAt.replace(' ', 'T') + ':00+08:00') || 0)) < opts.recentDays * 86400000)
    .sort((a, b) => b.score - a.score);

  const view = {
    ok: true, builtAt: now, date: beijing(),
    candidates: candidates.slice(0, opts.limit || 30),
    counts: {
      total: picked.list.length, blocks: picked.blocks.size,
      ready: candidates.filter(c => c.verdict === 'ready').length,
      partial: candidates.filter(c => c.verdict === 'partial').length,
      veto: candidates.filter(c => c.verdict === 'veto').length
    },
    envSnapshot: {
      sentimentStage: env.sentimentStage != null ? env.sentimentStage : null,
      volumeYi: env.volumeYi != null ? env.volumeYi : null,
      volumeRegime: env.volumeRegime != null ? env.volumeRegime : null,
      riskOffScore: env.riskOffScore != null ? env.riskOffScore : null,
      overseasEquity: env.overseasEquity != null ? env.overseasEquity : null
    },
    methodology: {
      input: '重组情况来自 events.js 已分类公告（标题推断）；外部环境来自 strength / limitUp / marketStyle / events.macro / sources 外围股指，均为系统真实采集值',
      scoring: '重组情况 55 分（事件类型 18 + 推进阶段 15 + 无否决 12 + 识别置信 10）+ 外部环境 45 分（板块/情绪/量能/避险/外围按已知项比例折算）',
      missing: '任何无数据项标 null、不按 0 填充、不参与该组打分；外部环境组按已知项比例折算',
      veto: '重组终止 / 立案调查 / 退市风险为一票否决，直接判定「一票否决」',
      stage: '推进阶段仅由公告标题关键词识别，未读取公告全文，输出已标注',
      verdict: 'verdict 是「条件齐备度」分档，不是涨幅预测、不是成功率、不是买入建议'
    },
    disclaimer: '公告标题 ≠ 事实。本模块不估算交易金额、标的估值、协同效应或目标市值，不输出预计涨幅与胜率。重组能否大幅提升市值取决于对价、标的盈利质量、审批结果与当时市场环境，其中多数信息本系统未取得，须由使用者核对公告原文。'
  };

  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(view), 'utf8'); } catch (_) {}
  return view;
}

module.exports = { buildValuation, stageOf, scaleClue, externalOf, CACHE_FILE, TTL };
