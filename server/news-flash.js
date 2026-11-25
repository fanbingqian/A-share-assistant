'use strict';
const macroOutlook = require('./macro-outlook');
/**
 * news-flash.js — 「新闻快讯」板块：真实新闻聚合 + 智能体解读
 *
 * 数据来源（全部来自系统内存中的真实数据，不重新抓取、不编造）：
 *   - latest.news.items          60 秒轮询的新闻池（华尔街见闻 / 中新网 / BBC / Google News 等）
 *   - newsPulse.latest()         每小时消息面脉冲（政策快讯 / 板块消息面 / 源健康 / 头条）
 *   - futureEvents.report()      新闻未来事件扫描的「待复核队列」（含回购等公司公告线索）
 *
 * 低幻觉纪律：
 *   1. 解读 prompt 里逐字引用新闻标题 / 摘要 / 来源 / 时点，禁止模型扩写事实；
 *   2. 个股代码与名称只能来自 cal.relatedStocks() 生成的系统真实标的清单；
 *   3. 板块映射是关键词近似，必须标注；
 *   4. 输出只写结构化文字叙述（固定段标题 + `- ` 列表 + **加粗** + 依据行），
 *      禁表格 / 图表 / 代码块 / emoji，且不预测涨跌、不给买卖指令；
 *   5. 区分「新闻事实 / 程序计算 / 本次推测」，推测必须带证伪条件。
 *
 * promptVersion：news-flash-v1（单条） / news-daily-v1（今日整体）
 */

const SECTOR_HINTS = [
  ['券商', /券商|证券|两融|融资保证金|印花税|资本市场|IPO|注册制/],
  ['银行', /银行|降准|降息|LPR|MLF|逆回购|信贷|社融|存款/],
  ['地产', /地产|房地产|楼市|房贷|建筑|建材/],
  ['半导体', /半导体|芯片|晶圆|光刻|存储|先进制程/],
  ['算力', /算力|AI|人工智能|数据中心|光模块|液冷|大模型/],
  ['新能源', /新能源|光伏|锂电|储能|风电|逆变器/],
  ['汽车', /汽车|新能源车|智能驾驶|整车|零部件/],
  ['医药', /医药|创新药|医疗|中药|疫苗|集采/],
  ['消费', /消费|白酒|食品|家电|零售|免税/],
  ['黄金', /黄金|贵金属|金价/],
  ['石油', /原油|石油|油气|OPEC/],
  ['煤炭', /煤炭|动力煤|焦煤/],
  ['军工', /军工|国防|航天|军贸/],
  ['出口链', /出口|外贸|关税|贸易|跨境/]
];

/**
 * 英文主题词 → 与 SECTOR_HINTS 完全相同的中文主题名（供 cal.relatedStocks 找系统真实标的）。
 * 外媒标题占新闻流六成以上，纯中文主题词命中不到，会让英文新闻的单条解读拿不到关联标的。
 * 只用金融语境短语而非裸单词：避免把游戏 "Golden Week / Gold Skins"、体育 "Gold Glove" 误判成黄金主题。
 */
const SECTOR_HINTS_EN = [
  ['黄金', /gold price|gold prices|gold futures|precious metal|gold mining|gold reserves|\bXAU\b|silver price|gold equities/i],
  ['石油', /crude oil|oil price|brent crude|\bWTI\b|\bOPEC\b|oil supply|oil output|petroleum|oil demand/i],
  ['半导体', /semiconductor|chipmaker|chip maker|memory chip|\bNvidia\b|\bTSMC\b|wafer|foundry|AI chip|chip export/i],
  ['算力', /artificial intelligence|generative AI|large language model|\bLLM\b|data center|cloud computing|AI model/i],
  ['汽车', /electric vehicle|EV maker|automaker|vehicle delivery|car sales|\bTesla\b|autonomous driving/i],
  ['新能源', /solar panel|solar module|photovoltaic|lithium|EV battery|battery storage|wind farm/i],
  ['医药', /drugmaker|pharmaceutical|FDA approv|\bvaccine\b|biotech|clinical trial/i],
  ['券商', /investment bank|brokerage|capital market|\bIPO\b|stock exchange|securities regulator|equity trading/i],
  ['银行', /central bank|interest rate|\bFed\b|rate cut|rate hike|bank lending|bank earnings|net interest margin|bank stocks/i],
  ['地产', /real estate|property market|home sales|housing market|mortgage rate|property developer/i],
  ['煤炭', /coal price|coal demand|thermal coal|metallurgical coal|coal miner/i],
  ['军工', /defense contractor|arms sales|defense spending|missile defense/i],
  ['出口链', /\btariff\b|trade war|export ban|customs duties|supply chain disruption/i],
  ['消费', /retail sales|consumer spending|consumer confidence|e-commerce retail/i],
  ['航运', /shipping rate|container rate|freight rate|\bHormuz\b|tanker traffic/i]
];

/** 判定是否为英文消息：优先用采集端 lang，缺失时按中英文字占比推断（可追溯、不调模型） */
function isEnglishNews(n) {
  if (n && n.lang === 'en') return true;
  if (n && n.lang === 'zh') return false;
  const t = String((n && n.title) || '') + ' ' + String((n && n.desc) || '');
  const han = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const lat = (t.match(/[A-Za-z]/g) || []).length;
  return lat > 20 && han < lat * 0.25;
}

/**
 * 真实股市板块定义表 —— 对应系统真实行情数据（data/strength-cache.json，东财行业板块全量列表）
 * 每项：[板块名, 东财BK代码, 系统大类, 新闻关键词正则]
 * 说明：名称 / 代码 / 大类均来自系统真实板块清单（非编造、非主题词伪板块）；
 *      关键词为「显式、可追溯」的近似映射，用于把新闻归入股市板块，并非官方行业分类或模型推断。
 * 与 SECTOR_HINTS 的区别：SECTOR_HINTS 是「主题词」（算力 / 出口链 / 政策主题），
 *      用于智能体解读找关联标的；本表是「可交易股市板块」（带 BK 代码），用于消息收集与排名。
 */
const BOARD_DEFS = [
  ['半导体', 'BK1036', '科技', /半导体|芯片|晶圆|光刻|存储芯片|先进制程|集成电路|芯片设计|封测|EDA|中芯|台积电/],
  ['元件', 'BK0459', '科技', /PCB|印制电路|覆铜板|被动元件|电容|电感|连接器|CPO|共封装光学/],
  ['光学光电子', 'BK1038', '科技', /面板|显示驱动|OLED|MiniLED|光学|镜头|光模块|光通信|光芯片/],
  ['消费电子', 'BK1037', '科技', /消费电子|智能手机|苹果|iPhone|安卓|可穿戴|AI眼镜|耳机|折叠屏/],
  ['通信设备', 'BK0448', '科技', /通信设备|5G|6G|基站|交换机|路由器|光网络|卫星互联网/],
  ['通信服务', 'BK0736', '科技', /运营商|中国移动|中国电信|中国联通|通信服务|移动网络/],
  ['计算机设备', 'BK0735', '科技', /服务器|算力硬件|计算机设备|整机|超算|数据中心硬件/],
  ['国防军工', 'BK1204', '科技', /军工|国防|航天|军贸|导弹|军费|武器装备|兵工|舰船/],
  ['软件开发', 'BK0737', '科技', /软件|SaaS|操作系统|数据库|大模型|AI应用|人工智能|算力租赁|云计算|办公软件|信创/],
  ['游戏Ⅱ', 'BK1046', '科技', /游戏|版号|手游|电竞|网游|游戏出海/],
  ['传媒', 'BK0486', '科技', /传媒|影视|院线|票房|出版|广告|短剧|内容平台/],
  ['电池', 'BK1033', '周期', /锂电|动力电池|储能电池|固态电池|电池|宁德时代|电池回收/],
  ['光伏设备', 'BK1031', '周期', /光伏|硅料|硅片|组件|逆变器|电池片|N型|HJT|钙钛矿/],
  ['风电设备', 'BK1032', '其他', /风电|风机|海风|海上风电/],
  ['电网设备', 'BK0457', '其他', /电网|特高压|变压器|输配电|智能电网|电表/],
  ['电力', 'BK0428', '周期', /火电|水电|核电|发电|电价|用电负荷|电力市场|绿电/],
  ['汽车零部件', 'BK0481', '消费', /汽车零部|新能源车|智能驾驶|自动驾驶|整车|车企|乘用车|车市|以旧换新|汽车出口|小米汽车|汽车交付|汽车销量|新车|车型|造车|汽车业务|智能座舱/],
  ['证券Ⅱ', 'BK0473', '金融', /券商|证券|两融|融资保证金|IPO|注册制|印花税|资本市场|再融资|并购重组|北交所|交易所/],
  ['银行Ⅱ', 'BK0475', '防御', /银行|降准|降息|LPR|MLF|信贷|社融|存款|净息差|逆回购|公开市场/],
  ['保险Ⅱ', 'BK0474', '金融', /保险|保费|寿险|财险|险资|偿付能力/],
  ['多元金融', 'BK0738', '金融', /信托|金融租赁|期货|金融科技|支付|征信/],
  ['房地产开发', 'BK0451', '金融', /地产|房地产|楼市|房贷|房企|商品房|土拍|保交楼|限购/],
  ['煤炭', 'BK0437', '周期', /煤炭|动力煤|焦煤|焦炭|煤价/],
  ['石油石化', 'BK0464', '周期', /原油|石油|油气|OPEC|炼化|油价|石化|天然气|页岩油/],
  ['贵金属', 'BK0732', '周期', /黄金|贵金属|金价|白银|金饰|央行购金/],
  ['有色金属', 'BK0478', '周期', /有色|铜价|电解铝|锌|工业金属|伦铜|金属价格/],
  ['小金属', 'BK1027', '周期', /稀土|小金属|钨|锑|锗|镓|钼/],
  ['能源金属', 'BK1015', '其他', /锂矿|锂价|碳酸锂|钴|镍|能源金属/],
  ['钢铁', 'BK0479', '周期', /钢铁|钢材|螺纹钢|铁矿石|特钢|粗钢/],
  ['化学制品', 'BK0538', '周期', /化工|化学制品|塑料|橡胶|化纤|农化|农药|化肥|环氧丙烷|制冷剂/],
  ['化学制药', 'BK0465', '周期', /创新药|化学制药|仿制药|原料药|药企|BD授权|GLP-1|集采/],
  ['中药Ⅱ', 'BK1040', '防御', /中药|中医药|药材|中成药/],
  ['生物制品', 'BK1044', '防御', /疫苗|生物制品|血制品|抗体|基因治疗/],
  ['医疗器械', 'BK1041', '防御', /医疗器械|医疗耗材|IVD|影像设备|高值耗材/],
  ['医疗服务', 'BK0727', '防御', /医疗服务|医院|CXO|临床|CRO/],
  ['医药商业', 'BK1042', '消费', /医药商业|医药流通|连锁药店|网上药房|阿里健康|京东健康|药品零售/],
  ['食品饮料', 'BK0438', '消费', /白酒|食品|饮料|乳品|调味品|啤酒|零食|预制菜|餐饮/],
  ['家用电器', 'BK0456', '其他', /家电|空调|冰箱|洗衣机|小家电|白电/],
  ['农林牧渔', 'BK0433', '其他', /农业|养殖|生猪|猪价|种业|饲料|农产品|粮食|玉米|大豆/],
  ['纺织服饰', 'BK0436', '消费', /纺织|服装|服饰|家纺|鞋类|品牌服饰/],
  ['一般零售', 'BK0482', '消费', /零售|商超|免税|电商|消费券|社零|双十一|618/],
  ['航运港口', 'BK0450', '周期', /航运|港口|集运|运价|海运|船东|红海|苏伊士/],
  ['航空机场', 'BK0420', '科技', /航空|机场|民航|机票|航班|空运/],
  ['物流', 'BK0422', '其他', /物流|快递|仓储|供应链|货运/],
  ['工程机械', 'BK0739', '周期', /工程机械|挖掘机|起重机|叉车|农机/],
  ['通用设备', 'BK0545', '其他', /通用设备|机床|机器人|减速器|工业母机|人形机器人|工控/],
  ['专用设备', 'BK0910', '其他', /专用设备|半导体设备|锂电设备|设备招标/],
  ['装修建材', 'BK0476', '周期', /建材|水泥|玻璃|玻纤|装修|涂料|防水/],
  ['公用事业', 'BK0427', '防御', /公用事业|供水|供气|环保|固废|水务/]
];

/**
 * 英文行业/商品短语 → 真实股市板块（BK 代码）。
 * 新闻池含大量外媒标题（如 Gold price、crude oil、Nvidia），纯中文行业词命中不到，
 * 但黄金/原油/半导体等确实对应 A 股「贵金属 / 石油石化 / 半导体」等真实板块。
 * 只用「金融语境短语」而非裸单词，避免把体育「Gold Glove」或币圈「Bitcoin or Gold?」误判成板块消息。
 * 宏观（Fed / 通胀 / 美元）、币圈、地缘伤亡等无对应 A 股板块的，如实不映射，不硬凑。
 */
const BOARD_EN = [
  ['BK0732', /gold price|gold prices|gold trades|digital gold|gold exploration|gold trend|gold investment|gold mining|gold reserves|gold futures|buy(?:ing)? more gold|precious metal|silver price|\bXAU\b|gold equities/i],
  ['BK0464', /oil price|crude oil|brent crude|\bWTI\b|\bOPEC\b|oil supply|oil output|oil futures|petroleum|oil demand/i],
  ['BK1036', /semiconductor|chipmaker|chip maker|memory chip|\bNvidia\b|\bTSMC\b|foundry|wafer|AI chip|chip export/i],
  ['BK0737', /artificial intelligence|generative AI|large language model|\bLLM\b|data center|cloud computing|AI model/i],
  ['BK0481', /electric vehicle|EV maker|automaker|vehicle delivery|car sales|\bTesla\b|autonomous driving/i],
  ['BK1031', /solar panel|solar module|photovoltaic|solar cell|solar farm/i],
  ['BK1033', /lithium|battery maker|EV battery|solid-state battery|\bCATL\b|battery storage/i],
  ['BK0450', /shipping rate|container rate|freight rate|\bHormuz\b|shipping stocks|tanker/i],
  ['BK0465', /drugmaker|pharmaceutical|FDA approv|\bvaccine\b|biotech|clinical trial/i],
  ['BK1204', /defense contractor|arms sales|defense spending|missile defense/i],
  ['BK0475', /central bank|interest rate|\bFed\b|rate cut|rate hike|bank lending|bank earnings|net interest margin|bank stocks/i],
  ['BK0473', /investment bank|brokerage|capital market|\bIPO\b|stock exchange|securities regulator|equity trading/i],
  ['BK0474', /insurer|insurance premium|life insurance|insurance stocks/i],
  ['BK0451', /real estate|property market|home sales|housing market|mortgage rate|property developer/i],
  ['BK0437', /coal price|coal demand|thermal coal|metallurgical coal|coal miner/i],
  ['BK0479', /steel price|steel mill|iron ore|steel output|steel stocks/i],
  ['BK0478', /copper price|aluminium price|industrial metal|base metal/i],
  ['BK0438', /food and beverage|liquor maker|retail sales|consumer spending|consumer confidence/i],
  ['BK0486', /media studio|box office|streaming platform|advertising market/i],
  ['BK1046', /video game|game publisher|game sales|esports/i],
  ['BK1037', /smartphone|\biPhone\b|consumer electronics|wearable device/i],
  ['BK0428', /electricity demand|nuclear power|power generation|utility stocks/i],
  ['BK0457', /power grid|ultra-high voltage|transformer|electricity transmission/i],
  ['BK0420', /airline|airport|air travel|flight demand/i],
  ['BK1032', /wind farm|wind turbine|offshore wind/i],
  ['BK0727', /hospital operator|clinical trial|\bCRO\b|healthcare service/i]
];

/** 公司公告类线索关键词（用户反馈：回购等公告消息不该混在日程与事件里） */
const COMPANY_KW = /回购|增持|减持|停牌|复牌|中标|业绩预|解禁|分红|质押|重组|收购|公告|股份|股东|风险警示|\bST\b|股东大会|可转债|定增/;

/* ---------- 消息面「初步评估」：确定性、可复现、可追溯 ----------
 * 口径完全沿用 server/analysis.js 已有的真实计算，本模块不重新打分、不调用大模型：
 *   - scoreSentiment()：VADER 式金融双语情感词典（含否定词 / 程度副词修正）→ sentiment ∈ [-100,100]
 *   - buildBriefing() 的 counts 分档：>= 8 正面（利多）、<= -8 负面（利空），其余中性
 * 因此同一批新闻每次刷新得到的比例完全一致；每条判定都能回溯到情感分与命中词。
 * 利多=红、利空=绿，遵循 A 股红涨绿跌习惯；占比是「新闻条数比例」，不是涨跌概率。
 */
const BIAS_POS = 8, BIAS_NEG = -8;

function biasOf(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'neutral';
  if (n >= BIAS_POS) return 'bull';
  if (n <= BIAS_NEG) return 'bear';
  return 'neutral';
}
function kindOf(n) {
  if (n.isCompany) return 'company';
  if (n.category || (n.importance || 0) >= 55 || n.alert) return 'policy';
  return 'other';
}
/* analysis.js 的 sentimentHits 是 [{w:'大涨',v:2.2},…]；转成「词 (valence)」便于前端逐条追溯方向 */
function fmtHits(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 5).map(h => {
    if (h && typeof h === 'object') {
      const w = s(h.w || '', 24);
      const v = Number(h.v);
      if (!w) return '';
      return s(w + (Number.isFinite(v) ? ' (' + (v > 0 ? '+' : '') + v + ')' : ''), 44);
    }
    return s(h, 44);
  }).filter(Boolean);
}
function blankBucket() { return { bull: 0, bear: 0, neutral: 0, total: 0 }; }
function pctBucket(b) {
  const t = b.total || 0;
  return {
    total: t,
    counts: { bull: b.bull, bear: b.bear, neutral: b.neutral },
    pct: {
      bull: t ? +(b.bull / t * 100).toFixed(1) : 0,
      bear: t ? +(b.bear / t * 100).toFixed(1) : 0,
      neutral: t ? +(b.neutral / t * 100).toFixed(1) : 0
    }
  };
}

function s(v, n) { return String(v == null ? '' : v).slice(0, n == null ? 10000 : n); }
/* 部分 RSS 摘要自带 HTML（如 <a href=...>），前端转义后会显示成标签文本；
   且上游常把标签截断成没有闭合 > 的残片，故正则不强制要求闭合 */
function cleanText(v, n) {
  const t = String(v == null ? '' : v)
    // 只清 HTML 标签 / 上游截断的无闭合标签残片，保留英文原文里的比较符（如 "GDP < 2%"）与标点，
    // 避免为了排版安全把英文内容本身一起抹掉。
    .replace(/<\/?[a-zA-Z][^>]*>?/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ').trim();
  return t.slice(0, n == null ? 10000 : n);
}
function bjDayOf(ts) { return new Date(Number(ts) + 8 * 3600e3).toISOString().slice(0, 10); }
function bjNow() { return new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); }

/** 新闻条目的时点：优先 publishedText，其次 publishedAt（毫秒），都无则标注未注明 */
function timeOf(n) {
  const raw = n.publishedText || n.pubDate || n.time;
  if (raw && /^\d{4}-\d{2}-\d{2}[ T]/.test(String(raw))) return String(raw).slice(0, 19).replace('T', ' ');
  if (n.publishedAt) return new Date(Number(n.publishedAt) + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
  return raw ? String(raw).slice(0, 40) : '时点未注明';
}
function dayOf(n) {
  const raw = n.publishedText || n.pubDate || n.time;
  if (raw && /^\d{4}-\d{2}-\d{2}/.test(String(raw))) return String(raw).slice(0, 10);
  if (n.publishedAt) return bjDayOf(n.publishedAt);
  return null;
}
function polImp(n) { return (n && (n.policyImportance != null ? n.policyImportance : n.importance)) || 0; }

function hintSectors(title, desc, titleZh) {
  const t = s(title || '') + ' ' + s(titleZh || '') + ' ' + s(desc || '');
  const out = [];
  for (const [name, re] of SECTOR_HINTS) if (re.test(t)) out.push(name);
  for (const [name, re] of SECTOR_HINTS_EN) if (re.test(t) && out.indexOf(name) < 0) out.push(name);
  return out.slice(0, 4);
}

/* ---------- 新闻 → 真实股市板块（东财行业板块，带 BK 代码） ----------
 * 与 hintSectors 的区别：这里返回的是系统真实行情数据里的「可交易板块」，不是主题词。
 * 一条新闻可同时命中多个板块（最多 4 个），命中依据（关键词）随新闻留存，便于逐条追溯。
 * titleZh 为系统已有的中文译文，只用于补中文板块命中；事实与原文展示仍以英文原文为准。
 */
function boardHits(title, desc, titleZh) {
  const t = s(title || '') + ' ' + s(titleZh || '');
  // desc 常带「（证券时报）」「(路透)」等来源署名，不清洗会把「证券」误命中成券商板块
  const d = cleanText(desc || '', 320).replace(/[（(][^）)]{2,20}[）)]\s*$/g, '');
  const text = t + ' ' + d;
  const byCode = new Map();
  for (const [name, code, category, re] of BOARD_DEFS) {
    if (re.test(text)) byCode.set(code, { name, code, category });
  }
  // 英文短语补充命中（仅当该板块尚未由中文命中，避免重复）
  const defByCode = new Map(BOARD_DEFS.map(x => [x[1], { name: x[0], code: x[1], category: x[2] }]));
  for (const [code, re] of BOARD_EN) {
    if (!byCode.has(code) && re.test(text)) {
      const def = defByCode.get(code);
      if (def) byCode.set(code, def);
    }
  }
  return Array.from(byCode.values()).slice(0, 4);
}
/** 新闻时点 → 毫秒时间戳（time 为北京时间 "YYYY-MM-DD HH:mm:ss"） */
function tsOf(n) {
  const t = String(n.time || '');
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(t)) {
    const v = Date.parse(t.slice(0, 19).replace('T', ' ').replace(' ', 'T') + '+08:00');
    if (Number.isFinite(v)) return v;
  }
  return null;
}
/** 时间衰减：半衰期 18 小时（调研：新闻情绪信号 48h 内衰减，短期窗口有效） */
function decayWeight(n, nowMs, halfLifeHours) {
  const ts = tsOf(n);
  if (ts == null) return 0.5;                       // 时点缺失：保守权重，不夸大
  const ageH = Math.max(0, (nowMs - ts) / 3600e3);
  return Math.pow(0.5, ageH / halfLifeHours);
}

/** 把内存新闻条目归一化成前端友好的结构（字段全部来自真实数据）
 *  英文消息：title / desc 保留英文原文（不被译文替换、不因清洗丢失），
 *            另附 titleZh / descZh 中文译文供对照，lang / isEn 供前端标注与分析覆盖统计。 */
function normNews(n, i) {
  const rawDesc = n.desc || n.summary || '';
  const title = s(n.title || n.headline || '（无标题）', 300);
  const desc = cleanText(rawDesc, 600);
  const isEn = isEnglishNews({ lang: n.lang, title, desc: rawDesc });
  const titleZh = n.lang === 'zh' ? '' : s(n.titleZh || '', 300);
  const descZh = n.lang === 'zh' ? '' : cleanText(n.descZh || '', 600);
  return {
    id: s(n.id || n.link || ('nf-' + i), 200),
    title,
    desc,
    lang: s(n.lang || (isEn ? 'en' : 'zh'), 8),
    isEn,
    titleZh: titleZh || null,
    descZh: descZh || null,
    translation: s(n.translation || '', 20),
    source: s(n.source || n.feed || '来源未注明', 80),
    time: timeOf(n),
    day: dayOf(n),
    category: s(n.category || '', 40),
    importance: polImp(n),
    alert: !!n.policyAlert,
    link: n.link ? s(n.link, 400) : null,
    topics: Array.isArray(n.topics) ? n.topics.map(t => s(t.label || t.id || t, 30)).slice(0, 6) : [],
    sentiment: n.sentiment == null ? null : (Number(n.sentiment) || 0),
    sentimentLabel: s(n.sentimentLabel || '', 20),
    sentimentHits: fmtHits(n.sentimentHits),
    bias: biasOf(n.sentiment),
    isCompany: COMPANY_KW.test(title),
    sectors: hintSectors(title, desc, titleZh),
    boards: boardHits(title, rawDesc, titleZh)
  };
}

/**
 * 聚合一次新闻快讯快照。
 * @param {{news?:object, pulse?:object, futureReport?:object}} ctx
 */
function build(ctx) {
  const news = (ctx && ctx.news) || {};
  const pulse = (ctx && ctx.pulse) || {};
  const rep = (ctx && ctx.futureReport) || {};
  const realBoards = (ctx && ctx.realBoards) || [];
  const items = Array.isArray(news.items) ? news.items : [];
  const today = bjDayOf(Date.now());

  const all = items.map(normNews);
  const todayList = all.filter(n => n.day === today);
  // 排名用「今日新闻池全量」而非仅展示的 80 条：消息收集更完整，时间衰减自动压低旧闻权重
  const rankSource = todayList.length ? todayList : all;
  // 今日无新闻时（例如盘后 / 源延迟）如实回退为「最近一批」，并在前端标注，不冒充今日
  const feedSource = todayList.length ? todayList : all.slice(0, 60);
  const feed = feedSource
    .slice()
    .sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')) || (b.importance || 0) - (a.importance || 0))
    .slice(0, 80);

  const policyNews = (Array.isArray(pulse.policyNews) ? pulse.policyNews : []).slice(0, 40).map(p => ({
    id: s(p.id || p.title, 200), title: s(p.title, 300), desc: cleanText(p.desc, 600),
    time: s(p.time, 40) || '时点未注明', source: s(p.source, 80), link: p.link ? s(p.link, 400) : null,
    importance: p.importance || 0, category: s(p.category, 40), alert: !!p.alert, reason: s(p.reason, 200)
  }));

  const reviewQueue = (Array.isArray(rep.reviewQueue) ? rep.reviewQueue : []).slice(0, 60).map(x => ({
    date: s(x.date, 20), title: s(x.title, 300), source: s(x.source, 80),
    reason: s(x.reason, 200), dateBasis: s(x.dateBasis, 80), isCompany: COMPANY_KW.test(s(x.title))
  }));

  const companyClues = reviewQueue.filter(x => x.isCompany).concat(
    feed.filter(n => n.isCompany).slice(0, 30).map(n => ({
      date: n.day || '--', title: n.title, source: n.source,
      reason: '新闻池公司公告线索', dateBasis: n.time || '时点未注明', isCompany: true
    }))
  ).slice(0, 60);

  const sectors = (Array.isArray(pulse.sectors) ? pulse.sectors : []).slice(0, 20).map(b => ({
    sector: s(b.sector, 30), score: b.score || 0, count: b.count || 0,
    direction: s(b.direction, 20), themes: (b.themes || []).slice(0, 6).map(s), note: s(b.note, 200)
  }));

  const feedHealth = pulse.feedHealth || news.feedHealth || {};
  const headlines = (Array.isArray(pulse.headlines) ? pulse.headlines : []).slice(0, 12);

  return {
    ok: true,
    at: bjNow(),
    today,
    newsFetchedAt: news.fetchedAt || null,
    analysisAt: pulse.analysisAt || null,
    pulseAt: pulse.at || null,
    scannedAt: rep.generatedAt || rep.scannedAt || null,
    coverage: rep.coverage || {},
    stats: {
      pool: all.length,
      today: todayList.length,
      shown: feed.length,
      en: all.filter(n => n.isEn).length,
      enShown: feed.filter(n => n.isEn).length,
      rankPool: rankSource.length,
      policy: policyNews.length,
      company: companyClues.length,
      review: reviewQueue.length,
      sources: Object.keys(feedHealth).length
    },
    bias: buildBias(feed),
    boardRank: buildBoardRank(rankSource, realBoards, { trackRank: !ctx || ctx.trackRank !== false }),
    feedHealth,
    sectors,
    headlines,
    policyNews,
    feed,
    reviewQueue,
    companyClues,
    fallbackToLatest: todayList.length === 0,
    disclaimer: '新闻标题 / 来源 / 时点均来自系统真实抓取结果；板块映射为关键词近似；消息面评分为新闻情绪方向分，非涨跌预测，不构成买卖建议。'
  };
}

/* ==================== 智能体解读 ==================== */

const OUT_RULES = [
  '【输出形式 · 必须严格遵守：只写结构化文字叙述】',
  '- 固定段标题为骨架，段内用 `- ` 列表组织；关键结论用 `**加粗**`；引用事实时写清来源与时点。',
  '- 不要输出表格、图表、代码块、ASCII 图示、KPI 卡片、emoji；不要加独立的开篇段或结尾免责声明段。',
  '- 区分「新闻事实」「程序计算」「本次推测」三层，凡推测必须标注并给证伪条件。'
].join('\n');

const HARD_RULES = [
  '【硬约束 · 违反即为不合格】',
  '1. 金额、数量、百分比、日期只能逐字引用上面给出的新闻原文或程序数据；不得改写、不得自行计算新数字、不得给「估算值」。',
  '2. 个股代码与名称只能逐字引用【本次新闻关联标的】清单；不得新增、不得改写、不得编造；清单为空或标注「无对应 A 股标的」时必须如实写明，全文不得出现任何 6 位股票代码或具体个股名称。',
  '3. 板块归类为关键词近似映射，必须显式说明是近似，不得冒充官方行业分类或真实持仓。',
  '4. 「观察」是条件化研究观点，不是买卖指令；不预测涨跌必然性、不承诺收益、不冒充真实成交。',
  '5. 带「⚠ 风险规避池」「⚠ 双池重叠」的标的必须显式提示风险与冲突，不得只讲机会。',
  '6. 不得把公司回购 / 停复牌等个股公告直接说成板块普涨依据；不得把新闻情绪分说成涨跌预测。',
  '7. 红涨绿跌遵循 A 股习惯；不修改任何评分、不替用户下单。',
  '8. 英文新闻（标 [EN]）一律以英文原文为事实依据，中文译文只是辅助理解；引用标题 / 主体 / 数字时必须逐字引用原文，不得据译文改写、扩写或补写，也不得把外媒地缘 / 社会新闻硬映射成 A 股板块利多利空。'
].join('\n');

function itemBlock(item) {
  const en = !!(item.isEn || item.lang === 'en');
  return [
    '【新闻原文（系统真实抓取，逐字使用，禁止扩写或补写事实）】' + (en ? ' [EN 英文消息：原文为准]' : ''),
    '- 标题：' + s(item.title || '未提供', 300),
    '- 摘要：' + s(item.desc || '未提供（不要臆测具体内容）', 600),
    '- 来源：' + s(item.source || '未注明', 80),
    '- 时点：' + s(item.time || '时点未注明', 40),
    '- 分类 / 标签：' + s([item.category, (item.topics || []).join('、')].filter(Boolean).join(' · ') || '未提供', 120),
    '- 政策重要性分：' + (item.importance || 0) + '（程序按政策关键词计算，非涨跌预测）',
    (item.titleZh ? '- 中文译文（仅辅助理解，事实以英文原文为准）：' + s(item.titleZh, 300) : ''),
    (item.descZh ? '- 摘要中译（仅辅助理解）：' + s(item.descZh, 600) : ''),
    (item.sentiment == null ? '' : '- 程序情感分：' + item.sentiment + '（' + s(item.sentimentLabel || '', 20) +
      '）· 命中词：' + ((item.sentimentHits || []).join('、') || '无')),
    ((item.boards && item.boards.length) ? '- 近似映射的真实股市板块：' + item.boards.map(b => b.name + '(' + b.code + ')').join('、') : '')
  ].filter(Boolean).join('\n');
}

/** 单条新闻解读
 * 命中「官方 / 政府指数发布」事件时，注入 macro-outlook 的机构预期 +
 * 跨资产 + 多数方向快照，并把标题骨架扩为七段；程序事实随响应恒返回。 */
async function interpretOne(cfg, hermes, item, relatedStocks, flash) {
  const it = item || {};
  const sectors = Array.isArray(it.sectors) && it.sectors.length
    ? it.sectors : hintSectors(it.title, it.desc, it.titleZh);
  const rel = typeof relatedStocks === 'function' ? relatedStocks(sectors) : { block: '（关联标的清单不可用）', count: 0, anyMatch: false };
  const macro = macroOutlook.build(it, { newsPool: (flash && Array.isArray(flash.feed)) ? flash.feed : [] });
  const isMacro = !!macro.detected;

  const q = [
    itemBlock(it),
    '',
    '【本次新闻关联标的（系统真实数据，逐字引用，禁止新增）】',
    rel.block,
    '',
    ...(isMacro ? [macroOutlook.promptBlock(macro), ''] : []),
    '【任务】基于上面的新闻原文、关联标的清单与系统注入的全局数据快照' +
      (isMacro ? '、以及【官方指数发布事件 · 程序注入的机构预期与跨资产快照】' : '') + '，写一份单条新闻解读。',
    '若本条标注 [EN]：事实一律以英文原文为准，中文译文仅辅助理解，不得据译文改写或扩写；外媒地缘 / 社会类新闻若无明确 A 股板块链条，须如实写「无对应 A 股板块」，不得硬凑。',
    '',
    OUT_RULES,
    ...(isMacro ? ['【本次输出形式补充】第七段内逐字引用注入的免责声明文案（放在该段末尾，不另起独立开篇或结尾段）；其余仍遵守上面的输出形式规则。'] : []),
    '- 标题骨架（顺序和文字都不要改）：',
    '## 一、这条消息说了什么',
    '## 二、可能影响哪些板块（机制链条）',
    '## 三、板块与个股观察',
    '## 四、本次怎么看（推测与证伪条件）',
    ...(isMacro ? [
      '## 五、机构与专家预测（官方指数发布增强）',
      '## 六、美股 / A股板块 / 期货与黄金影响',
      '## 七、多数预测方向建议'
    ] : []),
    isMacro
      ? '在第七段末尾另起一行写：`依据：新闻原文(来源/时点) · 机构预期快照(快照时点) · 全局数据快照(快照时点) · 关联标的清单(生成时点)`。'
      : '在第四段末尾另起一行写：`依据：新闻原文(来源/时点) · 全局数据快照(快照时点) · 关联标的清单(生成时点)`。',
    '',
    '【各段内容要求】',
    '一：用 2-3 句复述新闻里明确写出的事实（谁、做了什么、金额/数量/日期），点名原文里的公司或政策主体；原文没写的不要补。',
    '二：说明「消息 → 预期 → 板块」的因果机制链条；若属公司公告类（回购 / 停复牌 / 增减持等），必须说明它主要是公司层面信号还是行业层面信号，不要硬放大成板块行情。',
    '三：逐个点名上面「近似映射」出的相关板块，各写 1 条条件化观察方向（偏正面 / 偏谨慎 / 中性观察三选一）并写明依据来自新闻原文、全局快照还是关联标的清单；个股只能逐字引用清单里的 `代码 名称`，写清入选来源、为什么值得观察以及「出现什么信号就说明不成立」的证伪条件。',
    '四：结合当前快照给 1 条明确推测（标注「推测」）、1-2 条可证伪条件，并提示「预期兑现」风险与新闻时点 / 口径不确定性。',
    ...(isMacro ? [
      '五：逐条点名【机构与专家预测清单】里的机构与观点（禁止新增机构、禁止改写数字、禁止自行计算新数值），写明各自来源与时点并标注「需核实原文」；明确区分「已公布的官方事实」「机构预测」「程序计算」三层；点名共识归纳与分歧点；若快照标为陈旧或该事件无覆盖，必须如实写明，不得当作当前观点。',
      '六：按「美股（指数与板块）」「A 股各板块」「期货」「黄金」四组分别写。每组先逐字引用注入的真实机构 / 媒体观点，再用「宏观变量 → 中间变量 → 资产」写 1–2 条条件性传导链并显式标注这是分析框架、不是事实、不是涨跌预测；A 股必须逐个说明机制链条与一阶 / 二阶差异，不得把所有板块都写成受益；每组末尾写 1 条失效条件。',
      '七：只按【多数方向统计】与【多数预测方向建议】写。有多数时写清「N 条中 M 条」、方向性参考、依据机构、失效条件与反向声音；无明确多数或样本不足时，如实写「机构分歧 / 样本不足，不给单向建议」并给条件化观察框架。免责声明必须逐字引用注入文案，不得改写、缩减或省略；全文不得出现买卖指令、目标价或仓位建议。'
    ] : []),
    '',
    HARD_RULES
  ].join('\n');

  const r = await hermes.ask(cfg, 'newsflash', q, {
    task: isMacro ? '官方指数发布新闻解读（机构预期 / 跨资产 / 多数方向）' : '单条新闻解读（结构化文字叙述 + 板块与个股观察）',
    maxTokens: isMacro ? 4800 : 1600, temperature: 0.2
  });
  const attach = x => {
    x.historical = null;
    x.related = { themes: rel.themes || [], count: rel.count || 0, anyMatch: !!rel.anyMatch, industries: rel.industries || [] };
    x.sectors = sectors;
    x.macro = macro;                 // 程序事实恒返回：智能体失败 / 未配置时前端仍可结构化展示
    x.itemTitle = s(it.title, 120);
    if (x.ok) x.promptVersion = isMacro ? 'news-flash-v2-macro' : 'news-flash-v1';
    /* 合规兜底：方向建议必须带完整免责声明；模型输出被截断时由程序补原文，不改写文案 */
    if (isMacro && x.ok && typeof x.text === 'string' && macro.advice && macro.advice.disclaimer &&
        !x.text.includes(macro.advice.disclaimer)) {
      x.text = x.text.replace(/\s+$/, '') + '\n\n' + macro.advice.disclaimer;
      x.disclaimerAppended = true;
    }
    return x;
  };
  return attach(r || { ok: false, error: '智能体未返回结果' });
}

/** 今日新闻整体解读（若今日清单命中官方指数发布事件，追加机构预期 / 跨资产 / 多数方向段） */
async function interpretDaily(cfg, hermes, flash, relatedStocks) {
  const f = flash || {};
  const list = (Array.isArray(f.feed) ? f.feed : []).slice(0, 40);
  const lines = list.map((n, i) =>
    (i + 1) + '. [' + s(n.time, 19) + ']' + (n.isEn ? ' [EN 英文原文]' : '') + ' ' + s(n.title, 200) +
    (n.titleZh ? ' ｜中译（仅辅助）：' + s(n.titleZh, 120) : '') +
    '（' + s(n.source, 40) + '）' +
    (n.desc ? ' — ' + s(n.desc, 90) : '')
  );
  const sectorLines = (f.sectors || []).slice(0, 12).map(b =>
    '- ' + s(b.sector, 20) + '：' + s(b.direction, 20) + ' · 新闻情绪分 ' + (b.score > 0 ? '+' : '') + (b.score || 0) +
    ' · 相关新闻 ' + (b.count || 0) + ' 条（' + (b.themes || []).slice(0, 3).join('、') + '）'
  );
  const policyLines = (f.policyNews || []).slice(0, 8).map(p =>
    '- [' + s(p.time, 19) + '] ' + s(p.title, 130) + '（' + s(p.source, 40) + '，重要性 ' + (p.importance || 0) + '）'
  );
  const companyLines = (f.companyClues || []).slice(0, 10).map(c =>
    '- ' + s(c.title, 130) + '（' + s(c.source, 40) + '）'
  );
  const macroItem = list.find(n => macroOutlook.detectEvent(n).matched) || null;
  const macro = macroItem ? macroOutlook.build(macroItem, { newsPool: list }) : null;
  const isMacro = !!(macro && macro.detected);

  const hotSectors = (f.sectors || []).slice().sort((a, b) => Math.abs(b.score || 0) - Math.abs(a.score || 0)).slice(0, 6).map(b => b.sector);
  const rel = typeof relatedStocks === 'function' ? relatedStocks(hotSectors) : { block: '（关联标的清单不可用）', count: 0, anyMatch: false };

  const q = [
    '【今日新闻清单（系统真实抓取，逐字使用，禁止扩写）】',
    '统计口径：北京时间 ' + s(f.today, 10) + ' · 本次共 ' + ((f.stats && f.stats.shown) || list.length) + ' 条进入解读（新闻池 ' +
      ((f.stats && f.stats.pool) || 0) + ' 条，今日 ' + ((f.stats && f.stats.today) || 0) + ' 条）' +
      ' · 其中英文原文消息 ' + ((f.stats && f.stats.enShown) || 0) + ' 条（标 [EN]，事实以英文原文为准，中译仅辅助理解）' +
    (f.fallbackToLatest ? ' · 注意：今日暂无带日期的新闻，以下为最近一批，禁止称为「今日全部」' : ''),
    lines.length ? lines.join('\n') : '（今日无新闻，请如实写明「当前无新闻数据」，不得编造任何事件）',
    '',
    '【程序计算的板块消息面（news-pulse，方向分为新闻情绪方向分，非涨跌预测）】',
    sectorLines.length ? sectorLines.join('\n') : '（当前无板块消息面数据）',
    '',
    '【政策快讯摘要（程序按政策关键词筛选）】',
    policyLines.length ? policyLines.join('\n') : '（当前无政策快讯）',
    '',
    '【公司公告线索（回购 / 停复牌 / 增减持等，来自待复核队列与新闻池）】',
    companyLines.length ? companyLines.join('\n') : '（当前无公司公告线索）',
    '',
    '【本次新闻关联标的（系统真实数据，逐字引用，禁止新增）】',
    rel.block,
    '',
    ...(isMacro ? [macroOutlook.promptBlock(macro), ''] : []),
    '【任务】基于上面的今日新闻清单、程序统计、关联标的清单与系统注入的全局数据快照' +
      (isMacro ? '、以及【官方指数发布事件 · 程序注入的机构预期与跨资产快照】' : '') + '，写一份「今日新闻整体解读」。',
    '清单含大量 [EN] 英文原文消息：引用标题 / 主体 / 数字时必须逐字引用英文原文，中文译文只辅助理解；外媒地缘 / 社会新闻若无明确 A 股映射链条，不得硬凑成板块利多利空。',
    '',
    OUT_RULES,
    ...(isMacro ? ['【本次输出形式补充】第六段内逐字引用注入的免责声明文案（放在该段末尾，不另起独立开篇或结尾段）；其余仍遵守上面的输出形式规则。'] : []),
    '- 标题骨架（顺序和文字都不要改）：',
    '## 一、今日消息面总览',
    '## 二、主要线索与因果链条',
    '## 三、分板块方向判断',
    '## 四、值得跟踪的标的线索',
    '## 五、风险与证伪条件',
    ...(isMacro ? ['## 六、官方指数发布事件：机构预期 / 跨资产 / 多数方向'] : []),
    isMacro
      ? '在第六段末尾另起一行写：`依据：今日新闻清单(抓取时点) · 机构预期快照(快照时点) · 消息面脉冲(生成时点) · 全局数据快照(快照时点) · 关联标的清单(生成时点)`。'
      : '在第五段末尾另起一行写：`依据：今日新闻清单(抓取时点) · 消息面脉冲(生成时点) · 全局数据快照(快照时点) · 关联标的清单(生成时点)`。',
    '',
    '【各段内容要求】',
    '一：用 3-4 句概括今天新闻的主线与密度，点名最重要的 2-3 条（逐字引用标题），并写明清单里的真实条数；不要夸大覆盖面。',
    '二：把主线拆成 2-3 条因果链条（消息 → 预期 → 板块），每条必须引用支撑它的新闻标题；公司公告类线索单独说明其公司层面属性。',
    '三：逐个点名【板块消息面】里的板块，各写 1 条方向判断与依据（来自新闻清单还是消息面评分）；必须说明评分是新闻情绪方向分、不是涨跌预测，不得据此外推涨跌。',
    '四：只逐字引用【关联标的】清单里的 `代码 名称`，写清入选来源、为什么值得跟踪与证伪条件；清单为空时如实写明，不得编造。',
    '五：给 2-3 条可证伪条件，提示「预期兑现」、新闻源时点不一致、低样本与口径限制；明确区分事实 / 计算 / 推测。',
    ...(isMacro ? [
      '六：只针对今日清单里命中的官方指数发布事件写。分三层：① 逐条点名注入清单里的机构与专家预测（禁止新增机构 / 数字，标注来源、时点与「需核实原文」）并写明共识与分歧；② 按美股 / A 股各板块 / 期货 / 黄金四组，先逐字引用真实机构或媒体观点，再用「宏观变量 → 中间变量 → 资产」写条件性传导链，显式标注为分析框架而非涨跌预测，A 股不得把所有板块写成受益；③ 按【多数方向统计】写方向性参考，无多数或样本不足时如实写「分歧 / 样本不足，不给单向建议」，附失效条件、反向声音，并逐字引用注入的免责声明，不得写成买卖指令或目标价。'
    ] : []),
    '',
    HARD_RULES
  ].join('\n');

  const r = await hermes.ask(cfg, 'newsflash', q, {
    task: isMacro ? '今日新闻整体解读（含官方指数发布机构预期增强）' : '今日新闻整体解读（结构化文字叙述 + 板块与个股观察）',
    maxTokens: isMacro ? 5200 : 2400, temperature: 0.2
  });
  const attach = x => {
    x.related = { themes: rel.themes || [], count: rel.count || 0, anyMatch: !!rel.anyMatch, industries: rel.industries || [] };
    x.newsCount = list.length;
    x.fallbackToLatest = !!f.fallbackToLatest;
    x.macro = macro;                // 程序事实恒返回
    if (x.ok) x.promptVersion = isMacro ? 'news-daily-v2-macro' : 'news-daily-v1';
    if (isMacro && x.ok && typeof x.text === 'string' && macro && macro.advice && macro.advice.disclaimer &&
        !x.text.includes(macro.advice.disclaimer)) {
      x.text = x.text.replace(/\s+$/, '') + '\n\n' + macro.advice.disclaimer;
      x.disclaimerAppended = true;
    }
    return x;
  };
  return attach(r || { ok: false, error: '智能体未返回结果' });
}

/* ==================== 消息面初评聚合 ==================== */

function sampleOf(n) {
  return {
    title: s(n.title, 220), titleZh: s(n.titleZh || '', 220) || null,
    source: s(n.source, 60), time: s(n.time, 30), isEn: !!n.isEn,
    sentiment: n.sentiment, label: s(n.sentimentLabel, 20),
    hits: (n.sentimentHits || []).slice(0, 4), kind: kindOf(n)
  };
}

/**
 * 只做聚合与占比，不重新打分、不调用大模型。
 * 返回结构同时服务「右侧辅助栏精简占比条」与「弹窗全部信息」。
 */
function buildBias(feed) {
  const list = Array.isArray(feed) ? feed : [];
  const all = blankBucket();
  const kinds = { policy: blankBucket(), company: blankBucket(), other: blankBucket() };
  // 按「语言」拆分：外媒英文消息是否也被分析，必须有可核查的覆盖数字，不能只报总条数
  const langs = { zh: blankBucket(), en: blankBucket() };
  const srcMap = new Map();
  let sum = 0, scored = 0, unscored = 0, enTotal = 0, enScored = 0, enMapped = 0;
  for (const n of list) {
    const b = biasOf(n.sentiment);
    all[b]++; all.total++;
    // 服务刚重启时分析周期尚未跑完，sentiment 可能缺失；必须与「中性」区分，不能把无数据当成中性
    if (n.sentiment == null) unscored++;
    else { scored++; sum += Number(n.sentiment) || 0; }
    const k = kinds[kindOf(n)] || kinds.other;
    k[b]++; k.total++;
    const lb = langs[n.isEn ? 'en' : 'zh'] || langs.zh;
    lb[b]++; lb.total++;
    if (n.isEn) {
      enTotal++;
      if (n.sentiment != null) enScored++;
      if (Array.isArray(n.boards) && n.boards.length) enMapped++;
    }
    const src = s(n.source || '来源未注明', 60);
    if (!srcMap.has(src)) srcMap.set(src, blankBucket());
    const sb = srcMap.get(src); sb[b]++; sb.total++;
  }
  const overall = pctBucket(all);
  const bySource = Array.from(srcMap.entries())
    .map(([source, b]) => Object.assign({ source }, pctBucket(b)))
    .sort((a, b) => b.total - a.total).slice(0, 10);
  const bull = list.filter(n => biasOf(n.sentiment) === 'bull')
    .sort((a, b) => Number(b.sentiment || 0) - Number(a.sentiment || 0)).slice(0, 6).map(sampleOf);
  const bear = list.filter(n => biasOf(n.sentiment) === 'bear')
    .sort((a, b) => Number(a.sentiment || 0) - Number(b.sentiment || 0)).slice(0, 6).map(sampleOf);
  return {
    version: 'bias-lexicon-v1',
    method: 'server/analysis.js · scoreSentiment（VADER 式金融双语情感词典 + 否定词 / 程度副词修正）',
    basis: '沿用 buildBriefing() 的 counts 分档：sentiment >= 8 正面（利多）、<= -8 负面（利空），其余中性；不重新打分、不调用大模型',
    threshold: { bull: 'sentiment >= 8', bear: 'sentiment <= -8', neutral: '-8 < sentiment < 8' },
    scope: '本次进入「新闻快讯 → 今日新闻流」的新闻条目（feed），非全市场全部新闻',
    total: overall.total,
    counts: overall.counts,
    pct: overall.pct,
    net: overall.counts.bull - overall.counts.bear,
    avgSentiment: overall.total ? Math.round(sum / overall.total) : null,
    byKind: {
      policy: pctBucket(kinds.policy), company: pctBucket(kinds.company), other: pctBucket(kinds.other)
    },
    byLang: { zh: pctBucket(langs.zh), en: pctBucket(langs.en) },
    langCoverage: { en: enTotal, enScored, enMapped, zh: overall.total - enTotal },
    bySource,
    samples: { bull, bear },
    coverage: { scored, unscored, total: overall.total },
    degraded: overall.total > 0 && unscored / overall.total >= 0.5,
    computedAt: bjNow(),
    caveat: '中性包含情感词典未命中的新闻，不等于「无影响」；占比是新闻条数比例，不是涨跌概率、不是资金流向，不构成买卖建议。'
  };
}

/* ==================== 股市板块消息面排名（确定性 · 可复现 · 可追溯） ====================
 * 排名方法（经查证对比后选定）：
 *   1) 不按「新闻条数」排名 —— 那会退化成「曝光度排名」（调研列为首要常见错误）；
 *   2) 不直接用「原始平均分」排名 —— 小样本板块会被 1 条极端新闻绑架到榜首；
 *   3) 不用「回测优化权重」—— 本系统无收益样本可回测，且样本内调权极易过拟合；
 *   4) 采用【贝叶斯收缩 / IMDb 加权评分 WR】+【时间衰减】+【横截面百分位】：
 *        score = (Σwᵢ·sᵢ + m·C) / (Σwᵢ + m)
 *        sᵢ 为该板块内新闻情感分(-100~100)，wᵢ=0.5^(age/半衰期) 为时间衰减权重，
 *        C 为全市场加权先验（本次全部已标注新闻的加权均分），m 为先验强度。
 *      小样本板块被拉向全市场先验，样本越多越接近自身真实均分；避免 1 条 +90 冲榜首。
 *   5) 覆盖度门槛：有效样本 < minEff 的板块只标注「样本不足」，不参与排名、不填 0 伪中性；
 *   6) 横截面比较：对参与排名板块的 score 做 z-score（±3 截断）与百分位，方向分档沿用
 *      bias 口径（>=8 偏多 / <=-8 偏空），但排名主依据是收缩分而非条数或净倾向。
 *   7) 实时：每次 GET /api/v2/news-flash 都基于最新新闻池重算；带 at / computedAt 时间戳，
 *      前端 SSE(news / news-pulse) 触发 loadNewsFlash() 自动刷新排名。
 * 全部复用 analysis.js 已有的 sentiment，不重新打分、不调用大模型；红涨绿跌遵循 A 股习惯。
 */
// minEff / minScored：只要求「至少 1 条真实情感标注」即可参与排名；
// 小样本防绑架由贝叶斯收缩(m=3)负责，不再叠加硬门槛造成双重惩罚
// （原 1.2 + scoredN>=2 会把「2 条 +86 收缩到 23.6」的银行板块误判为样本不足）。
const RANK_PARAMS = { halfLifeHours: 18, priorM: 3, minEff: 0.4, minScored: 1, zCap: 3, companyWeight: 0.6 };
/** 模块内保存上一次排名，用于生成名次变动（上升/下降/新进榜），只影响展示、不影响算法 */
let lastBoardRank = null;

function buildBoardRank(feed, realBoards, opts) {
  const trackRank = !opts || opts.trackRank !== false;
  const raw = Array.isArray(feed) ? feed : [];
  const now = Date.now();
  const P = RANK_PARAMS;

  // 同一新闻被多个源/多次抓取会在标题上重复；不去重会人为放大有效样本、绕过贝叶斯收缩，
  // 把「1 条 +86」刷成「多条 +86」顶到榜首。按规范化标题去重，保留时点最新的一条。
  const normTitle = t => s(t || '').replace(/[\s，。、：；！？,.．·\-—（）()\[\]【】"'“”]/g, '').slice(0, 60);
  const seen = new Map();
  for (const n of raw) {
    const k = normTitle(n.title);
    if (!k) continue;
    const prev = seen.get(k);
    if (!prev || String(n.time || '') > String(prev.time || '')) seen.set(k, n);
  }
  const list = Array.from(seen.values());
  const deduped = raw.length - list.length;

  // 全市场加权先验 C（只用有情感标注的新闻）
  let gW = 0, gWS = 0, scoredNews = 0, unscoredNews = 0;
  for (const n of list) {
    if (n.sentiment == null) { unscoredNews++; continue; }
    scoredNews++;
    const w = decayWeight(n, now, P.halfLifeHours) * (n.isCompany ? P.companyWeight : 1);
    gW += w; gWS += w * Number(n.sentiment);
  }
  // 服务刚重启时分析周期未跑完，sentiment 会整体为 0/null；必须与「真中性」区分，
  // 否则会显示「全部板块 0 分、全中性」的误导性排名。
  // 注意：新闻池里「尚未进入分析窗口的新抓取条目」本来就无标注，属正常状态，不能算降级；
  // 因此降级判定只看【已标注新闻】里是否几乎全为 0，以及是否已标注样本过少。
  const nonZero = list.filter(n => n.sentiment != null && Number(n.sentiment) !== 0).length;
  const degraded = scoredNews < 5 || (scoredNews > 0 && nonZero / scoredNews < 0.15);
  const C = gW ? gWS / gW : 0;

  // 真实股市板块清单（来自 strength-cache / edge.strength.boards）：用于补 chg1 与校验代码
  const realByCode = new Map();
  if (Array.isArray(realBoards)) {
    for (const b of realBoards) {
      const code = s(b.code, 20);
      if (code) realByCode.set(code, b);
    }
  }

  // 按板块聚合
  // 「收集条数 n」与「有效打分样本 eff / scoredN」严格分开：
  // 未标注 sentiment 的新闻只计入收集条数，不进 eff、不计入 bull/neutral/bear，
  // 绝不用 0 分填充成「伪中性」（调研明确列为常见错误）。
  const map = new Map();
  let mappedNews = 0, sentimentMissing = 0;
  for (const n of list) {
    const bs = Array.isArray(n.boards) ? n.boards : [];
    if (!bs.length) continue;
    mappedNews++;
    const scored = n.sentiment != null;
    if (!scored) sentimentMissing++;
    const wBase = decayWeight(n, now, P.halfLifeHours);
    // 公司回购 / 增减持 / 停复牌等属公司层面信号，降权处理，避免个股公告主导板块榜
    const w = wBase * (n.isCompany ? P.companyWeight : 1);
    const bias = scored ? biasOf(n.sentiment) : null;
    for (const b of bs) {
      let cur = map.get(b.code);
      if (!cur) {
        cur = { code: b.code, name: b.name, category: b.category,
          n: 0, scoredN: 0, eff: 0, ws: 0, bull: 0, neutral: 0, bear: 0, unscored: 0,
          samples: [], themes: new Set() };
        map.set(b.code, cur);
      }
      cur.n++;                                   // 收集到的消息条数（含未标注）
      if (scored) {
        cur.scoredN++;
        cur.eff += w;                            // 有效样本只累加已标注新闻
        cur.ws += w * Number(n.sentiment);
        cur[bias]++;
      } else cur.unscored++;
      if (n.topics && n.topics.length) n.topics.slice(0, 2).forEach(t => cur.themes.add(s(t, 20)));
      if (cur.samples.length < 4) {
        cur.samples.push({ title: s(n.title, 220), titleZh: s(n.titleZh || '', 220) || null,
          source: s(n.source, 40), time: s(n.time, 19), isEn: !!n.isEn,
          sentiment: n.sentiment, bias: bias || 'unscored',
          hits: (n.sentimentHits || []).slice(0, 3), isCompany: !!n.isCompany });
      }
    }
  }

  // 贝叶斯收缩分
  const rows = [];
  for (const cur of map.values()) {
    const rawMean = cur.eff ? cur.ws / cur.eff : 0;
    const score = (cur.ws + P.priorM * C) / (cur.eff + P.priorM);
    const real = realByCode.get(cur.code);
    // 代表样本：按情感分绝对值降序（未标注排最后），利多/利空各留最典型的
    const absSent = x => x.sentiment == null ? -1 : Math.abs(Number(x.sentiment) || 0);
    const samples = cur.samples.slice().sort((a, b) => absSent(b) - absSent(a)).slice(0, 3);
    rows.push({
      code: cur.code, name: cur.name, category: cur.category,
      n: cur.n, scoredN: cur.scoredN, unscored: cur.unscored, eff: +cur.eff.toFixed(2),
      bull: cur.bull, neutral: cur.neutral, bear: cur.bear,
      net: cur.bull - cur.bear,
      rawMean: +rawMean.toFixed(1),
      score: +score.toFixed(1),
      chg1: real && Number.isFinite(Number(real.chg1)) ? +Number(real.chg1).toFixed(2) : null,
      chg5: real && Number.isFinite(Number(real.chg5)) ? +Number(real.chg5).toFixed(2) : null,
      realName: real ? s(real.name, 30) : null,
      themes: Array.from(cur.themes).slice(0, 4),
      samples,
      eligible: cur.scoredN >= P.minScored && cur.eff >= P.minEff
    });
  }

  // 横截面标准化：只对合格板块做 z-score 与百分位
  const eligible = rows.filter(r => r.eligible).slice().sort((a, b) => b.score - a.score);
  const scores = eligible.map(r => r.score);
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const variance = scores.length ? scores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / scores.length : 0;
  const sd = Math.sqrt(variance) || 1;
  const rankOf = new Map();
  eligible.forEach((r, i) => {
    const z = Math.max(-P.zCap, Math.min(P.zCap, (r.score - mean) / sd));
    r.z = +z.toFixed(2);
    // 百分位：严格小于占比 + 并列半权，映射到 0~100
    const less = scores.filter(v => v < r.score).length;
    const equal = scores.filter(v => v === r.score).length;
    r.pct = scores.length > 1 ? +(((less + (equal - 1) / 2) / (scores.length - 1)) * 100).toFixed(1) : 100;
    r.rank = i + 1;
    r.direction = r.score >= 8 ? '偏多' : r.score <= -8 ? '偏空' : '中性';
    rankOf.set(r.code, i + 1);
  });
  // 不合格板块：不参与排名，排名为空，标注样本不足
  const insufficient = rows.filter(r => !r.eligible)
    .sort((a, b) => b.n - a.n)
    .map(r => { r.rank = null; r.z = null; r.pct = null; r.direction = '样本不足'; return r; });

  // 名次变动（对比上一次本接口快照）
  const prev = lastBoardRank || new Map();
  eligible.forEach(r => {
    const p = prev.get(r.code);
    r.move = p == null ? 'new' : (p > r.rank ? 'up' : p < r.rank ? 'down' : 'flat');
    r.moveBy = p == null ? null : Math.abs(p - r.rank);
  });
  if (trackRank) lastBoardRank = rankOf;

  const bullTop = eligible.filter(r => r.score >= 8).slice(0, 8);
  const bearTop = eligible.filter(r => r.score <= -8).slice().reverse().slice(0, 8);

  return {
    version: 'board-rank-v1',
    method: '贝叶斯收缩(IMDb WR) + 时间衰减 + 横截面 z-score/百分位',
    formula: 'score = (Σ wᵢ·sᵢ + m·C) / (Σ wᵢ + m)，wᵢ = 0.5^(时距/半衰期)',
    basis: 'sᵢ 复用 server/analysis.js·scoreSentiment 的真实情感分(-100~100)；C=全市场加权先验；m=先验强度；半衰期 18h；公司公告类消息按 0.6 权重降权(公司层面信号不主导板块榜)；重复标题去重',
    why: '不用「新闻条数」(会变成曝光度排名)、不用「原始均分」(小样本被单条极端绑架)、不用回测寻权(无收益样本且易过拟合)；收缩使小样本回归先验、时间衰减使排名对最新消息敏感、横截面标准化使板块可比',
    params: { halfLifeHours: P.halfLifeHours, priorM: P.priorM, minEff: P.minEff, minScored: P.minScored,
      zCap: P.zCap, companyWeight: P.companyWeight, priorC: +C.toFixed(1),
      crossMean: +mean.toFixed(1), crossSd: +sd.toFixed(1) },
    scope: '本次「今日新闻池全量」条目（非仅展示的 80 条），按关键词近似映射到系统真实东财行业板块(BK 代码)；旧闻由时间衰减自动降权',
    totalNews: list.length,
    rawNews: raw.length,
    deduped,
    degraded,
    coverage: { scored: scoredNews, unscored: unscoredNews, nonZero, total: list.length },
    mappedNews,
    unmappedNews: list.length - mappedNews,
    sentimentMissing,
    boardDefs: BOARD_DEFS.length,
    realBoardCatalog: realByCode.size,
    rankedCount: eligible.length,
    insufficientCount: insufficient.length,
    ranking: eligible,
    insufficient,
    bullTop,
    bearTop,
    computedAt: bjNow(),
    caveat: '板块为关键词近似映射，非官方行业分类或真实持仓；已按标题去重，避免重复抓取放大有效样本；score 为新闻情绪方向分(已做小样本收缩与时间衰减)，不是涨跌预测、不是资金流向；未进入分析窗口、尚无情感标注的新闻只计入「收集条数」、不参与打分，不以 0 分填充伪中性；小样本板块由贝叶斯收缩压向全市场先验，而非直接排除；公司回购 / 增减持等个股公告属公司层面信号，按 0.6 降权，不能作为板块普涨依据；完全无真实标注的板块标「样本不足」不参与排名；chg1/chg5 为系统真实行情同期涨跌幅，仅作消息面与价格的对照，不构成因果结论。'
  };
}

/* ==================== 按需智能体复核（不改写任何程序数字） ==================== */

const BIAS_RULES = [
  '【硬约束 · 违反即为不合格】',
  '1. 上面给出的利多 / 中性 / 利空条数与百分比是程序确定性计算结果，禁止改写、禁止重新计算、禁止给出任何新的比例或百分比。',
  '2. 新闻标题、来源、时点、情感分与命中词只能逐字引用上面给出的清单，禁止编造或补写新闻事实。',
  '3. 本次不提供关联标的清单，全文不得出现任何 6 位股票代码或具体个股名称，不给买卖指令、不预测涨跌。',
  '4. 明确区分「程序计算」与「本次复核推测」；凡推测必须标注并给证伪条件。',
  '5. 不得把消息面占比说成涨跌概率、资金流向或板块普涨依据；公司回购 / 停复牌属个股事件，须单独说明。',
  '6. 红涨绿跌遵循 A 股习惯；不修改任何评分、不替用户下单。',
  '7. 标 [EN] 的英文消息以英文原文为事实依据，中文译文仅辅助理解；不得据译文改写标题或补写事实，不得把外媒地缘 / 社会新闻硬映射成 A 股板块方向。'
].join('\n');

async function interpretBias(cfg, hermes, flash) {
  const f = flash || {}, b = f.bias || {};
  const c = b.counts || {}, p = b.pct || {};
  const lines = (arr) => (arr || []).map((x, i) =>
    (i + 1) + '. [' + s(x.time, 19) + ']' + (x.isEn ? ' [EN 英文原文]' : '') + ' ' + s(x.title, 200) +
    (x.titleZh ? '（中译：' + s(x.titleZh, 120) + '）' : '') +
    '（来源：' + s(x.source, 40) + ' · 情感分 ' + x.sentiment + ' · ' + s(x.label, 12) +
    ' · 命中词：' + ((x.hits || []).join('、') || '无') + '）'
  );
  const kindLines = Object.keys(b.byKind || {}).map(k => {
    const v = b.byKind[k];
    const name = { policy: '政策', company: '公司公告', other: '其他' }[k] || k;
    return '- ' + name + '：共 ' + v.total + ' 条 · 利多 ' + v.counts.bull + '（' + v.pct.bull + '%）/ 中性 ' +
      v.counts.neutral + '（' + v.pct.neutral + '%）/ 利空 ' + v.counts.bear + '（' + v.pct.bear + '%）';
  });
  const q = [
    '【程序确定性初评结果（只可引用、不可改写）】',
    '- 口径：' + s(b.method, 200),
    '- 分档依据：' + s(b.basis, 220),
    '- 统计范围：' + s(b.scope, 120) + '；共 ' + (b.total || 0) + ' 条',
    '- 利多 ' + (c.bull || 0) + ' 条（' + (p.bull || 0) + '%）· 中性 ' + (c.neutral || 0) + ' 条（' + (p.neutral || 0) + '%）· 利空 ' + (c.bear || 0) + ' 条（' + (p.bear || 0) + '%）',
    '- 净倾向（利多 − 利空）：' + (b.net || 0) + ' 条；平均情感分：' + (b.avgSentiment == null ? '无数据' : b.avgSentiment),
    (b.degraded
      ? '- 注意：本次情感标注覆盖不足（已标注 ' + ((b.coverage && b.coverage.scored) || 0) + ' / ' + (b.total || 0) + ' 条），程序初评处于降级态，占比不代表真实消息面；请以「数据尚未就绪」为主，不要对退化分布做过度解读。'
      : '- 情感标注覆盖：已标注 ' + ((b.coverage && b.coverage.scored) || 0) + ' / ' + (b.total || 0) + ' 条。'),
    ((b.langCoverage && b.langCoverage.en)
      ? '- 英文消息分析覆盖：英文原文 ' + b.langCoverage.en + ' 条 · 已标注情感分 ' + b.langCoverage.enScored +
        ' 条 · 已近似映射到真实股市板块 ' + b.langCoverage.enMapped + ' 条（标 [EN]，事实以英文原文为准）。'
      : ''),
    '',
    '【按类别拆分】',
    kindLines.join('\n') || '（无数据）',
    '',
    '【利多代表新闻（逐字引用，含情感分与命中词）】',
    lines(b.samples && b.samples.bull).join('\n') || '（无利多样本）',
    '',
    '【利空代表新闻（逐字引用，含情感分与命中词）】',
    lines(b.samples && b.samples.bear).join('\n') || '（无利空样本）',
    '',
    '【程序声明的口径限制】',
    s(b.caveat, 300),
    '',
    '【任务】写一份「消息面初评复核」。注意：比例已经由程序算好，你的价值在于解释它的边界，而不是重算它。',
    '',
    OUT_RULES,
    '- 标题骨架（顺序和文字都不要改）：',
    '## 一、这个占比能说明什么、不能说明什么',
    '## 二、方向模糊或正负词并存的边界样本',
    '## 三、哪些消息不能直接映射为 A 股利多 / 利空',
    '## 四、使用这个比例时的口径限制与证伪条件',
    '在第四段末尾另起一行写：`依据：程序初评(生成时点) · 代表新闻清单(抓取时点) · 全局数据快照(快照时点)`。',
    '',
    '【各段内容要求】',
    '一：用 2-3 句复述程序给出的真实条数与占比，说明它是「新闻条数比例」而非涨跌概率；点名「中性含词典未命中」这一限制。',
    '二：从给定代表新闻里挑出确实方向模糊、正负词并存或需要上下文才能判断的条目，逐字引用标题并说明原因；没有就如实写「本次样本中未见明显边界模糊条目」，不要硬凑。',
    '三：说明地缘冲突、海外宏观、公司回购 / 停复牌等消息为何不能直接换算成 A 股板块利多利空；逐字引用清单里的相关标题。',
    '四：给 2-3 条可证伪条件，提示词典覆盖、翻译误差、新闻时点不一致、样本范围限制；明确区分程序计算与本次推测。',
    '',
    BIAS_RULES
  ].join('\n');

  const r = await hermes.ask(cfg, 'newsflash', q, {
    task: '消息面初评复核（只解释边界，不改写程序比例）', maxTokens: 1800, temperature: 0.2
  });
  if (r) {
    r.biasVersion = b.version || 'bias-lexicon-v1';
    if (r.ok) r.promptVersion = 'news-bias-v1';
  }
  return r;
}

module.exports = { build, interpretOne, interpretDaily, interpretBias, buildBias, buildBoardRank,
  hintSectors, boardHits, normNews, isEnglishNews, COMPANY_KW, BOARD_DEFS, BOARD_EN,
  SECTOR_HINTS, SECTOR_HINTS_EN, RANK_PARAMS, buildMacro: macroOutlook.build };
