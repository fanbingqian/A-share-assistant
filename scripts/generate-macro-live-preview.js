/* 用真实接口响应（POST /api/v2/news-flash/interpret）生成「实际解读结果」静态预览。
 * 结构化卡片 = web/v2/macro-render.js；智能体文本 = web/v2/markdown-lite.js（vm 加载，复用真实渲染）。
 * 输入：data/tmp/interpret-macro2.json（真实接口、真实模型输出，未改写）。 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const MacroRender = require(path.join(ROOT, 'web', 'v2', 'macro-render.js'));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tmp', 'interpret-macro2.json'), 'utf8'));
const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'web', 'v2', 'markdown-lite.js'), 'utf8'), ctx);
const md = ctx.window.MarkdownLite && ctx.window.MarkdownLite.render
  ? ctx.window.MarkdownLite.render(String(r.text || ''))
  : '<pre>' + esc(r.text || '') + '</pre>';
const macroHtml = r.macro ? MacroRender.render(r.macro) : '';
const css = fs.readFileSync(path.join(ROOT, 'web', 'v2', 'v2.css'), 'utf8');

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>官方指数发布 · 真实智能体解读结果（结构化预览）</title>
<style>${css}
.pv-wrap{max-width:1120px;margin:0 auto;padding:22px 20px 60px}
.pv-head{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px;margin-bottom:16px;box-shadow:var(--shadow)}
.pv-head h1{font-size:19px;margin-bottom:7px}
.pv-head .pv-meta{color:var(--ink2);font-size:12.5px;line-height:1.95}
.pv-badge{display:inline-block;padding:2px 8px;border-radius:5px;background:var(--brand-soft);color:var(--brand);font-size:11.5px;font-weight:600;margin-left:8px}
.pv-sec{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;margin-bottom:16px;box-shadow:var(--shadow)}
.pv-sec > h2{font-size:15px;margin-bottom:8px}
.pv-sec > .pv-sub{color:var(--ink3);font-size:12px;margin-bottom:10px;line-height:1.8}
.pv-agent{font-size:12.5px;line-height:1.85;color:var(--ink2);overflow-wrap:anywhere;word-break:break-word}
.pv-agent h2{font-size:14px;color:var(--ink);margin:18px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line2)}
.pv-agent h3,.pv-agent h4{font-size:13px;color:var(--ink);margin:14px 0 6px}
.pv-agent ul,.pv-agent ol{margin:6px 0 10px 20px}
.pv-agent li{margin:4px 0}
.pv-agent strong{color:var(--ink)}
.pv-agent code{background:var(--bg);border:1px solid var(--line2);border-radius:4px;padding:1px 5px;font-size:11.5px}
.pv-foot{color:var(--ink3);font-size:12px;line-height:1.9;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px 18px}
</style></head><body>
<div class="pv-wrap">
  <div class="pv-head">
    <h1>官方指数发布新闻 · 真实智能体解读结果 <span class="pv-badge">真实接口 · 真实模型输出</span></h1>
    <div class="pv-meta">
      触发新闻：<b>${esc(r.itemTitle || '')}</b> · 接口 <code>/api/v2/news-flash/interpret</code><br>
      模型后端 <b>${esc(r.backend || '')}</b> · 提示词版本 <b>${esc(r.promptVersion || '')}</b> · 文本 ${String(r.text || '').length} 字 ·
      程序事实快照 ${esc(r.macro && r.macro.snapshot && r.macro.snapshot.at || '--')} · 机构观点 ${(r.macro && r.macro.views || []).length} 条<br>
      本页上半部分为程序结构化事实（智能体不可用时仍恒显示），下半部分为智能体按七段骨架生成的叙述，两者来自同一次真实响应。
    </div>
  </div>
  <div class="pv-sec">
    <h2>① 程序结构化事实：机构预期 / 跨资产 / 多数方向</h2>
    <div class="pv-sub">不依赖模型输出；每条机构观点带来源、日期与「需核实原文」标记；方向建议带失效条件、反向声音与固定免责声明。</div>
    ${macroHtml}
  </div>
  <div class="pv-sec">
    <h2>② 智能体解读文本（七段骨架）</h2>
    <div class="pv-sub">由真实模型生成，逐字引用注入快照；第「七、多数预测方向建议」段为本次新增，免责声明完整位于文末。</div>
    <div class="pv-agent md-body">${md}</div>
  </div>
  <div class="pv-foot">
    口径说明：机构预测来自 2026-11-25 可追溯检索快照与项目实时新闻池，程序不生成预测数字；跨资产传导链为条件性分析框架，不是涨跌预测；方向性参考只在机构观点形成明确多数时给出，不是买卖指令。<br>
    实际交互：<b>http://127.0.0.1:8777</b> → 新闻快讯 → 对官方指数发布类新闻点「智能体解读」。
  </div>
</div></body></html>`;

const out = path.join(ROOT, 'preview', 'macro-interpret-live.html');
fs.writeFileSync(out, html, 'utf8');
console.log('WROTE', out, 'bytes', Buffer.byteLength(html));
console.log('macroHtml', macroHtml.length, 'mdHtml', md.length, 'headings', (String(r.text || '').match(/^##\s/gm) || []).length);
