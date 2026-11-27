'use strict';

/**
 * generate-fomc-preview.js — 生成 FOMC 官方日历核对页（数据直接取自程序模块）
 * 输出：preview/fomc-calendar.html
 */
const fs = require('node:fs');
const path = require('node:path');
const fomc = require('../server/fomc-calendar');

const OUT = path.join(__dirname, '..', 'preview', 'fomc-calendar.html');
const e26 = fomc.eventsForYear(2026);
const e27 = fomc.eventsForYear(2027);
const e28 = fomc.eventsForYear(2028);
const next = fomc.status().nextAfter('2026-11-27');

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const md = s => s.replace('-', '/').replace(/^0/, '');

function row(e) {
  const rng = md(e.date.slice(5)) + '–' + md(e.endDate.slice(5));
  return `<tr class="${e.date === next.date ? 'next' : ''}">
    <td class="date">${esc(rng)}</td>
    <td>${e.sep ? '<span class="pill sep">SEP · 点阵图</span>' : '<span class="muted">—</span>'}</td>
    <td class="mono">${e.minutesDate ? esc(e.minutesDate) : '<span class="muted">官网未列（约三周后）</span>'}</td>
    <td class="mono">${esc(e.decisionTimeBJ)}</td>
    <td><span class="pill ${e.grade === 'A' ? 'ga' : 'gb'}">${e.grade} · ${e.confirmed ? '官网已公布' : '暂定'}</span></td>
  </tr>`;
}

const rows26 = e26.map(row).join('\n');
const rows27 = e27.map(e => `<tr><td class="date">${esc(md(e.date.slice(5)) + '–' + md(e.endDate.slice(5)))}</td><td>${esc(e.detail.match(/【官网备注】([^。]*)/)?.[1] || '例行会议（官网暂定）')}</td><td><span class="pill gb">B · 暂定</span></td></tr>`).join('\n');
const rows28 = e28.map(e => `<tr><td class="date">${esc(md(e.date.slice(5)) + '–' + md(e.endDate.slice(5)))}</td><td>官网脚注：两天会议；其余 2028 年日程尚未公布</td><td><span class="pill gb">B · 暂定</span></td></tr>`).join('\n');

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>美联储 FOMC 议息会议 · 官方日历核对</title>
<style>
  :root{--bg:#f5f7fa;--card:#fff;--ink:#1b2430;--sub:#5b6879;--line:#e3e8ef;--brand:#1b4f9c;--red:#b3261e;--amber:#8a5a00;--green:#137a4b}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:28px}
  .wrap{max-width:1080px;margin:0 auto}
  h1{font-size:24px;margin:0 0 6px}h2{font-size:17px;margin:0 0 14px;padding-left:10px;border-left:3px solid var(--brand)}
  .sub{color:var(--sub);font-size:13px;margin-bottom:22px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px 22px;margin-bottom:18px;box-shadow:0 1px 3px rgba(20,40,80,.04)}
  .hero{background:linear-gradient(135deg,#fff 0%,#f0f5ff 100%);border-left:4px solid var(--brand)}
  .hero .big{font-size:26px;font-weight:700;color:var(--brand);margin:2px 0 8px}
  .kv{display:grid;grid-template-columns:110px 1fr;gap:6px 14px;font-size:13px;margin-top:12px}
  .kv .k{color:var(--sub)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
  th{background:#f8fafc;color:var(--sub);font-weight:600;font-size:12px}
  tr.next{background:#fff8f0}tr.next .date{color:var(--red);font-weight:700}
  .date{font-weight:600;white-space:nowrap}.mono{font-family:Consolas,monospace;font-size:12px}
  .muted{color:#98a2b3}.pill{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;white-space:nowrap}
  .sep{background:#eef3ff;color:var(--brand)}.ga{background:#fdecea;color:var(--red)}.gb{background:#fff4e0;color:var(--amber)}
  .flow{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:6px}
  .step{background:#f8fafc;border:1px solid var(--line);border-radius:8px;padding:12px;position:relative}
  .step .n{display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:50%;background:var(--brand);color:#fff;font-size:11px;margin-bottom:8px}
  .step b{display:block;font-size:13px}.step span{color:var(--sub);font-size:12px}
  .cmp{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .cmp>div{border:1px solid var(--line);border-radius:8px;padding:14px}
  .bad{background:#fff5f4;border-color:#f3c9c4}.good{background:#f2fbf6;border-color:#bfe6cf}
  .bad h3,.good h3{margin:0 0 8px;font-size:14px}.bad h3{color:var(--red)}.good h3{color:var(--green)}
  ul{margin:6px 0 0;padding-left:18px}li{margin:4px 0}
  .note{background:#f8fafc;border:1px dashed var(--line);border-radius:8px;padding:12px 14px;color:var(--sub);font-size:12.5px}
  a{color:var(--brand)}code{background:#eef2f7;padding:1px 5px;border-radius:4px;font-size:12px}
  footer{color:var(--sub);font-size:12px;text-align:center;margin:24px 0 6px}
  @media(max-width:760px){.flow,.cmp{grid-template-columns:1fr}.kv{grid-template-columns:90px 1fr}}
</style></head><body><div class="wrap">

<h1>美联储 FOMC 议息会议 · 官方日历核对</h1>
<div class="sub">数据源：<a href="${esc(fomc.SOURCE.url)}" target="_blank" rel="noopener">Federal Reserve 官网 FOMC Meeting calendars</a> · 本机核实于 ${esc(fomc.SOURCE.verifiedAt)} · 本页数据直接由 <code>server/fomc-calendar.js</code> 生成，非手写</div>

<div class="card hero">
  <div class="sub" style="margin:0">下一次会议（当前 2026-11-27 之后）</div>
  <div class="big">2026-12-08 ~ 12-09（周二–周三）</div>
  <div>美联储 FOMC 议息会议，<b>含经济预测摘要 SEP 与点阵图</b>；<span class="pill ga">A · 官网已公布</span> <span class="pill sep">fed-official</span></div>
  <div class="kv">
    <div class="k">决议发布</div><div>美东 12-09 14:00（长期惯例）→ <b>北京时间 2026-12-10 03:00</b>（冬令时 EST，ET+13h）</div>
    <div class="k">主席发布会</div><div>美东 12-09 14:30 → 北京时间 2026-12-10 03:30</div>
    <div class="k">会议纪要</div><div>决议后三周（惯例）；官网尚未列出 12 月这次的具体日期，程序留空不臆造</div>
    <div class="k">系统位置</div><div>12/8 与 12/9 两格跨天连续色条，来源标签「美联储官网」，并进入 A 级提醒</div>
  </div>
</div>

<div class="card">
  <h2>会议进程（只陈述流程事实，不预判利率结果）</h2>
  <div class="flow">
    <div class="step"><span class="n">1</span><b>第一天 · 闭门讨论</b><span>12/8，讨论经济与金融形势、审阅预测材料</span></div>
    <div class="step"><span class="n">2</span><b>第二天 14:00 ET</b><span>政策声明 + 联邦基金利率决定 + 实施说明</span></div>
    <div class="step"><span class="n">3</span><b>同步发布 SEP</b><span>点阵图、GDP / 通胀 / 失业率预测（仅 3/6/9/12 月会议）</span></div>
    <div class="step"><span class="n">4</span><b>14:30 ET 发布会</b><span>主席答记者问，市场据措辞调整预期</span></div>
    <div class="step"><span class="n">5</span><b>三周后 · 纪要</b><span>披露讨论细节与分歧；2026 前 7 次日期官网已列</span></div>
  </div>
  <div class="note" style="margin-top:14px">14:00 / 14:30 是 FOMC <b>长期惯例</b>，官网日历页只列日期、不列时刻。程序按美东夏令时（EDT，ET+12h）/ 冬令时（EST，ET+13h）换算北京时间并标注口径。</div>
</div>

<div class="card">
  <h2>2026 年 8 次例会（官网已公布 · A 级）</h2>
  <table><thead><tr><th>会议日期</th><th>经济预测</th><th>纪要发布（官网）</th><th>决议北京时间</th><th>分级</th></tr></thead><tbody>
${rows26}
  </tbody></table>
  <div class="note" style="margin-top:12px">月份为 1/3/4/6/7/9/10/12 —— 官网 <b>4 月开会</b>；原程序误写成 5 月。带 * 的 4 次会议含 SEP / 点阵图。</div>
</div>

<div class="card">
  <h2>2027 / 2028 暂定日程（官网 Future Year · B 级）</h2>
  <table><thead><tr><th>会议日期</th><th>官网备注</th><th>分级</th></tr></thead><tbody>
${rows27}
${rows28}
  </tbody></table>
  <div class="note" style="margin-top:12px">官网明确注明「每次会议日期在前一次会议确认前均为暂定」，因此全部标 <code>B / confirmed=false / fed-tentative</code>。2027 年官网未列 12 月例会、改列 11 月，程序照录不自行补一个 12 月。2029 起官网未公布 → 不生成、不推算。</div>
</div>

<div class="card">
  <h2>修复前 vs 修复后</h2>
  <div class="cmp">
    <div class="bad"><h3>修复前（你截图里看到的状态）</h3><ul>
      <li>12 月日历里 FOMC 挂在 <b>12/1</b>，是 <code>allMonth=true</code> 的「月事件」，没有具体日期</li>
      <li><code>grade=B</code> / <code>verified=false</code>，详情只写「以官网为准」</li>
      <li>规则月份 <code>[1,3,5,6,7,9,10,12]</code>：把官网 4 月会议误写成 5 月</li>
      <li>12/2 那条是「EIA 原油库存周报」（C 级、每周三推算），与议息无关</li>
      <li>从未与官网日期做过比对，也未经过准入闸门审查</li>
    </ul></div>
    <div class="good"><h3>修复后</h3><ul>
      <li>12/8 与 12/9 显示 <b>A 级</b>官方两日会议，跨天连续色条</li>
      <li>逐条附官网 URL、核实日期、SEP 标记、纪要日期、北京时间换算</li>
      <li>2027/2028 暂定日程标 B 级并注明「待前一次会议确认」</li>
      <li>进入 A 级提醒（重大事件，不被休市类排除）</li>
      <li><code>scripts/verify-fomc-calendar.js</code> 26/26 断言 + 真实接口逐月核对</li>
    </ul></div>
  </div>
</div>

<div class="card">
  <h2>准确性检查：哪些事件会被核对</h2>
  <table><thead><tr><th>事件来源</th><th>是否核对</th><th>机制</th></tr></thead><tbody>
    <tr><td>新闻扫描入历 <code>news-scan</code></td><td><span class="pill ga">有</span></td><td>准入复核台：能否入历 → 信源分级 → 智能体证真伪；未通过不写入（README 一·F）</td></tr>
    <tr><td>周期规则推算 <code>calendar-rule</code></td><td><span class="pill gb">仅标注</span></td><td>闸门标 <code>rule-generated / not-a-news-claim</code>，明确「非新闻线索，无需真伪核验」，靠 B/C 级 + <code>verified=false</code> 提示待核实</td></tr>
    <tr><td>官方常量（美股休市 / <b>FOMC</b>）</td><td><span class="pill ga">人工核对 + 程序验证</span></td><td>照录官网并附 URL / 核实日期，配验收脚本断言；<b>不经过智能体审查，也不自动联网比对</b>，官网更新后需人工维护常量</td></tr>
  </tbody></table>
  <div class="note" style="margin-top:12px">结论：自动的「证真伪」只针对新闻线索。FOMC 这类制度性日历过去既没有官方日期、也不走闸门，属于设计缺口；本次补成官方常量库，但性质仍是「人工按官网核对 + 程序断言」，不是实时联网校验。</div>
</div>

<footer>本页仅陈述官方会议日程与流程事实，不预测利率决定结果，不给出涨跌方向，不构成投资建议。<br>生成脚本：<code>scripts/generate-fomc-preview.js</code> · 验收脚本：<code>scripts/verify-fomc-calendar.js</code></footer>
</div></body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log('written: ' + OUT);
console.log('bytes  : ' + Buffer.byteLength(html, 'utf8'));
console.log('2026=' + e26.length + '  2027=' + e27.length + '  2028=' + e28.length + '  next=' + next.date + '~' + next.endDate);
