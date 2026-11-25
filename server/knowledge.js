'use strict';

/**
 * knowledge.js — 「个人知识库」模块（v2）
 *
 * 收纳交易中产生的问题与经验，本地存储，经智能体整理后以「知识图谱」保存。
 * 设计参考《知识库评估与消息转知识方案》：只存不提取接口分离、置信度锚点、
 * 相似度合并 + 待确认、多源确认加权、反馈闭环、时序失效（借鉴 Graphiti）。
 *
 * 【存储结构】data/knowledge/
 *   notes.jsonl        原始笔记/问答（append-only，永不覆盖）
 *   messages.jsonl     统一消息原始流：对话/新闻/事件/笔记（append-only，P0 新增）
 *   graph.json         知识图谱 { nodes:[], edges:[] }（可重建）
 *   aliases.json       别名表：规范化标签 → 权威节点（P2）
 *   pending-merge.json 待确认合并候选（P2）
 *   feedback.json      问答命中反馈 + 抽取偏好摘要（P3）
 *   entries/*.md       知识词条（本地 md 文档，图谱节点的文本主体，可人工编辑）
 *
 * 【节点字段】（向后兼容，旧字段保留）
 *   id, type, label, confidence, sourceNoteId,
 *   sourceType(user/conversation/journal/daily/event), sourceMessageId, validFrom, validTo,
 *   status(active/proposed/archived), confirmations, createdAt, lastSeenAt, hitCount
 * 【边类型】supports / contradicts / causes / relates / instance_of
 *
 * 【纪律】
 *   - 只做抽取与结构化，不改分、不自动晋升为规则（沿用 journal 审核闸门）。
 *   - 新经验一律 status=proposed，须人工确认才 active；contradicts 边不自动消解。
 *   - 时序失效：事实用 validTo 标记失效而非删除（投资逻辑会过期）。
 *   - 回流只影响抽取偏好与召回权重，绝不触碰智能体 L1/L2/L3/L4 四层约束。
 */

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'data', 'knowledge');
const F_NOTES = path.join(DIR, 'notes.jsonl');
const F_MESSAGES = path.join(DIR, 'messages.jsonl');
const F_GRAPH = path.join(DIR, 'graph.json');
const F_ALIASES = path.join(DIR, 'aliases.json');
const F_PENDING = path.join(DIR, 'pending-merge.json');
const F_FEEDBACK = path.join(DIR, 'feedback.json');
const DIR_ENTRIES = path.join(DIR, 'entries');

function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }
function readJson(file, fallback) { try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {} return fallback; }
function writeJson(file, obj) { ensureDir(); const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj, null, 2), 'utf8'); fs.renameSync(t, t.replace(/\.tmp$/, '')); }
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    .map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
}
function appendJsonl(file, obj) { ensureDir(); fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8'); }
function writeJsonl(file, rows) { ensureDir(); fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8'); }

const TYPES = ['concept', 'factor', 'experience', 'pattern', 'event', 'question'];
const EDGES = ['supports', 'contradicts', 'causes', 'relates', 'instance_of'];
const CONF = { anchor: 0.9, derived: 0.7, weak: 0.5, proposed: 0.3, drop: 0.4, multiSourceBonus: 0.1 };
const SIM_MERGE = 0.85;   // 相似度 ≥ 0.85 自动合并
const SIM_PENDING = 0.60; // 0.60–0.85 进入待确认
const DECAY_HIDE_DAYS = 7;  // 孤立 N 天隐藏
const DECAY_DROP_DAYS = 30; // 孤立 N 天归档
const DAY = 86400e3;

/* ============================ P0：消息原始流 ============================ */

/**
 * 追加一条原始消息到统一流（只存不提取，符合 AI-Hel2 "Agent 只存不提取" 接口分离）。
 * @param {object} msg { source:'conversation|note|journal|daily|event', role, content, module, question, answer, backend, meta }
 */
function collectMessage(msg) {
  if (!msg || (!String(msg.content || '').trim() && !String(msg.question || '').trim())) {
    return { ok: false, error: '消息内容为空' };
  }
  const row = {
    messageId: 'M-' + Date.now() + '-' + String(Math.floor(Math.random() * 1000)).padStart(3, '0'),
    source: msg.source || 'conversation',
    role: msg.role || null,
    module: msg.module || null,
    content: String(msg.content || '').slice(0, 6000),
    question: String(msg.question || '').slice(0, 4000) || null,
    answer: String(msg.answer || '').slice(0, 8000) || null,
    backend: msg.backend || null,
    tags: Array.isArray(msg.tags) ? msg.tags.slice(0, 12).map(String) : [],
    symbols: Array.isArray(msg.symbols) ? msg.symbols.slice(0, 12).map(String) : [],
    meta: msg.meta && typeof msg.meta === 'object' ? msg.meta : null,
    extracted: false,
    createdAt: Date.now()
  };
  appendJsonl(F_MESSAGES, row);
  return { ok: true, messageId: row.messageId };
}

function messages({ limit = 100, source, unextracted } = {}) {
  let rows = readJsonl(F_MESSAGES).slice().reverse();
  if (source) rows = rows.filter(r => r.source === source);
  if (unextracted) rows = rows.filter(r => !r.extracted);
  return { ok: true, total: rows.length, items: rows.slice(0, limit) };
}

/* ============================ 知识词条（本地 md 文档） ============================ */

/** 由笔记/图谱节点生成 md 词条文本。front matter 记录来源与状态，正文可直接人工编辑。 */
function entryMarkdown(entry) {
  const fm = [
    '---',
    'id: ' + String(entry.id || '').replace(/[:]/g, '-'),
    'title: ' + JSON.stringify(String(entry.title || entry.label || '未命名')),
    'type: ' + (entry.type || entry.kind || 'experience'),
    'status: ' + (entry.status || 'active'),
    'sourceNoteId: ' + (entry.sourceNoteId || ''),
    'tags: [' + (entry.tags || []).map(t => JSON.stringify(String(t))).join(', ') + ']',
    'updatedAt: ' + (entry.updatedAt || Date.now()),
    '---',
    ''
  ].join('\n');
  const body = String(entry.content || entry.summary || entry.fact || '').trim() || '（暂无正文，可在本地编辑此 md 文件补充。）';
  return fm + '# ' + String(entry.title || entry.label || '未命名') + '\n\n' + body + '\n';
}

/** 把当前笔记导出为 md 词条（幂等：同一 noteId 覆盖同名文件；返回导出清单） */
function exportEntries() {
  fs.mkdirSync(DIR_ENTRIES, { recursive: true });
  const rows = readJsonl(F_NOTES);
  const written = [];
  for (const r of rows) {
    const safe = String(r.noteId || Date.now()).replace(/[^\w-]/g, '_');
    const file = path.join(DIR_ENTRIES, safe + '.md');
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, entryMarkdown({
        id: r.noteId, title: r.title || (r.content || '').slice(0, 30),
        type: r.kind, content: r.content, tags: r.tags,
        sourceNoteId: r.noteId, status: r.organized ? 'active' : 'proposed',
        updatedAt: r.createdAt
      }), 'utf8');
    }
    written.push({ id: r.noteId, file: file, title: r.title || (r.content || '').slice(0, 30) });
  }
  return { ok: true, count: written.length, dir: DIR_ENTRIES, entries: written };
}

/** 读取所有 md 词条（供前端「知识词条列表」视图；本地 md 是唯一正文来源） */
function listEntries({ limit = 200 } = {}) {
  fs.mkdirSync(DIR_ENTRIES, { recursive: true });
  const files = fs.readdirSync(DIR_ENTRIES).filter(f => f.endsWith('.md')).sort();
  const items = files.map(f => {
    const full = path.join(DIR_ENTRIES, f);
    const text = fs.readFileSync(full, 'utf8');
    const titleM = /^#\s+(.+)$/m.exec(text);
    const fm = (text.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
    const get = k => { const m = new RegExp('^' + k + ':\\s*(.+)$', 'm').exec(fm); return m ? m[1].trim() : null; };
    let tags = [];
    try { tags = JSON.parse(get('tags') || '[]'); } catch (_) {}
    const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^#\s+.+\n?/, '').trim();
    return {
      id: f.replace(/\.md$/, ''), file: f, path: full,
      title: titleM ? titleM[1].trim() : (get('title') || f),
      type: get('type') || 'experience', status: get('status') || 'active',
      sourceNoteId: get('sourceNoteId') || null, tags,
      updatedAt: Number(get('updatedAt') || 0) || fs.statSync(full).mtimeMs,
      content: body.slice(0, 1200),
      bytes: Buffer.byteLength(text, 'utf8')
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
  return { ok: true, total: items.length, dir: DIR_ENTRIES, items: items.slice(0, limit) };
}

/** 读取/保存单个 md 词条正文（人工编辑入口） */
function getEntry(id) {
  const safe = String(id || '').replace(/[^\w-]/g, '_');
  const file = path.join(DIR_ENTRIES, safe + '.md');
  if (!fs.existsSync(file)) return { ok: false, error: '词条不存在' };
  return { ok: true, id: safe, path: file, content: fs.readFileSync(file, 'utf8') };
}
function saveEntry(id, content) {
  const safe = String(id || '').replace(/[^\w-]/g, '_');
  const file = path.join(DIR_ENTRIES, safe + '.md');
  if (!fs.existsSync(file)) return { ok: false, error: '词条不存在' };
  const text = String(content || '');
  if (text.length > 50000) return { ok: false, error: '内容过长' };
  fs.writeFileSync(file, text, 'utf8');
  return { ok: true, id: safe, path: file, bytes: Buffer.byteLength(text, 'utf8') };
}

/* ============================ 笔记（兼容原接口） ============================ */

function addNote(note) {
  if (!String(note.content || '').trim()) return { ok: false, error: '内容不能为空' };
  const row = {
    noteId: 'N-' + String(Date.now()) + '-' + String(Math.floor(Math.random() * 1000)).padStart(3, '0'),
    kind: note.kind || (note.isQuestion ? 'question' : 'experience'),
    title: String(note.title || '').slice(0, 100),
    content: String(note.content).slice(0, 4000),
    tags: Array.isArray(note.tags) ? note.tags.slice(0, 12).map(String) : [],
    symbols: Array.isArray(note.symbols) ? note.symbols.slice(0, 12).map(String) : [],
    source: note.source || 'user',
    sourceType: note.sourceType || (note.source === 'conversation' ? 'conversation' : 'user'),
    createdAt: Date.now(),
    organized: false
  };
  appendJsonl(F_NOTES, row);
  // 同时进入统一消息流（P0）
  try { collectMessage({ source: 'note', content: row.content, question: row.title, tags: row.tags, symbols: row.symbols, meta: { noteId: row.noteId, kind: row.kind } }); } catch (_) {}
  return { ok: true, note: row };
}

function notes({ limit = 100, kind } = {}) {
  let rows = readJsonl(F_NOTES).slice().reverse();
  if (kind) rows = rows.filter(r => r.kind === kind);
  return { ok: true, total: rows.length, items: rows.slice(0, limit) };
}

function removeNote(noteId) {
  const rows = readJsonl(F_NOTES).filter(r => r.noteId !== noteId);
  writeJsonl(F_NOTES, rows);
  const g = readJson(F_GRAPH, { nodes: [], edges: [] });
  const ids = new Set(g.nodes.filter(n => n.sourceNoteId === noteId).map(n => n.id));
  g.nodes = g.nodes.filter(n => !ids.has(n.id));
  g.edges = g.edges.filter(e => !ids.has(e.from) && !ids.has(e.to));
  writeJson(F_GRAPH, g);
  return { ok: true, removed: noteId, nodesRemoved: ids.size };
}

/** 清理重复笔记（内容相同保留最早一条）；默认只报告不删，confirm=true 才执行 */
function dedupeNotes(confirm = false) {
  const rows = readJsonl(F_NOTES);
  const seen = new Map(); const dupIds = [];
  for (const r of rows) {
    const k = (r.title || '') + '||' + String(r.content || '').replace(/\s/g, '');
    if (seen.has(k)) dupIds.push(r.noteId); else seen.set(k, r.noteId);
  }
  if (confirm && dupIds.length) {
    const set = new Set(dupIds);
    writeJsonl(F_NOTES, rows.filter(r => !set.has(r.noteId)));
    // 图谱里源自重复笔记的节点改挂到保留笔记，避免丢失知识
    const keepByKey = new Map();
    for (const r of rows) if (!set.has(r.noteId)) keepByKey.set((r.title || '') + '||' + String(r.content || '').replace(/\s/g, ''), r.noteId);
    const g = readJson(F_GRAPH, { nodes: [], edges: [] });
    for (const n of g.nodes) if (set.has(n.sourceNoteId)) {
      const k = n._dupKey; // 若抽取时存过 key 则用它；否则不强行迁移
      if (k && keepByKey.has(k)) n.sourceNoteId = keepByKey.get(k);
    }
    writeJson(F_GRAPH, g);
  }
  return { ok: true, duplicates: dupIds.length, ids: dupIds, executed: confirm && dupIds.length > 0 };
}

/* ============================ 知识图谱（兼容 + 增强） ============================ */

function graph({ includeArchived = false } = {}) {
  const g = readJson(F_GRAPH, { nodes: [], edges: [], builtAt: null });
  const now = Date.now();
  // 兼容性 + 时序失效：旧节点无 status 默认视为 active；validTo 已过的降级 archived（不删除）
  let changed = false;
  for (const n of g.nodes) {
    if (!n.status) { n.status = 'active'; changed = true; }
    if (n.status === 'active' && n.validTo && new Date(n.validTo).getTime() < now) { n.status = 'archived'; changed = true; }
  }
  if (changed) writeJson(F_GRAPH, g);
  const nodes = includeArchived ? g.nodes : g.nodes.filter(n => n.status !== 'archived');
  const ids = new Set(nodes.map(n => n.id));
  const edges = g.edges.filter(e => ids.has(e.from) && ids.has(e.to));
  const byType = {};
  for (const n of nodes) byType[n.type] = (byType[n.type] || 0) + 1;
  return {
    ok: true, nodes, edges, builtAt: g.builtAt,
    stats: {
      nodes: nodes.length, edges: edges.length, byType,
      active: nodes.filter(n => n.status === 'active').length,
      proposed: nodes.filter(n => n.status === 'proposed').length,
      archived: g.nodes.filter(n => n.status === 'archived').length
    },
    note: '图谱由智能体整理消息/笔记生成，节点可回溯来源；contradicts 边不自动消解，须人工审核；失效事实以 validTo 归档而非删除。'
  };
}

/** 归一化标签：去空格/标点/大小写，用于别名与相似度 */
function norm(s) { return String(s || '').replace(/[\s\.,，。、\-_（）()]/g, '').toLowerCase(); }

/** 编辑距离相似度（0-1，零依赖；中文按字符） */
function similarity(a, b) {
  const s1 = norm(a), s2 = norm(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const m = s1.length, n = s2.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i].concat(new Array(n).fill(0)));
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (s1[i - 1] === s2[j - 1] ? 0 : 1));
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

/** 离线确定性兜底抽取（智能体不可用时），带置信度锚点 */
function extractHeuristic(note) {
  const nodes = [];
  const text = String(note.content || '');
  const concepts = ['缩量', '放量', '跌破MA5', '均线', 'MACD', '主力资金', '北向资金', '涨停', '连板', '炸板',
    '业绩预增', '医保目录', '防御', '红利', '低波', '板块轮动', '存量博弈', '避险', '超预期', '利好出尽'];
  const hit = concepts.filter(c => text.includes(c));
  const now = new Date().toISOString();
  for (const c of hit) nodes.push({
    id: 'C-' + slug(c), type: 'concept', label: c, confidence: CONF.anchor,
    sourceNoteId: note.noteId, sourceType: note.sourceType || 'user',
    validFrom: now, status: 'proposed', confirmations: 1, createdAt: Date.now(), lastSeenAt: Date.now()
  });
  if (hit.length >= 2) nodes.push({
    id: 'E-' + note.noteId, type: note.kind === 'question' ? 'question' : 'experience',
    label: note.title || text.slice(0, 24), confidence: CONF.derived,
    sourceNoteId: note.noteId, sourceType: note.sourceType || 'user',
    validFrom: now, status: 'proposed', confirmations: 1, createdAt: Date.now(), lastSeenAt: Date.now()
  });
  const edges = [];
  const exp = nodes.find(n => n.id === 'E-' + note.noteId);
  if (exp) for (const c of nodes.filter(n => n.type === 'concept')) edges.push({ from: exp.id, to: c.id, type: 'relates', sourceNoteId: note.noteId });
  return { nodes, edges };
}

function slug(s) { return String(s).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').slice(0, 24); }

function dedupe(g) {
  const m = new Map();
  for (const n of g.nodes) m.set(n.id, n);
  g.nodes = [...m.values()];
  const seen = new Set();
  g.edges = g.edges.filter(e => {
    const k = e.from + '|' + e.to + '|' + e.type;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return g;
}

/* ============================ P1：价值门控 + 抽取 ============================ */

/** 价值门控：过滤闲聊/无信息量消息，避免图谱被噪音污染（借鉴 Mem0 选择性抽取） */
function valueGate(msg) {
  const text = String((msg && (msg.content || msg.question || msg.answer)) || '');
  if (text.length < 12) return { pass: false, reason: '过短' };
  if (/^(你好|在吗|谢谢|好的|嗯+|收到|随便|哈哈+)$/.test(text.trim())) return { pass: false, reason: '寒暄' };
  const signal = /(涨|跌|量|价|资金|板块|因子|信号|经验|规律|形态|事件|规则|筛选|命中|超额|胜率|样本|趋势股|反弹股| why|为什么|缩量|放量|均线|止|仓位|情绪|超预期|政策|业绩)/i;
  if (!signal.test(text)) return { pass: false, reason: '无金融信号' };
  if (/买卖建议|该买|该卖/.test(text) && text.length < 30) return { pass: false, reason: '疑似交易请求' };
  return { pass: true };
}

function enrichNode(n, note, backend) {
  const now = new Date().toISOString();
  return {
    ...n,
    sourceType: n.sourceType || note.sourceType || note.source || 'user',
    sourceNoteId: n.sourceNoteId || note.noteId || note.sourceNoteId || null,
    sourceMessageId: n.sourceMessageId || note.sourceMessageId || null,
    validFrom: n.validFrom || now,
    validTo: n.validTo || null,
    status: n.status || 'proposed', // 新节点一律待确认
    confirmations: n.confirmations || 1,
    createdAt: n.createdAt || Date.now(),
    lastSeenAt: n.lastSeenAt || Date.now(),
    hitCount: n.hitCount || 0,
    extractedBy: backend || n.extractedBy || 'heuristic'
  };
}

const EXTRACT_PROMPT = (note) =>
  '把这条交易笔记/消息整理成知识图谱三元组。只输出 JSON：' +
  '{"nodes":[{"id":"唯一短id","type":"concept|factor|experience|pattern|event|question","label":"简短标签","confidence":0-1}],' +
  '"edges":[{"from":"节点id","to":"节点id","type":"supports|contradicts|causes|relates|instance_of"}]}。' +
  '置信度锚点：原文明确结论=0.9，推断=0.7，弱相关=0.5；低于0.4不要输出。' +
  '要求：至少1个 experience/question 节点，概念节点2-6个；边必须引用已定义的节点id；' +
  '若内容含时间有效性（如"当前""截至目前"）在 id 里标注；禁止买卖建议；不要输出解释文字。\n\n' +
  JSON.stringify({ title: note.title, content: note.content, tags: note.tags, symbols: note.symbols, kind: note.kind });

/**
 * 整理笔记 → 知识图谱（P1：价值门控 + 智能体抽取 + 置信度过滤 + 来源溯源）。
 * 保持原签名 organize(cfg, hermes, {noteId, limit})。
 */
async function organize(cfg, hermes, { noteId, noteIds, limit = 20 } = {}) {
  let rows = readJsonl(F_NOTES);
  if (noteId) rows = rows.filter(r => r.noteId === noteId);
  else if (Array.isArray(noteIds) && noteIds.length) rows = rows.filter(r => noteIds.includes(r.noteId));
  else rows = rows.filter(r => !r.organized).slice(0, limit);
  if (!rows.length) return { ok: true, addedNodes: 0, addedEdges: 0, note: '无待整理笔记' };

  const g = readJson(F_GRAPH, { nodes: [], edges: [], builtAt: null });
  let addedN = 0, addedE = 0, backend = 'heuristic', gated = 0;
  const feedback = readJson(F_FEEDBACK, { preferenceSummary: '' });

  for (const note of rows) {
    const gate = valueGate(note);
    if (!gate.pass) { gated++; markOrganized(note.noteId, 'gated:' + gate.reason); continue; }
    let extracted = null;
    if (hermes && cfg) {
      let prompt = EXTRACT_PROMPT(note);
      if (feedback.preferenceSummary) prompt += '\n\n【用户抽取偏好（来自历史反馈）】' + feedback.preferenceSummary.slice(0, 400);
      const ai = await hermes.chat(cfg, {
        messages: [{ role: 'user', content: prompt }],
        task: '知识图谱结构化抽取', maxTokens: 1200, temperature: 0.1
      });
      if (ai.ok) {
        try {
          let s = String(ai.text).trim();
          const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
          if (fence) s = fence[1];
          const d = JSON.parse(s);
          if (Array.isArray(d.nodes) && Array.isArray(d.edges)) {
            const nodes = d.nodes
              .filter(n => TYPES.includes(n.type) && (n.confidence == null || n.confidence >= CONF.drop))
              .map(n => enrichNode({ ...n, id: 'N-' + slug(String(n.id)) }, note, ai.backend));
            const ids = new Set(nodes.map(n => n.id));
            const edges = d.edges
              .filter(e => EDGES.includes(e.type) && ids.has('N-' + slug(String(e.from))) && ids.has('N-' + slug(String(e.to))))
              .map(e => ({ ...e, from: 'N-' + slug(String(e.from)), to: 'N-' + slug(String(e.to)), sourceNoteId: note.noteId }));
            if (nodes.length) { extracted = { nodes, edges }; backend = ai.backend; }
          }
        } catch (_) { /* JSON 解析失败 → 回退 */ }
      }
    }
    if (!extracted) extracted = {
      nodes: extractHeuristic(note).nodes.map(n => enrichNode(n, note, 'heuristic')),
      edges: extractHeuristic(note).edges,
    };
    g.nodes.push(...extracted.nodes);
    g.edges.push(...extracted.edges);
    addedN += extracted.nodes.length;
    addedE += extracted.edges.length;
    // 标记消息流已抽取
    try { markMessagesExtracted(note.noteId); } catch (_) {}
    markOrganized(note.noteId, 'organized');
  }
  P2_align(g); // P2：别名合并 + 待确认
  dedupe(g);
  g.builtAt = Date.now();
  writeJson(F_GRAPH, g);
  const pending = readJson(F_PENDING, { items: [] });
  return {
    ok: true, addedNodes: addedN, addedEdges: addedE, gated, backend,
    totalNodes: g.nodes.length, totalEdges: g.edges.length,
    pendingMerge: pending.items.length
  };
}

function markOrganized(noteId, status) {
  const all = readJsonl(F_NOTES);
  const idx = all.findIndex(r => r.noteId === noteId);
  if (idx >= 0) { all[idx].organized = true; all[idx].organizedAt = Date.now(); all[idx].organizeStatus = status; writeJsonl(F_NOTES, all); }
}
function markMessagesExtracted(noteId) {
  const rows = readJsonl(F_MESSAGES);
  let changed = false;
  for (const m of rows) if (m.meta && m.meta.noteId === noteId && !m.extracted) { m.extracted = true; changed = true; }
  if (changed) writeJsonl(F_MESSAGES, rows);
}

/* ============================ P2：对齐审核 ============================ */

/** 别名合并：相似度≥0.85 自动合并（加权置信度/多源+0.1）；0.60–0.85 进待确认；冲突边保留 */
function P2_align(g) {
  const aliases = readJson(F_ALIASES, { map: {} });
  const pending = readJson(F_PENDING, { items: [] });
  const byLabel = new Map();
  for (const n of g.nodes) {
    const key = norm(n.label);
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key).push(n);
  }
  const keys = [...byLabel.keys()];
  const removed = new Set();
  for (let i = 0; i < keys.length; i++) {
    if (removed.has(keys[i])) continue;
    const a = byLabel.get(keys[i])[0];
    for (let j = i + 1; j < keys.length; j++) {
      if (removed.has(keys[j])) continue;
      const b = byLabel.get(keys[j])[0];
      if (a.type !== b.type) continue; // 只合并同类
      const sim = similarity(a.label, b.label);
      if (sim >= SIM_MERGE) {
        // 合并到 a：多源确认 +0.1，置信度取较高，命中数累加
        const sources = new Set([a.sourceNoteId, b.sourceNoteId]);
        a.confidence = Math.min(1, Math.max(a.confidence || 0, b.confidence || 0) + (sources.size > 1 ? CONF.multiSourceBonus : 0));
        a.confirmations = (a.confirmations || 1) + (b.confirmations || 1);
        a.hitCount = (a.hitCount || 0) + (b.hitCount || 0);
        aliases.map[b.id] = a.id; // 旧 id 指向权威 id
        //  rewiring 边
        for (const e of g.edges) { if (e.from === b.id) e.from = a.id; if (e.to === b.id) e.to = a.id; }
        removed.add(keys[j]);
        for (const dup of byLabel.get(keys[j])) removed.add(dup.id);
      } else if (sim >= SIM_PENDING && !pending.items.some(p => p.a === a.id && p.b === b.id)) {
        pending.items.push({ a: a.id, b: b.id, labelA: a.label, labelB: b.label, sim: Math.round(sim * 100) / 100, createdAt: Date.now(), status: 'pending' });
      }
    }
  }
  if (removed.size) g.nodes = g.nodes.filter(n => !removed.has(n.id));
  dedupe(g);
  writeJson(F_ALIASES, aliases);
  writeJson(F_PENDING, pending);
  return g;
}

/** 列出待确认合并候选 */
function pendingMerges() { return { ok: true, items: readJson(F_PENDING, { items: [] }).items }; }

/** 人工裁决合并候选 */
function resolveMerge({ a, b, action }) {
  const pending = readJson(F_PENDING, { items: [] });
  const idx = pending.items.findIndex(p => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  if (idx < 0) return { ok: false, error: '未找到待确认项' };
  const item = pending.items[idx];
  if (action === 'merge') {
    const g = readJson(F_GRAPH, { nodes: [], edges: [] });
    const na = g.nodes.find(n => n.id === item.a), nb = g.nodes.find(n => n.id === item.b);
    if (na && nb) {
      na.confirmations = (na.confirmations || 1) + 1;
      na.status = 'active';
      for (const e of g.edges) { if (e.from === nb.id) e.from = na.id; if (e.to === nb.id) e.to = na.id; }
      g.nodes = g.nodes.filter(n => n.id !== nb.id);
      dedupe(g);
      writeJson(F_GRAPH, g);
    }
    pending.items.splice(idx, 1);
  } else if (action === 'reject') {
    pending.items.splice(idx, 1);
  } else return { ok: false, error: 'action 须为 merge|reject' };
  writeJson(F_PENDING, pending);
  return { ok: true, action, remaining: pending.items.length };
}

/** 人工确认节点：proposed → active（经验晋升的可检索态，非可执行规则） */
function confirmNode(id, { validTo } = {}) {
  const g = readJson(F_GRAPH, { nodes: [], edges: [] });
  const n = g.nodes.find(x => x.id === id);
  if (!n) return { ok: false, error: '节点不存在' };
  n.status = 'active';
  n.confirmations = (n.confirmations || 0) + 1;
  n.confirmedAt = Date.now();
  if (validTo) n.validTo = validTo; // 已知失效时点
  writeJson(F_GRAPH, g);
  return { ok: true, node: n };
}

/** 冲突边清单（人工审核，不自动消解） */
function conflicts() {
  const g = readJson(F_GRAPH, { nodes: [], edges: [] });
  const label = new Map(g.nodes.map(n => [n.id, n.label]));
  return {
    ok: true,
    items: g.edges.filter(e => e.type === 'contradicts').map(e => ({
      ...e, fromLabel: label.get(e.from) || e.from, toLabel: label.get(e.to) || e.to
    }))
  };
}

/* ============================ P3：时序回流 + 衰减 ============================ */

/** 问答命中反馈：记录哪些节点被问答引用/命中，注入抽取偏好 */
function recordFeedback({ question, hitNodeIds, useful }) {
  const f = readJson(F_FEEDBACK, { hits: [], preferenceSummary: '' });
  f.hits = f.hits || [];
  f.hits.push({ question: String(question || '').slice(0, 300), hitNodeIds: Array.isArray(hitNodeIds) ? hitNodeIds.slice(0, 20) : [], useful: useful !== false, at: Date.now() });
  f.hits = f.hits.slice(-100);
  // 更新节点 hitCount
  if (Array.isArray(hitNodeIds) && hitNodeIds.length) {
    const g = readJson(F_GRAPH, { nodes: [], edges: [] });
    for (const n of g.nodes) if (hitNodeIds.includes(n.id)) n.hitCount = (n.hitCount || 0) + 1;
    writeJson(F_GRAPH, g);
  }
  // 最近 15 条反馈汇总成偏好摘要（借鉴 AI-Hel2 反馈闭环）
  const recent = f.hits.slice(-15).filter(h => h.useful);
  const freq = {};
  for (const h of recent) for (const id of h.hitNodeIds) freq[id] = (freq[id] || 0) + 1;
  const g = readJson(F_GRAPH, { nodes: [], edges: [] });
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([id, c]) => (g.nodes.find(n => n.id === id) || {}).label).filter(Boolean);
  f.preferenceSummary = top.length ? '用户追问/关注较多：' + top.join('、') + '。抽取时优先保留这类主题的节点与关系。' : '';
  writeJson(F_FEEDBACK, f);
  return { ok: true, recorded: f.hits.length, preferenceSummary: f.preferenceSummary };
}

/** 衰减清理：孤立且长期无命中的节点隐藏/归档（validTo 失效而非物理删除） */
function decay({ hideDays = DECAY_HIDE_DAYS, dropDays = DECAY_DROP_DAYS, confirm = false } = {}) {
  const g = readJson(F_GRAPH, { nodes: [], edges: [] });
  const now = Date.now();
  const degree = new Map();
  for (const e of g.edges) { degree.set(e.from, (degree.get(e.from) || 0) + 1); degree.set(e.to, (degree.get(e.to) || 0) + 1); }
  const toHide = [], toArchive = [];
  for (const n of g.nodes) {
    if (n.status === 'archived') continue;
    const deg = degree.get(n.id) || 0;
    const age = (now - (n.lastSeenAt || n.createdAt || now)) / DAY;
    if (deg === 0 && (n.hitCount || 0) === 0 && age >= dropDays) toArchive.push(n.id);
    else if (deg === 0 && (n.hitCount || 0) === 0 && age >= hideDays) toHide.push(n.id);
  }
  if (confirm) {
    for (const n of g.nodes) {
      if (toArchive.includes(n.id)) { n.status = 'archived'; n.validTo = new Date().toISOString(); }
      else if (toHide.includes(n.id)) n.hidden = true;
    }
    writeJson(F_GRAPH, g);
  }
  return { ok: true, toHide: toHide.length, toArchive: toArchive.length, executed: confirm };
}

/** 知识库问答（带图谱上下文 + 命中反馈钩子） */
async function query(cfg, hermes, question) {
  const g = graph();
  const ctx = {
    graphStats: g.stats,
    concepts: g.nodes.filter(n => n.type === 'concept').slice(0, 30).map(n => ({ label: n.label, confidence: n.confidence, status: n.status })),
    experiences: g.nodes.filter(n => n.type === 'experience').slice(0, 20).map(n => ({ label: n.label, status: n.status })),
    questions: g.nodes.filter(n => n.type === 'question').slice(0, 20).map(n => n.label),
    conflicts: g.edges.filter(e => e.type === 'contradicts').length
  };
  const feedback = readJson(F_FEEDBACK, { preferenceSummary: '' });
  const q = '基于我的个人知识库（以下为已整理的图谱摘要）回答问题。若知识库没有相关内容就直说，不要编造我的经验。' +
    '不要给买卖建议。\n\n【知识库摘要】' + JSON.stringify(ctx) +
    (feedback.preferenceSummary ? '\n【关注偏好】' + feedback.preferenceSummary : '') + '\n\n【问题】' + question;
  const ai = await hermes.chat(cfg, {
    messages: [{ role: 'user', content: q }],
    task: '个人知识库问答', maxTokens: 1200
  });
  return { ok: ai.ok, answer: ai.ok ? ai.text : null, error: ai.ok ? null : ai.error, backend: ai.backend };
}

/* ============================ P2：复盘结论自动回流 ============================ */

/**
 * 复盘报告候选 → 智能体判定价值 → 写入笔记并整理图谱。
 * 纪律：智能体不可用时一律不自动入库；写入的全部是 proposed 节点，仍需人工确认才 active。
 */
async function reflowFromReport(cfg, hermes, { date, candidates = [], maxKeep = 4 } = {}) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return { ok: true, kept: 0, skipped: 0, reason: '无候选' };
  }
  const keyOf = c => norm(c.title) + '||' + norm(c.content);
  const existing = new Set(readJsonl(F_NOTES).map(keyOf));
  const fresh = candidates.filter(c => !existing.has(keyOf(c)));
  const duplicates = candidates.length - fresh.length;
  if (!fresh.length) return { ok: true, kept: 0, skipped: candidates.length, duplicates, reason: '全部已存在' };

  let verdict = null, backend = null, agentOk = false;
  if (cfg && hermes) {
    const prompt = '判断下列复盘候选中哪些值得写入个人知识库。只保留可复用经验、可核对的规律或需要长期跟踪的事实；' +
      '一次性的当日流水、无信息量的描述不要保留。不要给买卖建议。只输出 JSON：' +
      '{"keep":[候选序号数组],"reason":"一句话理由"}。\n\n候选：' +
      JSON.stringify(fresh.map((c, i) => ({ i, kind: c.kind, title: c.title, content: c.content })));
    const ai = await hermes.chat(cfg, {
      messages: [{ role: 'user', content: prompt }],
      task: '复盘知识入库判断', maxTokens: 600, temperature: 0.1
    });
    backend = ai.backend || null;
    agentOk = !!ai.ok;
    if (ai.ok) {
      try {
        let s = String(ai.text).trim();
        const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
        if (fence) s = fence[1];
        const d = JSON.parse(s);
        if (Array.isArray(d.keep)) verdict = { keep: d.keep.map(Number), reason: String(d.reason || '').slice(0, 300) };
      } catch (_) { /* 解析失败 → 不自动入库 */ }
    }
  }
  if (!verdict) {
    return { ok: true, kept: 0, skipped: fresh.length, duplicates, agentOk, backend,
      reason: agentOk ? '智能体输出无法解析，本次不自动入库' : '智能体不可用，本次不自动入库' };
  }

  const keepIdx = [...new Set(verdict.keep.filter(i => Number.isInteger(i) && i >= 0 && i < fresh.length))].slice(0, maxKeep);
  const noteIds = [];
  for (const i of keepIdx) {
    const c = fresh[i];
    const r = addNote({
      kind: c.kind === 'experience' ? 'experience' : 'experience',
      title: c.title,
      content: c.content,
      tags: ['daily-report', String(date || ''), c.kind || 'fact'],
      source: 'daily-report',
      sourceType: 'daily'
    });
    if (r.ok) noteIds.push(r.note.noteId);
  }
  let organized = null;
  if (noteIds.length && cfg && hermes) {
    try { organized = await organize(cfg, hermes, { noteIds }); } catch (e) { organized = { ok: false, error: e.message }; }
  }
  return {
    ok: true, date: date || null, kept: noteIds.length, noteIds, skipped: fresh.length - noteIds.length,
    duplicates, agentOk, backend, reason: verdict.reason, organized,
    note: '写入节点均为 proposed，需人工确认后才进入 active；contradicts 边不自动消解。'
  };
}

/** 综合健康度（供前端/API 展示） */
function status() {
  const g = graph();
  return {
    ok: true,
    notes: readJsonl(F_NOTES).length,
    messages: readJsonl(F_MESSAGES).length,
    unextractedMessages: readJsonl(F_MESSAGES).filter(m => !m.extracted).length,
    graph: g.stats,
    pendingMerge: readJson(F_PENDING, { items: [] }).items.length,
    conflicts: g.edges.filter(e => e.type === 'contradicts').length,
    feedbackHits: (readJson(F_FEEDBACK, { hits: [] }).hits || []).length
  };
}

module.exports = {
  // 原接口（兼容）
  addNote, notes, removeNote, graph, organize, query,
  // 本地 md 知识词条
  exportEntries, listEntries, getEntry, saveEntry, entryMarkdown, DIR_ENTRIES,
  // P0 消息流
  collectMessage, messages, dedupeNotes,
  // P2 对齐审核
  pendingMerges, resolveMerge, confirmNode, conflicts,
  // P3 时序回流
  recordFeedback, decay, status, reflowFromReport,
  // 工具/常量
  valueGate, similarity, norm, TYPES, EDGES, CONF,
  DIR, F_NOTES, F_MESSAGES, F_GRAPH, F_ALIASES, F_PENDING, F_FEEDBACK
};
