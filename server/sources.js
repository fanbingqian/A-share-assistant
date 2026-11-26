'use strict';

/**
 * 数据采集层：全部数据源均在本机实测连通（2026-11-13，北京时间）。
 * 主源 CNBC Quote API（交易所/Tradeweb，标注 realTime），
 * 备源 新浪财经外盘 / 东方财富，历史线 Yahoo Finance。
 * 所有返回值都带 source 与 sourceTime，便于界面标注来源与时点。
 */

const crypto = require('node:crypto');
const financeRel = require('./finance-relevance');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CNBC_SYMBOLS = ['US10Y', 'US2Y', 'US30Y', '@GC.1', '@CL.1', '@LCO.1', '.DXY'];

const SYMBOL_META = {
  US10Y:  { id: 'ust10y', name: '美国10年期国债收益率', short: '美债10Y', unit: '%',       kind: 'yield',   decimals: 3, group: 'rates' },
  US2Y:   { id: 'ust2y',  name: '美国2年期国债收益率',  short: '美债2Y',  unit: '%',       kind: 'yield',   decimals: 3, group: 'rates' },
  US30Y:  { id: 'ust30y', name: '美国30年期国债收益率', short: '美债30Y', unit: '%',       kind: 'yield',   decimals: 3, group: 'rates' },
  '@GC.1':{ id: 'gold',   name: 'COMEX 黄金期货',       short: '黄金',    unit: 'USD/oz',  kind: 'price',   decimals: 2, group: 'commodity' },
  '@CL.1':{ id: 'wti',    name: 'WTI 原油期货',         short: 'WTI原油', unit: 'USD/bbl', kind: 'price',   decimals: 2, group: 'commodity' },
  '@LCO.1':{id: 'brent',  name: 'ICE 布伦特原油期货',   short: '布伦特',  unit: 'USD/bbl', kind: 'price',   decimals: 2, group: 'commodity' },
  '.DXY': { id: 'dxy',    name: 'ICE 美元指数',         short: '美元指数',unit: '',        kind: 'index',   decimals: 3, group: 'fx' }
};

/**
 * 新闻源（2026-11-25 补齐金融垂直源）。
 * 全部 URL 均在本机实测连通；lang 决定中文化与情感分析口径。
 * 原 7 个源以综合国际新闻为主，实测只有约 66%~74% 与金融相关；新增 11 个金融垂直源
 * （中文财经聚合 / CNBC 分频道 / MarketWatch / Investing.com / SEC / 东方财富），把金融内容补齐。
 * The Guardian（综合国际）对服务端 fetch 间歇性返回 403（curl 可通、并发采集下持续 403），
 * 且并非金融源，2026-11-25 起替换为稳定的 CNBC · Top News；地缘信息仍由
 * Google 全球头条 / BBC World / Al Jazeera 提供。headers 字段保留供个别源覆盖请求头。
 */
const NEWS_FEEDS = [
  {
    name: 'Google News · 市场关键词', lang: 'en',
    url: 'https://news.google.com/rss/search?q=(gold+OR+%22oil+price%22+OR+%22treasury+yield%22+OR+Fed+OR+OPEC+OR+inflation)+when:1d&hl=en-US&gl=US&ceid=US:en'
  },
  { name: 'Google News · 全球头条', lang: 'en', url: 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en' },
  { name: 'BBC World', lang: 'en', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'BBC Business', lang: 'en', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { name: 'CNBC · Top News', lang: 'en', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { name: 'Al Jazeera', lang: 'en', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: '中新网财经', lang: 'zh', url: 'https://www.chinanews.com.cn/rss/finance.xml' },

  /* ↓ 金融垂直源（2026-11-25 新增，本机实测） */
  { name: 'Google News · 中文财经', lang: 'zh',
    url: 'https://news.google.com/rss/search?q=(A%E8%82%A1+OR+%E5%A4%AE%E8%A1%8C+OR+%E8%AF%81%E7%9B%91%E4%BC%9A+OR+%E8%B4%A2%E6%8A%A5)+when:1d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans' },
  { name: 'Google News · 中文市场', lang: 'zh',
    url: 'https://news.google.com/rss/search?q=(%E5%9F%BA%E9%87%91+OR+%E5%80%BA%E5%88%B8+OR+%E6%B1%87%E7%8E%87+OR+%E8%82%A1%E5%B8%82)+when:1d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans' },
  { name: 'Google News · 金融市场', lang: 'en',
    url: 'https://news.google.com/rss/search?q=(earnings+OR+%22central+bank%22+OR+%22bond+yield%22+OR+IPO)+when:1d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'CNBC · Finance', lang: 'en', url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html' },
  { name: 'CNBC · Economy', lang: 'en', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { name: 'CNBC · Earnings', lang: 'en', url: 'https://www.cnbc.com/id/15839135/device/rss/rss.html' },
  { name: 'CNBC · Investing', lang: 'en', url: 'https://www.cnbc.com/id/15839069/device/rss/rss.html' },
  { name: 'MarketWatch · Top Stories', lang: 'en', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { name: 'Investing.com · News', lang: 'en', url: 'https://www.investing.com/rss/news.rss' },
  { name: 'SEC · Press Releases', lang: 'en', url: 'https://www.sec.gov/news/pressreleases.rss' }
];

/**
 * 中文财经 JSON/JSONP 快讯源（非 RSS，单独解析）。
 * 东方财富快讯：实测返回 `var ajaxResult={...,"LivesList":[...]};`，
 * 字段 title / digest / showtime(北京时间) / url_w / id，一次 50 条。
 */
const CN_JSON_FEEDS = [
  { name: '东方财富 · 快讯', kind: 'eastmoney',
    url: 'https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_1_.html' }
];

/** 新闻池上限保持不变（200）：runAnalysis 会对全池做翻译，扩容会显著增加翻译成本 */
const NEWS_POOL_LIMIT = 200;
/** 金融条目保底配额：优先保留 160 条金融，剩余位置留给综合新闻作地缘/风险参考 */
const FINANCE_QUOTA = 160;
/** 单源上限：避免单个快讯源（如华尔街见闻 160 条）独占整个池子 */
const PER_FEED_CAP = 40;

/**
 * A 股政策/监管快讯源（2026-11-22 增加）。
 * 华尔街见闻为 JSON 接口而非 RSS，单独在 fetchWallstreetCN() 中解析。
 * 实测可用：A股频道 100 条，含 11/22「融资保证金比例下限降至80%」等政策原文。
 */
const CN_POLICY_FEEDS = [
  { name: '华尔街见闻 · A股快讯', channel: 'a-stock-channel',
    url: 'https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=a-stock-channel&client=pc&limit=100' },
  { name: '华尔街见闻 · 全球快讯', channel: 'global-channel',
    url: 'https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&client=pc&limit=60' }
];

/** 新闻告警关键词：只放高影响事件词，避免「黄金」「原油」这类高频词造成噪音 */
const NEWS_KEYWORDS = {
  critical: [
    'war', 'invasion', 'missile', 'nuclear', 'attack', 'default', 'collapse', 'crisis', 'emergency rate', 'bank failure',
    '战争', '入侵', '导弹', '核武', '核弹', '核试验', '核打击', '核泄漏', '袭击', '违约', '崩盘', '金融危机', '倒闭', '军事冲突'
  ],
  warning: [
    'opec', 'fed', 'fomc', 'rate cut', 'rate hike', 'nonfarm', 'payrolls', 'recession', 'tariff', 'sanctions',
    'shutdown', 'cpi', 'inflation', 'treasury yield', 'yield curve', 'safe haven', 'supply cut',
    '美联储', '降息', '加息', '非农', '衰退', '关税', '制裁', '减产', '增产', '国债收益率', '通胀', '避险', '央行', '停摆'
  ]
};

const NEWS_KEYWORDS_FLAT = [
  ...NEWS_KEYWORDS.critical.map(w => ({ w, level: 'critical' })),
  ...NEWS_KEYWORDS.warning.map(w => ({ w, level: 'warning' }))
];

/**
 * A 股政策/监管关键词权重表。命中后产出 importance(0-100) 与 category，
 * 供「政策快讯」排序、SSE 高优先级提醒与选股消息面使用。
 * 注意：这些是新闻筛选标签，不是买卖信号，也不是给智能体的行为约束。
 */
const POLICY_KEYWORDS = [
  { w: '融资保证金', weight: 96, tag: '资本市场', alert: true },
  { w: '保证金比例', weight: 88, tag: '资本市场', alert: true },
  { w: '沪深北交易所', weight: 92, tag: '监管', alert: true },
  { w: '证监会', weight: 90, tag: '监管', alert: true },
  { w: '印花税', weight: 96, tag: '资本市场', alert: true },
  { w: '政治局会议', weight: 95, tag: '宏观', alert: true },
  { w: '中央经济工作会议', weight: 95, tag: '宏观', alert: true },
  { w: '稳定股市', weight: 90, tag: '资本市场', alert: true },
  { w: '增量资金', weight: 82, tag: '资金面', alert: true },
  { w: '两融', weight: 78, tag: '资金面' },
  { w: '融资余额', weight: 70, tag: '资金面' },
  { w: '降准', weight: 90, tag: '货币政策', alert: true },
  { w: '降息', weight: 84, tag: '货币政策', alert: true },
  { w: '公开市场', weight: 68, tag: '货币政策' },
  { w: '逆回购', weight: 66, tag: '货币政策' },
  { w: '央行', weight: 64, tag: '货币政策' },
  { w: '国务院', weight: 76, tag: '宏观' },
  { w: '资本市场', weight: 68, tag: '资本市场' },
  { w: '做市交易', weight: 66, tag: '资本市场' },
  { w: '注册制', weight: 74, tag: '资本市场' },
  { w: 'IPO', weight: 70, tag: '资本市场' },
  { w: '退市', weight: 68, tag: '监管' },
  { w: '交易所', weight: 58, tag: '监管' },
  { w: '汇金', weight: 80, tag: '资金面', alert: true },
  { w: '国家队', weight: 78, tag: '资金面' },
  { w: '社保基金', weight: 60, tag: '资金面' },
  { w: '公募基金', weight: 55, tag: '资金面' },
  { w: '北向', weight: 56, tag: '资金面' },
  { w: '险资', weight: 58, tag: '资金面' },
  { w: '长线资金', weight: 72, tag: '资金面' },
  { w: '稳增长', weight: 62, tag: '宏观' },
  { w: '专项债', weight: 60, tag: '宏观' }
];

/** 返回政策标签与重要性分；中文用包含匹配，英文词用边界匹配（避免 IPO 命中ishop） */
function matchPolicy(text) {
  const s = String(text || '');
  const lower = s.toLowerCase();
  const hits = [];
  for (const p of POLICY_KEYWORDS) {
    const ok = /^[a-z]+$/i.test(p.w)
      ? new RegExp('(^|[^a-z])' + p.w.toLowerCase() + '(?=$|[^a-z])', 'i').test(lower)
      : s.includes(p.w);
    if (ok) hits.push({ w: p.w, weight: p.weight, tag: p.tag, alert: !!p.alert });
  }
  if (!hits.length) return { hits: [], importance: 0, category: null, alert: false };
  const top = hits.reduce((a, b) => (b.weight > a.weight ? b : a), hits[0]);
  const importance = Math.min(100, top.weight + Math.max(0, hits.length - 1) * 4);
  return { hits, importance, category: top.tag, alert: hits.some(h => h.alert) };
}

async function fetchRaw(url, opts = {}) {
  const { timeout = 11000, headers = {} } = opts;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept': '*/*',
      ...headers
    },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url.slice(0, 90));
  return res;
}

async function fetchText(url, opts) {
  const res = await fetchRaw(url, opts);
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.subarray(0, 240).toString('latin1');
  const m = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head);
  const enc = m && /gbk|gb2312|gb18030|big5/i.test(m[1]) ? 'gbk' : 'utf-8';
  try { return new TextDecoder(enc).decode(buf); } catch (_) { return buf.toString('utf8'); }
}

/** 采集层轻量重试：部分源（如 The Guardian）WAF 会偶发 403，重试一次即可恢复 */
async function fetchTextRetry(url, opts, retries = 1) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await fetchText(url, opts); }
    catch (e) { last = e; if (i < retries) await new Promise(r => setTimeout(r, 350)); }
  }
  throw last;
}

function num(s) {
  if (s === null || s === undefined) return null;
  const v = parseFloat(String(s).replace(/[,%+\s]/g, ''));
  return Number.isFinite(v) ? v : null;
}

/* ------------------------------- 行情：CNBC ------------------------------- */

async function fetchCNBC() {
  const started = Date.now();
  const params = new URLSearchParams({
    symbols: CNBC_SYMBOLS.join('|'),
    requestMethod: 'itv', noform: '1', partnerId: '2',
    fund: '1', exthrs: '1', output: 'json', events: '1'
  });
  const url = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?' + params.toString();
  const res = await fetchRaw(url, { timeout: 12000 });
  const json = await res.json();
  let list = json && json.FormattedQuoteResult && json.FormattedQuoteResult.FormattedQuote;
  if (!list) throw new Error('CNBC 返回结构异常');
  if (!Array.isArray(list)) list = [list];

  const quotes = [];
  for (const row of list) {
    const meta = SYMBOL_META[row.symbol];
    if (!meta) continue;
    const value = num(row.last);
    if (value === null) continue;
    quotes.push({
      ...meta,
      symbol: row.symbol,
      value,
      change: num(row.change),
      changePct: num(row.change_pct),
      prevClose: num(row.previous_day_closing),
      open: num(row.open),
      high: num(row.high),
      low: num(row.low),
      sourceTime: row.last_time || null,
      realTime: String(row.realTime).toLowerCase() === 'true',
      marketStatus: row.curmktstatus || null,
      contract: row.name || '',
      source: 'CNBC Quote API · ' + (row.exchange || row.source || 'Exchange'),
      quality: String(row.realTime).toLowerCase() === 'true' ? 'realtime' : 'delayed'
    });
  }
  if (!quotes.length) throw new Error('CNBC 无有效报价');
  return { quotes, latencyMs: Date.now() - started, fetchedAt: Date.now() };
}

/* ------------------------------- 行情：新浪备源 ------------------------------- */

/** 新浪外盘返回 GBK，hf_ 字段：0现价 4最高 5最低 6时间 7昨收 8开盘 13日期 */
function parseSinaLine(line) {
  const m = /hq_str_([^=]+)="([^"]*)"/.exec(line);
  if (!m) return null;
  const f = m[2].split(',');
  return { key: m[1].trim(), f };
}

async function fetchSina() {
  const started = Date.now();
  const url = 'https://hq.sinajs.cn/list=hf_GC,hf_CL,fx_sxauusd';
  const text = await fetchText(url, { timeout: 10000, headers: { Referer: 'https://finance.sina.com.cn' } });
  const lines = {};
  for (const line of text.split('\n')) {
    const p = parseSinaLine(line);
    if (p) lines[p.key] = p.f;
  }
  const out = [];

  const build = (key, meta) => {
    const f = lines[key];
    if (!f) return;
    const value = num(f[0]);
    const prev = num(f[7]);
    if (value === null || !value) return;
    out.push({
      ...meta,
      symbol: key,
      value,
      prevClose: prev,
      change: prev ? +(value - prev).toFixed(meta.decimals) : null,
      changePct: prev ? +(((value - prev) / prev) * 100).toFixed(4) : null,
      high: num(f[4]), low: num(f[5]), open: num(f[8]),
      sourceTime: (f[13] || '') + ' ' + (f[6] || ''),
      realTime: true,
      source: '新浪财经外盘行情',
      quality: 'realtime'
    });
  };

  build('hf_GC', { id: 'gold_sina', name: 'COMEX 黄金（新浪实时）', short: '黄金·实时', unit: 'USD/oz', kind: 'price', decimals: 3, group: 'commodity' });
  build('hf_CL', { id: 'wti_sina', name: 'WTI 原油（新浪实时）', short: 'WTI·实时', unit: 'USD/bbl', kind: 'price', decimals: 3, group: 'commodity' });

  const fx = lines['fx_sxauusd'];
  if (fx && num(fx[1])) {
    const value = +num(fx[1]).toFixed(2);
    const prev = num(fx[3]) || value;
    // 字段 0=时间, 1=最新价, 3=昨收, 17=日期；高低字段口径不明确，故不展示，避免误读
    out.push({
      id: 'xau', name: '伦敦金现 XAU/USD', short: '现货黄金', unit: 'USD/oz', kind: 'price', decimals: 2, group: 'commodity',
      symbol: 'fx_sxauusd', value, prevClose: +prev.toFixed(2),
      change: +(value - prev).toFixed(2),
      changePct: prev ? +(((value - prev) / prev) * 100).toFixed(4) : null,
      high: null, low: null,
      sourceTime: (fx[17] || '') + ' ' + (fx[0] || ''),
      realTime: true, source: '新浪财经 · 现货黄金', quality: 'realtime'
    });
  }
  if (!out.length) throw new Error('新浪行情为空');
  return { quotes: out, latencyMs: Date.now() - started, fetchedAt: Date.now() };
}

/* ------------------------------- 行情：东方财富备源 ------------------------------- */

const EM_CODES = [
  { code: '101.GC00Y', id: 'gold', scale: 10 },
  { code: '102.CL00Y', id: 'wti', scale: 100 },
  { code: '100.UDI', id: 'dxy', scale: 100 }
];

async function fetchEastmoney() {
  const started = Date.now();
  const results = await Promise.allSettled(EM_CODES.map(async c => {
    const url = 'https://push2.eastmoney.com/api/qt/stock/get?secid=' + c.code +
      '&fields=f43,f57,f58,f169,f170,f86&_=' + Date.now();
    const res = await fetchRaw(url, { timeout: 9000 });
    const j = await res.json();
    if (!j || !j.data) throw new Error('无数据 ' + c.code);
    return { c, d: j.data };
  }));

  const metaById = {
    gold: { name: 'COMEX 黄金（东财）', short: '黄金', unit: 'USD/oz', kind: 'price', decimals: 2, group: 'commodity' },
    wti:  { name: 'NYMEX 原油（东财）', short: 'WTI原油', unit: 'USD/bbl', kind: 'price', decimals: 2, group: 'commodity' },
    dxy:  { name: '美元指数（东财）', short: '美元指数', unit: '', kind: 'index', decimals: 2, group: 'fx' }
  };

  const quotes = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { c, d } = r.value;
    const value = num(d.f43) / c.scale;
    if (!Number.isFinite(value) || !value) continue;
    quotes.push({
      ...metaById[c.id], id: c.id, symbol: c.code, value,
      changePct: num(d.f170) === null ? null : num(d.f170) / 100,
      change: num(d.f169) === null ? null : num(d.f169) / c.scale,
      sourceTime: d.f86 ? new Date(d.f86 * 1000).toISOString() : null,
      realTime: true, source: '东方财富行情中心', quality: 'fallback'
    });
  }
  if (!quotes.length) throw new Error('东方财富行情为空');
  return { quotes, latencyMs: Date.now() - started, fetchedAt: Date.now() };
}

/* ------------------------------- 行情：外围股指（东方财富·全球指数） ------------------------------- */

/**
 * 外围股市：美股三大指数（A 股早盘看隔夜收盘、晚间盘中等同实时）、日经225 / 恒生 / KOSPI。
 * 用途：① 早盘 09:05 定格观察池时把外围市况一并存证（journal context.overseas）；
 *       ② 供 events.js 宏观避险修正参考（美股隔夜大跌 → 避险温度上升）。
 * 指数变化慢，5 分钟缓存足够；盘前无报价的（如恒生 09:30 前 f2 为 "-"）整条跳过，不编数。
 */
const OVERSEAS_SECIDS = [
  { secid: '100.DJIA', id: 'dji',  name: '道琼斯工业指数', short: '道琼斯',   unit: '', kind: 'index', decimals: 2 },
  { secid: '100.SPX',  id: 'spx',  name: '标普500',        short: '标普500',  unit: '', kind: 'index', decimals: 2 },
  { secid: '100.NDX',  id: 'ndx',  name: '纳斯达克综合',   short: '纳斯达克', unit: '', kind: 'index', decimals: 2 },
  { secid: '100.N225', id: 'n225', name: '日经225',        short: '日经225',  unit: '', kind: 'index', decimals: 2 },
  { secid: '100.HSI',  id: 'hsi',  name: '恒生指数',       short: '恒生',     unit: '', kind: 'index', decimals: 2 },
  { secid: '100.KS11', id: 'ks11', name: '韩国KOSPI',      short: 'KOSPI',    unit: '', kind: 'index', decimals: 2 }
];

let overseasCache = { at: 0, quotes: [] };
const OVERSEAS_TTL = 5 * 60 * 1000;

async function fetchOverseas(force = false) {
  if (!force && overseasCache.quotes.length && Date.now() - overseasCache.at < OVERSEAS_TTL) {
    return { quotes: overseasCache.quotes, cached: true, fetchedAt: overseasCache.at };
  }
  const started = Date.now();
  const secids = OVERSEAS_SECIDS.map(s => s.secid).join(',');
  const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f12,f14&secids=' + secids;
  const res = await fetchRaw(url, { timeout: 9000, headers: { Referer: 'https://quote.eastmoney.com/' } });
  const j = await res.json();
  const rows = (j && j.data && j.data.diff) || [];
  const bySecid = new Map(OVERSEAS_SECIDS.map(s => [s.secid, s]));
  const quotes = [];
  for (const r of rows) {
    // f12 是不带市场前缀的代码（DJIA/SPX/…），拼回 secid 匹配，避免 id 与代码不一致漏配
    const meta = bySecid.get('100.' + String(r.f12 || '').toUpperCase());
    if (!meta) continue;
    // 盘前 / 假日无报价时东财返回 "-"，整条跳过——宁可缺一行，不造一个 0
    if (!Number.isFinite(+r.f2) || r.f2 === '-' || r.f2 === null) continue;
    quotes.push({
      ...meta, group: 'overseas', symbol: meta.secid,
      value: +(+r.f2).toFixed(meta.decimals),
      changePct: Number.isFinite(+r.f3) && r.f3 !== '-' ? +r.f3 : null,
      source: '东方财富·全球指数', quality: 'realtime', realTime: true,
      sourceTime: null
    });
  }
  if (quotes.length) overseasCache = { at: Date.now(), quotes };
  return { quotes: overseasCache.quotes, cached: false, latencyMs: Date.now() - started, fetchedAt: overseasCache.at };
}

/* -------------------- 行情：全球股指（新浪备源） --------------------
 * 东财 push2 接口在部分网络环境不可达（2026-11-24 实测 fetch failed），
 * 导致海外股指整组缺失。新浪 hq.sinajs.cn 国际指数作为备源，实测可用：
 *   var hq_str_int_dji="道琼斯,46247.29,299.97,0.65";
 * 字段：名称 / 现价 / 涨跌额 / 涨跌幅%。只取 ASCII 数字段，中文名用本地 meta，
 * 不依赖解码结果；无报价的 symbol 整条跳过，不编造 0。
 * 重要：新浪国际指数为延迟报价，quality 标 delayed / realTime:false，
 * 避免把延迟行情误标为实时（沿用本项目「来源与时点可追溯」纪律）。
 */
const SINA_INTL = [
  { sym: 'int_dji',      id: 'dji',  name: '道琼斯工业指数', short: '道琼斯',   decimals: 2 },
  { sym: 'int_sp500',    id: 'spx',  name: '标普500',       short: '标普500',  decimals: 2 },
  { sym: 'int_nasdaq',   id: 'ndx',  name: '纳斯达克综合',   short: '纳斯达克', decimals: 2 },
  { sym: 'int_nikkei',   id: 'n225', name: '日经225',       short: '日经225',  decimals: 2 },
  { sym: 'int_hangseng', id: 'hsi',  name: '恒生指数',       short: '恒生',     decimals: 2 },
  { sym: 'int_ftse',     id: 'ftse', name: '英国富时100',    short: '富时100',  decimals: 2 }
];

async function fetchOverseasSina() {
  const started = Date.now();
  const url = 'https://hq.sinajs.cn/list=' + SINA_INTL.map(s => s.sym).join(',');
  const txt = await fetchText(url, { timeout: 9000, headers: { Referer: 'https://finance.sina.com.cn/' } });
  const bySym = new Map(SINA_INTL.map(s => [s.sym, s]));
  const quotes = [];
  const re = /hq_str_(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(txt))) {
    const meta = bySym.get(m[1]);
    if (!meta) continue;
    const p = m[2].split(',');
    const value = num(p[1]), change = num(p[2]), changePct = num(p[3]);
    if (!Number.isFinite(value) || value <= 0) continue;   // 盘前/无报价整条跳过
    quotes.push({
      ...meta, group: 'overseas', symbol: meta.sym, kind: 'index', unit: '',
      value: +value.toFixed(meta.decimals),
      change: Number.isFinite(change) ? +change.toFixed(meta.decimals) : null,
      changePct: Number.isFinite(changePct) ? +changePct.toFixed(2) : null,
      source: '新浪财经·国际指数（延迟报价）', quality: 'delayed', realTime: false,
      sourceTime: null
    });
  }
  if (!quotes.length) throw new Error('新浪国际指数无有效报价');
  return { quotes, cached: false, latencyMs: Date.now() - started, fetchedAt: Date.now() };
}

/* ----------------------- 行情：比特币（免密钥） -----------------------
 * 主源 OKX /api/v5/market/ticker?instId=BTC-USDT（现价 + 24h 开/高/低/量 + 时间戳），
 * 兜底 CoinGecko simple/price（仅现价 + 24h 涨跌）。两者均无需 API key，实测连通。
 * 不编造：兜底源没有的高/低/成交量留 null，并在 source 里写明实际来源。
 */
async function fetchCrypto() {
  const started = Date.now();
  try {
    const res = await fetchRaw('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT', { timeout: 9000 });
    const j = await res.json();
    const d = j && j.data && j.data[0];
    const last = num(d && d.last);
    if (j && j.code === '0' && Number.isFinite(last) && last > 0) {
      const open = num(d.open24h);
      const changePct = Number.isFinite(open) && open > 0 ? +(((last - open) / open) * 100).toFixed(2) : null;
      const change = Number.isFinite(open) ? +(last - open).toFixed(2) : null;
      const ts = num(d.ts);
      return {
        quotes: [{
          id: 'btc', name: '比特币 / 美元（OKX 现货 BTC-USDT）', short: '比特币',
          unit: 'USD', kind: 'price', decimals: 2, group: 'crypto', symbol: 'BTC-USDT',
          value: +last.toFixed(2), change, changePct,
          high24h: num(d.high24h), low24h: num(d.low24h),
          vol24h: num(d.vol24h), volCcy24h: num(d.volCcy24h),
          source: 'OKX · 现货 BTC-USDT', quality: 'realtime', realTime: true,
          sourceTime: Number.isFinite(ts) ? new Date(ts).toISOString() : null
        }],
        health: 'ok', source: 'okx', latencyMs: Date.now() - started, fetchedAt: Date.now()
      };
    }
  } catch (_) { /* 主源失败，落到兜底源 */ }

  try {
    const res = await fetchRaw('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true', { timeout: 9000 });
    const j = await res.json();
    const b = j && j.bitcoin;
    const last = num(b && b.usd);
    if (Number.isFinite(last) && last > 0) {
      const pct = num(b.usd_24h_change);
      return {
        quotes: [{
          id: 'btc', name: '比特币 / 美元（CoinGecko）', short: '比特币',
          unit: 'USD', kind: 'price', decimals: 2, group: 'crypto', symbol: 'BTC/USD',
          value: +last.toFixed(2), change: null,
          changePct: Number.isFinite(pct) ? +pct.toFixed(2) : null,
          high24h: null, low24h: null, vol24h: null, volCcy24h: null,
          source: 'CoinGecko · simple/price（兜底）', quality: 'realtime', realTime: true,
          sourceTime: null
        }],
        health: 'ok', source: 'coingecko', latencyMs: Date.now() - started, fetchedAt: Date.now()
      };
    }
  } catch (_) {}

  return { quotes: [], health: 'down', source: null, latencyMs: Date.now() - started, fetchedAt: Date.now() };
}

/* ------------------------------- 行情：聚合 ------------------------------- */

/**
 * CNBC 为主源、新浪并行补充实时商品与现货黄金；东方财富仅在主源失败时按需启用，
 * 避免无谓的并发请求被限流，也避免备用源抖动造成误报。
 */
async function fetchQuotes() {
  const [cnbc, sina, ovs, btc] = await Promise.allSettled([
    fetchCNBC(), fetchSina(), fetchOverseas(), fetchCrypto()
  ]);
  let em = null;
  if (cnbc.status === 'rejected') {
    const r = await Promise.allSettled([fetchEastmoney()]);
    em = r[0];
  }
  // 东财全球股指失败（或返回空）时启用新浪国际指数备源
  let ovsFallback = null;
  const ovsPrimary = ovs.status === 'fulfilled' && ovs.value && ovs.value.quotes && ovs.value.quotes.length > 0;
  if (!ovsPrimary) {
    const r = await Promise.allSettled([fetchOverseasSina()]);
    ovsFallback = r[0];
  }
  const ovsBackup = !!(ovsFallback && ovsFallback.status === 'fulfilled' && ovsFallback.value.quotes.length > 0);
  const cryptoOk = !!(btc.status === 'fulfilled' && btc.value && btc.value.quotes.length && btc.value.health === 'ok');

  const health = {
    cnbc: cnbc.status === 'fulfilled' ? 'ok' : 'down',
    sina: sina.status === 'fulfilled' ? 'ok' : 'down',
    overseas: (ovsPrimary || ovsBackup) ? 'ok' : 'down',
    crypto: cryptoOk ? 'ok' : 'down'
  };
  health.overseasSource = ovsPrimary ? 'eastmoney' : (ovsBackup ? 'sina' : null);
  health.cryptoSource = cryptoOk ? btc.value.source : null;
  if (em !== null) health.eastmoney = em.status === 'fulfilled' ? 'ok' : 'down';
  const errors = [];
  for (const [k, r] of Object.entries({ cnbc, sina, ovs, btc })) {
    if (r.status === 'rejected') errors.push(k + ': ' + (r.reason && r.reason.message));
  }
  if (!ovsPrimary && ovsFallback && ovsFallback.status === 'rejected') {
    errors.push('overseas-sina: ' + (ovsFallback.reason && ovsFallback.reason.message));
  }
  if (em !== null && em.status === 'rejected') errors.push('eastmoney: ' + (em.reason && em.reason.message));

  const map = new Map();
  if (cnbc.status === 'fulfilled') for (const q of cnbc.value.quotes) map.set(q.id, q);
  if (em !== null && em.status === 'fulfilled') {
    for (const q of em.value.quotes) {
      if (!map.has(q.id)) map.set(q.id, q);
      else map.get(q.id).fallbackValue = q.value;
    }
  }
  if (sina.status === 'fulfilled') {
    for (const q of sina.value.quotes) {
      if (q.id === 'xau') { map.set('xau', q); continue; }
      const baseId = q.id === 'gold_sina' ? 'gold' : 'wti';
      const base = map.get(baseId);
      if (base) base.rtValue = q.value;      // 商品期货 CNBC 常为延迟报价，另附实时参考价
      else map.set(baseId, { ...q, id: baseId });
    }
  }
  // 外围股指：东财优先，失败时用新浪备源；id 不与既有行情冲突（dji/spx/ndx/n225/hsi/…）
  const overseasQuotes = ovsPrimary ? ovs.value.quotes
    : (ovsFallback && ovsFallback.status === 'fulfilled' ? ovsFallback.value.quotes : []);
  for (const q of overseasQuotes) map.set(q.id, q);
  // 比特币（OKX 主源 / CoinGecko 兜底，免密钥）
  if (cryptoOk) for (const q of btc.value.quotes) map.set(q.id, q);

  // 衍生指标：10Y-2Y 期限利差（bp）
  const y10 = map.get('ust10y');
  const y2 = map.get('ust2y');
  if (y10 && y2 && Number.isFinite(y10.value) && Number.isFinite(y2.value)) {
    const spread = +((y10.value - y2.value) * 100).toFixed(1);
    map.set('spread', {
      id: 'spread', name: '美债 10Y-2Y 期限利差', short: '10Y-2Y利差', unit: 'bp',
      kind: 'spread', decimals: 1, group: 'rates', symbol: 'US10Y-US2Y',
      value: spread, changePct: null, change: null,
      sourceTime: y10.sourceTime,
      realTime: y10.realTime,
      source: '由 CNBC 的 US10Y / US2Y 报价计算',
      quality: y10.quality,
      inverted: spread < 0
    });
  }

  const quotes = Array.from(map.values());
  return {
    quotes,
    health,
    errors,
    fetchedAt: Date.now(),
    latencyMs: {
      cnbc: cnbc.status === 'fulfilled' ? cnbc.value.latencyMs : null,
      sina: sina.status === 'fulfilled' ? sina.value.latencyMs : null,
      overseas: ovsPrimary ? ovs.value.latencyMs : null,
      overseasSina: ovsBackup ? ovsFallback.value.latencyMs : null,
      crypto: btc.status === 'fulfilled' ? btc.value.latencyMs : null,
      eastmoney: em !== null && em.status === 'fulfilled' ? em.value.latencyMs : null
    },
    ok: quotes.length > 0
  };
}

/* ------------------------------- 历史走势：Yahoo ------------------------------- */

// 注意：Yahoo 的 ^FVX 是 5 年期国债收益率，不是 2 年期，故 ust2y 不映射历史源，避免口径混淆
const YAHOO_MAP = { gold: 'GC=F', wti: 'CL=F', brent: 'BZ=F', ust10y: '^TNX', ust30y: '^TYX', dxy: 'DX-Y.NYB' };

async function fetchYahooHistory(id) {
  const sym = YAHOO_MAP[id];
  if (!sym) return [];
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) +
    '?interval=5m&range=1d&includePrePost=true';
  const res = await fetchRaw(url, { timeout: 12000 });
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) return [];
  const closes = (r.indicators && r.indicators.quote && r.indicators.quote[0].close) || [];
  return r.timestamp
    .map((t, i) => ({ t: t * 1000, v: closes[i] }))
    .filter(p => Number.isFinite(p.v));
}

/* ------------------------------- 新闻 RSS ------------------------------- */

function xmlTag(block, name) {
  const re = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i');
  const m = re.exec(block);
  return m ? m[1] : '';
}

function cleanXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, ' ')
    .trim();
}

const KW_RE_CACHE = new Map();

/** 英文关键词按「词」匹配，避免 war 命中 warns / award、fed 命中 federal；中文仍用包含匹配 */
function keywordRegex(kw) {
  const key = String(kw).toLowerCase();
  if (KW_RE_CACHE.has(key)) return KW_RE_CACHE.get(key);
  // 仅含字母数字空格时才构正则，天然不含正则元字符；允许常见复数与时态后缀
  const isAsciiWord = /^[a-z0-9 ]+$/.test(key);
  const re = isAsciiWord
    ? new RegExp('(^|[^a-z0-9])' + key + '(?:s|es|ed|ing)?(?=$|[^a-z0-9])', 'i')
    : null;
  KW_RE_CACHE.set(key, re);
  return re;
}

function matchKeywords(text) {
  const lower = String(text).toLowerCase();
  const hits = [];
  for (const { w, level } of NEWS_KEYWORDS_FLAT) {
    const re = keywordRegex(w);
    const ok = re ? re.test(lower) : lower.includes(w.toLowerCase());
    if (ok && !hits.some(h => h.w === w)) hits.push({ w, level });
  }
  return hits;
}

/** 按设置里自定义的词表匹配，返回第一个命中词（小写） */
function matchConfigured(text, words) {
  const lower = String(text).toLowerCase();
  for (const raw of words || []) {
    const k = String(raw).trim().toLowerCase();
    if (!k) continue;
    const re = keywordRegex(k);
    if (re ? re.test(lower) : lower.includes(k)) return k;
  }
  return null;
}

function parseFeed(xml, feed) {
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  const out = [];
  for (const b of blocks) {
    const title = cleanXml(xmlTag(b, 'title'));
    if (!title) continue;
    let link = cleanXml(xmlTag(b, 'link'));
    if (!link) {
      const m = /<link[^>]*href=["']([^"']+)["']/i.exec(b);
      if (m) link = m[1];
    }
    const pub = cleanXml(xmlTag(b, 'pubDate') || xmlTag(b, 'dc:date') || xmlTag(b, 'date'));
    const source = cleanXml(xmlTag(b, 'source')) || feed.name;
    const desc = cleanXml(xmlTag(b, 'description') || xmlTag(b, 'content:encoded')).slice(0, 220);
    const ts = pub ? Date.parse(pub) : NaN;
    const text = title + ' ' + desc;
    const hits = matchKeywords(text);
    const pol = matchPolicy(text);
    out.push({
      id: crypto.createHash('md5').update(title).digest('hex').slice(0, 14),
      title, link, source, feed: feed.name, lang: feed.lang,
      publishedAt: Number.isFinite(ts) ? ts : Date.now(),
      publishedText: pub || '', desc,
      hits,
      level: hits.some(h => h.level === 'critical') ? 'critical' : (hits.length ? 'warning' : 'none'),
      policyHits: pol.hits, importance: pol.importance, policyImportance: pol.importance,
      category: pol.category, policyAlert: pol.alert
    });
  }
  return out;
}

/** 华尔街见闻快讯（JSON API）→ 与 RSS 新闻统一的条目格式 */
async function fetchWallstreetFeed(feed) {
  const text = await fetchTextRetry(feed.url, { timeout: 12000 });
  const json = JSON.parse(text);
  const rows = (json && json.data && json.data.items) || [];
  const out = [];
  for (const x of rows) {
    const title = String(x.title || '').trim() || String(x.content_text || '').trim().slice(0, 80);
    if (!title) continue;
    const desc = String(x.content_text || x.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 260);
    const ts = Number(x.display_time || 0) * 1000;
    const textForMatch = title + ' ' + desc;
    const hits = matchKeywords(textForMatch);
    const pol = matchPolicy(textForMatch);
    out.push({
      id: 'ws_' + (x.id || crypto.createHash('md5').update(title).digest('hex').slice(0, 14)),
      title,
      link: x.uri ? 'https://wallstreetcn.com' + x.uri : null,
      source: '华尔街见闻',
      feed: feed.name,
      lang: 'zh',
      publishedAt: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
      publishedText: new Date((Number.isFinite(ts) && ts > 0 ? ts : Date.now()) + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19),
      desc,
      hits,
      level: hits.some(h => h.level === 'critical') ? 'critical'
        : (pol.alert && pol.importance >= 84) || hits.length ? 'warning' : 'none',
      policyHits: pol.hits,
      importance: pol.importance,
      policyImportance: pol.importance,
      category: pol.category,
      policyAlert: pol.alert,
      symbolCodes: Array.isArray(x.fund_codes) ? x.fund_codes.map(String).filter(Boolean) : []
    });
  }
  return out;
}

/** 东方财富快讯（JSONP）→ 与 RSS 新闻统一的条目格式 */
async function fetchEastmoneyFeed(feed) {
  const raw = await fetchTextRetry(feed.url, { timeout: 12000 });
  const text = String(raw).replace(/^\s*var\s+ajaxResult\s*=\s*/, '').replace(/;\s*$/, '').trim();
  const json = JSON.parse(text);
  const rows = (json && json.LivesList) || [];
  const out = [];
  for (const x of rows) {
    const title = String(x.title || x.simtitle || '').trim();
    if (!title) continue;
    const desc = String(x.digest || x.simdigest || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 260);
    const st = String(x.showtime || x.ordertime || '').trim();              // 形如 2026-11-25 23:39:14（北京时间）
    const ts = st ? Date.parse(st.replace(' ', 'T') + '+08:00') : NaN;
    const textForMatch = title + ' ' + desc;
    const hits = matchKeywords(textForMatch);
    const pol = matchPolicy(textForMatch);
    out.push({
      id: 'em_' + String(x.id || x.newsid || crypto.createHash('md5').update(title).digest('hex').slice(0, 14)),
      title,
      link: x.url_w || x.url_unique || null,
      source: '东方财富',
      feed: feed.name,
      lang: 'zh',
      publishedAt: Number.isFinite(ts) ? ts : Date.now(),
      publishedText: st || '',
      desc,
      hits,
      level: hits.some(h => h.level === 'critical') ? 'critical'
        : (pol.alert && pol.importance >= 84) || hits.length ? 'warning' : 'none',
      policyHits: pol.hits,
      importance: pol.importance,
      policyImportance: pol.importance,
      category: pol.category,
      policyAlert: pol.alert,
      symbolCodes: []
    });
  }
  return out;
}

/**
 * 金融优先的池子保留策略。
 * 旧逻辑是「全量按时间倒序 → slice(0,200)」，实测 433 条里丢掉 233 条，且综合媒体
 * （BBC World / Al Jazeera / 全球头条）的社会新闻会按时间挤掉中文金融快讯。
 * 新逻辑：① 单源配额（避免单一快讯源刷屏）② 金融组优先占 FINANCE_QUOTA
 * ③ 剩余位置留给非金融作地缘/风险参考 ④ 总量仍 200，翻译成本不变。
 * 只做排序与截断，不删除标题、不改写事实、不预判行情。
 */
function prioritizeNews(all) {
  const byTime = (a, b) => (b.publishedAt || 0) - (a.publishedAt || 0);
  const count = new Map();
  const capped = [];
  for (const n of [...all].sort(byTime)) {
    const k = n.feed || n.source || '未知';
    const c = count.get(k) || 0;
    if (c >= PER_FEED_CAP) continue;
    count.set(k, c + 1);
    capped.push(n);
  }
  const fin = capped.filter(n => n.finance && n.finance.isFinance);
  const non = capped.filter(n => !(n.finance && n.finance.isFinance));
  const finKeep = fin.slice(0, FINANCE_QUOTA);
  const room = Math.max(0, NEWS_POOL_LIMIT - finKeep.length);
  return finKeep.concat(non.slice(0, room)).sort(byTime);
}

async function fetchNews() {
  const results = await Promise.allSettled(NEWS_FEEDS.map(async f => {
    const xml = await fetchTextRetry(f.url, { timeout: 12000, headers: f.headers || {} });
    return { feed: f, items: parseFeed(xml, f) };
  }));
  const cnResults = await Promise.allSettled(CN_POLICY_FEEDS.map(f => fetchWallstreetFeed(f)));
  const jsonResults = await Promise.allSettled(CN_JSON_FEEDS.map(f => fetchEastmoneyFeed(f)));

  const feedHealth = {};
  const seen = new Set();
  const all = [];
  const absorb = (name, rows) => {
    feedHealth[name] = rows.length;
    for (const item of rows) {
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      all.push(item);
    }
  };
  NEWS_FEEDS.forEach((f, i) => {
    const r = results[i];
    absorb(f.name, r.status === 'fulfilled' ? r.value.items : []);
  });
  CN_POLICY_FEEDS.forEach((f, i) => {
    const r = cnResults[i];
    absorb(f.name, r.status === 'fulfilled' ? r.value : []);
  });
  CN_JSON_FEEDS.forEach((f, i) => {
    const r = jsonResults[i];
    absorb(f.name, r.status === 'fulfilled' ? r.value : []);
  });

  // 确定性金融相关性标注（零模型、可复现），供池子保留、前端筛选与覆盖率统计使用
  for (const n of all) n.finance = financeRel.classify(n.title, n.desc || '');

  const items = prioritizeNews(all);
  return {
    items,
    feedHealth,
    fetchedAt: Date.now(),
    ok: items.length > 0,
    poolStats: {
      collected: all.length,
      finance: all.filter(n => n.finance.isFinance).length,
      nonFinance: all.filter(n => !n.finance.isFinance).length,
      kept: items.length,
      keptFinance: items.filter(n => n.finance.isFinance).length,
      limit: NEWS_POOL_LIMIT,
      financeQuota: FINANCE_QUOTA,
      perFeedCap: PER_FEED_CAP
    }
  };
}

module.exports = {
  fetchQuotes, fetchNews, fetchYahooHistory, fetchOverseas, fetchOverseasSina, fetchCrypto,
  matchKeywords, matchConfigured, keywordRegex, matchPolicy, fetchWallstreetFeed,
  fetchEastmoneyFeed, prioritizeNews,
  NEWS_FEEDS, CN_POLICY_FEEDS, CN_JSON_FEEDS, NEWS_KEYWORDS, POLICY_KEYWORDS,
  SYMBOL_META, YAHOO_MAP, UA,
  NEWS_POOL_LIMIT, FINANCE_QUOTA, PER_FEED_CAP
};
