/* shell.js — 主界面壳（纯增量，零字节改动 app.js / styles.css / server/*.js / interaction.js / navplan.js）
 *
 * 目标：交互工作区默认作为「主界面」；全球监测 17 个面板收进左侧分组导航。
 * 手段：只操作运行时 DOM 与 body class，不写 storage、不建 EventSource、不调用任何 POST/写接口。
 * 兼容：接管 interaction.js / navplan.js 里会「关闭浮层」的入口，统一改为模式切换，避免界面空白。
 * 回退：删掉 index.html 里 /shell.css 与 /shell.js 两行即完全恢复原状。
 * 反幻觉：导航项全部对应 index.html 真实存在的面板 h2 前缀；不编造任何数值与能力。
 */
(function () {
  'use strict';

  /* 17 个真实面板，按任务分组（h2 文本前缀，与 index.html 一致） */
  var GROUPS = [
    { g: '① 全球监测 · 实时态势', items: [
      ['核心监测', '📡'], ['扩展指标', '📈'], ['走势监测', '📉'], ['新闻解读', '📰'],
      ['全球新闻', '🌐'], ['告警中心', '🔔'], ['数据源状态', '🔌']
    ]},
    { g: '② 选股与因子', items: [
      ['当日观察池', '🎯'], ['我的选股', '✍'], ['A 股量能与市值风格', '🏛'], ['涨停结构与市场情绪', '🧱'],
      ['涨停归因 · 事实卡', '🧾'],
      ['市场状态与事件驱动', '⚡'], ['评分有效性自检', '🧪']
    ]},
    { g: '③ 持仓与风控', items: [
      ['持仓监控', '💼'], ['资金主体与避险识别', '💰']
    ]},
    { g: '④ 研究与闭环', items: [
      ['评估数据库与经验库', '📚'], ['周期事件日历', '🗓'], ['预期研究与多因素叠加', '🧭']
    ]}
  ];
  /* navplan.js 的 4 个「原有系统」项 → 面板前缀 */
  var NAV_TARGET = { '监控总览': '核心监测', '自动选股': '当日观察池', '我的持仓': '持仓监控', '研究看板': '评估数据库与经验库' };

  var mode = 'interaction', opened = false, injected = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function findPanel(title) {
    var hs = document.querySelectorAll('.app .panel-head h2');
    for (var i = 0; i < hs.length; i++) {
      var t = (hs[i].textContent || '').trim();
      if (t.indexOf(title) === 0) {
        var s = hs[i].closest ? hs[i].closest('section') : null;
        if (s) return s;
        var p = hs[i].parentElement;
        return (p && p.parentElement) || null;
      }
    }
    return null;
  }

  /* ---------- 顶部模式切换条 ---------- */
  function buildSwitch() {
    if (document.getElementById('gmSwitch')) return;
    var d = document.createElement('div');
    d.className = 'gm-switch'; d.id = 'gmSwitch';
    d.innerHTML =
      '<span class="gm-logo">全球市场监测与报警系统</span>' +
      '<div class="gm-tabs">' +
        '<button class="gm-tab" id="gmToMain" data-gm="main"><span class="gm-dot"></span>交互工作区 · 主界面</button>' +
        '<button class="gm-tab monitor" id="gmToMon" data-gm="monitor"><span class="gm-dot"></span>全球监测 · 17 面板</button>' +
      '</div><span class="gm-sp"></span>' +
      '<span class="gm-hint">一个项目 · 同一 8777 · 真实数据 · L0 确定性（未接 LLM）</span>' +
      '<button class="gm-set" id="gmSettings" title="打开原有告警设置抽屉">告警设置</button>' +
      '<button class="gm-back" id="gmBack">← 返回交互主界面</button>';
    document.body.appendChild(d);
    d.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-gm]') : null;
      if (!b) return;
      if (b.getAttribute('data-gm') === 'main') setMode('interaction');
      else setMode('monitor');
    });
    /* 复用原有设置抽屉（#settings 在 .app 之外，不受隐藏影响），不重写任何配置逻辑 */
    document.getElementById('gmSettings').addEventListener('click', function () {
      var bs = document.getElementById('btnSettings');
      if (bs) bs.click();
    });
    document.getElementById('gmBack').addEventListener('click', function () { setMode('interaction'); });
  }

  /* ---------- 注入：把 17 个面板拆进交互主界面的左侧导航 ---------- */
  function injectMonitorNav() {
    var side = document.querySelector('#iwShell .iw-side');
    if (!side || document.getElementById('gmNav')) return;
    var labels = side.querySelectorAll('.iw-side-label');
    var anchor = null;
    for (var i = 0; i < labels.length; i++) {
      if ((labels[i].textContent || '').indexOf('原有系统') >= 0) { anchor = labels[i]; break; }
    }
    /* 隐藏 interaction.js 原本那 4 个粗粒度跳转项，改由 17 项分组导航接管 */
    var olds = side.querySelectorAll('.iw-nav[data-act="origin"]');
    for (var j = 0; j < olds.length; j++) olds[j].style.display = 'none';
    if (anchor) anchor.textContent = '⑤ 全球监测 · 导航（17 个面板，点击进入）';

    var h = '<div id="gmNav">';
    GROUPS.forEach(function (grp) {
      h += '<div class="gm-group">' + esc(grp.g) + '</div>';
      grp.items.forEach(function (it) {
        h += '<button class="gm-nav" data-gm-panel="' + esc(it[0]) + '">' +
             '<span class="gm-ico">' + it[1] + '</span><span>' + esc(it[0]) + '</span></button>';
      });
    });
    h += '<div class="gm-group" style="padding-top:14px;letter-spacing:0;font-weight:400;line-height:1.6">' +
         '以上面板均为原有系统真实功能，点击进入后平滑定位；不新建视图、不改动任何评分或配置。' +
         '</div></div>';
    if (anchor) anchor.insertAdjacentHTML('afterend', h);
    else side.insertAdjacentHTML('beforeend', h);

    document.getElementById('gmNav').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-gm-panel]') : null;
      if (b) gotoPanel(b.getAttribute('data-gm-panel'));
    });
    injected = true;
  }

  /* ---------- 模式切换 ---------- */
  function setMode(m, view) {
    mode = m;
    document.body.classList.add('gm-on');
    document.body.classList.toggle('mode-interaction', m === 'interaction');
    document.body.classList.toggle('mode-monitor', m === 'monitor');
    var a = document.getElementById('gmToMain'), b = document.getElementById('gmToMon');
    if (a) a.classList.toggle('on', m === 'interaction');
    if (b) b.classList.toggle('on', m === 'monitor');
    if (m === 'interaction') {
      if (window.Interaction && typeof window.Interaction.open === 'function') {
        window.Interaction.open(view || 'chat');
        opened = true;
      }
      injectMonitorNav();
      /* 主界面下把「返回原有仪表盘」按钮语义改为「查看全球监测总览」 */
      var cb = document.querySelector('#iwShell [data-act="close"]');
      if (cb) cb.textContent = '全球监测总览 →';
    } else {
      var sh = document.getElementById('iwShell');
      if (sh) sh.classList.remove('show');
      var mk = document.getElementById('iwMask');
      if (mk) mk.classList.remove('show');
    }
  }

  function gotoPanel(title) {
    setMode('monitor');
    setTimeout(function () {
      var p = findPanel(title);
      if (!p) return;
      p.scrollIntoView({ behavior: 'smooth', block: 'start' });
      p.classList.add('gm-flash');
      setTimeout(function () { p.classList.remove('gm-flash'); }, 2200);
    }, 80);
  }

  /* ---------- 捕获阶段接管：避免「关掉浮层」导致空白、保证老入口照常可用 ---------- */
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (t) {
      var act = t.getAttribute('data-act');
      if (act === 'close') { e.stopPropagation(); e.preventDefault(); setMode('monitor'); return; }
      if (act === 'origin') {
        e.stopPropagation(); e.preventDefault();
        gotoPanel(t.getAttribute('data-target') || '核心监测');
        return;
      }
      if (act === 'theme') {
        e.stopPropagation(); e.preventDefault();
        var sh = document.getElementById('iwShell');
        if (sh) {
          var dark = sh.classList.toggle('iw-dark');
          document.body.classList.toggle('gm-dark', dark);
        }
        return;
      }
    }
    /* navplan 抽屉里的项 */
    var n = e.target && e.target.closest ? e.target.closest('.np-item') : null;
    if (n) {
      var g = n.getAttribute('data-group'), name = n.getAttribute('data-name');
      if (g === 'origin') { e.stopPropagation(); e.preventDefault(); gotoPanel(NAV_TARGET[name] || '核心监测'); return; }
      if (g === 'inc' || (g === 'set' && name === '智能体设置')) {
        e.stopPropagation(); e.preventDefault(); setMode('interaction', name); return;
      }
    }
    /* 原顶栏 / 状态带上的工作区入口 */
    var id = e.target && e.target.id;
    if (id === 'btnWorkspace' || id === 'btnPlanOpenBar') {
      e.stopPropagation(); e.preventDefault(); setMode('interaction', 'chat'); return;
    }
  }, true);

  /* Escape 在主界面下改为切到监测，而不是关掉浮层留下空白 */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.body.classList.contains('mode-interaction')) {
      e.stopImmediatePropagation(); e.preventDefault(); setMode('monitor');
    }
  }, true);

  /* ---------- 初始化：默认交互主界面 ---------- */
  function init() {
    buildSwitch();
    var forceMonitor = /[?&]view=monitor(?:&|$)/.test(location.search);
    setMode(forceMonitor ? 'monitor' : 'interaction', 'chat');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
