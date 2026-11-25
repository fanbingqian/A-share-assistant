'use strict';
/**
 * verify-gate-decide.js — 准入复核台「人工放行 / 驳回」端到端验证（自清理）
 *
 * 通过真实 HTTP 接口调用 /api/v2/calendar/gate/decide，验证：
 *   ① 人工放行 → 立即写入日历（source=gate-human-admit、gate.humanAdmitted=true）+ 写豁免白名单
 *   ② 人工驳回 → 加入黑名单防回写，并从复核队列移除
 *   ③ 黑名单指纹确实能拦住同名候选（isBlacklisted=true）
 *
 * 自清理：测试条目、写入的测试事件、白名单/黑名单/复核队列改动全部还原，
 * 不污染用户真实日程与配置。需本机 8777 服务在运行。
 *
 * 运行：node scripts/verify-gate-decide.js
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const gate = require(path.join(ROOT, 'server', 'calendar-gate'));
const cal = require(path.join(ROOT, 'server', 'calendar'));

const API = 'http://127.0.0.1:8777';
const F_REVIEW = gate.F_REVIEW;
const F_BLACKLIST = gate.F_BLACKLIST;
const F_WHITELIST = path.join(ROOT, 'data', 'calendar', 'gate-whitelist.json');
const F_EVENTS = cal.USER_FILE;

function readRaw(f) { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } }
function restore(f, raw) {
  if (raw === null) { try { fs.unlinkSync(f); } catch (_) {} }
  else fs.writeFileSync(f, raw, 'utf8');
}
async function post(p, body) {
  const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

const TEST_ADMIT = {
  fingerprint: 'TESTADMIT0001',
  scanKey: 'gate-verify-admit-0001',
  title: '【验证用】某官方机构将于12月20日公布月度宏观数据',
  source: '验证脚本', url: null,
  date: '2026-12-20', dateBasis: '新闻明确日期「12月20日」',
  decision: 'review', sourceTier: 'official', truthStatus: 'official-firsthand-available',
  reasons: ['日期为相对/窗口推算，需以官方日历校准'],
  verifyHints: ['以主办方官网确认准确日期'],
  impacts: ['CPI / 通胀数据'], sectors: ['消费', '黄金'],
  ai: null
};
const TEST_REJECT = {
  fingerprint: 'TESTREJECT001',
  scanKey: 'gate-verify-reject-0001',
  title: '【验证用】报道：某公司立场反转，决策未征询高管',
  source: '验证脚本', url: null,
  date: '2026-12-21', dateBasis: '新闻相对时间「上周日」按当前周推算',
  decision: 'review', sourceTier: 'anonymous', truthStatus: 'anonymous-unverified',
  reasons: ['R4 匿名信源或未经证实细节'], verifyHints: [],
  impacts: [], sectors: [], ai: null
};

(async () => {
  const backup = {
    review: readRaw(F_REVIEW), blacklist: readRaw(F_BLACKLIST),
    whitelist: readRaw(F_WHITELIST), events: readRaw(F_EVENTS)
  };
  const results = [];
  let createdEventId = null;
  try {
    // 注入两条测试复核条目
    const rv = gate.loadReview();
    rv.items = [TEST_ADMIT, TEST_REJECT].concat(rv.items || []);
    fs.writeFileSync(F_REVIEW, JSON.stringify(rv, null, 2), 'utf8');

    // ① 人工放行
    const a = await post('/api/v2/calendar/gate/decide', { fingerprint: TEST_ADMIT.fingerprint, action: 'admit', by: 'verify-script' });
    const rows = cal.readUserEvents();
    const ev = rows.find(x => x.source === 'gate-human-admit' && x.scanKey === TEST_ADMIT.scanKey);
    createdEventId = ev && ev.id;
    const wl = readRaw(F_WHITELIST);
    const passAdmit = !!(a.ok && a.calendarWritten === true && ev && ev.gate && ev.gate.humanAdmitted === true && wl && wl.includes(TEST_ADMIT.fingerprint));
    results.push(['人工放行 → 立即写入日历 + 白名单', passAdmit,
      'calendarWritten=' + a.calendarWritten + ' · 事件=' + (ev ? ev.name : '未找到') + ' · gate.humanAdmitted=' + (ev && ev.gate && ev.gate.humanAdmitted)]);

    // ② 人工驳回
    const b = await post('/api/v2/calendar/gate/decide', { fingerprint: TEST_REJECT.fingerprint, action: 'reject', by: 'verify-script' });
    const bl = gate.loadBlacklist();
    const inBlacklist = (bl.items || []).some(x => x.fingerprint === TEST_REJECT.fingerprint);
    const rv2 = gate.loadReview();
    const removedFromQueue = !(rv2.items || []).some(x => x.fingerprint === TEST_REJECT.fingerprint);
    const passReject = !!(b.ok && inBlacklist && removedFromQueue);
    results.push(['人工驳回 → 黑名单 + 移出复核队列', passReject,
      '黑名单命中=' + inBlacklist + ' · 队列已移除=' + removedFromQueue]);

    // ③ 黑名单防回写
    const blocked = gate.isBlacklisted({ fingerprint: TEST_REJECT.fingerprint, title: TEST_REJECT.title, source: TEST_REJECT.source, scanKey: TEST_REJECT.scanKey });
    results.push(['黑名单指纹拦住同名候选（防回写）', blocked === true, 'isBlacklisted=' + blocked]);
  } catch (e) {
    results.push(['执行异常', false, e.message]);
  } finally {
    // 自清理：删除测试事件、移除黑名单、还原三份文件
    try { if (createdEventId) cal.removeEvent(createdEventId); } catch (_) {}
    try { gate.removeBlacklist(TEST_REJECT.fingerprint); } catch (_) {}
    restore(F_REVIEW, backup.review);
    restore(F_BLACKLIST, backup.blacklist);
    restore(F_WHITELIST, backup.whitelist);
    restore(F_EVENTS, backup.events);
  }

  console.log('='.repeat(72));
  console.log('准入复核台 · 人工裁决端到端验证（已自清理，不改动真实数据）');
  console.log('='.repeat(72));
  let pass = 0;
  for (const [name, ok, detail] of results) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
    console.log('      ' + detail);
    if (ok) pass++;
  }
  console.log('='.repeat(72));
  console.log('结果：' + pass + '/' + results.length + ' 通过');
  console.log('='.repeat(72));
  // 复核还原结果
  const check = cal.readUserEvents().some(x => x.source === 'gate-human-admit' && x.scanKey === TEST_ADMIT.scanKey);
  console.log('清理确认：测试事件残留 = ' + check + '（应为 false）');
  process.exit(pass === results.length && !check ? 0 : 1);
})();
