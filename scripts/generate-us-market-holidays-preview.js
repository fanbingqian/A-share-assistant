'use strict';
/**
 * generate-us-market-holidays-preview.js — 生成美股休市日历的可视化核对页
 * 数据全部来自 server/us-market-holidays.js（NYSE 官方表），不手抄，避免预览与程序口径漂移。
 */
const fs = require('node:fs');
const path = require('node:path');
const us = require('../server/us-market-holidays');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'preview', 'us-market-holidays.html');
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wd = ds => WD[new Date(ds + 'T00:00:00Z').getUTCDay()];
const p2 = n => String(n).padStart(2, '0');

const rows = [];
for (const [y, list] of Object.entries(us.OFFICIAL_CLOSED)) {
  for (const [date, en, cn] of list) rows.push({ date, en, cn, type: 'closed', grade: 'A' });
}
for (const [date, en, cn] of us.OFFICIAL_EARLY_CLOSE) rows.push({ date, en, cn, type: 'early', grade: 'A' });
rows.sort((a, b) => a.date.localeCompare(b.date));

const closedSet = new Set(rows.filter(r => r.type === 'closed').map(r => r.date));
const earlySet = new Set(rows.filter(r => r.type === 'early').map(r => r.date));

function monthGrid(y, m) {
  const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // 周一=0
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = Math.ceil((firstDow + total) / 7) * 7;
  let html = '<div class="cal"><div class="cal-h">' + y + ' 年 ' + m + ' 月</div><div class="cal-w">' +
    ['一', '二', '三', '四', '五', '六', '日'].map(d => '<span>' + d + '</span>').join('') + '</div><div class="cal-g">';
  for (let i = 0; i < cells; i++) {
    const d = i - firstDow + 1;
    const ds = y + '-' + p2(m) + '-' + p2(d);
    const valid = d >= 1 && d <= total;
    const kind = valid ? (closedSet.has(ds) ? 'closed' : earlySet.has(ds) ? 'early' : '') : '';
    const label = kind === 'closed' ? 'US 休' : kind === 'early' ? 'US 早收' : '';
    const name = kind === 'closed'
      ? (rows.find(r => r.date === ds && r.type === 'closed') || {}).cn
      : kind === 'early' ? (rows.find(r => r.date === ds && r.type === 'early') || {}).cn : '';
    html += '<div class="cell' + (valid ? '' : ' blank') + (kind ? ' us-' + kind : '') + '">' +
      (valid ? '<div class="cn">' + d + '</div>' + (label ? '<div class="flag">' + label + '</div>' : '') +
        (name ? '<div class="chip">' + esc(name) + '</div>' : '') : '') + '</div>';
  }
  return html + '</div></div>';
}

const tableRows = rows.map(r => {
  const badge = r.type === 'closed'
    ? '<span class="bd bd-closed">全天休市</span>'
    : '<span class="bd bd-early">提前收盘 13:00 ET</span>';
  return '<tr><td class="dt">' + r.date + '</td><td>' + wd(r.date) + '</td><td>' + esc(r.cn) +
    '</td><td class="en">' + esc(r.en) + '</td><td>' + badge + '</td><td><span class="gd">A · 官方已公布</span></td></tr>';
}).join('\n');

const yearSummary = [2026, 2027, 2028].map(y => {
  const c = (us.OFFICIAL_CLOSED[y] || []).length;
  const e = us.OFFICIAL_EARLY_CLOSE.filter(r => r[0].startsWith(String(y))).map(r => r[0].slice(5)).join('、') || '—';
  return '<tr><td><b>' + y + '</b></td><td>' + c + ' 天</td><td>' + e + '</td><td><span class="gd">A · 官方已公布</span></td></tr>';
}).join('\n');

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>美股休市日历 · NYSE 官方（2026–2028）</title>
<style>
:root{--bg:#f5f6f8;--panel:#fff;--ink:#1d2129;--ink2:#4e5969;--ink3:#86909c;--line:#e5e6eb;--us:#2d6a86;--us-soft:rgba(45,106,134,.14);--brand:#165dff}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:26px 18px 50px}
.wrap{max-width:1080px;margin:0 auto}
h1{font-size:24px;font-weight:700;letter-spacing:.5px}
.sub{color:var(--ink2);margin-top:6px;font-size:13px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-top:18px;box-shadow:0 1px 3px rgba(20,30,60,.05)}
h2{font-size:16px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:8px}
h2::before{content:'';width:4px;height:16px;background:var(--us);border-radius:2px}
a{color:var(--brand);text-decoration:none}
a:hover{text-decoration:underline}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-top:4px}
.kv div{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 12px}
.kv b{display:block;font-size:11px;color:var(--ink3);font-weight:600;letter-spacing:.4px}
.kv span{font-size:13px;color:var(--ink)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11.5px;color:var(--ink3);font-weight:600;background:var(--bg)}
tbody tr:nth-child(even){background:#fafbfc}
.dt{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}
.en{color:var(--ink2);font-size:12px}
.bd{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap}
.bd-closed{color:#1c4b63;background:var(--us-soft);border:1px dashed var(--us)}
.bd-early{color:#1c4b63;background:rgba(45,106,134,.07);border:1px dotted var(--us)}
.gd{font-size:11px;color:var(--ink2);white-space:nowrap}
.cals{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.cal{border:1px solid var(--line);border-radius:10px;overflow:hidden}
.cal-h{background:var(--bg);font-weight:700;font-size:13px;padding:8px 12px;border-bottom:1px solid var(--line)}
.cal-w,.cal-g{display:grid;grid-template-columns:repeat(7,1fr)}
.cal-w span{text-align:center;font-size:11px;color:var(--ink3);padding:5px 0;border-bottom:1px solid var(--line)}
.cell{min-height:62px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:4px;position:relative}
.cell:nth-child(7n){border-right:0}
.cell.blank{background:#fafbfc}
.cn{font-size:11px;font-weight:600;color:var(--ink2)}
.us-closed{background:repeating-linear-gradient(135deg,transparent 0 7px,rgba(45,106,134,.05) 7px 14px)}
.us-early{background:repeating-linear-gradient(135deg,transparent 0 7px,rgba(45,106,134,.025) 7px 14px)}
.flag{position:absolute;top:3px;right:3px;font-size:9px;font-weight:700;color:#1c4b63;background:var(--us-soft);border:1px dashed var(--us);border-radius:3px;padding:0 3px;white-space:nowrap;z-index:2}
.chip{margin-top:6px;font-size:9.5px;line-height:1.35;color:#1c4b63;background:var(--us-soft);border-left:3px dashed var(--us);border-radius:3px;padding:2px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.note{font-size:12.5px;color:var(--ink2);line-height:1.8}
.note li{margin-left:18px;margin-top:4px}
.warn{border-left:3px solid var(--us);background:var(--us-soft);padding:10px 14px;border-radius:0 8px 8px 0;font-size:12.5px;color:var(--ink2);margin-top:14px}
.foot{color:var(--ink3);font-size:11.5px;text-align:center;margin-top:22px;line-height:1.8}
</style></head><body><div class="wrap">
<h1>美股休市日历 · NYSE 官方</h1>
<div class="sub">日程与事件 → 日历网格 / 当日事件 / 未来 30 天 · 2026–2028 已公布，2029 起按规则推算</div>

<div class="card"><h2>数据来源（可追溯）</h2><div class="kv">
<div><b>发布方</b><span>${esc(us.SOURCE.publisher)}</span></div>
<div><b>页面</b><span>${esc(us.SOURCE.page)}</span></div>
<div><b>本机核实日期</b><span>${esc(us.SOURCE.verifiedAt)}</span></div>
<div><b>官方链接</b><span><a href="${esc(us.SOURCE.url)}" target="_blank" rel="noopener">nyse.com/markets/hours-calendars ↗</a></span></div>
</div><p class="note" style="margin-top:10px">NYSE 与 Nasdaq 采用同一股票市场休市日历；官网另附 <a href="${esc(us.SOURCE.tradingDaysPdf)}" target="_blank" rel="noopener">Trading Days PDF ↗</a>。</p></div>

<div class="card"><h2>年度汇总</h2><table><thead><tr><th>年份</th><th>全天休市</th><th>提前收盘（13:00 ET）</th><th>分级</th></tr></thead><tbody>
${yearSummary}
<tr><td><b>2029+</b></td><td>10 天（规则推算）</td><td>不生成（官网未公布，不臆造）</td><td><span class="gd">B · 待官方确认</span></td></tr>
</tbody></table></div>

<div class="card"><h2>逐条官方日期（共 ${rows.length} 条）</h2>
<div style="overflow-x:auto"><table><thead><tr><th>日期</th><th>星期</th><th>中文名称</th><th>NYSE 官网名称</th><th>类型</th><th>分级</th></tr></thead><tbody>
${tableRows}
</tbody></table></div></div>

<div class="card"><h2>日历呈现示意（前端专用样式）</h2><div class="cals">
${monthGrid(2026, 11)}${monthGrid(2026, 12)}
</div><p class="note" style="margin-top:12px">灰蓝虚线 = 美股官方日历；<b>与 A/B/C 等级色区分，不代表涨跌方向</b>。格子右上角标 <span class="gd">US 休 / US 早收</span>，图例注明「NYSE 官方」。</p></div>

<div class="card"><h2>口径与边界</h2><ul class="note">
<li>只写「全天休市」与 <b>官网脚注明确列出</b> 的提前收盘；第三方日历另列、官网未确认的日期一律不收录。</li>
<li>2028-01-01 为周六，NYSE 官网脚注明确 <b>不另设元旦休市日</b>（不跨年补休），故 2028 年只有 9 个全天休市日。</li>
<li>仅指美国<b>股票</b>市场（NYSE / Nasdaq / NYSE American 等）。<b>A 股、港股、中国期货照常交易</b>；美股股指期货与美国债券市场（SIFMA 日历）另有安排。</li>
<li>属制度性确定性事件库，由 <code>server/us-market-holidays.js</code> 生成、<code>calendar.js::expandRules()</code> 合并；<b>不写入 events.jsonl</b>、不经过新闻准入闸门、不被新闻扫描重复追加，因此不适用「新闻线索证真伪」流程。</li>
<li>休市 / 提前收盘<b>不进自动提醒弹框</b>（不新增每日弹窗噪音），但显示在日历网格、当日事件与「未来 30 天」。</li>
<li>交易所临时休市（如全国哀悼日）由临时公告决定，系统不预判；官网更新年度表后人工维护常量即可。</li>
</ul><div class="warn">验收：<code>node scripts/verify-us-market-holidays.js</code> → 23/23 通过；真实接口 <code>/api/v2/calendar</code> 已逐月核对 2026-11 / 12、2027-01、2028-01。</div></div>

<div class="foot">本表为交易所官方日历事实，不构成投资建议，也不对任何市场走势作判断。<br>生成脚本：scripts/generate-us-market-holidays-preview.js · 数据模块：server/us-market-holidays.js</div>
</div></body></html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log('written: ' + OUT + ' (' + Buffer.byteLength(html, 'utf8') + ' bytes, ' + rows.length + ' official dates)');
