'use strict';
/**
 * report.js — 每日【短线复盘】报告生成
 *
 * 输出 data/daily/YYYY-MM-DD/report.md 与 report.html
 * 短线视角 12 节：一句话定性 / 指数量能 / 短线情绪三项与梯队炸板明细 / 行业热点 /
 *   四类量化选股（趋势·低吸·打板·趋势突破）/ 板块领跑→跟随 / 次日备选观察池与风险规避池 /
 *   预测兑现检验 / 资金结构与主线延续 / 明日情绪触发条件 / 数据来源 / 知识入库候选
 *
 * 纪律：事实来自程序快照（market-style / strength / limitup / sentiment / strategy / 四类 screen）；
 *       定性由 Hermes 生成并标注推测；无数据写「待补充」，不编造、不给买卖建议。
 */

const fs = require('node:fs');
const path = require('node:path');
const daily = require('./daily');
const predictions = require('./predictions');
const cal = require('./calendar');
const eventStudy = require('./event-study');

const DATA = path.join(__dirname, '..', 'data');

function bjDate(ts = Date.now()) { return new Date(ts + 8 * 3600e3).toISOString().slice(0, 10); }
function bjNow() { return new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); }
function readJson(f) { try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} return null; }
function writeText(f, s) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s, 'utf8'); }
function writeJson(f, o) { writeText(f, JSON.stringify(o, null, 2)); }
function dayDir(date) { return path.join(DATA, 'daily', date); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function cls(v) { return Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : ''; }
function pct(v) { return v == null ? '待补充' : (Number(v) > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
function benchText(b) {
  if (!b) return '待补充';
  if (typeof b === 'string') return b;
  return [b.name, b.date, (b.r5 != null ? '5日' + b.r5 + '%' : null)].filter(Boolean).join(' ');
}
function listItems(arr, fn, max = 8) { return (arr || []).slice(0, max).map(fn).join('') || '<li>待补充</li>'; }

function collectFacts(date) {
  const dir = dayDir(date);
  return {
    date,
    generatedAt: bjNow(),
    forecast: readJson(path.join(dir, 'forecast.json')),
    review: readJson(path.join(dir, 'review.json')),
    market: daily.marketMonitor(),
    sector: daily.sectorMonitor(),
    picks: daily.picks(),
    sentiment: readJson(path.join(DATA, 'sentiment.json')),
    strategy: readJson(path.join(DATA, 'strategy.json')),
    predictionSummary: predictions.summary(),
    upcoming: (() => {
      try { return (cal.upcoming({ days: 7 }) || []).slice(0, 8); } catch (_) { return []; }
    })(),
    eventStudy: (() => {
      try {
        const s = eventStudy.study();
        if (!s.ok) return { ok: false, note: s.error };
        return { ok: true, generatedAt: s.data.generatedAt, overall: s.data.overall, rules: s.data.rules.slice(0, 6) };
      } catch (e) { return { ok: false, note: e.message }; }
    })()
  };
}

/** 短线情绪三项的事实切片（缺数据时全部降级为待补充，不编造） */
function senti(f) {
  const d = f.sentiment || {};
  return {
    ok: !!d.ok, date: d.date || null,
    me: d.moneyEffect || {}, bh: d.boardHeight || {}, br: d.breakRate || {},
    summary: (d.shortTerm || {}).summary || null, disclaimer: d.disclaimer || null
  };
}
/** 四类选股 + 次日双池的事实切片 */
function strat(f) {
  const s = f.strategy || {};
  return { four: s.fourClass || {}, pools: s.pools || {} };
}

function buildKnowledgeCandidates(f) {
  const out = [];
  const m = f.market || {};
  if (m.ok) out.push({
    kind: 'fact', title: m.tradingDate + ' 两市量价事实',
    content: '成交额' + (m.amountYi != null ? m.amountYi + '亿' : '待补充') + '，量比20 ' +
      (m.ratio20 != null ? m.ratio20 : '待补充') + '，' + (m.state || '未知') +
      '，沪指' + pct(m.shPct) + '，深成' + pct(m.szPct) + '，上涨占比' +
      (m.breadth && m.breadth.upRatio != null ? m.breadth.upRatio + '%' : '待补充') + '。',
    extracted: false
  });
  const ps = f.predictionSummary || {};
  if (ps.judged > 0) out.push({
    kind: 'experience', title: '方向判断累计命中记录',
    content: '截至' + f.date + '，已判定' + ps.judged + '次，命中' + ps.hit + '次，命中率' +
      (ps.hitRate != null ? ps.hitRate + '%' : '待补充') + '；需结合每次证伪条件复核，不直接当作未来概率。',
    extracted: false
  });
  const st = senti(f);
  if (st.ok) out.push({
    kind: 'fact', title: f.date + ' 短线情绪三项',
    content: '赚钱效应' + (st.me.ok ? ((st.me.avgRet > 0 ? '+' : '') + st.me.avgRet + '%（' + st.me.sample + '只样本，上涨占比' + st.me.upRatio + '%）') : '数据不足') +
      '；连板高度' + (st.bh.maxBoards || 0) + '板（' + (st.bh.heightLevel || '--') + '，梯队' + (st.bh.ladderText || '待补充') + '）' +
      '；炸板率' + (st.br.rate != null ? st.br.rate + '%（' + st.br.level + '）' : '无样本') + '。' +
      '口径：赚钱效应为昨日涨停股今日收益分布，炸板率为收盘快照口径，非盘中封板成功率。',
    extracted: false
  });
  const { four, pools } = strat(f);
  if (four.ok) out.push({
    kind: 'fact', title: f.date + ' 四类量化选股结果',
    content: '趋势' + ((four.counts || {}).trend || 0) + '、低吸' + ((four.counts || {}).dip || 0) +
      '、打板' + ((four.counts || {}).board || 0) + '、趋势突破' + ((four.counts || {}).breakout || 0) +
      '，去重后 ' + (four.totalRows || 0) + ' 行；板块领跑 ' + ((four.leaders || []).length) + ' 只。为筛选排序结果，非推荐。',
    extracted: false
  });
  if (pools.ok) out.push({
    kind: 'fact', title: f.date + ' 次日双池',
    content: '备选观察池 ' + (pools.watchCount || 0) + ' 只（四类重点/连板梯队/领跑跟随），风险规避池 ' +
      (pools.riskCount || 0) + ' 只（炸板/高位连板/跌停）；均为研究清单，非买卖指令。',
    extracted: false
  });
  if (f.upcoming && f.upcoming.length) out.push({
    kind: 'fact', title: '未来 7 日日程事件',
    content: f.upcoming.slice(0, 5).map(e => (e.date || '?') + ' ' + (e.name || '?')).join('；') + '。',
    extracted: false
  });
  return out;
}

/* -------------------------------- Markdown -------------------------------- */

function renderMd(f, agentText, candidates) {
  const m = f.market || {}, s = f.sector || {}, ps = f.predictionSummary || {};
  const fc = f.forecast || {}, rv = f.review || {};
  const st = senti(f); const { four, pools } = strat(f);
  const L = [];
  L.push('# A 股短线复盘 · ' + f.date);
  L.push('> 生成时间：' + f.generatedAt + ' · 行情数据日：' + (m.tradingDate || '待补充') + ' · 红涨绿跌');
  L.push('> 视角：短线情绪（赚钱效应 / 连板高度 / 炸板率）· 四类量化策略 · 次日观察与风险双池');
  L.push('');
  L.push('## 1. 一句话定性');
  L.push(agentText ? agentText : ('程序结论：' + (m.momentum || '待补充') + '。以下为事实归纳，不含买卖建议。'));
  L.push('');
  L.push('## 2. 指数与量能');
  L.push('- 成交额：' + (m.amountYi != null ? m.amountYi + ' 亿' : '待补充') + '；20 日均量：' + (m.ma20Yi != null ? m.ma20Yi + ' 亿' : '待补充'));
  L.push('- 量比20：' + (m.ratio20 != null ? m.ratio20 : '待补充') + '，' + (m.state || '未知') + '，环比 ' + pct(m.changePct));
  L.push('- 沪指 ' + pct(m.shPct) + '，深成 ' + pct(m.szPct) + '，整体 ' + pct(m.indexPct));
  L.push('');
  L.push('## 3. 短线情绪三项（核心）');
  if (st.ok) {
    L.push('- 赚钱效应：' + (st.me.ok
      ? ((st.me.avgRet > 0 ? '+' : '') + st.me.avgRet + '%（昨日涨停股今日平均，样本 ' + st.me.sample + ' 只，上涨占比 ' + st.me.upRatio + '%，再涨停 ' + st.me.againLimitRatio + '%）')
      : '数据不足（' + (st.me.reason || '') + '）'));
    L.push('  口径：' + (st.me.basis || '待补充'));
    L.push('- 连板高度：' + (st.bh.maxBoards || 0) + ' 板（' + (st.bh.heightLevel || '--') + '），梯队 ' + (st.bh.ladderText || '待补充'));
    if ((st.bh.leaders || []).length) L.push('  高标：' + st.bh.leaders.slice(0, 8).map(x => (x.name || x.code) + ' ' + (x.boards || '?') + '板' + (x.industry ? '/' + x.industry : '')).join('；'));
    L.push('- 炸板率：' + (st.br.rate != null ? st.br.rate + '%（' + st.br.level + '）' : '无样本') +
      '，收盘涨停 ' + (st.br.ztCount || 0) + ' / 炸板 ' + (st.br.zbCount || 0) + ' / 跌停 ' + (st.br.dtCount || 0));
    L.push('  口径：' + (st.br.basis || '待补充'));
    if ((st.br.failed || []).length) L.push('  炸板名单（前8）：' + st.br.failed.slice(0, 8).map(x => (x.name || x.code) + (x.industry ? '(' + x.industry + ')' : '')).join('；'));
    if (st.summary) L.push('- 综合：' + st.summary);
  } else L.push('- 情绪指标尚未生成（sentiment.json 缺失或当日未刷新）。');
  for (const a of (pools.alerts || [])) L.push('- 市场级提示：' + a);
  L.push('');
  L.push('## 4. 行业 / 概念热点');
  L.push('- 基准：' + benchText(s.benchmark) + '；领涨前 5：' + ((s.leaders || []).slice(0, 5).map(x => x.name + ' ' + pct(x.chg5)).join('；') || '待补充'));
  L.push('- 长增长候选：' + ((s.longGrowth || []).slice(0, 5).map(x => x.name).join('、') || '待补充'));
  const es = f.eventStudy || {};
  if (es.ok && es.rules && es.rules.length) {
    L.push('- 事件历史统计（近2年，ETF 代理近似口径，非买卖依据）：');
    for (const r of es.rules) L.push('  · ' + r.name + '：' + r.stats.events + ' 次事件 / ' + r.stats.samples + ' 次观测，T+5 平均超额 ' +
      (r.stats.avgAr5 == null ? '待补充' : (r.stats.avgAr5 > 0 ? '+' : '') + r.stats.avgAr5 + '%') +
      '，胜率 ' + (r.stats.win5 == null ? '待补充' : r.stats.win5 + '%') +
      (r.stats.samples < 8 ? '（低样本，不可外推）' : ''));
  } else L.push('- 事件历史统计：待补充（尚未运行事件研究引擎）');
  L.push('');
  L.push('## 5. 四类量化选股（趋势 / 低吸 / 打板 / 趋势突破，非推荐）');
  if (four.ok) {
    L.push('- 数量：趋势 ' + ((four.counts || {}).trend || 0) + ' · 低吸 ' + ((four.counts || {}).dip || 0) +
      ' · 打板 ' + ((four.counts || {}).board || 0) + ' · 趋势突破 ' + ((four.counts || {}).breakout || 0) +
      '，去重后 ' + (four.totalRows || 0) + ' 行');
    for (const x of (four.items || []).slice(0, 12)) {
      L.push('  · ' + x.code + ' ' + (x.name || '') + ' [' + (x.classes || [x.kindLabel]).join('/') + ']' +
        (x.industry ? '/' + x.industry : '') + ' 评分 ' + (x.score != null ? x.score : '--') +
        ' 角色' + (x.role || '-') + '：' + String(x.driverSummary || '').slice(0, 90));
    }
  } else L.push('- 四类选股快照尚未生成（strategy.json 缺失）。');
  L.push('');
  L.push('## 6. 板块领跑 → 跟随候选');
  if ((four.leaders || []).length) {
    for (const l of four.leaders.slice(0, 6)) {
      const fl = (four.followers || {})[(l.industry || '') + '::' + l.code] || [];
      L.push('- ' + (l.industry || '?') + '：领跑 ' + (l.name || l.code) + '（' + String(l.basis || '').slice(0, 60) + '）' +
        (fl.length ? '；跟随 ' + fl.slice(0, 4).map(x => (x.name || x.code)).join('、') : '；暂无跟随候选'));
    }
  } else L.push('- 当前无板块领跑判定。');
  L.push('');
  L.push('## 7. 次日备选观察池 / 风险规避池（研究清单，非推荐）');
  if (pools.ok) {
    L.push('### 次日备选观察池（' + (pools.watchCount || 0) + ' 只）');
    for (const x of (pools.watchPool || []).slice(0, 10)) {
      L.push('- ' + x.code + ' ' + (x.name || '') + (x.kind ? ' [' + x.kind + ']' : '') + '：' + (x.why || '') + '｜次日看：' + (x.track || ''));
    }
    L.push('### 风险规避池（' + (pools.riskCount || 0) + ' 只）');
    for (const x of (pools.riskPool || []).slice(0, 10)) {
      L.push('- ' + x.code + ' ' + (x.name || '') + ' [' + (x.riskType || '') + ']：' + (x.reason || ''));
    }
  } else L.push('- 双池尚未生成（strategy.json 缺失）。');
  L.push('');
  L.push('## 8. 预测兑现检验');
  if (fc.forecast) {
    L.push('- 当日方向倾向：' + ((fc.prediction || {}).direction || '待补充'));
    L.push('- 证伪条件：' + ((fc.prediction || {}).falsifier || '待补充'));
  } else L.push('- 当日预测快照：待补充');
  L.push('- 账本累计：判定 ' + (ps.judged || 0) + ' 次，命中 ' + (ps.hit || 0) + '，未命中 ' + (ps.miss || 0) + '，命中率 ' + (ps.hitRate != null ? ps.hitRate + '%' : '待补充'));
  if (rv.summary) L.push('- 本次复盘：' + JSON.stringify(rv.summary));
  L.push('');
  L.push('## 9. 资金结构与主线延续');
  L.push('- 资金分档实测值：待补充。当前数据源未提供主力净流入分档；strength-cache 的 exN 为相对强弱，不是资金流。');
  L.push('- 持续强势（ex5 与 ex10 同向为正）：' + ((s.sustained || []).slice(0, 6).map(x => x.name).join('、') || '待补充'));
  L.push('- 前日主线延续性统计：待补充（需五日快照账本累积）');
  L.push('');
  L.push('## 10. 明日情景与触发条件（短线情绪口径，不给点位、不给买卖动作）');
  L.push('- 情绪修复触发：赚钱效应维持为正或回正、炸板率回落至 20% 以下、最高连板晋级且无显著炸板潮。');
  L.push('- 退潮触发：赚钱效应转负、炸板率升至 30% 以上、高标断板且跌停家数增加、连板梯队断层。');
  L.push('- 证伪：以上条件若均未出现，维持「需等待确认」，不给出方向结论。');
  L.push('');
  L.push('## 11. 数据来源与口径');
  L.push('- 两市：' + (m.at || '待补充') + ' market-style.json；板块：' + (s.at || '待补充') + ' strength-cache.json');
  L.push('- 短线情绪：' + (st.date || '待补充') + ' sentiment.json（limitup-cache 涨停/炸板快照 + 昨日涨停 K 线收益）');
  L.push('- 四类选股与双池：' + ((f.strategy || {}).generatedAt || '待补充') + ' strategy.json（trend/dip/board/breakout-screen + pick-insight + sentiment）');
  L.push('- 领跑/上涨原因：pick-insight.json（证据链含 source）；选股候选池：' + ((f.picks && f.picks.trend && f.picks.trend.universe) ? JSON.stringify(f.picks.trend.universe) : '待补充'));
  L.push('- 事件统计：' + ((f.eventStudy || {}).generatedAt || '待补充') + ' event-study.json（ETF 代理近似）');
  L.push('- 缺失：资金分档、分钟尾盘、全市场日线快照；赚钱效应为样本口径非全量。');
  L.push('');
  L.push('## 12. 知识入库候选（需确认）');
  for (const c of candidates) L.push('- [' + c.kind + '] ' + c.title + '：' + c.content);
  L.push('');
  L.push('---');
  L.push('免责声明：本文基于程序计算与公开数据的研究归纳，不构成任何证券买卖建议或价格预测；投资有风险，决策需独立。');
  return L.join('\n');
}

/* -------------------------------- HTML -------------------------------- */

function renderHtml(f, agentText, candidates) {
  const m = f.market || {}, s = f.sector || {}, ps = f.predictionSummary || {};
  const fc = f.forecast || {}, rv = f.review || {};
  const st = senti(f); const { four, pools } = strat(f);
  const rows = (arr, fn, max = 10) => (arr || []).length
    ? arr.slice(0, max).map(fn).join('')
    : '<tr><td colspan="6" class="muted">待补充</td></tr>';
  const sentiCards = [
    { k: '赚钱效应', v: st.me.ok ? ((st.me.avgRet > 0 ? '+' : '') + st.me.avgRet + '%') : '数据不足',
      c: st.me.ok && st.me.avgRet > 0 ? 'up' : (st.me.ok && st.me.avgRet < 0 ? 'down' : ''),
      d: st.me.ok ? ('样本 ' + st.me.sample + ' 只 · 上涨占比 ' + st.me.upRatio + '% · 再涨停 ' + st.me.againLimitRatio + '%') : (st.me.reason || '') },
    { k: '连板高度', v: (st.bh.maxBoards != null ? st.bh.maxBoards + ' 板' : '--'), c: '',
      d: (st.bh.ladderText || '待补充') + ' · ' + (st.bh.heightLevel || '--') },
    { k: '炸板率', v: (st.br.rate != null ? st.br.rate + '%' : '--'), c: '',
      d: (st.br.level || '无样本') + ' · 涨停 ' + (st.br.ztCount || 0) + ' / 炸板 ' + (st.br.zbCount || 0) + ' / 跌停 ' + (st.br.dtCount || 0) }
  ];
  const alertsHtml = (pools.alerts || []).length
    ? '<div class="box warn"><b>市场级情绪提示：</b>' + pools.alerts.map(a => esc(a)).join('<br>') + '</div>' : '';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>短线复盘 ${esc(f.date)}</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1d2129;background:#f5f6f8;margin:0;padding:28px;line-height:1.7}
.wrap{max-width:1000px;margin:auto;background:#fff;border-radius:12px;padding:30px 36px;box-shadow:0 4px 18px rgba(0,0,0,.05)}
h1{font-size:23px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 10px;padding-bottom:6px;border-bottom:2px solid #e8f0ff;color:#165dff}
h3{font-size:13.5px;margin:16px 0 6px;color:#4e5969}
.sub{color:#86909c;font-size:12.5px;margin-bottom:18px}
table{border-collapse:collapse;width:100%;font-size:12.5px;margin:8px 0}th,td{border:1px solid #e5e6eb;padding:6px 9px;text-align:left}th{background:#f7f8fa}
.up{color:#d93025;font-weight:600}.down{color:#1a7f37;font-weight:600}.muted{color:#9ca3af}
.box{background:#f8fafc;border-left:4px solid #165dff;padding:10px 14px;border-radius:0 6px 6px 0;font-size:13px;margin:10px 0}
.warn{background:#fff8e8;border-left-color:#ff7d00}.senti{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:10px 0}
.senti .c{background:#f7f8fa;border-radius:8px;padding:12px 14px}.senti .k{font-size:12px;color:#86909c}
.senti .v{font-size:22px;font-weight:700;margin:4px 0}.senti .d{font-size:11.5px;color:#4e5969}
code{background:#f2f3f5;padding:1px 5px;border-radius:3px}
.foot{margin-top:30px;border-top:1px solid #e5e6eb;padding-top:12px;color:#86909c;font-size:12px}
</style></head><body><div class="wrap">
<h1>A 股短线复盘 · ${esc(f.date)}</h1>
<div class="sub">生成 ${esc(f.generatedAt)} · 行情数据日 ${esc(m.tradingDate || '待补充')} · 红涨绿跌 · 视角：情绪三项 / 四类量化策略 / 次日双池</div>
<div class="box"><strong>一句话定性：</strong>${esc(agentText || (m.momentum || '待补充'))}</div>
<h2>1 · 指数与量能</h2>
<table><tr><th>成交额</th><th>20日均量</th><th>量比20</th><th>状态</th><th>沪指</th><th>深成</th></tr>
<tr><td>${esc(m.amountYi != null ? m.amountYi + '亿' : '待补充')}</td><td>${esc(m.ma20Yi != null ? m.ma20Yi + '亿' : '待补充')}</td><td>${esc(m.ratio20 != null ? m.ratio20 : '待补充')}</td><td>${esc(m.state || '待补充')}</td><td class="${cls(m.shPct)}">${esc(pct(m.shPct))}</td><td class="${cls(m.szPct)}">${esc(pct(m.szPct))}</td></tr></table>
<h2>2 · 短线情绪三项（核心）</h2>
<div class="senti">${sentiCards.map(c => '<div class="c"><div class="k">' + esc(c.k) + '</div><div class="v ' + c.c + '">' + esc(c.v) + '</div><div class="d">' + esc(c.d) + '</div></div>').join('')}</div>
<div class="box">${st.ok ? esc(st.summary || '') : '情绪指标尚未生成。'}<br>连板梯队：${esc(st.bh.ladderText || '待补充')}；高标：${esc((st.bh.leaders || []).slice(0, 6).map(x => (x.name || x.code) + ' ' + (x.boards || '?') + '板').join('；') || '待补充')}</div>
${(st.br.failed || []).length ? '<div class="box warn">炸板名单（前8）：' + esc(st.br.failed.slice(0, 8).map(x => (x.name || x.code) + (x.industry ? '(' + x.industry + ')' : '')).join('；')) + '</div>' : ''}
${alertsHtml}
<div class="box">口径：赚钱效应=昨日涨停股今日收盘收益分布（样本口径）；炸板率=炸板数/(收盘涨停+炸板)，为收盘快照，非盘中封板成功率。${esc(st.disclaimer || '')}</div>
<h2>3 · 行业与主线</h2>
<table><tr><th>板块</th><th>5日涨跌</th><th>10日超额</th><th>60日超额</th><th>宽度</th></tr>
${rows((s.leaders || []), x => `<tr><td>${esc(x.name)}</td><td class="${cls(x.chg5)}">${esc(pct(x.chg5))}</td><td class="${cls(x.ex10)}">${esc(pct(x.ex10))}</td><td class="${cls(x.ex60)}">${esc(pct(x.ex60))}</td><td>${esc(x.breadth)}</td></tr>`)}</table>
<div class="box warn">资金分档实测值：待补充。exN 为相对沪深300 超额，不是资金流。</div>
<div class="box">事件历史统计：${(() => {
    const es = f.eventStudy || {};
    if (!es.ok || !(es.rules || []).length) return '待补充（事件研究引擎未生成）';
    return es.rules.slice(0, 4).map(r => esc(r.name) + ' ' + r.stats.events + '次/' + r.stats.samples + '观测，T+5超额 ' +
      (r.stats.avgAr5 > 0 ? '+' : '') + esc(r.stats.avgAr5) + '%，胜率 ' + esc(r.stats.win5) + '%' +
      (r.stats.samples < 8 ? '（低样本）' : '')).join('<br>');
  })()}</div>
<h2>4 · 四类量化选股（趋势 / 低吸 / 打板 / 趋势突破，非推荐）</h2>
<div class="box">数量：趋势 ${esc((four.counts || {}).trend || 0)} · 低吸 ${esc((four.counts || {}).dip || 0)} · 打板 ${esc((four.counts || {}).board || 0)} · 趋势突破 ${esc((four.counts || {}).breakout || 0)}，去重后 ${esc(four.totalRows || 0)} 行</div>
<table><tr><th>类别</th><th>代码</th><th>名称</th><th>行业</th><th>评分/角色</th><th>上涨/入选依据</th></tr>
${rows((four.items || []), x => `<tr><td>${esc((x.classes || [x.kindLabel]).join('/'))}</td><td>${esc(x.code)}</td><td>${esc(x.name || '')}</td><td>${esc(x.industry || '行业待补')}</td><td>${esc(x.score != null ? x.score : '--')} / ${esc(x.role || '-')}</td><td>${esc(String(x.driverSummary || '').slice(0, 70))}</td></tr>`, 12)}</table>
<h3>板块领跑 → 跟随候选</h3>
<div class="box">${(four.leaders || []).length ? four.leaders.slice(0, 6).map(l => {
    const fl = (four.followers || {})[(l.industry || '') + '::' + l.code] || [];
    return esc((l.industry || '?') + '：领跑 ' + (l.name || l.code) + (fl.length ? '；跟随 ' + fl.slice(0, 4).map(x => (x.name || x.code)).join('、') : '；暂无跟随候选'));
  }).join('<br>') : '当前无板块领跑判定。'}</div>
<h2>5 · 次日备选观察池 / 风险规避池（研究清单，非推荐）</h2>
<h3>次日备选观察池（${esc(pools.watchCount || 0)} 只）</h3>
<table><tr><th>代码</th><th>名称</th><th>类别</th><th>为什么观察</th><th>次日看什么</th><th>来源</th></tr>
${rows((pools.watchPool || []), x => `<tr><td>${esc(x.code)}</td><td>${esc(x.name || '')}</td><td>${esc(x.kind || '')}</td><td>${esc(x.why || '')}</td><td>${esc(x.track || '')}</td><td>${esc(x.source || '')}</td></tr>`)}</table>
<h3>风险规避池（${esc(pools.riskCount || 0)} 只）</h3>
<table><tr><th>代码</th><th>名称</th><th>风险类型</th><th>原因</th><th>来源</th></tr>
${rows((pools.riskPool || []), x => `<tr><td>${esc(x.code)}</td><td>${esc(x.name || '')}</td><td>${esc(x.riskType || '')}</td><td>${esc(x.reason || '')}</td><td>${esc(x.source || '')}</td></tr>`)}</table>
<h2>6 · 预测兑现检验</h2>
<div class="box">当日预测：${esc((fc.prediction || {}).direction || '待补充')}｜账本判定 ${esc(ps.judged || 0)} 次，命中 ${esc(ps.hit || 0)}，命中率 ${esc(ps.hitRate != null ? ps.hitRate + '%' : '待补充')}<br>证伪条件：${esc((fc.prediction || {}).falsifier || '待补充')}</div>
${rv.summary ? '<pre style="font-size:12px">' + esc(JSON.stringify(rv.summary, null, 2)) + '</pre>' : ''}
<h2>7 · 明日情景与触发条件（短线情绪口径）</h2>
<div class="box">情绪修复：赚钱效应维持为正或回正、炸板率回落至20%以下、最高连板晋级且无显著炸板潮。<br>退潮：赚钱效应转负、炸板率升至30%以上、高标断板且跌停家数增加、连板梯队断层。<br>证伪：两者均未出现则维持「需等待确认」。</div>
<h2>8 · 数据来源与口径</h2>
<div class="box">两市：${esc(m.at || '待补充')}；板块：${esc(s.at || '待补充')}；情绪：${esc(st.date || '待补充')} sentiment.json；四类/双池：${esc((f.strategy || {}).generatedAt || '待补充')} strategy.json<br>候选池：${esc((f.picks && f.picks.trend && f.picks.trend.universe) ? JSON.stringify(f.picks.trend.universe) : '待补充')}<br>事件统计：${esc((f.eventStudy || {}).generatedAt || '待补充')}（ETF 代理近似）<br>缺失：资金分档、分钟尾盘、全市场日线快照；赚钱效应为样本口径非全量。</div>
<h2>9 · 知识入库候选</h2>
<table><tr><th>类型</th><th>标题</th><th>内容</th></tr>
${candidates.map(c => `<tr><td>${esc(c.kind)}</td><td>${esc(c.title)}</td><td>${esc(c.content)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">待补充</td></tr>'}</table>
<div class="foot">免责声明：本文基于程序计算与公开数据的研究归纳，不构成任何证券买卖建议或价格预测；投资有风险，决策需独立。</div>
</div></body></html>`;
}

/** 生成短线复盘报告；agentText 由调用方可选传入 Hermes 的一段总结 */
async function generate(cfg, hermes, opts = {}) {
  const date = opts.date || bjDate();
  const dir = dayDir(date);
  fs.mkdirSync(dir, { recursive: true });
  const f = collectFacts(date);
  const candidates = buildKnowledgeCandidates(f);
  let agentText = opts.agentText || null;
  let agent = null;
  if (!agentText && hermes && cfg) {
    const st = senti(f); const { four, pools } = strat(f);
    const q = '请用一段话（120字内）做当日【A股短线复盘】定性，只引用下面结构化事实：赚钱效应、连板高度、炸板率、四类选股数量、次日双池、两市量能。' +
      '基于这些事实充分展开你的解读与观察方向，区分「事实」与「推测」，对推测标注证伪条件；不要编造未给出的数据。\n\n' +
      JSON.stringify({
        情绪: { summary: st.summary, 赚钱效应: st.me.ok ? st.me.avgRet : null, 连板高度: st.bh.maxBoards || null, 炸板率: st.br.rate != null ? st.br.rate : null },
        四类选股: four.counts || null,
        次日双池: { 观察: pools.watchCount || 0, 规避: pools.riskCount || 0, 提示: pools.alerts || [] },
        两市: { 成交额: f.market && f.market.amountYi, 沪指: f.market && f.market.shPct, 深成: f.market && f.market.szPct, 上涨占比: f.market && f.market.breadth && f.market.breadth.upRatio },
        预测: f.forecast && f.forecast.prediction, 复盘: f.review && f.review.summary
      });
    agent = await hermes.ask(cfg, 'daily-report', q, { task: '当日短线复盘一句话定性', maxTokens: 300 });
    if (agent.ok) agentText = agent.text;
  }
  const md = renderMd(f, agentText, candidates);
  const html = renderHtml(f, agentText, candidates);
  const mdFile = path.join(dir, 'report.md');
  const htmlFile = path.join(dir, 'report.html');
  writeText(mdFile, md);
  writeText(htmlFile, html);
  const indexFile = path.join(dir, 'index.json');
  writeJson(indexFile, {
    ok: true, date, generatedAt: bjNow(), style: 'short-term-review',
    files: { md: mdFile, html: htmlFile },
    agentBackend: agent ? agent.backend : null,
    agentOk: agent ? agent.ok : null,
    candidates
  });
  return { ok: true, date, md: mdFile, html: htmlFile, index: indexFile, candidates: candidates.length, candidatesList: candidates, agentOk: agent ? agent.ok : null, agentBackend: agent ? agent.backend : null };
}

module.exports = { generate, collectFacts, buildKnowledgeCandidates, dayDir, bjDate, bjNow };
