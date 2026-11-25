'use strict';

/**
 * agent.js — Step 2 智能体薄适配器（Node 零依赖，唯一的外部依赖是 DeepSeek HTTP API）
 *
 * 【设计纪律（v9 方案 §Step 2 / §7 安全边界）】
 *   - 主服务不动脑的地方继续不动脑：本模块只挂两个低风险任务 A1 / A4；
 *   - 智能体输出永不改分、永不剔除股票（affectsScore 恒 false，Flag 只标记）；
 *   - 网关三查：JSON 格式、禁买卖建议词、禁编造输入中不存在的数字；
 *   - 来源锚点由代码注入（feedId / briefId），LLM 不产锚点 → 天然防锚点幻觉；
 *   - 密钥只存 data/config.json 的 agent.apiKey，本模块不打印、不回显全文；
 *   - 本模块任何失败（无密钥/断网/超时/校验不过）都返回 skipped/error，不影响 8777 主服务。
 *
 * 【DeepSeek 五硬约束的落地】
 *   ① 结构化抽取一律用非思考模型（默认 deepseek-chat，勿配 reasoner 类思考模型，
 *      思考模式拒绝强制 tool_choice 会改用散文作答）；
 *   ② JSON 模式遇非 JSON 输出时 content 会变成空白而 finish_reason 仍是 stop
 *      → chatJSON 内置空白兜底 + 加强提示重试一次；
 *   ③ MODEL_ID 写配置不硬编码（旧 ID 已退役，以调用当日官方列表为准）；
 *   ④ 只传脱敏事实：A1 只有公告标题/栏目（公开信息），A4 只有统计数字摘要；
 *   ⑤ 用无状态的 Chat Completions，历史由本地自己回传，不用 Responses API。
 *
 * 【产出账本】
 *   events-feed.jsonl   A1 解读结果回写（interpreted: true / 'error'）
 *   flag-events.jsonl   A1 高置信利空分流（level 强警示/提示，affectsScore false）
 *   daily-brief.jsonl   A4 每日简报（统计摘要 + 人话日报 + 假说卡 + 今日重点）
 *   hypotheses.jsonl    A4 假说卡追加（status proposed，走人工审核，永不自动生效）
 *   ai-usage.json       用量与错误状态（滚动覆写：今日 tokens / 调用数 / 最近错误）
 */

const fs = require('node:fs');
const path = require('node:path');
const { FEED } = require('./watchers');

const DIR = path.join(__dirname, '..', 'data', 'journal');
const FLAG_FILE = path.join(DIR, 'flag-events.jsonl');
const HYPO_FILE = path.join(DIR, 'hypotheses.jsonl');
const BRIEF_FILE = path.join(DIR, 'daily-brief.jsonl');
const USAGE_FILE = path.join(DIR, 'ai-usage.json');

const TIMEOUT_MS = 60000;
/* A1/A4 全文禁词：智能体不得给出任何买卖指令（v9 §7「不出买卖指令」） */
const FORBIDDEN_ADVICE = ['买入', '卖出', '加仓', '减仓', '建仓', '清仓', '抄底', '止盈', '止损', '满仓', '梭哈'];

/* ------------------------------ 小工具 ------------------------------ */

function beijingDate(ts = Date.now()) {
  return new Date(ts + 8 * 3600e3).toISOString().slice(0, 10);
}
function beijingHM(ts = Date.now()) {
  return new Date(ts + 8 * 3600e3).toISOString().slice(11, 16);
}

function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* 半行跳过 */ }
  }
  return out;
}

function appendJsonl(file, obj) {
  ensureDir();
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

function loadUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const d = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
      if (d && d.day === beijingDate()) return d;
    }
  } catch (_) { /* 损坏重置 */ }
  return { version: 1, day: beijingDate(), tokensIn: 0, tokensOut: 0, calls: 0, errors: 0, lastError: null, lastErrorAt: null, lastOkAt: null };
}

function saveUsage(u) {
  ensureDir();
  try {
    const tmp = USAGE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(u), 'utf8');
    fs.renameSync(tmp, USAGE_FILE);
  } catch (e) { console.warn('[agent] 用量写入失败:', e.message); }
}

function bumpUsage(patch) {
  const u = loadUsage();
  Object.assign(u, patch);
  saveUsage(u);
  return u;
}

/** 从任意文本中提取所有百分数（用于「禁编造数字」校验） */
function extractPercents(text) {
  const out = [];
  const re = /([-+]?\d+(?:\.\d+)?)\s*%/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(parseFloat(m[1]));
  return out;
}

/** 从文本提取所有裸数值（不含 % 的也算，供换算匹配） */
function extractNumbers(text) {
  const out = [];
  const re = /[-+]?\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[0]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** 数字防编造（容差版）：输出中的百分数必须能追溯到输入数值——
 *  允许四舍五入（绝对差 ≤0.05 或相对差 ≤0.5%）与 % 换算（×100 / ÷100），
 *  拒绝的只有输入中完全无出处的新数字。 */
function checkNoInventedPercents(outputText, inputText) {
  const allowed = extractNumbers(inputText);
  if (!allowed.length) return extractPercents(outputText).length ? (extractPercents(outputText)[0] + '%') : null;
  const near = (v, a) => Math.abs(v - a) <= Math.max(0.05, Math.abs(a) * 0.005);
  for (const v of extractPercents(outputText)) {
    const ok = allowed.some(a => near(v, a) || near(v, a * 100) || (a !== 0 && near(v, a / 100)));
    if (!ok) return v + '%';
  }
  return null;
}

/* ------------------------------ 用量守门 ------------------------------ */

/** 每日 token 软上限（默认 200k：按 deepseek 单价约几毛钱，足够 A1+A4 常态运行）。
 *  超限后拒绝新的 LLM 调用并记录原因——成本失控保护，用户可在配置里调大。 */
function usageGate(cfg, usage) {
  const cap = (cfg.agent && cfg.agent.maxTokensPerDay) || 200000;
  if (usage.tokensIn + usage.tokensOut >= cap) {
    return '今日用量已达上限 ' + cap + ' tokens（config.agent.maxTokensPerDay 可调）';
  }
  return null;
}

/* ------------------------------ DeepSeek 客户端 ------------------------------ */

/**
 * 结构化抽取调用：Chat Completions + JSON 模式 + 空白兜底重试。
 * 返回 { ok, data, usage } 或 { ok: false, skipped?, error }。永不抛异常。
 */
async function chatJSON(cfg, messages, { maxTokens = 1024, temperature = 0.2 } = {}) {
  const ac = cfg.agent || {};
  if (!ac.enabled) return { ok: false, skipped: 'disabled' };
  const key = ac.apiKey || '';
  if (!key || !/^sk-/.test(key)) return { ok: false, skipped: 'no_api_key' };

  const gate = usageGate(cfg, loadUsage());
  if (gate) return { ok: false, skipped: 'usage_cap', error: gate };

  const model = ac.model || 'deepseek-chat';
  const baseUrl = (ac.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = baseUrl + '/chat/completions';

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
    response_format: { type: 'json_object' } // JSON 模式：硬约束②的空白兜底在下方处理
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let content = null;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          signal: ctl.signal,
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
          body: JSON.stringify(attempt === 2 ? body : body)
        });
      } finally { clearTimeout(t); }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error('HTTP ' + res.status + (txt ? ' ' + txt.slice(0, 160) : ''));
      }
      const j = await res.json();
      const choice = j && j.choices && j.choices[0];
      content = choice && choice.message && choice.message.content;
      /* 硬约束②：JSON 模式失败时 content 是空白而 finish_reason 仍是 stop */
      const blank = content == null || !String(content).trim();
      if (j && j.usage) {
        bumpUsage({
          tokensIn: loadUsage().tokensIn + (j.usage.prompt_tokens || 0),
          tokensOut: loadUsage().tokensOut + (j.usage.completion_tokens || 0),
          calls: loadUsage().calls + 1, lastOkAt: Date.now()
        });
      }
      if (blank) {
        lastErr = 'blank_content';
        if (attempt === 1) {
          // 空白兜底重试：加强指令后再试一次
          messages = messages.concat([{ role: 'user', content: '上一次输出为空。只输出一个合法的 JSON 对象，不要输出任何解释、markdown 代码块或其他文字。' }]);
          await new Promise(r => setTimeout(r, 800));
          continue;
        }
        break;
      }
      // 剥掉可能的 markdown 围栏再解析
      let s = String(content).trim();
      const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
      if (fence) s = fence[1].trim();
      const data = JSON.parse(s);
      return { ok: true, data, usage: j.usage || null, model };
    } catch (e) {
      lastErr = e.name === 'AbortError' ? 'timeout_' + TIMEOUT_MS + 'ms' : (e.message || String(e));
      if (attempt === 1) { await new Promise(r => setTimeout(r, 2000)); continue; } // 网络错重试一次
    }
  }
  bumpUsage({ errors: loadUsage().errors + 1, lastError: String(lastErr).slice(0, 200), lastErrorAt: Date.now() });
  return { ok: false, error: String(lastErr) };
}

/* ------------------------------ 网关校验 ------------------------------ */

/** 全文禁词检查：任何字段出现买卖指令词即拒绝 */
function hasForbiddenAdvice(obj) {
  const text = JSON.stringify(obj);
  return FORBIDDEN_ADVICE.filter(w => text.includes(w));
}

/* ------------------------------ A1：公告解读（R1 抽取） ------------------------------ */

const A1_DIRECTIONS = ['利好', '利空', '中性', '不确定'];
const A1_CONFIDENCE = ['low', 'medium', 'high'];

function validateA1(d) {
  if (!d || typeof d !== 'object') return '输出不是对象';
  if (!A1_DIRECTIONS.includes(d.direction)) return 'direction 非法: ' + d.direction;
  if (!A1_CONFIDENCE.includes(d.confidence)) return 'confidence 非法: ' + d.confidence;
  if (!Array.isArray(d.keyFacts) || !d.keyFacts.length) return 'keyFacts 为空';
  for (const f of d.keyFacts.slice(0, 8)) {
    if (!f || typeof f.fact !== 'string' || f.fact.length < 2 || f.fact.length > 120) return 'keyFacts.fact 长度非法';
  }
  if (typeof d.plainSummary !== 'string' || !d.plainSummary.trim() || d.plainSummary.length > 160) return 'plainSummary 缺失或过长';
  const bad = hasForbiddenAdvice(d);
  if (bad.length) return '出现禁词（买卖建议）: ' + bad.join('/');
  if (!Array.isArray(d.uncertainty)) d.uncertainty = [];
  if (!Array.isArray(d.riskFlags)) d.riskFlags = [];
  return null;
}

/** 把 events-feed.jsonl 中指定 feedId 的行整体替换（3000 行内全量重写，原子写） */
function rewriteFeedRow(feedId, patch) {
  if (!fs.existsSync(FEED)) return false;
  const lines = fs.readFileSync(FEED, 'utf8').split('\n');
  const out = [];
  let hit = false;
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s);
      if (row.feedId === feedId && row.interpreted === false) {
        out.push(JSON.stringify({ ...row, ...patch }));
        hit = true;
      } else out.push(s);
    } catch (_) { out.push(s); }
  }
  if (!hit) return false;
  const tmp = FEED + '.tmp';
  fs.writeFileSync(tmp, out.join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, FEED);
  return true;
}

/** 幂等：同一条公告只分流一次 Flag */
function flagExistsForFeed(feedId) {
  return readJsonl(FLAG_FILE).some(f => f.feedId === feedId);
}

/**
 * A1 主流程：解读 events-feed.jsonl 中未解读的公告增量。
 * interpreted 字段约定：false=待解读，true=已解读，'error'=解读失败不再重试。
 */
async function interpretPending(cfg, { limit, force } = {}) {
  const acfg = (cfg.agent && cfg.agent.a1) || {};
  if (!(cfg.agent || {}).enabled || !acfg.enabled) return { ok: true, skipped: 'a1_disabled' };
  const maxPerRun = limit || acfg.maxPerRun || 4;
  const rows = readJsonl(FEED).filter(r => r.interpreted === false).slice(0, maxPerRun);
  if (!rows.length) return { ok: true, added: 0, note: '无待解读公告' };

  const done = [], failed = [];
  for (const row of rows) {
    const inputText = [row.title, (row.columns || []).join('/'), row.name].join(' ');
    const messages = [
      {
        role: 'system',
        content: '你是 A 股公告事实抽取器（R1 角色）。纪律：只依据给定的公告标题与栏目分类做抽取和保守判断；标题没写的内容一律放进 uncertainty，禁止推测、禁止编造、禁止计算任何数字、禁止给出任何买卖建议。输出一个 JSON 对象，字段：direction（"利好"|"利空"|"中性"|"不确定"）、confidence（"low"|"medium"|"high"）、keyFacts（数组，每项 {fact: 改写自标题的客观事实, fromTitle: true}，最多 5 条）、riskFlags（数组，标题可见的风险点，没有就空数组）、plainSummary（一句股民能听懂的大白话，不超过 60 字）、uncertainty（数组，标题没说清的关键信息）。'
      },
      {
        role: 'user',
        content: '股票：' + (row.name || '') + '（' + row.code + '）\n公告栏目：' + (row.columns || []).join(' / ') + '\n公告标题：' + row.title + '\n\n请输出 JSON。'
      }
    ];
    const r = await chatJSON(cfg, messages, { maxTokens: 700, temperature: 0.1 });
    if (!r.ok) {
      failed.push({ feedId: row.feedId, error: r.error || r.skipped });
      rewriteFeedRow(row.feedId, { interpreted: 'error', interpretError: String(r.error || r.skipped).slice(0, 120), interpretedAt: Date.now() });
      continue;
    }
    const verr = validateA1(r.data);
    if (verr) {
      failed.push({ feedId: row.feedId, error: '校验不过: ' + verr });
      rewriteFeedRow(row.feedId, { interpreted: 'error', interpretError: verr, interpretedAt: Date.now() });
      continue;
    }
    // 来源锚点由代码注入（feedId + link + sourceGrade），LLM 不产锚点
    const interpretation = {
      direction: r.data.direction,
      confidence: r.data.confidence,
      keyFacts: r.data.keyFacts.slice(0, 5),
      riskFlags: (r.data.riskFlags || []).slice(0, 5),
      plainSummary: r.data.plainSummary,
      uncertainty: (r.data.uncertainty || []).slice(0, 5),
      model: r.model,
      sourceRef: row.feedId,
      link: row.link,
      verifyHint: row.verifyHint || '标题为转载口径，事实以巨潮资讯网原文为准'
    };
    rewriteFeedRow(row.feedId, { interpreted: true, interpretation, interpretedAt: Date.now() });
    done.push({ feedId: row.feedId, code: row.code, name: row.name, direction: interpretation.direction, confidence: interpretation.confidence });

    // 四路分流的 Flag 路：高置信利空才预警，且永不改分（affectsScore false）
    if (interpretation.direction === '利空' && (interpretation.confidence === 'high' || interpretation.confidence === 'medium') && !flagExistsForFeed(row.feedId)) {
      const level = interpretation.confidence === 'high' ? '强警示' : '提示';
      appendJsonl(FLAG_FILE, {
        flagId: 'F-AI-' + row.code + '-' + beijingDate() + '-' + String(Date.now()).slice(-4),
        feedId: row.feedId,
        symbol: row.code,
        name: row.name || '',
        triggerTs: row.annAt ? new Date(row.annAt + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00' : null,
        level,
        ruleId: 'ai_announcement_reading',
        title: '公告解读（AI，' + interpretation.confidence + ' 置信）：' + row.title.slice(0, 40),
        detail: interpretation.plainSummary + '｜AI 仅解读标题口径，原文以巨潮为准',
        sourceGrade: 'B',
        sourceRefs: [row.link, row.feedId],
        sampleN: 1, counterN: 0,
        feedback: null,
        affectsScore: false,
        status: 'active',
        interpretedBy: r.model,
        recordedAt: Date.now()
      });
    }
  }
  return { ok: true, interpreted: done.length, flagged: done.filter(d => d.direction === '利空').length, failed: failed.length, detail: { done, failed } };
}

/* ------------------------------ A4：复盘二次处理（R2 假说 + R4 翻译） ------------------------------ */

function validateA4(d, inputText) {
  if (!d || typeof d !== 'object') return '输出不是对象';
  if (typeof d.marketNarrative !== 'string' || d.marketNarrative.length < 20 || d.marketNarrative.length > 600) return 'marketNarrative 缺失或长度非法';
  if (!Array.isArray(d.todayFocus) || !d.todayFocus.length || d.todayFocus.length > 5) return 'todayFocus 应为 1-5 条';
  for (const s of d.todayFocus) if (typeof s !== 'string' || s.length > 120) return 'todayFocus 条目过长';
  if (!Array.isArray(d.hypotheses) || !d.hypotheses.length || d.hypotheses.length > 3) return 'hypotheses 应为 1-3 张';
  for (const h of d.hypotheses) {
    if (!h || typeof h.title !== 'string' || h.title.length < 4 || h.title.length > 60) return '假说 title 长度非法';
    if (!Array.isArray(h.mechanism) || !h.mechanism.length) return '假说 ' + h.title + ' 缺 mechanism';
    if (typeof h.falsifyCondition !== 'string' || h.falsifyCondition.length < 8) return '假说 ' + h.title + ' 缺证伪条件（falsifyCondition）';
    if (!Array.isArray(h.observables) || !h.observables.length) return '假说 ' + h.title + ' 缺 observables';
  }
  const bad = hasForbiddenAdvice(d);
  if (bad.length) return '出现禁词（买卖建议）: ' + bad.join('/');
  // 禁编造数字：输出中的百分数必须来自输入统计
  const invented = checkNoInventedPercents(d.marketNarrative + ' ' + JSON.stringify(d.hypotheses) + ' ' + d.todayFocus.join(' '), inputText);
  if (invented) return '输出出现输入中不存在的数字: ' + invented;
  if (!Array.isArray(d.experienceCandidates)) d.experienceCandidates = [];
  return null;
}

/** 当日简报是否已存在（幂等：A4 每交易日一次） */
function briefOfDate(date) {
  return readJsonl(BRIEF_FILE).find(b => b.date === date) || null;
}

/**
 * A4 主流程：确定性统计 → 人话日报 + 假说卡。
 * statsInput 由 server.js 收集（数字全部由代码给出，模型只组织语言与提假说）。
 */
async function makeBrief(cfg, statsInput, { force } = {}) {
  const acfg = (cfg.agent && cfg.agent.a4) || {};
  if (!(cfg.agent || {}).enabled || !acfg.enabled) return { ok: true, skipped: 'a4_disabled' };
  const date = beijingDate();
  if (!force && briefOfDate(date)) return { ok: true, skipped: 'already_generated', briefId: briefOfDate(date).briefId };
  if (!statsInput || !Object.keys(statsInput).length) return { ok: false, skipped: 'stats_empty', error: '确定性统计缓存未就绪' };

  const inputText = JSON.stringify(statsInput);
  if (inputText.length > 12000) return { ok: false, error: '统计摘要过大（' + inputText.length + ' 字符），需裁剪' };

  const baseMessages = [
    {
      role: 'system',
      content: '你是 A 股复盘助手（R2 假说 + R4 翻译角色）。输入是程序算好的当日统计摘要（全部数字由代码给出）。纪律：只组织语言和提出假说，禁止自己计算或编造任何新数字（可以引用输入里的数字，包括百分数，但一个都不能改、不能新增）；禁止给出任何买卖建议；每张假说必须写清可观察指标（observables）和证伪条件（falsifyCondition），说清楚「看到什么现象就说明这个假说错了」。输出一个 JSON 对象，字段：marketNarrative（今日两市与风格的人话描述，120-300 字）、hypotheses（1-3 张，每项 {title, mechanism: string[], observables: string[], falsifyCondition}）、todayFocus（1-5 条，股民今日最该盯的事，每条一句）、experienceCandidates（0-2 条，值得沉淀的经验候选，每项 {claim, evidence}，没有就空数组）。'
    },
    { role: 'user', content: '当日统计摘要（数字由程序计算，可直接引用）：\n' + inputText + '\n\n请输出 JSON。' }
  ];

  /* 两段式：第一轮校验不过（常见于模型自发计算了个百分数）→ 带错误提示重试一次 */
  let r = null, data = null, verr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages = attempt === 2
      ? baseMessages.concat([{ role: 'user', content: '上一次输出被网关拒绝，原因：' + verr + '。请严格修正：只允许引用输入摘要中出现过的数字与百分数，禁止出现任何输入里没有的数值。重新输出 JSON。' }])
      : baseMessages;
    r = await chatJSON(cfg, messages, { maxTokens: 2000, temperature: attempt === 2 ? 0.1 : 0.3 });
    if (!r.ok) return r;
    verr = validateA4(r.data, inputText);
    if (!verr) { data = r.data; break; }
    if (attempt === 1) console.warn('[agent-a4] 第一轮校验不过，重试: ' + verr);
  }
  if (!data) {
    bumpUsage({ errors: loadUsage().errors + 1, lastError: 'A4 校验不过（已重试）: ' + verr, lastErrorAt: Date.now() });
    return { ok: false, error: '校验不过（已重试一次）: ' + verr };
  }

  // 幂等重试兜底：并发/重复触发时只保留当日第一条
  const exist = briefOfDate(date);
  if (exist && !force) return { ok: true, skipped: 'already_generated', briefId: exist.briefId };

  const briefId = 'B-' + date.replace(/-/g, '');
  const hypoRows = [];
  (data.hypotheses || []).slice(0, 3).forEach((h, i) => {
    hypoRows.push({
      hypId: 'H-AI-' + date.replace(/-/g, '') + '-' + String(i + 1).padStart(2, '0'),
      title: h.title,
      scope: 'market',
      patternFamily: 'ai_daily_hypothesis',
      mechanism: (h.mechanism || []).slice(0, 6),
      observables: (h.observables || []).slice(0, 6),
      falsifyCondition: h.falsifyCondition,
      supportN: 0,
      contradictN: 0,
      status: 'proposed',
      registeredAt: Date.now(),
      sourceRefs: [briefId + '@daily-brief（统计摘要由程序计算）'],
      promotionGate: 'AI 生成假说：人工采纳前 affectsScore 恒为 false；须累计独立样本并经人工审核方可晋升',
      note: 'A4 复盘二次处理产出，模型只组织语言与提假说，统计数字全部由代码给出'
    });
  });

  appendJsonl(BRIEF_FILE, {
    briefId,
    date,
    model: r.model,
    statsDigest: statsInput,          // 锚点：当日统计原文（可复算）
    marketNarrative: data.marketNarrative,
    hypotheses: hypoRows.map(h => h.hypId),
    todayFocus: data.todayFocus.slice(0, 5),
    experienceCandidates: (data.experienceCandidates || []).slice(0, 2),
    tokens: r.usage ? (r.usage.total_tokens || null) : null,
    affectsScore: false,
    generatedAt: Date.now()
  });
  for (const h of hypoRows) appendJsonl(HYPO_FILE, h);

  return { ok: true, briefId, hypotheses: hypoRows.length, note: '假说卡已写入 hypotheses.jsonl（status=proposed，待人工审核）' };
}

/* ------------------------------ 状态与连通测试 ------------------------------ */

function maskKey(k) {
  if (!k) return null;
  return k.length > 10 ? k.slice(0, 6) + '****' + k.slice(-4) : 'sk-****';
}

async function testConnection(cfg) {
  const r = await chatJSON(cfg, [
    { role: 'system', content: '输出一个 JSON 对象：{"ok": true}' },
    { role: 'user', content: '连通性测试，请输出 JSON。' }
  ], { maxTokens: 32, temperature: 0 });
  return r;
}

function status(cfg) {
  const ac = cfg.agent || {};
  const usage = loadUsage();
  const feed = readJsonl(FEED);
  return {
    ok: true,
    enabled: !!ac.enabled,
    keyConfigured: !!(ac.apiKey && /^sk-/.test(ac.apiKey)),
    keyMasked: maskKey(ac.apiKey),
    model: ac.model || 'deepseek-chat',
    baseUrl: ac.baseUrl || 'https://api.deepseek.com',
    a1: { enabled: !!((ac.a1 || {}).enabled), pending: feed.filter(r => r.interpreted === false).length, maxPerRun: (ac.a1 || {}).maxPerRun || 4 },
    a4: { enabled: !!((ac.a4 || {}).enabled), hour: (ac.a4 || {}).hour || '22:00', briefToday: !!briefOfDate(beijingDate()) },
    usage: { day: usage.day, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, calls: usage.calls, errors: usage.errors, cap: ac.maxTokensPerDay || 200000 },
    lastError: usage.lastError, lastErrorAt: usage.lastErrorAt, lastOkAt: usage.lastOkAt,
    note: '薄适配器只做 A1 公告解读与 A4 复盘简报；输出永不改分（affectsScore 恒 false）；禁词与数字校验不过即丢弃'
  };
}

function readBriefs({ limit = 10 } = {}) {
  return readJsonl(BRIEF_FILE).slice(-limit).reverse();
}

module.exports = {
  interpretPending, makeBrief, testConnection, status, readBriefs,
  DIR, BRIEF_FILE, FLAG_FILE, HYPO_FILE, USAGE_FILE
};
