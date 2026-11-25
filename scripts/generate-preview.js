/* Generate a static, interactive preview of the new strip+fold picks UI using REAL API data.
 * Temporary tool for the 2026-11-25 verification; output goes to preview/. */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const B = 'http://127.0.0.1:8777';
const ReviewRender = require('../web/v2/review-render.js');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
const pctText = v => { const n = num(v); return n == null ? '--' : (n > 0 ? '+' : '') + n + '%'; };

function kindTag(x) {
  const map = { hot: ['热度独立', 'k-hot'], trend: ['趋势', 'k-trend'], rebound: ['反弹', 'k-rebound'],
    dip: ['低吸', 'k-dip'], board: ['打板', 'k-board'], breakout: ['趋势突破', 'k-breakout'] };
  const labelKey = { '趋势': 'trend', '低吸': 'dip', '打板': 'board', '趋势突破': 'breakout', '热度/独立行情': 'hot', '强势反弹': 'rebound' };
  const labels = (Array.isArray(x.classes) && x.classes.length) ? x.classes : [x.kindLabel || x.kind || ''];
  return labels.map(lb => {
    const key = labelKey[lb] || x.kind;
    const m = map[key] || [lb || '未分类', 'k-hot'];
    return '<span class="k-tag ' + m[1] + '">' + esc(m[0]) + '</span>';
  }).join('');
}
function roleTag(x) {
  if (x.role === 'leader') return '<span class="r-tag r-leader">★ 板块领跑</span>';
  if (x.role === 'follower') return '<span class="r-tag r-follower">↳ 跟随 ' + esc(x.leaderName || '') + '</span>';
  return '';
}
function techSignalBrief(code, byCode) {
  const t = byCode.get(String(code));
  if (!t || !t.calc) return '<span class="u-sig-none">技术标注待生成</span>';
  const fs = t.calc.factors || [];
  const hits = fs.filter(f => f.hit === true);
  const pat = ((t.calc.patterns && t.calc.patterns.rules) || []).filter(r => r.hit === true);
  const tags = [];
  if (t.stale) tags.push('<span class="u-sig warn">日线源不可达 · 沿用上次快照</span>');
  const kdj = fs.find(f => f.key === 'kdj');
  if (kdj && kdj.value && kdj.value.cross && kdj.value.cross !== 'none')
    tags.push('<span class="u-sig ' + (kdj.value.cross === 'gold' ? 'bull' : 'bear') + '">KDJ' + (kdj.value.cross === 'gold' ? '金叉' : '死叉') + '</span>');
  const bb = fs.find(f => f.key === 'buybackPrice');
  if (bb && bb.hit) tags.push('<span class="u-sig warn">回购偏离</span>');
  const mna = fs.find(f => f.key === 'mnaCapRef');
  if (mna && mna.hit) tags.push('<span class="u-sig warn">收购/重组</span>');
  tags.push('<span class="u-sig count">因子 ' + hits.length + '/' + fs.length + ' · 形态 ' + pat.length + '</span>');
  return tags.join('');
}
function driversHtml(x) {
  const ds = x.riseDrivers || [];
  if (!ds.length) return '';
  const label = { technical: '技术面', capital: '资金盘口', news: '公告/新闻', sector: '板块政策' };
  const items = ds.slice(0, 5).map(d => '<div class="drv-row"><span class="drv-type t-' + esc(d.type) + '">' + esc(label[d.type] || d.type) + '</span><span class="drv-text">' + esc(d.text) + '</span><span class="drv-src">' + esc(d.source || '') + '</span></div>').join('');
  return '<div class="drv-list"><div class="drv-head">上涨驱动线索 <span class="note">（可核验事实，非因果认定）</span></div>' + items + '</div>';
}
function techDetailHtml(code, byCode, methodology) {
  const t = byCode.get(String(code));
  if (!t || !t.calc) return '<div class="tech-empty">该标的暂无确定性技术标注（定向计算，未覆盖全部标的；不臆测）。</div>';
  const c = t.calc;
  const st = f => f.hit === true ? '<span class="tech-hit yes">命中</span>' : f.hit === false ? '<span class="tech-hit no">未命中</span>' : '<span class="tech-hit na">不可得</span>';
  const groups = {};
  (c.factors || []).forEach(f => {
    const fam = /kdj|breakMa5Two|holdMa5NewHigh|resilience|tightRange|phaseVolume/.test(f.key) ? '趋势与量能'
      : /capPercentile|longMa/.test(f.key) ? '市值与长期均线' : '事件与回购';
    (groups[fam] = groups[fam] || []).push(f);
  });
  let h = '<div class="tech-detail"><div class="tech-h">确定性技术因子 <span class="note">真实前复权日线逐条计算 · 只读标注 · 不进评分</span></div>';
  if (t.stale) h += '<div class="tech-stale">⚠ 本次日线源不可达，以下沿用上一次成功快照（已标 stale），非当日重算结果。</div>';
  Object.keys(groups).forEach(g => {
    h += '<div class="tech-grp"><div class="tech-grp-t">' + esc(g) + '</div>';
    groups[g].forEach(f => {
      h += '<div class="tech-f"><div class="tech-f-top">' + st(f) + '<b>' + esc(f.label) + '</b></div>' +
        '<div class="tech-f-note">' + esc(f.note || '') + '</div></div>';
    });
    h += '</div>';
  });
  const p = c.patterns;
  if (p && p.ok) {
    const hit = (p.rules || []).filter(r => r.hit === true);
    h += '<div class="tech-h">绝招形态库 <span class="note">共 ' + p.rules.length + ' 条判据 · 命中 ' + p.hitCount + ' · 不可得 ' + p.unavailable + ' · 原文买卖点已转为「依据 + 失效条件」</span></div>';
    if (!hit.length) h += '<div class="tech-empty">当日无形态命中（不编造命中项）。</div>';
    else h += hit.map(r => '<div class="tech-pat"><div class="tech-pat-t"><span class="tech-hit yes">命中</span><b>' + esc(r.name) + '</b><span class="note">' + esc(r.family) + ' · ' + esc(r.spec) + '</span></div>' +
      '<div class="tech-pat-b">依据：' + esc(r.basis) + '</div>' +
      '<div class="tech-pat-i">失效条件：' + esc(r.invalid) + '</div></div>').join('');
    if (methodology.length) h += '<details class="tech-meth"><summary>评估口径 · 与市面通用量化指标的对照（' + methodology.length + ' 条）</summary><ol>' +
      methodology.map(m => '<li>' + esc(m) + '</li>').join('') + '</ol></details>';
  }
  h += '<div class="tech-foot">' + esc(p && p.note ? p.note : '形态命中仅为技术条件标注，不含「必涨 / 买卖点」含义。') + '</div></div>';
  return h;
}
function unifiedRow(x, byCode, methodology) {
  const score = x.score != null ? x.score : '--';
  const ind = x.industry ? '<span class="u-industry">' + esc(x.industry) + '</span>' : '<span class="u-industry none">行业待补</span>';
  const metrics = [];
  if (x.ret5 != null) metrics.push('5日 ' + pctText(x.ret5));
  if (x.ret20 != null) metrics.push('20日 ' + pctText(x.ret20));
  if (x.independent != null) metrics.push('独立超额 ' + (x.independent > 0 ? '+' : '') + x.independent + 'pct');
  if (x.boards) metrics.push(x.boards + ' 连板');
  if (x.last != null) metrics.push('现价 ' + x.last);
  const sig = techSignalBrief(x.code, byCode);
  return '<div class="u-row u-row-v2" data-code="' + esc(x.code) + '">' +
    '<div class="u-bar" data-udetail="' + esc(x.code) + '" title="点击展开 / 收起详细指标">' +
      '<div class="u-score"><span class="sv">' + score + '</span><span class="sl">评分</span></div>' +
      '<div class="u-bar-main"><div class="u-bar-line">' + kindTag(x) + roleTag(x) +
        '<span class="stock-name">' + (esc(x.name) || esc(x.code)) + '</span><span class="stock-code">' + esc(x.code) + '</span>' + ind +
        '<span class="u-signal">' + sig + '</span>' +
        '<button class="stock-analyze" data-analyze>指标</button>' +
        '<span class="u-caret">▾</span></div>' +
        (x.score != null ? '<div class="score-bar slim"><i style="width:' + score + '%"></i></div>' : '') +
      '</div></div>' +
    '<div class="u-detail" hidden>' +
      '<div class="u-metrics">' + metrics.map(m => '<span class="stock-metric">' + esc(m) + '</span>').join('') + '</div>' +
      (x.driverSummary ? '<div class="u-driver-sum">' + esc(x.driverSummary) + '</div>' : '') +
      driversHtml(x) + techDetailHtml(x.code, byCode, methodology) +
    '</div></div>';
}
function regRow(label, value, note) {
  return '<div class="reg-row"><span class="reg-k">' + esc(label) + '</span><span class="reg-v">' + value + '</span>' +
    (note ? '<span class="reg-note">' + esc(note) + '</span>' : '') + '</div>';
}
function regimeHtml(r) {
  if (!r || !r.ok) return '<div class="empty">市场级标注尚未生成</div>';
  let h = '<div class="reg-wrap"><div class="reg-meta">数据时点 ' + esc(r.at || '--') + ' · 交易日 ' + esc(r.tradingDate || '--') + '</div>';
  const bl = r.boardLeadership || {};
  h += '<div class="reg-sec"><div class="reg-t">① 哪些板块带动指标上涨 <span class="note">贡献度 ≈ 涨跌 × 成交额，非真实指数权重分解</span></div>';
  if (bl.ok) {
    h += regRow('指数当日', bl.indexPct == null ? '不可得' : (bl.indexPct > 0 ? '+' : '') + bl.indexPct + '%', bl.indexUp ? '收涨' : '未收涨');
    h += '<div class="reg-cols"><div><div class="reg-sub">带动板块（按贡献度）</div>' +
      (bl.driving || []).slice(0, 6).map(b => regRow(b.name, (b.chg1 > 0 ? '+' : '') + b.chg1 + '%', '权重 ' + (b.weightPct == null ? '--' : b.weightPct + '%') + ' · 贡献 ' + (b.contrib == null ? '--' : b.contrib))).join('') + '</div>' +
      '<div><div class="reg-sub">指标涨 / 板块不涨</div>' +
      ((bl.lagging || []).length ? (bl.lagging || []).slice(0, 6).map(b => regRow(b.name, (b.chg1 > 0 ? '+' : '') + b.chg1 + '%', '跑输或下跌')).join('') : '<div class="reg-none">无（或指数未收涨，口径不适用）</div>') + '</div></div>';
    h += '<div class="reg-note2">' + esc(bl.note || '') + '</div>';
  } else h += '<div class="reg-none">' + esc(bl.note || '不可得') + '</div>';
  h += '</div>';
  const bb = r.barbell || {};
  h += '<div class="reg-sec"><div class="reg-t">② 震荡期哑铃效应 + 大盘哑铃 <span class="note">结合全球市场当下什么最赚钱判别</span></div>';
  if (bb.ok) {
    h += regRow('哑铃特征', bb.isBarbell == null ? '不可得' : (bb.isBarbell ? '命中' : '未命中'), '两端−中间：当日 ' + (bb.spread1 == null ? '--' : bb.spread1) + 'pct / 5日 ' + (bb.spread5 == null ? '--' : bb.spread5) + 'pct');
    h += '<div class="reg-cols"><div><div class="reg-sub">A 股市值分层</div>' +
      (bb.layers || []).map(l => regRow(l.name, l.pct1 == null ? '--' : (l.pct1 > 0 ? '+' : '') + l.pct1 + '%', '5日 ' + (l.ret5 == null ? '--' : l.ret5))).join('') + '</div>' +
      '<div><div class="reg-sub">全球倾向</div>' + regRow('风险 / 避险', (bb.global && bb.global.tilt) || 'unknown', '风险均值 ' + (bb.global && bb.global.riskAvg != null ? bb.global.riskAvg : '--') + ' / 避险均值 ' + (bb.global && bb.global.safeAvg != null ? bb.global.safeAvg : '--')) +
      ((bb.global && bb.global.best || []).length ? '<div class="reg-best">领涨：' + (bb.global.best || []).map(x => esc(x.name) + ' ' + (x.chg > 0 ? '+' : '') + x.chg + '%').join(' · ') + '</div>' : '') +
      '<div class="reg-note2">' + esc(bb.global && bb.global.note || '') + '</div></div></div>';
    h += '<div class="reg-note2">' + esc(bb.note || '') + '</div>';
  } else h += '<div class="reg-none">' + esc(bb.note || '不可得') + '</div>';
  h += '</div>';
  const ex = r.experience || {};
  h += '<div class="reg-sec"><div class="reg-t">③ 经验条目事实核对</div>';
  if (ex.ok) {
    h += regRow(esc(ex.userClaim || '用户经验'), '<b>' + esc(ex.claimStatus || '') + '</b>', '以本地真实板块快照为准，不把口述写成系统结论');
    h += '<div class="reg-inline">当日领涨：' + (ex.topBoards || []).slice(0, 5).map(b => esc(b.name) + ' ' + (b.chg1 > 0 ? '+' : '') + b.chg1 + '%').join(' · ') + '</div>';
    h += '<div class="reg-inline">化学/电子化学相关：' + ((ex.chemBoards || []).length ? (ex.chemBoards || []).slice(0, 4).map(b => esc(b.name) + ' ' + b.chg1 + '%（第' + b.rank + '/' + b.total + '）').join(' · ') : '无匹配板块') + '</div>';
  } else h += '<div class="reg-none">' + esc(ex.note || '不可得') + '</div>';
  h += '</div>';
  const by = r.buyback || {};
  h += '<div class="reg-sec"><div class="reg-t">④ 股份回购价格区间 vs 现价 <span class="note">重点标注 · 标题无价格标「待补正文」</span></div>';
  if (by.ok) {
    h += regRow('回购公告', by.count + ' 条', '重点标注 ' + by.highlighted + ' 条 · 未含价格 ' + by.missingPrice + ' 条');
    const hi = (by.items || []).filter(x => x.highlight).slice(0, 6);
    h += hi.length ? hi.map(x => '<div class="reg-bb"><b>' + esc(x.name || x.code) + '</b> <span class="stock-code">' + esc(x.code) + '</span> ' +
      '<span class="u-sig warn">' + esc((x.tags || []).join(' / ')) + '</span><div class="reg-note2">' + esc((x.notes || []).join(' ')) + '</div>' +
      '<div class="reg-note2">' + esc(x.title || '') + '</div></div>').join('') : '<div class="reg-none">当前无重点偏离标注（不代表无回购公告）。</div>';
    h += '<div class="reg-note2">' + esc(by.disclaimer || '') + '</div>';
  } else h += '<div class="reg-none">回购快照不可得</div>';
  h += '</div><div class="reg-foot">' + esc(r.disclaimer || '') + '</div></div>';
  return h;
}

(async () => {
  const get = u => fetch(B + u).then(r => r.json());
  const post = (u, b) => fetch(B + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
  const [picks, tech, rt] = await Promise.all([
    get('/api/v2/daily/picks'), get('/api/technical'), post('/api/v2/daily/review-team', { noAI: true })
  ]);
  const tv = tech.data || {};
  const byCode = new Map((tv.items || []).map(x => [String(x.code), x]));
  const methodology = tv.patternsMethodology || [];
  const view = picks.fourClass || picks.unified || {};
  const items = (view.items || []).slice(0, 14);

  const css = fs.readFileSync(path.join(ROOT, 'web', 'v2', 'v2.css'), 'utf8');
  /* 复盘改用与真实页面共用的结构化渲染模块（不再是纯文本平铺） */
  const rtHtml = ReviewRender.render(rt);

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>选股条状 + 折叠详情 · 静态预览（真实数据）</title>
<style>${css}
.pv-wrap{max-width:1180px;margin:0 auto;padding:22px 20px 60px}
.pv-head{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px;margin-bottom:16px;box-shadow:var(--shadow)}
.pv-head h1{font-size:19px;margin-bottom:6px}
.pv-head .pv-meta{color:var(--ink2);font-size:12.5px;line-height:1.9}
.pv-sec{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;margin-bottom:16px;box-shadow:var(--shadow)}
.pv-sec > h2{font-size:15px;margin-bottom:4px}
.pv-sec > .pv-sub{color:var(--ink3);font-size:12px;margin-bottom:12px}
.u-list{display:block}
.rt-text{white-space:pre-wrap;font-size:12.5px;line-height:1.85;color:var(--ink2);background:var(--bg);border:1px solid var(--line2);border-radius:8px;padding:12px 14px;margin-top:10px;max-height:420px;overflow:auto}
.rt-roles{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.rt-role{background:var(--brand-soft);border-radius:8px;padding:8px 12px;font-size:12px;display:flex;gap:8px;align-items:center}
.pv-foot{color:var(--ink3);font-size:12px;line-height:1.9;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px 18px}
.pv-badge{display:inline-block;padding:2px 8px;border-radius:5px;background:var(--brand-soft);color:var(--brand);font-size:11.5px;font-weight:600}
</style></head><body>
<div class="pv-wrap">
  <div class="pv-head">
    <h1>三类选股 · 条状列表 + 折叠详情 <span class="pv-badge">静态预览 · 真实接口数据</span></h1>
    <div class="pv-meta">
      技术标注时点 ${esc(tv.builtAtLabel || '--')} · 日线来源 <b>${esc(tv.klineSource || '--')}</b> · 覆盖 ${(tv.items || []).length} 只 / 成功 ${(tv.universe && tv.universe.barsOk) || 0} 只<br>
      选股视图 ${esc(view.generatedAt || '--')} · 共 ${(view.items || []).length} 行（本预览取前 ${items.length} 行） · 复盘时点 ${esc(rt.at || '--')}<br>
      点击任意条状行可展开「确定性技术因子 + 绝招形态库 + 评估口径」；数据均来自本机 8777 真实接口，未做任何填充或编造。
    </div>
  </div>

  <div class="pv-sec">
    <h2>① 选股池（条状 · 点击折叠）</h2>
    <div class="pv-sub">评分条 + 关键信号摘要；展开后按「趋势与量能 / 市值与长期均线 / 事件与回购」分组展示 10 项因子与形态命中依据、失效条件。</div>
    <div class="u-list">${items.map(x => unifiedRow(x, byCode, methodology)).join('')}</div>
    <div class="note" style="margin-top:10px">${esc(view.note || '')}</div>
  </div>

  <div class="pv-sec">
    <h2>② 市场级量化标注</h2>
    <div class="pv-sub">板块带动 / 哑铃效应 / 经验事实核对 / 回购价格区间偏离 —— 均为本地真实快照计算，不认定因果。</div>
    ${regimeHtml(tv.regime)}
  </div>

  <div class="pv-sec">
    <h2>③ 盘后复盘专家团 · 结构化渲染（智能体不参与预判）</h2>
    <div class="pv-sub">${esc(rt.mode || '')} · ${rt.aiSkipped ? '仅程序事实（按请求跳过智能体）' : (rt.degraded ? '智能体不可用 · 已降级为纯程序事实' : '智能体已调用')} · 右上角可切换「结构化 / 原文」</div>
    ${rtHtml}
  </div>

  <div class="pv-foot">
    <b>口径说明：</b>技术因子由真实前复权日线逐条计算（主源东财不可达时自动切腾讯 qfq，已在页首标注实际来源）；形态库把「绝招」原文的买点/卖点/必涨统一改写为「形态命中 + 量化依据 + 失效条件」；回购价格区间来自公告标题，标题无价格时如实标「待补正文」，不构成涨跌保证；板块带动为成交额加权近似分解，哑铃效应为横截面相对强弱观察。<br>
    本页只做技术条件命中判定，不含因果推断、不预测涨跌、不构成投资建议。实际交互页面：<b>http://127.0.0.1:8777</b>（服务已配置开机自启 + 健康看门狗常驻）。
  </div>
</div>
<script>
document.querySelectorAll('.u-bar').forEach(function(bar){
  bar.addEventListener('click', function(e){
    if(e.target.closest('[data-analyze]')) return;
    var row=bar.closest('.u-row'), d=row&&row.querySelector('.u-detail');
    if(!d) return;
    d.hidden=!d.hidden;
    row.classList.toggle('open',!d.hidden);
    var c=bar.querySelector('.u-caret'); if(c) c.textContent=d.hidden?'▾':'▴';
  });
});
var views=document.querySelectorAll('[data-rt-view]');
Array.prototype.forEach.call(views,function(b){
  b.addEventListener('click',function(){
    var v=b.getAttribute('data-rt-view');
    Array.prototype.forEach.call(views,function(x){ x.classList.toggle('active',x===b); });
    var st=document.querySelector('[data-rt-struct]'), raw=document.querySelector('[data-rt-raw]');
    if(st) st.hidden=(v!=='struct');
    if(raw) raw.hidden=(v!=='raw');
  });
});
</script></body></html>`;

  const out = path.join(ROOT, 'preview', 'picks-strip-preview.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log('WROTE', out, 'bytes', Buffer.byteLength(html));
  console.log('rows', items.length, 'techItems', (tv.items || []).length, 'rtHtmlLen', rtHtml.length);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
