/* ==========================================================================
 * macro-render.js — 官方指数发布事件「机构预期 / 跨资产 / 多数方向」结构化渲染
 *
 * 零依赖 UMD：浏览器（v2.js）与静态预览脚本共用同一套渲染。
 * 输入 server/macro-outlook.js 的 build() 结果；只读、不改数据、不补内容。
 * 所有机构观点带来源 / 时点 / 需核实标记；方向建议带失效条件与固定免责声明。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MacroRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const arr = a => Array.isArray(a) ? a : [];
  const DIR = {
    positive: { label: '偏正面', cls: 'pos' },
    negative: { label: '偏谨慎', cls: 'neg' },
    neutral: { label: '中性', cls: 'neu' }
  };
  const dirOf = d => DIR[d] || { label: '未标注', cls: 'neu' };
  const NA = '<span class="mo-na">不可得</span>';

  function factsHtml(m) {
    const f = arr(m.officialFacts);
    let h = '<div class="mo-sec-t"><span class="mo-dot"></span>已公布的官方事实' +
      '<span class="note">一手数据标「官方」，媒体转述标「需核实原文」</span></div>';
    if (!f.length) return h + '<div class="mo-empty">当前数据源未覆盖官方事实，不可得。</div>';
    h += '<div class="mo-facts">' + f.map(x =>
      '<div class="mo-fact"><div class="mo-fact-t">' + esc(x.text) + '</div>' +
      '<div class="mo-fact-m"><span class="mo-src">' + esc(x.source || '来源未注明') + '</span>' +
      '<span class="mo-date">' + esc(x.date || '时点未注明') + '</span>' +
      (x.primary ? '<span class="mo-tag official">官方一手</span>' : '<span class="mo-tag verify">需核实原文</span>') +
      (x.url ? '<a class="mo-link" href="' + esc(x.url) + '" target="_blank" rel="noopener">原文 ↗</a>' : '') +
      '</div></div>').join('') + '</div>';
    return h;
  }

  function viewsHtml(m) {
    const v = arr(m.views);
    let h = '<div class="mo-sec-t"><span class="mo-dot"></span>机构与专家预测清单' +
      '<span class="note">逐条带来源 / 时点 · 程序不生成任何预测数字</span></div>';
    if (!v.length) return h + '<div class="mo-empty">当前数据源未覆盖该事件的机构预测，' + NA + '（不编造）。</div>';
    const row = x => {
      const d = dirOf(x.direction);
      return '<div class="mo-view ' + d.cls + '">' +
        '<div class="mo-view-h"><span class="mo-dir ' + d.cls + '">' + d.label + '</span>' +
        '<b>' + esc(x.institution) + '</b><span class="mo-date">' + esc(x.date || '时点未注明') + '</span></div>' +
        '<div class="mo-view-b">' + esc(x.view) + '</div>' +
        '<div class="mo-view-f"><span class="mo-src">' + esc(x.source || '来源未注明') + '</span>' +
        (x.needsVerify ? '<span class="mo-tag verify">需核实原文</span>' : '') +
        (x.url ? '<a class="mo-link" href="' + esc(x.url) + '" target="_blank" rel="noopener">原文 ↗</a>' : '') +
        '</div></div>';
    };
    h += '<div class="mo-views">' + v.slice(0, 6).map(row).join('') + '</div>';
    if (v.length > 6) h += '<details class="mo-more"><summary>展开其余 ' + (v.length - 6) + ' 条机构观点（共 ' + v.length + ' 条）</summary>' +
      '<div class="mo-views">' + v.slice(6).map(row).join('') + '</div></details>';
    const live = arr(m.liveNewsViews);
    if (live.length) {
      h += '<details class="mo-more"><summary>项目实时新闻池补抽 ' + live.length + ' 条（未判方向，不计入多数统计）</summary>' +
        '<div class="mo-live">' + live.map(x => '<div class="mo-live-i"><b>' + esc(x.institution) + '</b>：' + esc(x.view) +
          '<span class="mo-src"> · ' + esc(x.source) + ' · ' + esc(x.date) + '</span></div>').join('') + '</div></details>';
    }
    return h;
  }

  function consensusHtml(m) {
    const c = m.consensus || {};
    const n = c.total || 0;
    const p = n ? (c.counts.positive / n * 100) : 0;
    const neu = n ? (c.counts.neutral / n * 100) : 0;
    const neg = n ? (c.counts.negative / n * 100) : 0;
    let h = '<div class="mo-sec-t"><span class="mo-dot"></span>多数方向统计' +
      '<span class="note">只统计带明确方向的快照观点；实时新闻池抽取不计入</span></div>';
    h += '<div class="mo-cons">' +
      '<div class="mo-cons-h"><b>' + esc(c.label || '不可得') + '</b>' +
      '<span class="mo-cons-n">有效 ' + n + ' 条</span></div>' +
      '<div class="mo-bar">' +
      (p ? '<i class="pos" style="width:' + p.toFixed(1) + '%"></i>' : '') +
      (neu ? '<i class="neu" style="width:' + neu.toFixed(1) + '%"></i>' : '') +
      (neg ? '<i class="neg" style="width:' + neg.toFixed(1) + '%"></i>' : '') +
      '</div>' +
      '<div class="mo-cons-l"><span class="pos">偏正面 ' + (c.counts.positive || 0) + '</span>' +
      '<span class="neu">中性 ' + (c.counts.neutral || 0) + '</span>' +
      '<span class="neg">偏谨慎 ' + (c.counts.negative || 0) + '</span></div>';
    if (m.consensusLine && m.consensusLine !== '不可得') h += '<div class="mo-cons-line">共识归纳：' + esc(m.consensusLine) + '</div>';
    h += '</div>';
    return h;
  }

  function impactsHtml(m) {
    const gs = arr(m.impacts);
    let h = '<div class="mo-sec-t"><span class="mo-dot"></span>跨资产影响分析' +
      '<span class="note">真实观点逐字引用 + 条件性传导链（分析框架，非涨跌预测）</span></div>';
    h += '<div class="mo-grid">' + gs.map(g => {
      const q = arr(g.quotes);
      return '<section class="mo-card">' +
        '<div class="mo-card-h"><span class="mo-icon">' + esc(g.icon) + '</span><b>' + esc(g.name) + '</b>' +
        '<span class="mo-cond">' + esc(g.conditionalDirection) + '</span></div>' +
        '<div class="mo-card-b">' +
        '<div class="mo-sub">条件性倾向</div><div class="mo-note">' + esc(g.directionNote) + '</div>' +
        '<div class="mo-sub">真实机构 / 媒体观点（' + q.length + ' 条）</div>' +
        q.map(x => '<div class="mo-quote"><div>' + esc(x.text) + '</div>' +
          '<div class="mo-quote-m">' + esc(x.source) + (x.date ? ' · ' + esc(x.date) : '') +
          (x.needsVerify ? ' <span class="mo-tag verify">需核实原文</span>' : '') +
          (x.url ? ' <a class="mo-link" href="' + esc(x.url) + '" target="_blank" rel="noopener">原文 ↗</a>' : '') + '</div></div>').join('') +
        '<div class="mo-sub">传导链 · 分析框架（非预测）</div>' +
        arr(g.chains).map(c => '<div class="mo-chain"><span class="mo-chain-tag">' + esc(c.tag) + '</span>' +
          esc(c.macro) + ' <span class="mo-arrow">→</span> ' + esc(c.mid) + ' <span class="mo-arrow">→</span> ' + esc(c.asset) + '</div>').join('') +
        '<details class="mo-more"><summary>失效条件（' + arr(g.invalidation).length + ' 条）</summary><ul>' +
          arr(g.invalidation).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></details>' +
        '</div></section>';
    }).join('') + '</div>';
    return h;
  }

  function adviceHtml(m) {
    const a = m.advice || {};
    let h = '<div class="mo-sec-t"><span class="mo-dot"></span>多数预测方向建议' +
      '<span class="note">只在机构观点形成明确多数时给方向 · 方向性参考，非买卖指令</span></div>';
    h += '<div class="mo-advice ' + (a.hasMajority ? 'has' : 'none') + '">' +
      '<div class="mo-advice-h"><span class="mo-advice-badge">' + (a.hasMajority ? '已形成多数' : '未形成多数') + '</span>' +
      '<b>' + esc(a.headline) + '</b></div>' +
      '<div class="mo-advice-b">' + esc(a.body) + '</div>';
    if (arr(a.basis).length) {
      h += '<div class="mo-sub">依据机构</div><div class="mo-basis">' +
        arr(a.basis).map(x => '<span class="mo-chip">' + esc(x) + '</span>').join('') + '</div>' +
        '<div class="mo-note">' + esc(a.basisNote || '') + '</div>';
    }
    if (a.consensusLine && a.consensusLine !== '不可得') h += '<div class="mo-cons-line">共识归纳：' + esc(a.consensusLine) + '</div>';
    if (arr(a.conditionalFramework).length) {
      h += '<div class="mo-sub">分歧 / 样本不足时的条件化观察框架</div><ul class="mo-ul">' +
        arr(a.conditionalFramework).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>';
    }
    h += '<div class="mo-sub">失效条件</div><ul class="mo-ul">' +
      arr(a.invalidation).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>';
    if (a.reverseVoice) h += '<div class="mo-reverse"><b>反向声音</b>：' + esc(a.reverseVoice) + '</div>';
    h += '<div class="mo-disclaimer">' + esc(a.disclaimer || m.disclaimer || '') + '</div>' +
      '</div>';
    return h;
  }

  function render(m) {
    if (!m || !m.detected) return '';
    const ev = m.event || {}, sn = m.snapshot || {};
    let h = '<div class="mo-root">';
    h += '<div class="mo-head"><div class="mo-head-l">' +
      '<div class="mo-title">官方指数发布 · 机构预期与跨资产增强 <span class="mo-badge">程序事实</span></div>' +
      '<div class="mo-meta">' +
      '<span>事件 <b>' + esc(ev.name || '--') + '</b></span>' +
      '<span>发布机构 <b>' + esc(ev.agency || '--') + '</b></span>' +
      '<span>地区 <b>' + esc(ev.jurisdiction || '--') + '</b></span>' +
      '<span>快照时点 <b>' + esc(sn.at || '不可得') + '</b>' +
      (sn.stale ? ' <span class="mo-tag stale">已过期 · 需重新检索</span>' : '') + '</span>' +
      '</div></div></div>';

    h += factsHtml(m);
    h += viewsHtml(m);
    h += consensusHtml(m);
    h += impactsHtml(m);
    h += adviceHtml(m);

    if (arr(m.dataGaps).length) {
      h += '<div class="mo-gaps"><b>数据缺口</b>：' +
        arr(m.dataGaps).map(x => '<span class="mo-chip gap">' + esc(x) + '</span>').join('') + '</div>';
    }
    h += '<div class="mo-foot">' + arr(m.notes).map(x => '<div>· ' + esc(x) + '</div>').join('') +
      '<div class="mo-foot-disc">' + esc(m.disclaimer || '') + '</div></div>';
    h += '</div>';
    return h;
  }

  return { render };
});
