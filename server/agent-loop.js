'use strict';

/**
 * agent-loop.js — 真正的 Hermes 风格 agent loop（tool calling / tools 回灌）
 *
 * 【与旧实现的本质区别】
 *   旧 /api/v2/chat：把各板块摘要一次性塞进 system prompt → 一次 LLM 调用 → 回答。
 *     模型看不到工具，不能按需取数，也没有「思考时用了什么」的可见轨迹。
 *   新 agent-loop：
 *     system(BASE_SYSTEM + 最小指引) + history(经上下文压缩) + question
 *       → LLM 决定调哪些工具（function calling）
 *       → 逐个执行真实工具（agent-tools.js，含 MCP server）
 *       → 把 tool result 回灌进 messages（tools 回灌）
 *       → 再问模型，直到给出最终答案或到达最大轮次
 *     每一步产出 SSE 事件：thinking / tool.started / tool.completed / delta / done / trace，
 *     前端像 AI-Hel2 那样把「思考过程」与「工具调用时间线」折叠展示。
 *
 * 【对齐 Hermes Agent 官网能力（本项目可落地的部分）】
 *   - agent loop + tool calling           ✅ 本模块
 *   - tools 回灌 / 按需 Pull 数据          ✅ 本模块 + agent-tools.js
 *   - MCP 集成（stdio JSON-RPC 客户端）    ✅ agent-tools.js
 *   - skills 系统                         ✅ hermes-bridge/skills（已在 WSL Hermes 用户技能目录安装）
 *   - 跨会话记忆检索（FTS5）               ✅ search_conversations 工具
 *   - 上下文压缩（免费清理 + 头尾保护）     ✅ data-hygiene.compressContext
 *   - cron 定时任务                       ✅ scheduler.js（既有 9 个任务）
 *   - 会话/多会话 + 历史                   ✅ chat-store.js
 *   - 更新事件流（Push 哨兵）              ✅ update-feed.js
 *   - 思考过程可见化                       ✅ SSE 事件 + 前端 Timeline
 *   - 官方 Hermes TUI / 消息网关 / 子智能体：属于官方 CLI 形态，通过 8765 桥接调用，本项目不重写。
 *
 * 【表达边界（2026-11-24 调整）】
 *   - 取消「不给选股建议 / 不推荐买卖 / 不预测涨跌」的拒答纪律与买卖词硬拦截；
 *     智能体可基于系统真实结果摊开分析，底线改由 BASE_SYSTEM 承担：数据真实、
 *     标注来源时点、区分事实/计算/推测、给证伪条件、风险自担。
 *   - 工具只读，不改任何评分、不写业务数据；输出不再被安全网关改写，仅留审计字段。
 *   - 不伪造思考：thinking 事件只描述「真实发生的动作」与结果摘要；模型若返回
 *     reasoning_content 则原样透传，否则不编造内心独白。
 *   - 每次调用落盘 trace，历史会话可回看「当时用了什么」。
 */

const fs = require('node:fs');
const path = require('node:path');

const agentTools = require('./agent-tools');
const hygiene = require('./data-hygiene');
const hermes = require('./hermes');

const DATA = path.join(__dirname, '..', 'data');
const F_TRACES = path.join(DATA, 'journal', 'agent-traces.jsonl');
const MAX_ROUNDS = 5;
const MAX_TOOL_CALLS = 10;
const TIMEOUT_MS = 120000;

function ensureDir() { fs.mkdirSync(path.dirname(F_TRACES), { recursive: true }); }
function appendTrace(t) { try { ensureDir(); fs.appendFileSync(F_TRACES, JSON.stringify(t) + '\n', 'utf8'); } catch (_) {} }
function short(s, n = 160) { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…' : t; }
function nowISO() { return new Date().toISOString(); }

/* ---------------------------- system 提示 ---------------------------- */

const AGENT_SYSTEM = [
  hermes.BASE_SYSTEM,
  '',
  '【工具使用规则 · Hermes agent loop】',
  '你现在有工具可以按需读取「我的数据」，而不是只依赖一次性注入的快照。',
  '1. 需要具体数字/清单/日期/评分时，必须调用对应工具取证，不要凭印象回答；可以一次调用多个工具。',
  '2. 工具返回值带 source（数据源文件）与 at（时点）；引用时请标注来源与时点，并区分「程序计算」「已发生事实」「你的推测」。',
  '3. 若工具返回 ok:false 或 staleWarning，明确说明数据不可用/陈旧，不要编造替代数字。',
  '4. knowledge_graph_query / knowledge_graph_asof / knowledge_graph_history 可回答实体关系、历史值与「某时点系统相信什么」。',
  '5. 回答末尾用一行「依据：工具名(来源)」列出本轮实际用到的工具，让使用过程可追溯。',
  '6. 工具调用最多 ' + MAX_TOOL_CALLS + ' 次；信息足够就停止调用，直接给结论。若已达上限，系统会基于已取得的数据要求你收尾，此时不要再请求新工具。'
].join('\n');

/* ---------------------------- DeepSeek function calling ---------------------------- */

async function callModel(cfg, messages, tools, opts = {}) {
  const ac = cfg.agent || {};
  const temperature = opts.temperature != null ? opts.temperature : (Number.isFinite(ac.temperature) ? ac.temperature : 0.3);
  const maxTokens = opts.maxTokens != null ? opts.maxTokens : (Number.isFinite(ac.maxTokens) ? ac.maxTokens : 1600);
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : TIMEOUT_MS;
  const key = ac.apiKey || '';
  if (!key || !/^sk-/.test(key)) return { ok: false, error: 'no_api_key' };
  const url = String(ac.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '') + '/chat/completions';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const body = {
      model: ac.model || 'deepseek-chat',
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const res = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, error: 'DeepSeek HTTP ' + res.status + (txt ? ' ' + txt.slice(0, 200) : ''), elapsedMs: Date.now() - t0 };
    }
    const j = await res.json();
    const choice = j && j.choices && j.choices[0];
    const msg = (choice && choice.message) || {};
    return {
      ok: true, message: {
        role: 'assistant',
        content: msg.content == null ? null : String(msg.content),
        tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls : null,
        reasoning_content: msg.reasoning_content || null
      },
      usage: j.usage || null, finishReason: choice && choice.finish_reason,
      model: j.model || ac.model, elapsedMs: Date.now() - t0
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '模型调用超时' : (e.message || String(e)), elapsedMs: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

/* ---------------------------- 主循环 ---------------------------- */

/**
 * @param {object} cfg   全局配置（含 agent.apiKey）
 * @param {object} opts  { question, history, contextHint, sessionId, maxRounds, emit }
 *   emit(event, payload) — SSE 事件回调；若为 null 则只收集、不推送
 * @returns {Promise<object>} { ok, text, backend, trace, usage, elapsedMs }
 */
async function run(cfg, opts = {}) {
  const started = Date.now();
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  const trace = {
    at: nowISO(), sessionId: opts.sessionId || null, question: short(opts.question || '', 200),
    backend: 'agent-loop/deepseek-function-calling', rounds: 0,
    tools: [], usage: [], model: (cfg.agent && cfg.agent.model) || 'deepseek-chat',
    contextCompressed: false, mcpUsed: false, status: 'running'
  };
  const fire = (event, payload) => { try { emit(event, payload); } catch (_) {} };

  try {
    // ① 构造初始消息：历史经上下文压缩（Hermes「免费清理」+ 头尾保护）
    const rawHistory = Array.isArray(opts.history) ? opts.history.slice(-20) : [];
    const comp = hygiene.compressContext(rawHistory.map(m => ({ role: m.role, content: m.content })),
      { maxChars: 9000, headKeep: 2, tailChars: 2200 });
    trace.contextCompressed = comp.compressed;
    trace.contextStats = { originalChars: comp.originalChars, outputChars: comp.outputChars, placeholders: comp.placeholders };
    const messages = [{ role: 'system', content: AGENT_SYSTEM }];
    if (opts.contextHint) messages.push({ role: 'system', content: '【本轮补充上下文】' + short(opts.contextHint, 1200) });
    for (const m of comp.messages) messages.push({ role: m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user'), content: String(m.content || '') });
    messages.push({ role: 'user', content: String(opts.question || '').slice(0, 4000) });

    // ② 工具清单（含 MCP server 工具）
    const tools = await agentTools.schemas({ includeMcp: true });
    trace.toolCount = tools.length;
    fire('thinking', { text: '已装载 ' + tools.length + ' 个数据工具（含 Hermes MCP server），开始按需取证…', phase: 'init' });

    let finalText = '';
    let calls = 0;
    const maxRounds = Math.min(MAX_ROUNDS, Math.max(1, Number(opts.maxRounds) || MAX_ROUNDS));

    // ③ agent loop
    for (let round = 1; round <= maxRounds; round++) {
      trace.rounds = round;
      fire('thinking', { text: '第 ' + round + ' 轮推理：' + (round === 1 ? '判断需要哪些数据' : '消化工具结果并判断是否还需补充'), phase: 'round', round });
      const r = await callModel(cfg, messages, tools, {});
      if (!r.ok) {
        trace.status = 'model-error'; trace.error = r.error;
        fire('error', { message: r.error });
        break;
      }
      trace.usage.push({ round, ...(r.usage || {}), elapsedMs: r.elapsedMs });
      const m = r.message;

      // 透传模型真实思考内容（若有），不编造
      if (m.reasoning_content) fire('reasoning', { text: short(m.reasoning_content, 4000), round });

      if (!m.tool_calls || !m.tool_calls.length) {
        finalText = String(m.content || '').trim();
        fire('delta', { text: finalText, round });
        break;
      }

      // 把 assistant 的 tool_calls 加入 messages（严格 OpenAI 格式）
      messages.push({
        role: 'assistant', content: m.content || null,
        tool_calls: m.tool_calls.map(tc => ({
          id: tc.id, type: 'function',
          function: { name: tc.function && tc.function.name, arguments: String((tc.function && tc.function.arguments) || '{}') }
        }))
      });

      // ④ 逐个执行工具 → 真实 trace → 结果回灌
      // 【关键协议约束】assistant(tool_calls) 之后，必须为「每一个」tool_call_id 回灌一条
      // role:'tool' 消息。若因工具预算上限直接 break，消息序列会缺 tool 消息，下一轮请求
      // 会被 DeepSeek 以 HTTP 400 "insufficient tool messages following tool_calls" 拒绝。
      for (let ti = 0; ti < m.tool_calls.length; ti++) {
        const tc = m.tool_calls[ti];
        const name = (tc.function && tc.function.name) || 'unknown';
        const callId = tc.id || ('tc-' + round + '-' + ti);

        if (calls >= MAX_TOOL_CALLS) {
          // 预算耗尽：工具不执行，但仍回灌一条明确的 tool 消息以保持协议合法，
          // 并让模型知道该数据没取到、应基于已有取证结果收尾（不得编造结果）。
          messages.push({
            role: 'tool', tool_call_id: callId,
            content: JSON.stringify({
              error: 'tool_budget_exhausted', name,
              message: '工具调用预算已用尽（' + MAX_TOOL_CALLS + ' 次），此工具未执行；请基于已取得的数据直接给出结论，不要编造该工具的结果。'
            })
          });
          continue;
        }

        let args = {};
        try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (_) {}
        trace.tools.push({ callId, name, args: hygiene.compressContext ? short(JSON.stringify(args), 200) : '', round, status: 'running' });
        fire('tool.started', { callId, tool: name, label: toolLabel(name, args), args, round });

        const out = await agentTools.execute(name, args);
        calls++;
        const rec = trace.tools[trace.tools.length - 1];
        rec.status = out.ok ? 'completed' : 'error';
        rec.elapsedMs = out.elapsedMs;
        rec.source = out.source || null;
        rec.resultSummary = out.ok ? short(JSON.stringify(out.data), 220) : short(out.error, 160);
        rec.mcp = !!out.mcpServer;
        if (out.mcpServer) trace.mcpUsed = true;
        fire('tool.completed', {
          callId, tool: name, status: rec.status, elapsedMs: rec.elapsedMs,
          source: rec.source, resultSummary: rec.resultSummary, mcp: rec.mcp, round
        });

        // 工具结果回灌（压缩后，避免上下文膨胀）
        let toolText = JSON.stringify(out.ok ? out.data : { error: out.error });
        if (toolText.length > 6000) toolText = toolText.slice(0, 6000) + '…(工具结果已截断，可用更小参数重新查询)';
        messages.push({ role: 'tool', tool_call_id: callId, content: toolText });
      }

      // ⑤ 预算或轮次到达上限：不再向模型提供工具，直接要求基于已取证结果收尾。
      //    既避免再次产生未被回灌的 tool_calls，也保证复杂提问一定能给出最终回答。
      const needFinalize = calls >= MAX_TOOL_CALLS || round === maxRounds;
      if (needFinalize) {
        const why = calls >= MAX_TOOL_CALLS
          ? '工具调用已达上限（' + MAX_TOOL_CALLS + ' 次）'
          : '已达最大推理轮次（' + maxRounds + ' 轮）';
        fire('thinking', { text: why + '，基于已取证数据收尾…', phase: 'finalize', round });
        const fin = await callModel(cfg, messages, null, {});
        if (fin.ok) { finalText = String(fin.message.content || '').trim(); fire('delta', { text: finalText, round }); }
        else {
          trace.status = 'model-error'; trace.error = fin.error;
          fire('error', { message: fin.error });
        }
        break;
      }
    }

    // ⑥ 输出合规状态（按使用者要求取消「买卖词硬拦截 / 拒答纪律」）
    // 不再因出现"买入/卖出/标的"等词替换文本或报错；底线由 AGENT_SYSTEM / BASE_SYSTEM 承担：
    // 数据真实、可追溯、区分事实与推测、标注证伪条件、风险自担。此处仅记录状态供 trace 审计。
    let text = finalText;
    const bad = hermes.hasForbidden(text);   // 现行实现恒返回 []，保留调用以便日后按需恢复
    if (bad.length) {
      trace.flaggedWords = bad;              // 仅记录，不拦截、不改写回答
    } else if (trace.status === 'running') trace.status = 'ok';

    // ⑦ 收尾：落盘 trace + done 事件
    trace.elapsedMs = Date.now() - started;
    trace.toolCalls = calls;
    trace.finishedAt = nowISO();
    appendTrace(trace);
    fire('trace', { trace: compactTrace(trace) });
    fire('done', { ok: !!(text && trace.status !== 'model-error'), elapsedMs: trace.elapsedMs, toolCalls: calls });
    return {
      ok: !!(text && trace.status !== 'model-error'),
      text, backend: 'agent-loop/deepseek-function-calling',
      trace: compactTrace(trace), elapsedMs: trace.elapsedMs,
      toolCalls: calls, status: trace.status,
      error: trace.error || null
    };
  } catch (e) {
    trace.status = 'error'; trace.error = e.message; trace.elapsedMs = Date.now() - started;
    appendTrace(trace);
    fire('error', { message: e.message });
    return { ok: false, error: e.message, backend: 'agent-loop', trace: compactTrace(trace) };
  }
}

function toolLabel(name, args) {
  const map = {
    market_snapshot: '每日行情快照', sector_board: '板块强度', screener_results: '四类选股结果',
    strategy_view: '策略视图/双池', sentiment_board: '短线情绪三项', policy_news: '政策快讯',
    calendar_events: '日程与事件', my_portfolio: '我的股池', stock_analysis: '个股量化评分',
    knowledge_graph_query: '知识图谱检索', knowledge_graph_asof: '图谱时点回溯',
    knowledge_graph_history: '图谱更新历史', search_conversations: '历史会话检索',
    update_feed: '更新事件流', hygiene_report: '数据质量报告', future_events: '未来事件扫描',
    event_history: '事件历史统计'
  };
  if (map[name]) return map[name];
  if (name.startsWith('mcp_')) return 'MCP · ' + name.slice(4);
  return name;
}

function compactTrace(t) {
  return {
    at: t.at, status: t.status, backend: t.backend, model: t.model,
    rounds: t.rounds, toolCount: t.toolCount, toolCalls: t.toolCalls,
    elapsedMs: t.elapsedMs, mcpUsed: t.mcpUsed, contextCompressed: t.contextCompressed,
    contextStats: t.contextStats, usage: t.usage, error: t.error || null,
    tools: t.tools.map(x => ({ name: x.name, label: toolLabel(x.name, x.args), args: x.args,
      status: x.status, elapsedMs: x.elapsedMs, source: x.source, resultSummary: x.resultSummary, mcp: x.mcp, round: x.round }))
  };
}

/** 历史轨迹（供前端「当时用了什么」回看） */
function traces({ limit = 30, sessionId } = {}) {
  if (!fs.existsSync(F_TRACES)) return { ok: true, total: 0, items: [] };
  let rows = fs.readFileSync(F_TRACES, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    .map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
  if (sessionId) rows = rows.filter(r => r.sessionId === sessionId);
  return { ok: true, total: rows.length, items: rows.slice(-limit).reverse().map(compactTrace) };
}

function status() {
  return {
    ok: true, engine: 'agent-loop (function calling + tools 回灌)',
    maxRounds: MAX_ROUNDS, maxToolCalls: MAX_TOOL_CALLS,
    traceFile: 'data/journal/agent-traces.jsonl',
    note: '思考过程/工具调用均为真实执行轨迹，不编造模型内心独白。'
  };
}

module.exports = { run, traces, status, AGENT_SYSTEM, toolLabel };
