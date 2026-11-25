'use strict';

/**
 * agent-tools.js — 智能体工具注册表（让 Hermes 能「感知我的数据」）
 *
 * 与旧架构的区别：
 *   旧：Node 把各板块摘要一次性塞进 prompt（Push），模型只能被动读，看不到工具、无法按需取数。
 *   新：把每个板块 + 统一知识图谱 + 历史会话 + 更新流注册成 function-calling 工具（Pull），
 *       由 agent loop 决定调什么、调几次；每次调用都有真实 trace（工具/参数/耗时/结果摘要/来源）。
 *
 * 工具分两类：
 *   - 本地工具：直接读本项目已落盘的真实数据（只读，绝不写业务数据、绝不改评分）
 *   - MCP 工具：通过 stdio JSON-RPC 调 hermes-bridge/mcp-market-modules.js（MCP 客户端落地）
 *
 * 纪律：所有工具只读；返回体带 source 与时点；禁止买卖建议、禁止编造数字。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const MCP_SCRIPT = path.join(ROOT, 'hermes-bridge', 'mcp-market-modules.js');
const NODE_BIN = process.execPath;

function jread(rel, fb) { try { const f = path.join(DATA, rel); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} return fb; }
function short(v, n) { const s = typeof v === 'string' ? v : JSON.stringify(v); return s == null ? '' : (s.length > n ? s.slice(0, n) + '…' : s); }
function compact(v, depth = 0) {
  if (v == null) return null;
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  if (typeof v === 'string') return v.length > 180 ? v.slice(0, 180) + '…' : v;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 10).map(x => compact(x, depth + 1));
  if (typeof v === 'object') {
    const entries = Object.entries(v).filter(([k]) => !['config', 'errors', 'sourceLatency', 'dataNote', 'history'].includes(k));
    // 小型标量字典（如 graph.byType 类型分布、stats 计数）不做深度截断，
    // 否则第 4 层的统计对象会被压成 '[对象]'，智能体就拿不到节点类型分布了。
    const scalarOnly = entries.length > 0 && entries.length <= 24 && entries.every(([, val]) =>
      val == null || ['number', 'string', 'boolean'].includes(typeof val));
    if (scalarOnly) {
      const o = {};
      for (const [k, val] of entries) {
        o[k] = typeof val === 'number' ? Math.round(val * 100) / 100
          : (typeof val === 'string' && val.length > 180 ? val.slice(0, 180) + '…' : val);
      }
      return o;
    }
    if (depth >= 3) return '[对象]';
    const o = {};
    for (const [k, val] of entries) o[k] = compact(val, depth + 1);
    return o;
  }
  return null;
}
function result(data, source, at, extra = {}) {
  return { ok: true, source, at: at || null, data, ...extra };
}
function fail(msg) { return { ok: false, error: String(msg) }; }

/* ---------------------------- MCP 客户端（stdio JSON-RPC） ---------------------------- */

class MCPClient {
  constructor(script) {
    this.script = script;
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.buf = '';
    this.tools = null;
    this.lastError = null;
  }
  start() {
    if (this.child && !this.child.killed) return true;
    if (!fs.existsSync(this.script)) { this.lastError = 'MCP 脚本不存在：' + this.script; return false; }
    try {
      this.child = spawn(NODE_BIN, [this.script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', chunk => {
        this.buf += chunk;
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id != null && this.pending.has(msg.id)) {
              const { resolve, timer } = this.pending.get(msg.id);
              clearTimeout(timer); this.pending.delete(msg.id); resolve(msg);
            }
          } catch (_) {}
        }
      });
      this.child.stderr.on('data', d => { this.lastError = String(d).slice(0, 200); });
      this.child.on('exit', () => { this.child = null; this.buf = ''; });
      return true;
    } catch (e) { this.lastError = e.message; return false; }
  }
  request(method, params, timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (!this.start()) return resolve({ error: { message: this.lastError } });
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: { message: 'MCP 调用超时' } }); }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); resolve({ error: { message: e.message } }); }
    });
  }
  async init() {
    const r = await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gmm-agent-loop', version: '1.0' } });
    if (r.error) return { ok: false, error: r.error.message };
    await this.request('notifications/initialized', {});
    const l = await this.request('tools/list', {});
    this.tools = (l.result && l.result.tools) || [];
    return { ok: true, serverInfo: r.result && r.result.serverInfo, tools: this.tools.map(t => t.name) };
  }
  async call(name, args) {
    const r = await this.request('tools/call', { name, arguments: args || {} }, 12000);
    if (r.error) return fail(r.error.message);
    const c = r.result && r.result.content;
    if (Array.isArray(c)) return { ok: !(r.result && r.result.isError), text: c.map(x => x.text || '').join('\n'), isError: !!(r.result && r.result.isError) };
    return { ok: true, raw: r.result };
  }
  stop() { try { if (this.child) this.child.kill(); } catch (_) {} this.child = null; }
}

const mcp = new MCPClient(MCP_SCRIPT);

/* ---------------------------- 本地工具实现 ---------------------------- */

const LOCAL = {
  market_snapshot: {
    description: '读取每日行情：两市量能/市场风格、涨跌宽度、涨停结构。需要回答大盘、量能、风格时调用。',
    schema: { type: 'object', properties: { detail: { type: 'string', enum: ['brief', 'full'], description: 'brief=摘要，full=尽量完整' } } },
    run: ({ detail }) => {
      const ms = jread('market-style.json', null), mb = jread('market-breadth.json', null), lu = jread('limitup-cache.json', null);
      if (!ms && !mb) return fail('行情快照暂无数据');
      return result({
        style: ms ? compact({ generatedAt: ms.generatedAt, tradingDate: ms.tradingDate,
          volume: ms.volume, dominant: ms.dominant, dominantLabel: ms.dominantLabel,
          conclusion: ms.confidence, ranked: detail === 'full' ? ms.ranked : undefined }) : null,
        breadth: mb ? compact(mb) : null,
        limitup: lu ? compact({ date: lu.date, zt: (lu.zt || []).length, zb: (lu.zb || []).length, dt: lu.dtCount, warnings: lu.warnings }) : null
      }, 'market-style.json / market-breadth.json / limitup-cache.json', (ms && ms.generatedAt) || null);
    }
  },
  sector_board: {
    description: '读取板块强度与领跑/跟随：板块排名、5日涨幅、超额、宽度。需要回答哪个板块强/轮动时调用。',
    schema: { type: 'object', properties: { top: { type: 'number', description: '返回前 N 个板块，默认 10' } } },
    run: ({ top }) => {
      const s = jread('strength-cache.json', null);
      const pi = jread('pick-insight.json', null);
      return result({
        leaders: compact((s && s.leaders || []).slice(0, Math.min(20, top || 10))),
        note: s ? (s.note || null) : 'strength-cache 未就绪或已陈旧',
        cachedAt: s ? (s.generatedAt || s.at || null) : null,
        insightLeaders: pi ? compact((pi.leaders || []).slice(0, 8)) : null
      }, 'strength-cache.json / pick-insight.json', s ? (s.generatedAt || s.at || null) : null,
      { staleWarning: s && s.generatedAt && (Date.now() - Date.parse(s.generatedAt)) / 86400e3 > 4 ? '板块强度缓存超过 4 天未更新，请在回答中提示数据陈旧' : null });
    }
  },
  screener_results: {
    description: '读取四类量化选股结果：趋势 / 低吸 / 打板 / 趋势突破。需要回答"选出了哪些股/各策略命中"时调用。',
    schema: { type: 'object', properties: { kind: { type: 'string', enum: ['all', 'trend', 'dip', 'board', 'breakout'], description: '策略类别，默认 all' }, limit: { type: 'number' } } },
    run: ({ kind, limit }) => {
      const files = { trend: 'trend-screen.json', dip: 'dip-screen.json', board: 'board-screen.json', breakout: 'breakout-screen.json' };
      const want = kind && kind !== 'all' ? [kind] : Object.keys(files);
      const out = {};
      for (const k of want) {
        const d = jread(files[k], null);
        out[k] = d ? { at: d.generatedAt, count: (d.items || []).length,
          items: (d.items || []).slice(0, Math.min(30, limit || 12)).map(x => compact({ code: x.code, name: x.name, score: x.score, industry: x.industry, signals: x.signals, reason: x.reason })) } : { available: false };
      }
      return result(out, Object.values(files).join(' / '), null,
        { note: '四类选股为程序按固定规则计算，仅为研究清单，不是推荐；回答中不得表述为买卖建议。' });
    }
  },
  strategy_view: {
    description: '读取策略视图：四类选股合并结果、次日备选观察池、风险规避池、板块领跑与跟随、情绪提示。',
    schema: { type: 'object', properties: { section: { type: 'string', enum: ['all', 'pools', 'fourClass', 'leaders'], description: '默认 all' } } },
    run: ({ section }) => {
      const d = jread('strategy.json', null);
      if (!d || !d.ok) return fail('策略视图暂无数据');
      const fc = d.fourClass || {}, p = d.pools || {}, s = section || 'all';
      const out = { at: d.generatedAt, disclaimer: d.disclaimer };
      if (s === 'all' || s === 'fourClass') out.fourClass = { counts: fc.counts, totalRows: fc.totalRows,
        items: (fc.items || []).slice(0, 16).map(x => compact({ code: x.code, name: x.name, classes: x.classes, kindLabel: x.kindLabel, industry: x.industry, role: x.role, score: x.score, driverSummary: x.driverSummary })) };
      if (s === 'all' || s === 'pools') out.pools = {
        watch: (p.watchPool || []).slice(0, 16).map(x => compact({ code: x.code, name: x.name, why: x.why })),
        risk: (p.riskPool || []).slice(0, 16).map(x => compact({ code: x.code, name: x.name, riskType: x.riskType, reason: x.reason })),
        alerts: p.alerts, note: p.note
      };
      if (s === 'all' || s === 'leaders') out.leaders = (fc.leaders || []).slice(0, 12).map(x => compact(x));
      return result(out, 'strategy.json', d.generatedAt);
    }
  },
  sentiment_board: {
    description: '读取短线情绪三项：赚钱效应、连板高度、炸板率，以及程序给出的情绪小结。',
    schema: { type: 'object', properties: {} },
    run: () => {
      const d = jread('sentiment.json', null);
      if (!d || !d.ok) return fail('情绪数据暂无');
      return result(compact({ date: d.date, moneyEffect: d.moneyEffect, boardHeight: d.boardHeight,
        breakRate: d.breakRate, shortTerm: d.shortTerm, disclaimer: d.disclaimer }), 'sentiment.json', d.generatedAt);
    }
  },
  policy_news: {
    description: '读取政策与监管快讯（按关键词权重筛选、标注来源与时点），以及新闻主题板块。',
    schema: { type: 'object', properties: { limit: { type: 'number', description: '默认 12 条' } } },
    run: ({ limit }) => {
      const d = jread('news-pulse.json', null);
      if (!d) return fail('新闻脉冲暂无数据');
      return result({
        at: d.at, newsCount: d.newsCount, policyCount: d.policyCount, alertCount: d.alertCount,
        policyNews: (d.policyNews || []).slice(0, Math.min(30, limit || 12)).map(n => compact({ title: n.title, time: n.time, source: n.source, importance: n.importance, category: n.category, reason: n.reason, desc: n.desc })),
        sectors: (d.sectors || []).slice(0, 12).map(s => compact(s))
      }, 'news-pulse.json', d.at,
      { note: '政策标签只表示命中监管/宏观关键词，不代表涨跌方向；回答须区分事实与推测。' });
    }
  },
  calendar_events: {
    description: '读取未来日程与事件（含美国 PCE、初请、议息等宏观时点，以及入历的新闻事件）。',
    schema: { type: 'object', properties: { days: { type: 'number', description: '未来天数，默认 45' } } },
    run: ({ days }) => {
      try {
        const cal = require('./calendar');
        const evs = cal.upcoming({ days: Math.min(365, Math.max(1, Number(days) || 45)) }).slice(0, 20);
        return result({ count: evs.length, items: evs.map(e => compact({ name: e.name, date: e.date, grade: e.grade,
          daysTo: e.daysTo, categories: e.categories, sectors: e.sectors, verified: e.verified, source: e.source })) },
          'calendar (upcoming)', null, { note: 'verified=false 或 dateBasis=relative 的条目须提示"待核实"' });
      } catch (e) { return fail(e.message); }
    }
  },
  my_portfolio: {
    description: '读取「我的股池」双分区：今天上午确定的（持仓/冻结池）与我的选股（自选）。',
    schema: { type: 'object', properties: {} },
    run: () => {
      try {
        const pv = require('./portfolio').view();
        return result({
          todayConfirmed: compact((pv.watching && pv.watching.holdings || []).slice(0, 30)),
          myPicks: compact((pv.watching && pv.watching.picks || []).slice(0, 30)),
          sold: compact((pv.sold || []).slice(0, 10)),
          counts: { todayConfirmed: (pv.watching && pv.watching.holdings || []).length, myPicks: (pv.watching && pv.watching.picks || []).length }
        }, 'portfolio.view() / holdings.json / my-picks.json', null);
      } catch (e) { return fail(e.message); }
    }
  },
  stock_analysis: {
    description: '按 6 位股票代码读取个股常规量化评分（0-100）与技术指标（MA/MACD/RSI/KDJ/量比/位置）及风险提示。',
    schema: { type: 'object', properties: { code: { type: 'string', description: '6 位 A 股代码，如 300721' } }, required: ['code'] },
    run: ({ code }) => {
      const c = String(code || '').trim();
      if (!/^\d{6}$/.test(c)) return fail('需要 6 位股票代码');
      try {
        const sa = require('./stock-analysis');
        // 同步读已落盘结果；若无则用程序现算（analyzeOne 是 async，这里只取缓存）
        const cached = jread('stocks-cache.json', null);
        const item = cached && Array.isArray(cached.items) ? cached.items.find(x => x.code === c) : null;
        if (item) return result(compact(item), 'stocks-cache.json', cached.generatedAt || null,
          { note: '评分为程序固定公式测算，可如实引用数值；不是涨跌预测或买卖建议。' });
        return result({ code: c, hint: '缓存中无该股，可用 knowledge_graph_query 查询该股在图谱中的入选记录与关联板块' },
          'stocks-cache.json（未命中）', null);
      } catch (e) { return fail(e.message); }
    }
  },
  knowledge_graph_query: {
    description: '在统一知识图谱中检索：输入关键词，返回相关实体、1 跳邻居、当前生效事实与被取代的历史值；同时返回图谱整体统计（节点总数、各类型节点数 byType、关系数、事实数）。不传 q 时只返回统计。所有板块数据都已纳入此图。',
    schema: { type: 'object', properties: { q: { type: 'string', description: '关键词（股票名/代码/板块/概念/事件/指标）；留空则返回图谱整体统计' }, limit: { type: 'number' } } },
    run: ({ q, limit }) => {
      try {
        const r = require('./unified-graph').query({ q, limit: Math.min(60, limit || 24) });
        if (!r.ok) return fail(r.error);
        return result({
          query: r.query, seeds: r.seeds, graphStats: r.stats || null,
          nodes: r.nodes.map(n => ({ id: n.id, label: n.label, type: n.type, status: n.status, validAt: n.validAt, props: compact(n.props) })),
          links: r.links.map(l => ({ source: l.source, target: l.target, type: l.type, label: l.label })),
          facts: r.facts.map(f => ({ entityId: f.entityId, predicate: f.predicate, value: short(f.value, 80), validAt: f.validAt, source: f.source })),
          supersededHistory: r.history.filter(h => h.kind === 'fact-superseded' || h.kind === 'fact-expired').slice(0, 8)
            .map(h => ({ entityId: h.entityId, predicate: h.predicate, oldValue: h.oldValue, newValue: h.newValue || null, invalidatedAt: h.invalidatedAt || h.at })),
          note: r.note
        }, 'unified-graph.query()', r.builtAt);
      } catch (e) { return fail(e.message); }
    }
  },
  knowledge_graph_asof: {
    description: '双时态时点回溯：回答「系统在某时刻相信什么」，返回该时刻生效的事实与已被取代的旧事实。',
    schema: { type: 'object', properties: { at: { type: 'string', description: 'ISO 时间，如 2026-11-20T10:00:00Z；留空为现在' }, entityId: { type: 'string' } } },
    run: ({ at, entityId }) => {
      try {
        const r = require('./unified-graph').asOf({ at, entityId });
        if (!r.ok) return fail(r.error);
        return result({ asOf: r.asOf, model: r.model, activeFacts: r.activeFacts, historicFacts: r.historicFacts,
          facts: r.facts.slice(0, 40).map(f => ({ entityId: f.entityId, predicate: f.predicate, value: short(f.value, 70), validAt: f.validAt })),
          superseded: r.superseded.slice(0, 20), note: r.note }, 'unified-graph.asOf()', r.asOf);
      } catch (e) { return fail(e.message); }
    }
  },
  knowledge_graph_history: {
    description: '读取知识图谱的更新历史：哪些事实被新值取代、哪些实体被合并、哪些事实因消失而失效。用于回答"这个信息以前是什么/什么时候改过"。',
    schema: { type: 'object', properties: { entityId: { type: 'string' }, kind: { type: 'string', enum: ['', 'fact-superseded', 'fact-expired', 'entity-merged', 'build'] }, limit: { type: 'number' } } },
    run: ({ entityId, kind, limit }) => {
      try {
        const r = require('./unified-graph').history({ entityId: entityId || undefined, kind: kind || undefined, limit: Math.min(100, limit || 30) });
        return result({ total: r.total, items: r.items.map(h => ({ kind: h.kind, at: h.at, entityId: h.entityId,
          predicate: h.predicate, oldValue: h.oldValue, newValue: h.newValue,
          keptId: h.keptId, removedId: h.removedId, source: h.source })) }, 'ug-history.jsonl', null);
      } catch (e) { return fail(e.message); }
    }
  },
  search_conversations: {
    description: '检索历史对话（SQLite FTS5 中文子串搜索）：跨会话找回之前讨论过的结论、偏好与决策。',
    schema: { type: 'object', properties: { q: { type: 'string', description: '搜索词' }, limit: { type: 'number' } }, required: ['q'] },
    run: ({ q, limit }) => {
      try {
        const rows = require('./chat-store').search(String(q || ''), Math.min(30, limit || 10)) || [];
        const hits = (Array.isArray(rows) ? rows : (rows.items || rows.hits || [])).map(x => ({
          sessionId: x.sessionId, sessionTitle: x.sessionTitle, role: x.role,
          content: short(x.content, 260), at: x.ts ? new Date(x.ts).toISOString() : null
        }));
        return result({ hits, total: hits.length, query: q }, 'chat.db (FTS5 trigram)', null);
      } catch (e) { return fail(e.message); }
    }
  },
  update_feed: {
    description: '读取各板块真实更新事件流（哪些模块在什么时间更新了什么），用于回答"最近有什么新变化"。',
    schema: { type: 'object', properties: { view: { type: 'string', description: 'calendar/market/portfolio/chat/knowledge/settings，留空为全部' }, limit: { type: 'number' } } },
    run: ({ view, limit }) => {
      try {
        const r = require('./update-feed').feed({ view: view || undefined, limit: Math.min(60, limit || 20) });
        return result({ items: (r.items || []).map(x => ({ at: x.at, view: x.view, module: x.module,
          title: x.title, detail: short(x.detail, 100), source: x.source, isNew: x.isNew })), unseen: r.unseen },
          'update-feed.json', null);
      } catch (e) { return fail(e.message); }
    }
  },
  hygiene_report: {
    description: '读取垃圾信息/数据质量报告：陈旧缓存、重复新闻、孤岛节点、死链、非交易日脏数据等，回答里应提示数据可信度。',
    schema: { type: 'object', properties: {} },
    run: () => {
      try {
        const r = require('./data-hygiene').report();
        return result({ total: r.total, health: r.health, byRule: r.byRule, bySeverity: r.bySeverity,
          top: (r.items || []).slice(0, 12).map(x => ({ severity: x.severity, rule: x.rule, message: x.message })) },
          'hygiene-report.json', r.at);
      } catch (e) { return fail(e.message); }
    }
  },
  future_events: {
    description: '读取未来事件扫描报告（新闻里有确定时点、且对股市有影响的内容入历覆盖率、待复核队列）。',
    schema: { type: 'object', properties: {} },
    run: () => {
      try {
        const r = require('./future-events').report();
        return result(compact(r), 'calendar/future-events-scan.json', r && (r.generatedAt || r.scannedAt));
      } catch (e) { return fail(e.message); }
    }
  },
  event_history: {
    description: '查询某类事件近 2 年的历史统计（T+1/T+3/T+5 超额与胜率），自动标注低样本。',
    schema: { type: 'object', properties: { ruleId: { type: 'string', description: '事件规则 ID，如 cn-medicare' } }, required: ['ruleId'] },
    run: ({ ruleId }) => {
      const d = jread('calendar/event-study.json', null) || jread('agent-perception/event-study.json', null);
      if (!d) return fail('事件研究数据暂无');
      const rules = ((d.data || d).rules || []).filter(r => r.ruleId === ruleId);
      if (!rules.length) return fail('未找到该规则：' + ruleId);
      return result(compact(rules[0]), 'event-study.json', d.generatedAt || null,
        { note: '低样本(<8)仅供参考，不可外推。' });
    }
  }
};

/* ---------------------------- MCP 工具（包装） ---------------------------- */

async function mcpTools() {
  if (!mcp.tools) { const r = await mcp.init(); if (!r.ok) return []; }
  // 加 mcp_ 前缀后与本地工具不冲突，全部暴露（体现 Hermes MCP 集成的完整工具面）
  return (mcp.tools || []).map(t => ({
    name: 'mcp_' + t.name,
    description: '[MCP server: market_modules] ' + (t.description || t.name),
    schema: t.inputSchema || { type: 'object', properties: {} },
    run: async (args) => {
      const r = await mcp.call(t.name, args);
      if (!r.ok) return fail(r.text || r.error || 'MCP 调用失败');
      let data = r.text || '';
      try { data = JSON.parse(r.text); } catch (_) {}
      return result(compact(data), 'MCP:market_modules/' + t.name, null,
        { mcpServer: 'market_modules', note: '数据来自 Hermes 已挂载的 MCP server（agent-perception 快照）。' });
    }
  }));
}

/* ---------------------------- 注册表 ---------------------------- */

let cachedSchemas = null;

/** 返回 OpenAI function-calling 格式的 tools（含 MCP 工具） */
async function schemas({ includeMcp = true } = {}) {
  const local = Object.entries(LOCAL).map(([name, t]) => ({
    type: 'function',
    function: { name, description: t.description, parameters: t.schema || { type: 'object', properties: {} } }
  }));
  let ext = [];
  if (includeMcp) {
    try { ext = (await mcpTools()).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })); }
    catch (_) {}
  }
  cachedSchemas = [...local, ...ext];
  return cachedSchemas;
}

/** 执行一个工具，返回 {ok, data, source, at, elapsedMs} */
async function execute(name, args = {}) {
  const t0 = Date.now();
  let out;
  const local = LOCAL[name];
  if (local) {
    try { out = await local.run(args || {}); } catch (e) { out = fail(e.message); }
  } else if (name.startsWith('mcp_')) {
    const real = name.slice(4);
    const r = await mcp.call(real, args || {});
    if (!r.ok) out = fail(r.text || r.error || 'MCP 调用失败');
    else { let d = r.text; try { d = JSON.parse(r.text); } catch (_) {} out = result(compact(d), 'MCP:market_modules/' + real, null, { mcpServer: 'market_modules' }); }
  } else out = fail('未知工具：' + name);
  const elapsedMs = Date.now() - t0;
  return { ...out, tool: name, elapsedMs, args: compact(args, 2) };
}

/** 工具清单（供状态页/思考轨迹说明） */
async function list({ includeMcp = true } = {}) {
  const s = await schemas({ includeMcp });
  return { ok: true, count: s.length, tools: s.map(x => ({ name: x.function.name, description: x.function.description })),
    local: Object.keys(LOCAL).length, mcp: s.length - Object.keys(LOCAL).length,
    mcpStatus: mcp.tools ? { connected: true, server: 'market_modules' } : { connected: false, lastError: mcp.lastError } };
}

function stop() { mcp.stop(); }

module.exports = { schemas, execute, list, stop, LOCAL, MCPClient };
