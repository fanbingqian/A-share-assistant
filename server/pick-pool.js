'use strict';
/**
 * pick-pool.js — 09:05 预测股票池（定格 + 当晚复盘）
 *
 * 与 journal.js 的分工：
 *   - journal.js 的 picks.jsonl 是「评分观察池」定格（signal=重点关注/观察等），由 stocks.js 评分驱动；
 *   - 本模块复用 journal.snapshot 的落盘与 reviewPending 的复盘能力，但定格对象是「三类选股的推荐」：
 *     板块领跑股(leader) + 重点关注(high score)，并在 note 里标注 source='09:05-recommend'。
 *
 * 时间点（北京时间，交易日）：
 *   09:05  用最近一次选股结果（昨日 15:40 生成）+ 领跑判定，定格当日预测池（kind=open，参考价=上一交易日收盘）
 *   20:30  当日日线齐备后，调用 journal.reviewPending 复盘 open 定格（用当日收盘价算收益/超额/命中）
 *
 * 幂等：同一天 journal.snapshot 已有 id 则跳过；复盘按 pickId+code 去重。
 * 纪律：只定格程序已算出的推荐，不新增荐股；复盘基准取不到记 null，不编造。
 */

const fs = require('node:fs');
const path = require('node:path');
const journal = require('./journal');
const insightMod = require('./pick-insight');

const DATA = path.join(__dirname, '..', 'data');
const POOL_FILE = path.join(DATA, 'pick-pool-state.json');

function readJson(file) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return null;
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function bjNow() { return new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); }
function bjDate(ts = Date.now()) { return new Date(ts + 8 * 3600e3).toISOString().slice(0, 10); }

/** 参考价：优先 stocks-cache 现价（盘前为昨收），其次涨停池价格 */
function priceOf(code, ctx) {
  const st = ctx.stockByCode && ctx.stockByCode.get(code);
  if (st && st.price != null && Number.isFinite(+st.price)) return +st.price;
  const zt = ctx.limitUpByCode && ctx.limitUpByCode.get(code);
  if (zt && zt.price != null && Number.isFinite(+zt.price)) return +zt.price;
  return null;
}

/**
 * 09:05 定格：从 pick-insight 取领跑股 + 高分推荐，构造定格项写入 journal picks.jsonl。
 * @param {object} opts { date, limit }
 */
function freeze(opts = {}) {
  const date = opts.date || bjDate();
  const limit = Math.max(3, Math.min(24, Number(opts.limit || 12)));
  const ctx = insightMod.loadContext();
  let ins = readJson(insightMod.OUT);
  if (!ins || !Array.isArray(ins.items) || !ins.items.length) ins = insightMod.build();

  // 选推荐：领跑股优先，其次评分最高的热度/趋势股；不足则用跟随股补充
  const leaders = new Set((ins.leaders || []).map(x => x.code));
  const pool = ins.items.slice().sort((a, b) => {
    const la = leaders.has(a.code) ? 1 : 0, lb = leaders.has(b.code) ? 1 : 0;
    if (la !== lb) return lb - la;
    return (b.score || 0) - (a.score || 0);
  }).slice(0, limit);

  const items = pool.map(x => ({
    code: x.code,
    name: x.name,
    industry: x.industry,
    score: x.score,
    // signal 用可复盘的角色标注，不用买卖措辞
    signal: x.role === 'leader' ? '板块领跑' : (x.role === 'follower' ? '跟随候选' : '独立标的'),
    price: x.last != null ? x.last : priceOf(x.code, ctx),
    bucket: null,           // 无市值分层数据，复盘基准记 null（不编造）
    changePct: null,
    // 附加证据（journal.pickItemOf 会忽略未知字段，这里另存在 note 侧文件供展示）
    role: x.role,
    leadBasis: x.role === 'leader' ? (ins.leaders.find(l => l.code === x.code) || {}).basis || null : null,
    driverSummary: x.driverSummary,
    driverRefs: x.riseDrivers
  }));

  const snapshot = journal.snapshot(items, {
    date,
    kind: 'open',
    limit: items.length,
    note: '09:05 三类选股推荐定格（板块领跑+高分候选）；参考价为定格时点价，复盘用当日收盘。来源=pick-pool'
  });

  const state = readJson(POOL_FILE) || { days: {} };
  state.days = state.days || {};
  state.days[date] = {
    frozenAt: bjNow(),
    snapshot,
    count: items.length,
    leaders: items.filter(x => x.role === 'leader').map(x => x.code),
    items: items.map(x => ({ code: x.code, name: x.name, industry: x.industry, score: x.score, role: x.role, signal: x.signal, price: x.price, driverSummary: x.driverSummary, driverRefs: x.driverRefs }))
  };
  writeJson(POOL_FILE, state);
  return { ok: snapshot.ok, date, snapshot, count: items.length, leaders: state.days[date].leaders.length };
}

/** 当晚复盘：调用 journal.reviewPending 复盘所有 open 定格（含当日 09:05 池） */
async function review(opts = {}) {
  const date = opts.date || bjDate();
  const r = await journal.reviewPending({});
  const state = readJson(POOL_FILE) || { days: {} };
  state.days = state.days || {};
  state.days[date] = state.days[date] || {};
  state.days[date].reviewedAt = bjNow();
  state.days[date].review = { ok: !!r.ok, reviewed: r.reviewed, pending: r.pending };
  writeJson(POOL_FILE, state);
  return { ok: !!r.ok, date, reviewed: r.reviewed, pending: r.pending, sample: (r.sample || []).slice(0, 20) };
}

/** 今日池视图（前端/API 用） */
function today(opts = {}) {
  const date = opts.date || bjDate();
  const state = readJson(POOL_FILE) || { days: {} };
  const d = (state.days || {})[date] || null;
  const outcomes = journal.listOutcomes({ days: 7 });
  const mine = d ? outcomes.filter(o => o.date === date) : [];
  return {
    ok: true, date,
    frozen: !!d,
    pool: d ? { frozenAt: d.frozenAt, count: d.count, leaders: d.leaders, items: d.items, review: d.review || null } : null,
    outcomes: mine
  };
}

function status() {
  const state = readJson(POOL_FILE) || { days: {} };
  const dates = Object.keys(state.days || {}).sort();
  return { ok: true, lastDate: dates[dates.length - 1] || null, totalDays: dates.length, file: POOL_FILE };
}

module.exports = { freeze, review, today, status, POOL_FILE, bjDate };
