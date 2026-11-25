'use strict';
/**
 * future-events.js — 未来事件扫描入历（不漏项）
 *
 * 用户要求：查找【所有新闻】里【有确定时间】的内容，对股市有影响/有关联的都纳入日程，不要漏项。
 *
 * 三层保障：
 *  ① 新闻时间抽取：扫描服务内存中的全部新闻（不是只取精选 12 条），识别绝对日期 / 相对周几 /
 *     明日 / 月底 / 英文周几等时间表达；对时间短语做「局部时态窗口」判定，区分
 *     「将于12月3日出席听证会」（预告）与「上周日下午敲定」（回顾），只保留落在扫描窗口内的条目。
 *  ② 准入闸门（calendar-gate.js）：【默认拒绝 fail-closed】
 *       · 确定性硬闸门：必须是未来待发生、时间绑定事件动作、信源可追溯、属可布局的市场事件；
 *         已发生/回顾语境、立场/人事/治理叙事、匿名信源未证实细节、公司名误命中一律驳回。
 *       · 智能体结构化审查：只输出「是否未来事件 / 时间是否属于事件 / 信源等级 / 真伪风险 / 核实途径」建议，
 *         不预判行情、不改事实、无权把驳回升级为放行；无 AI 结论的 admit 一律降级为待复核。
 *       · 合并决策 + 人工复核：仅 admit 才写入日程；reject 登记黑名单防回写；review/reject 进复核台。
 *  ③ 周期规则兜底：补齐 calendar.js RULES 里缺失的关键宏观日历（美国 PCE、初请失业金、
 *     EIA 原油库存、零售销售、ISM PMI、GDP、中国 MLF、外汇储备等），按规律推算日期；
 *     这类是「系统规则推算」而非新闻线索，单独标注来源性质，不参与消息真伪核验。
 *
 * 诚实标注：新闻相对时间 / 规律推算一律标 confirmLevel 与 dateBasis，verified=false，
 *          detail 里写明「以官方日历为准」，绝不把推算冒充已公布；程序只做来源分级，
 *          不对消息真伪作事实裁定，匿名信源与未证实细节一律标注。
 *
 * 落盘：data/calendar/events.jsonl（经 calendar.upsertEvent 去重写入）
 *       data/calendar/future-events-scan.json（最近一次扫描的覆盖率 + 准入报告）
 *       data/calendar/gate-review.json / gate-blacklist.json / gate-cache.json（闸门状态）
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cal = require('./calendar');
const gate = require('./calendar-gate');

const DATA = path.join(__dirname, '..', 'data', 'calendar');
const F_REPORT = path.join(DATA, 'future-events-scan.json');

function readJson(f) { try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} return null; }
function writeJson(f, o) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = f + '.tmp';
  fs.writeFileSync(t, JSON.stringify(o, null, 2), 'utf8');
  fs.renameSync(t, f);
}
function bjNow(ts = Date.now()) { return new Date(ts + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); }
function bjParts(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600e3);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay() || 7 }; // 周一=1..周日=7
}
function iso(y, m, d) { return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400e3);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
function addMonths(y, m, n) { const t = m - 1 + n; return { y: y + Math.floor(t / 12), m: (t % 12 + 12) % 12 + 1 }; }
function lastWeekday(y, m, dow) {
  for (let d = daysInMonth(y, m); d >= 1; d--) {
    if ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7) === dow) return d;
  }
  return daysInMonth(y, m);
}
function validDate(y, m, d) { return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m); }
function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 10); }

/* ---------------------- ① 新闻时间表达抽取 ---------------------- */

const CN_WEEK = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
const EN_WEEK = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };

/**
 * 时间短语的「局部时态窗口」判定。
 * 背景：原文「这项决定于【上周日】下午敲定」里的「周日」曾被当成未来相对时间推算出 11-29。
 * 现在按匹配位置前后各取一小段文字，判断这个时间到底在描述「未来待发生」还是「回顾已发生」，
 * 以及是否绑定了「将于…出席 / 定于…召开」这类预告动作。
 */
function localCtx(s, m) {
  const raw = m[0] || '';
  const i = m.index || 0;
  // 形如 /(?:^|[^\d])(\d{1,2})月…/ 的正则会把前导字（「于12月3日」的「于」）一并吃进匹配，
  // 若不归还给 before 窗口，「将于 / 定于」会被截断成「将 / 定」，预告绑定判定就会失效。
  const lead = (raw.match(/^[^\d]*/) || [''])[0].length;
  const start = i + lead, len = raw.length - lead;
  return { before: s.slice(Math.max(0, start - 16), start), after: s.slice(start + len, start + len + 20) };
}
// 只保留【明确完成态 / 回顾标记】。「公布 / 发布 / 宣布 / 决定 / 通过」是中性词，
// 「将于12月10日公布」是未来动作，不能因为出现「公布」就判为回顾已发生。
const PAST_LOCAL = /(上周|上月|上一|去年|昨日|昨|此前|日前|已于|已在|曾在|当时|刚刚|敲定|落定|尘埃落定|最后一刻|才收到|才获|并不知情|事后|复盘|回顾|一度|已完成|完成了|已结束|结束了|开盘前|收盘后|通过了|宣布了|公布了|发布了|披露了|作出决定|了决定|达成)/;
const FORECAST_LOCAL = /(将于|定于|拟于|计划于|预计|将在|将召开|将举行|将公布|将发布|将出席|将披露|将上市|将到期|将生效|届时|scheduled\s+to|is\s+due\s+to|set\s+to|will\s+(?:release|publish|report|announce|hold|testify|meet))/i;
const EVENT_LOCAL = /(出席|参加|作证|听证|召开|举行|举办|开幕|发布|公布|披露|出炉|揭晓|上市|申购|到期|生效|实施|决议|表决|投票|数据|报告|财报|会议|论坛|峰会|审议|会谈|审议|公布数据)/;
function tenseOf(s, m) {
  const { before, after } = localCtx(s, m);
  const past = PAST_LOCAL.test(before) || PAST_LOCAL.test(after);
  const forecastBound = FORECAST_LOCAL.test(before) && EVENT_LOCAL.test(before + after);
  return { past, forecastBound, phrase: m[0] };
}
/** 统一装配返回值：把时态信号附带出去，供准入闸门使用 */
function timeHit(date, basis, confidence, tense, extra) {
  return {
    date, basis, confidence,
    phrase: (tense && tense.phrase) || null,
    past: !!(tense && tense.past),
    forecastBound: !!(tense && tense.forecastBound),
    ...(extra || {})
  };
}

/** 从一段新闻文本里抽取时间表达；返回 {date,basis,confidence,phrase,past,forecastBound} 或 null
 *  注意：这里只做「抽取 + 时态标注」，是否够格入历由 calendar-gate 判定。 */
function extractTime(text, base) {
  const s = String(text || '');
  // 1) 绝对年月日：2026年11月25日
  let m = s.match(/(20\d{2})年(\d{1,2})月(\d{1,2})[日号]?/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (validDate(y, mo, d)) return timeHit(iso(y, mo, d), '新闻明确日期「' + m[0] + '」', 'explicit', tenseOf(s, m));
  }
  // 2) 月日：11月25日 / 12/05（补年份；跨年就近推断）
  m = s.match(/(?:^|[^\d])(\d{1,2})月(\d{1,2})[日号]/);
  if (!m) m = s.match(/(?:^|[^\d])(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?/);
  if (m) {
    const mo = +m[1], d = +m[2];
    let y = m[3] ? +m[3] : base.y;
    if (!m[3]) {
      if (mo < base.m - 6) y = base.y + 1;
      else if (mo > base.m + 6) y = base.y - 1;
    }
    if (validDate(y, mo, d)) {
      const label = mo + '月' + d + '日' + (m[3] ? '（' + m[3] + '年）' : '');
      return timeHit(iso(y, mo, d), '新闻明确日期「' + label + '」' + (m[3] ? '' : '（按当前年份补齐）'), 'explicit', tenseOf(s, m));
    }
  }
  // 3) 中文相对周几：本周三 / 下周三 / 上周日 / 周三 / 星期四
  //    显式捕获「上/去」前缀：这类是回顾语境，标记 past，不再按未来推算。
  m = s.match(/(上周|上周|上|去|本周|下周|本|下)?\s*(周[一二三四五六日天]|星期[一二三四五六日天])/);
  if (m) {
    const wd = CN_WEEK[m[2].slice(-1)];
    const prefix = m[1] || '';
    const pastPrefix = /上|去/.test(prefix);
    let delta = wd - base.dow;
    if (delta < 0) delta += 7;
    if (prefix === '下周' || prefix === '下') delta += 7;
    const t = addDays(base.y, base.m, base.d, delta);
    const tense = tenseOf(s, m);
    return timeHit(iso(t.y, t.m, t.d), '新闻相对时间「' + m[0] + '」按当前周推算', 'relative', { ...tense, past: tense.past || pastPrefix });
  }
  // 4) 英文周几：next Wednesday / on Friday
  m = s.match(/\b(next|this|last)?\s*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
  if (m) {
    const wd = EN_WEEK[m[2].toLowerCase()];
    let delta = wd - base.dow;
    if (delta < 0) delta += 7;
    if (m[1] && /next/i.test(m[1])) delta += 7;
    const t = addDays(base.y, base.m, base.d, delta);
    const tense = tenseOf(s, m);
    return timeHit(iso(t.y, t.m, t.d), '新闻相对时间「' + m[0] + '」按当前周推算', 'relative', { ...tense, past: tense.past || (m[1] && /last/i.test(m[1])) });
  }
  // 5) 明日 / 后天 / 今日 / 今晚
  m = s.match(/(明日|明天|后天|今日|今晚)/);
  if (m) {
    const n = /后天/.test(m[1]) ? 2 : (/今日|今晚/.test(m[1]) ? 0 : 1);
    const t = addDays(base.y, base.m, base.d, n);
    return timeHit(iso(t.y, t.m, t.d), '新闻相对时间「' + m[1] + '」推算', 'relative', tenseOf(s, m));
  }
  // 6) 模糊窗口：月底 / 月末 / 下旬 / 中旬 / 下月初（取该窗口代表日，标注为窗口推算）
  m = s.match(/(月底|月末|下旬|中旬|下月初|下周|本周)/);
  if (m) {
    let t;
    if (/中旬/.test(m[1])) t = { y: base.y, m: base.m, d: Math.min(15, daysInMonth(base.y, base.m)) };
    else if (/下月初/.test(m[1])) { const nm = addMonths(base.y, base.m, 1); t = { y: nm.y, m: nm.m, d: 3 }; }
    else if (/下旬|月底|月末/.test(m[1])) t = { y: base.y, m: base.m, d: daysInMonth(base.y, base.m) };
    else t = addDays(base.y, base.m, base.d, /下周/.test(m[1]) ? 7 : 0);
    return timeHit(iso(t.y, t.m, t.d), '新闻模糊窗口「' + m[1] + '」取代表日（区间未精确）', 'window', tenseOf(s, m));
  }
  return null;
}

/**
 * 预告语义（已收紧）：只保留明确的「未来预告」措辞。
 * 旧版含裸词「公布|发布|数据|报告|会议|决议」，导致「对外公布」「上周日敲定」这类
 * 回顾性报道被误判为预告。现在准入判定完全交给 calendar-gate，此正则仅作参考标注。
 */
const FORECAST_RE = /(将于|定于|计划于|拟于|预计将于|预计在|将在|将公布|将发布|将出炉|将揭晓|将召开|将举行|将披露|将出席|将生效|将实施|将上市|将到期|届时|scheduled\s+to|is\s+(?:due|scheduled|set)\s+to|scheduled\s+for|due\s+on|will\s+(?:release|publish|report|announce|hold|testify|meet))/i;

/** 对 A 股有影响/有关联的事件主题 → 相关板块映射（命中即认为应纳入日程） */
const IMPACT_RULES = [
  { name: '美国 PCE 物价指数', cat: '海外指标', sectors: ['黄金', '美债', '成长股', '美元'], kw: ['PCE', '个人消费支出', '核心PCE', 'pce', 'personal consumption'] },
  { name: 'CPI / 通胀数据', cat: '宏观指标', sectors: ['消费', '黄金', '成长股'], kw: ['CPI', '消费者物价', '通胀数据', 'cpi', 'inflation', 'PPI', '生产者物价'] },
  { name: '就业 / 非农数据', cat: '海外指标', sectors: ['黄金', '美元', '美债'], kw: ['非农', '就业报告', '失业率', 'nonfarm', 'payroll', 'jobs report', '初请失业金'] },
  { name: '央行议息 / 利率决议', cat: '全球央行', sectors: ['黄金', '美债', '券商', '全市场'], kw: ['FOMC', '议息', '利率决议', '美联储', '加息', '降息', '点阵图', 'fed ', 'rate decision', 'BOJ', 'ECB', '日本央行', '欧洲央行'] },
  { name: 'GDP / 经济增长数据', cat: '宏观指标', sectors: ['全市场', '地产', '消费'], kw: ['GDP', '国内生产总值', '经济增速', 'gdp'] },
  { name: 'PMI / 景气指标', cat: '宏观指标', sectors: ['全市场', '煤炭', '地产'], kw: ['PMI', '采购经理人', '制造业景气', 'ISM', 'pmi'] },
  { name: '国内货币 / 信贷数据', cat: '国内指标', sectors: ['券商', '地产', '全市场'], kw: ['社融', '信贷', 'M2', 'LPR', 'MLF', '降准', '逆回购', '央行操作'] },
  { name: '财报 / 业绩披露', cat: '业绩', sectors: ['全市场', '业绩预增'], kw: ['财报', '业绩', '披露', '季报', '年报', '中报', 'earnings', '业绩预告'] },
  { name: '解禁 / 新股 / IPO', cat: '供给', sectors: ['全市场', '次新股'], kw: ['解禁', '限售股', '新股', '申购', 'IPO', '上市', '增发', '配股'] },
  { name: '关税 / 贸易 / 出口管制', cat: '政策', sectors: ['出口链', '半导体', '黄金'], kw: ['关税', '制裁', '出口管制', '贸易', 'tariff', 'sanctions', 'export ban'] },
  { name: '原油 / OPEC / EIA', cat: '大宗', sectors: ['石油', '化工', '航运'], kw: ['OPEC', '减产', 'EIA', '原油库存', '油价', 'opec'] },
  { name: '重要会议 / 政策发布', cat: '中国重要会议', sectors: ['政策主题', '全市场'], kw: ['政治局', '两会', '中央经济工作会议', '国新办', '发布会', '政策', '国务院', '发改委', '证监会'] },
  // 公司名本身不是事件：必须同时出现「财报 / 业绩 / earnings」才算财报事件，
  // 避免「英伟达在黄仁勋一事上立场反转」这类人事报道被误命中成「美股科技巨头财报」。
  { name: '美股科技巨头财报', cat: '海外业绩', sectors: ['科技', '算力', '消费电子'],
    kw: ['英伟达', '苹果', '特斯拉', '微软', '谷歌', 'nvidia', 'apple', 'tesla'],
    requireAlso: /财报|业绩|earnings|季报|年报|业绩说明会|公布业绩|发布财报/i },
  { name: '选举 / 地缘 / 协议', cat: '国际事件', sectors: ['黄金', '军工', '全市场'], kw: ['大选', '选举', '公投', '停火', '谈判', '协议', 'election', 'ceasefire'] },
  { name: '医药政策', cat: '医药政策', sectors: ['创新药', '医药', '中药'], kw: ['医保', '集采', '药审', '创新药', '带量采购'] },
  { name: '新能源 / 产业政策', cat: '产业政策', sectors: ['光伏', '储能', '电力设备'], kw: ['光伏', '新能源', '装机', '储能', '以旧换新', '补贴'] }
];
function matchImpact(text) {
  const s = String(text || '');
  const hits = [];
  for (const r of IMPACT_RULES) {
    if (!r.kw.some(k => s.toLowerCase().includes(String(k).toLowerCase()))) continue;
    // 复合规则：公司名必须搭配财报语义词才算命中
    if (r.requireAlso && !r.requireAlso.test(s)) continue;
    hits.push(r);
  }
  return hits;
}

/* ---------------------- ② 周期规则兜底（补 calendar.js 缺失项） ---------------------- */

const EXTRA_RULES = [
  { id: 'us-pce', name: '美国 PCE 物价指数公布', cat: '海外指标', grade: 'B',
    sectors: ['黄金', '美债', '成长股', '美元'], dayRule: (y, m) => lastWeekday(y, m, 3),
    detail: 'BEA「个人收入与支出」报告含核心 PCE，是美联储最关注的通胀指标，影响降息预期、美元与全球风险偏好。按月末最后一个周三的惯例推算（BEA 遇节假日会前移，常落在周三/周四）；具体时点以 BEA 官方日历为准。' },
  { id: 'us-retail', name: '美国零售销售数据', cat: '海外指标', grade: 'B',
    sectors: ['消费', '美元', '出口链'], dayRule: (y, m) => 15,
    detail: '美国商务部月度零售销售，反映消费韧性，影响美元与外需链；通常为月中公布，以官方日历为准。' },
  { id: 'us-ism', name: '美国 ISM 制造业 PMI', cat: '海外指标', grade: 'B',
    sectors: ['全市场', '有色', '出口链'], dayRule: (y, m) => 1,
    detail: '每月首个工作日前后公布，全球制造业景气风向标；以 ISM 官方日历为准。' },
  { id: 'us-gdp', name: '美国 GDP 季度数据', cat: '海外指标', grade: 'B', months: [1, 4, 7, 10],
    sectors: ['美元', '美债', '黄金'], dayRule: (y, m) => lastWeekday(y, m, 4),
    detail: 'BEA 季度 GDP 修正值通常在季末月下旬公布，影响衰退预期与降息定价；以官方日历为准。' },
  { id: 'cn-mlf', name: '中国 MLF 操作 / 中期借贷便利', cat: '国内指标', grade: 'B',
    sectors: ['券商', '地产', '全市场'], dayRule: (y, m) => 15,
    detail: '央行每月中旬常态化操作，利率与投放量是货币政策取向的重要观察；以央行公告为准。' },
  { id: 'cn-fx', name: '中国外汇储备数据', cat: '国内指标', grade: 'B',
    sectors: ['人民币', '黄金', '全市场'], dayRule: (y, m) => 7,
    detail: '国家外汇管理局每月上旬公布，影响人民币汇率与跨境资金预期；以官方公布为准。' },
  { id: 'us-jobless', name: '美国初请失业金人数', cat: '海外指标', grade: 'C', weekly: 4,
    sectors: ['黄金', '美元'], detail: '每周四公布的高频就业指标，用于跟踪劳动力市场边际变化；周度规律推算，仅作观察线索。' },
  { id: 'us-eia', name: 'EIA 原油库存周报', cat: '大宗', grade: 'C', weekly: 3,
    sectors: ['石油', '化工', '航运'], detail: '每周三公布（遇假期顺延），库存变化影响油价与能化链；周度规律推算，仅作观察线索。' }
];

function expandExtraRules(base, horizonDays) {
  const out = [];
  const horizon = iso(addDays(base.y, base.m, base.d, horizonDays).y, addDays(base.y, base.m, base.d, horizonDays).m, addDays(base.y, base.m, base.d, horizonDays).d);
  const today = iso(base.y, base.m, base.d);
  for (let off = 0; off < 4; off++) {
    const { y, m } = addMonths(base.y, base.m, off);
    for (const r of EXTRA_RULES) {
      if (r.months && !r.months.includes(m)) continue;
      if (r.weekly) continue; // 周度单独处理
      const d = Math.min(r.dayRule(y, m), daysInMonth(y, m));
      const date = iso(y, m, d);
      if (date < today || date > horizon) continue;
      out.push(makeRuleEvent(r, date));
    }
  }
  // 周度事件：只覆盖未来 14 天，避免刷屏
  for (let n = 0; n <= 14; n++) {
    const t = addDays(base.y, base.m, base.d, n);
    const date = iso(t.y, t.m, t.d);
    const dow = new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay() || 7;
    for (const r of EXTRA_RULES) {
      if (!r.weekly || r.weekly !== dow) continue;
      out.push(makeRuleEvent(r, date));
    }
  }
  return out;
}
function makeRuleEvent(r, date) {
  const scanKey = 'rule-' + r.id + '-' + date;
  return {
    scanKey, id: 'FE-R-' + md5(scanKey),
    date, name: r.name + '（' + date.slice(5) + '）',
    grade: r.grade, category: r.cat,
    detail: r.detail + ' 【来源：周期规律推算，非官方已确认日期】',
    sectors: r.sectors,
    source: 'calendar-rule', confirmLevel: 'rule-estimate',
    dateBasis: '按 ' + r.id + ' 月度/周度规律推算（' + (r.weekly ? '每周固定星期' : '月度固定窗口') + '）',
    ruleId: r.id, verified: false,
    newsRef: null
  };
}

/* ---------------------- ③ 候选构造（时间抽取 + 确定性闸门） ---------------------- */

/**
 * 把新闻全文压成「准入候选」。只做抽取 + 元数据装配 + 确定性闸门判定，不写入日历。
 * 每条候选自带 rule（准入结论）与 fingerprint，供后续智能体审查 / 合并决策复用。
 */
function collectCandidates({ news = [], now = Date.now(), horizonDays = 90 } = {}) {
  const base = bjParts(now);
  const today = iso(base.y, base.m, base.d);
  const h = addDays(base.y, base.m, base.d, horizonDays);
  const horizon = iso(h.y, h.m, h.d);
  const items = Array.isArray(news) ? news : [];

  const timed = [], outOfWindow = [];
  for (const n of items) {
    const title = String(n.title || n.titleZh || '').trim();
    const desc = String(n.desc || n.description || n.translation || '').trim();
    const text = (title + ' ' + desc).trim();
    if (!text) continue;
    const t = extractTime(text, base);
    if (!t) continue;
    if (t.date < today || t.date > horizon) { outOfWindow.push({ title: title.slice(0, 60), date: t.date }); continue; }
    const forecast = FORECAST_RE.test(text);
    const impacts = matchImpact(text);
    const rec = {
      key: 'N-' + md5(String(n.id || '') + '|' + title.slice(0, 40)),
      newsId: n.id || null,
      title: title.slice(0, 130),
      desc: desc.slice(0, 400),
      source: n.source || n.feed || '新闻源',
      url: gate.normalizeUrl(n.link || n.url || null),
      publishedAt: n.publishedAt || null,
      date: t.date, dateBasis: t.basis, dateConfidence: t.confidence,
      phrase: t.phrase || null,
      past: !!t.past, forecastBound: !!t.forecastBound,
      forecast,
      impacts: impacts.map(x => x.name),
      sectors: [...new Set(impacts.flatMap(x => x.sectors))]
    };
    // ① 确定性硬闸门（fail-closed）：时间绑定 / 未来事件 / 信源分级 / 真伪措辞
    rec.rule = gate.checkAdmissibility(rec);
    rec.fingerprint = rec.rule.fingerprint;
    timed.push(rec);
  }
  return { base, today, horizon, horizonDays, now, items, timed, outOfWindow };
}

/** 把「准入通过」的候选转成日历事件对象，并把审查元数据一并带上供前端展示 */
function toCalendarEvent(r) {
  const primary = r.impacts[0] || '市场事件';
  const scanKey = 'news-' + r.date + '-' + md5(primary);
  const m = r.merged || {};
  return {
    scanKey, id: 'FE-N-' + md5(scanKey),
    date: r.date,
    name: primary + '（新闻线索 · ' + r.date.slice(5) + '）',
    grade: r.dateConfidence === 'explicit' ? 'A' : 'B',
    category: '新闻确定时间事件',
    detail: '新闻线索：' + r.title + '（来源 ' + r.source +
      (r.publishedAt ? '，发布 ' + new Date(r.publishedAt + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '') + '）。' +
      '时间依据：' + r.dateBasis + '。命中主题：' + (r.impacts.join('、') || '未映射') + '。相关板块：' + (r.sectors.join('、') || '未映射') + '。' +
      ' 【提示：日期来自新闻文本/相对时间推算，非官方日历确认，请以官方公布为准；本条已过准入闸门与信源分级，程序不对消息真伪作事实裁定。】',
    sectors: r.sectors,
    source: 'news-scan',
    confirmLevel: r.dateConfidence === 'explicit' ? 'news-explicit-date' : (r.dateConfidence === 'window' ? 'news-window-estimate' : 'news-relative-estimate'),
    dateBasis: r.dateBasis,
    verified: false,
    newsRef: { title: r.title, source: r.source, url: r.url, publishedAt: r.publishedAt, newsId: r.newsId },
    gate: {
      decision: m.finalDecision || 'review',
      ruleDecision: r.rule.decision,
      sourceTier: r.rule.sourceTier,
      truthStatus: r.rule.truthStatus,
      humanAdmitted: !!m.humanAdmitted,
      aiReviewed: !!(m.ai && m.ai.reviewed),
      aiBackend: (m.ai && m.ai.backend) || null,
      aiSuggestion: (m.ai && m.ai.admitSuggestion) || null,
      checkedAt: r.rule.checkedAt,
      gateVersion: r.rule.gateVersion,
      label: m.humanAdmitted ? '人工复核放行' : (m.ai && m.ai.reviewed ? '闸门通过 · 智能体已审查' : '闸门通过')
    }
  };
}

/** 需要送智能体审查的候选：确定性明确驳回的、已进黑名单的，不再浪费 token */
function needAIReview(timed) {
  return timed.filter(r => r.rule.decision !== 'reject' && !gate.isBlacklisted(r));
}

/** 定时扫描（同步）：只读审查缓存，并后台预热缓存，本次按 fail-closed 处理无 AI 结论的候选 */
let _aiWarmPending = false;
function warmAICache(need, opts) {
  if (_aiWarmPending || !need.length || !opts || !opts.hermes || typeof gate.aiReview !== 'function') return;
  _aiWarmPending = true;
  Promise.resolve()
    .then(() => gate.aiReview(opts.cfg || {}, opts.hermes, need, { noAI: opts.noAI }))
    .catch(e => console.warn('[calendar-gate] AI 审查缓存预热失败：' + (e && e.message)))
    .finally(() => { _aiWarmPending = false; });
}

/** 核心决策 + 落盘（同步），scan / scanAsync 共用 */
function finalizeScan(c, opts = {}) {
  const { base, today, horizon, horizonDays, now, items, timed } = c;
  const need = needAIReview(timed);
  // ② 智能体审查结论：手动扫描实时传 aiItems；定时扫描读缓存并后台预热
  const aiItems = Array.isArray(opts.aiItems) ? opts.aiItems : gate.cachedReviews(need);
  if (!Array.isArray(opts.aiItems)) warmAICache(need, opts);
  const aiByKey = new Map(aiItems.map(x => [String(x.key), x]));

  const admitted = [], rejected = [], reviewItems = [], skippedBlacklist = [], whitelistAdmitted = [];
  for (const r of timed) {
    const whitelisted = gate.isWhitelisted(r);
    if (gate.isBlacklisted(r) && !whitelisted) { skippedBlacklist.push(r); continue; }
    // ③ 合并：AI 无权把 reject 升级为 admit；无 AI 结论的 admit 一律降级为 review
    const ai = aiByKey.get(String(r.key)) || null;
    r.merged = whitelisted
      ? { ...r.rule, finalDecision: 'admit', ai: null, humanAdmitted: true }
      : gate.mergeDecision(r.rule, ai);
    if (whitelisted) whitelistAdmitted.push(r);
    if (r.merged.finalDecision === 'admit') admitted.push(r);
    else if (r.merged.finalDecision === 'reject') rejected.push(r);
    else reviewItems.push(r);
  }

  // 明确驳回 → 登记指纹黑名单，防止下次定时扫描回写
  if (rejected.length) gate.addBlacklist(rejected.map(r => ({ ...r, rule: r.rule, rejectedBy: 'gate-rule' })));

  // 新闻事件合并：同一「日期 + 主影响类」只保留信息量最大的一条，避免同一事件多条新闻刷屏
  const merged = new Map();
  for (const r of admitted) {
    const key = r.date + '|' + (r.impacts[0] || r.title.slice(0, 12));
    const cur = merged.get(key);
    if (!cur || (r.dateConfidence === 'explicit' && cur.dateConfidence !== 'explicit')) merged.set(key, r);
  }
  const newsEvents = [...merged.values()].map(toCalendarEvent);

  // 复核队列落盘：reject 与 review 都进队列，供人工查看 / 放行 / 驳回（不静默丢弃）
  const reviewRows = reviewItems.concat(rejected).map(r => ({
    key: r.key,
    scanKey: 'news-' + r.date + '-' + md5(r.impacts[0] || r.title.slice(0, 12)),
    title: r.title, source: r.source, url: r.url,
    date: r.date, dateBasis: r.dateBasis, dateConfidence: r.dateConfidence,
    impacts: r.impacts, sectors: r.sectors,
    finalDecision: r.merged.finalDecision,
    rule: r.rule, ai: r.merged.ai,
    fingerprint: r.fingerprint
  }));
  const gateSummary = {
    gateVersion: 'calendar-gate-v1',
    timedCandidates: timed.length,
    sentToAI: need.length,
    aiReviewed: aiItems.filter(x => x && x.reviewed !== false).length,
    aiBackend: opts.aiMeta ? opts.aiMeta.backend : (aiItems[0] && aiItems[0].backend) || 'cache',
    aiOk: opts.aiMeta ? opts.aiMeta.ok : true,
    aiError: opts.aiMeta ? opts.aiMeta.error : null,
    admitted: newsEvents.length,
    rejected: rejected.length,
    review: reviewItems.length,
    blacklistSkipped: skippedBlacklist.length,
    whitelistAdmitted: whitelistAdmitted.length
  };
  gate.saveReview(reviewRows, gateSummary);

  // 周期规则兜底：系统按规律推算的宏观日历，非新闻线索，不参与「消息真伪」闸门，
  // 但同样保留 verified=false / dateBasis 标注，并在事件上注明来源性质。
  const ruleEvents = expandExtraRules(base, horizonDays).map(e => ({
    ...e,
    gate: {
      decision: 'rule-generated', ruleDecision: 'rule-generated',
      sourceTier: 'system-calendar-rule', truthStatus: 'not-a-news-claim',
      aiReviewed: false, humanAdmitted: false, checkedAt: bjNow(now),
      gateVersion: 'calendar-gate-v1',
      label: '系统周期规则推算（非新闻线索，无需真伪核验）'
    }
  }));
  const all = newsEvents.concat(ruleEvents);

  // 入历：只有「闸门 admit + 人工白名单」的新闻事件才能走到这里
  let created = 0, updated = 0;
  const failed = [];
  for (const ev of all) {
    try {
      const r = cal.upsertEvent(ev);
      if (!r.ok) failed.push({ scanKey: ev.scanKey, error: r.error });
      else if (r.action === 'created') created++;
      else updated++;
    } catch (e) { failed.push({ scanKey: ev.scanKey, error: e.message }); }
  }

  const report = {
    ok: true,
    generatedAt: bjNow(now),
    scannedAt: today,
    horizon: { from: today, to: horizon, days: horizonDays },
    coverage: {
      scannedNews: items.length,
      timedCandidates: timed.length,
      relevantMatched: admitted.length,
      relevantMerged: newsEvents.length,
      reviewQueue: reviewRows.length,
      calendarRules: ruleEvents.length,
      totalUpsertCandidates: all.length,
      created, updated, failed: failed.length
    },
    gate: gateSummary,
    // 待复核队列：含准入结论、信源等级、真伪状态、理由与核实途径，供人工放行/驳回
    reviewQueue: reviewRows.slice(0, 60).map(r => ({
      date: r.date, title: r.title, source: r.source, url: r.url,
      dateBasis: r.dateBasis, impacts: r.impacts,
      decision: r.finalDecision,
      sourceTier: r.rule.sourceTier, truthStatus: r.rule.truthStatus,
      reasons: (r.rule.rejectHits || []).concat(r.rule.reviewHits || []).slice(0, 6),
      verifyHints: r.rule.verifyHints || [],
      ai: r.ai || null,
      fingerprint: r.fingerprint
    })),
    // 明确驳回样例（便于核对这条英伟达消息确实被挡住）
    rejectedSample: rejected.slice(0, 12).map(r => ({
      date: r.date, title: r.title, source: r.source,
      reasons: r.rule.rejectHits, fingerprint: r.fingerprint
    })),
    upserted: all.slice(0, 80).map(e => ({
      date: e.date, name: e.name, grade: e.grade, source: e.source,
      confirmLevel: e.confirmLevel, dateBasis: e.dateBasis,
      gate: e.gate ? { decision: e.gate.decision, label: e.gate.label } : null
    })),
    failures: failed.slice(0, 20),
    note: '扫描覆盖服务内存中的全部新闻（非精选条数）。准入顺序：① 确定性硬闸门（未来事件 / 时间绑定 / 信源分级 / 真伪措辞，默认拒绝）→ ' +
      '② 智能体结构化审查（仅建议标注，不预判行情、不改事实）→ ③ 合并决策（AI 无权把驳回升级为放行；无 AI 结论者一律降级为待复核）。' +
      '仅 admit 才写入日程；reject 登记黑名单防回写；review/reject 进复核台由人工裁决。' +
      '周期规则为系统按惯例推算的宏观日历，非新闻线索，单独标注来源性质。' +
      '所有相对时间/规律推算均标注 confirmLevel 与 dateBasis，verified=false，绝不冒充官方已公布。'
  };
  writeJson(F_REPORT, report);
  return report;
}

/** 同步扫描（每小时定时任务 / 冷启动）：本次按缓存中的 AI 结论决策，并后台预热缓存 */
function scan(opts = {}) { return finalizeScan(collectCandidates(opts), opts); }

/** 异步扫描（手动按钮 / API）：先实时跑智能体审查，再带着完整结论决策，一次出结果 */
async function scanAsync(opts = {}) {
  const c = collectCandidates(opts);
  const need = needAIReview(c.timed);
  let ai = { ok: true, reviewed: 0, backend: null, items: [], skipped: true };
  if (need.length && opts.hermes && opts.noAI !== true) {
    try { ai = await gate.aiReview(opts.cfg || {}, opts.hermes, need, { noAI: opts.noAI }); }
    catch (e) { ai = { ok: false, reviewed: 0, backend: null, items: [], error: e.message }; }
  }
  return finalizeScan(c, {
    ...opts,
    aiItems: ai.items || [],
    aiMeta: { ok: ai.ok, backend: ai.backend, reviewed: ai.reviewed, error: ai.error || null, skipped: !!ai.skipped }
  });
}

function report() { return readJson(F_REPORT) || { ok: false, note: '尚未执行扫描，请调用 /api/v2/future-events/scan' }; }
function scannedEvents() {
  try { return cal.readUserEvents().filter(e => e.source === 'news-scan' || e.source === 'calendar-rule'); }
  catch (_) { return []; }
}
function status() {
  const r = report();
  return { ok: !!r.ok, generatedAt: r.generatedAt || null, coverage: r.coverage || null, events: scannedEvents().length };
}

module.exports = {
  scan, scanAsync, collectCandidates, report, status, scannedEvents,
  extractTime, matchImpact, EXTRA_RULES, F_REPORT
};
