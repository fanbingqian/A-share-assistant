/* ============================================================
 * markdown-lite.js — 智能体回复的轻量 Markdown 渲染（零依赖）
 *
 * 设计：转义优先（先 esc 再解析），所有内容都当作不可信文本处理，
 * 不执行任何 HTML；只输出有限的白名单标签，避免 XSS。
 * 支持：标题 / 有序无序列表 / 加粗 / 行内代码 / 代码块 / 引用 /
 *       分隔线 / 表格 / 「依据：…」取证行 / 段落。
 * 暴露：window.MarkdownLite.render(text) -> HTML 字符串
 * ============================================================ */
(function (global) {
  'use strict';

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }

  /* 行内格式：先占位保护行内代码，再转义，再加粗，最后还原代码块 */
  function inline(raw) {
    var codes = [];
    var s = String(raw == null ? '' : raw);
    // 行内代码占位（内容稍后单独 esc）
    s = s.replace(/`([^`]+)`/g, function (_, c) {
      codes.push('<code class="md-code">' + esc(c) + '</code>');
      return '\u0001' + (codes.length - 1) + '\u0001';
    });
    s = esc(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong class="md-strong">$1</strong>');
    s = s.replace(/\u0001(\d+)\u0001/g, function (_, i) { return codes[+i] || ''; });
    return s;
  }

  var RE_H = /^(#{1,4})\s+(.*)$/;
  var RE_UL = /^\s*[-*•]\s+(.*)$/;
  var RE_OL = /^\s*\d+[.)、]\s*(.*)$/;
  var RE_QUOTE = /^\s*>\s?(.*)$/;
  var RE_HR = /^\s*(---+|\*\*\*+|___+)\s*$/;
  var RE_FENCE = /^\s*```/;
  var RE_BASIS = /^\s*(依据|数据来源|来源|取证)[:：]/;
  var RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

  function isTableRow(l) { return /\s\|/.test(l) || /^\s*\|/.test(l); }
  function cells(l) {
    var t = l.trim().replace(/^\|/, '').replace(/\|$/, '');
    return t.split('|').map(function (c) { return c.trim(); });
  }

  function render(text) {
    var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    var out = [], i = 0;

    function flushPara(buf) {
      if (!buf.length) return;
      out.push('<p class="md-p">' + inline(buf.join(' ')) + '</p>');
      buf.length = 0;
    }
    function flushList(buf, type) {
      if (!buf.length) return;
      out.push('<' + type + ' class="md-list">' +
        buf.map(function (x) { return '<li>' + x + '</li>'; }).join('') +
        '</' + type + '>');
      buf.length = 0;
    }

    var para = [], list = [], listType = null, quote = [];

    function flushAll() {
      flushPara(para);
      flushList(list, listType || 'ul');
      listType = null;
      if (quote.length) {
        out.push('<blockquote class="md-quote">' + inline(quote.join(' ')) + '</blockquote>');
        quote.length = 0;
      }
    }

    while (i < lines.length) {
      var l = lines[i];

      // 代码块（整段吞掉，内容仅 esc）
      if (RE_FENCE.test(l)) {
        flushAll();
        var lang = l.replace(/^\s*```/, '').trim();
        var buf = [];
        i++;
        while (i < lines.length && !RE_FENCE.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) i++; // 跳过收尾 ```
        out.push('<div class="md-prewrap"><pre class="md-pre"><code>' + esc(buf.join('\n')) + '</code></pre></div>');
        continue;
      }

      // 表格
      if (isTableRow(l) && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
        flushAll();
        var head = cells(l);
        i += 2;
        var rows = [];
        while (i < lines.length && isTableRow(lines[i]) && lines[i].trim()) {
          rows.push(cells(lines[i])); i++;
        }
        var th = head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('');
        var tb = rows.map(function (r) {
          return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>';
        }).join('');
        out.push('<div class="md-tablewrap"><table class="md-table"><thead><tr>' + th + '</tr></thead><tbody>' + tb + '</tbody></table></div>');
        continue;
      }

      var m;
      // 分隔线
      if (RE_HR.test(l)) { flushAll(); out.push('<hr class="md-hr">'); i++; continue; }
      // 标题
      if ((m = RE_H.exec(l))) {
        flushAll();
        var lv = Math.min(4, m[1].length + 1); // # -> h2，避免和页面 h1 冲突
        out.push('<h' + lv + ' class="md-h md-h' + lv + '">' + inline(m[2]) + '</h' + lv + '>');
        i++; continue;
      }
      // 依据 / 取证行：单独做成溯源 chip
      if (RE_BASIS.test(l)) {
        flushAll();
        out.push('<div class="md-basis"><span class="md-basis-tag">依据</span>' +
          inline(l.replace(RE_BASIS, '')) + '</div>');
        i++; continue;
      }
      // 引用
      if ((m = RE_QUOTE.exec(l))) {
        flushPara(para); flushList(list, listType || 'ul'); listType = null;
        quote.push(m[1]); i++; continue;
      }
      if (quote.length) {
        out.push('<blockquote class="md-quote">' + inline(quote.join(' ')) + '</blockquote>');
        quote.length = 0;
      }
      // 列表
      var ul = RE_UL.exec(l), ol = RE_OL.exec(l);
      if (ul || ol) {
        flushPara(para);
        var t = ol ? 'ol' : 'ul';
        if (listType && listType !== t) { flushList(list, listType); }
        listType = t;
        list.push(inline((ul || ol)[1]));
        i++; continue;
      }
      if (list.length) { flushList(list, listType || 'ul'); listType = null; }
      // 空行 = 段落分隔
      if (!l.trim()) { flushPara(para); i++; continue; }
      para.push(l.trim());
      i++;
    }
    flushAll();
    return out.join('');
  }

  global.MarkdownLite = { render: render, esc: esc };
})(window);
