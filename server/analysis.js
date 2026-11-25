'use strict';

/**
 * 新闻解读引擎（零依赖、纯规则，可解释、可复现）。
 *
 * 技术思路参考 GitHub 上 2025–2026 年仍在维护的开源项目：
 *   - StockView (SiD-array/StockView)：VADER 情感标注 + Z-score 异常检测；其自 published 的
 *     时序 80/20 回测显示主流 ML 价格预测模型平均 R² 为负（-1.02 ~ -2.93），
 *     故本模块【不做价格预测】，只做「消息面方向推理 + 风险提示」。
 *   - ai-stock-watcher (NUS-ISS 2025)：价格 / 成交量 / 情绪多信号融合（multi-signal fusion）。
 *   - QuantFusionAI：可解释信号 + 置信度 + 基于 ATR 的风险度量。
 *   - AutoWealth AI：加权投票与多空情感词典；daily_stock_analysis：中文决策仪表盘与催化因素。
 *
 * 本模块实现的是它们的「可解释子集」：金融领域情感词典（含否定 / 程度修饰，
 * VADER 思路）→ 事件主题识别 → 主题到资产的影响映射 → 按重要度加权融合 →
 * 生成带依据的中文综述。所有结论都附带命中新闻数与推理逻辑，不输出无依据的判断。
 */

const ASSETS = [
  { key: 'gold',    label: '黄金',     note: '价格方向' },
  { key: 'oil',     label: '原油',     note: '价格方向' },
  { key: 'ust10y',  label: '美债10Y',  note: '收益率方向' },
  { key: 'dxy',     label: '美元指数', note: '价格方向' },
  { key: 'equity',  label: '股票',     note: '风险偏好方向' }
];

/* -------------------------- 金融情感词典 -------------------------- */
/* 数值为 valence（-3 ~ +3），参照 VADER 的词典打分 + 归一化思路 */

const LEXICON = [
  // 强正向
  ['surge', 2.2], ['soar', 2.5], ['rally', 1.8], ['jump', 1.5], ['record high', 2.3],
  ['all-time high', 2.3], ['breakout', 1.6], ['rebound', 1.3], ['stimulus', 1.6],
  ['rate cut', 1.2], ['ceasefire', 2.0], ['peace deal', 2.0], ['beat expectations', 1.8],
  ['upgrade', 1.4], ['strong earnings', 1.8], ['easing', 1.2], ['dovish', 1.0],
  ['大涨', 2.2], ['飙升', 2.5], ['暴涨', 2.5], ['创新高', 2.3], ['利好', 2.0],
  ['反弹', 1.3], ['降息', 1.2], ['宽松', 1.2], ['复苏', 1.5], ['超预期', 1.8],
  ['止跌', 1.0], ['回暖', 1.3], ['增持', 1.2], ['突破', 1.5], ['盈利', 1.2],
  // 温和正向
  ['gain', 1.0], ['rise', 0.9], ['climb', 0.9], ['advance', 0.8], ['recover', 1.0],
  ['optimism', 1.1], ['confidence', 0.8], ['growth', 0.8], ['deal', 0.7], ['strong', 0.8],
  ['上涨', 1.0], ['上升', 0.8], ['走高', 1.0], ['增长', 0.9], ['改善', 1.0],
  ['企稳', 0.8], ['提振', 1.1], ['乐观', 1.1], ['合作', 0.6], ['达成协议', 1.2],
  // 强负向
  ['crash', -3.0], ['plunge', -2.5], ['collapse', -2.8], ['slump', -2.0], ['tumble', -2.0],
  ['sell-off', -2.0], ['selloff', -2.0], ['default', -2.8], ['bank failure', -2.8],
  ['recession', -2.2], ['crisis', -2.4], ['war', -2.4], ['invasion', -2.6],
  ['missile', -2.2], ['attack', -2.2], ['nuclear', -2.0], ['sanctions', -1.5],
  ['tariff', -1.3], ['shutdown', -1.5], ['layoffs', -1.6], ['downgrade', -1.8],
  ['miss expectations', -1.8], ['hawkish', -1.0], ['rate hike', -1.2],
  ['崩盘', -3.0], ['暴跌', -2.5], ['大跌', -2.0], ['闪崩', -2.8], ['违约', -2.8],
  ['衰退', -2.2], ['危机', -2.4], ['战争', -2.4], ['冲突', -1.8], ['袭击', -2.2],
  ['制裁', -1.5], ['关税', -1.3], ['裁员', -1.6], ['下调评级', -1.8], ['加息', -1.2],
  ['爆雷', -2.6], ['停摆', -1.5], ['恐慌', -2.0], ['风险加剧', -1.8],
  // 温和负向
  ['fall', -1.0], ['drop', -1.1], ['decline', -1.0], ['weaken', -1.0], ['weak', -0.9],
  ['concern', -1.0], ['worry', -1.0], ['fear', -1.3], ['inflation', -0.9],
  ['uncertainty', -1.0], ['pressure', -0.8], ['slowdown', -1.2], ['deficit', -0.9],
  ['下跌', -1.0], ['走低', -1.0], ['回落', -0.9], ['疲弱', -1.1], ['放缓', -1.1],
  ['通胀', -0.9], ['担忧', -1.0], ['不确定性', -1.0], ['承压', -1.0], ['亏损', -1.4],
  ['减持', -1.0], ['萎缩', -1.3], ['库存增加', -0.9],
  // A 股个股资讯常见表达（东财个股栏目标题，供个股舆情指数使用）
  ['创近年新高', 1.8], ['创历史新高', 2.2], ['股价新高', 1.8], ['涨停', 1.8],
  ['业绩预增', 2.0], ['净利润增长', 1.6], ['中标', 1.3], ['买入评级', 1.4],
  ['上调目标价', 1.5], ['首次覆盖', 0.8], ['回购', 1.0], ['分红', 0.8],
  ['扭亏', 1.6], ['订单饱满', 1.4], ['量产', 1.0], ['获批', 1.0],
  ['融资净买入', 0.8], ['主力净流入', 1.0], ['机构加仓', 1.2],
  ['跌停', -2.0], ['问询函', -1.2], ['立案调查', -2.2], ['被查', -1.6],
  ['业绩预亏', -2.0], ['净利润下滑', -1.8], ['商誉减值', -2.0],
  ['退市风险', -2.5], ['解禁', -0.8], ['诉讼', -1.2], ['质押', -0.8],
  ['融资净偿还', -0.6], ['主力净流出', -1.0], ['股东减持', -1.4],
  // 英文外媒高置信补充（只为「方向明确」的金融语境短语，避免裸单词把体育/游戏新闻误判）
  ['beat estimates', 1.8], ['record profit', 2.0], ['raises guidance', 1.8],
  ['profit growth', 1.5], ['recovery', 1.2],
  ['conflict', -1.8], ['tensions', -1.0], ['profit warning', -2.0],
  ['bankruptcy', -2.8], ['debt crisis', -2.4], ['outflow', -1.2]
];

const NEGATIONS = ['not ', 'no ', 'never ', 'without ', 'fails to ', "isn't ", 'unlikely ',
  '未', '不', '没有', '并非', '无', '缓解', '降温', '避免'];
const BOOSTERS = [['sharp', 1.4], ['sharply', 1.4], ['very', 1.3], ['highly', 1.3],
  ['significant', 1.3], ['massive', 1.5], ['大幅', 1.5], ['急剧', 1.5], ['显著', 1.3], ['严重', 1.4], ['持续', 1.2]];

const LEX = LEXICON.map(([w, v]) => {
  const ascii = /^[a-z0-9 ]+$/.test(w);
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = ascii
    ? new RegExp('(^|[^a-z0-9])' + esc + '(?:s|es|ed|ing)?(?=$|[^a-z0-9])', 'gi')
    : new RegExp(esc, 'g');
  return { w, v, re, ascii };
});

/** VADER 风格：累加 valence，用 sum / sqrt(sum² + alpha) 压缩到 (-1, 1)，带否定与程度修饰 */
function scoreSentiment(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return { score: 0, label: '中性', hits: [] };
  let sum = 0;
  const hits = [];
  for (const e of LEX) {
    e.re.lastIndex = 0;
    let m, count = 0;
    while ((m = e.re.exec(s)) !== null && count < 3) {
      const pos = m.index;
      const before = s.slice(Math.max(0, pos - 22), pos);
      let v = e.v;
      if (NEGATIONS.some(n => before.includes(n))) v = -v * 0.65;
      for (const [b, mul] of BOOSTERS) if (before.includes(b)) { v *= mul; break; }
      sum += v;
      count++;
      if (!hits.some(h => h.w === e.w)) hits.push({ w: e.w, v: +v.toFixed(2) });
      if (e.ascii === false && e.re.lastIndex === pos) e.re.lastIndex = pos + 1;
    }
  }
  const norm = sum / Math.sqrt(sum * sum + 15);
  const score = Math.round(norm * 100);
  const label = score >= 25 ? '偏乐观' : score >= 8 ? '略偏乐观'
    : score <= -25 ? '偏悲观' : score <= -8 ? '略偏悲观' : '中性';
  return { score, label, hits: hits.slice(0, 4) };
}

/* -------------------------- 事件主题与资产影响映射 -------------------------- */
/* impact 取值 -2 ~ +2：对「价格 / 收益率 / 风险偏好」的方向，不是涨跌幅预测 */

const TOPICS = [
  {
    id: 'geopolitics', label: '地缘冲突', weight: 92,
    kw: ['war', 'invasion', 'missile', 'attack', 'nuclear', 'military strike', 'conflict', 'ceasefire',
      '战争', '入侵', '导弹', '袭击', '军事冲突', '停火', '地缘', '武装'],
    impact: { gold: 2, oil: 2, ust10y: -1, dxy: 0.5, equity: -2 },
    logic: '避险需求通常推升黄金与原油，压制股票风险偏好，资金流入国债压低收益率',
    sectors: ['贵金属', '石油', '能源', '军工', '国防', '船舶', '黄金']
  },
  {
    id: 'safehaven', label: '金融避险', weight: 90,
    kw: ['bank failure', 'default', 'credit crisis', 'contagion', 'liquidity crisis', 'flight to safety',
      'safe haven', '银行倒闭', '爆雷', '违约', '流动性危机', '避险', '挤兑', '金融危机'],
    impact: { gold: 2.5, oil: -1, ust10y: -2, dxy: 0.5, equity: -2.5 },
    logic: '系统性风险事件下资金涌向黄金与国债、撤离权益资产',
    sectors: ['贵金属', '黄金', '银行']
  },
  {
    id: 'easing', label: '货币宽松/降息', weight: 84,
    kw: ['rate cut', 'dovish', 'quantitative easing', 'stimulus', 'monetary easing', 'fed cuts',
      '降息', '宽松', '量化宽松', '刺激政策', '鸽派', '降准', '货币宽松'],
    impact: { gold: 2, oil: 1, ust10y: -2, dxy: -1, equity: 1.5 },
    logic: '实际利率与美元走低通常利多黄金、压低债券收益率并改善风险偏好',
    sectors: ['贵金属', '黄金', '证券', '房地产', '有色']
  },
  {
    id: 'tightening', label: '加息/鹰派', weight: 82,
    kw: ['rate hike', 'hawkish', 'higher for longer', 'tightening', '加息', '鹰派', '收紧', '缩表'],
    impact: { gold: -2, oil: -1, ust10y: 2, dxy: 1.5, equity: -1.5 },
    logic: '政策利率预期上行推升收益率与美元，压制黄金估值与成长股风险偏好',
    sectors: ['银行', '保险']
  },
  {
    id: 'inflation', label: '通胀数据', weight: 76,
    kw: ['cpi', 'inflation', 'ppi', 'price pressures', 'consumer prices', '通胀', '物价', 'cpi', 'ppi'],
    impact: { gold: 1, oil: 1, ust10y: 2, dxy: 0.5, equity: -1 },
    logic: '通胀黏性抬升名义收益率，黄金获得部分抗通胀买盘，估值端压制股票',
    sectors: ['贵金属', '石油', '能源', '农业', '消费']
  },
  {
    id: 'recession', label: '衰退/就业', weight: 78,
    kw: ['recession', 'nonfarm', 'payrolls', 'unemployment', 'jobless', 'slowdown', 'gdp contraction',
      '衰退', '非农', '失业', '就业疲弱', '经济放缓', '萎缩'],
    impact: { gold: 2, oil: -2, ust10y: -2, dxy: -0.5, equity: -2 },
    logic: '增长走弱压低原油需求预期与收益率，强化降息与避险交易',
    sectors: ['贵金属', '黄金', '公用', '医药']
  },
  {
    id: 'opec_cut', label: '供给收缩/减产', weight: 80,
    kw: ['opec', 'supply cut', 'output cut', 'production cut', 'supply disruption', 'embargo',
      'opec+', '减产', '供给中断', '禁运', '产量削减'],
    impact: { gold: 0.5, oil: 2.5, ust10y: 0.5, dxy: 0, equity: -0.5 },
    logic: '原油供给收紧直接推升油价，并通过通胀预期轻微抬升收益率',
    sectors: ['石油', '能源', '化工', '煤炭', '油服']
  },
  {
    id: 'oil_demand', label: '需求疲弱/增产', weight: 72,
    kw: ['demand outlook', 'demand weakness', 'output increase', 'supply glut', 'oil slump',
      '需求疲弱', '需求下滑', '增产', '供应过剩', '库存增加'],
    impact: { gold: -0.5, oil: -2.5, ust10y: -0.5, dxy: 0, equity: 0.5 },
    logic: '需求下修或供给增加压制油价，同时缓解通胀压力',
    sectors: ['石油', '能源', '化工', '航空', '物流']
  },
  {
    id: 'fiscal', label: '美债供给/评级', weight: 74,
    kw: ['treasury auction', 'bond supply', 'debt ceiling', 'credit rating', 'budget deficit',
      'yield curve', '国债拍卖', '债务上限', '评级下调', '财政赤字', '收益率曲线', '发债'],
    impact: { gold: 1, oil: 0, ust10y: 1.5, dxy: -0.5, equity: -1 },
    logic: '供给压力或主权信用担忧推升长端收益率，削弱美元与股票估值',
    sectors: ['银行', '证券', '贵金属']
  },
  {
    id: 'trade', label: '关税/制裁', weight: 70,
    kw: ['tariff', 'sanctions', 'trade war', 'export ban', '关税', '制裁', '贸易摩擦', '出口管制'],
    impact: { gold: 1.5, oil: 0.5, ust10y: 0.5, dxy: 0.5, equity: -1.5 },
    logic: '贸易壁垒抬升成本与不确定性，利多避险资产、压制权益风险偏好',
    sectors: ['贵金属', '黄金', '军工', '半导体', '农业']
  },
  {
    id: 'tech', label: '科技/AI/财报', weight: 62,
    kw: ['artificial intelligence', 'ai chip', 'earnings beat', 'nvidia', 'data center', 'semiconductor',
      '人工智能', '算力', '芯片', '半导体', '业绩超预期', '科技股', '财报'],
    impact: { gold: 0, oil: 0, ust10y: 0, dxy: 0, equity: 1.5 },
    logic: '科技盈利与资本开支预期改善主要影响权益风险偏好，对商品与利率为中性',
    sectors: ['半导体', '通信设备', '计算机', '电子', '软件', '消费电子', '光模块', '互联网']
  },
  {
    id: 'china', label: '中国政策/需求', weight: 66,
    kw: ['china stimulus', 'pboc', 'chinese demand', 'beijing', '央行', '中国经济', '内需', '政策刺激', '稳增长'],
    impact: { gold: 0.5, oil: 1, ust10y: 0, dxy: 0, equity: 1 },
    logic: '中国需求与政策预期主要通过大宗商品需求与全球风险偏好传导',
    sectors: ['有色', '钢铁', '化工', '消费', '基建', '工程机械', '证券']
  }
];

/* 市场相关性过滤：RSS 全球头条混杂体育 / 娱乐 / 地方政治，直接纳入会稀释解读结论。
   使用精确词组而非裸词，避免 "Gold medal"（金牌）、"olive oil"（橄榄油）误判为商品新闻。 */
const FINANCE_KW = [
  'market', 'stocks', 'shares', 'wall street', 'investor', 'nasdaq', 's&p', 'dow jones',
  'federal reserve', 'central bank', 'interest rate', 'rate cut', 'rate hike', 'bond',
  'treasury', 'yield', 'dollar', 'currency', 'gold price', 'gold prices', 'gold futures',
  'spot gold', 'crude', 'brent', 'wti', 'opec', 'oil price', 'oil prices', 'inflation',
  'cpi', 'gdp', 'economy', 'economic', 'recession', 'earnings', 'revenue', 'financial',
  'commodity', 'futures', 'tariff', 'trade war', 'bitcoin', 'crypto', 'fund', 'hedge fund',
  '市场', '股市', '股价', '投资者', '央行', '利率', '债券', '国债', '收益率', '美元',
  '黄金', '金价', '贵金属', '原油', '石油', '天然气', '油价', '能源', '通胀', '经济', '财报', '业绩',
  '银行', '金融', '贸易', '关税', '汇率', '期货', '大宗', '板块', 'a股', '沪指',
  '基金', '机构', '资金', '美股', '港股', '上市公司', '降息', '加息', '货币政策'
];
const NOISE_KW = [
  'ufc', 'nfl', 'nba', 'premier league', 'football match', 'tennis', 'golf', 'olympic',
  'celebrity', 'movie review', 'box office', 'album', 'concert', 'horoscope', 'recipe',
  'weather forecast', 'upper house candidate', 'local council', 'reality tv',
  '体育', '比赛', '夺冠', '金牌', '演唱会', '电影', '明星', '娱乐', '天气预报', '菜谱', '综艺'
];

const clampRs = (v, a, b) => Math.max(a, Math.min(b, v));

function marketRelevance(text, topics) {
  const lower = String(text || '').toLowerCase();
  let s = topics.length ? 22 + topics[0].weight * 0.22 : 0;
  let fin = 0, noise = 0;
  for (const k of FINANCE_KW) if (kwHit(lower, k)) { fin++; if (fin >= 4) break; }
  for (const k of NOISE_KW) if (kwHit(lower, k)) { noise++; if (noise >= 2) break; }
  s += fin * 14 - noise * 30;
  return Math.round(clampRs(s, 0, 100));
}

/* 行业 → 受益资产映射。避免「地缘冲突利多黄金、却给贵金属股票打负分」这类自相矛盾：
   此前错误地统一用 equity 方向给所有行业打分。 */
const SECTOR_ASSET = [
  { re: /贵金属|黄金|有色|小金属|珠宝/, asset: 'gold' },
  { re: /石油|油服|能源|煤炭|燃气|化工|石化/, asset: 'oil' },
  { re: /银行|保险|证券|券商|多元金融/, asset: 'ust10y' },
  { re: /军工|国防|船舶|航天|航空装备/, asset: 'defense' },
  { re: /医药|医疗|公用事业|电力|食品|饮料|农牧|消费/, asset: 'defensive' },
  { re: /半导体|通信|计算机|电子|软件|互联网|光模块|消费电子|光学/, asset: 'equity' }
];

function sectorImpact(sector, topic) {
  const rule = SECTOR_ASSET.find(r => r.re.test(sector));
  const eq = topic.impact.equity || 0;
  if (!rule) return eq * 0.6;
  if (rule.asset === 'defense') return topic.id === 'geopolitics' ? 1.8 : eq * 0.5;
  if (rule.asset === 'defensive') return -eq * 0.4;
  return topic.impact[rule.asset] !== undefined ? topic.impact[rule.asset] : eq * 0.6;
}

function kwHit(lower, kw) {
  const k = String(kw).toLowerCase();
  if (/^[a-z0-9 ]+$/.test(k)) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^a-z0-9])' + esc + '(?:s|es|ed|ing)?(?=$|[^a-z0-9])', 'i').test(lower);
  }
  return lower.includes(k);
}

function detectTopics(text) {
  const lower = String(text || '').toLowerCase();
  const out = [];
  for (const t of TOPICS) {
    const matched = t.kw.filter(k => kwHit(lower, k));
    if (matched.length) out.push({ id: t.id, label: t.label, weight: t.weight, matched: matched.slice(0, 3), impact: t.impact, logic: t.logic, sectors: t.sectors });
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, 3);
}

/* -------------------------- 单条新闻分析 -------------------------- */

function analyzeItem(n, tr, now) {
  const titleZh = (tr && tr.titleZh) || (n.lang === 'zh' ? n.title : null);
  const descZh = (tr && tr.descZh) || null;
  // 情感分只基于「新闻原文」，不再把中文译文拼进来：
  // 词典本身是中英双语，若原文与译文同时入串，同一语义会被各命中一次
  // （如 "fall" 与「下跌」、"attack" 与「袭击」），valence 翻倍或互相抵销。
  // 实测会把 "Mexico inflation spikes" 判成利多(+18)、把 "tanker attacks" 放大到 -92。
  // 译文仅用于主题识别（detectTopics 只看是否命中、不累加分数）与前端中英对照，不参与打分。
  const analysisText = [n.title, n.desc].filter(Boolean).join(' ');
  // 主题只依据标题判定：RSS 摘要常夹带无关背景词，实测会把「航班混乱」误判为地缘冲突。
  // 情感与市场相关性仍用原文全文，以便捕捉更多语义线索。
  const topicText = [n.title, titleZh].filter(Boolean).join(' ');
  const sent = scoreSentiment(analysisText);
  const topics = detectTopics(topicText);
  const relevance = marketRelevance(analysisText, topics);

  const impacts = {};
  for (const t of topics) {
    const w = 1 + (topics.indexOf(t) === 0 ? 0.4 : 0); // 主主题略加权
    for (const [k, v] of Object.entries(t.impact)) impacts[k] = (impacts[k] || 0) + v * w;
  }
  for (const k of Object.keys(impacts)) impacts[k] = +Math.max(-2, Math.min(2, impacts[k])).toFixed(2);

  const ageH = Math.max(0, (now - n.publishedAt) / 3600000);
  const recency = Math.round(10 * Math.max(0, 1 - ageH / 24));
  const themeW = topics.length ? topics[0].weight : 30;
  const levelBonus = n.level === 'critical' ? 18 : n.level === 'warning' ? 7 : 0;
  const importance = Math.min(100, Math.round(themeW * 0.62 + Math.abs(sent.score) * 0.20 + levelBonus + recency));

  const primary = topics[0] || null;
  const directions = ASSETS.filter(a => Math.abs(impacts[a.key] || 0) >= 0.8)
    .sort((a, b) => Math.abs(impacts[b.key]) - Math.abs(impacts[a.key]))
    .slice(0, 3)
    .map(a => ({ asset: a.key, label: a.label, dir: impacts[a.key] > 0 ? '偏多' : '偏空', note: a.note }));

  return {
    ...n,
    titleZh, descZh,
    translation: (tr && tr.engine) || (n.lang === 'zh' ? 'native' : 'original'),
    displayTitle: titleZh || n.title,
    sentiment: sent.score,
    sentimentLabel: sent.label,
    sentimentHits: sent.hits,
    relevance,
    topics: topics.map(t => ({ id: t.id, label: t.label, matched: t.matched, impact: t.impact, logic: t.logic, sectors: t.sectors })),
    primaryTopic: primary ? primary.label : '一般资讯',
    impacts,
    directions,
    importance,
    insight: primary
      ? primary.label + '：' + primary.logic
      : '未识别到高影响事件主题，按一般市场资讯处理'
  };
}

/* -------------------------- 每日综述 -------------------------- */

function directionText(v) {
  if (v >= 45) return '明显偏多';
  if (v >= 18) return '偏多';
  if (v > -18) return '中性';
  if (v > -45) return '偏空';
  return '明显偏空';
}

function buildBriefing(news, translations, quotes, opts = {}) {
  const now = opts.now || Date.now();
  const windowHours = 24;
  const raw = (news && Array.isArray(news.items)) ? news.items : [];
  const inWindow = raw.filter(n => now - n.publishedAt <= windowHours * 3600000 + 3600000);
  const items = inWindow.slice(0, 80).map(n => analyzeItem(n, translations[n.id], now));
  // 只有市场相关新闻进入统计与结论，体育 / 娱乐 / 地方政治等不稀释信号
  const core = items.filter(x => x.relevance >= 35);

  const counts = {
    rawTotal: items.length,
    total: core.length,
    filtered: items.length - core.length,
    positive: core.filter(x => x.sentiment >= 8).length,
    neutral: core.filter(x => x.sentiment > -8 && x.sentiment < 8).length,
    negative: core.filter(x => x.sentiment <= -8).length,
    translated: core.filter(x => x.translation === 'machine').length,
    native: core.filter(x => x.translation === 'native').length,
    critical: core.filter(x => x.level === 'critical').length
  };
  const sentimentAvg = core.length ? Math.round(core.reduce((s, x) => s + x.sentiment, 0) / core.length) : 0;
  const tone = sentimentAvg >= 12 ? '偏乐观' : sentimentAvg <= -12 ? '偏谨慎' : '中性偏平衡';

  // 主题热度
  const themeMap = new Map();
  for (const it of core) for (const t of it.topics) {
    if (!themeMap.has(t.id)) themeMap.set(t.id, { id: t.id, label: t.label, count: 0, weight: 0, sentiment: 0, impact: t.impact, logic: t.logic, sectors: t.sectors });
    const e = themeMap.get(t.id);
    e.count++; e.weight += it.importance; e.sentiment += it.sentiment;
  }
  const themes = Array.from(themeMap.values())
    .map(t => ({ ...t, avgSentiment: Math.round(t.sentiment / t.count), heat: Math.round(t.weight / Math.max(1, core.length)) }))
    .sort((a, b) => b.weight - a.weight).slice(0, 6);

  // 资产影响：按重要度加权平均
  const impacts = ASSETS.map(a => {
    const related = core.filter(x => Math.abs(x.impacts[a.key] || 0) > 0);
    let wsum = 0, sum = 0;
    for (const x of related) { const w = x.importance / 100; sum += x.impacts[a.key] * w; wsum += w; }
    const avg = wsum ? sum / wsum : 0;
    const score = Math.round(Math.max(-100, Math.min(100, avg * 50)));
    return {
      asset: a.key, label: a.label, note: a.note, score,
      direction: directionText(score), newsCount: related.length,
      logic: themes.find(t => Math.abs(t.impact[a.key] || 0) >= 1)?.logic || '当前窗口内缺少明确的方向性事件'
    };
  });

  // 行业倾向（供选股模块做消息面联动）
  const sectorMap = new Map();
  for (const it of core) for (const t of it.topics) {
    const sign = Math.sign(it.sentiment) || 0;
    for (const s of t.sectors) {
      const cur = sectorMap.get(s) || { sector: s, score: 0, count: 0, themes: new Set() };
      cur.score += sectorImpact(s, t) * 16 + sign * 4;
      cur.count++;
      cur.themes.add(t.label);
      sectorMap.set(s, cur);
    }
  }
  const sectorBias = Array.from(sectorMap.values())
    .map(s => ({ sector: s.sector, score: Math.round(Math.max(-100, Math.min(100, s.score / Math.max(1, Math.sqrt(s.count))))), count: s.count, themes: Array.from(s.themes).slice(0, 3) }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 16);

  // 风险温度
  const negRatio = core.length ? counts.negative / core.length : 0;
  const critRatio = core.length ? counts.critical / core.length : 0;
  const riskyThemes = themes.filter(t => ['geopolitics', 'safehaven', 'recession', 'tightening'].includes(t.id))
    .reduce((s, t) => s + t.count, 0);
  const eqScore = (impacts.find(i => i.asset === 'equity') || {}).score || 0;
  const eqDrag = eqScore < -30 ? 12 : 0; // 消息面对权益明显偏空时抬高风险温度
  const riskTemperature = Math.min(100, Math.round(
    negRatio * 45 + critRatio * 60 + (core.length ? riskyThemes / core.length : 0) * 55 +
    (sentimentAvg < 0 ? Math.abs(sentimentAvg) * 0.12 : 0) + eqDrag
  ));

  const headlines = (core.length ? core : items).slice()
    .sort((a, b) => b.importance - a.importance || b.publishedAt - a.publishedAt).slice(0, 8);

  // 中文综述：句句来自上面的统计，不引入外部事实
  const narrative = [];
  if (core.length) {
    narrative.push('过去 24 小时共采集 ' + counts.rawTotal + ' 条新闻，识别出市场相关 ' + counts.total +
      ' 条（已过滤体育 / 娱乐等无关资讯 ' + counts.filtered + ' 条）；其中中文原生 ' + counts.native +
      ' 条、机器译文 ' + counts.translated + ' 条。市场相关新闻整体情绪' + tone +
      '（正面 ' + counts.positive + ' / 中性 ' + counts.neutral + ' / 负面 ' + counts.negative + ' 条，均值 ' + sentimentAvg + '）。');
    if (themes.length) {
      narrative.push('主导事件为' + themes.slice(0, 3).map(t => t.label + '（' + t.count + ' 条）').join('、') + '。');
    }
    const strong = impacts.filter(i => Math.abs(i.score) >= 18).sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 3);
    if (strong.length) {
      narrative.push('按事件-资产映射规则，消息面对' +
        strong.map(i => i.label + i.direction + '（' + (i.score > 0 ? '+' : '') + i.score + '，' + i.newsCount + ' 条相关）').join('、') + '；' +
        '该方向为规则推理，非价格预测。');
    } else {
      narrative.push('当前窗口内缺少一致性的方向性事件，各大类资产的消息面倾向接近中性。');
    }
    narrative.push('风险温度 ' + riskTemperature + '/100（负面占比 ' + Math.round(negRatio * 100) + '%、高影响关键词 ' +
      counts.critical + ' 条、高风险主题 ' + riskyThemes + ' 条）。' +
      (riskTemperature >= 60 ? '消息面扰动偏强，注意控制仓位与设置止损。' : riskTemperature >= 35 ? '存在局部扰动，建议留意重点事件。' : '未见显著系统性扰动。'));
  } else {
    narrative.push('近 24 小时暂无可用新闻，暂不生成解读，等待下一轮采集。');
  }

  return {
    version: 1,
    generatedAt: now,
    windowHours,
    counts, sentimentAvg, tone, riskTemperature,
    themes, impacts, sectorBias, headlines,
    narrative,
    items,
    methodology: {
      sentiment: '金融领域双语情感词典 + 否定词 / 程度副词修正，VADER 式归一化（参考 StockView 的 VADER 与 AutoWealth 的情感词典思路）',
      fusion: '事件主题识别 → 主题到资产的方向映射 → 按新闻重要度加权融合（参考 ai-stock-watcher 的多信号融合与 AutoWealth 的加权投票）',
      explainability: '每条结论附命中主题、逻辑说明与相关新闻数（参考 QuantFusionAI 的可解释信号）',
      noForecast: '不输出价格预测。StockView 公开的时序 80/20 回测中，随机森林/LightGBM/XGBoost/线性回归平均 R² 为 -1.02 ~ -2.93，说明日频价格预测在样本外普遍失效',
      translation: '英文标题经机器翻译自动转为中文并落盘缓存；中文原生新闻保持原文；翻译不可用时保留原文并标注'
    },
    disclaimer: '消息面解读为基于关键词与情感词典的规则推理，用于提示关注方向，不构成因果判断、价格预测或投资建议。'
  };
}

module.exports = { buildBriefing, analyzeItem, scoreSentiment, detectTopics, ASSETS, TOPICS, LEXICON };
