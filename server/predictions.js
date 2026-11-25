/**
 * predictions.js —— 大盘方向预测账本（可证伪 · 可复盘 · 可进化）
 *
 * 与 journal.js 的分工：
 *   - journal.js 的 outcomes.jsonl：个股评分的 T+N 复盘（针对 picks.jsonl 定格个股）
 *   - 本模块 predictions.jsonl：大盘方向预测（marketForecast 的「偏强/偏弱/中性/需等待确认」）事后命中检验
 *
 * 设计原则：
 *   1. 预测由 Hermes 基于程序快照生成，本模块只存「结构化结论 + 快照数字 + 证伪条件」，不改分、不编数字。
 *   2. 同一交易日幂等：重复生成预测只更新文本，不新增行（避免一天多条噪音）。
 *   3. 复盘自动回填实际涨跌：优先用 ic.fetchKline('000001') 查次日沪指涨跌幅；
 *      失败则保留 status=pending，等数据源恢复后再复盘，绝不编造实际结果。
 *   4. 命中判定：偏强→次日沪指 > +0.3%；偏弱→ < -0.3%；中性/需等待确认→ [-0.3%, +0.3%] 区间内。
 *      阈值 0.3% 用来过滤噪音，属于「方向」判断而非点位承诺。
 *   5. 所有输出供经验回流与知识抽取使用，绝不写回智能体四层约束（L1 BASE_SYSTEM / L2 拦截 / L3 GUARDRAIL / L4 SOUL）。
 *
 * 数据文件：data/predictions.jsonl（只追加 + 幂等重写）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PRED_FILE = path.join(DATA_DIR, 'predictions.jsonl');
const ACTUAL_FILE = path.join(DATA_DIR, 'predictions-actual.json');
const THRESHOLD = 0.3; // 方向判定阈值（%）

function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {} }

function readAll() {
  ensureDir();
  if (!fs.existsSync(PRED_FILE)) return [];
  try {
    return fs.readFileSync(PRED_FILE, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function writeAll(rows) {
  ensureDir();
  const tmp = PRED_FILE + '.tmp';
  fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, PRED_FILE);
}

/* -------- 本地实际涨跌累积（自包含，零外部依赖，VPN 环境也能复盘） -------- */
function readActual() {
  ensureDir();
  if (!fs.existsSync(ACTUAL_FILE)) return { days: {} };
  try { const j = JSON.parse(fs.readFileSync(ACTUAL_FILE, 'utf8')); return j && typeof j === 'object' ? j : { days: {} }; }
  catch (_) { return { days: {} }; }
}
function writeActual(j) {
  ensureDir();
  const tmp = ACTUAL_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
  fs.renameSync(tmp, ACTUAL_FILE);
}
/** 记录某交易日大盘实际涨跌（来自当日 marketMonitor 快照的 shPct，程序计算值，非编造） */
function recordActual(tradingDate, shPct, note) {
  if (!tradingDate || shPct == null || !isFinite(shPct)) return { ok: false };
  const j = readActual();
  j.days = j.days || {};
  const prev = j.days[tradingDate];
  // 盘中值会被多次写入：只保留「收盘后」的值（trading=false 或更晚时间），避免用盘中临时值定案
  const isClose = note === 'close' || note === false;
  if (!prev || isClose || (prev.intraday && !isClose === false)) {
    j.days[tradingDate] = { shPct: Math.round(shPct * 100) / 100, intraday: !isClose, updatedAt: new Date().toISOString() };
    writeActual(j);
  }
  return { ok: true, tradingDate, shPct: j.days[tradingDate].shPct };
}
/** 找出某交易日之后的下一个「已有实际数据」的交易日（按日期升序） */
function nextActualDate(tradingDate) {
  const j = readActual();
  const dates = Object.keys(j.days || {}).filter(d => d > tradingDate && j.days[d].shPct != null).sort();
  return dates.length ? { date: dates[0], shPct: j.days[dates[0]].shPct, source: 'local-accumulated' } : null;
}

/** 从 Hermes 预测文本里抽取方向倾向（枚举四档，抽不到记 unknown） */
function extractDirection(text) {
  const s = String(text || '');
  const match = (re) => { const m = s.match(re); return m ? m[1] : null; };
  // 优先取明确结论行：「结论：偏弱」「方向：偏强」「倾向：中性」等（主判断，不看括号补充）
  const d = match(/(?:结论|方向|倾向|判断)\s*[:：]\s*(偏强|偏弱|中性|需等待确认)/) ||
            match(/\*\*\s*(?:结论|方向|倾向|判断)?\s*[:：]?\s*(偏强|偏弱|中性|需等待确认)/);
  if (d) return d;
  // 次选：正文中出现的主方向词（偏强/偏弱 优先于括号里的"需等待确认"）
  if (/偏强|偏多|走强/.test(s)) return '偏强';
  if (/偏弱|偏空|走弱/.test(s)) return '偏弱';
  if (/中性|震荡|持平/.test(s)) return '中性';
  if (/需等待确认|等待确认|尚不明确|信号不足/.test(s)) return '需等待确认';
  return 'unknown';
}

/** 抽取证伪条件句（若 Hermes 写了「证伪：...」/「如果...则判断错误」） */
function extractFalsifier(text) {
  const s = String(text || '');
  // 形如「证伪条件：xxx」或「## 证伪条件（说明）\n- xxx」：取标题后本行，若本行只是括号说明则取紧随其后的前 2 条列表项
  const labeled = s.match(/证伪条件?\s*[:：]\s*([^\n]{1,300})/);
  if (labeled && labeled[1].trim()) return labeled[1].trim().slice(0, 300);
  const heading = s.match(/证伪条件[^\n]*\n((?:[^\n]*\n){0,3})/);
  if (heading) {
    const items = heading[1].split('\n').map(x => x.trim()).filter(x => /^[-*•]|\d+[.、]|如果|看到|若|一旦/.test(x));
    if (items.length) return items.slice(0, 2).join(' ').slice(0, 300);
  }
  const m = s.match(/(如果[^\n。]{0,80}(?:则|说明)[^\n。]{0,80}(?:错|误|失效)|看到[^\n。]{0,80}(?:说明|证明)[^\n。]{0,80}错)/);
  return m ? m[0].slice(0, 300) : null;
}

/**
 * 记录一次大盘方向预测（幂等：按 tradingDate 去重）。
 * @param {object} forecastResult daily.marketForecast 的返回值 { ok, monitor, forecast, backend }
 */
function record(forecastResult) {
  if (!forecastResult || !forecastResult.ok || !forecastResult.forecast) {
    return { ok: false, note: '预测文本为空或生成失败，不落盘' };
  }
  const m = forecastResult.monitor || {};
  const tradingDate = m.tradingDate || new Date().toISOString().slice(0, 10);
  const rows = readAll();
  const idx = rows.findIndex(r => r.tradingDate === tradingDate);
  const rec = {
    id: 'M' + String(tradingDate).replace(/-/g, ''),
    tradingDate,
    recordedAt: new Date().toISOString(),
    direction: extractDirection(forecastResult.forecast),
    forecast: String(forecastResult.forecast).slice(0, 4000),
    falsifier: extractFalsifier(forecastResult.forecast),
    backend: forecastResult.backend || null,
    snapshot: {
      amountYi: m.amountYi, ratio20: m.ratio20, state: m.state,
      changePct: m.changePct, indexPct: m.indexPct, shPct: m.shPct, szPct: m.szPct,
      upRatio: m.breadth && m.breadth.upRatio, momentum: m.momentum
    },
    review: null // 复盘后填入 { actualDate, actualShPct, verdict, reviewedAt, source }
  };
  if (idx >= 0) { rows[idx] = { ...rec, review: rows[idx].review || null }; }
  else rows.push(rec);
  writeAll(rows);
  // 同时把当日实际大盘涨跌累积到本地（快照 shPct 即当日实际值，供次日复盘）
  let actualRec = null;
  if (m.shPct != null && isFinite(m.shPct)) actualRec = recordActual(tradingDate, m.shPct, m.trading === false ? 'close' : 'intraday');
  return { ok: true, id: rec.id, direction: rec.direction, dedup: idx >= 0, total: rows.length, actual: actualRec };
}

/** 根据方向 + 实际沪指涨跌判定命中 */
function judge(direction, actualShPct) {
  if (actualShPct == null || !isFinite(actualShPct)) return 'pending';
  if (direction === '偏强') return actualShPct > THRESHOLD ? 'hit' : 'miss';
  if (direction === '偏弱') return actualShPct < -THRESHOLD ? 'hit' : 'miss';
  if (direction === '中性' || direction === '需等待确认') return Math.abs(actualShPct) <= THRESHOLD ? 'hit' : 'miss';
  return 'pending'; // unknown 方向不判定
}

/**
 * 复盘所有未判定 / 待定预测。
 * @param {object} opts { ic, config, fetchNextShPct }
 *   fetchNextShPct(tradingDate) => Promise<{date, shPct} | null>  由调用方注入（用 fetchKline 查下一交易日）
 *   不注入时用保守策略：仅用行内已回填的 actual 数据。
 */
async function review(opts = {}) {
  const rows = readAll();
  const pending = rows.filter(r => !r.review || r.review.verdict === 'pending');
  if (!pending.length) return { ok: true, reviewed: 0, hit: count(rows, 'hit'), miss: count(rows, 'miss'), pending: 0, total: rows.length };

  let reviewed = 0, unresolved = 0;
  for (const r of pending) {
    // 优先用本地自累积的下一交易日实际涨跌；没有再回退到外部 fetchKline 注入
    let actual = nextActualDate(r.tradingDate);
    if (!actual && typeof opts.fetchNextShPct === 'function') {
      try { actual = await opts.fetchNextShPct(r.tradingDate); } catch (_) { actual = null; }
    }
    if (!actual || actual.shPct == null || !isFinite(actual.shPct)) { unresolved++; continue; }
    const verdict = judge(r.direction, actual.shPct);
    r.review = {
      actualDate: actual.date || null,
      actualShPct: Math.round(actual.shPct * 100) / 100,
      verdict,
      reviewedAt: new Date().toISOString(),
      source: actual.source || 'fetchKline(000001)'
    };
    reviewed++;
  }
  if (reviewed) writeAll(rows);
  return {
    ok: true, reviewed, unresolved,
    hit: count(rows, 'hit'), miss: count(rows, 'miss'),
    pending: count(rows, 'pending'), total: rows.length
  };
}

function count(rows, verdict) {
  return rows.filter(r => r.review && r.review.verdict === verdict).length;
}

/** 汇总视图（供 API / 经验回流使用） */
function summary() {
  const rows = readAll();
  const judged = rows.filter(r => r.review && ['hit', 'miss'].includes(r.review.verdict));
  const hit = judged.filter(r => r.review.verdict === 'hit').length;
  const byDirection = {};
  for (const d of ['偏强', '偏弱', '中性', '需等待确认', 'unknown']) {
    const g = judged.filter(r => r.direction === d);
    if (g.length) byDirection[d] = { total: g.length, hit: g.filter(r => r.review.verdict === 'hit').length };
  }
  return {
    ok: true,
    total: rows.length,
    judged: judged.length,
    hit, miss: judged.length - hit,
    hitRate: judged.length ? Math.round(hit / judged.length * 1000) / 10 : null,
    pending: rows.filter(r => !r.review || r.review.verdict === 'pending').length,
    byDirection,
    recent: rows.slice(-8).map(r => ({
      id: r.id, tradingDate: r.tradingDate, direction: r.direction,
      falsifier: r.falsifier, verdict: r.review ? r.review.verdict : 'pending',
      actualShPct: r.review ? r.review.actualShPct : null
    }))
  };
}

function list() { return { ok: true, items: readAll() }; }

module.exports = { record, review, judge, summary, list, recordActual, nextActualDate, extractDirection, extractFalsifier, PRED_FILE, ACTUAL_FILE, THRESHOLD };
