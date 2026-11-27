'use strict';

/**
 * verify-fomc-calendar.js — FOMC 官方日历接入验收
 * 数据源：https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 * 核对日期：2026-11-27
 *
 * 运行：node scripts/verify-fomc-calendar.js
 */
const assert = require('node:assert/strict');
const fomc = require('../server/fomc-calendar');
const cal = require('../server/calendar');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '  -> ' + e.message); }
}
const dates = list => list.map(e => e.date);
const byStart = s => fomc.eventsForYear(2026).find(e => e.date === s);

console.log('==== 1. 官方 2026 日程 ====');
const e26 = fomc.eventsForYear(2026);
check('2026 共 8 次例会', () => assert.equal(e26.length, 8));
check('月份为 1/3/4/6/7/9/10/12（含 4 月、无 5 月）', () => {
  assert.deepEqual(e26.map(e => Number(e.date.slice(5, 7))), [1, 3, 4, 6, 7, 9, 10, 12]);
});
check('首末日期 2026-01-27 / 2026-12-08', () => {
  assert.equal(e26[0].date, '2026-01-27');
  assert.equal(e26[7].date, '2026-12-08');
});
check('每次均为两日会议且 endDate = 起始日 +1', () => {
  for (const e of e26) {
    const d = new Date(e.date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
    assert.equal(e.endDate, d.toISOString().slice(0, 10));
  }
});
check('SEP / 点阵图会议为 3/6/9/12 月共 4 次', () => {
  assert.deepEqual(e26.filter(e => e.sep).map(e => Number(e.date.slice(5, 7))), [3, 6, 9, 12]);
});
check('12 月会议 = 2026-12-08~09、A 级、已确认、含点阵图', () => {
  const e = byStart('2026-12-08');
  assert.ok(e);
  assert.equal(e.endDate, '2026-12-09');
  assert.equal(e.grade, 'A');
  assert.equal(e.verified, true);
  assert.equal(e.confirmed, true);
  assert.equal(e.sep, true);
  assert.equal(e.source, 'fed-official');
});
check('2026 全部为 A 级 / fed-official / 带官方 URL', () => {
  for (const e of e26) {
    assert.equal(e.grade, 'A');
    assert.equal(e.source, 'fed-official');
    assert.match(e.officialUrl, /federalreserve\.gov\/monetarypolicy\/fomccalendars\.htm/);
    assert.equal(e.sourceVerifiedAt, '2026-11-27');
  }
});
check('纪要日期前 7 次照录官网，12 月留空不臆造', () => {
  assert.deepEqual(e26.slice(0, 7).map(e => e.minutesDate),
    ['2026-02-18', '2026-04-08', '2026-05-20', '2026-07-08', '2026-08-19', '2026-10-07', '2026-11-18']);
  assert.equal(e26[7].minutesDate, null);
  assert.match(e26[7].detail, /官网尚未列出/);
});

console.log('==== 2. 会议进程与北京时间换算 ====');
check('12 月决议 = 北京时间 2026-12-10 03:00（EST）', () => {
  assert.equal(byStart('2026-12-08').decisionTimeBJ, '2026-12-10 03:00');
  assert.equal(byStart('2026-12-08').presserTimeBJ, '2026-12-10 03:30');
  assert.equal(byStart('2026-12-08').isUsDst, false);
});
check('3 月决议 = 北京时间 2026-03-19 02:00（EDT）', () => {
  assert.equal(byStart('2026-03-17').decisionTimeBJ, '2026-03-19 02:00');
  assert.equal(byStart('2026-03-17').isUsDst, true);
});
check('detail 含完整进程且标注时刻为「惯例」非官网列示', () => {
  const d = byStart('2026-12-08').detail;
  for (const k of ['会议进程', '14:00', '政策声明', '实施说明', '经济预测摘要', '点阵图', '新闻发布会', '三周', '惯例', '不构成投资建议']) {
    assert.ok(d.includes(k), '缺少：' + k);
  }
  assert.match(d, /官网日历页只列日期不列时刻/);
});
check('detail 明确不预判利率与涨跌', () => {
  assert.match(byStart('2026-12-08').detail, /不预测利率决定结果/);
});

console.log('==== 3. 2027 / 2028 暂定日程 ====');
const e27 = fomc.eventsForYear(2027);
check('2027 共 8 次，全部 B 级 / fed-tentative / 未确认', () => {
  assert.equal(e27.length, 8);
  for (const e of e27) {
    assert.equal(e.grade, 'B');
    assert.equal(e.source, 'fed-tentative');
    assert.equal(e.confirmed, false);
    assert.match(e.detail, /暂定/);
  }
});
check('2027 有 11 月会议、无 12 月会议', () => {
  assert.ok(e27.some(e => e.date === '2027-11-16'));
  assert.ok(!e27.some(e => e.date.startsWith('2027-12')));
});
check('2027 日期与官网 Future Year 一致', () => {
  assert.deepEqual(dates(e27), ['2027-01-26', '2027-03-16', '2027-04-27', '2027-06-08', '2027-07-27', '2027-09-14', '2027-10-26', '2027-11-16']);
});
check('2028 仅官网脚注的 1/25–26 两天会议', () => {
  const e28 = fomc.eventsForYear(2028);
  assert.equal(e28.length, 1);
  assert.equal(e28[0].date, '2028-01-25');
  assert.equal(e28[0].endDate, '2028-01-26');
  assert.equal(e28[0].grade, 'B');
});
check('2029 起官网未公布 → 返回空，不推算', () => {
  assert.deepEqual(fomc.eventsForYear(2029), []);
  assert.deepEqual(fomc.eventsForYear(2030), []);
});
check('status().nextAfter 返回下一次会议 2026-12-08', () => {
  assert.equal(fomc.status().nextAfter('2026-11-27').date, '2026-12-08');
});

console.log('==== 4. 接入日历引擎 ====');
check('旧 fomc 月规则已停用（months 为空，不再生成 12/1 月事件）', () => {
  const r = cal.RULES.find(x => x.id === 'fomc');
  assert.ok(r);
  assert.deepEqual(r.months, []);
});
check('expandRules(2026,12) 只在 12/8 生成 FOMC，且非 allMonth', () => {
  const f = cal.expandRules(2026, 12).filter(e => e.ruleId === 'fomc');
  assert.equal(f.length, 1);
  assert.equal(f[0].date, '2026-12-08');
  assert.equal(f[0].allMonth, false);
  assert.equal(f[0].endDate, '2026-12-09');
});
check('12 月视图：12/8 与 12/9 都有 FOMC 跨天片段', () => {
  const v = cal.view({ year: 2026, month: 12 });
  for (const k of ['2026-12-08', '2026-12-09']) {
    assert.ok((v.byDate[k] || []).some(e => e.ruleId === 'fomc'), k + ' 缺少 FOMC');
  }
  assert.ok(!(v.byDate['2026-12-01'] || []).some(e => e.ruleId === 'fomc'), '12/1 仍残留月事件');
});
check('12/2 仍是 EIA 周报，不是议息会议', () => {
  const v = cal.view({ year: 2026, month: 12 });
  const a = (v.byDate['2026-12-02'] || []).map(e => e.name).join(' | ');
  assert.match(a, /EIA/);
  assert.ok(!a.includes('FOMC') && !a.includes('议息'));
});
check('跨天片段带 spanStart/spanEnd/spanSeg 标记', () => {
  const v = cal.view({ year: 2026, month: 12 });
  const s = v.byDate['2026-12-08'].find(e => e.ruleId === 'fomc');
  const t = v.byDate['2026-12-09'].find(e => e.ruleId === 'fomc');
  assert.equal(s.spanSeg, 'start');
  assert.equal(t.spanSeg, 'end');
  assert.equal(s.spanDays, 2);
});
check('FOMC 进入 A 级提醒（重大事件，不被休市排除）', () => {
  const due = cal.dueReminders({ aheadDays: 14, now: '2026-11-27' });
  assert.ok(due.some(d => d.ruleId === 'fomc' && d.date === '2026-12-08'));
});
check('2027 年暂定会议标 B 级且 verified=false', () => {
  const f = cal.expandRules(2027, 1).filter(e => e.ruleId === 'fomc');
  assert.equal(f.length, 1);
  assert.equal(f[0].grade, 'B');
  assert.equal(f[0].verified, false);
});
check('事件 id 全局唯一、月份过滤有效', () => {
  const all = [2026, 2027, 2028].flatMap(y => fomc.eventsForYear(y));
  assert.equal(new Set(all.map(e => e.id)).size, all.length);
  assert.equal(fomc.eventsForYear(2026, 12).length, 1);
});

console.log('\n==== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ====');
process.exit(fail ? 1 : 0);
