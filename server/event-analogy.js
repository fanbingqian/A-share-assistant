'use strict';
/**
 * event-analogy.js — 新闻事件的「历史同类情形」确定性生成器
 *
 * 目的：回答「历史上这种事情发生时，二级市场出现过什么」，且**不靠智能体编**。
 * 数据源只有一个：server/event-study.js 落盘的 data/calendar/event-study.json
 *   （近 2 年日历事件 × 可交易 ETF 代理，T+1/T+3/T+5 相对上证的超额与胜率）。
 *
 * 纪律（与全项目一致）：
 *   1. 零幻觉：所有数字逐字来自统计文件；无样本时只写「无历史统计可比」，
 *      不编造年份、案例、指数涨跌或「历史上通常上涨」这类口头结论。
 *   2. 口径透明：ETF 代理 ≠ 行业指数；样本 < 8 标「低样本不可外推」；
 *      快照超过 30 天标陈旧；历史胜率不是未来概率、不构成买卖建议。
 *   3. 智能体只做「解释与判断」，历史事实由本模块提供；
 *      本模块不做涨跌预测、不给方向建议。
 *
 * 输出：{ ...stats, block(注入 prompt 的纯文本), card(前端程序事实卡片数据) }
 *      程序事实恒返回：即使智能体失败 / 未配置，前端仍可展示历史统计。
 */
const eventStudy = require('./event-study');
const macroOutlook = require('./macro-outlook');

const STALE_DAYS = 30;
const LOW_SAMPLE = 8;

function s(v, n) { return String(v == null ? '' : v).slice(0, n || 200); }
function pct(v) { return v == null ? '不可得' : (v > 0 ? '+' : '') + v + '%'; }
function num(v) { return v == null ? '不可得' : String(v); }

/** 官方指数事件 → event-study 规则键（不存在的键由 forEvent 如实降级，不硬凑） */
const MACRO_RULE = {
  US_CPI: 'us-cpi',
  FOMC: 'fomc',
  CN_PMI: 'cn-pmi',
  US_LABOR: 'us-nfp',
  US_GDP: null,
  CN_DATA: null
};

/** 非宏观新闻的规则映射：先具体后泛化，命中即停 */
const RULE_PATTERNS = [
  { ruleId: 'cn-lpr', label: 'LPR / 货币政策', re: /LPR|贷款市场报价利率|MLF|降准|降息|逆回购/i },
  { ruleId: 'cn-social-finance', label: '社融 / 信贷', re: /社融|社会融资规模|\bM2\b|新增贷款|信贷投放/i },
  { ruleId: 'cn-trade', label: '进出口数据', re: /进出口数据|出口增速|贸易数据|海关总署/i },
  { ruleId: 'cn-cpi-ppi', label: '中国 CPI / PPI', re: /中国.{0,6}(CPI|PPI)|\bCPI\b|\bPPI\b|物价指数/i },
  { ruleId: 'cn-gdp', label: '中国经济增长数据', re: /\bGDP\b|工业增加值|固定资产投资|社会消费品零售|经济增速/i },
  { ruleId: 'cn-medicare', label: '医保目录 / 集采', re: /医保目录|医保谈判|集采|带量采购/i },
  { ruleId: 'cn-politburo', label: '中央政治局会议', re: /政治局会议|中央政治局/i },
  { ruleId: 'cn-cewc', label: '中央经济工作会议', re: /中央经济工作会议/i },
  { ruleId: 'cn-lianghui', label: '两会 / 政府工作报告', re: /两会|政府工作报告|全国人大/i },
  { ruleId: 'cn-annual-report', label: '年报披露', re: /年报|年度报告/i },
  { ruleId: 'cn-annual-preannounce', label: '业绩预告', re: /业绩预告|业绩预增|业绩预亏/i },
  { ruleId: 'cn-q1-report', label: '一季报披露', re: /一季报|一季度报告/i },
  { ruleId: 'waic', label: '世界人工智能大会', re: /世界人工智能大会|WAIC/i },
  { ruleId: 'ces', label: 'CES 消费电子展', re: /\bCES\b|消费电子展/i },
  { ruleId: 'canton-fair', label: '广交会', re: /广交会/i },
  { ruleId: 'ciie', label: '进博会', re: /进博会/i },
  { ruleId: 'wef-davos', label: '达沃斯论坛', re: /达沃斯|世界经济论坛/i },
  { ruleId: 'us-earnings', label: '美股头部财报', re: /美股.{0,4}财报|财报季/i }
];

/** 主题词 → event-study 的 ETF 代理键（近似口径，只用于让 proxiesFor 找到板块代理） */
const SECTOR_ALIAS = {
  '半导体': '科技', '芯片': '科技', '军工': '科技', '通信': '科技', '电子': '科技',
  '银行': '券商', '证券': '券商', '资本市场': '券商',
  'AI': '算力', '人工智能': '算力', '大模型': '算力', '数据中心': '算力',
  '光伏': '新能源', '锂电': '新能源', '储能': '新能源', '风电': '新能源',
  '创新药': '医药', '中药': '医药', '医疗': '医药', '疫苗': '医药',
  '白酒': '消费', '食品': '消费', '家电': '消费', '零售': '消费',
  '原油': '石油', '油气': '石油', '关税': '出口链', '外贸': '出口链', '贸易': '出口链'
};

const COMPANY_RE = /回购|增持|减持|停牌|复牌|中标|业绩预|解禁|分红|质押|重组|收购|公告|股份|股东|风险警示|\bST\b|股东大会|可转债|定增/;

/** 把新闻（或今日清单）归类成一个「事件类型 + 规则键 + 板块代理」 */
function classify(item, newsList) {
  const it = item || {};
  const text = (Array.isArray(newsList) && newsList.length)
    ? newsList.slice(0, 6).map(n => [n.title || n.titleZh, n.desc].filter(Boolean).join(' ')).join(' ｜ ').slice(0, 1400)
    : [it.title, it.titleZh, it.desc, it.category, (it.topics || []).join(' ')].filter(Boolean).join(' ').slice(0, 900);

  let ruleId = null, label = null, via = null;

  // ① 官方 / 政府指数发布：复用 macro-outlook 的确定性识别
  const evList = (Array.isArray(newsList) && newsList.length) ? newsList : [it];
  let macroHit = null;
  for (const n of evList) {
    const d = macroOutlook.detectEvent(n || {});
    if (d.matched && d.hasReleaseContext) { macroHit = d; break; }
    if (d.matched && !macroHit) macroHit = d;
  }
  if (macroHit) {
    label = macroHit.name;
    via = '官方指数发布事件识别';
    ruleId = MACRO_RULE[macroHit.id] || null;
    // CN_DATA 是大杂烩，按具体数据名细分到对应规则
    if (!ruleId && macroHit.id === 'CN_DATA') {
      const hit = RULE_PATTERNS.find(p => p.re.test(text));
      if (hit) { ruleId = hit.ruleId; label = hit.label; via = '官方数据细分'; }
    }
  }
  // ② 非宏观新闻的关键词规则
  if (!ruleId) {
    const hit = RULE_PATTERNS.find(p => p.re.test(text));
    if (hit) { ruleId = hit.ruleId; label = hit.label; via = '新闻关键词规则'; }
  }

  // ③ 板块代理：把系统已有的主题词映射成 ETF 代理键（今日清单模式也要汇总各条）
  const pool = (Array.isArray(newsList) && newsList.length) ? newsList : [it];
  const raw = [];
  for (const n of pool) {
    if (Array.isArray(n.sectors)) raw.push(...n.sectors);
    if (Array.isArray(n.boards)) raw.push(...n.boards.map(b => (b && b.name) || ''));
  }
  const sectors = [...new Set(raw.map(x => SECTOR_ALIAS[x] || x).filter(Boolean))].slice(0, 6);

  const company = COMPANY_RE.test(text) && !ruleId;
  return {
    text,
    ruleId,
    label: label || (company ? '公司公告 / 个股事件' : '一般新闻线索'),
    via: via || (company ? '公司公告特征' : '未匹配到事件规则'),
    company,
    sectors
  };
}

/** 组装口径限制清单（全部为程序判定，不让模型自己写） */
function caveatsOf(o) {
  const c = [];
  if (!o.ok) c.push('该类事件暂无可核对的 A 股代理样本，禁止编造历史事件与数字');
  if (o.ok && (o.stats.samples || 0) < LOW_SAMPLE) c.push('样本不足 ' + LOW_SAMPLE + '，只作线索，不可外推');
  if (o.scope === 'proxy') c.push('统计口径为「相关板块代理在历史事件中的表现」，不是「同类事件」严格对照');
  c.push('板块用可交易 ETF 近似，不等于行业指数真实表现');
  c.push('历史胜率不是未来概率，过往表现不预示未来收益，不构成买卖建议');
  if (o.stale) c.push('统计快照已超过 ' + STALE_DAYS + ' 天，可能陈旧');
  if (o.statNote) c.push(s(o.statNote, 160));
  return c;
}

/** 给解读 prompt 的注入块：逐字引用，禁止模型扩写 */
function promptBlock(o) {
  const L = [];
  L.push('【历史同类情形（程序确定性统计，逐字引用；禁止编造历史事件、年份、案例与数字）】');
  L.push('- 事件类型：' + o.eventType + ' · 归类依据：' + o.via + ' · 规则键：' + (o.ruleId || '无'));
  if (!o.ok) {
    L.push('- 历史统计：**不可得**（' + s(o.unavailableReason, 120) + '）。本段必须如实写「无历史统计可比」，不得外推、不得用常识补写。');
    if (o.mechanism) L.push('- 可引用的程序内置机制说明（不是模型推断，不是历史案例）：' + s(o.mechanism, 300));
    L.push('- 口径限制：' + o.caveats.join('；'));
    return L.join('\n');
  }
  L.push('- 统计范围：' + (o.scope === 'rule' ? '近 2 年同类日历事件' : '近 2 年事件下的相关板块代理（非同类严格对照）'));
  L.push('- 数据来源：data/calendar/event-study.json（生成于 ' + (o.generatedAt || '不可得') + (o.stale ? '，已陈旧' : '') +
    '）· 日线 ' + (o.statSource || '不可得') + ' · 基准 ' + ((o.benchmark && o.benchmark.label) || '不可得'));
  L.push('- 计算口径：' + s(o.method, 140) + ' · 窗口 ' + (o.window ? o.window.from + '~' + o.window.to : '不可得'));
  if (o.mechanism) L.push('- 机制说明（程序内置，不是模型推断）：' + s(o.mechanism, 300));
  L.push('');
  L.push('■ 后验统计（只能逐字引用以下数字）');
  const st = o.stats;
  L.push('- 样本：近 2 年 ' + num(st.events) + ' 次事件 / ' + num(st.samples) + ' 次板块观测' +
    ((st.samples || 0) < LOW_SAMPLE ? '（低样本，不可外推）' : ''));
  L.push('- 事件之前：T-5 平均 ' + pct(st.avgPre5) + '、T-3 平均 ' + pct(st.avgPre3) +
    '；事件前 5 日上涨占比 ' + (st.preUpProb5 == null ? '不可得' : st.preUpProb5 + '%') + '（用于判断是否有提前交易预期）');
  L.push('- 事件之后：T+1 平均 ' + pct(st.avgRet1) + '、T+3 平均 ' + pct(st.avgRet3) + '、T+5 平均 ' + pct(st.avgRet5) +
    '；相对上证超额 T+5 平均 ' + pct(st.avgAr5));
  L.push('- T+5 上涨概率 ' + (st.upProb5 == null ? '不可得' : st.upProb5 + '%') +
    ' · 超额为正比例（胜率）' + (st.win5 == null ? '不可得' : st.win5 + '%') +
    (st.dist5 ? ' · 涨跌分布 上涨 ' + st.dist5.up + '% / 下跌 ' + st.dist5.down + '% / 持平 ' + st.dist5.flat + '%' : ''));
  if (o.proxies && o.proxies.length) {
    L.push('- 分板块（ETF 代理近似口径，最多 4 条）：' + o.proxies.slice(0, 4).map(p =>
      p.label + ' T+5 ' + pct(p.ret5) + ' / 上涨概率 ' + (p.upProb5 == null ? '不可得' : p.upProb5 + '%')).join('；'));
  }
  L.push('');
  L.push('■ 口径限制（必须写进解读，不要省略）');
  o.caveats.forEach(c => L.push('- ' + c));
  return L.join('\n');
}

/** 前端程序事实卡片数据（不依赖模型输出） */
function cardData(o) {
  const st = o.stats || {};
  return {
    ok: o.ok,
    eventType: o.eventType,
    scopeLabel: o.scope === 'rule' ? '同类事件后验统计' : (o.scope === 'proxy' ? '相关板块代理统计（非同类严格对照）' : '无可用历史统计'),
    sampleLine: o.ok
      ? '近 2 年 ' + num(st.events) + ' 次事件 / ' + num(st.samples) + ' 次板块观测' + ((st.samples || 0) < LOW_SAMPLE ? ' · 低样本' : '')
      : '无可核对样本',
    rows: o.ok ? [
      { k: '事件前 T-5', v: pct(st.avgPre5) },
      { k: '事件后 T+1', v: pct(st.avgRet1) },
      { k: '事件后 T+3', v: pct(st.avgRet3) },
      { k: '事件后 T+5', v: pct(st.avgRet5) },
      { k: 'T+5 超额（对上证）', v: pct(st.avgAr5) },
      { k: 'T+5 上涨概率', v: st.upProb5 == null ? '不可得' : st.upProb5 + '%' },
      { k: 'T+5 超额为正比例', v: st.win5 == null ? '不可得' : st.win5 + '%' }
    ] : [],
    proxies: o.ok ? (o.proxies || []).slice(0, 4).map(p => ({ label: p.label, ret5: pct(p.ret5), upProb5: p.upProb5 == null ? '不可得' : p.upProb5 + '%' })) : [],
    mechanism: o.mechanism || null,
    caveats: o.caveats,
    generatedAt: o.generatedAt || null,
    stale: !!o.stale,
    unavailableReason: o.unavailableReason || null
  };
}

/**
 * 生成历史同类情形。
 * @param {object} item  单条新闻（mode=one）
 * @param {object} opts  { newsList: [...] } 今日清单（mode=daily，此时 item 可为空）
 */
function build(item, opts = {}) {
  const newsList = Array.isArray(opts.newsList) ? opts.newsList : null;
  const cls = classify(item || {}, newsList);
  const isDaily = !!(newsList && newsList.length);

  let r;
  try {
    r = eventStudy.forEvent({ ruleId: cls.ruleId, sectors: cls.sectors }, { maxAgeDays: STALE_DAYS });
  } catch (e) {
    r = { ok: false, error: '事件统计读取失败：' + e.message };
  }
  r = r || { ok: false, error: '事件统计不可用' };

  const o = {
    ok: !!r.ok,
    mode: isDaily ? 'daily' : 'one',
    eventType: (isDaily ? '今日主线：' : '') + cls.label,
    via: cls.via,
    ruleId: r.ruleId || cls.ruleId || null,
    scope: r.scope || null,
    companyEvent: !!cls.company,
    mechanism: r.mechanism || null,
    stats: r.summary || null,
    proxies: r.proxies || [],
    line: r.line || null,
    detail: r.detail || null,
    generatedAt: r.generatedAt || null,
    stale: !!r.stale,
    method: r.method || null,
    window: r.window || null,
    benchmark: r.benchmark || null,
    statNote: r.statNote || null,
    statSource: r.statSource || null,
    unavailableReason: r.ok ? null : s(r.error || '无可用历史统计', 160)
  };
  o.caveats = caveatsOf(o);
  o.block = promptBlock(o);
  o.card = cardData(o);
  return o;
}

module.exports = { build, classify, promptBlock, cardData, MACRO_RULE, RULE_PATTERNS, STALE_DAYS, LOW_SAMPLE };
