'use strict';

/**
 * unified-graph.js — 全板块统一知识图谱（U-KG）
 *
 * 目标：把「日程与事件 / 每日行情 / 我的股池 / 选股 / 情绪 / 策略 / 新闻 / 复盘 /
 *       经验库 / 预测池 / 知识库词条」各板块真实产出，汇聚成一张可检索、可回溯的图谱，
 *       供智能体做结构化分析（而不只是把摘要塞进 prompt）。
 *
 * 【时序模型：借鉴 Zep / Graphiti 的双时态知识图谱】
 *   每条「事实」（节点属性 / 边）带四个时间戳：
 *     validAt    事实在现实世界生效的时刻（数据快照时间）
 *     invalidAt  事实失效的时刻（被新事实取代 / 过期）
 *     createdAt  系统首次录入该事实的时刻
 *     expiredAt  系统得知该事实失效的时刻
 *   更新规则（用户要求的「更新同一个或类似信息，并保存被更新的历史」）：
 *     同一 (实体, 谓词) 出现新值 → 旧事实不删除，打 invalidAt/expiredAt 归入 history，
 *     新事实 validAt=now 生效。asOf(t) 可回答「系统在 t 时刻相信什么」。
 *   实体消解（Entity Resolution）：
 *     规范化标签 + 别名表 + 编辑距离相似度；≥0.88 自动合并（继承双方 episode 溯源），
 *     0.62–0.88 记为待确认候选，不自动合并。
 *
 * 【存储】data/knowledge/
 *   unified-graph.json        当前生效图（nodes / links / facts / meta）
 *   ug-history.jsonl           append-only 失效事实与合并历史（永不覆盖）
 *   ug-aliases.json            别名 → 权威节点 id
 *   ug-pending.json            待确认合并候选
 *
 * 【纪律】
 *   - 只读各板块已落盘的真实数据，不编造实体、不改任何评分、不写买卖建议。
 *   - 每次 build 都是「全量重算 + 与上一版做时序比对」，幂等；无新数据时只更新 lastSeen。
 *   - 与旧 knowledge/graph.json 并存：旧图是「经验/概念」，本图是「全板块事实」，互不覆盖。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const KDIR = path.join(DATA, 'knowledge');
const F_GRAPH = path.join(KDIR, 'unified-graph.json');
const F_HIST = path.join(KDIR, 'ug-history.jsonl');
const F_ALIAS = path.join(KDIR, 'ug-aliases.json');
const F_PENDING = path.join(KDIR, 'ug-pending.json');
const F_SCAN = path.join(KDIR, 'ug-sources.json');

const SIM_MERGE = 0.88;
const SIM_PENDING = 0.62;
const MAX_NODES = 900;          // 防止 3D 图谱过载
const MAX_LINKS = 2600;

/* ---------------------------- 基础工具 ---------------------------- */

function ensureDir() { if (!fs.existsSync(KDIR)) fs.mkdirSync(KDIR, { recursive: true }); }
function readJson(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return fallback;
}
function writeJson(file, obj) {
  ensureDir();
  const t = file + '.tmp';
  fs.writeFileSync(t, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(t, file);
}
function appendJsonl(file, obj) { ensureDir(); fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8'); }
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    .map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
}
function jread(rel, fallback) { return readJson(path.join(DATA, rel), fallback); }
function nowISO() { return new Date().toISOString(); }
function tsOf(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? new Date(v).toISOString() : null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + 'T00:00:00.000Z';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return s.replace(' ', 'T').replace(/:(\d{2}):(\d{2})$/, ':$1:$2') + (s.length <= 16 ? ':00' : '') + '.000Z';
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function norm(s) {
  return String(s || '').replace(/[\s\.,，。、\-_（）()【】\[\]"'`*·:：;；/\\]/g, '').toLowerCase();
}
function similarity(a, b) {
  const s1 = norm(a), s2 = norm(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;
  const m = s1.length, n = s2.length;
  if (m * n > 40000) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s1[i - 1] === s2[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}
function short(s, n = 60) { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…' : t; }

/* ---------------------------- 实体类型 ---------------------------- */

const TYPES = {
  module:    { label: '板块',     color: '#7c5cff', val: 9 },
  stock:     { label: '个股',     color: '#165dff', val: 4 },
  sector:    { label: '行业/概念', color: '#0fc6c2', val: 5 },
  strategy:  { label: '策略类别', color: '#722ed1', val: 6 },
  pool:      { label: '股池',     color: '#00b42a', val: 6 },
  metric:    { label: '情绪指标', color: '#f7ba1e', val: 6 },
  policy:    { label: '政策快讯', color: '#f53f3f', val: 4 },
  news:      { label: '新闻',     color: '#ff7d00', val: 3 },
  event:     { label: '日程事件', color: '#eb0aa4', val: 5 },
  factor:    { label: '因子',     color: '#86909c', val: 5 },
  experience:{ label: '经验/词条', color: '#00b42a', val: 4 },
  concept:   { label: '概念',     color: '#165dff', val: 4 },
  question:  { label: '问题',     color: '#d46b08', val: 4 },
  prediction:{ label: '预测',     color: '#4080ff', val: 4 },
  source:    { label: '数据源',   color: '#4e5969', val: 3 }
};
const LINK_LABEL = {
  belongs_to: '属于', selected_by: '入选', in_pool: '入池', watch_in: '观察',
  risk_in: '规避', affects: '影响', mentions: '提及', leads: '领跑',
  follows: '跟随', caused_by: '驱动', relates: '关联', supports: '支持',
  contradicts: '冲突', instance_of: '实例', measured_by: '度量', sourced_from: '来源',
  scheduled_at: '日程', invalidates: '取代'
};

/* ---------------------------- 构建器 ---------------------------- */

function makeBuilder(builtAt) {
  const nodes = new Map();   // id -> node
  const links = new Map();   // key -> link
  const facts = new Map();   // factKey -> 当前生效事实（双时态）
  const expired = [];        // 本次失效的事实（写入历史）
  const sources = [];

  function addNode(id, type, label, props = {}, episode = null) {
    if (!id || !label) return null;
    const key = String(id);
    const t = TYPES[type] || TYPES.source;
    let n = nodes.get(key);
    if (!n) {
      n = {
        id: key, type, label: String(label).slice(0, 80),
        color: t.color, val: t.val, group: type,
        createdAt: builtAt, validAt: props.validAt || builtAt, lastSeenAt: builtAt,
        status: 'active', episodes: [], props: {}
      };
      nodes.set(key, n);
    }
    n.lastSeenAt = builtAt;
    if (episode && !n.episodes.includes(episode)) n.episodes.push(episode);
    Object.assign(n.props, props);
    return n;
  }

  function addLink(from, to, type, label, props = {}, episode = null) {
    if (!from || !to || from === to || !nodes.has(from) || !nodes.has(to)) return null;
    const key = from + '|' + to + '|' + type;
    let l = links.get(key);
    if (!l) {
      l = { source: from, target: to, type, label: label || LINK_LABEL[type] || type,
            createdAt: builtAt, validAt: props.validAt || builtAt, status: 'active', episodes: [] };
      links.set(key, l);
    }
    if (episode && !l.episodes.includes(episode)) l.episodes.push(episode);
    Object.assign(l, props);
    return l;
  }

  /**
   * 载入上一版「当前生效事实」作为基线（跨版本时序比对的关键）。
   * 每条基线打 _seen=false；本次 build 没被 setFact 命中的，视为事实消失 → 失效归档。
   */
  function seedFacts(rows) {
    for (const f of (Array.isArray(rows) ? rows : [])) {
      if (!f || f.status !== 'active' || !f.factKey) continue;
      facts.set(f.factKey, { ...f, _seen: false });
    }
  }

  /** 注册一条「事实」：同一 (entity, predicate) 值变化时旧值入历史（不删除） */
  function setFact(entityId, predicate, value, opts = {}) {
    const key = entityId + '::' + predicate;
    const v = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const prev = facts.get(key);
    if (prev && prev.value !== v) {
      // 时序失效：旧事实不删除，打 invalidAt/expiredAt 并 append-only 写入历史
      const old = { ...prev }; delete old._seen;
      old.invalidAt = builtAt; old.expiredAt = builtAt; old.status = 'invalidated';
      old.newValue = v; old.supersededBy = opts.episode || null;
      expired.push(old);
      appendJsonl(F_HIST, {
        kind: 'fact-superseded', at: builtAt, entityId, predicate,
        oldValue: old.value, newValue: v,
        oldValidAt: old.validAt, oldCreatedAt: old.createdAt,
        invalidatedAt: builtAt, episode: opts.episode || old.episode || null,
        source: opts.source || old.source || null
      });
      facts.set(key, {
        factKey: key, entityId, predicate, value: v,
        validAt: opts.validAt || builtAt, invalidAt: null,
        createdAt: builtAt, expiredAt: null, status: 'active',
        episode: opts.episode || null, source: opts.source || null, _seen: true
      });
    } else if (!prev) {
      facts.set(key, {
        factKey: key, entityId, predicate, value: v,
        validAt: opts.validAt || builtAt, invalidAt: null,
        createdAt: builtAt, expiredAt: null, status: 'active',
        episode: opts.episode || null, source: opts.source || null, _seen: true
      });
    } else {
      prev._seen = true;                       // 值未变：只续命，不重写 createdAt
      prev.lastConfirmedAt = builtAt;
      facts.set(key, prev);
    }
    return facts.get(key);
  }

  /** 本次未被任何 setFact 命中的基线事实 → 判定为「实体/事实消失」，失效归档 */
  function expireMissing() {
    for (const [key, f] of facts) {
      if (f._seen) continue;
      const old = { ...f }; delete old._seen;
      old.invalidAt = builtAt; old.expiredAt = builtAt; old.status = 'invalidated';
      expired.push(old);
      appendJsonl(F_HIST, {
        kind: 'fact-expired', at: builtAt, entityId: old.entityId, predicate: old.predicate,
        oldValue: old.value, oldValidAt: old.validAt, oldCreatedAt: old.createdAt,
        invalidatedAt: builtAt, reason: '本次全板块扫描未再出现该事实',
        source: old.source || null
      });
      facts.delete(key);
    }
  }

  function src(rel, ok, count, note) {
    sources.push({ file: rel, ok: !!ok, count: count == null ? null : count, note: note || null, readAt: builtAt });
  }

  return { nodes, links, facts, expired, sources, addNode, addLink, setFact, seedFacts, expireMissing, src };
}

/* ---------------------------- 各板块抽取器 ---------------------------- */

/** 全板块：一个总节点，保证图谱有中心 */
function ingestModules(B, b) {
  const mods = [
    ['calendar', '日程与事件'], ['market', '每日行情'], ['portfolio', '我的股池'],
    ['chat', '对话'], ['knowledge', '个人知识库'], ['settings', '设置'],
    ['screener', '四类量化选股'], ['sentiment', '短线情绪'],
    ['strategy', '策略视图'], ['news', '新闻与政策'], ['report', '短线复盘']
  ];
  for (const [id, label] of mods) {
    B.addNode('M:' + id, 'module', label, { moduleId: id }, 'modules');
    B.setFact('M:' + id, 'present', true, { episode: 'modules', source: 'system' });
  }
}

/** 四类选股 + 观察池/风险池 → 个股、行业、策略节点 */
function ingestStrategy(B, b) {
  const d = jread('strategy.json', null);
  if (!d || !d.ok) return B.src('strategy.json', false);
  const fc = d.fourClass || {}, pools = d.pools || {};
  const at = tsOf(d.generatedAt) || b;
  const items = Array.isArray(fc.items) ? fc.items : [];
  const kinds = new Map();
  for (const x of items) {
    if (!x.code) continue;
    const sid = 'S:' + x.code;
    B.addNode(sid, 'stock', x.name || x.code, {
      code: x.code, industry: x.industry || null, score: x.score != null ? x.score : null,
      role: x.role || null, validAt: at
    }, 'strategy');
    B.setFact(sid, 'score', x.score, { validAt: at, episode: 'strategy', source: 'strategy.json' });
    B.setFact(sid, 'industry', x.industry || '未知', { validAt: at, episode: 'strategy', source: 'strategy.json' });
    for (const c of (Array.isArray(x.classes) ? x.classes : (x.kind ? [x.kind] : []))) {
      const kid = 'K:' + c;
      if (!kinds.has(c)) {
        kinds.set(c, (kinds.get(c) || 0) + 1);
        B.addNode(kid, 'strategy', x.kindLabel || c, { strategyKey: c, validAt: at }, 'strategy');
      }
      B.addLink(sid, kid, 'selected_by', '入选' + (x.kindLabel || c), { validAt: at }, 'strategy');
    }
    if (x.industry) {
      const iid = 'I:' + norm(x.industry);
      B.addNode(iid, 'sector', x.industry, { sectorType: 'industry', validAt: at }, 'strategy');
      B.addLink(sid, iid, 'belongs_to', '所属行业', { validAt: at }, 'strategy');
    }
  }
  for (const [k, n] of kinds) B.setFact('K:' + k, 'count', n, { validAt: at, episode: 'strategy', source: 'strategy.json' });
  B.setFact('M:screener', 'totalRows', fc.totalRows || items.length, { validAt: at, episode: 'strategy', source: 'strategy.json' });

  const P = [
    ['watchPool', 'watch_in', '次日备选观察池'],
    ['riskPool', 'risk_in', '风险规避池']
  ];
  for (const [key, ltype, plabel] of P) {
    const pid = 'P:' + key;
    const arr = Array.isArray(pools[key]) ? pools[key] : [];
    B.addNode(pid, 'pool', plabel, { poolKey: key, count: arr.length, validAt: at }, 'strategy');
    B.setFact(pid, 'size', arr.length, { validAt: at, episode: 'strategy', source: 'strategy.json' });
    for (const x of arr) {
      if (!x.code) continue;
      const sid = 'S:' + x.code;
      B.addNode(sid, 'stock', x.name || x.code, { code: x.code, validAt: at }, 'strategy');
      B.addLink(sid, pid, ltype, ltype === 'watch_in' ? '观察池' : '风险池',
        { why: short(x.why || x.reason || '', 40), validAt: at }, 'strategy');
    }
  }
  B.src('strategy.json', true, items.length, '四类选股 + 次日双池');
}

/** 四类独立选股快照（保留每个策略自己的命中，避免 strategy 合并后丢信息） */
function ingestScreens(B, b) {
  const files = [
    ['trend-screen.json', '趋势'], ['dip-screen.json', '低吸'],
    ['board-screen.json', '打板'], ['breakout-screen.json', '趋势突破']
  ];
  let total = 0;
  for (const [f, label] of files) {
    const d = jread(f, null);
    if (!d) { B.src(f, false); continue; }
    const at = tsOf(d.generatedAt) || b;
    const arr = Array.isArray(d.items) ? d.items : [];
    const kid = 'K:screen-' + label;
    B.addNode(kid, 'strategy', label + '选股', { screenFile: f, count: arr.length, validAt: at }, 'screens');
    for (const x of arr) {
      if (!x.code) continue;
      const sid = 'S:' + x.code;
      B.addNode(sid, 'stock', x.name || x.code, { code: x.code, validAt: at }, 'screens');
      B.addLink(sid, kid, 'selected_by', label + '命中', { score: x.score != null ? x.score : null, validAt: at }, 'screens');
    }
    B.setFact(kid, 'count', arr.length, { validAt: at, episode: 'screens', source: f });
    total += arr.length;
    B.src(f, true, arr.length, label);
  }
  return total;
}

/** 情绪三项 */
function ingestSentiment(B, b) {
  const d = jread('sentiment.json', null);
  if (!d || !d.ok) return B.src('sentiment.json', false);
  const at = tsOf(d.generatedAt) || b;
  const me = d.moneyEffect || {}, bh = d.boardHeight || {}, br = d.breakRate || {};
  const triples = [
    ['moneyEffect', '赚钱效应', me.ok ? ('均收益 ' + me.avgRet + '% · 上涨占比 ' + me.upRatio + '%') : '数据不足'],
    ['boardHeight', '连板高度', bh.maxBoards != null ? (bh.maxBoards + ' 板 · ' + (bh.heightLevel || '')) : '数据不足'],
    ['breakRate', '炸板率', br.rate != null ? (br.rate + '% · ' + (br.level || '')) : '数据不足']
  ];
  for (const [key, label, value] of triples) {
    const mid = 'E:' + key;
    B.addNode(mid, 'metric', label, { metricKey: key, validAt: at, tradeDate: d.date || null }, 'sentiment');
    B.setFact(mid, 'value', value, { validAt: at, episode: 'sentiment', source: 'sentiment.json' });
    B.addLink('M:sentiment', mid, 'measured_by', '度量', { validAt: at }, 'sentiment');
  }
  B.src('sentiment.json', true, 3, '赚钱效应/连板高度/炸板率');
}

/** 行情风格 / 市场宽度 */
function ingestMarket(B, b) {
  const ms = jread('market-style.json', null);
  if (ms) {
    const at = tsOf(ms.generatedAt) || b;
    const v = ms.volume || {};
    B.addNode('E:volume', 'metric', '两市量能', { validAt: at, tradingDate: ms.tradingDate || null }, 'market');
    B.setFact('E:volume', 'state', v.state || '未知', { validAt: at, episode: 'market', source: 'market-style.json' });
    B.setFact('E:volume', 'totalAmountYi', v.totalAmountYi, { validAt: at, episode: 'market', source: 'market-style.json' });
    B.addLink('M:market', 'E:volume', 'measured_by', '度量', { validAt: at }, 'market');
    B.src('market-style.json', true, 1, '量能状态');
  } else B.src('market-style.json', false);
  const mb = jread('market-breadth.json', null);
  if (mb) {
    const at = tsOf(mb.generatedAt) || b;
    B.addNode('E:breadth', 'metric', '市场涨跌宽度', { validAt: at }, 'market');
    B.setFact('E:breadth', 'upRatio', mb.up != null && mb.valid ? Math.round(mb.up / mb.valid * 100) : null,
      { validAt: at, episode: 'market', source: 'market-breadth.json' });
    B.src('market-breadth.json', true, mb.valid || 0, '上涨/下跌家数');
  } else B.src('market-breadth.json', false);
}

/** 新闻与政策：政策快讯 + 板块主题 */
function ingestNews(B, b) {
  const d = jread('news-pulse.json', null);
  if (!d) return B.src('news-pulse.json', false);
  const at = tsOf(d.at) || b;
  const policy = Array.isArray(d.policyNews) ? d.policyNews : [];
  for (const n of policy.slice(0, 40)) {
    const pid = 'N:policy-' + (n.id || norm(n.title).slice(0, 20));
    B.addNode(pid, 'policy', short(n.title, 60), {
      importance: n.importance || 0, category: n.category || null,
      source: n.source || null, time: n.time || null, link: n.link || null, validAt: at
    }, 'news');
    B.setFact(pid, 'importance', n.importance, { validAt: at, episode: 'news', source: 'news-pulse.json' });
    B.addLink(pid, 'M:news', 'sourced_from', '来源', { validAt: at }, 'news');
  }
  const sectors = Array.isArray(d.sectors) ? d.sectors : [];
  for (const s of sectors.slice(0, 30)) {
    if (!s.sector) continue;
    const sid = 'I:' + norm(s.sector);
    B.addNode(sid, 'sector', s.sector, { sectorType: 'theme', validAt: at }, 'news');
    B.setFact(sid, 'newsScore', s.score, { validAt: at, episode: 'news', source: 'news-pulse.json' });
    B.setFact(sid, 'direction', s.direction || '', { validAt: at, episode: 'news', source: 'news-pulse.json' });
    for (const t of (Array.isArray(s.themes) ? s.themes : []).slice(0, 4)) {
      const tid = 'I:' + norm(t);
      B.addNode(tid, 'sector', t, { sectorType: 'theme', validAt: at }, 'news');
      B.addLink(sid, tid, 'relates', '主题关联', { validAt: at }, 'news');
    }
  }
  const heads = Array.isArray(d.headlines) ? d.headlines : [];
  for (const h of heads.slice(0, 20)) {
    const title = typeof h === 'string' ? h : (h.title || '');
    if (!title) continue;
    B.addNode('N:head-' + norm(title).slice(0, 20), 'news', short(title, 60), { time: h.time || null, validAt: at }, 'news');
  }
  B.setFact('M:news', 'policyCount', policy.length, { validAt: at, episode: 'news', source: 'news-pulse.json' });
  B.setFact('M:news', 'newsCount', d.newsCount || 0, { validAt: at, episode: 'news', source: 'news-pulse.json' });
  B.src('news-pulse.json', true, policy.length + sectors.length + heads.length, '政策快讯/板块主题/头条');
}

/** 日程与事件 */
function ingestCalendar(B, b) {
  let count = 0;
  const scan = jread('calendar/future-events-scan.json', null);
  if (scan) {
    const at = tsOf(scan.generatedAt) || b;
    const ups = Array.isArray(scan.upserted) ? scan.upserted : [];
    for (const e of ups.slice(0, 40)) {
      const name = e.name || e.title;
      if (!name) continue;
      const id = 'V:' + norm(name).slice(0, 24) + '-' + String(e.date || '').replace(/\D/g, '').slice(0, 8);
      B.addNode(id, 'event', short(name, 60), {
        date: e.date || null, grade: e.grade || null, sectors: e.sectors || [],
        verified: !!e.verified, source: e.source || null, validAt: at
      }, 'calendar');
      B.setFact(id, 'date', e.date || '未定', { validAt: at, episode: 'calendar', source: 'future-events-scan.json' });
      for (const s of (Array.isArray(e.sectors) ? e.sectors : []).slice(0, 3)) {
        B.addNode('I:' + norm(s), 'sector', s, { validAt: at }, 'calendar');
        B.addLink(id, 'I:' + norm(s), 'affects', '影响板块', { validAt: at }, 'calendar');
      }
      count++;
    }
    B.setFact('M:calendar', 'upserted', ups.length, { validAt: at, episode: 'calendar', source: 'future-events-scan.json' });
    B.src('calendar/future-events-scan.json', true, ups.length, '未来事件入历');
  } else B.src('calendar/future-events-scan.json', false);
  return count;
}

/** 我的股池：持仓 + 自选 */
function ingestPortfolio(B, b) {
  let count = 0;
  const h = jread('holdings.json', null);
  const mp = jread('my-picks.json', null);
  for (const [file, d, kind] of [['holdings.json', h, '持仓'], ['my-picks.json', mp, '自选']]) {
    if (!d) { B.src(file, false); continue; }
    const arr = Array.isArray(d.positions) ? d.positions : (Array.isArray(d.items) ? d.items : []);
    const at = tsOf(d.updatedAt) || b;
    const pid = 'P:mine-' + (kind === '持仓' ? 'hold' : 'pick');
    B.addNode(pid, 'pool', kind === '持仓' ? '今日上午确定的' : '我的选股',
      { poolKind: kind, count: arr.length, validAt: at }, 'portfolio');
    B.setFact(pid, 'size', arr.length, { validAt: at, episode: 'portfolio', source: file });
    for (const x of arr) {
      const code = x.code || x.symbol;
      if (!code) continue;
      const sid = 'S:' + code;
      B.addNode(sid, 'stock', x.name || code, { code, validAt: at }, 'portfolio');
      B.addLink(sid, pid, 'in_pool', kind === '持仓' ? '上午确定' : '我的选股', { validAt: at }, 'portfolio');
      count++;
    }
    B.src(file, true, arr.length, kind);
  }
  return count;
}

/** 旧知识库图谱：概念/经验/因子/问题节点纳入统一图 */
function ingestLegacyKnowledge(B, b) {
  const g = readJson(path.join(KDIR, 'graph.json'), null);
  if (!g || !Array.isArray(g.nodes)) return B.src('knowledge/graph.json', false);
  const at = tsOf(g.builtAt) || b;
  const mapType = t => ({ concept: 'concept', factor: 'factor', experience: 'experience', pattern: 'experience', question: 'question', event: 'event' }[t] || 'concept');
  const ids = new Map();
  for (const n of g.nodes) {
    if (n.status === 'archived') continue;
    const id = 'G:' + String(n.id).replace(/^G:/, '');
    ids.set(n.id, id);
    B.addNode(id, mapType(n.type), n.label, {
      confidence: n.confidence != null ? n.confidence : null,
      status: n.status || 'active', legacyId: n.id, validAt: n.validFrom || at
    }, 'knowledge');
    B.setFact(id, 'confidence', n.confidence, { validAt: at, episode: 'knowledge', source: 'knowledge/graph.json' });
  }
  for (const e of (Array.isArray(g.edges) ? g.edges : [])) {
    const a = ids.get(e.from), z = ids.get(e.to);
    if (a && z) B.addLink(a, z, e.type || 'relates', LINK_LABEL[e.type] || '关联', { validAt: at }, 'knowledge');
  }
  B.src('knowledge/graph.json', true, g.nodes.length, '经验/概念节点并入');
}

/** 经验库 / 预测池 / 复盘：统计型节点，避免爆量 */
function ingestJournals(B, b) {
  // 股池冻结账本：days 是 { 日期: {上午确定/我的选股...} } 对象
  const pp = jread('pick-pool-state.json', null);
  if (pp && pp.days) {
    const dates = Object.keys(pp.days);
    B.addNode('E:pickpool', 'metric', '选股池冻结账本', { dates, validAt: b }, 'journal');
    B.setFact('E:pickpool', 'days', dates.length, { validAt: b, episode: 'journal', source: 'pick-pool-state.json' });
    for (const date of dates.slice(-5)) {
      const day = pp.days[date] || {};
      for (const [key, arr] of Object.entries(day)) {
        if (!Array.isArray(arr)) continue;
        for (const x of arr.slice(0, 15)) {
          const code = (x && (x.code || x.symbol)) || null;
          if (!code) continue;
          const sid = 'S:' + code;
          B.addNode(sid, 'stock', x.name || code, { code, validAt: b }, 'journal');
          B.setFact(sid, 'frozen-' + key, date, { validAt: b, episode: 'journal', source: 'pick-pool-state.json' });
        }
      }
    }
    B.src('pick-pool-state.json', true, dates.length, '每日冻结股池（' + dates.join('/') + '）');
  } else B.src('pick-pool-state.json', false);
  // 预测账本：days 是 { 日期: {...} }
  const pa = jread('predictions-actual.json', null);
  if (pa && pa.days) {
    const dates = Object.keys(pa.days);
    B.addNode('E:prediction', 'prediction', '预测池账本', { dates, validAt: b }, 'journal');
    B.setFact('E:prediction', 'days', dates.length, { validAt: b, episode: 'journal', source: 'predictions-actual.json' });
    for (const date of dates.slice(-5)) {
      const day = pa.days[date] || {};
      const items = Array.isArray(day) ? day : (Array.isArray(day.items) ? day.items : []);
      for (const x of items.slice(0, 12)) {
        const code = (x && (x.code || x.symbol)) || null;
        if (!code) continue;
        B.addNode('S:' + code, 'stock', x.name || code, { code, validAt: b }, 'journal');
        B.addLink('E:prediction', 'S:' + code, 'mentions', '预测池', { date, validAt: b }, 'journal');
      }
    }
    B.src('predictions-actual.json', true, dates.length, '预测/实际对照');
  } else B.src('predictions-actual.json', false);
  const jr = jread('journal/rules.json', null);
  if (jr) {
    const arr = Array.isArray(jr) ? jr : (Array.isArray(jr.items) ? jr.items : (Array.isArray(jr.rules) ? jr.rules : []));
    for (const r of arr.slice(0, 25)) {
      const name = r.name || r.title || r.rule || r.label;
      if (!name) continue;
      const id = 'G:rule-' + norm(name).slice(0, 22);
      B.addNode(id, 'experience', short(name, 60), { validAt: b, ruleKind: 'journal' }, 'journal');
      B.addLink(id, 'M:knowledge', 'belongs_to', '经验库', { validAt: b }, 'journal');
    }
    B.src('journal/rules.json', true, arr.length, '经验规则');
  }
}

/** 更新事件流：把最新的「真实更新」作为 source 节点，证明图谱有时序 */
function ingestUpdateFeed(B, b) {
  const f = readJson(path.join(DATA, 'update-feed.json'), null);
  const arr = Array.isArray(f) ? f : (f && Array.isArray(f.events) ? f.events : (f && Array.isArray(f.items) ? f.items : []));
  if (!arr.length) return B.src('update-feed.json', false);
  const at = b;
  B.addNode('U:feed', 'source', '更新事件流', { count: arr.length, validAt: at }, 'update-feed');
  B.setFact('U:feed', 'count', arr.length, { validAt: at, episode: 'update-feed', source: 'update-feed.json' });
  const seen = new Set();
  for (const e of arr.slice(-20)) {
    const view = e.view || 'all';
    // 复用已有的板块节点，不新建未知 view 节点
    B.addLink('U:feed', 'M:' + (['calendar', 'market', 'portfolio', 'chat', 'knowledge', 'settings'].includes(view) ? view : 'market'),
      'mentions', '最近更新', { at: e.at || null, module: e.module || null, validAt: at }, 'update-feed');
    if (!seen.has(view)) { seen.add(view); B.setFact('U:feed', 'last-' + view, e.at || '', { validAt: at, episode: 'update-feed', source: 'update-feed.json' }); }
  }
  B.src('update-feed.json', true, arr.length, '真实更新事件');
}

/* ---------------------------- 实体消解 ---------------------------- */

function resolveEntities(nodeMap, linkMap, builtAt) {
  const aliases = readJson(F_ALIAS, { map: {} });
  const pending = readJson(F_PENDING, { items: [] });
  const nodes = nodeMap;              // Map<id, node>
  const links = linkMap;              // Map<key, link>
  const list = [...nodes.values()];
  const removed = new Set();
  let merged = 0, candidates = 0;
  // append-only 历史里已记录过的合并对不再重复写入：
  // 每次 build 都从源数据全量重算，若不去重，同一批实体会在每次重建时刷出重复的 entity-merged 事件。
  const seenMerge = new Set(readJsonl(F_HIST)
    .filter(h => h.kind === 'entity-merged' || h.kind === 'manual-merge')
    .map(h => (h.keptId || h.a) + '|' + (h.removedId || h.b)));

  // 只在同一类型内比较，且跳过股票（代码唯一，不需要消解）
  const groups = new Map();
  for (const n of list) {
    if (n.type === 'stock' || n.type === 'module') continue;
    const g = groups.get(n.type) || [];
    g.push(n); groups.set(n.type, g);
  }
  for (const [, arr] of groups) {
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (removed.has(a.id)) continue;
      for (let j = i + 1; j < arr.length; j++) {
        const b2 = arr[j];
        if (removed.has(b2.id)) continue;
        const sim = similarity(a.label, b2.label);
        if (sim >= SIM_MERGE) {
          // 合并到 a：继承双方 episode 溯源（Zep 的 lineage union）
          a.episodes = [...new Set([...(a.episodes || []), ...(b2.episodes || [])])];
          a.lastSeenAt = builtAt;
          aliases.map[b2.id] = a.id;
          for (const l of links.values()) {
            if (l.source === b2.id) l.source = a.id;
            if (l.target === b2.id) l.target = a.id;
          }
          removed.add(b2.id);
          merged++;
          const mergeKey = a.id + '|' + b2.id;
          if (!seenMerge.has(mergeKey)) {
            seenMerge.add(mergeKey);
            appendJsonl(F_HIST, {
              kind: 'entity-merged', at: builtAt, keptId: a.id, removedId: b2.id,
              label: a.label, mergedLabel: b2.label, similarity: Math.round(sim * 100) / 100,
              inheritedEpisodes: b2.episodes || []
            });
          }
        } else if (sim >= SIM_PENDING && !pending.items.some(p => p.a === a.id && p.b === b2.id)) {
          candidates++;
          pending.items.push({ a: a.id, b: b2.id, labelA: a.label, labelB: b2.label,
            sim: Math.round(sim * 100) / 100, createdAt: builtAt, status: 'pending' });
        }
      }
    }
  }
  const kept = [...nodes.values()].filter(n => !removed.has(n.id));
  const keptIds = new Set(kept.map(n => n.id));
  const cleanLinks = [...links.values()].filter(l => keptIds.has(l.source) && keptIds.has(l.target) && l.source !== l.target);
  writeJson(F_ALIAS, aliases);
  writeJson(F_PENDING, pending);
  return { nodes: kept, links: cleanLinks, merged, candidates };
}

/* ---------------------------- 主入口 ---------------------------- */

function build({ force = false } = {}) {
  const builtAt = nowISO();
  const B = makeBuilder(builtAt);
  const prev = readJson(F_GRAPH, null);
  if (prev && Array.isArray(prev.facts)) B.seedFacts(prev.facts); // 跨版本时序基线

  ingestModules(B, builtAt);
  ingestStrategy(B, builtAt);
  ingestScreens(B, builtAt);
  ingestSentiment(B, builtAt);
  ingestMarket(B, builtAt);
  ingestNews(B, builtAt);
  ingestCalendar(B, builtAt);
  ingestPortfolio(B, builtAt);
  ingestLegacyKnowledge(B, builtAt);
  ingestJournals(B, builtAt);
  ingestUpdateFeed(B, builtAt);
  B.expireMissing(); // 未被本轮命中的旧事实 → 失效归档（不删除）

  let nodes = [...B.nodes.values()];
  let links = [...B.links.values()];
  const facts = [...B.facts.values()].map(f => { const o = { ...f }; delete o._seen; return o; });

  // 过载保护：优先保留有边相连的实体
  if (nodes.length > MAX_NODES) {
    const deg = new Map();
    for (const l of links) { deg.set(l.source, (deg.get(l.source) || 0) + 1); deg.set(l.target, (deg.get(l.target) || 0) + 1); }
    nodes.sort((a, b2) => (deg.get(b2.id) || 0) - (deg.get(a.id) || 0) || (TYPES[a.type] ? 1 : -1));
    nodes = nodes.slice(0, MAX_NODES);
    const ids = new Set(nodes.map(n => n.id));
    links = links.filter(l => ids.has(l.source) && ids.has(l.target));
  }
  if (links.length > MAX_LINKS) links = links.slice(0, MAX_LINKS);

  const nm = new Map(nodes.map(n => [n.id, n]));
  const lm = new Map();
  for (const l of links) lm.set(l.source + '|' + l.target + '|' + l.type, l);
  const r = resolveEntities(nm, lm, builtAt);

  // 与上一版比对：节点增减 + 本轮失效事实数
  const changed = r.nodes.length - (prev && prev.nodes ? prev.nodes.length : 0);
  const expiredCount = B.expired.length;

  const byType = {};
  for (const n of r.nodes) byType[n.type] = (byType[n.type] || 0) + 1;
  const out = {
    ok: true, builtAt, version: (prev && prev.version ? prev.version + 1 : 1),
    model: 'bi-temporal-kg (Zep/Graphiti-inspired)',
    nodes: r.nodes, links: r.links, facts,
    meta: {
      nodeCount: r.nodes.length, linkCount: r.links.length, factCount: facts.length,
      byType, mergedEntities: r.merged, pendingMerge: r.candidates,
      nodeDelta: changed, expiredThisBuild: expiredCount,
      sources: B.sources,
      failedSources: B.sources.filter(s => !s.ok).map(s => s.file),
      historyFile: 'data/knowledge/ug-history.jsonl',
      discipline: '事实更新不删除旧值，打 invalidAt/expiredAt 并 append-only 写入 ug-history.jsonl；实体消解继承双方 episode 溯源。'
    }
  };
  writeJson(F_GRAPH, out);
  writeJson(F_SCAN, { builtAt, sources: B.sources });
  appendJsonl(F_HIST, {
    kind: 'build', at: builtAt, version: out.version,
    nodes: out.meta.nodeCount, links: out.meta.linkCount,
    facts: out.meta.factCount, expired: expiredCount, merged: r.merged,
    sources: B.sources.length, failedSources: out.meta.failedSources
  });
  return {
    ok: true, builtAt, version: out.version,
    nodes: out.meta.nodeCount, links: out.meta.linkCount, facts: out.meta.factCount,
    byType, merged: r.merged, pendingMerge: r.candidates,
    expiredThisBuild: expiredCount,
    sources: B.sources.length, failedSources: out.meta.failedSources
  };
}

/** 当前图（供 3D/2D 渲染）；可按类型过滤、限制规模 */
function graph({ type, limit, includeFacts = false } = {}) {
  let d = readJson(F_GRAPH, null);
  if (!d || !d.ok) d = (build(), readJson(F_GRAPH, null));
  if (!d) return { ok: false, error: '图谱未构建' };
  let nodes = d.nodes || [], links = d.links || [];
  if (type) {
    const ts = String(type).split(',');
    nodes = nodes.filter(n => ts.includes(n.type));
    const ids = new Set(nodes.map(n => n.id));
    links = links.filter(l => ids.has(l.source) && ids.has(l.target));
  }
  if (limit && nodes.length > limit) {
    nodes = nodes.slice(0, limit);
    const ids = new Set(nodes.map(n => n.id));
    links = links.filter(l => ids.has(l.source) && ids.has(l.target));
  }
  return {
    ok: true, builtAt: d.builtAt, version: d.version, model: d.model,
    nodes: nodes.map(n => ({
      id: n.id, label: n.label, type: n.type, group: n.group, color: n.color, val: n.val,
      status: n.status, validAt: n.validAt, createdAt: n.createdAt, lastSeenAt: n.lastSeenAt,
      episodes: n.episodes, props: n.props
    })),
    links: links.map(l => ({
      source: l.source, target: l.target, type: l.type, label: l.label,
      validAt: l.validAt, status: l.status, episodes: l.episodes
    })),
    ...(includeFacts ? { facts: d.facts } : {}),
    meta: d.meta,
    typeLabels: Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, v.label])),
    linkLabels: LINK_LABEL
  };
}

/** 图谱整体统计（类型分布等），供智能体回答「各类型节点多少个」 */
function graphStats(g) {
  const m = g && g.meta ? g.meta : null;
  if (!m) return null;
  return {
    nodeCount: m.nodeCount, linkCount: m.linkCount, factCount: m.factCount,
    byType: m.byType, pendingMerge: m.pendingMerge, failedSources: m.failedSources,
    version: g.version, model: g.model, builtAt: g.builtAt
  };
}

/** 问答式检索：按关键词找相关节点 + 1 跳邻居 + 相关事实（供智能体基于图谱分析） */
function query({ q, limit = 24 } = {}) {
  const g = graph({ includeFacts: true });
  if (!g.ok) return { ok: false, error: g.error };
  const stats = graphStats(g);
  const term = norm(q || '');
  if (!term) return { ok: true, nodes: [], links: [], facts: [], history: [], stats, note: '空查询：返回图谱整体统计（节点/关系/事实/类型分布）' };
  const score = n => {
    const l = norm(n.label);
    let s = 0;
    if (l === term) s += 100;
    else if (l.includes(term) || term.includes(l)) s += 60;
    else s += similarity(n.label, q) * 40;
    const p = JSON.stringify(n.props || {});
    if (p.includes(String(q))) s += 15;
    return s;
  };
  const ranked = g.nodes.map(n => ({ n, s: score(n) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  const seeds = ranked.slice(0, Math.min(8, limit)).map(x => x.n.id);
  const seedSet = new Set(seeds);
  const picked = new Set(seeds);
  for (const l of g.links) {
    if (seedSet.has(l.source)) picked.add(l.target);
    if (seedSet.has(l.target)) picked.add(l.source);
  }
  const nodeIds = [...picked].slice(0, limit);
  const idSet = new Set(nodeIds);
  const nodes = g.nodes.filter(n => idSet.has(n.id));
  const links = g.links.filter(l => idSet.has(l.source) && idSet.has(l.target));
  const facts = (g.facts || []).filter(f => idSet.has(f.entityId)).slice(0, 60);
  return {
    ok: true, builtAt: g.builtAt, query: q, seeds: seeds.length, stats,
    nodes, links, facts,
    history: history({ entityId: seeds[0] || null, limit: 10 }).items,
    note: '基于统一图谱的关键词 + 1 跳邻域检索；facts 为当前生效事实，history 为被取代的历史值。'
  };
}

/** 时点查询（bitemporal point-in-time）：系统在 asOf 时刻相信哪些事实 */
function asOf({ at, entityId } = {}) {
  const t = at ? Date.parse(at) : Date.now();
  if (!Number.isFinite(t)) return { ok: false, error: '时间格式无效' };
  const d = readJson(F_GRAPH, null);
  const rows = readJsonl(F_HIST).filter(h => h.kind === 'fact-superseded');
  const active = (d && Array.isArray(d.facts) ? d.facts : []).filter(f => {
    if (entityId && f.entityId !== entityId) return false;
    const va = Date.parse(f.validAt), ia = f.invalidAt ? Date.parse(f.invalidAt) : Infinity;
    const ca = Date.parse(f.createdAt), ea = f.expiredAt ? Date.parse(f.expiredAt) : Infinity;
    return va <= t && t < ia && ca <= t && t < ea;
  });
  const historic = rows.filter(h => {
    if (entityId && h.entityId !== entityId) return false;
    const va = Date.parse(h.oldValidAt), ia = Date.parse(h.invalidatedAt);
    return va <= t && t < ia;
  });
  return {
    ok: true, asOf: new Date(t).toISOString(), model: 'bi-temporal (valid time + transaction time)',
    activeFacts: active.length, historicFacts: historic.length,
    facts: active.slice(0, 200), superseded: historic.slice(0, 100).map(h => ({
      entityId: h.entityId, predicate: h.predicate, oldValue: h.oldValue,
      newValue: h.newValue, validAt: h.oldValidAt, invalidatedAt: h.invalidatedAt, source: h.source
    })),
    note: '双时态：validAt/invalidAt 为事实在现实中的有效期，createdAt/expiredAt 为系统得知的时间。'
  };
}

/** 被更新的历史（append-only） */
/**
 * 展示层去重：append-only 原始流永不删改（保留审计能力），但同一 (keptId, removedId)
 * 合并对在历史里只需展示一次，否则每次重建的重复记录会让智能体误判为「重复计数」。
 * 同一 key 保留最新一条。
 */
function dedupeHistory(rows) {
  const lastIdx = new Map();
  rows.forEach((h, i) => {
    if (h.kind === 'entity-merged' || h.kind === 'manual-merge') {
      lastIdx.set(h.kind + '|' + (h.keptId || h.a) + '|' + (h.removedId || h.b), i);
    }
  });
  return rows.filter((h, i) => {
    if (h.kind !== 'entity-merged' && h.kind !== 'manual-merge') return true;
    const k = h.kind + '|' + (h.keptId || h.a) + '|' + (h.removedId || h.b);
    return lastIdx.get(k) === i;
  });
}

function history({ entityId, kind, limit = 100 } = {}) {
  let rows = readJsonl(F_HIST);
  if (entityId) rows = rows.filter(h => h.entityId === entityId || h.keptId === entityId || h.removedId === entityId);
  if (kind) rows = rows.filter(h => h.kind === kind);
  const deduped = dedupeHistory(rows);
  return { ok: true, total: deduped.length, raw: rows.length,
    items: deduped.slice(-limit).reverse(), file: 'data/knowledge/ug-history.jsonl' };
}

function pending() { return { ok: true, items: readJson(F_PENDING, { items: [] }).items }; }
function resolveMerge({ a, b, action }) {
  const p = readJson(F_PENDING, { items: [] });
  const i = p.items.findIndex(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
  if (i < 0) return { ok: false, error: '未找到待确认项' };
  if (action === 'reject') p.items.splice(i, 1);
  else if (action === 'merge') {
    appendJsonl(F_HIST, { kind: 'manual-merge', at: nowISO(), keptId: a, removedId: b,
      labelA: p.items[i].labelA, labelB: p.items[i].labelB, by: 'user' });
    p.items.splice(i, 1);
  } else return { ok: false, error: 'action 须为 merge|reject' };
  writeJson(F_PENDING, p);
  return { ok: true, action, remaining: p.items.length };
}

function status() {
  const d = readJson(F_GRAPH, null);
  const h = readJsonl(F_HIST);
  const hd = dedupeHistory(h);
  return {
    ok: true, built: !!d, version: d ? d.version : 0, builtAt: d ? d.builtAt : null,
    model: d ? d.model : null, meta: d ? d.meta : null,
    historyEvents: hd.length,
    historyEventsRaw: h.length,
    duplicateMergeEvents: h.length - hd.length,
    factSuperseded: hd.filter(x => x.kind === 'fact-superseded').length,
    entityMerged: hd.filter(x => x.kind === 'entity-merged' || x.kind === 'manual-merge').length,
    pendingMerge: readJson(F_PENDING, { items: [] }).items.length,
    files: { graph: 'data/knowledge/unified-graph.json', history: 'data/knowledge/ug-history.jsonl', aliases: 'data/knowledge/ug-aliases.json' }
  };
}

module.exports = {
  build, graph, query, asOf, history, pending, resolveMerge, status,
  TYPES, LINK_LABEL, similarity, norm,
  F_GRAPH, F_HIST, F_ALIAS, F_PENDING
};
