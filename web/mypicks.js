/* mypicks.js — 「我的选股」面板（纯增量，不触碰 app.js / interaction.js / navplan.js） */
(function () {
  'use strict';

  var API = '/api/mypicks';
  var els = {};
  var data = null;
  var lookupSeq = 0;
  var recognized = null;   // 最近一次识别结果 {code,name,price,changePct,market,source}

  function clearRecognized() {
    recognized = null;
    if (els.hint) { els.hint.textContent = ''; els.hint.className = 'mp-lookup-hint'; }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hhmm(ts) {
    var d = new Date(Number(ts) || 0);
    if (!isFinite(d.getTime())) return '—';
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  function card(it, overlap, outcomes) {
    var inPool = overlap.indexOf(it.code) >= 0;
    var mine = outcomes.filter(function (o) { return o.code === it.code; });
    var h = '<div class="mp-card"><div class="mp-head">';
    h += '<span class="mp-code">' + esc(it.code) + '</span>';
    h += '<span class="mp-name' + (it.name ? '' : ' unknown') + '">'
      + esc(it.name || '未识别名称（本地缓存无此代码）') + '</span>';
    h += '<button class="mp-del" data-del="' + esc(it.code) + '">移除</button></div>';
    h += '<div style="margin-bottom:6px"><span class="mp-tag ' + (inPool ? 'inpool' : 'outpool') + '">'
      + (inPool ? '同时在当日观察池' : '不在当日观察池') + '</span></div>';
    if (it.note) h += '<p class="mp-note-text">' + esc(it.note) + '</p>';
    h += '<div class="mp-facts"><span>加入 <b>' + hhmm(it.addedAt) + '</b></span>'
      + '<span>来源 <b>手工</b></span></div>';
    if (mine.length) {
      h += '<div class="mp-outcomes">经验库复盘记录 <b>' + mine.length + '</b> 条：'
        + mine.slice(0, 3).map(function (o) {
          var r = (o.ret === null || o.ret === undefined) ? '—' : (Number(o.ret) >= 0 ? '+' : '') + Number(o.ret).toFixed(2) + '%';
          return esc(o.date || '—') + ' ' + r;
        }).join(' · ') + '</div>';
    } else {
      h += '<div class="mp-outcomes">经验库暂无该股复盘记录（人工选股尚未纳入 journal 定格复盘闭环）</div>';
    }
    return h + '</div>';
  }

  function render() {
    if (!els.body) return;
    if (!data) { els.body.innerHTML = '<div class="mp-empty">正在读取…</div>'; return; }
    var overlap = data.overlap || [];
    var outcomes = data.outcomes || [];
    els.meta.innerHTML = '<span>清单 <b>' + (data.count || 0) + '</b> 只</span>'
      + '<span' + (overlap.length ? ' class="hit"' : '') + '>与观察池重合 <b>' + overlap.length + '</b> 只</span>'
      + '<span>系统观察池 <b>' + (data.poolCount || 0) + '</b> 只</span>'
      + '<span>复盘记录 <b>' + outcomes.length + '</b> 条</span>';
    els.time.textContent = data.updatedAt ? '更新于 ' + hhmm(data.updatedAt) : '尚未添加';
    if (!data.items || !data.items.length) {
      els.body.innerHTML = '<div class="mp-empty">清单为空。输入 6 位股票代码即可加入「我的选股」。'
        + '这里与系统自动生成的当日观察池彼此独立。</div>';
      return;
    }
    els.body.innerHTML = data.items.map(function (it) {
      return card(it, overlap, outcomes);
    }).join('');
  }

  function load() {
    return fetch(API, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) { data = j && j.data; render(); })
      .catch(function (e) {
        if (els.body) els.body.innerHTML = '<div class="mp-empty">读取失败：' + esc(e.message) + '</div>';
      });
  }

  function fmtPct(v) {
    if (v === null || v === undefined || !isFinite(Number(v))) return '';
    var x = Number(v);
    return (x >= 0 ? '+' : '') + x.toFixed(2) + '%';
  }

  function lookupCode() {
    var code = (els.code.value || '').trim();
    var seq = ++lookupSeq;
    clearRecognized();
    if (!/^[0-9]{6}$/.test(code)) {
      if (els.name.value.trim() === '') els.name.placeholder = '名称（自动识别，也可手填）';
      return;
    }
    if (els.hint) { els.hint.textContent = '正在识别 ' + code + '…'; els.hint.className = 'mp-lookup-hint loading'; }
    fetch('/api/stock/lookup?code=' + encodeURIComponent(code), { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (seq !== lookupSeq) return;   // 输入已变化，丢弃过期结果
        if (j && j.ok) {
          recognized = j;
          if (!els.name.value.trim()) els.name.value = j.name;   // 名称留空时自动填入，用户可改
          if (els.hint) {
            els.hint.className = 'mp-lookup-hint ok';
            els.hint.innerHTML = '<b>' + esc(j.name) + '</b> · ' + esc(j.market) +
              ' · 现价 <b>' + fmt(j.price) + '</b> · <span class="' +
              (Number(j.changePct) >= 0 ? 'up' : 'down') + '">' + fmtPct(j.changePct) + '</span>' +
              ' <span class="src">' + esc(j.source) + '</span>';
          }
        } else {
          if (els.hint) {
            els.hint.className = 'mp-lookup-hint warn';
            els.hint.textContent = '未识别：' + esc((j && j.reason) || '请核对代码');
          }
        }
      })
      .catch(function (e) {
        if (seq !== lookupSeq) return;
        if (els.hint) { els.hint.className = 'mp-lookup-hint warn'; els.hint.textContent = '识别失败：' + esc(e.message); }
      });
  }

  function doAdd() {
    var code = (els.code.value || '').trim();
    if (!/^[0-9]{6}$/.test(code)) { els.code.focus(); return; }
    var body = {
      code: code,
      name: (els.name.value || '').trim() || (recognized && recognized.code === code ? recognized.name : ''),
      note: (els.note.value || '').trim()
    };
    post(API + '/add', body).then(function (r) {
      if (r && r.data) { data = r.data; render(); }
      els.code.value = ''; els.name.value = ''; els.note.value = '';
      els.name.placeholder = '名称（自动识别，也可手填）';
      clearRecognized();
    });
  }

  function init() {
    els.body = document.getElementById('mpBody');
    if (!els.body) return;
    els.meta = document.getElementById('mpMeta');
    els.time = document.getElementById('mpTime');
    els.code = document.getElementById('mpCode');
    els.name = document.getElementById('mpName');
    els.note = document.getElementById('mpNote');
    els.hint = document.getElementById('mpLookupHint');

    document.getElementById('mpAdd').addEventListener('click', doAdd);
    els.code.addEventListener('keydown', function (e) { if (e.key === 'Enter') doAdd(); });
    els.note.addEventListener('keydown', function (e) { if (e.key === 'Enter') doAdd(); });
    // 输入满 6 位自动识别（每次输入变更多次触发也无害：用序号丢弃过期结果）
    els.code.addEventListener('input', lookupCode);
    document.getElementById('mpClear').addEventListener('click', function () {
      post(API + '/clear', {}).then(function (r) { if (r && r.data) { data = r.data; render(); } });
    });
    els.body.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-del]') : null;
      if (!b) return;
      post(API + '/remove', { code: b.getAttribute('data-del') })
        .then(function (r) { if (r && r.data) { data = r.data; render(); } });
    });

    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
