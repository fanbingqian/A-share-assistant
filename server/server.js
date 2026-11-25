'use strict';

/**
 * 全球市场监测与报警系统 · 本地服务
 * 仅监听 127.0.0.1，不对外暴露；零第三方依赖，Node 18+ 即可运行。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sources = require('./sources');
const {
  loadConfig, saveConfig, loadState, saveState,
  appendAlerts, loadAlertHistory, deepMerge, DEFAULT_CONFIG
} = require('./config');
const { evaluate, createRuntime, makeTestAlert, makeAlert, inQuietHours } = require('./alerts');
const translate = require('./translate');
const analysis = require('./analysis');
const attention = require('./attention');
const marketStyle = require('./marketStyle');
const events = require('./events');
const limitup = require('./limitup');
const attribution = require('./attribution');
const technical = require('./technical');
const mypicks = require('./mypicks');
const stocks = require('./stocks');
const ic = require('./ic');
const journal = require('./journal');
const holdings = require('./holdings');
const cycle = require('./cycle');
const flow = require('./flow');
const riskoff = require('./riskoff');
const strength = require('./strength');
const valuation = require('./valuation');
const phase = require('./phase');
const stack = require('./stack');
const watchers = require('./watchers');
const agent = require('./agent');
const emtx = require('./emtx');
/* ===== v2 新外壳模块（Hermes 核心智能体贯穿）===== */
const hermes = require('./hermes');
const cal = require('./calendar');
const daily = require('./daily');
const portfolio = require('./portfolio');
const knowledge = require('./knowledge');
const predictions = require('./predictions');
const screener = require('./screener');
const stockAnalysis = require('./stock-analysis');
const scheduler = require('./scheduler');
const report = require('./report');
const eventStudy = require('./event-study');
const perception = require('./perception');
const newsPulse = require('./news-pulse');
const newsFlash = require('./news-flash');
const reviewTeam = require('./review-team');
const universe = require('./universe');
const pickInsight = require('./pick-insight');
const pickPool = require('./pick-pool');
const chatStore = require('./chat-store');
const sentiment = require('./sentiment');
const strategy = require('./strategy');
const futureEvents = require('./future-events');
const updateFeed = require('./update-feed');
const newsTriage = require('./news-triage');
/* ===== 全板块知识图谱 / 垃圾信息处理 / Hermes agent loop ===== */
const unifiedGraph = require('./unified-graph');
const dataHygiene = require('./data-hygiene');
const agentTools = require('./agent-tools');
const agentLoop = require('./agent-loop');

const PORT = Number(process.env.PORT || 8777);
const HOST = '127.0.0.1';
const WEB_DIR = path.resolve(__dirname, '..', 'web');
const MAX_HISTORY = 900;
const MAX_ALERTS = 400;

let config = loadConfig();
const saved = loadState();
const runtime = createRuntime(saved);
let alerts = loadAlertHistory(160);
let history = saved.history || {};

const latest = {
  quotes: [],
  news: { items: [], feedHealth: {}, fetchedAt: 0, ok: false },
  analysis: null, stocks: null, attention: null, market: null, stockNews: null, style: null,
  events: null, macro: null, eventRaw: null, ic: null,
  limitup: null, limitRaw: null, limitContext: null,
  // 涨停/炸板事实卡（只陈列公开事实，不认定原因）
  attribution: null,
  // P0 八项确定性技术因子（只读标注层，不进 stocks.js 评分）
  technical: null,
  journal: null, cyc: null, flow: null, riskoff: null, holdings: null,
  // 预期研究层：板块相对强弱 / 市值重估 / 板块阶段 / 多因素叠加（统一由 runEdge 编排）
  edge: null,
  health: {}, errors: [], sourceLatency: {},
  quoteFetchedAt: 0, newsFetchedAt: 0,
  startedAt: Date.now()
};

let quoteBusy = false, newsBusy = false, quotesSeen = false;
let lastPolicyAlertIds = new Set(); // 政策快讯提醒去重：同一条只主动弹一次
let analysisBusy = false, stocksBusy = false, lastAnalysisAt = 0;
let stylePromise = null;  // 风格计算较重（含全市场分页），并发调用复用同一 Promise
let eventsBusy = false, signalBusy = false, lastMacroSignature = '', lastEventSignature = '';
let lastMarketSignature = '', lastMarketScore = 0, lastMarketRegime = '', lastQuoteTriggerAt = 0;
let quoteTimer = null, newsTimer = null, stocksTimer = null, styleTimer = null, eventsTimer = null, icTimer = null, limitTimer = null, lastPersist = 0;
let journalTimer = null, cycleTimer = null, flowTimer = null, riskoffTimer = null, holdingsTimer = null, edgeTimer = null;
let attributionTimer = null, technicalTimer = null, watchersTimer = null, agentTimer = null;
let icBusy = false, limitBusy = false, cycleBusy = false, flowBusy = false, riskoffBusy = false, journalBusy = false, holdingsBusy = false, edgeBusy = false, attributionBusy = false, technicalBusy = false, watchersBusy = false, agentBusy = false;
let flowRefreshDay = null;
// 事件告警去重：按事件 ID 记录已推送；首次启动把当前事件全部标记为基线，不补推历史积压
const seenEventAlerts = new Set();
let eventAlertBaselineSet = false;
const sseClients = new Set();

/* ------------------------------- 广播与快照 ------------------------------- */

function broadcast(event, data) {
  let payload;
  try { payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'; }
  catch (e) { console.error('[sse] 序列化失败:', e.message); return; }
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
  // 每条 SSE 广播都对应一次真实数据变更，登记为对应板块的更新事件（高频事件内部聚合）
  try { updateFeed.observe(event, data); } catch (_) {}
}

/** 对外输出用的配置副本：API Key 永不以明文出现在 HTTP / SSE 响应里。
 *  真实 Key 只保留在服务端内存与 data/config.json；前端只拿到掩码 + 是否已配置。 */
function publicConfig(src = config) {
  const c = structuredClone(src);
  if (!c.agent) c.agent = {};
  const real = c.agent.apiKey;
  c.agent.apiKey = hermes.maskKey(real) || '';
  c.agent.apiKeySet = !!real;
  return c;
}

function snapshot() {
  return {
    config: publicConfig(),
    quotes: latest.quotes,
    news: latest.news,
    history,
    alerts: alerts.slice(-120),
    health: latest.health,
    errors: latest.errors,
    sourceLatency: latest.sourceLatency,
    quoteFetchedAt: latest.quoteFetchedAt,
    newsFetchedAt: latest.newsFetchedAt,
    analysis: latest.analysis,
    stocks: latest.stocks,
    attention: latest.attention,
    market: latest.market,
    style: latest.style,
    events: latest.events,
    macro: latest.macro,
    limitup: latest.limitup,
    journal: latest.journal,
    cycle: latest.cyc,
    flow: latest.flow,
    holdings: latest.holdings,
    riskoff: latest.riskoff,
    edge: latest.edge,
    ic: latest.ic,
    startedAt: latest.startedAt,
    serverTime: Date.now(),
    dataNote: '全部数值来自公开实时接口，具体来源与时点见每张卡片标注；自检告警为模拟数据，不代表真实行情。新闻中文由机器翻译生成；新闻解读与观察池为规则推理，不构成投资建议。'
  };
}

function pushAlerts(list) {
  if (!list || !list.length) return;
  for (const a of list) {
    alerts.push(a);
    broadcast('alert', a);
    console.log('[告警] ' + a.level.toUpperCase() + ' | ' + a.title + ' | ' + a.message);
  }
  if (alerts.length > MAX_ALERTS) alerts = alerts.slice(-MAX_ALERTS);
  appendAlerts(list);
}

/* ------------------------------- 历史序列 ------------------------------- */

function appendLiveHistory(quotes, ts) {
  for (const q of quotes) {
    const v = +q.value;
    if (!Number.isFinite(v)) continue;
    if (!Array.isArray(history[q.id])) history[q.id] = [];
    const arr = history[q.id];
    const last = arr[arr.length - 1];
    if (last && ts - last.t < 4000) continue;
    // 休市期间报价恒定，若每轮都追加常数点，会很快填满 900 点窗口、
    // 把 Yahoo 历史线挤出去，走势图变成一条水平直线。值不变时只推进末点时间。
    if (last && last.s === 'live' && last.v === v) { last.t = ts; continue; }
    arr.push({ t: ts, v, s: 'live' });
    if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
  }
}

async function initYahooHistory() {
  const ids = Object.keys(sources.YAHOO_MAP);
  const results = await Promise.allSettled(ids.map(id => sources.fetchYahooHistory(id)));
  let loaded = 0;
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value.length) return;
    const id = ids[i];
    const old = (history[id] || []).filter(p => p.s === 'live');
    const merged = r.value.map(p => ({ t: p.t, v: p.v, s: 'yahoo' })).concat(old);
    merged.sort((a, b) => a.t - b.t);
    // 同一时间戳去重
    history[id] = merged.filter((p, k) => k === 0 || p.t !== merged[k - 1].t).slice(-MAX_HISTORY);
    loaded++;
  });
  console.log('[history] Yahoo 历史线加载 ' + loaded + '/' + ids.length + ' 个标的');
  broadcast('history', { history, source: 'Yahoo Finance 5分钟线', loaded });
}

/* ------------------------------- 轮询任务 ------------------------------- */

async function doQuoteTick() {
  if (quoteBusy) return;
  quoteBusy = true;
  const now = Date.now();
  try {
    const r = await sources.fetchQuotes();
    latest.sourceLatency = r.latencyMs;
    if (r.quotes.length) {
      latest.quotes = r.quotes;
      latest.health = r.health;
      latest.errors = r.errors;
      latest.quoteFetchedAt = r.fetchedAt;
      runtime.lastQuoteSuccessAt = r.fetchedAt;
      appendLiveHistory(r.quotes, r.fetchedAt);
    } else {
      latest.health = r.health;
      latest.errors = r.errors;
    }

    const triggered = evaluate({
      quotes: r.quotes, news: null, health: r.health,
      config, runtime, now, isFirstQuote: !quotesSeen, mode: 'quote'
    });
    quotesSeen = true;
    pushAlerts(triggered);
    broadcast('tick', {
      quotes: r.quotes, health: r.health, errors: r.errors,
      sourceLatency: r.latencyMs, fetchedAt: r.fetchedAt, history
    });
    // 外围市场联动：每轮都更新上下文，出现显著变化时触发观察池「轻量重评分」
    if (r.quotes.length) {
      const mc = attention.buildMarketContext(r.quotes);
      latest.market = mc;
      if (lastMarketSignature && mc.signature !== lastMarketSignature && config.stocks.enabled) {
        const bigMove = Math.abs(mc.score - lastMarketScore) >= 8;
        const regimeChanged = mc.regime !== lastMarketRegime;
        if ((bigMove || regimeChanged) && Date.now() - lastQuoteTriggerAt > 60000) {
          lastQuoteTriggerAt = Date.now();
          console.log('[linkage] 外围行情变化触发观察池重评分 | ' + lastMarketRegime + ' → ' + mc.regime +
            ' | ' + lastMarketScore + ' → ' + mc.score);
          runStocks(false).catch(e => console.warn('[stocks]', e.message));
        }
      }
      lastMarketSignature = mc.signature;
      lastMarketScore = mc.score;
      lastMarketRegime = mc.regime;
      // 宏观避险状态依赖实时行情；内部按签名去重，微小报价波动不会反复触发重评分
      rebuildSignals();
    }
    if (r.errors.length) console.warn('[source] ' + r.errors.join(' | '));
  } catch (e) {
    console.error('[quote] 采集异常:', e.message);
    latest.errors = ['行情采集异常: ' + e.message];
    broadcast('tick', { quotes: latest.quotes, health: latest.health, errors: latest.errors, fetchedAt: now, history });
  } finally {
    quoteBusy = false;
    if (now - lastPersist > 60000) { lastPersist = now; persistState(); }
  }
}

async function doNewsTick() {
  if (newsBusy) return;
  newsBusy = true;
  try {
    const r = await sources.fetchNews();
    if (r.items.length) {
      // 轮询会重建 items，必须沿用上一轮的译文与分析字段，
      // 否则解读节流期间新闻列表会「退回英文」，出现中文时有时无的问题。
      const prev = new Map(latest.news.items.map(n => [n.id, n]));
      const keep = ['titleZh', 'descZh', 'translation', 'displayTitle', 'sentiment',
        'sentimentLabel', 'sentimentHits', 'relevance', 'topics', 'primaryTopic', 'directions', 'importance', 'insight'];
      const items = r.items.map(n => {
        const p = prev.get(n.id);
        if (!p) return n;
        const carry = {};
        for (const k of keep) if (p[k] !== undefined) carry[k] = p[k];
        return { ...n, ...carry };
      });
      latest.news = {
        items, feedHealth: r.feedHealth,
        fetchedAt: r.fetchedAt, ok: r.ok
      };
      latest.newsFetchedAt = r.fetchedAt;
      runtime.lastNewsAt = r.fetchedAt;
    }
    const triggered = evaluate({
      quotes: latest.quotes, news: r.items.length ? r : null, health: {},
      config, runtime, now: Date.now(), mode: 'news'
    });
    if (!r.items.length) {
      pushAlerts([makeAlert({
        level: 'warning', category: 'system', rule: 'news-down',
        title: '新闻源全部不可达', message: '本轮未抓取到任何新闻，请检查网络连接。',
        source: '新闻采集', silent: false
      })]);
    }
    pushAlerts(triggered);
    // 政策快讯：按政策关键词权重筛出高影响条目，只对首次出现者主动提醒
    const pi = n => (n.policyImportance != null ? n.policyImportance : (n.importance || 0));
    const policyAlerts = (latest.news.items || [])
      .filter(n => n.policyAlert && pi(n) >= 84)
      .sort((a, b) => pi(b) - pi(a) || (b.publishedAt || 0) - (a.publishedAt || 0))
      .slice(0, 6)
      .map(n => ({
        id: n.id, title: n.title, source: n.source || n.feed || '',
        time: n.publishedText || null, importance: pi(n),
        category: n.category || null,
        hits: (n.policyHits || []).map(h => h.w).slice(0, 4)
      }));
    const fresh = policyAlerts.filter(n => !lastPolicyAlertIds.has(n.id));
    for (const n of fresh) lastPolicyAlertIds.add(n.id);
    if (lastPolicyAlertIds.size > 400) lastPolicyAlertIds = new Set([...lastPolicyAlertIds].slice(-250));
    broadcast('news', { ...latest.news, policyAlerts, freshPolicyAlerts: fresh });
    // 宏观事件分类与避险温度随新闻流更新（纯计算，签名去重）
    rebuildSignals();
    // 翻译与解读异步进行：先让界面拿到原文，中文与分析结果稍后自动补齐
    runAnalysis(false).catch(e => console.warn('[analysis]', e.message));
  } catch (e) {
    console.error('[news] 采集异常:', e.message);
  } finally {
    newsBusy = false;
  }
}

/* ------------------------------- 新闻中文化与解读 ------------------------------- */

async function runAnalysis(force) {
  if (analysisBusy || !config.analysis.enabled || !latest.news.items.length) return;
  // 出现未翻译的新英文条目时提前重算（译文有缓存，成本很低），但至少间隔 30 秒防止抖动
  const pending = config.analysis.autoTranslate
    ? latest.news.items.some(n => n.lang !== 'zh' && !n.titleZh) : false;
  const minGap = Math.max(30, config.analysis.refreshSec || 180) * 1000;
  const elapsed = Date.now() - (lastAnalysisAt || 0);
  if (!force && lastAnalysisAt && elapsed < minGap && !(pending && elapsed > 30000)) return;
  analysisBusy = true;
  try {
    const items = latest.news.items;
    let tr = {};
    if (config.analysis.autoTranslate) {
      tr = await translate.translateNews(items, { descLimit: config.analysis.translateDescLimit });
    } else {
      for (const n of items) {
        tr[n.id] = {
          titleZh: n.lang === 'zh' ? n.title : null, descZh: null,
          engine: n.lang === 'zh' ? 'native' : 'original'
        };
      }
    }

    const brief = analysis.buildBriefing({ ...latest.news, items }, tr, latest.quotes, { now: Date.now() });
    const analyzed = new Map(brief.items.map(x => [x.id, x]));
    latest.news.items = items.map(n => {
      const t = tr[n.id] || {};
      const a = analyzed.get(n.id);
      const base = {
        ...n,
        titleZh: t.titleZh || null,
        descZh: t.descZh || null,
        translation: t.engine || (n.lang === 'zh' ? 'native' : 'original'),
        displayTitle: t.titleZh || n.title
      };
      if (!a) return base;
      return {
        ...base,
        sentiment: a.sentiment, sentimentLabel: a.sentimentLabel, sentimentHits: a.sentimentHits, relevance: a.relevance,
        topics: a.topics, primaryTopic: a.primaryTopic,
        directions: a.directions, importance: a.importance, insight: a.insight
      };
    });
    latest.analysis = brief;
    lastAnalysisAt = Date.now();
    broadcast('news', latest.news);
    broadcast('analysis', brief);
    console.log('[analysis] 解读完成 | 新闻 ' + brief.counts.total + ' 条 | 译文 ' +
      brief.counts.translated + ' 条 | 风险温度 ' + brief.riskTemperature);
    // 消息面变化后，事件板块倾向、避险温度与观察池行业联动分都需要重算（内部签名去重）
    rebuildSignals();
  } finally {
    analysisBusy = false;
  }
}

/* ------------------------------- 当日观察池 ------------------------------- */

function isTradingNow() {
  const d = new Date(Date.now() + 8 * 3600000);
  const day = d.getUTCDay(), hhmm = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (day === 0 || day === 6) return false;
  return (hhmm >= 570 && hhmm <= 690) || (hhmm >= 780 && hhmm <= 900);
}

/** 新闻内容指纹：译文补齐、情绪/重要度变化都会改变它，从而触发观察池重评分 */
function newsFingerprint(items) {
  return (items || []).slice(0, 80).map(n =>
    n.id + ':' + (n.sentiment === undefined ? '' : n.sentiment) + ':' +
    (n.importance === undefined ? '' : n.importance) + ':' + (n.titleZh ? 1 : 0)
  ).join('|');
}

/* ------------------------------- 公司事件 / 宏观状态 ------------------------------- */

function eventOpts() {
  const c = config.events || {};
  return {
    alertEnabled: c.alertEnabled !== false,
    leaderCapYi: c.leaderCapYi,
    lookbackDays: c.lookbackDays,
    maxAdjust: c.maxAdjust,
    volumeThresholdYi: c.volumeThresholdYi,
    riskOffEnabled: c.riskOffEnabled,
    macroMaxAdjust: c.macroMaxAdjust
  };
}

/** 即时告警：只推「本轮新出现」的重点事件，冷启动先建立基线，避免历史公告一次性刷屏 */
function pushEventAlerts(view) {
  if (!config.events.alertEnabled || !view || !Array.isArray(view.items)) return;
  const rank = { critical: 3, warning: 2, info: 1 };
  const candidates = view.items.filter(e => e.alert)
    .sort((a, b) => (rank[b.alert.level] || 0) - (rank[a.alert.level] || 0) || b.ts - a.ts);
  if (!eventAlertBaselineSet) {
    for (const e of view.items) seenEventAlerts.add(e.id);
    eventAlertBaselineSet = true;
    // 冷启动不补推历史积压，但把「当前仍在有效期内」的龙头超预期业绩汇总成一条提示，
    // 让用户立刻知道事件监测已生效（此后新事件按级别即时提醒）。
    const leaders = view.items.filter(e => e.type === 'earnings' && e.isBeat && e.isLeader);
    if (leaders.length) {
      pushAlerts([makeAlert({
        level: 'info', category: 'event', rule: 'event-baseline-summary',
        title: '事件监测已启动 · 龙头业绩超预期 ' + leaders.length + ' 家',
        message: leaders.slice(0, 3).map(e => e.name + '（' + e.beatLevel + '，净利同比中值 ' +
          (e.amp > 0 ? '+' : '') + Number(e.amp || 0).toFixed(1) + '%）').join('；') +
          '。此后新出现的重点事件将即时声音 + 消息提醒。',
        source: '东方财富 · 业绩预告 / 快报', silent: inQuietHours(config, Date.now()),
        link: leaders[0].link || null
      })]);
    }
    console.log('[events] 已建立事件告警基线（' + seenEventAlerts.size + ' 条历史事件不补推）');
    return;
  }
  const fresh = candidates.filter(e => !seenEventAlerts.has(e.id));
  for (const e of fresh) seenEventAlerts.add(e.id);
  if (seenEventAlerts.size > 4000) {
    const arr = Array.from(seenEventAlerts);
    seenEventAlerts.clear();
    arr.slice(-2000).forEach(x => seenEventAlerts.add(x));
  }
  // 每轮最多 5 条：龙头超预期业绩优先，其余进入告警中心但不会连响
  const chosen = fresh.slice(0, 5);
  if (!chosen.length) return;
  const silent = inQuietHours(config, Date.now());
  pushAlerts(chosen.map(e => makeAlert({ ...e.alert, now: Date.now(), silent })));
  console.log('[events] 新事件提醒 ' + chosen.length + ' 条' +
    (fresh.length > chosen.length ? '（另有 ' + (fresh.length - chosen.length) + ' 条按限流未推声音）' : ''));
}

/**
 * 纯计算重建事件视图与宏观状态（不访问网络），因此行情 / 新闻 / 解读每次变化都能近实时反映。
 * 只有签名变化才广播并触发观察池轻量重评分。
 */
function rebuildSignals(opts = {}) {
  if (signalBusy || !config.events.enabled) return null;
  signalBusy = true;
  try {
    const o = eventOpts();
    const view = latest.eventRaw ? events.buildEventView(latest.eventRaw, {
      news: { items: latest.news.items },
      briefing: latest.analysis, style: latest.style,
      market: latest.market, quotes: latest.quotes, opts: o
    }) : null;
    const macro = events.buildMacroRegime({
      style: latest.style, briefing: latest.analysis,
      market: latest.market, quotes: latest.quotes, opts: o
    });
    const viewChanged = !!view && view.signature !== lastEventSignature;
    const macroChanged = macro.signature !== lastMacroSignature;
    if (view) { latest.events = view; lastEventSignature = view.signature; }
    latest.macro = macro; lastMacroSignature = macro.signature;
    if (viewChanged) broadcast('events', view);
    if (macroChanged) broadcast('macro', macro);
    if (viewChanged || macroChanged) {
      console.log('[events] 事件 ' + (view ? view.counts.total : 0) + ' 条 | 重点 ' +
        (view ? view.counts.focus : 0) + ' | 超预期 ' + (view ? view.counts.earningsBeats : 0) +
        ' | 龙头超预期 ' + (view ? view.counts.leaderBeats : 0) +
        ' || ' + macro.volume.regime + ' | 避险 ' + macro.riskOff.score + '/100');
      if (viewChanged) pushEventAlerts(view);
      if (config.stocks.enabled && !opts.skipStocks) {
        runStocks(false).catch(e => console.warn('[stocks]', e.message));
      }
    }
    return { view, macro, viewChanged, macroChanged };
  } catch (e) {
    console.warn('[events] 信号重建失败: ' + e.message);
    return null;
  } finally { signalBusy = false; }
}

/** 事件材料采集（较慢，按 refreshMin 节流）；采集后重建信号 */
async function runEvents(force) {
  if (eventsBusy || !config.events.enabled) return null;
  eventsBusy = true;
  try {
    const raw = await events.refreshRawEvents({
      force: !!force, trading: isTradingNow(),
      refreshMin: config.events.refreshMin,
      lookbackDays: config.events.lookbackDays
    });
    latest.eventRaw = raw;
    return rebuildSignals();
  } catch (e) {
    console.warn('[events] 事件采集失败: ' + e.message);
    return null;
  } finally { eventsBusy = false; }
}

/**
 * 评分有效性自检：补算到期快照的前瞻收益 → 重建 Rank IC 报告 → 推送前端。
 * 无到期样本时只重建聚合（纯读盘，几乎无成本）。
 */
async function runIC(force) {
  if (icBusy || !(config.ic || {}).enabled) return null;
  icBusy = true;
  try {
    const rep = force ? ic.getReport(config.ic, false) : await ic.tick(config.ic);
    if (force) ic.appendLesson(rep);
    latest.ic = rep;
    broadcast('ic', rep);
    const h5 = (rep.horizons || []).find(x => x.h === 5) || {};
    console.log('[ic] 自检 | 快照 ' + rep.status.snapshots + ' 天 | 标注 ' + rep.status.labeled +
      ' 条 | T+5 IC ' + (h5.mean ?? '—') + ' | ' + rep.verdict.level);
    return rep;
  } catch (e) {
    console.warn('[ic] 自检失败: ' + e.message);
    return null;
  } finally { icBusy = false; }
}

/**
 * 大盘量能 / 市值风格独立刷新。风格签名变化（或首次产出）时推送给前端，
 * 并触发观察池的轻量重评分——风格分已纳入 contextSignature，无需重拉个股日线。
 */
async function refreshStyleAndStocks(force) {
  if (!config.marketStyle.enabled) return null;
  if (stylePromise) return stylePromise;
  stylePromise = (async () => {
    try {
      const prev = latest.style && latest.style.signature;
      const st = await marketStyle.getMarketStyle({
        force: !!force, trading: isTradingNow(),
        refreshMin: config.marketStyle.refreshMin,
        breadthEnabled: config.marketStyle.breadthEnabled
      });
      latest.style = st;
      if (st.signature !== prev) {
        broadcast('style', st);
        console.log('[style] ' + st.dominantLabel + ' | 置信度 ' + st.confidence +
          ' | 两市 ' + (st.volume ? st.volume.state : '--') + ' | ' + (st.tradingDate || '--'));
        // 单位资金弹性与量能分档依赖风格数据，先刷新宏观视图再重评分
        rebuildSignals({ skipStocks: true });
        if (config.stocks.enabled) runStocks(false).catch(e => console.warn('[stocks]', e.message));
      }
      return st;
    } catch (e) {
      console.warn('[style] 量能风格计算失败: ' + e.message);
      return null;
    }
  })();
  try { return await stylePromise; } finally { stylePromise = null; }
}

/** 观察池计算前确保风格数据可用：优先内存 → 落盘缓存 → 现算 */
async function ensureStyle() {
  if (latest.style) return latest.style;
  const cached = marketStyle.loadCached();
  if (cached && cached.ok) { latest.style = cached; return cached; }
  await refreshStyleAndStocks(true);
  return latest.style;
}

/**
 * 涨停池 / 炸板池 / 跌停池刷新。
 * 交易时段按 limitUp.refreshMin（默认 3 分钟）刷新——封板时间、封单额、开板次数盘中持续变化；
 * 非交易时段且当日缓存已就绪时直接复用，不发请求（涨停池收盘后不再变化）。
 * 涨停池一变就触发观察池轻量重评分，使板型/封单/开板次数即时反映到排序。
 */
async function runLimitUp(force) {
  if (limitBusy || !config.limitUp || config.limitUp.enabled === false) return latest.limitup;
  limitBusy = true;
  try {
    const bjYmd = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
    const cached = limitup.readCache();
    const cachedToday = cached && String(cached.date) === bjYmd;
    if (!force && cachedToday && !isTradingNow()) {
      const ageMin = (Date.now() - (cached.fetchedAt || 0)) / 60000;
      if (ageMin >= 1) {
        latest.limitRaw = cached;
        if (!latest.limitContext) latest.limitContext = limitup.toContext(cached);
        if (!latest.limitup) latest.limitup = limitup.buildView(cached);
        return latest.limitup;
      }
    }
    const pools = await limitup.fetchPools();
    if (!pools.ok) {
      console.warn('[limitup] 涨停池为空或不可达: ' + (pools.warnings.join('; ') || '无数据'));
      return latest.limitup;
    }
    pools.fetchedAt = Date.now();
    limitup.writeCache(pools);
    latest.limitRaw = pools;
    latest.limitContext = limitup.toContext(pools);
    latest.limitup = limitup.buildView(pools);
    broadcast('limitup', latest.limitup);
    const s = latest.limitup.sentiment;
    console.log('[limitup] 涨停 ' + s.ztCount + ' / 跌停 ' + s.dtCount + ' / 炸板 ' + s.zbCount +
      '（炸板率 ' + s.zbRate + '%）| 情绪 ' + s.stage + ' | 最高 ' + s.maxBoards + ' 板');
    // 结构因子随封板/开板变化 → 触发观察池重评分（复用日线缓存，无额外请求）
    if (config.stocks.enabled) runStocks(false).catch(e => console.warn('[stocks]', e.message));
    return latest.limitup;
  } catch (e) {
    console.warn('[limitup] 采集失败: ' + e.message);
    return latest.limitup;
  } finally {
    limitBusy = false;
  }
}

/* ------------------ 涨停 / 炸板「事实卡」（L0 确定性，不做因果） ------------------ */

/**
 * 只陈列可核验事实：涨停盘口 + 公告（带日期与原文链接）+ 新闻标题 + 规则关键词命中。
 * 刻意不接 LLM、不写「涨停原因」——归纳那一步最容易产生幻觉且无法逐条溯源。
 * 公告接口有限流，故串行抓取 + 6 小时缓存，只对涨停股定向抓，不做全市场扫描。
 */
async function runAttribution(force) {
  if (attributionBusy) return latest.attribution;
  if (!config.attribution || config.attribution.enabled === false) return latest.attribution;
  attributionBusy = true;
  try {
    if (!latest.attribution) latest.attribution = attribution.readCache();
    const v = await attribution.build({
      force: !!force,
      maxStocks: config.attribution.maxStocks || 30,
      gapMs: config.attribution.gapMs || 1300
    });
    latest.attribution = v;
    if (v && v.ok) {
      broadcast('attribution', v);
      console.log('[attribution] ' + v.date + ' 扫描 ' + v.coverage.scanned + ' 只 · 有素材 '
        + (v.coverage.scanned - v.coverage.none) + ' · 公告失败 ' + v.coverage.annErrors);
    }
    return v;
  } catch (e) {
    console.warn('[attribution] 构建失败: ' + e.message);
    if (!latest.attribution) {
      latest.attribution = {
        ok: false,
        error: e.message,
        builtAt: Date.now(),
        disclaimer: attribution.DISCLAIMER,
        items: [],
        coverage: { scanned: 0, withAnn: 0, withNews: 0, none: 0, annErrors: 0, pct: 0 }
      };
    }
    return latest.attribution;
  } finally {
    attributionBusy = false;
  }
}

/* ------------------ P0 技术因子（只读标注，不进评分） ------------------ */

/**
 * 八项确定性因子：复用 ic.fetchKline 的真实前复权日线，逐条可复算。
 * 纪律：构建失败时显式标「数据源不可达」，不编造任何因子值；
 *       SSE 广播结果，网络恢复后由定时器或手动刷新自动重算。
 */
async function runTechnical(force) {
  if (technicalBusy) return latest.technical;
  if (!config.technical || config.technical.enabled === false) return latest.technical;
  technicalBusy = true;
  try {
    if (!latest.technical) latest.technical = technical.readCache();
    const v = await technical.build({ force: !!force, quotes: Array.isArray(latest.quotes) ? latest.quotes : [] });
    latest.technical = v;
    broadcast('technical', v);
    const u = v.universe || {};
    console.log('[technical] ' + (v.date || '-') + ' 标的 ' + (u.count || 0) + ' 只 · 日线成功 '
      + (u.barsOk || 0) + ' / 失败 ' + (u.barsFail || 0));
    return v;
  } catch (e) {
    console.warn('[technical] 构建失败: ' + e.message);
    if (!latest.technical) {
      latest.technical = {
        ok: false, builtAt: Date.now(), error: e.message,
        universe: { count: 0, barsOk: 0, barsFail: 0 },
        breadth: null, industrySample: [], items: [], ruleStat: [], errors: [],
        disclaimer: ['技术因子构建失败：' + e.message, '未编造任何数值；网络恢复后点击刷新即可重算。']
      };
      broadcast('technical', latest.technical);
    }
    return latest.technical;
  } finally {
    technicalBusy = false;
  }
}

/* ====================================================================== */
/* 闭环四模块：经验库 / 周期事件 / 资金主体 / 避险识别                       */
/* ====================================================================== */

function bjNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return {
    date: d.toISOString().slice(0, 10),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    weekday: d.getUTCDay()
  };
}

let calMemo = { at: 0, set: null };
async function isTradingDay(dateStr) {
  try {
    if (!calMemo.set || Date.now() - calMemo.at > 3600000) {
      const cal = await ic.tradingCalendar();
      calMemo = { at: Date.now(), set: new Set(cal), last: cal.length ? cal[cal.length - 1] : null };
    }
    if (calMemo.set.has(dateStr)) return true;
    // 【关键修复】日历来自上证指数历史日K，只覆盖到最后一个「已收盘」的交易日。
    // 任何交易日的早晨，当日都不在日历里（当日日K要到收盘后才存在）——
    // 若直接返回 false，开盘档定格永远不会触发。对「日历末尾之后」的日期
    // （= 今天与未来）按周一至周五推定为交易日：法定节假日会误判，
    // 但定格幂等去重、复盘按真实下一交易日对齐，代价可控且远小于漏定格。
    if (calMemo.last && dateStr > calMemo.last) {
      // 用北京时间正午取星期（00:00+08:00 换算成 UTC 会落到前一天，星期会错位）
      const d = new Date(dateStr + 'T12:00:00+08:00');
      const wd = d.getUTCDay();
      return wd >= 1 && wd <= 5;
    }
    return false;
  } catch (_) { return true; } // 日历不可用时按交易日处理，宁可多定格一次（幂等去重会挡住重复）
}

/** 观察池定格用的上下文元数据（情绪阶段 / 量能 / 风格 / 避险温度） */
function journalMeta() {
  const s = (latest.limitup && latest.limitup.sentiment) || {};
  const st = latest.style || {};
  const mc = latest.macro || {};
  // 外围市况存证：美股三大指数（早盘=隔夜收盘）+ 亚太指数（恒生盘前无报价自动缺省，不编数）
  const overseas = (latest.quotes || [])
    .filter(q => q.group === 'overseas' && q.changePct !== null && q.changePct !== undefined)
    .map(q => ({ id: q.id, short: q.short || q.name, changePct: q.changePct, value: q.value }));
  return {
    sentimentStage: s.stage || null,
    sentimentFactor: s.factor != null ? s.factor : null,
    volumeYi: mc.amountYi != null ? mc.amountYi : (st.volumeYi != null ? st.volumeYi : null),
    volumeRegime: mc.regime || null,
    styleDominant: st.dominant || null,
    marketRegime: (latest.market && latest.market.regime) || null,
    riskOffScore: mc.riskOffScore != null ? mc.riskOffScore : null,
    overseas: overseas.length ? overseas : null
  };
}

/**
 * 经验库编排（每分钟检查一次，幂等）：
 *   09:05 定格开盘档（含外围市况：美股隔夜 + 亚太早盘）→ 15:10 起复盘 → 22:00 定格收盘档（美股盘中）→ 22:05 归纳经验。
 * 定格必须用「当时的观察池」：若内存里的名单超过 3 小时（如周末后首日）则先强制重算一次。
 */
async function runJournalTick() {
  if (journalBusy || !config.journal || config.journal.enabled === false) return;
  journalBusy = true;
  try {
    const bj = bjNow();
    const jcfg = config.journal || {};
    const openMin = parseHm(jcfg.openTime, 9 * 60);
    const eveMin = parseHm(jcfg.eveTime, 22 * 60);
    const reviewMin = parseHm(jcfg.reviewTime, 15 * 60 + 10);

    if (await isTradingDay(bj.date)) {
      for (const kind of [['open', openMin, 9 * 60 + 25], ['eve', Math.max(eveMin, 15 * 60 + 5), 23 * 60 + 59]]) {
        const [k, from, to] = kind;
        // 定格有时效：开盘档必须在 09:25 集合竞价结束前取（那时报价仍是昨收），
        // 盘后启动的服务不允许补建开盘档——参考价会被当日盘中价格污染，复盘就失去意义。
        if (bj.minutes < from || bj.minutes > to) continue;
        if (journal.listPicks({ date: bj.date, kind: k, limit: 1 }).length) continue;
        if (!latest.stocks || !latest.stocks.items || !latest.stocks.items.length ||
            Date.now() - (latest.stocks.generatedAt || 0) > 3 * 3600000) {
          await runStocks(true);
        }
        if (!latest.stocks || !latest.stocks.items || !latest.stocks.items.length) continue; // 空名单宁可放弃本轮，绝不定格 0 只
        // 定格前确保叠加视图已生成（冷启动时 edge 可能还没跑），再注入形态标签
        if ((!latest.edge || !latest.edge.ok) && !edgeBusy) await runEdge(false);
        const r = journal.snapshot(withStack(latest.stocks.items), { kind: k, date: bj.date, ...journalMeta() });
        if (!r.exists) {
          console.log('[journal] ' + bj.date + ' ' + (k === 'open' ? '开盘前' : '收盘后') + '定格 ' + r.count + ' 只');
          latest.journal = journalView();
          broadcast('journal', latest.journal);
        }
      }

      // 实时观察池：交易时段内随评分滚动更新（与冻结定格互补，不作为复盘基准）。
      // 仅当内存里的名单「新鲜」（10 分钟内产出）才滚动，防止把陈旧评分盖上新时间戳。
      if (jcfg.liveEnabled !== false) {
        const inSession = (bj.minutes >= 9 * 60 + 25 && bj.minutes <= 11 * 60 + 35) ||
          (bj.minutes >= 13 * 60 && bj.minutes <= 15 * 60 + 5);
        const stocksFresh = latest.stocks && latest.stocks.items && latest.stocks.items.length &&
          Date.now() - (latest.stocks.generatedAt || 0) <= 10 * 60 * 1000;
        if (inSession && stocksFresh) {
          const r = journal.liveSnapshot(withStack(latest.stocks.items), {
            date: bj.date, limit: jcfg.liveLimit || 12, ...journalMeta()
          });
          if (r.changed) {
            latest.journal = journalView();
            broadcast('journal', latest.journal);
          }
        }
      }
    }

    // 复盘：收盘数据可用后回填 T+1 结果（每日一次即可，重复调用靠 outcomes 去重）
    if (bj.minutes >= reviewMin && !runJournalTick._reviewedOn) {
      const r = await journal.reviewPending();
      if (r.ok && r.reviewed) {
        console.log('[journal] 复盘回填 ' + r.reviewed + ' 条（待回填 ' + r.pending + '）');
        const l = journal.buildLessons();
        if (l.created) console.log('[journal] 新增待审经验 ' + l.created + ' 条');
      }
      runJournalTick._reviewedOn = bj.date;
      latest.journal = journalView();
      broadcast('journal', latest.journal);
    }
    if (runJournalTick._reviewedOn !== bj.date) runJournalTick._reviewedOn = null;

    if (!latest.journal) { latest.journal = journalView(); }
  } catch (e) {
    console.warn('[journal] ' + e.message);
  } finally {
    journalBusy = false;
  }
}

function parseHm(s, fallback) {
  if (typeof s === 'string' && /^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(':').map(Number);
    if (h >= 0 && h < 24 && m >= 0 && m < 60) return h * 60 + m;
  }
  return fallback;
}

function journalView() {
  const st = journal.status();
  return {
    ...st,
    live: journal.readLive(),
    latestPicks: journal.listPicks({ limit: 2 }),
    lessonsList: journal.listLessons({ limit: 40 }),
    rules: journal.readRules()
  };
}

/**
 * 持仓监控编排：每 30 秒刷新实时行情与建议，与观察池评分联动。
 * 告警去重：同一 (代码, 日期, 建议级别) 只推一次，避免止损位附近反复刷屏。
 */
const seenHoldAlerts = new Set();
async function runHoldings() {
  if (holdingsBusy) return latest.holdings;
  holdingsBusy = true;
  try {
    const v = await holdings.buildView(latest.stocks && latest.stocks.items);
    latest.holdings = v;
    broadcast('holdings', v);
    // 确定性告警：跌停(critical)与跌破止损(warning)才推入告警流，info 级只在面板展示
    const bj = bjNow();
    for (const p of (v.positions || [])) {
      for (const a of (p.advice || [])) {
        if (a.level !== 'critical' && a.level !== 'warning') continue;
        const key = p.code + ':' + bj.date + ':' + (a.level === 'critical' ? 'limitdown' : 'stop');
        if (seenHoldAlerts.has(key)) continue;
        seenHoldAlerts.add(key);
        pushAlerts([makeAlert({
          level: a.level, category: 'stock', rule: 'holding-' + (a.level === 'critical' ? 'limitdown' : 'stop'),
          instrument: p.code, instrumentName: p.name || p.code,
          title: '持仓提醒：' + (p.name || p.code),
          message: a.text,
          source: '持仓监控', silent: false
        })]);
      }
    }
    if (seenHoldAlerts.size > 500) {
      for (const k of seenHoldAlerts) if (!k.endsWith(bj.date)) seenHoldAlerts.delete(k);
    }
    return v;
  } catch (e) {
    console.warn('[holdings] ' + e.message);
    return latest.holdings;
  } finally {
    holdingsBusy = false;
  }
}

/** 周期事件研究：6 小时重建一次，或手动刷新 */
async function runCycle(force) {
  if (cycleBusy || !config.cycle || config.cycle.enabled === false) return latest.cyc;
  cycleBusy = true;
  try {
    const v = await cycle.buildCycleView({ force: !!force });
    if (v.ok) {
      latest.cyc = v;
      broadcast('cycle', v);
      // 临近的高置信事件推送到告警流（一次性，按 id 去重）
      if (config.cycle.alertEnabled !== false) {
        for (const a of (v.alerts || [])) {
          const key = 'cycle:' + a.name + ':' + a.date;
          if (seenEventAlerts.has(key)) continue;
          if (!eventAlertBaselineSet) { seenEventAlerts.add(key); continue; }
          seenEventAlerts.add(key);
          pushAlerts([{
            id: key, level: a.level === 'warn' ? 'warning' : 'info',
            title: '周期事件' + (a.level === 'warn' ? '·警惕兑现' : '临近'),
            message: a.text, at: Date.now(), source: '周期事件日历',
            kind: 'cycle'
          }]);
        }
      }
      console.log('[cycle] 事件 ' + v.counts.total + ' 个（完成 ' + v.counts.done + ' / 临近 ' + v.counts.upcoming + '），提前告知 ' + (v.alerts || []).length + ' 条');
    }
    return v;
  } catch (e) {
    console.warn('[cycle] ' + e.message);
    return latest.cyc;
  } finally {
    cycleBusy = false;
  }
}

/** 资金主体：增量回填一年龙虎榜 → 每日刷新近 3 天 → 重建视图 */
async function runFlow() {
  if (flowBusy || !config.flow || config.flow.enabled === false) return latest.flow;
  flowBusy = true;
  try {
    const st = flow.backfillStatus();
    if (!st.done) {
      await flow.backfillLhb(1); // 每轮一个 20 天窗口，一年约 19 轮
    } else {
      const bj = bjNow();
      if (flowRefreshDay !== bj.date && bj.minutes >= 10 * 60 + 30) {
        flowRefreshDay = bj.date;
        const r = await flow.refreshRecent();
        if (r && r.ok) console.log('[flow] 近 3 日增量 ' + (r.rows || 0) + ' 条席位记录');
      }
    }
    await flow.backfillMargin(2); // 两融：历史按月抽样缓慢补齐 + 最新一日
    latest.flow = await flow.getView(false, { volumeYi: (latest.macro || {}).amountYi });
    broadcast('flow', latest.flow);
    return latest.flow;
  } catch (e) {
    console.warn('[flow] ' + e.message);
    return latest.flow;
  } finally {
    flowBusy = false;
  }
}

/** 两融 5 日变化（供避险模块）：仅当存在连续日样本时计算，否则返回 null 而不是编数 */
function marginDelta() {
  try {
    const st = JSON.parse(require('node:fs').readFileSync(flow.STATE_FILE, 'utf8'));
    const keys = Object.keys(st.margin || {}).sort();
    const daily = keys.slice(-8).map(k => ({ d: k, rz: st.margin[k].rz }));
    if (daily.length < 2) return null;
    const last = daily[daily.length - 1];
    const prev = daily[daily.length - 2];
    if (!last || !prev || !Number.isFinite(last.rz) || !Number.isFinite(prev.rz)) return null;
    return { rzYi: last.rz, rz5d: Math.round((last.rz - prev.rz) * 100) / 100, asOf: last.d };
  } catch (_) { return null; }
}

/** 避险识别：10 分钟一次，量能与两融从现有模块传入（单一数据源原则） */
async function runRiskOff(force) {
  if (riskoffBusy || !config.riskoff || config.riskoff.enabled === false) return latest.riskoff;
  riskoffBusy = true;
  try {
    const mc = latest.macro || {};
    latest.riskoff = await riskoff.getRiskOff(!!force, {
      volumeYi: mc.amountYi != null ? mc.amountYi : undefined,
      volumePercentile: mc.percentile != null ? mc.percentile : undefined,
      marginTrend: marginDelta() || undefined
    });
    if (latest.riskoff && latest.riskoff.ok) broadcast('riskoff', latest.riskoff);
    return latest.riskoff;
  } catch (e) {
    console.warn('[riskoff] ' + e.message);
    return latest.riskoff;
  } finally {
    riskoffBusy = false;
  }
}

/**
 * 预期研究层统一编排（strength / valuation / phase / stack）。
 * 依赖关系：strength 是 valuation/stack 的输入；cycle 由 runCycle 独立维护，这里只读；
 * phase 拉 22 个板块日 K（6 小时缓存），valuation/stack 是纯计算（每次可重算）。
 * 任何一环失败不影响其它环，且绝不因「算不出」而编造数值。
 */
async function runEdge(force) {
  if (edgeBusy || !config.edge || config.edge.enabled === false) return latest.edge;
  edgeBusy = true;
  const ecfg = config.edge || {};
  try {
    // 板块抓取失败时不让整条 edge 链路崩掉：回退上次成功缓存，并显式标记 stale
    const strengthRaw = await strength.buildStrength({ force: !!force }).catch(e => {
      console.warn('[edge/strength] ' + e.message); return null;
    });
    let str = strengthRaw, staleFromCache = false, staleReason = '';
    if (!str || str.ok === false || !Array.isArray(str.boards)) {
      staleReason = (strengthRaw && strengthRaw.error) || '板块数据源不可达';
      try {
        const c = JSON.parse(fs.readFileSync(strength.CACHE_FILE, 'utf8'));
        if (c && c.ok && Array.isArray(c.boards) && c.boards.length) {
          str = Object.assign({}, c, { stale: true, staleReason });
          staleFromCache = true;
          console.warn('[edge/strength] ' + staleReason + '；回退上次成功缓存（' +
            c.boards.length + ' 板块，' + new Date(c.builtAt).toLocaleString('zh-CN') + '），标记 stale');
        }
      } catch (_) {}
      if (!str || str.ok === false || !Array.isArray(str.boards)) {
        // 连缓存都没有时给空壳，保证下游模块按「无数据」处理而不是抛异常
        str = { ok: false, stale: true, staleReason, error: staleReason, builtAt: Date.now(),
          boards: [], mainlines: [], leaders: [], laggards: [], categories: [], counts: { total: 0 } };
      }
    }
    const industries = ((latest.stocks && latest.stocks.items) || []).map(x => x.industry).filter(Boolean);
    const phRaw = await phase.buildPhase({ force: !!force, strength: str, industries }).catch(e => {
      console.warn('[edge/phase] ' + e.message); return null;
    });
    // 板块源不可达 / 沪深300 日线不足时，phase.buildPhase 会返回不带 counts 的失败对象。
    // 前端 app.js:renderEdge 无条件读 ph.counts.qualified，会抛 TypeError 并中断整个
    // renderAll()（后续所有面板不再渲染）。这里统一补一个全 0 的 counts 空壳：
    // 「无数据」按 0 展示，不编造任何数值，也不改前端一个字节。
    const ph = (phRaw && phRaw.counts) ? phRaw : Object.assign({
      ok: false, error: (phRaw && phRaw.error) || '板块价格周期数据不可用', builtAt: Date.now(),
      boards: [], qualified: [], stageAggregate: []
    }, phRaw || {}, {
      counts: { boards: 0, qualified: 0, samples: 0 }
    });
    const env = edgeEnv();
    const val = valuation.buildValuation({ events: latest.events, strength: str, env, limit: ecfg.valuationLimit || 30 });
    const ctx = {
      stocks: latest.stocks, events: latest.events, strength: str, valuation: val,
      phase: ph, cycle: latest.cyc, flow: latest.flow, riskoff: latest.riskoff,
      style: latest.style, quotes: latest.quotes
    };
    const stk = stack.buildStack({ ctx });

    const cnt = (o, k) => (o && o.counts && Number.isFinite(o.counts[k]) ? o.counts[k] : 0);
    latest.edge = {
      ok: true, builtAt: Date.now(),
      stale: staleFromCache || !!str.stale,
      staleReason: staleReason || str.staleReason || null,
      strength: str, valuation: val, phase: ph,
      cycle: latest.cyc ? { boardPhase: latest.cyc.boardPhase || [], boardAlerts: latest.cyc.boardAlerts || [] } : null,
      stack: stk,
      counts: {
        boards: cnt(str, 'total'),
        mainlines: (str && Array.isArray(str.mainlines)) ? str.mainlines.length : 0,
        valuations: cnt(val, 'total'),
        phaseBoards: cnt(ph, 'boards'),
        phaseQualified: cnt(ph, 'qualified'),
        stackResonance: cnt(stk, 'resonance'),
        stackDivergence: cnt(stk, 'divergence')
      },
      notes: [
        '预期研究层与评分引擎解耦：不修改任何评分或修正项',
        '叠加形态只写入经验库定格存证，由复盘统计裁决是否真有超额',
        ...(staleFromCache ? ['板块数据源不可达：当前展示上次成功缓存（stale，' +
          new Date(str.builtAt).toLocaleString('zh-CN') + '），数据可能过期，恢复后自动重算'] : [])
      ]
    };
    broadcast('edge', latest.edge);
    console.log('[edge] 板块 ' + latest.edge.counts.boards + ' | 主线 ' + latest.edge.counts.mainlines +
      ' | 重估候选 ' + latest.edge.counts.valuations + ' | 阶段结论 ' + latest.edge.counts.phaseQualified +
      ' | 共振 ' + latest.edge.counts.stackResonance + ' / 分歧 ' + latest.edge.counts.stackDivergence +
      (staleFromCache ? ' | [stale 缓存回退]' : ''));
    return latest.edge;
  } catch (e) {
    console.warn('[edge] ' + e.message);
    return latest.edge;
  } finally {
    edgeBusy = false;
  }
}

/** 市值重估用的外部环境快照：全部取自系统已有实时模块，不额外造数 */
function edgeEnv() {
  const mc = latest.macro || {};
  const s = (latest.limitup && latest.limitup.sentiment) || {};
  const qs = (latest.quotes || []).filter(q => q.group === 'overseas' && q.changePct != null);
  const us = qs.filter(q => /道琼斯|标普|纳斯达克/.test(q.short || ''));
  const overseasEquity = us.length >= 2
    ? Math.round(us.reduce((a, b) => a + b.changePct, 0) / us.length * 100) / 100 : null;
  return {
    sentimentStage: s.stage || null,
    volumeYi: mc.amountYi != null ? mc.amountYi : ((latest.style && latest.style.volume && latest.style.volume.totalAmountYi) || null),
    volumeRegime: mc.volume && mc.volume.regime ? mc.volume.regime : null,
    volumeThresholdYi: (config.events || {}).volumeThresholdYi || 25000,
    riskOffScore: mc.riskOff && mc.riskOff.score != null ? mc.riskOff.score : mc.riskOffScore,
    riskOffLevel: mc.riskOff && mc.riskOff.level ? mc.riskOff.level : null,
    overseasEquity
  };
}

/** 评分变化后只重算叠加（纯计算，不重复拉 K 线），保持 edge.stack 与观察池同步 */
function refreshStackOnly() {
  if (!latest.edge || !latest.edge.ok) return;
  const e = latest.edge;
  const ctx = {
    stocks: latest.stocks, events: latest.events, strength: e.strength, valuation: e.valuation,
    phase: e.phase, cycle: latest.cyc, flow: latest.flow, riskoff: latest.riskoff,
    style: latest.style, quotes: latest.quotes
  };
  e.stack = stack.buildStack({ ctx });
  e.builtAt = Date.now();
  e.counts.stackResonance = e.stack.counts.resonance;
  e.counts.stackDivergence = e.stack.counts.divergence;
  broadcast('edge', e);
}

/** 定格 / 实时池前，把叠加形态注入观察池条目（供 journal 存证与复盘分组） */
function withStack(items) {
  const rows = (latest.edge && latest.edge.stack && latest.edge.stack.items) || [];
  if (!rows.length) return items;
  const map = new Map(rows.map(r => [r.code, r]));
  return (items || []).map(it => {
    const s = map.get(it.code);
    if (!s) return it;
    return {
      ...it,
      stackForm: s.form, stackLabel: s.label, stackFingerprint: s.fingerprint,
      stackPos: s.posCount, stackNeg: s.negCount
    };
  });
}

async function runStocks(force) {
  if (stocksBusy || !config.stocks.enabled) return;
  stocksBusy = true;
  try {
    const trading = isTradingNow();
    if (config.marketStyle.enabled) await ensureStyle();
    let att = null;
    if (config.attention.enabled) {
      try {
        att = await attention.fetchAttention({
          force: !!force, refreshMin: config.attention.refreshMin, trading
        });
      } catch (e) {
        console.warn('[attention] 热榜采集失败: ' + e.message);
      }
    }
    latest.attention = att;
    const mc = attention.buildMarketContext(latest.quotes);
    latest.market = mc;

    // 个股中文资讯：先按上一轮观察池取一次，拿到内容指纹用于判断是否需要重评分
    const cachedCodes = ((latest.stocks && latest.stocks.items) || []).map(x => x.code);
    let sn = null;
    if (config.attention.enabled && cachedCodes.length) {
      try {
        sn = await attention.fetchStockNews(cachedCodes, { force: !!force, trading, refreshMin: 10 });
        latest.stockNews = sn;
      } catch (e) { console.warn('[attention] 个股资讯采集失败: ' + e.message); }
    }

    // sentiment 用异步回调：按「本轮实际入选标的」取个股资讯并计算舆情，避免候选池变化对不上号
    const ctx = {
      briefing: latest.analysis,
      attention: att,
      sentiment: async list => {
        let merged = null;
        if (config.attention.enabled) {
          try {
            merged = await attention.fetchStockNews(list.map(x => x.code), { trading, refreshMin: 10 });
            latest.stockNews = merged;
          } catch (e) { console.warn('[attention] 个股资讯补取失败: ' + e.message); }
        }
        return attention.buildStockSentiment(
          latest.news.items, list, att, merged ? merged.items : (sn ? sn.items : null), Date.now()
        );
      },
      market: mc,
      style: latest.style,
      maxStyleAdjust: config.marketStyle.maxAdjust,
      events: latest.events,
      macro: latest.macro,
      limit: latest.limitContext,
      maxEventAdjust: (config.events || {}).maxAdjust,
      macroMaxAdjust: (config.events || {}).macroMaxAdjust,
      maxTotalAdjust: (config.events || {}).maxTotalAdjust,
      eventLookbackDays: (config.events || {}).lookbackDays,
      valueTrapEnabled: (config.stocks || {}).valueTrapEnabled !== false,
      stageWeights: (config.stocks || {}).stageWeights !== false,
      maxLimitAdjust: (config.limitUp || {}).maxAdjust,
      news: latest.news.items,
      newsFingerprint: newsFingerprint(latest.news.items),
      stockNewsFingerprint: sn ? sn.fingerprint : ''
    };
    const r = await stocks.analyzeStocks(ctx, {
      force: !!force, maxStocks: config.stocks.maxStocks,
      refreshMin: config.stocks.refreshMin
    });
    const same = latest.stocks && r.fromCache && latest.stocks.generatedAt === r.generatedAt;
    latest.stocks = r;
    refreshStackOnly(); // 叠加指纹随最新评分重算（纯计算）
    if (same) return; // 缓存未变化时不重复推送
    broadcast('stocks', r);
    // 评分定格：仅在配置的时点窗口内、且非轻量重评分时写入，作为 IC 自检的样本
    try {
      const rec = ic.record(r, config.ic || {});
      if (rec.recorded) {
        latest.ic = ic.getReport(config.ic || {}, false);
        broadcast('ic', latest.ic);
      }
    } catch (e) { console.warn('[ic] 定格失败: ' + e.message); }
    console.log('[stocks] 观察池 | ' + tradingLabel(r) + ' | ' + (r.rescoreOnly ? '轻量重评分' : '全量重算') +
      ' | ' + r.items.length + ' 只 | 重点关注 ' + r.summary.focus +
      ' | 热度覆盖 ' + r.summary.heatCovered + ' | 舆情覆盖 ' + r.summary.sentimentCovered +
      ' | 外围 ' + mc.regime + (r.fromCache ? '（缓存）' : ''));
  } catch (e) {
    console.warn('[stocks] 计算失败: ' + e.message);
    if (latest.stocks) {
      latest.stocks = { ...latest.stocks, lastError: e.message };
      broadcast('stocks', latest.stocks);
    } else {
      latest.stocks = { error: e.message, generatedAt: Date.now(), items: [] };
      broadcast('stocks', latest.stocks);
    }
  } finally {
    stocksBusy = false;
  }
}

function tradingLabel(r) {
  return r.tradingDate ? r.tradingDate + (r.isTrading ? ' 盘中' : ' 收盘') : '日期未知';
}

function persistState() {
  try {
    saveState({
      history,
      seenNews: Array.from(runtime.seenNews).slice(-600),
      lastQuoteAt: runtime.lastQuoteSuccessAt,
      lastNewsAt: runtime.lastNewsAt
    });
  } catch (e) { console.error('[state] 保存失败:', e.message); }
}

/* --------------------- 事件感知层观察者（公告增量，零 LLM） --------------------- */

/** 观察者只发现自选池公告增量并写入 events-feed.jsonl；解读属智能体层（Step 2），此处永不解读。
 *  挂掉、观察池为空、接口失败都不影响主服务——失败只记警告。 */
async function runWatchers() {
  if (watchersBusy) return { ok: true, skipped: 'busy' };
  watchersBusy = true;
  try {
    const r = await watchers.runOnce();
    latest.watchers = watchers.status();
    if (r.added) {
      broadcast('watchers', latest.watchers);
      // 公告有增量 → 触发 A1 解读（异步不阻塞观察者；失败只记警告）
      runAgentA1().catch(e => console.warn('[agent-a1]', e.message));
    }
    return r;
  } catch (e) {
    console.warn('[watchers]', e.message);
    return { ok: false, error: e.message };
  } finally { watchersBusy = false; }
}

/* --------------------- 智能体薄适配器（Step 2：A1 公告解读 + A4 复盘简报） --------------------- */

/** A1：解读观察者新增的公告增量。agent.js 内部自带节流与单轮上限，失败不影响主服务。 */
async function runAgentA1() {
  if (agentBusy) return { ok: true, skipped: 'busy' };
  agentBusy = true;
  try {
    const r = await agent.interpretPending(config);
    if (r && r.interpreted) console.log('[agent-a1] 解读公告 ' + r.interpreted + ' 条（利空 ' + r.flagged + ' 条已分流 Flag）');
    return r;
  } catch (e) {
    console.warn('[agent-a1]', e.message);
    return { ok: false, error: e.message };
  } finally { agentBusy = false; }
}

/** A4 统计摘要的通用裁剪：只保留数字/短字符串/浅层结构（自动脱敏 + 控制输入大小）。
 *  数字全部来自确定性计算（latest.* 缓存），模型只负责组织语言与提假说。 */
function digestStat(v, depth) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 90 ? v.slice(0, 90) + '…' : v;
  if (Array.isArray(v)) return { count: v.length, items: v.slice(0, 4).map(x => digestStat(x, depth - 1)) };
  if (typeof v === 'object' && depth > 0) {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 24)) out[k] = digestStat(x, depth - 1);
    return out;
  }
  return null;
}

/** A4 统计收集：按信息优先级装箱，总预算约 9000 字符（LLM 输入防超限 + 控成本）。
 *  优先级：市场风格 > 涨停结构 > 周期 > 避险 > 事件 > 资金 > 股池（细节最多、价值最低）。 */
function collectA4Stats() {
  const order = ['marketStyle', 'limitUp', 'cycle', 'riskoff', 'events', 'flow', 'stocks'];
  const src = {
    marketStyle: latest.style, limitUp: latest.limitup, cycle: latest.cyc,
    riskoff: latest.riskoff, events: latest.events, flow: latest.flow, stocks: latest.stocks
  };
  const out = {};
  let budget = 9000;
  for (const k of order) {
    const v = src[k];
    if (!v) continue;
    const d = digestStat(v, 2);
    if (!d || !Object.keys(d).length) continue;
    const s = JSON.stringify(d);
    if (s.length <= budget) { out[k] = d; budget -= s.length; }
    /* 超预算的数据面直接丢弃（低优先级在后，丢的是细节最多的） */
  }
  return out;
}

let a4Attempts = { date: '', n: 0 }; // A4 当日尝试次数（防失败重试烧钱，上限 3 次）

/** A4：22:00 定时 / 手动触发复盘简报（人话日报 + 假说卡，每交易日一次） */
async function runAgentA4(force) {
  try {
    const r = await agent.makeBrief(config, collectA4Stats(), { force: !!force });
    if (r && r.ok && !r.skipped) console.log('[agent-a4] 生成简报 ' + r.briefId + '（假说卡 ' + r.hypotheses + ' 张）');
    else console.warn('[agent-a4] 未生成:', (r && (r.skipped || r.error)) || '未知原因');
    return r;
  } catch (e) {
    console.warn('[agent-a4]', e.message);
    return { ok: false, error: e.message };
  }
}

function reschedule() {
  clearTimeout(quoteTimer);
  clearTimeout(newsTimer);
  clearInterval(stocksTimer);
  clearInterval(styleTimer);
  clearInterval(eventsTimer);
  clearInterval(limitTimer);
  clearInterval(watchersTimer);
  clearInterval(agentTimer);
  quoteTimer = setTimeout(async function loopQuote() {
    await doQuoteTick();
    quoteTimer = setTimeout(loopQuote, Math.max(5, config.quoteIntervalSec) * 1000);
  }, Math.max(5, config.quoteIntervalSec) * 1000);
  newsTimer = setTimeout(async function loopNews() {
    await doNewsTick();
    newsTimer = setTimeout(loopNews, Math.max(20, config.newsIntervalSec) * 1000);
  }, Math.max(20, config.newsIntervalSec) * 1000);
  stocksTimer = setInterval(() => {
    if (config.stocks.enabled) runStocks(false).catch(e => console.warn('[stocks]', e.message));
  }, Math.max(1, config.stocks.refreshMin) * 60000);
  styleTimer = setInterval(() => {
    refreshStyleAndStocks(false).catch(e => console.warn('[style]', e.message));
  }, Math.max(1, config.marketStyle.refreshMin) * 60000);
  eventsTimer = setInterval(() => {
    runEvents(false).catch(e => console.warn('[events]', e.message));
  }, Math.max(1, config.events.refreshMin) * 60000);
  limitTimer = setInterval(() => {
    runLimitUp(false).catch(e => console.warn('[limitup]', e.message));
  }, Math.max(1, (config.limitUp || {}).refreshMin || 3) * 60000);
  icTimer = setInterval(() => {
    runIC(false).catch(e => console.warn('[ic]', e.message));
  }, 10 * 60000);
  journalTimer = setInterval(() => {
    runJournalTick().catch(e => console.warn('[journal]', e.message));
  }, 60 * 1000);
  cycleTimer = setInterval(() => {
    runCycle(false).catch(e => console.warn('[cycle]', e.message));
  }, Math.max(30, (config.cycle || {}).refreshMin || 360) * 60000);
  flowTimer = setInterval(() => {
    runFlow().catch(e => console.warn('[flow]', e.message));
  }, Math.max(2, (config.flow || {}).refreshMin || 5) * 60000);
  riskoffTimer = setInterval(() => {
    runRiskOff(false).catch(e => console.warn('[riskoff]', e.message));
  }, 10 * 60000);
  holdingsTimer = setInterval(() => {
    runHoldings().catch(e => console.warn('[holdings]', e.message));
  }, 30 * 1000);
  edgeTimer = setInterval(() => {
    runEdge(false).catch(e => console.warn('[edge]', e.message));
  }, Math.max(2, (config.edge || {}).refreshMin || 10) * 60000);
  /* 事实卡：启动后延迟 90 秒首次构建（避开启动时的行情/评分高峰），之后按 refreshMin 重建。
     内部有 6 小时缓存，同一交易日重复调用会直接命中缓存、不发请求。 */
  setTimeout(() => {
    runAttribution(false).catch(e => console.warn('[attribution]', e.message));
  }, 90 * 1000);
  attributionTimer = setInterval(() => {
    runAttribution(false).catch(e => console.warn('[attribution]', e.message));
  }, Math.max(30, (config.attribution || {}).refreshMin || 360) * 60000);
  /* P0 技术因子：启动后延迟 100 秒首次构建（避开行情/评分高峰），
     内部有 30 分钟缓存，同一时段重复调用直接命中缓存、不发请求。 */
  setTimeout(() => {
    runTechnical(false).catch(e => console.warn('[technical]', e.message));
  }, 100 * 1000);
  technicalTimer = setInterval(() => {
    runTechnical(false).catch(e => console.warn('[technical]', e.message));
  }, Math.max(10, (config.technical || {}).refreshMin || 30) * 60000);
  /* 事件感知观察者：启动后延迟 110 秒首轮（首轮只建立已见基线、不写流水，防止历史倒灌），
     之后每 10 分钟增量检测自选池公告。删除 data/journal/watch-last.json 可强制重建基线。 */
  setTimeout(() => { runWatchers().catch(e => console.warn('[watchers]', e.message)); }, 110 * 1000);
  watchersTimer = setInterval(() => {
    runWatchers().catch(e => console.warn('[watchers]', e.message));
  }, Math.max(5, (config.watchers || {}).refreshMin || 10) * 60000);
  /* A4 复盘简报：每分钟检查一次时间窗（默认 22:00 后、当日未生成、尝试未超限）。
     A1 不需要独立定时器——观察者每轮新增公告后自动触发（runWatchers 内）。 */
  agentTimer = setInterval(() => {
    try {
      const acfg = (config.agent || {});
      if (!acfg.enabled || !((acfg.a4 || {}).enabled)) return;
      const now = new Date(Date.now() + 8 * 3600e3);
      const hm = now.toISOString().slice(11, 16);
      const date = now.toISOString().slice(0, 10);
      const hour = (acfg.a4 || {}).hour || '22:00';
      if (hm < hour || hm > '23:59') return;                 // 只在窗口内触发（启动晚也能补）
      if (a4Attempts.date !== date) a4Attempts = { date, n: 0 };
      if (a4Attempts.n >= 3) return;                          // 当日失败重试上限
      a4Attempts.n++;
      runAgentA4(false).catch(e => console.warn('[agent-a4]', e.message));
    } catch (_) { /* 定时器永不抛出 */ }
  }, 60 * 1000);
}

/* ------------------------------- 配置校验 ------------------------------- */

function clamp(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function nullableNumber(v) {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sanitizeConfig(c) {
  const out = structuredClone(c);
  out.agent = out.agent || {};
  out.agent.temperature = clamp(out.agent.temperature, 0, 2, 0.3);
  out.agent.maxTokens = clamp(out.agent.maxTokens, 256, 8192, 1600);
  out.quoteIntervalSec = clamp(out.quoteIntervalSec, 5, 600, 15);
  out.newsIntervalSec = clamp(out.newsIntervalSec, 20, 900, 60);
  out.cooldownSec = clamp(out.cooldownSec, 10, 3600, 300);
  out.staleAfterSec = clamp(out.staleAfterSec, 60, 3600, 180);
  out.sound = out.sound || {};
  out.sound.volume = clamp(out.sound.volume, 0, 1, 0.55);
  out.sound.minLevel = ['info', 'warning', 'critical'].includes(out.sound.minLevel) ? out.sound.minLevel : 'warning';
  out.notification = out.notification || {};
  out.notification.minLevel = ['info', 'warning', 'critical'].includes(out.notification.minLevel) ? out.notification.minLevel : 'critical';
  out.newsAlert = out.newsAlert || {};
  out.newsAlert.keywords = Array.isArray(out.newsAlert.keywords)
    ? out.newsAlert.keywords.map(String).map(s => s.trim()).filter(Boolean).slice(0, 200)
    : [...sources.NEWS_KEYWORDS.critical, ...sources.NEWS_KEYWORDS.warning];
  out.analysis = out.analysis || {};
  out.analysis.enabled = out.analysis.enabled !== false;
  out.analysis.autoTranslate = out.analysis.autoTranslate !== false;
  out.analysis.translateDescLimit = clamp(out.analysis.translateDescLimit, 0, 120, 40);
  out.analysis.refreshSec = clamp(out.analysis.refreshSec, 30, 1800, 180);
  out.stocks = out.stocks || {};
  out.stocks.enabled = out.stocks.enabled !== false;
  out.stocks.maxStocks = clamp(out.stocks.maxStocks, 8, 30, 18);
  out.stocks.refreshMin = clamp(out.stocks.refreshMin, 1, 240, 15);
  out.attention = out.attention || {};
  out.attention.enabled = out.attention.enabled !== false;
  out.attention.refreshMin = clamp(out.attention.refreshMin, 1, 240, 5);
  out.marketStyle = out.marketStyle || {};
  out.marketStyle.enabled = out.marketStyle.enabled !== false;
  out.marketStyle.refreshMin = clamp(out.marketStyle.refreshMin, 1, 240, 5);
  out.marketStyle.breadthEnabled = out.marketStyle.breadthEnabled !== false;
  out.marketStyle.maxAdjust = clamp(out.marketStyle.maxAdjust, 0, 20, 12);
  out.events = out.events || {};
  out.events.enabled = out.events.enabled !== false;
  out.events.refreshMin = clamp(out.events.refreshMin, 1, 240, 5);
  out.events.lookbackDays = clamp(out.events.lookbackDays, 3, 60, 14);
  out.events.alertEnabled = out.events.alertEnabled !== false;
  out.events.maxAdjust = clamp(out.events.maxAdjust, 0, 24, 12);
  out.events.volumeThresholdYi = clamp(out.events.volumeThresholdYi, 5000, 100000, 25000);
  out.events.leaderCapYi = clamp(out.events.leaderCapYi, 100, 3000, 500);
  out.events.riskOffEnabled = out.events.riskOffEnabled !== false;
  out.events.macroMaxAdjust = clamp(out.events.macroMaxAdjust, 0, 20, 10);
  out.events.maxTotalAdjust = clamp(out.events.maxTotalAdjust, 0, 40, 22);
  out.limitUp = out.limitUp || {};
  out.limitUp.enabled = out.limitUp.enabled !== false;
  out.limitUp.refreshMin = clamp(out.limitUp.refreshMin, 1, 120, 3);
  out.limitUp.maxAdjust = clamp(out.limitUp.maxAdjust, 0, 20, 12);
  out.limitUp.cycleEnabled = out.limitUp.cycleEnabled !== false;
  out.journal = out.journal || {};
  out.journal.enabled = out.journal.enabled !== false;
  out.journal.openTime = typeof out.journal.openTime === 'string' ? out.journal.openTime : '09:05';
  out.journal.eveTime = typeof out.journal.eveTime === 'string' ? out.journal.eveTime : '22:00';
  out.journal.reviewTime = typeof out.journal.reviewTime === 'string' ? out.journal.reviewTime : '15:10';
  out.journal.liveEnabled = out.journal.liveEnabled !== false;
  out.journal.liveLimit = Number.isFinite(+out.journal.liveLimit) ? Math.min(30, Math.max(6, Math.round(+out.journal.liveLimit))) : 12;
  out.cycle = out.cycle || {};
  out.cycle.enabled = out.cycle.enabled !== false;
  out.cycle.refreshMin = clamp(out.cycle.refreshMin, 30, 1440, 360);
  out.cycle.alertEnabled = out.cycle.alertEnabled !== false;
  out.flow = out.flow || {};
  out.flow.enabled = out.flow.enabled !== false;
  out.flow.refreshMin = clamp(out.flow.refreshMin, 2, 120, 5);
  out.flow.hfSeatMin = clamp(out.flow.hfSeatMin, 5, 100, 20);
  out.riskoff = out.riskoff || {};
  out.riskoff.enabled = out.riskoff.enabled !== false;
  out.edge = out.edge || {};
  out.edge.enabled = out.edge.enabled !== false;
  out.edge.refreshMin = clamp(out.edge.refreshMin, 2, 240, 10);
  out.edge.valuationLimit = clamp(out.edge.valuationLimit, 5, 100, 30);
  out.ic = out.ic || {};
  out.ic.enabled = out.ic.enabled !== false;
  out.ic.rollDays = clamp(out.ic.rollDays, 5, 120, 20);
  out.ic.minDays = clamp(out.ic.minDays, 3, 60, 5);
  out.ic.keepDays = clamp(out.ic.keepDays, 60, 1000, 400);
  out.ic.maxLabelsPerTick = clamp(out.ic.maxLabelsPerTick, 10, 200, 60);
  out.ic.horizons = Array.isArray(out.ic.horizons)
    ? [...new Set(out.ic.horizons.map(Number).filter(n => n >= 1 && n <= 30))].sort((a, b) => a - b).slice(0, 6)
    : [1, 3, 5, 10];
  if (!out.ic.horizons.length) out.ic.horizons = [1, 3, 5, 10];
  out.ic.snapshots = Array.isArray(out.ic.snapshots)
    ? out.ic.snapshots.filter(k => ['am', 'pm', 'close'].includes(k))
    : ['pm'];
  if (!out.ic.snapshots.length) out.ic.snapshots = ['pm'];
  out.stocks.valueTrapEnabled = out.stocks.valueTrapEnabled !== false;
  out.stocks.stageWeights = out.stocks.stageWeights !== false;
  out.rules = out.rules || {};
  for (const [id, r] of Object.entries(out.rules)) {
    if (!r || typeof r !== 'object') { delete out.rules[id]; continue; }
    for (const k of ['upper', 'lower', 'movePct', 'dayPct', 'moveBp', 'dayBp']) {
      r[k] = nullableNumber(r[k]);
      if (r[k] !== null && (k === 'movePct' || k === 'dayPct' || k === 'moveBp' || k === 'dayBp')) {
        r[k] = clamp(r[k], 0.01, 1000, null);
      }
    }
    r.enabled = r.enabled !== false;
  }
  return out;
}

/* ------------------------------- HTTP ------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStatic(pathname, res) {
  // v2：新简洁外壳为主入口；旧完整面板保留在 /legacy
  let rel;
  if (pathname === '/') rel = 'v2/index.html';
  else if (pathname === '/legacy') rel = 'index.html';
  else rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

function readBody(req) {
  // 缓存已解析的 body 到 req 上：主 POST 块与 v2 路由可能都调用本函数，
  // 第二次必须直接返回，否则流已被消费、'end' 不再触发 → 请求永久挂起。
  if (req.__parsedBody) return Promise.resolve(req.__parsedBody);
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => {
      s += c;
      if (s.length > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      let out = {};
      if (s.trim()) {
        try { out = JSON.parse(s); } catch (e) { return reject(new Error('JSON 格式错误')); }
      }
      req.__parsedBody = out;
      resolve(out);
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://' + HOST).pathname; }
  catch (_) { return sendJson(res, 400, { ok: false, error: 'bad url' }); }

  if (req.method === 'GET' && pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    res.write('event: snapshot\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/snapshot') return sendJson(res, 200, { ok: true, data: snapshot() });
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      uptimeSec: Math.round((Date.now() - latest.startedAt) / 1000),
      quotes: latest.quotes.length, news: latest.news.items.length,
      health: latest.health, sseClients: sseClients.size,
      quoteFetchedAt: latest.quoteFetchedAt,
      analysis: latest.analysis ? { news: latest.analysis.counts.total, translated: latest.analysis.counts.translated, risk: latest.analysis.riskTemperature } : null,
      stocks: latest.stocks ? {
        items: (latest.stocks.items || []).length, date: latest.stocks.tradingDate,
        fromCache: !!latest.stocks.fromCache, rescoreOnly: !!latest.stocks.rescoreOnly,
        heatCovered: latest.stocks.summary && latest.stocks.summary.heatCovered,
        sentimentCovered: latest.stocks.summary && latest.stocks.summary.sentimentCovered
      } : null,
      attention: latest.attention ? { ok: latest.attention.ok, poolSize: latest.attention.poolSize, stale: !!latest.attention.stale } : null,
      market: latest.market ? { regime: latest.market.regime, score: latest.market.score } : null,
      style: latest.style ? {
        ok: !!latest.style.ok, date: latest.style.tradingDate,
        dominant: latest.style.dominantLabel, confidence: latest.style.confidence,
        volumeState: latest.style.volume && latest.style.volume.state,
        volumeYi: latest.style.volume && latest.style.volume.totalAmountYi,
        buckets: (latest.style.buckets || []).length,
        breadthCoverage: latest.style.volume && latest.style.volume.breadth && latest.style.volume.breadth.coverage
      } : null,
      styleCovered: latest.stocks && latest.stocks.summary ? latest.stocks.summary.styleCovered : null,
      events: latest.events ? {
        total: latest.events.counts.total, focus: latest.events.counts.focus,
        beats: latest.events.counts.earningsBeats, leaderBeats: latest.events.counts.leaderBeats,
        alerts: latest.events.counts.alerts, macroEvents: latest.events.counts.macro
      } : null,
      macro: latest.macro ? {
        regime: latest.macro.volume.regime, amountYi: latest.macro.volume.amountYi,
        thresholdYi: latest.macro.volume.thresholdYi, percentile: latest.macro.volume.percentile,
        riskOff: latest.macro.riskOff.score, riskOffLevel: latest.macro.riskOff.level
      } : null,
      limitup: latest.limitup ? {
        date: latest.limitup.date,
        limitUp: latest.limitup.counts.limitUp,
        failed: latest.limitup.counts.failed,
        limitDown: latest.limitup.counts.limitDown,
        stage: latest.limitup.sentiment.stage,
        maxBoards: latest.limitup.sentiment.maxBoards,
        zbRate: latest.limitup.sentiment.zbRate
      } : null,
      ic: latest.ic ? {
        snapshots: latest.ic.status.snapshots, labeled: latest.ic.status.labeled,
        lastSnapshot: latest.ic.status.lastSnapshot,
        rankIC5: (latest.ic.horizons.find(x => x.h === 5) || {}).mean,
        verdict: latest.ic.verdict.level
      } : null,
      journal: latest.journal ? {
        picks: latest.journal.picks, outcomes: latest.journal.outcomes,
        pending: latest.journal.lessons && latest.journal.lessons.pending,
        rules: latest.journal.rules && latest.journal.rules.count
      } : null,
      holdings: latest.holdings ? { count: latest.holdings.count } : null,
      cycle: latest.cyc ? { total: latest.cyc.counts.total, alerts: (latest.cyc.alerts || []).length } : null,
      flow: latest.flow ? { days: latest.flow.coverage.days, tilt: latest.flow.tilt.top } : null,
      riskoff: latest.riskoff ? { form: latest.riskoff.form, score: latest.riskoff.score } : null,
      edge: latest.edge ? {
        boards: latest.edge.counts.boards, mainlines: latest.edge.counts.mainlines,
        valuations: latest.edge.counts.valuations, phaseQualified: latest.edge.counts.phaseQualified,
        resonance: latest.edge.counts.stackResonance, divergence: latest.edge.counts.stackDivergence
      } : null
    });
  }
  if (req.method === 'GET' && pathname === '/api/alerts') return sendJson(res, 200, { ok: true, data: alerts.slice(-300) });
  if (req.method === 'GET' && pathname === '/api/analysis') return sendJson(res, 200, { ok: true, data: latest.analysis });
  if (req.method === 'GET' && pathname === '/api/stocks') return sendJson(res, 200, { ok: true, data: latest.stocks });
  if (req.method === 'GET' && pathname === '/api/style') return sendJson(res, 200, { ok: true, data: latest.style });
  if (req.method === 'GET' && pathname === '/api/events') return sendJson(res, 200, { ok: true, data: latest.events });
  if (req.method === 'GET' && pathname === '/api/macro') return sendJson(res, 200, { ok: true, data: latest.macro });
  if (req.method === 'GET' && pathname === '/api/limitup') return sendJson(res, 200, { ok: true, data: latest.limitup });
  if (req.method === 'GET' && pathname === '/api/journal') return sendJson(res, 200, { ok: true, data: latest.journal || journalView() });
  if (req.method === 'GET' && pathname === '/api/journal/live') return sendJson(res, 200, { ok: true, data: journal.readLive() });
  if (req.method === 'GET' && pathname === '/api/watchers') {
    // 事件感知层：观察者状态 + 最近 50 条公告增量流水（只读）
    return sendJson(res, 200, { ok: true, data: watchers.status(), feed: watchers.readFeed({ limit: 50 }) });
  }
  if (req.method === 'GET' && pathname === '/api/agent') {
    // 智能体薄适配器状态（密钥只回显掩码）
    return sendJson(res, 200, { ok: true, data: agent.status(config) });
  }
  if (req.method === 'GET' && pathname === '/api/agent/brief') {
    return sendJson(res, 200, { ok: true, data: agent.readBriefs({ limit: 10 }) });
  }
  if (req.method === 'GET' && pathname === '/api/holdings') {
    if (!latest.holdings) runHoldings().catch(() => {});
    return sendJson(res, 200, { ok: true, data: latest.holdings || { ok: true, count: 0, positions: [], summary: null, note: '刷新中' } });
  }
  if (req.method === 'GET' && pathname === '/api/journal/picks') {
    const u = new URL(req.url, 'http://x');
    return sendJson(res, 200, { ok: true, data: journal.listPicks({ date: u.searchParams.get('date') || undefined, kind: u.searchParams.get('kind') || undefined, limit: 30 }) });
  }
  if (req.method === 'GET' && pathname === '/api/journal/outcomes') {
    return sendJson(res, 200, { ok: true, data: journal.listOutcomes({ days: 90 }) });
  }
  if (req.method === 'GET' && pathname === '/api/cycle') return sendJson(res, 200, { ok: true, data: latest.cyc });
  if (req.method === 'GET' && pathname === '/api/flow') return sendJson(res, 200, { ok: true, data: latest.flow });
  if (req.method === 'GET' && pathname === '/api/riskoff') return sendJson(res, 200, { ok: true, data: latest.riskoff });
  if (req.method === 'GET' && pathname === '/api/edge') return sendJson(res, 200, { ok: true, data: latest.edge });
  if (req.method === 'GET' && pathname === '/api/attribution') {
    return sendJson(res, 200, { ok: true, data: latest.attribution || attribution.readCache() });
  }
  if (req.method === 'GET' && pathname === '/api/technical') {
    return sendJson(res, 200, { ok: true, data: latest.technical || technical.readCache() });
  }
  if (req.method === 'GET' && pathname === '/api/mypicks') {
    return sendJson(res, 200, { ok: true, data: mypicks.view() });
  }
  if (req.method === 'GET' && pathname === '/api/stock/lookup') {
    // 代码识别：输入 6 位代码实时查名称/现价（腾讯行情，VPN 下可用），只读、不写清单
    const code = (new URL(req.url, 'http://x').searchParams.get('code') || '').trim();
    return sendJson(res, 200, await emtx.lookupCode(code));
  }
  if (req.method === 'GET' && pathname === '/api/edge/strength') return sendJson(res, 200, { ok: true, data: latest.edge && latest.edge.strength });
  if (req.method === 'GET' && pathname === '/api/edge/valuation') return sendJson(res, 200, { ok: true, data: latest.edge && latest.edge.valuation });
  if (req.method === 'GET' && pathname === '/api/edge/phase') return sendJson(res, 200, { ok: true, data: latest.edge && latest.edge.phase });
  if (req.method === 'GET' && pathname === '/api/edge/stack') return sendJson(res, 200, { ok: true, data: latest.edge && latest.edge.stack });
  if (req.method === 'GET' && pathname === '/api/ic') return sendJson(res, 200, { ok: true, data: latest.ic || ic.getReport(config.ic || {}) });
  if (req.method === 'GET' && pathname === '/api/ic/lessons') {
    return sendJson(res, 200, { ok: true, data: { markdown: ic.readLessons(), status: ic.status() } });
  }
  if (req.method === 'GET' && pathname === '/api/attention') {
    const sn = latest.stockNews;
    return sendJson(res, 200, {
      ok: true,
      data: {
        attention: latest.attention,
        market: latest.market,
        stockNews: sn ? {
          generatedAt: sn.generatedAt, requested: sn.requested, refreshed: sn.refreshed,
          failures: sn.failures, stale: sn.stale, fingerprint: sn.fingerprint,
          covered: Object.values(sn.items || {}).filter(a => a.length).length,
          note: sn.note
        } : null
      }
    });
  }
  if (req.method === 'GET' && pathname === '/api/config') return sendJson(res, 200, { ok: true, data: publicConfig() });

  if (req.method === 'POST') {
    try {
      const body = await readBody(req);

      if (pathname === '/api/config') {
        // 前端回显的是掩码；若用户未修改 Key（或误提交掩码），不要把它写回配置
        const patch = structuredClone(body);
        if (patch.agent && typeof patch.agent.apiKey === 'string' && patch.agent.apiKey.includes('****')) {
          delete patch.agent.apiKey;
        }
        config = sanitizeConfig(deepMerge(config, patch));
        saveConfig(config);
        broadcast('config', publicConfig());
        reschedule();
        console.log('[config] 配置已更新');
        return sendJson(res, 200, { ok: true, data: publicConfig() });
      }
      if (pathname === '/api/reset') {
        config = sanitizeConfig(structuredClone(DEFAULT_CONFIG));
        saveConfig(config);
        broadcast('config', publicConfig());
        reschedule();
        console.log('[config] 已恢复默认设置');
        return sendJson(res, 200, { ok: true, data: publicConfig() });
      }
      if (pathname === '/api/test-alert') {
        const level = ['info', 'warning', 'critical'].includes(body.level) ? body.level : 'critical';
        const a = makeTestAlert(level);
        pushAlerts([a]);
        return sendJson(res, 200, { ok: true, data: a });
      }
      if (pathname === '/api/ack') {
        if (body.all === true) alerts.forEach(a => { a.ack = true; });
        else { const a = alerts.find(x => x.id === body.id); if (a) a.ack = true; }
        broadcast('ack', { all: body.all === true, id: body.id || null });
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/clear') {
        alerts = [];
        broadcast('clear', {});
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/refresh') {
        // 涨停池先拉：观察池的结构因子依赖它，且它会顺带触发一次轻量重评分
        runLimitUp(true).catch(e => console.warn('[limitup]', e.message));
        doQuoteTick(); doNewsTick();
        runAnalysis(true).catch(e => console.warn('[analysis]', e.message));
        refreshStyleAndStocks(true).catch(e => console.warn('[style]', e.message));
        runEvents(true).catch(e => console.warn('[events]', e.message));
        runStocks(true).catch(e => console.warn('[stocks]', e.message));
        runIC(false).catch(e => console.warn('[ic]', e.message));
        return sendJson(res, 200, { ok: true, message: '已触发立即刷新（含涨停池、新闻解读、事件采集、观察池与 IC 自检）' });
      }
      if (pathname === '/api/analysis/refresh') {
        runAnalysis(true).catch(e => console.warn('[analysis]', e.message));
        return sendJson(res, 200, { ok: true, message: '已重新翻译并生成新闻解读' });
      }
      if (pathname === '/api/stocks/refresh') {
        runStocks(true).catch(e => console.warn('[stocks]', e.message));
        return sendJson(res, 200, { ok: true, message: '已重新计算当日观察池' });
      }
      if (pathname === '/api/style/refresh') {
        refreshStyleAndStocks(true).catch(e => console.warn('[style]', e.message));
        return sendJson(res, 200, { ok: true, message: '已重新检测大盘量能与市值风格，并触发观察池重评分' });
      }
      if (pathname === '/api/events/refresh') {
        runEvents(true).catch(e => console.warn('[events]', e.message));
        return sendJson(res, 200, { ok: true, message: '已重新采集公告、业绩预告与快报，并重建事件与宏观状态' });
      }
      if (pathname === '/api/watchers/refresh') {
        runWatchers().catch(e => console.warn('[watchers]', e.message));
        return sendJson(res, 200, { ok: true, message: '观察者已触发一轮公告增量检测（后台执行，首轮只建基线）' });
      }
      if (pathname === '/api/agent/interpret') {
        // A1 公告解读：手动触发一轮（后台执行），解读 events-feed 中未解读行
        runAgentA1().catch(e => console.warn('[agent-a1]', e.message));
        return sendJson(res, 200, { ok: true, message: 'A1 公告解读已在后台执行（单轮最多 ' + (((config.agent || {}).a1 || {}).maxPerRun || 4) + ' 条）' });
      }
      if (pathname === '/api/agent/brief') {
        // A4 复盘简报：手动触发（force 覆盖当日幂等），需统计缓存就绪
        runAgentA4(true).catch(e => console.warn('[agent-a4]', e.message));
        return sendJson(res, 200, { ok: true, message: 'A4 复盘简报已在后台生成（统计缓存未就绪时会跳过，稍后重试或先刷新各数据面）' });
      }
      if (pathname === '/api/agent/test') {
        // DeepSeek 连通性测试（一次最小调用，真实计费约 10 tokens）
        const r = await agent.testConnection(config);
        return sendJson(res, 200, { ok: r.ok, data: r.ok ? { model: r.model, reply: r.data } : r });
      }
      if (pathname === '/api/limitup/refresh') {
        runLimitUp(true).catch(e => console.warn('[limitup]', e.message));
        return sendJson(res, 200, { ok: true, message: '已重新采集涨停 / 炸板 / 跌停池并重建情绪周期' });
      }
      if (pathname === '/api/journal/review') {
        journal.reviewPending().then(r => {
          const l = journal.buildLessons();
          latest.journal = journalView();
          broadcast('journal', latest.journal);
          console.log('[journal] 手动复盘 ' + (r.reviewed || 0) + ' 条，新经验 ' + (l.created || 0) + ' 条');
        }).catch(e => console.warn('[journal]', e.message));
        return sendJson(res, 200, { ok: true, message: '复盘已在后台执行（回填 T+1 结果并归纳经验）' });
      }
      if (pathname === '/api/journal/audit') {
        const r = journal.auditLesson(body.id, body.action, { note: body.note });
        if (r.ok) {
          latest.journal = journalView();
          broadcast('journal', latest.journal);
        }
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      if (pathname === '/api/journal/snapshot') {
        // 手动定格（幂等）。body.date 可选：仅允许补建「过去的交易日」，且只允许 eve 档，
        // 用当前已定格的收盘数据补建，note 标注「补建」以便复盘时识别；
        // 不允许补 open 档（参考价会被盘中价格污染），不允许补未来日期。
        (async () => {
          if (!latest.stocks || !latest.stocks.items) await runStocks(true);
          if ((!latest.edge || !latest.edge.ok) && !edgeBusy) await runEdge(false);
          if (latest.stocks && latest.stocks.items) {
            const bj = bjNow();
            const bjHhmm = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 16);
            const wantDate = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
            const kind = body.kind === 'open' ? 'open' : 'eve';
            let date = bj.date, note = null;
            if (wantDate && wantDate < bj.date) {
              if (!(await isTradingDay(wantDate))) {
                return sendJson(res, 400, { ok: false, error: '补建日期不是交易日: ' + wantDate });
              }
              if (kind === 'open') {
                return sendJson(res, 400, { ok: false, error: '不允许补建开盘档：参考价会被盘中价格污染，复盘失去意义' });
              }
              date = wantDate;
              note = '补建定格（于 ' + bj.date + ' ' + bjHhmm + ' 用已收盘数据补建，非当日实时冻结）';
            }
            const meta = journalMeta();
            if (note) meta.note = note;
            const r = journal.snapshot(withStack(latest.stocks.items), { kind, date, ...meta });
            latest.journal = journalView();
            broadcast('journal', latest.journal);
            console.log('[journal] 手动定格 ' + date + ' ' + kind + ' ' + r.count + ' 只（' + (r.exists ? '已存在' : '新建') + '）');
          }
        })().catch(e => console.warn('[journal]', e.message));
        return sendJson(res, 200, { ok: true, message: '定格任务已提交' });
      }
      if (pathname === '/api/journal/live') {
        // 手动刷新实时观察池（非交易时段也可看最新一次结果，但不重算）
        (async () => {
          if (!latest.stocks || !latest.stocks.items || Date.now() - (latest.stocks.generatedAt || 0) > 10 * 60 * 1000) {
            await runStocks(true);
          }
          if (latest.stocks && latest.stocks.items) {
            const jcfg = config.journal || {};
            const r = journal.liveSnapshot(latest.stocks.items, { limit: jcfg.liveLimit || 12, ...journalMeta() });
            latest.journal = journalView();
            broadcast('journal', latest.journal);
            console.log('[journal] 实时观察池刷新 ' + r.count + ' 只（新进 ' + r.added + ' / 移出 ' + r.removed + '）');
          }
        })().catch(e => console.warn('[journal]', e.message));
        return sendJson(res, 200, { ok: true, message: '实时观察池刷新中' });
      }
      if (pathname === '/api/cycle/refresh') {
        runCycle(true).catch(e => console.warn('[cycle]', e.message));
        return sendJson(res, 200, { ok: true, message: '周期事件研究重建中（约 10 秒）' });
      }
      if (pathname === '/api/cycle/event') {
        const r = cycle.addCalendarEvent(body);
        if (r.ok) runCycle(true).catch(() => {});
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      if (pathname === '/api/flow/refresh') {
        runFlow().catch(e => console.warn('[flow]', e.message));
        return sendJson(res, 200, { ok: true, data: flow.backfillStatus(), message: '资金主体数据增量更新中' });
      }
      if (pathname === '/api/riskoff/refresh') {
        runRiskOff(true).catch(e => console.warn('[riskoff]', e.message));
        return sendJson(res, 200, { ok: true, message: '避险识别重建中' });
      }
      if (pathname === '/api/edge/refresh') {
        runEdge(true).catch(e => console.warn('[edge]', e.message));
        return sendJson(res, 200, { ok: true, message: '预期研究层重建中（板块日 K 与阶段统计约需 10-20 秒）' });
      }
      if (pathname === '/api/holdings') {
        const r = holdings.upsert(body);
        if (r.ok) {
          runHoldings().catch(e => console.warn('[holdings]', e.message));
          console.log('[holdings] 录入/更新持仓 ' + body.code + '（共 ' + r.positions + ' 只）');
        }
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      if (pathname === '/api/holdings/delete') {
        const r = holdings.remove(body.code);
        if (r.ok) {
          runHoldings().catch(e => console.warn('[holdings]', e.message));
          console.log('[holdings] 删除持仓 ' + body.code + '（剩 ' + r.positions + ' 只）');
        }
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      if (pathname === '/api/holdings/refresh') {
        runHoldings().catch(e => console.warn('[holdings]', e.message));
        return sendJson(res, 200, { ok: true, message: '持仓行情刷新中' });
      }
      if (pathname === '/api/ic/rebuild') {
        // 先补标注（会拉日线，较慢），再重建报告；放后台执行，立即返回
        runIC(false).catch(e => console.warn('[ic]', e.message));
        return sendJson(res, 200, { ok: true, message: '已开始补算前瞻收益并重建 IC 自检报告' });
      }
      if (pathname === '/api/attribution/refresh') {
        // 公告抓取串行 + 限速，全量约 40~70 秒；放后台执行，立即返回
        runAttribution(true).catch(e => console.warn('[attribution]', e.message));
        return sendJson(res, 200, { ok: true, message: '已开始抓取涨停股公告事实，约需 40~70 秒' });
      }
      if (pathname === '/api/technical/refresh') {
        // 关注池定向拉日线（≤14 只 × 限速），约 5~15 秒；放后台执行，立即返回
        runTechnical(true).catch(e => console.warn('[technical]', e.message));
        return sendJson(res, 200, { ok: true, message: '已开始重算 P0 技术因子，约需 5~15 秒' });
      }
      if (pathname === '/api/mypicks/add') {
        const r = mypicks.add(body);
        return sendJson(res, r.ok ? 200 : 400, r);
      }
      if (pathname === '/api/mypicks/remove') {
        return sendJson(res, 200, mypicks.remove(body));
      }
      if (pathname === '/api/mypicks/clear') {
        return sendJson(res, 200, mypicks.clear());
      }
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  /* ======================== v2 新外壳 API ======================== */
  // —— 核心智能体（Hermes 贯穿）——
  if (req.method === 'GET' && pathname === '/api/v2/hermes/status') return sendJson(res, 200, await hermes.status(config));
  // 个股分析：常规量化评分 + 技术指标解释层（不改 stocks.js 原评分）
  if (req.method === 'GET' && pathname === '/api/v2/stock/analysis') {
    const u = new URL(req.url, 'http://' + HOST);
    const code = u.searchParams.get('code') || '';
    const force = u.searchParams.get('force') === '1';
    try {
      const r = await stockAnalysis.analyzeOne(code, { latest: snapshot(), force });
      return sendJson(res, r.ok ? 200 : 400, r);
    } catch (e) { return sendJson(res, 502, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/stock/analysis/status') {
    return sendJson(res, 200, { ok: true, data: stockAnalysis.status() });
  }
  // 对话历史：读取 conversations.jsonl 的最近 N 轮；UI 清空用时间戳过滤，不删除原始经验流
  const CHAT_FILE = path.join(__dirname, '..', 'data', 'journal', 'conversations.jsonl');
  const CHAT_UI_STATE = path.join(__dirname, '..', 'data', 'journal', 'chat-ui-state.json');
  function chatUiState() {
    try { if (fs.existsSync(CHAT_UI_STATE)) return JSON.parse(fs.readFileSync(CHAT_UI_STATE, 'utf8')); } catch (_) {}
    return { clearedAt: null };
  }
  function chatHistory(limit) {
    const state = chatUiState();
    const clearedAt = state.clearedAt ? Date.parse(state.clearedAt) : 0;
    if (!fs.existsSync(CHAT_FILE)) return [];
    const rows = fs.readFileSync(CHAT_FILE, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(r => r && r.question && r.answer && (!clearedAt || (Date.parse(r.ts) || 0) > clearedAt))
      .slice(-Math.max(1, Math.min(40, limit || 12)));
    const items = [];
    for (const r of rows) {
      items.push({ role: 'user', content: r.question, ts: r.ts || null, module: r.module || null });
      items.push({ role: 'assistant', content: r.answer, ts: r.ts || null, module: r.module || null, backend: r.backend || null });
    }
    return items;
  }
  if (req.method === 'GET' && pathname === '/api/v2/chat/history') {
    const limit = Number(new URL(req.url, 'http://' + HOST).searchParams.get('limit') || 12);
    const items = chatHistory(limit);
    return sendJson(res, 200, { ok: true, items, count: items.length, clearedAt: chatUiState().clearedAt });
  }
  if (req.method === 'POST' && pathname === '/api/v2/chat/clear') {
    try {
      const b = await readBody(req);
      const sid = String(b.sessionId || '').trim() || chatStore.getCurrentId();
      const cleared = sid ? chatStore.clearSession(sid) : { ok: false, error: '无当前会话' };
      fs.mkdirSync(path.dirname(CHAT_UI_STATE), { recursive: true });
      const state = { clearedAt: new Date().toISOString(), sessionId: sid };
      fs.writeFileSync(CHAT_UI_STATE, JSON.stringify(state, null, 2), 'utf8');
      return sendJson(res, 200, { ok: true, ...state, cleared });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  /* ---- 多会话：列表 / 新建 / 打开 / 重命名 / 删除 / 搜索 / 当前会话 ---- */
  if (req.method === 'GET' && pathname === '/api/v2/chat/sessions') {
    const items = chatStore.listSessions();
    return sendJson(res, 200, { ok: true, items, count: items.length, currentId: chatStore.getCurrentId(), support: !!chatStore.status().ok });
  }
  if (req.method === 'POST' && pathname === '/api/v2/chat/sessions') {
    try {
      const b = await readBody(req);
      const s = chatStore.createSession(b.title);
      return s ? sendJson(res, 200, { ok: true, session: s }) : sendJson(res, 400, { ok: false, error: '创建会话失败' });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/chat/sessions/current') {
    const id = chatStore.getCurrentId();
    return sendJson(res, 200, { ok: true, id, session: chatStore.getSession(id) });
  }
  if (req.method === 'POST' && pathname === '/api/v2/chat/sessions/current') {
    try {
      const b = await readBody(req);
      const id = String(b.sessionId || '');
      if (!chatStore.getSession(id)) return sendJson(res, 400, { ok: false, error: '会话不存在' });
      chatStore.setCurrentId(id);
      return sendJson(res, 200, { ok: true, id, session: chatStore.getSession(id) });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  let _sm;
  if (req.method === 'GET' && (_sm = pathname.match(/^\/api\/v2\/chat\/sessions\/([^/]+)\/messages$/))) {
    const id = decodeURIComponent(_sm[1]);
    const limit = Number(new URL(req.url, 'http://' + HOST).searchParams.get('limit') || 40);
    return sendJson(res, 200, { ok: true, session: chatStore.getSession(id), items: chatStore.getMessages(id, limit) });
  }
  if ((req.method === 'POST' || req.method === 'PATCH') && (_sm = pathname.match(/^\/api\/v2\/chat\/sessions\/([^/]+)\/rename$/))) {
    try {
      const b = await readBody(req);
      const s = chatStore.renameSession(decodeURIComponent(_sm[1]), b.title);
      return s ? sendJson(res, 200, { ok: true, session: s }) : sendJson(res, 400, { ok: false, error: '重命名失败' });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && (_sm = pathname.match(/^\/api\/v2\/chat\/sessions\/([^/]+)\/clear$/))) {
    return sendJson(res, 200, chatStore.clearSession(decodeURIComponent(_sm[1])));
  }
  if (req.method === 'DELETE' && (_sm = pathname.match(/^\/api\/v2\/chat\/sessions\/([^/]+)$/))) {
    return sendJson(res, 200, chatStore.deleteSession(decodeURIComponent(_sm[1])));
  }
  if (req.method === 'GET' && pathname === '/api/v2/chat/search') {
    const u = new URL(req.url, 'http://' + HOST);
    const items = chatStore.search(u.searchParams.get('q') || '', u.searchParams.get('limit'));
    return sendJson(res, 200, { ok: true, items, count: items.length });
  }
  if (req.method === 'GET' && pathname === '/api/v2/chat/store/status') {
    return sendJson(res, 200, chatStore.status());
  }
  if (req.method === 'POST' && pathname === '/api/v2/chat') {
    try {
      const body = await readBody(req);
      const question = String(body.question || '').trim();
      if (!question) return sendJson(res, 400, { ok: false, error: '问题不能为空' });
      // 多会话隔离：带 sessionId 时历史从 SQLite 该会话读取，避免串话；老前端仍可用 body.history
      const wantedId = String(body.sessionId || '').trim();
      const sid = (wantedId && chatStore.getSession(wantedId)) ? wantedId : (chatStore.getCurrentId() || '');
      const history = (wantedId && chatStore.getSession(wantedId))
        ? chatStore.getMessages(wantedId, 12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) }))
        : (Array.isArray(body.history) ? body.history.slice(-12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) })) : []);
      const messages = history.concat([{ role: 'user', content: question }]);
      // 全局上下文：快照 + 板块监控 + 我的股池（让智能体真正「了解整个板块」）
      const snap = snapshot();
      const ctx = hermes.collectContext(snap);
      // 政策快讯：从新闻脉冲取高影响政策条目注入，让智能体知道「融资保证金调整」这类最新政策
      try {
        const pulse = newsPulse.latest();
        const pn = pulse && Array.isArray(pulse.policyNews) ? pulse.policyNews : [];
        // 问题提到政策/保证金/证监会等词时给足 12 条，否则给 6 条避免上下文过长
        const wantMore = /政策|监管|保证金|证监会|交易所|降准|降息|央行|增量资金/.test(question);
        ctx.policyNews = pn.slice(0, wantMore ? 12 : 6).map(n => ({
          title: n.title, time: n.time, source: n.source,
          importance: n.importance, category: n.category, reason: n.reason
        }));
        if (!ctx.policyNews.length) delete ctx.policyNews;
      } catch (_) {}
      try {
        const sm = daily.sectorMonitor();
        if (sm.ok) ctx.sector = { longGrowth: sm.longGrowth, sustained: sm.sustained, benchmark: sm.benchmark };
      } catch (_) {}
      try {
        const pv = portfolio.view();
        ctx.portfolio = {
          watching: (pv.watching.picks || []).length + (pv.watching.holdings || []).length,
          sold: (pv.sold || []).length,
          codes: (pv.watching.picks || []).concat(pv.watching.holdings || []).slice(0, 10).map(x => x.code)
        };
      } catch (_) {}
      // 日程与事件：注入近 45 天具体条目（名称/日期/等级/相关板块），让智能体能看到「日程与事件」模块
      try {
        const ups = cal.upcoming({ days: 45 }).slice(0, 12);
        ctx.calendar = ups.map(e => ({
          name: e.name, date: e.date, grade: e.grade,
          daysTo: e.daysTo, categories: e.categories,
          sectors: Array.isArray(e.sectors) ? e.sectors.slice(0, 5) : [],
          verified: !!e.verified, source: e.source
        }));
      } catch (_) {}
      // 个股分析：问题里出现 6 位代码，或前端「指标」按钮显式带入 stockCode 时，
      // 把可复算的量化评分与技术指标摘要注入上下文，避免智能体只凭文本印象回答。
      try {
        const combined = String(body.stockCode || '') + ' ' + question;
        const codes = Array.from(new Set((combined.match(/\b\d{6}\b/g) || []))).slice(0, 2);
        if (codes.length) {
          ctx.stockAnalysis = [];
          for (const code of codes) {
            const a = await stockAnalysis.analyzeOne(code, { latest: snap });
            if (!a.ok) continue;
            ctx.stockAnalysis.push({
              code: a.code, name: a.name, score: a.score, level: a.level,
              parts: a.scoreParts.map(p => p.label + ' ' + p.score + '(权重' + p.weight + '%)'),
              technical: {
                ma5: a.technical.ma.ma5, ma10: a.technical.ma.ma10, ma20: a.technical.ma.ma20,
                macd: a.technical.macd, rsi14: a.technical.rsi14,
                kdj: a.technical.kdj, boll: a.technical.boll,
                volRatio5: a.technical.volRatio5, pos60: a.technical.pos60,
                mom5: a.technical.mom5, mom20: a.technical.mom20,
                atrPct: a.technical.atrPct, volatility: a.technical.volatility
              },
              signals: a.signals, riskNotes: a.riskNotes,
              tradePlan: a.tradePlan ? {
                last: a.tradePlan.last,
                buyZone: { low: a.tradePlan.buyZone.low, high: a.tradePlan.buyZone.high,
                  pctLow: a.tradePlan.buyZone.pctLow, pctHigh: a.tradePlan.buyZone.pctHigh },
                breakout: { price: a.tradePlan.breakout.price, pct: a.tradePlan.breakout.pct },
                takeProfit: a.tradePlan.takeProfit.map(x => ({ label: x.label, price: x.price, pct: x.pct })),
                pressure: a.tradePlan.pressure,
                support: a.tradePlan.support,
                stopLoss: { price: a.tradePlan.stopLoss.price, pct: a.tradePlan.stopLoss.pct },
                positionMaxPct: a.tradePlan.positionMaxPct
              } : null,
              note: '以上为程序按固定公式测算的技术分与参考价位，可如实引用其数值；不是涨跌预测，不要把参考位表述为买卖指令。'
            });
          }
          if (!ctx.stockAnalysis.length) delete ctx.stockAnalysis;
        }
      } catch (e) { console.warn('[chat-stock-analysis]', e.message); }
      // 选股解释层：问题涉及领跑/跟随/行业/上涨原因/选股时，注入精简的板块判定与驱动线索摘要
      try {
        if (/领跑|龙头|跟随|补涨|板块|行业|为什么涨|上涨原因|驱动|选股|推荐/.test(question)) {
          const ins = require('node:fs').existsSync(pickInsight.OUT)
            ? JSON.parse(require('node:fs').readFileSync(pickInsight.OUT, 'utf8')) : null;
          if (ins && ins.ok) {
            ctx.pickInsight = {
              note: ins.note,
              leaders: (ins.leaders || []).slice(0, 10).map(l => ({
                industry: l.industry, code: l.code, name: l.name, score: l.score || null,
                basis: l.basis, sectorBias: l.sectorBias, followerCount: l.followerCount
              })),
              topDrivers: (ins.items || []).slice(0, 8).map(x => ({
                code: x.code, name: x.name, industry: x.industry, role: x.role,
                kind: x.kindLabel, score: x.score,
                drivers: (x.riseDrivers || []).slice(0, 3).map(d => ({ type: d.type, text: d.text, source: d.source }))
              }))
            };
          }
        }
      } catch (e) { console.warn('[chat-pick-insight]', e.message); }
      const r = await hermes.chat(config, {
        messages,
        context: ctx,
        task: body.module ? '来源模块：' + String(body.module) : undefined,
        maxTokens: body.maxTokens || 1400
      });
      // 对话落盘：一问一答追加一行 JSONL，作为经验回流 / 知识抽取的原始流
      try {
        const convFile = CHAT_FILE;
        fs.mkdirSync(path.dirname(convFile), { recursive: true });
        const rec = {
          ts: new Date().toISOString(),
          module: String(body.module || '对话'),
          question: question.slice(0, 4000),
          answer: String(r.text || '').slice(0, 8000),
          backend: r.backend || null,
          ok: !!r.ok,
          elapsedMs: r.elapsedMs != null ? r.elapsedMs : (r.usage && r.usage.elapsed_ms) || null,
          contextAt: ctx.at || null
        };
        fs.appendFileSync(convFile, JSON.stringify(rec) + '\n', 'utf8');
      } catch (e) { console.warn('[chat-persist]', e.message); }
      // 多会话落库：写入 SQLite 指定会话（首轮自动命名），与 JSONL 经验流并存
      let persistedSession = null;
      try {
        persistedSession = chatStore.appendTurn(sid, {
          question, answer: String(r.text || ''),
          module: String(body.module || '对话'), backend: r.backend || null
        });
      } catch (e) { console.warn('[chat-store-persist]', e.message); }
      // 同步进入知识库统一消息流（只存不提取；价值门控过滤闲聊，且仅成功回答入库）
      try {
        if (r.ok && r.text) {
          knowledge.collectMessage({
            source: 'conversation', module: String(body.module || '对话'),
            question, answer: String(r.text).slice(0, 8000), backend: r.backend || null,
            meta: { contextAt: ctx.at || null }
          });
        }
      } catch (e) { console.warn('[knowledge-collect]', e.message); }
      try {
        if (r.ok) updateFeed.record('chat', '对话记录', '智能体问答落库',
          `问题「${String(question).slice(0, 40)}」· 后端 ${r.backend || '—'} · 会话 ${(persistedSession && persistedSession.title) || sid || '默认'}`, 'chat:turn');
      } catch (_) {}
      return sendJson(res, r.ok ? 200 : 502, Object.assign({}, r, {
        sessionId: persistedSession ? persistedSession.id : sid,
        sessionTitle: persistedSession ? persistedSession.title : null
      }));
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/v2/hermes/test') {
    try { return sendJson(res, 200, await hermes.test(config)); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/context') {
    return sendJson(res, 200, { ok: true, data: hermes.collectContext(snapshot()) });
  }
  // 智能体模块感知快照：供 Hermes skill / MCP 按需读取
  if (req.method === 'GET' && pathname === '/api/v2/agent/perception') return sendJson(res, 200, perception.status());
  if (req.method === 'POST' && pathname === '/api/v2/agent/perception/refresh') {
    try { return sendJson(res, 200, perception.refresh()); }
    catch (e) { return sendJson(res, 502, { ok: false, error: e.message }); }
  }

  // —— ① 日程与事件 ——
  if (req.method === 'GET' && pathname === '/api/v2/calendar') {
    const u = new URL(req.url, 'http://' + HOST);
    return sendJson(res, 200, cal.view({ year: u.searchParams.get('year'), month: u.searchParams.get('month'), date: u.searchParams.get('date') }));
  }
  if (req.method === 'GET' && pathname === '/api/v2/calendar/upcoming') {
    const u = new URL(req.url, 'http://' + HOST);
    const days = Math.min(365, Math.max(1, Number(u.searchParams.get('days')) || 30));
    return sendJson(res, 200, { ok: true, items: cal.upcoming({ days }) });
  }
  if (req.method === 'POST' && pathname === '/api/v2/calendar/event') {
    try { const r = cal.addEvent(await readBody(req)); return sendJson(res, r.ok ? 200 : 400, r); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/v2/calendar/event/remove') {
    try { return sendJson(res, 200, cal.removeEvent((await readBody(req)).id)); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/v2/calendar/impact') {
    try {
      const body = await readBody(req);
      const ev = body.event || {};
      const hist = eventStudy.forEvent(ev);
      return sendJson(res, 200, await cal.eventImpact(config, hermes, ev, hist));
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/calendar/reminders') {
    const u = new URL(req.url, 'http://' + HOST);
    const due = cal.dueReminders({ aheadDays: Math.min(30, Math.max(1, Number(u.searchParams.get('ahead')) || 7)) });
    if (u.searchParams.get('mark') === '1') cal.markReminded(due.map(d => d.id));
    return sendJson(res, 200, { ok: true, items: due });
  }
  // 事件历史统计引擎：近2年事件 × 板块代理 ETF 的 T+1/T+3/T+5 超额与胜率
  if (req.method === 'GET' && pathname === '/api/v2/calendar/event-study/status') return sendJson(res, 200, eventStudy.status());
  if (req.method === 'GET' && pathname === '/api/v2/calendar/event-study') {
    const u = new URL(req.url, 'http://' + HOST);
    const ruleId = u.searchParams.get('ruleId');
    if (u.searchParams.get('refresh') === '1') {
      try { return sendJson(res, 200, await eventStudy.refresh({ years: 2 })); }
      catch (e) { return sendJson(res, 502, { ok: false, error: e.message }); }
    }
    const s = eventStudy.study();
    if (!s.ok) return sendJson(res, 404, s);
    const d = s.data;
    return sendJson(res, 200, {
      ok: true, status: { generatedAt: d.generatedAt, window: d.window, eventCount: d.eventCount, observationCount: d.observationCount },
      method: d.method, overall: d.overall, source: d.source, note: d.note,
      rules: ruleId ? d.rules.filter(r => r.ruleId === ruleId) : d.rules,
      proxyStats: d.proxyStats, noProxy: d.noProxy,
      ruleMeta: d.ruleMeta
    });
  }
  if (req.method === 'POST' && pathname === '/api/v2/calendar/event-study/refresh') {
    try { return sendJson(res, 200, await eventStudy.refresh({ years: 2 })); }
    catch (e) { return sendJson(res, 502, { ok: false, error: e.message }); }
  }

  // —— ② 每日行情 ——
  if (req.method === 'GET' && pathname === '/api/v2/daily/market') {
    const m = daily.marketMonitor();
    // 累积当日大盘实际涨跌到预测账本（供次日方向预测复盘；程序计算值，非编造）
    try { if (m.ok && m.shPct != null) predictions.recordActual(m.tradingDate, m.shPct, m.trading === false ? 'close' : 'intraday'); } catch (_) {}
    return sendJson(res, 200, m);
  }
  if (req.method === 'GET' && pathname === '/api/v2/daily/sectors') return sendJson(res, 200, daily.sectorMonitor());
  if (req.method === 'GET' && pathname === '/api/v2/daily/picks') {
    const p = daily.picks();
    const pulse = newsPulse.latest();
    return sendJson(res, 200, pulse ? newsPulse.attachToPicks(p, pulse) : p);
  }
  // 盘后复盘专家团：智能体不参与预判，只对当日重点关注股 + 持仓做四角色结构化复盘
  if (req.method === 'POST' && pathname === '/api/v2/daily/review-team') {
    const body = await readBody(req);
    const r = await reviewTeam.run(config, hermes, latest, { noAI: !!(body && body.noAI) });
    return sendJson(res, 200, r);
  }
  // —— 新闻快讯：真实新闻聚合 + 智能体「单条解读 / 今日整体解读」+ 股市板块消息面排名 ——
  // 真实股市板块清单来自 edge.strength.boards（东财行业板块全量列表，带 BK 代码与涨跌幅）
  const nfRealBoards = () => {
    try {
      const e = latest.edge;
      const b = e && e.strength && Array.isArray(e.strength.boards) ? e.strength.boards : [];
      if (b.length) return b;
      const c = JSON.parse(fs.readFileSync(strength.CACHE_FILE, 'utf8'));
      return (c && Array.isArray(c.boards)) ? c.boards : [];
    } catch (_) { return []; }
  };
  if (req.method === 'GET' && pathname === '/api/v2/news-flash') {
    let rep = {};
    try { rep = futureEvents.report() || {}; } catch (_) {}
    return sendJson(res, 200, newsFlash.build({ news: latest.news, pulse: newsPulse.latest() || {},
      futureReport: rep, realBoards: nfRealBoards(), trackRank: true }));
  }
  if (req.method === 'POST' && pathname === '/api/v2/news-flash/interpret') {
    try {
      const body = await readBody(req);
      let rep = {};
      try { rep = futureEvents.report() || {}; } catch (_) {}
      const flash = newsFlash.build({ news: latest.news, pulse: newsPulse.latest() || {},
        futureReport: rep, realBoards: nfRealBoards(), trackRank: false });
      const mode = (body && body.mode === 'daily') ? 'daily' : (body && body.mode === 'bias') ? 'bias' : 'one';
      const out = mode === 'daily'
        ? await newsFlash.interpretDaily(config, hermes, flash, cal.relatedStocks)
        : mode === 'bias'
          ? await newsFlash.interpretBias(config, hermes, flash)
          : await newsFlash.interpretOne(config, hermes, (body && body.item) || {}, cal.relatedStocks, flash);
      return sendJson(res, 200, out || { ok: false, error: '智能体未返回结果' });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  // 每小时消息面脉冲：状态 / 最新 / 历史 / 手动刷新
  if (req.method === 'GET' && pathname === '/api/v2/news-pulse') return sendJson(res, 200, { ok: true, data: newsPulse.latest(), history: newsPulse.history(24) });
  if (req.method === 'GET' && pathname === '/api/v2/news-pulse/status') {
    const d = newsPulse.latest();
    return sendJson(res, 200, { ok: true, at: d && d.at, hour: d && d.hour, newsCount: d && d.newsCount, interval: 'hourly' });
  }
  if (req.method === 'POST' && pathname === '/api/v2/news-pulse/refresh') {
    try {
      const pulse = newsPulse.persist(newsPulse.build({ news: latest.news, analysis: latest.analysis }));
      updateFeed.record('market', '政策快讯', '政策快讯手动刷新', `${pulse.newsCount} 条新闻 · 政策相关 ${(pulse.policyNews || []).length} 条 · 板块 ${pulse.sectors.length} 个`, 'manual:news-pulse');
      return sendJson(res, 200, { ok: true, at: pulse.at, sectors: pulse.sectors.length, newsCount: pulse.newsCount });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  // 新闻「规则召回 → 智能体价值分级」桥接：候选集快照 / AI 标注读取 / 手动重建
  if (req.method === 'GET' && pathname === '/api/v2/news-triage') {
    const c = newsTriage.latestCandidates();
    return sendJson(res, 200, {
      ok: true,
      candidates: c ? { generatedAt: c.generatedAt, recall: c.recall } : null,
      triage: newsTriage.latestTriage(),
      status: newsTriage.status()
    });
  }
  if (req.method === 'POST' && pathname === '/api/v2/news-triage/refresh') {
    try {
      const snap = newsTriage.build({ news: latest.news, pulse: newsPulse.latest() });
      updateFeed.record('market', '新闻价值分级', '候选新闻快照重建',
        `扫描 ${snap.recall.scannedTotal} 条新闻 · 交给智能体精排 ${snap.recall.returned} 条`, 'task:news-candidates');
      return sendJson(res, 200, {
        ok: true, generatedAt: snap.generatedAt,
        scannedTotal: snap.recall.scannedTotal, returned: snap.recall.returned,
        outputPath: snap.outputPath
      });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  // 三类选股生成器：状态 / 手动刷新（读取候选池日线，生成 hot/trend/rebound 三份快照）
  // 全市场股票列表（覆盖与统计；逐股日线选股仍在候选/扩大池内进行）
  if (req.method === 'GET' && pathname === '/api/v2/universe/status') return sendJson(res, 200, universe.status());
  if (req.method === 'GET' && pathname === '/api/v2/universe') {
    const u = new URL(req.url, 'http://' + HOST);
    const limit = Math.min(2000, Math.max(0, Number(u.searchParams.get('limit')) || 0));
    const f = universe.filtered({ limit, excludeBJ: u.searchParams.get('bj') !== '1' });
    return sendJson(res, 200, { ...f, count: f.items.length });
  }
  if (req.method === 'POST' && pathname === '/api/v2/universe/refresh') {
    try {
      const r = await universe.refresh({ force: true, concurrency: 3, gapMs: 100 });
      return sendJson(res, 200, { ok: r.ok, at: r.at, total: r.total, count: r.count, coverage: r.coverage, failedPages: r.failedPages });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  // —— 各板块真实更新事件流（每条来自 SSE 广播或调度任务的真实数据变更）——
  if (req.method === 'GET' && pathname === '/api/v2/update-feed') {
    const u = new URL(req.url, 'http://' + HOST);
    return sendJson(res, 200, updateFeed.feed({
      view: u.searchParams.get('view') || 'all',
      since: Number(u.searchParams.get('since') || 0),
      limit: Number(u.searchParams.get('limit') || 80)
    }));
  }
  if (req.method === 'GET' && pathname === '/api/v2/update-feed/summary') {
    return sendJson(res, 200, { ok: true, ...updateFeed.status() });
  }
  if (req.method === 'POST' && pathname === '/api/v2/update-feed/seen') {
    try {
      const b = await readBody(req);
      return sendJson(res, 200, updateFeed.markSeen(b.view || 'all', b.at ? Number(b.at) : Date.now()));
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  // —— 短线情绪三项（赚钱效应 / 连板高度 / 炸板率）——
  if (req.method === 'GET' && pathname === '/api/v2/sentiment') {
    return sendJson(res, 200, { ok: true, data: sentiment.latest(), history: sentiment.history(60) });
  }
  if (req.method === 'POST' && pathname === '/api/v2/sentiment/refresh') {
    try {
      const r = await sentiment.build();
      if (r.ok) updateFeed.record('market', '短线情绪', '情绪指标重算',
        `赚钱效应 ${r.moneyEffect && r.moneyEffect.avgPct != null ? r.moneyEffect.avgPct + '%' : '—'} · 连板高度 ${r.boardHeight && r.boardHeight.maxBoards} 板 · 炸板率 ${r.breakRate && r.breakRate.rate}%`, 'manual:sentiment');
      return sendJson(res, r.ok ? 200 : 502, r);
    }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  // —— 未来事件扫描入历：从全部新闻抽取带确定时间的、对股市有影响的事件 ——
  if (req.method === 'GET' && pathname === '/api/v2/future-events') {
    const rep = futureEvents.report();
    return sendJson(res, 200, { ok: true, ...rep, events: futureEvents.scannedEvents() });
  }
  if (req.method === 'POST' && pathname === '/api/v2/future-events/scan') {
    try {
      const r = futureEvents.scan({ news: latest.news.items, now: Date.now() });
      const cv = r.coverage || {};
      updateFeed.record('calendar', '未来事件', '未来事件扫描入历',
        `扫描 ${cv.scannedNews || 0} 条新闻 · 带确定时间 ${cv.timedCandidates || 0} 条 · 入历 ${cv.totalUpsertCandidates || 0} 条 · 待复核 ${cv.reviewQueue || 0} 条`, 'manual:future-events');
      return sendJson(res, 200, {
        ok: true, generatedAt: r.generatedAt, coverage: r.coverage,
        upserted: (r.upserted || []).slice(0, 20), reviewQueue: (r.reviewQueue || []).slice(0, 10)
      });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  // —— 四类选股统一视图 + 次日备选观察池 / 风险规避池 ——
  if (req.method === 'GET' && pathname === '/api/v2/strategy') {
    const d = strategy.latest();
    return sendJson(res, 200, d || { ok: false, error: '尚未生成，请先运行 /api/v2/strategy/refresh' });
  }
  if (req.method === 'POST' && pathname === '/api/v2/strategy/refresh') {
    try {
      const r = strategy.build();
      updateFeed.record('market', '四类策略', '四类选股与双池重建',
        `四类合并 ${r.fourClass.totalRows} 行 · 领跑 ${r.fourClass.leaders.length} 只 · 次日观察池 ${r.pools.watchCount} 只 · 风险规避池 ${r.pools.riskCount} 只`, 'manual:strategy');
      return sendJson(res, 200, { ok: true, fourClassRows: r.fourClass.totalRows, watch: r.pools.watchCount, risk: r.pools.riskCount, generatedAt: r.generatedAt });
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/screener/status') return sendJson(res, 200, screener.status());
  // 选股解释层：行业 / 上涨驱动线索 / 板块领跑与跟随；status 只读，rebuild 重建
  if (req.method === 'GET' && pathname === '/api/v2/pick-insight') {
    try { return sendJson(res, 200, require('node:fs').existsSync(pickInsight.OUT) ? JSON.parse(require('node:fs').readFileSync(pickInsight.OUT, 'utf8')) : { ok: false, note: '尚未生成' }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/pick-insight/status') return sendJson(res, 200, pickInsight.status());
  if (req.method === 'POST' && pathname === '/api/v2/pick-insight/rebuild') {
    try { const r = pickInsight.build(); return sendJson(res, 200, { ok: r.ok, items: r.items.length, leaders: r.leaders.length, generatedAt: r.generatedAt }); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/v2/screener/run') {
    try {
      const r = await screener.refresh();
      return sendJson(res, r.ok ? 200 : 502, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  // 定时快照 / 复盘 / 报告：状态与手动触发
  // 09:05 预测股票池：今日视图 / 历史状态 / 手动定格 / 手动复盘
  if (req.method === 'GET' && pathname === '/api/v2/pick-pool') {
    const date = new URL(req.url, 'http://' + HOST).searchParams.get('date') || undefined;
    return sendJson(res, 200, pickPool.today(date ? { date } : {}));
  }
  if (req.method === 'GET' && pathname === '/api/v2/pick-pool/status') return sendJson(res, 200, pickPool.status());
  if (req.method === 'POST' && pathname === '/api/v2/pick-pool/freeze') {
    try { const body = await readBody(req); const r = pickPool.freeze(body.date ? { date: body.date } : {}); return sendJson(res, r.ok ? 200 : 400, r); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/v2/pick-pool/review') {
    try { const r = await pickPool.review({}); return sendJson(res, r.ok ? 200 : 400, r); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/scheduler/status') return sendJson(res, 200, scheduler.status());
  if (req.method === 'POST' && pathname === '/api/v2/scheduler/run') {
    try {
      const body = await readBody(req);
      const task = String(body.task || 'all');
      const r = await scheduler.runTask(task, config, hermes, body.date || undefined);
      return sendJson(res, r.ok ? 200 : 400, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/report/today') {
    const date = String(new URL(req.url, 'http://' + HOST).searchParams.get('date') || scheduler.bjDate());
    const dir = report.dayDir(date);
    const fsx = require('node:fs');
    const idxFile = require('node:path').join(dir, 'index.json');
    if (!fsx.existsSync(idxFile)) return sendJson(res, 404, { ok: false, error: '当日报告尚未生成' });
    try { return sendJson(res, 200, JSON.parse(fsx.readFileSync(idxFile, 'utf8'))); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/daily/forecast') {
    const r = await daily.marketForecast(config, hermes);
    // 预测账本：生成即落盘（按交易日幂等），供次日复盘命中检验
    try {
      const rec = predictions.record(r);
      r.prediction = rec;
    } catch (e) { console.warn('[predictions] record:', e.message); }
    return sendJson(res, r.ok ? 200 : 502, r);
  }
  // 预测账本：汇总 / 明细
  if (req.method === 'GET' && pathname === '/api/v2/predictions') return sendJson(res, 200, predictions.summary());
  if (req.method === 'GET' && pathname === '/api/v2/predictions/list') return sendJson(res, 200, predictions.list());
  // 预测账本：复盘（用 fetchKline 查下一交易日沪指涨跌回填实际结果，不编造）
  if (req.method === 'POST' && pathname === '/api/v2/predictions/review') {
    try {
      const calDates = await ic.tradingCalendar();
      const fetchNextShPct = async (tradingDate) => {
        const i = calDates.indexOf(tradingDate);
        if (i < 0 || i + 1 >= calDates.length) return null;
        const nextDate = calDates[i + 1];
        // 下一交易日尚未收盘时无法核对，返回 null 保留 pending
        const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
        if (nextDate >= today) return null;
        const bars = await ic.fetchKline('000001', 480, 'index');
        const idx = bars.findIndex(b => b.d === nextDate);
        if (idx <= 0) return null;
        const prev = bars[idx - 1].c, cur = bars[idx].c;
        if (!prev || !cur) return null;
        return { date: nextDate, shPct: Math.round((cur - prev) / prev * 10000) / 100, source: 'fetchKline(000001)' };
      };
      return sendJson(res, 200, await predictions.review({ ic, fetchNextShPct }));
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/daily/sectors/brief') {
    const r = await daily.sectorBrief(config, hermes);
    return sendJson(res, r.ok ? 200 : 502, r);
  }
  if (req.method === 'GET' && pathname === '/api/v2/daily/picks/brief') {
    const r = await daily.picksBrief(config, hermes);
    return sendJson(res, r.ok ? 200 : 502, r);
  }

  // —— ③ 我的股池 ——
  if (req.method === 'GET' && pathname === '/api/v2/portfolio') return sendJson(res, 200, portfolio.view());
  if (req.method === 'POST' && pathname === '/api/v2/portfolio/sold') {
    try { const r = portfolio.addSold(await readBody(req)); return sendJson(res, r.ok ? 200 : 400, r); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/v2/portfolio/sold/remove') {
    try { return sendJson(res, 200, portfolio.removeSold((await readBody(req)).id)); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  // —— ⑤ 个人知识库 ——
  if (req.method === 'GET' && pathname === '/api/v2/knowledge/notes') {
    const u = new URL(req.url, 'http://' + HOST);
    return sendJson(res, 200, knowledge.notes({ limit: Math.min(300, Number(u.searchParams.get('limit')) || 100), kind: u.searchParams.get('kind') || undefined }));
  }
  if (req.method === 'POST' && pathname === '/api/v2/knowledge/note') {
    try {
      const r = knowledge.addNote(await readBody(req));
      if (r.ok) { try { knowledge.exportEntries(); } catch (_) {} } // 同步生成本地 md 词条
      return sendJson(res, r.ok ? 200 : 400, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/v2/knowledge/note/remove') {
    try { return sendJson(res, 200, knowledge.removeNote((await readBody(req)).noteId)); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  // 本地 md 知识词条：图谱铺满视图的词条列表来源，词条以 md 文档存在本地可人工编辑
  if (req.method === 'GET' && pathname === '/api/v2/knowledge/entries') {
    const u = new URL(req.url, 'http://' + HOST);
    return sendJson(res, 200, knowledge.listEntries({ limit: Math.min(500, Number(u.searchParams.get('limit')) || 200) }));
  }
  if (req.method === 'POST' && pathname === '/api/v2/knowledge/entries/export') {
    try { return sendJson(res, 200, knowledge.exportEntries()); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname.startsWith('/api/v2/knowledge/entry/')) {
    return sendJson(res, 200, knowledge.getEntry(decodeURIComponent(pathname.slice('/api/v2/knowledge/entry/'.length))));
  }
  if (req.method === 'POST' && pathname === '/api/v2/knowledge/entry/save') {
    try {
      const body = await readBody(req);
      const r = knowledge.saveEntry(body.id, body.content);
      if (r && r.ok !== false) updateFeed.record('knowledge', '知识词条', '本地词条保存',
        `词条「${String(body.id || '').slice(0, 40)}」已写入 md`, 'knowledge:entry-save');
      return sendJson(res, 200, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/knowledge/graph') return sendJson(res, 200, knowledge.graph());
  if (req.method === 'POST' && pathname === '/api/v2/knowledge/organize') {
    try {
      const body = await readBody(req);
      const r = await knowledge.organize(config, hermes, { noteId: body.noteId, limit: body.limit });
      return sendJson(res, r.ok ? 200 : 502, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/v2/knowledge/query') {
    try {
      const body = await readBody(req);
      const q = String(body.question || '').trim();
      if (!q) return sendJson(res, 400, { ok: false, error: '问题不能为空' });
      const r = await knowledge.query(config, hermes, q);
      // 记录问答命中反馈（P3）：把答案里出现的图谱节点 label 作为 hitNodeIds
      try {
        if (r.ok && r.answer) {
          const g = knowledge.graph();
          const hits = g.nodes.filter(n => n.label && r.answer.includes(n.label)).map(n => n.id);
          if (hits.length) knowledge.recordFeedback({ question: q, hitNodeIds: hits, useful: true });
        }
      } catch (_) {}
      return sendJson(res, 200, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  // —— 知识库 P0–P3 增强接口 ——
  if (req.method === 'GET' && pathname === '/api/v2/knowledge/status') return sendJson(res, 200, knowledge.status());
  // 复盘结论回流知识库：智能体判定候选价值后写入 proposed 笔记与图谱
  if (req.method === 'POST' && pathname === '/api/v2/knowledge/reflow') {
    try {
      const body = await readBody(req);
      const date = body.date || scheduler.bjDate();
      const idxFile = require('node:path').join(report.dayDir(date), 'index.json');
      const idx = JSON.parse(require('node:fs').readFileSync(idxFile, 'utf8'));
      const r = await knowledge.reflowFromReport(config, hermes, { date, candidates: idx.candidates || [] });
      return sendJson(res, r.ok ? 200 : 502, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/knowledge/messages') {
    const u = new URL(req.url, 'http://' + HOST);
    return sendJson(res, 200, knowledge.messages({
      limit: Math.min(300, Number(u.searchParams.get('limit')) || 100),
      source: u.searchParams.get('source') || undefined,
      unextracted: u.searchParams.get('unextracted') === '1'
    }));
  }
  if (req.method === 'POST' && pathname === '/api/v2/knowledge/message') {
    try { return sendJson(res, 200, knowledge.collectMessage(await readBody(req))); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/v2/knowledge/dedupe') {
    try { return sendJson(res, 200, knowledge.dedupeNotes((await readBody(req)).confirm === true)); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/knowledge/pending') return sendJson(res, 200, knowledge.pendingMerges());
  if (req.method === 'POST' && pathname === '/api/v2/knowledge/resolve-merge') {
    try { const r = knowledge.resolveMerge(await readBody(req)); return sendJson(res, r.ok ? 200 : 400, r); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/v2/knowledge/confirm-node') {
    try { const b = await readBody(req); const r = knowledge.confirmNode(b.id, { validTo: b.validTo }); return sendJson(res, r.ok ? 200 : 400, r); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/knowledge/conflicts') return sendJson(res, 200, knowledge.conflicts());
  if (req.method === 'POST' && pathname === '/api/v2/knowledge/feedback') {
    try { return sendJson(res, 200, knowledge.recordFeedback(await readBody(req))); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/v2/knowledge/decay') {
    try { const b = await readBody(req); return sendJson(res, 200, knowledge.decay({ confirm: b.confirm === true })); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  /* ==================================================================
   * Hermes agent loop：SSE 流式对话（思考过程 + 工具调用时间线 + 真实轨迹）
   * ================================================================== */
  if (req.method === 'POST' && pathname === '/api/v2/chat/stream') {
    let closed = false;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    req.on('close', () => { closed = true; });
    const sse = (event, data) => {
      if (closed || res.writableEnded) return;
      try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (_) {}
    };
    try {
      const body = await readBody(req);
      const question = String(body.question || '').trim();
      if (!question) { sse('error', { message: '问题不能为空' }); res.end(); return; }
      const wantedId = String(body.sessionId || '').trim();
      const sid = (wantedId && chatStore.getSession(wantedId)) ? wantedId : (chatStore.getCurrentId() || '');
      const history = (wantedId && chatStore.getSession(wantedId))
        ? chatStore.getMessages(wantedId, 12).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) }))
        : (Array.isArray(body.history) ? body.history.slice(-12) : []);
      // 最小上下文提示：agent 按需用工具取数，不把整包快照塞进 prompt
      let hint = '';
      try {
        const snap = snapshot();
        const ctx = hermes.collectContext(snap);
        hint = hermes.contextPrefix(ctx).slice(0, 1400);
      } catch (_) {}
      const result = await agentLoop.run(config, {
        question, history, sessionId: sid, contextHint: hint,
        emit: (event, data) => sse(event, data)
      });
      // 落盘（与 /api/v2/chat 一致：JSONL 经验流 + SQLite 会话 + 知识库消息流 + 更新事件）
      try {
        const rec = { ts: new Date().toISOString(), module: String(body.module || '对话'),
          question: question.slice(0, 4000), answer: String(result.text || '').slice(0, 8000),
          backend: result.backend || 'agent-loop', ok: !!result.ok,
          elapsedMs: result.elapsedMs || null, traceTools: (result.trace && result.trace.tools || []).map(x => x.name) };
        fs.mkdirSync(path.dirname(CHAT_FILE), { recursive: true });
        fs.appendFileSync(CHAT_FILE, JSON.stringify(rec) + '\n', 'utf8');
      } catch (e) { console.warn('[stream-chat-persist]', e.message); }
      let persisted = null;
      try {
        persisted = chatStore.appendTurn(sid, {
          question, answer: String(result.text || ''),
          module: String(body.module || '对话'), backend: result.backend || 'agent-loop'
        });
      } catch (e) { console.warn('[stream-chat-store]', e.message); }
      try {
        if (result.ok && result.text) knowledge.collectMessage({
          source: 'conversation', module: String(body.module || '对话'),
          question, answer: String(result.text).slice(0, 8000), backend: result.backend || 'agent-loop',
          meta: { agentTrace: result.trace || null }
        });
      } catch (_) {}
      try {
        if (result.ok) updateFeed.record('chat', '对话记录', '智能体问答落库（工具取证）',
          '问题「' + String(question).slice(0, 40) + '」· 调用 ' + (result.toolCalls || 0) + ' 次工具 · ' +
          (result.trace && result.trace.mcpUsed ? '含 MCP' : '本地工具'), 'chat:agent-turn');
      } catch (_) {}
      sse('meta', { sessionId: persisted ? persisted.id : sid, sessionTitle: persisted ? persisted.title : null,
        backend: result.backend, toolCalls: result.toolCalls || 0, elapsedMs: result.elapsedMs });
      if (!closed && !res.writableEnded) res.end();
    } catch (e) {
      sse('error', { message: e.message });
      if (!closed && !res.writableEnded) res.end();
    }
    return;
  }
  if (req.method === 'GET' && pathname === '/api/v2/agent/tools') {
    return sendJson(res, 200, await agentTools.list());
  }
  if (req.method === 'GET' && pathname === '/api/v2/agent/loop/status') {
    const u = new URL(req.url, 'http://' + HOST);
    return sendJson(res, 200, Object.assign(agentLoop.status(), {
      tools: (await agentTools.list()).count
    }));
  }
  if (req.method === 'GET' && pathname === '/api/v2/agent/traces') {
    const u = new URL(req.url, 'http://' + HOST);
    return sendJson(res, 200, agentLoop.traces({ limit: Number(u.searchParams.get('limit')) || 30, sessionId: u.searchParams.get('sessionId') || undefined }));
  }

  /* ==================================================================
   * 全板块统一知识图谱（双时态 / 实体消解 / 历史保留）
   * ================================================================== */
  if (req.method === 'GET' && pathname === '/api/v2/unified-graph') {
    const u = new URL(req.url, 'http://' + HOST);
    return sendJson(res, 200, unifiedGraph.graph({
      type: u.searchParams.get('type') || undefined,
      limit: Number(u.searchParams.get('limit')) || undefined,
      includeFacts: u.searchParams.get('facts') === '1'
    }));
  }
  if (req.method === 'POST' && pathname === '/api/v2/unified-graph/build') {
    try {
      const r = unifiedGraph.build();
      try { updateFeed.record('knowledge', '统一知识图谱', '全板块图谱重建',
        '节点 ' + r.nodes + ' · 关系 ' + r.links + ' · 事实 ' + r.facts + ' · 失效归档 ' + r.expiredThisBuild + ' 条', 'unified-graph:build'); } catch (_) {}
      return sendJson(res, 200, r);
    } catch (e) { return sendJson(res, 502, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/unified-graph/query') {
    const u = new URL(req.url, 'http://' + HOST);
    return sendJson(res, 200, unifiedGraph.query({ q: u.searchParams.get('q') || '', limit: Number(u.searchParams.get('limit')) || 24 }));
  }
  if (req.method === 'GET' && pathname === '/api/v2/unified-graph/asof') {
    const u = new URL(req.url, 'http://' + HOST);
    return sendJson(res, 200, unifiedGraph.asOf({ at: u.searchParams.get('at') || undefined, entityId: u.searchParams.get('entityId') || undefined }));
  }
  if (req.method === 'GET' && pathname === '/api/v2/unified-graph/history') {
    const u = new URL(req.url, 'http://' + HOST);
    return sendJson(res, 200, unifiedGraph.history({ entityId: u.searchParams.get('entityId') || undefined,
      kind: u.searchParams.get('kind') || undefined, limit: Number(u.searchParams.get('limit')) || 100 }));
  }
  if (req.method === 'GET' && pathname === '/api/v2/unified-graph/pending') return sendJson(res, 200, unifiedGraph.pending());
  if (req.method === 'POST' && pathname === '/api/v2/unified-graph/resolve-merge') {
    try { return sendJson(res, 200, unifiedGraph.resolveMerge(await readBody(req))); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/unified-graph/status') return sendJson(res, 200, unifiedGraph.status());

  /* ==================================================================
   * 垃圾信息处理 / 数据质量治理（默认只报告，confirm 才处置）
   * ================================================================== */
  if (req.method === 'GET' && pathname === '/api/v2/hygiene/report') return sendJson(res, 200, dataHygiene.report());
  if (req.method === 'POST' && pathname === '/api/v2/hygiene/scan') {
    try { return sendJson(res, 200, dataHygiene.scan()); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/v2/hygiene/clean') {
    try { const b = await readBody(req); return sendJson(res, 200, dataHygiene.clean({ confirm: b.confirm === true, rules: b.rules || [] })); }
    catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }
  if (req.method === 'GET' && pathname === '/api/v2/hygiene/status') return sendJson(res, 200, dataHygiene.status());

  if (req.method === 'GET') return serveStatic(pathname, res);
  res.writeHead(405); res.end('Method Not Allowed');
});

/* ------------------------------- 启动 ------------------------------- */

function openBrowser(url) {
  try {
    const candidates = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];
    const exe = candidates.find(p => fs.existsSync(p));
    if (exe) {
      const child = spawn(exe, ['--app=' + url, '--window-size=1480,960', '--no-first-run', '--disable-features=Translate'], { stdio: 'ignore' });
      child.on('error', e => console.warn('[browser] 启动失败:', e.message));
      console.log('[browser] 已用独立应用窗口打开');
    } else {
      spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore' });
      console.log('[browser] 已用默认浏览器打开');
    }
  } catch (e) {
    console.warn('[browser] 无法自动打开，请手动访问 ' + url + '（' + e.message + '）');
  }
}

const heartbeat = setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': ping\n\n'); } catch (_) { sseClients.delete(res); }
  }
}, 15000);

/* ===== v2 定时：15 分钟量能汇报 + 日程自动提醒（仅在交易时段推量能） ===== */
let lastVolReportAt = 0, lastRemindDay = '';
// 每小时消息面脉冲：整点后 2 分钟内触发一次（按小时去重，不依赖交易日）
let lastNewsPulseHour = '';
function runNewsPulse() {
  try {
    const hour = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 13);
    if (hour === lastNewsPulseHour) return null;
    lastNewsPulseHour = hour;
    const pulse = newsPulse.persist(newsPulse.build({ news: latest.news, analysis: latest.analysis }));
    // 未来事件扫描：跟随每小时新闻脉冲，把「带确定时间 + 对股市有影响」的内容去重写入日程
    try { futureEvents.scan({ news: latest.news.items, now: Date.now() }); }
    catch (e) { console.warn('[future-events]', e.message); }
    // 同步重建「新闻价值分级」候选集快照，供 Hermes 技能按需 Pull 精排（此处不调用大模型）
    try { newsTriage.build({ news: latest.news, pulse }); }
    catch (e) { console.warn('[news-triage]', e.message); }
    // 广播给前端刷新选股卡片消息面
    try { broadcast('news-pulse', {
      at: pulse.at, sectors: pulse.sectors.slice(0, 8), newsCount: pulse.newsCount,
      policyCount: pulse.policyCount, alertCount: pulse.alertCount,
      topPolicy: (pulse.policyNews || []).slice(0, 4)
    }); } catch (_) {}
    return pulse;
  } catch (e) { console.warn('[news-pulse]', e.message); return null; }
}
// 冷启动后 12 秒做一次未来事件扫描（新闻缓存已就绪），此后每小时随新闻脉冲自动扫描
setTimeout(() => {
  try {
    const r = futureEvents.scan({ news: latest.news.items, now: Date.now() });
    console.log('[future-events] initial scan', JSON.stringify(r.coverage));
  } catch (e) { console.warn('[future-events] initial scan failed:', e.message); }
}, 12000);
const v2Timer = setInterval(() => {
  const now = Date.now();
  // 每小时消息面脉冲（整点后 2 分钟内）
  const bjMin = new Date(now + 8 * 3600e3).toISOString().slice(14, 16);
  if (Number(bjMin) <= 2) runNewsPulse();
  // 量能汇报：每 15 分钟，交易时段且距上次 ≥15 分钟
  if (isTradingNow() && now - lastVolReportAt >= 15 * 60 * 1000) {
    lastVolReportAt = now;
    try {
      const m = daily.marketMonitor();
      if (m.ok) {
        const msg = '【15分钟量能】' + m.at + ' 两市成交 ' + (m.amountYi != null ? m.amountYi + ' 亿' : '--') +
          '，较20日均量' + (m.ratio20 != null ? (m.ratio20 >= 1 ? '放大' : '萎缩') + '至' + Math.round(m.ratio20 * 100) + '%' : '--') +
          '（' + m.state + '），' + m.momentum;
        pushAlerts([{ id: 'v2-vol-' + now, level: 'info', ruleId: 'v2_volume_report', title: '量能播报', detail: msg, sourceGrade: 'A', affectsScore: false, recordedAt: now }]);
        broadcast('v2-volume', m);
      }
    } catch (e) { console.warn('[v2-volume]', e.message); }
  }
  // 日程提醒：每 30 分钟检查一次，每天去重
  const day = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
  if (lastRemindDay !== day || now - (v2Timer._lastRemind || 0) >= 30 * 60 * 1000) {
    lastRemindDay = day; v2Timer._lastRemind = now;
    try {
      const due = cal.dueReminders({ aheadDays: 7 });
      if (due.length) {
        for (const d of due) {
          pushAlerts([{ id: 'v2-cal-' + d.id, level: d.daysTo === 0 ? 'warning' : 'info', ruleId: 'v2_calendar_reminder', title: '日程提醒', detail: d.message + '｜相关：' + (d.sectors || []).join('/'), sourceGrade: d.grade, affectsScore: false, recordedAt: now }]);
        }
        cal.markReminded(due.map(d => d.id));
        // 智能体卡片：事件 + 分析 + 观察点，异步生成，不阻塞定时器
        (async () => {
          const cards = [];
          for (const d of due.slice(0, 3)) {
            let analysis = null, analysisMeta = null;
            const hist = eventStudy.forEvent(d);
            try {
              const imp = await cal.eventImpact(config, hermes, d, hist);
              if (imp && imp.ok) {
                analysis = imp.text;
                // 把提示词版本 / 后端一并下发，前端标注来源，保持真实可追溯
                analysisMeta = { promptVersion: imp.promptVersion || 'event-impact-v3', backend: imp.backend || null };
              }
            } catch (_) {}
            cards.push({
              ...d,
              analysis,
              analysisMeta,
              historical: hist.ok ? (hist.detail || hist.line) : null,
              eventDetail: {
                ok: hist.ok, ruleId: hist.ruleId || d.ruleId || null,
                mechanism: hist.mechanism || null,
                proxies: hist.proxies || [],
                summary: hist.summary || null,
                source: 'event-study(真实日线/ETF代理)'
              },
              observation: '观察点：关注相关板块量能与相对强弱是否同步变化；若事件落地后板块高开低走且量能放大，则「预期兑现」风险上升。历史样本不代表本次必然重演。'
            });
          }
          broadcast('v2-calendar', { items: cards });
        })().catch(e => console.warn('[v2-calendar-card]', e.message));
      }
    } catch (e) { console.warn('[v2-calendar]', e.message); }
  }
}, 60 * 1000);

/* 每日 09:00 预测快照 / 15:40 选股刷新 / 16:30 复盘 / 18:30 报告 */
try {
  scheduler.start({ hermes, getConfig: () => config });
  console.log('[scheduler] 已启动：09:00 forecast / 15:40 screener / 16:30 review / 18:30 report');
} catch (e) { console.warn('[scheduler] 启动失败:', e.message); }
// 启动时生成一次消息面脉冲（若尚未有），保证选股卡片立即带消息面解释
setTimeout(() => { if (!newsPulse.latest()) runNewsPulse(); }, 8000);

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用。若系统已在运行，请直接访问 http://' + HOST + ':' + PORT);
    console.error('如需换端口，可设置环境变量 PORT，例如 set PORT=8888');
  } else console.error('[server] ', e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = 'http://' + HOST + ':' + PORT;
  console.log('');
  console.log('  全球市场监测与报警系统');
  console.log('  ---------------------------------------------');
  console.log('  服务地址: ' + url);
  console.log('  行情轮询: ' + config.quoteIntervalSec + ' 秒 | 新闻轮询: ' + config.newsIntervalSec + ' 秒');
  console.log('  主数据源: CNBC Quote API / 新浪财经 / 东方财富 / Yahoo Finance');
  console.log('  新闻来源: 华尔街见闻A股/全球快讯 / 中新网财经 / Google News / BBC / Guardian / Al Jazeera');
  console.log('  新闻中文化: 自动机器翻译 + 落盘缓存 | 解读: 情感词典 + 事件主题 + 资产影响映射');
  console.log('  当日观察池: 五榜候选池 + 涨停池 / 60日日线 / 12项指标 / 舆情热度 / 外围联动 / 量能风格 / 加权融合评分');
  console.log('  涨停结构: 一字/T字/换手/炸板 板型 · 封板时间 · 封单占流通市值 · 连板梯队 · 开板次数 · 情绪周期六阶段');
  console.log('  K线形态: Alpha158 Kbar 9 因子 + 涨停后高开大阴 / 单阳不破 / 缩量突破 / 多方炮 / 吞没 / 跳空缺口 等 14 种');
  console.log('  量能风格: 两市量能 + 中证2000/1000/500/300 四层代理 / 份额偏移 / 风格动量 / 宽度与拥挤度');
  console.log('  事件与宏观: 公告 / 重组收购回购减持 / 业绩超预期 / 龙头板块联动 + 2.5万亿存量博弈弹性 / 机构避险');
  console.log('  评分自检: 每日定格评分快照 → T+1/3/5/10 前瞻收益 → Rank IC / 分组 IC / 分档单调性 / 经验库');
  console.log('  实时联动: 新闻解读、公司事件、人气热榜或外围行情变化 → 自动轻量重评分（复用缓存指标，非预测）');
  console.log('  热度来源: 东财人气榜 + 同花顺热榜 | 舆情: 中文新闻标题匹配 + VADER 式情感');
  console.log('  评估闭环: 09:05/22:00 定格 → T+1 复盘 → n≥8 归纳 → 人工审核 → 有界回流（±2 分）');
  console.log('  预期研究: 板块相对强弱 / 市值重估条件清单 / 周期阶段统计 / 多因素叠加指纹（不改分，由复盘裁决）');
  console.log('  关闭窗口即停止监控；配置与告警保存在 data/ 目录');
  console.log('  ---------------------------------------------');
  console.log('');
  doQuoteTick();
  doNewsTick();
  initYahooHistory();
  reschedule();
  // 量能风格先算（含全市场分页宽度），观察池随后可复用结果
  setTimeout(() => refreshStyleAndStocks(false).catch(e => console.warn('[style]', e.message)), 2500);
  // 事件材料（公告 / 业绩预告快报 / 行业市值）采集，完成后自动重建信号并触发重评分
  setTimeout(() => runEvents(false).catch(e => console.warn('[events]', e.message)), 6000);
  // 兜底：新闻源异常时也能独立完成选股，不依赖解读流程
  // 涨停池优先拉取：观察池的结构因子（板型/封板/封单/连板）依赖它
  setTimeout(() => runLimitUp(false).catch(e => console.warn('[limitup]', e.message)), 6000);
  // 闭环四模块：周期事件 → 资金主体（增量回填）→ 避险 → 经验库（定时定格在 09:05 / 22:00）
  setTimeout(() => runCycle(false).catch(e => console.warn('[cycle]', e.message)), 9000);
  setTimeout(() => runFlow().catch(e => console.warn('[flow]', e.message)), 12000);
  setTimeout(() => runRiskOff(false).catch(e => console.warn('[riskoff]', e.message)), 16000);
  setTimeout(() => runJournalTick().catch(e => console.warn('[journal]', e.message)), 20000);
  // 持仓监控：启动即算一次（观察池就绪前先出行情与盈亏，评分联动等 stocks 就绪后自动补齐）
  setTimeout(() => runHoldings().catch(e => console.warn('[holdings]', e.message)), 22000);
  setTimeout(() => runStocks(false).catch(e => console.warn('[stocks]', e.message)), 15000);
  // 预期研究层：等事件/周期/避险/观察池就绪后再跑，保证叠加因子都有真实输入
  setTimeout(() => runEdge(false).catch(e => console.warn('[edge]', e.message)), 30000);
  // 评分自检：启动后补算到期快照的前瞻收益并重建报告（纯读盘 + 少量日线）
  setTimeout(() => runIC(false).catch(e => console.warn('[ic]', e.message)), 40000);
  if (!process.argv.includes('--no-browser')) setTimeout(() => openBrowser(url), 900);
});

function shutdown() {
  clearInterval(heartbeat);
  clearTimeout(quoteTimer);
  clearTimeout(newsTimer);
  clearInterval(stocksTimer);
  clearInterval(styleTimer);
  clearInterval(eventsTimer);
  clearInterval(limitTimer);
  clearInterval(journalTimer);
  clearInterval(cycleTimer);
  clearInterval(flowTimer);
  clearInterval(riskoffTimer);
  clearInterval(holdingsTimer);
  clearInterval(edgeTimer);
  clearInterval(attributionTimer);
  clearInterval(technicalTimer);
  persistState();
  for (const res of sseClients) { try { res.end(); } catch (_) {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
