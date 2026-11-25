'use strict';

/* 全球市场监测与报警系统 · 前端
   数据来源与时点全部随卡片展示；演示/自检告警明确标注为模拟数据。 */

const $ = id => document.getElementById(id);
const LEVEL_RANK = { info: 0, warning: 1, critical: 2 };
const LEVEL_TEXT = { info: '提示', warning: '警告', critical: '严重' };

const PRIMARY = ['gold', 'wti', 'ust10y', 'dxy'];
const SECONDARY = ['xau', 'brent', 'ust2y', 'ust30y', 'spread'];
const CHART_IDS = [
  { id: 'gold', label: 'COMEX黄金' }, { id: 'xau', label: '现货黄金' },
  { id: 'wti', label: 'WTI原油' }, { id: 'brent', label: '布伦特' },
  { id: 'ust10y', label: '美债10Y' }, { id: 'ust2y', label: '美债2Y' },
  { id: 'dxy', label: '美元指数' }, { id: 'spread', label: '10Y-2Y利差' }
];
const RULE_ROWS = [
  { id: 'gold', name: 'COMEX 黄金', unit: 'USD/oz · %', bp: false },
  { id: 'xau', name: '伦敦金现', unit: 'USD/oz · %', bp: false },
  { id: 'wti', name: 'WTI 原油', unit: 'USD/bbl · %', bp: false },
  { id: 'brent', name: '布伦特原油', unit: 'USD/bbl · %', bp: false },
  { id: 'ust10y', name: '美债 10Y 收益率', unit: '% · bp', bp: true },
  { id: 'ust2y', name: '美债 2Y 收益率', unit: '% · bp', bp: true },
  { id: 'ust30y', name: '美债 30Y 收益率', unit: '% · bp', bp: true },
  { id: 'dxy', name: '美元指数', unit: '点 · %', bp: false },
  { id: 'spread', name: '10Y-2Y 利差', unit: 'bp · bp', bp: true }
];
const SOURCE_LABELS = {
  cnbc: 'CNBC 主行情源（收益率/期货/美元指数）',
  sina: '新浪财经（实时商品、伦敦金现）',
  eastmoney: '东方财富（主源故障时的备用源）'
};

const S = {
  config: null, quotes: [], news: { items: [], feedHealth: {} },
  analysis: null, stocks: null, style: null, events: null, macro: null, ic: null, limitup: null,
  journal: null, cycle: null, flow: null, riskoff: null, holdings: null, edge: null,
  history: {}, alerts: [], health: {}, errors: [], sourceLatency: {},
  quoteFetchedAt: 0, newsFetchedAt: 0, startedAt: 0,
  connected: false, audioUnlocked: false,
  chartId: 'gold', chartRange: 'all',
  newsFilter: 'all', alertFilter: 'all', eventFilter: 'focus',
  newsLang: 'zh', stockDetail: null
};

/* ------------------------------- 工具 ------------------------------- */

const esc = s => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function parseTs(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v;
  let s = String(v).trim();
  s = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T');
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

function bjTime(ts, withDate) {
  const t = typeof ts === 'number' ? ts : parseTs(ts);
  if (!Number.isFinite(t)) return '--';
  const o = {
    timeZone: 'Asia/Shanghai', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  };
  if (withDate) { o.year = 'numeric'; o.month = '2-digit'; o.day = '2-digit'; }
  return new Date(t).toLocaleString('zh-CN', o).replace(/\//g, '-');
}

function relTime(ts) {
  const t = typeof ts === 'number' ? ts : parseTs(ts);
  if (!Number.isFinite(t)) return '--';
  const d = Date.now() - t;
  if (d < 0) return '刚刚';
  if (d < 60000) return Math.max(1, Math.floor(d / 1000)) + ' 秒前';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}

function fmtNum(v, d) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  const dec = d === undefined ? 2 : d;
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function findQuote(id) { return S.quotes.find(q => q.id === id) || null; }

async function api(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return res.json();
}

/* ------------------------------- 顶部状态 ------------------------------- */

function setConn(ok) {
  $('conn').className = 'conn ' + (ok ? 'on' : 'off');
  $('connText').textContent = ok ? '实时连接' : '连接断开·重试中';
}

function renderSummary() {
  $('quoteTime').textContent = S.quoteFetchedAt ? bjTime(S.quoteFetchedAt) : '--';
  $('newsTime').textContent = S.newsFetchedAt ? bjTime(S.newsFetchedAt) : '--';

  const recent = S.alerts.filter(a => Date.now() - a.ts < 86400000);
  const criticals = recent.filter(a => a.level === 'critical' && !a.ack);
  $('alertCount').textContent = String(recent.length);
  $('alertCountHint').textContent = criticals.length
    ? ('其中 ' + criticals.length + ' 条严重未确认') : '最近 24 小时';

  let state = '正常监测', hint = '全部规则运行中', cls = 'big';
  if (!S.connected) { state = '连接断开'; hint = '正在尝试重新连接服务'; }
  else if (criticals.length) { state = '警戒'; hint = criticals.length + ' 条严重告警待确认'; }
  else if (recent.some(a => a.level === 'warning')) { state = '关注'; hint = '有警告级告警，请查看告警中心'; }
  $('riskState').textContent = state;
  $('riskState').className = cls + (state === '警戒' ? ' crit-text' : '');
  $('riskState').style.color = state === '警戒' ? '#dc2626' : (state === '关注' ? '#d97706' : (state === '连接断开' ? '#8a99ad' : '#0f9d58'));
  $('riskHint').textContent = hint;

  const last = S.alerts[S.alerts.length - 1];
  const el = $('latestAlert');
  if (!last) { el.textContent = '暂无告警'; el.className = 'latest'; }
  else {
    el.className = 'latest ' + last.level;
    el.textContent = '[' + (LEVEL_TEXT[last.level] || '') + '] ' + last.title + ' — ' + last.message;
    el.title = last.title + ' / ' + last.message;
  }

  const parts = [];
  for (const [k, label] of Object.entries(SOURCE_LABELS)) {
    const st = S.health[k];
    if (!st) continue;
    parts.push(label.split('（')[0] + ' <b class="' + (st === 'ok' ? '' : 'bad') + '">' + (st === 'ok' ? '正常' : '异常') + '</b>');
  }
  const newsOk = Object.values(S.news.feedHealth || {}).filter(n => n > 0).length;
  parts.push('新闻源 <b>' + newsOk + '/' + Object.keys(S.news.feedHealth || {}).length + '</b> 可用');
  $('sourceSummary').innerHTML = parts.length ? parts.join('<br>') : '等待首次采集…';
}

/* ------------------------------- 行情卡片 ------------------------------- */

function sparkSvg(id, dir) {
  const pts = (S.history[id] || []).slice(-40).map(p => Number(p.v)).filter(Number.isFinite);
  if (pts.length < 2) return '<svg viewBox="0 0 120 30"></svg>';
  const min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
  const span = (max - min) || 1;
  const d = pts.map((v, i) =>
    (i === 0 ? 'M' : 'L') + (i / (pts.length - 1) * 120).toFixed(1) + ' ' +
    (26 - (v - min) / span * 22).toFixed(1)
  ).join(' ');
  const color = dir === 'up' ? '#d92d20' : (dir === 'down' ? '#0f9d58' : '#8a99ad');
  return '<svg viewBox="0 0 120 30" preserveAspectRatio="none"><path d="' + d +
    '" fill="none" stroke="' + color + '" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" opacity=".9"/></svg>';
}

function cardHtml(id) {
  const q = findQuote(id);
  if (!q) {
    const label = (RULE_ROWS.find(c => c.id === id) || { name: id }).name;
    return '<div class="card"><div class="card-name">' + esc(label) +
      '</div><div class="card-value">--</div><div class="card-meta"><span>等待数据源返回</span></div></div>';
  }
  const dec = q.decimals === undefined ? 2 : q.decimals;
  const chg = q.changePct === null || q.changePct === undefined ? NaN : Number(q.changePct);
  const hasChg = Number.isFinite(chg);
  const dir = hasChg ? (chg > 0.0001 ? 'up' : (chg < -0.0001 ? 'down' : 'flat')) : 'flat';
  const sign = chg > 0 ? '+' : '';
  const badge = q.quality === 'realtime' ? '<span class="badge realtime">实时</span>'
    : q.quality === 'delayed' ? '<span class="badge delayed">延迟</span>'
      : '<span class="badge fallback">备用源</span>';
  const prev = (q.prevClose !== null && q.prevClose !== undefined && Number.isFinite(Number(q.prevClose)))
    ? '前收 ' + fmtNum(q.prevClose, dec) : '前收 --';
  const chgText = hasChg
    ? sign + fmtNum(chg, 2) + '%' + '<small>' + prev + '</small>'
    : (q.kind === 'spread' ? '利差 ' + (q.inverted ? '倒挂' : '为正') + '<small>' + (q.source || '') + '</small>' : '变动 --');
  const rtRef = q.rtValue
    ? '<div class="rt-ref">实时参考（新浪） <b>' + fmtNum(q.rtValue, 2) + '</b></div>' : '';
  const timeText = bjTime(q.sourceTime, true);
  return '<div class="card">' +
    '<div class="card-top"><div><div class="card-name">' + esc(q.short || q.name) + '</div>' +
    '<div class="card-sym" title="' + esc(q.name) + '">' + esc(q.symbol || q.id) +
    (q.contract ? ' · ' + esc(q.contract) : '') + '</div></div>' + badge + '</div>' +
    '<div class="card-value">' + fmtNum(q.value, dec) +
    (q.unit ? '<span class="card-unit">' + esc(q.unit) + '</span>' : '') + '</div>' +
    '<div class="card-change ' + dir + '">' + chgText + '</div>' + rtRef +
    '<div class="spark">' + sparkSvg(q.id, dir) + '</div>' +
    '<div class="card-meta"><span title="' + esc(q.source) + '">来源 ' + esc(q.source) + '</span>' +
    '<span>数据时点 ' + esc(timeText) + '（北京时间）</span></div>' +
    '</div>';
}

function renderCards() {
  $('primaryCards').innerHTML = PRIMARY.map(cardHtml).join('');
  $('secondaryCards').innerHTML = SECONDARY.map(cardHtml).join('');
}

/* ------------------------------- 走势图 ------------------------------- */

function renderChartTabs() {
  const ids = CHART_IDS.map(c =>
    '<button class="tab ' + (S.chartId === c.id ? 'active' : '') + '" data-kind="id" data-val="' + c.id + '">' + c.label + '</button>'
  ).join('');
  const ranges = [['1h', '近1小时'], ['4h', '近4小时'], ['all', '全部']].map(r =>
    '<button class="tab ' + (S.chartRange === r[0] ? 'active' : '') + '" data-kind="range" data-val="' + r[0] + '">' + r[1] + '</button>'
  ).join('');
  $('chartTabs').innerHTML = ids + '<span style="width:8px"></span>' + ranges;
}

function renderChart() {
  const id = S.chartId;
  const q = findQuote(id);
  let pts = (S.history[id] || []).filter(p => Number.isFinite(p.t) && Number.isFinite(Number(p.v)))
    .map(p => ({ t: p.t, v: Number(p.v), s: p.s }));
  if (S.chartRange !== 'all') {
    const cutoff = Date.now() - (S.chartRange === '1h' ? 3600000 : 4 * 3600000);
    const f = pts.filter(p => p.t >= cutoff);
    if (f.length >= 2) pts = f;
  }
  if (pts.length < 2) {
    $('chart').innerHTML = '<div class="empty">该指标暂无足够走势数据，系统每 ' +
      ((S.config && S.config.quoteIntervalSec) || 15) + ' 秒采样一次，稍后自动生成曲线。</div>';
    $('chartMeta').innerHTML = '';
    $('chartFoot').textContent = '走势数据来自本地实时采样与 Yahoo Finance 历史线，均为程序抓取，非人工录入。';
    return;
  }

  const W = 900, H = 280, PL = 62, PR = 18, PT = 16, PB = 30;
  const vals = pts.map(p => p.v);
  let min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  const pad = ((max - min) || Math.abs(max) * 0.001 || 1) * 0.18;
  min -= pad; max += pad;
  const x = i => PL + i / (pts.length - 1) * (W - PL - PR);
  const y = v => PT + (max - v) / (max - min) * (H - PT - PB);
  const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
  const area = line + ' L' + x(pts.length - 1).toFixed(1) + ' ' + (H - PB) + ' L' + PL + ' ' + (H - PB) + ' Z';
  const rising = pts[pts.length - 1].v >= pts[0].v;
  const color = rising ? '#d92d20' : '#0f9d58';
  const flat = Math.max.apply(null, vals) === Math.min.apply(null, vals);
  const isYieldLike = q && (q.kind === 'yield' || q.kind === 'spread');
  const dec = q ? (q.decimals === undefined ? 2 : q.decimals) : 2;
  const unit = q ? q.unit : '';

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = max - (max - min) * i / 4;
    const gy = PT + (H - PT - PB) * i / 4;
    grid += '<line x1="' + PL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + gy.toFixed(1) +
      '" stroke="#eef2f7" stroke-width="1"/>' +
      '<text x="' + (PL - 8) + '" y="' + (gy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="#8a99ad">' +
      fmtNum(v, dec) + '</text>';
  }
  let xt = '';
  [0, Math.floor((pts.length - 1) / 2), pts.length - 1].forEach((i, k) => {
    const anchor = k === 0 ? 'start' : (k === 2 ? 'end' : 'middle');
    xt += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' + anchor +
      '" font-size="10" fill="#8a99ad">' + bjTime(pts[i].t, true) + '</text>';
  });
  const lastX = x(pts.length - 1).toFixed(1), lastY = y(pts[pts.length - 1].v).toFixed(1);

  $('chart').innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="走势图">' +
    '<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="' + color + '" stop-opacity="' + (flat ? '0.045' : '0.16') + '"/>' +
    '<stop offset="100%" stop-color="' + color + '" stop-opacity="' + (flat ? '0.005' : '0.01') + '"/></linearGradient></defs>' +
    grid +
    '<path d="' + area + '" fill="url(#areaGrad)"/>' +
    '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<line x1="' + lastX + '" y1="' + PT + '" x2="' + lastX + '" y2="' + (H - PB) + '" stroke="' + color + '" stroke-width="1" stroke-dasharray="3 3" opacity=".35"/>' +
    '<circle cx="' + lastX + '" cy="' + lastY + '" r="4" fill="#fff" stroke="' + color + '" stroke-width="2"/>' +
    xt + '</svg>';

  const high = Math.max.apply(null, vals), low = Math.min.apply(null, vals);
  $('chartMeta').innerHTML =
    '<span class="cm-value">' + fmtNum(pts[pts.length - 1].v, dec) + ' <small style="font-size:11px;color:#8a99ad">' + esc(unit) + '</small></span>' +
    '<span class="cm-kv">区间高 <b>' + fmtNum(high, dec) + '</b></span>' +
    '<span class="cm-kv">区间低 <b>' + fmtNum(low, dec) + '</b></span>' +
    '<span class="cm-kv">采样点 <b>' + pts.length + '</b></span>' +
    (isYieldLike ? '<span class="cm-kv">纵轴单位 <b>' + esc(unit) + '</b></span>' : '') +
    (flat ? '<span class="cm-kv" style="color:var(--warn)">区间内数值无变动（休市或数据源静态）</span>' : '');

  const yahooCount = pts.filter(p => p.s === 'yahoo').length;
  const liveCount = pts.filter(p => p.s === 'live').length;
  const symMap = { gold: 'GC=F', wti: 'CL=F', brent: 'BZ=F', ust10y: '^TNX', ust30y: '^TYX', dxy: 'DX-Y.NYB' };
  let foot = '图内时间均为北京时间。历史线 ' + yahooCount + ' 点来自 Yahoo Finance 5 分钟线' +
    (symMap[id] ? '（' + symMap[id] + '）' : '') + '，本地实时采样 ' + liveCount + ' 点来自 ' +
    (q ? esc(q.source) : '行情接口') + '；两源合约与更新节奏不同，数值可能有细微差异。';
  if (!yahooCount) foot = '该指标无外部历史线，曲线为系统启动以来每 ' + ((S.config && S.config.quoteIntervalSec) || 15) +
    ' 秒一次的本地实时采样，来源 ' + (q ? esc(q.source) : '行情接口') + '；重启后从持久化状态恢复。';
  $('chartFoot').textContent = foot;
}

/* ------------------------------- 数据源状态 ------------------------------- */

function renderHealth() {
  const items = [];
  for (const [k, label] of Object.entries(SOURCE_LABELS)) {
    const st = S.health[k];
    if (!st) {
      if (k === 'eastmoney') items.push(['standby', '东方财富（按需备源）', '主源正常时休眠']);
      else items.push(['standby', label, '等待首次采集']);
      continue;
    }
    const lat = S.sourceLatency && S.sourceLatency[k];
    items.push([st === 'ok' ? 'ok' : 'down', label,
      (st === 'ok' ? '连通' : '异常') + (Number.isFinite(lat) ? ' · ' + lat + ' ms' : '')]);
  }
  const feeds = Object.entries(S.news.feedHealth || {});
  const okFeeds = feeds.filter(([, n]) => n > 0).length;
  items.push([okFeeds ? 'ok' : 'down', '新闻 RSS 聚合', okFeeds + '/' + feeds.length + ' 个源可用 · 共 ' + (S.news.items || []).length + ' 条']);
  items.push(['standby', 'Yahoo Finance', '启动时加载 5 分钟历史线']);
  $('sourceHealth').innerHTML = items.map(([st, name, sub]) =>
    '<div class="health-item ' + st + '"><span class="hi-dot"></span><div>' +
    '<div class="hi-name">' + esc(name) + '</div><div class="hi-sub">' + esc(sub) + '</div></div></div>'
  ).join('');
  if (S.errors && S.errors.length) {
    $('extNote').textContent = '采集提示：' + S.errors[0];
    $('extNote').style.color = '#d97706';
  } else {
    $('extNote').textContent = '收益率与利差变动以基点（bp）计 · 1bp = 0.01 个百分点';
    $('extNote').style.color = '';
  }
}

/* ------------------------------- 告警 / 新闻列表 ------------------------------- */

function renderFilters() {
  const af = [['all', '全部'], ['unack', '未确认'], ['critical', '严重'], ['warning', '警告'], ['info', '提示']];
  $('alertFilter').innerHTML = af.map(([k, t]) =>
    '<button class="chip ' + (S.alertFilter === k ? 'active' : '') + '" data-f="' + k + '">' + t + '</button>').join('');
  const nf = [['all', '全部'], ['market', '市场相关'], ['hit', '命中关键词'], ['zh', '原生中文'], ['en', '译文']];
  $('newsFilter').innerHTML = nf.map(([k, t]) =>
    '<button class="chip ' + (S.newsFilter === k ? 'active' : '') + '" data-f="' + k + '">' + t + '</button>').join('');
  const c = (S.events && S.events.counts) || {};
  const ef = [
    ['focus', '重点关注 ' + (c.focus || 0)], ['beat', '业绩超预期 ' + (c.earningsBeats || 0)],
    ['all', '全部 ' + (c.total || 0)], ['positive', '利多'], ['negative', '利空'],
    ['macro', '宏观事件 ' + (c.macro || 0)]
  ];
  $('eventFilter').innerHTML = ef.map(([k, t]) =>
    '<button class="chip ' + (S.eventFilter === k ? 'active' : '') + '" data-f="' + k + '">' + t + '</button>').join('');
}

function renderAlerts() {
  let list = S.alerts.slice().reverse();
  if (S.alertFilter === 'unack') list = list.filter(a => !a.ack);
  else if (S.alertFilter !== 'all') list = list.filter(a => a.level === S.alertFilter);
  if (!list.length) {
    $('alertList').innerHTML = '<div class="list-empty">暂无告警记录<br><span style="font-size:10px">可点击「链路自检」验证声音与消息显示</span></div>';
    return;
  }
  $('alertList').innerHTML = list.slice(0, 120).map(a =>
    '<div class="alert-item ' + a.level + (a.ack ? ' ack' : '') + (a.demo ? ' demo' : '') + '">' +
    '<div class="ai-top"><div class="ai-title">' + esc(a.title) + '</div>' +
    '<div class="ai-time">' + esc(bjTime(a.ts, true)) + '</div></div>' +
    '<div class="ai-msg">' + esc(a.message) + '</div>' +
    (a.detail ? '<div class="ai-detail">' + esc(a.detail) + '</div>' : '') +
    (a.source || a.sourceTime ? '<div class="ai-detail">来源 ' + esc(a.source || '--') +
      (a.sourceTime ? ' · ' + esc(bjTime(a.sourceTime, true)) : '') + '</div>' : '') +
    '<div class="ai-foot"><span class="ai-tag">' + esc(LEVEL_TEXT[a.level] || '') +
    (a.demo ? ' · 模拟数据' : '') + (a.silent ? ' · 免打扰' : '') + '</span>' +
    '<span class="ai-links">' + (a.link ? '<a href="' + esc(a.link) + '" target="_blank" rel="noopener">查看原文</a>' : '') +
    (a.ack ? '' : '<button data-ack="' + esc(a.id) + '">确认</button>') + '</span></div></div>'
  ).join('');
}

function sentBadge(n) {
  if (n.sentiment === undefined || n.sentimentLabel === undefined) return '';
  const cls = n.sentiment >= 8 ? 'sent-pos' : n.sentiment <= -8 ? 'sent-neg' : 'sent-mid';
  return '<span class="ni-sent ' + cls + '">' + esc(n.sentimentLabel) + ' ' +
    (n.sentiment > 0 ? '+' : '') + n.sentiment + '</span>';
}

function translationBadge(n) {
  if (n.translation === 'machine') return '<span class="ni-tr" title="机器译文，点右上角可切换原文">译</span>';
  if (n.translation === 'native') return '<span class="ni-native">中文</span>';
  return '<span class="ni-native" title="翻译暂不可用，显示原文">原文</span>';
}

function renderNews() {
  const btn = $('btnNewsLang');
  if (btn) {
    btn.textContent = S.newsLang === 'zh' ? '原文' : '中文';
    btn.title = S.newsLang === 'zh' ? '当前显示中文译文，点击切换为原文' : '当前显示原文，点击切换为中文';
  }
  const items = (S.news.items || []).slice();
  let list = items;
  if (S.newsFilter === 'hit') list = items.filter(n => n.hits && n.hits.length);
  else if (S.newsFilter === 'market') list = items.filter(n => n.relevance === undefined || n.relevance >= 35);
  else if (S.newsFilter === 'zh') list = items.filter(n => n.lang === 'zh');
  else if (S.newsFilter === 'en') list = items.filter(n => n.translation === 'machine');

  const zhDone = items.filter(n => n.titleZh && n.titleZh !== n.title).length;
  $('newsCount').textContent = items.length + ' 条 · 已中文化 ' + zhDone + ' 条 · 更新于 ' +
    (S.newsFetchedAt ? bjTime(S.newsFetchedAt) : '--');
  if (!list.length) { $('newsList').innerHTML = '<div class="list-empty">暂无符合条件的新闻</div>'; return; }

  const useZh = S.newsLang === 'zh';
  $('newsList').innerHTML = list.slice(0, 100).map(n => {
    const hasZh = !!(n.titleZh && n.titleZh !== n.title);
    const main = (useZh && hasZh) ? n.titleZh : n.title;
    const sub = (useZh && hasZh) ? n.title : (hasZh ? n.titleZh : '');
    const kws = (n.hits || []).slice(0, 2).map(h =>
      '<span class="ni-kw ' + (h.level === 'critical' ? 'crit' : '') + '">' + esc(h.w) + '</span>').join('');
    const topic = n.primaryTopic && n.primaryTopic !== '一般资讯'
      ? '<span class="ni-topic">' + esc(n.primaryTopic) + '</span>' : '';
    const dirs = (n.directions || []).length
      ? '<div class="ni-impact">影响倾向：' + esc(n.directions.map(d => d.label + d.dir).join(' · ')) + '</div>' : '';
    const low = n.relevance !== undefined && n.relevance < 35 ? ' ni-low' : '';
    return '<div class="news-item' + low + '">' +
      '<a class="ni-title" href="' + esc(n.link || '#') + '" target="_blank" rel="noopener">' +
      '<span class="ni-level ' + (n.level || 'none') + '" style="display:inline-block;margin-right:5px"></span>' +
      '<span class="' + (useZh && hasZh ? 'ni-zh' : '') + '">' + esc(main) + '</span></a>' +
      (sub ? '<span class="ni-orig">' + esc(sub) + '</span>' : '') +
      '<div class="ni-meta">' + translationBadge(n) + '<span>' + esc(n.source) + '</span><span>·</span>' +
      '<span>' + esc(relTime(n.publishedAt)) + '</span>' + sentBadge(n) + topic + kws +
      (n.relevance !== undefined ? '<span class="ni-rel">相关度 ' + n.relevance + '</span>' : '') + '</div>' +
      dirs + '</div>';
  }).join('');
}

/* ------------------------------- 新闻解读面板 ------------------------------- */

function renderAnalysis() {
  const a = S.analysis;
  if (!a) {
    $('analysisTime').textContent = '等待解读';
    $('analysisNarrative').innerHTML = '<div class="empty">首次加载需要翻译新闻，约 10–30 秒后自动显示中文与解读…</div>';
    ['analysisMetrics', 'analysisImpacts', 'analysisThemes', 'analysisHeadlines', 'analysisMethod']
      .forEach(id => { $(id).innerHTML = ''; });
    return;
  }
  $('analysisTime').textContent = '生成于 ' + bjTime(a.generatedAt);
  $('analysisNarrative').innerHTML = (a.narrative || []).map(p => '<p>' + esc(p) + '</p>').join('');

  const c = a.counts || {};
  const tot = Math.max(1, c.total || 0);
  const pos = (c.positive || 0) / tot * 100;
  const mid = (c.neutral || 0) / tot * 100;
  const neg = (c.negative || 0) / tot * 100;
  const risk = a.riskTemperature || 0;
  const riskColor = risk >= 60 ? 'var(--up)' : risk >= 35 ? 'var(--warn)' : 'var(--down)';
  const sentColor = a.sentimentAvg > 8 ? 'var(--up)' : a.sentimentAvg < -8 ? 'var(--down)' : 'var(--text-2)';
  $('analysisMetrics').innerHTML =
    '<div class="an-metric"><label>市场相关新闻</label><b>' + (c.total || 0) + '</b>' +
    '<small>共采集 ' + (c.rawTotal || 0) + ' 条 · 过滤 ' + (c.filtered || 0) + ' 条</small>' +
    '<div class="an-bar"><i style="width:' + Math.min(100, (c.total || 0) / Math.max(1, c.rawTotal || 1) * 100) + '%;background:var(--blue)"></i></div></div>' +
    '<div class="an-metric"><label>消息面情绪均值</label><b style="color:' + sentColor + '">' +
    (a.sentimentAvg > 0 ? '+' : '') + a.sentimentAvg + '</b><small>' + esc(a.tone) + ' · 正 ' + (c.positive || 0) +
    ' / 中 ' + (c.neutral || 0) + ' / 负 ' + (c.negative || 0) + '</small>' +
    '<div class="an-bar" style="display:flex"><i style="width:' + pos + '%;background:var(--up)"></i>' +
    '<i style="width:' + mid + '%;background:#cbd5e1"></i><i style="width:' + neg + '%;background:var(--down)"></i></div></div>' +
    '<div class="an-metric"><label>风险温度</label><b style="color:' + riskColor + '">' + risk + '</b>' +
    '<small>/ 100 · 高影响词 ' + (c.critical || 0) + ' 条</small>' +
    '<div class="an-bar"><i style="width:' + risk + '%;background:' + riskColor + '"></i></div></div>';

  $('analysisImpacts').innerHTML = (a.impacts || []).map(im => {
    const v = im.score || 0;
    const color = v >= 18 ? 'var(--up)' : v <= -18 ? 'var(--down)' : 'var(--text-3)';
    const w = Math.abs(v) / 2;
    const left = v >= 0 ? 50 : 50 - w;
    return '<div class="an-impact" title="' + esc(im.logic || '') + '">' +
      '<div class="ai-l">' + esc(im.label) + '</div>' +
      '<div class="ai-v" style="color:' + color + '">' + (v > 0 ? '+' : '') + v + '</div>' +
      '<div class="ai-n">' + esc(im.direction) + ' · ' + (im.newsCount || 0) + ' 条相关</div>' +
      '<div class="ai-track"><span class="ai-mid"></span><i style="left:' + left + '%;width:' + w + '%;background:' + color + '"></i></div></div>';
  }).join('');

  $('analysisThemes').innerHTML = (a.themes || []).map(t =>
    '<span class="an-theme" title="' + esc(t.logic || '') + '">' + esc(t.label) + '<b>' + t.count + ' 条</b></span>').join('')
    || '<span class="note">当前窗口内未识别到高影响事件主题</span>';

  $('analysisHeadlines').innerHTML = (a.headlines || []).slice(0, 6).map((h, i) =>
    '<div class="an-headline"><span class="an-hl-rank">' + (i + 1) + '</span><div class="an-hl-body">' +
    '<a href="' + esc(h.link || '#') + '" target="_blank" rel="noopener">' + esc(h.displayTitle || h.title) + '</a>' +
    '<div class="an-hl-meta">' + sentBadge(h) + '<span class="ni-topic">' + esc(h.primaryTopic) + '</span>' +
    '<span class="note">影响权重 ' + h.importance + '</span><span class="note">' + esc(bjTime(h.publishedAt)) + '</span></div>' +
    '</div></div>').join('') || '<span class="note">暂无重点新闻</span>';

  const m = a.methodology || {};
  $('analysisMethod').innerHTML = '<b>方法</b>：' + esc(m.sentiment || '') + '；' + esc(m.fusion || '') +
    '。<br><b>边界</b>：' + esc(m.noForecast || '') + '<br>' + esc(a.disclaimer || '');
}

/* ------------------------------- A 股量能与市值风格 ------------------------------- */

function signed(v, digits) {
  const n = Number(v) || 0;
  const t = digits === undefined ? String(n) : n.toFixed(digits);
  return (n > 0 ? '+' : '') + t;
}
function adjCls(v) { return v > 0.5 ? 'chg-up' : v < -0.5 ? 'chg-down' : 'adj-flat'; }

function renderStyle() {
  const r = S.style;
  const empty = msg => {
    $('styleConclusion').innerHTML = '<div class="empty">' + esc(msg) + '</div>';
    $('styleVolume').innerHTML = ''; $('styleBuckets').innerHTML = '';
    $('styleWarnings').innerHTML = ''; $('styleMethodBody').innerHTML = '';
  };
  if (!r) { $('styleTime').textContent = '等待检测'; return empty('正在采集两市量能与四层规模指数…'); }
  if (!r.ok) { $('styleTime').textContent = '检测失败'; return empty(r.conclusion || r.error || '量能风格数据不可用'); }

  const v = r.volume || {};
  $('styleTime').textContent = '交易日 ' + esc(r.tradingDate || '--') + ' · ' +
    bjTime(r.generatedAt) + (r.fromCache ? ' · 缓存' : '');
  const confCls = r.confidence >= 0.75 ? 'high' : r.confidence >= 0.55 ? 'mid' : 'low';
  const spreadNote = r.dominant === 'balanced' ? '四层分差 ' + r.spread + ' 分' : '领先 ' + r.spread + ' 分';
  $('styleConclusion').innerHTML =
    '<div class="style-lead"><b>' + esc(r.dominantLabel || '风格均衡') + '</b>' +
    '<span class="style-conf conf-' + confCls + '">置信度 ' + esc(r.confidenceLabel || '--') +
    ' ' + r.confidence + '</span><span class="style-spread">' + esc(spreadNote) + '</span></div>' +
    '<div class="style-text">' + esc(r.conclusion || '') + '</div>';

  const bd = v.breadth;
  const cards = [
    ['两市成交额', Number(v.totalAmountYi || 0).toLocaleString('zh-CN') + ' 亿',
      '20 日均量 ' + Number(v.ma20Yi || 0).toLocaleString('zh-CN') + ' 亿'],
    ['量能状态', esc(v.state || '--'), signed(v.changePct, 1) + '% · Z ' + signed(v.z20, 2) + 'σ'],
    ['量价配合', esc(v.priceVolume || '--'), '5日/20日均量比 ' + Number(v.trend5v20 || 1).toFixed(2)],
    ['全市场宽度', bd ? bd.upRatio + '% 上涨' : '未覆盖',
      bd ? '涨 ' + bd.up + ' / 跌 ' + bd.down + ' · 覆盖 ' + Math.round((bd.coverage || 0) * 100) + '%' : '数据不可用']
  ];
  $('styleVolume').innerHTML = cards.map(c =>
    '<div class="sv-card"><label>' + c[0] + '</label><b>' + c[1] + '</b><small>' + c[2] + '</small></div>'
  ).join('');

  $('styleBuckets').innerHTML = (r.buckets || []).map(b => {
    const s = Number(b.score) || 0;
    const pct = Math.min(50, Math.abs(s) / 2);
    const bar = s >= 0
      ? '<i class="pos" style="left:50%;width:' + pct + '%"></i>'
      : '<i class="neg" style="left:' + (50 - pct) + '%;width:' + pct + '%"></i>';
    const lead = b.rank === 1 && r.dominant !== 'balanced' ? ' lead' : '';
    return '<div class="style-bucket' + lead + '">' +
      '<div class="sb-head"><b>' + esc(b.name) + '</b><span>' + esc(b.index) + '</span>' +
      '<em class="' + adjCls(s) + '">' + signed(s) + '</em></div>' +
      '<div class="sb-cap">流通市值 ' + esc(b.capLabel) + ' · 第 ' + b.rank + '/4' +
      (b.crowdPenalty ? ' · 拥挤扣分' : '') + '</div>' +
      '<div class="style-bar"><span class="mid"></span>' + bar + '</div>' +
      '<div class="sb-rows">' +
      '<span>成交占比 <b>' + b.share + '%</b>（' + signed(b.shareDelta) + 'pct / ' + signed(b.shareZ) + 'σ）</span>' +
      '<span>5日超额 <b class="' + adjCls(b.rel5) + '">' + signed(b.rel5) + '%</b> · 20日 ' + signed(b.ret20) + '%</span>' +
      '<span>层内宽度 <b>' + b.upRatio + '%</b> · 换手分位 ' + Math.round((b.crowdPct || 0) * 100) + '%</span>' +
      '<span>量价 ' + signed(b.volumePrice) + ' · 弹性 ' + signed(b.elasticity) + ' · 当日 ' + signed(b.pct1) + '%</span>' +
      '</div></div>';
  }).join('');

  const ws = r.warnings || [];
  $('styleWarnings').innerHTML = ws.length
    ? '<b>数据提示</b>' + ws.map(w => '<span>· ' + esc(w) + '</span>').join('') : '';
  const m = r.methodology || {};
  const labels = {
    universe: '代理指数与口径', standard: '标准化与去极值', signals: '信号与固定权重',
    confidence: '置信度构成', capBuckets: '市值分档', limitation: '边界与局限'
  };
  $('styleMethodBody').innerHTML = Object.keys(labels).map(k =>
    '<p><b>' + labels[k] + '</b>：' + esc(m[k] || '') + '</p>').join('') +
    '<p><b>文献与工程出处</b>：' + (m.references || []).map(esc).join('；') + '</p>';
}

/** 观察池里的「市值层 / 风格」紧凑单元格 */
function styleCell(x) {
  const sl = x.styleLink || {}, g = x.groups || {};
  if (!sl.available) return '<span class="heat-none">风格未覆盖</span>';
  const adj = Number(g.styleAdjust || 0);
  return '<span class="style-badge">' + esc(sl.label) + '</span>' +
    '<span class="adj-tag ' + adjCls(adj) + '">风格 ' + signed(adj) + '</span>' +
    '<span class="sent-mini">层分 ' + signed(sl.score) + ' · 第 ' + sl.rank + '/4</span>';
}

/* ------------------------------- 市场状态与事件驱动 ------------------------------- */

const EVENT_LABELS = {
  classification: '公司事件分类', earnings: '业绩超预期判定', corporate: '重大事项判读',
  macro: '宏观事件与板块', spillover: '龙头业绩板块联动', alert: '即时提醒规则',
  volumeRegime: '存量博弈 / 增量行情分档', elasticity: '单位资金价格冲击',
  riskOff: '机构避险温度', orthogonal: '与既有因子的正交'
};

function renderEvents() {
  const ev = S.events, mc = S.macro;
  const clear = msg => {
    $('eventsTime').textContent = '等待检测';
    $('eventsConclusion').innerHTML = '<div class="empty">' + esc(msg) + '</div>';
    ['macroCards', 'macroBuckets', 'eventSectors', 'eventList', 'eventWarnings', 'eventsMethodBody']
      .forEach(id => { $(id).innerHTML = ''; });
  };
  if (!ev && !mc) return clear('正在采集公司公告、业绩预告与快报…');
  $('eventsTime').textContent = bjTime(ev ? ev.generatedAt : mc.generatedAt) +
    (ev && ev.fromCache ? ' · 缓存' : '');
  const v = (mc && mc.volume) || {}, ro = (mc && mc.riskOff) || {};
  const counts = (ev && ev.counts) || {};
  $('eventsConclusion').innerHTML =
    '<div class="events-lead"><b>' + esc(v.regime || '宏观状态计算中') + '</b>' +
    '<span class="style-conf conf-' + (ro.level === '高' ? 'low' : ro.level === '中' ? 'mid' : 'high') + '">避险 ' +
    (ro.score || 0) + '/100（' + esc(ro.level || '--') + '）</span>' +
    '<span class="style-spread">事件利多 ' + (counts.positive || 0) + ' / 利空 ' + (counts.negative || 0) + '</span></div>' +
    (mc ? '<div class="style-text">' + esc(mc.conclusion || '') + '</div>' : '') +
    (ev ? '<div class="style-text">' + esc(ev.conclusion || '') + '</div>' : '');

  const ce = (mc && mc.elasticity) || [];
  const micro = ce.find(x => x.key === 'micro'), large = ce.find(x => x.key === 'large');
  const cards = [
    ['两市量能', Number(v.amountYi || 0).toLocaleString('zh-CN') + ' 亿',
      '阈值 ' + Number(v.thresholdYi || 0).toLocaleString('zh-CN') + ' 亿 · 历史分位 ' +
      (v.percentile === null || v.percentile === undefined ? '--' : v.percentile + '%')],
    ['量能状态', esc(v.regime || '--'), esc(v.note || '')],
    ['单位资金价格冲击', micro ? micro.ratioToLarge + '×（微盘/大盘）' : '--',
      micro ? '每亿元推动 ' + micro.illiq + '% vs 大盘 ' + (large ? large.illiq : '--') + '%' +
        (mc.approxElasticity ? '（当日近似，半权重）' : '') : '等待量能模块重算'],
    ['机构避险', (ro.score || 0) + '/100 · ' + esc(ro.level || '--'), esc(ro.preference || '')]
  ];
  $('macroCards').innerHTML = cards.map(c =>
    '<div class="sv-card"><label>' + c[0] + '</label><b>' + c[1] + '</b><small>' + c[2] + '</small></div>').join('');

  const ba = (mc && mc.bucketAdjust) || {};
  $('macroBuckets').innerHTML = ce.length ? ce.map(e => {
    const b = Number(ba[e.key] || 0);
    return '<div class="mb-item"><div class="mb-head"><b>' + esc(e.name) + '</b>' +
      '<em class="' + adjCls(b) + '">' + signed(b, 2) + ' 分</em></div>' +
      '<div class="mb-rows">冲击 ' + e.illiq + '%/亿元 · 为大盘 ' + e.ratioToLarge + ' 倍 · 环境系数 ×' +
      (v.rotationFactor === undefined ? 1 : v.rotationFactor) + ' · 避险抑制 ×' + (ro.suppress === undefined ? 1 : ro.suppress) +
      '</div></div>';
  }).join('') : '<div class="empty">等待量能模块重算四层单位资金冲击…</div>';

  const sectors = (ev && ev.sectorBias) || [];
  const spills = (ev && ev.spillovers) || [];
  const pos = sectors.filter(s => s.score > 0).slice(0, 8);
  const neg = sectors.filter(s => s.score < 0).slice(0, 6);
  $('eventSectors').innerHTML =
    '<div class="es-group"><h4>利多方向</h4>' + (pos.length ? pos.map(s =>
      '<span class="es-tag pos">' + esc(s.sector) + ' <b>' + signed(s.score) + '</b></span>').join('') : '<span class="sd-muted">暂无</span>') + '</div>' +
    '<div class="es-group"><h4>受损方向</h4>' + (neg.length ? neg.map(s =>
      '<span class="es-tag neg">' + esc(s.sector) + ' <b>' + signed(s.score) + '</b></span>').join('') : '<span class="sd-muted">暂无</span>') + '</div>' +
    (spills.length ? '<div class="es-group"><h4>龙头业绩板块联动</h4>' + spills.slice(0, 6).map(s =>
      '<div class="es-spill"><b>' + esc(s.industry) + ' ' + signed(s.score, 1) + ' 分</b> · ' + esc(s.reason) + '</div>').join('') + '</div>' : '');

  const macroItems = ((ev && ev.macroEvents) || []).map(m => ({
    id: m.id, _macro: true, name: '宏观', code: '', ts: m.ts, timeLabel: bjTime(m.ts),
    label: m.label, typeLabel: m.label, polarity: m.polarity, title: m.title, link: m.link,
    logic: m.logic, benefit: m.benefit || [], hurt: m.hurt || [], isBeat: false, focus: false
  }));
  const base = (ev && ev.items) || [];
  const f = S.eventFilter;
  let list;
  if (f === 'macro') list = macroItems;
  else if (f === 'focus') list = base.filter(x => x.focus || x.isBeat);
  else if (f === 'beat') list = base.filter(x => x.isBeat);
  else if (f === 'positive') list = base.filter(x => x.polarity === '利多');
  else if (f === 'negative') list = base.filter(x => x.polarity === '利空');
  else list = base.concat(macroItems);
  list = list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 60);
  $('eventList').innerHTML = list.length ? list.map(x => {
    const pc = x.polarity === '利空' ? 'neg' : x.polarity === '利多' ? 'pos' : 'flat';
    const title = x.link
      ? '<a href="' + esc(x.link) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a>'
      : esc(x.title);
    const sec = x._macro
      ? ((x.benefit || []).length ? '利多板块：' + esc(x.benefit.slice(0, 4).join('、')) : '') +
        ((x.hurt || []).length ? ' ｜ 受损：' + esc(x.hurt.slice(0, 3).join('、')) : '')
      : (x.industry ? '行业：' + esc(x.industry) : '');
    return '<div class="event-item ev-' + pc + '">' +
      '<div class="ev-top"><span class="ev-time">' + esc(x.timeLabel || '') + '</span>' +
      (x.code ? '<b class="ev-name">' + esc(x.name) + '</b><span class="s-code">' + esc(x.code) + '</span>'
        : '<b class="ev-name">宏观事件</b>') +
      '<span class="ev-type">' + esc(x.typeLabel || x.label || '') + '</span>' +
      '<span class="ev-pol ev-' + pc + '">' + esc(x.polarity || '') + '</span>' +
      (x.isBeat ? '<span class="ev-beat">' + esc(x.beatLevel || '') + ' ' + (x.beatScore || '') + '</span>' : '') +
      (x.isLeader ? '<span class="ev-leader">龙头</span>' : '') +
      (x.confidence === '低' ? '<span class="ev-low">低置信</span>' : '') + '</div>' +
      '<div class="ev-title">' + title + '</div>' +
      (sec ? '<div class="ev-sectors">' + sec + '</div>' : '') +
      (x.logic ? '<div class="ev-logic">' + esc(x.logic) + '</div>' : '') + '</div>';
  }).join('') : '<div class="empty">该筛选下暂无事件</div>';

  const ws = ((ev && ev.warnings) || []).concat(
    mc && mc.approxElasticity ? ['弹性当前为当日单值近似，量能模块重算后自动替换为 20 日均值'] : []);
  $('eventWarnings').innerHTML = ws.length ? '<b>数据提示</b>' + ws.map(w => '<span>· ' + esc(w) + '</span>').join('') : '';

  const mm = Object.assign({}, (mc && mc.methodology) || {}, (ev && ev.methodology) || {});
  const refs = (ev && ev.methodology && ev.methodology.references) || [];
  $('eventsMethodBody').innerHTML = Object.keys(EVENT_LABELS).map(k =>
    mm[k] ? '<p><b>' + EVENT_LABELS[k] + '</b>：' + esc(mm[k]) + '</p>' : '').join('') +
    (refs.length ? '<p><b>文献与工程出处</b>：' + refs.map(esc).join('；') + '</p>' : '') +
    '<p><b>边界</b>：' + esc((ev && ev.disclaimer) || '') + ' ' + esc((mc && mc.disclaimer) || '') + '</p>';
}

/** 观察池里的「事件 / 宏观」紧凑单元格 */
function eventCell(x) {
  const e = x.eventLink || {}, m = x.macroLink || {};
  const ea = Number(e.adjustment || 0), ma = Number(m.adjustment || 0);
  let tag;
  if (e.watchItem) tag = '<span class="ev-badge ' + (e.polarity === '利空' ? 'neg' : 'pos') + '">' +
    esc(e.watchItem.label) + '</span>';
  else if (e.spilloverFrom) tag = '<span class="ev-badge spill">板块联动</span>';
  else if (e.hitCount) tag = '<span class="ev-badge">事件 ' + e.hitCount + '</span>';
  else tag = '<span class="heat-none">无事件</span>';
  return tag +
    '<span class="adj-tag ' + adjCls(ea) + '">事件 ' + signed(ea, 1) + '</span>' +
    '<span class="sent-mini">' + esc(m.bucketLabel || '--') + ' · 避险 ' + (m.riskOffScore || 0) + '</span>' +
    '<span class="adj-tag ' + adjCls(ma) + '">宏观 ' + signed(ma, 1) + '</span>';
}

/* --------------------------- 涨停结构与市场情绪 --------------------------- */

const BOARD_CLS = { oneWord: 'one', tShape: 't', reseal: 'reseal', turnover: 'turn', fail: 'fail' };

/** 观察池里的「板型」紧凑单元格 */
function boardCell(x) {
  const l = x.limitLink;
  if (!l || !l.active) return '<span class="heat-none">—</span>';
  const b = l.board || {};
  return '<span class="board-tag ' + (BOARD_CLS[b.key] || '') + '">' + esc(b.label) + '</span>' +
    (l.boards > 1 ? '<span class="board-boards">' + l.boards + ' 板</span>' : '') +
    '<span class="sent-mini">修正 ' + signed(l.adjust, 1) + ' · 追高 ' + (l.chaseRisk || 0) + '</span>';
}

function renderLimitUp() {
  const v = S.limitup;
  const clear = msg => {
    if ($('limitTime')) $('limitTime').textContent = '等待采集';
    if ($('limitConclusion')) $('limitConclusion').innerHTML = '<div class="empty">' + esc(msg) + '</div>';
    ['limitCards', 'limitLadder', 'limitFailed', 'limitWarnings', 'limitMethodBody']
      .forEach(id => { if ($(id)) $(id).innerHTML = ''; });
  };
  if (!v) return clear('正在采集涨停、炸板与跌停池…');
  if (!v.ok) return clear('涨停池暂无数据（非交易日、休市或接口不可达）');

  const s = v.sentiment || {}, c = v.counts || {};
  $('limitTime').textContent = bjTime(v.fetchedAt);
  const weak = ['冰点', '退潮'].includes(s.stage);
  $('limitConclusion').innerHTML =
    '<div class="events-lead"><b>情绪周期：' + esc(s.stage || '--') + '</b>' +
    '<span class="style-conf conf-' + (weak ? 'low' : s.stage === '高潮' ? 'mid' : 'high') + '">周期系数 ×' +
    (s.factor === undefined ? 1 : s.factor) + '</span>' +
    '<span class="style-spread">涨停 ' + (c.limitUp || 0) + ' · 跌停 ' + (c.limitDown || 0) +
    ' · 炸板 ' + (c.failed || 0) + '</span></div>' +
    '<div class="style-text">' + (s.notes || []).slice(1).map(esc).join(' ｜ ') + '</div>';

  const adv = s.advancement || {};
  $('limitCards').innerHTML = [
    ['情绪周期', esc(s.stage || '--') + '（×' + (s.factor === undefined ? 1 : s.factor) + '）',
      '弱势市场压低涨停强度的正向加成；负向修正反而放大，不美化烂板'],
    ['涨停 / 跌停', (c.limitUp || 0) + ' / ' + (c.limitDown || 0),
      '跌停 ≥ 涨停 1.5 倍即判冰点'],
    ['炸板率', (s.zbRate || 0) + '%',
      '炸板 ' + (c.failed || 0) + ' 家 ＝ 炸板 /（涨停＋炸板）'],
    ['最高连板', (s.maxBoards || 0) + ' 板',
      (adv.rate === null || adv.rate === undefined)
        ? '昨日晋级率累积中（需两个交易日记录）'
        : '昨日 ' + adv.prevCount + ' 家 → 今日晋级 ' + adv.promoted + ' 家（' + Math.round(adv.rate * 100) + '%）']
  ].map(x => '<div class="sv-card"><label>' + x[0] + '</label><b>' + x[1] + '</b><small>' + x[2] + '</small></div>').join('');

  const ladder = v.ladder || [];
  $('limitLadder').innerHTML = ladder.length ? ladder.map(x => {
    const sr = x.sealRatio;
    const thick = (sr === null || sr === undefined) ? 'flat' : sr >= 2 ? 'thick' : sr >= 1 ? 'mid' : 'thin';
    return '<div class="lad-item"><div class="lad-head"><b>' + esc(x.name) + '</b>' +
      '<span class="lad-boards">' + esc(x.statLabel || ((x.boards || 1) + ' 板')) + '</span>' +
      '<span class="lad-ind">' + esc(x.industry || '') + '</span></div>' +
      '<div class="lad-rows">' +
      '<span>首封 ' + esc(x.firstSealLabel || '--') + '</span>' +
      '<span class="seal-' + thick + '">封单 ' + (sr === null || sr === undefined ? '--' : sr + '%') + '</span>' +
      (x.sealFundYi ? '<span>封单额 ' + x.sealFundYi + ' 亿</span>' : '') +
      '<span>开板 ' + (x.breakCount || 0) + ' 次</span>' +
      '<span>换手 ' + (x.turnover === null || x.turnover === undefined ? '--' : x.turnover + '%') + '</span>' +
      '</div></div>';
  }).join('') : '<div class="empty">今日无涨停</div>';

  const fails = v.failed || [];
  $('limitFailed').innerHTML = fails.length ? fails.map(x =>
    '<div class="lf-item"><b>' + esc(x.name) + '</b>' +
    '<span class="lf-pct ' + adjCls(x.pct) + '">' + signed(x.pct, 1) + '%</span>' +
    (x.resealed ? '<span class="board-tag reseal">尾盘回封</span>' : '<span class="board-tag fail">未回封</span>') +
    '<span class="sent-mini">距涨停 ' + (x.failDepth === null || x.failDepth === undefined ? '--' : x.failDepth + '%') +
    ' · 开板 ' + (x.breakCount || 0) + ' 次 · ' + esc(x.industry || '') + '</span></div>').join('')
    : '<div class="empty">今日无炸板</div>';

  const warn = [];
  if (weak) warn.push('市场处于「' + s.stage + '」：涨停溢价整体缩水，追涨与打板胜率下降，结构分的正向加成已按系数 ' + s.factor + ' 打折');
  if ((s.zbRate || 0) >= 40) warn.push('炸板率 ' + s.zbRate + '%：封板质量普遍不佳，注意「回封失败」风险');
  if ((c.limitDown || 0) > (c.limitUp || 0)) warn.push('跌停 ' + c.limitDown + ' 家多于涨停 ' + c.limitUp + ' 家，市场处于防守状态');
  $('limitWarnings').innerHTML = warn.length ? '<ul><li>' + warn.map(esc).join('</li><li>') + '</li></ul>' : '';

  const m = v.methods || {};
  $('limitMethodBody').innerHTML =
    '<p><b>板型判定</b>：' + esc(m.board || '') + '</p>' +
    '<p><b>实证基线</b>：' + esc(m.empirical || '') + '</p>' +
    '<p><b>结构分</b>：' + esc(m.score || '') + '</p>' +
    '<p><b>情绪周期</b>：' + esc(m.cycle || '') + '</p>' +
    '<p><b>边界</b>：' + esc(m.caution || '') + '</p>';
}

/* --------------------------- 评分有效性自检（IC） --------------------------- */

function icBar(ic, max) {
  const v = Number(ic);
  if (!Number.isFinite(v)) return '<span class="ic-bar flat"></span>';
  const pct = Math.min(100, Math.abs(v) / (max || 0.08) * 100);
  return '<span class="ic-bar ' + (v > 0 ? 'pos' : 'neg') + '"><i style="width:' + pct.toFixed(1) + '%"></i></span>';
}

function icSvg(series, key, color) {
  const pts = (series || []).filter(x => Number.isFinite(x[key]));
  if (pts.length < 2) return '<div class="empty">样本不足，暂无法绘制时序</div>';
  const W = 600, H = 110, pad = 18;
  const vals = pts.map(x => x[key]);
  const max = Math.max(0.06, ...vals.map(v => Math.abs(v)));
  const x = i => pad + i * (W - pad * 2) / (pts.length - 1);
  const y = v => H / 2 - v / max * (H / 2 - 10);
  const path = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p[key]).toFixed(1)).join(' ');
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" class="ic-svg" role="img" aria-label="IC 时序折线">' +
    '<line x1="' + pad + '" y1="' + (H / 2) + '" x2="' + (W - pad) + '" y2="' + (H / 2) + '" stroke="#d8d5cc" stroke-width="0.5"/>' +
    '<path d="' + path + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round"/>' +
    pts.map((p, i) => '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p[key]).toFixed(1) + '" r="1.8" fill="' + color + '"/>').join('') +
    '<text x="' + pad + '" y="' + (H - 4) + '" font-size="10" fill="#888780">' + esc(pts[0].date.slice(5)) + '</text>' +
    '<text x="' + (W - pad) + '" y="' + (H - 4) + '" font-size="10" fill="#888780" text-anchor="end">' +
    esc(pts[pts.length - 1].date.slice(5)) + '</text>' +
    '</svg>';
}

function renderIc() {
  const r = S.ic;
  const clear = msg => {
    $('icTime').textContent = '等待积累';
    $('icConclusion').innerHTML = '<div class="empty">' + esc(msg) + '</div>';
    ['icCards', 'icGroups', 'icSeries', 'icLessons', 'icMethodBody'].forEach(id => { if ($(id)) $(id).innerHTML = ''; });
  };
  if (!r) return clear('正在读取评分快照与前瞻收益…');
  if (r.status && !r.status.snapshots) {
    return clear('尚无评分快照：自检会在 14:50（收盘前）自动定格当日评分，T+1 起才有前瞻收益可算。' +
      (r.verdict && r.verdict.text ? ' ' + r.verdict.text : ''));
  }
  const st = r.status || {}, v = r.verdict || {};
  const hs = r.horizons || [];
  const h5 = hs.find(x => x.h === 5) || hs[0] || {};
  $('icTime').textContent = '更新 ' + bjTime(r.updatedAt) + ' · 快照 ' + (st.snapshots || 0) + ' 天';

  const levelCls = /有效/.test(v.level || '') && !/偏弱/.test(v.level || '') ? 'high'
    : /偏弱|不足/.test(v.level || '') ? 'mid' : 'low';
  $('icConclusion').innerHTML =
    '<div class="events-lead"><b>排序' + esc(v.level || '评估中') + '</b>' +
    '<span class="style-conf conf-' + levelCls + '">T+5 IC ' +
    (h5.mean === null || h5.mean === undefined ? '—' : (h5.mean > 0 ? '+' : '') + h5.mean) + '</span>' +
    '<span class="style-spread">观测 ' + (st.snapshots || 0) + ' 天 · 标注 ' + (st.labeled || 0) + ' 条 · 待补 ' +
    (st.pending || 0) + '</span></div>' +
    '<div class="style-text">' + esc(v.text || '') + '</div>' +
    ((v.suggestions || []).length ? '<div class="ic-sug"><b>可执行建议</b>' +
      v.suggestions.map(s => '<span>· ' + esc(s) + '</span>').join('') + '</div>' : '');

  $('icCards').innerHTML = hs.map(x =>
    '<div class="sv-card"><label>T+' + x.h + ' 前瞻</label><b>' +
    (x.mean === null || x.mean === undefined ? '—' : (x.mean > 0 ? '+' : '') + x.mean) + '</b>' +
    '<small>ICIR ' + (x.ir === null || x.ir === undefined ? '—' : x.ir) +
    ' · 正 IC ' + (x.pos === null || x.pos === undefined ? '—' : x.pos + '%') +
    ' · t ' + (x.t === null || x.t === undefined ? '—' : x.t) +
    '<br>分档差 ' + (x.spread === null || x.spread === undefined ? '—' : (x.spread > 0 ? '+' : '') + x.spread + ' pct') +
    ' · ' + (x.days || 0) + ' 天</small></div>').join('') ||
    '<div class="empty">等待到期标注</div>';

  const gs = (r.groups || []).filter(g => g.ic5 !== null && g.ic5 !== undefined);
  $('icGroups').innerHTML = gs.length
    ? gs.slice().sort((a, b) => b.ic5 - a.ic5).map(g =>
      '<div class="ic-row"><span class="ic-name">' + esc(g.label) + '</span>' +
      icBar(g.ic5) +
      '<em class="' + (g.ic5 > 0 ? 'chg-up' : g.ic5 < 0 ? 'chg-down' : 'adj-flat') + '">' +
      (g.ic5 > 0 ? '+' : '') + g.ic5 + '</em>' +
      '<span class="ic-meta">T+1 ' + (g.ic1 === null || g.ic1 === undefined ? '—' : g.ic1) +
      ' · T+10 ' + (g.ic10 === null || g.ic10 === undefined ? '—' : g.ic10) +
      (g.t !== null && g.t !== undefined ? ' · t ' + g.t : '') + '</span></div>').join('')
    : '<div class="empty">样本不足，暂无法拆分因子组</div>';

  $('icSeries').innerHTML =
    '<div class="ic-legend"><span class="ic-dot" style="background:#378ADD"></span>T+5 IC</div>' +
    (r.series && r.series.length ? icSvg(r.series, 'ic5', '#378ADD') : '<div class="empty">等待样本</div>');

  const lessons = r.lessons || [];
  $('icLessons').innerHTML = lessons.length
    ? '<ul class="ic-lessons-list">' + lessons.map(l => '<li>' + esc(l) + '</li>').join('') + '</ul>'
    : '<div class="empty">尚未生成经验条目</div>';

  $('icMethodBody').innerHTML =
    '<p><b>评估节点</b>：每个交易日 14:50（收盘前决策时点）定格一次评分快照，同一天同类型只存一次；盘中多次评分不重复记录，避免用「事后最优的那一版」自评。</p>' +
    '<p><b>前瞻收益</b>：以定格日收盘价为基准，计算 T+1/T+3/T+5/T+10 个交易日后的收益；A 股 T+1，故最短窗口为次日收盘，不评估日内。</p>' +
    '<p><b>Rank IC</b>：当天这 18 只标的的「分数排序」与「前瞻收益排序」的 Spearman 秩相关。池子每天换股票不影响评估——衡量的是同一横截面内的相对排序能力。Rank IC 对大盘涨跌天然免疫：给所有股票减去同一个基准收益，秩次不变。</p>' +
    '<p><b>为什么要滚动看</b>：18 个样本的单日 IC 标准误约 1/√17 ≈ 0.24，单日数字几乎是噪声。程序按 20 个快照日聚合，输出 IC 均值、ICIR、正 IC 占比与 t 值；只有均值 ≥0.03 且 t ≥1.5 才判「有效」。作为参照，微软 qlib 在 Alpha158/CSI300 上的主流模型 Rank IC 约 0.03–0.05。</p>' +
    '<p><b>分层与状态</b>：按得分三分位看 Top/Mid/Bottom 的平均前瞻收益是否单调；按当日两市量能分档（存量博弈 / 增量行情）分别统计 IC，检验「哪套因子在哪种市场更有效」。</p>' +
    '<p><b>经验沉淀</b>：结论自动追加到 <code>data/ic-lessons.md</code>（只追加不覆盖），包含观测窗口、IC 与显著性、因子组排序、分档单调性、市场状态分层与建议；机器可读版本在 <code>data/ic-report.json</code>，供后续调权重参考（默认不自动改权重）。</p>' +
    '<p><b>边界</b>：' + esc(r.note || '') + ' 本自检只检验「排序是否有用」，不构成买卖信号，也不代表未来仍有效。</p>';
}

/* ------------------------------- 当日观察池 ------------------------------- */

const SIG_CLASS ={ '重点关注': 'focus', '观察': 'watch', '中性': 'neutral', '谨慎': 'caution' };

/** 热度 / 舆情 / 外围联动的紧凑单元格 */
function heatCell(x) {
  const a = x.attention, g = x.groups || {}, st = x.sentiment || {};
  const heat = a
    ? '<span class="heat-badge h-' + (a.heatScore >= 75 ? 'high' : a.heatScore >= 55 ? 'warm' : 'normal') +
      '">' + esc(a.heatLevel) + ' ' + a.heatScore + '</span>'
    : '<span class="heat-none">未上热榜</span>';
  const sent = '<span class="sent-mini">' + esc(st.label || '无舆情') +
    (st.index ? ' ' + (st.index > 0 ? '+' : '') + st.index : '') + '</span>';
  const adj = Number(g.marketAdjust || 0);
  const cls = adj > 0.5 ? 'chg-up' : adj < -0.5 ? 'chg-down' : 'adj-flat';
  const link = '<span class="adj-tag ' + cls + '">外围 ' + (adj > 0 ? '+' : '') + adj + '</span>';
  return heat + sent + link;
}

function renderStocks() {
  const r = S.stocks;
  if (!r) {
    $('stocksTime').textContent = '等待计算';
    $('stocksMeta').innerHTML = '';
    $('stocksNote').className = 'stocks-note';
    $('stocksNote').textContent = '正在获取 A 股榜单与日线数据，首次计算约需 10–30 秒…';
    $('stocksBody').innerHTML = '<tr><td colspan="14" class="list-empty">正在计算…</td></tr>';
    return;
  }
  if (!r.items || !r.items.length) {
    $('stocksTime').textContent = '计算失败';
    $('stocksMeta').innerHTML = '';
    $('stocksNote').className = 'stocks-note';
    $('stocksNote').textContent = r.error || '暂无可用数据，请稍后点击「重新计算」';
    $('stocksBody').innerHTML = '<tr><td colspan="14" class="list-empty">暂无数据</td></tr>';
    return;
  }
  $('stocksTime').textContent = '生成于 ' + bjTime(r.generatedAt) + (r.fromCache ? ' · 缓存' : '');
  const u = r.universe || {}, s = r.summary || {};
  const cm = r.contextMeta || {};
  const meta = [
    '交易日 <b>' + esc(r.tradingDate || '--') + '</b>',
    esc(r.session || ''),
    '候选池 <b>' + (u.poolSize || 0) + '</b> 只',
    '深度分析 <b>' + r.items.length + '</b> 只',
    '平均评分 <b>' + (s.avgScore || 0) + '</b>',
    '重点关注 <b>' + (s.focus || 0) + '</b> / 观察 <b>' + (s.watch || 0) + '</b>',
    '高频行业 <b>' + esc(s.topIndustry || '—') + '</b>',
    '热度覆盖 <b>' + (s.heatCovered || 0) + '/' + r.items.length + '</b>',
    '舆情覆盖 <b>' + (s.sentimentCovered || 0) + '/' + r.items.length + '</b>',
    '风格覆盖 <b>' + (s.styleCovered || 0) + '/' + r.items.length + '</b>',
    '事件覆盖 <b>' + (s.eventCovered || 0) + '/' + r.items.length + '</b>'
  ];
  if (cm.marketRegime) meta.push('外围 <b>' + esc(cm.marketRegime) + '</b> ' +
    ((cm.marketScore || 0) > 0 ? '+' : '') + (cm.marketScore || 0));
  if (cm.styleDominant) meta.push('量能风格 <b>' + esc(cm.styleDominant) + '</b> ' +
    esc(cm.styleVolumeState || '') + '（置信度 ' + (cm.styleConfidence || 0) + '）');
  if (cm.volumeRegime) meta.push('市场状态 <b>' + esc(cm.volumeRegime) + '</b>（' +
    (cm.volumeAmountYi || 0).toLocaleString('zh-CN') + '/' +
    (cm.volumeThresholdYi || 0).toLocaleString('zh-CN') + ' 亿）');
  if (cm.riskOffScore !== undefined) meta.push('机构避险 <b>' + cm.riskOffScore + '/100 · ' +
    esc(cm.riskOffLevel || '') + '</b>');
  if (cm.eventTotal) meta.push('事件 <b>' + cm.eventTotal + '</b> 条（重点 ' + (cm.eventFocus || 0) +
    ' · 超预期 ' + (cm.eventBeats || 0) + ' · 龙头 ' + (cm.leaderBeats || 0) + '）');
  meta.push('本次 <b>' + (r.rescoreOnly ? '轻量重评分' : '全量重算') + '</b>');
  $('stocksMeta').innerHTML = meta.map(t => '<span>' + t + '</span>').join('');
  $('stocksNote').className = 'stocks-note' + (r.isStaleDate ? '' : ' ok');
  $('stocksNote').textContent = r.note + (r.lastError ? '（本次刷新失败：' + r.lastError + '，当前显示上次结果）' : '')
    + ' 实时联动：新闻解读、人气热榜或外围行情变化会自动重新融合评分（复用缓存技术指标）。点击任意一行查看完整依据。';

  $('stocksBody').innerHTML = r.items.map((x, i) => {
    const g = x.groups || {};
    const up = (x.changePct || 0) >= 0;
    const cls = SIG_CLASS[x.signal] || 'neutral';
    const scoreColor = x.score >= 70 ? 'var(--blue)' : x.score >= 58 ? '#5b7fd4' : 'var(--text-3)';
    return '<tr data-code="' + esc(x.code) + '"' + (S.stockDetail === x.code ? ' class="active"' : '') + '>' +
      '<td>' + (i + 1) + '</td>' +
      '<td><span class="s-name">' + esc(x.name) + '</span><span class="s-code">' + esc(x.code) + '</span></td>' +
      '<td>' + esc(x.industry) + '</td>' +
      '<td>¥' + fmtNum(x.price) + '</td>' +
      '<td class="' + (up ? 'chg-up' : 'chg-down') + '">' + (up ? '+' : '') + fmtNum(x.changePct) + '%</td>' +
      '<td><div class="score-box"><b>' + x.score + '</b><span class="score-track"><i style="width:' + x.score + '%;background:' + scoreColor + '"></i></span></div></td>' +
      '<td><span class="sig sig-' + cls + '">' + esc(x.signal) + '</span></td>' +
      '<td>' + esc(x.confidence) + '</td>' +
      '<td class="s-groups">' + (g.technical || 0) + ' / ' + (g.capital || 0) + ' / ' +
      (g.buzz === undefined ? (g.news || 0) : g.buzz) +
      (g.riskPenalty ? '<br><span style="color:var(--warn)">风险 -' + g.riskPenalty + '</span>' : '') +
      (g.valueTrapPenalty ? '<br><span style="color:var(--warn)">价值陷阱 -' + g.valueTrapPenalty + '</span>' : '') + '</td>' +
      '<td class="s-heat">' + heatCell(x) + '</td>' +
      '<td class="s-heat">' + styleCell(x) + '</td>' +
      '<td class="s-limit">' + boardCell(x) + '</td>' +
      '<td class="s-heat">' + eventCell(x) + '</td>' +
      '<td class="s-reason">' + esc((x.reasons || []).slice(0, 2).join('；')) + '</td></tr>';
  }).join('');

  const m = r.methodology || {};
  const labels = {
    indicators: '指标口径', fusion: '加权融合', sentiment: '个股舆情指数',
    heat: '关注度热度', marketLink: '外围市场联动', volumeStyle: '大盘量能与市值风格因子',
    eventDriven: '公司事件 / 业绩超预期 / 龙头板块联动', macroRegime: '存量博弈弹性与机构避险',
    limitUp: '涨停结构（板型 / 封板 / 封单 / 连板）', klinePattern: 'K 线形态 14 种',
    sentimentCycle: '市场情绪周期（六阶段）',
    stageWeights: '分层权重（阶段感知）', valueTrap: '价值陷阱过滤', evaluation: '评分有效性自检（Rank IC）',
    realtime: '实时联动机制',
    explainability: '可解释性', risk: '风险度量', noForecast: '为何不预测价格'
  };
  $('stocksMethodBody').innerHTML = Object.keys(labels).map(k =>
    '<p><b>' + labels[k] + '</b>：' + esc(m[k] || '') + '</p>').join('') +
    '<p><b>参考的 GitHub 开源项目</b>：' + (m.references || []).map(esc).join('；') + '</p>' +
    '<p><b>候选池与过滤</b>：' + esc((u.source || '')) + '；' + esc(u.filters || '') + '</p>';
  $('stocksDisclaimer').textContent = r.disclaimer || '';
  renderStocksDetail();
}

function renderStocksDetail() {
  const box = $('stocksDetail');
  const x = ((S.stocks && S.stocks.items) || []).find(v => v.code === S.stockDetail);
  if (!x) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const ind = x.indicators || {};
  const st = x.sentiment || {}, a = x.attention, ml = x.marketLink || {}, g = x.groups || {};
  const headlines = (st.headlines || []).map(h =>
    '<li><a href="' + esc(h.link || '#') + '" target="_blank" rel="noopener">' + esc(h.title || '') + '</a>' +
    '<span class="sd-hit">' + esc(h.matchKind || '') + ' · ' + esc(h.label || '') +
    (h.timeLabel ? ' · ' + esc(h.timeLabel) : '') + '</span></li>'
  ).join('') || '<li class="sd-muted">暂无命中新闻</li>';
  const heatHtml = a
    ? '<div class="sd-kv"><b>' + esc(a.heatLevel) + ' ' + a.heatScore + '/100</b> · ' + esc(a.sourceLabel) +
      '（置信度' + esc(a.confidence) + '）</div>' +
      '<div class="sd-kv">东财人气第 ' + (a.emRank === null ? '—' : a.emRank) + ' 名 / 同花顺热榜第 ' +
      (a.thsRank === null ? '—' : a.thsRank) + ' 名</div>' +
      (a.conceptTags && a.conceptTags.length ? '<div class="sd-kv">概念标签：' + esc(a.conceptTags.slice(0, 4).join('、')) + '</div>' : '') +
      (a.popularityTag ? '<div class="sd-kv">人气标记：' + esc(a.popularityTag) + '</div>' : '') +
      (a.catalyst ? '<div class="sd-kv">异动线索：' + esc(a.catalyst) + '</div>' : '')
    : '<div class="sd-muted">未进入两个热榜前 100 名，热度按中性 50 计</div>';
  const adj = Number(g.marketAdjust || 0);
  const sl = x.styleLink || {};
  const capYi = Number(sl.capValue) > 0 ? (Number(sl.capValue) / 1e8).toFixed(1) + ' 亿元' : '--';
  const styleHtml = sl.available
    ? '<div class="sd-news-block"><h4>大盘量能与市值风格 · ' + esc(sl.label) +
      '（代理 ' + esc(sl.index) + '，风格分 ' + signed(sl.score) + ' / 四层第 ' + sl.rank + '）</h4>' +
      '<div class="sd-kv">流通市值 <b>' + capYi + '</b>（分档 ' + esc(sl.capLabel) +
      '）｜全场倾向 ' + esc(sl.dominant || '--') + '｜模型置信度 ' + sl.confidence + '</div>' +
      '<div class="sd-kv">本次评分修正 <b class="' + adjCls(sl.adjustment) + '">' +
      signed(sl.adjustment) + '</b> 分 · 量比传导 ×' + (1 + (sl.volBoost || 0)).toFixed(2) + '</div>' +
      (sl.reasons || []).map(v => '<div class="sd-kv">· ' + esc(v) + '</div>').join('') + '</div>'
    : '<div class="sd-news-block"><h4>大盘量能与市值风格</h4>' +
      '<div class="sd-muted">风格数据不可用或流通市值缺失，本因子按中性 0 分计</div></div>';
  const linkHtml = '<div class="sd-kv">状态 <b>' + esc(ml.regime || '无行情') + '</b> · 本次修正 <b class="' +
    (adj > 0.5 ? 'chg-up' : adj < -0.5 ? 'chg-down' : '') + '">' + (adj > 0 ? '+' : '') + adj + '</b> 分</div>' +
    (ml.reasons || []).map(v => '<div class="sd-kv">· ' + esc(v) + '</div>').join('');
  const el = x.eventLink || {}, mc2 = x.macroLink || {};
  const eventHtml = '<div class="sd-news-block"><h4>事件驱动与宏观状态 · 合计修正 ' +
    signed((el.adjustment || 0) + (mc2.adjustment || 0), 1) + ' 分</h4>' +
    '<div class="sd-kv">五项方向性修正：外围 ' + signed(g.marketAdjust || 0, 1) +
    ' + 风格 ' + signed(g.styleAdjust || 0, 1) +
    ' + 事件 ' + signed(g.eventAdjust || 0, 1) +
    ' + 宏观 ' + signed(g.macroAdjust || 0, 1) +
    ' + 涨停 ' + signed(g.limitAdjust || 0, 1) +
    ' = ' + signed(g.adjustSum || 0, 1) + ' 分 → 实际计入 <b>' + signed(g.adjustApplied || 0, 1) +
    '</b> 分（组合上限 ±' + (g.adjustCap || 22) + '，' +
    (Number(g.adjustSum || 0) !== Number(g.adjustApplied || 0) ? '已封顶' : '未触发') + '）</div>' +
    '<div class="sd-kv"><b>' + esc(el.polarity || '中性') + '</b> · ' +
    (el.watchItem ? esc(el.watchItem.label) + '｜' + esc(String(el.watchItem.title || '').slice(0, 64)) : '无个股事件命中') +
    '｜事件 ' + signed(el.adjustment || 0, 1) + ' 分（自身 ' + signed(el.own || 0, 1) +
    ' + 板块溢出 ' + signed(el.spillover || 0, 1) + ' + 板块倾向 ' + signed(el.sector || 0, 1) + '）</div>' +
    (el.spilloverFrom ? '<div class="sd-kv">板块联动来源：<b>' + esc(el.spilloverFrom) +
      '</b> 的龙头超预期业绩（行业内信息溢出）</div>' : '') +
    '<div class="sd-kv">宏观：' + esc(mc2.volumeRegime || '--') + ' · ' + esc(mc2.bucketLabel || '--') +
    ' · 避险 ' + (mc2.riskOffScore || 0) + '/100（' + esc(mc2.riskOffLevel || '--') + '）｜修正 ' +
    signed(mc2.adjustment || 0, 1) + ' 分（市值层 ' + signed(mc2.bucketAdjust || 0, 1) +
    ' + 行业属性 ' + signed(mc2.sectorAdjust || 0, 1) + '）</div>' +
    ((el.reasons || []).slice(0, 3).concat((mc2.reasons || []).slice(0, 2)))
      .map(v => '<div class="sd-kv">· ' + esc(v) + '</div>').join('') + '</div>';

  const ll = x.limitLink || {}, pl = x.patternLink;
  const limitHtml = (ll.active || pl)
    ? '<div class="sd-news-block"><h4>涨停结构与 K 线形态' +
      (ll.active ? ' · ' + esc((ll.board && ll.board.label) || '') + (ll.boards > 1 ? ' ' + ll.boards + ' 板' : '') : '') +
      '</h4>' +
      (ll.active
        ? '<div class="sd-kv">' + esc(ll.note || '') + '｜本次修正 <b class="' + adjCls(ll.adjust) + '">' +
          signed(ll.adjust, 1) + '</b> 分（结构分 ' + ll.score + '/100 × 情绪系数 ' + ll.cycleFactor +
          ' × 成交折扣 ' + ll.fillFactor + '，市场情绪 ' + esc(ll.cycleStage || '--') + '）</div>' +
          '<div class="sd-kv">可成交性 <b>' + esc(ll.fillable || '--') + '</b>｜追高风险 ' + ll.chaseRisk +
          '/100' + (ll.industryZt ? '｜同行业涨停 ' + ll.industryZt + ' 家' : '') +
          (ll.sealFundYi ? '｜封单额 ' + ll.sealFundYi + ' 亿' : '') + '</div>' +
          '<div class="sd-kv">' + esc((ll.board && ll.board.note) || '') + '</div>' +
          (ll.parts || []).map(p => '<div class="sd-kv">· ' + esc(p.label) + ' ' + signed(p.value) +
            ' 分：' + esc(p.note || '') + '</div>').join('')
        : '<div class="sd-muted">当日未涨停，无涨停结构因子</div>') +
      (pl ? '<div class="sd-kv">K 线形态分 <b>' + pl.score + '</b>/100｜60 日位置 ' + pl.position60 + '%' +
        (pl.gap ? '｜' + (pl.gap.dir === 'up' ? '向上' : '向下') + '跳空 ' + pl.gap.from + '–' + pl.gap.to +
          (pl.gap.filled ? '（已回补）' : '（未回补）') : '') + '</div>' +
        (pl.flags.length
          ? pl.flags.map(f => '<div class="sd-kv">· ' + esc(f.label) + '（' + (f.strength > 0 ? '+' : '') +
            f.strength + '）：' + esc(f.note) + '</div>').join('')
          : '<div class="sd-muted">未识别到显著形态</div>')
        : '') +
      '</div>'
    : '';

  const wgt = g.weights || {};
  const val = x.valuation || {};
  const weightHtml = '<div class="sd-news-block"><h4>权重结构（按市值层切换）与估值检查</h4>' +
    (wgt.bucket ? '<div class="sd-kv">当前分层 <b>' + esc(wgt.bucket) + '</b> → 技术 ' +
      Math.round((wgt.technical || 0) * 100) + '% / 资金 ' + Math.round((wgt.capital || 0) * 100) +
      '% / 舆情热度 ' + Math.round((wgt.buzz || 0) * 100) + '%（微盘偏情绪、大盘偏趋势与资金）</div>' : '') +
    '<div class="sd-kv">估值：动态 PE ' + (val.pe === null || val.pe === undefined ? '—' : val.pe) +
    ' · PB ' + (val.pb === null || val.pb === undefined ? '—' : val.pb) + ' · ' +
    (val.cheap ? '处于低估值区间（PE ≤ 25）' : '非低估值或数据缺失') + '</div>' +
    (val.valueTrap ? '<div class="sd-kv" style="color:var(--warn)"><b>价值陷阱扣分 -' +
      (g.valueTrapPenalty || 0) + ' 分</b>：' + esc(val.note || '') + '</div>' : '') +
    '<div class="sd-kv">风险惩罚合计 -' + (g.totalPenalty === undefined ? (g.riskPenalty || 0) : g.totalPenalty) +
    ' 分（技术面 -' + (g.riskPenalty || 0) + ' / 价值陷阱 -' + (g.valueTrapPenalty || 0) + '）</div></div>';

  box.innerHTML = '<div style="font-weight:800;margin-bottom:7px">' + esc(x.name) + '（' + esc(x.code) +
    '） · 综合评分 ' + x.score + ' · ' + esc(x.signal) + ' · 置信度' + esc(x.confidence) + '</div>' +
    '<div class="sd-grid">' +
    '<div class="sd-col"><h4>评分理由</h4><ul>' + (x.reasons || []).map(v => '<li>' + esc(v) + '</li>').join('') + '</ul></div>' +
    '<div class="sd-col"><h4>风险提示</h4><ul>' + (x.risks || []).map(v => '<li>' + esc(v) + '</li>').join('') + '</ul></div>' +
    '<div class="sd-col"><h4>消息面与来源</h4><div>' + esc(x.newsNote || '') + '</div>' +
    '<div class="sd-muted" style="margin-top:5px">入池榜单：' + esc((x.ranks || []).join('、')) + '；数据源：' + esc(x.source || '') +
    '；日线 ' + x.bars + ' 根；ATR 波动参考位 ¥' + fmtNum(x.atrStopRef) + '（收盘价 − 2×ATR14，非止损建议）</div></div>' +
    '<div class="sd-col"><h4>人气热度 / 外围联动</h4>' + heatHtml +
    '<div class="sd-sep"></div>' + linkHtml + '</div>' +
    '</div>' +
    styleHtml +
    limitHtml +
    eventHtml +
    weightHtml +
    '<div class="sd-news-block"><h4>舆情依据 · ' + esc(st.label || '无') + '（情绪指数 ' + (st.index || 0) +
    ' / 资讯覆盖 ' + (st.coverageScore || 0) + ' / 置信度' + esc(st.confidence || '无') + '）</h4>' +
    '<div class="sd-muted">' + esc(st.note || '') + '</div><ul class="sd-news">' + headlines + '</ul></div>' +
    '<div class="sd-ind"><b>关键指标</b>：RSI14 ' + ind.rsi14 + ' · MACD 柱 ' + ind.macdHist +
    ' · 5日动量 ' + ind.mom5 + '% · 20日动量 ' + ind.mom20 + '% · 年化波动率 ' + ind.volatility +
    '% · ATR ' + ind.atrPct + '% · Z-score ' + ind.zScore + ' · 布林位置 ' + ind.bollPos +
    ' · 20日最大回撤 ' + ind.maxDrawdown + '% · MA5 ' + ind.ma5 + ' / MA20 ' + ind.ma20 + '</div>';
}

/* ------------------------------- 声音 / 通知 / 消息 ------------------------------- */

let actx = null;
function ensureAudio() {
  try {
    if (!actx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;
      actx = new Ctor();
    }
    if (actx.state === 'suspended') actx.resume();
    S.audioUnlocked = true;
    updateBanner();
    return true;
  } catch (_) { return false; }
}

function beep(level) {
  const c = S.config && S.config.sound;
  if (!c || !c.enabled) return;
  if ((LEVEL_RANK[level] || 0) < (LEVEL_RANK[c.minLevel] || 1)) return;
  if (!ensureAudio() || !actx) return;
  const vol = Math.max(0, Math.min(1, Number(c.volume) || 0.55));
  const patterns = {
    info: [[660, 0, 0.13]],
    warning: [[720, 0, 0.14], [900, 0.17, 0.17]],
    critical: [[820, 0, 0.12], [1040, 0.14, 0.12], [820, 0.29, 0.19]]
  };
  const t0 = actx.currentTime;
  (patterns[level] || patterns.info).forEach(p => {
    const osc = actx.createOscillator(), gain = actx.createGain();
    osc.type = level === 'critical' ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(p[0], t0 + p[1]);
    gain.gain.setValueAtTime(0.0001, t0 + p[1]);
    gain.gain.exponentialRampToValueAtTime(vol * 0.18, t0 + p[1] + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + p[1] + p[2]);
    osc.connect(gain); gain.connect(actx.destination);
    osc.start(t0 + p[1]); osc.stop(t0 + p[1] + p[2] + 0.03);
  });
}

function desktopNotify(a) {
  const c = S.config && S.config.notification;
  if (!c || !c.enabled) return;
  if ((LEVEL_RANK[a.level] || 0) < (LEVEL_RANK[c.minLevel] || 2)) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(a.title, { body: a.message, tag: a.id, silent: true });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), 12000);
  } catch (_) { /* 部分浏览器在应用窗口模式下不支持 */ }
}

function toast(a) {
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + (a.demo ? 'demo' : a.level);
  el.innerHTML = '<div class="t-head"><span class="t-title">' + esc(a.title) + '</span>' +
    '<span class="t-time">' + esc(bjTime(a.ts)) + '</span></div>' +
    '<div class="t-msg">' + esc(a.message) + '</div>' +
    '<div class="t-src">' + (a.demo ? '模拟数据 · 链路自检' : esc(a.source || '系统')) +
    (a.silent ? ' · 免打扰（仅显示消息）' : '') + '</div>';
  wrap.appendChild(el);
  while (wrap.children.length > 4) wrap.removeChild(wrap.firstChild);
  const life = a.level === 'critical' ? 9000 : 6000;
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0'; el.style.transform = 'translateX(18px)';
    setTimeout(() => el.remove(), 260);
  }, life);
}

const originalTitle = document.title;
let flashTimer = null, flashOn = false;
function flashTitle() {
  clearInterval(flashTimer);
  let n = 0;
  flashTimer = setInterval(() => {
    document.title = (flashOn ? '【新告警】' : '') + originalTitle;
    flashOn = !flashOn;
    if (++n > 14) { clearInterval(flashTimer); document.title = originalTitle; }
  }, 700);
}
window.addEventListener('focus', () => { clearInterval(flashTimer); document.title = originalTitle; });

function onNewAlert(a) {
  if (!a || !a.id || S.alerts.some(x => x.id === a.id)) return;
  S.alerts.push(a);
  if (S.alerts.length > 400) S.alerts = S.alerts.slice(-400);
  toast(a);
  if (!a.silent) { beep(a.level); desktopNotify(a); }
  if (a.level === 'critical' && !a.demo) flashTitle();
  renderAlerts(); renderSummary();
}

function updateBanner() {
  const b = $('banner');
  const hasNotif = 'Notification' in window;
  const needAudio = S.config && S.config.sound && S.config.sound.enabled && !S.audioUnlocked;
  const needPerm = hasNotif && S.config && S.config.notification && S.config.notification.enabled &&
    Notification.permission === 'default';
  const denied = hasNotif && Notification.permission === 'denied' &&
    S.config && S.config.notification && S.config.notification.enabled;
  if (!needAudio && !needPerm && !denied) { b.className = 'banner hidden'; return; }
  let html = '<span>';
  if (needAudio) html += '浏览器要求先有一次交互才能播放声音，请点击页面任意处或右侧按钮启用提示音。';
  if (needAudio && needPerm) html += ' ';
  if (needPerm) html += '桌面通知尚未授权，授权后严重告警可弹出系统通知。';
  if (denied) html += '桌面通知已被浏览器阻止，请在浏览器站点设置中允许通知后刷新页面。';
  html += '</span><span>';
  if (needAudio) html += '<button id="bannerAudio">启用声音</button> ';
  if (needPerm) html += '<button id="bannerPerm">开启通知</button>';
  html += '</span>';
  b.className = 'banner';
  b.innerHTML = html;
  if ($('bannerAudio')) $('bannerAudio').onclick = () => { ensureAudio(); beep('info'); };
  if ($('bannerPerm')) $('bannerPerm').onclick = () => {
    if ('Notification' in window) Notification.requestPermission().then(updateBanner);
  };
}

function updateToggles() {
  const c = S.config || {};
  $('btnSound').className = 'toggle' + (c.sound && c.sound.enabled ? ' on' : '');
  $('btnSound').title = c.sound && c.sound.enabled ? '声音已开启，点击关闭' : '声音已关闭，点击开启';
  $('btnNotify').className = 'toggle' + (c.notification && c.notification.enabled ? ' on' : '');
  $('btnNotify').title = c.notification && c.notification.enabled ? '桌面通知已开启，点击关闭' : '桌面通知已关闭，点击开启';
  $('permText').textContent = !('Notification' in window) ? '浏览器不支持'
    : ({ granted: '已授权', default: '未授权', denied: '已阻止' }[Notification.permission] || '--');
}

/* ------------------------------- 设置抽屉 ------------------------------- */

function rulesRowsHtml() {
  return RULE_ROWS.map(r => {
    const c = (S.config.rules && S.config.rules[r.id]) || {};
    const mvField = r.bp ? 'moveBp' : 'movePct';
    const dyField = r.bp ? 'dayBp' : 'dayPct';
    const unit = r.bp ? 'bp' : '%';
    const inp = (f, v) => '<input type="number" step="0.01" data-field="' + f + '" value="' +
      (v === null || v === undefined ? '' : v) + '" placeholder="空">';
    return '<tr data-id="' + r.id + '">' +
      '<td class="rname">' + esc(r.name) + '<span class="runit">' + esc(r.unit) + '</span></td>' +
      '<td><input type="checkbox" data-field="enabled" ' + (c.enabled !== false ? 'checked' : '') + '></td>' +
      '<td>' + inp('upper', c.upper) + '</td>' +
      '<td>' + inp('lower', c.lower) + '</td>' +
      '<td>' + inp(mvField, c[mvField]) + '<span class="runit">' + unit + '</span></td>' +
      '<td>' + inp(dyField, c[dyField]) + '<span class="runit">' + unit + '</span></td>' +
      '</tr>';
  }).join('');
}

function fillSettings() {
  const c = S.config;
  if (!c) return;
  $('cfgQuoteInterval').value = c.quoteIntervalSec;
  $('cfgNewsInterval').value = c.newsIntervalSec;
  $('cfgCooldown').value = c.cooldownSec;
  $('cfgSoundEnabled').checked = !!c.sound.enabled;
  $('cfgNotifyEnabled').checked = !!c.notification.enabled;
  $('cfgVolume').value = Math.round(c.sound.volume * 100);
  $('volText').textContent = Math.round(c.sound.volume * 100) + '%';
  $('cfgSoundMin').value = c.sound.minLevel;
  $('cfgNotifyMin').value = c.notification.minLevel;
  $('cfgQuietEnabled').checked = !!c.quietHours.enabled;
  $('cfgQuietFrom').value = c.quietHours.from;
  $('cfgQuietTo').value = c.quietHours.to;
  $('cfgNewsAlertEnabled').checked = !!c.newsAlert.enabled;
  $('cfgKeywords').value = (c.newsAlert.keywords || []).join(', ');
  const an = c.analysis || {}, sk = c.stocks || {}, at = c.attention || {}, ms = c.marketStyle || {};
  $('cfgAnalysisEnabled').checked = an.enabled !== false;
  $('cfgAutoTranslate').checked = an.autoTranslate !== false;
  $('cfgTranslateDesc').value = an.translateDescLimit === undefined ? 40 : an.translateDescLimit;
  $('cfgAnalysisRefresh').value = an.refreshSec === undefined ? 180 : an.refreshSec;
  $('cfgStocksEnabled').checked = sk.enabled !== false;
  $('cfgStocksMax').value = sk.maxStocks === undefined ? 18 : sk.maxStocks;
  $('cfgStocksRefresh').value = sk.refreshMin === undefined ? 15 : sk.refreshMin;
  $('cfgAttentionEnabled').checked = at.enabled !== false;
  $('cfgAttentionRefresh').value = at.refreshMin === undefined ? 5 : at.refreshMin;
  $('cfgStyleEnabled').checked = ms.enabled !== false;
  $('cfgStyleBreadth').checked = ms.breadthEnabled !== false;
  $('cfgStyleRefresh').value = ms.refreshMin === undefined ? 5 : ms.refreshMin;
  $('cfgStyleMaxAdjust').value = ms.maxAdjust === undefined ? 12 : ms.maxAdjust;
  const ev = c.events || {};
  $('cfgEventsEnabled').checked = ev.enabled !== false;
  $('cfgEventsAlert').checked = ev.alertEnabled !== false;
  $('cfgRiskOffEnabled').checked = ev.riskOffEnabled !== false;
  $('cfgVolumeThreshold').value = ev.volumeThresholdYi === undefined ? 25000 : ev.volumeThresholdYi;
  $('cfgLeaderCap').value = ev.leaderCapYi === undefined ? 500 : ev.leaderCapYi;
  $('cfgEventLookback').value = ev.lookbackDays === undefined ? 14 : ev.lookbackDays;
  $('cfgEventsRefresh').value = ev.refreshMin === undefined ? 5 : ev.refreshMin;
  $('cfgEventMaxAdjust').value = ev.maxAdjust === undefined ? 12 : ev.maxAdjust;
  $('cfgTotalMaxAdjust').value = ev.maxTotalAdjust === undefined ? 22 : ev.maxTotalAdjust;
  $('cfgStageWeights').checked = sk.stageWeights !== false;
  $('cfgValueTrap').checked = sk.valueTrapEnabled !== false;
  const ic = c.ic || {};
  $('cfgIcEnabled').checked = ic.enabled !== false;
  $('cfgIcSnapshot').value = (ic.snapshots && ic.snapshots[0]) || 'pm';
  $('cfgIcHorizons').value = (ic.horizons || [1, 3, 5, 10]).join(',');
  $('cfgIcRoll').value = ic.rollDays === undefined ? 20 : ic.rollDays;
  const jr = c.journal || {};
  $('cfgJournalEnabled').checked = jr.enabled !== false;
  $('cfgJournalOpen').value = jr.openTime || '09:05';
  $('cfgJournalEve').value = jr.eveTime || '22:00';
  $('cfgJournalReview').value = jr.reviewTime || '15:10';
  $('cfgJournalLive').checked = jr.liveEnabled !== false;
  $('cfgJournalLiveLimit').value = jr.liveLimit || 12;
  const cy = c.cycle || {};
  $('cfgCycleEnabled').checked = cy.enabled !== false;
  const fl = c.flow || {};
  $('cfgFlowEnabled').checked = fl.enabled !== false;
  $('cfgFlowSeatMin').value = fl.hfSeatMin === undefined ? 20 : fl.hfSeatMin;
  $('cfgRiskoffEnabled').checked = (c.riskoff || {}).enabled !== false;
  const ed = c.edge || {};
  $('cfgEdgeEnabled').checked = ed.enabled !== false;
  $('cfgEdgeRefresh').value = ed.refreshMin === undefined ? 10 : ed.refreshMin;
  $('cfgEdgeValLimit').value = ed.valuationLimit === undefined ? 30 : ed.valuationLimit;
  $('rulesBody').innerHTML = rulesRowsHtml();
  updateToggles();
}

function collectConfig() {
  const c = structuredClone(S.config);
  c.quoteIntervalSec = Number($('cfgQuoteInterval').value);
  c.newsIntervalSec = Number($('cfgNewsInterval').value);
  c.cooldownSec = Number($('cfgCooldown').value);
  c.sound.enabled = $('cfgSoundEnabled').checked;
  c.notification.enabled = $('cfgNotifyEnabled').checked;
  c.sound.volume = Number($('cfgVolume').value) / 100;
  c.sound.minLevel = $('cfgSoundMin').value;
  c.notification.minLevel = $('cfgNotifyMin').value;
  c.quietHours.enabled = $('cfgQuietEnabled').checked;
  c.quietHours.from = $('cfgQuietFrom').value;
  c.quietHours.to = $('cfgQuietTo').value;
  c.newsAlert.enabled = $('cfgNewsAlertEnabled').checked;
  c.newsAlert.keywords = $('cfgKeywords').value.split(/[,\n，]/).map(s => s.trim()).filter(Boolean);
  c.analysis = c.analysis || {};
  c.analysis.enabled = $('cfgAnalysisEnabled').checked;
  c.analysis.autoTranslate = $('cfgAutoTranslate').checked;
  c.analysis.translateDescLimit = Number($('cfgTranslateDesc').value);
  c.analysis.refreshSec = Number($('cfgAnalysisRefresh').value);
  c.stocks = c.stocks || {};
  c.stocks.enabled = $('cfgStocksEnabled').checked;
  c.stocks.maxStocks = Number($('cfgStocksMax').value);
  c.stocks.refreshMin = Number($('cfgStocksRefresh').value);
  c.attention = c.attention || {};
  c.attention.enabled = $('cfgAttentionEnabled').checked;
  c.attention.refreshMin = Number($('cfgAttentionRefresh').value);
  c.marketStyle = c.marketStyle || {};
  c.marketStyle.enabled = $('cfgStyleEnabled').checked;
  c.marketStyle.breadthEnabled = $('cfgStyleBreadth').checked;
  c.marketStyle.refreshMin = Number($('cfgStyleRefresh').value);
  c.marketStyle.maxAdjust = Number($('cfgStyleMaxAdjust').value);
  c.events = c.events || {};
  c.events.enabled = $('cfgEventsEnabled').checked;
  c.events.alertEnabled = $('cfgEventsAlert').checked;
  c.events.riskOffEnabled = $('cfgRiskOffEnabled').checked;
  c.events.volumeThresholdYi = Number($('cfgVolumeThreshold').value);
  c.events.leaderCapYi = Number($('cfgLeaderCap').value);
  c.events.lookbackDays = Number($('cfgEventLookback').value);
  c.events.refreshMin = Number($('cfgEventsRefresh').value);
  c.events.maxAdjust = Number($('cfgEventMaxAdjust').value);
  c.events.maxTotalAdjust = Number($('cfgTotalMaxAdjust').value);
  c.stocks.stageWeights = $('cfgStageWeights').checked;
  c.stocks.valueTrapEnabled = $('cfgValueTrap').checked;
  c.ic = c.ic || {};
  c.ic.enabled = $('cfgIcEnabled').checked;
  c.ic.snapshots = [$('cfgIcSnapshot').value];
  c.ic.horizons = $('cfgIcHorizons').value.split(/[,\s，]+/).map(Number).filter(n => n >= 1 && n <= 30);
  if (!c.ic.horizons.length) c.ic.horizons = [1, 3, 5, 10];
  c.ic.rollDays = Number($('cfgIcRoll').value);
  c.journal = c.journal || {};
  c.journal.enabled = $('cfgJournalEnabled').checked;
  c.journal.openTime = $('cfgJournalOpen').value || '09:05';
  c.journal.eveTime = $('cfgJournalEve').value || '22:00';
  c.journal.reviewTime = $('cfgJournalReview').value || '15:10';
  c.journal.liveEnabled = $('cfgJournalLive').checked;
  c.journal.liveLimit = Number($('cfgJournalLiveLimit').value) || 12;
  c.cycle = c.cycle || {};
  c.cycle.enabled = $('cfgCycleEnabled').checked;
  c.flow = c.flow || {};
  c.flow.enabled = $('cfgFlowEnabled').checked;
  c.flow.hfSeatMin = Number($('cfgFlowSeatMin').value) || 20;
  c.riskoff = c.riskoff || {};
  c.riskoff.enabled = $('cfgRiskoffEnabled').checked;
  c.edge = c.edge || {};
  c.edge.enabled = $('cfgEdgeEnabled').checked;
  c.edge.refreshMin = Number($('cfgEdgeRefresh').value) || 10;
  c.edge.valuationLimit = Number($('cfgEdgeValLimit').value) || 30;
  c.rules = {};
  document.querySelectorAll('#rulesBody tr[data-id]').forEach(tr => {
    const g = f => { const el = tr.querySelector('[data-field="' + f + '"]'); return el ? el.value : ''; };
    const n = f => (g(f) === '' ? null : Number(g(f)));
    c.rules[tr.dataset.id] = {
      enabled: tr.querySelector('[data-field="enabled"]').checked,
      upper: n('upper'), lower: n('lower'),
      movePct: n('movePct'), dayPct: n('dayPct'),
      moveBp: n('moveBp'), dayBp: n('dayBp')
    };
  });
  return c;
}

function openSettings() {
  fillSettings();
  $('settings').classList.remove('hidden');
  $('settingsMask').classList.remove('hidden');
}
function closeSettings() {
  $('settings').classList.add('hidden');
  $('settingsMask').classList.add('hidden');
}

/* ------------------------------- 渲染总入口 ------------------------------- */

/* ===================== 闭环四模块：经验库 / 周期事件 / 资金主体 / 避险 ===================== */

const sig = (v, n = 1) => (v > 0 ? '+' : '') + (v == null ? '—' : (n ? Number(v).toFixed(n).replace(/\.0$/, '') : v));

function renderJournal() {
  const j = S.journal;
  const el = id => $(id);
  if (!j) {
    el('journalTime').textContent = '等待定格';
    return;
  }
  el('journalTime').textContent = '定格 ' + (j.lastPick ? j.lastPick.date + ' ' + (j.lastPick.kind === 'open' ? '开盘档' : '收盘档') : '—') +
    ' · 复盘 ' + j.outcomes + ' 条 · 待审 ' + (j.lessons && j.lessons.pending || 0);

  const read = j.readiness || '';
  el('journalStatus').innerHTML =
    '<div class="events-lead"><b>样本充足度：' + esc(read) + '</b>' +
    (j.overall ? '<span class="style-spread">全部 ' + j.overall.n + ' 条 · 命中率 ' + j.overall.hitRate +
      '% · 平均超额 ' + sig(j.overall.avgExcess) + '%</span>' : '') +
    (j.focus ? '<span class="style-spread">重点关注 ' + j.focus.n + ' 条 · 命中率 ' + j.focus.hitRate +
      '% · 平均超额 ' + sig(j.focus.avgExcess) + '%</span>' : '') + '</div>' +
    '<div class="style-text">' + (j.lastPick ? '名单在 09:05（当日观察，含美股隔夜与亚太早盘的外围市况）与 22:00（次日决策）各冻结一次，复盘以「次日跑赢同市值层基准」为命中口径' : '尚未产生定格名单，等待下一个交易日的定格时点') + '</div>';

  // 实时观察池（盘中滚动更新，不作为复盘基准）
  const lv = j.live;
  if (lv && lv.items && lv.items.length) {
    const staleMin = Math.round((Date.now() - (lv.updatedAt || 0)) / 60000);
    const staleTag = staleMin > 15 ? '（' + staleMin + ' 分钟前，非交易时段停止滚动）' : '';
    const recentChanges = (lv.changes || []).slice(-6).reverse();
    el('journalLive').innerHTML =
      '<div class="jl-live-head">更新于 ' + esc(lv.hhmm || '—') + staleTag +
      ' · ' + lv.items.length + ' 只 · 重点关注 ' + ((lv.context && lv.context.focusCount) || 0) + ' 只' +
      (recentChanges.length ? ' · 近期变动：' + recentChanges.map(c =>
        '<span class="' + (c.type === 'in' ? 'jl-in' : 'jl-out') + '">' + (c.type === 'in' ? '↑' : '↓') + esc(c.name) + '</span>').join(' ') : '') + '</div>' +
      lv.items.slice(0, 12).map((it, i) =>
        '<div class="jp-item' + (it.isNew ? ' jl-new' : '') + '"><span class="jp-rank">' + (i + 1) + '</span>' +
        '<span class="jp-name">' + esc(it.name) + '</span>' +
        (it.isNew ? '<span class="jl-badge">新进 ' + esc(it.enteredHhmm || '') + '</span>' : '') +
        '<span class="board-tag ' + (it.board ? ({ one: 'one', t: 't', reseal: 'reseal', turn: 'turn', fail: 'fail' }[it.board] || '') : '') + '">' +
        esc(it.boardLabel || '非涨停') + '</span>' +
        '<span class="jp-score">' + it.score + ' · ' + esc(it.signal) +
        (it.changePct != null ? ' · ' + sig(it.changePct) + '%' : '') +
        (it.prevScore != null && it.prevScore !== it.score ? '（前值 ' + it.prevScore + '）' : '') + '</span>' +
        '<div class="jp-thesis">' + esc(it.thesis) + '</div></div>').join('');
  } else {
    el('journalLive').innerHTML = '<div class="empty">等待交易时段，盘中自动滚动更新（非交易时段显示最近一次结果）</div>';
  }

  // 最新定格名单
  const picks = j.latestPicks || [];
  const ovsLine = ovs => (ovs || []).map(o =>
    esc(o.short) + ' ' + sig(o.changePct) + '%').join(' · ');
  el('journalPicks').innerHTML = picks.length ? picks.map(p =>
    '<div class="jp-block"><div class="jp-head">' + esc(p.date) + ' · ' + (p.kind === 'open' ? '开盘前定格（当日观察）' : '收盘后定格（次日决策）') +
    (p.context && p.context.sentimentStage ? ' · 情绪' + esc(p.context.sentimentStage) : '') +
    (p.context && p.context.volumeYi ? ' · 量能 ' + p.context.volumeYi + ' 亿' : '') + '</div>' +
    (p.context && p.context.overseas && p.context.overseas.length
      ? '<div class="jp-ovs">外围市况（定格时点）：' + ovsLine(p.context.overseas) + '</div>' : '') +
    p.items.slice(0, 10).map((it, i) =>
      '<div class="jp-item"><span class="jp-rank">' + (i + 1) + '</span>' +
      '<span class="jp-name">' + esc(it.name) + '</span>' +
      '<span class="board-tag ' + (it.board ? ({ one: 'one', t: 't', reseal: 'reseal', turn: 'turn', fail: 'fail' }[it.board] || '') : '') + '">' +
      esc(it.boardLabel || '非涨停') + '</span>' +
      '<span class="jp-score">' + it.score + ' · ' + esc(it.signal) + '</span>' +
      '<div class="jp-thesis">' + esc(it.thesis) + '</div>' +
      '<div class="jp-quant">' + (it.quant || []).map(esc).join(' ｜ ') + '</div></div>').join('') +
    '</div>').join('') : '<div class="empty">尚无定格名单</div>';

  // 复盘统计卡
  el('journalStats').innerHTML = j.overall ? [
    card('复盘样本', j.overall.n + ' 条', '次日收益可得的定格'),
    card('命中率', j.overall.hitRate + '%', '跑赢同市值层基准'),
    card('平均次日', sig(j.overall.avgRet) + '%', '绝对收益'),
    card('平均超额', sig(j.overall.avgExcess) + '%', '相对同层基准'),
    card('盈亏比', j.overall.payoff || '—', '正超额 / 负超额幅度')
  ].join('') : '<div class="empty">复盘尚未产生样本（定格后的下一个交易日收盘自动回填）</div>';

  // 待审经验
  const pend = j.lessonsList || [];
  el('journalLessons').innerHTML = pend.filter(l => l.status === 'pending').length
    ? pend.filter(l => l.status === 'pending').slice(0, 6).map(l =>
      '<div class="jl-item"><div class="jl-claim">' + esc(l.claim) + '</div>' +
      '<div class="jl-meta">维度：' + esc(l.dimLabel) + ' · 置信 ' + esc(l.confidence) +
      (l.proposal ? ' · 回流建议 ×' + l.proposal.mult : ' · 仅观察结论') + '</div>' +
      '<div class="jl-actions"><button class="btn tiny" onclick="auditLesson(\'' + l.id + '\',\'approve\')">采纳并回流</button>' +
      '<button class="btn tiny ghost" onclick="auditLesson(\'' + l.id + '\',\'reject\')">驳回</button></div></div>').join('')
    : '<div class="empty">暂无待审经验（复盘样本 ≥ 8 条后按维度自动归纳）</div>';

  // 已生效规则
  const rules = (j.rules && j.rules.items) || [];
  el('journalRules').innerHTML = rules.length
    ? '<div class="an-subhead" style="margin-top:8px">已生效回流规则（' + rules.length + ' 条）</div>' + rules.map(r =>
      '<div class="jr-item">×' + r.mult + ' ｜ ' + esc(r.note || r.key) + '</div>').join('')
    : '';
}

function card(title, value, note) {
  return '<div class="sv-card"><div class="sv-label">' + esc(title) + '</div>' +
    '<div class="sv-value">' + esc(String(value)) + '</div>' +
    '<div class="sv-note">' + esc(note || '') + '</div></div>';
}

/* ===================== 预期研究与多因素叠加 ===================== */

const signPct = v => (v == null || !Number.isFinite(Number(v))) ? '--'
  : (Number(v) > 0 ? '+' : '') + Number(v) + '%';
const valClass = v => v == null ? '' : Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : '';

function renderEdge() {
  const e = S.edge;
  if (!e || !e.ok) {
    $('edgeTime').textContent = '等待研究';
    $('edgeConclusion').innerHTML = '<div class="empty">预期研究层尚未就绪（启动后约 30 秒首次构建），或已在设置中关闭</div>';
    ['edgeStrength', 'edgeValuation', 'edgePhase', 'edgeStack', 'edgeMethodBody'].forEach(id => { $(id).innerHTML = ''; });
    return;
  }
  $('edgeTime').textContent = '更新 ' + relTime(e.builtAt);
  const st = e.strength, val = e.valuation, ph = e.phase, stk = e.stack, cyc = e.cycle;

  /* 顶部结论：只陈述事实与状态，不预测 */
  const mainNames = (st && st.mainlines || []).slice(0, 3).map(m => m.name).join('、');
  const bench = st && st.benchmark ? st.benchmark : null;
  $('edgeBench').textContent = bench
    ? '相对沪深300（5日 ' + signPct(bench.r5) + ' / 10日 ' + signPct(bench.r10) + ' / 60日 ' + signPct(bench.r60) + '）'
    : '相对沪深300';
  $('edgeConclusion').innerHTML =
    '<div class="edge-cards">' +
    card('全市场板块', st ? st.counts.total : '--', '横截面排名 · ' + (st ? st.date : '--')) +
    card('趋势主线', st ? st.mainlines.length : '--', mainNames || '暂无') +
    card('重估候选', val ? val.counts.total : '--', val ? '条件较齐备 ' + val.counts.ready + ' / 否决 ' + val.counts.veto : '--') +
    card('阶段结论', ph ? ph.counts.qualified : '--', ph ? ph.counts.boards + ' 个板块 · ' + ph.counts.samples + ' 个不重叠窗口' : '--') +
    card('多重共振', stk ? stk.counts.resonance : '--', stk ? '信号分歧 ' + stk.counts.divergence + ' 只' : '--') +
    '</div>' +
    '<div class="style-text">叠加形态（共振 / 分歧）只写入经验库定格存证，由 T+1 复盘统计裁决是否真有超额；<strong>不修改任何评分</strong>。</div>';

  /* ① 板块相对强弱 */
  if (!st || !st.ok) $('edgeStrength').innerHTML = '<div class="empty">' + esc(st ? st.error : '板块数据不可用') + '</div>';
  else {
    const rows = st.mainlines.slice(0, 8).map(m =>
      '<div class="es-row' + (m.crowded ? ' es-crowded' : '') + '">' +
      '<span class="es-rank">#' + m.rank + '</span>' +
      '<span class="es-name">' + esc(m.name) + '<em>' + esc(m.category) + '</em></span>' +
      '<span class="es-stage">' + esc(m.label) + '</span>' +
      '<span class="' + valClass(m.ex5) + '">' + signPct(m.ex5) + '</span>' +
      '<span class="' + valClass(m.ex10) + '">' + signPct(m.ex10) + '</span>' +
      '<span class="' + valClass(m.ex60) + '">' + signPct(m.ex60) + '</span>' +
      '<span class="es-note">' + esc(m.crowdNote) + '</span></div>').join('');
    $('edgeStrength').innerHTML =
      '<div class="es-head"><span>#</span><span>板块</span><span>阶段</span><span>5日超额</span><span>10日超额</span><span>60日超额</span><span>拥挤度 / 说明</span></div>' +
      rows +
      '<div class="edge-note">主线分 = 0.5×5日 + 0.3×10日 + 0.2×60日超额，近期权重更高以识别「正在变强」。' +
      '板块一/二/三级混排，罗马数字变体已折叠。<span class="down">⚠ 拥挤度偏高</span>表示成交额处高分位，警惕最后一棒。</div>';
  }

  /* ② 市值重估条件清单 */
  if (!val || !val.candidates || !val.candidates.length)
    $('edgeValuation').innerHTML = '<div class="empty">当前公告窗口内未检出重组 / 拟并购 / 回购类重点事件（或事件数据尚未就绪）</div>';
  else {
    $('edgeValuation').innerHTML = val.candidates.slice(0, 10).map(c => {
      const met = c.conditions.filter(x => x.met === true).length;
      const unmet = c.conditions.filter(x => x.met === false).length;
      const na = c.conditions.filter(x => x.met === null).length;
      const cls = c.verdict === 'ready' ? 'ev-ready' : c.verdict === 'veto' ? 'ev-veto' :
        c.verdict === 'partial' ? 'ev-partial' : 'ev-weak';
      return '<details class="ev-item ' + cls + '">' +
        '<summary><span class="ev-v">' + esc(c.verdictLabel) + '</span> ' +
        '<strong>' + esc(c.name) + '</strong> <span class="ev-code">' + esc(c.code) + '</span> ' +
        esc(c.typeLabel) + ' · 条件齐备度 ' + c.score + '/100 ' +
        '<span class="ev-meta">满足 ' + met + ' / 未满足 ' + unmet + ' / 无数据 ' + na + '</span></summary>' +
        '<div class="ev-body">' +
        '<div class="ev-title">' + esc(c.title) + '</div>' +
        '<div class="ev-mech">' + esc(c.mechanism) + '｜' + esc(c.mechanismNote) + '</div>' +
        '<div class="ev-grid">' + c.conditions.map(x =>
          '<div class="ev-cond ' + (x.met === true ? 'ok' : x.met === false ? 'no' : 'na') + '">' +
          '<span class="ev-mark">' + (x.met === true ? '✓' : x.met === false ? '✗' : '—') + '</span>' +
          '<span class="ev-cl"><b>' + esc(x.label) + '</b><small>' + esc(x.group) + ' · ' + esc(x.source) + '</small></span>' +
          '<span class="ev-cd">' + esc(x.detail) + '</span></div>').join('') + '</div>' +
        (c.elasticity ? '<div class="ev-note">流通市值 ' + c.elasticity.floatCapYi + ' 亿：' + esc(c.elasticity.note) + '。' + esc(c.elasticity.caveat) + '</div>' : '') +
        '<div class="ev-note">反证与边界：' + c.counterEvidence.map(esc).join('；') + '</div>' +
        (c.link ? '<a class="ev-link" href="' + esc(c.link) + '" target="_blank" rel="noopener">查看公告原文 ↗</a>' : '') +
        '</div></details>';
    }).join('') +
    '<div class="edge-note">' + esc(val.disclaimer) + '</div>';
  }

  /* ③ 板块阶段研究：两层口径并列 */
  let phaseHtml = '';
  if (cyc && cyc.boardPhase && cyc.boardPhase.length) {
    const q = cyc.boardPhase.filter(x => x.qualified).slice(0, 6);
    phaseHtml += '<div class="an-subhead">事件锚定阶段 <span class="note">某事件发生前 / 中 / 后，板块相对沪深300 超额</span></div>';
    phaseHtml += q.length ? q.map(b =>
      '<div class="ep-row"><b>' + esc(b.board) + '</b><span class="ep-stage">' + esc(b.best.label) + '</span>' +
      '<span class="up">' + signPct(b.best.avg) + '</span><span>上涨占比 ' + b.best.win + '% · n=' + b.n + '</span>' +
      '<span class="ep-note">' + esc(b.events.slice(0, 2).join('、')) + '</span></div>').join('')
      : '<div class="empty">所有板块事件样本均 &lt;5 或占优段超额未达 +1%，系统拒绝下阶段结论</div>';
    const coal = ['煤炭', '影视院线', '传媒'].map(n => cyc.boardPhase.find(x => x.board === n)).filter(Boolean);
    if (coal.length) phaseHtml += '<div class="edge-note">用户关注板块事件样本：' + coal.map(b =>
      esc(b.board) + ' n=' + b.n + '（' + (b.qualified ? '有结论' : '样本不足，不下结论') + '）').join('；') +
      '。季节性事件一年 1 次，事件锚定口径天然样本少，故另用下方「价格周期阶段」补足。</div>';
    if (cyc.boardAlerts && cyc.boardAlerts.length) {
      phaseHtml += '<div class="edge-note">阶段性提前告知（' + cyc.boardAlerts.length + ' 条，只对 n≥5 的板块）：' +
        cyc.boardAlerts.slice(0, 3).map(a => esc(a.text)).join('<br>') + '</div>';
    }
  }
  if (ph && ph.ok) {
    phaseHtml += '<div class="an-subhead">板块自身价格周期阶段 <span class="note">280 根日 K · 每 5 日一个不重叠窗口</span></div>';
    phaseHtml += '<div class="ep-agg">' + (ph.stageAggregate || []).filter(g => g.n > 0).map(g =>
      '<span class="ep-chip">' + esc(g.label) + ' <b class="' + valClass(g.avg) + '">' + signPct(g.avg) + '</b> <small>n=' + g.n + '</small></span>').join('') + '</div>';
    phaseHtml += (ph.qualified || []).length ? (ph.qualified.slice(0, 6).map(b =>
      '<div class="ep-row"><b>' + esc(b.name) + '</b><span class="ep-stage">' + esc(b.best.label) + '</span>' +
      '<span class="up">' + signPct(b.best.avg) + '</span><span>胜率 ' + b.best.win + '% · n=' + b.best.n + '</span>' +
      '<span class="ep-note">样本 ' + b.samples + ' 个窗口</span></div>').join(''))
      : '<div class="empty">各阶段有效样本均 &lt;8 或平均超额未达 ±1%，不做阶段占优结论</div>';
    const focus = ['煤炭', '影视院线', '传媒'].map(n => (ph.boards || []).find(b => b.name === n)).filter(Boolean);
    if (focus.length) phaseHtml += '<div class="edge-note">关注板块：' + focus.map(b =>
      esc(b.name) + '（' + (b.qualified ? esc(b.best.conclusion) : '样本不足 / 平均超额未达门槛，不下结论') + '）').join('；') + '</div>';
  }
  $('edgePhase').innerHTML = phaseHtml || '<div class="empty">板块阶段数据尚未就绪</div>';

  /* ④ 多因素叠加 */
  if (!stk || !stk.items || !stk.items.length) $('edgeStack').innerHTML = '<div class="empty">观察池未就绪，暂无叠加标注</div>';
  else {
    const byForm = stk.byForm || {};
    const chips = Object.keys(byForm).map(k => {
      const label = (stk.items.find(x => x.form === k) || {}).label || k;
      return '<span class="st-chip st-' + k + '">' + esc(label) + ' <b>' + byForm[k] + '</b></span>';
    }).join('');
    const rows = stk.top.slice(0, 10).map(r => {
      const pos = r.factors.filter(f => f.dir > 0);
      const neg = r.factors.filter(f => f.dir < 0);
      return '<details class="st-item st-' + r.form + '">' +
        '<summary><span class="st-form">' + esc(r.label) + '</span> <strong>' + esc(r.name) + '</strong> ' +
        '<span class="ev-code">' + esc(r.code) + '</span> 评分 ' + r.score + ' · ' + esc(r.signal) +
        '<span class="ev-meta">正向 ' + r.posCount + ' / 反向 ' + r.negCount + ' · 置信 ' + esc(r.confidenceHint) + '</span></summary>' +
        '<div class="st-body">' +
        '<div class="st-fp">叠加指纹：<code>' + esc(r.fingerprint || '（无同向因子）') + '</code></div>' +
        '<div class="st-note">' + esc(r.note) + '</div>' +
        '<div class="st-factors">' + r.factors.map(f =>
          '<div class="st-f ' + (f.dir > 0 ? 'pos' : f.dir < 0 ? 'neg' : 'neu') + '">' +
          '<span class="st-dir">' + (f.dir > 0 ? '+' : f.dir < 0 ? '−' : '·') + '</span>' +
          '<span class="st-fl">' + esc(f.label) + '<small>' + esc(f.source) + '</small></span>' +
          '<span class="st-fv">' + esc(f.value) + '</span></div>').join('') + '</div>' +
        '</div></details>';
    }).join('');
    $('edgeStack').innerHTML = '<div class="st-chips">' + chips + '</div>' + rows +
      '<div class="edge-note">' + esc(stk.disclaimer) + '</div>';
  }

  /* 方法论 */
  const m = [];
  if (st && st.methodology) m.push(['板块相对强弱', st.methodology]);
  if (val && val.methodology) m.push(['市值重估', val.methodology]);
  if (ph && ph.methodology) m.push(['价格周期阶段', ph.methodology]);
  if (stk && stk.methodology) m.push(['多因素叠加', stk.methodology]);
  $('edgeMethodBody').innerHTML = m.map(([t, o]) =>
    '<div class="an-subhead">' + esc(t) + '</div>' +
    Object.entries(o).map(([k, v]) => '<div class="edge-m"><b>' + esc(k) + '</b>：' + esc(v) + '</div>').join('')).join('') +
    '<div class="edge-note">反幻觉：所有数值来自公开实时接口或真实日 K 计算；无数据一律标 null 不按 0 填充；公告标题不等于事实；历史统计不是预测。' +
    '春节档等农历日期不推算，仅接受人工录入。</div>';
}

/* ===================== 持仓监控 ===================== */

const pnlColor = v => v > 0 ? 'up' : v < 0 ? 'down' : '';

function renderHoldings() {
  const h = S.holdings;
  if (!h) { $('holdingsTime').textContent = '未设置持仓'; return; }

  const s = h.summary;
  $('holdingsTime').textContent = h.count
    ? (s && s.quotedAt ? '更新于 ' + new Date(s.quotedAt).toTimeString().slice(0, 5) + ' · 每 30 秒自动刷新' : '行情获取中')
    : '未设置持仓';

  if (!h.count || !s) {
    $('holdingsSummary').innerHTML = '<div class="empty">' + esc(h.note || '尚未录入持仓') + '</div>';
    $('holdingsList').innerHTML = '';
    return;
  }

  $('holdingsSummary').innerHTML =
    '<div class="events-lead"><b>持仓 ' + s.count + ' 只' +
    (s.cost != null ? ' · 投入 ' + (s.cost / 10000).toFixed(2) + ' 万 · 市值 ' + (s.value / 10000).toFixed(2) + ' 万' +
      ' · 总盈亏 <span class="' + pnlColor(s.pnl) + '">' + (s.pnl > 0 ? '+' : '') + (s.pnl / 10000).toFixed(2) + ' 万（' +
      (s.pnlPct > 0 ? '+' : '') + s.pnlPct + '%）</span>' : ' · ' + esc(s.note || '')) + '</b></div>' +
    '<div class="style-text">建议由规则引擎生成（止损参考 / 涨跌停 / 浮盈浮亏 / 观察池联动），不预测涨跌；持仓不在观察池时明确标注「无评分意见」</div>';

  $('holdingsList').innerHTML = (h.positions || []).map(p => {
    const adv = (p.advice || []);
    return '<div class="hold-row' + (adv.some(a => a.level === 'critical') ? ' hold-crit' : adv.some(a => a.level === 'warning') ? ' hold-warn' : '') + '">' +
      '<div class="hold-main">' +
      '<span class="hold-name">' + esc(p.name || p.code) + '</span>' +
      '<span class="hold-code">' + esc(p.code) + '</span>' +
      (p.boardLabel ? '<span class="board-tag">' + esc(p.boardLabel) + '</span>' : '') +
      (p.inPool ? '<span class="hold-score">' + p.score + ' · ' + esc(p.signal || '') + '</span>' : '<span class="hold-nopool">不在观察池</span>') +
      (p.price != null ? '<span class="hold-price">' + p.price + '（<span class="' + pnlColor(p.changePct) + '">' + sig(p.changePct) + '%</span>）</span>' : '<span class="hold-price">—</span>') +
      '</div>' +
      '<div class="hold-nums">' +
      '成本 ' + p.cost + ' × ' + p.shares + ' 股' +
      (p.value != null ? ' · 市值 ' + (p.value / 10000).toFixed(2) + ' 万' : '') +
      (p.pnl != null ? ' · 盈亏 <b class="' + pnlColor(p.pnl) + '">' + (p.pnl > 0 ? '+' : '') + p.pnl.toFixed(0) + '（' + (p.pnlPct > 0 ? '+' : '') + p.pnlPct + '%）</b>' : '') +
      (p.stopRef != null ? ' · 止损参考 ' + p.stopRef : '') +
      (p.note ? ' · ' + esc(p.note) : '') +
      '</div>' +
      (adv.length ? '<div class="hold-advice">' + adv.map(a =>
        '<span class="hold-tag ' + (a.level === 'critical' ? 'tag-crit' : a.level === 'warning' ? 'tag-warn' : 'tag-info') + '">' + esc(a.text) + '</span>').join('') + '</div>' : '') +
      '<button class="btn tiny ghost hold-del" onclick="delHolding(\'' + p.code + '\')">删除</button>' +
      '</div>';
  }).join('');
}

window.delHolding = async function (code) {
  try {
    const r = await api('/api/holdings/delete', { code });
    if (r.ok) toast({ title: '已删除', message: '持仓 ' + code + ' 已移除', level: 'info', source: '持仓监控' });
    else toast({ title: '删除失败', message: r.error || '', level: 'warning', source: '持仓监控' });
  } catch (e) {
    toast({ title: '网络错误', message: e.message, level: 'warning', source: '持仓监控' });
  }
};

window.auditLesson = async function (id, action) {
  try {
    const r = await fetch('/api/journal/audit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action })
    });
    const j = await r.json();
    toast({
      title: action === 'approve' ? '经验已采纳' : '经验已驳回',
      message: j.ok ? (action === 'approve' ? '已回流到涨停结构修正（单股影响上限 ±2 分）' : '该结论不再参与回流') : '操作失败：' + (j.error || ''),
      level: j.ok ? 'info' : 'warning', source: '经验库'
    });
    if (j.ok) { S.journal = await (await fetch('/api/journal')).json(); renderJournal(); }
  } catch (e) {
    toast({ title: '网络错误', message: e.message, level: 'warning', source: '经验库' });
  }
};

function renderCycle() {
  const c = S.cycle;
  if (!c) { $('cycleTime').textContent = '等待研究'; return; }
  $('cycleTime').textContent = '事件 ' + c.counts.total + ' · 已研究 ' + c.counts.done + ' · 人工录入 ' + c.counts.manual;

  const alerts = c.alerts || [];
  $('cycleAlerts').innerHTML = alerts.length
    ? alerts.slice(0, 3).map(a =>
      '<div class="events-lead"><b>' + (a.level === 'warn' ? '⚠ 警惕兑现' : '◇ 临近') + '：' + esc(a.name) + '</b>' +
      '<span class="style-spread">' + esc(a.date) + '（' + a.daysTo + ' 天后）</span></div>' +
      '<div class="style-text">' + esc(a.text) + '</div>').join('')
    : '<div class="empty">当前无高置信提前告知（只在同类事件 ≥ 5 次且「前涨后跌」占比 ≥ 50% 时提示，宁缺毋滥）</div>';

  $('cycleUpcoming').innerHTML = (c.upcoming || []).slice(0, 8).map(u =>
    '<div class="cu-item"><span class="cu-date">' + esc(u.date) + '</span>' +
    '<span class="cu-days">' + (u.daysTo <= 3 ? '<b>' + u.daysTo + ' 天</b>' : u.daysTo + ' 天') + '</span>' +
    '<span class="cu-name">' + esc(u.name) + '</span>' +
    '<span class="cu-type">' + esc(u.type) + '</span>' +
    '<span class="note">' + (u.basis === 'manual' ? '人工录入' : '规律推算') + ' · ' +
    esc((u.sectors || []).slice(0, 3).join('、')) + '</span></div>').join('') || '<div class="empty">未来 45 天无待发生事件</div>';

  const sm = (c.summary || []).filter(s => s.n >= 5).slice(0, 10);
  $('cycleSummary').innerHTML = sm.length ? sm.map(s =>
    '<div class="cs-row"><span class="cs-name">' + esc(s.name) + '</span>' +
    '<span class="cs-n">n=' + s.n + '</span>' +
    '<span class="cs-pre">前 ' + sig(s.avgPre) + '%</span>' +
    '<span class="cs-post">后 ' + sig(s.avgPost) + '%</span>' +
    '<span class="cs-rate ' + (s.sellNewsRate >= 40 ? 'bad' : s.trendRate >= 40 ? 'good' : '') + '">出货率 ' + s.sellNewsRate + '%</span></div>').join('')
    : '<div class="empty">同类事件样本不足 5 次，不出结论</div>';

  $('cycleMethodBody').innerHTML = '<p>' + (c.methodology ? Object.values(c.methodology).map(esc).join('；') : '') + '</p>' +
    '<p class="hint">结论示例：「利好出货」= 事件前 20 日板块相对沪深300 上涨超 3%，事件后 20 日回落超 2%，属预期兑现型。战争等无周期事件不做日期推算，用地缘冲突新闻密度作连续指标。</p>';
}

function renderFlowRiskoff() {
  const f = S.flow, r = S.riskoff;
  if (!f) { $('flowTime').textContent = '等待采集'; return; }
  $('flowTime').textContent = '样本 ' + f.coverage.days + ' 个交易日（' + (f.coverage.from || '—') + ' 起）';

  // 避险识别
  if (r && r.ok) {
    $('riskoffBox').innerHTML =
      '<div class="events-lead"><b>避险形态：' + esc(r.form) + '</b>' +
      '<span class="style-conf conf-' + (r.score >= 60 ? 'high' : r.score >= 30 ? 'mid' : 'low') + '">证据强度 ' + r.score + '/100</span></div>' +
      '<div class="style-text">' + esc(r.answer) + '</div>' +
      '<div class="style-text">' + (r.actions || []).map(esc).join('；') + '</div>' +
      '<div class="ro-evidence">' + (r.evidence || []).map(e =>
        '<div class="ro-ev ' + (e.hit ? 'hit' : '') + '">[' + (e.hit ? '触发' : '未触发') + '] ' + esc(e.label) + '：' + esc(e.detail) + '</div>').join('') + '</div>';
  } else {
    $('riskoffBox').innerHTML = '<div class="empty">避险识别等待数据</div>';
  }

  // 主体画像
  const a = f.actors || {};
  const seatRow = s => s ? '<div class="fa-row"><span class="fa-name">' + esc(s.name) + '</span>' +
    '<span class="fa-stat">上榜 ' + s.count + ' 次</span><span class="fa-stat">净买 ' + sig(s.netYi) + ' 亿</span>' +
    '<span class="fa-stat">次日均 ' + sig(s.d1Avg) + '%</span><span class="fa-stat">胜率 ' + (s.winRate == null ? '—' : s.winRate + '%') + '</span>' +
    '<span class="board-tag turn">' + ({ micro: '微盘', small: '小盘', mid: '中盘', large: '大盘' }[s.favBucket] || '—') + '偏好</span></div>' : '';
  $('flowActors').innerHTML =
    seatRow(a.org) + seatRow(a.north) + seatRow(a.lhasa) +
    (a.hfSeats && a.hfSeats.length
      ? '<div class="an-subhead" style="margin-top:6px">高频活跃席位 Top（一年上榜 ≥ ' + ((S.config && S.config.flow && S.config.flow.hfSeatMin) || 20) + ' 次；总部/外资席位多为量化与套利资金）</div>' +
      a.hfSeats.slice(0, 6).map(seatRow).join('')
      : '<div class="empty">高频席位统计中</div>');

  // 市值层资金倾向
  const b20 = f.bucketFlow && f.bucketFlow.d20 ? f.bucketFlow.d20.buckets : null;
  const b5 = f.bucketFlow && f.bucketFlow.d5 ? f.bucketFlow.d5.buckets : null;
  $('flowBuckets').innerHTML = b20 ? ['micro', 'small', 'mid', 'large'].map(k => {
    const v = b20[k], v5 = b5 ? b5[k] : null;
    return '<div class="sb-card"><div class="sb-label">' + ({ micro: '微盘', small: '小盘', mid: '中盘', large: '大盘' }[k]) + '</div>' +
      '<div class="sb-value">' + sig(v.netYi) + ' 亿</div>' +
      '<div class="sb-note">机构 ' + sig(v.orgYi) + ' / 席位 ' + sig(v.seatYi) + '<br>近5日 ' + (v5 ? sig(v5.netYi) : '—') + ' 亿</div></div>';
  }).join('') + '<div class="style-text" style="grid-column:1/-1">' + esc(f.tilt ? f.tilt.text : '') + '</div>' : '<div class="empty">回填中</div>';

  // 两融
  const m = f.margin;
  $('flowMargin').innerHTML = m && m.ok
    ? '<div class="fm-row"><b>融资余额 ' + m.latest.rzYi + ' 亿</b>（融券 ' + m.latest.rqYi + ' 亿）· 一年变化 ' + sig(m.yearChange) + '% · 当前分位 ' + m.percentile + '%' +
      '<div class="note" style="margin-top:3px">' + esc(m.note) + '</div></div>'
    : '<div class="empty">两融历史按月抽样回填中</div>';

  // 大宗 + 股东户数
  const bt = f.blockTrade, hd = f.holders;
  let extras = '';
  if (bt && bt.ok) {
    extras += '<div class="fx-block"><b>大宗交易（近 7 日）</b>：' + bt.deals + ' 笔 / ' + bt.amtYi + ' 亿，平均溢价 ' + (bt.avgPremium == null ? '—' : bt.avgPremium + '%') +
      (bt.top && bt.top.length ? '<div class="fx-list">' + bt.top.slice(0, 4).map(t =>
        '<div>' + esc(t.name) + ' ' + t.amtYi + ' 亿 · ' + (t.premium > 0 ? '溢价' : '折价') + ' ' + t.premium + '% · 买方 ' + esc(String(t.buyer).slice(0, 14)) + '</div>').join('') + '</div>' : '') + '</div>';
  }
  if (hd && hd.ok) {
    extras += '<div class="fx-block"><b>筹码集中（股东户数降幅前列）</b>：' +
      '<div class="fx-list">' + hd.concentrating.slice(0, 5).map(x =>
        '<div>' + esc(x.name) + ' 户数环比 ' + sig(x.ratio) + '%（' + esc(x.end) + '）</div>').join('') + '</div></div>';
  }
  $('flowExtras').innerHTML = extras || '<div class="empty">大宗交易与股东户数采集中</div>';

  $('flowMethodBody').innerHTML = f.methodology ? '<p>' + Object.values(f.methodology).map(esc).join('；') + '</p>' +
    '<p class="hint">龙虎榜是「触发披露阈值的强势股」子样本，机构低吸建仓不触发披露，因此这里衡量的是「进攻性资金」而非全部机构行为。社保养老等长线资金按季报十大流通股东观察。</p>' : '';
}

function renderAll() {
  renderSummary();
  renderCards();
  renderChartTabs();
  renderChart();
  renderHealth();
  renderFilters();
  renderAlerts();
  renderNews();
  renderAnalysis();
  renderStyle();
  renderLimitUp();
  renderEvents();
  renderIc();
  renderJournal();
  renderCycle();
  renderEdge();
  renderFlowRiskoff();
  renderHoldings();
  renderStocks();
  updateToggles();
  updateBanner();
}

/* ------------------------------- SSE ------------------------------- */

function connect() {
  const es = new EventSource('/api/stream');
  es.onopen = () => { S.connected = true; setConn(true); renderSummary(); };
  es.onerror = () => { S.connected = false; setConn(false); renderSummary(); };

  es.addEventListener('snapshot', e => {
    const d = JSON.parse(e.data);
    S.config = d.config; S.quotes = d.quotes || []; S.news = d.news || { items: [], feedHealth: {} };
    S.analysis = d.analysis || null; S.stocks = d.stocks || null;
    S.style = d.style || null;
    S.events = d.events || null; S.macro = d.macro || null; S.ic = d.ic || null;
    S.limitup = d.limitup || null;
    S.journal = d.journal || null;
    S.cycle = d.cycle || null;
    S.flow = d.flow || null;
    S.riskoff = d.riskoff || null;
    S.holdings = d.holdings || null;
    S.edge = d.edge || null;
    S.history = d.history || {}; S.alerts = d.alerts || []; S.health = d.health || {};
    S.errors = d.errors || []; S.sourceLatency = d.sourceLatency || {};
    S.quoteFetchedAt = d.quoteFetchedAt || 0; S.newsFetchedAt = d.newsFetchedAt || 0;
    S.startedAt = d.startedAt || 0;
    renderAll(); fillSettings();
  });
  es.addEventListener('tick', e => {
    const d = JSON.parse(e.data);
    S.quotes = d.quotes || S.quotes; S.health = d.health || S.health;
    S.errors = d.errors || []; S.sourceLatency = d.sourceLatency || {};
    S.quoteFetchedAt = d.fetchedAt || Date.now();
    if (d.history) S.history = d.history;
    renderSummary(); renderCards(); renderChart(); renderHealth();
  });
  es.addEventListener('news', e => {
    S.news = JSON.parse(e.data);
    S.newsFetchedAt = S.news.fetchedAt || Date.now();
    renderSummary(); renderNews(); renderHealth();
  });
  es.addEventListener('history', e => {
    const d = JSON.parse(e.data);
    if (d.history) S.history = d.history;
    renderCards(); renderChart();
  });
  es.addEventListener('analysis', e => { S.analysis = JSON.parse(e.data); renderAnalysis(); renderNews(); });
  es.addEventListener('stocks', e => { S.stocks = JSON.parse(e.data); renderStocks(); });
  es.addEventListener('style', e => { S.style = JSON.parse(e.data); renderStyle(); });
  es.addEventListener('events', e => { S.events = JSON.parse(e.data); renderFilters(); renderEvents(); });
  es.addEventListener('macro', e => { S.macro = JSON.parse(e.data); renderEvents(); });
  es.addEventListener('ic', e => { S.ic = JSON.parse(e.data); renderIc(); });
  es.addEventListener('limitup', e => {
    S.limitup = JSON.parse(e.data);
    renderLimitUp();
    renderStocks();
  });
  es.addEventListener('journal', e => { S.journal = JSON.parse(e.data); renderJournal(); });
  es.addEventListener('cycle', e => { S.cycle = JSON.parse(e.data); renderCycle(); });
  es.addEventListener('flow', e => { S.flow = JSON.parse(e.data); renderFlowRiskoff(); });
  es.addEventListener('riskoff', e => { S.riskoff = JSON.parse(e.data); renderFlowRiskoff(); });
  es.addEventListener('holdings', e => { S.holdings = JSON.parse(e.data); renderHoldings(); });
  es.addEventListener('edge', e => { S.edge = JSON.parse(e.data); renderEdge(); });
  es.addEventListener('alert', e => onNewAlert(JSON.parse(e.data)));
  es.addEventListener('config', e => { S.config = JSON.parse(e.data); fillSettings(); updateToggles(); updateBanner(); });
  es.addEventListener('ack', e => {
    const d = JSON.parse(e.data);
    S.alerts.forEach(a => { if (d.all || a.id === d.id) a.ack = true; });
    renderAlerts(); renderSummary();
  });
  es.addEventListener('clear', () => { S.alerts = []; renderAlerts(); renderSummary(); });
}

/* ------------------------------- 事件绑定 ------------------------------- */

function bind() {
  $('chartTabs').addEventListener('click', e => {
    const btn = e.target.closest('button[data-kind]');
    if (!btn) return;
    if (btn.dataset.kind === 'id') S.chartId = btn.dataset.val;
    else S.chartRange = btn.dataset.val;
    renderChartTabs(); renderChart();
  });
  $('alertFilter').addEventListener('click', e => {
    const btn = e.target.closest('button[data-f]'); if (!btn) return;
    S.alertFilter = btn.dataset.f; renderFilters(); renderAlerts();
  });
  $('newsFilter').addEventListener('click', e => {
    const btn = e.target.closest('button[data-f]'); if (!btn) return;
    S.newsFilter = btn.dataset.f; renderFilters(); renderNews();
  });
  $('eventFilter').addEventListener('click', e => {
    const btn = e.target.closest('button[data-f]'); if (!btn) return;
    S.eventFilter = btn.dataset.f; renderFilters(); renderEvents();
  });
  $('btnNewsLang').onclick = () => {
    S.newsLang = S.newsLang === 'zh' ? 'original' : 'zh';
    renderNews();
  };
  $('btnAnalysisRefresh').onclick = async () => {
    await api('/api/analysis/refresh', {});
    $('btnAnalysisRefresh').textContent = '已触发';
    setTimeout(() => { $('btnAnalysisRefresh').textContent = '重新解读'; }, 1800);
  };
  $('btnStocksRefresh').onclick = async () => {
    $('btnStocksRefresh').textContent = '计算中…';
    await api('/api/stocks/refresh', {});
    setTimeout(() => { $('btnStocksRefresh').textContent = '重新计算'; }, 3500);
  };
  $('btnStyleRefresh').onclick = async () => {
    $('btnStyleRefresh').textContent = '检测中…';
    await api('/api/style/refresh', {});
    setTimeout(() => { $('btnStyleRefresh').textContent = '重新检测'; }, 3500);
  };
  $('btnEventsRefresh').onclick = async () => {
    $('btnEventsRefresh').textContent = '检测中…';
    await api('/api/events/refresh', {});
    setTimeout(() => { $('btnEventsRefresh').textContent = '重新检测'; }, 3500);
  };
  $('btnLimitRefresh').onclick = async () => {
    $('btnLimitRefresh').textContent = '采集中…';
    await api('/api/limitup/refresh', {});
    setTimeout(() => { $('btnLimitRefresh').textContent = '重新采集'; }, 3500);
  };
  $('btnHoldingsRefresh').onclick = async () => {
    $('btnHoldingsRefresh').textContent = '刷新中…';
    S.holdings = await (await fetch('/api/holdings')).json().then(j => j.data).catch(() => null);
    renderHoldings();
    setTimeout(() => { $('btnHoldingsRefresh').textContent = '刷新'; }, 3000);
  };
  $('btnHoldAdd').onclick = async () => {
    const code = $('holdCode').value.trim();
    const cost = parseFloat($('holdCost').value);
    const shares = parseInt($('holdShares').value, 10);
    const note = $('holdNote').value.trim();
    if (!code || !(cost > 0) || !(shares > 0)) {
      toast({ title: '请补全信息', message: '代码（6 位数字）、成本价、股数均为必填', level: 'warning', source: '持仓监控' });
      return;
    }
    const r = await api('/api/holdings', { code, cost, shares, note });
    if (r.ok) {
      toast({ title: '持仓已保存', message: code + ' 已录入（成本 ' + cost + ' × ' + shares + ' 股）', level: 'info', source: '持仓监控' });
      $('holdCode').value = ''; $('holdCost').value = ''; $('holdShares').value = ''; $('holdNote').value = '';
      setTimeout(async () => { S.holdings = await (await fetch('/api/holdings')).json().then(j => j.data).catch(() => null); renderHoldings(); }, 2500);
    } else {
      toast({ title: '保存失败', message: r.error || '请检查输入', level: 'warning', source: '持仓监控' });
    }
  };
  $('btnJournalLive').onclick = async () => {
    $('btnJournalLive').textContent = '刷新中…';
    await api('/api/journal/live', {});
    setTimeout(() => { $('btnJournalLive').textContent = '刷新实时池'; }, 3500);
  };
  $('btnJournalSnapshot').onclick = async () => {
    $('btnJournalSnapshot').textContent = '定格中…';
    await api('/api/journal/snapshot', { kind: 'eve' });
    setTimeout(() => { $('btnJournalSnapshot').textContent = '手动定格'; }, 3500);
  };
  $('btnJournalReview').onclick = async () => {
    $('btnJournalReview').textContent = '复盘中…';
    await api('/api/journal/review', {});
    setTimeout(() => { $('btnJournalReview').textContent = '立即复盘'; }, 3500);
  };
  $('btnCycleRefresh').onclick = async () => {
    $('btnCycleRefresh').textContent = '重建中…';
    await api('/api/cycle/refresh', {});
    setTimeout(() => { $('btnCycleRefresh').textContent = '重建研究'; }, 3500);
  };
  $('btnFlowRefresh').onclick = async () => {
    $('btnFlowRefresh').textContent = '更新中…';
    await api('/api/flow/refresh', {});
    setTimeout(() => { $('btnFlowRefresh').textContent = '增量更新'; }, 3500);
  };
  $('btnEdgeRefresh').onclick = async () => {
    $('btnEdgeRefresh').textContent = '重建中…';
    await api('/api/edge/refresh', {});
    toast({ title: '预期研究层', message: '已提交重建，板块日 K 与阶段统计约需 10-20 秒', level: 'info', source: 'edge' });
    setTimeout(() => { $('btnEdgeRefresh').textContent = '重建研究'; }, 3500);
  };
  $('btnIcRefresh').onclick = async () => {
    $('btnIcRefresh').textContent = '补算中…';
    await api('/api/ic/rebuild', {});
    setTimeout(() => {
      $('btnIcRefresh').textContent = '重算 IC';
      fetch('/api/ic', { cache: 'no-store' }).then(r => r.json()).then(j => {
        if (j && j.data) { S.ic = j.data; renderIc(); }
      }).catch(() => {});
    }, 4000);
  };
  $('btnStocksMethod').onclick = () => {
    const d = $('stocksMethod');
    d.open = !d.open;
    if (d.open) d.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  $('stocksBody').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-code]'); if (!tr) return;
    S.stockDetail = S.stockDetail === tr.dataset.code ? null : tr.dataset.code;
    renderStocks();
  });
  $('alertList').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-ack]'); if (!btn) return;
    await api('/api/ack', { id: btn.dataset.ack });
    const a = S.alerts.find(x => x.id === btn.dataset.ack); if (a) a.ack = true;
    renderAlerts(); renderSummary();
  });
  $('btnClear').onclick = async () => {
    if (!confirm('确定清空当前显示的告警记录？（历史日志文件仍保留在 data/alerts.jsonl）')) return;
    await api('/api/clear', {});
    S.alerts = []; renderAlerts(); renderSummary();
  };
  $('btnTest').onclick = () => {
    ['info', 'warning', 'critical'].forEach((lv, i) => {
      setTimeout(() => api('/api/test-alert', { level: lv }), i * 950);
    });
  };
  $('btnRefresh').onclick = async () => {
    await api('/api/refresh', {});
    $('btnRefresh').textContent = '已触发';
    setTimeout(() => { $('btnRefresh').textContent = '立即刷新'; }, 1600);
  };
  $('btnSound').onclick = async () => {
    if (!S.config) return;
    const c = structuredClone(S.config);
    c.sound.enabled = !c.sound.enabled;
    if (c.sound.enabled) ensureAudio();
    await api('/api/config', { sound: c.sound });
  };
  $('btnNotify').onclick = async () => {
    if (!S.config) return;
    const c = structuredClone(S.config);
    c.notification.enabled = !c.notification.enabled;
    if (c.notification.enabled && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(updateBanner);
    }
    await api('/api/config', { notification: c.notification });
  };
  $('btnSettings').onclick = openSettings;
  $('btnCloseSettings').onclick = closeSettings;
  $('settingsMask').onclick = closeSettings;
  $('cfgVolume').oninput = () => { $('volText').textContent = $('cfgVolume').value + '%'; };
  $('btnSaveCfg').onclick = async () => {
    const r = await api('/api/config', collectConfig());
    if (r.ok) { closeSettings(); $('btnRefresh').textContent = '设置已保存'; setTimeout(() => { $('btnRefresh').textContent = '立即刷新'; }, 1600); }
    else alert('保存失败：' + (r.error || '未知错误'));
  };
  $('btnResetCfg').onclick = async () => {
    if (!confirm('恢复所有设置为默认值？')) return;
    const r = await api('/api/reset', {});
    if (r.ok) { fillSettings(); updateBanner(); }
    else alert('恢复失败：' + (r.error || '未知错误'));
  };
  $('btnNotifyPerm').onclick = () => {
    if ('Notification' in window) Notification.requestPermission().then(() => { updateBanner(); updateToggles(); });
  };
  $('btnSoundTest').onclick = () => { ensureAudio(); beep('critical'); };
  document.addEventListener('pointerdown', () => { if (S.config && S.config.sound && S.config.sound.enabled) ensureAudio(); }, { once: true });
  window.addEventListener('resize', () => { /* SVG 自适应，无需重绘 */ });
}

/* ------------------------------- 启动 ------------------------------- */

renderFilters();
renderChartTabs();
renderAll();
bind();
connect();
setInterval(() => { renderNews(); renderSummary(); }, 30000);
