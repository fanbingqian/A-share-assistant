'use strict';

/**
 * 事件语义识别 + 公司重大事项 + 业绩超预期 + 宏观状态传导（零依赖、纯规则、可解释）。
 *
 * 【本模块要回答用户提出的四件事】
 *   1) 两市量能不足 2.5 万亿时，盘面多为板块拉伸 / 板块轮动，微盘与小盘「少量资金即可拉到涨停」
 *      —— 用 Amihud(2002) ILLIQ / Kyle(1985) λ 的层级化近似，实测四层「单位成交额的价格冲击」，
 *      在存量博弈状态下把它转成微小盘的可解释弹性加成；绝对阈值同时用 70 日历史分位校准。
 *   2) 全球经济不确定时机构避险 —— 用新闻风险温度、高风险主题占比、外围 regime、黄金/美元走势
 *      合成风险规避温度，输出「偏大盘 / 防御行业、回避微盘高波动」的修正，并抑制第 1 项的弹性加成。
 *   3) 每日事件判定利多 / 利空，以及利多涉及哪些板块 —— 宏观事件规则表 + 公司事件规则表，
 *      每条事件都给出方向、受影响板块与推理依据。
 *   4) 重大重组 / 拟收购 / 回购 / 重要股东减持重点关注；业绩先判超预期，龙头超预期带动板块，
 *      并生成即时告警（声音 + 桌面通知 + 页内消息）。
 *
 * 【方法学出处】
 *   - Amihud (2002) Illiquidity and Stock Returns；Kyle (1985) Continuous Auctions：单位资金价格冲击随市值下降。
 *   - 华泰金工《基于趋势和拐点的市值因子择时模型》(2025)、《金工：小盘或率先开展反弹》(2026)：
 *     存量博弈下小额增量资金更易推动小市值；绝对成交额阈值需以历史分位校准。
 *   - Ball & Brown (1968) / Bernard & Thomas (1989) PEAD；A 股证据方向不稳健：
 *     杨德明等 (2007)、吴世农/吴超鹏 (2005)、陆婷 (2010)、庞晓波/呼建光 (2011)，
 *     公开回测显示「大幅预增」才有较稳定超额，中小幅不显著 → 本模块对幅度做非线性加权。
 *   - 朱茶芬/李志文/陈超《A股市场上大股东减持的时机选择和市场反应研究》：减持公告后 CAR 为负（倒 V）。
 *   - Firth (1976) / Foster (1981) / Ramnath (2002) intra-industry information transfer：
 *     龙头业绩具有行业信息溢出；Liu/Tan/Wong/Yip (2022, JAPP) 提供中国证据。
 *   - Ang, Hodrick, Xing & Zhang (2006, JF) 低波异象；flight-to-quality / Banz (1981) size premium
 *     在下行市走弱 → 避险状态下偏好大盘与防御。
 *   - GitHub: virattt/ai-hedge-fund (signals/pead.py)、aniketnmishra/PEAD、
 *     gen-li/Replicate_PEAD、simonlin1212/a-stock-data（A股公告/事件数据层）、
 *     shy3130/tick-stock-panel、hzzqq/StockSignal（A股事件驱动回溯）。
 *
 * 【诚实边界】公告标题 ≠ 事实（重组可能终止、回购可能不执行、预增可能来自非经常性损益）；
 *   A 股 PEAD 样本外方向不稳健；T+1 与涨跌停使一字板不可成交；绝对成交额阈值会随市值膨胀漂移。
 *   本模块输出的是「方向 + 依据 + 置信度」，不是因果结论、资金流测量或涨跌预测。
 */

const fs = require('node:fs');
const path = require('node:path');
const { UA } = require('./sources');
const { scoreSentiment, detectTopics } = require('./analysis');
const marketStyle = require('./marketStyle');

const EM_ANN = 'https://np-anotice-stock.eastmoney.com/api/security/ann';
const EM_DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const EM_STOCK_GET = 'https://push2.eastmoney.com/api/qt/stock/get';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'events-cache.json');

/* ------------------------------- 工具 ------------------------------- */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round = (v, n = 1) => +Number(v).toFixed(n);
const finite = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(+v) ? +v : null));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

function hash(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** 东财时间有两种格式：
 *  公告 2026-11-15 16:57:47:242（毫秒用冒号分隔，4 段）
 *  报表 2026-11-06 00:00:00（标准 3 段）—— 不能把最后的秒误当成毫秒改写，否则解析失败会静默退化成 now。 */
function parseEMTime(s) {
  if (!s) return Date.now();
  let t = String(s).trim();
  if (t.split(':').length === 4) t = t.replace(/:(\d{1,3})$/, '.$1');
  t = t.replace(' ', 'T');
  const ms = Date.parse(/[+-]\d{2}:?\d{2}$|Z$/.test(t) ? t : t + '+08:00');
  return Number.isFinite(ms) ? ms : Date.now();
}

function timeLabel(ts) {
  const d = new Date(ts + 8 * 3600000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Referer': 'https://data.eastmoney.com/' },
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = await r.text();
    if (!text || !text.trim()) throw new Error('空响应（可能被限流）');
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

function hit(text, kws) {
  const s = String(text || '').toLowerCase();
  for (const k of kws) {
    const kw = String(k).toLowerCase();
    if (/^[a-z0-9 ]+$/.test(kw)) {
      const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('(^|[^a-z0-9])' + esc + '(?:s|es|ed|ing)?(?=$|[^a-z0-9])', 'i').test(s)) return k;
    } else if (s.includes(kw)) return k;
  }
  return null;
}

/* ------------------------------- 一、公司事件规则表 ------------------------------- */
/* weight 为「方向 × 强度」的原始分（-10 ~ +10），正数＝利多、负数＝利空。
   focus=true 表示用户点名需要重点关注的重大事项。栏目名也参与匹配。
   顺序即优先级：靠前的规则先命中，避免「终止重组」被当成普通重组利好。 */

const CORPORATE_RULES = [
  { type: 'reorg_stop', label: '重组终止', weight: -7, polarity: '利空', level: 'warning', focus: true,
    kw: ['终止重大资产重组', '终止重组', '重组终止', '终止筹划', '终止收购', '撤回重组'],
    logic: '重组预期落空通常带来估值回吐，属明确利空' },
  { type: 'investigation', label: '立案调查 / 处罚', weight: -9, polarity: '利空', level: 'warning', focus: true,
    kw: ['立案调查', '被立案', '行政处罚', '监管处罚', '警示函', '刑事拘留', '涉嫌违法', '纪律处分', '被查'],
    logic: '监管与合规风险显著抬升，机构资金通常回避' },
  { type: 'delist_risk', label: '退市 / 风险警示', weight: -8, polarity: '利空', level: 'warning', focus: false,
    kw: ['退市风险', '终止上市', '可能被终止上市', '风险警示', '其他风险警示', '摘牌提示'],
    logic: '上市地位与流动性风险，属于最高等级负面事项' },
  { type: 'reorg', label: '重大资产重组', weight: 8, polarity: '利多', level: 'warning', focus: true,
    kw: ['重大资产重组', '资产重组', '重组预案', '重组报告书', '重组进展', '吸收合并', '借壳上市', '发行股份购买资产', '重大资产置换'],
    logic: '重组预期带来资产质量与规模跃迁，A 股事件研究对资产收购类公告多为正向反应；但需跟踪是否终止' },
  { type: 'acquisition', label: '拟收购 / 并购', weight: 7, polarity: '利多', level: 'warning', focus: true,
    kw: ['拟收购', '收购报告书', '要约收购', '股权收购', '发行股份购买资产', '支付现金购买资产', '购买资产', '收购出售资产', '并购重组', '筹划收购'],
    logic: '外延扩张通常被解读为成长信号，需结合对价与标的盈利质量；并购贷款、司法拍卖等流程性标题不算新事件' },
  { type: 'reduce', label: '重要股东减持', weight: -7, polarity: '利空', level: 'warning', focus: true,
    kw: ['减持计划', '拟减持', '减持股份', '减持完毕', '减持进展', '股东减持', '实际控制人减持', '股份减持', '询价转让', '减持比例'],
    logic: '朱茶芬等实证：大股东减持公告前常有正超额、公告后 CAR 转负（倒 V），供给压力与信号效应偏空；「权益变动报告书」方向不明，不据此定性' },
  { type: 'buyback', label: '股份回购', weight: 7, polarity: '利多', level: 'warning', focus: true,
    kw: ['回购股份', '回购预案', '回购报告书', '回购进展', '股份回购', '集中竞价回购', '回购注销', '回购方案'],
    logic: '回购传递管理层低估信号并减少流通股本；A 股回购预案后 20 日 CAR 约 +2%，但需防公告前已透支' },
  { type: 'increase', label: '股东增持', weight: 6, polarity: '利多', level: 'info', focus: false,
    kw: ['增持计划', '增持股份', '增持完成', '增持进展', '股东增持', '实际控制人增持', '增持公司股份'],
    logic: '内部人买入通常被视为信心信号' },
  { type: 'contract', label: '重大合同 / 中标', weight: 5, polarity: '利多', level: 'info', focus: false,
    kw: ['重大合同', '中标', '签订日常经营重大合同', '框架协议', '战略合作协议', '重大订单', '获得大额订单'],
    logic: '订单直接改善未来收入能见度，需折算占营收比例' },
  { type: 'dividend', label: '分红 / 派息', weight: 3, polarity: '利多', level: 'info', focus: false,
    kw: ['利润分配', '现金分红', '分红派息', '派发现金红利', '年度权益分派'],
    logic: '现金回报提升防御属性，成长股上幅度有限' },
  { type: 'incentive', label: '股权激励', weight: 3, polarity: '利多', level: 'info', focus: false,
    kw: ['股权激励', '限制性股票激励', '员工持股计划', '股票期权激励'],
    logic: '绑定管理层利益，但需看行权条件是否宽松' },
  { type: 'unlock', label: '限售股解禁', weight: -4, polarity: '利空', level: 'info', focus: false,
    kw: ['限售股份上市流通', '解除限售', '限售股解禁', '首发原股东限售股份'],
    logic: '流通盘阶段性扩张，短期供给压力' },
  { type: 'placement', label: '定增 / 再融资', weight: -3, polarity: '偏空', level: 'info', focus: false,
    kw: ['非公开发行', '向特定对象发行', '增发预案', '配股', '向不特定对象发行可转债', '募集资金'],
    logic: '摊薄与供给压力，若募投项目优质则方向可能反转' },
  { type: 'pledge', label: '股权质押 / 冻结', weight: -4, polarity: '利空', level: 'info', focus: false,
    kw: ['股份质押', '股权质押', '股份冻结', '被冻结', '质押式回购'],
    logic: '控股股东流动性风险与平仓压力' },
  { type: 'litigation', label: '诉讼仲裁', weight: -3, polarity: '利空', level: 'info', focus: false,
    kw: ['诉讼', '仲裁', '重大诉讼', '涉诉'],
    logic: '或有负债与经营不确定性上升' },
  { type: 'approval', label: '获批 / 纳入目录', weight: 4, polarity: '利多', level: 'info', focus: false,
    kw: ['纳入国家医保目录', '获得批准', '获批上市', '取得注册证', '通过一致性评价', '获得药品注册', '入选'],
    logic: '准入或审批落地直接打开销售空间（医药 / 器械尤为显著）' },
  { type: 'earnings_notice', label: '业绩公告', weight: 0, polarity: '需判断', level: 'info', focus: false,
    kw: ['业绩预告', '业绩快报', '业绩预增', '业绩预亏', '年度报告', '季度报告', '半年度报告', '业绩说明会'],
    logic: '业绩方向由业绩预告 / 快报数据判定，不以标题词定性' }
];

/* 公告标题 ≠ 事实：流程性文件不是新事件；反向词出现时不能按栏目推断利多；
   反向词与栏目推断的联合约束，是实测「司法拍卖被判成收购」「并购贷款被判成并购」后的修正。 */
const FLOW_KW = ['核查意见', '法律意见书', '独立意见', '专项说明', '保荐', '审计报告', '问询函回复',
  '股东大会资料', '管理制度', '管理办法', '决议公告', '会议通知', '情况说明', '补充说明', '招股说明书',
  '评估报告', '资产评估', '董事会关于', '是否构成', '不存在不得', '一般风险提示', '权益价值'];
const PROGRESS_KW = ['进展公告', '提示性公告', '预案', '进展'];
const REVERSE_KW = ['终止', '撤回', '中止', '失败', '未通过', '司法拍卖', '被拍卖', '质押', '冻结',
  '减持', '亏损', '处罚', '贷款', '担保', '问询函'];
const HIGH_CONF_COLUMNS = ['回购进展情况', '回购预案', '重组进展公告', '重大资产重组',
  '股东/实际控制人股份增持', '限售股份上市流通', '收购出售资产/股权', '重大合同', '股权激励进展公告'];

/** 龙头判定：优先实测流通市值；缺市值时用「显著超预期 + 明确行业」降级推断，保证板块联动不失效 */
function leaderInfo(code, meta, industry, beatScore, opts = {}) {
  const m = (meta && meta[code]) || {};
  const cap = finite(m.floatCap);
  const thresholdYi = clamp(Number(opts.leaderCapYi) || 500, 100, 3000);
  let tier = cap === null ? '未知' : cap >= thresholdYi * 1e8 ? '高' : cap >= 200e8 ? '中' : '低';
  const notes = [];
  if (cap === null) notes.push('流通市值数据缺失');
  if (tier === '未知' && industry && Number(beatScore) >= 80) {
    tier = '中';
    notes.push('缺市值数据，按显著超预期（≥80 分）+ 明确行业代表性降级推断为行业龙头');
  }
  return { cap, tier, isLeader: tier === '高' || tier === '中', notes };
}

/* ------------------------------- 二、业绩超预期判定 ------------------------------- */

const EARNINGS_TYPES = {
  '预增': { dir: 1, base: 62 }, '略增': { dir: 1, base: 55 },
  '扭亏': { dir: 1, base: 58 }, '续盈': { dir: 1, base: 52 },
  '略减': { dir: -1, base: 44 }, '预减': { dir: -1, base: 36 },
  '首亏': { dir: -1, base: 28 }, '续亏': { dir: -1, base: 30 },
  '不确定': { dir: 0, base: 50 }, '减亏': { dir: 1, base: 52 }, '增亏': { dir: -1, base: 30 }
};

/** 一次性收益 / 低质量驱动的扣分项（调研建议：剔除补助、卖资产、低基数扭亏） */
const LOW_QUALITY_KW = ['非经常性损益', '政府补助', '出售资产', '资产处置', '投资收益', '公允价值变动',
  '债务重组', '会计估计变更', '低基数', '去年同期亏损'];
const HIGH_QUALITY_KW = ['主营业务', '销售收入增长', '订单', '销量增长', '产能释放', '毛利率提升',
  '市场份额', '新产品', '扣除非经常性损益后'];

function earningsScore(input) {
  const type = String(input.type || '').trim();
  const t = EARNINGS_TYPES[type] || { dir: 0, base: 50 };
  const amp = finite(input.amp);
  const content = String(input.content || '') + ' ' + String(input.reason || '') + ' ' + String(input.title || '');
  let score = t.base;
  const notes = [];
  // 幅度非线性：大幅预增（>100%）才有较稳定超额，小幅预增在 A 股不显著（调研结论）
  if (amp !== null && t.dir > 0) {
    const bonus = clamp(Math.log2(1 + Math.max(0, amp) / 20) * 8, 0, 26);
    score += bonus;
    notes.push('同比中值 ' + signed(amp, 1) + '% → 幅度加分 ' + round(bonus, 1));
  } else if (amp !== null && t.dir < 0) {
    const penalty = clamp(Math.log2(1 + Math.abs(Math.min(0, amp)) / 20) * 7, 0, 22);
    score -= penalty;
    notes.push('同比中值 ' + signed(amp, 1) + '% → 幅度扣分 ' + round(penalty, 1));
  }
  const beatWord = hit(content, ['超预期', '超市场预期', '高于预期', '好于预期', 'beat expectations', '超出预期', '上修业绩']);
  if (beatWord && t.dir >= 0) { score += 8; notes.push('文本明确「' + beatWord + '」+8'); }
  const missWord = hit(content, ['低于预期', '不及预期', 'miss expectations', '下修业绩', '业绩不达预期']);
  if (missWord) { score -= 8; notes.push('文本明确「' + missWord + '」−8'); }
  const lowQ = LOW_QUALITY_KW.find(k => content.includes(k));
  if (lowQ && t.dir > 0) { score -= 10; notes.push('含「' + lowQ + '」等非经常/一次性因素，质量扣分 −10'); }
  const highQ = HIGH_QUALITY_KW.find(k => content.includes(k));
  if (highQ && t.dir > 0) { score += 5; notes.push('含「' + highQ + '」等主营驱动，质量加分 +5'); }
  if (type === '扭亏' && amp === null) { score -= 6; notes.push('扭亏缺少幅度数据，防低基数 −6'); }
  score = Math.round(clamp(score, 0, 100));
  const isBeat = t.dir > 0 && score >= 68;
  const level = score >= 80 ? '显著超预期' : score >= 68 ? '超预期'
    : score >= 52 ? '基本符合预期' : score >= 38 ? '低于预期' : '明显低于预期';
  return { score, isBeat, level, dir: t.dir, type, amp, notes };
}

function signed(v, d = 0) { const n = Number(v) || 0; return (n > 0 ? '+' : '') + (d ? n.toFixed(d) : String(n)); }

/* ------------------------------- 三、宏观事件规则表 ------------------------------- */
/* polarity 指对「A 股权益整体」的方向；benefit / hurt 给出利多与利空涉及的具体板块。 */

const MACRO_RULES = [
  { id: 'easing_cn', label: '降准降息 / 稳增长', polarity: '利多', weight: 8,
    kw: ['降准', '降息', '宽松', '政策刺激', '稳增长', '内需', '财政刺激', '特别国债', '央行投放', 'rate cut', 'stimulus', 'pboc'],
    benefit: ['证券', '银行', '房地产', '基建', '工程机械', '有色', '消费', '家电', '汽车'], hurt: [],
    logic: '流动性宽松与需求刺激改善顺周期与券商板块盈利预期' },
  { id: 'ai_tech', label: 'AI / 算力 / 半导体突破', polarity: '利多', weight: 7,
    kw: ['人工智能', '算力', 'ai chip', '大模型', '芯片突破', '半导体', '光模块', '数据中心', '英伟达', 'nvidia', 'hbm'],
    benefit: ['半导体', '通信设备', '计算机', '电子', '软件', '光模块', '消费电子', '互联网'], hurt: [],
    logic: '资本开支与算力需求上行直接映射科技硬件产业链' },
  { id: 'geopolitics', label: '地缘冲突 / 战争', polarity: '利空', weight: 9,
    kw: ['war', 'invasion', 'missile', 'attack', '战争', '冲突', '军事打击', '地缘', '导弹', '制裁升级'],
    benefit: ['贵金属', '黄金', '石油', '能源', '军工', '国防', '船舶'], hurt: ['航空', '航运', '消费', '电子', '出口'],
    logic: '整体压制风险偏好，但避险与军工 / 资源板块受益' },
  { id: 'financial_risk', label: '金融危机 / 流动性风险', polarity: '利空', weight: 10,
    kw: ['bank failure', 'credit crisis', 'liquidity crisis', 'default', '银行倒闭', '爆雷', '违约', '挤兑', '流动性危机', '金融危机'],
    benefit: ['贵金属', '黄金', '银行'], hurt: ['证券', '房地产', '多元金融', '成长', '微盘'],
    logic: '系统性风险下资金撤离权益，机构降低高波动与小微盘暴露' },
  { id: 'recession', label: '衰退 / 就业疲弱', polarity: '利空', weight: 8,
    kw: ['recession', 'jobless', 'unemployment', 'slowdown', '衰退', '经济放缓', '失业', '非农疲弱', 'gdp contraction'],
    benefit: ['贵金属', '黄金', '公用事业', '电力', '医药', '食品'], hurt: ['有色', '钢铁', '化工', '煤炭', '航运', '出口'],
    logic: '需求走弱压制周期与出口链，防御与避险资产相对占优' },
  { id: 'trade', label: '关税 / 出口管制', polarity: '利空', weight: 8,
    kw: ['tariff', 'sanctions', 'trade war', 'export ban', '关税', '制裁', '贸易摩擦', '出口管制', '加征关税'],
    benefit: ['半导体', '军工', '农业', '贵金属'], hurt: ['消费电子', '家电', '纺织', '机械', '贸易', '航运'],
    logic: '贸易壁垒压制出口链，同时强化国产替代与避险方向' },
  { id: 'oil_supply', label: '供给收缩 / 油价上行', polarity: '分化', weight: 6,
    kw: ['opec', '减产', '供给中断', 'supply cut', '油价大涨', '原油上涨', '禁运'],
    benefit: ['石油', '石化', '油服', '煤炭', '能源'], hurt: ['航空', '机场', '航运', '物流', '化工'],
    logic: '上游资源受益、下游运输与化工成本承压' },
  { id: 'gold_high', label: '黄金创新高 / 避险升温', polarity: '分化', weight: 5,
    kw: ['record high', '金价', '黄金创新高', 'gold price', '现货黄金', '避险买盘'],
    benefit: ['贵金属', '黄金', '有色', '珠宝'], hurt: ['消费电子', '航空'],
    logic: '贵金属板块盈利弹性与避险资金同步' },
  { id: 'policy_med', label: '医保 / 药审 / 集采政策', polarity: '分化', weight: 6,
    kw: ['医保目录', '集采', '药品审批', '创新药', '医药政策', '医疗器械', '带量采购'],
    benefit: ['医药', '医疗', '生物', '化学制药'], hurt: ['医药商业'],
    logic: '准入与创新药支持利多，降价类集采对流通环节偏空' },
  { id: 'new_energy', label: '新能源装机 / 补贴', polarity: '利多', weight: 6,
    kw: ['光伏', '新能源', '装机', '储能', '锂电', '风电', '补贴', '以旧换新', '电力设备'],
    benefit: ['光伏', '电力设备', '锂电', '新能源', '储能', '电网'], hurt: ['煤炭', '火电'],
    logic: '装机与补贴政策抬升设备需求' },
  { id: 'inflation', label: '通胀黏性 / 加息', polarity: '利空', weight: 6,
    kw: ['rate hike', 'hawkish', 'inflation', 'cpi', '加息', '鹰派', '通胀', '缩表'],
    benefit: ['银行', '保险', '石油', '农业'], hurt: ['半导体', '软件', '房地产', '成长', '微盘'],
    logic: '贴现率上行压制高久期成长与小盘估值' },
  { id: 'china_consumption', label: '消费刺激 / 内需回暖', polarity: '利多', weight: 6,
    kw: ['消费刺激', '以旧换新', '消费券', '内需', '社零', '零售增长', 'chinastimulus'],
    benefit: ['消费', '家电', '汽车', '食品', '饮料', '商业', '旅游', '白酒'], hurt: [],
    logic: '终端需求改善直接映射可选与必选消费' }
];

/* ------------------------------- 四、数据采集（带缓存与降级） ------------------------------- */

function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (_) { /* 缓存损坏则重拉 */ }
  return null;
}

function writeCache(data) {
  try {
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) { console.warn('[events] 缓存写入失败: ' + e.message); }
}

function isoDate(daysAgo) {
  const d = new Date(Date.now() + 8 * 3600000 - daysAgo * 86400000);
  return d.toISOString().slice(0, 10);
}

function normalizeAnn(j) {
  const list = (j && j.data && j.data.list) || [];
  return list.map(a => {
    const c = (a.codes || []).find(x => /^\d{6}$/.test(String(x.stock_code || ''))) || (a.codes || [])[0] || {};
    return {
      id: 'ann:' + (a.art_code || hash(a.title)),
      code: String(c.stock_code || ''), name: String(c.short_name || ''),
      title: String(a.title_ch || a.title || ''),
      columns: (a.columns || []).map(x => String(x.column_name || '')),
      ts: parseEMTime(a.display_time || a.notice_date),
      link: 'https://data.eastmoney.com/notices/detail/' + String(c.stock_code || '') + '/' + String(a.art_code || '') + '.html'
    };
  }).filter(a => a.title);
}

async function fetchAnnouncements(pages = 3) {
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const url = EM_ANN + '?sr=-1&page_size=100&page_index=' + p + '&ann_type=A&client_source=web&_=' + Date.now();
    let j = null;
    for (let attempt = 0; attempt < 2 && !j; attempt++) {
      try { j = await fetchJson(url); }
      catch (e) { if (attempt === 1) throw new Error('公告第 ' + p + ' 页失败: ' + e.message); await sleep(900); }
    }
    const rows = normalizeAnn(j);
    if (!rows.length) break;
    out.push(...rows);
    if (p < pages) await sleep(420);
  }
  if (!out.length) throw new Error('公告接口返回空');
  return out;
}

async function fetchReport(reportName, columns, days, pages, dateField) {
  const filter = '(' + dateField + ">='" + isoDate(days) + "')";
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const url = EM_DC + '?reportName=' + reportName + '&columns=' + encodeURIComponent(columns) +
      '&filter=' + encodeURIComponent(filter) + '&pageNumber=' + p + '&pageSize=100' +
      '&sortColumns=' + dateField + '&sortTypes=-1&_=' + Date.now();
    let j = null;
    for (let attempt = 0; attempt < 2 && !j; attempt++) {
      try { j = await fetchJson(url); }
      catch (e) { if (attempt === 1) throw new Error(reportName + ' 第 ' + p + ' 页失败: ' + e.message); await sleep(900); }
    }
    const rows = (j && j.result && j.result.data) || [];
    if (!rows.length) break;
    out.push(...rows);
    if (p < pages && rows.length >= 100) await sleep(420); else break;
  }
  return out;
}

function secidOf(code) { return (/^[65]/.test(String(code)) ? '1.' : '0.') + code; }

async function fetchOneMeta(code) {
  const j = await fetchJson(EM_STOCK_GET + '?secid=' + secidOf(code) +
    '&fields=f57,f58,f127,f116,f117&_=' + Date.now(), 9000);
  const d = j && j.data;
  if (!d) throw new Error('无数据');
  return {
    code, industry: String(d.f127 || '').replace(/[ⅠⅡⅢⅣ]+$/, '').trim(),
    floatCap: finite(d.f117), totalCap: finite(d.f116), name: String(d.f58 || '')
  };
}

/** 只对出现事件的代码补行业与流通市值。业绩 / 快报代码先串行优先取，
 *  其余 3 个一批 + 失败项串行重试 —— 东财限流时高并发会让关键代码静默失败。 */
async function fetchStockMeta(codes, cached = {}, priority = []) {
  const out = { ...cached };
  const clean = c => /^\d{6}$/.test(String(c));
  const missing = c => !out[c] || !out[c].industry;
  const priorityCodes = [...new Set(priority.filter(clean))].filter(missing).slice(0, 24);
  for (const code of priorityCodes) {
    try { out[code] = await fetchOneMeta(code); } catch (_) { /* 稍后由批量重试兜底 */ }
    await sleep(260);
  }
  const need = [...new Set(codes.filter(clean))].filter(missing).slice(0, 120);
  const failed = [];
  for (let i = 0; i < need.length; i += 3) {
    const batch = need.slice(i, i + 3);
    const res = await Promise.allSettled(batch.map(fetchOneMeta));
    res.forEach((r, k) => {
      if (r.status === 'fulfilled') out[batch[k]] = r.value;
      else failed.push(batch[k]);
    });
    if (i + 3 < need.length) await sleep(220);
  }
  for (const code of failed.slice(0, 30)) {
    try { out[code] = await fetchOneMeta(code); } catch (_) { /* 保留降级路径 */ }
    await sleep(180);
  }
  return out;
}

/**
 * 采集原始事件材料。任何一路失败都降级到上一份落盘缓存，保证评分因子不突然抖动。
 */
async function refreshRawEvents(opts = {}) {
  const trading = !!opts.trading;
  const days = clamp(Number(opts.lookbackDays) || 14, 3, 60);
  const refreshMin = clamp(Number(opts.refreshMin) || 5, 1, 240);
  const ttl = (trading ? refreshMin : Math.max(20, refreshMin * 4)) * 60000;
  const cached = readCache();
  if (!opts.force && cached && cached.raw && Date.now() - cached.generatedAt < ttl) {
    return { ...cached.raw, fromCache: true, warnings: (cached.raw.warnings || []).slice() };
  }
  const warnings = [];
  const sourcesOk = {};
  const prev = (cached && cached.raw) || {};
  let announcements = prev.announcements || [];
  let forecasts = prev.forecasts || [];
  let express = prev.express || [];
  let meta = prev.meta || {};

  try { announcements = await fetchAnnouncements(3); sourcesOk.announcements = announcements.length; }
  catch (e) { warnings.push('公告采集失败，沿用上次快照：' + e.message); sourcesOk.announcements = 0; }
  await sleep(320);
  try {
    forecasts = await fetchReport('RPT_PUBLIC_OP_NEWPREDICT',
      'SECURITY_CODE,SECURITY_NAME_ABBR,NOTICE_DATE,REPORT_DATE,PREDICT_TYPE,PREDICT_CONTENT,ADD_AMP_LOWER,ADD_AMP_UPPER,INCREASE_JZ,CHANGE_REASON_EXPLAIN,IS_LATEST,PREDICT_FINANCE',
      days, 3, 'NOTICE_DATE');
    sourcesOk.forecasts = forecasts.length;
  } catch (e) { warnings.push('业绩预告采集失败，沿用上次快照：' + e.message); sourcesOk.forecasts = 0; }
  await sleep(320);
  try {
    express = await fetchReport('RPT_FCI_PERFORMANCEE',
      'SECURITY_CODE,SECURITY_NAME_ABBR,NOTICE_DATE,REPORT_DATE,YSTZ,JLRTBZCL,BASIC_EPS,WEIGHTAVG_ROE,PUBLISHNAME,ISNEW',
      days, 2, 'NOTICE_DATE');
    sourcesOk.express = express.length;
  } catch (e) { warnings.push('业绩快报采集失败，沿用上次快照：' + e.message); sourcesOk.express = 0; }

  // 业绩事件优先补行业与流通市值：龙头识别与板块联动依赖它，不能被 300 条公告挤到截断区外
  const codes = [];
  for (const e of express) if (e.SECURITY_CODE) codes.push(String(e.SECURITY_CODE));
  for (const f of forecasts) if (f.SECURITY_CODE) codes.push(String(f.SECURITY_CODE));
  for (const a of announcements) if (a.code) codes.push(a.code);
  await sleep(900); // 公告 / 报表请求后留出限流恢复窗口
  try { meta = await fetchStockMeta(codes, meta, codes.slice(0, 24)); }
  catch (e) { warnings.push('个股行业/市值补取失败：' + e.message); }

  const raw = {
    generatedAt: Date.now(), warnings, sourcesOk,
    announcements, forecasts, express, meta,
    note: '东财公告（最新 300 条）+ 业绩预告 / 快报（近 ' + days + ' 天）+ 事件个股行业与流通市值'
  };
  writeCache({ generatedAt: Date.now(), raw });
  return { ...raw, fromCache: false };
}

/* ------------------------------- 五、事件视图（纯计算，可高频调用） ------------------------------- */

function industryOf(code, name, meta, fallback) {
  const m = meta && meta[code];
  if (m && m.industry) return m.industry;
  return fallback || '';
}

/** 板块名匹配：东财行业名（如「白酒Ⅱ」「化学制药」）与规则里的宽泛板块词做包含匹配 */
function sectorMatch(industry, sectors) {
  const s = String(industry || '');
  if (!s) return null;
  let best = null;
  for (const sec of sectors || []) {
    if (s.includes(sec) || sec.includes(s)) {
      if (!best || sec.length > best.length) best = sec;
    }
  }
  return best;
}

function alertFor(ev, cfg) {
  if (!cfg.alertEnabled) return null;
  const base = {
    rule: 'event-' + ev.type, category: 'event', instrument: ev.code || null,
    instrumentName: ev.name || null, source: ev.source || '东方财富',
    sourceTime: new Date(ev.ts).toISOString(), link: ev.link || null, silent: false
  };
  if (ev.type === 'earnings' && ev.isBeat && ev.isLeader) {
    return { ...base, rule: 'leader-earnings-beat', level: 'critical',
      title: '龙头业绩超预期 · ' + ev.name,
      message: ev.name + '（' + ev.code + '）' + ev.typeLabel + '，' + ev.beatLevel +
        '（净利同比中值 ' + signed(ev.amp, 1) + '%，超预期分 ' + ev.beatScore + '）。' +
        (ev.industry ? ev.industry + ' 板块可能出现业绩联动，' : '') + '请及时关注。',
      detail: (ev.notes || []).join('；') };
  }
  if (ev.type === 'earnings' && ev.isBeat) {
    return { ...base, rule: 'earnings-beat', level: 'info',
      title: '业绩超预期 · ' + ev.name,
      message: ev.name + '（' + ev.code + '）' + ev.beatLevel + '，同比中值 ' + signed(ev.amp, 1) + '%，超预期分 ' + ev.beatScore + '。',
      detail: (ev.notes || []).join('；') };
  }
  if (ev.focus && ['reorg', 'acquisition', 'buyback', 'reduce', 'reorg_stop', 'investigation'].includes(ev.type)) {
    // 进展公告 / 仅凭栏目推断的事件不按高级别推送，避免公告流把告警中心淹没
    const level = (ev.progressDowngrade || ev.viaColumn) ? 'info' : 'warning';
    return { ...base, level,
      title: (level === 'info' ? '关注' : '重点') + ' · ' + ev.label + ' · ' + ev.name,
      message: ev.name + '（' + ev.code + '）：' + ev.title.slice(0, 90) + '。判定为' + ev.polarity + '，' + ev.logic + '。',
      detail: '事件来源：' + (ev.source || '') + '；发布时间：' + timeLabel(ev.ts) +
        (ev.confidence === '低' ? '；置信度低（进展文件/栏目推断）' : '') };
  }
  return null;
}

/**
 * 构建事件视图。
 * @param {object} raw   refreshRawEvents 的输出
 * @param {object} ctx   { news, stockNews, briefing, quotes, market, style, opts }
 */
function buildEventView(raw, ctx = {}) {
  const now = ctx.now || Date.now();
  const opts = ctx.opts || {};
  const meta = (raw && raw.meta) || {};
  const items = [];
  const seen = new Set();
  const add = ev => {
    if (!ev || seen.has(ev.id)) return;
    seen.add(ev.id);
    const ageH = Math.max(0, (now - ev.ts) / 3600000);
    ev.ageH = round(ageH, 1);
    ev.timeLabel = timeLabel(ev.ts);
    ev.decay = round(Math.pow(0.5, ageH / 72), 3); // 事件 72 小时半衰期
    items.push(ev);
  };

  /* ① 公司公告事件：codes 已明确绑定股票；标题优先，栏目只作低置信兜底。
        实测教训：把栏目名与标题一起匹配会把「司法拍卖」「券商核查意见」误判成收购利多。 */
  for (const a of (raw && raw.announcements) || []) {
    if (!a.code || !/^\d{6}$/.test(a.code)) continue;
    const titleText = a.title;
    const colText = a.columns.join(' ');
    if (hit(titleText, FLOW_KW)) continue; // 券商核查 / 法律意见 / 决议 / 制度等不是新事件
    const matched = [];
    let main = null, viaColumn = false;
    for (const r of CORPORATE_RULES) {
      const k = hit(titleText, r.kw);
      if (!k) continue;
      matched.push({ type: r.type, label: r.label, kw: k });
      if (!main) main = { r, k };
    }
    if (!main && HIGH_CONF_COLUMNS.some(c => colText.includes(c))) {
      for (const r of CORPORATE_RULES) {
        const k = hit(colText, r.kw);
        if (k) { main = { r, k }; viaColumn = true; break; }
      }
    }
    if (!main || main.r.type === 'earnings_notice') continue;
    const adverse = hit(titleText, REVERSE_KW);
    if (adverse && main.r.weight > 0) continue; // 「质押 / 司法拍卖 / 贷款」类标题不能推断为利多
    const r = main.r;
    const li = leaderInfo(a.code, meta, '', 0, opts);
    const notes = li.notes.slice();
    let weight = r.weight, focus = !!r.focus, downgrade = false;
    if (viaColumn) { weight = Math.round(weight * 0.55); notes.push('按东财栏目「' + main.k + '」推断（标题未直接点明），权重 ×0.55'); }
    const prog = hit(titleText, PROGRESS_KW);
    if (prog) { weight = Math.round(weight * 0.6); downgrade = true; notes.push('「' + prog + '」为进展/提示性文件，权重 ×0.6 且告警降级'); }
    const ev = {
      id: a.id, code: a.code, name: a.name || (meta[a.code] && meta[a.code].name) || a.code,
      industry: industryOf(a.code, a.name, meta),
      floatCap: li.cap, leaderTier: li.tier, isLeader: li.isLeader,
      title: a.title, ts: a.ts, link: a.link, source: '东方财富 · 公司公告 / ' + (a.columns[0] || '公告'),
      type: r.type, label: r.label, typeLabel: r.label,
      polarity: r.polarity, weight, level: r.level, focus,
      logic: r.logic, matchKw: main.k, allTags: matched.slice(0, 4),
      viaColumn, progressDowngrade: downgrade, confidence: viaColumn || downgrade ? '低' : '中',
      sectors: [], notes, isBeat: false, beatScore: null, beatLevel: null, amp: null
    };
    // 情感词典仅作方向一致性的旁证，不覆盖规则结论
    const sent = scoreSentiment(titleText).score;
    ev.sentiment = sent;
    if (weight > 0 && sent <= -25) { ev.weight = Math.round(weight * 0.6); notes.push('标题情感偏负面，事件强度折减'); }
    if (weight < 0 && sent >= 25) { ev.weight = Math.round(weight * 0.7); notes.push('标题情感偏正面，事件强度折减'); }
    add(ev);
  }

  /* ② 业绩预告：同 code + 报告期去重，优先归母净利润口径 */
  const forecastGroups = new Map();
  for (const f of (raw && raw.forecasts) || []) {
    if (!f || f.IS_LATEST !== 'T' && f.IS_LATEST !== undefined && f.IS_LATEST !== '1') continue;
    const code = String(f.SECURITY_CODE || '');
    if (!/^\d{6}$/.test(code)) continue;
    const key = code + '|' + String(f.REPORT_DATE || '').slice(0, 10);
    const cur = forecastGroups.get(key);
    const isNet = /净利润/.test(String(f.PREDICT_FINANCE || '')) || /净利润/.test(String(f.PREDICT_CONTENT || ''));
    if (!cur || (isNet && !cur._isNet)) forecastGroups.set(key, { ...f, _isNet: isNet });
  }
  for (const f of forecastGroups.values()) {
    const code = String(f.SECURITY_CODE);
    const amp = finite(f.INCREASE_JZ) !== null ? finite(f.INCREASE_JZ)
      : (finite(f.ADD_AMP_LOWER) !== null && finite(f.ADD_AMP_UPPER) !== null
        ? (finite(f.ADD_AMP_LOWER) + finite(f.ADD_AMP_UPPER)) / 2 : null);
    const es = earningsScore({
      type: f.PREDICT_TYPE, amp,
      content: f.PREDICT_CONTENT, reason: f.CHANGE_REASON_EXPLAIN, title: ''
    });
    const m = meta[code] || {};
    const industry = industryOf(code, '', meta);
    const li = leaderInfo(code, meta, industry, es.score, opts);
    const ev = {
      id: 'fc:' + code + ':' + String(f.REPORT_DATE || '').slice(0, 10) + ':' + hash(String(f.PREDICT_CONTENT || '').slice(0, 32)),
      code, name: String(f.SECURITY_NAME_ABBR || m.name || code),
      industry, floatCap: li.cap, leaderTier: li.tier,
      isLeader: li.isLeader,
      title: String(f.PREDICT_CONTENT || (f.PREDICT_TYPE + '业绩预告')).slice(0, 140),
      ts: parseEMTime(f.NOTICE_DATE), link: 'https://data.eastmoney.com/yjyg/',
      source: '东方财富 · 业绩预告（' + String(f.REPORT_DATE || '').slice(0, 10) + '报告期）',
      type: 'earnings', label: '业绩预告 · ' + String(f.PREDICT_TYPE || ''),
      typeLabel: String(f.PREDICT_TYPE || '') + '业绩预告',
      polarity: es.dir > 0 ? '利多' : es.dir < 0 ? '利空' : '中性',
      weight: Math.round((es.score - 50) / 5), level: es.isBeat ? 'warning' : 'info',
      focus: es.isBeat,       logic: '业绩方向由预告类型 + 同比中值 + 文本超预期表述 + 损益质量共同判定（PEAD 思路）',
      matchKw: String(f.PREDICT_TYPE || ''), allTags: [], viaColumn: false, progressDowngrade: false, confidence: '中',
      sectors: [], notes: es.notes.concat(li.notes),
      isBeat: es.isBeat, beatScore: es.score, beatLevel: es.level,
      beatDir: es.dir, amp: es.amp, sentiment: Math.round((es.score - 50) * 0.8)
    };
    add(ev);
  }

  /* ③ 业绩快报：营收 / 净利同比双维度，行业字段可直接用于板块联动 */
  for (const e of (raw && raw.express) || []) {
    if (!e || e.ISNEW !== '1' && e.ISNEW !== 1 && e.ISNEW !== undefined) continue;
    const code = String(e.SECURITY_CODE || '');
    if (!/^\d{6}$/.test(code)) continue;
    const np = finite(e.JLRTBZCL), rev = finite(e.YSTZ);
    if (np === null && rev === null) continue;
    const es = earningsScore({
      type: (np !== null && np >= 30) ? '预增' : (np !== null && np <= -20) ? '预减' : '续盈',
      amp: np, content: '', title: ''
    });
    // 快报为已实现数据，营收同比作为质量确认项
    if (rev !== null) {
      const q = clamp(rev / 20, -8, 8);
      es.score = Math.round(clamp(es.score + q, 0, 100));
      es.notes.push('营收同比 ' + signed(rev, 1) + '% → 质量修正 ' + signed(q, 1));
    }
    es.isBeat = np !== null && np >= 50 && (rev === null || rev >= 10);
    es.level = es.isBeat ? (np >= 100 ? '显著超预期' : '超预期')
      : np !== null && np >= 20 ? '基本符合预期' : np !== null && np < 0 ? '低于预期' : '基本符合预期';
    const m = meta[code] || {};
    const industry = String(e.PUBLISHNAME || '').replace(/[ⅠⅡⅢⅣ]+$/, '').trim() || industryOf(code, '', meta);
    const li = leaderInfo(code, meta, industry, es.score, opts);
    const ev = {
      id: 'ex:' + code + ':' + String(e.REPORT_DATE || '').slice(0, 10),
      code, name: String(e.SECURITY_NAME_ABBR || m.name || code),
      industry, floatCap: li.cap, leaderTier: li.tier, isLeader: li.isLeader,
      title: '业绩快报：净利润同比 ' + signed(np, 1) + '%、营业收入同比 ' + signed(rev, 1) + '%',
      ts: parseEMTime(e.NOTICE_DATE), link: 'https://data.eastmoney.com/yjkb/',
      source: '东方财富 · 业绩快报（' + String(e.REPORT_DATE || '').slice(0, 10) + '报告期）',
      type: 'earnings', label: '业绩快报', typeLabel: '业绩快报',
      polarity: np !== null && np >= 20 ? '利多' : np !== null && np < 0 ? '利空' : '中性',
      weight: Math.round((es.score - 50) / 5), level: es.isBeat ? 'warning' : 'info',
      focus: es.isBeat, logic: '快报为已实现业绩，用净利同比 + 营收同比双维度判断是否超预期',
      matchKw: '净利同比 ' + signed(np, 1) + '%', allTags: [], viaColumn: false, progressDowngrade: false, confidence: '中',
      sectors: [], notes: es.notes.concat(li.notes),
      isBeat: es.isBeat, beatScore: es.score, beatLevel: es.level,
      beatDir: np !== null && np >= 0 ? 1 : -1, amp: np, sentiment: Math.round((es.score - 50) * 0.8)
    };
    add(ev);
  }

  /* ④ 宏观事件：全球新闻（含译文）与主题识别，判定利多 / 利空 + 涉及板块 */
  const macroEvents = [];
  const news = (ctx.news && ctx.news.items) || (Array.isArray(ctx.news) ? ctx.news : []);
  for (const n of news) {
    const title = String(n.displayTitle || n.titleZh || n.title || '');
    if (!title) continue;
    const text = title + ' ' + String(n.descZh || n.desc || '');
    const topics = detectTopics(title).map(t => t.id);
    let found = null;
    for (const r of MACRO_RULES) {
      const k = hit(text, r.kw);
      if (!k) continue;
      if (!found || r.weight > found.r.weight) found = { r, k };
    }
    if (!found) continue;
    const r = found.r;
    const importance = Number(n.importance) || 40;
    macroEvents.push({
      id: 'macro:' + (n.id || hash(title)), title, ts: n.publishedAt || now,
      link: n.link || null, source: n.source || '全球新闻',
      type: r.id, label: r.label, polarity: r.polarity,
      weight: r.weight, kw: found.k, importance,
      benefit: r.benefit, hurt: r.hurt, logic: r.logic, topics
    });
  }

  // 宏观板块净倾向：同一板块多事件累加后按 sqrt 收缩，避免单条刷屏主导
  const sectorMap = new Map();
  for (const e of macroEvents) {
    const w = e.weight * (0.6 + e.importance / 200) * Math.pow(0.5, Math.max(0, (now - e.ts) / 3600000) / 36);
    for (const s of e.benefit) {
      const cur = sectorMap.get(s) || { sector: s, score: 0, positive: 0, negative: 0, themes: new Set() };
      cur.score += w; cur.positive++; cur.themes.add(e.label); sectorMap.set(s, cur);
    }
    for (const s of e.hurt) {
      const cur = sectorMap.get(s) || { sector: s, score: 0, positive: 0, negative: 0, themes: new Set() };
      cur.score -= w * 0.75; cur.negative++; cur.themes.add(e.label); sectorMap.set(s, cur);
    }
  }
  const sectorBias = Array.from(sectorMap.values())
    .map(s => ({ ...s, themes: Array.from(s.themes).slice(0, 3),
      score: Math.round(clamp(s.score / Math.max(1, Math.sqrt(s.positive + s.negative)) * 4, -100, 100)) }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 18);

  /* ⑤ 龙头业绩的板块溢出：同行业只取最强一条，避免重复计分 */
  const spillMap = new Map();
  for (const ev of items) {
    if (ev.type !== 'earnings' || !ev.isBeat || !ev.isLeader || !ev.industry) continue;
    const leaderFactor = ev.leaderTier === '高' ? 1 : 0.65;
    // 行业信息溢出持续期远长于个股公告效应：Bernard & Thomas (1989) 的 PEAD 漂移可达 60 日，
    // 故板块联动用 15 天半衰期，而不是个股事件的 72 小时半衰期。
    const spillDecay = Math.pow(0.5, Math.max(0, ev.ageH || 0) / 360);
    const score = round(clamp((ev.beatScore / 100) * 8 * leaderFactor * spillDecay, 0, 6), 1);
    const cur = spillMap.get(ev.industry);
    if (!cur || score > cur.score) {
      spillMap.set(ev.industry, {
        industry: ev.industry, score, fromCode: ev.code, fromName: ev.name,
        fromBeatLevel: ev.beatLevel, fromAmp: ev.amp,
        reason: ev.name + '（' + ev.code + '，' + ev.leaderTier + '市值层级）' + ev.beatLevel +
          '，净利同比中值 ' + signed(ev.amp, 1) + '%，按行业内信息溢出（15 天半衰期）给同板块标的 ' +
          signed(score, 1) + ' 分'
      });
    }
  }
  const spillovers = Array.from(spillMap.values()).sort((a, b) => b.score - a.score);

  /* ⑥ 事件排序、告警附加与统计。
        告警按「股票 + 事件类型」只保留最新一条，并按级别限量，避免一轮公告流刷屏。 */
  items.sort((a, b) => (b.ts - a.ts) || (Math.abs(b.weight) - Math.abs(a.weight)));
  const cfg = { alertEnabled: opts.alertEnabled !== false };
  for (const ev of items) ev.alert = alertFor(ev, cfg);
  const alertMap = new Map();
  for (const ev of items) {
    if (!ev.alert) continue;
    const k = ev.code + '|' + ev.type + '|' + ev.alert.rule;
    const cur = alertMap.get(k);
    if (!cur || ev.ts > cur.ts) alertMap.set(k, ev);
  }
  const levelRank = { critical: 3, warning: 2, info: 1 };
  const keptAlerts = Array.from(alertMap.values())
    .sort((a, b) => (levelRank[b.alert.level] || 0) - (levelRank[a.alert.level] || 0) || b.ts - a.ts)
    .slice(0, 20);
  const keepIds = new Set(keptAlerts.map(e => e.id));
  for (const ev of items) if (!keepIds.has(ev.id)) ev.alert = null;

  const focusTypes = ['reorg', 'acquisition', 'buyback', 'reduce', 'reorg_stop', 'investigation'];
  const watchMap = new Map();
  for (const e of items) {
    if (!e.focus || !focusTypes.includes(e.type)) continue;
    const k = e.code + '|' + e.type; // 同一重组预案常有多份摘要文件，只保留最新一条
    const cur = watchMap.get(k);
    if (!cur || e.ts > cur.ts) watchMap.set(k, e);
  }
  const watchlist = Array.from(watchMap.values()).sort((a, b) => b.ts - a.ts).slice(0, 40);
  const earningsBeats = items.filter(e => e.type === 'earnings' && e.isBeat);
  const leaderBeats = earningsBeats.filter(e => e.isLeader);
  const counts = {
    total: items.length, corporate: items.filter(e => e.type !== 'earnings').length,
    earnings: items.filter(e => e.type === 'earnings').length,
    positive: items.filter(e => e.polarity === '利多').length,
    negative: items.filter(e => e.polarity === '利空').length,
    focus: watchlist.length, earningsBeats: earningsBeats.length,
    leaderBeats: leaderBeats.length, macro: macroEvents.length,
    alerts: items.filter(e => e.alert).length
  };
  const signature = hash([
    items.slice(0, 80).map(e => e.id + ':' + e.weight).join(','),
    sectorBias.map(s => s.sector + ':' + s.score).join(','),
    spillovers.map(s => s.industry + ':' + s.score).join(','),
    macroEvents.length
  ].join('|'));

  return {
    ok: true, version: 1, generatedAt: now, signature,
    source: '东方财富公告 / 业绩预告 / 业绩快报 + 全球新闻流',
    items: items.slice(0, 160), watchlist, macroEvents: macroEvents.slice(0, 60),
    sectorBias, spillovers, counts,
    sourcesOk: (raw && raw.sourcesOk) || {},
    warnings: (raw && raw.warnings) || [],
    rawGeneratedAt: (raw && raw.generatedAt) || null,
    fromCache: !!(raw && raw.fromCache),
    conclusion: buildEventConclusion(counts, sectorBias, leaderBeats),
    methodology: {
      classification: '公司事件按「公告标题 + 东财栏目」双重关键词匹配 18 类规则（重组/收购/回购/减持/增持/重大合同/解禁/立案/质押/诉讼/审批/分红等），规则顺序即优先级；情感词典只作方向一致性折减，不覆盖规则结论',
      earnings: '业绩超预期得分 = 预告类型基准（预增/略增/扭亏/预减/首亏等）+ log2 幅度的非线性加分 + 「超预期/不及预期」文本 + 损益质量（扣非主营 +5、政府补助/卖资产 −10）。快报用净利同比 + 营收同比双维度。A 股 PEAD 方向不稳健，仅大幅预增与高质量驱动给高置信',
      corporate: '重大重组、拟收购、股份回购、重要股东减持为用户指定重点关注项，单独进入 watchlist 与告警；减持按 A 股事件研究（公告后 CAR 转负）定为利空；重组终止、立案调查、退市风险单列为强利空',
      macro: '全球新闻按 12 组宏观事件规则判定对权益整体的利多/利空，并显式给出受益板块与受损板块；板块净倾向按事件重要度 × 36 小时半衰期加权，除以事件数平方根收缩',
      spillover: '龙头（流通市值 ≥ 配置阈值或 ≥ 200 亿）超预期业绩 → 按东财行业名给同板块标的加分，同行业只取最强一条；依据 intra-industry information transfer（Firth 1976 / Foster 1981 / Ramnath 2002 / Liu et al. 2022）',
      alert: '龙头业绩超预期为 critical，重大重组/收购/回购/减持为 warning，其他超预期为 info；按事件 ID 去重，冷启动建立基线不推送历史积压',
      references: [
        'Amihud (2002) Illiquidity and Stock Returns；Kyle (1985) Continuous Auctions and Insider Trading',
        'Ball & Brown (1968) / Bernard & Thomas (1989) PEAD；杨德明等 (2007)《盈利质量、投资者非理性行为与盈余惯性》',
        '朱茶芬/李志文/陈超《A股市场上大股东减持的时机选择和市场反应研究》',
        'Firth (1976) / Foster (1981) / Ramnath (2002) intra-industry information transfer；Liu et al. (2022, JAPP) 中国证据',
        '华泰金工《基于趋势和拐点的市值因子择时模型》(2025)、《金工：小盘或率先开展反弹》(2026)',
        'github.com/virattt/ai-hedge-fund（signals/pead.py）、github.com/aniketnmishra/PEAD、github.com/gen-li/Replicate_PEAD',
        'github.com/simonlin1212/a-stock-data（A 股公告/事件数据层）、github.com/hzzqq/StockSignal（A 股事件驱动回溯）'
      ]
    },
    disclaimer: '事件方向为规则推理，公告标题不等于事实（重组可能终止、回购可能不执行、预增可能来自非经常性损益或低基数）；A 股 PEAD 样本外方向不稳健，大幅预增才较稳定；T+1 与涨跌停下利好可能已一字板无法成交。事件与板块联动仅作横截面相对修正，不构成投资建议或收益承诺。'
  };
}

function buildEventConclusion(counts, sectorBias, leaderBeats) {
  const bits = [];
  bits.push('共识别公司事件 ' + counts.total + ' 条（利多 ' + counts.positive + ' / 利空 ' + counts.negative +
    '），其中重点关注 ' + counts.focus + ' 条、业绩超预期 ' + counts.earningsBeats + ' 条');
  if (leaderBeats.length) {
    bits.push('龙头超预期 ' + leaderBeats.length + ' 家：' +
      leaderBeats.slice(0, 3).map(e => e.name + '（' + e.beatLevel + '）').join('、'));
  }
  const top = sectorBias.slice(0, 3);
  if (top.length) bits.push('事件利多集中在 ' + top.filter(s => s.score > 0).map(s => s.sector).join('、') +
    (top.some(s => s.score < 0) ? '；受损方向 ' + top.filter(s => s.score < 0).map(s => s.sector).join('、') : ''));
  return bits.join('。') + '。';
}

/* ------------------------------- 六、宏观状态传导（纯计算，可高频调用） ------------------------------- */

const DEFENSIVE_RE = /银行|保险|证券|公用事业|电力|热力|燃气|医药|医疗|生物|食品|饮料|白酒|农牧|养殖|黄金|贵金属|珠宝|高速|公路|铁路/;
const HIGH_BETA_RE = /半导体|软件|计算机|电子|通信|互联网|光模块|新能源|光伏|锂电|军工|消费电子|传媒|游戏|微盘/;

/**
 * 量能分档 + 单位资金弹性 + 机构避险温度。
 * 每次行情/新闻变化都可重算（无网络请求），签名变化才触发选股重评分。
 */
function buildMacroRegime(ctx = {}) {
  const now = ctx.now || Date.now();
  const style = ctx.style || {};
  const briefing = ctx.briefing || {};
  const market = ctx.market || {};
  const opts = ctx.opts || {};
  const thresholdYi = clamp(Number(opts.volumeThresholdYi) || 25000, 5000, 100000);
  const macroMax = clamp(Number(opts.macroMaxAdjust) || 10, 0, 20);
  const v = style.volume || {};
  const amountYi = finite(v.totalAmountYi) || 0;
  const percentile = finite(v.percentile);
  const below = amountYi > 0 && amountYi < thresholdYi;
  const lowPct = percentile !== null && percentile < 45;
  const veryLow = amountYi > 0 && (amountYi < thresholdYi * 0.6 || (percentile !== null && percentile < 20));

  let regime, rotationFactor, volumeNote;
  if (veryLow) {
    regime = '地量 · 极度缩量'; rotationFactor = 1.15;
    volumeNote = '两市成交显著低于阈值且处于历史低分位，增量资金匮乏，盘面以局部题材拉伸为主';
  } else if (below || lowPct) {
    regime = '存量博弈 · 板块轮动'; rotationFactor = 1;
    volumeNote = '两市成交 ' + (amountYi ? amountYi.toLocaleString('zh-CN') + ' 亿元' : '数据缺失') +
      '，低于 ' + thresholdYi.toLocaleString('zh-CN') + ' 亿元锚（或处历史低分位）；增量资金不足时以板块拉伸 / 轮动为主';
  } else if (amountYi >= thresholdYi && (percentile === null || percentile >= 65)) {
    regime = '增量行情'; rotationFactor = 0.35;
    volumeNote = '两市成交达到阈值且处历史高分位，具备普涨与权重搭台的资金条件，微小盘弹性优势相对减弱';
  } else {
    regime = '量能中性 · 结构分化'; rotationFactor = 0.6;
    volumeNote = '绝对成交额与历史分位不一致，量能信号偏结构化，弹性因子按中等强度计入';
  }

  /* 单位资金价格冲击：优先用 marketStyle 实测的 20 日四层 ILLIQ 近似；
     旧缓存 / 模块尚未重算时降级为当日单值近似，保证因子不突然失效（并显式标注）。 */
  let ce = Array.isArray(style.capitalEfficiency) ? style.capitalEfficiency.slice() : [];
  let approxElasticity = false;
  if (!ce.length && Array.isArray(style.buckets) && style.buckets.length) {
    approxElasticity = true;
    ce = style.buckets.map(b => {
      const amt = Number(b.amountYi) || 0;
      const p = Math.abs(Number(b.pct1) || 0);
      return {
        key: b.key, name: b.name, index: b.index,
        illiq: amt > 0 ? round(p / amt, 5) : 0, avgAmountYi: amt, avgAbsPct: p,
        ratioToLarge: 1, approx: true
      };
    });
    const largeC = ce.find(x => x.key === 'large');
    const base = largeC && largeC.illiq > 0 ? largeC.illiq : Math.max(...ce.map(x => x.illiq), 1e-9);
    ce.forEach(x => { x.ratioToLarge = round(x.illiq / base, 2); });
  }
  const maxRatio = clamp(Math.max(1, ...ce.map(x => Number(x.ratioToLarge) || 1)), 2, 80);
  const denom = Math.log(1 + maxRatio) || 1;
  const reliability = approxElasticity ? 0.5 : 1; // 当日单值近似 → 半权重，待 20 日均值恢复
  const elasticity = ce.map(x => {
    const ratio = clamp(Number(x.ratioToLarge) || 1, 1, maxRatio);
    const norm = clamp(Math.log(1 + ratio) / denom, 0, 1);
    return { ...x, norm: round(norm, 3), reliability,
      rawBoost: round(norm * 8 * rotationFactor * reliability, 2) };
  });
  // 单调化：Amihud(2002) / Kyle(1985) 的理论结论是「单位资金价格冲击随市值下降而上升」，
  // 单日或短样本实测噪声可能让中盘反而高于微盘。用理论层级先验 {1, .72, .40, .12} 作上限，
  // 再按 micro→small→mid→large 取前缀最小值，保证弹性加成单调且不脱离实测幅度。
  const tierPrior = { micro: 1, small: 0.72, mid: 0.40, large: 0.12 };
  const boostCap = 8 * rotationFactor * reliability;
  let prevBoost = Infinity;
  for (const key of ['micro', 'small', 'mid', 'large']) {
    const e = elasticity.find(x => x.key === key);
    if (!e) continue;
    e.rawBoost = round(Math.min(e.rawBoost, prevBoost, boostCap * tierPrior[key]), 2);
    prevBoost = e.rawBoost;
  }

  /* 机构避险：新闻风险温度 + 高风险主题占比 + 外围 regime + 黄金/美元动量 */
  const riskTemp = clamp(Number(briefing.riskTemperature) || 0, 0, 100);
  const themes = Array.isArray(briefing.themes) ? briefing.themes : [];
  const riskyIds = ['geopolitics', 'safehaven', 'recession', 'tightening', 'trade'];
  const riskyCount = themes.filter(t => riskyIds.includes(t.id)).reduce((s, t) => s + (t.count || 0), 0);
  const coreCount = Math.max(1, (briefing.counts && briefing.counts.total) || 0);
  const themeShare = clamp(riskyCount / coreCount, 0, 1);
  const marketDrag = clamp(-(Number(market.score) || 0) * 2, 0, 100);
  const byId = new Map((ctx.quotes || []).map(q => [q.id, q]));
  const pct = id => { const q = byId.get(id); return q ? clamp(finite(q.changePct) || 0, -8, 8) : 0; };
  const goldDxy = clamp((pct('xau') || pct('gold')) * 8 + pct('dxy') * 8, 0, 100);
  // 外围股市：美股三大指数隔夜（A 股早盘）/盘中（晚间）涨跌，跌得越狠避险温度越高。
  // 至少两个指数有报价才参与合成；涨不加分（外围大涨不等于 A 股必涨），只度量下行拖累。
  const ovsVals = ['spx', 'ndx', 'dji'].map(id => byId.get(id))
    .filter(Boolean).map(q => clamp(finite(q.changePct) || 0, -8, 8));
  const overseasEquity = ovsVals.length >= 2
    ? round(ovsVals.reduce((s, v) => s + v, 0) / ovsVals.length, 2) : null;
  const overseasDrag = overseasEquity === null ? 0 : clamp(-overseasEquity * 12, 0, 100);
  const riskOffEnabled = opts.riskOffEnabled !== false;
  const riskOffScore = riskOffEnabled ? Math.round(clamp(
    overseasEquity === null
      // 原配方（外围股指不可用时保持既有行为）
      ? 0.34 * riskTemp + 0.24 * themeShare * 100 + 0.26 * marketDrag + 0.16 * goldDxy
      // 含外围股市：美股隔夜大跌直接抬升避险温度（权重 0.20，其余四项等比收缩）
      : 0.28 * riskTemp + 0.20 * themeShare * 100 + 0.20 * marketDrag + 0.12 * goldDxy + 0.20 * overseasDrag
    , 0, 100)) : 0;
  const riskOffLevel = riskOffScore >= 65 ? '高' : riskOffScore >= 40 ? '中' : '低';
  const riskOffFactor = round(clamp((riskOffScore - 25) / 60, 0, 1), 2);
  const drivers = [
    '消息面风险温度 ' + riskTemp + '/100',
    '高风险主题占比 ' + Math.round(themeShare * 100) + '%（地缘/避险/衰退/紧缩/贸易）',
    '外围状态 ' + (market.regime || '无数据') + ' ' + (Number(market.score) || 0),
    '黄金/美元动量 ' + round(goldDxy, 1),
    '外围股市 ' + (overseasEquity === null ? '暂无数据' : '美股均值 ' + overseasEquity + '%（道指/标普/纳指）'),
    riskOffEnabled ? '避险检测已启用' : '避险检测已按配置关闭'
  ];

  /* 弹性加成与避险修正的相互制约：避险升温时抑制微盘弹性（避免矛盾信号叠加） */
  const suppress = round(1 - riskOffFactor * 0.6, 2);
  const bucketAdjust = {};
  for (const e of elasticity) bucketAdjust[e.key] = round(e.rawBoost * suppress, 2);
  const defensiveLift = round(4 * riskOffFactor, 2);
  const highBetaDrag = round(-3 * riskOffFactor, 2);
  for (const k of ['micro', 'small', 'mid', 'large']) {
    if (bucketAdjust[k] === undefined) bucketAdjust[k] = 0;
  }
  // 避险修正强度刻意低于弹性项：中等避险不应完全反转「缩量利好微小盘」的结论，
  // 只有避险温度很高时大盘/防御才会明显占优。
  bucketAdjust.large = round(bucketAdjust.large + 2.0 * riskOffFactor, 2);
  bucketAdjust.mid = round(bucketAdjust.mid + 0.5 * riskOffFactor, 2);
  bucketAdjust.small = round(bucketAdjust.small - 1.2 * riskOffFactor, 2);
  bucketAdjust.micro = round(bucketAdjust.micro - 2.2 * riskOffFactor, 2);
  for (const k of Object.keys(bucketAdjust)) bucketAdjust[k] = round(clamp(bucketAdjust[k], -macroMax, macroMax), 2);

  const micro = elasticity.find(x => x.key === 'micro');
  const large = elasticity.find(x => x.key === 'large');
  const conclusion = '两市 ' + (amountYi ? amountYi.toLocaleString('zh-CN') + ' 亿元' : '数据缺失') +
    '（阈值 ' + thresholdYi.toLocaleString('zh-CN') + ' 亿元，近 ' + (v.historyDays || 0) + ' 日分位 ' +
    (percentile === null ? '--' : percentile + '%') + '）→ ' + regime + '。' +
    (micro && large ? (approxElasticity ? '当日近似单位资金价格冲击' : '实测单位资金价格冲击（近20日均值）') +
      '：微盘为大盘的 ' + micro.ratioToLarge + ' 倍（每亿元推动 ' +
      micro.illiq + '% vs ' + large.illiq + '%），' +
      (below || lowPct ? '存量博弈下少量资金即可拉动微小盘，也意味着下跌时同样容易砸盘，弹性加成 ' +
        round(bucketAdjust.micro, 2) + '/' + round(bucketAdjust.small, 2) + ' 分' : '增量环境下弹性优势按 ' + rotationFactor + ' 系数折减') + '。' : '') +
    '机构避险温度 ' + riskOffScore + '/100（' + riskOffLevel + '），' +
    (riskOffLevel === '低' ? '未见显著避险压力' : '偏好大盘与防御板块、回避微盘高波动，弹性加成已按 ×' + suppress + ' 抑制') +
    (approxElasticity ? '。弹性当前为当日单值近似，量能模块重算后自动替换为 20 日均值' : '');

  // 签名只取量化后的稳定量：行情每 15 秒的微小波动不应触发观察池反复重评分。
  const signature = hash([
    regime, amountYi, percentile, thresholdYi, below ? 1 : 0,
    elasticity.map(x => x.key + ':' + x.rawBoost.toFixed(1)).join(','),
    Math.round(riskOffScore / 5) * 5, riskOffLevel, macroMax,
    Object.keys(bucketAdjust).sort().map(k => k + ':' + bucketAdjust[k].toFixed(1)).join(',')
  ].join('|'));

  return {
    ok: true, generatedAt: now, signature,
    volume: {
      amountYi, thresholdYi, percentile, historyDays: v.historyDays || 0,
      state: v.state || '', changePct: v.changePct || 0, ratio20: v.ratio20 || 1,
      regime, rotationFactor, note: volumeNote,
      calibration: '绝对阈值来自用户设定，同时用近 ' + (v.historyDays || 0) +
        ' 个交易日成交额历史分位校准；上市公司数量与总市值增长会使绝对阈值漂移，分位更稳健'
    },
    elasticity, approxElasticity, riskOff: {
      score: riskOffScore, level: riskOffLevel, factor: riskOffFactor,
      overseasEquity,
      drivers, suppress, defensiveLift, highBetaDrag,
      preference: riskOffLevel === '低' ? '无明显避险偏向'
        : '机构倾向大盘 / 低波动 / 防御（银行、公用、医药、必选消费、贵金属），回避微盘与高估值成长'
    },
    bucketAdjust, conclusion,
    methodology: {
      volumeRegime: '用户指定的 2.5 万亿元为「存量博弈 / 增量行情」分界锚，叠加近 70 日成交额历史分位校准（华泰金工 2025）：低于阈值或分位 <45% → 板块拉伸轮动；达到阈值且分位 ≥65% → 增量行情',
      elasticity: '单位资金价格冲击 = 近 20 日 |指数涨跌%| 均值 ÷ 代理指数成交额（亿元），Amihud(2002) ILLIQ / Kyle(1985) λ 的层级化近似；四层用 log 归一化，并以理论层级先验 {1, .72, .40, .12} 做单调约束（避免短样本噪声让中盘反而高于微盘）。存量博弈按 1.0 系数、地量 1.15、增量行情 0.35 折减；仅有当日单值近似时整体 ×0.5。数值是双向的：拉升容易，砸盘也容易',
      riskOff: '消息面风险温度 34% + 高风险主题占比 24% + 外围避险状态 26% + 黄金/美元动量 16%；避险升温时按 (1 − 0.6×避险系数) 抑制微小盘弹性，并对大盘/防御行业加分、微盘与高波动成长减分；修正强度低于弹性项，只有高避险才会反转风格结论。依据 Ang et al.(2006) 低波异象与 flight-to-quality',
      orthogonal: '宏观修正与既有量能风格因子方向不同：风格分刻画「资金实际去了哪一层」，弹性/避险刻画「当前环境下哪一层更容易被推动、机构愿意持有哪一层」；两者分别设 ±上限，避免过度叠加'
    },
    disclaimer: '存量博弈与避险判断均为规则推理的环境刻画，不是资金流测量或涨跌预测。单位资金冲击为代理指数的相对口径（指数成交额≠成分股总成交额）；70 日样本不足以估多年分位。A 股 T+1、涨跌停与微盘流动性风险另行考虑。'
  };
}

/* ------------------------------- 七、选股因子（个股级修正） ------------------------------- */

/** 事件因子：自身公司事件 + 龙头业绩板块溢出 + 宏观事件板块倾向（低权重，避免与主题因子重复） */
function eventAdjustFor(stock, events, opts = {}) {
  const neutral = {
    adjustment: 0, own: 0, spillover: 0, sector: 0, polarity: '中性',
    hits: [], reasons: ['暂无公司事件或板块联动数据，事件因子按中性 0 计'], available: false
  };
  if (!events || !events.ok || !Array.isArray(events.items)) return neutral;
  const code = String(stock.code || '');
  const industry = String(stock.industry || '');
  const maxAdjust = clamp(Number(opts.maxAdjust) || 12, 0, 24);
  const now = Date.now();

  const hits = events.items.filter(e => e.code === code && Number(e.weight) !== 0);
  // 同一股票多条事件：取最强一条全额，其余按 0.3 累加并做时间衰减
  const weighted = hits.map(e => ({
    e, v: e.weight * Math.pow(0.5, Math.max(0, (now - (e.ts || now)) / 3600000) / 72)
  })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  let own = 0;
  weighted.forEach((w, i) => { own += w.v * (i === 0 ? 1 : 0.3); });
  own = round(clamp(own, -maxAdjust, maxAdjust), 1);

  const spill = (events.spillovers || []).filter(s =>
    s.industry && industry && (industry.includes(s.industry) || s.industry.includes(industry)) &&
    s.fromCode !== code);
  const spillover = spill.length ? round(clamp(Math.max(...spill.map(s => s.score)), 0, 6), 1) : 0;

  const sectorHits = (events.sectorBias || []).filter(s =>
    industry && (industry.includes(s.sector) || s.sector.includes(industry)));
  const sector = sectorHits.length
    ? round(clamp(Math.max(...sectorHits.map(s => Math.abs(s.score))) * Math.sign(sectorHits[0].score) * 0.04, -4, 4), 1)
    : 0;

  const adjustment = round(clamp(own + spillover + sector, -maxAdjust, maxAdjust), 1);
  const reasons = [];
  if (weighted.length) {
    const top = weighted[0].e;
    reasons.push('公司事件：' + top.typeLabel + '（' + top.polarity + '，' + top.timeLabel + '）' +
      (top.isBeat ? ' · ' + top.beatLevel + '，超预期分 ' + top.beatScore + '、同比中值 ' + signed(top.amp, 1) + '%' : '') +
      ' → ' + top.title.slice(0, 60));
    if (top.logic) reasons.push('判读依据：' + top.logic);
    if (weighted.length > 1) reasons.push('同股另有 ' + (weighted.length - 1) + ' 条事件，按 0.3 权重叠加并做 72 小时半衰期衰减');
    if (top.notes && top.notes.length) reasons.push('超预期判读：' + top.notes.slice(0, 3).join('；'));
  }
  if (spillover) reasons.push('板块联动：' + spill[0].reason);
  if (sector) reasons.push('事件板块倾向：' + sectorHits.slice(0, 2).map(s => s.sector + ' ' + signed(s.score)).join('、') +
    ' ×0.04 低权重（避免与新闻主题因子重复计分）');
  if (!reasons.length) reasons.push('该股近 ' + ((opts.lookbackDays) || 14) + ' 天无公司事件，也无同行业龙头业绩溢出，事件因子按中性 0 计');
  reasons.push('事件修正合计 ' + signed(adjustment, 1) + ' 分 = 自身 ' + signed(own, 1) +
    ' + 板块溢出 ' + signed(spillover, 1) + ' + 板块倾向 ' + signed(sector, 1) + '（上限 ±' + maxAdjust + '）');

  const polarity = adjustment > 0.8 ? '利多' : adjustment < -0.8 ? '利空' : '中性';
  return {
    adjustment, own, spillover, sector, polarity, available: true,
    hitCount: hits.length, isBeat: hits.some(e => e.isBeat),
    isLeader: hits.some(e => e.isLeader),
    watchItem: weighted.length ? {
      type: weighted[0].e.type, label: weighted[0].e.typeLabel, polarity: weighted[0].e.polarity,
      title: weighted[0].e.title, beatLevel: weighted[0].e.beatLevel || null,
      beatScore: weighted[0].e.beatScore || null, timeLabel: weighted[0].e.timeLabel,
      focus: !!weighted[0].e.focus, link: weighted[0].e.link || null
    } : null,
    hits: hits.slice(0, 5).map(e => ({
      id: e.id, label: e.typeLabel, polarity: e.polarity, weight: e.weight,
      title: e.title.slice(0, 80), timeLabel: e.timeLabel, isBeat: !!e.isBeat,
      beatLevel: e.beatLevel || null, link: e.link || null
    })),
    spilloverFrom: spill.length ? spill[0].fromName : null,
    reasons
  };
}

/** 宏观因子：按流通市值归层取弹性/避险修正，再按防御 / 高波动行业微调 */
function macroAdjustFor(stock, macro, opts = {}) {
  const neutral = {
    adjustment: 0, bucketAdjust: 0, sectorAdjust: 0, reasons: ['宏观状态数据不可用，按中性 0 计'], available: false
  };
  if (!macro || !macro.ok) return neutral;
  const limit = clamp(Number(opts.macroMaxAdjust) || 10, 0, 20);
  const b = marketStyle.bucketOf(finite(stock.floatCap));
  const key = b ? b.key : 'mid';
  const bucketAdjust = Number((macro.bucketAdjust || {})[key]) || 0;
  const industry = String(stock.industry || '');
  const f = Number(macro.riskOff && macro.riskOff.factor) || 0;
  let sectorAdjust = 0;
  if (DEFENSIVE_RE.test(industry)) sectorAdjust = round(clamp(2.5 * f, 0, 3), 1);
  else if (HIGH_BETA_RE.test(industry)) sectorAdjust = round(clamp(-2 * f, -2.5, 0), 1);
  const adjustment = round(clamp(bucketAdjust + sectorAdjust, -limit, limit), 1);
  const reasons = [
    macro.volume.regime + '：' + macro.volume.note,
    (macro.elasticity || []).filter(e => e.key === key).map(e =>
      '本层单位资金价格冲击 ' + e.illiq + '%/亿元（为大盘 ' + e.ratioToLarge + ' 倍），' +
      '环境系数 ×' + macro.volume.rotationFactor + ' → 弹性 ' + signed(e.rawBoost, 2) + ' 分').join('') ||
      '该层暂无弹性实测值',
    '避险温度 ' + macro.riskOff.score + '/100（' + macro.riskOff.level + '），弹性按 ×' +
      macro.riskOff.suppress + ' 抑制；' + macro.riskOff.preference,
    '市值层「' + (b ? b.name : '未分层') + '」修正 ' + signed(bucketAdjust, 2) +
      ' 分 + 行业属性 ' + signed(sectorAdjust, 1) + ' 分 = ' + signed(adjustment, 1) + ' 分（上限 ±' + limit + '）'
  ];
  return {
    adjustment, bucketAdjust, sectorAdjust, available: true,
    bucket: key, bucketLabel: b ? b.name : '未分层',
    volumeRegime: macro.volume.regime, riskOffScore: macro.riskOff.score,
    riskOffLevel: macro.riskOff.level, reasons
  };
}

module.exports = {
  refreshRawEvents, buildEventView, buildMacroRegime,
  eventAdjustFor, macroAdjustFor, earningsScore,
  CORPORATE_RULES, MACRO_RULES, EARNINGS_TYPES,
  CACHE_FILE
};
