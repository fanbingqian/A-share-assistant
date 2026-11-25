'use strict';
/**
 * mcp-market-modules.js — 极简 MCP stdio 服务（零依赖）
 *
 * 让 Hermes 通过 function-calling / MCP 按需读取模块快照，
 * 而不是依赖 Node 把全部数据预先塞进提示词。
 *
 * 工具：
 *   market_snapshot(module)  读取单个模块快照
 *   market_bundle(maxChars)  读取全部快照的紧凑摘要
 *   event_history(ruleId)    查询某类事件的历史统计
 */

const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');

const BASE = path.resolve(__dirname, '..', 'data', 'agent-perception');
const MODULES = ['manifest', 'market', 'sectors', 'picks', 'calendar', 'event-study', 'knowledge', 'predictions'];

function read(name) {
  if (!MODULES.includes(name)) throw new Error('未知模块：' + name);
  const f = path.join(BASE, name + '.json');
  if (!fs.existsSync(f)) throw new Error('快照不存在：' + name + '（请先 POST /api/v2/agent/perception/refresh）');
  return fs.readFileSync(f, 'utf8');
}
function okText(text) { return { content: [{ type: 'text', text }], isError: false }; }
function errText(e) { return { content: [{ type: 'text', text: String(e && e.message || e) }], isError: true }; }

const TOOLS = [
  {
    name: 'market_snapshot',
    description: '按需读取一个模块快照 JSON（两市行情/板块/选股/日程/事件研究/知识库/预测账本）。',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', enum: MODULES, description: '模块名' }
      },
      required: ['module']
    }
  },
  {
    name: 'market_bundle',
    description: '一次性读取所有模块快照的紧凑摘要；仅在问题跨多个模块时使用。',
    inputSchema: {
      type: 'object',
      properties: { maxChars: { type: 'number', description: '总字数上限，默认 12000' } }
    }
  },
  {
    name: 'event_history',
    description: '查询某类事件近2年的历史统计（T+1/T+3/T+5 超额与胜率），自动标注低样本。',
    inputSchema: {
      type: 'object',
      properties: { ruleId: { type: 'string', description: '事件规则 ID，如 cn-medicare' } },
      required: ['ruleId']
    }
  }
];

function callTool(name, args) {
  try {
    if (name === 'market_snapshot') return okText(read(String((args || {}).module || '')));
    if (name === 'market_bundle') {
      const max = Math.min(40000, Math.max(2000, Number((args || {}).maxChars) || 12000));
      const parts = [];
      const files = MODULES.filter(m => m !== 'manifest');
      const each = Math.floor(max / files.length);
      for (const m of files) {
        try {
          const j = JSON.parse(read(m));
          let s = JSON.stringify(j.data);
          if (s.length > each) s = s.slice(0, each) + '…(截断)';
          parts.push('【' + m + '｜' + (j.generatedAt || '') + '】\n' + s);
        } catch (e) { parts.push('【' + m + '】不可用：' + e.message); }
      }
      return okText(parts.join('\n\n'));
    }
    if (name === 'event_history') {
      const ruleId = String((args || {}).ruleId || '');
      const j = JSON.parse(read('event-study'));
      const d = j.data || {};
      const rules = (d.rules || []).filter(r => r.ruleId === ruleId);
      if (!rules.length) return okText(JSON.stringify({ ok: false, error: '未找到该规则的历史样本', ruleId }));
      const r = rules[0];
      const low = (r.stats.samples || 0) < 8 ? '（低样本，仅供参考，不可外推）' : '';
      return okText(JSON.stringify({ ok: true, ruleId, name: r.name, stats: r.stats,
        line: r.name + ' 近2年 ' + r.stats.events + ' 次事件 / ' + r.stats.samples + ' 次观测，T+5 平均超额 ' +
          (r.stats.avgAr5 > 0 ? '+' : '') + r.stats.avgAr5 + '%，胜率 ' + r.stats.win5 + '%' + low,
        note: d.note }, null, 2));
    }
    return errText(new Error('未知工具：' + name));
  } catch (e) { return errText(e); }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  const s = String(line).trim();
  if (!s) return;
  let req;
  try { req = JSON.parse(s); } catch (_) { return; }
  const id = req.id;
  const send = obj => { if (id != null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: obj }) + '\n'); };
  if (req.method === 'initialize') {
    send({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'market-modules', version: '1.0.0' } });
    return;
  }
  if (req.method === 'notifications/initialized' || req.method === 'initialized') return;
  if (req.method === 'ping') { send({}); return; }
  if (req.method === 'tools/list') { send({ tools: TOOLS }); return; }
  if (req.method === 'tools/call') {
    const name = String((req.params || {}).name || '');
    const args = (req.params || {}).arguments || {};
    const r = callTool(name, args);
    if (id != null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: r }) + '\n');
    return;
  }
  if (id != null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }) + '\n');
});
process.on('SIGINT', () => process.exit(0));
