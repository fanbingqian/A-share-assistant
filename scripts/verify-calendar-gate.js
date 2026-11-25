'use strict';
/**
 * verify-calendar-gate.js — 日程准入闸门可追溯验证
 *
 * 用「用户实际看到的那条英伟达消息」与「应当保留的官方预告事件」做对照语料，
 * 逐条输出确定性闸门结论 / 驳回理由 / 信源等级 / 真伪状态，并验证智能体合并纪律。
 *
 * 纯只读：只调 collectCandidates() + checkAdmissibility() + mergeDecision()，
 * 不写入 events.jsonl、不调模型、不发网络请求，可反复运行。
 *
 * 运行：node scripts/verify-calendar-gate.js
 */
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const fe = require(path.join(ROOT, 'server', 'future-events'));
const gate = require(path.join(ROOT, 'server', 'calendar-gate'));

// 固定时间基准，复现「2026-11-24 发布、2026-11-25 扫描」的现场
const NOW = Date.parse('2026-11-25T02:00:00Z'); // 北京时间 2026-11-25 10:00
const URL_WSCN = 'https://wallstreetcn.com/livenews/3024186';
const URL_CCTV = 'https://news.cctv.com/2026/11/23/ARTI.shtml';
const URL_BEA = 'https://www.bea.gov/news/schedule';

const CASES = [
  {
    tag: 'A 用户质疑的这条（应驳回）',
    expect: 'reject',
    news: {
      id: 'news-nvidia-reversal',
      title: '报道：英伟达在黄仁勋一事上立场反转，决策未征询公司高管',
      desc: '据彭博援引不愿透露姓名的知情人士报道，英伟达董事会这项决定于上周日下午敲定，部分公司高管事先并不知情，最后一刻才收到通知。英伟达官方新闻稿仅称董事会听取了美国政府高层意见，未提及是否征询高管。',
      source: '华尔街见闻',
      link: URL_WSCN,
      publishedAt: Date.parse('2026-11-24T01:40:00+08:00')
    }
  },
  {
    tag: 'B 官方预告：12月3日听证会（应保留）',
    expect: 'admit-or-review',
    news: {
      id: 'news-senate-hearing',
      title: '黄仁勋将于12月3日出席美国参议院银行委员会听证会',
      desc: '据央视新闻及美国参议院银行委员会官网日程，英伟达CEO黄仁勋定于12月3日上午10时出席听证会，就AI芯片出口管制政策作证。',
      source: '央视新闻',
      link: URL_CCTV,
      publishedAt: Date.parse('2026-11-23T20:00:00+08:00')
    }
  },
  {
    tag: 'C 官方宏观数据预告（应保留）',
    expect: 'admit-or-review',
    news: {
      id: 'news-us-cpi',
      title: '美国11月CPI数据将于12月10日公布',
      desc: '美国劳工统计局公布日程显示，11月消费者物价指数报告定于12月10日发布，市场关注核心通胀对美联储降息路径的影响。',
      source: '新华社',
      link: URL_BEA,
      publishedAt: Date.parse('2026-11-23T09:00:00+08:00')
    }
  },
  {
    tag: 'D 纯观点/展望（应驳回）',
    expect: 'reject',
    news: {
      id: 'news-opinion',
      title: '分析称英伟达立场反转或改变AI芯片格局',
      desc: '有分析师认为，此前黄仁勋一度被排除在决策之外，此次人事变动恐将对行业情绪产生影响，料将引发市场关注。',
      source: '某财经自媒体',
      link: null,
      publishedAt: Date.parse('2026-11-24T10:00:00+08:00')
    }
  }
];

function line(ch, n) { return String(ch).repeat(n || 72); }

const collected = fe.collectCandidates({ news: CASES.map(x => x.news), now: NOW, horizonDays: 90 });
const byKey = new Map(collected.timed.map(r => [r.newsId, r]));

console.log(line('='));
console.log('日程准入闸门 · 可追溯验证');
console.log('扫描基准：2026-11-25（北京时间） · 窗口 90 天 · 固定语料 ' + CASES.length + ' 条');
console.log('闸门版本：calendar-gate-v1 · 默认拒绝 fail-closed');
console.log(line('='));

let pass = 0;
for (const c of CASES) {
  const r = byKey.get(c.news.id);
  console.log('\n' + c.tag);
  console.log(line('-'));
  console.log('标题：' + c.news.title);
  if (!r) {
    console.log('结果：未抽出确定时间 → 不进入候选（同样不会入历）');
    console.log('判定：' + (c.expect === 'reject' ? 'PASS' : 'FAIL'));
    if (c.expect === 'reject') pass++;
    continue;
  }
  const rule = r.rule;
  console.log('抽到日期：' + r.date + '（' + r.dateConfidence + '，' + r.dateBasis + '）');
  console.log('时态信号：past=' + r.past + ' forecastBound=' + r.forecastBound + ' phrase=' + (r.phrase || '—'));
  console.log('影响主题：' + (r.impacts.join('、') || '（无）'));
  console.log('信源等级：' + rule.sourceTier + ' · 真伪状态：' + rule.truthStatus);
  console.log('确定性结论：' + rule.decision.toUpperCase());
  if (rule.rejectHits.length) console.log('驳回理由：\n  - ' + rule.rejectHits.join('\n  - '));
  if (rule.reviewHits.length) console.log('待复核项：\n  - ' + rule.reviewHits.join('\n  - '));
  console.log('核实途径：\n  - ' + rule.verifyHints.join('\n  - '));

  // 无智能体审查结论时，admit 必须保守降级为 review（fail-closed）
  const mergedNoAI = gate.mergeDecision(rule, null);
  console.log('合并决策（AI 不可用）：' + mergedNoAI.finalDecision.toUpperCase() +
    (rule.decision === 'admit' ? '  ← admit 已按纪律降级为待复核' : ''));

  const ok = c.expect === 'reject'
    ? rule.decision === 'reject'
    : (rule.decision === 'admit' || rule.decision === 'review');
  console.log('判定：' + (ok ? 'PASS' : 'FAIL') + '（期望 ' + c.expect + '）');
  if (ok) pass++;
}

// 验证「AI 无权把 reject 升级为 admit」
const rejectedRule = (byKey.get('news-nvidia-reversal') || {}).rule;
if (rejectedRule) {
  const upgraded = gate.mergeDecision(rejectedRule, {
    reviewed: true, admitSuggestion: 'admit', truthRisk: 'low',
    isFutureEvent: true, timeBelongsToEvent: true, reason: '模拟：智能体误判为可入历'
  });
  const safe = upgraded.finalDecision === 'reject';
  console.log('\n' + line('-'));
  console.log('纪律校验：智能体把驳回项建议为 admit → 最终仍为 ' + upgraded.finalDecision.toUpperCase());
  console.log('判定：' + (safe ? 'PASS' : 'FAIL'));
  if (safe) pass++;
}
// 验证「AI 判 high-risk 可把 admit 降级为 review」
const goodRule = (byKey.get('news-senate-hearing') || {}).rule;
if (goodRule && goodRule.decision === 'admit') {
  const downgraded = gate.mergeDecision(goodRule, {
    reviewed: true, admitSuggestion: 'review', truthRisk: 'high',
    isFutureEvent: true, timeBelongsToEvent: true, reason: '模拟：真伪风险高'
  });
  const safe = downgraded.finalDecision === 'review';
  console.log('纪律校验：智能体判 high-risk → admit 降级为 ' + downgraded.finalDecision.toUpperCase());
  console.log('判定：' + (safe ? 'PASS' : 'FAIL'));
  if (safe) pass++;
}

const total = CASES.length + 1 + (goodRule && goodRule.decision === 'admit' ? 1 : 0);
console.log('\n' + line('='));
console.log('结果：' + pass + '/' + total + ' 通过');
console.log(line('='));
process.exit(pass === total ? 0 : 1);
