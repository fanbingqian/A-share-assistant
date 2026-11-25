/* ==========================================================================
 * review-render.js — 盘后复盘专家团「结构化 + 美观」渲染（零依赖 UMD）
 *
 * 为什么独立成模块：
 *   1) 浏览器（v2.js）与静态预览脚本（scripts/*.js）共用同一套渲染，
 *      避免两处逻辑漂移，预览页 = 真实页面效果；
 *   2) 纯函数：输入 /api/v2/daily/review-team 的响应，输出 HTML 字符串，
 *      不碰 DOM、不碰评分、不补数据、不预测，缺数据一律写「不可得」。
 *
 * 数据来源：全部来自响应里的 facts（本地真实快照）与 text（智能体 / 程序叙述）。
 * 视图：默认「结构化」（四角色事实卡 + 专家叙述分段），可切「原文」对照。
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReviewRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 基础工具（全部只读，不臆造数值） ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
  const has = v => num(v) != null;
  const arr = a => Array.isArray(a) ? a : [];
  const cls = v => { const n = num(v); return n == null ? 'flat' : (n > 0 ? 'up' : n < 0 ? 'down' : 'flat'); };
  const pct = v => { const n = num(v); return n == null ? '--' : (n > 0 ? '+' : '') + n.toFixed(2) + '%'; };
  const NA = '<span class="rt2-na">不可得</span>';
  const txt = (v, suffix) => has(v) ? esc(v) + (suffix || '') : NA;

  const NONE = '<span class="rt2-none">无</span>';
  function chips(list, kind, max) {
    const a = arr(list).map(v => String(v == null ? '' : v).trim()).filter(Boolean);
    if (!a.length) return NONE;
    const lim = max || 4;
    return a.slice(0, lim).map(t => '<span class="rt2-chip ' + kind + '">' + esc(t) + '</span>').join('') +
      (a.length > lim ? '<span class="rt2-chip more">+' + (a.length - lim) + '</span>' : '');
  }
  function empty(t) { return '<div class="rt2-empty">' + esc(t) + '</div>'; }

  /* 零轴居中的双向占比条：正值向右红、负值向左绿（A 股习惯） */
  function barRow(name, v, max) {
    const n = num(v), m = Math.max(1, num(max) || 1);
    const w = n == null ? 0 : Math.min(50, Math.abs(n) / m * 50);
    const side = (n == null || n >= 0) ? 'pos' : 'neg';
    return '<div class="rt2-bar">' +
      '<div class="rt2-bar-t"><span>' + esc(name) + '</span><b class="' + cls(n) + '">' + pct(n) + '</b></div>' +
      '<div class="rt2-bar-track"><span class="rt2-bar-mid"></span>' +
      (n == null ? '' : '<i class="' + side + '" style="width:' + w.toFixed(1) + '%"></i>') +
      '</div></div>';
  }
  const barsBlock = (title, rows, max) => rows.length
    ? '<div class="rt2-sub">' + esc(title) + '</div>' + rows.map(x => barRow(x.name, x.chg1 != null ? x.chg1 : x.pct1, max)).join('')
    : '';

  /* ---------- 叙述文本 → 按角色分段（容错，任何格式都不丢内容） ---------- */
  const ROLE_OF = t => /技术面/.test(t) ? 'tech'
    : /资金面/.test(t) ? 'capital'
      : /消息面/.test(t) ? 'news'
        : /风控/.test(t) ? 'risk'
          : /数据缺口|证伪|缺口/.test(t) ? 'gap'
            : /复盘时点|范围|概览/.test(t) ? 'overview' : 'other';
  function isHead(line) {
    const t = String(line || '').trim();
    if (!t || t.startsWith('- ') || t.startsWith('•') || /^\d+[.、)]/.test(t) || t.length > 48) return false;
    if (/^■|^◆|^●|^#|^[一二三四五六][、.]/.test(t)) return true;
    return /技术面|资金面|消息面|风控|数据缺口|证伪条件/.test(t);
  }
  function parseNarrative(text) {
    const lines = String(text || '').split('\n');
    const out = []; let cur = null;
    const ensure = () => { if (!cur) { cur = { key: 'overview', title: '复盘概述', lines: [] }; out.push(cur); } return cur; };
    lines.forEach(raw => {
      const line = String(raw || '').replace(/\s+$/, '');
      if (!line.trim()) return;
      /* 【角色】正文同行：角色段单独成段；【复盘时点】等元信息归入概述内容，不吞掉正文 */
      const m = line.match(/^[■◆●\s]*【([^】]+)】\s*(.*)$/);
      if (m) {
        if (/技术面|资金面|消息面|风控|数据缺口|证伪/.test(m[1])) {
          cur = { key: ROLE_OF(m[1]), title: m[1].trim(), lines: m[2].trim() ? [m[2].trim()] : [] };
          out.push(cur);
        } else ensure().lines.push(line);
        return;
      }
      if (isHead(line)) {
        cur = { key: ROLE_OF(line), title: line.replace(/^[■◆●#\s]+/, '').trim(), lines: [] };
        out.push(cur);
      } else ensure().lines.push(line);
    });
    return out;
  }
  const NARR_META = {
    tech: ['01', 'tech'], capital: ['02', 'capital'], news: ['03', 'news'],
    risk: ['04', 'risk'], gap: ['05', 'gap'], overview: ['·', 'overview'], other: ['·', 'overview']
  };
  function narrativeHtml(r) {
    const segs = arr(r.narrative).length ? r.narrative : parseNarrative(r.text || r.factsText || '');
    if (!segs.length) return empty('无叙述文本');
    const source = (r.ai && r.ai.ok)
      ? '智能体叙述 · ' + esc((r.ai.model || r.ai.backend || 'hermes'))
      : (r.aiSkipped ? '程序事实叙述 · 按请求跳过智能体' : (r.degraded ? '程序事实叙述 · 智能体不可用已降级' : '程序事实叙述'));
    let h = '<div class="rt2-narr-src">' + source + ' <span class="note">只叙述已发生事实，不预判涨跌</span></div>';
    h += '<div class="rt2-narr-grid">' + segs.map(s => {
      const meta = NARR_META[s.key] || NARR_META.other;
      const lines = arr(s.lines).map(l => {
        const t = String(l || '');
        if (t.trim().startsWith('- ')) return '<div class="rt2-nl"><span class="rt2-dot">•</span><span>' + esc(t.trim().slice(2)) + '</span></div>';
        return '<div class="rt2-nl">' + esc(t) + '</div>';
      }).join('');
      return '<div class="rt2-narr ' + meta[1] + '">' +
        '<div class="rt2-narr-h"><span class="rt2-narr-i">' + meta[0] + '</span><b>' + esc(s.title || '叙述') + '</b></div>' +
        '<div class="rt2-narr-b">' + (lines || '<div class="rt2-nl rt2-none">（本段无内容）</div>') + '</div></div>';
    }).join('') + '</div>';
    return h;
  }

  /* ---------- 四角色事实卡 ---------- */
  function card(tone, idx, name, sub, cnt, body) {
    return '<section class="rt2-card ' + tone + '">' +
      '<div class="rt2-card-top"></div>' +
      '<div class="rt2-ch"><span class="rt2-idx">' + idx + '</span>' +
      '<span class="rt2-cname">' + esc(name) + '</span>' +
      '<span class="rt2-csub">' + esc(sub) + '</span>' +
      '<span class="rt2-cnt">' + esc(cnt) + '</span></div>' +
      '<div class="rt2-cb">' + body + '</div></section>';
  }

  function stockRow(x) {
    const kdj = x.kdj && x.kdj.value ? x.kdj.value : null;
    const cross = kdj ? kdj.cross : null;
    const kdjTag = cross === 'gold' ? '<span class="rt2-tag bull">KDJ 金叉</span>'
      : cross === 'dead' ? '<span class="rt2-tag bear">KDJ 死叉</span>'
        : '<span class="rt2-tag">KDJ 无交叉</span>';
    const stateTag = x.state === '已算' ? '' : '<span class="rt2-tag warn">' + esc(x.state) + '</span>';
    return '<div class="rt2-stock">' +
      '<div class="rt2-score">' + esc(has(x.score) ? x.score : '--') + '<small>评分</small></div>' +
      '<div class="rt2-stock-b">' +
      '<div class="rt2-stock-l1"><b>' + (esc(x.name) || esc(x.code)) + '</b>' +
      '<span class="rt2-code">' + esc(x.code) + '</span>' +
      (x.industry ? '<span class="rt2-ind">' + esc(x.industry) + '</span>' : '') +
      (x.from ? '<span class="rt2-from">' + esc(x.from) + '</span>' : '') + '</div>' +
      '<div class="rt2-stock-l2">' + kdjTag + stateTag +
      '<span class="rt2-kv-i">收盘 <b>' + txt(x.lastClose) + '</b></span>' +
      '<span class="rt2-kv-i">当日 <b class="' + cls(x.lastPct) + '">' + pct(x.lastPct) + '</b></span>' +
      (has(x.bars) ? '<span class="rt2-kv-i">日线 <b>' + esc(x.bars) + '</b> 根</span>' : '') + '</div>' +
      '<div class="rt2-chip-l"><span class="rt2-chip-k">因子</span>' + chips(x.hits, 'factor') + '</div>' +
      '<div class="rt2-chip-l"><span class="rt2-chip-k">形态</span>' + chips(x.patHits, 'pat') + '</div>' +
      '</div></div>';
  }
  function techCard(f) {
    const rows = arr(f.technical);
    const ok = rows.filter(x => x.state === '已算').length;
    let body;
    if (!rows.length) body = empty('暂无可复核标的');
    else {
      const head = rows.slice(0, 5).map(stockRow).join('');
      const rest = rows.length > 5
        ? '<details class="rt2-more"><summary>展开其余 ' + (rows.length - 5) + ' 只（共 ' + rows.length + ' 只）</summary>' +
          '<div class="rt2-more-b">' + rows.slice(5).map(stockRow).join('') + '</div></details>' : '';
      body = '<div class="rt2-stocks">' + head + '</div>' + rest;
    }
    return card('tech', '01', '技术面', '确定性因子与形态命中 · 逐只可复算', ok + '/' + rows.length + ' 只已算', body);
  }

  function capitalCard(f) {
    const c = f.capital || {};
    const kpi = (k, v, sub) => '<div class="rt2-mini"><span class="rt2-mini-k">' + esc(k) + '</span>' +
      '<span class="rt2-mini-v">' + v + '</span><span class="rt2-mini-s">' + esc(sub || '') + '</span></div>';
    let body = '<div class="rt2-minis">' +
      kpi('两市成交额', has(c.amountYi) ? esc(c.amountYi) + '<small> 亿</small>' : NA, '快照字段') +
      kpi('量比 20', txt(c.volRatio20), '较 20 日均量') +
      kpi('上涨占比', has(c.upRatio) ? esc(c.upRatio) + '<small>%</small>' : NA, '全市场宽度') +
      '</div>';
    if (c.conclusion) body += '<div class="rt2-quote"><span class="rt2-quote-k">量能结论（快照原文）</span>' + esc(c.conclusion) + '</div>';

    const bks = arr(c.buckets);
    const maxB = Math.max(1, ...bks.map(b => Math.abs(num(b.pct1) || 0)));
    body += barsBlock('市值分层 · 当日涨跌', bks.map(b => ({ name: b.name, chg1: b.pct1 })), maxB);
    const top = arr(c.boardTop), bottom = arr(c.boardBottom);
    const maxT = Math.max(1, ...top.map(b => Math.abs(num(b.chg1) || 0)));
    const maxD = Math.max(1, ...bottom.map(b => Math.abs(num(b.chg1) || 0)));
    body += barsBlock('领涨板块 Top ' + top.length, top, maxT);
    body += barsBlock('靠后板块 Bottom ' + bottom.length, bottom, maxD);

    const bl = c.leadership || {};
    if (bl.ok) body += '<div class="rt2-note"><b>板块带动</b>：指数当日 <span class="' + cls(bl.indexPct) + '">' + pct(bl.indexPct) +
      '</span> · ' + esc(bl.boardCount) + ' 个板块 · 贡献居前 ' +
      arr(bl.driving).slice(0, 3).map(b => esc(b.name) + ' ' + pct(b.chg1)).join('、') + '</div>';
    const bb = c.barbell || {};
    if (bb.ok) {
      const g = bb.global || {};
      body += '<div class="rt2-note"><b>哑铃特征</b>：' + (bb.isBarbell == null ? '不可得' : (bb.isBarbell ? '命中' : '未命中')) +
        ' · 两端−中间当日 ' + (bb.spread1 == null ? '不可得' : esc(bb.spread1) + 'pct') +
        ' · 全球倾向 ' + esc(g.tilt || 'unknown') + (g.note ? '（' + esc(g.note) + '）' : '') + '</div>';
    }
    return card('capital', '02', '资金面', '两市量能 · 市值分层 · 板块贡献', bks.length + ' 层 / ' + (top.length + bottom.length) + ' 板块', body);
  }

  function newsRow(n) {
    return '<div class="rt2-news"><span class="rt2-news-t">' + esc(n.time || '时点未注明') + '</span>' +
      '<div class="rt2-news-b"><div class="rt2-news-ti">' + esc(n.title) + '</div>' +
      '<div class="rt2-news-m"><span class="rt2-src">' + esc(n.source || '来源未注明') + '</span>' +
      (has(n.sentiment) ? '<span class="rt2-tag ' + cls(n.sentiment) + '">情感 ' + esc(n.sentiment) + ' ' + esc(n.label || '') + '</span>'
        : '<span class="rt2-none">情感未标注</span>') + '</div></div></div>';
  }
  function newsCard(f) {
    const m = f.message || {}, news = arr(m.news);
    let body = '';
    const se = m.sentiment || {}, me = se.moneyEffect || {}, bh = se.boardHeight || {}, br = se.breakRate || {};
    const mini = (k, v, s, tone) => '<div class="rt2-mini ' + tone + '"><span class="rt2-mini-k">' + esc(k) + '</span>' +
      '<span class="rt2-mini-v">' + v + '</span><span class="rt2-mini-s">' + esc(s || '') + '</span></div>';
    body += '<div class="rt2-minis">' +
      mini('赚钱效应', me.ok ? '<span class="' + cls(me.avgRet) + '">' + pct(me.avgRet) + '</span>' : NA,
        me.ok ? '样本 ' + esc(me.sample) + ' 只 · 上涨占比 ' + esc(me.upRatio) + '%' : '样本不足', '') +
      mini('连板高度', bh.maxBoards != null ? esc(bh.maxBoards) + '<small> 板</small>' : NA,
        esc(bh.ladderText || bh.heightLevel || ''), '') +
      mini('炸板率', br.rate != null ? '<span class="warn">' + esc(br.rate) + '<small>%</small></span>' : NA,
        esc(br.level || '') + ' · 炸板 ' + esc(br.zbCount) + ' / 涨停 ' + esc(br.ztCount), 'warn') +
      '</div>';

    if (!news.length) body += empty('当下新闻快照不可得');
    else {
      body += '<div class="rt2-sub">当下真实新闻 · ' + news.length + ' 条</div>';
      body += '<div class="rt2-news-l">' + news.slice(0, 5).map(newsRow).join('') + '</div>';
      if (news.length > 5) body += '<details class="rt2-more"><summary>展开其余 ' + (news.length - 5) + ' 条新闻</summary>' +
        '<div class="rt2-more-b">' + news.slice(5).map(newsRow).join('') + '</div></details>';
    }
    const ex = m.experience || {};
    if (ex.ok) body += '<div class="rt2-note"><b>经验事实核对</b>：' + esc(ex.userClaim) + ' → <b>' + esc(ex.claimStatus) + '</b>' +
      '；当日领涨 ' + arr(ex.topBoards).slice(0, 3).map(b => esc(b.name) + ' ' + pct(b.chg1)).join('、') + '</div>';
    const by = m.buyback || {};
    if (by.count != null) body += '<div class="rt2-note"><b>回购公告</b>：' + esc(by.count) + ' 条 · 重点标注 ' +
      esc(by.highlighted) + ' 条 · 标题未含价格 ' + esc(by.missingPrice) + ' 条（需公告正文）</div>';
    return card('news', '03', '消息面', '当下真实新闻 · 情绪 · 经验核对', news.length + ' 条新闻', body);
  }

  function riskCard(f) {
    const r = f.risk || {}, gaps = arr(f.dataGaps);
    const kv = (k, v, tone) => '<div class="rt2-kv"><span>' + esc(k) + '</span><b class="' + (tone || '') + '">' + v + '</b></div>';
    let body = '<div class="rt2-kvs">' +
      kv('双池重叠', esc(arr(r.conflicts).length) + ' 只', arr(r.conflicts).length ? 'warn' : '') +
      kv('破 MA5 / 趋势结束', esc(arr(r.breakMa5).length) + ' 只', arr(r.breakMa5).length ? 'warn' : '') +
      kv('全市场宽度快照', r.breadthStale ? '非当日（抗压判据仅供参考）' : '当日', r.breadthStale ? 'warn' : '') +
      kv('已买入持仓', esc(r.holdingsCount == null ? 0 : r.holdingsCount) + ' 只', '') +
      kv('回购重点标注', esc(arr(r.buybackHighlighted).length) + ' 条', '') +
      '</div>';
    body += '<div class="rt2-sub">数据缺口与口径</div>';
    body += gaps.length ? '<div class="rt2-gaps">' + gaps.map(g => '<span class="rt2-chip gap">' + esc(g) + '</span>').join('') + '</div>'
      : '<div class="rt2-none">无（各快照均可得）</div>';
    if (r.note) body += '<div class="rt2-note">' + esc(r.note) + '</div>';
    return card('risk', '04', '风控', '只列已发生标注与数据缺口', arr(r.conflicts).length + ' 处重叠', body);
  }

  /* ---------- 主渲染 ---------- */
  function render(r) {
    r = r || {};
    const f = r.facts || {}, scope = f.scope || {};
    const focus = arr(scope.focus), tech = arr(f.technical), news = arr((f.message || {}).news);
    const okTech = tech.filter(x => x.state === '已算').length;

    let badge = '程序事实', badgeCls = 'info';
    if (r.aiSkipped) { badge = '仅程序事实 · 按请求跳过智能体'; badgeCls = 'info'; }
    else if (r.degraded) { badge = '智能体不可用 · 已降级为纯程序事实'; badgeCls = 'warn'; }
    else if (r.ai && r.ai.ok) { badge = '智能体 ' + (r.ai.model || r.ai.backend || 'hermes') + ' · 已生成叙述'; badgeCls = 'ok'; }

    let h = '<div class="rt2-root" data-rt-root>';

    /* 头部 */
    h += '<div class="rt2-head"><div class="rt2-head-l">' +
      '<div class="rt2-title">盘后复盘专家团 <span class="rt2-sub">智能体不参与预判 · 只叙述已发生事实</span></div>' +
      '<div class="rt2-meta">' +
      '<span>复盘时点 <b>' + esc(r.at || '--') + '</b></span>' +
      '<span>数据交易日 <b>' + esc(r.tradingDate || '--') + '</b></span>' +
      '<span>模式 <b>' + esc(r.mode || '盘后复盘专家团') + '</b></span>' +
      '<span class="rt2-badge ' + badgeCls + '">' + esc(badge) + '</span>' +
      '</div></div>' +
      '<div class="rt2-views"><button type="button" class="rt2-view active" data-rt-view="struct">结构化</button>' +
      '<button type="button" class="rt2-view" data-rt-view="raw">原文</button></div></div>';

    /* 概览 KPI */
    const kpi = (k, v, u, s) => '<div class="rt2-kpi"><span class="rt2-kpi-k">' + esc(k) + '</span>' +
      '<span class="rt2-kpi-v">' + esc(v) + '<small>' + esc(u) + '</small></span>' +
      '<span class="rt2-kpi-s">' + esc(s) + '</span></div>';
    h += '<div class="rt2-kpis">' +
      kpi('当日重点关注', focus.length, '只', '选股 / 预测池 / 我的选股') +
      kpi('已买入持仓', arr(scope.holdings).length, '只', '来自持仓快照') +
      kpi('当下真实新闻', news.length, '条', '实时复盘结合项') +
      kpi('技术标注已算', okTech + '/' + tech.length, '只', '真实前复权日线逐条计算') +
      '</div>';

    /* 结构化视图：四角色事实卡 + 分段叙述；切「原文」时整体隐藏，只留完整原文 */
    h += '<div data-rt-struct class="rt2-struct">';
    h += '<div class="rt2-sec-t"><span class="rt2-sec-dot"></span>四角色事实卡' +
      '<span class="note">全部取自本地真实快照 · 只读 · 不改任何评分与选股结果</span></div>';
    h += '<div class="rt2-grid">' + techCard(f) + capitalCard(f) + newsCard(f) + riskCard(f) + '</div>';

    h += '<div class="rt2-sec-t"><span class="rt2-sec-dot"></span>专家叙述' +
      '<span class="note">按技术面 / 资金面 / 消息面 / 风控分段 · 可切「原文」逐字对照</span></div>';
    h += narrativeHtml(r);
    h += '</div>';
    h += '<div data-rt-raw class="rt2-raw" hidden><pre>' + esc(r.text || r.factsText || '') + '</pre></div>';

    /* 底部：免责 + 可追溯 */
    const disc = arr(r.disclaimer);
    h += '<div class="rt2-foot">' +
      (disc.length ? '<details class="rt2-det"><summary>口径与免责（' + disc.length + ' 条）</summary><ol>' +
        disc.map(d => '<li>' + esc(d) + '</li>').join('') + '</ol></details>' : '') +
      '<details class="rt2-det"><summary>提示词 / 事实原文（可追溯）</summary><div class="rt2-det-b">' +
      '<div class="rt2-sub">注入提示词</div><pre>' + esc(r.prompt || '') + '</pre>' +
      '<div class="rt2-sub">程序事实原文</div><pre>' + esc(r.factsText || '') + '</pre>' +
      '</div></details></div>';

    h += '</div>';
    return h;
  }

  return { render, parseNarrative };
});
