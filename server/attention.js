'use strict';

/**
 * 个股关注度热度 · 舆情指数 · 外围市场联动
 *
 * 【GitHub 开源项目调研与选型结论（2025–2026，本机已核对 README）】
 *
 *  A. ramhee98/StockSentimentAlpha（MIT，2025-10 更新）
 *     - 双模型：VADER（词典）+ FinBERT（GPU 推理）；每标的按日聚合「Sentiment Index」，
 *       输出 label / confidence / compound / pos-neg-neu 概率。
 *     - 信号融合权重（README 明确给出）：情绪 30% / RSI 25% / MACD 25% / 价格趋势 20%，
 *       阈值 ±0.4 → buy / hold / sell。
 *     → 【选用】「每标的独立情绪指数 + 置信度 + 情绪作为独立分组参与加权」的结构与量纲。
 *     → 【不选用】buy/sell 阈值（本系统不产出买卖信号）；FinBERT（需 transformers/PyTorch/
 *        模型权重/GPU，与零依赖 Node 运行时冲突），改用项目同样提供的 VADER 词典路线。
 *
 *  B. sansan0/TrendRadar（63.6K stars，2026 活跃）
 *     - 多平台热榜聚合，统计「排名变化 + 出现频次 + 跨平台排名差异」，按自定义权重重排；
 *       默认约 30 分钟抓取一次；README 未公开具体权重公式（仅提示 config.yaml 可调三个比例）。
 *     → 【选用】多平台交叉 + 排名变化 + 名次归一化的思路；权重公式由本模块自行定义并公开。
 *     → 【不选用】其 newsnow 依赖与 GitHub Actions 调度（本机直连交易所/门户数据更实时）。
 *
 *  C. Open-Dev-Society/OpenStock（~20K stars，2025–2026）
 *     - 每只股票的「跨源情绪卡」聚合 Reddit / X / 财经新闻 / Polymarket，让分歧度可见。
 *     → 【选用】跨源交叉验证与「单源/双源置信度」表达。
 *     → 【不选用】其 Adanos / Finnhub / Reddit API（需 key；本机实测雪球 400、股吧 302 跳转）。
 *
 *  D. Ayushs6/StockWatch、katsav21/NVDA_Sentiment_Analysis、AjayParthibha/Market-Sentiment-Analyzer
 *     - 均为 Reddit + 新闻 + FinBERT 路线。后者公开实测：NVDA 社媒情绪与股价相关系数仅 -0.112。
 *     → 【不选用】社媒数据在本机不可达且需 OAuth；同时该相关性结果支持「情绪只作相对排序因子、
 *        不用于价格预测」的克制设计。
 *
 *  E. 666ghj/BettaFish（微舆，42.7K stars）、jundizhou/easy-stock
 *     - 多智能体舆情 / A 股大 V 观点聚合，需 LLM 与多源爬虫。
 *     → 【选用】理念上的「舆情与行情并列输入」；【不选用】重型多智能体实现。
 *
 * 【本模块落地】
 *   1) 热度：东财人气榜 + 同花顺热榜双源交叉 → 0-100 关注度分、排名变化、概念标签、置信度。
 *   2) 舆情：东财个股中文资讯（真实个股级）+ 已中文化的全球新闻（个股名 / 行业 / 概念标签命中），
 *      VADER 式情绪分 + 12 小时半衰期时间衰减 + 重要度加权 → 每标的情绪指数
 *      （StockSentimentAlpha 的 per-ticker sentiment index 可解释子集）。
 *   3) 外围联动：黄金 / 原油 / 美债10Y / 美元指数日内变动 → 风险偏好状态 → 行业敏感度调整。
 *
 * 【诚实边界】热榜是「关注度」而非资金流向，休市时为最近交易时段快照；个股舆情受中文新闻
 *   覆盖率限制（英文新闻里的公司英文名不与 A 股中文名互认），无覆盖时按中性 50 计并明确标注；
 *   外围联动为规则推理的方向修正，不是因果判断或价格预测。
 */

const fs = require('node:fs');
const path = require('node:path');
const { UA } = require('./sources');
const { scoreSentiment } = require('./analysis');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'attention-cache.json');
const STOCK_NEWS_CACHE = path.join(__dirname, '..', 'data', 'stock-news-cache.json');
const EM_RANK_URL = 'https://emappdata.eastmoney.com/stockrank/getAllCurrentList';
const THS_HOT_URL = 'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type=hour&list_type=normal';
const EM_STOCK_NEWS = 'https://np-listapi.eastmoney.com/comm/web/getListInfo';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const finite = v => Number.isFinite(+v) ? +v : null;
const round = (v, n = 1) => +Number(v).toFixed(n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let memCache = null;
let newsCache = null;

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/* ------------------------------- 数据源 ------------------------------- */

async function getJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://quote.eastmoney.com/', ...(init.headers || {}) },
    signal: AbortSignal.timeout(11000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/** 东方财富人气榜：rk 名次、rc / hisRc 排名变动（平台原始符号，正数视为升温） */
async function fetchEastmoneyRank() {
  const j = await getJson(EM_RANK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: 'appId01', globalId: '786e4c21-70dc-435a-93bb-38',
      marketType: '', pageNo: 1, pageSize: 100
    })
  });
  const arr = Array.isArray(j && j.data) ? j.data : [];
  const map = new Map();
  for (const r of arr) {
    const sc = String(r.sc || '');
    const code = sc.replace(/^(SH|SZ|BJ)/i, '');
    if (!/^\d{6}$/.test(code) || !Number.isFinite(+r.rk)) continue;
    map.set(code, {
      rank: +r.rk,
      rankDelta: finite(r.hisRc) ?? finite(r.rc) ?? 0,
      raw: { rc: r.rc, hisRc: r.hisRc }
    });
  }
  if (!map.size) throw new Error('人气榜返回空');
  return { map, count: map.size };
}

/** 同花顺热榜：rate 热度值、order 名次、hot_rank_chg 名次变化、概念/人气标签、异动标题 */
async function fetchThsHot() {
  const j = await getJson(THS_HOT_URL);
  const arr = (j && j.data && Array.isArray(j.data.stock_list)) ? j.data.stock_list : [];
  const map = new Map();
  for (const r of arr) {
    const code = String(r.code || '');
    if (!/^\d{6}$/.test(code)) continue;
    const rate = finite(r.rate) || 0;
    const tag = r.tag && typeof r.tag === 'object' ? r.tag : {};
    map.set(code, {
      rank: finite(r.order) || 0,
      rankDelta: finite(r.hot_rank_chg) || 0,
      rate,
      name: String(r.name || ''),
      conceptTags: Array.isArray(tag.concept_tag) ? tag.concept_tag.map(String).filter(Boolean) : [],
      popularityTag: String(tag.popularity_tag || ''),
      catalyst: String(r.analyse_title || r.topic || ''),
      riseAndFall: finite(r.rise_and_fall)
    });
  }
  if (!map.size) throw new Error('热榜返回空');
  return { map, count: map.size };
}

/* ------------------------------- 热度合成 ------------------------------- */

/**
 * 借鉴 TrendRadar 的「多平台名次 + 排名变化 + 出现频次」与 OpenStock 的跨源交叉：
 *   rankScore  = 100 - (名次-1)*0.9               名次归一化
 *   rateScore  = 榜内 log 热度值的分位             热度值归一化
 *   base       = 0.75*名次均值 + 0.25*热度值分位
 *   crossBoost = 双榜同时命中 +6（关注度交叉验证）
 *   delta      = 两榜排名变动之和 * 1.5，截断 ±10
 * 权重为本模块自定义并公开，非 TrendRadar 原公式（该项目未公开公式）。
 */
function computeHeat(em, ths) {
  const rates = Array.from(ths.values()).map(x => x.rate).filter(v => v > 0);
  const logMin = rates.length ? Math.log(Math.min(...rates)) : 0;
  const logMax = rates.length ? Math.log(Math.max(...rates)) : 1;
  const codes = new Set([...em.keys(), ...ths.keys()]);
  const out = new Map();

  for (const code of codes) {
    const e = em.get(code) || null, t = ths.get(code) || null;
    const emScore = e ? clamp(100 - (e.rank - 1) * 0.9, 0, 100) : null;
    const thsScore = t && t.rank ? clamp(100 - (t.rank - 1) * 0.9, 0, 100) : null;
    const rankScores = [emScore, thsScore].filter(v => v !== null);
    const rankAvg = rankScores.reduce((a, b) => a + b, 0) / rankScores.length;
    const rateScore = t && t.rate > 0 && logMax > logMin
      ? clamp(((Math.log(t.rate) - logMin) / (logMax - logMin)) * 100, 0, 100) : rankAvg;
    const crossBoost = e && t ? 6 : 0;
    const delta = clamp(((e ? e.rankDelta : 0) + (t ? t.rankDelta : 0)) * 1.5, -10, 10);
    const heatScore = Math.round(clamp(0.75 * rankAvg + 0.25 * rateScore + crossBoost + delta, 0, 100));

    out.set(code, {
      code,
      emRank: e ? e.rank : null,
      emRankDelta: e ? e.rankDelta : null,
      thsRank: t ? t.rank : null,
      thsRankDelta: t ? t.rankDelta : null,
      hotRate: t ? t.rate : null,
      conceptTags: t ? t.conceptTags : [],
      popularityTag: t ? t.popularityTag : '',
      catalyst: t ? t.catalyst : '',
      heatScore,
      heatLevel: heatScore >= 75 ? '高热' : heatScore >= 55 ? '升温' : heatScore >= 35 ? '常温' : '低关注',
      sourceCount: (e ? 1 : 0) + (t ? 1 : 0),
      confidence: e && t ? '高' : (e || t) ? '中' : '无',
      sourceLabel: e && t ? '东财人气榜 + 同花顺热榜' : e ? '东财人气榜（单源）' : '同花顺热榜（单源）'
    });
  }
  return out;
}

function readCache() {
  if (memCache) return memCache;
  try {
    if (fs.existsSync(CACHE_FILE)) memCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (_) { memCache = null; }
  return memCache;
}

function writeCache(d) {
  memCache = d;
  try {
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d), 'utf8');
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) { console.warn('[attention] 缓存写入失败:', e.message); }
}

function cachedShape(c, stale) {
  return { ...c, fromCache: true, stale, note: stale ? '热榜源暂时不可达，沿用上次成功快照' : (c.note || '') };
}

/**
 * @param {object} opts { force, refreshMin, trading }
 * 休市时热榜不再变化，缓存窗口自动放宽 6 倍，避免无意义请求。
 */
async function fetchAttention(opts = {}) {
  const refreshMin = clamp(Number(opts.refreshMin) || 5, 1, 240);
  const ttl = refreshMin * 60000 * (opts.trading ? 1 : 6);
  const cached = readCache();
  if (!opts.force && cached && cached.ok && Date.now() - cached.generatedAt < ttl) {
    return cachedShape(cached, false);
  }

  const [emR, thsR] = await Promise.allSettled([fetchEastmoneyRank(), fetchThsHot()]);
  const em = emR.status === 'fulfilled' ? emR.value.map : new Map();
  const ths = thsR.status === 'fulfilled' ? thsR.value.map : new Map();
  const sources = {
    eastmoney: emR.status === 'fulfilled' ? { ok: true, count: emR.value.count } : { ok: false, error: String(emR.reason && emR.reason.message) },
    ths: thsR.status === 'fulfilled' ? { ok: true, count: thsR.value.count } : { ok: false, error: String(thsR.reason && thsR.reason.message) }
  };
  if (!em.size && !ths.size) {
    if (cached && cached.ok) return cachedShape(cached, true);
    return { ok: false, generatedAt: Date.now(), sources, items: {}, note: '两个热榜源均不可达', fromCache: false, stale: true };
  }

  const heatMap = computeHeat(em, ths);
  const items = {};
  for (const [code, v] of heatMap) items[code] = v;
  const bj = new Date(Date.now() + 8 * 3600000);
  const trading = !!opts.trading;
  const result = {
    ok: true,
    version: 1,
    generatedAt: Date.now(),
    trading,
    sources,
    poolSize: heatMap.size,
    note: trading
      ? '热度为盘中实时人气快照；东财人气榜反映自选/浏览关注度，同花顺热榜反映搜索与讨论热度。'
      : '当前为非交易时段，热榜为最近交易时段的关注度快照，不代表实时资金进出。',
    coverageNote: '热榜仅覆盖前 100 名，未上榜个股按「无热度数据」中性处理。',
    methodology: {
      rank: '名次分 = 100 − (名次−1)×0.9；热度值分 = 榜内 log(rate) 分位',
      fusion: '0.75×名次均值 + 0.25×热度值分位 + 双榜交叉加成 6 + 排名变动×1.5（截断 ±10）',
      reference: '参考 TrendRadar 的多平台排名/排名变化聚合与 OpenStock 的跨源情绪卡；权重为本模块自定义并公开'
    },
    items,
    fromCache: false,
    stale: false,
    fetchedAtLabel: bj.toISOString().slice(0, 16).replace('T', ' ') + ' 北京时间'
  };
  writeCache(result);
  return result;
}

/* ------------------------------- 个股中文资讯 ------------------------------- */

/**
 * 东方财富个股资讯（真实个股级新闻，非行业主题推测）。
 * 全球新闻流以宏观英文报道为主，A 股个股名几乎不出现；此接口按 secid 返回中文个股标题，
 * 是让「个股舆情」真正有数据支撑的关键来源。
 */
async function fetchOneStockNews(code) {
  const secid = (/^6/.test(code) ? '1.' : '0.') + code;
  const url = EM_STOCK_NEWS + '?client=web&biz=web_news_col&column=347&order=1&needjump=false' +
    '&pageindex=1&pagesize=8&mTypeAndCode=' + secid + '&type=1&_=' + Date.now();
  const j = await getJson(url);
  const list = (j && j.data && Array.isArray(j.data.list)) ? j.data.list : [];
  return list.map(x => {
    const title = String(x.Art_Title || '').trim();
    const ts = Date.parse(String(x.Art_ShowTime || '').replace(' ', 'T') + '+08:00');
    return {
      title,
      publishedAt: Number.isFinite(ts) ? ts : Date.now() - 24 * 3600000,
      timeLabel: String(x.Art_ShowTime || ''),
      url: String(x.Art_Url || x.Art_OriginUrl || '#')
    };
  }).filter(x => x.title.length >= 6).slice(0, 8);
}

function readNewsCache() {
  if (newsCache) return newsCache;
  try {
    if (fs.existsSync(STOCK_NEWS_CACHE)) newsCache = JSON.parse(fs.readFileSync(STOCK_NEWS_CACHE, 'utf8'));
  } catch (_) { newsCache = null; }
  return newsCache;
}

function writeNewsCache(d) {
  newsCache = d;
  try {
    const tmp = STOCK_NEWS_CACHE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d), 'utf8');
    fs.renameSync(tmp, STOCK_NEWS_CACHE);
  } catch (e) { console.warn('[attention] 个股资讯缓存写入失败:', e.message); }
}

/**
 * 按代码批量取个股资讯，只请求「缓存缺失或已过期」的代码。
 * @param {string[]} codes
 * @param {object} opts { force, trading, refreshMin }
 */
async function fetchStockNews(codes, opts = {}) {
  const wanted = Array.from(new Set((codes || []).map(String).filter(c => /^\d{6}$/.test(c))));
  const ttl = (clamp(Number(opts.refreshMin) || 10, 1, 240) * 60000) * (opts.trading ? 1 : 6);
  const prev = readNewsCache();
  const base = (prev && prev.items && typeof prev.items === 'object') ? { ...prev.items } : {};
  const prevAt = (prev && prev.generatedAt) || 0;
  const need = opts.force ? wanted : wanted.filter(c => !base[c] || Date.now() - prevAt >= ttl);

  const failures = [];
  for (let i = 0; i < need.length; i += 5) {
    const batch = need.slice(i, i + 5);
    const res = await Promise.allSettled(batch.map(fetchOneStockNews));
    res.forEach((r, k) => {
      if (r.status === 'fulfilled') base[batch[k]] = r.value;
      else failures.push(batch[k] + ': ' + (r.reason && r.reason.message));
    });
    if (i + 5 < need.length) await sleep(140);
  }
  // 请求失败的代码沿用上次结果，避免舆情突然归零
  const items = {};
  for (const c of wanted) items[c] = base[c] || [];
  const fingerprint = hash(wanted.join(',') + '|' + wanted.map(c => (items[c][0] || {}).title || '').join('|'));
  const result = {
    ok: !failures.length || wanted.some(c => items[c].length),
    generatedAt: Date.now(),
    requested: wanted.length,
    refreshed: need.length,
    failures,
    stale: failures.length > 0,
    fingerprint,
    items,
    source: '东方财富 · 个股资讯（web_news_col）',
    note: '每只标的取最近 8 条中文个股资讯标题；休市时为最近交易日资讯，缓存窗口自动放宽。'
  };
  if (need.length || !prev) writeNewsCache({ ...result, items: base });
  return result;
}

/* ------------------------------- 个股舆情指数 ------------------------------- */

const STOP_TERMS = new Set(['中国', '美国', '全球', '市场', '公司', '其他', '综合', '行业', '板块', '股票', '概念', '未分类']);

function termsFor(stock, heat) {
  const terms = [];
  const name = String(stock.name || '').replace(/\s/g, '');
  if (name.length >= 2) terms.push({ t: name, w: 1.0, kind: '个股' });
  const short = name.replace(/(股份有限公司|有限责任公司|有限公司|股份|集团|控股|科技|实业|发展)$/g, '');
  if (short.length >= 3 && short !== name) terms.push({ t: short, w: 0.9, kind: '个股' });
  const industry = String(stock.industry || '');
  if (industry.length >= 2 && !STOP_TERMS.has(industry)) terms.push({ t: industry, w: 0.35, kind: '行业' });
  const tags = (heat && heat.conceptTags) || [];
  for (const c of tags.slice(0, 4)) {
    if (c.length >= 3 && !STOP_TERMS.has(c)) terms.push({ t: c, w: 0.5, kind: '概念' });
  }
  // 长词优先，避免「中国银行」被「中国」提前截断
  return terms.sort((a, b) => b.t.length - a.t.length);
}

/**
 * 每标的舆情指数：StockSentimentAlpha「daily sentiment index per ticker」的可解释子集。
 * 命中新闻 → VADER 式情绪分 × 时间衰减(12h 半衰期) × 重要度权重 → 收缩加权平均。
 * @param {Array} news  已带 sentiment / importance / displayTitle 的新闻
 * @param {Array} stocks 候选股（至少含 code / name / industry）
 * @param {object} attention fetchAttention 结果
 */
function buildStockSentiment(news, stocks, attention, stockNews = null, now = Date.now()) {
  const heatItems = (attention && attention.items) || {};
  const ownNewsMap = (stockNews && typeof stockNews === 'object') ? stockNews : {};
  const list = (news || []).filter(n => n && (n.relevance === undefined || n.relevance >= 20));
  const prepared = list.map(n => {
    const text = String(n.displayTitle || n.titleZh || n.title || '');
    const alt = String(n.title || '') + ' ' + String(n.desc || '');
    const s = Number.isFinite(n.sentiment) ? n.sentiment : scoreSentiment(text + ' ' + alt).score;
    const ageH = Math.max(0, (now - (n.publishedAt || now)) / 3600000);
    return {
      text, lower: (text + ' ' + alt).toLowerCase(),
      sentiment: s,
      decay: Math.pow(0.5, ageH / 12),
      weight: 0.5 + (Number(n.importance) || 40) / 200,
      title: text,
      label: n.sentimentLabel || scoreSentiment(text).label,
      link: n.link || '#',
      source: n.source || ''
    };
  });

  const out = new Map();
  for (const st of stocks) {
    const code = String(st.code);
    const heat = heatItems[code] || null;
    const terms = termsFor(st, heat);
    const hits = [];
    // ① 个股相关资讯：东财个股页栏目是「个股新闻 + 板块/市场资讯」混合，
    //    只有标题点名个股名或 6 位代码才算个股级，其余按「关联资讯」低权重计入。
    const ownNews = ownNewsMap[code] || [];
    const nameClean = String(st.name || '').replace(/\s/g, '');
    const shortName = nameClean.replace(/(股份有限公司|有限责任公司|有限公司|股份|集团|控股|科技|实业|发展)$/g, '');
    let ownSpecific = 0;
    for (const e of ownNews) {
      const isOwn = e.title.includes(code) ||
        (nameClean.length >= 2 && e.title.includes(nameClean)) ||
        (shortName.length >= 3 && e.title.includes(shortName));
      if (isOwn) ownSpecific++;
      const r = scoreSentiment(e.title);
      const ageH = Math.max(0, (now - (e.publishedAt || now)) / 3600000);
      hits.push({
        title: e.title, sentiment: r.score, label: r.label,
        matchedBy: isOwn ? '个股名/代码' : '个股关联栏目',
        matchKind: isOwn ? '个股资讯' : '关联资讯',
        matchWeight: isOwn ? 1.5 : 0.4,
        decay: Math.pow(0.5, ageH / 12), weight: 0.8,
        link: e.url || '#', source: '东方财富 · 个股相关资讯',
        timeLabel: e.timeLabel || ''
      });
    }
    const ownCount = hits.length;
    // ② 全球新闻流：按个股名 / 行业 / 概念标签命中（主题级舆情）
    const seen = new Set();
    for (const item of prepared) {
      let best = null;
      for (const term of terms) {
        if (term.t.length < 2) continue;
        if (item.lower.includes(term.t.toLowerCase())) {
          if (!best || term.w > best.w) best = term;
        }
      }
      if (!best) continue;
      const key = item.title.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ ...item, matchedBy: best.t, matchKind: best.kind, matchWeight: best.w });
    }

    let num = 0, den = 0;
    for (const h of hits) {
      const w = h.decay * h.weight * h.matchWeight;
      num += h.sentiment * w; den += w;
    }
    // 收缩项 1.5：单条命中不会让情绪指数直接跳到极值
    const index = hits.length ? Math.round(clamp((num / (den + 1.5)) * 1.2, -100, 100)) : 0;
    const individual = hits.filter(h => h.matchKind === '个股' || h.matchKind === '个股资讯').length;
    const globalHits = hits.length - ownCount;
    // 资讯覆盖度与情绪分分开表达：中文财经标题多为中性陈述，若只看情绪会让舆情组退化为常数。
    // 覆盖度只衡量「信息流关注」，不代表利好，故与情绪分按 35/65 合成并在理由中标明。
    const coverageScore = clamp(30 + ownSpecific * 12 + ownCount * 1.5 + globalHits * 4, 0, 100);
    const emotionScore = hits.length ? clamp(50 + index * 0.5, 0, 100) : 50;
    const scored = hits.length ? 0.65 * emotionScore + 0.35 * coverageScore : 50;
    out.set(code, {
      index,
      score: +scored.toFixed(1),
      emotionScore: +emotionScore.toFixed(1),
      coverageScore: Math.round(coverageScore),
      label: !hits.length ? '无舆情覆盖' : index >= 25 ? '偏暖' : index >= 8 ? '略暖'
        : index <= -25 ? '偏冷' : index <= -8 ? '略冷' : '中性',
      hitCount: hits.length,
      individualHits: individual,
      ownNewsCount: ownCount,
      ownSpecificCount: ownSpecific,
      confidence: individual >= 3 ? '高' : individual >= 1 ? '中' : hits.length >= 3 ? '低' : '无',
      headlines: hits.slice(0, 4).map(h => ({
        title: h.title, sentiment: h.sentiment, label: h.label,
        matchedBy: h.matchedBy, matchKind: h.matchKind, link: h.link,
        source: h.source, timeLabel: h.timeLabel || ''
      })),
      note: !hits.length
        ? '个股资讯与全球新闻流均未命中该股名称、行业或概念标签，舆情按中性 50 计'
        : '个股相关资讯 ' + ownCount + ' 条（标题点名 ' + ownSpecific + ' 条）+ 全球新闻命中 ' + globalHits +
          ' 条；情绪指数 ' + index + '、资讯覆盖 ' + Math.round(coverageScore) +
          '/100（覆盖度只反映信息流关注，不代表利好）；按 12 小时半衰期加权'
    });
  }
  return out;
}

/* ------------------------------- 外围市场联动 ------------------------------- */

const MOVE_LABELS = {
  xau: '伦敦金现', gold: 'COMEX 黄金', wti: 'WTI 原油', brent: '布伦特原油',
  ust10y: '美债10Y收益率', dxy: '美元指数', spread: '10Y-2Y 利差'
};

/** 行业敏感度规则：direction 为变动百分比的乘数，正值表示「该指标上涨利好该行业」 */
const SECTOR_RULES = [
  { re: /黄金|贵金属|有色|小金属|稀有金属/, factor: 'gold', k: 1.3, reason: '金价上行通常改善贵金属/有色板块盈利预期' },
  { re: /石油|石化|油气|油服|煤炭|能源/, factor: 'oil', k: 1.1, reason: '油价上行抬升上游资源品价格' },
  { re: /航空|机场|航运|物流|运输/, factor: 'oil', k: -1.2, reason: '油价上行推高燃油成本，压制运输类毛利' },
  { re: /半导体|软件|电子|通信|计算机|医药|生物|新能源|光伏|互联网/, factor: 'yield', k: -1.1, reason: '美债收益率上行抬高贴现率，压制高久期成长股估值' },
  { re: /银行|保险|券商|多元金融/, factor: 'yield', k: 0.6, reason: '利率中枢上行改善金融板块息差与再投资收益' },
  { re: /房地产|地产|建筑|建材|工程/, factor: 'yield', k: -0.9, reason: '利率与融资成本敏感，收益率上行压制地产链' },
  { re: /家电|纺织|机械|汽车|家居|消费电子|贸易/, factor: 'dxy', k: 0.8, reason: '美元走强改善出口型企业的汇兑与价格竞争力' },
  { re: /钢铁|化工|造纸|有色/, factor: 'oil', k: 0.5, reason: '能源与大宗成本传导' }
];

/**
 * 外围行情 → 风险偏好状态 + 行业敏感度。所有 quotes 均为本系统已抓取的真实行情，
 * changePct 为数据源给出的相对前收变动（收益率标的为相对百分比变动，非基点）。
 */
function buildMarketContext(quotes) {
  const byId = new Map((quotes || []).map(q => [q.id, q]));
  const pct = id => {
    const q = byId.get(id);
    const v = q ? finite(q.changePct) : null;
    return v === null ? 0 : clamp(v, -8, 8);
  };
  const gold = pct('xau') || pct('gold');
  const oil = pct('wti') || pct('brent');
  const yieldMv = pct('ust10y');
  const dxy = pct('dxy');
  const spread = pct('spread');

  // 避险升温为负、风险偏好回升为正；系数把「百分之零点几」放大到可读刻度
  const score = Math.round(clamp(
    -(gold * 6 + yieldMv * 4 + dxy * 5 + Math.max(0, oil) * 2.2 - Math.max(0, -oil) * 1.2 - spread * 0.4),
    -100, 100
  ));
  const regime = score <= -25 ? '避险升温' : score >= 25 ? '风险偏好回升'
    : score <= -10 ? '偏谨慎' : score >= 10 ? '偏积极' : '中性';
  const factors = { gold, oil, yield: yieldMv, dxy, spread };
  const moves = ['xau', 'wti', 'ust10y', 'dxy', 'spread'].map(id => {
    const q = byId.get(id);
    if (!q) return null;
    return { id, label: MOVE_LABELS[id] || id, value: q.value, changePct: finite(q.changePct), quality: q.quality };
  }).filter(Boolean);

  return {
    version: 1,
    generatedAt: Date.now(),
    score, regime, factors, moves,
    // 用于判断是否需要触发观察池重算；保留一位小数避免浮点抖动
    signature: [regime, score, round(gold), round(oil), round(yieldMv), round(dxy)].join('|'),
    note: score <= -25
      ? '黄金/美元走强叠加利率压力，外围环境偏向避险，成长与高估值板块的评分修正为负'
      : score >= 25
        ? '避险资产回落、利率压力缓解，外围环境偏向风险偏好回升'
        : '外围市场变动温和，仅对敏感行业做小幅修正',
    disclaimer: '外围联动为规则推理的方向修正（±12 分以内），不是因果结论或涨跌预测；休市时行情为最近报价快照。'
  };
}

/** 返回指定行业的调整分与理由，供评分使用 */
function marketAdjustFor(industry, market) {
  if (!market) return { adjustment: 0, reasons: [], matched: 0 };
  const text = String(industry || '');
  let sum = 0; const reasons = []; let matched = 0;
  for (const rule of SECTOR_RULES) {
    if (!rule.re.test(text)) continue;
    const v = clamp(market.factors[rule.factor] || 0, -8, 8);
    if (Math.abs(v) < 0.05) continue;
    const d = clamp(v * rule.k, -6, 6);
    sum += d; matched++;
    if (reasons.length < 3) reasons.push(rule.reason + '（' + (d > 0 ? '+' : '') + round(d) + ' 分）');
  }
  if (!matched) {
    // 未命中行业规则时，只给一个很小的全局风险偏好项，避免过度干预
    sum = clamp(market.score * 0.035, -3, 3);
    if (Math.abs(market.score) >= 25) reasons.push('行业无特异映射，按全局风险偏好 ' + market.regime + ' 做 ' + round(sum) + ' 分轻微修正');
  }
  const adjustment = +clamp(sum, -12, 12).toFixed(1);
  if (!reasons.length) reasons.push('外围市场变动温和，本行业无显著修正');
  return { adjustment, reasons, matched, regime: market.regime };
}

module.exports = {
  fetchAttention, fetchStockNews, buildStockSentiment, buildMarketContext, marketAdjustFor,
  computeHeat, termsFor, CACHE_FILE, STOCK_NEWS_CACHE
};
