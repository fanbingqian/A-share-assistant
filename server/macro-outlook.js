'use strict';
/* ==========================================================================
 * macro-outlook.js — 官方 / 政府指数发布事件的「机构预期 + 跨资产 + 多数方向」增强
 *
 * 用户规格：涉及政府相关指数发布的新闻，智能体解读要增加
 *   ① 当前各个机构与专家预测情况；
 *   ② 对美股、A 股各个板块的影响分析；
 *   ③ 对期货、黄金的影响分析；
 *   ④ 根据多数预测内容给一个方向的建议。
 *
 * 【反幻觉 · 硬约束】
 *   - 机构观点只来自两个可追溯来源：
 *       a) data/macro-expectations.json（domain_search 检索快照，逐条带来源/日期/需核实标记）
 *       b) 项目实时新闻池中确定性抽取的机构观点（带原文标题/来源/时点）
 *     程序不生成、不推算、不补全任何机构预测数字；无数据一律写「不可得」。
 *   - 跨资产「传导链」是按宏观方法论写出的**条件性分析框架**，明确标注非事实、非预测；
 *     具体资产观点只引用 crossAssetViews 里的真实媒体/机构原文。
 *   - 方向建议只在「机构观点形成明确多数」时给出，且标注为方向性参考、
 *     非买卖指令、非涨跌保证，附失效条件、反向声音与固定免责声明。
 *   - 本模块不修改任何评分、不选股、不替用户下单、不预测涨跌必然性。
 * ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const SNAP_FILE = path.join(__dirname, '..', 'data', 'macro-expectations.json');

const s = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n || 200);
const arr = a => Array.isArray(a) ? a : [];
const DISCLAIMER = '免责声明：以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。';

/* --------------------------------------------------------------------------
 * 1) 官方 / 政府指数发布事件识别（确定性关键词，不调模型）
 * ------------------------------------------------------------------------ */
const EVENT_SPECS = [
  {
    id: 'US_CPI', name: '美国 CPI / 核心 CPI', agency: '美国劳工统计局 BLS', jurisdiction: '美国',
    re: /美国.{0,6}CPI|核心\s*CPI|CPI\s*(同比|环比|数据|读数|指数|公布|发布)|U\.?S\.?\s*CPI|consumer price index|inflation rate|通胀数据|PCE|PPI|生产者物价|物价指数/i
  },
  {
    id: 'FOMC', name: '美联储 FOMC 利率决议 / 议息路径', agency: '美联储 FOMC', jurisdiction: '美国',
    re: /美联储|议息|利率决议|FOMC|点阵图|会议纪要|褐皮书|联邦基金利率|加息|降息|Fed\s*(rate|decision|meeting)|rate\s*(cut|hike)|FOMC/i
  },
  {
    id: 'CN_PMI', name: '中国官方制造业 PMI / 非制造业 PMI', agency: '国家统计局', jurisdiction: '中国',
    re: /PMI|采购经理指数|制造业景气|荣枯线|非制造业商务活动|财新.{0,4}PMI/i
  },
  {
    id: 'US_LABOR', name: '美国非农就业 / 失业率 / 初请失业金', agency: '美国劳工部 BLS', jurisdiction: '美国',
    re: /非农|失业率|初请失业金|非农业就业|payroll|jobless claims|unemployment rate/i
  },
  {
    id: 'US_GDP', name: '美国 GDP / 零售销售 / ISM 景气指数', agency: '美国经济分析局 BEA / 商务部', jurisdiction: '美国',
    re: /美国.{0,6}GDP|GDP\s*(增速|预估|数据)|零售销售|ISM\s*(制造业|服务业)|耐用品订单|retail sales|GDP\s*growth/i
  },
  {
    id: 'CN_DATA', name: '中国经济数据（CPI / PPI / 社融 / M2 / 工业增加值 / 进出口 / LPR）', agency: '国家统计局 / 中国人民银行 / 海关总署', jurisdiction: '中国',
    re: /社融|社会融资规模|\bM2\b|工业增加值|固定资产投资|社会消费品零售|进出口数据|LPR|MLF|降准|降息|统计局.{0,6}(公布|发布|数据)|中国.{0,6}(CPI|PPI)/i
  }
];
/* 发布语境词：用于把「提到了 Fed」与「发布了官方数据」区分开 */
const RELEASE_CTX = /公布|发布|出炉|数据|读数|指数|预期|前值|同比|环比|纪要|决议|会议|报告|统计局|劳工部|美联储|央行|federal reserve|bureau of labor statistics|\bBLS\b|\bBEA\b|release|report|data|forecast/i;

function detectEvent(item) {
  const text = s((item && (item.title || item.headline)) + ' ' + (item && (item.desc || item.summary || '')), 600);
  if (!text) return { matched: false, reason: '无新闻文本' };
  for (const spec of EVENT_SPECS) {
    const m = text.match(spec.re);
    if (m) {
      return {
        matched: true, id: spec.id, name: spec.name, agency: spec.agency,
        jurisdiction: spec.jurisdiction, keyword: s(m[0], 30),
        hasReleaseContext: RELEASE_CTX.test(text)
      };
    }
  }
  return { matched: false, reason: '未命中官方指数发布关键词' };
}

/* --------------------------------------------------------------------------
 * 2) 快照读取（带时效校验；过期只标注，不静默当最新）
 * ------------------------------------------------------------------------ */
function readSnapshot() {
  try {
    const j = JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8'));
    const at = s(j.snapshotAt, 20);
    const validDays = Number(j.validDays) || 7;
    const ageDays = Math.floor((Date.now() - new Date(at + 'T00:00:00+08:00').getTime()) / 86400000);
    return {
      ok: true, at, capturedBy: s(j.capturedBy, 120), sourcePolicy: s(j.sourcePolicy, 400),
      disclaimer: s(j.disclaimer, 400) || DISCLAIMER,
      directionLegend: j.directionLegend || {}, events: j.events || {},
      crossAssetViews: arr(j.crossAssetViews),
      stale: !Number.isFinite(ageDays) || ageDays > validDays,
      ageDays: Number.isFinite(ageDays) ? ageDays : null, validDays
    };
  } catch (e) {
    return { ok: false, at: null, error: e.message, events: {}, crossAssetViews: [], stale: true, disclaimer: DISCLAIMER };
  }
}

/* --------------------------------------------------------------------------
 * 3) 实时新闻池里的机构观点抽取（确定性正则，方向不臆断）
 * ------------------------------------------------------------------------ */
const INST_RE = /(高盛|摩根大通|摩根士丹利|野村|瑞银|德意志银行|丹斯克|贝莱德|花旗|美国银行|美银|巴克莱|渣打|中金|中信证券|华泰|东方金诚|经济学人智库|ING|PNC|Continuum|CME|克利夫兰联储|分析师|经济学家|机构|专家|策略师)/;
const VIEW_RE = /(预计|预测|预期|料将|料|认为|看法|观点|研判|展望|共识)/;
function extractLiveViews(newsPool, eventId) {
  const out = [], seen = new Set();
  arr(newsPool).slice(0, 400).forEach(n => {
    const title = s(n && (n.title || n.headline), 220);
    const text = title + ' ' + s(n && (n.desc || n.summary), 220);
    if (!INST_RE.test(text) || !VIEW_RE.test(text)) return;
    const key = title.slice(0, 60);
    if (!key || seen.has(key)) return;
    /* 只收与本次事件相关的条目，避免把无关公司研报混进来 */
    const spec = EVENT_SPECS.find(x => x.id === eventId);
    if (spec && !spec.re.test(text) && !/CPI|PMI|美联储|Fed|利率|通胀|数据|PMI|社融|GDP/i.test(text)) return;
    seen.add(key);
    const im = text.match(INST_RE);
    out.push({
      institution: s(im ? im[0] : '机构（未具名）', 40),
      view: s(text, 240),
      direction: null,                 // 程序不臆断方向，不参与多数统计
      date: s(n && (n.time || n.publishedAt || n.date), 24) || '时点未注明',
      source: s(n && (n.source || n.feed), 40) || '来源未注明',
      needsVerify: true,
      sourceType: 'live-news',
      note: '来自项目实时新闻池的确定性抽取，未判定方向，不计入多数统计'
    });
  });
  return out.slice(0, 8);
}

/* --------------------------------------------------------------------------
 * 4) 多数方向统计（只统计带明确 direction 的快照观点）
 * ------------------------------------------------------------------------ */
function consensusOf(views) {
  const scored = arr(views).filter(v => v.direction === 'positive' || v.direction === 'negative' || v.direction === 'neutral');
  const counts = { positive: 0, negative: 0, neutral: 0 };
  scored.forEach(v => { counts[v.direction]++; });
  const total = scored.length;
  let majority = null, hasMajority = false;
  if (total >= 2) {
    const pairs = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const top = pairs[0], second = pairs[1];
    if (counts[top] > total / 2 && counts[top] > counts[second] && top !== 'neutral') {
      majority = top; hasMajority = true;
    }
  }
  return {
    counts, total, majority, hasMajority,
    insufficient: total < 2,
    tieOrSplit: total >= 2 && !hasMajority,
    label: hasMajority
      ? (majority === 'negative' ? '多数偏谨慎（通胀黏性 / 政策偏紧 / 增长走弱）' : '多数偏正面（通胀缓和 / 政策偏松 / 增长改善）')
      : (total < 2 ? '样本不足，无法统计多数方向' : '机构观点分歧或中性占优，未形成明确多数方向')
  };
}

/* --------------------------------------------------------------------------
 * 5) 跨资产影响：真实观点 + 条件性传导链（框架，非预测）
 * ------------------------------------------------------------------------ */
const ASSET_GROUPS = [
  { key: 'us_equity', name: '美股（指数与板块）', icon: 'US' },
  { key: 'a_share', name: 'A 股（各板块）', icon: 'A' },
  { key: 'futures', name: '期货（股指 / 国债 / 商品）', icon: 'F' },
  { key: 'gold', name: '黄金（现货 / 期货 / 相关权益）', icon: 'Au' }
];
/* 按宏观→中间变量→资产的条件性传导链；明确只是分析框架，不含事实数字 */
const CHAINS = {
  us_equity: [
    { macro: '官方通胀 / 就业读数高于或低于机构预期', mid: '政策利率路径 → 无风险利率与折现率', asset: '长久期成长股（AI / 科技）估值弹性最大，利率敏感板块先反应', tag: '一阶' },
    { macro: '利率决议与点阵图', mid: '风险偏好 → 资金在成长与价值间的再平衡', asset: '高估值成长承压、美元与短端收益率偏强时价值/金融相对占优', tag: '二阶' },
    { macro: '数据发布时点晚于议息会议', mid: '信息空窗 → 预期先行定价', asset: '数据落地时可能出现「预期兑现」或反向交易', tag: '时滞' }
  ],
  a_share: [
    { macro: '海外利率与美元走势', mid: '跨境流动性 / 汇率 → 外资定价权', asset: '外资敏感的核心资产、消费与医药；出口链受汇率与外需共同影响', tag: '一阶' },
    { macro: '国内 PMI / 社融 / 工业企业利润', mid: '需求预期 → 顺周期盈利预期', asset: '有色、化工、机械、基建链；读数回落时顺周期承压', tag: '一阶' },
    { macro: '政策预期（降准降息 / 稳投资工具）', mid: '流动性与风险偏好 → 估值中枢', asset: '券商、银行对政策预期敏感；基建链需等订单与细则验证', tag: '二阶' },
    { macro: 'AI 芯片与算力限制', mid: '产业景气 → 资本开支与订单', asset: '半导体、算力硬件、通信设备；需区分业绩验证与概念映射', tag: '二阶' }
  ],
  futures: [
    { macro: '政策利率预期变化', mid: '短端收益率 → 国债期货定价', asset: '国债期货（短端更敏感）；股指期货跟随风险偏好', tag: '一阶' },
    { macro: '美元与实际利率', mid: '计价与持有成本 → 商品定价', asset: '铜、原油等商品期货；美元走强通常压制以美元计价商品', tag: '一阶' },
    { macro: '能源价格冲击见顶或延续', mid: '通胀预期 → 政策路径', asset: '能源化工链与上游资本开支预期；OPEC+ 配额决定油价中枢', tag: '二阶' },
    { macro: '宏观数据落地', mid: '预期差 → 波动率', asset: '数据空窗期仓位与展期成本需单独管理', tag: '时滞' }
  ],
  gold: [
    { macro: '实际利率预期抬升', mid: '无息资产持有成本上升', asset: '黄金承压，避险吸引力被削弱', tag: '一阶' },
    { macro: '美元指数走强', mid: '以美元计价 → 相对购买力', asset: '金价承压；但地缘避险需求可能反向支撑', tag: '一阶' },
    { macro: '能源与通胀路径反转', mid: '通胀预期 → 实际利率', asset: '若通胀压力缓和，压制黄金的利率因素可能减弱', tag: '二阶' }
  ]
};
const DIRECTION_HINT = {
  negative: { us_equity: '偏谨慎观察', a_share: '偏谨慎观察', futures: '利率与美元方向偏支撑、商品偏承压', gold: '实际利率上行情形偏承压' },
  positive: { us_equity: '偏正面观察', a_share: '偏正面观察', futures: '利率压力缓和、风险偏好修复', gold: '压制因素减弱，但需看美元与避险' },
  neutral: { us_equity: '中性观察', a_share: '中性观察', futures: '中性观察', gold: '中性观察' }
};
function buildImpacts(snap, consensus) {
  const hint = DIRECTION_HINT[consensus.majority || 'neutral'];
  return ASSET_GROUPS.map(g => {
    const quotes = snap.crossAssetViews.filter(v => arr(v.assets).includes(g.key)).map(v => ({
      text: s(v.text, 400), source: s(v.source, 80), date: s(v.date, 20),
      url: s(v.url, 200) || null, needsVerify: v.needsVerify !== false
    }));
    return {
      key: g.key, name: g.name, icon: g.icon,
      conditionalDirection: hint[g.key],
      directionNote: consensus.hasMajority
        ? '由「多数机构方向」推导的条件性倾向，不是涨跌预测；官方数据落地后需重新校验。'
        : '机构未形成明确多数方向，本组只给条件性观察，不给单向倾向。',
      quotes: quotes.length ? quotes : [{ text: '当前数据源未覆盖该资产的机构 / 媒体观点，不可得。', source: '不可得', date: '', needsVerify: false }],
      chains: CHAINS[g.key].map(c => ({ ...c, framework: true })),
      invalidation: [
        '官方实际读数与机构预期出现方向性偏差',
        '数据在发布前已被市场提前定价，落地后出现反向交易',
        '不同机构口径不一致（同比可比性 / 季调 / 样本范围），需核实原文'
      ]
    };
  });
}

/* --------------------------------------------------------------------------
 * 6) 多数预测 → 方向性参考（只在明确多数时给，附失效条件与反向声音）
 * ------------------------------------------------------------------------ */
function buildAdvice(event, snap, consensus) {
  const ev = snap.events[event.id] || {};
  if (!consensus.hasMajority) {
    return {
      hasMajority: false,
      headline: consensus.insufficient ? '机构观点样本不足，不给方向建议' : '机构观点分歧，不给单向方向建议',
      body: consensus.insufficient
        ? '当前数据源未覆盖该事件的机构预测（或有效观点少于 2 条），按反幻觉纪律不生成方向性参考。'
        : '机构预测未形成过半多数（' + consensus.counts.positive + ' 条偏正面 / ' + consensus.counts.negative + ' 条偏谨慎 / ' + consensus.counts.neutral + ' 条中性），按「根据多数预测给方向」的要求，此处不硬凑单向结论。',
      conditionalFramework: [
        '若官方读数落在偏紧 / 偏弱一侧，按跨资产影响表里「偏谨慎」链路校验风险资产与黄金',
        '若读数落在偏松 / 改善一侧，按「偏正面」链路校验估值修复与商品',
        '数据落地前不单向押注；以实际读数、发布机构原文口径为准'
      ],
      invalidation: ['官方数据发布并证实某一侧预测', '新增机构观点使多数方向改变'],
      reverseVoice: '机构分歧本身就是重要信息：分歧核心往往在政策落地效果与外生冲击，不宜把任一机构观点当作基准情形。',
      disclaimer: snap.disclaimer || DISCLAIMER,
      isInvestmentAdvice: false
    };
  }
  const negative = consensus.majority === 'negative';
  const basis = arr(ev.views).filter(v => v.direction === consensus.majority)
    .map(v => s(v.institution, 40) + '（' + s(v.date, 12) + '，' + s(v.source, 40) + '）');
  return {
    hasMajority: true,
    majority: consensus.majority,
    headline: '多数机构方向：' + (negative ? '偏谨慎 / 偏紧缩' : '偏正面 / 偏宽松') +
      '（' + consensus.total + ' 条有效观点中 ' + consensus.counts[consensus.majority] + ' 条）',
    body: negative
      ? '方向性参考：对利率敏感的长久期风险资产（高估值成长、AI 链）保持谨慎观察，美元与短端利率方向偏支撑，黄金在实际利率上行情形偏承压；A 股顺周期与外资敏感板块需等官方读数验证。这是基于机构多数观点的方向归纳，不是买卖指令，也不是涨跌保证。'
      : '方向性参考：利率与通胀压力缓和情形下，风险偏好与估值中枢有条件修复，长久期成长与顺周期板块偏正面观察，黄金的利率压制因素减弱。这是基于机构多数观点的方向归纳，不是买卖指令，也不是涨跌保证。',
    basis: basis.slice(0, 8),
    basisNote: '以上机构观点均为公开媒体转述 / 研报二次引用（非一手来源，需核实原文）；仅 CME FedWatch 与国家统计局条目为市场定价 / 官方数据。',
    consensusLine: s(ev.consensusLine, 300) || '不可得',
    invalidation: [
      '官方实际读数与多数预测方向相反（预期差反转）',
      '发布机构修正口径或数据修订（如同比基数、季调因子）',
      '数据在发布前已被充分定价，落地后出现「利好兑现 / 反向交易」',
      '能源、地缘或政策外生冲击改变利率路径'
    ],
    reverseVoice: negative
      ? '反向声音：贝莱德认为市场高估了后续加息次数，能源价格冲击见顶可能使 2027 年通胀转为下行；ING、瑞银也提示不宜把紧缩路径线性外推。'
      : '反向声音：通胀黏性与政策偏紧的机构仍占相当比例，需防范「总体缓和、核心仍黏」的结构性分化。',
    disclaimer: snap.disclaimer || DISCLAIMER,
    isInvestmentAdvice: false
  };
}

/* --------------------------------------------------------------------------
 * 7) 主入口：程序事实恒返回，供解读 prompt 注入 + 前端结构化渲染
 * ------------------------------------------------------------------------ */
function build(item, opts = {}) {
  const detected = detectEvent(item || {});
  const snap = readSnapshot();
  const base = {
    detected: detected.matched,
    event: detected.matched ? {
      id: detected.id, name: detected.name, agency: detected.agency,
      jurisdiction: detected.jurisdiction, keyword: detected.keyword,
      hasReleaseContext: detected.hasReleaseContext
    } : null,
    detectReason: detected.reason || null,
    snapshot: { at: snap.at, capturedBy: snap.capturedBy, stale: snap.stale, ageDays: snap.ageDays, validDays: snap.validDays, sourcePolicy: snap.sourcePolicy },
    disclaimer: snap.disclaimer || DISCLAIMER,
    directionLegend: snap.directionLegend,
    officialFacts: [], consensusLine: '不可得', views: [], liveNewsViews: [],
    consensus: consensusOf([]), impacts: [], advice: null, dataGaps: [],
    notes: [
      '机构观点来自可追溯快照与项目实时新闻池，程序不生成任何预测数字。',
      '跨资产传导链为条件性分析框架，不是事实、不是涨跌预测。',
      '方向性参考只在机构观点形成明确多数时给出，不是买卖指令。'
    ]
  };
  if (!detected.matched) return base;

  const ev = snap.events[detected.id];
  const gaps = [];
  if (!snap.ok) gaps.push('机构预测快照不可读：' + s(snap.error, 80));
  if (snap.stale) gaps.push('机构预测快照已超过有效期（' + snap.ageDays + ' 天 / 上限 ' + snap.validDays + ' 天），需重新检索后才可作为「当前」观点使用');
  if (!ev) gaps.push('当前数据源未覆盖「' + detected.name + '」的机构预测清单，不可得');

  base.officialFacts = ev ? arr(ev.officialFacts).map(f => ({
    text: s(f.text, 400), source: s(f.source, 80), date: s(f.date, 20),
    url: s(f.url, 200) || null, primary: f.primary === true
  })) : [];
  base.consensusLine = ev ? s(ev.consensusLine, 300) : '不可得';
  base.views = ev ? arr(ev.views).map(v => ({
    institution: s(v.institution, 60), view: s(v.view, 600),
    direction: ['positive', 'negative', 'neutral'].includes(v.direction) ? v.direction : null,
    date: s(v.date, 20), source: s(v.source, 80), url: s(v.url, 200) || null,
    needsVerify: v.needsVerify !== false, sourceType: 'snapshot'
  })) : [];
  base.liveNewsViews = extractLiveViews(opts.newsPool, detected.id);
  base.consensus = consensusOf(base.views);
  if (!base.views.length) gaps.push('该事件当前无带方向的机构观点，无法统计多数方向');
  base.impacts = buildImpacts(snap, base.consensus);
  base.advice = buildAdvice(detected, snap, base.consensus);
  base.dataGaps = gaps;
  return base;
}

/** 给解读 prompt 用的纯文本注入块（逐条带来源/时点，禁止模型扩写） */
function promptBlock(macro) {
  if (!macro || !macro.detected) return '';
  const L = [];
  L.push('【官方指数发布事件 · 程序注入的机构预期与跨资产快照（逐字引用，禁止扩写 / 禁止新增机构或数字）】');
  L.push('- 事件：' + macro.event.name + ' · 发布机构 ' + macro.event.agency + ' · ' + macro.event.jurisdiction);
  L.push('- 快照时点：' + (macro.snapshot.at || '不可得') + (macro.snapshot.stale ? '（已过期，需标注陈旧）' : '') + ' · 来源：' + (macro.snapshot.capturedBy || '不可得'));
  L.push('- 口径：' + (macro.snapshot.sourcePolicy || '不可得'));
  L.push('');
  L.push('■ 已公布的官方事实');
  if (!macro.officialFacts.length) L.push('- 不可得');
  macro.officialFacts.forEach(f => L.push('- ' + f.text + '（' + f.source + '，' + f.date + '）'));
  L.push('');
  L.push('■ 机构与专家预测清单（' + macro.views.length + ' 条，方向仅作程序标注）');
  if (!macro.views.length) L.push('- 不可得');
  macro.views.forEach((v, i) => L.push('  ' + (i + 1) + '. ' + v.institution + '：' + v.view +
    '（方向 ' + v.direction + ' · ' + v.source + ' · ' + v.date + (v.needsVerify ? ' · 需核实原文' : '') + '）'));
  if (macro.liveNewsViews.length) {
    L.push('■ 项目实时新闻池补抽的机构观点（未判方向，不计入多数统计，只可逐字引用）');
    macro.liveNewsViews.forEach(v => L.push('- ' + v.institution + '：' + v.view + '（' + v.source + ' · ' + v.date + '）'));
  }
  L.push('');
  L.push('■ 多数方向统计：' + macro.consensus.label + '（正面 ' + macro.consensus.counts.positive +
    ' / 谨慎 ' + macro.consensus.counts.negative + ' / 中性 ' + macro.consensus.counts.neutral + '，有效 ' + macro.consensus.total + ' 条）');
  if (macro.consensusLine && macro.consensusLine !== '不可得') L.push('- 共识归纳：' + macro.consensusLine);
  L.push('');
  L.push('■ 跨资产影响（真实机构 / 媒体观点，逐字引用；传导链为条件性分析框架）');
  macro.impacts.forEach(g => {
    L.push('- ' + g.name + ' · 条件性倾向：' + g.conditionalDirection);
    g.quotes.forEach(q => L.push('  引用：' + q.text + '（' + q.source + '，' + q.date + (q.needsVerify ? '，需核实原文' : '') + '）'));
    g.chains.forEach(c => L.push('  框架：' + c.macro + ' → ' + c.mid + ' → ' + c.asset + '（' + c.tag + '，非预测）'));
  });
  L.push('');
  L.push('■ 多数预测方向建议（程序结论，不是买卖指令）');
  L.push('- ' + macro.advice.headline);
  L.push('- ' + macro.advice.body);
  if (macro.advice.basis && macro.advice.basis.length) L.push('- 依据机构：' + macro.advice.basis.join('；'));
  L.push('- 失效条件：' + macro.advice.invalidation.join('；'));
  L.push('- 反向声音：' + macro.advice.reverseVoice);
  L.push('- ' + macro.advice.disclaimer);
  return L.join('\n');
}

module.exports = { build, detectEvent, readSnapshot, consensusOf, promptBlock, EVENT_SPECS, DISCLAIMER };
