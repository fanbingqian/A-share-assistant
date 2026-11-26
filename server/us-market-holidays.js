'use strict';

/**
 * us-market-holidays.js — 美国股票市场交易日历（NYSE / Nasdaq / NYSE American 等）
 *
 * 【纪律 · 与 calendar.js 的 A/B/C 分级一致，绝不把推算冒充已公布】
 *   1) 2026 / 2027 / 2028：逐条照录 NYSE 官网「Holidays & Trading Hours」页面
 *      公布的确定日期 → grade=A、confirmed=true、source='nyse-official'，
 *      附官方页面 URL、发布方、核实日期。
 *   2) 2029 及以后：按 NYSE 假日规则推算 → grade=B、confirmed=false、
 *      source='nyse-rule-projection'，detail 明确「按规则推算，具体日期以 NYSE
 *      官网年度公告为准」。提前收盘日 NYSE 每年单独公告，推算不覆盖，避免臆造。
 *   3) 只收录「全天休市」与「NYSE 官网脚注明确列出的提前收盘（13:00 ET）」。
 *      第三方日历另列、但官网未确认的提前收盘日期一律不写入。
 *   4) 本表仅指美国**股票**市场。A 股、港股、中国期货照常；美股股指期货与
 *      美国债券市场（SIFMA 日历）另有安排。detail 中显式提示，避免误读。
 *   5) 一次性临时休市（如全国哀悼日）由交易所临时公告，系统不预判。
 *      官网更新后由人工维护 OFFICIAL 即可，不改动任何行情/评分逻辑。
 *
 * 【为什么不放进 data/calendar/events.jsonl】
 *   该文件属于「用户手工录入 + 新闻扫描入历」，受 calendar-gate.js 准入复核台
 *   审查。官方交易日历是制度性常量，与现有 A 股披露截止日 / FOMC 规则事件同属
 *   确定性事件库，直接由 calendar.js 的 expandRules() 生成，不经过新闻准入闸门，
 *   也不会被每小时新闻扫描重复写入。
 */

const SOURCE = {
  publisher: 'New York Stock Exchange (NYSE)',
  page: 'Holidays & Trading Hours',
  url: 'https://www.nyse.com/markets/hours-calendars',
  tradingDaysPdf: 'https://www.nyse.com/publicdocs/Trading_Days.pdf',
  verifiedAt: '2026-11-26',
  note: 'NYSE 官网列示 2026 / 2027 / 2028 三年；NYSE 与 Nasdaq 采用同一股票市场休市日历。'
};

/** 官网明确列出的全天休市日（日期为美东时间当地日期） */
const OFFICIAL_CLOSED = {
  2026: [
    ['2026-01-01', "New Year's Day", '元旦'],
    ['2026-01-19', 'Martin Luther King, Jr. Day', '马丁·路德·金纪念日'],
    ['2026-02-16', "Washington's Birthday", '华盛顿诞辰日（总统日）'],
    ['2026-04-03', 'Good Friday', '耶稣受难日'],
    ['2026-05-25', 'Memorial Day', '阵亡将士纪念日'],
    ['2026-06-19', 'Juneteenth National Independence Day', '六月节'],
    ['2026-07-03', 'Independence Day (observed)', '独立日（7/4 逢周六，提前至周五休市）'],
    ['2026-09-07', 'Labor Day', '劳动节'],
    ['2026-11-26', 'Thanksgiving Day', '感恩节'],
    ['2026-12-25', 'Christmas Day', '圣诞节']
  ],
  2027: [
    ['2027-01-01', "New Year's Day", '元旦'],
    ['2027-01-18', 'Martin Luther King, Jr. Day', '马丁·路德·金纪念日'],
    ['2027-02-15', "Washington's Birthday", '华盛顿诞辰日（总统日）'],
    ['2027-03-26', 'Good Friday', '耶稣受难日'],
    ['2027-05-31', 'Memorial Day', '阵亡将士纪念日'],
    ['2027-06-18', 'Juneteenth National Independence Day (observed)', '六月节（6/19 逢周六，提前至周五休市）'],
    ['2027-07-05', 'Independence Day (observed)', '独立日（7/4 逢周日，顺延至周一休市）'],
    ['2027-09-06', 'Labor Day', '劳动节'],
    ['2027-11-25', 'Thanksgiving Day', '感恩节'],
    ['2027-12-24', 'Christmas Day (observed)', '圣诞节（12/25 逢周六，提前至周五休市）']
  ],
  2028: [
    // 官网脚注：2028-01-01 为周六，不另设元旦休市日（不跨年补休）
    ['2028-01-17', 'Martin Luther King, Jr. Day', '马丁·路德·金纪念日'],
    ['2028-02-21', "Washington's Birthday", '华盛顿诞辰日（总统日）'],
    ['2028-04-14', 'Good Friday', '耶稣受难日'],
    ['2028-05-29', 'Memorial Day', '阵亡将士纪念日'],
    ['2028-06-19', 'Juneteenth National Independence Day', '六月节'],
    ['2028-07-04', 'Independence Day', '独立日'],
    ['2028-09-04', 'Labor Day', '劳动节'],
    ['2028-11-23', 'Thanksgiving Day', '感恩节'],
    ['2028-12-25', 'Christmas Day', '圣诞节']
  ]
};

/** 官网脚注明确列出的提前收盘日（常规时段 13:00 ET 结束，期权 13:15 ET） */
const OFFICIAL_EARLY_CLOSE = [
  ['2026-11-27', 'Day after Thanksgiving', '感恩节次日（黑色星期五）'],
  ['2026-12-24', 'Christmas Eve', '圣诞前夜'],
  ['2027-11-26', 'Day after Thanksgiving', '感恩节次日'],
  ['2028-07-03', 'Day before Independence Day', '独立日前一交易日'],
  ['2028-11-24', 'Day after Thanksgiving', '感恩节次日']
];

const CATEGORY_CLOSED = '美股休市';
const CATEGORY_EARLY = '美股提前收盘';

function ymd(y, m, d) { return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
function dow(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); } // 0=Sun

/** 第 n 个星期几（weekday: 0=Sun..6=Sat） */
function nthWeekday(y, m, weekday, n) {
  const add = (weekday - dow(y, m, 1) + 7) % 7;
  return 1 + add + (n - 1) * 7;
}
/** 当月最后一个星期几 */
function lastWeekday(y, m, weekday) {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return last - ((dow(y, m, last) - weekday + 7) % 7);
}
/** 复活节（匿名公历算法 Meeus/Jones/Butcher），用于推算 Good Friday */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mo = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mo + 114) / 31);
  const day = ((h + l - 7 * mo + 114) % 31) + 1;
  return { m: month, d: day };
}
/** 联邦假日「周六→前周五 / 周日→后周一」观察规则；1/1 逢周六不补休（NYSE 官网 2028 脚注） */
function observed(y, m, d, isNewYear) {
  const w = dow(y, m, d);
  if (w === 6) return isNewYear ? null : { y, m, d: d - 1 };
  if (w === 0) return { y, m, d: d + 1 };
  return { y, m, d };
}

/** 2029+ 规则推算（B 级，仅全天休市；提前收盘不推算） */
function projectedClosed(year) {
  const out = [];
  const push = (label, cn, y, m, d, isNewYear) => {
    const o = observed(y, m, d, !!isNewYear);
    if (!o) return;
    out.push({ date: ymd(o.y, o.m, o.d), en: label, cn: cn + (o.d !== d ? '（观察日）' : '') });
  };
  push("New Year's Day", '元旦', year, 1, 1, true);
  push('Martin Luther King, Jr. Day', '马丁·路德·金纪念日', year, 1, nthWeekday(year, 1, 1, 3));
  push("Washington's Birthday", '华盛顿诞辰日（总统日）', year, 2, nthWeekday(year, 2, 1, 3));
  const es = easter(year);
  const gf = new Date(Date.UTC(year, es.m - 1, es.d - 2));
  push('Good Friday', '耶稣受难日', gf.getUTCFullYear(), gf.getUTCMonth() + 1, gf.getUTCDate());
  push('Memorial Day', '阵亡将士纪念日', year, 5, lastWeekday(year, 5, 1));
  push('Juneteenth National Independence Day', '六月节', year, 6, 19);
  push('Independence Day', '独立日', year, 7, 4);
  push('Labor Day', '劳动节', year, 9, nthWeekday(year, 9, 1, 1));
  push('Thanksgiving Day', '感恩节', year, 11, nthWeekday(year, 11, 4, 4));
  push('Christmas Day', '圣诞节', year, 12, 25);
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const CLOSED_DETAIL_TAIL =
  '仅指美国股票市场（NYSE / Nasdaq / NYSE American 等）全天休市、无常规交易时段；' +
  'A 股、港股与中国期货照常交易，美股股指期货及美国债券市场（SIFMA 日历）另有安排。' +
  '本条为交易所官方日历事实，非新闻线索、非行情预判，不对任何市场走势作判断。';

const EARLY_DETAIL_TAIL =
  '仅指美国股票市场常规交易时段于美东时间 13:00 结束（合资格期权 13:15），' +
  '较通常 16:00 收盘缩短 3 小时；盘前照常，盘后时段缩短或不可用。' +
  'A 股、港股与中国期货照常交易。本条为交易所官方日历事实，非行情预判。';

function closedEvent(date, en, cn, official) {
  return {
    id: 'US-C-' + date.replace(/-/g, ''),
    ruleId: 'us-market-closed',
    date,
    endDate: null,
    allMonth: false,
    name: '美股休市 · ' + cn,
    grade: official ? 'A' : 'B',
    category: CATEGORY_CLOSED,
    detail: (official
      ? 'NYSE 官网名称：' + en + '；中文：' + cn + '。日期来自 NYSE 官方「Holidays & Trading Hours」年度假日表（核实于 ' + SOURCE.verifiedAt + '）。'
      : '按 NYSE 假日规则推算：' + en + '（' + cn + '）。具体日期以 NYSE 官网后续年度公告为准，未官方确认。') +
      CLOSED_DETAIL_TAIL,
    sectors: [],
    source: official ? 'nyse-official' : 'nyse-rule-projection',
    verified: !!official,
    confirmed: !!official,
    dateBasis: official ? ('NYSE 官网年度假日表（' + SOURCE.verifiedAt + ' 核对）') : 'NYSE 假日规则推算 · 待官方确认',
    market: 'US',
    marketStatus: 'closed',
    officialUrl: SOURCE.url,
    sourceVerifiedAt: SOURCE.verifiedAt
  };
}

function earlyEvent(date, en, cn) {
  return {
    id: 'US-E-' + date.replace(/-/g, ''),
    ruleId: 'us-market-early-close',
    date,
    endDate: null,
    allMonth: false,
    name: '美股提前收盘 · ' + cn,
    grade: 'A',
    category: CATEGORY_EARLY,
    detail: 'NYSE 官网脚注列示：' + en + '（' + cn + '）提前收盘，13:00 ET 收盘（期权 13:15 ET）。' + EARLY_DETAIL_TAIL,
    sectors: [],
    source: 'nyse-official',
    verified: true,
    confirmed: true,
    dateBasis: 'NYSE 官网提前收盘脚注（' + SOURCE.verifiedAt + ' 核对）',
    market: 'US',
    marketStatus: 'early-close',
    earlyCloseET: '13:00 ET（期权 13:15 ET）',
    officialUrl: SOURCE.url,
    sourceVerifiedAt: SOURCE.verifiedAt
  };
}

/**
 * 生成指定年份（可按 month 过滤）的美股日历事件。
 * 返回结构与 calendar.js expandRules() 输出一致，可直接并入 byKey。
 */
function eventsForYear(year, month) {
  const y = Number(year);
  const out = [];
  const want = m => !month || Number(month) === m;
  const inMonth = ds => want(Number(String(ds).slice(5, 7)));

  const rows = OFFICIAL_CLOSED[y];
  if (rows) {
    for (const [date, en, cn] of rows) if (inMonth(date)) out.push(closedEvent(date, en, cn, true));
  } else if (y >= 2029 && y <= 2100) {
    for (const x of projectedClosed(y)) if (inMonth(x.date)) out.push(closedEvent(x.date, x.en, x.cn, false));
  }

  // 提前收盘只收录官网已公布的年份，推算年份不生成，避免臆造
  for (const [date, en, cn] of OFFICIAL_EARLY_CLOSE) {
    if (Number(String(date).slice(0, 4)) === y && inMonth(date)) out.push(earlyEvent(date, en, cn));
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.marketStatus).localeCompare(String(b.marketStatus)));
}

/** 供验证 / 诊断使用的官方日期清单 */
function officialDates() {
  const closed = [];
  for (const [y, rows] of Object.entries(OFFICIAL_CLOSED)) for (const r of rows) closed.push(r[0]);
  return { closed, earlyClose: OFFICIAL_EARLY_CLOSE.map(r => r[0]), source: SOURCE };
}

module.exports = {
  SOURCE, OFFICIAL_CLOSED, OFFICIAL_EARLY_CLOSE,
  CATEGORY_CLOSED, CATEGORY_EARLY,
  eventsForYear, officialDates, projectedClosed
};
