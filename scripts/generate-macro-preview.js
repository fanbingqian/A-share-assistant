/* 生成「官方指数发布事件 · 机构预期 / 跨资产 / 多数方向」静态预览页。
 * 数据：data/macro-expectations.json（可追溯快照）+ 项目真实新闻池样本；
 * 渲染：web/v2/macro-render.js（与真实页面共用，UMD 零依赖）。
 * 展示两种形态：FOMC 形成明确多数 → 给方向建议；CPI / PMI 机构分歧 → 不给单向建议。 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const macroOutlook = require(path.join(ROOT, 'server', 'macro-outlook.js'));
const MacroRender = require(path.join(ROOT, 'web', 'v2', 'macro-render.js'));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 三条演示标题均来自 2026-11-25 检索到的真实媒体报道（见快照来源），不是编造事件 */
const DEMOS = [
  {
    tag: '① 形成明确多数 → 给方向建议',
    item: {
      title: 'CME数据显示美联储12月加息25个基点概率达97.4%',
      desc: '据CME「美联储观察」最新数据，市场预计美联储12月议息会议加息25个基点的概率为97.4%，降息或维持不变的可能性极低。',
      source: '中国基金报', time: '2026-11-25'
    }
  },
  {
    tag: '② 机构分歧 → 不给单向建议',
    item: {
      title: '美国10月CPI环比上涨0.4% 核心CPI连续三个月0.3%',
      desc: '美国劳工统计局公布的10月CPI环比高于市场预期，核心CPI环比连续三个月维持0.3%。',
      source: '新华财经 / 中国金融信息网', time: '2026-11-19'
    }
  },
  {
    tag: '③ 机构分歧 → 不给单向建议',
    item: {
      title: '10月制造业PMI降至49.3% 业内预计11月重回扩张',
      desc: '国家统计局数据显示10月制造业采购经理指数为49.3%，落入收缩区间；机构对11月读数分歧明显。',
      source: '财经媒体转述（需核实原文）', time: '2026-11-25'
    }
  }
];

(() => {
  let newsPool = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tmp', 'news-flash-sample.json'), 'utf8'));
    newsPool = Array.isArray(j.feed) ? j.feed : [];
  } catch (_) {}
  const css = fs.readFileSync(path.join(ROOT, 'web', 'v2', 'v2.css'), 'utf8');
  const blocks = DEMOS.map(d => {
    const m = macroOutlook.build(d.item, { newsPool });
    return {
      tag: d.tag, item: d.item, macro: m,
      html: MacroRender.render(m)
    };
  });

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>官方指数发布 · 机构预期与跨资产增强（结构化预览）</title>
<style>${css}
.pv-wrap{max-width:1240px;margin:0 auto;padding:22px 20px 60px}
.pv-head{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:18px 20px;margin-bottom:16px;box-shadow:var(--shadow)}
.pv-head h1{font-size:19px;margin-bottom:8px}
.pv-head .pv-meta{color:var(--ink2);font-size:12.5px;line-height:1.95}
.pv-badge{display:inline-block;padding:2px 8px;border-radius:5px;background:var(--brand-soft);color:var(--brand);font-size:11.5px;font-weight:600;margin-left:8px}
.pv-sec{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;margin-bottom:16px;box-shadow:var(--shadow)}
.pv-sec > h2{font-size:15px;margin-bottom:6px}
.pv-sec > .pv-sub{color:var(--ink3);font-size:12px;margin-bottom:10px;line-height:1.8}
.pv-foot{color:var(--ink3);font-size:12px;line-height:1.9;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px 18px}
</style></head><body>
<div class="pv-wrap">
  <div class="pv-head">
    <h1>官方指数发布 · 机构预期与跨资产增强 <span class="pv-badge">结构化预览 · 真实可追溯数据</span></h1>
    <div class="pv-meta">
      机构预测快照：<b>2026-11-25</b> · 来源为 domain_search 多源检索（新华财经 / 中国金融信息网、格隆汇转述高盛与摩根士丹利报告、Yahoo 财经转述野村报告、Continuum Economics、CME FedWatch、中国基金报、汇通网、贝莱德、济安金信、国家统计局等），逐条带来源与日期，媒体转述均标「需核实原文」。<br>
      实时新闻池补抽：项目 8777 真实接口快照 ${newsPool.length} 条；演示标题取自同期真实媒体报道，不是编造事件。<br>
      三种形态：① 12 条观点中 11 条偏谨慎 → <b>形成多数并给方向性参考</b>；② 2:2:1 分歧、③ 2:2 分歧 → <b>如实不给单向建议</b>。
    </div>
  </div>
  ${blocks.map((b, i) => `<div class="pv-sec">
    <h2>${esc(b.tag)}</h2>
    <div class="pv-sub">触发新闻：<b>${esc(b.item.title)}</b> · ${esc(b.item.source)} · ${esc(b.item.time)}<br>
      识别事件：${esc(b.macro.event ? b.macro.event.name : '未识别')} · 机构观点 ${b.macro.views.length} 条 · 多数方向：${esc(b.macro.consensus.label)}</div>
    ${b.html}
  </div>`).join('')}
  <div class="pv-foot">
    <b>口径说明：</b>机构与专家预测全部来自可追溯快照与项目实时新闻池，程序不生成、不推算、不补全任何预测数字；跨资产传导链为条件性分析框架，不是事实、不是涨跌预测；方向性参考只在机构观点形成明确多数时给出，附失效条件、反向声音与固定免责声明，不是买卖指令。<br>
    实际交互页面：<b>http://127.0.0.1:8777</b> → 新闻快讯 → 对官方指数发布类新闻点「智能体解读」，或点「今日整体解读」；智能体不可用时程序结构化事实仍会显示。
  </div>
</div></body></html>`;

  const out = path.join(ROOT, 'preview', 'macro-outlook-preview.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log('WROTE', out, 'bytes', Buffer.byteLength(html));
  blocks.forEach((b, i) => console.log('block' + (i + 1),
    b.macro.event && b.macro.event.id, 'views', b.macro.views.length,
    'majority', b.macro.consensus.majority, 'advice', b.macro.advice.hasMajority,
    'htmlLen', b.html.length));
})();
