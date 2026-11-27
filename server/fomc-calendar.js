'use strict';

/**
 * fomc-calendar.js — 美联储 FOMC 议息会议官方日历
 *
 * 【纪律 · 与 calendar.js 的 A/B/C 分级一致，绝不把推算冒充已公布】
 *   1) 2026：逐条照录 Federal Reserve 官网「Meeting calendars, statements,
 *      and minutes」页面公布的确定日期 → grade=A、confirmed=true、
 *      source='fed-official'，附官方 URL 与核实日期。带 * 的会议附
 *      Summary of Economic Projections（SEP，含点阵图）。
 *   2) 2027 / 2028：官网列为 Future Year / 脚注，且明确注明
 *      "Each meeting date is tentative until confirmed at the meeting
 *      immediately preceding it" → grade=B、confirmed=false、
 *      source='fed-tentative'，detail 显式标注「暂定，待前一次会议确认」。
 *   3) 决议公布时刻（美东 14:00 / 主席发布会 14:30）是 FOMC 长期惯例，
 *      官网日历页只列日期、不列时刻，因此本模块把它标为「惯例」而非官方
 *      公布时点；北京时间按美东夏令时/冬令时换算，仅供阅读参考。
 *   4) 会议纪要按「决议后三周」惯例发布。2026 年前 7 次纪要日期官网已列出，
 *      逐条照录；12 月会议官网尚未列出，留 null 并说明，不臆造。
 *   5) 本表只陈述会议日程与流程事实，不含利率路径预判、不含行情方向判断、
 *      不构成投资建议。临时加开的会议（如 notation vote）由官网临时公告，
 *      本表不预判。
 *
 * 【为什么不写进 data/calendar/events.jsonl】
 *   该文件属于「用户手工录入 + 新闻扫描入历」，受 calendar-gate.js 准入复核台
 *   审查。官方会议日历是制度性常量，与美股休市日历、A 股披露截止日同属确定性
 *   事件库，由 calendar.js 的 expandRules() 合并，不经过新闻准入闸门，也不会被
 *   每小时新闻扫描重复写入。
 *
 * 【替代了什么】
 *   原 calendar.js RULES 中 fomc 规则为 months:[1,3,5,6,7,9,10,12]、
 *   dayRule:()=>null，既无具体日期，且把官方 4 月会议误写成 5 月。现该规则
 *   置空（months:[]），由本模块提供逐条官方日期。
 */

const SOURCE = {
  publisher: 'Board of Governors of the Federal Reserve System · Federal Open Market Committee',
  page: 'Meeting calendars, statements, and minutes (2021–2027)',
  url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  verifiedAt: '2026-11-27',
  note: 'FOMC 每年召开 8 次例行会议；带 * 的会议附经济预测摘要（SEP / 点阵图）。会议纪要在政策决定后三周发布。'
};

/**
 * 2026 年（官网已公布，确定日期）
 * [起始日, 结束日, 是否含 SEP, 纪要发布日(官网已列则填), 备注]
 */
const OFFICIAL_2026 = [
  ['2026-01-27', '2026-01-28', false, '2026-02-18', '同期发布《长期目标与货币政策策略声明》'],
  ['2026-03-17', '2026-03-18', true,  '2026-04-08', ''],
  ['2026-04-28', '2026-04-29', false, '2026-05-20', ''],
  ['2026-06-16', '2026-06-17', true,  '2026-07-08', ''],
  ['2026-07-28', '2026-07-29', false, '2026-08-19', ''],
  ['2026-09-15', '2026-09-16', true,  '2026-10-07', ''],
  ['2026-10-27', '2026-10-28', false, '2026-11-18', ''],
  ['2026-12-08', '2026-12-09', true,  null,          '12 月会议纪要官网尚未列出具体日期，按「决议后三周」惯例约在 12 月下旬']
];

/** 2027 年（官网 Future Year，全部 tentative） */
const TENTATIVE_2027 = [
  ['2027-01-26', '2027-01-27', ''],
  ['2027-03-16', '2027-03-17', ''],
  ['2027-04-27', '2027-04-28', ''],
  ['2027-06-08', '2027-06-09', ''],
  ['2027-07-27', '2027-07-28', ''],
  ['2027-09-14', '2027-09-15', ''],
  ['2027-10-26', '2027-10-27', '官网标注为 Monetary Policy Strategy Meeting（货币政策策略会议）'],
  ['2027-11-16', '2027-11-17', '官网 2027 年未列 12 月例会，改列 11 月']
];

/** 2028 年（官网脚注：A two-day meeting is scheduled for January 25-26, 2028） */
const TENTATIVE_2028 = [
  ['2028-01-25', '2028-01-26', '官网脚注列示的两天会议，其余 2028 年日程官网尚未公布']
];

const CATEGORY = '全球央行';
const SECTORS = ['黄金', '美债', '美元', '北向资金', '成长股'];

function ymd(y, m, d) { return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
function datePlus(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** 某月第 n 个星期日（0=Sun）；用于判断美国夏令时区间 */
function nthSunday(y, m, n) {
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}
/** 美国夏令时：3 月第二个周日至 11 月第一个周日（ EDT = UTC-4，否则 EST = UTC-5 ） */
function isUsDst(dateStr) {
  const y = Number(dateStr.slice(0, 4));
  const start = ymd(y, 3, nthSunday(y, 3, 2));
  const end = ymd(y, 11, nthSunday(y, 11, 1));
  return dateStr >= start && dateStr < end;
}
/** 14:00 ET 决议 / 14:30 ET 发布会换算为北京时间（次日凌晨） */
function bjTimes(endDate) {
  const off = isUsDst(endDate) ? 12 : 13; // ET + off = 北京时间
  const next = datePlus(endDate, 1);
  const hh = String(14 + off - 24).padStart(2, '0');
  return {
    decisionBJ: next + ' ' + hh + ':00',
    presserBJ: next + ' ' + hh + ':30',
    tzNote: isUsDst(endDate) ? '美东夏令时 EDT（UTC-4），北京时间 = ET + 12 小时' : '美东冬令时 EST（UTC-5），北京时间 = ET + 13 小时'
  };
}

function fmtRange(start, end) {
  const a = start.slice(5).replace('-', '/');
  const b = end.slice(5).replace('-', '/');
  return a + '–' + b;
}

function buildEvent(start, end, official, { sep = false, minutes = null, note = '' } = {}) {
  const t = bjTimes(end);
  const confirmed = !!official;
  const grade = confirmed ? 'A' : 'B';
  const label = '美联储 FOMC 议息会议（' + fmtRange(start, end) + '）' + (sep ? ' · 含点阵图' : '');
  const head = confirmed
    ? '日期来自美联储官网 FOMC 会议日历（' + SOURCE.verifiedAt + ' 核对），为已公布的确定日期。'
    : '日期来自美联储官网 Future Year 暂定日程；官网明确注明「每次会议日期在前一次会议确认前均为暂定」，本条未官方确认，以官网后续公告为准。';
  const process =
    '【会议进程】两日会议：第一天闭门讨论经济与金融形势；第二天美东时间 14:00 发布政策声明、联邦基金利率决定与实施说明（Implementation Note），' +
    (sep ? '同时发布经济预测摘要 SEP（含点阵图、GDP/通胀/失业率预测）；' : '本次不含经济预测摘要；') +
    '14:30 主席新闻发布会；会议纪要于政策决定三周后发布' +
    (minutes ? '（本次官网列示 ' + minutes + '）' : '（官网尚未列出本次具体日期，按惯例约三周后）') + '。' +
    '按长期惯例换算：决议 ' + t.decisionBJ + '、发布会 ' + t.presserBJ + '（北京时间，' + t.tzNote + '）。' +
    '注：14:00 / 14:30 为 FOMC 长期惯例，官网日历页只列日期不列时刻。';
  const tail =
    '本条为官方会议日程事实，不是新闻线索、不是行情预判；程序不预测利率决定结果，也不给出涨跌方向；本条不构成投资建议。' +
    '会议可能影响美债利率、美元与全球风险偏好，相关板块仅作观察口径。';

  return {
    id: 'FOMC-' + start.replace(/-/g, ''),
    ruleId: 'fomc',
    date: start,
    endDate: end,
    allMonth: false,
    name: label,
    grade,
    category: CATEGORY,
    detail: head + process + (note ? '【官网备注】' + note + '。' : '') + tail,
    sectors: SECTORS.slice(),
    source: confirmed ? 'fed-official' : 'fed-tentative',
    verified: confirmed,
    confirmed,
    dateBasis: confirmed
      ? '美联储官网 FOMC 会议日历（' + SOURCE.verifiedAt + ' 核对）'
      : '美联储官网 Future Year 暂定日程（待前一次会议确认）',
    officialUrl: SOURCE.url,
    sourceVerifiedAt: SOURCE.verifiedAt,
    sep: !!sep,
    minutesDate: minutes || null,
    decisionTimeET: end + ' 14:00 ET（惯例，非官网列示时刻）',
    decisionTimeBJ: t.decisionBJ,
    presserTimeBJ: t.presserBJ,
    isUsDst: isUsDst(end)
  };
}

/** 返回指定年份（可限定月份）的 FOMC 事件；按会议起始日归月 */
function eventsForYear(year, month) {
  const y = Number(year);
  const out = [];
  if (y === 2026) {
    for (const [s, e, sep, minutes, note] of OFFICIAL_2026) {
      out.push(buildEvent(s, e, true, { sep, minutes, note }));
    }
  } else if (y === 2027) {
    for (const [s, e, note] of TENTATIVE_2027) out.push(buildEvent(s, e, false, { note }));
  } else if (y === 2028) {
    for (const [s, e, note] of TENTATIVE_2028) out.push(buildEvent(s, e, false, { note }));
  }
  // 2029 及以后：官网尚未公布，系统不推算、不冒充，直接返回空数组。
  return month ? out.filter(e => Number(e.date.slice(5, 7)) === Number(month)) : out;
}

/** 供复核台/诊断使用 */
function status() {
  return {
    source: SOURCE,
    officialYears: [2026],
    tentativeYears: [2027, 2028],
    counts: { 2026: eventsForYear(2026).length, 2027: eventsForYear(2027).length, 2028: eventsForYear(2028).length },
    nextAfter: function (from) {
      const d = from || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
      return [2026, 2027, 2028].flatMap(y => eventsForYear(y)).filter(e => e.date >= d).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
    }
  };
}

module.exports = {
  SOURCE, OFFICIAL_2026, TENTATIVE_2027, TENTATIVE_2028,
  eventsForYear, status, isUsDst, bjTimes
};
