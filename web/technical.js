/* ==========================================================================
 * technical.js — P0 技术因子面板（只读渲染，纯增量）
 *
 * 只做两件事：GET /api/technical 渲染、POST /api/technical/refresh 触发重算。
 * 不改 app.js / styles.css / server 任何既有逻辑；不写任何业务数据。
 * 数据源不可达时渲染醒目告警 + 不编造数值，符合反幻觉纪律。
 * ========================================================================== */
(function () {
  'use strict';

  var BOX_ID = 'techBox';
  var API = '/api/technical';
  var POLL_MS = 5 * 60 * 1000;   // 页面可见时每 5 分钟轻量 GET（只读）
  var lastBuiltAt = 0;
  var busy = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v, n) {
    if (v == null || v === '' || (typeof v === 'number' && !isFinite(v))) return '—';
    if (typeof v === 'number') return v.toFixed(n == null ? 2 : n);
    return String(v);
  }
  function sideOf(f) {
    if (f.key === 'kdj') {
      if (f.value && f.value.cross === 'gold') return 'bull';
      if (f.value && f.value.cross === 'dead') return 'bear';
      return 'neutral';
    }
    var M = {
      breakMa5Two: 'bear', holdMa5NewHigh: 'bull', resilience: 'bull',
      tightRange: 'bull', phaseVolume: 'bull', capPercentile: 'neutral'
    };
    return M[f.key] || 'neutral';
  }
  function stateOf(f) {
    if (f.hit === null) return { cls: 'tf-na', text: '不可得' };
    if (f.hit === true) return { cls: 'tf-' + sideOf(f), text: '命中' };
    return { cls: 'tf-miss', text: '未命中' };
  }
  function valueText(f) {
    var v = f.value || {};
    switch (f.key) {
      case 'kdj':
        return v.cross === 'gold' ? 'K ' + num(v.k) + ' / D ' + num(v.d) + ' · 金叉'
          : v.cross === 'dead' ? 'K ' + num(v.k) + ' / D ' + num(v.d) + ' · 死叉'
            : 'K ' + num(v.k) + ' / D ' + num(v.d) + ' / J ' + num(v.j);
      case 'breakMa5Two':
        return '收 ' + num(v.todayClose) + ' vs MA5 ' + num(v.todayMa5);
      case 'holdMa5NewHigh':
        return '上影 ' + num(v.upperShadow) + ' · 前高 ' + num(v.high20Prev);
      case 'resilience':
        return '跌 ' + num(v.envDown, 0) + ' 家 · ' + (v.uptrendPos ? '趋势位置成立' : '趋势位置不足');
      case 'tightRange':
        return '振幅 ' + num(v.bandPct, 1) + '% · 红' + num(v.red, 0) + '绿' + num(v.green, 0);
      case 'phaseVolume':
        return '量比 ' + num(v.ratio) + '（近5/前5）';
      case 'capPercentile':
        return v.sampleN != null ? (num(v.floatCapYi, 1) + ' 亿 · 样本 n=' + num(v.sampleN, 0)) : '样本不足';
      default:
        return f.note || '—';
    }
  }
  function traceHtml(f) {
    var t = f.trace || {};
    var lines = Object.keys(t).map(function (k) {
      var val = t[k];
      if (val && typeof val === 'object') val = JSON.stringify(val);
      return esc(k) + '=' + esc(val);
    });
    return '<span class="tt-note">' + esc(f.note || '') + '</span>'
      + (lines.length ? '<code>验算依据：' + lines.join(' · ') + '</code>' : '');
  }

  function statusHtml(v) {
    var u = v.universe || {};
    var b = v.breadth;
    var h = '';
    h += '<span>构建 <b>' + esc(v.builtAtLabel || '—') + '</b></span>';
    h += '<span>日线 <b>' + esc(v.date || '—') + '</b></span>';
    h += '<span>标的 <b>' + num(u.count, 0) + '</b> 只</span>';
    h += '<span>日线成功 <b>' + num(u.barsOk, 0) + '</b> / 失败 <b>' + num(u.barsFail, 0) + '</b></span>';
    if (b) {
      h += '<span class="' + (b.isToday ? '' : 'warn') + '">全市场 涨 <b>' + num(b.up, 0)
        + '</b> / 跌 <b>' + num(b.down, 0) + '</b> / 平 <b>' + num(b.flat, 0) + '</b> · 快照 '
        + esc(b.dateLabel) + (b.isToday ? '' : '（非当日）') + '</span>';
      if (!b.isToday) h += '<span class="warn">环境快照非当日 → 抗压判据仅供参考</span>';
    } else {
      h += '<span class="warn">无全市场涨跌家数快照 → 抗压判据不可得</span>';
    }
    return h;
  }

  function rulesHtml(v) {
    var rs = v.ruleStat || [];
    if (!rs.length) return '';
    var h = '<div class="tech-sec-t">复盘触发规则（只读候选 · 未写入 outcomes.jsonl）</div><div class="tech-rules">';
    rs.forEach(function (r) {
      var na = (r.avail || 0) === 0;
      var cls = na ? 'na' : (r.hits > 0 ? 'hit' : '');
      var txt = na ? '全部不可得' : ('命中 ' + r.hits + ' / 可判 ' + r.avail);
      h += '<div class="tech-rule" title="' + esc(r.label) + '">'
        + '<span class="tr-n">' + esc(r.label) + '</span>'
        + '<span class="tr-spec">' + esc(r.id) + '</span>'
        + '<span class="tr-s ' + cls + '">' + esc(txt) + '</span></div>';
    });
    return h + '</div>';
  }

  function cardHtml(x) {
    var c = x.calc;
    var h = '<div class="tech-card' + (c ? '' : ' fail') + '">';
    h += '<div class="tech-chead"><span class="tech-code">' + esc(x.code) + '</span>'
      + '<span class="tech-name">' + esc(x.name || x.code) + '</span>'
      + (x.from || []).map(function (f) { return '<span class="tech-from">' + esc(f) + '</span>'; }).join('')
      + '<span class="tech-csp"></span>'
      + '<span class="tech-bars">' + (c ? (c.bars + ' 根日线') : ('日线 ' + num(x.bars, 0) + ' 根')) + '</span></div>';
    if (!c) {
      h += '<div class="tech-alert" style="margin:0"><b>数据源不可达</b>：' + esc(x.error || '日线不足，未计算任何因子')
        + '。<br>本模块不编造数值，网络恢复后点击「重算」即可。</div></div>';
      return h;
    }
    h += '<div class="tech-kv">'
      + '<span><i>末日</i><b>' + esc(c.lastDate) + '</b></span>'
      + '<span><i>收盘</i><b>' + num(c.lastClose) + '</b></span>'
      + '<span><i>涨跌</i><b>' + num(c.lastPct) + '%</b></span>'
      + '<span><i>MA5</i><b>' + num(c.ma5) + '</b></span>'
      + (x.industry ? '<span><i>行业</i><b>' + esc(x.industry) + '</b></span>' : '')
      + '</div><div class="tech-fgrid">';
    (c.factors || []).forEach(function (f) {
      var s = stateOf(f);
      h += '<div class="tech-f ' + s.cls + '" data-tf="1" title="点击查看验算依据">'
        + '<div class="tf-l">' + esc(f.label) + '</div>'
        + '<div class="tf-v">' + esc(valueText(f)) + '</div>'
        + '<span class="tf-s">' + esc(s.text) + '</span>'
        + '<div class="tech-trace">' + traceHtml(f) + '</div></div>';
    });
    return h + '</div></div>';
  }

  function industryHtml(v) {
    var a = v.industrySample || [];
    if (!a.length) return '';
    var multi = a.filter(function (x) { return x.n >= 2; }).length;
    return '<div class="tech-sec-t">行业市值样本（本地关注池，非全市场）</div>'
      + '<div class="tech-status"><span>行业数 <b>' + a.length + '</b></span>'
      + '<span>样本 n≥2 的行业 <b>' + multi + '</b></span>'
      + '<span class="' + (multi ? '' : 'warn') + '">' + (multi ? '部分行业可给出分位' : '每行业仅 1 只 → 市值分位不可得，不编造全市场均值')
      + '</span></div>';
  }

  function discHtml(v) {
    var d = v.disclaimer || [];
    if (!d.length) return '';
    return '<div class="tech-disc"><b>口径与边界</b><ul>'
      + d.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></div>';
  }

  function failureHtml(v, err) {
    var reasons = [];
    if (err) reasons.push('接口请求失败：' + err);
    if (v && v.error) reasons.push(esc(v.error));
    if (v && v.errors && v.errors.length) {
      v.errors.slice(0, 6).forEach(function (e) { reasons.push(esc(e.code) + '：' + esc(e.error)); });
    }
    var h = '<div class="tech-alert"><b>⚠ 数据源不可达 · P0 技术因子当前无可用数据</b>'
      + '<div>东方财富日线接口不可达或数据不足。按反幻觉纪律，本面板不编造任何因子值，也不显示空白表格。</div>'
      + (reasons.length ? '<ul>' + reasons.map(function (r) { return '<li>' + r + '</li>'; }).join('') + '</ul>' : '')
      + '<div>网络恢复后点击「重算」，或等待 30 分钟定时任务自动重试。</div></div>';
    /* 即便日线不可达，仍展示已核实的真实数据（全市场宽度 / 行业样本），
       让用户清楚「哪些有、哪些没有」，而不是一片空白。 */
    h += statusHtml(v || {});
    h += industryHtml(v || {});
    if (v && v.ruleStat && v.ruleStat.length) h += rulesHtml(v);
    h += discHtml(v || {});
    return h;
  }

  function render(v, err) {
    var box = document.getElementById(BOX_ID);
    if (!box) return;
    var btn = '<button class="tech-btn" id="techRefresh">重算</button>';
    var head = '<div class="tech-head"><span class="tech-title">P0 技术因子标注</span>'
      + '<span class="tech-badge ro">只读 · 不进评分</span>'
      + '<span class="tech-badge calc">8 项确定性因子</span>'
      + '<span class="tech-sp"></span>' + btn
      + '<button class="tech-btn" id="techToggle">收起</button></div>';

    var ok = v && v.ok !== false && (v.universe && v.universe.barsOk > 0);
    var body;
    if (!ok) {
      body = failureHtml(v, err);
    } else {
      body = '<div class="tech-status">' + statusHtml(v) + '</div>'
        + industryHtml(v)
        + rulesHtml(v)
        + '<div class="tech-sec-t">逐股因子（点徽标看验算依据）</div>'
        + '<div class="tech-grid">' + (v.items || []).map(cardHtml).join('') + '</div>'
        + discHtml(v);
    }
    box.className = 'tech-box' + (ok ? '' : ' tech-empty');
    box.innerHTML = head + '<div id="techBody">' + body + '</div>';
    lastBuiltAt = (v && v.builtAt) || 0;
    bind();
  }

  function bind() {
    var rf = document.getElementById('techRefresh');
    if (rf) rf.addEventListener('click', function () { refresh(); });
    var tg = document.getElementById('techToggle');
    if (tg) tg.addEventListener('click', function () {
      var b = document.getElementById('techBody');
      if (!b) return;
      var hidden = b.style.display === 'none';
      b.style.display = hidden ? '' : 'none';
      tg.textContent = hidden ? '收起' : '展开';
    });
    var box = document.getElementById(BOX_ID);
    /* 用 onclick 赋值而非 addEventListener：render 会重建 innerHTML 但 box 本身不换，
       反复 addEventListener 会累积多个处理器，导致一次点击 toggle 多次（偶数次相互抵消）。 */
    if (box) box.onclick = function (e) {
      var f = e.target.closest ? e.target.closest('[data-tf]') : null;
      if (f) f.classList.toggle('open');
    };
  }

  function load(silent) {
    return fetch(API, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { render(j.data || null, null); })
      .catch(function (e) { if (!silent) render(null, e.message); });
  }

  function refresh() {
    if (busy) return;
    busy = true;
    var b = document.getElementById('techRefresh');
    if (b) { b.disabled = true; b.textContent = '重算中…'; }
    fetch('/api/technical/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    }).then(function (r) { return r.json(); })
      .then(function () { return poll(lastBuiltAt, 0); })
      .catch(function (e) { render(null, e.message); })
      .then(function () {
        busy = false;
        var b2 = document.getElementById('techRefresh');
        if (b2) { b2.disabled = false; b2.textContent = '重算'; }
      });
  }

  /* POST 是异步的：服务端立即返回「已开始」，需轮询直到 builtAt 变化或超时 */
  function poll(old, tries) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        fetch(API, { cache: 'no-store' }).then(function (r) { return r.json(); })
          .then(function (j) {
            var v = j.data || null;
            if ((v && v.builtAt && v.builtAt !== old) || tries >= 14) { render(v, null); resolve(); }
            else poll(old, tries + 1).then(resolve);
          }).catch(function () { resolve(); });
      }, 1500);
    });
  }

  function init() {
    if (!document.getElementById(BOX_ID)) return;
    load(false);
    setInterval(function () {
      if (document.visibilityState === 'visible' && !busy) load(true);
    }, POLL_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
