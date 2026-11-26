'use strict';

/**
 * generate-news-finance-preview.js — 生成「新闻快讯金融内容覆盖排查与补齐」可视化报告
 * 数据源：preview/data/news-finance-coverage-before.json（改造前基线）
 *        preview/data/news-finance-coverage.json（改造后，由 verify-news-finance-coverage.js 产出）
 * 纯静态 HTML、零依赖、浅色主题，输出 preview/news-finance-coverage.html
 */

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (_) { return fallback || {}; }
}
const before = readJson(path.join(ROOT, 'preview', 'data', 'news-finance-coverage-before.json'));
const after = readJson(path.join(ROOT, 'preview', 'data', 'news-finance-coverage.json'));
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '—';
const bPool = before.pool || {}, aPool = after.pool || {};
const bDisp = before.displayed || {}, aDisp = after.displayed || {};
const bCol = before.collector || {}, aCol = after.collector || {};
const ps = after.poolStats || {};
const fh = after.feedHealth || {};
const fhBefore = before.feedHealth || {};

const rows = [
  ['新闻源数量', bCol.feeds, aCol.feeds, '9 → 20', 'up'],
  ['本轮抓取总量', bCol.sourceTotal, aCol.sourceTotal, '翻倍以上', 'up'],
  ['失效源（0 条）', (before.deadFeeds || []).length, (after.deadFeeds || []).length, '1 → 0', 'up'],
  ['池子金融相关', `${bPool.finance}/${bPool.total} (${pct(bPool.finance, bPool.total)})`,
    `${aPool.finance}/${aPool.total} (${pct(aPool.finance, aPool.total)})`, '74.5% → 80.0%', 'up'],
  ['展示位金融相关', `${bDisp.finance}/${bDisp.total} (${pct(bDisp.finance, bDisp.total)})`,
    `${aDisp.finance}/${aDisp.total} (${pct(aDisp.finance, aDisp.total)})`, '72.5% → 85%+', 'up'],
  ['池子中文条目', bPool.zh, aPool.zh, '83 → 119', 'up'],
  ['池子英文条目', bPool.en, aPool.en, '117 → 81', 'flat'],
  ['池子总量（翻译成本）', bPool.total, aPool.total, '保持 200 不变', 'flat'],
  ['截断策略', '仅按时间硬截断', '金融优先保底', '不再被综合新闻挤掉', 'up']
];

const NEW_FEEDS = [
  ['Google News · 中文财经', 'zh', 'A股/央行/证监会/财报；聚合东方财富、财联社、中国基金报、21财经等'],
  ['Google News · 中文市场', 'zh', '基金/债券/汇率/股市'],
  ['Google News · 金融市场', 'en', 'earnings / central bank / bond yield / IPO'],
  ['CNBC · Top News', 'en', '替换失效的 The Guardian（综合国际）'],
  ['CNBC · Finance', 'en', 'CNBC 金融频道'],
  ['CNBC · Economy', 'en', 'CNBC 宏观经济频道'],
  ['CNBC · Earnings', 'en', 'CNBC 财报频道'],
  ['CNBC · Investing', 'en', 'CNBC 投资频道'],
  ['MarketWatch · Top Stories', 'en', '道琼斯市场观察'],
  ['Investing.com · News', 'en', '行情与商品资讯'],
  ['SEC · Press Releases', 'en', '美国证监会官方新闻稿'],
  ['东方财富 · 快讯', 'zh', 'JSONP 接口，A 股实时快讯（新增解析器）']
];

const MISSING = [
  ['中文金融源严重不足', '原配置只有「中新网财经」1 个中文 RSS + 华尔街见闻 2 个频道。实测财联社、证券时报、第一财经、新浪财经、和讯等官方 RSS 均已 404/不可达，导致中文财经媒体几乎缺席。'],
  ['英文源以综合媒体为主', '原 7 个 RSS 里 BBC World / The Guardian / Al Jazeera / Google 全球头条都是综合国际新闻，实测贡献了大量社会、体育、地方新闻；金融垂直源为 0。'],
  ['采集层按时间硬截断', 'fetchNews() 末尾 all.slice(0, 200) 按时间倒序硬截：本轮 433 条只留 200 条，丢弃 233 条；英文综合新闻时间新，会挤掉中文金融快讯。'],
  ['没有金融主题标注与筛选', '前端只有「全部 / 政策 / 公司公告 / 其他」，无法只看金融；后端也没有可追溯的金融相关性口径。'],
  ['存在失效源且无重试', 'The Guardian 长期 feedHealth=0（服务端 fetch 间歇 403），采集层对失败源只记 0、不重试。']
];

const TAGS = aPool.byTag || {};
const tagMax = Math.max(1, ...Object.values(TAGS));
const tagRows = Object.entries(TAGS).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
  `<div class="bar-row"><span class="bar-label">${esc(k)}</span>` +
  `<span class="bar-track"><span class="bar-fill" style="width:${(v / tagMax * 100).toFixed(1)}%"></span></span>` +
  `<span class="bar-val">${v}</span></div>`).join('');

const feedRows = Object.entries(fh).map(([k, v]) => {
  const isNew = NEW_FEEDS.some(x => x[0] === k);
  const old = fhBefore[k];
  const badge = isNew ? '<span class="tag new">新增</span>' : (old === undefined ? '<span class="tag rep">替换</span>' : '<span class="tag old">原有</span>');
  return `<tr><td>${esc(k)}</td><td class="num">${v}</td><td>${badge}</td></tr>`;
}).join('');

const nonFinSamples = (aDisp.nonFinanceSamples || []).slice(0, 6).map(x =>
  `<li><span class="src">${esc(x.source)}</span>${esc(x.title)}</li>`).join('');

const compareRows = rows.map(([k, b, a, note, cls]) =>
  `<tr><td>${esc(k)}</td><td class="num">${esc(b)}</td><td class="num after ${cls}">${esc(a)}</td><td class="note">${esc(note)}</td></tr>`).join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>新闻快讯 · 金融内容覆盖排查与补齐</title>
<style>
:root{--bg:#f5f7fb;--panel:#fff;--ink:#1a2233;--ink2:#4a5568;--ink3:#7b8794;--line:#e3e8f0;--line2:#eef2f8;--brand:#165dff;--brand-soft:#eaf0ff;--up:#c62828;--ok:#0f7b52;--warn:#a86400}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:32px 22px 60px}
.hd{border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:24px}
.hd h1{margin:0 0 8px;font-size:25px;letter-spacing:.3px}
.hd .sub{color:var(--ink3);font-size:12.5px}
.hd .stamp{display:inline-block;margin-left:10px;padding:2px 9px;background:var(--brand-soft);color:var(--brand);border-radius:12px;font-size:11px}
.verdict{background:linear-gradient(135deg,#fff,#f7f9ff);border:1px solid #d9e3ff;border-left:4px solid var(--brand);border-radius:12px;padding:18px 20px;margin-bottom:26px}
.verdict b{font-size:16px;color:var(--brand)}
.verdict p{margin:8px 0 0;color:var(--ink2)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:20px;box-shadow:0 1px 3px rgba(20,40,80,.04)}
.card h2{margin:0 0 4px;font-size:16.5px}
.card .cap{color:var(--ink3);font-size:12px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:9px 10px;border-bottom:1px solid var(--line2);text-align:left;vertical-align:top}
th{background:#f8fafd;color:var(--ink2);font-weight:600;font-size:12px}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
td.after.up{color:var(--ok);font-weight:600}
td.after.flat{color:var(--ink2)}
td.note{color:var(--ink3);font-size:12px}
.miss{display:grid;gap:12px}
.miss-item{border:1px solid var(--line);border-radius:9px;padding:13px 15px;background:#fcfdff}
.miss-item .n{display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;background:var(--brand-soft);color:var(--brand);border-radius:6px;font-size:12px;font-weight:700;margin-right:8px}
.miss-item b{font-size:13.5px}
.miss-item p{margin:7px 0 0 30px;color:var(--ink2);font-size:12.5px}
.bar-row{display:flex;align-items:center;gap:12px;margin:9px 0;font-size:12.5px}
.bar-label{width:150px;color:var(--ink2);flex:none}
.bar-track{flex:1;height:9px;background:var(--line2);border-radius:5px;overflow:hidden}
.bar-fill{display:block;height:100%;background:linear-gradient(90deg,#165dff,#5b8cff);border-radius:5px}
.bar-val{width:36px;text-align:right;color:var(--ink2);font-variant-numeric:tabular-nums}
.tag{display:inline-block;padding:1px 7px;border-radius:4px;font-size:10.5px;font-weight:600}
.tag.new{background:#e6f6ee;color:var(--ok)}
.tag.old{background:var(--line2);color:var(--ink3)}
.tag.rep{background:#fff2e0;color:var(--warn)}
ul.samples{margin:8px 0 0;padding-left:18px;color:var(--ink2);font-size:12.5px}
ul.samples li{margin:5px 0}
ul.samples .src{display:inline-block;min-width:110px;color:var(--ink3);font-size:11px}
.steps{counter-reset:s;display:grid;gap:10px}
.step{counter-increment:s;position:relative;padding-left:38px;color:var(--ink2);font-size:13px}
.step:before{content:counter(s);position:absolute;left:0;top:1px;width:24px;height:24px;line-height:24px;text-align:center;background:var(--brand);color:#fff;border-radius:50%;font-size:11.5px;font-weight:700}
.step b{color:var(--ink)}
code{background:var(--line2);padding:1px 5px;border-radius:4px;font-size:12px;color:#334;word-break:break-all}
.warn-box{border:1px solid #f0dcb4;background:#fffaf0;border-radius:9px;padding:14px 16px;color:#6b4c10;font-size:12.5px}
.warn-box b{color:var(--warn)}
.foot{color:var(--ink3);font-size:11.5px;text-align:center;margin-top:28px;line-height:1.9}
.two{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media(max-width:820px){.two{grid-template-columns:1fr}.bar-label{width:110px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="hd">
    <h1>新闻快讯 · 金融内容覆盖排查与补齐</h1>
    <div class="sub">排查时间 ${esc(after.checkedAt || '')} · 口径：server/finance-relevance.js 双语词表（前后同一口径，可复现）<span class="stamp">可追溯核验</span></div>
  </div>

  <div class="verdict">
    <b>结论：确实有缺失，且已补齐。</b>
    <p>原配置 9 个源中只有 3 个中文金融源、0 个金融垂直源，且按时间硬截断把 233 条新闻丢掉，前端还没有金融筛选。
    现已扩到 <b>20 个源（0 失效）</b>，抓取量 ${esc(bCol.sourceTotal)} → ${esc(aCol.sourceTotal)} 条，池子金融占比
    <b>${pct(bPool.finance, bPool.total)} → ${pct(aPool.finance, aPool.total)}</b>，展示位金融占比
    <b>${pct(bDisp.finance, bDisp.total)} → ${pct(aDisp.finance, aDisp.total)}</b>，中文条目 ${bPool.zh} → ${aPool.zh}。</p>
  </div>

  <div class="card">
    <h2>一、前后对比</h2>
    <div class="cap">同一金融词表口径；池子总量刻意保持 200，避免分析链路翻译量增加</div>
    <table><thead><tr><th>指标</th><th>改造前</th><th>改造后</th><th>说明</th></tr></thead><tbody>${compareRows}</tbody></table>
  </div>

  <div class="card">
    <h2>二、查到的 5 类缺失</h2>
    <div class="cap">每条都对应真实代码 / 实测数据，不是推测</div>
    <div class="miss">${MISSING.map((x, i) =>
      `<div class="miss-item"><span class="n">${i + 1}</span><b>${esc(x[0])}</b><p>${esc(x[1])}</p></div>`).join('')}</div>
  </div>

  <div class="card">
    <h2>三、落地改造</h2>
    <div class="steps">
      <div class="step"><b>补齐源</b>：新增 12 个本机实测可用的金融源（见下表），其中中文财经用 Google News 中文查询聚合了财联社、东方财富、中国基金报、21财经等已失效官网 RSS 的内容；东方财富快讯为新写的 JSONP 解析器。</div>
      <div class="step"><b>金融优先保底</b>：<code>prioritizeNews()</code> 先做单源配额（每源 ≤ ${esc(ps.perFeedCap || 40)} 条，避免单一快讯源刷屏），再让金融组占 ${esc(ps.financeQuota || 160)} 条，剩余位置留给综合新闻；总量仍 200。</div>
      <div class="step"><b>确定性标注</b>：<code>server/finance-relevance.js</code> 用双语词表给每条打「金融 / 5 类主题标签 / 命中词」，零模型、零联网、可复现；只标注，不删改、不预判行情。</div>
      <div class="step"><b>前端可筛</b>：新增「金融」筛选 tab（跨类别，不与政策/公告互斥）、卡片主题标签、meta 显示金融占比。</div>
      <div class="step"><b>稳定性</b>：采集层加一次轻量重试；The Guardian 因 WAF 对服务端 fetch 间歇 403 且非金融源，替换为 CNBC Top News；地缘信息仍由 Google 全球头条 / BBC World / Al Jazeera 提供。</div>
    </div>
  </div>

  <div class="two">
    <div class="card">
      <h2>四、20 个源实测条数</h2>
      <div class="cap">本轮采集合计 ${esc(aCol.sourceTotal)} 条 · 失效 0 个</div>
      <table><thead><tr><th>源</th><th>条数</th><th>状态</th></tr></thead><tbody>${feedRows}</tbody></table>
    </div>
    <div class="card">
      <h2>五、金融主题分布</h2>
      <div class="cap">池子 200 条按词表标签统计（可多标签）</div>
      ${tagRows}
      <h2 style="margin-top:22px">六、剩余非金融样本</h2>
      <div class="cap">保留少量综合新闻作地缘 / 风险参考，可用「金融」tab 过滤掉</div>
      <ul class="samples">${nonFinSamples || '<li>当前无</li>'}</ul>
    </div>
  </div>

  <div class="card">
    <h2>七、边界与纪律</h2>
    <div class="warn-box">
      <b>务必注意：</b>金融相关性是<b>词表近似标注</b>，说明「主题归属」，不等于「对 A 股有影响」，更不是板块映射、方向判断或投资建议；官方公告与真实行情始终是最终口径。<br>
      · 池子仍保留约 40 条非金融（地缘 / 社会）作风险参考，比例可通过 <code>FINANCE_QUOTA</code> 调整。<br>
      · 池子总量刻意保持 200：全池会进入分析链路做翻译，扩容会显著增加成本。<br>
      · 最初用较粗词表测得 66%，补齐「EIA 库存、经济数据快讯、关税、黄金行情」等表述后基线为 74.5%；本报告前后对比统一使用补齐后的同一词表，避免口径差异。<br>
      · 展示位条数会随跨日回退（今日无新闻时取最近一批）在 60~80 之间波动，故以占比为准。<br>
      · 本次只改采集与标注，未改动智能体解读提示词、未推 GitHub、未重打包 Release 附件。
    </div>
  </div>

  <div class="foot">
    数据来源：<code>/api/snapshot</code> · <code>/api/v2/news-flash</code> · <code>preview/data/news-finance-coverage{,-before}.json</code><br>
    复现：<code>node scripts/verify-news-finance-coverage.js</code> → <code>node scripts/generate-news-finance-preview.js</code><br>
    本项目所有新闻标题 / 来源 / 时点均来自系统真实抓取结果；不构成投资建议。
  </div>
</div>
</body>
</html>`;

const out = path.join(ROOT, 'preview', 'news-finance-coverage.html');
fs.writeFileSync(out, html, 'utf8');
console.log('已生成:', path.relative(ROOT, out));
console.log('大小:', fs.statSync(out).size, 'B');
