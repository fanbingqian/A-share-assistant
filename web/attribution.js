/* attribution.js — 涨停归因事实卡渲染（纯增量；不改 app.js / interaction.js / navplan.js）
 *
 * 只做三件事：取数 → 渲染事实 → 提供手动重抓。
 * 不写任何因果判断，不做评分，不写配置。无素材的股票显式留空并说明，不补全、不推测。
 */
(function () {
  'use strict';

  var API = '/api/attribution';
  var REFRESH = '/api/attribution/refresh';

  var els = {};
  var data = null;
  var timer = null;
  var busy = false;
  var expanded = {};
  var pollUntil = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function num(v, d) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    return n.toFixed(d == null ? 2 : d);
  }

  function hhmm(ts) {
    var d = new Date(Number(ts) || 0);
    if (!isFinite(d.getTime())) return '—';
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function kindBadge(b) {
    if (!b) return '';
    var pct = Number(b.pct);
    var sign = isFinite(pct) && pct > 0 ? '+' : '';
    if (b.kind === 'zt') return '<span class="attr-badge zt">涨停 ' + sign + num(pct, 2) + '%</span>';
    if (b.kind === 'zb') return '<span class="attr-badge zb">炸板 ' + num(pct, 2) + '%</span>';
    if (b.kind === 'dt') return '<span class="attr-badge dt">跌停 ' + num(pct, 2) + '%</span>';
    return '';
  }

  function kvLine(b) {
    if (!b) return '';
    var out = [];
    if (b.statLabel) out.push('<span><i>连板</i><b>' + esc(b.statLabel) + '</b></span>');
    if (b.sealFundYi != null) {
      out.push('<span><i>封单</i><b>' + num(b.sealFundYi, 2) + '亿</b>'
        + (b.sealRatio != null ? '（占流通 ' + num(b.sealRatio, 2) + '%）' : '') + '</span>');
    }
    if (b.firstSealLabel) out.push('<span><i>首封</i><b>' + esc(b.firstSealLabel) + '</b></span>');
    if (b.breakCount != null) out.push('<span><i>开板</i><b>' + b.breakCount + ' 次</b></span>');
    if (b.turnover != null) out.push('<span><i>换手</i><b>' + num(b.turnover, 2) + '%</b></span>');
    if (b.floatCapYi != null) out.push('<span><i>流通</i><b>' + num(b.floatCapYi, 1) + '亿</b></span>');
    if (b.failDepth != null) out.push('<span><i>距涨停</i><b>' + num(b.failDepth, 2) + '%</b></span>');
    return out.length ? '<div class="attr-kv">' + out.join('') + '</div>' : '';
  }

  function rulesHtml(rules) {
    if (!rules || !rules.length) return '';
    var spec = rules.filter(function (r) { return !r.common; }).slice(0, 4);
    var comm = rules.filter(function (r) { return r.common; }).slice(0, 2);
    var all = spec.concat(comm);
    return '<div class="attr-rules">' + all.map(function (r) {
      var tip = '标题命中「' + r.kw + '」· ' + (r.from || '')
        + (r.date ? ' ' + r.date : '')
        + (r.common ? ' · 本批 ' + r.share + '% 命中，属普遍事项' : ' · 本批 ' + r.share + '% 命中');
      return '<span class="attr-rule' + (r.common ? ' common' : '') + '" title="' + esc(tip) + '">'
        + esc(r.label) + '<em>' + esc(r.kw) + '</em></span>';
    }).join('') + '</div>';
  }

  function annHtml(list, code, isOpen) {
    if (!list || !list.length) return '';
    var limit = isOpen ? list.length : 4;
    var rows = list.slice(0, limit).map(function (a) {
      return '<li><span class="attr-date">' + esc(a.date || '—') + '</span>'
        + (a.column ? '<span class="attr-col">' + esc(a.column) + '</span>' : '')
        + '<a href="' + esc(a.link) + '" target="_blank" rel="noopener noreferrer">'
        + esc(a.title) + '</a></li>';
    }).join('');
    var more = list.length > limit
      ? '<button class="attr-more" data-more="' + esc(code) + '">展开全部 ' + list.length + ' 条公告</button>'
      : (isOpen && list.length > 4
        ? '<button class="attr-more" data-more="' + esc(code) + '">收起</button>' : '');
    return '<div class="attr-sec-t">公告原文 · 近 120 天</div><ul class="attr-list">' + rows + '</ul>' + more;
  }

  function newsHtml(list) {
    if (!list || !list.length) return '';
    return '<div class="attr-sec-t">相关新闻标题</div><ul class="attr-list">'
      + list.slice(0, 4).map(function (n) {
        return '<li><span class="attr-date">' + esc(n.date || '—') + '</span>'
          + '<a href="' + esc(n.url) + '" target="_blank" rel="noopener noreferrer">'
          + esc(n.title) + '</a></li>';
      }).join('') + '</ul>';
  }

  function card(it) {
    var b = it.board || {};
    var isOpen = !!expanded[it.code];
    var noSrc = it.status === 'no-source';
    var h = '<article class="attr-card' + (noSrc ? ' no-src' : '') + (isOpen ? ' open' : '') + '">';
    h += '<div class="attr-head">'
      + '<span class="attr-code">' + esc(it.code) + '</span>'
      + '<span class="attr-name">' + esc(it.name) + '</span>'
      + '<span class="attr-ind">' + esc(it.industry || '—') + '</span>'
      + '<span class="attr-sp"></span>' + kindBadge(b) + '</div>';
    h += kvLine(b);
    h += rulesHtml(it.rules);
    h += annHtml(it.announcements, it.code, isOpen);
    h += newsHtml(it.news);
    if (it.annError) {
      h += '<div class="attr-empty-line">公告接口本次未返回（可能触发限流）。可点右上「重新抓取」重试。</div>';
    } else if (noSrc) {
      h += '<div class="attr-empty-line">未检索到该股近期公开公告与新闻。<b>不做任何推测</b>。</div>';
    }
    h += '</article>';
    return h;
  }

  function sumHtml(v) {
    var c = v.coverage || {};
    var pool = v.pool || {};
    var parts = [];
    parts.push('<span>扫描涨停 <b>' + (c.scanned || 0) + '</b> 只</span>');
    parts.push('<span>有公告 <b>' + (c.withAnn || 0) + '</b></span>');
    parts.push('<span>有新闻 <b>' + (c.withNews || 0) + '</b></span>');
    parts.push(c.none ? '<span class="warn">无素材 <b>' + c.none + '</b></span>'
      : '<span class="dim">无素材 <b>0</b></span>');
    if (c.annErrors) parts.push('<span class="warn">公告失败 <b>' + c.annErrors + '</b></span>');
    parts.push('<span class="dim">炸板池 <b>' + (pool.zb || 0) + '</b> 只（仅盘口）</span>');
    parts.push('<span class="dim">跌停 <b>' + (pool.dt || 0) + '</b> 只</span>');
    parts.push('<span class="dim">覆盖 <b>' + (c.pct || 0) + '%</b></span>');
    return parts.join('');
  }

  function ruleStatHtml(stat) {
    if (!stat || !stat.length) return '';
    var rows = stat.slice(0, 8).map(function (r) {
      return '<div class="attr-rs-row">'
        + '<span class="attr-rs-label" title="' + esc(r.label) + '">' + esc(r.label) + '</span>'
        + '<span class="attr-rs-bar"><span class="attr-rs-fill' + (r.common ? ' common' : '')
        + '" style="width:' + Math.min(100, r.share) + '%"></span></span>'
        + '<span class="attr-rs-val">' + r.hits + ' 只 · ' + r.share + '%'
        + (r.common ? ' 普遍' : '') + '</span></div>';
    }).join('');
    return '<div class="attr-rs-head"><b>规则命中普遍性</b>'
      + '<span>命中占比 ≥60% 视为普遍事项（如季度报告），不具区分度，已弱化显示</span></div>'
      + rows;
  }

  function render() {
    if (!els.body) return;
    if (!data) { els.body.innerHTML = '<div class="empty">正在获取事实卡…</div>'; return; }
    if (data.ok === false) {
      els.body.innerHTML = '<div class="empty">事实卡暂不可用：' + esc(data.error || '未知原因')
        + '。涨停池就绪后会自动重试。</div>';
      if (els.sum) els.sum.innerHTML = '';
      if (els.rs) els.rs.innerHTML = '';
      return;
    }
    if (!data.items || !data.items.length) {
      els.body.innerHTML = '<div class="empty">当日没有涨停股，或涨停池尚未采集。等待 3 分钟刷新周期。</div>';
      return;
    }
    if (els.sum) els.sum.innerHTML = sumHtml(data);
    els.body.innerHTML = data.items.map(card).join('');
    if (els.rs) {
      els.rs.innerHTML = ruleStatHtml(data.ruleStat);
      els.rs.style.display = (data.ruleStat && data.ruleStat.length) ? '' : 'none';
    }
    if (els.dis) {
      els.dis.innerHTML = '<b>免责声明</b>：' + esc(data.disclaimer || '')
        + '<div class="attr-note">' + esc(data.note || '') + '</div>';
    }
    if (els.time) {
      var t = '更新于 ' + hhmm(data.builtAt) + ' · ' + esc(data.date || '');
      els.time.textContent = t;
    }
  }

  function load() {
    return fetch(API, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) { data = j && j.data; render(); })
      .catch(function (e) {
        if (els.body) els.body.innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>';
      });
  }

  function doRefresh() {
    if (busy) return;
    busy = true;
    if (els.btn) { els.btn.disabled = true; els.btn.textContent = '抓取中…'; }
    fetch(REFRESH, { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function () {
        pollUntil = Date.now() + 120000;
        var tick = setInterval(function () {
          if (Date.now() > pollUntil) {
            clearInterval(tick);
            busy = false;
            if (els.btn) { els.btn.disabled = false; els.btn.textContent = '重新抓取'; }
            return;
          }
          load().then(function () {
            if (data && data.builtAt && Date.now() - data.builtAt < 150000) {
              clearInterval(tick);
              busy = false;
              if (els.btn) { els.btn.disabled = false; els.btn.textContent = '重新抓取'; }
            }
          });
        }, 5000);
      })
      .catch(function () {
        busy = false;
        if (els.btn) { els.btn.disabled = false; els.btn.textContent = '重新抓取'; }
      });
  }

  function init() {
    els.body = document.getElementById('attrBody');
    if (!els.body) return;
    els.sum = document.getElementById('attrSum');
    els.rs = document.getElementById('attrRuleStat');
    els.dis = document.getElementById('attrDisclaimer');
    els.time = document.getElementById('attrTime');
    els.btn = document.getElementById('attrRefresh');

    if (els.btn) els.btn.addEventListener('click', doRefresh);

    els.body.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-more]') : null;
      if (!b) return;
      var code = b.getAttribute('data-more');
      expanded[code] = !expanded[code];
      render();
    });

    load();
    timer = setInterval(function () {
      if (document.hidden || busy) return;
      load();
    }, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
