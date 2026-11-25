'use strict';

/**
 * 评估数据库 / 经验库（闭环的“记忆”层）
 *
 * 【它解决什么问题】
 * 之前系统每天给 18 只股票打分、给「重点关注」，但没有任何地方记录
 * 「当时为什么推它」以及「推完之后到底对不对」。没有记录就没有复盘，
 * 没有复盘就没有经验，没有经验就永远在原地打转。
 *
 * 本模块把一次判断拆成三段，并让它可追溯、可审核、可回流：
 *   ① 定格（snapshot）：交易日 22:00 与次日 09:05 各冻结一版名单，
 *      每只股票同时存「量化指标」与「一句话看多理由」，此后再也不改。
 *      冻结的意义：防止用事后行情反推理由（后视偏差），也让复盘有唯一基准。
 *   ② 复盘（review）：目标交易日收盘后，用真实日线回填 T+1 收益、超额定基准收益、
 *      最大浮盈/浮亏，判定「看多是否成立」。
 *   ③ 归纳（lesson）：按信号等级 / 市值层 / 情绪阶段 / 板型 / 主导因子分组统计命中率，
 *      样本量达阈值才产出结论，结论进入待审队列。
 *   ④ 审核（audit）：人审核后 approved / rejected，只有 approved 才会变成规则。
 *   ⑤ 回流（bias）：approved 规则以「有界乘数」作用于涨停结构修正，
 *      影响上限 ±2 分，且不会翻转符号——经验能微调判断，但不能接管判断。
 *
 * 【存储】
 *   data/journal/picks.jsonl     定格名单（只追加，永不修改）
 *   data/journal/outcomes.jsonl  复盘结果（只追加）
 *   data/journal/lessons.jsonl   经验条目（状态流转时追加新版本行，读取取最新）
 *   data/journal/rules.json      已生效规则（由 approved 经验派生，可整体重建）
 *   data/journal/live.json       实时观察池（滚动覆写：当前名单 + 当日进出日志）
 *
 * 【实时观察池（live）与定格（open/eve）的分工】
 *   定格是「存证」：冻结时点的判断，用于复盘与经验归纳，一天两档、永不修改；
 *   实时池是「看盘」：盘中随评分滚动更新（含新进/移出提示），回答「现在该盯谁」。
 *   实时池不作为复盘基准——参考价随盘中行情漂移，用它复盘等于用事后行情自评。
 *
 * 【为什么用 JSONL 而不是数据库】
 * 项目坚持零第三方依赖、单机运行。JSONL 追加写天然幂等、可 diff、可人工审阅、
 * 崩溃只会丢最后一行；一年约 9000 行，全量读取在 10ms 量级，无需索引。
 * 若将来换 SQLite，只需替换本文件的读写函数，上层接口不变。
 */

const fs = require('node:fs');
const path = require('node:path');
const ic = require('./ic');

const DIR = path.join(__dirname, '..', 'data', 'journal');
const PICKS = path.join(DIR, 'picks.jsonl');
const OUTCOMES = path.join(DIR, 'outcomes.jsonl');
const LESSONS = path.join(DIR, 'lessons.jsonl');
const RULES = path.join(DIR, 'rules.json');
const LIVE = path.join(DIR, 'live.json');   // 实时观察池（滚动覆写，不进 JSONL）

const MAX_PICKS = 800;        // 约 400 个交易日的两档定格
const MIN_N = 8;              // 单组最少样本，低于此不出结论
const MAX_BIAS = 2;           // 经验回流对单项修正的最大影响（分）
const KEEP_DAYS = 400;

/* ---------------------------------- 工具 ---------------------------------- */

function round(x, n = 2) {
  if (!Number.isFinite(x)) return null;
  const p = Math.pow(10, n);
  return Math.round(x * p) / p;
}
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function pct(a, b) { return a && b ? (a / b - 1) * 100 : null; }

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  const txt = fs.readFileSync(file, 'utf8');
  for (const line of txt.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* 半行写入，跳过 */ }
  }
  return out;
}

function appendJsonl(file, obj) {
  ensureDir();
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

function writeJson(file, obj) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function beijing(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return {
    date: d.toISOString().slice(0, 10),
    hhmm: d.toISOString().slice(11, 16),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    weekday: d.getUTCDay()
  };
}

/* ------------------------------- 一句话理由 ------------------------------- */

/**
 * 把结构化评分压成一句人话。
 * 原则：优先说「这只股票今天为什么被看见」，而不是罗列所有因子。
 * 语气必须可证伪（写明方向与条件），不写「必涨」「稳了」这类话。
 */
function thesisOf(it) {
  const g = it.groups || {};
  const adj = it.adjust || {};
  const parts = [];
  const bucketLabel = { micro: '微盘', small: '小盘', mid: '中盘', large: '大盘' }[it.bucket] || '中盘';

  if (it.boardLabel && it.boardLabel !== '—' && it.limitAdjust) {
    if (it.boardLabel === '一字板') {
      parts.push('一字板封单 ' + (it.sealRatio != null ? it.sealRatio + '%' : '偏厚') + '，结构最强但约三成买不到');
    } else if (it.boardLabel === '回封板') {
      parts.push('盘中炸板后回封，分歧转一致，接力成功率高于缩量板');
    } else if (it.boardLabel === '炸板未回封') {
      parts.push('触及涨停未封住，封单被消化，属接力失败');
    } else if (it.boards >= 3) {
      parts.push(it.boards + ' 连板高位，溢价仍在但均值回归压力大');
    } else {
      parts.push('换手板 ' + (it.firstSeal || '') + ' 封板，可成交性好');
    }
  } else if (it.eventPolarity === '利多' && it.eventAdjust > 0.5) {
    parts.push('公司事件偏多（' + (it.eventLabel || '公告驱动') + '），修正 +' + it.eventAdjust + ' 分');
  } else if (it.styleAdjust >= 2) {
    parts.push(bucketLabel + '资金占优（风格 +' + it.styleAdjust + '），市值风格顺风');
  } else if (g.capital >= 60 && g.technical >= 55) {
    parts.push('资金与趋势同步改善（' + g.technical + '/' + g.capital + '）');
  } else if (g.buzz >= 60) {
    parts.push('舆情热度领先（' + g.buzz + '），情绪驱动为主');
  } else {
    parts.push('技术 ' + g.technical + ' / 资金 ' + g.capital + ' / 舆情 ' + g.buzz + '，无突出单项');
  }

  const tail = [];
  if (it.cycleStage) tail.push('情绪' + it.cycleStage);
  if (adj.limit != null && Math.abs(adj.limit) >= 3) tail.push('涨停修正 ' + (adj.limit > 0 ? '+' : '') + adj.limit);
  if (it.chaseRisk >= 65) tail.push('追高风险 ' + it.chaseRisk);
  if (it.risk0) tail.push(it.risk0.slice(0, 40));

  return parts.join('；') + (tail.length ? '（' + tail.join('，') + '）' : '');
}

/** 量化指标摘要：给「为什么看多」提供可核对的数字，而非形容词 */
function quantOf(it) {
  const g = it.groups || {};
  const adj = it.adjust || {};
  const out = [];
  out.push('技术 ' + g.technical + ' / 资金 ' + g.capital + ' / 舆情 ' + g.buzz +
    '（权重 ' + (g.weights ? Math.round(g.weights.technical * 100) + '/' +
      Math.round(g.weights.capital * 100) + '/' + Math.round(g.weights.buzz * 100) : '—') + '）');
  const ap = [];
  if (adj.market) ap.push('外围 ' + (adj.market > 0 ? '+' : '') + adj.market);
  if (adj.style) ap.push('风格 ' + (adj.style > 0 ? '+' : '') + adj.style);
  if (adj.event) ap.push('事件 ' + (adj.event > 0 ? '+' : '') + adj.event);
  if (adj.macro) ap.push('宏观 ' + (adj.macro > 0 ? '+' : '') + adj.macro);
  if (adj.limit) ap.push('涨停 ' + (adj.limit > 0 ? '+' : '') + adj.limit);
  if (ap.length) out.push('修正 ' + ap.join('｜') + ' = ' + (adj.sum > 0 ? '+' : '') + adj.sum);
  const ind = [];
  if (it.volRatio != null) ind.push('量比 ' + it.volRatio);
  if (it.turnover != null) ind.push('换手 ' + it.turnover + '%');
  if (it.mainFlowPct != null) ind.push('主力 ' + (it.mainFlowPct > 0 ? '+' : '') + it.mainFlowPct + '%');
  if (it.pe != null) ind.push('PE ' + it.pe);
  if (ind.length) out.push(ind.join(' · '));
  return out;
}

/* --------------------------------- 定格 --------------------------------- */

function pickId(date, kind) { return 'P' + date.replace(/-/g, '') + '-' + kind; }

/**
 * 冻结一版名单。同一 (日期, 档位) 只允许一次——重跑返回已有结果，
 * 保证复盘基准唯一（这是 IC 自检里同样的原则：不许用事后最优版本自评）。
 */
/** 定格条目的统一字段映射（定格与实时观察池共用，保证两者口径一致） */
function pickItemOf(it) {
  return {
    code: it.code,
    name: it.name,
    industry: it.industry,
    score: it.score,
    signal: it.signal,
    price: it.price,
    changePct: it.changePct,
    bucket: it.bucket || (it.styleLink && it.styleLink.bucket) || null,
    board: (it.limitLink && it.limitLink.board && it.limitLink.board.key) || null,
    boardLabel: (it.limitLink && it.limitLink.board && it.limitLink.board.label) || null,
    boards: (it.limitLink && it.limitLink.boards) || 0,
    firstSeal: (it.limitLink && it.limitLink.firstSealLabel) || null,
    sealRatio: (it.limitLink && it.limitLink.sealRatio) || null,
    cycleStage: (it.limitLink && it.limitLink.cycleStage) || null,
    chaseRisk: (it.limitLink && it.limitLink.chaseRisk) || 0,
    limitAdjust: it.groups && it.groups.limitAdjust,
    styleAdjust: it.groups && it.groups.styleAdjust,
    eventAdjust: it.groups && it.groups.eventAdjust,
    eventPolarity: it.eventLink && it.eventLink.polarity,
    eventLabel: (it.eventLink && it.eventLink.watchItem && it.eventLink.watchItem.label) || null,
    macroAdjust: it.groups && it.groups.macroAdjust,
    marketAdjust: it.groups && it.groups.marketAdjust,
    groups: {
      technical: it.groups && it.groups.technical,
      capital: it.groups && it.groups.capital,
      buzz: it.groups && it.groups.buzz,
      weights: it.groups && it.groups.weights
    },
    volRatio: it.volRatio,
    turnover: it.turnover,
    mainFlowPct: it.mainFlowPct,
    pe: it.pe,
    patternScore: it.groups && it.groups.pattern,
    quant: quantOf({
      groups: it.groups, adjust: {
        market: it.groups && it.groups.marketAdjust, style: it.groups && it.groups.styleAdjust,
        event: it.groups && it.groups.eventAdjust, macro: it.groups && it.groups.macroAdjust,
        limit: it.groups && it.groups.limitAdjust, sum: it.groups && it.groups.adjustSum
      },
      volRatio: it.volRatio, turnover: it.turnover, mainFlowPct: it.mainFlowPct, pe: it.pe
    }),
    thesis: thesisOf({
      groups: it.groups, bucket: it.bucket || (it.styleLink && it.styleLink.bucket),
      boardLabel: (it.limitLink && it.limitLink.board && it.limitLink.board.label) || null,
      boards: (it.limitLink && it.limitLink.boards) || 0,
      firstSeal: (it.limitLink && it.limitLink.firstSealLabel) || null,
      sealRatio: (it.limitLink && it.limitLink.sealRatio) || null,
      limitAdjust: it.groups && it.groups.limitAdjust,
      styleAdjust: it.groups && it.groups.styleAdjust,
      eventAdjust: it.groups && it.groups.eventAdjust,
      eventPolarity: it.eventLink && it.eventLink.polarity,
      eventLabel: (it.eventLink && it.eventLink.watchItem && it.eventLink.watchItem.label) || null,
      cycleStage: (it.limitLink && it.limitLink.cycleStage) || null,
      chaseRisk: (it.limitLink && it.limitLink.chaseRisk) || 0,
      risk0: (it.risks && it.risks[0]) || null
    }),
    // 风险提示只取「真实风险」：跳过「未触发…风险项」这类否定式陈述，避免看多理由里出现反义句
    risks: (it.risks || []).filter(x => !/^未触发|^无显著|^暂未/.test(String(x))).slice(0, 3),
    // 多因素叠加存证：形态 + 指纹。复盘时按形态分组统计「共振是否真有超额」，
    // 统计裁决前不改任何评分——避免把「因子多」直接设计成胜率。
    stackForm: it.stackForm || (it.stack && it.stack.form) || null,
    stackLabel: it.stackLabel || (it.stack && it.stack.label) || null,
    stackFingerprint: it.stackFingerprint || (it.stack && it.stack.fingerprint) || null,
    stackPos: it.stackPos != null ? it.stackPos : (it.stack ? it.stack.posCount : null),
    stackNeg: it.stackNeg != null ? it.stackNeg : (it.stack ? it.stack.negCount : null),
    atrStopRef: it.atrStopRef || null
  };
}

function snapshot(items, meta = {}) {
  ensureDir();
  const bj = beijing();
  const date = meta.date || bj.date;
  const kind = meta.kind === 'open' ? 'open' : 'eve';
  const id = pickId(date, kind);
  const existing = readJsonl(PICKS).find(p => p.id === id);
  if (existing) return { ok: true, exists: true, id, at: existing.at, count: existing.items.length };

  const list = (items || []).slice(0, meta.limit || 24).map(pickItemOf);

  const rec = {
    id, date, kind, at: Date.now(), hhmm: bj.hhmm,
    note: meta.note || (kind === 'eve' ? '收盘后定格，用于次日决策' : '开盘前定格，用于当日观察'),
    context: {
      sentimentStage: meta.sentimentStage || null,
      sentimentFactor: meta.sentimentFactor || null,
      volumeYi: meta.volumeYi || null,
      volumeRegime: meta.volumeRegime || null,
      styleDominant: meta.styleDominant || null,
      marketRegime: meta.marketRegime || null,
      riskOffScore: meta.riskOffScore || null,
      // 外围市况（开盘档=美股隔夜+亚太早盘；收盘档=美股盘中）：只存事实涨跌，复盘时可回看当时外围环境
      overseas: Array.isArray(meta.overseas) && meta.overseas.length ? meta.overseas : null,
      focusCount: list.filter(x => x.signal === '重点关注').length
    },
    items: list
  };
  appendJsonl(PICKS, rec);
  prunePicks();
  return { ok: true, exists: false, id, at: rec.at, count: list.length };
}

function prunePicks() {
  const all = readJsonl(PICKS);
  if (all.length <= MAX_PICKS) return;
  const keep = all.slice(-MAX_PICKS);
  ensureDir();
  fs.writeFileSync(PICKS, keep.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
}

function listPicks({ date, kind, limit = 20 } = {}) {
  let all = readJsonl(PICKS);
  if (date) all = all.filter(p => p.date === date);
  if (kind) all = all.filter(p => p.kind === kind);
  return all.slice(-limit).reverse();
}

/* ------------------------------ 实时观察池 ------------------------------ */

/**
 * 实时观察池：盘中随评分滚动更新的动态名单（与 09:05 / 22:00 的「冻结定格」互补）。
 *
 * 【与定格的三点区别】
 *   1. 存储方式：live.json 滚动覆写（只保留当前状态 + 变动日志），不进 picks.jsonl；
 *   2. 复盘地位：不作为复盘基准——参考价随盘中行情漂移，用它复盘等于用事后行情自评。
 *      闭环仍以冻结定格为准；实时池解决的是「盘中名单变了能不能看见」；
 *   3. 附加信息：每只记录「何时进入池子」（enteredAt），新进/移出记入变动日志，
 *      用于观察「评分升降导致的进出」，这也是一种可复盘的行为数据。
 *
 * 【幂等】同一次评分结果重复调用只刷新 updatedAt，不产生虚假的进出记录。
 */
function liveSnapshot(items, meta = {}) {
  ensureDir();
  const bj = beijing();
  const date = meta.date || bj.date;
  const prev = readLive();
  const prevSameDay = prev && prev.date === date ? prev : null;
  const prevMap = new Map(((prevSameDay && prevSameDay.items) || []).map(x => [x.code, x]));

  const limit = meta.limit || 12;
  const list = (items || []).slice(0, limit).map(it => {
    const base = pickItemOf(it);
    const p = prevMap.get(it.code);
    return {
      ...base,
      // 实时池专属：何时进入池子、相对上次快照的评分变动
      enteredAt: p ? p.enteredAt : Date.now(),
      enteredHhmm: p ? p.enteredHhmm : bj.hhmm,
      prevScore: p ? p.score : null,
      isNew: !p
    };
  });

  const codes = new Set(list.map(x => x.code));
  const added = list.filter(x => x.isNew).map(x => ({ code: x.code, name: x.name, score: x.score, hhmm: bj.hhmm }));
  const removed = ((prevSameDay && prevSameDay.items) || [])
    .filter(x => !codes.has(x.code))
    .map(x => ({ code: x.code, name: x.name, score: x.score, hhmm: bj.hhmm }));

  // 变动日志只保留当天最近 60 条，避免文件无限膨胀
  const changes = [...((prevSameDay && prevSameDay.changes) || []),
    ...added.map(a => ({ type: 'in', ...a, at: Date.now() })),
    ...removed.map(r => ({ type: 'out', ...r, at: Date.now() }))]
    .slice(-60);

  // changed 判定：名单组成或任一评分变化才算「有更新」，供上层决定是否推送 SSE
  let changed = added.length > 0 || removed.length > 0;
  if (!changed && prevSameDay) {
    for (const x of list) { if (x.prevScore != null && x.prevScore !== x.score) { changed = true; break; } }
  }

  const doc = {
    ok: true,
    date, kind: 'live',
    updatedAt: Date.now(), hhmm: bj.hhmm,
    count: list.length,
    note: '盘中随评分滚动更新，仅供当日观察；复盘基准仍以 09:05 / 22:00 冻结定格为准',
    context: {
      sentimentStage: meta.sentimentStage || null,
      volumeYi: meta.volumeYi || null,
      styleDominant: meta.styleDominant || null,
      marketRegime: meta.marketRegime || null,
      focusCount: list.filter(x => x.signal === '重点关注').length
    },
    items: list,
    changes
  };
  writeJson(LIVE, doc);
  return { ok: true, date, count: list.length, changed, added: added.length, removed: removed.length };
}

function readLive() {
  try { return JSON.parse(fs.readFileSync(LIVE, 'utf8')); }
  catch (_) { return null; }
}

/* --------------------------------- 复盘 --------------------------------- */

const KLINE_TTL = 30 * 60 * 1000;
let klineCache = new Map();

async function barOf(code, date, market) {
  const key = code + ':' + (market || '');
  const hit = klineCache.get(key);
  if (hit && Date.now() - hit.at < KLINE_TTL) return hit.bars.find(b => b.d === date) || null;
  const bars = await ic.fetchKline(code, 60, market);
  klineCache.set(key, { at: Date.now(), bars });
  return bars.find(b => b.d === date) || null;
}

/** 基准指数：按市值层选代理，超额收益才有可比性 */
const BUCKET_INDEX = { micro: '932000', small: '932000', mid: '000905', large: '000300' };

async function benchRet(bucket, date) {
  const code = BUCKET_INDEX[bucket] || '000905';
  try {
    const bars = await ic.fetchKline(code, 60, 'index');
    const i = bars.findIndex(b => b.d === date);
    if (i <= 0) return null;
    return pct(bars[i].c, bars[i - 1].c);
  } catch (_) { return null; }
}

/**
 * 复盘：只处理「目标交易日已收盘且有日线」的定格。
 * 目标日 = open 档 → 当天；eve 档 → 下一个交易日。
 * 收益口径：以定格时的收盘价为参考价，衡量目标日收盘相对参考价的涨跌。
 */
async function reviewPending(opts = {}) {
  const picks = readJsonl(PICKS);
  if (!picks.length) return { ok: true, reviewed: 0, pending: 0, note: '尚无定格名单' };

  const done = new Set(readJsonl(OUTCOMES).map(o => o.pickId + ':' + o.code));
  const cal = await ic.tradingCalendar().catch(() => []);
  const latestCal = cal.length ? cal[cal.length - 1] : null;

  let reviewed = 0, pending = 0;
  const results = [];

  for (const p of picks.slice(-60)) {
    const idx = cal.indexOf(p.date);
    let target = null;
    if (p.kind === 'open') target = p.date;
    else if (idx >= 0 && idx + 1 < cal.length) target = cal[idx + 1];
    if (!target) { pending++; continue; }
    if (latestCal && target > latestCal) { pending++; continue; }

    const todo = p.items.filter(it => !done.has(p.id + ':' + it.code));
    if (!todo.length) continue;

    for (const it of todo) {
      const bar = await barOf(it.code, target).catch(() => null);
      if (!bar) { pending++; continue; }
      const ret = pct(bar.c, it.price);
      if (ret == null) { pending++; continue; }
      const bRet = await benchRet(it.bucket, target);
      const o = {
        pickId: p.id, date: p.date, kind: p.kind, targetDate: target,
        code: it.code, name: it.name, industry: it.industry,
        signal: it.signal, score: it.score, bucket: it.bucket,
        board: it.board, boardLabel: it.boardLabel, boards: it.boards,
        cycleStage: it.cycleStage, chaseRisk: it.chaseRisk,
        // 叠加形态随复盘结果带出，供归纳阶段按形态分组统计真实超额
        stackForm: it.stackForm || null, stackLabel: it.stackLabel || null,
        stackFingerprint: it.stackFingerprint || null,
        stackPos: it.stackPos != null ? it.stackPos : null,
        stackNeg: it.stackNeg != null ? it.stackNeg : null,
        priceRef: it.price, close: bar.c,
        ret: round(ret, 2),
        high: round(pct(bar.h, it.price), 2),
        low: round(pct(bar.l, it.price), 2),
        bench: bRet == null ? null : round(bRet, 2),
        excess: bRet == null ? null : round(ret - bRet, 2),
        // 命中定义：跑赢同市值层基准才算「判断成立」。
        // 不把「大盘整体上涨带来的浮盈」算成能力，这是评估体系可信的前提。
        // 2026-11-20 口径修正：基准取不到时不再退化为 ret>0（旧写法与本注释自相矛盾），
        // 改为 hit=null 并以 hitBasis 标注；statsOf 只用有基准样本计算命中率与超额。
        hit: bRet == null ? null : ret > bRet,
        hitBasis: bRet == null ? 'no_bench' : 'bench',
        reviewedAt: Date.now()
      };
      appendJsonl(OUTCOMES, o);
      results.push(o);
      reviewed++;
    }
  }
  return { ok: true, reviewed, pending, sample: results.slice(0, 30) };
}

function listOutcomes({ days = 60 } = {}) {
  const all = readJsonl(OUTCOMES);
  const cut = Date.now() - days * 86400000;
  return all.filter(o => (o.reviewedAt || 0) >= cut);
}

/* --------------------------------- 归纳 --------------------------------- */

function statsOf(rows) {
  if (!rows.length) return null;
  const rets = rows.map(r => r.ret).filter(Number.isFinite);
  // 2026-11-20 口径修正：命中率与平均超额统一用「有基准」的可比样本。
  // 旧口径 hitRate 用全部样本（含基准缺失时退化为 ret>0 的判定，与命中定义矛盾），
  // 而 avgExcess 只用有基准子样本——两个数不同源，propose() 却直接拿 avgExcess 算回流乘数。
  // 现在：hitRate = 有基准样本中跑赢基准的比例（与 avgExcess 同源）；
  //       hitRateRaw = 旧口径（全样本、含退化判定），仅作历史对照，不再用于任何回流判断。
  const withBench = rows.filter(r => Number.isFinite(r.excess));
  const exs = withBench.map(r => r.excess);
  const hitsBench = withBench.filter(r => r.hit === true).length;
  const hitsAll = rows.filter(r => r.hit === true).length;
  return {
    n: rows.length,
    nBench: withBench.length,
    hitRate: withBench.length ? round((hitsBench / withBench.length) * 100, 1) : null,
    hitRateRaw: round((hitsAll / rows.length) * 100, 1),
    avgRet: round(mean(rets), 2),
    avgExcess: round(mean(exs), 2),
    // 盈亏比：正超额均值 / 负超额绝对值均值，衡量「对了赚多少、错了亏多少」
    payoff: (() => {
      const win = exs.filter(x => x > 0), loss = exs.filter(x => x < 0);
      if (!win.length || !loss.length) return null;
      return round(mean(win) / Math.abs(mean(loss)), 2);
    })()
  };
}

/** 按一个维度切分样本，产出候选结论 */
function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null || k === '') continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()].map(([k, v]) => ({ key: k, ...statsOf(v) }));
}

const LESSON_DIMENSIONS = [
  {
    id: 'signal', label: '信号等级',
    key: r => r.signal,
    claim: s => '信号「' + s.key + '」的标的次日跑赢同层基准的比例 ' + s.hitRate + '%，平均超额 ' + s.avgExcess + '%（n=' + s.n + '）',
    target: 'signal'
  },
  {
    id: 'bucket', label: '市值层',
    key: r => r.bucket,
    claim: s => '「' + s.key + '」市值层在观察池中的命中率 ' + s.hitRate + '%，平均超额 ' + s.avgExcess + '%（n=' + s.n + '）',
    target: 'bucket'
  },
  {
    id: 'board', label: '板型',
    key: r => r.board,
    claim: s => '板型「' + s.key + '」次日命中率 ' + s.hitRate + '%、平均超额 ' + s.avgExcess + '%（n=' + s.n + '）',
    target: 'limit'
  },
  {
    id: 'stage', label: '情绪阶段',
    key: r => r.cycleStage,
    claim: s => '情绪「' + s.key + '」阶段，观察池命中率 ' + s.hitRate + '%、平均超额 ' + s.avgExcess + '%（n=' + s.n + '）',
    target: 'stage'
  },
  {
    id: 'chase', label: '追高风险',
    key: r => (r.chaseRisk >= 65 ? '高(≥65)' : r.chaseRisk >= 40 ? '中(40-64)' : '低(<40)'),
    claim: s => '追高风险「' + s.key + '」组命中率 ' + s.hitRate + '%、平均超额 ' + s.avgExcess + '%（n=' + s.n + '）',
    target: 'chase'
  },
  {
    id: 'boards', label: '连板高度',
    key: r => (r.boards >= 3 ? '≥3板' : r.boards === 2 ? '2板' : r.boards === 1 ? '1板' : '未涨停'),
    claim: s => '「' + s.key + '」组次日命中率 ' + s.hitRate + '%、平均超额 ' + s.avgExcess + '%（n=' + s.n + '）',
    target: 'limit'
  },
  {
    // 第 7 维：多因素叠加。只统计「共振组是否真跑赢」，不自动回流评分。
    // 原因：共振是新假设，胜率必须由复盘统计裁决，不能因为「因子多」就设计加分。
    id: 'stack', label: '多因素叠加形态',
    // 历史复盘样本没有叠加标注（该功能上线前定格的），返回 null 让 groupBy 跳过，
    // 不与新样本混在一起制造「未标注组」的噪声结论。
    key: r => r.stackForm || null,
    claim: s => '叠加形态「' + s.key + '」的标的次日跑赢同层基准的比例 ' + s.hitRate + '%，平均超额 ' + s.avgExcess + '%（n=' + s.n + '）——这是「共振是否真有效」的统计裁决，非设计结论',
    target: 'stack', observeOnly: true
  }
];

/**
 * 生成经验条目。策略：
 *  - 只对 n ≥ MIN_N 的组出结论（小样本一律不写，避免用 3 个样本「总结规律」）；
 *  - 结论写成可证伪的陈述（含样本量、命中率、平均超额）；
 *  - 同一 (维度, 组) 已有 approved 经验且样本没翻倍时，不重复生成，避免刷屏；
 *  - 结论不自动改权重，只作为待审建议 + 回流候选。
 */
function buildLessons(opts = {}) {
  const rows = readJsonl(OUTCOMES);
  if (rows.length < MIN_N) {
    return { ok: true, created: 0, note: '复盘样本 ' + rows.length + ' 条，不足 ' + MIN_N + ' 条，暂不归纳' };
  }
  const existing = readJsonl(LESSONS);
  const latest = new Map();
  for (const l of existing) latest.set(l.key, l);

  const created = [];
  for (const dim of LESSON_DIMENSIONS) {
    // 2026-11-20 门槛收紧：组内「有基准的可比样本」也必须 ≥ MIN_N，
    // 防止用大量无基准退化判定凑数产出「命中率与超额不同源」的经验。
    const groups = groupBy(rows, dim.key).filter(g => g.n >= MIN_N && (g.nBench || 0) >= MIN_N);
    for (const g of groups) {
      const key = dim.id + '::' + g.key;
      const prev = latest.get(key);
      if (prev && prev.status === 'pending') continue;
      if (prev && prev.status === 'approved' && g.n < prev.evidence.n * 2) continue;

      const conf = g.n >= 40 ? '高' : g.n >= 20 ? '中' : '低';
      const lesson = {
        id: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        key, dim: dim.id, dimLabel: dim.label, group: g.key,
        target: dim.target,
        claim: dim.claim(g),
        evidence: { n: g.n, hitRate: g.hitRate, avgRet: g.avgRet, avgExcess: g.avgExcess, payoff: g.payoff },
        confidence: conf,
        status: 'pending',
        createdAt: Date.now(),
        reviewedAt: null,
        reviewer: null,
        note: null,
        // 回流建议：只有当组间差异足够大、样本足够时才给出乘数建议，
        // 否则只作为「观察结论」存在，不影响打分。
        proposal: propose(g, dim)
      };
      appendJsonl(LESSONS, lesson);
      created.push(lesson);
    }
  }
  return { ok: true, created: created.length, items: created.slice(0, 12), total: rows.length };
}

/** 把统计结论翻译成「可执行的乘数建议」，并写清适用条件 */
function propose(g, dim) {
  const ex = g.avgExcess;
  // 观察型维度（如多因素叠加）只沉淀统计结论，不生成回流乘数。
  // 这类维度是新假设，必须先由人工审核确认「共振确实有超额」，才谈得上影响判断。
  if (dim.observeOnly) return null;
  if (ex == null) return null;
  // 阈值：超额 ±1% 以上才认为有经济意义（A 股日波动 2%，低于 1% 的超额无法覆盖成本）
  if (Math.abs(ex) < 1) return null;
  const mult = ex > 0 ? clamp(1 + Math.min(ex, 4) * 0.05, 1, 1.2)
    : clamp(1 + Math.max(ex, -4) * 0.05, 0.8, 1);
  return {
    target: dim.target,
    cond: { [dim.id]: g.key },
    mult: round(mult, 2),
    note: '当 ' + dim.label + ' = ' + g.key + ' 时，历史平均超额 ' + ex + '%（n=' + g.n + '），建议乘数 ×' + round(mult, 2)
  };
}

/* --------------------------------- 审核 --------------------------------- */

function listLessons({ status, limit = 50 } = {}) {
  const all = readJsonl(LESSONS);
  const latestByKey = new Map();
  for (const l of all) latestByKey.set(l.key, l);
  let rows = [...latestByKey.values()];
  if (status) rows = rows.filter(l => l.status === status);
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rows.slice(0, limit);
}

/**
 * 审核：approved 才会进入规则库。
 * 审核动作本身也写一条新版本行（JSONL 只追加），保留完整流转痕迹。
 */
function auditLesson(id, action, opts = {}) {
  const all = readJsonl(LESSONS);
  const target = all.filter(l => l.id === id).pop() || all.find(l => l.key === id);
  if (!target) return { ok: false, error: '经验不存在：' + id };
  const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : null;
  if (!status) return { ok: false, error: '动作必须是 approve / reject' };

  const next = {
    ...target,
    id: target.id,
    status,
    reviewedAt: Date.now(),
    reviewer: opts.reviewer || 'user',
    note: opts.note || null
  };
  appendJsonl(LESSONS, next);
  rebuildRules();
  return { ok: true, lesson: next, rules: readRules().items.length };
}

/** 规则库由 approved 经验重建，永远是经验库的投影，不独立演化 */
function rebuildRules() {
  const approved = listLessons({ status: 'approved', limit: 500 });
  const items = approved.filter(l => l.proposal).map(l => ({
    id: l.id, key: l.key, target: l.proposal.target,
    cond: l.proposal.cond, mult: l.proposal.mult,
    note: l.proposal.note, evidence: l.evidence, approvedAt: l.reviewedAt
  }));
  const doc = { version: Date.now(), updatedAt: Date.now(), count: items.length, items };
  writeJson(RULES, doc);
  invalidateRulesCache();
  return doc;
}

let rulesCache = { at: 0, doc: null };

function readRules() {
  // 评分链路每只股票都会调用，缓存 60 秒；审核动作后 rebuildRules 会立即失效缓存
  if (rulesCache.doc && Date.now() - rulesCache.at < 60000) return rulesCache.doc;
  if (!fs.existsSync(RULES)) {
    rulesCache = { at: Date.now(), doc: { version: 0, updatedAt: 0, count: 0, items: [] } };
    return rulesCache.doc;
  }
  try {
    rulesCache = { at: Date.now(), doc: JSON.parse(fs.readFileSync(RULES, 'utf8')) };
    return rulesCache.doc;
  } catch (_) {
    rulesCache = { at: Date.now(), doc: { version: 0, updatedAt: 0, count: 0, items: [] } };
    return rulesCache.doc;
  }
}

function invalidateRulesCache() { rulesCache = { at: 0, doc: null }; }

function clearRules() {
  const doc = { version: Date.now(), updatedAt: Date.now(), count: 0, items: [] };
  writeJson(RULES, doc);
  invalidateRulesCache();
  return doc;
}

/**
 * 回流：把 approved 规则换算成对「涨停结构修正」的乘数。
 * 故意只作用于涨停结构这一项：它是经验最容易失效、也最需要按情绪阶段/板型分档的地方。
 * 上限 ±2 分，且不改变符号——经验微调判断，不接管判断。
 */
function biasFor({ stage, board, chaseRisk, boards } = {}) {
  const rules = readRules().items || [];
  let mult = 1;
  const notes = [];
  for (const r of rules) {
    const c = r.cond || {};
    let match = true;
    if (c.stage != null && c.stage !== stage) match = false;
    if (c.board != null && c.board !== board) match = false;
    if (c.chase != null) {
      const bucket = chaseRisk >= 65 ? '高(≥65)' : chaseRisk >= 40 ? '中(40-64)' : '低(<40)';
      if (c.chase !== bucket) match = false;
    }
    if (c.boards != null) {
      const b = boards >= 3 ? '≥3板' : boards === 2 ? '2板' : boards === 1 ? '1板' : '未涨停';
      if (c.boards !== b) match = false;
    }
    if (c.signal != null || c.bucket != null) match = false; // 这两类不作用于涨停修正
    if (!match) continue;
    mult *= r.mult;
    notes.push('经验 ' + r.key + ' ×' + r.mult);
  }
  return { mult: round(clamp(mult, 0.8, 1.25), 3), notes, maxBias: MAX_BIAS };
}

/* --------------------------------- 概览 --------------------------------- */

function status() {
  const picks = readJsonl(PICKS);
  const outs = readJsonl(OUTCOMES);
  const lessons = readJsonl(LESSONS);
  const latestByKey = new Map();
  for (const l of lessons) latestByKey.set(l.key, l);
  const ls = [...latestByKey.values()];
  const focused = outs.filter(o => o.signal === '重点关注');
  const rules = readRules();

  return {
    ok: true,
    picks: picks.length,
    lastPick: picks.length ? { id: picks[picks.length - 1].id, date: picks[picks.length - 1].date, kind: picks[picks.length - 1].kind, at: picks[picks.length - 1].at } : null,
    outcomes: outs.length,
    lastOutcome: outs.length ? { date: outs[outs.length - 1].targetDate, code: outs[outs.length - 1].code } : null,
    overall: statsOf(outs),
    focus: statsOf(focused),
    lessons: {
      total: ls.length,
      pending: ls.filter(l => l.status === 'pending').length,
      approved: ls.filter(l => l.status === 'approved').length,
      rejected: ls.filter(l => l.status === 'rejected').length
    },
    rules: { count: rules.count, updatedAt: rules.updatedAt },
    // 样本充足度提示：让用户一眼知道「结论现在能不能信」
    readiness: outs.length === 0 ? '无复盘样本'
      : outs.length < 30 ? '样本不足（' + outs.length + '/30），结论仅供参考'
        : outs.length < 120 ? '样本初步可用（' + outs.length + '），建议只看方向'
          : '样本充足（' + outs.length + '），可用于规则回流'
  };
}

module.exports = {
  snapshot, listPicks,
  liveSnapshot, readLive,
  reviewPending, listOutcomes,
  buildLessons, listLessons, auditLesson,
  rebuildRules, readRules, clearRules, biasFor, invalidateRulesCache,
  status, statsOf, thesisOf, quantOf,
  PICKS, OUTCOMES, LESSONS, RULES, LIVE, MIN_N, MAX_BIAS
};
