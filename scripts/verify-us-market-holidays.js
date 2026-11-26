'use strict';
/**
 * verify-us-market-holidays.js — 美股休市日历接入验收（零依赖，可反复运行）
 *
 * 校验四类不变量：
 *   1) 日期逐条与 NYSE 官网「Holidays & Trading Hours」2026/2027/2028 表一致
 *   2) 分级纪律：已公布=A/已确认/官方源；2029+=B/未确认/规则推算，绝不冒充已公布
 *   3) 日历引擎：view / upcoming / expandRules 正常出事件，且不进自动提醒弹框
 *   4) 不污染 events.jsonl（新闻扫描 / 用户事件文件），前端已接入专用样式
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const us = require('../server/us-market-holidays');
const cal = require('../server/calendar');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + ' -> ' + e.message); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

/* —— 官网逐条照录的期望值（独立硬编码，用于交叉核对模块内数据，防止手抄错误） —— */
const EXPECT_CLOSED = {
  2026: ['2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25'],
  2027: ['2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24'],
  // 2028-01-01 为周六，NYSE 官网脚注明确「不另设元旦休市日」→ 全年 9 天
  2028: ['2028-01-17','2028-02-21','2028-04-14','2028-05-29','2028-06-19','2028-07-04','2028-09-04','2028-11-23','2028-12-25']
};
const EXPECT_EARLY = ['2026-11-27','2026-12-24','2027-11-26','2028-07-03','2028-11-24'];

console.log('=== 美股休市日历接入验收 ===\n');

console.log('[1] 官方日期与来源');
check('2026 全天休市 10 天，逐条一致', () => {
  assert.deepEqual(Object.keys(us.OFFICIAL_CLOSED[2026]).map(k => us.OFFICIAL_CLOSED[2026][k][0]), EXPECT_CLOSED[2026]);
});
check('2027 全天休市 10 天，逐条一致', () => {
  assert.deepEqual(Object.keys(us.OFFICIAL_CLOSED[2027]).map(k => us.OFFICIAL_CLOSED[2027][k][0]), EXPECT_CLOSED[2027]);
});
check('2028 全天休市 9 天（元旦周六不补休），逐条一致', () => {
  assert.deepEqual(Object.keys(us.OFFICIAL_CLOSED[2028]).map(k => us.OFFICIAL_CLOSED[2028][k][0]), EXPECT_CLOSED[2028]);
});
check('提前收盘 5 天，均为官网脚注明确列出', () => {
  assert.deepEqual(us.OFFICIAL_EARLY_CLOSE.map(r => r[0]), EXPECT_EARLY);
});
check('来源可追溯：发布方 / 页面 URL / 核实日期齐全', () => {
  const s = us.SOURCE;
  assert.match(s.publisher, /New York Stock Exchange/);
  assert.equal(s.url, 'https://www.nyse.com/markets/hours-calendars');
  assert.match(s.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
});
check('所有官方休市日均落在工作日（Mon–Fri）', () => {
  for (const d of Object.values(EXPECT_CLOSED).flat().concat(EXPECT_EARLY)) {
    const w = new Date(d + 'T00:00:00Z').getUTCDay();
    assert.ok(w >= 1 && w <= 5, d + ' 落在周末');
  }
});

console.log('\n[2] 分级纪律：已公布 vs 推算');
check('官方年份全部 grade=A / confirmed=true / source=nyse-official', () => {
  for (const y of [2026, 2027, 2028]) {
    for (const e of us.eventsForYear(y, null)) {
      assert.equal(e.grade, 'A', y + ' ' + e.date + ' 等级错误');
      assert.equal(e.confirmed, true, y + ' ' + e.date + ' 未标已确认');
      assert.equal(e.verified, true);
      assert.equal(e.source, 'nyse-official');
      assert.equal(e.officialUrl, us.SOURCE.url);
      assert.equal(e.market, 'US');
      assert.ok(['closed', 'early-close'].includes(e.marketStatus));
    }
  }
});
check('全天休市 detail 显式说明「仅美股 / A 股照常 / 非行情预判」', () => {
  const e = us.eventsForYear(2026, 11).find(x => x.date === '2026-11-26');
  assert.ok(e);
  for (const kw of ['仅指美国股票市场', 'A 股', '非新闻线索', '非行情预判']) assert.ok(e.detail.includes(kw), '缺 ' + kw);
});
check('提前收盘 detail 含 13:00 ET 与期权 13:15 ET', () => {
  const e = us.eventsForYear(2026, 11).find(x => x.date === '2026-11-27');
  assert.ok(e && e.detail.includes('13:00') && e.detail.includes('13:15'));
  assert.equal(e.earlyCloseET, '13:00 ET（期权 13:15 ET）');
  assert.equal(e.marketStatus, 'early-close');
});
check('2029 推算：grade=B / confirmed=false / 明确待官方确认', () => {
  const list = us.eventsForYear(2029, null);
  assert.equal(list.length, 10, '2029 应推算 10 个全天休市');
  for (const e of list) {
    assert.equal(e.grade, 'B');
    assert.equal(e.confirmed, false);
    assert.equal(e.verified, false);
    assert.equal(e.source, 'nyse-rule-projection');
    assert.ok(e.detail.includes('具体日期以 NYSE'), '缺「待官方确认」措辞');
    assert.equal(e.marketStatus, 'closed');
  }
});
check('2029 推算不生成提前收盘（官网未公布，不臆造）', () => {
  assert.equal(us.eventsForYear(2029, null).filter(e => e.marketStatus === 'early-close').length, 0);
});
check('2029 推算日期全为工作日、递增且无重复', () => {
  const ds = us.eventsForYear(2029, null).map(e => e.date);
  assert.equal(new Set(ds).size, ds.length);
  assert.deepEqual(ds, [...ds].sort());
  for (const d of ds) { const w = new Date(d + 'T00:00:00Z').getUTCDay(); assert.ok(w >= 1 && w <= 5, d + ' 落在周末'); }
});
check('2028 元旦（周六）确实没有生成休市事件', () => {
  assert.equal(us.eventsForYear(2028, 1).some(e => e.date === '2028-01-01'), false);
});

console.log('\n[3] 日历引擎接入');
check('expandRules(2026,11) 含感恩节休市与次日提前收盘', () => {
  const list = cal.expandRules(2026, 11);
  assert.ok(list.some(e => e.id === 'US-C-20261126' && e.category === '美股休市'));
  assert.ok(list.some(e => e.id === 'US-E-20261127' && e.category === '美股提前收盘'));
});
check('view(2026-11) 返回 marketClosedDates / marketEarlyCloseDates', () => {
  const v = cal.view({ year: 2026, month: 11 });
  assert.deepEqual(v.marketClosedDates, ['2026-11-26']);
  assert.deepEqual(v.marketEarlyCloseDates, ['2026-11-27']);
  assert.ok(v.byDate['2026-11-26'].some(e => e.id === 'US-C-20261126'));
});
check('view(2028-01) 元旦无休市标记（官网脚注）', () => {
  const v = cal.view({ year: 2028, month: 1 });
  assert.equal(v.marketClosedDates.includes('2028-01-01'), false);
  assert.equal(v.marketClosedDates.length, 1); // 仅 MLK 1/17
});
check('upcoming 含未来休市事件（窗口 40 天，覆盖 11/26、11/27、12/24）', () => {
  const list = cal.upcoming({ days: 40, from: '2026-11-20' });
  assert.ok(list.some(e => e.id === 'US-C-20261126'));
  assert.ok(list.some(e => e.id === 'US-E-20261127'));
  assert.ok(list.some(e => e.id === 'US-E-20261224'));
});
check('dueReminders 不推送休市 / 提前收盘（避免弹框噪音）', () => {
  const due = cal.dueReminders({ aheadDays: 30, now: '2026-11-20' });
  assert.equal(due.some(d => /美股休市|美股提前收盘/.test(d.name)), false);
  assert.equal(due.some(d => String(d.eventId).startsWith('US-')), false);
});
check('官方事件不写入 events.jsonl（不污染新闻扫描 / 用户事件）', () => {
  const p = path.join(ROOT, 'data', 'calendar', 'events.jsonl');
  const txt = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  assert.equal(txt.includes('US-C-'), false);
  assert.equal(txt.includes('US-E-'), false);
  assert.equal(txt.includes('"category":"美股休市"'), false);
});

console.log('\n[4] 前端接入');
check('v2.js：usMkClass / marketClosedDates / NYSE 官方标签', () => {
  const s = read('web/v2/v2.js');
  for (const kw of ['function usMkClass', 'marketClosedDates', 'marketEarlyCloseDates', 'nyse-official', 'us-mk-flag']) {
    assert.ok(s.includes(kw), 'v2.js 缺 ' + kw);
  }
});
check('v2.css：专用色变量与虚线样式', () => {
  const s = read('web/v2/v2.css');
  for (const kw of ['--cal-us:', '.cal-ev.us-mk', '.ce-card.us-mk', '.event-item.us-mk', '.dot.us-mk', '.us-mk-flag']) {
    assert.ok(s.includes(kw), 'v2.css 缺 ' + kw);
  }
});
check('index.html：图例新增美股休市条目', () => {
  assert.ok(read('web/v2/index.html').includes('美股休市 / 提前收盘（NYSE 官方）'));
});
check('calendar.js：已 require 并在 expandRules 合并', () => {
  const s = read('server/calendar.js');
  assert.ok(s.includes("require('./us-market-holidays')"));
  assert.ok(s.includes('usHolidays.eventsForYear(year, month)'));
});

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
