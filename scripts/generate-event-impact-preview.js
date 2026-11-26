'use strict';
/**
 * generate-event-impact-preview.js — 新闻解读 v3 可视化核验报告
 *
 * 数据来源：真实接口调用落盘的 _res_one.json / _res_daily.json
 *   （由 scripts/verify-event-impact.js 之外的真实 POST /api/v2/news-flash/interpret 产生）
 * 输出：preview/news-event-impact-preview.html
 *
 * 只做展示，不修改任何运行数据；文件不含密钥与个人信息。
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'preview', 'news-event-impact-preview.html');

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
const one = readJson(path.join(ROOT, 'preview', 'data', 'news-impact-one.json'))
  || readJson(path.join(ROOT, '_res_one.json')) || {};
const daily = readJson(path.join(ROOT, 'preview', 'data', 'news-impact-daily.json'))
  || readJson(path.join(ROOT, '_res_daily.json')) || {};
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** 极简 markdown → HTML：只处理标题 / 列表 / 加粗 / 行内代码 / 段落 */
function md(t) {
  const lines = String(t || '').split('\n');
  const out = [];
  let inUl = false;
  const inline = x => esc(x)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^##\s+/.test(l)) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      out.push('<h4>' + inline(l.replace(/^##\s+/, '')) + '</h4>');
    } else if (/^[-*]\s+/.test(l)) {
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push('<li>' + inline(l.replace(/^[-*]\s+/, '')) + '</li>');
    } else if (!l.trim()) {
      if (inUl) { out.push('</ul>'); inUl = false; }
    } else {
      if (inUl) { out.push('</ul>'); inUl = false; }
      out.push('<p>' + inline(l) + '</p>');
    }
  }
  if (inUl) out.push('</ul>');
  return out.join('\n');
}

/** 历史同类情形卡片：与前端 renderHistoricalCard 同结构 */
function histCard(h) {
  if (!h) return '<div class="empty">无历史统计数据</div>';
  const head = '<div class="ha-head"><b>历史同类情形（程序统计 · 非预测）</b><span>' + esc(h.scopeLabel || '') + (h.stale ? ' · 快照陈旧' : '') + '</span></div>';
  if (!h.ok) return '<div class="ha-card ha-na">' + head + '<div class="ha-body">该类事件暂无可核对的 A 股代理样本，按低幻觉纪律不提供历史类比。' + (h.unavailableReason ? '（' + esc(h.unavailableReason) + '）' : '') + '</div></div>';
  const rows = (h.rows || []).map(r => '<div class="ha-kpi"><div class="ha-k">' + esc(r.k) + '</div><div class="ha-v">' + esc(r.v) + '</div></div>').join('');
  const prox = (h.proxies || []).length ? '<div class="ha-sub">分板块（ETF 代理近似）：' + h.proxies.map(p => esc(p.label) + ' T+5 ' + esc(p.ret5) + ' · 上涨概率 ' + esc(p.upProb5)).join('；') + '</div>' : '';
  const mech = h.mechanism ? '<div class="ha-sub">机制：' + esc(h.mechanism) + '</div>' : '';
  const cav = (h.caveats || []).map(c => '<div class="ha-cav">· ' + esc(c) + '</div>').join('');
  return '<div class="ha-card">' + head +
    '<div class="ha-sub">' + esc(h.eventType || '') + ' · ' + esc(h.sampleLine || '') + (h.generatedAt ? ' · 统计生成于 ' + esc(String(h.generatedAt).slice(0, 10)) : '') + '</div>' +
    '<div class="ha-grid">' + rows + '</div>' + mech + prox +
    (cav ? '<div class="ha-cavs">' + cav + '</div>' : '') + '</div>';
}

const oldSkel = ['一、这条消息说了什么', '二、可能影响哪些板块（机制链条）', '三、板块与个股观察', '四、本次怎么看（推测与证伪条件）', '＋宏观：机构预测 / 跨资产 / 多数方向（共 7 段）'];
const newSkel = ['一、这是什么事件（事实 + 性质判定）', '二、为什么重要：作用机制', '三、对二级市场的影响判断（四选一明确结论）', '四、历史上同类情况下出现过什么', '五、板块与标的观察（精简 1–3 个）', '六、证伪条件与风险', '＋宏观：机构预期 / 跨资产 / 多数方向（共 9 段）'];

const H = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>新闻解读 v3 · 事件中心改造核验报告</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--ink:#1d2129;--ink2:#4e5969;--ink3:#86909c;--line:#e5e6eb;--line2:#f0f1f3;--accent:#185fa5;--warn:#8a5a12;--ok:#0f6e56}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:28px 22px 60px}
h1{font-size:22px;font-weight:600;margin:0 0 6px}h2{font-size:16px;font-weight:600;margin:30px 0 12px;padding-left:10px;border-left:3px solid var(--accent)}
.lead{color:var(--ink2);font-size:13px;margin:0 0 18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:14px}
.note{font-size:12px;color:var(--ink3);line-height:1.8}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.tile b{display:block;font-size:13px;margin-bottom:6px}.tile p{margin:0;font-size:12px;color:var(--ink2);line-height:1.8}
.tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:20px;background:#e8f1fb;color:var(--accent);margin:0 4px 4px 0}
.tag.new{background:#e1f5ee;color:var(--ok)}.tag.none{background:#f2f3f5;color:var(--ink3)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.skel{margin:0;padding-left:18px;font-size:12.5px;line-height:2}.skel li{color:var(--ink2)}
.skel.new li{color:var(--ink)}
.fold{margin-top:10px}.fold>summary{cursor:pointer;font-size:13px;color:var(--accent);font-weight:600}
.md h4{font-size:14px;margin:18px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--line2)}
.md p{margin:6px 0;font-size:13px}.md ul{margin:6px 0;padding-left:20px}.md li{font-size:13px;margin:4px 0}
.md strong{color:var(--ink)}.md code{background:#f2f3f5;border-radius:4px;padding:1px 5px;font-size:12px}
.ha-card{border:1px solid var(--line);border-radius:9px;background:#fbfcfd;padding:13px 14px}
.ha-head{display:flex;justify-content:space-between;gap:10px;font-size:13px}.ha-head span{font-size:11px;color:var(--ink3)}
.ha-sub{font-size:11.5px;color:var(--ink2);margin-top:8px;line-height:1.8}
.ha-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:10px}
.ha-kpi{background:#fff;border:1px solid var(--line2);border-radius:7px;padding:7px 9px}
.ha-k{font-size:10.5px;color:var(--ink3)}.ha-v{font-size:14px;font-weight:600;margin-top:2px}
.ha-cavs{margin-top:10px;border-top:1px dashed var(--line);padding-top:8px}
.ha-cav{font-size:11px;color:var(--warn);line-height:1.8}
.meta{font-size:11.5px;color:var(--ink3)}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}th{background:#fafbfc;color:var(--ink2);font-weight:600}
@media(max-width:760px){.grid3,.cols{grid-template-columns:1fr}.ha-grid{grid-template-columns:repeat(2,1fr)}}
</style></head><body><div class="wrap">
<h1>新闻解读 v3 · 事件中心改造核验报告</h1>
<p class="lead">生成时间：${esc(new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))} ｜ 数据来源：本机 8777 真实接口（官方 Hermes 通道）｜ 本报告只作展示，不含运行数据与密钥</p>

<h2>一、Hermes 技能盘点结论</h2>
<div class="grid3">
  <div class="tile"><b>已有的相关技能（2 个，均为本项目自建）</b>
    <span class="tag">ashare-news-triage</span><span class="tag">market-modules</span>
    <p>前者做新闻价值分级、只输出标注 JSON；后者按需读模块快照，内含 <code>event-study.json</code> 事件历史统计。两者都不是「事件解释 + 影响判断 + 历史类比」。</p></div>
  <div class="tile"><b>内置技能库</b><span class="tag none">无金融 / 股票专属</span>
    <p>WSL <code>~/.hermes/skills</code> 共 34 个技能（apple / research / data-science / feeds / knowledge-graph 等通用类），没有任何 A 股、股票或二级市场影响专属技能。且后端 <code>hermes.ask()</code> 不带技能参数，技能不会自动作用于解读接口。</p></div>
  <div class="tile"><b>本次补齐（1 个）</b><span class="tag new">ashare-event-impact 新增</span>
    <p>把「事件解释 → 作用机制 → 二级市场影响判断 → 历史同类情形 → 证伪条件」写成技能规范，已同步安装到 WSL 用户技能目录；后端按同一方法论落地，不只依赖技能。</p></div>
</div>

<h2>二、解读骨架：从指标罗列改成事件主线</h2>
<div class="cols">
  <div class="card"><b>改造前（指标复述机）</b><ul class="skel">${oldSkel.map(x => '<li>' + esc(x) + '</li>').join('')}</ul>
    <p class="note">根因：提示词注入政策重要性分 / 情感分 / 命中词 / 板块代码 / 条数，硬性规则又要求「逐字引用、逐个点名」，模型只能把数字复述一遍。</p></div>
  <div class="card"><b>改造后（事件中心）</b><ul class="skel new">${newSkel.map(x => '<li>' + esc(x) + '</li>').join('')}</ul>
    <p class="note">新增硬约束：禁止指标罗列、影响判断必须四选一给明确结论、历史段只能逐字引用程序统计、无样本必须写「无历史统计可比」。</p></div>
</div>

<h2>三、历史同类情形（程序事实卡片 · 真实数据）</h2>
<p class="note">由 <code>server/event-analogy.js</code> 从 <code>data/calendar/event-study.json</code> 确定性生成，随响应恒返回；智能体失败 / 未配置时卡片依然可见。下面是真实单条解读返回的卡片。</p>
${histCard(one.historicalCard)}
<div class="card" style="margin-top:12px"><b>归类与降级口径</b>
<table><tr><th>情况</th><th>处理</th></tr>
<tr><td>命中官方指数 / 政策 / 会议规则</td><td>用「近 2 年同类日历事件」统计（如 PMI 24 次 / 96 观测、LPR 23 次 / 46 观测）</td></tr>
<tr><td>未命中规则但命中板块</td><td>降级为「相关板块代理在历史事件中的表现」，明确标注非同类严格对照（如黄金 48 次观测）</td></tr>
<tr><td>无规则、无板块代理</td><td>如实写「无历史统计可比」，不编造年份、案例或涨跌数字</td></tr>
<tr><td>样本 &lt; 8 / 快照 &gt; 30 天</td><td>标「低样本不可外推」/「快照陈旧」，口径限制随卡片与提示词一起注入</td></tr></table></div>

<h2>四、真实单条解读输出（${esc(one.promptVersion || '')} · ${esc(one.backend || '')}）</h2>
<p class="meta">新闻：${esc(one.itemTitle || '')} ｜ 事件类型：${esc(one.eventType || '')} ｜ 文本 ${String(one.text || '').length} 字</p>
<div class="card md">${md(one.text)}</div>

<h2>五、真实今日整体解读输出（${esc(daily.promptVersion || '')} · ${esc(daily.backend || '')}）</h2>
<p class="meta">进入解读 ${esc(String(daily.newsCount || 0))} 条 ｜ 命中官方指数发布增强：${daily.macro && daily.macro.detected ? '是' : '否'} ｜ 文本 ${String(daily.text || '').length} 字</p>
<details class="fold"><summary>展开全文</summary><div class="card md" style="margin-top:10px">${md(daily.text)}</div></details>

<h2>六、边界与纪律</h2>
<div class="card note">
- 程序只做确定性统计与归类，<b>不裁定事实真伪、不预判行情</b>；官方公告始终是最终口径。<br>
- 历史统计为可交易 ETF 代理近似，不等于行业指数真实表现；历史胜率不是未来概率，过往表现不预示未来收益。<br>
- 影响判断是研究观点，不是涨跌必然性预测、不是点位预测、不是买卖指令；受益侧无证据时如实写「无法认定」。<br>
- 宏观增强段（机构预期 / 跨资产 / 多数方向）保留上一轮成果，但统计计数只引用一次，不得抄成清单；免责声明逐字引用且有程序兜底。<br>
- 手动解读需等智能体审查，实测单条约 45 秒、今日整体约 38 秒；前端已保留 loading 与防重复点击。
</div>
</div></body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, H, 'utf8');
console.log('已生成：' + OUT);
console.log('大小：' + fs.statSync(OUT).size + ' B');
console.log('单条解读字数：' + String(one.text || '').length + ' ｜ 整体解读字数：' + String(daily.text || '').length);
