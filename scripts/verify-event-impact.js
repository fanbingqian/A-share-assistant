'use strict';
/**
 * verify-event-impact.js — 新闻解读 v3（事件中心 + 历史同类情形）可追溯验证
 *
 * 零副作用、零联网：用一个 stub 接住 hermes.ask 的提示词，检查
 *   ① 提示词骨架是否已从「指标清单」改成「事件主线」；
 *   ② 【历史同类情形】是否注入且数字来自 event-study.json（不编造）；
 *   ③ 响应是否恒返回 historical / historicalCard（智能体失败也在）；
 *   ④ 样本不可得时是否如实标注、不生成历史案例。
 *
 * 运行：node scripts/verify-event-impact.js
 */
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const newsFlash = require(path.join(ROOT, 'server', 'news-flash'));
const analogy = require(path.join(ROOT, 'server', 'event-analogy'));

const cfg = require(path.join(ROOT, 'data', 'config.json'));
const captured = [];
const hermesStub = {
  ask: async (c, m, q, e) => {
    captured.push({ module: m, q, extra: e });
    return { ok: true, text: '（本脚本只检查提示词与程序事实，不调用模型）', backend: 'stub' };
  }
};
const relStub = () => ({ block: '（本次无关联标的）', count: 0, anyMatch: false, themes: [], industries: [] });
const flash = {
  feed: [], sectors: [], policyNews: [], companyClues: [],
  stats: { shown: 0, pool: 0, today: 0, enShown: 0 },
  today: '2026-11-25', fallbackToLatest: false
};

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); }
}
function has(q, s) { return q.indexOf(s) !== -1; }

(async () => {
  console.log('=== ① 单条 · 官方指数发布事件（中国 PMI）===');
  const pmi = {
    title: '中国11月制造业PMI为50.2，国家统计局公布',
    desc: '国家统计局发布 11 月采购经理指数，制造业景气位于荣枯线上方',
    source: '国家统计局', time: '2026-11-25 09:30', category: '宏观数据',
    sectors: [], boards: [], importance: 0
  };
  const r1 = await newsFlash.interpretOne(cfg, hermesStub, pmi, relStub, flash);
  const q1 = captured[captured.length - 1].q;
  check('骨架已换为事件主线', has(q1, '## 一、这是什么事件') && has(q1, '## 二、为什么重要：作用机制'));
  check('含二级市场影响判断段', has(q1, '## 三、对二级市场的影响判断'));
  check('含历史同类情形段', has(q1, '## 四、历史上同类情况下出现过什么'));
  check('旧「板块与个股观察」标题已移除', !has(q1, '## 三、板块与个股观察'));
  check('注入【历史同类情形】块', has(q1, '【历史同类情形（程序确定性统计'));
  check('明确禁止指标罗列', has(q1, '禁止指标罗列') && has(q1, '以事件为主线'));
  check('影响判断要求四选一', has(q1, '偏正面 / 偏承压 / 中性且分化 / 暂难判断'));
  check('历史段禁止编造历史', has(q1, '不得编造历史事件'));
  check('promptVersion = v3 宏观版', r1.promptVersion === 'news-flash-v3-macro', r1.promptVersion);
  check('historical 恒返回且有真实样本', !!r1.historical && r1.historical.ok === true && r1.historical.stats.samples > 0,
    JSON.stringify(r1.historical && r1.historical.stats && r1.historical.stats.samples));
  check('historicalCard 含 7 行统计', !!r1.historicalCard && r1.historicalCard.rows.length === 7);
  check('历史数字逐字来自统计文件', q1.indexOf(String(r1.historical.stats.samples) + ' 次板块观测') !== -1);
  check('口径限制随块注入', has(q1, 'ETF 代理') && has(q1, '历史胜率不是未来概率'));
  check('官方指数增强段保留', has(q1, '## 七、机构与专家预测') && has(q1, '## 九、多数预测方向建议'));
  check('宏观免责兜底生效', (r1.text || '').indexOf('免责声明') !== -1);

  console.log('\n=== ② 单条 · 一般新闻（无可核对历史样本）===');
  const gen = {
    title: '英伟达CEO将出席参议院银行委员会听证会',
    desc: '就 AI 芯片出口管制政策作证，时间定于 12 月 3 日',
    source: '央视新闻', time: '2026-11-24', category: '公司',
    sectors: [], boards: [], importance: 0
  };
  const r2 = await newsFlash.interpretOne(cfg, hermesStub, gen, relStub, flash);
  const q2 = captured[captured.length - 1].q;
  check('如实标注历史统计不可得', has(q2, '不可得') && has(q2, '无历史统计可比'));
  check('historical.ok = false', !!r2.historical && r2.historical.ok === false);
  check('historicalCard 不伪造统计行', !!r2.historicalCard && r2.historicalCard.rows.length === 0);
  check('promptVersion = v3 事件版', r2.promptVersion === 'news-flash-v3-event', r2.promptVersion);

  console.log('\n=== ③ 单条 · 一般新闻但命中板块代理 ===');
  const sec = {
    title: '半导体出口管制新规出台', desc: '影响芯片产业链', source: '路透', time: '2026-11-25',
    category: '产业', sectors: ['半导体', '算力'], boards: [{ name: '半导体', code: 'BK1036' }], importance: 0
  };
  const a3 = analogy.build(sec, {});
  check('板块代理兜底可用', a3.ok === true && a3.scope === 'proxy' && a3.stats.samples > 0,
    JSON.stringify({ ok: a3.ok, scope: a3.scope, samples: a3.stats && a3.stats.samples }));
  check('标注「非同类严格对照」口径', a3.block.indexOf('非同类严格对照') !== -1 || a3.card.scopeLabel.indexOf('非同类严格对照') !== -1);

  console.log('\n=== ④ 今日整体解读 ===');
  const list = [
    { title: '中国11月制造业PMI为50.2，国家统计局公布', desc: '制造业景气位于荣枯线上方', source: '国家统计局', time: '2026-11-25 09:30', sectors: [] },
    { title: '某上市公司发布回购股份公告', desc: '公司层面公告', source: '交易所', time: '2026-11-25 10:00', sectors: [] }
  ];
  const dailyFlash = { ...flash, feed: list, stats: { shown: 2, pool: 2, today: 2, enShown: 0 } };
  const r3 = await newsFlash.interpretDaily(cfg, hermesStub, dailyFlash, relStub);
  const q3 = captured[captured.length - 1].q;
  check('今日骨架以核心事件开篇', has(q3, '## 一、今天的核心事件是什么'));
  check('含整体影响判断与历史段', has(q3, '## 三、对二级市场的整体影响判断') && has(q3, '## 四、历史上同类情况下出现过什么'));
  check('旧「今日消息面总览」标题已移除', !has(q3, '## 一、今日消息面总览'));
  check('板块/公告清单标注为背景', has(q3, '仅作背景，不要逐条复述'));
  check('promptVersion = v3', /^news-daily-v3-/.test(r3.promptVersion || ''), r3.promptVersion);
  check('今日 historicalCard 恒返回', !!r3.historicalCard && r3.historicalCard.eventType.indexOf('今日主线') === 0);

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('验证脚本异常：', e); process.exit(1); });
