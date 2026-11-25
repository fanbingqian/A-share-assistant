/* interaction.js
 * 交互工作区 —— 「全球舆情程序」与「交互程序」融合后的主程序内原生视图层。
 *
 * 定位（一个项目）：
 *   - 同一个服务 127.0.0.1:8777（server/server.js），同一份 data/config.json，同一套 SSE。
 *   - 本文件只是 web/ 下的一个视图层，由 index.html 引入；不是独立 HTML 程序。
 *   - 原有 17 个主面板 / app.js / styles.css / server/*.js 全部零改动。
 *
 * 反幻觉边界（务必保持）：
 *   - 只读 GET：/api/stocks /api/journal /api/journal/picks /api/journal/live
 *              /api/holdings /api/edge /api/health
 *   - 零 POST/PUT/DELETE、零 localStorage/sessionStorage 写入、零自建 EventSource。
 *   - 不读取、不修改 app.js 的状态 S；不改任何评分、不写任何配置、不调用审核 API。
 *   - 取不到数据一律显示「暂无 / 数据源不可达」，绝不编造数值。
 *   - 所有 LLM / 智能体相关产出一律标注「AI 提案 · 未生效」或「设计态」。
 */
(function () {
  'use strict';

  /* ------------------------- 常量 ------------------------- */
  var API = {
    stocks:   '/api/stocks',
    journal:  '/api/journal',
    picks:    '/api/journal/picks',
    live:     '/api/journal/live',
    holdings: '/api/holdings',
    edge:     '/api/edge',
    health:   '/api/health'
  };
  var D = {}, E = {};                 /* 数据 / 错误 */
  var cur = 'chat', built = false, dark = false;
  var AI_MARK = 'AI 提案 · 未生效';

  var VIEWS = [
    { k: 'chat',     ico: '💬', name: '对话分诊', sub: '本地规则 · 未接 LLM' },
    { k: 'factors',  ico: '🧮', name: '因子池',   sub: '真实因子 + 登记草案' },
    { k: 'lessons',  ico: '📚', name: '经验池',   sub: '现有经验库 + 三类来源' },
    { k: 'review',   ico: '🔍', name: '今日复盘', sub: '定格 / 实时池 / 持仓' },
    { k: 'audit',    ico: '✅', name: '审核台',   sub: '待审经验（只读）' },
    { k: 'settings', ico: '⚙️', name: '智能体设置', sub: '选型结论 · 设计态' }
  ];
  var ORIGIN = [
    { ico: '📡', name: '监控总览', target: '核心监测' },
    { ico: '🎯', name: '自动选股', target: '当日观察池' },
    { ico: '💼', name: '我的持仓', target: '持仓监控' },
    { ico: '🧭', name: '研究看板', target: '评估数据库与经验库' }
  ];
  /* 抽屉项 → 本工作区视图的映射（navplan.js 与这里共用同一套 key） */
  var INC_MAP = {
    '对话入口': 'chat', '因子池': 'factors', '经验池': 'lessons',
    '今日复盘': 'review', '审核台': 'audit', '智能体设置': 'settings'
  };
  var FACTOR_KW = ['因子', '指标', 'IC', '动量', '反转', '换手', '波动', '均线', '量比',
                   '市值', '估值', '回撤', '打分', '权重', 'alpha', 'Alpha', '超预期'];
  var LESSON_KW = ['经验', '教训', '上次', '复盘', '我发现', '总结', '规律', '以后',
                   '注意', '不要', '追高', '止损', '当时', '事后'];

  /* ------------------------- 工具 ------------------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmt(v, unit) {
    if (v == null || v === '' || (typeof v === 'number' && !isFinite(v))) return '—';
    return String(v) + (unit || '');
  }
  /* 统一的更新时间标记：北京时间 + 相对多久前（所有更新内容都带时间） */
  function stamp(ts, hhmm) {
    if (!ts && !hhmm) return '<span class="iw-stamp">更新时间 —</span>';
    var d = ts ? new Date(ts) : null;
    var t = hhmm || (d ? d.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }).replace(/\//g, '-') : '—');
    var rel = '';
    if (ts) {
      var min = Math.round((Date.now() - ts) / 60000);
      rel = min < 1 ? '刚刚' : min < 60 ? min + ' 分钟前'
        : min < 1440 ? Math.floor(min / 60) + ' 小时前' : Math.floor(min / 1440) + ' 天前';
    }
    return '<span class="iw-stamp" title="数据来源：本地确定性计算 / 账本">更新于 ' + esc(t) + ' · ' + rel + '</span>';
  }
  function unwrap(j) {
    return (j && typeof j === 'object' && Object.prototype.hasOwnProperty.call(j, 'data'))
      ? j.data : j;
  }
  function jget(url) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 9000);
    var opt = { method: 'GET', cache: 'no-store' };
    if (ctl) opt.signal = ctl.signal;
    return fetch(url, opt).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(unwrap).then(function (v) {
      clearTimeout(timer); return v;
    }, function (e) {
      clearTimeout(timer); throw e;
    });
  }
  function loadAll(cb) {
    var keys = Object.keys(API);
    Promise.all(keys.map(function (k) {
      return jget(API[k]).then(function (v) { D[k] = v; E[k] = null; },
        function (e) { D[k] = null; E[k] = e.message || '请求失败'; });
    })).then(function () { try { render(); } catch (err) { console.error(err); } if (cb) cb(); });
  }
  function srcOk(k) {
    return D[k] ? '<span class="iw-tag iw-t-live">真实数据 · ' + esc(API[k]) + '</span>'
                : '<span class="iw-tag iw-t-design">暂无 / 数据源不可达 · ' + esc(API[k]) + '</span>';
  }
  function items(v, key) {
    if (!v || !Array.isArray(v[key])) return [];
    return v[key];
  }
  function findPanel(title) {
    var hs = document.querySelectorAll('.panel-head h2');
    for (var i = 0; i < hs.length; i++) {
      var t = (hs[i].textContent || '').trim();
      if (t.indexOf(title) === 0) {
        if (hs[i].closest) { var s = hs[i].closest('section'); if (s) return s; }
        var p = hs[i].parentElement;
        return (p && p.parentElement) || null;
      }
    }
    return null;
  }

  /* ------------------------- 骨架 ------------------------- */
  function topHtml() {
    return '<div class="iw-top">' +
      '<div class="iw-brand">全球市场监测与报警系统 <small>／ 交互工作区</small></div>' +
      '<div class="iw-oneproj">🟦 <b>这是一个项目</b>：全球新闻舆情监测（原有 17 个主面板）＋ 交互增量（本工作区 6 个视图）' +
        '共用 <b>同一个 8777 服务</b>、同一份 <b>data/config.json</b>、同一套 <b>SSE 推送</b>、同一个 <b>启动监控.bat</b>。' +
        '独立原型已归档为设计稿，不再是另一个程序。</div>' +
      '<div class="iw-top-btns">' +
        '<button class="iw-btn" data-act="refresh">↻ 刷新数据</button>' +
        '<button class="iw-btn" data-act="theme">◐ 深/浅</button>' +
        '<button class="iw-btn primary" data-act="close">← 返回原有仪表盘</button>' +
      '</div></div>';
  }
  function sideHtml() {
    var a = '<div class="iw-side"><div class="iw-side-label">② 交互增量 · 本工作区</div>';
    VIEWS.forEach(function (v) {
      a += '<button class="iw-nav' + (v.k === cur ? ' on' : '') + '" data-act="nav" data-v="' + v.k + '">' +
        '<span class="ico">' + v.ico + '</span><span>' + esc(v.name) +
        '<span class="sub">' + esc(v.sub) + '</span></span></button>';
    });
    a += '<div class="iw-side-label" style="margin-top:14px">① 原有系统 · 已上线</div>';
    ORIGIN.forEach(function (o) {
      a += '<button class="iw-nav" data-act="origin" data-target="' + esc(o.target) + '">' +
        '<span class="ico">' + o.ico + '</span><span>' + esc(o.name) +
        '<span class="sub">跳转到现有面板</span></span></button>';
    });
    a += '<div class="iw-side-foot">本工作区<b>只读</b>：仅 GET 现有 API，不写配置、不改评分、不调用审核接口。' +
      '所有智能体产出标记「' + esc(AI_MARK) + '」。未接 LLM 时自动降级为确定性模式。</div></div>';
    return a;
  }
  function viewsHtml() {
    var s = '';
    /* 1 对话分诊 */
    s += '<section class="iw-view' + (cur === 'chat' ? ' on' : '') + '" id="iwv-chat">' +
      '<h1 class="iw-h1">💬 对话分诊</h1>' +
      '<p class="iw-sub">一句话自动区分「可登记为因子」还是「可作为经验」。当前<b>未接 LLM</b>，分诊由本地确定性关键词规则完成，结果仅是<b>规则草案</b>。</p>' +
      '<div class="iw-warn">⚠️ 未配置 DeepSeek 时运行于 <b>L0 纯确定性模式</b>。以下分类不调用任何模型、不猜测语义；低置信度一律进「待澄清」。' +
      '智能体接入后也只给建议、不得覆盖确定性结果。</div>' +
      '<div class="iw-card"><h3>输入一句话</h3>' +
        '<textarea class="iw-textarea" id="iwChatIn" placeholder="例如：我发现放量突破后第二天经常回落，能不能记成经验？"></textarea>' +
        '<div class="iw-chips">' +
          ['我发现连板后第二天容易低开，记成经验', '把换手率分位数登记成一个因子',
           'RSI 超过 70 是不是该减仓', '上次追高吃了亏，以后要注意',
           '帮我看看今天什么最赚钱'].map(function (t) {
             return '<button class="iw-chip" data-act="example" data-t="' + esc(t) + '">' + esc(t) + '</button>';
           }).join('') +
        '</div><button class="iw-btn primary" data-act="triage">运行确定性分诊</button>' +
        '<div id="iwTriageOut" style="margin-top:12px"></div></div>' +
      '<div class="iw-card"><h3>分诊规则（可解释，非黑箱）</h3>' +
        '<div class="iw-flow"><span class="s">因子词：' + esc(FACTOR_KW.join(' / ')) + '</span></div>' +
        '<div class="iw-flow"><span class="s">经验词：' + esc(LESSON_KW.join(' / ')) + '</span></div>' +
        '<p class="iw-note">命中因子词多 → 因子候选；命中经验词多 → 经验候选；双向都命中或都不命中 → 待澄清。' +
        '置信度由命中词数决定，<b>不做语义推断</b>。分类结果只在本页展示，不写入因子池或经验池。</p></div>' +
      '<div id="iwd-chat"></div></section>';
    /* 2-6 其余视图：动态区 */
    var meta = [
      ['factors',  '🧮 因子池',   '系统当前真实可算的因子 + 自定义因子登记草案。影子运行 / IC 复检 / 上架均为设计态。'],
      ['lessons',  '📚 经验池',   '现有经验库的真实统计 + 个人 / 自动 / 讨论三类来源草案。'],
      ['review',   '🔍 今日复盘', '真实复盘对象 = 持仓 ∪ 09:05 定格名单 ∪ 实时观察池。多智能体讨论为设计态。'],
      ['audit',    '✅ 审核台',   '现有待审经验只读展示；AI 提案队列为空。本页不调用审核 API。'],
      ['settings', '⚙️ 智能体设置', '选型唯一结论、设计态配置预览与隐私边界。不写入配置。']
    ];
    meta.forEach(function (m) {
      s += '<section class="iw-view' + (cur === m[0] ? ' on' : '') + '" id="iwv-' + m[0] + '">' +
        '<h1 class="iw-h1">' + m[1] + '</h1><p class="iw-sub">' + m[2] + '</p>' +
        '<div id="iwd-' + m[0] + '"></div></section>';
    });
    return s;
  }
  function build() {
    if (built) return;
    var mask = document.createElement('div');
    mask.className = 'iw-mask'; mask.id = 'iwMask';
    var shell = document.createElement('div');
    shell.className = 'iw-shell'; shell.id = 'iwShell';
    shell.innerHTML = topHtml() + '<div class="iw-body">' + sideHtml() +
      '<div class="iw-main">' + viewsHtml() + '</div></div>';
    document.body.appendChild(mask);
    document.body.appendChild(shell);

    mask.addEventListener('click', close);
    shell.addEventListener('click', onClick);
    shell.addEventListener('keydown', function (e) {
      if (e.target && e.target.id === 'iwChatIn' && e.key === 'Enter' &&
          (e.ctrlKey || e.metaKey)) { e.preventDefault(); triage(); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && shell.classList.contains('show')) close();
    });
    built = true;
  }

  /* ------------------------- 交互 ------------------------- */
  function open(view) {
    build();
    if (view && INC_MAP[view]) view = INC_MAP[view];
    if (view && VIEWS.some(function (v) { return v.k === view; })) switchView(view);
    document.getElementById('iwMask').classList.add('show');
    document.getElementById('iwShell').classList.add('show');
    loadAll();
  }
  function close() {
    if (!built) return;
    document.getElementById('iwMask').classList.remove('show');
    document.getElementById('iwShell').classList.remove('show');
  }
  function switchView(k) {
    cur = k;
    var vs = document.querySelectorAll('.iw-view');
    for (var i = 0; i < vs.length; i++) vs[i].classList.remove('on');
    var v = document.getElementById('iwv-' + k);
    if (v) v.classList.add('on');
    var ns = document.querySelectorAll('.iw-nav[data-v]');
    for (var j = 0; j < ns.length; j++) ns[j].classList.toggle('on', ns[j].getAttribute('data-v') === k);
    var main = document.querySelector('.iw-main');
    if (main) main.scrollTop = 0;
  }
  function onClick(e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t) return;
    var act = t.getAttribute('data-act');
    if (act === 'close') close();
    else if (act === 'theme') {
      dark = !dark;
      document.getElementById('iwShell').classList.toggle('iw-dark', dark);
    } else if (act === 'refresh') loadAll();
    else if (act === 'nav') switchView(t.getAttribute('data-v'));
    else if (act === 'origin') {
      var name = t.getAttribute('data-target');
      close();
      setTimeout(function () {
        var p = findPanel(name);
        if (p) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    } else if (act === 'example') {
      var inp = document.getElementById('iwChatIn');
      if (inp) inp.value = t.getAttribute('data-t') || '';
      triage();
    } else if (act === 'triage') triage();
    else if (act === 'factor-draft') factorDraft();
    else if (act === 'lesson-draft') lessonDraft();
  }
  function triage() {
    var inp = document.getElementById('iwTriageOut');
    var ta = document.getElementById('iwChatIn');
    if (!inp || !ta) return;
    var text = (ta.value || '').trim();
    if (!text) { inp.innerHTML = '<div class="iw-empty">请输入一句话后再分诊。</div>'; return; }
    var f = FACTOR_KW.filter(function (k) { return text.indexOf(k) >= 0; });
    var l = LESSON_KW.filter(function (k) { return text.indexOf(k) >= 0; });
    var kind, conf, why;
    if (f.length && l.length) { kind = '待澄清'; conf = '低'; why = '同时命中因子词与经验词，确定性规则不猜测，交由用户确认。'; }
    else if (f.length > l.length) { kind = '因子候选'; conf = f.length >= 2 ? '中' : '低'; why = '命中因子词 ' + f.length + ' 个：' + f.join('、'); }
    else if (l.length > f.length) { kind = '经验候选'; conf = l.length >= 2 ? '中' : '低'; why = '命中经验词 ' + l.length + ' 个：' + l.join('、'); }
    else { kind = '待澄清'; conf = '低'; why = '未命中任何规则词，不推断语义。'; }
    var draft = {
      分类: kind, 置信度: conf, 判定依据: why,
      原文: text, 来源: 'L0 本地确定性规则（未调用 LLM）',
      状态: '规则草案 · 未生效（未写入因子池 / 经验池）'
    };
    inp.innerHTML = '<div class="iw-card" style="margin:0">' +
      '<h3>分诊结果 <span class="iw-tag iw-t-ai">' + esc(AI_MARK) + '</span></h3>' +
      '<div class="iw-row" style="margin-bottom:9px">' +
        '<div class="iw-kpi"><div class="k">分类</div><div class="v" style="font-size:17px">' + esc(kind) + '</div><div class="d">确定性规则</div></div>' +
        '<div class="iw-kpi"><div class="k">置信度</div><div class="v" style="font-size:17px">' + esc(conf) + '</div><div class="d">命中词数</div></div>' +
        '<div class="iw-kpi"><div class="k">模式</div><div class="v" style="font-size:17px">L0</div><div class="d">未接 LLM</div></div>' +
      '</div><div class="iw-mono-block">' + esc(JSON.stringify(draft, null, 2)) + '</div>' +
      '<p class="iw-note">' + esc(why) + '　本结果<b>只在本页展示</b>，未提供提交按钮：设计态下不会写入任何数据文件。</p></div>';
  }
  function factorDraft() {
    var n = document.getElementById('iwFactorName');
    var out = document.getElementById('iwFactorOut');
    if (!n || !out) return;
    var name = (n.value || '').trim();
    if (!name) { out.innerHTML = '<div class="iw-empty">请填写因子名称（仅生成本页草案，不提交）。</div>'; return; }
    var d = {
      id: 'usr_' + Date.now(), name: name, status: 'draft',
      formula: null, requiredFields: [], verdict: '字段白名单未校验 · 不可计算',
      状态: AI_MARK, 说明: '草案只在本页展示；未写入因子池、未进入影子运行、不参与评分。'
    };
    out.innerHTML = '<div class="iw-card" style="margin:10px 0 0"><h3>登记草案 <span class="iw-tag iw-t-ai">' +
      esc(AI_MARK) + '</span></h3><div class="iw-mono-block">' + esc(JSON.stringify(d, null, 2)) + '</div></div>';
  }
  function lessonDraft() {
    var n = document.getElementById('iwLessonText');
    var out = document.getElementById('iwLessonOut');
    if (!n || !out) return;
    var text = (n.value || '').trim();
    if (!text) { out.innerHTML = '<div class="iw-empty">请填写经验内容（仅生成本页草案，不提交）。</div>'; return; }
    var d = {
      source: '个人经验', dim: 'manual', claim: text,
      falsifiable: '需人工补写可证伪条件', n: 0,
      状态: AI_MARK, 说明: '草案只在本页展示；未写入经验池、未进入审核队列。'
    };
    out.innerHTML = '<div class="iw-card" style="margin:10px 0 0"><h3>经验草案 <span class="iw-tag iw-t-ai">' +
      esc(AI_MARK) + '</span></h3><div class="iw-mono-block">' + esc(JSON.stringify(d, null, 2)) + '</div></div>';
  }

  /* ------------------------- 渲染 ------------------------- */
  function kpi(k, v, d) {
    return '<div class="iw-kpi"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) +
      '</div><div class="d">' + esc(d || '') + '</div></div>';
  }
  function renderChat() {
    var j = D.journal || {}, h = D.health || {};
    var mod = ['stocks', 'journal', 'edge', 'holdings', 'cycle', 'flow', 'riskoff']
      .filter(function (k) { return h && h[k]; }).length;
    document.getElementById('iwd-chat').innerHTML =
      '<div class="iw-card"><h3>同项目实时状态 <span class="n">打开工作区时读取</span></h3>' +
        '<div class="iw-row" style="margin-bottom:8px">' +
          kpi('主服务', h.ok === true ? '在线' : '未知', '/api/health') +
          kpi('运行时长', h.uptimeSec != null ? Math.round(h.uptimeSec / 3600) + ' h' : '—', '同一进程') +
          kpi('已就绪模块', mod + ' / 7', 'health 字段') +
          kpi('SSE 客户端', fmt(h.sseClients), '共用一套推送') +
        '</div>' + srcOk('health') + ' ' + srcOk('journal') +
        '<p class="iw-note">对话分诊与下列所有视图，读的都是<b>同一个服务</b>的 API；不存在第二个后端、第二份配置。</p></div>';
  }
  function renderFactors() {
    var st = D.stocks, eg = D.edge, h = D.health;
    var it = (st && Array.isArray(st.items) && st.items[0]) || null;
    var ind = (it && it.indicators) || {}, grp = (it && it.groups) || {};
    var ik = Object.keys(ind), gk = Object.keys(grp).filter(function (k) { return k !== 'weights'; });
    var rows = '';
    if (ik.length) {
      rows = '<table class="iw-table"><thead><tr><th>因子键</th><th>当前样本值</th><th>来源</th></tr></thead><tbody>' +
        ik.map(function (k) {
          return '<tr><td class="iw-mono">' + esc(k) + '</td><td class="iw-mono">' +
            esc(fmt(ind[k])) + '</td><td>stocks.js · indicators（观察池首只样本）</td></tr>';
        }).join('') + '</tbody></table>';
    } else {
      rows = '<div class="iw-empty">未能取得真实因子明细（数据源不可达或未生成观察池）。此处不编造因子列表。</div>';
    }
    var grpHtml = gk.length
      ? '<table class="iw-table"><thead><tr><th>分组 / 修正项</th><th>当前样本值</th></tr></thead><tbody>' +
        gk.map(function (k) {
          return '<tr><td class="iw-mono">' + esc(k) + '</td><td class="iw-mono">' +
            esc(typeof grp[k] === 'object' ? JSON.stringify(grp[k]) : fmt(grp[k])) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="iw-empty">暂无分组数据。</div>';
    var cnt = (eg && eg.counts) || {};
    document.getElementById('iwd-factors').innerHTML =
      '<div class="iw-card"><h3>真实因子清单 <span class="n">来自 stocks.js，非设计稿</span></h3>' +
        '<div class="iw-row" style="margin-bottom:10px">' +
          kpi('观察池标的', (st && st.items) ? st.items.length : '—', '/api/stocks') +
          kpi('indicators 因子', ik.length || '—', '真实可算') +
          kpi('groups 维度', gk.length || '—', '三组 + 修正') +
          kpi('板块榜', fmt(cnt.boards), '/api/edge（0 表示数据源当前不可达）') +
        '</div>' + srcOk('stocks') + ' ' + srcOk('edge') +
        rows +
        '<p class="iw-note">上表是系统<b>现在真的在计算</b>的因子。WorldQuant 101 / Qlib Alpha158 / Barra 等外部因子库只作方法参照，' +
        '未接入、不登记为可用因子。板块数为 0 时请查看原有「数据源状态」面板，本页不做推测。</p></div>' +
      '<div class="iw-card"><h3>评分分组与修正项（真实）</h3>' + grpHtml + '</div>' +
      '<div class="iw-card"><h3>自定义因子登记 <span class="iw-tag iw-t-ai">' + esc(AI_MARK) + '</span></h3>' +
        '<div class="iw-flow"><span class="s">draft</span><span class="a">→</span><span class="s">字段白名单校验</span>' +
        '<span class="a">→</span><span class="s">shadow 影子运行(只算不进分)</span><span class="a">→</span>' +
        '<span class="s">Rank IC 复检</span><span class="a">→</span><span class="s">人工审核</span>' +
        '<span class="a">→</span><span class="s">live 有界上架</span></div>' +
        '<p class="iw-note">状态机为设计态流程说明，<b>尚未实现后端</b>。下面的输入只生成本页草案。</p>' +
        '<input class="iw-input" id="iwFactorName" placeholder="因子名称，例如：20 日换手率分位">' +
        '<div style="margin-top:9px"><button class="iw-btn" data-act="factor-draft">生成草案（不提交）</button></div>' +
        '<div id="iwFactorOut"></div></div>' +
      '<div class="iw-card"><h3>数据源状态（真实）</h3>' +
        '<p class="iw-note">模块健康字段：' + esc(['stocks', 'journal', 'edge', 'holdings', 'cycle', 'flow', 'riskoff']
          .map(function (k) { return k + '=' + (h && h[k] ? 'ok' : 'n/a'); }).join(' · ')) + '</p>' +
        srcOk('health') + '</div>';
  }
  function renderLessons() {
    var j = D.journal || {};
    var o = j.overall || {}, ls = j.lessons || {}, rl = j.rules || {};
    document.getElementById('iwd-lessons').innerHTML =
      '<div class="iw-card"><h3>现有经验库真实统计 <span class="n">/api/journal</span></h3>' +
        '<div class="iw-row" style="margin-bottom:9px">' +
          kpi('定格名单', fmt(j.picks), 'picks.jsonl') +
          kpi('复盘结果', fmt(j.outcomes), 'outcomes.jsonl') +
          kpi('归纳经验', fmt(ls.total), (ls.pending || 0) + ' 待审') +
          kpi('已生效规则', fmt(rl.count), 'rules.json') +
        '</div><div class="iw-row">' +
          kpi('命中率', fmt(o.hitRate, '%'), '跑赢同市值层基准') +
          kpi('平均超额', fmt(o.avgExcess, '%'), 'T+1') +
          kpi('样本 n', fmt(o.n), '可证伪') +
          kpi('就绪度', '—', String(j.readiness || '—')) +
        '</div><div style="margin-top:9px">' + srcOk('journal') + '</div>' +
        '<p class="iw-note">这些是<b>现有五段式闭环</b>的真实数据：定格 → 复盘 → 归纳 → 人工审核 → 有界回流。' +
        '经验池不另起一套存储，直接扩展它。</p></div>' +
      '<div class="iw-card"><h3>三类来源（个人 / 自动 / 讨论）</h3>' +
        '<table class="iw-table"><thead><tr><th>来源</th><th>当前状态</th><th>存储与裁决</th></tr></thead><tbody>' +
        '<tr><td>个人经验</td><td><span class="iw-tag iw-t-design">设计态</span></td><td>拟写入 lessons.jsonl，带「来源」维度</td></tr>' +
        '<tr><td>自动复盘</td><td><span class="iw-tag iw-t-live">已上线</span></td><td>现有 outcomes → lessons（n≥8 才归纳）</td></tr>' +
        '<tr><td>多智能体讨论</td><td><span class="iw-tag iw-t-design">设计态</span></td><td>12 技能排布产物，统一进待审队列</td></tr>' +
        '</tbody></table></div>' +
      '<div class="iw-card"><h3>写一条个人经验 <span class="iw-tag iw-t-ai">' + esc(AI_MARK) + '</span></h3>' +
        '<textarea class="iw-textarea" id="iwLessonText" placeholder="例如：放量突破后若次日量能萎缩过半，不追。"></textarea>' +
        '<div style="margin-top:9px"><button class="iw-btn" data-act="lesson-draft">生成草案（不提交）</button></div>' +
        '<div id="iwLessonOut"></div>' +
        '<p class="iw-note">要求可证伪、n≥8 才归纳、被证伪保留记录不删除。当前<b>不写入任何文件</b>。</p></div>';
  }
  function renderReview() {
    var pk = D.picks, lv = D.live, hd = D.holdings, st = D.stocks;
    var p = (Array.isArray(pk) && pk[0]) || null;
    var pItems = (p && p.items) || [];
    var lItems = (lv && lv.items) || [];
    var hItems = (hd && hd.positions) || [];
    // 三池对照：实时池与股池的成分重合度（诊断「为什么两个界面股池不一样」）
    var stCodes = ((st && st.items) || []).map(function (x) { return x.code; });
    var lvCodes = lItems.map(function (x) { return x.code; });
    var overlap = lvCodes.filter(function (c) { return stCodes.indexOf(c) >= 0; }).length;
    var syncTag = !lItems.length || !stCodes.length ? ''
      : overlap === lvCodes.length
        ? '<span class="iw-tag iw-t-live">✓ 实时池与股池同源（前 ' + lvCodes.length + ' 只）</span>'
        : '<span class="iw-tag iw-t-design">实时池与股池重合 ' + overlap + '/' + lvCodes.length +
          ' · 更新时点不同（实时池 ' + esc(lv && lv.hhmm || '—') + ' / 股池 ' + esc(st && st.generatedAt ? new Date(st.generatedAt).toTimeString().slice(0, 5) : '—') + '）</span>';
    function stockRows(arr, cap) {
      if (!arr.length) return '<div class="iw-empty">暂无数据（数据源不可达或未生成）。</div>';
      return '<table class="iw-table"><thead><tr><th>代码</th><th>名称</th><th>行业</th><th>评分 / 现价</th><th>依据</th></tr></thead><tbody>' +
        arr.slice(0, cap || 6).map(function (x) {
          return '<tr><td class="iw-mono">' + esc(x.code) + '</td><td>' + esc(x.name) + '</td><td>' +
            esc(x.industry || '—') + '</td><td class="iw-mono">' + esc(fmt(x.score)) + ' / ' +
            esc(fmt(x.price)) + '</td><td>' + esc(String(x.thesis || x.quant || x.signal || '—').slice(0, 48)) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    document.getElementById('iwd-review').innerHTML =
      '<div class="iw-card"><h3>今日复盘对象（真实并集）' + stamp(st && st.generatedAt, null) + '</h3>' +
        '<div class="iw-row" style="margin-bottom:9px">' +
          kpi('持仓', fmt(hd && hd.count, ' 只'), stamp(hd && hd.generatedAt || hd && hd.updatedAt, null)) +
          kpi('定格名单', pItems.length + ' 只', p ? (p.date + ' ' + p.kind + ' ' + stamp(p.at, p.hhmm)) : '暂无') +
          kpi('实时观察池', lItems.length + ' 只', stamp(lv && lv.updatedAt, lv && lv.hhmm)) +
          kpi('观察池全量', (st && st.items) ? st.items.length + ' 只' : '—', stamp(st && st.generatedAt, null)) +
        '</div>' + srcOk('holdings') + ' ' + srcOk('picks') + ' ' + srcOk('live') + syncTag +
        '<p class="iw-note"><b>三个池子为何不一样（正常）</b>：<b>观察池全量</b>（检测界面「自动选股」）= 当前评分结果，自动每 15 分钟重算；' +
        '<b>实时观察池</b> = 盘中 9:25–15:05 随评分滚动的当日快照（上限 12 只）；' +
        '<b>定格名单</b> = 09:05 / 22:00 冻结的复盘基准（不可变）。' +
        '三者更新时点不同，非交易时段会看到差异。若实时池显示「更新时点不同」，点主界面「自动选股 → 重新计算」后到 9:25 会自动对齐。' +
        '复盘口径：以<b>固定定格名单</b>为基准，命中 = 跑赢同市值层基准。推荐数量：全量 ' +
        fmt(st && st.maxStocks || 18) + ' / 实时池 ' + fmt(lv && lv.count || 12) + ' / 定格 ' + fmt(p && p.items && p.items.length || 18) + '。</p></div>' +
      '<div class="iw-card"><h3>最近一次冻结定格 <span class="n">' +
        esc(p ? (p.id + ' · ' + p.note) : '无记录') + '</span>' + stamp(p && p.at, p && p.hhmm) + '</h3>' + stockRows(pItems, 6) + '</div>' +
      '<div class="iw-card"><h3>实时观察池 <span class="n">' + esc(lv && lv.note ? lv.note : '盘中滚动') + '</span>' + stamp(lv && lv.updatedAt, lv && lv.hhmm) + '</h3>' +
        stockRows(lItems, 5) + '</div>' +
      '<div class="iw-card"><h3>我的持仓（真实）</h3>' + stockRows(hItems.map(function (x) {
        return { code: x.code, name: x.name, industry: x.industry || '—',
                 score: x.pnlPct != null ? x.pnlPct + '%' : '—', price: x.price, thesis: x.advice || x.note || '—' };
      }), 5) + '</div>' +
      '<div class="iw-card"><h3>多智能体复盘讨论 <span class="iw-tag iw-t-ai">' + esc(AI_MARK) + '</span></h3>' +
        '<div class="iw-warn">⚠️ 12 技能排布、多空辩论、fact-audit 一票否决闸均为<b>设计态，尚未实现</b>。' +
        '本页不生成任何讨论结论、不编造复盘结果。</div>' +
        '<div class="iw-skill">' +
          ['① 事实冻结', '② 价量归因', '③ 资金归因', '④ 事件归因', '⑤ 宏观归因', '⑥ 风控复核',
           '⑦ Bull', '⑧ Bear', '⑨ fact-audit 确定性闸', '⑩ 反方质询', '⑪ 归纳员', '⑫ 白话转述'].map(function (x, i) {
             return '<span class="' + (i === 8 ? 'det' : '') + '">' + esc(x) + '</span>';
           }).join('') + '</div>' +
        '<p class="iw-note">第 ⑨ 步是纯确定性代码、不经过 LLM：所有论断先过 factId 核对，无事实编号的断言直接剔除。' +
        '这是「不能出现幻觉」的物理落点，而不是靠提示词请求模型别说错。</p></div>';
  }
  function renderAudit() {
    var j = D.journal || {}, L = j.lessonsList || [], rl = j.rules || {};
    var rows = L.length
      ? '<table class="iw-table"><thead><tr><th>维度</th><th>分组</th><th>统计结论（真实）</th><th>状态</th></tr></thead><tbody>' +
        L.map(function (x) {
          return '<tr><td>' + esc(x.dimLabel || x.dim) + '</td><td>' + esc(x.group) + '</td><td>' +
            esc(x.claim) + '</td><td>' + esc(x.status) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="iw-empty">当前没有待审经验。</div>';
    document.getElementById('iwd-audit').innerHTML =
      '<div class="iw-card"><h3>现有待审经验 <span class="n">只读展示 · 不调用审核 API</span></h3>' + rows +
        '<div style="margin-top:9px">' + srcOk('journal') + '</div>' +
        '<p class="iw-note">审核操作请继续使用原有「评估数据库与经验库」面板。本工作区<b>不重复实现</b>、不代做决策，' +
        '避免同一份数据被两处改写。</p></div>' +
      '<div class="iw-card"><h3>AI 提案队列 <span class="iw-tag iw-t-ai">' + esc(AI_MARK) + '</span></h3>' +
        '<div class="iw-empty">队列为空 —— 智能体后端尚未接入，不存在待审 AI 提案。此处不伪造条目。</div>' +
        '<div class="iw-flow" style="margin-top:10px"><span class="s">AI 提案</span><span class="a">→</span>' +
        '<span class="s">确定性反幻觉闸</span><span class="a">→</span><span class="s">人工采纳 / 驳回</span>' +
        '<span class="a">→</span><span class="s">journal 五段式</span><span class="a">→</span>' +
        '<span class="s">有界回流 ±2 分 / [0.8,1.25] / 不翻符号</span><span class="a">→</span>' +
        '<span class="s">回到 stocks.js 自动选股</span></div>' +
        '<p class="iw-note">闭环终点落在<b>原有</b>评分链路，这就是「沉淀又能用于判断」在同一个项目里合拢。</p></div>' +
      '<div class="iw-card"><h3>已生效规则（真实）</h3>' +
        '<div class="iw-row">' + kpi('规则条数', fmt(rl.count), 'rules.json') +
        kpi('版本', fmt(rl.version), '—') + kpi('更新时间', rl.updatedAt ?
          new Date(rl.updatedAt).toLocaleString('zh-CN') : '—', '—') + '</div></div>';
  }
  function renderSettings() {
    var cfg = {
      agents: {
        enabled: false,
        selection: '形态对标 TradingAgents / 实现用 Agent Skills 技能排布 / 模型统一 DeepSeek / 零新增依赖',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        quickModel: '<模型名配置化，启动时校验>',
        deepModel: '<模型名配置化，启动时校验>',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        allowExternal: false,
        externalScope: '仅脱敏事实账本；不发持仓明细',
        fallback: 'L0 纯确定性',
        judgeChain: '智能体永不进入 stocks.js 评分链路'
      }
    };
    document.getElementById('iwd-settings').innerHTML =
      '<div class="iw-card"><h3>智能体选型 · 唯一结论</h3>' +
        '<table class="iw-table"><thead><tr><th>层</th><th>结论</th><th>是否安装</th></tr></thead><tbody>' +
        '<tr><td>角色范式</td><td>TradingAgents：分析师 + 多空辩论 + 风控 + 决策记忆</td><td><span class="iw-tag iw-t-design">只借鉴</span></td></tr>' +
        '<tr><td>实现</td><td>自建 agentBus.js + skillRunner.js + 12 个 SKILL.md（role-as-skill）</td><td><span class="iw-tag iw-t-live">零新增依赖</span></td></tr>' +
        '<tr><td>模型</td><td>DeepSeek 薄适配器，quick / deep 分工，模型名配置化不写死</td><td><span class="iw-tag iw-t-design">设计态</span></td></tr>' +
        '<tr><td>判断链路</td><td>现有 stocks.js 确定性评分，智能体永不进入</td><td><span class="iw-tag iw-t-live">零改动</span></td></tr>' +
        '</tbody></table>' +
        '<p class="iw-note">LangGraph / CrewAI / AutoGen / AgentScope / Dify 均为 Python 或需独立部署，' +
        '装进来会把 21 模块零依赖 Node 拆成双运行时；TradingAgents 内核是让 LLM 做买卖决策，与项目铁律冲突。</p></div>' +
      '<div class="iw-card"><h3>config.agents 设计态预览 <span class="iw-tag iw-t-ai">' + esc(AI_MARK) + '</span></h3>' +
        '<div class="iw-mono-block">' + esc(JSON.stringify(cfg, null, 2)) + '</div>' +
        '<p class="iw-note">⚠️ 这是<b>设计态预览</b>，未写入 data/config.json、未读取密钥、未发起任何请求。' +
        'DeepSeek 模型名会随时间变化，必须配置化并在启动时校验；网上教程中的旧模型名不可写死。</p></div>' +
      '<div class="iw-card"><h3>隐私与降级边界</h3><ul class="iw-list">' +
        '<li>默认 <b>allowExternal:false</b>：脱敏事实账本是否发往外部 API 仍待你拍板。</li>' +
        '<li>密钥只进环境变量 <b>DEEPSEEK_API_KEY</b>，不落盘、不进日志、不显示在界面。</li>' +
        '<li>未配置 / 调用失败 → 自动降级 <b>L0 纯确定性</b>，两池、复盘、审核照常可用。</li>' +
        '<li>若不允许外发，只把 baseUrl 指向本地 Ollama 或自建兼容端点，技能排布一行不改。</li>' +
        '</ul></div>' +
      '<div class="iw-card"><h3>商用边界（合规提示，非法律意见）</h3>' +
        '<p class="iw-note">框架许可证基本不卡商用（CrewAI=MIT、AG2=Apache-2.0、TradingAgents=Apache-2.0、LangGraph=MIT 均已一手核验）；' +
        '真正需要优先处理的是<b>行情数据授权</b>——本项目全部行情来自东方财富公开接口，无官方商用授权；' +
        '以及模型 API 条款、证券投资建议业务资质。商业化前请法务逐项确认。</p></div>';
  }
  function render() {
    if (!built) return;
    try { renderChat(); } catch (e) { console.error(e); }
    try { renderFactors(); } catch (e) { console.error(e); }
    try { renderLessons(); } catch (e) { console.error(e); }
    try { renderReview(); } catch (e) { console.error(e); }
    try { renderAudit(); } catch (e) { console.error(e); }
    try { renderSettings(); } catch (e) { console.error(e); }
  }

  /* 对外暴露：navplan.js 抽屉的增量项直接打开本工作区对应视图 */
  window.Interaction = {
    open: open,
    close: close,
    refresh: function () { loadAll(); },
    map: INC_MAP
  };
})();
