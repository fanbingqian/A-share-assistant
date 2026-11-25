/* ============================================================
 * agent-ui.js — Hermes Agent 思考过程 / 工具调用时间线 / 3D 知识图谱 / 数据质量
 *
 * 参考 AI-Hel2：
 *   src/components/chat/ThinkingSection.tsx   （思考过程：流式展开、结束 1.5s 自动折叠）
 *   src/components/chat/ToolCallTimeline.tsx  （工具时间线：图标/状态/耗时/一键折叠摘要）
 *   src/components/sphere/LintPanel.tsx       （数据质量 lint 面板）
 * 3D 图谱：vasturiano/3d-force-graph（本地 vendor，WebGL/ThreeJS，中文标签 + 分组着色）
 *
 * 暴露 window.AgentUI = { sendStream, appendThinking, appendToolTimeline, KG, init }
 * ============================================================ */
(function (global) {
  'use strict';

  const $ = (s, p) => (p || document).querySelector(s);
  const $$ = (s, p) => Array.from((p || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtMs = ms => {
    if (ms == null) return '';
    const s = ms / 1000;
    if (s < 1) return (Math.round(s * 10) / 10) + 's';
    if (s < 60) return (Math.round(s * 10) / 10) + 's';
    return Math.floor(s / 60) + 'm' + Math.round(s % 60) + 's';
  };

  /* ---------------- 工具中文化 + 图标（对齐 AI-Hel2 humanToolName） ---------------- */
  const TOOL_LABEL = {
    market_snapshot: '每日行情', sector_board: '板块强度', screener_results: '四类选股',
    strategy_view: '策略视图', sentiment_board: '短线情绪', policy_news: '政策快讯',
    calendar_events: '日程与事件', my_portfolio: '我的股池', stock_analysis: '个股评分',
    knowledge_graph_query: '知识图谱检索', knowledge_graph_asof: '图谱时点回溯',
    knowledge_graph_history: '图谱更新历史', search_conversations: '历史会话检索',
    update_feed: '更新事件流', hygiene_report: '数据质量报告', future_events: '未来事件扫描',
    event_history: '事件历史统计'
  };
  const TOOL_ICON = {
    market_snapshot: '📈', sector_board: '🧭', screener_results: '🎯', strategy_view: '🧩',
    sentiment_board: '🌡️', policy_news: '📰', calendar_events: '📅', my_portfolio: '💼',
    stock_analysis: '🔍', knowledge_graph_query: '🕸️', knowledge_graph_asof: '⏱️',
    knowledge_graph_history: '📜', search_conversations: '💬', update_feed: '🔔',
    hygiene_report: '⚑', future_events: '🔭', event_history: '📊'
  };
  function toolName(n) {
    if (TOOL_LABEL[n]) return TOOL_LABEL[n];
    if (String(n).startsWith('mcp_')) return 'MCP · ' + String(n).slice(4);
    return n || '工具';
  }
  function toolIcon(n) { return String(n).startsWith('mcp_') ? '🔌' : (TOOL_ICON[n] || '🔧'); }

  /* ---------------- 可折叠区块（ThinkingSection 风格） ---------------- */

  /**
   * 创建一个可折叠区块。
   * opts: { title, live, autoCollapseMs, className, buildBody(bodyEl) }
   * 返回 { el, body, setLive, append, finish, toggle, isOpen }
   */
  function collapsible(opts = {}) {
    const el = document.createElement('div');
    el.className = 'au-fold ' + (opts.className || '');
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'au-fold-head';
    const chev = document.createElement('span'); chev.className = 'au-chev'; chev.textContent = '▸';
    const status = document.createElement('span'); status.className = 'au-status';
    const label = document.createElement('span'); label.className = 'au-label'; label.textContent = opts.title || '详情';
    const summary = document.createElement('span'); summary.className = 'au-summary';
    const dot = document.createElement('span'); dot.className = 'au-dot';
    head.append(chev, status, label, summary);
    if (opts.live) head.append(dot);
    const body = document.createElement('div'); body.className = 'au-fold-body';
    el.append(head, body);

    let userOverride = null, live = !!opts.live, hadLive = !!opts.live, timer = null;
    const render = () => {
      const open = userOverride == null ? live : userOverride;
      chev.textContent = open ? '▾' : '▸';
      el.classList.toggle('open', open);
      el.classList.toggle('live', live);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    head.addEventListener('click', () => { userOverride = !(userOverride == null ? live : userOverride); render(); });
    render();
    if (typeof opts.buildBody === 'function') opts.buildBody(body);

    return {
      el, body, head, summary, status, dot,
      isOpen: () => userOverride == null ? live : userOverride,
      setLive(v) {
        live = !!v; if (live) hadLive = true;
        if (timer) { clearTimeout(timer); timer = null; }
        render();
      },
      setSummary(t) { summary.textContent = t || ''; },
      setStatus(t) { status.textContent = t || ''; },
      append(node) { body.appendChild(node); },
      /** 完成：1.5s 后自动折叠（AI-Hel2 同款），用户若手动展开过则不干预 */
      finish(fold) {
        live = false; render();
        if (fold !== false && userOverride === null && hadLive) {
          timer = setTimeout(() => { userOverride = false; render(); }, 1500);
        }
      }
    };
  }

  /* ---------------- 思考过程 ---------------- */

  function appendThinking(container, { title = '思考过程' } = {}) {
    const fold = collapsible({ title, live: true, className: 'au-thinking' });
    const lines = document.createElement('div'); lines.className = 'au-think-lines';
    fold.append(lines);
    container.appendChild(fold.el);
    let n = 0;
    return {
      el: fold.el,
      add(text, phase) {
        n++;
        const row = document.createElement('div');
        row.className = 'au-think-line';
        row.innerHTML = '<span class="au-think-idx">' + n + '</span><span>' + esc(text) + '</span>';
        lines.appendChild(row);
        fold.setSummary(n + ' 步 · ' + (phase || '进行中'));
      },
      reasoning(text) {
        const box = document.createElement('pre');
        box.className = 'au-reasoning';
        box.textContent = String(text || '');
        lines.appendChild(box);
        fold.setSummary('模型推理内容');
      },
      finish(summary) { fold.setSummary(summary || (n + ' 步 · 已完成')); fold.finish(); }
    };
  }

  /* ---------------- 工具调用时间线（ToolCallTimeline 风格） ---------------- */

  function appendToolTimeline(container) {
    const fold = collapsible({ title: '数据工具调用', live: false, className: 'au-tools' });
    const list = document.createElement('div'); list.className = 'au-tool-list';
    fold.append(list);
    container.appendChild(fold.el);
    const calls = new Map();
    let completed = 0, total = 0, totalMs = 0;

    function summarize() {
      if (!total) return '';
      const done = [...calls.values()].filter(c => c.status === 'completed').length;
      const err = [...calls.values()].filter(c => c.status === 'error').length;
      return '✓ ' + done + '/' + total + (err ? ' · ' + err + ' 失败' : '') + ' · ' + fmtMs(totalMs);
    }
    return {
      el: fold.el,
      start(call) {
        total++;
        fold.setLive(true);
        const row = document.createElement('div');
        row.className = 'au-tool-row running';
        row.innerHTML = '<span class="au-tool-status">◌</span>' +
          '<span class="au-tool-icon">' + toolIcon(call.tool) + '</span>' +
          '<span class="au-tool-name">' + esc(toolName(call.tool)) + '</span>' +
          '<span class="au-tool-arg">' + esc(call.label || '') + '</span>' +
          '<span class="au-tool-time"></span>';
        list.appendChild(row);
        calls.set(call.callId, { row, tool: call.tool, status: 'running' });
        fold.setSummary(summarize() || '调用中…');
      },
      done(call) {
        const c = calls.get(call.callId);
        if (!c) return;
        c.status = call.status || 'completed';
        c.row.className = 'au-tool-row ' + (c.status === 'error' ? 'error' : 'completed');
        c.row.querySelector('.au-tool-status').textContent = c.status === 'error' ? '!' : '✓';
        c.row.querySelector('.au-tool-time').textContent = fmtMs(call.elapsedMs);
        const src = document.createElement('div');
        src.className = 'au-tool-src';
        src.textContent = (call.mcp ? 'MCP · ' : '') + (call.source || '') + (call.resultSummary ? ' → ' + call.resultSummary : '');
        c.row.appendChild(src);
        completed++;
        if (call.elapsedMs) totalMs += call.elapsedMs;
        fold.setSummary(summarize());
      },
      finish() { fold.setLive(false); fold.setSummary(summarize()); fold.finish(); }
    };
  }

  /* ---------------- SSE 流式对话 ---------------- */

  /**
   * 走 /api/v2/chat/stream（agent loop）。
   * hooks: { onUser(question), onThinkingCreated(t), onTimelineCreated(tl),
   *          onDelta(text), onError(msg), onMeta(meta), onDone() }
   * 返回 Promise<{ok, text, trace}>
   */
  async function sendStream({ question, history, sessionId, module, stockCode }, hooks = {}) {
    const box = $('#chatMessages');
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant au-stream';
    const body = document.createElement('div');
    body.className = 'au-stream-body';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = '思考中…';
    wrap.appendChild(body);
    wrap.appendChild(bubble);
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;

    const thinking = appendThinking(body, { title: '思考过程 · 工具取证' });
    const timeline = appendToolTimeline(body);
    if (hooks.onThinkingCreated) hooks.onThinkingCreated(thinking);
    if (hooks.onTimelineCreated) hooks.onTimelineCreated(timeline);

    let text = '', trace = null, meta = null, finished = false;
    // 智能体回复统一走轻量 Markdown 渲染（与经典模式 appendMsg 同一套，转义优先）
    const paint = (t) => {
      if (window.MarkdownLite) { bubble.classList.add('md-body'); bubble.innerHTML = window.MarkdownLite.render(t); }
      else bubble.textContent = t;
    };
    const finish = () => {
      if (finished) return; finished = true;
      thinking.finish(); timeline.finish();
      paint(text || '（无回答）');
      box.scrollTop = box.scrollHeight;
      if (hooks.onDone) hooks.onDone();
    };

    try {
      const res = await fetch('/api/v2/chat/stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history, sessionId, module, stockCode })
      });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '', event = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
          if (!line) { event = null; continue; }
          if (line.startsWith('event: ')) { event = line.slice(7).trim(); continue; }
          if (!line.startsWith('data: ')) continue;
          let d = {}; try { d = JSON.parse(line.slice(6)); } catch (_) { continue; }
          switch (event) {
            case 'thinking': thinking.add(d.text, d.phase); break;
            case 'reasoning': thinking.reasoning(d.text); break;
            case 'tool.started': timeline.start(d); break;
            case 'tool.completed': timeline.done(d); break;
            case 'delta': text = d.text || text; if (text) paint(text); break;
            case 'trace': trace = d.trace; break;
            case 'meta': meta = d; if (hooks.onMeta) hooks.onMeta(d); break;
            case 'error': if (hooks.onError) hooks.onError(d.message); break;
            case 'done': finish(); break;
            default: break;
          }
        }
      }
      finish();
      return { ok: !!text, text, trace, meta };
    } catch (e) {
      thinking.finish('连接失败'); timeline.finish();
      bubble.textContent = '流式对话失败：' + e.message;
      bubble.classList.add('err');
      if (hooks.onError) hooks.onError(e.message);
      return { ok: false, error: e.message, text: '', trace };
    }
  }

  /* ---------------- 3D 知识图谱（3d-force-graph） ---------------- */

  const KG = {
    instance: null, data: null, dim: '3d', source: 'unified',
    container: null, wrapEl: null, filter: ''
  };

  function kgNodeLabel(n) {
    const p = n.props || {};
    const bits = ['<div class="kg-tip"><b>' + esc(n.label) + '</b>',
      '<span>类型：' + esc((window.__kgTypeLabels || {})[n.type] || n.type) + '</span>',
      '<span>状态：' + esc(n.status || 'active') + '</span>'];
    if (p.code) bits.push('<span>代码：' + esc(p.code) + '</span>');
    if (p.industry) bits.push('<span>行业：' + esc(p.industry) + '</span>');
    if (p.score != null) bits.push('<span>评分：' + esc(p.score) + '</span>');
    if (p.importance != null) bits.push('<span>重要性：' + esc(p.importance) + '</span>');
    if (n.validAt) bits.push('<span>生效：' + esc(String(n.validAt).slice(0, 16).replace('T', ' ')) + '</span>');
    if (n.episodes && n.episodes.length) bits.push('<span>来源板块：' + esc(n.episodes.join(' / ')) + '</span>');
    bits.push('</div>');
    return bits.join('');
  }

  function kgDetail(n) {
    const el = $('#graphDetail');
    if (!el) return;
    const p = n.props || {};
    const rows = Object.entries(p).filter(([k]) => !/^(validAt|color|val)$/.test(k)).slice(0, 12)
      .map(([k, v]) => '<div class="gd-meta">' + esc(k) + '：' + esc(typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : v) + '</div>').join('');
    const at = n.validAt ? new Date(n.validAt).toLocaleString('zh-CN') : '—';
    el.innerHTML = '<span class="gd-close" id="kgDetailClose">×</span>' +
      '<div class="gd-name">' + esc(n.label) + '</div>' +
      '<div class="gd-meta">类型：' + esc((window.__kgTypeLabels || {})[n.type] || n.type) +
      ' · 状态：' + esc(n.status || 'active') + ' · 生效：' + esc(at) + '</div>' +
      rows + (n.episodes && n.episodes.length ? '<div class="gd-meta">来源板块：' + esc(n.episodes.join(' / ')) + '</div>' : '') +
      '<div class="gd-meta"><button class="btn tiny ghost" id="kgDetailHistory">查看该实体更新历史</button></div>';
    el.classList.remove('hidden');
    $('#kgDetailClose') && $('#kgDetailClose').addEventListener('click', () => el.classList.add('hidden'));
    $('#kgDetailHistory') && $('#kgDetailHistory').addEventListener('click', () => {
      const btn = $$('.kb-mode-btn').find(b => b.dataset.mode === 'history');
      if (btn) btn.click();
      setTimeout(() => global.AgentUI.loadHistory({ entityId: n.id }), 60);
    });
  }

  async function loadKG(opts = {}) {
    const dim = opts.dim || KG.dim;
    const source = opts.source || KG.source;
    KG.dim = dim; KG.source = source;
    const wrap = $('#graphWrap');
    if (!wrap) return;

    if (dim === '2d') {
      // 交给原有 2D 引擎（legacy 或 unified 都转成 {nodes,edges}）
      destroy3D();
      const r = await api(source === 'unified' ? '/api/v2/unified-graph' : '/api/v2/knowledge/graph');
      if (!r.ok) return;
      const nodes = (r.nodes || []).map(n => ({ id: n.id, type: n.type, label: n.label, confidence: (n.props || {}).confidence != null ? (n.props || {}).confidence : n.confidence }));
      const edges = (r.links || r.edges || []).map(l => ({ from: typeof l.source === 'object' ? l.source.id : (l.from || l.source), to: typeof l.target === 'object' ? l.target.id : (l.to || l.target), type: l.type }));
      if (typeof window.loadGraph2D === 'function') window.loadGraph2D({ nodes, edges, stats: r.meta || r.stats, builtAt: r.builtAt });
      return;
    }

    // 3D：读统一图谱（含全板块），或旧经验图谱
    if (typeof global.ForceGraph3D !== 'function') {
      wrap.innerHTML = '<div class="empty">3D 组件未加载（vendor/3d-force-graph.min.js）；请切换到 2D</div>';
      return;
    }
    const r = await api(source === 'unified' ? '/api/v2/unified-graph' : '/api/v2/knowledge/graph');
    if (!r.ok) { wrap.innerHTML = '<div class="empty">图谱读取失败</div>'; return; }
    window.__kgTypeLabels = r.typeLabels || {};
    const nodes = (r.nodes || []).map(n => ({ ...n, name: n.label }));
    const links = (r.links || r.edges || []).map(l => ({
      source: typeof l.source === 'object' ? l.source.id : (l.from || l.source),
      target: typeof l.target === 'object' ? l.target.id : (l.to || l.target),
      type: l.type, label: l.label || l.type
    })).filter(l => l.source && l.target);
    KG.data = { nodes, links };

    const stats = r.meta || r.stats || {};
    const st = $('#graphStats');
    if (st) st.textContent = (stats.nodeCount || nodes.length) + ' 节点 · ' + (stats.linkCount || links.length) + ' 条关系 · ' +
      (source === 'unified' ? '全板块 · 双时态' : '经验词条') + (r.builtAt ? ' · ' + new Date(r.builtAt).toLocaleString('zh-CN') : '');
    renderLegend(nodes);
    wrap.innerHTML = '';
    const host = document.createElement('div');
    host.className = 'kg3d-host';
    wrap.appendChild(host);

    const graph = global.ForceGraph3D(host, { controlType: 'orbit' })
      .backgroundColor('rgba(0,0,0,0)')
      .graphData(KG.data)
      .nodeId('id')
      .nodeLabel(kgNodeLabel)
      .nodeColor(n => n.color || '#165dff')
      .nodeVal(n => n.val || 4)
      .nodeRelSize(5)
      .linkColor(() => 'rgba(120,135,160,0.35)')
      .linkOpacity(0.45)
      .linkWidth(l => l.type === 'contradicts' ? 1.6 : 0.6)
      .linkDirectionalParticles(l => l.type === 'affects' || l.type === 'caused_by' ? 2 : 0)
      .linkDirectionalParticleWidth(1.4)
      .linkDirectionalParticleSpeed(0.006)
      .onNodeClick(n => {
        const dist = 90, ratio = 1 + dist / Math.hypot(n.x || 1, n.y || 1, n.z || 1);
        graph.cameraPosition({ x: (n.x || 0) * ratio, y: (n.y || 0) * ratio, z: (n.z || 0) * ratio }, n, 1200);
        kgDetail(n);
      });
    KG.instance = graph; KG.wrapEl = wrap;
    graph.width(wrap.clientWidth || 800);
    graph.height(wrap.clientHeight || 500);
    // 中文标签策略：不混用外部 Three（UMD 内置较新版本，混用有 WebGL 风险）。
    // 用原生球体 + 分组配色 + HTML tooltip（悬停显示中文全文）+ 图例 + 点击详情面板，
    // 3D 样式与中文可读性都由 3d-force-graph 自身能力保证，零版本冲突。
    setTimeout(() => { try { graph.zoomToFit(900, 60); } catch (_) {} }, 1400);
    if (typeof window.__onKgResize === 'undefined') {
      window.__onKgResize = () => { if (KG.instance && KG.wrapEl) { KG.instance.width(KG.wrapEl.clientWidth || 800); KG.instance.height(KG.wrapEl.clientHeight || 500); } };
      window.addEventListener('resize', window.__onKgResize);
    }
  }

  function renderLegend(nodes) {
    const box = $('#graphLegend'); if (!box) return;
    const counts = {};
    for (const n of nodes) counts[n.type] = (counts[n.type] || 0) + 1;
    const labels = window.__kgTypeLabels || {};
    box.innerHTML = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, c]) => {
      const col = (nodes.find(n => n.type === t) || {}).color || '#86909c';
      return '<span class="gl-item"><span class="gl-dot" style="background:' + esc(col) + '"></span>' + esc(labels[t] || t) + ' ' + c + '</span>';
    }).join('');
  }

  function destroy3D() {
    if (KG.instance) { try { KG.instance._destructor && KG.instance._destructor(); } catch (_) {} KG.instance = null; }
    const host = $('.kg3d-host'); if (host && host.parentNode) host.parentNode.removeChild(host);
  }

  function kgSearch(q) {
    KG.filter = String(q || '').trim();
    if (!KG.instance || !KG.data) return;
    const t = KG.filter;
    const hit = new Set();
    if (t) for (const n of KG.data.nodes) if (String(n.label).includes(t) || String((n.props || {}).code || '').includes(t)) hit.add(n.id);
    KG.instance.nodeVisibility(n => !t || hit.has(n.id) ||
      KG.data.links.some(l => (l.source.id || l.source) === n.id && hit.has(l.target.id || l.target)) ||
      KG.data.links.some(l => (l.target.id || l.target) === n.id && hit.has(l.source.id || l.source)));
  }

  /* ---------------- 更新历史 / 数据质量面板 ---------------- */

  async function loadHistory({ entityId } = {}) {
    const box = $('#kgHistoryList'), meta = $('#kgHistoryMeta');
    if (!box) return;
    const qs = entityId ? '?entityId=' + encodeURIComponent(entityId) + '&limit=60' : '?limit=60';
    const [h, s] = await Promise.all([api('/api/v2/unified-graph/history' + qs), api('/api/v2/unified-graph/status')]);
    if (meta) meta.textContent = '历史 ' + (h.total || 0) + ' 条 · 已取代事实 ' + (s.factSuperseded || 0) +
      ' · 实体合并 ' + (s.entityMerged || 0) + ' · append-only 永不覆盖';
    const KIND = { 'fact-superseded': '事实被取代', 'fact-expired': '事实失效', 'entity-merged': '实体合并', 'manual-merge': '人工合并', build: '图谱重建' };
    box.innerHTML = (h.items || []).map(x => {
      const k = KIND[x.kind] || x.kind || '事件';
      const detail = x.oldValue != null
        ? '<div class="kg-h-val"><span>旧值</span><code>' + esc(String(x.oldValue).slice(0, 90)) + '</code>' +
          (x.newValue != null ? '<span>→ 新值</span><code>' + esc(String(x.newValue).slice(0, 90)) + '</code>' : '') + '</div>'
        : (x.labelB ? '<div class="kg-h-val"><code>' + esc(x.labelA || x.keptId) + '</code> + <code>' + esc(x.labelB || x.removedId) + '</code></div>' : '');
      return '<div class="kg-h-item ' + esc(x.kind) + '"><div class="kg-h-top"><span class="kg-h-kind">' + esc(k) + '</span>' +
        '<span class="kg-h-at">' + esc(String(x.at || '').slice(0, 19).replace('T', ' ')) + '</span></div>' +
        '<div class="kg-h-entity">' + esc(x.entityId || x.keptId || '—') + (x.predicate ? ' · ' + esc(x.predicate) : '') +
        (x.source ? ' · 来源 ' + esc(x.source) : '') + '</div>' + detail + '</div>';
    }).join('') || '<div class="empty">暂无更新历史（图谱重建或数据变化后会产生记录）</div>';
  }

  async function loadHygiene() {
    const box = $('#kgHygieneList'), meta = $('#kgHygieneMeta'), sum = $('#kgHygieneSummary');
    if (!box) return;
    const r = await api('/api/v2/hygiene/report');
    if (sum) {
      const s = r.bySeverity || {};
      sum.innerHTML = '<div class="kg-hy-card total"><b>' + (r.total || 0) + '</b><span>问题总数</span></div>' +
        '<div class="kg-hy-card high"><b>' + (s.high || 0) + '</b><span>高</span></div>' +
        '<div class="kg-hy-card medium"><b>' + (s.medium || 0) + '</b><span>中</span></div>' +
        '<div class="kg-hy-card low"><b>' + (s.low || 0) + '</b><span>低</span></div>' +
        '<div class="kg-hy-card"><b>' + esc(r.health || '—') + '</b><span>健康度</span></div>';
    }
    if (meta) meta.textContent = '扫描于 ' + (r.at ? new Date(r.at).toLocaleString('zh-CN') : '—') +
      ' · 规则：陈旧缓存/空损坏JSON/重复新闻/孤岛/死链/低置信/非交易日脏数据';
    const RULE = r.rules || {};
    box.innerHTML = (r.items || []).map(x =>
      '<div class="kg-hy-item ' + esc(x.severity) + '"><span class="kg-hy-sev">' + esc(x.severity === 'high' ? 'H' : x.severity === 'medium' ? 'M' : 'L') + '</span>' +
      '<span class="kg-hy-rule">' + esc(RULE[x.rule] || x.rule) + '</span>' +
      '<span class="kg-hy-msg">' + esc(x.message) + '</span>' +
      (x.file ? '<span class="kg-hy-file">' + esc(x.file) + '</span>' : '') +
      (x.suggestion ? '<span class="kg-hy-sug">→ ' + esc(x.suggestion) + '</span>' : '') + '</div>'
    ).join('') || '<div class="empty">未发现数据质量问题</div>';
  }

  /* ---------------- 初始化绑定 ---------------- */

  function init() {
    // 图谱来源 / 维度切换
    $$('.kg-src-btn').forEach(b => b.addEventListener('click', () => {
      $$('.kg-src-btn').forEach(x => x.classList.toggle('active', x === b));
      KG.source = b.dataset.src;
      loadKG({ source: KG.source, dim: KG.dim });
    }));
    $$('.kg-dim-btn').forEach(b => b.addEventListener('click', () => {
      $$('.kg-dim-btn').forEach(x => x.classList.toggle('active', x === b));
      KG.dim = b.dataset.dim;
      loadKG({ source: KG.source, dim: KG.dim });
    }));
    $('#btnKgRebuild') && $('#btnKgRebuild').addEventListener('click', async () => {
      const r = await post('/api/v2/unified-graph/build', {});
      await loadKG();
      if (global.toast) global.toast('图谱已重建', '节点 ' + (r.nodes || 0) + ' · 关系 ' + (r.links || 0));
    });
    $('#btnKgHistoryReload') && $('#btnKgHistoryReload').addEventListener('click', () => loadHistory());
    $('#btnKgHygieneScan') && $('#btnKgHygieneScan').addEventListener('click', async () => {
      await post('/api/v2/hygiene/scan', {}); await loadHygiene();
      if (global.toast) global.toast('已重新扫描', '按 13 类规则检查数据质量');
    });
    $('#btnKgHygieneClean') && $('#btnKgHygieneClean').addEventListener('click', async () => {
      const r = await post('/api/v2/hygiene/clean', { confirm: true });
      await loadHygiene();
      if (global.toast) global.toast(r.executed ? '已执行可逆清理' : '预演', r.note || '');
    });
    $('#btnKgAsof') && $('#btnKgAsof').addEventListener('click', async () => {
      const v = $('#kgAsofInput').value;
      if (!v) { if (global.toast) global.toast('请选择时间', '', true); return; }
      const r = await api('/api/v2/unified-graph/asof?at=' + encodeURIComponent(new Date(v).toISOString()));
      const el = $('#kgAsofResult'); if (!el) return;
      el.classList.remove('hidden');
      el.innerHTML = '<div class="kg-asof-head"><b>时点回溯 · ' + esc(v.replace('T', ' ')) + '</b>' +
        '<button class="btn tiny ghost" id="kgAsofClose">关闭</button></div>' +
        '<p class="note">' + esc(r.note || '') + '</p>' +
        '<div class="kg-asof-grid"><div>当时生效事实 <b>' + (r.activeFacts || 0) + '</b></div>' +
        '<div>已被取代的旧事实 <b>' + (r.historicFacts || 0) + '</b></div></div>' +
        (r.superseded || []).slice(0, 8).map(x => '<div class="kg-asof-row">' + esc(x.entityId) + ' · ' + esc(x.predicate) +
          '：<code>' + esc(x.oldValue) + '</code> → <code>' + esc(x.newValue) + '</code>（' + esc(String(x.invalidatedAt).slice(0, 16).replace('T', ' ')) + '）</div>').join('');
      $('#kgAsofClose') && $('#kgAsofClose').addEventListener('click', () => el.classList.add('hidden'));
    });
    // 工具清单
    $('#btnAgentTools') && $('#btnAgentTools').addEventListener('click', async () => {
      const r = await api('/api/v2/agent/tools');
      const box = $('#chatMessages'); if (!box) return;
      const w = document.createElement('div'); w.className = 'msg assistant';
      const b = document.createElement('div'); b.className = 'msg-bubble au-toolcard';
      b.innerHTML = '<div class="au-toolcard-head"><b>智能体可调用的数据工具</b> <span class="note">' +
        r.count + ' 个（本地 ' + r.local + ' · MCP ' + r.mcp + '）</span></div>' +
        '<div class="au-toolcard-list">' + (r.tools || []).map(t =>
          '<div class="au-toolcard-item"><span>' + toolIcon(t.name) + '</span><b>' + esc(toolName(t.name)) + '</b>' +
          '<span class="note">' + esc(String(t.description || '').slice(0, 90)) + '</span></div>').join('') + '</div>' +
        '<div class="note">MCP server：' + esc(r.mcpStatus && r.mcpStatus.server || '未连接') + ' · 工具按需 Pull，调用轨迹在每次回答中可见。</div>';
      w.appendChild(b); box.appendChild(w); box.scrollTop = box.scrollHeight;
    });
    // 工具数
    api('/api/v2/agent/tools').then(r => { const el = $('#chatToolCount'); if (el && r.count) el.textContent = r.count; });
    // 知识库四视图切换（覆盖原有双视图绑定）
    $$('.kb-mode-btn').forEach(b => {
      b.addEventListener('click', () => {
        const mode = b.dataset.mode;
        $$('.kb-mode-btn').forEach(x => x.classList.toggle('active', x === b));
        ['graph', 'entries', 'history', 'hygiene'].forEach(m => {
          const p = $('#kbPanel' + m.charAt(0).toUpperCase() + m.slice(1));
          if (p) p.classList.toggle('active', m === mode);
        });
        if (mode === 'graph') loadKG();
        else destroy3D();
        if (mode === 'history') loadHistory();
        if (mode === 'hygiene') loadHygiene();
      });
    });
    // 图谱搜索
    const gs = $('#graphSearch');
    if (gs) gs.addEventListener('input', e => {
      KG.filter = e.target.value;
      if (KG.dim === '3d') kgSearch(KG.filter);
      else if (typeof window.applyGraphSearch === 'function') window.applyGraphSearch(KG.filter);
    });
  }

  global.AgentUI = {
    collapsible, appendThinking, appendToolTimeline, sendStream,
    loadKG, loadHistory, loadHygiene, kgSearch, destroy3D, init, KG,
    toolName, toolIcon, fmtMs
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
