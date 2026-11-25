'use strict';
/**
 * attribution.js — 涨停 / 炸板「事实卡」（L0 确定性模式，不接 LLM）
 *
 * 设计纪律（反幻觉，逐条对应）：
 * 1. 只陈列可核验的公开事实：涨停盘口 + 上市公司公告（带日期与原文链接）+ 公开新闻标题。
 * 2. 绝不输出因果关系——不写「因为…所以涨停」「受益于…」「主要系…」。规则命中只陈述
 *    「标题里出现了哪个词」，不宣称这是涨跌原因。
 * 3. 无素材时显式标 no-source，不做任何推测；宁可为空，不可编造。
 * 4. 公告接口有限流（连续请求会直接断连），故串行 + 间隔 + 本地缓存，只对涨停股定向抓取，
 *    不做全市场高频扫描。
 *
 * 与同花顺「涨停原因」的差异（必须对用户说清）：
 * 同花顺是 AI 汇总公开信息后归纳成句的编辑内容；本模块是原始事实陈列，不做归纳。
 * 因此本模块输出的是「素材」，不是「原因结论」。
 */

const fs = require('node:fs');
const path = require('node:path');
const { UA } = require('./sources');
const { CORPORATE_RULES } = require('./events');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'attribution-cache.json');
const POOL_FILE = path.join(DATA_DIR, 'limitup-cache.json');
const NEWS_FILE = path.join(DATA_DIR, 'stock-news-cache.json');
const EM_ANN = 'https://np-anotice-stock.eastmoney.com/api/security/ann';

const DISCLAIMER = '本卡片只陈列公开信息事实，不认定涨跌原因。每条事实均附公告日期与原文链接，可自行核验。'
  + '事实存在不等于因果关系，请勿据此单独决策。';

const NOTE = '素材来自上市公司公告与公开新闻。同花顺等产品的「涨停原因」由 AI 归纳成句，本模块刻意不做归纳，'
  + '只把可核验的原始事实摆出来——因为归纳那一步最容易产生幻觉，且无法逐条溯源。';

const METHODS = {
  scope: '覆盖当日涨停池（最多 30 只）。炸板池与跌停池暂只给盘口事实，不抓公告正文，避免触发接口限流。',
  source: '公告取自东方财富公告接口（np-anotice-stock），近 120 天，按披露日期倒序；新闻取自个股资讯缓存。',
  rule: '规则命中 = 公告或新闻标题中出现该规则的关键词，仅表示「有此类事项披露」，不表示「这是涨停原因」。',
  limit: '公告接口对连续请求敏感（实测连发数次即返回空响应），故串行抓取、每只间隔 1.3 秒、结果缓存 6 小时。',
  gap: '已知缺口：尚缺互动易问答原文与卖方研报；公告正文未做句子级抽取，只到标题层。补齐需接入正文解析与概念题材词库。'
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function round(v, n = 2) {
  const x = Number(v);
  return Number.isFinite(x) ? +x.toFixed(n) : null;
}

function fmtDate(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://data.eastmoney.com/'
      },
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------- 读取本地素材 ----------------------------- */

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function readPool() {
  const p = readJson(POOL_FILE, null);
  return p && Array.isArray(p.zt) ? p : null;
}

function readNews() {
  const n = readJson(NEWS_FILE, null);
  return (n && n.items && typeof n.items === 'object') ? n.items : {};
}

function readCache() {
  const c = readJson(CACHE_FILE, null);
  return c && typeof c === 'object' ? c : null;
}

function writeCache(obj) {
  try {
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) {
    console.warn('[attribution] 缓存写入失败: ' + e.message);
  }
}

/* ----------------------------- 规则命中 ----------------------------- */

function matchRules(texts) {
  const hits = [];
  for (const r of CORPORATE_RULES) {
    for (const t of texts) {
      const body = String((t && t.title) || '');
      if (!body) continue;
      const kw = (r.kw || []).find(w => body.includes(w));
      if (kw) {
        hits.push({
          label: r.label,
          kw,
          from: t.from,
          date: t.date || '',
          ref: t.link || t.url || ''
        });
        break;
      }
    }
  }
  return hits;
}

/* ----------------------------- 公告抓取 ----------------------------- */

async function fetchAnnouncements(code, days = 120, size = 10) {
  const url = EM_ANN + '?sr=-1&page_size=' + size + '&page_index=1&ann_type=A'
    + '&client_source=web&stock_list=' + encodeURIComponent(code)
    + '&f_node=0&s_node=0&_=' + Date.now();
  const j = await fetchJson(url);
  const list = (j && j.data && j.data.list) || [];
  const since = Date.now() - days * 86400000;
  return list
    .map(a => {
      const ts = Date.parse(a.notice_date);
      return {
        date: fmtDate(ts),
        ts: Number.isFinite(ts) ? ts : 0,
        column: (a.columns || []).map(c => c.column_name).filter(Boolean).slice(0, 2).join(' / '),
        title: String(a.title || '').trim(),
        link: 'https://data.eastmoney.com/notices/detail/' + code + '/' + String(a.art_code || '') + '.html'
      };
    })
    .filter(a => a.title && (!a.ts || a.ts >= since))
    .slice(0, size);
}

/* ----------------------------- 单只事实卡 ----------------------------- */

function boardFact(s, kind) {
  const sealFundYi = s.sealFund ? round(s.sealFund / 1e8, 2) : null;
  const floatCapYi = s.floatCap ? round(s.floatCap / 1e8, 2) : null;
  return {
    kind,
    pct: round(s.pct, 2),
    boards: Number.isFinite(+s.boards) ? +s.boards : null,
    statLabel: s.statDays && s.statBoards ? (s.statDays + ' 天 ' + s.statBoards + ' 板')
      : (Number.isFinite(+s.boards) ? s.boards + ' 板' : null),
    firstSealLabel: s.firstSealLabel || null,
    lastSealLabel: s.lastSealLabel || null,
    sealFundYi,
    sealRatio: round(s.sealRatio, 2),
    breakCount: Number.isFinite(+s.breakCount) ? +s.breakCount : null,
    turnover: round(s.turnover, 2),
    floatCapYi,
    failDepth: round(s.failDepth, 2)
  };
}

function buildItem(s, kind, newsMap) {
  const news = (newsMap[s.code] || []).slice(0, 5).map(n => ({
    date: n.timeLabel || fmtDate(n.publishedAt),
    title: String(n.title || '').trim(),
    url: n.url || ''
  })).filter(n => n.title);

  return {
    code: s.code,
    name: s.name,
    industry: s.industry || null,
    board: boardFact(s, kind),
    announcements: [],
    news,
    rules: [],
    factCount: news.length,
    status: news.length ? 'ok' : 'no-source',
    annError: false
  };
}

/* ----------------------------- 主构建 ----------------------------- */

async function build(opts = {}) {
  const maxStocks = Math.max(1, Math.min(60, opts.maxStocks || 30));
  const gapMs = Math.max(600, opts.gapMs || 1300);
  const force = !!opts.force;

  const pool = readPool();
  if (!pool) {
    return {
      ok: false,
      error: '涨停池缓存不可达，无法生成事实卡',
      builtAt: Date.now(),
      disclaimer: DISCLAIMER,
      note: NOTE
    };
  }

  const date = String(pool.date || '');
  const cached = readCache();
  if (!force && cached && cached.ok && cached.date === date
      && (Date.now() - (cached.builtAt || 0)) < 6 * 3600000) {
    return cached;
  }

  const newsMap = readNews();
  const zt = pool.zt.slice(0, maxStocks);
  const zb = Array.isArray(pool.zb) ? pool.zb : [];
  const dt = Array.isArray(pool.dt) ? pool.dt : [];

  const items = [];
  let annErrors = 0;

  for (let i = 0; i < zt.length; i++) {
    const s = zt[i];
    const it = buildItem(s, 'zt', newsMap);
    try {
      it.announcements = await fetchAnnouncements(s.code);
    } catch (e) {
      annErrors++;
      it.annError = true;
    }
    const texts = [
      ...it.announcements.map(a => ({ title: a.title, from: '公告', date: a.date, link: a.link })),
      ...it.news.map(n => ({ title: n.title, from: '新闻', date: n.date, url: n.url }))
    ];
    it.rules = matchRules(texts);
    it.factCount = it.announcements.length + it.news.length;
    it.status = it.factCount ? 'ok' : 'no-source';
    items.push(it);
    if (i < zt.length - 1) await sleep(gapMs);
  }

  items.sort((a, b) => (b.board.boards || 0) - (a.board.boards || 0) || b.factCount - a.factCount);

  /* 规则普遍性：统计每条规则在本批样本中的命中比例。
     命中率过高的（如「业绩公告」几乎每只都有）属于普遍事项、无区分度，
     单独标 common，避免用户把它误读成「这只票的特殊原因」。这是确定性统计，不含推断。 */
  const ruleCount = {};
  items.forEach(x => (x.rules || []).forEach(r => {
    ruleCount[r.label] = (ruleCount[r.label] || 0) + 1;
  }));
  const scannedN = items.length || 1;
  const ruleStat = Object.keys(ruleCount)
    .map(label => ({
      label,
      hits: ruleCount[label],
      share: Math.round(ruleCount[label] / scannedN * 100),
      common: ruleCount[label] / scannedN >= 0.6
    }))
    .sort((a, b) => a.hits - b.hits);
  items.forEach(x => (x.rules || []).forEach(r => {
    const st = ruleStat.find(s => s.label === r.label);
    r.hits = st ? st.hits : 1;
    r.share = st ? st.share : 100;
    r.common = st ? st.common : false;
  }));

  const withAnn = items.filter(x => x.announcements.length).length;
  const withNews = items.filter(x => x.news.length).length;
  const none = items.filter(x => x.status === 'no-source').length;

  const view = {
    ok: true,
    date,
    builtAt: Date.now(),
    pool: { zt: pool.zt.length, zb: zb.length, dt: pool.dtCount || dt.length },
    coverage: {
      scanned: items.length,
      withAnn,
      withNews,
      none,
      annErrors,
      pct: items.length ? Math.round((items.length - none) / items.length * 100) : 0
    },
    items,
    ruleStat,
    // 炸板池只给盘口事实，不抓公告（限流约束）
    failed: zb.slice(0, 12).map(s => buildItem(s, 'zb', newsMap)).map(x => ({
      code: x.code, name: x.name, industry: x.industry, board: x.board
    })),
    disclaimer: DISCLAIMER,
    note: NOTE,
    methods: METHODS
  };

  writeCache(view);
  return view;
}

module.exports = { build, readCache, CACHE_FILE, DISCLAIMER };
