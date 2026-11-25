'use strict';

/**
 * data-hygiene.js — 垃圾信息处理 / 数据质量治理
 *
 * 参考三套做法，落到本项目：
 *  ① AI-Hel2 LintPanel：orphan(孤岛) / dead_link(死链) / low_confidence / stale / duplicate
 *  ② Hermes context compressor「免费清理阶段」：超长工具结果先替换成占位符，再交给 LLM 摘要；
 *     头尾保护（前 3 条 + 尾部预算）、tool_call 与 tool_result 不拆开。
 *  ③ Mem0 选择性抽取 / 价值门控：闲聊、无金融信号、疑似交易请求不进图谱与上下文。
 *
 * 本项目实际脏数据类型（都是真实存在的）：
 *  - 陈旧缓存：strength-cache.json 等停在旧交易日；周末/非交易日脏 K 线（limitup-history）
 *  - 重复新闻：同一事件多家转载（news-pulse / 政策快讯）
 *  - 孤岛节点 / 死链 / 低置信度节点（knowledge/graph.json、unified-graph.json）
 *  - 空/损坏 JSON、抓取失败留下的 0 条占位、测试定格的假日期
 *  - 上下文膨胀：把整包 JSON 塞进 prompt、历史会话无限增长
 *
 * 【纪律】默认只「报告」不删除；clean() 必须 confirm=true 才执行，且只做去归档/隐藏，
 *         不物理删除任何原始文件（append-only 原始流永不覆盖）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const KDIR = path.join(DATA, 'knowledge');
const F_REPORT = path.join(KDIR, 'hygiene-report.json');
const F_LOG = path.join(KDIR, 'hygiene-actions.jsonl');
const DAY = 86400e3;

function ensureDir() { if (!fs.existsSync(KDIR)) fs.mkdirSync(KDIR, { recursive: true }); }
function readJson(f, fb) { try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} return fb; }
function writeJson(f, o) { ensureDir(); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2), 'utf8'); fs.renameSync(t, f); }
function appendJsonl(f, o) { ensureDir(); fs.appendFileSync(f, JSON.stringify(o) + '\n', 'utf8'); }
function jread(rel, fb) { return readJson(path.join(DATA, rel), fb); }
function norm(s) { return String(s == null ? '' : s).replace(/[\s\.,，。、\-_（）()【】\[\]"'`*·:：;；/\\]/g, '').toLowerCase(); }
function hash(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12); }
function nowISO() { return new Date().toISOString(); }

/* ---------------------- 规则 1：陈旧 / 脏数据文件 ---------------------- */

/** 关键缓存文件的最大可接受年龄（按交易日，宽松到 4 天覆盖周末） */
const STALE_RULES = [
  ['strength-cache.json', 4, '板块强度缓存'], ['limitup-cache.json', 4, '涨停池缓存'],
  ['limitup-history.json', 4, '涨停历史'], ['market-style.json', 4, '市场风格'],
  ['market-breadth.json', 4, '涨跌宽度'], ['sentiment.json', 4, '短线情绪'],
  ['strategy.json', 4, '策略视图'], ['news-pulse.json', 1, '新闻脉冲'],
  ['stocks-cache.json', 4, '个股评分缓存'], ['technical-cache.json', 4, '技术指标'],
  ['stock-news-cache.json', 2, '个股新闻缓存'], ['universe-all.json', 7, '全市场池']
];

function checkStaleFiles() {
  const out = [];
  const now = Date.now();
  for (const [file, maxDays, label] of STALE_RULES) {
    const fp = path.join(DATA, file);
    if (!fs.existsSync(fp)) continue;
    const st = fs.statSync(fp);
    const j = readJson(fp, null);
    let generatedAt = null;
    if (j && typeof j === 'object') {
      for (const k of ['generatedAt', 'at', 'updatedAt', 'fetchedAt', 'builtAt']) {
        if (j[k]) { const t = Date.parse(typeof j[k] === 'number' ? new Date(j[k]).toISOString() : String(j[k])); if (Number.isFinite(t)) { generatedAt = t; break; } }
      }
    }
    const ref = generatedAt || st.mtimeMs;
    const ageDays = (now - ref) / DAY;
    if (ageDays > maxDays) {
      out.push({
        rule: 'stale_file', severity: ageDays > maxDays * 2 ? 'high' : 'medium',
        file: 'data/' + file, label,
        message: label + ' 已 ' + ageDays.toFixed(1) + ' 天未更新（阈值 ' + maxDays + ' 天）',
        ageDays: Math.round(ageDays * 10) / 10,
        lastAt: new Date(ref).toISOString(),
        suggestion: '触发对应模块 refresh；若数据仍停留在非交易日，需按真实交易日过滤'
      });
    }
  }
  return out;
}

/** 空/损坏/占位数据：抓取失败留下的 0 条结果 */
function checkEmptyOrBroken() {
  const out = [];
  const files = fs.readdirSync(DATA).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const fp = path.join(DATA, f);
    let st; try { st = fs.statSync(fp); } catch (_) { continue; }
    if (st.size === 0) { out.push({ rule: 'empty_file', severity: 'high', file: 'data/' + f, message: '文件为空（0 字节）' }); continue; }
    const j = readJson(fp, undefined);
    if (j === undefined) { out.push({ rule: 'broken_json', severity: 'high', file: 'data/' + f, message: 'JSON 解析失败或内容损坏' }); continue; }
    // 抓取失败占位：有 ok:false 或 fetched:0 / count:0
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      if (j.ok === false && j.error) out.push({ rule: 'failed_snapshot', severity: 'medium', file: 'data/' + f, message: '抓取失败占位：' + String(j.error).slice(0, 60) });
      if ((j.count === 0 || j.got === 0 || j.valid === 0) && Array.isArray(j.errors) && j.errors.length) {
        out.push({ rule: 'zero_result', severity: 'medium', file: 'data/' + f, message: '0 条结果且带 ' + j.errors.length + ' 条错误' });
      }
    }
  }
  return out;
}

/* ---------------------- 规则 2：重复新闻 / 重复笔记 ---------------------- */

function checkDuplicateNews() {
  const out = [];
  const d = jread('news-pulse.json', null);
  if (!d) return out;
  const policy = Array.isArray(d.policyNews) ? d.policyNews : [];
  const heads = Array.isArray(d.headlines) ? d.headlines : [];
  const all = policy.concat(heads.map(h => typeof h === 'string' ? { title: h } : h));
  const groups = new Map();
  for (const n of all) {
    if (!n || !n.title) continue;
    const k = norm(n.title).slice(0, 30);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  for (const [k, arr] of groups) {
    if (arr.length < 2) continue;
    out.push({
      rule: 'duplicate_news', severity: 'medium',
      file: 'data/news-pulse.json',
      message: '同一标题出现 ' + arr.length + ' 次（多家转载）：' + String(arr[0].title).slice(0, 40),
      count: arr.length, keyHash: hash(k),
      sources: [...new Set(arr.map(x => x.source).filter(Boolean))].slice(0, 5),
      suggestion: '按事件指纹聚类，保留最早一条 + 记录其他来源作为 episode 溯源，不做物理删除'
    });
  }
  // 疑似同源事件（标题相似度极高但非完全相同）——只报告，不自动合并
  const titles = policy.map(n => String(n.title || '')).filter(Boolean);
  for (let i = 0; i < titles.length; i++) for (let j = i + 1; j < titles.length; j++) {
    const a = norm(titles[i]), b = norm(titles[j]);
    if (!a || !b || a === b) continue;
    if ((a.length > 8 && b.length > 8) && (a.includes(b.slice(0, 12)) || b.includes(a.slice(0, 12)))) {
      out.push({ rule: 'near_duplicate_news', severity: 'low', file: 'data/news-pulse.json',
        message: '疑似同一事件两条快讯：' + titles[i].slice(0, 26) + ' ↔ ' + titles[j].slice(0, 26),
        suggestion: '交给智能体做事件去重判断（news-triage 技能）' });
    }
  }
  return out.slice(0, 30);
}

function checkDuplicateNotes() {
  const out = [];
  const f = path.join(KDIR, 'notes.jsonl');
  if (!fs.existsSync(f)) return out;
  const rows = fs.readFileSync(f, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    .map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
  const seen = new Map();
  for (const r of rows) {
    const k = norm((r.title || '') + '|' + (r.content || ''));
    if (!k) continue;
    if (seen.has(k)) out.push({ rule: 'duplicate_note', severity: 'low', file: 'data/knowledge/notes.jsonl',
      message: '重复笔记：' + String(r.title || (r.content || '').slice(0, 20)).slice(0, 40),
      keepId: seen.get(k), dupId: r.noteId, suggestion: 'dedupeNotes(confirm) 保留最早一条' });
    else seen.set(k, r.noteId);
  }
  return out;
}

/* ---------------------- 规则 3：图谱 lint（对齐 AI-Hel2） ---------------------- */

function lintGraph(nodes, links, { label = '统一图谱', file = 'unified-graph.json', confidenceKey = 'confidence' } = {}) {
  const out = [];
  if (!Array.isArray(nodes) || !nodes.length) return out;
  const ids = new Set(nodes.map(n => n.id));
  const deg = new Map();
  const dead = [];
  for (const l of (links || [])) {
    const s = typeof l.source === 'object' ? (l.source && l.source.id) : l.source;
    const t = typeof l.target === 'object' ? (l.target && l.target.id) : l.target;
    if (!ids.has(s) || !ids.has(t)) { dead.push(l); continue; }
    deg.set(s, (deg.get(s) || 0) + 1); deg.set(t, (deg.get(t) || 0) + 1);
  }
  // orphan 孤岛
  for (const n of nodes) {
    if ((deg.get(n.id) || 0) === 0 && n.type !== 'module') {
      out.push({ rule: 'orphan', severity: 'low', file, entityId: n.id,
        message: '孤岛节点「' + String(n.label).slice(0, 30) + '」无任何关联', suggestion: 'decay 隐藏/归档，或补一条 relates 边' });
    }
  }
  // dead_link
  if (dead.length) out.push({ rule: 'dead_link', severity: 'high', file,
    message: dead.length + ' 条边指向不存在的实体', count: dead.length,
    sample: dead.slice(0, 3).map(l => (l.source || '?') + '→' + (l.target || '?')) });
  // duplicate（同名不同 id）
  const byName = new Map();
  for (const n of nodes) {
    const k = norm(n.label);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(n);
  }
  for (const [k, arr] of byName) if (arr.length > 1) {
    out.push({ rule: 'duplicate', severity: 'medium', file,
      message: arr.length + ' 个节点名称相同「' + String(arr[0].label).slice(0, 28) + '」',
      ids: arr.map(x => x.id).slice(0, 8), suggestion: '实体消解合并（unified-graph 已自动处理 ≥0.88）' });
  }
  // low_confidence / stale（仅旧知识库有这些字段）
  const now = Date.now();
  for (const n of nodes) {
    const conf = (n.props && n.props[confidenceKey] != null) ? n.props[confidenceKey] : n[confidenceKey];
    if (typeof conf === 'number' && conf < 0.4) {
      out.push({ rule: 'low_confidence', severity: 'low', file, entityId: n.id,
        message: '节点「' + String(n.label).slice(0, 26) + '」置信度仅 ' + conf.toFixed(2), suggestion: '人工确认或降权' });
    }
    const last = n.lastSeenAt || n.updatedAt;
    if (last) {
      const t = Date.parse(last);
      if (Number.isFinite(t) && (now - t) / DAY > 30) {
        out.push({ rule: 'stale_entity', severity: 'low', file, entityId: n.id,
          message: '节点「' + String(n.label).slice(0, 26) + '」超过 30 天未更新', suggestion: '复核是否仍有效' });
      }
    }
  }
  return out;
}

/* ---------------------- 规则 4：周末/非交易日脏数据 ---------------------- */

function checkTradingDayDirt() {
  const out = [];
  const f = path.join(DATA, 'limitup-history.json');
  const j = readJson(f, null);
  if (!j) return out;
  const arr = Array.isArray(j) ? j : (Array.isArray(j.days) ? j.days : (j.history && Array.isArray(j.history) ? j.history : []));
  const bad = [];
  for (const x of arr) {
    const date = typeof x === 'string' ? x : (x && (x.date || x.day));
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) continue;
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    if (dow === 0 || dow === 6) bad.push(date);
  }
  if (bad.length) out.push({ rule: 'weekend_dirty', severity: 'medium', file: 'data/limitup-history.json',
    message: '涨停历史混入 ' + bad.length + ' 条非交易日：' + [...new Set(bad)].slice(0, 6).join('/'),
    suggestion: '按真实 K 线交易日过滤（sentiment.js 的 prevTradeDate 已做同类处理）' });
  return out;
}

/* ---------------------- 主报告 ---------------------- */

function scan() {
  const at = nowISO();
  const ug = jread('knowledge/unified-graph.json', null);
  const legacy = jread('knowledge/graph.json', null);
  const items = [
    ...checkStaleFiles(),
    ...checkEmptyOrBroken(),
    ...checkDuplicateNews(),
    ...checkDuplicateNotes(),
    ...checkTradingDayDirt(),
    ...lintGraph(ug && ug.nodes, ug && ug.links, { file: 'data/knowledge/unified-graph.json' }),
    ...lintGraph(legacy && legacy.nodes, (legacy && legacy.edges || []).map(e => ({ source: e.from, target: e.to })),
      { label: '经验图谱', file: 'data/knowledge/graph.json' })
  ];
  // 统一编号 + 去重（同 rule+message 只留一条）
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    const k = it.rule + '|' + it.message;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push({ ...it, id: 'H-' + hash(k), detectedAt: at });
  }
  const byRule = {}, bySeverity = { high: 0, medium: 0, low: 0 };
  for (const it of uniq) { byRule[it.rule] = (byRule[it.rule] || 0) + 1; bySeverity[it.severity] = (bySeverity[it.severity] || 0) + 1; }
  const report = {
    ok: true, at,
    total: uniq.length, byRule, bySeverity,
    health: uniq.length === 0 ? 'clean' : (bySeverity.high > 0 ? 'needs-attention' : 'minor'),
    items: uniq,
    rules: {
      stale_file: '缓存超过阈值天数未更新', empty_file: '文件为空', broken_json: 'JSON 损坏',
      failed_snapshot: '抓取失败占位', zero_result: '0 条结果且带错误',
      duplicate_news: '重复新闻（多家转载）', near_duplicate_news: '疑似同源快讯',
      duplicate_note: '重复笔记', weekend_dirty: '非交易日脏数据',
      orphan: '图谱孤岛节点', dead_link: '图谱死链', duplicate: '同名节点',
      low_confidence: '低置信度节点', stale_entity: '长期未更新实体'
    },
    note: '默认只报告不处置；clean(confirm=true) 才执行，且只做隐藏/归档，不物理删除原始文件。'
  };
  writeJson(F_REPORT, report);
  return report;
}

function report() {
  const r = readJson(F_REPORT, null);
  if (!r) return scan();
  return { ...r, cached: true };
}

/**
 * 处置：默认只报告。confirm=true 时执行「可逆」动作：
 *  - 空/损坏文件：不删，仅记录（避免破坏 append-only 流）
 *  - 重复笔记：调用 knowledge.dedupeNotes(true)
 *  - 孤岛/低置信节点：调用 knowledge.decay(true) 归档（validTo 而非物理删）
 *  - 陈旧缓存：只产出刷新建议清单，绝不代跑抓取（避免伪造更新）
 */
function clean({ confirm = false, rules = [] } = {}) {
  const r = scan();
  if (!confirm) return { ok: true, executed: false, report: r, note: '预演模式：未做任何修改。传 confirm:true 才执行可逆处置。' };
  const actions = [];
  const want = s => !rules.length || rules.includes(s);
  try {
    const knowledge = require('./knowledge');
    if (r.byRule.duplicate_note && want('duplicate_note')) {
      const d = knowledge.dedupeNotes(true);
      actions.push({ rule: 'duplicate_note', result: d });
    }
    if ((r.byRule.orphan || r.byRule.stale_entity) && (want('orphan') || want('stale_entity'))) {
      const d = knowledge.decay({ confirm: true, hideDays: 7, dropDays: 30 });
      actions.push({ rule: 'orphan/stale_entity', result: d, note: '归档=validTo 标记，非物理删除' });
    }
  } catch (e) { actions.push({ error: e.message }); }
  const rec = { ok: true, executed: true, at: nowISO(), scanned: r.total, actions,
    note: '空/损坏/陈旧文件未做任何修改，仅列出刷新建议；原始 append-only 流永不覆盖。' };
  appendJsonl(F_LOG, rec);
  return rec;
}

/* ---------------------- 上下文压缩（Hermes「免费清理阶段」） ---------------------- */

/**
 * 压缩对话历史，避免把整包上下文塞进 prompt。
 * 顺序：① 掐头留尾 ② 超长 tool/上下文结果替换成占位符（零 LLM 成本）
 *      ③ 中段做确定性摘要（不编造内容，只保留结构与关键字段行）
 * @param {Array} messages [{role, content, ...}]
 * @param {object} opts { maxChars, headKeep, tailChars }
 */
function compressContext(messages, opts = {}) {
  const maxChars = opts.maxChars || 12000;
  const headKeep = opts.headKeep == null ? 3 : opts.headKeep;
  const tailChars = opts.tailChars || Math.min(2500, Math.round(maxChars * 0.25));
  const LONG_TOOL = 200;
  const PLACEHOLDER = '[旧工具结果已清理以节省上下文；需要时可通过工具重新读取]';
  const rows = Array.isArray(messages) ? messages.map(m => ({ ...m })) : [];
  const originalChars = rows.reduce((s, m) => s + String(m.content || '').length, 0);
  const cleaned = [];
  let placeholders = 0;

  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    const c = String(m.content == null ? '' : m.content);
    // 头尾保护区之外、超长的结果类消息 → 占位符（不调用 LLM，纯免费清理）
    const isProtected = i < headKeep || i >= rows.length - headKeep;
    if (!isProtected && c.length > LONG_TOOL && (m.role === 'tool' || m.role === 'system' || /^【.*数据快照|^\{[\s\S]*\}$/.test(c))) {
      cleaned.push({ ...m, content: PLACEHOLDER, _compressed: true, _origChars: c.length });
      placeholders++;
    } else cleaned.push(m);
  }

  let body = cleaned;
  let chars = body.reduce((s, m) => s + String(m.content || '').length, 0);
  if (chars > maxChars && body.length > headKeep + 2) {
    const head = body.slice(0, headKeep);
    let tail = [], tailLen = 0;
    for (let i = body.length - 1; i >= headKeep; i--) {
      const len = String(body[i].content || '').length;
      if (tailLen + len > tailChars && tail.length) break;
      tail.unshift(body[i]); tailLen += len;
    }
    const middle = body.slice(headKeep, body.length - tail.length);
    // 确定性中段摘要：只保留每条消息的首行/前 80 字，明确标注为截断，不编造
    const digest = middle.map(m => {
      const first = String(m.content || '').split('\n').find(x => x.trim()) || '';
      return '[' + (m.role || '?') + '] ' + first.slice(0, 80);
    }).join('\n');
    const summary = { role: 'system', content: '[历史中段已压缩：' + middle.length + ' 条 → 摘要，不含原始全文，需要细节请用工具回查]\n' + digest.slice(0, 1800), _compressed: true };
    body = [...head, summary, ...tail];
    chars = body.reduce((s, m) => s + String(m.content || '').length, 0);
  }
  return {
    ok: true, originalMessages: rows.length, outputMessages: body.length,
    originalChars, outputChars: chars,
    placeholders, compressed: originalChars > chars || placeholders > 0,
    messages: body,
    note: '借鉴 Hermes context compressor：免费清理阶段（超长结果占位符）+ 头尾保护 + 中段确定性摘要；不做有损 LLM 摘要以免引入编造。'
  };
}

function status() {
  const r = readJson(F_REPORT, null);
  const logs = fs.existsSync(F_LOG) ? fs.readFileSync(F_LOG, 'utf8').split('\n').filter(Boolean).length : 0;
  return {
    ok: true, lastScanAt: r ? r.at : null, total: r ? r.total : null,
    bySeverity: r ? r.bySeverity : null, health: r ? r.health : null,
    cleanActions: logs,
    files: { report: 'data/knowledge/hygiene-report.json', actions: 'data/knowledge/hygiene-actions.jsonl' }
  };
}

module.exports = { scan, report, clean, compressContext, status, lintGraph, F_REPORT };
