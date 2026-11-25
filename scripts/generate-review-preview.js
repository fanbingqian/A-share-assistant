/* 生成「盘后复盘专家团 · 结构化渲染」独立静态预览页。
 * 数据来自本机 8777 真实接口（noAI:true，仅程序事实，不编造）；
 * 服务不可用时回退到最近一次抓取的本地样本，保证预览可离线查看。
 * 渲染逻辑直接复用 web/v2/review-render.js，预览 = 真实页面效果。 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const RR = require(path.join(ROOT, 'web', 'v2', 'review-render.js'));
const B = 'http://127.0.0.1:8777';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

(async () => {
  let r = null, source = '实时接口';
  try {
    const resp = await fetch(B + '/api/v2/daily/review-team', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ noAI: true }), signal: AbortSignal.timeout(20000)
    });
    r = await resp.json();
    if (!r || !r.ok) throw new Error('接口未返回 ok');
  } catch (e) {
    try {
      r = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tmp', 'review-sample.json'), 'utf8'));
      source = '本地缓存样本（接口不可用：' + e.message + '）';
    } catch (_) { throw new Error('接口与本地样本均不可用：' + e.message); }
  }

  const css = fs.readFileSync(path.join(ROOT, 'web', 'v2', 'v2.css'), 'utf8');
  const body = RR.render(r);
  const f = r.facts || {};
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>盘后复盘专家团 · 结构化渲染预览（真实数据）</title>
<style>${css}
.pv-wrap{max-width:1240px;margin:0 auto;padding:22px 20px 60px}
.pv-head{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px;margin-bottom:16px;box-shadow:var(--shadow)}
.pv-head h1{font-size:19px;margin-bottom:7px}
.pv-head .pv-meta{color:var(--ink2);font-size:12.5px;line-height:1.95}
.pv-badge{display:inline-block;padding:2px 8px;border-radius:5px;background:var(--brand-soft);color:var(--brand);font-size:11.5px;font-weight:600;margin-left:8px}
.pv-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;margin-bottom:16px;box-shadow:var(--shadow)}
.pv-foot{color:var(--ink3);font-size:12px;line-height:1.9;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px 18px}
</style></head><body>
<div class="pv-wrap">
  <div class="pv-head">
    <h1>盘后复盘专家团 · 结构化渲染预览 <span class="pv-badge">真实接口数据</span></h1>
    <div class="pv-meta">
      数据来源：<b>${esc(source)}</b> · 复盘时点 ${esc(r.at || '--')} · 数据交易日 ${esc(r.tradingDate || '--')}<br>
      叙述来源：<b>${esc(r.narrativeSource || 'program')}</b> · 分段数 ${(r.narrative || []).length} ·
      ${r.aiSkipped ? '仅程序事实（按请求跳过智能体）' : (r.degraded ? '智能体不可用 · 已降级为纯程序事实' : '智能体已调用')}<br>
      重点关注 ${((f.scope || {}).focus || []).length} 只 · 持仓 ${((f.scope || {}).holdings || []).length} 只 ·
      当下新闻 ${((f.message || {}).news || []).length} 条 · 四角色事实卡与占比条全部取自本地真实快照，未做任何填充或编造。
    </div>
  </div>
  <div class="pv-card">${body}</div>
  <div class="pv-foot">
    <b>使用说明：</b>右上角可切换「结构化 / 原文」；股票条、新闻列表可点「展开其余…」；
    底部「口径与免责」「提示词 / 事实原文」可折叠查看逐字追溯内容。
    本页只叙述已发生事实与可复核标注，不预测涨跌、不给买卖建议、不修改任何评分。<br>
    实际交互页面：<b>http://127.0.0.1:8777</b> · 每日行情 → 盘后复盘专家团 → 生成复盘 / 仅程序事实。
  </div>
</div>
<script>
(function(){
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
})();
</script></body></html>`;

  const out = path.join(ROOT, 'preview', 'review-team-preview.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log('WROTE', out, 'bytes', Buffer.byteLength(html));
  console.log('source', source, 'narrative', (r.narrative || []).length, 'htmlLen', body.length);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
