/* focus.js — 选股聚焦模式（纯增量，可逆）
 *
 * 用户诉求：把监控内容大部分隐藏，只显示「当日关注股池」与「我的选股」。
 * 实现约束：
 *  - 只隐藏 DOM，不停止任何采集/评分/定时器，原有功能一个不丢；
 *  - 不修改 app.js / styles.css / server/*.js 的任何既有逻辑，去掉本文件引用即完全回退；
 *  - 提供「显示全部监控」开关，随时恢复 18 个面板；选择记在 localStorage；
 *  - 「我的选股」是本次新建的面板，与「当日观察池」（系统自动选股）并列。
 */
(function () {
  'use strict';

  var KEY = 'gm.focus.mode';
  var KEEP = ['当日观察池', '我的选股'];
  var injected = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function isFocus() {
    try { return localStorage.getItem(KEY) !== 'all'; } catch (e) { return true; }
  }

  function setMode(all) {
    try { localStorage.setItem(KEY, all ? 'all' : 'focus'); } catch (e) { /* 隐私模式忽略 */ }
    apply();
  }

  function firstText(h) {
    if (!h) return '';
    for (var i = 0; i < h.childNodes.length; i++) {
      if (h.childNodes[i].nodeType === 3) {
        var t = (h.childNodes[i].textContent || '').trim();
        if (t) return t;
      }
    }
    return (h.textContent || '').trim();
  }

  function panelTitle(sec) {
    return firstText(sec.querySelector('.panel-head h2'));
  }

  function markPanels() {
    var secs = document.querySelectorAll('.app .panel');
    var kept = 0, hidden = 0;
    for (var i = 0; i < secs.length; i++) {
      var t = panelTitle(secs[i]);
      var keep = KEEP.some(function (k) { return t.indexOf(k) === 0; });
      secs[i].classList.toggle('focus-keep', keep);
      if (keep) kept++; else hidden++;
    }
    /* 导航项同步收敛：只留两个入口 */
    var navs = document.querySelectorAll('.gm-nav[data-gm-panel]');
    for (var j = 0; j < navs.length; j++) {
      var name = navs[j].getAttribute('data-gm-panel') || '';
      navs[j].classList.toggle('focus-keep', KEEP.some(function (k) { return name.indexOf(k) === 0; }));
    }
    return { kept: kept, hidden: hidden };
  }

  function injectBanner() {
    if (document.getElementById('focusBanner')) return;
    var host = document.querySelector('.app');
    if (!host) return;
    var d = document.createElement('div');
    d.className = 'focus-banner';
    d.id = 'focusBanner';
    /* 用 firstChild 而不是 querySelector('.panel')：面板不一定是直接子节点，
       insertBefore 的参照节点必须是 host 的直接子节点，否则抛 NotFoundError。 */
    try { host.insertBefore(d, host.firstChild || null); }
    catch (e) { try { host.appendChild(d); } catch (_) { /* 容器异常时不阻断其余逻辑 */ } }
  }

  function updateBanner(counts) {
    var el = document.getElementById('focusBanner');
    if (!el) return;
    var on = isFocus();
    el.style.display = on ? '' : 'none';
    if (!on) return;
    el.innerHTML = '<b>选股聚焦视图</b>'
      + '<span>只显示「当日关注股池」与「我的选股」两个面板；其余 '
      + (counts.hidden || 16) + ' 个监控面板已隐藏（仍在后台采集与刷新，未删除、未停用）。</span>'
      + '<span class="fb-sp"></span>'
      + '<button id="focusShowAll">显示全部监控</button>';
    var b = document.getElementById('focusShowAll');
    if (b) b.addEventListener('click', function () { setMode(true); });
  }

  function injectSwitch() {
    if (injected) return;
    var sw = document.getElementById('gmSwitch');
    if (!sw) return false;
    var btn = document.createElement('button');
    btn.className = 'gm-focus-btn';
    btn.id = 'focusToggle';
    sw.appendChild(btn);
    btn.addEventListener('click', function () { setMode(isFocus()); });
    injected = true;
    return true;
  }

  function updateSwitch() {
    var btn = document.getElementById('focusToggle');
    if (!btn) return;
    var on = isFocus();
    btn.textContent = on ? '显示全部监控' : '收敛为选股视图';
    btn.classList.toggle('on', on);
    btn.title = on ? '当前为聚焦视图，点击显示全部监控面板' : '当前显示全部监控，点击收敛为两个选股面板';
  }

  function apply() {
    var on = isFocus();
    document.body.classList.toggle('focus-on', on);
    var counts = markPanels();

    /* 关键：聚焦模式必须落在监测模式，否则 .app 整体被 mode-interaction 隐藏，
       两个保留面板用户根本看不见。放在最前面，且不被后续渲染异常阻断。 */
    if (on) {
      var toMon = document.getElementById('gmToMon');
      if (toMon && document.body.className.indexOf('mode-monitor') < 0) {
        try { toMon.click(); } catch (e) { /* 顶栏尚未就绪时由 boot 的重试补上 */ }
      }
    }

    try { injectBanner(); } catch (e) { /* 单点失败不影响开关 */ }
    try { updateBanner(counts); } catch (e) { /* 同上 */ }
    try { updateSwitch(); } catch (e) { /* 同上 */ }
  }

  function boot() {
    /* shell.js 的顶栏是动态生成的，等它出现后再挂开关 */
    if (!injectSwitch()) { setTimeout(boot, 180); return; }
    apply();
    /* 导航抽屉可能被 shell.js 重绘，轻量补一次 */
    setTimeout(apply, 600);
    window.addEventListener('hashchange', function () { setTimeout(apply, 50); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 60); });
  } else {
    setTimeout(boot, 60);
  }
})();
