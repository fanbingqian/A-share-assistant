'use strict';

/**
 * calendar.js — 万年日历 + 确定性事件库 + A股周期事件 + 自动提醒
 *
 * 【事件来源分级（诚实标注，绝不把推算冒充已公布）】
 *   A = 制度性/官方已公布的具体日期（如财报披露截止日、全国两会开幕月）
 *   B = 制度性规律推算，具体日期待官方确认（如 FOMC 会议月、政治局会议）
 *   C = 历史季节性规律，仅作观察线索（如迎峰度夏用电、煤炭旺季）
 *   自定义 = 用户在界面手工录入，标注 source='user'
 *
 * 【能力】
 *   - 万年日历：任意年月，返回当日/当月事件
 *   - 周期性事件：按规则在任意年份生成（业绩披露季、医保目录、非农、CPI 等）
 *   - 自动提醒：未来 N 天内的事件推送到告警流（由 server 定时器调用 dueReminders）
 *   - 智能体解读：eventImpact() 走 Hermes 桥接，说明事件可能影响哪些板块（不改分）
 *
 * 【落盘】data/calendar/events.jsonl（用户自定义 + 数据源写入）、data/calendar/reminders.json（提醒已发去重）
 */

const fs = require('node:fs');
const path = require('node:path');
const usHolidays = require('./us-market-holidays');

const DIR = path.join(__dirname, '..', 'data', 'calendar');
const USER_FILE = path.join(DIR, 'events.jsonl');
const REM_FILE = path.join(DIR, 'reminders.json');

function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    .map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
}
function appendJsonl(file, obj) { ensureDir(); fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8'); }
function ymd(y, m, d) { return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
function bjToday() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }

/* ------------------------------ 周期性事件规则 ------------------------------ */
// 每条规则：{ id, name, grade, category, months:[...], dayRule(y,m)->day|null, detail, sectors[] }
// dayRule 返回 null 表示该月无此事件；规则只给「月 + 大致日」，B/C 级明确标注待核实。

const RULES = [
  // —— A 级：制度性确定窗口（披露截止、两会开幕等硬性制度日）——
  { id: 'cn-annual-report', name: 'A股年报披露截止', grade: 'A', category: '业绩', months: [4], dayRule: (y, m) => 30, detail: '年报披露最后期限（1/1–4/30），业绩集中发布，是业绩预增/高送转与业绩暴雷集中兑现窗口', sectors: ['全市场', '高送转', '业绩预增'] },
  { id: 'cn-q1-report', name: 'A股一季报披露截止', grade: 'A', category: '业绩', months: [4], dayRule: (y, m) => 30, detail: '一季报披露最后期限（4/1–4/30），验证开年景气度', sectors: ['全市场'] },
  { id: 'cn-h1-report', name: 'A股中报披露截止', grade: 'A', category: '业绩', months: [8], dayRule: (y, m) => 31, detail: '半年报披露最后期限（7/1–8/31）', sectors: ['全市场'] },
  { id: 'cn-q3-report', name: 'A股三季报披露截止', grade: 'A', category: '业绩', months: [10], dayRule: (y, m) => 31, detail: '三季报披露最后期限（10/1–10/31）', sectors: ['全市场'] },
  { id: 'cn-annual-preannounce', name: '年报业绩预告窗口', grade: 'A', category: '业绩', months: [1], dayRule: (y, m) => 31, detail: '年报预告集中披露（符合条件者1月底前）', sectors: ['业绩预增', '业绩预亏'] },
  { id: 'cn-h1-preannounce', name: '中报业绩预告窗口', grade: 'A', category: '业绩', months: [7], dayRule: (y, m) => 15, detail: '中报预告集中披露（符合条件者7/15前）', sectors: ['业绩预增', '业绩预亏'] },
  { id: 'cn-lianghui', name: '全国两会', grade: 'A', category: '中国重要会议', months: [3], dayRule: (y, m) => 5, detail: '全国人大/政协会议通常3月初开幕，政府工作报告定调当年增长目标、财政赤字与产业政策，具体日期以官方公告为准', sectors: ['政策主题', '新质生产力', '扩内需'] },

  // —— B 级：制度性规律 / 已确认国际会议（具体日期以主办方公告为准）——
  { id: 'fomc', name: '美联储 FOMC 议息会议', grade: 'B', category: '全球央行', months: [1, 3, 5, 6, 7, 9, 10, 12], dayRule: () => null, detail: '每年约8次，议息决定与点阵图影响美债利率、美元与全球风险偏好；具体两日会议日期以 Federal Reserve 官网公布为准', sectors: ['黄金', '美债', '美元', '北向资金'] },
  { id: 'us-nfp', name: '美国非农就业报告', grade: 'B', category: '海外指标', months: [1,2,3,4,5,6,7,8,9,10,11,12], dayRule: (y, m) => firstFriday(y, m), detail: '通常为每月第一个周五（北京时间晚间），就业强弱直接影响降息预期、美元与黄金；以 BLS 日历为准', sectors: ['黄金', '美元', '美债'] },
  { id: 'us-cpi', name: '美国 CPI 发布', grade: 'B', category: '海外指标', months: [1,2,3,4,5,6,7,8,9,10,11,12], dayRule: (y, m) => 13, detail: '通常在每月中旬发布，通胀超预期会压制成长股估值；以 BLS 日历为准', sectors: ['黄金', '美债', '成长股'] },
  { id: 'cn-politburo', name: '中央政治局会议（经济议题）', grade: 'B', category: '中国重要会议', months: [4, 7, 10, 12], dayRule: (y, m) => 24, detail: '讨论经济工作的政治局会议多在4/7/10/12月下旬，是政策转向的重要观察窗口；日期以新华社通稿为准', sectors: ['政策主题', '地产', '基建'] },
  { id: 'cn-cewc', name: '中央经济工作会议', grade: 'B', category: '中国重要会议', months: [12], dayRule: (y, m) => 18, detail: '通常12月中下旬召开，正式定调次年宏观政策总基调（财政/货币/地产/产业政策）；日期以官方公告为准', sectors: ['政策主题', '消费', '科技'] },
  { id: 'cn-medicare', name: '国家医保目录调整', grade: 'B', category: '医药政策', months: [12], dayRule: (y, m) => 20, detail: '每年一轮，年底公布结果，谈判降价与纳入目录直接影响创新药/中药/医药商业；以国家医保局公告为准', sectors: ['创新药', '医药商业', '中药'] },

  // —— 中国宏观指标（每月固定节奏，日期为国家统计局/央行惯例，以官方日历为准）——
  { id: 'cn-pmi', name: '中国制造业 PMI', grade: 'B', category: '国内指标', months: [1,2,3,4,5,6,7,8,9,10,11,12], dayRule: (y, m) => lastDay(y, m), detail: '国家统计局每月末公布，制造业景气荣枯线（50）是顺周期板块与大盘情绪的重要先行指标', sectors: ['全市场', '煤炭', '地产', '消费'] },
  { id: 'cn-cpi-ppi', name: '中国 CPI / PPI', grade: 'B', category: '国内指标', months: [1,2,3,4,5,6,7,8,9,10,11,12], dayRule: (y, m) => 9, detail: '国家统计局通常每月9日前后公布，PPI 回升利好上游周期，CPI 影响消费与货币政策空间', sectors: ['消费', '煤炭', '农业'] },
  { id: 'cn-trade', name: '中国进出口数据', grade: 'B', category: '国内指标', months: [1,2,3,4,5,6,7,8,9,10,11,12], dayRule: (y, m) => 7, detail: '海关总署通常每月7日前后公布，出口增速影响外需链（家电/机械/纺织）与人民币汇率', sectors: ['消费', '科技', '出口链'] },
  { id: 'cn-lpr', name: 'LPR 贷款市场报价利率', grade: 'B', category: '国内指标', months: [1,2,3,4,5,6,7,8,9,10,11,12], dayRule: (y, m) => 20, detail: '每月20日（遇节假日顺延）公布，降息直接影响地产、券商与高股息资产的相对价值', sectors: ['地产', '券商', '全市场'] },
  { id: 'cn-gdp', name: '中国 GDP 季度数据', grade: 'B', category: '国内指标', months: [1, 4, 7, 10], dayRule: (y, m) => 16, detail: '季度中旬公布（1月公布上年四季度），验证增长目标完成度，是大盘方向性变量', sectors: ['全市场', '地产', '消费'] },
  { id: 'cn-social-finance', name: '中国社融 / 信贷数据', grade: 'B', category: '国内指标', months: [1,2,3,4,5,6,7,8,9,10,11,12], dayRule: (y, m) => 12, detail: '央行通常每月中旬公布，社融超预期利好顺周期与金融，是流动性宽窄的核心观测', sectors: ['券商', '地产', '全市场'] },

  // —— 国际会议 / 峰会 / 展会（已公开举办月份，具体日以主办方为准，A 级具体日见 DATED_EVENTS）——
  { id: 'wef-davos', name: '达沃斯世界经济论坛年会', grade: 'B', category: '国际会议', months: [1], dayRule: (y, m) => 18, detail: '每年1月中下旬在瑞士达沃斯举行，全球政商议题风向标，影响科技、能源与全球化叙事；已公布年份用具体日期（见已确认日历）', sectors: ['科技', '新能源', '全市场'] },
  { id: 'ces', name: 'CES 国际消费电子展', grade: 'B', category: '国际展会', months: [1], dayRule: (y, m) => 6, detail: '每年1月初拉斯维加斯举办，消费电子/AI/汽车科技风向标，催化 A 股科技与智能驾驶主题', sectors: ['科技', '消费', '汽车'] },
  { id: 'mwc', name: 'MWC 世界移动通信大会', grade: 'B', category: '国际展会', months: [2, 3], dayRule: (y, m) => 27, detail: '每年2月底至3月初巴塞罗那举办，通信与终端产业链催化明显', sectors: ['科技', '通信'] },
  { id: 'g20', name: 'G20 领导人峰会', grade: 'B', category: '国际会议', months: [9, 10, 11], dayRule: () => null, detail: '每年一次，主办国与日期由轮值主席国公布，议题多为全球增长、贸易与金融治理', sectors: ['全市场', '黄金', '出口链'] },
  { id: 'apec', name: 'APEC 领导人非正式会议', grade: 'B', category: '国际会议', months: [9, 10, 11], dayRule: () => null, detail: '每年9–11月由东道主择日举行，2026 年由深圳主办；影响亚太自贸区与区域合作主题', sectors: ['出口链', '科技', '消费'] },
  { id: 'brics', name: '金砖国家峰会', grade: 'B', category: '国际会议', months: [6, 7, 8, 9, 10], dayRule: () => null, detail: '年度峰会由轮值主席国确定时间，议题含本币结算、产业链合作', sectors: ['黄金', '出口链', '基建'] },
  { id: 'boao', name: '博鳌亚洲论坛年会', grade: 'B', category: '国际会议', months: [3, 4], dayRule: (y, m) => 25, detail: '每年3月底至4月在海南博鳌举行，亚洲经济一体化与开放政策信号', sectors: ['消费', '地产', '旅游'] },
  { id: 'cop', name: '联合国气候变化大会 COP', grade: 'B', category: '国际会议', months: [10, 11, 12], dayRule: () => null, detail: '年度气候谈判，影响新能源、碳交易与能源转型政策预期', sectors: ['新能源', '电力', '煤炭'] },
  { id: 'opec', name: 'OPEC+ 石油政策会议', grade: 'B', category: '国际会议', months: [1,2,3,4,5,6,7,8,9,10,11,12], dayRule: () => null, detail: '原油产量决策影响国际油价，传导至石油石化、航运与化工；具体日期以 OPEC 公告为准', sectors: ['石油', '化工', '航运'] },

  // —— 中国展会 / 旺季（时间相对固定）——
  { id: 'ciie', name: '中国国际进口博览会', grade: 'B', category: '国内展会', months: [11], dayRule: (y, m) => 5, detail: '每年11月初上海举办，进口与开放政策信号，催化消费、医药与高端制造', sectors: ['消费', '医药', '科技'] },
  { id: 'canton-fair', name: '广交会', grade: 'B', category: '国内展会', months: [4, 10], dayRule: (y, m) => 15, detail: '每年春（4月）秋（10月）两届，外贸订单风向标，影响出口链与跨境电商', sectors: ['出口链', '消费', '家居'] },
  { id: 'waic', name: '世界人工智能大会', grade: 'B', category: '国内展会', months: [7], dayRule: (y, m) => 6, detail: '每年7月上海举办，AI 大模型与算力产业链催化窗口', sectors: ['科技', '算力', '传媒'] },
  { id: 'lujiazui', name: '陆家嘴论坛', grade: 'B', category: '国内会议', months: [6], dayRule: (y, m) => 18, detail: '每年6月上海举行，央行/证监会政策发声窗口，影响券商与金融板块', sectors: ['券商', '全市场'] },
  { id: 'jinrongjie', name: '金融街论坛年会', grade: 'B', category: '国内会议', months: [10], dayRule: (y, m) => 19, detail: '每年10月北京举行，央行、金监总局、证监会集中发声，释放金融政策信号', sectors: ['券商', '地产', '全市场'] },

  // —— 美股财报季（业绩密集窗口）——
  { id: 'us-earnings', name: '美股财报季', grade: 'B', category: '海外业绩', months: [1, 4, 7, 10], dayRule: () => null, detail: '美股头部科技/消费企业财报密集披露，影响全球风险偏好与 A 股映射主题；具体个股日历以公司公告为准', sectors: ['科技', '消费', '成长股'] },

  // —— C 级：季节性规律，仅观察线索 ——
  { id: 'coal-peak', name: '煤炭迎峰度冬/度夏', grade: 'C', category: '涨价周期', months: [1, 7, 8, 11, 12], dayRule: () => null, detail: '冬季供暖与夏季高温用电高峰，动力煤价格季节性偏强；仅为历史规律观察', sectors: ['煤炭', '电力', '煤化工'] },
  { id: 'power-demand', name: '电力负荷高峰', grade: 'C', category: '涨价周期', months: [7, 8], dayRule: () => null, detail: '迎峰度夏电网负荷高峰，火电/水电利用小时与电价季节性变化；仅为历史规律', sectors: ['电力', '电网设备'] },
  { id: 'travel-peak', name: '春运 / 暑运高峰', grade: 'C', category: '季节性消费', months: [1, 2, 7, 8], dayRule: () => null, detail: '出行高峰催化航空、机场、酒店、旅游与白酒消费；仅为季节性观察', sectors: ['旅游', '消费', '交通'] },
  { id: 'shopping-festival', name: '618 / 双11 购物节', grade: 'C', category: '季节性消费', months: [6, 11], dayRule: (y, m) => (m === 6 ? 18 : 11), detail: '电商大促，催化消费、物流与零售；仅为季节性观察', sectors: ['消费', '物流'] }
];

/** 已核实具体日期的确定事件（未来），来源为官方网站/权威媒体；dates 为闭区间起止日 */
const DATED_EVENTS = [
  { id: 'D-apec-2026', name: 'APEC 第三十三次领导人非正式会议（深圳）', ruleId: 'apec', grade: 'A', category: '国际会议', date: '2026-11-18', endDate: '2026-11-19', detail: '2026年11月18–19日在广东深圳举行，中国第三次主办 APEC。来源：央视新闻/新华社。关注亚太自贸区、跨境支付、AI 普惠与绿色供应链议题。', sectors: ['出口链', '科技', '消费'], source: 'official', confirmed: true },
  { id: 'D-us-tariff-2027', name: '中美部分关税暂停政策到期', ruleId: 'us-tariff', grade: 'A', category: '政策到期', date: '2027-01-10', endDate: null, detail: '2027年1月10日中美部分关税暂停政策到期，需关注贸易政策变化对出口链与人民币的影响。来源：公开政策日历。', sectors: ['出口链', '黄金', '全市场'], source: 'policy-calendar', confirmed: true },
  { id: 'D-ces-2027', name: 'CES 2027 国际消费电子展', ruleId: 'ces', grade: 'A', category: '国际展会', date: '2027-01-06', endDate: '2027-01-09', detail: '2027年1月6–9日美国拉斯维加斯举办，60周年，主题涵盖 AI、机器人、数字健康、智能家居。来源：CES 官网。', sectors: ['科技', '消费', '汽车'], source: 'official', confirmed: true },
  { id: 'D-davos-2027', name: '达沃斯世界经济论坛 2027 年会', ruleId: 'wef-davos', grade: 'A', category: '国际会议', date: '2027-01-18', endDate: '2027-01-22', detail: '2027年1月18–22日在瑞士达沃斯举行，主题「Deliberate Conversations on the Future」，五大议题：人、技术、增长、地球、地缘经济。来源：世界经济论坛官网。', sectors: ['科技', '新能源', '全市场'], source: 'official', confirmed: true },
  { id: 'D-cewc-2026', name: '中央经济工作会议（12月窗口）', ruleId: 'cn-cewc', grade: 'B', category: '中国重要会议', date: '2026-12-18', endDate: null, detail: '按惯例12月中下旬召开，正式敲定2027年宏观政策总基调；具体日期以新华社通稿为准。来源：公开政策日历（窗口推算）。', sectors: ['政策主题', '消费', '科技'], source: 'policy-window', confirmed: false }
];

function firstFriday(y, m) {
  const d = new Date(y, m - 1, 1);
  const add = (5 - d.getDay() + 7) % 7;
  return 1 + add;
}
function lastDay(y, m) { return daysInMonth(y, m); }

/** 展开规则为具体事件（指定年月，或指定年份全年） */
function expandRules(year, month) {
  const out = [];
  const months = month ? [Number(month)] : Array.from({ length: 12 }, (_, i) => i + 1);
  for (const r of RULES) {
    for (const m of months) {
      if (!r.months.includes(m)) continue;
      const day = r.dayRule ? r.dayRule(year, m) : null;
      // dayRule 返回 null 的事件按「月事件」呈现，日期放当月1日并标 allMonth
      const d = day == null ? 1 : Math.min(day, daysInMonth(year, m));
      out.push({
        id: r.id + '-' + ymd(year, m, d),
        ruleId: r.id,
        date: ymd(year, m, d),
        allMonth: day == null,
        name: r.name,
        grade: r.grade,
        category: r.category,
        detail: r.detail,
        sectors: r.sectors,
        source: 'rule',
        verified: r.grade === 'A'
      });
    }
  }
  // 合并「已核实具体日期」的确定事件：按 ruleId+date 覆盖同日规则推算，优先展示已确认版本
  const byKey = new Map(out.map(e => [e.ruleId + '|' + e.date, e]));
  for (const d of DATED_EVENTS) {
    const dy = Number(String(d.date).slice(0, 4));
    if (dy !== Number(year)) continue;
    if (month && Number(String(d.date).slice(5, 7)) !== Number(month)) continue;
    byKey.set((d.ruleId || d.id) + '|' + d.date, {
      id: d.id, ruleId: d.ruleId || d.id, date: d.date, endDate: d.endDate || null,
      allMonth: false, name: d.name, grade: d.grade, category: d.category,
      detail: d.detail, sectors: d.sectors, source: d.source,
      verified: !!d.confirmed, confirmed: !!d.confirmed
    });
  }
  // 美股官方交易日历（NYSE 官网 2026/2027/2028 已公布 + 2029 起规则推算）：
  // 与 A 股披露截止日 / FOMC 等一样属于确定性事件库，不经过新闻准入闸门，
  // 也不写入 events.jsonl，避免被每小时新闻扫描重复追加或当成新闻线索复核。
  for (const e of usHolidays.eventsForYear(year, month)) {
    byKey.set(e.ruleId + '|' + e.date, e);
  }
  return Array.from(byKey.values());
}

/** 读取用户自定义事件（可指定年月过滤） */
function readUserEvents(year, month) {
  let rows = readJsonl(USER_FILE);
  if (year) rows = rows.filter(r => String(r.date || '').startsWith(String(year)));
  if (month) rows = rows.filter(r => String(r.date || '').slice(5, 7) === String(month).padStart(2, '0'));
  return rows;
}

/* ---------------- 跨天行程（multi-day / spanning event） ---------------- */

/**
 * 从事件文本里抽取明确的日期区间，补 endDate（用于「某会议 20–23 日举行」这类描述）。
 * 纪律：只在「区间起始日 == 事件本身 date」时才采纳，避免把描述里的其他日期误当成本事件区间；
 *      抽取结果标注 endDateBasis + endDateInferred=true，前端可提示「文本推断」。
 */
function deriveEndDate(e) {
  if (e.endDate) return { endDate: String(e.endDate).slice(0, 10), basis: '官方/规则给定', inferred: false };
  const d = String(e.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { endDate: null, basis: null, inferred: false };
  const y0 = Number(d.slice(0, 4)), m0 = Number(d.slice(5, 7)), d0 = Number(d.slice(8, 10));
  const txt = String(e.name || '') + ' ' + String(e.detail || '');
  let m1 = null, d1 = null, m2 = null, d2 = null, yEnd = y0;
  let g = txt.match(/(\d{1,2})月(\d{1,2})日?\s*[–~—\-至到]\s*(\d{1,2})日/);
  if (g) {
    m1 = Number(g[1]); d1 = Number(g[2]); d2 = Number(g[3]);
    m2 = d2 >= d1 ? m1 : m1 + 1;
  } else {
    g = txt.match(/(\d{1,2})\s*[–~—\-至到]\s*(\d{1,2})日\s*(?:举行|召开|举办|开展|进行)/);
    if (g) {
      m1 = m0; d1 = Number(g[1]); d2 = Number(g[2]);
      m2 = d2 >= d1 ? m0 : m0 + 1;
    } else {
      g = txt.match(/(\d{4}-\d{2}-\d{2})\s*至\s*(\d{4}-\d{2}-\d{2})/);
      if (g) {
        const a = g[1].split('-').map(Number), b = g[2].split('-').map(Number);
        m1 = a[1]; d1 = a[2]; m2 = b[1]; d2 = b[2]; yEnd = b[0];
      }
    }
  }
  if (d1 == null || d2 == null) return { endDate: null, basis: null, inferred: false };
  if (m1 !== m0 || d1 !== d0) return { endDate: null, basis: null, inferred: false };
  let ey = yEnd, em = m2;
  if (em > 12) { em = 1; ey += 1; }
  const last = new Date(ey, em, 0).getDate();
  if (d2 < 1 || d2 > last || (em === m0 && ey === y0 && d2 < d1)) return { endDate: null, basis: null, inferred: false };
  const end = ey + '-' + String(em).padStart(2, '0') + '-' + String(d2).padStart(2, '0');
  if (end <= d) return { endDate: null, basis: null, inferred: false };
  return { endDate: end, basis: '事件文本时间段抽取（起止日期）', inferred: true };
}

function datePlus(ds, n) {
  const t = new Date(ds + 'T00:00:00Z').getTime() + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 当月/当日视图：合并规则事件 + 用户事件，按日期排序；跨天行程展开到区间内每一天 */
function view({ year, month, date } = {}) {
  const now = new Date(Date.now() + 8 * 3600e3);
  const y = Number(year || now.getUTCFullYear());
  const m = month ? Number(month) : now.getUTCMonth() + 1;
  const p2 = n => String(n).padStart(2, '0');
  const monthStart = y + '-' + p2(m) + '-01';
  const monthEnd = y + '-' + p2(m) + '-' + p2(daysInMonth(y, m));
  const all = expandRules(y, m).concat(readUserEvents(y, m));

  // 跨月边界补捞：起始日在上月、但结束日覆盖本月的行程，保证两侧月份都连续
  const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
  for (const e of expandRules(py, pm)) {
    const ed = e.endDate ? String(e.endDate).slice(0, 10) : null;
    if (ed && ed >= monthStart && ed <= monthEnd && String(e.date) < monthStart
      && !all.some(x => x.id === e.id && x.date === e.date)) all.push(e);
  }

  // 补全时间段：仅采纳「起始日 == 事件 date」的文本区间，标注推断来源，不臆造日期
  for (const e of all) {
    const d = deriveEndDate(e);
    if (d.endDate) { e.endDate = d.endDate; e.endDateBasis = d.basis; e.endDateInferred = d.inferred; }
  }
  all.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.grade).localeCompare(String(b.grade)));

  // 选中某日时，包含「该日处于行程区间内」的事件
  const selected = date ? all.filter(e => e.date === date ||
    (e.endDate && String(e.endDate).slice(0, 10) > e.date && date >= e.date && date <= String(e.endDate).slice(0, 10))) : all;

  const byDate = {};
  for (const e of all) {
    const start = String(e.date).slice(0, 10);
    const end = e.endDate ? String(e.endDate).slice(0, 10) : null;
    if (!end || end <= start) { (byDate[start] = byDate[start] || []).push(e); continue; }
    // FullCalendar 风格：一个跨天行程展开成连续片段，首/尾/中间段带标记，前端拼成连续横条
    let cur = start, guard = 0;
    while (cur <= end && guard++ < 62) {
      (byDate[cur] = byDate[cur] || []).push({
        ...e,
        spanId: String(e.id || (e.ruleId + '|' + e.date)),
        spanStart: start, spanEnd: end,
        spanSeg: cur === start ? 'start' : (cur === end ? 'end' : 'mid'),
        spanDays: Math.round((new Date(end + 'T00:00:00Z') - new Date(start + 'T00:00:00Z')) / 86400000) + 1,
        onDate: cur
      });
      cur = datePlus(cur, 1);
    }
  }
  return {
    ok: true,
    year: y, month: m, date: date || null,
    today: bjToday(),
    daysInMonth: daysInMonth(y, m),
    events: selected,
    byDate,
    // 供前端给日历格子加「US 休 / US 早收」角标（仅当月事件，不把推算冒充官方）
    marketClosedDates: [...new Set(all.filter(e => e.marketStatus === 'closed').map(e => String(e.date).slice(0, 10)))].sort(),
    marketEarlyCloseDates: [...new Set(all.filter(e => e.marketStatus === 'early-close').map(e => String(e.date).slice(0, 10)))].sort(),
    stats: {
      total: all.length,
      byGrade: all.reduce((a, e) => { a[e.grade] = (a[e.grade] || 0) + 1; return a; }, {}),
      byCategory: all.reduce((a, e) => { a[e.category] = (a[e.category] || 0) + 1; return a; }, {}),
      spanningEvents: all.filter(e => e.endDate && String(e.endDate).slice(0, 10) > String(e.date).slice(0, 10)).length
    },
    note: 'A=制度性/官方确定日期；B=制度性规律推算、具体日待官方确认；C=历史季节性规律，仅作观察线索。跨天行程按起止区间展开为连续色条；规则事件日期不自动生成买卖建议。'
  };
}

/** 未来 N 天内即将到来的事件（用于提醒与首页） */
function upcoming({ days = 30, from } = {}) {
  const start = from || bjToday();
  const s = new Date(start + 'T00:00:00Z');
  const end = new Date(s.getTime() + days * 86400e3);
  const years = new Set([s.getUTCFullYear(), end.getUTCFullYear()]);
  const list = [];
  for (const y of years) list.push(...expandRules(y, null));
  list.push(...readUserEvents());
  const fromStr = start, toStr = end.toISOString().slice(0, 10);
  return list.filter(e => e.date >= fromStr && e.date <= toStr)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* ------------------------------ 提醒 ------------------------------ */

function loadReminders() {
  try { if (fs.existsSync(REM_FILE)) return JSON.parse(fs.readFileSync(REM_FILE, 'utf8')); } catch (_) {}
  return { sent: {} };
}
function saveReminders(r) {
  ensureDir();
  const tmp = REM_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(r), 'utf8');
  fs.renameSync(tmp, REM_FILE);
}

/**
 * 计算应提醒的事件（去重）。返回 [{ id, name, date, grade, daysTo, message }]
 * 由 server 定时调用，把结果并入告警流；前端也据此弹框。
 */
function dueReminders({ aheadDays = 7, now } = {}) {
  const today = now || bjToday();
  const state = loadReminders();
  const ups = upcoming({ days: aheadDays, from: today });
  const due = [];
  for (const e of ups) {
    const daysTo = Math.round((new Date(e.date + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400e3);
    // 只提醒 A/B 级；C 级季节性不弹框（避免噪音）
    if (!['A', 'B'].includes(e.grade)) continue;
    // 美股休市 / 提前收盘是交易所日历背景信息，不是待办事项：
    // 仍显示于日历网格、当日事件与「未来30天」，但不进自动提醒弹框，避免新增每日弹窗噪音。
    if (e.market === 'US' && (e.marketStatus === 'closed' || e.marketStatus === 'early-close')) continue;
    if (state.sent[e.id + '@' + today]) continue;
    due.push({
      id: e.id + '@' + today,
      eventId: e.id,
      ruleId: e.ruleId || null,
      name: e.name,
      date: e.date,
      grade: e.grade,
      category: e.category,
      daysTo,
      sectors: e.sectors || [],
      message: (daysTo === 0 ? '今日' : daysTo === 1 ? '明日' : daysTo + ' 天后') + '：' + e.name + '（' + e.grade + '级' + (e.verified ? '·已确认' : '·待核实') + '）'
    });
  }
  return due;
}

function markReminded(ids) {
  if (!ids || !ids.length) return;
  const state = loadReminders();
  for (const id of ids) state.sent[id] = Date.now();
  // 只保留最近 14 天去重键
  const cutoff = Date.now() - 14 * 86400e3;
  for (const [k, v] of Object.entries(state.sent)) if (v < cutoff) delete state.sent[k];
  saveReminders(state);
}

/* ------------------------------ 用户事件 CRUD ------------------------------ */

function addEvent(ev) {
  if (!ev || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '')) return { ok: false, error: '日期格式应为 YYYY-MM-DD' };
  if (!String(ev.name || '').trim()) return { ok: false, error: '事件名称不能为空' };
  const row = {
    id: 'U-' + String(ev.date).replace(/-/g, '') + '-' + String(Date.now()).slice(-5),
    date: ev.date,
    name: String(ev.name).trim().slice(0, 80),
    grade: '自定义',
    category: ev.category || '自定义',
    detail: String(ev.detail || '').slice(0, 300),
    sectors: Array.isArray(ev.sectors) ? ev.sectors.slice(0, 12).map(String) : [],
    remindAhead: Number.isFinite(ev.remindAhead) ? ev.remindAhead : 3,
    source: 'user',
    verified: true,
    createdAt: Date.now()
  };
  appendJsonl(USER_FILE, row);
  return { ok: true, event: row };
}

/**
 * 去重写入（供 future-events 扫描器使用）：按 scanKey / id 命中则更新、否则追加。
 * 保留首次 createdAt，刷新 updatedAt，避免每小时扫描把同一事件重复追加到日历。
 * 允许透传 source / confirmLevel / dateBasis / newsRef / grade / verified 等来源分级字段。
 */
function upsertEvent(ev) {
  if (!ev || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date || '')) return { ok: false, error: '日期格式应为 YYYY-MM-DD' };
  if (!String(ev.name || '').trim()) return { ok: false, error: '事件名称不能为空' };
  const rows = readJsonl(USER_FILE);
  const key = String(ev.scanKey || ev.id || '').trim();
  const idx = key ? rows.findIndex(r => String(r.scanKey || r.id) === key) : -1;
  const now = Date.now();
  const base = {
    id: ev.id || ('S-' + String(ev.date).replace(/-/g, '') + '-' + String(now).slice(-6)),
    date: ev.date,
    name: String(ev.name).trim().slice(0, 90),
    grade: ev.grade || '自定义',
    category: ev.category || '自定义',
    detail: String(ev.detail || '').slice(0, 500),
    sectors: Array.isArray(ev.sectors) ? ev.sectors.slice(0, 12).map(String) : [],
    remindAhead: Number.isFinite(ev.remindAhead) ? ev.remindAhead : 3,
    source: ev.source || 'user',
    verified: ev.verified != null ? !!ev.verified : true,
    confirmLevel: ev.confirmLevel || null,
    dateBasis: ev.dateBasis || null,
    newsRef: ev.newsRef || null,
    scanKey: key || null,
    ruleId: ev.ruleId || null,
    // 日程准入审查元数据（calendar-gate.js）：结论 / 信源等级 / 真伪状态 / 智能体审查标记
    gate: ev.gate || null,
    createdAt: ev.createdAt || now,
    updatedAt: now
  };
  let action;
  if (idx >= 0) {
    rows[idx] = { ...rows[idx], ...base, createdAt: rows[idx].createdAt || now };
    action = 'updated';
  } else {
    rows.push(base);
    action = 'created';
  }
  ensureDir();
  const tmp = USER_FILE + '.tmp';
  fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, USER_FILE);
  return { ok: true, action, event: base };
}

function removeEvent(id) {
  if (!fs.existsSync(USER_FILE)) return { ok: false, error: '无自定义事件' };
  const rows = readJsonl(USER_FILE);
  const keep = rows.filter(r => r.id !== id);
  if (keep.length === rows.length) return { ok: false, error: '未找到事件 ' + id };
  ensureDir();
  const tmp = USER_FILE + '.tmp';
  fs.writeFileSync(tmp, keep.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, USER_FILE);
  return { ok: true, removed: id };
}

/**
 * 事件解读 · 分层提示词（2026-11-24 重构）
 *
 *   L0  BASE_SYSTEM     全局表达准则：数据真实 / 标注来源时点 / 区分事实与推测 / 证伪条件 / 风险自担
 *   L1  contextPrefix   当前全局数据快照（hermes.ask → collectContext 自动注入）
 *   L2  本函数 q        任务定义 + 事件原始信息 + 输出格式 + 硬约束
 *   L3  hist            程序基于真实日线计算的统计（禁止改写）
 *
 * 采用「单次确定性生成」而非 Agent Loop / function-calling：
 *   事件解读的输入是封闭的（一条事件 + 一份统计 + 一份快照），不需要模型自主多轮取数；
 *   单次生成更省、更稳、可复现，也避免多轮工具调用带来的口径漂移。
 *   Agent Loop 留给开放式对话（用户可追问、需按需拉取多板块数据）。
 */
/* ==================== 事件 → 关联真实标的（低幻觉前提） ==================== */
/**
 * 使用者要求（2026-11-24）：事件解读要「对哪个板块和哪个个股提供建议」。
 * 关键约束：个股代码 / 名称必须来自系统真实数据，绝不能由模型编造。
 *
 * 难点：事件的 sectors 是「黄金 / 光伏 / 科技 / 全市场」这类主题词，
 *       而 strategy.json / pick-insight.json 里的个股是「化学制品 / 光伏设备」这类行业名，
 *       直接相等匹配会大量落空，也不能让模型「自己判断哪个股属于这个主题」（那就是臆造关联）。
 * 做法：维护一张【显式、可追溯】的主题→行业关键词映射表（常量，非模型推断），
 *       用「行业名包含关键词」筛出候选，并把匹配依据一起写进 prompt。
 *       境外 / 宏观 / 宽基主题显式映射为空数组 → 如实写「无对应 A 股标的」。
 */
/* 关键词按系统真实行业名校准（数据里是截断简称 + 概念板块名，如「计算机设」「东数西算(算力)」） */
const SECTOR_INDUSTRY_MAP = {
  '光伏': ['光伏设备'],
  '储能': ['电网设备', '光伏设备', '电机', '电池'],
  '电力设备': ['电网设备', '光伏设备', '电机'],
  '新能源': ['光伏设备', '电网设备', '电机'],
  '电力': ['电网设备', '燃气'],
  '煤炭': ['煤炭', '焦炭'],
  '石油': ['石油', '炼化', '油气'],
  '化工': ['化学制品', '化学制药', '塑料', '农化制品', '橡胶'],
  '航运': ['物流', '港口', '航运'],
  '黄金': ['贵金属', '饰品'],
  '有色': ['工业金属', '小金属', '饰品'],
  '半导体': ['半导体', '元件', '光学光电', '共封装光学', 'CPO'],
  '芯片': ['半导体', '元件'],
  '算力': ['东数西算', '算力', '云计算', '通信设备', '计算机设', 'IT服务', '通信服务'],
  '科技': ['半导体', '计算机设', '软件开发', '通信设备', '消费电子', '元件', '云计算', '东数西算', '通信服务', 'IT服务'],
  '消费电子': ['消费电子', '元件', '光学光电', '黑色家电', '小家电'],
  '军工': ['航天', '航空', '船舶', '兵器', '国防'],
  '汽车': ['汽车零部', '汽车服务', '汽车'],
  '医药': ['化学制药', '中药', '生物制品', '医疗器械', '医药商业'],
  '创新药': ['化学制药'],
  '中药': ['中药'],
  '医药商业': ['医药商业'],
  '地产': ['房地产开', '装修装饰', '基础建设'],
  '基建': ['基础建设', '装修装饰', '工程机械'],
  '消费': ['饮料乳品', '小家电', '黑色家电', '一般零售', '服装家纺', '家居用品', '预制菜', '文娱用品', '饲料'],
  '券商': ['证券', '多元金融'],
  '金融': ['银行', '证券', '保险', '多元金融'],
  '钢铁': ['钢铁', '特钢'],
  '农业': ['饲料', '玉米', '农产品加', '农化制品'],
  '出口链': ['通用设备', '专用设备', '纺织制造', '家电零部', '服装家纺'],
  '次新股': ['注册制次新股'],
  // 以下为境外 / 宏观 / 宽基主题：A 股行业体系里无对应映射，如实写「无对应 A 股标的」，不硬凑
  '全市场': [], '政策主题': [], '业绩预增': [], '北向资金': [],
  '美债': [], '美元': [], '人民币': [], '成长股': [], '价值股': [], '港股': []
};
const DATA_DIR = path.join(__dirname, '..', 'data');
function readJsonSafe(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function matchIndustries(theme) {
  const t = String(theme || '').trim();
  if (!t) return [];
  if (Object.prototype.hasOwnProperty.call(SECTOR_INDUSTRY_MAP, t)) return SECTOR_INDUSTRY_MAP[t];
  for (const k of Object.keys(SECTOR_INDUSTRY_MAP)) {
    if (t.includes(k) || k.includes(t)) return SECTOR_INDUSTRY_MAP[k];
  }
  return [];
}
function addStock(map, x, source, extra) {
  const code = String((x && (x.code || x.symbol)) || '').trim();
  if (!code) return;
  const cur = map.get(code) || {
    code, name: '', industry: '', sources: [], score: null,
    why: '', basis: '', reason: '', risk: false, conflict: false
  };
  if (x.name && !cur.name) cur.name = String(x.name);
  if (x.industry && !cur.industry) cur.industry = String(x.industry);
  if (!cur.sources.includes(source)) cur.sources.push(source);
  for (const k of Object.keys(extra || {})) {
    const v = extra[k];
    if (v == null) continue;
    if (k === 'risk' || k === 'conflict') cur[k] = cur[k] || v;
    else if (cur[k] == null || cur[k] === '') cur[k] = v;
  }
  map.set(code, cur);
}
/** 汇总系统当前真实个股：四类选股 / 次日观察池 / 风险规避池 / 板块领跑股 */
function collectStockUniverse() {
  const out = new Map();
  const st = readJsonSafe(path.join(DATA_DIR, 'strategy.json')) || {};
  const fc = st.fourClass || {}, pools = st.pools || {};
  for (const x of (fc.items || [])) {
    const drv = (x.riseDrivers || []).map(d => String(d.text || '').slice(0, 46)).join(' | ');
    addStock(out, x, '四类选股·' + (x.kindLabel || x.kind || '?'), { score: x.score, why: drv });
  }
  for (const x of (pools.watchPool || [])) addStock(out, x, '次日备选观察池', { score: x.score, why: x.why });
  for (const x of (pools.riskPool || [])) addStock(out, x, '风险规避池', { risk: true, reason: x.reason });
  for (const c of (pools.conflicts || [])) { const s = out.get(String(c.code)); if (s) s.conflict = true; }
  const pi = readJsonSafe(path.join(DATA_DIR, 'pick-insight.json')) || {};
  for (const x of (pi.leaders || [])) addStock(out, x, '板块领跑股', { basis: x.basis, score: x.leadScore });
  // 重点股池（带评分 / 信号 / 理由，质量最高）
  const sc = readJsonSafe(path.join(DATA_DIR, 'stocks-cache.json')) || {};
  for (const x of (sc.items || [])) {
    const why = [x.signal, (x.reasons || []).slice(0, 2).join('；')].filter(Boolean).join('：');
    addStock(out, x, '重点股池', { score: x.score, why: why });
  }
  // 当日涨停池（industry 为截断简称，如「计算机设」「光学光电」，由 hitIndustry 前缀匹配兼容）
  const lu = readJsonSafe(path.join(DATA_DIR, 'limitup-cache.json')) || {};
  for (const x of (lu.zt || [])) {
    addStock(out, x, '当日涨停池', {
      why: (x.boards != null ? x.boards + ' 连板' : '涨停') + '，首封 ' + (x.firstSealLabel || '未知')
    });
  }
  // 归因池（带公告 / 新闻事实与涨停结构）
  const at = readJsonSafe(path.join(DATA_DIR, 'attribution-cache.json')) || {};
  for (const x of (at.items || [])) {
    addStock(out, x, '归因池', { why: (x.board && (x.board.statLabel || x.board.kind)) || '' });
  }
  return out;
}
/** 行业命中：兼容「完整名包含关键词」与「数据里被截断的简称作为关键词前缀」两种情形 */
function hitIndustry(industry, kws) {
  const ind = String(industry || '').trim();
  if (!ind) return false;
  return kws.some(k => ind.includes(k) || (ind.length >= 3 && k.startsWith(ind)));
}
/**
 * 按事件 sectors 生成「关联标的」文本块。返回 { block, count, themes, anyMatch, industries }。
 * 全局预算 12 只，避免 prompt 膨胀；超出的只写数量，不列全。
 */
function relatedStocks(sectors) {
  const universe = collectStockUniverse();
  const themes = [...new Set((sectors || []).map(s => String(s || '').trim()).filter(Boolean))];
  const lines = ['【本次事件关联标的（程序按「相关板块」从系统真实数据匹配，禁止模型自行补充股票代码或名称）】'];
  const industries = [];
  let count = 0, anyMatch = false;
  const BUDGET = 12;
  for (const theme of themes) {
    const kws = matchIndustries(theme);
    if (!kws.length) {
      lines.push('- ' + theme + '：当前无对应 A 股行业映射（境外 / 宏观 / 宽基主题），下文须写「无对应 A 股标的」，不得硬凑个股。');
      continue;
    }
    industries.push(theme + '→' + kws.join('/'));
    const hits = [...universe.values()].filter(s => hitIndustry(s.industry, kws));
    if (!hits.length) {
      lines.push('- ' + theme + '（匹配依据：行业关键词 ' + kws.join('/') + '）：系统当前真实数据中无关联标的，下文须写「当前无对应标的」。');
      continue;
    }
    hits.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    const room = Math.max(0, BUDGET - count);
    const picked = hits.slice(0, Math.min(3, room));
    if (!picked.length) { lines.push('- ' + theme + '：受全局展示预算限制，本主题标的未逐一列出（见上文清单）。'); continue; }
    anyMatch = true; count += picked.length;
    lines.push('- ' + theme + '（匹配依据：行业关键词 ' + kws.join('/') + '，命中 ' + hits.length + ' 只）：');
    for (const s of picked) {
      lines.push('  · ' + s.code + ' ' + s.name + '｜行业 ' + (s.industry || '未知') +
        '｜来源 ' + s.sources.join('、') +
        (s.score != null ? '｜评分 ' + s.score : '') +
        (s.why ? '｜依据 ' + String(s.why).slice(0, 60) : '') +
        (s.basis ? '｜领跑依据 ' + String(s.basis).slice(0, 60) : '') +
        (s.risk ? '｜⚠ 同时在风险规避池（' + String(s.reason || '').slice(0, 46) + '）' : '') +
        (s.conflict ? '｜⚠ 双池重叠' : ''));
    }
    if (hits.length > picked.length) lines.push('  · …同主题另有 ' + (hits.length - picked.length) + ' 只未列出，不得自行补名。');
  }
  if (!themes.length) lines.push('- 事件未指定相关板块：全文不得出现具体个股，只做宏观层面解读。');
  if (!anyMatch) lines.push('- 结论：本次事件在系统真实数据中没有任何可关联个股，全文不得出现具体股票代码或名称。');
  lines.push('- 口径：以上为程序基于「行业关键词包含匹配」筛出的研究清单，非推荐、非买卖指令；映射表为显式常量，不是模型推断。');
  return { block: lines.join('\n'), count, themes, anyMatch, industries };
}

async function eventImpact(cfg, hermes, event, historical) {
  const ev = event || {};
  // ① 事件原始信息：旧 prompt 未使用 detail（新闻线索正文完全丢失），且前端未传 confirmed（恒显示「待核实」）
  const evBlock = [
    '【事件原始信息（来自日历 / 事件库，逐字使用，不要扩写）】',
    '- 名称：' + (ev.name || '未提供'),
    '- 日期：' + (ev.date || '未提供') + '（' + (ev.confirmed ? '已确认日期' : '日期待核实') +
      (ev.dateBasis ? '；日期依据：' + ev.dateBasis : '') + '）',
    '- 等级：' + (ev.grade || '未分级') + '；来源：' + (ev.source || '未提供') +
      (ev.category ? '；分类：' + ev.category : ''),
    '- 相关板块：' + ((ev.sectors || []).join('、') || '未指定'),
    '- 事件描述 / 新闻原文：' + (ev.detail || '未提供（不要臆测事件具体内容）'),
    '- 新闻出处：' + ((ev.newsRef && (ev.newsRef.title || ev.newsRef.source)) || '未提供')
  ].join('\n');

  // ② 程序统计与口径：口径只能引用 L3 提供的字段，禁止模型自行推断
  let histBlock;
  if (historical && historical.ok) {
    const meta = [
      historical.method ? '- 统计口径：' + historical.method : '',
      historical.window ? '- 统计窗口：' + JSON.stringify(historical.window) : '',
      historical.benchmark ? '- 超额基准：' + JSON.stringify(historical.benchmark) : '',
      historical.statNote ? '- 口径限制：' + historical.statNote : '',
      '- 生成时点：' + (historical.generatedAt || '未提供') +
        '；统计范围：' + (historical.scope === 'rule' ? '同类规则级' : '板块代理合并') +
        '；数据是否过期：' + (historical.stale ? '是（需提示）' : '否'),
      historical.mechanism ? '- 预设机制线索：' + historical.mechanism : ''
    ].filter(Boolean).join('\n');
    histBlock = '【同类事件历史统计（程序基于真实日线计算，禁止改写任何数字）】\n' +
      meta + '\n- 统计明细：' + (historical.detail || JSON.stringify(historical.summary || historical)) +
      '\n- 分板块明细：' + JSON.stringify(historical.proxies || []);
  } else {
    histBlock = '【同类事件历史统计】\n' +
      '- 状态：该类事件暂无可核对的历史样本' + (historical && historical.error ? '（' + historical.error + '）' : '') + '。\n' +
      (historical && historical.mechanism ? '- 预设机制线索：' + historical.mechanism + '\n' : '') +
      '- 要求：全文各段明确写「暂无历史统计」，不得编造任何百分比、样本数或胜率。';
  }

  // ③ 关联标的：按事件板块从系统真实数据匹配（本轮新增 —— 使用者要求「对哪个板块和哪个个股提供建议」）
  const rel = relatedStocks(ev.sectors || []);

  const q = [
    evBlock,
    '',
    histBlock,
    '',
    rel.block,
    '',
    '【任务】基于上面的事件信息、程序统计、关联标的清单与系统注入的全局数据快照，写一份事件解读。',
    '',
    '【输出形式 · 必须严格遵守：只写结构化文字叙述】',
    '- 固定 5 个二级标题为骨架，段内用 `- ` 列表组织；关键数字与结论用 `**加粗**`；引用事实时写清来源与时点。',
    '- 不要输出表格、图表、代码块、ASCII 图示、KPI 卡片、emoji；不要加独立的开篇段或结尾免责声明段。',
    '- 标题骨架（顺序和文字都不要改）：',
    '## 一、这是什么事件 / 为什么重要',
    '## 二、事件之前（历史样本表现）',
    '## 三、事件之后（历史样本表现）',
    '## 四、板块与个股建议',
    '## 五、本次怎么看（推测与证伪条件）',
    '在第五段末尾另起一行写：`依据：事件研究引擎(生成时点) · 全局数据快照(快照时点) · 关联标的清单(strategy/pick-insight 生成时点)`。',
    '',
    '【各段内容要求】',
    '一：用 2-3 句说明事件背景与影响市场的因果机制链条，不要只给结论；若事件描述里含具体公司 / 标的 / 政策原文，必须点名。',
    '二：引用统计里的事件前 T-5 / T-3 平均涨跌与事件前上涨占比，判断是否存在提前交易预期；无样本则明说。',
    '三：引用 T+1 / T+3 / T+5 平均涨跌、相对基准超额、上涨概率、涨跌分布，并逐个点名分板块明细中的板块及对应百分比；样本数 < 8 必须写「低样本，不可外推」。',
    '四（本轮重点 · 必须给出明确建议，不要回避、不要泛泛而谈）：',
    '  · 逐个点名【事件原始信息】里的每一个「相关板块」，各写 1 条明确的观察方向 / 条件化判断（偏正面、偏谨慎、中性观察三选一），并说明依据来自历史统计、全局快照还是关联标的清单。',
    '  · 只从【本次事件关联标的】清单里点名个股，写清 `代码 名称` + 入选来源 + 为什么值得观察（或为什么需规避），并给出条件化判断与「出现什么信号就说明不成立」的证伪条件。',
    '  · 清单里带「⚠ 风险规避池」或「⚠ 双池重叠」的标的必须显式提示风险与冲突，不得只讲机会。',
    '  · 清单为空、或某板块标注「无对应 A 股标的 / 当前无对应标的」时，必须如实写明，不得硬凑、不得用其他板块个股代替、不得编造股票代码或名称。',
    '五：结合当前快照给出明确推测（标注「推测」），给 1-2 条可证伪条件，并提示「预期兑现」风险与日期 / 口径不确定性。',
    '',
    '【硬约束 · 违反即为不合格】',
    '1. 所有百分比、样本数、事件次数只能引用上面提供的历史统计；不得改写、不得自行计算新数字、不得给「估算值」。',
    '2. 上面没有给出代理数据的板块，必须逐一点名写「当前无历史数据」；不得跳过、不得用宽基代理的数字代替、不得含糊带过。',
    '3. 统计口径（T+N 定义、超额基准、样本范围、窗口）只能引用上面给出的「统计口径 / 统计窗口 / 超额基准」；没给就写「口径以程序定义为准」，禁止自行推断或补写口径解释。',
    '4. 个股代码与名称只能逐字引用【本次事件关联标的】清单；不得新增、不得改写、不得编造；清单为空时全文不得出现任何 6 位股票代码或具体个股名称。',
    '5. 区分「历史样本表现」「当前快照事实」「本次推测」三层；凡推测必须标注，并给证伪条件。',
    '6. 不得把 ETF 代理的统计说成板块内个股表现；不得把「上涨概率」读成「必然上涨」；不承诺收益、不冒充真实成交或持仓。',
    '7. 若标记「数据是否过期：是」或统计范围为「板块代理合并」，必须在第三段显式提示可比性限制。',
    '8. 「建议」是条件化研究观点，不是买卖指令；必须写明依据与证伪条件，决策与风险由使用者自行承担。',
    '9. 红涨绿跌遵循 A 股习惯；你不修改任何评分、不替用户下单。'
  ].join('\n');

  const r = await hermes.ask(cfg, 'calendar', q, {
    task: '事件详细解读（结构化文字叙述 + 板块与个股建议）', maxTokens: 2400, temperature: 0.2
  });
  if (r) {
    r.historical = historical || null;
    r.related = { themes: rel.themes, count: rel.count, anyMatch: rel.anyMatch, industries: rel.industries };
    if (r.ok) r.promptVersion = 'event-impact-v3';   // 便于日后追溯 / 前端标注
  }
  return r;
}

module.exports = {
  view, upcoming, expandRules, readUserEvents, dueReminders, markReminded,
  addEvent, upsertEvent, removeEvent, eventImpact, relatedStocks, deriveEndDate,
  RULES, DATED_EVENTS, DIR, USER_FILE, US_HOLIDAYS: usHolidays
};
