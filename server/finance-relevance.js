'use strict';

/**
 * finance-relevance.js — 新闻「金融相关性」确定性标注
 *
 * 目的：新闻快讯应以金融内容为主。采集层混入大量综合媒体（BBC World / Al Jazeera /
 * Guardian / Google 全球头条）的社会、体育、地缘、地方新闻，需要一个可复现的口径，
 * 把「金融相关」与「非金融」分开，用于：
 *   ① 池子截断时优先保留金融条目（不被综合新闻按时间挤掉）；
 *   ② 前端「金融」筛选与每条新闻的标签；
 *   ③ 覆盖率统计（可追溯、可回归验证）。
 *
 * 纪律：
 *   - 纯词表匹配，零模型、零联网、零随机；同一输入永远同一输出。
 *   - 只做标注，不删除新闻、不改写标题、不预判行情、不构成投资建议。
 *   - 中文用包含匹配；英文用词边界正则，避免 war→award、fed→federal、
 *     market→supermarket 这类误命中。
 *   - 「命中」不等于「对 A 股有影响」：这是主题相关性，不是板块映射、不是方向判断。
 */

/** 词表分组：tag 用于前端分组展示；zh 为包含匹配；en 为词边界匹配（自动加 \b） */
const GROUPS = [
  {
    tag: '宏观与货币政策',
    zh: ['央行', '人民银行', '美联储', '欧洲央行', '日本央行', '议息', 'FOMC', '利率', '加息', '降息',
      '降准', 'LPR', 'MLF', 'SLF', '逆回购', '公开市场', '存款准备金', 'CPI', 'PPI', 'PMI', 'GDP',
      '通胀', '通缩', '非农', '失业率', '就业数据', '社融', '社会融资', 'M1', 'M2', '信贷',
      '新增贷款', '统计局', '财政部', '专项债', '地方债', '国债', '收益率曲线', '汇率', '人民币',
      '美元指数', '外汇', '中间价', '货币政策', '财政政策', '经济数据', '经济增速', '景气度',
      '减税', '贴息', 'PMI', 'PCE', '核心通胀', '经济刺激', '衰退',
      '纽约联储', '联储', '初请', '续请', '经济指标', '景气指数', '消费者信心',
      '零售销售', '工业产出', '耐用品订单', '贸易帐', '外汇储备', '资金面', '流动性',
      '同业存单', 'Shibor', 'DR007', '贷款市场报价利率', '存款利率', '公司债压力指标',
      '当周', '经济数据公布', '数据快讯',
      '新屋销售', '成屋销售', '营建许可', '新屋开工', '环比', '同比', '季调',
      '制造业产出', '工业产值', '库存变动',
      '关税', '加征关税', '贸易摩擦', '贸易协定', '出口管制', '制裁', '反倾销'],
    en: ['fed', 'fomc', 'central bank', 'interest rate', 'rate cut', 'rate hike', 'inflation',
      'cpi', 'ppi', 'pmi', 'gdp', 'nonfarm', 'payroll', 'unemployment', 'jobless claims',
      'monetary policy', 'fiscal', 'stimulus', 'recession', 'yield curve', 'treasury yield',
      'bond yield', 'economic data', 'economic growth', 'powell', 'ecb', 'boj', 'pce',
      'debt ceiling', 'budget deficit', 'soft landing', 'hard landing',
      'eia', 'corporate bond', 'credit spread', 'liquidity', 'economic indicator',
      'tariff', 'trade war', 'sanctions', 'export control', 'trade deal',
      'customs duties', 'trade policy']
  },
  {
    tag: '资本市场与监管',
    zh: ['A股', '美股', '港股', '股市', '股票', '股价', '股指', '上证', '深证', '创业板', '科创板',
      '北交所', '沪深', 'IPO', '上市', '退市', '注册制', '再融资', '定增', '配股', '可转债',
      '证监会', '交易所', '上交所', '深交所', '监管处罚', '立案调查', '并购', '重组', '借壳',
      '做市', '两融', '融资融券', '融资余额', '北向', '南向', '沪股通', '深股通', 'ETF',
      '公募', '私募', '基金', '资管', '券商', '证券', '保险', '险资', '期货', '期权',
      '龙虎榜', '大宗交易', '解禁', '限售', '增减持', '回购', '分红', '送转', '打新',
      '新股', '次新股', '破发', '涨停', '跌停', '成交额', '成交量', '换手率', '市值',
      '估值', '市盈率', '资金流向', '主力资金', '外资', '汇金', '社保基金', '养老金',
      '互联互通', '融券', '转融通', '程序化交易', '量化交易', '停牌', '复牌', '风险警示',
      '融资保证金', '印花税', '资本市场', '稳定股市', '增量资金', '长线资金'],
    en: ['stock', 'stocks', 'share price', 'shares', 'equity', 'equities', 'stock market',
      'wall street', 'nasdaq', 's&p 500', 'dow jones', 'ipo', 'listing', 'delist', 'sec',
      'securities regulator', 'stock exchange', 'brokerage', 'investment bank', 'etf',
      'mutual fund', 'hedge fund', 'capital market', 'buyback', 'share repurchase',
      'dividend', 'merger', 'acquisition', 'takeover', 'antitrust', 'short selling',
      'trading halt', 'market cap', 'valuation', 'price target', 'analyst', 'upgrade',
      'downgrade', 'earnings season', 'stock futures', 'volatility', 'vix',
      'bull market', 'bear market', 'selloff', 'sell-off', 'rally', 'stock index']
  },
  {
    tag: '公司与财报',
    zh: ['财报', '业绩', '营收', '营业收入', '净利润', '亏损', '盈利', '季报', '年报', '中报',
      '业绩预告', '业绩快报', '公告', '中标', '订单', '扩产', '涨价', '降价', '董事会',
      '股东大会', '管理层', '业绩指引', '毛利率', '现金流', '商誉', '股权激励', '分拆',
      '股东', '股份', '减持计划', '增持计划', '回购股份'],
    en: ['earnings', 'revenue', 'net income', 'quarterly results', 'guidance', 'profit',
      'loss', 'ceo', 'cfo', 'board of directors', 'shareholder', 'annual report',
      'gross margin', 'cash flow', 'layoffs', 'restructuring', 'bankruptcy', 'default',
      'credit rating', 'sales forecast', 'profit warning']
  },
  {
    tag: '行业与板块',
    zh: ['半导体', '芯片', '晶圆', '光刻', '封装', '集成电路', '新能源', '光伏', '锂电', '储能',
      '风电', '汽车', '新能源车', '智能驾驶', '医药', '创新药', '集采', '医疗', '白酒',
      '家电', '地产', '房地产', '楼市', '房企', '银行', '煤炭', '钢铁', '有色', '稀土',
      '算力', '人工智能', '大模型', '数据中心', '光模块', '消费电子', '机器人', '低空经济',
      '固态电池', '军工', '航运', '电力', '核电', '化工', '猪价', '旅游', '零售',
      '物理AI', '产业生态', '算力租赁', '光通信', '液冷', '先进制程'],
    en: ['semiconductor', 'chipmaker', 'chip maker', 'nvidia', 'tsmc', 'memory chip',
      'electric vehicle', 'ev maker', 'tesla', 'automaker', 'battery maker', 'solar panel',
      'photovoltaic', 'pharmaceutical', 'biotech', 'fda approv', 'vaccine', 'clinical trial',
      'real estate', 'housing market', 'property developer', 'bank stock', 'insurer',
      'defense contractor', 'airline', 'retailer', 'data center', 'cloud computing',
      'generative ai', 'artificial intelligence', 'wind farm', 'coal miner', 'steel mill',
      'ai', 'physical ai', 'ai chip', 'ai model']
  },
  {
    tag: '大宗·债券·汇率·加密',
    zh: ['黄金', '金价', '白银', '贵金属', '原油', '油价', '石油', 'OPEC', '天然气', '铜价',
      '铁矿', '螺纹钢', '焦煤', '动力煤', '锂价', '碳酸锂', '大宗商品', '黄金期货',
      '比特币', '加密货币', '数字货币', '稳定币', '债券', '美债', '信用债', '国债收益率',
      '美元', '欧元', '日元', '避险', 'COMEX', '布伦特', 'WTI', '期金', '期油',
      'EIA', '库存变动', '精炼油', '汽油', '馏分油', '原油库存', 'API库存',
      '战略储备', 'SPR', '精炼厂', '产能利用率'],
    en: ['gold price', 'gold prices', 'gold futures', 'precious metal', 'silver price',
      'crude oil', 'oil price', 'brent crude', 'wti', 'opec', 'natural gas', 'copper price',
      'iron ore', 'thermal coal', 'lithium price', 'commodity', 'futures contract',
      'bitcoin', 'crypto', 'cryptocurrency', 'stablecoin', 'treasury', 'bond market',
      'us dollar', 'euro', 'yen', 'currency', 'forex', 'safe haven', 'gold mining',
      'eia', 'oil inventory', 'crude inventory', 'gasoline', 'distillate', 'refinery',
      'stockpile', 'strategic reserve', 'spr', 'spot gold', 'bullion', 'price of gold',
      'gold sinks', 'gold rises', 'gold falls', 'gold surges', 'gold slips',
      'silver crashes', 'gold below', 'gold above', 'gold traded']
  }
];

/** 预编译英文正则（词边界，允许常见复数/时态后缀），避免每次调用重复构造 */
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const EN_RULES = [];
for (const g of GROUPS) {
  for (const w of g.en) {
    const body = escRe(w).replace(/\\ /g, '\\s+');
    EN_RULES.push({ tag: g.tag, w, re: new RegExp('(^|[^a-z0-9])' + body + '(?:s|es|ed|ing)?(?=$|[^a-z0-9])', 'i') });
  }
}
const ZH_RULES = [];
for (const g of GROUPS) for (const w of g.zh) ZH_RULES.push({ tag: g.tag, w });

const TAG_LABELS = GROUPS.map(g => g.tag);

/**
 * 判定一条新闻是否金融相关。
 * @param {string} title 标题（原文）
 * @param {string} desc  摘要（原文）
 * @param {object} [opts] { limit = 8 } 最多记录多少命中词
 * @returns {{isFinance:boolean, score:number, tags:string[], hits:string[], byTag:object}}
 */
function classify(title, desc, opts = {}) {
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 8;
  const text = String(title || '') + ' ' + String(desc || '');
  const lower = text.toLowerCase();
  const hits = [];
  const byTag = {};
  const seen = new Set();

  for (const r of ZH_RULES) {
    if (text.includes(r.w) && !seen.has('zh:' + r.w)) {
      seen.add('zh:' + r.w);
      byTag[r.tag] = (byTag[r.tag] || 0) + 1;
      hits.push(r.w);
    }
  }
  for (const r of EN_RULES) {
    if (r.re.test(lower) && !seen.has('en:' + r.w)) {
      seen.add('en:' + r.w);
      byTag[r.tag] = (byTag[r.tag] || 0) + 1;
      hits.push(r.w);
    }
  }

  const tags = TAG_LABELS.filter(t => byTag[t] > 0);
  return {
    isFinance: hits.length > 0,
    score: hits.length,
    tags,
    hits: hits.slice(0, limit),
    byTag
  };
}

/** 便捷：直接从采集层 item 对象判定 */
function ofItem(n) {
  if (!n) return classify('', '');
  return classify(n.title, n.desc || n.description || '', {});
}

module.exports = { classify, ofItem, GROUPS, TAG_LABELS };
