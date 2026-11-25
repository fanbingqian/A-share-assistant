'use strict';
/**
 * future-events.js — 未来事件扫描入历（不漏项）
 *
 * 用户要求：查找【所有新闻】里【有确定时间】的内容，对股市有影响/有关联的都纳入日程，不要漏项。
 *
 * 三层保障：
 *  ① 新闻时间抽取：扫描服务内存中的全部新闻（不是只取精选 12 条），识别绝对日期 / 相对周几 /
 *     明日 / 月底 / 英文周几等时间表达，只保留今天及以后、且落在扫描窗口内的条目。
 *  ② 影响筛选与复核队列：命中宏观/政策/财报/解禁/关税等影响词且带预告语义的 → 自动入历；
 *     有确定时间但未命中影响词的 → 进「待复核队列」（不静默丢弃，便于人工确认有没有漏项）。
 *  ③ 周期规则兜底：补齐 calendar.js RULES 里缺失的关键宏观日历（美国 PCE、初请失业金、
 *     EIA 原油库存、零售销售、ISM PMI、GDP、中国 MLF、外汇储备等），按规律推算日期。
 *
 * 诚实标注：新闻相对时间 / 规律推算一律标 confirmLevel 与 dateBasis，verified=false，
 *          detail 里写明「以官方日历为准」，绝不把推算冒充已公布。
 *
 * 落盘：data/calendar/events.jsonl（经 calendar.upsertEvent 去重写入）
 *       data/calendar/future-events-scan.json（最近一次扫描的覆盖率报告）
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cal = require('./calendar');

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

/** 从一段新闻文本里抽取「未来确定时间」；返回 {date, basis, confidence} 或 null */
function extractTime(text, base) {
  const s = String(text || '');
  // 1) 绝对年月日：2026年11月25日
  let m = s.match(/(20\d{2})年(\d{1,2})月(\d{1,2})[日号]?/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (validDate(y, mo, d)) return { date: iso(y, mo, d), basis: '新闻明确日期「' + m[0] + '」', confidence: 'explicit' };
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
      return { date: iso(y, mo, d), basis: '新闻明确日期「' + label + '」' + (m[3] ? '' : '（按当前年份补齐）'), confidence: 'explicit' };
    }
  }
  // 3) 中文相对周几：本周三 / 下周三 / 周三 / 星期四
  m = s.match(/(本周|下周|本|下)?\s*(周[一二三四五六日天]|星期[一二三四五六日天])/);
  if (m) {
    const wd = CN_WEEK[m[2].slice(-1)];
    const prefix = m[1] || '';
    let delta = wd - base.dow;
    if (delta < 0) delta += 7;                       // 本周已过 → 顺延到下周同一天
    if (prefix === '下周' || prefix === '下') delta += 7;
    const t = addDays(base.y, base.m, base.d, delta);
    return { date: iso(t.y, t.m, t.d), basis: '新闻相对时间「' + m[0] + '」按当前周推算', confidence: 'relative' };
  }
  // 4) 英文周几：next Wednesday / on Friday
  m = s.match(/\b(next|this)?\s*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
  if (m) {
    const wd = EN_WEEK[m[2].toLowerCase()];
    let delta = wd - base.dow;
    if (delta < 0) delta += 7;
    if (m[1] && /next/i.test(m[1])) delta += 7;
    const t = addDays(base.y, base.m, base.d, delta);
    return { date: iso(t.y, t.m, t.d), basis: '新闻相对时间「' + m[0] + '」按当前周推算', confidence: 'relative' };
  }
  // 5) 明日 / 后天 / 今日 / 今晚
  m = s.match(/(明日|明天|后天|今日|今晚)/);
  if (m) {
    const n = /后天/.test(m[1]) ? 2 : (/今日|今晚/.test(m[1]) ? 0 : 1);
    const t = addDays(base.y, base.m, base.d, n);
    return { date: iso(t.y, t.m, t.d), basis: '新闻相对时间「' + m[1] + '」推算', confidence: 'relative' };
  }
  // 6) 模糊窗口：月底 / 月末 / 下旬 / 中旬 / 下月初（取该窗口代表日，标注为窗口推算）
  m = s.match(/(月底|月末|下旬|中旬|下月初|下周|本周)/);
  if (m) {
    let t;
    if (/中旬/.test(m[1])) t = { y: base.y, m: base.m, d: Math.min(15, daysInMonth(base.y, base.m)) };
    else if (/下月初/.test(m[1])) { const nm = addMonths(base.y, base.m, 1); t = { y: nm.y, m: nm.m, d: 3 }; }
    else if (/下旬|月底|月末/.test(m[1])) t = { y: base.y, m: base.m, d: daysInMonth(base.y, base.m) };
    else t = addDays(base.y, base.m, base.d, /下周/.test(m[1]) ? 7 : 0);
    return { date: iso(t.y, t.m, t.d), basis: '新闻模糊窗口「' + m[1] + '」取代表日（区间未精确）', confidence: 'window' };
  }
  return null;
}

/** 预告语义：区分「将要发生」与「已经发生/一般陈述」 */
const FORECAST_RE = /(将于|定于|计划于|拟于|预计|将在|将公布|将发布|将出炉|将揭晓|将召开|将举行|将披露|公布|发布|出炉|揭晓|召开|举行|生效|实施|披露|申购|上市|到期|登场|开幕|揭幕|决议|数据|报告|会议|will\s+(?:release|publish|report|announce)|is\s+(?:due|scheduled|set)\s+to|scheduled\s+for|due\s+on)/i;

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
  { name: '美股科技巨头财报', cat: '海外业绩', sectors: ['科技', '算力', '消费电子'], kw: ['英伟达', '苹果', '特斯拉', '微软', '谷歌', 'nvidia', 'apple', 'tesla'] },
  { name: '选举 / 地缘 / 协议', cat: '国际事件', sectors: ['黄金', '军工', '全市场'], kw: ['大选', '选举', '公投', '停火', '谈判', '协议', 'election', 'ceasefire'] },
  { name: '医药政策', cat: '医药政策', sectors: ['创新药', '医药', '中药'], kw: ['医保', '集采', '药审', '创新药', '带量采购'] },
  { name: '新能源 / 产业政策', cat: '产业政策', sectors: ['光伏', '储能', '电力设备'], kw: ['光伏', '新能源', '装机', '储能', '以旧换新', '补贴'] }
];
function matchImpact(text) {
  const s = String(text || '');
  const hits = [];
  for (const r of IMPACT_RULES) if (r.kw.some(k => s.toLowerCase().includes(String(k).toLowerCase()))) hits.push(r);
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

/* ---------------------- ③ 扫描主流程 ---------------------- */

function scan({ news = [], now = Date.now(), horizonDays = 90 } = {}) {
  const base = bjParts(now);
  const today = iso(base.y, base.m, base.d);
  const h = addDays(base.y, base.m, base.d, horizonDays);
  const horizon = iso(h.y, h.m, h.d);
  const items = Array.isArray(news) ? news : [];

  const timed = [];
  const relevant = [];
  const review = [];
  for (const n of items) {
    const title = String(n.title || n.titleZh || '').trim();
    const desc = String(n.desc || n.description || n.translation || '').trim();
    const text = title + ' ' + desc;
    if (!text.trim()) continue;
    const t = extractTime(text, base);
    if (!t) continue;
    if (t.date < today || t.date > horizon) continue;
    const forecast = FORECAST_RE.test(text);
    const impacts = matchImpact(text);
    const rec = {
      newsId: n.id || null, title: title.slice(0, 130),
      source: n.source || n.feed || '新闻源', url: n.link || n.url || null,
      publishedAt: n.publishedAt || null,
      date: t.date, dateBasis: t.basis, dateConfidence: t.confidence,
      forecast, impacts: impacts.map(x => x.name), sectors: [...new Set(impacts.flatMap(x => x.sectors))]
    };
    timed.push(rec);
    if (impacts.length && forecast) relevant.push(rec);
    else review.push(rec);
  }

  // 新闻事件合并：同一「日期 + 主影响类」只保留信息量最大的一条，避免同一事件多条新闻刷屏
  const merged = new Map();
  for (const r of relevant) {
    const primary = r.impacts[0] || r.title.slice(0, 12);
    const key = r.date + '|' + primary;
    const cur = merged.get(key);
    if (!cur || (r.dateConfidence === 'explicit' && cur.dateConfidence !== 'explicit')) merged.set(key, r);
  }
  const newsEvents = [...merged.values()].map(r => {
    const primary = r.impacts[0] || '市场事件';
    const scanKey = 'news-' + r.date + '-' + md5(primary);
    return {
      scanKey, id: 'FE-N-' + md5(scanKey),
      date: r.date,
      name: primary + '（新闻线索 · ' + r.date.slice(5) + '）',
      grade: r.dateConfidence === 'explicit' ? 'A' : 'B',
      category: '新闻确定时间事件',
      detail: '新闻线索：' + r.title + '（来源 ' + r.source + (r.publishedAt ? '，发布 ' + new Date(r.publishedAt + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '') + '）。' +
        '时间依据：' + r.dateBasis + '。命中主题：' + r.impacts.join('、') + '。相关板块：' + (r.sectors.join('、') || '未映射') + '。' +
        ' 【提示：日期来自新闻文本/相对时间推算，非官方日历确认，请以官方公布为准。】',
      sectors: r.sectors,
      source: 'news-scan',
      confirmLevel: r.dateConfidence === 'explicit' ? 'news-explicit-date' : (r.dateConfidence === 'window' ? 'news-window-estimate' : 'news-relative-estimate'),
      dateBasis: r.dateBasis,
      verified: false,
      newsRef: { title: r.title, source: r.source, url: r.url, publishedAt: r.publishedAt, newsId: r.newsId }
    };
  });

  const ruleEvents = expandExtraRules(base, horizonDays);
  const all = newsEvents.concat(ruleEvents);

  // 入历：按 scanKey 去重写入（同键只更新，不重复追加）
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
      relevantMatched: relevant.length,
      relevantMerged: newsEvents.length,
      reviewQueue: review.length,
      calendarRules: ruleEvents.length,
      totalUpsertCandidates: all.length,
      created, updated, failed: failed.length
    },
    // 待复核队列：有确定时间但未命中影响词/预告语义，不静默丢弃，供人工核对是否漏项
    reviewQueue: review.slice(0, 60).map(r => ({
      date: r.date, title: r.title, source: r.source, url: r.url,
      dateBasis: r.dateBasis, forecast: r.forecast, impacts: r.impacts,
      reason: r.impacts.length ? '命中影响词但缺少预告语义（可能已发生）' : '有确定时间但未命中股市影响词'
    })),
    // 本次入历的事件摘要（便于核对 PCE 等是否落入）
    upserted: all.slice(0, 80).map(e => ({
      date: e.date, name: e.name, grade: e.grade, source: e.source,
      confirmLevel: e.confirmLevel, dateBasis: e.dateBasis
    })),
    failures: failed.slice(0, 20),
    note: '扫描覆盖服务内存中的全部新闻（非精选条数）；带确定时间且命中股市影响词+预告语义者自动入历，' +
      '未命中者进入待复核队列不丢弃；周期规则兜底补齐 calendar RULES 缺失的宏观日历。' +
      '所有相对时间/规律推算均标注 confirmLevel 与 dateBasis，verified=false，绝不冒充官方已公布。'
  };
  writeJson(F_REPORT, report);
  return report;
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

module.exports = { scan, report, status, scannedEvents, extractTime, EXTRA_RULES, F_REPORT };
