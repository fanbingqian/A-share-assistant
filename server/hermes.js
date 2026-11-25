'use strict';

/**
 * hermes.js — 核心智能体桥接层（贯穿全部五个模块）
 *
 * 【架构】
 *   v2 外壳 / 各业务模块
 *        │  chat({ messages, context, role, task })
 *        ▼
 *   hermes.js ──backend=auto──┬── official: HTTP → Hermes Agent (WSL2, Python)
 *                            │              Hermes 内部用 DeepSeek（OpenAI 兼容端点）
 *                            └── fallback: Node 直连 DeepSeek（现有薄适配器，零依赖）
 *
 * 【为什么这样设计】
 *   - 用户选定「真装官方 Hermes + 桥接」：官方 Hermes 是核心，负责持久记忆、技能自进化、
 *     MCP 工具、跨模块上下文；DeepSeek 是它调用的底层模型。
 *   - 本机 WSL 被安全策略拦截，无法从这里安装/启动 Hermes；所以桥接层在 Hermes 未就绪时
 *     自动降级到直连 DeepSeek，保证骨架能跑通。用户在 WSL2 里跑一次 setup 脚本即可切换。
 *   - 所有 LLM 输出遵守既有安全纪律：禁买卖建议词、禁编造数字、不改任何评分（affectsScore=false）。
 *
 * 【对外接口】
 *   status(cfg)                      查看后端状态（official 是否在线、当前走哪条路）
 *   chat(cfg, opts)                  统一对话入口，返回 { ok, text, backend, usage, ... }
 *   collectContext()                 汇总全局数据快照，注入 system，让智能体「了解整个板块」
 *   ask(cfg, module, question, extra) 便捷封装：带模块上下文的一次提问
 *   test(cfg)                        连通自检（依次试 official、fallback）
 *
 * 【配置】config.agent.hermes = { enabled, backend, officialUrl, timeoutMs, fallbackToDeepSeek,
 *                                  memory, skills, contextModules }
 */

const TIMEOUT_OFFICIAL = 60000;
const TIMEOUT_FALLBACK = 60000;
const FORBIDDEN_ADVICE = ['买入', '卖出', '加仓', '减仓', '建仓', '清仓', '抄底', '止盈', '止损', '满仓', '梭哈'];

// 【L2 硬拦截 · 否定语境白名单】
// 背景：模型正确拒绝（"我不能给出买入/卖出的指令"）时会复述买卖词，旧版 hasForbidden
// 只看 s.includes(w) 会把这类合规回答误判为违规（ok:false）。这里改为"逐次出现 + 局部语境"
// 判定：只有出现在肯定/祈使语境里的买卖词才拦截；被否定/拒绝词修饰的视为合规拒绝，放行。
// 注意：宁可放行极少数"双重否定"边缘句，也不再误杀正确拒绝——安全底线由 BASE_SYSTEM +
// 肯定语境拦截共同保证，且所有输出仍可溯源到 rawText。
const NEGATION_CUES = [
  '不能', '不可', '不应', '不该', '不宜', '不得', '不准', '不要', '不会', '无法', '没法',
  '禁止', '严禁', '切勿', '请勿', '拒绝', '避免', '不构成', '不提供', '不给出', '不进行',
  '不做出', '不建议', '不推荐', '不是', '非', '没有', '别', '免于',
  // 复合否定短语：去掉后不能再被识别成"肯定建议"
  '不能建议', '无法建议', '不应建议', '不能推荐', '无法推荐', '不能给出', '无法给出',
  '不能提供', '无法提供', '不给', '不做', '不发表'
];
const AFFIRMATIVE_CUES = [
  '建议', '推荐', '可以', '应该', '应当', '宜于', '择机', '逢低', '马上', '立刻',
  '现在', '考虑', '打算', '计划'
];
// 这些是名词短语（不是"建议某人买卖"的动词），剔除后避免其中的"建议"被误判为肯定建议词。
// 只用于局部窗口清洗，不参与"整句是否有否定词"的判断。
const NOUN_TERMS = ['投资建议', '买卖建议', '操作建议', '交易建议', '个股建议', '投资意见'];
// 【事实/状态描述语境】买卖词后紧跟这些词时，是"记录/指标/状态"的陈述，不是操作建议。
// 例："无已清仓记录""买入次数统计""止损线设在8%"——都应放行。
// 仅用于放行判定，不参与肯定建议词检测；句中若仍有"建议/推荐/可以"等肯定词则不豁免。
const FACTUAL_SUFFIXES = [
  '记录', '历史', '明细', '次数', '统计', '表现', '占比', '清单', '列表',
  '规则', '条件', '阈值', '线', '位', '价', '信号', '逻辑', '口径'
];
const SENTENCE_BREAKS = ['。', '！', '？', '!', '?', '\n', '；', ';'];

/* ------------------------------ 工具 ------------------------------ */

function beijingISO(ts = Date.now()) {
  return new Date(ts + 8 * 3600e3).toISOString();
}
function maskKey(k) {
  if (!k) return null;
  return String(k).length > 10 ? String(k).slice(0, 6) + '****' + String(k).slice(-4) : 'sk-****';
}
function firstBreakAt(s, from, dir = 1) {
  for (let i = from; i >= 0 && i < s.length; i += dir) {
    if (SENTENCE_BREAKS.includes(s[i])) return i;
  }
  return dir > 0 ? s.length : -1;
}

/** 判断某个买卖词的一次出现是否处于"合规拒绝 / 事实陈述"语境（应放行） */
function isRefusalOccurrence(s, idx, word) {
  // 所在句子范围
  const start = firstBreakAt(s, idx - 1, -1) + 1;
  const end = firstBreakAt(s, idx + 1, 1);
  const sentence = s.slice(start, end);
  const after = s.slice(idx + word.length, end);

  // ① 事实/状态描述语境：买卖词后紧跟"记录/历史/线/位/价…"等名词后缀，
  // 且整句没有肯定建议词 → 这是对持仓/规则的陈述，不是建议，放行。
  // 例："无已清仓记录""你的股池有3次买入记录""止损线设在8%"。
  if (FACTUAL_SUFFIXES.some(x => after.trimStart().startsWith(x))) {
    if (!AFFIRMATIVE_CUES.some(c => sentence.includes(c))) return true;
  }

  // ② 整句没有任何否定信号 → 视为肯定/陈述语境，直接拦截。
  // 单字"不/无/未"作为兜底：覆盖"都不输出/不予/无已清仓/未卖出"等未列入词表的否定表达，
  // 只在这里用于"是否进入细化判断"，不参与下面的局部窗口清洗（避免过度放行）。
  if (!NEGATION_CUES.some(c => sentence.includes(c))
      && !sentence.includes('不') && !sentence.includes('无') && !sentence.includes('未')) return false;
  // 取买卖词前 10 字的局部窗口，剔除否定短语后再看是否残留"肯定建议词"
  const localStart = Math.max(start, idx - 10);
  let before = s.slice(localStart, idx);
  for (const c of NOUN_TERMS) before = before.split(c).join('');
  for (const c of NEGATION_CUES) before = before.split(c).join('');
  const hasAffirmative = AFFIRMATIVE_CUES.some(c => before.includes(c));
  // 局部无肯定建议词 → 视为被否定修饰的合规拒绝，放行
  return !hasAffirmative;
}

/**
 * 【纪律调整 · 2026-11-24】按使用者要求取消「不给选股建议 / 不推荐买卖 / 不预测涨跌」的拒答纪律。
 * 旧实现会按 FORBIDDEN_ADVICE 买卖词硬拦截，导致模型即便基于真实数据做结构分析也被判违规，
 * 并生成「选股建议我不给，这是纪律」这类拒答话术。现网关降级为「不拦截」：
 * 智能体可基于系统真实计算结果摊开分析、给观察清单与条件化观点；
 * 底线由 BASE_SYSTEM 承担 —— 不编造数据、标注来源时点、区分事实/计算/推测、给证伪条件、风险自担。
 * 保留函数签名与常量，兼容 finalize() / agent-loop.js 等既有调用方，便于审计与日后按需恢复。
 */
function hasForbidden(text) {
  return [];
}

/** 从任意模块数据里抽取「可安全喂给模型」的精简事实，避免把整包 JSON 塞爆上下文 */
function compact(v, depth = 0) {
  if (v == null) return null;
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  if (typeof v === 'string') return v.length > 160 ? v.slice(0, 160) + '…' : v;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 8).map(x => compact(x, depth + 1));
  if (typeof v === 'object') {
    if (depth >= 3) return '[对象]';
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (['config', 'history', 'errors', 'sourceLatency', 'dataNote'].includes(k)) continue;
      out[k] = compact(val, depth + 1);
    }
    return out;
  }
  return null;
}

/* ------------------------------ 全局上下文汇总 ------------------------------ */

/**
 * 汇总各业务模块的关键数据，让常驻对话智能体「了解我的整个板块」。
 * 只取结论与统计，不取逐条明细；由调用方决定注入多少。
 */
function collectContext(snapshotRef = {}) {
  const s = snapshotRef || {};
  const ctx = {
    at: beijingISO().slice(0, 16).replace('T', ' '),
    market: s.market ? compact(s.market) : null,
    quotes: Array.isArray(s.quotes) ? s.quotes.slice(0, 12).map(q => ({
      name: q.name, code: q.code, price: q.price, changePct: q.changePct
    })) : null,
    style: s.style ? { conclusion: s.style.conclusion, volume: s.style.volume } : null,
    limitup: s.limitup ? { conclusion: s.limitup.conclusion, summary: s.limitup.summary, sentiment: s.limitup.sentiment } : null,
    events: s.events ? { conclusion: s.events.conclusion } : null,
    sector: s.strength ? {
      leaders: Array.isArray(s.strength.leaders) ? s.strength.leaders.slice(0, 8).map(x => ({ name: x.name, chg5: x.chg5, ex10: x.ex10, breadth: x.breadth })) : null
    } : null,
    stocks: Array.isArray(s.stocks && s.stocks.items)
      ? s.stocks.items.slice(0, 18).map(x => ({ code: x.code, name: x.name, score: x.score, signals: x.signals }))
      : null,
    portfolio: null, // 由 /api/v2/chat 调用时按需注入（见 server.js），避免每次快照读盘
    journal: s.journal ? { stats: s.journal.overall } : null,
    // 短线情绪三项 + 四类选股/次日双池：只读已落盘快照，精简后注入，避免把全量明细塞进 prompt
    sentiment: (() => {
      try {
        const d = require('./sentiment').latest();
        if (!d || !d.ok) return null;
        return {
          summary: d.shortTerm && d.shortTerm.summary,
          money: d.moneyEffect && d.moneyEffect.ok ? {
            avgRet: d.moneyEffect.avgRet, upRatio: d.moneyEffect.upRatio,
            againLimitRatio: d.moneyEffect.againLimitRatio, sample: d.moneyEffect.sample
          } : null,
          height: d.boardHeight && d.boardHeight.maxBoards,
          heightLevel: d.boardHeight && d.boardHeight.heightLevel,
          ladderText: d.boardHeight && d.boardHeight.ladderText,
          breakRate: d.breakRate && d.breakRate.rate,
          breakLevel: d.breakRate && d.breakRate.level
        };
      } catch (_) { return null; }
    })(),
    strategy: (() => {
      try {
        const d = require('./strategy').latest();
        if (!d || !d.ok) return null;
        const f = d.fourClass || {}, p = d.pools || {};
        return {
          counts: f.counts || null, totalRows: f.totalRows || 0,
          top: (f.items || []).slice(0, 8).map(x => ({
            code: x.code, name: x.name, kindLabel: x.kindLabel, classes: x.classes,
            industry: x.industry, role: x.role, score: x.score, driverSummary: x.driverSummary
          })),
          watch: (p.watchPool || []).slice(0, 8).map(x => ({ code: x.code, name: x.name, kind: x.kind, why: x.why })),
          risk: (p.riskPool || []).slice(0, 8).map(x => ({ code: x.code, name: x.name, riskType: x.riskType, reason: x.reason })),
          alerts: p.alerts || [], note: p.note || null
        };
      } catch (_) { return null; }
    })()
  };
  return ctx;
}

/** 把上下文转成「人类可读、字段明确」的 system 前缀：避免模型看不懂嵌套 JSON 而误判为无数据 */
function contextPrefix(ctx, modules) {
  if (!ctx) return '';
  const allow = Array.isArray(modules) && modules.length ? modules : Object.keys(ctx);
  const has = k => allow.includes(k) && ctx[k] != null;
  const lines = ['【当前全局数据快照 · 时间 ' + (ctx.at || '--') + '】'];

  if (has('style')) {
    const v = ctx.style.volume || {};
    lines.push('— 两市量能：成交额 ' + (v.totalAmountYi != null ? v.totalAmountYi + '亿' : '未知') +
      '，较20日均量 ' + (v.changePct != null ? v.changePct + '%' : '未知') +
      '，状态「' + (v.state || '未知') + '」，量比20 ' + (v.ratio20 != null ? v.ratio20 : '未知') +
      '，沪指 ' + (v.shPct != null ? v.shPct + '%' : '未知') + '，深成 ' + (v.szPct != null ? v.szPct + '%' : '未知') +
      (v.breadth && v.breadth.upRatio != null ? '，上涨占比 ' + v.breadth.upRatio + '%' : ''));
    if (ctx.style.conclusion) lines.push('  风格结论：' + ctx.style.conclusion);
  }
  if (has('market')) {
    const m = ctx.market;
    lines.push('— 外围市场：风险状态「' + (m.regime || '未知') + '」，综合分 ' + (m.score != null ? m.score : '未知') +
      (m.factors ? '，因子 ' + JSON.stringify(m.factors).slice(0, 220) : ''));
  }
  if (has('quotes') && ctx.quotes.length) {
    lines.push('— 主要行情：' + ctx.quotes.slice(0, 8).map(q => (q.name || q.code || '?') + ' ' + (q.changePct != null ? q.changePct + '%' : '')).join('；'));
  }
  if (has('limitup')) {
    const l = ctx.limitup;
    if (l.conclusion) lines.push('— 涨停结构：' + l.conclusion);
    else lines.push('— 涨停结构：' + JSON.stringify(l).slice(0, 240));
  }
  if (has('sector')) {
    lines.push('— 板块：' + JSON.stringify(ctx.sector).slice(0, 600));
  }
  if (has('events') && ctx.events.conclusion) lines.push('— 公司事件：' + ctx.events.conclusion);
  if (has('calendar') && Array.isArray(ctx.calendar) && ctx.calendar.length) {
    const evs = ctx.calendar.slice(0, 10).map(e =>
      (e.date || '?') + ' [' + (e.grade || '?') + '级' + (e.verified ? '·已确认' : '·待核实') + '] ' + (e.name || '?') +
      (Array.isArray(e.sectors) && e.sectors.length ? '（相关：' + e.sectors.join('/') + '）' : '')
    ).join('；');
    lines.push('— 日程与事件（未来 ' + ctx.calendar.length + ' 条）：' + evs);
  }
  if (has('stocks') && Array.isArray(ctx.stocks) && ctx.stocks.length) {
    lines.push('— 观察池前几名：' + ctx.stocks.slice(0, 8).map(x => (x.code || '') + ' ' + (x.name || '') + ' 评分' + (x.score != null ? x.score : '?')).join('；'));
  }
  if (has('pickInsight') && ctx.pickInsight) {
    const pi = ctx.pickInsight;
    lines.push('— 选股解释层（程序判定，非荐股）：' + (pi.note || '').slice(0, 120));
    if (Array.isArray(pi.leaders) && pi.leaders.length) {
      lines.push('— 板块领跑股：' + pi.leaders.slice(0, 8).map(l =>
        (l.industry || '?') + '→' + (l.name || l.code || '?') + '（' + String(l.basis || '').slice(0, 70) + '，跟随' + (l.followerCount != null ? l.followerCount : '?') + '只）'
      ).join('；'));
    }
    if (Array.isArray(pi.topDrivers) && pi.topDrivers.length) {
      lines.push('— 个股上涨驱动线索（可核验事实，非因果认定）：' + pi.topDrivers.slice(0, 6).map(x =>
        (x.name || x.code || '?') + '[' + (x.role || '?') + '/' + (x.kind || '?') + ']：' + (x.drivers || []).map(d => d.text.slice(0, 50)).join(' | ')
      ).join('；'));
    }
  }
  if (has('sentiment') && ctx.sentiment) {
    const st = ctx.sentiment;
    lines.push('— 短线情绪（程序计算，非涨跌预测）：' + (st.summary || '数据不足'));
    if (st.money) lines.push('  赚钱效应：昨日涨停股今日平均 ' + (st.money.avgRet > 0 ? '+' : '') + st.money.avgRet + '%，上涨占比 ' + st.money.upRatio + '%，再涨停占比 ' + st.money.againLimitRatio + '%（样本 ' + st.money.sample + '只）');
    if (st.ladderText) lines.push('  连板梯队：' + st.ladderText + '，最高 ' + st.height + ' 板（' + st.heightLevel + '）');
    if (st.breakRate != null) lines.push('  炸板率：' + st.breakRate + '%（' + st.breakLevel + '）');
  }
  if (has('strategy') && ctx.strategy) {
    const sg = ctx.strategy;
    if (sg.counts) lines.push('— 四类量化选股（趋势/低吸/打板/趋势突破，同一板块内逐行标注类别）：' + JSON.stringify(sg.counts) + '，去重后 ' + sg.totalRows + ' 行');
    if (Array.isArray(sg.top) && sg.top.length) lines.push('  前几名（类别/行业/角色/依据）：' + sg.top.map(x =>
      (x.code || '') + ' ' + (x.name || '') + '[' + (Array.isArray(x.classes) ? x.classes.join('/') : (x.kindLabel || '?')) + '/' + (x.industry || '行业未知') + '/' + (x.role || '-') + ']：' + String(x.driverSummary || '').slice(0, 50)
    ).join('；'));
    if (Array.isArray(sg.watch) && sg.watch.length) lines.push('— 次日备选观察池（研究清单，非推荐）：' + sg.watch.map(x => (x.name || x.code) + '（' + String(x.why || '').slice(0, 36) + '）').join('；'));
    if (Array.isArray(sg.risk) && sg.risk.length) lines.push('— 风险规避池（需留意）：' + sg.risk.map(x => (x.name || x.code) + '[' + x.riskType + ']').join('；'));
    if (Array.isArray(sg.alerts) && sg.alerts.length) lines.push('— 情绪提示：' + sg.alerts.join(' '));
  }
  if (has('stockAnalysis') && Array.isArray(ctx.stockAnalysis) && ctx.stockAnalysis.length) {
    for (const a of ctx.stockAnalysis.slice(0, 2)) {
      const t = a.technical || {};
      lines.push('— 个股技术解释：' + (a.code || '') + ' ' + (a.name || '') +
        ' 通用量化分 ' + (a.score != null ? a.score : '?') + '/100（' + (a.level || '未知') + '）' +
        '，MA5/10/20=' + [t.ma5, t.ma10, t.ma20].join('/') +
        '，MACD DIF/DEA/柱=' + [t.macd && t.macd.dif, t.macd && t.macd.dea, t.macd && t.macd.hist].join('/') +
        '，RSI14=' + (t.rsi14 != null ? t.rsi14 : '?') +
        '，KDJ=' + (t.kdj ? [t.kdj.k, t.kdj.d, t.kdj.j, t.kdj.cross].join('/') : '无数据') +
        '，量比5=' + (t.volRatio5 != null ? t.volRatio5 : '?') +
        '，60日位置=' + (t.pos60 != null ? t.pos60 + '%' : '?'));
      if (Array.isArray(a.parts) && a.parts.length) lines.push('  分项：' + a.parts.join('；'));
      if (Array.isArray(a.signals) && a.signals.length) lines.push('  信号：' + a.signals.slice(0, 6).map(s => s.label + '（' + s.detail + '）').join('；'));
      if (Array.isArray(a.riskNotes) && a.riskNotes.length) lines.push('  风险：' + a.riskNotes.slice(0, 4).join('；'));
      if (a.tradePlan) {
        const tp = a.tradePlan, bz = tp.buyZone || {}, sl = tp.stopLoss || {};
        lines.push('  技术参考位（程序测算）：回踩区 ' + (bz.low || '?') + '~' + (bz.high || '?') +
          '（' + (bz.pctLow || '?') + '%~' + (bz.pctHigh || '?') + '%）' +
          '，突破确认 ' + ((tp.breakout && tp.breakout.price) || '?') +
          '，目标 ' + (tp.takeProfit || []).map(x => x.price + '/' + x.pct + '%').join('、') +
          '，风险控制位 ' + (sl.price || '?') + '（' + (sl.pct || '?') + '%）' +
          '，仓位上限参考 ' + (tp.positionMaxPct != null ? tp.positionMaxPct + '%' : '?') +
          '，上方承压 ' + (tp.pressure || []).map(x => x.label + ' ' + x.price).join('、'));
      }
      if (a.note) lines.push('  ' + a.note);
    }
  }
  if (has('policyNews') && Array.isArray(ctx.policyNews) && ctx.policyNews.length) {
    lines.push('— 政策快讯（最近 ' + ctx.policyNews.length + ' 条，由新闻关键词筛选，含来源与时点）：');
    for (const n of ctx.policyNews.slice(0, 12)) {
      lines.push('  · [' + (n.time || '时间未标注') + '｜' + (n.source || '') + '｜重要性' + (n.importance || 0) + '｜' + (n.category || '') + '] ' + (n.title || ''));
    }
    lines.push('  提示：政策标签只表示命中监管/宏观关键词，不代表涨跌方向；回答时须区分事实与推测。');
  }
  if (has('portfolio')) lines.push('— 我的股池：' + JSON.stringify(ctx.portfolio).slice(0, 400));
  if (has('journal') && ctx.journal.stats) lines.push('— 经验库统计：' + JSON.stringify(ctx.journal.stats).slice(0, 240));

  // 兜底：若上面一行都没生成（例如自定义 modules），退回 JSON
  if (lines.length <= 1) {
    const picked = {};
    for (const k of allow) if (ctx[k] != null) picked[k] = ctx[k];
    const text = JSON.stringify(picked);
    lines.push(text.length > 5000 ? text.slice(0, 5000) + '…（已截断）' : text);
  }
  lines.push('');
  lines.push('说明：以上数字均由程序从公开数据计算，可直接引用；快照里没有的数据不要编造。');
  return lines.join('\n') + '\n\n';
}

const BASE_SYSTEM = [
  '你是「全球市场监测与报警系统」的核心智能体 Hermes，由 DeepSeek 提供底层推理。',
  '你贯穿五个模块：日程与事件、每日行情、我的股池、对话、个人知识库。你能看到系统注入的全局数据快照，也能通过工具按需读取各板块真实数据。',
  '表达准则（这是面向使用者本人的个人研究工具，不是持牌投资咨询）：',
  '1. 只依据注入的数据快照、工具返回与用户输入回答；快照或工具里没有的数字绝不编造，缺数据就直说「当前无数据」。',
  '2. 可以基于系统已算出的真实结果充分展开分析：给出观察清单、结构解读、条件化判断与研究观点，不必回避具体标的或方向；但每个判断都要写清依据的数据、来源与时点。',
  '3. 区分「已发生的事实」「程序计算结果」「你的推测」；凡属推测必须标明，并给出证伪条件（出现什么数据或信号就说明这个判断不成立）。',
  '4. 结论代表基于当前快照的研究观点，不是确定结果；涉及不确定处直接说明，不把推测写成事实，不承诺收益、不冒充真实成交或持仓。',
  '5. 回答结构化、可读，优先用短标题、短句和列表；红涨绿跌遵循 A 股习惯。',
  '6. 决策与风险由使用者自行承担；你不修改任何评分、不替用户下单。'
].join('\n');

/* ------------------------------ 后端一：官方 Hermes ------------------------------ */

/**
 * 调用官方 Hermes Agent。
 * 桥接约定：WSL2 里跑 hermes_bridge.py，对外暴露 OpenAI 兼容的 POST /v1/chat/completions。
 * 这样 Herems 的 CLI / 技能 / 记忆 / MCP 都在 WSL2 侧执行，Node 只发标准请求。
 */
async function callOfficial(cfg, messages, { maxTokens, temperature, timeoutMs } = {}) {
  const h = (cfg.agent && cfg.agent.hermes) || {};
  const gen = cfg.agent || {};
  const url = String(h.officialUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '') + '/v1/chat/completions';
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs || h.timeoutMs || TIMEOUT_OFFICIAL);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: h.model || 'hermes',
        messages,
        temperature: temperature == null ? (Number.isFinite(gen.temperature) ? gen.temperature : 0.3) : temperature,
        max_tokens: maxTokens || (Number.isFinite(gen.maxTokens) ? gen.maxTokens : 1200),
        stream: false,
        // 让 Hermes 侧知道来源模块，便于它写记忆/技能
        metadata: { source: 'global-market-monitor-v2', backend: 'hermes-official' }
      })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('Hermes HTTP ' + res.status + (txt ? ' ' + txt.slice(0, 160) : ''));
    }
    const j = await res.json();
    const choice = j && j.choices && j.choices[0];
    const text = choice && choice.message && choice.message.content;
    if (!text || !String(text).trim()) throw new Error('Hermes 返回空内容');
    return { ok: true, text: String(text).trim(), backend: 'hermes-official', usage: j.usage || null, model: j.model || h.model || 'hermes' };
  } catch (e) {
    return { ok: false, backend: 'hermes-official', error: e.name === 'AbortError' ? 'Hermes 超时' : (e.message || String(e)) };
  } finally { clearTimeout(t); }
}

/* ------------------------------ 后端二：DeepSeek 兜底 ------------------------------ */

async function callDeepSeek(cfg, messages, { maxTokens, temperature } = {}) {
  const ac = cfg.agent || {};
  const key = ac.apiKey || '';
  if (!key || !/^sk-/.test(key)) return { ok: false, backend: 'deepseek-fallback', error: 'no_api_key' };
  if (ac.enabled === false) return { ok: false, backend: 'deepseek-fallback', error: 'agent_disabled' };
  const url = String(ac.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '') + '/chat/completions';
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_FALLBACK);
  try {
    const res = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: ac.model || 'deepseek-chat',
        messages,
        temperature: temperature == null ? (Number.isFinite(ac.temperature) ? ac.temperature : 0.3) : temperature,
        max_tokens: maxTokens || (Number.isFinite(ac.maxTokens) ? ac.maxTokens : 1200),
        stream: false
      })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('DeepSeek HTTP ' + res.status + (txt ? ' ' + txt.slice(0, 160) : ''));
    }
    const j = await res.json();
    const choice = j && j.choices && j.choices[0];
    const text = choice && choice.message && choice.message.content;
    if (!text || !String(text).trim()) throw new Error('DeepSeek 返回空内容');
    return { ok: true, text: String(text).trim(), backend: 'deepseek-fallback', usage: j.usage || null, model: j.model || 'deepseek-chat' };
  } catch (e) {
    return { ok: false, backend: 'deepseek-fallback', error: e.name === 'AbortError' ? 'DeepSeek 超时' : (e.message || String(e)) };
  } finally { clearTimeout(t); }
}

/* ------------------------------ 统一入口 ------------------------------ */

/**
 * 统一对话入口。自动选择后端并做安全网关。
 * opts: { messages, context, modules, task, maxTokens, temperature, forceBackend }
 */
async function chat(cfg, opts = {}) {
  const h = (cfg.agent && cfg.agent.hermes) || {};
  if (h.enabled === false) return { ok: false, error: 'hermes_disabled' };

  const ctx = opts.context || collectContext();
  const prefix = contextPrefix(ctx, h.contextModules || opts.modules);
  const taskHint = opts.task ? '【本轮任务】' + opts.task + '\n\n' : '';
  const sys = { role: 'system', content: prefix + taskHint + BASE_SYSTEM };
  const messages = [sys].concat((opts.messages || []).filter(m => m && m.role));
  if (!messages.some(m => m.role === 'user')) return { ok: false, error: 'empty_question' };

  const backend = h.backend || 'auto';
  const attempts = [];
  let r = null;

  if (backend === 'official' || backend === 'auto') {
    r = await callOfficial(cfg, messages, opts);
    attempts.push(r);
    if (r.ok) return finalize(r);
  }
  if ((!r || !r.ok) && (backend === 'fallback' || backend === 'auto' || backend === 'deepseek')) {
    if (h.fallbackToDeepSeek !== false) {
      const f = await callDeepSeek(cfg, messages, opts);
      attempts.push(f);
      if (f.ok) return finalize({ ...f, degraded: backend === 'auto' });
    }
  }
  return {
    ok: false,
    error: '全部后端失败',
    attempts: attempts.map(a => ({ backend: a.backend, error: a.error })),
    hint: '若是 Hermes 未就绪：在 WSL2 执行 hermes setup 并启动 hermes_bridge.py；或在配置里把 backend 设为 deepseek 直接用兜底。'
  };
}

function finalize(r) {
  // 【纪律调整】不再按买卖词拦截输出；hasForbidden 现恒返回 []，保留调用便于审计/按需恢复。
  // 输出质量由 BASE_SYSTEM 的「数据真实 / 标注来源 / 区分事实与推测 / 证伪条件 / 风险自担」承担。
  const bad = hasForbidden(r.text);
  if (bad.length) r.flaggedWords = bad;
  return r;
}

/** 便捷封装：某模块带上下文提问 */
async function ask(cfg, module, question, extra = {}) {
  const ctx = collectContext(extra.snapshot);
  return chat(cfg, {
    messages: [{ role: 'user', content: question }],
    context: ctx,
    task: (extra.task || '') + '（来源模块：' + module + '）',
    maxTokens: extra.maxTokens || 1200,
    temperature: extra.temperature == null ? 0.3 : extra.temperature
  });
}

async function test(cfg) {
  const probe = [{ role: 'user', content: '只回复两个字：在线' }];
  const h = (cfg.agent && cfg.agent.hermes) || {};
  const out = { ok: false, official: null, fallback: null };
  if (h.backend !== 'deepseek') out.official = await callOfficial(cfg, probe, { maxTokens: 16, temperature: 0 });
  if (h.fallbackToDeepSeek !== false) out.fallback = await callDeepSeek(cfg, probe, { maxTokens: 16, temperature: 0 });
  out.ok = !!(out.official && out.official.ok) || !!(out.fallback && out.fallback.ok);
  out.active = out.official && out.official.ok ? 'hermes-official' : (out.fallback && out.fallback.ok ? 'deepseek-fallback' : null);
  return out;
}

/** 轻量探测官方 Hermes 桥接是否在线（GET /health，1.5s 超时） */
async function probeOfficial(cfg) {
  const h = (cfg.agent && cfg.agent.hermes) || {};
  const base = String(h.officialUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 1500);
  try {
    const res = await fetch(base + '/health', { signal: ac.signal });
    if (!res.ok) return { online: false, reason: 'HTTP ' + res.status };
    const j = await res.json().catch(() => ({}));
    return { online: true, service: j.service || 'hermes-bridge', hermes: j.hermes || null };
  } catch (e) {
    return { online: false, reason: e.name === 'AbortError' ? '超时' : '未连接' };
  } finally { clearTimeout(t); }
}

async function status(cfg) {
  const h = (cfg.agent && cfg.agent.hermes) || {};
  const probe = await probeOfficial(cfg);
  const backend = h.backend || 'auto';
  const active = probe.online ? 'hermes-official' : 'deepseek-fallback';
  return {
    ok: true,
    enabled: h.enabled !== false,
    backend,
    official: probe,                       // { online, service, hermes } 或 { online:false, reason }
    active,                                // 当前实际会走的路径（探测所得）
    officialUrl: h.officialUrl || 'http://127.0.0.1:8765',
    officialModel: h.model || 'hermes',
    fallbackToDeepSeek: h.fallbackToDeepSeek !== false,
    deepSeekKey: maskKey((cfg.agent || {}).apiKey),
    deepSeekModel: (cfg.agent || {}).model || 'deepseek-chat',
    contextModules: h.contextModules || null,
    note: probe.online
      ? 'Hermes 桥接在线（WSL2），核心智能体=Hermes + DeepSeek；输出已过安全网关。'
      : 'Hermes 桥接未连接，当前走 Node 直连 DeepSeek；在 WSL2 跑 setup-wsl2.sh 后自动切换。'
  };
}

module.exports = {
  chat, ask, test, status, collectContext, contextPrefix,
  BASE_SYSTEM, maskKey, hasForbidden
};
