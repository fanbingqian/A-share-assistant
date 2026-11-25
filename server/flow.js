'use strict';

/**
 * 资金主体行为分析（机构 / 游资 / 散户通道 / 杠杆资金）
 *
 * 【要回答的问题】
 * 「机构、游资、社保养老这类长钱，过去一年到底在买什么市值层的股票？
 *   他们的交易习惯是什么（胜率、持仓风格）？现在钱倾向去微盘还是大盘？
 *   哪些股票出现了筹码集中（控盘）迹象？」
 *
 * 【数据与口径】
 * 全部来自公开的东方财富数据中心接口，且都在本文件里可核对：
 *   ① 龙虎榜席位明细 RPT_BILLBOARD_DAILYDETAILSBUY —— 每个「股票 × 席位」的买卖额；
 *   ② 龙虎榜个股汇总 RPT_DAILYBILLBOARD_DETAILSNEW —— 个股流通市值、上榜原因、D1/D5 次日涨幅；
 *   ③ 融资融券个股 RPTA_WEB_RZRQ_GGMX —— 融资余额、融券余额、融资净买入；
 *   ④ 大宗交易 RPT_DATA_BLOCKTRADE —— 机构协议转让的折价与金额；
 *   ⑤ 股东户数 RPT_HOLDERNUMLATEST —— 筹码集中度（户数下降 = 筹码收集）。
 * 北向资金：交易所已停止披露实时净买入，不猜测；仅当「十大流通股东」里出现
 * 香港中央结算时，在个股层面标注北向持股（由 events / journal 流程使用）。
 *
 * 【主体分类是操作化定义，不是江湖传说】
 *   机构专用（席位名含「机构专用」）→ 机构；
 *   沪深股通（席位名含「沪股通 / 深股通」）→ 北向通道；
 *   拉萨系（席位名含「拉萨」）→ 散户互联网通道（东财拉萨天团，代表散户拥挤度）；
 *   其余营业部 → 「活跃席位」，其中一年上榜 ≥ 20 次的称为「高频游资」。
 * 每个主体的胜率、偏好市值层、平均净买入，全部由回填数据统计得出，不引用任何坊间称号。
 *
 * 【样本要求】
 * 用户要求样本不少于一年、并覆盖单边与震荡行情。回填从「一年前」开始，每轮 20 个自然日，
 * 增量推进；两融市场合计因接口无汇总报表，历史按月抽样（每月 15 日附近一天），
 * 之后每日累积——月度粒度足够判断趋势与分位，这个取舍在 README 里写明。
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'flow-state.json');
const CACHE_FILE = path.join(DATA_DIR, 'flow-cache.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

const PAGE = 500;
const WINDOW_DAYS = 20;        // 每轮回填的自然日窗口
const LOOKBACK_DAYS = 370;     // 一年样本
const HF_SEAT_MIN = 20;        // 高频游资门槛：一年上榜 ≥ 20 次
const MARGIN_SAMPLE_DAY = 15;  // 两融历史抽样日
const TTL = 30 * 60 * 1000;

/* --------------------------------- 工具 --------------------------------- */

function round(x, n = 2) { if (!Number.isFinite(x)) return null; const p = Math.pow(10, n); return Math.round(x * p) / p; }
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const yi = v => round((Number(v) || 0) / 1e8, 2); // 元 → 亿元

function beijing(ts = Date.now()) { return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function addDays(str, n) { const d = new Date(str + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

function fetchJson(url, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const req = https.get(url, { headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' }, timeout }, res => {
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let buf = [];
      res.on('data', d => buf.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(buf).toString('utf8'))); } catch (e) { reject(new Error('JSON 解析失败')); } });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

async function fetchReport(reportName, filter, maxPages = 12) {
  const out = [];
  for (let pn = 1; pn <= maxPages; pn++) {
    const url = DC + '?reportName=' + reportName + '&columns=ALL&pageNumber=' + pn +
      '&pageSize=' + PAGE + '&client=WEB' + (filter ? '&filter=' + filter : '');
    const j = await fetchJson(url).catch(() => null);
    const res = j && j.result;
    if (!res || !Array.isArray(res.data) || !res.data.length) break;
    out.push(...res.data);
    if (out.length >= (res.count || 0) || res.data.length < PAGE) break;
    await sleep(120);
  }
  return out;
}

/** 与 marketStyle 完全一致的市值分层，保证两个模块对「微盘/小盘/中盘/大盘」的口径相同 */
function bucketOf(floatCap) {
  const c = Number(floatCap);
  if (!Number.isFinite(c) || c <= 0) return null;
  if (c < 5e9) return 'micro';
  if (c < 1.5e10) return 'small';
  if (c < 5e10) return 'mid';
  return 'large';
}

/**
 * 交易所对「严重异常波动」股票会披露投资者结构（自然人 / 机构投资者 / 中小投资者 / 其他自然人），
 * 这些行的金额是「异常期间累计值」而非当日席位交易，混入会严重扭曲统计（单条可达数百亿）。
 * 处理：白名单式识别席位——名字不含证券/营业部/分公司等关键词的一律归为 anon 并整行跳过。
 */
const ANON_SEAT = /^(自然人|机构投资者|中小投资者|其他自然人|机构|其他|一般法人|合格境外投资者)$/;

function seatKind(name) {
  const n = String(name || '').trim();
  if (ANON_SEAT.test(n)) return 'anon';
  if (n.includes('机构专用')) return 'org';
  if (n.includes('沪股通') || n.includes('深股通')) return 'north';
  if (n.includes('拉萨')) return 'lhasa';
  if (n.includes('证券') || n.includes('营业部') || n.includes('分公司') || n.includes('资产管理') || n.includes('银行')) return 'seat';
  return 'anon';
}

/* --------------------------------- 状态 --------------------------------- */

const EMPTY_STATE = () => ({
  version: 2,
  lhbStart: null,      // 回填起点
  lhbCursor: null,     // 已聚合到的日期（含）
  days: {},            // 按日汇总（主体 × 市值层净买）
  daySeats: {},        // 按日 × 席位 明细聚合（席位画像由此按需计算，天然幂等）
  margin: {},          // 两融市场合计（按日）
  marginMonths: [],    // 已抽样的月份
  updatedAt: 0,
  lastError: null
});

function readState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return { ...EMPTY_STATE(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch (_) {}
  }
  return EMPTY_STATE();
}

function writeState(st) {
  st.updatedAt = Date.now();
  // 只保留最近 400 天，防止无限膨胀
  const cut = addDays(beijing(), -400);
  for (const map of [st.days, st.daySeats]) {
    for (const d of Object.keys(map)) if (d < cut) delete map[d];
  }
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

/* ------------------------------ 龙虎榜回填 ------------------------------ */

/**
 * 聚合一个日期窗口的龙虎榜数据。
 * 每条席位记录 join 个股汇总（拿流通市值 → 市值层，拿 D1 涨幅 → 胜率），
 * join 不到就放弃该条的胜率统计，但不放弃金额统计——口径分开算，互不污染。
 */
async function aggregateWindow(st, from, to) {
  const f = encodeURIComponent("(TRADE_DATE>='" + from + "')(TRADE_DATE<='" + to + "')");
  const summary = await fetchReport('RPT_DAILYBILLBOARD_DETAILSNEW', f, 8);
  if (!summary.length) return { ok: false, rows: 0 };
  const byKey = new Map();
  for (const s of summary) {
    const d = String(s.TRADE_DATE || '').slice(0, 10);
    byKey.set(d + '|' + s.SECURITY_CODE, {
      cap: Number(s.FREE_MARKET_CAP) || null,
      d1: Number(s.D1_CLOSE_ADJCHRATE),
      d5: Number(s.D5_CLOSE_ADJCHRATE)
    });
  }

  const detail = await fetchReport('RPT_BILLBOARD_DAILYDETAILSBUY', f, 14);
  const winDates = new Set();
  for (const r of detail) {
    const kind = seatKind(r.OPERATEDEPT_NAME);
    if (kind === 'anon') continue; // 投资者结构披露行，非席位交易，整行排除
    const d = String(r.TRADE_DATE || '').slice(0, 10);
    const code = r.SECURITY_CODE;
    const info = byKey.get(d + '|' + code) || {};
    const bucket = bucketOf(info.cap);
    const net = Number(r.NET) || 0;
    const buy = Number(r.BUY) || 0;
    const d1 = Number.isFinite(info.d1) ? info.d1 : null;
    winDates.add(d);

    // 按日 × 席位 聚合（画像在读取时从 daySeats 折算，同一天重复拉取会先删除再重建，幂等）
    const seatName = r.OPERATEDEPT_NAME;
    let daySeat = st.daySeats[d];
    if (!daySeat) daySeat = st.daySeats[d] = {};
    let seat = daySeat[seatName];
    if (!seat) seat = daySeat[seatName] = { kind, count: 0, buy: 0, net: 0, d1n: 0, d1Sum: 0, d1Win: 0, buckets: {} };
    seat.count++;
    seat.buy += buy;
    seat.net += net;
    if (bucket) seat.buckets[bucket] = (seat.buckets[bucket] || 0) + net;
    if (d1 != null) { seat.d1n++; seat.d1Sum += d1; if (d1 > 0) seat.d1Win++; }

    // 按日 × 主体 × 市值层
    let day = st.days[d];
    if (!day) day = st.days[d] = { n: 0, net: 0, orgNet: 0, northNet: 0, lhasaNet: 0, seatNet: 0, buckets: {} };
    day.net += net;
    if (kind === 'org') day.orgNet += net;
    else if (kind === 'north') day.northNet += net;
    else if (kind === 'lhasa') day.lhasaNet += net;
    else day.seatNet += net;
    if (bucket) {
      let b = day.buckets[bucket];
      if (!b) b = day.buckets[bucket] = { net: 0, org: 0, seat: 0, north: 0, n: 0 };
      b.net += net; b.n++;
      if (kind === 'org') b.org += net;
      else if (kind === 'north') b.north += net;
      else if (kind !== 'lhasa') b.seat += net;
    }
  }
  // 上榜家数按个股汇总算（同股多席位只算一次）
  const perDay = new Map();
  for (const s of summary) {
    const d = String(s.TRADE_DATE || '').slice(0, 10);
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  for (const [d, n] of perDay) {
    if (!st.days[d]) st.days[d] = { n: 0, net: 0, orgNet: 0, northNet: 0, lhasaNet: 0, seatNet: 0, buckets: {} };
    st.days[d].lhb = n;
  }
  return { ok: true, rows: detail.length, stocks: summary.length, days: winDates.size };
}

/**
 * 增量回填：每轮处理一个 20 天窗口，直到追上「昨天」。
 * 服务端定时调用（每 5 分钟一轮），一年数据约 19 轮 ≈ 4 分钟回填完毕；
 * 之后每轮只处理最近 3 天的增量。幂等性靠「窗口推进游标」保证：已聚合的日期不重复拉。
 */
async function backfillLhb(maxWindows = 1) {
  const st = readState();
  const today = beijing();
  const target = addDays(today, -1); // 龙虎榜 T+1 晨间披露，昨天为最新可用
  let start = st.lhbCursor ? addDays(st.lhbCursor, 1) : addDays(today, -LOOKBACK_DAYS);
  if (!st.lhbStart) st.lhbStart = start;

  let windows = 0, lastResult = null;
  while (start <= target && windows < maxWindows) {
    const end = addDays(start, WINDOW_DAYS - 1) > target ? target : addDays(start, WINDOW_DAYS - 1);
    try {
      lastResult = await aggregateWindow(st, start, end);
    } catch (e) {
      st.lastError = String(e.message || e);
      writeState(st);
      return { ok: false, error: st.lastError, cursor: st.lhbCursor };
    }
    st.lhbCursor = end;
    windows++;
    start = addDays(end, 1);
    if (!lastResult.ok) break; // 窗口无数据（接口限流或超出范围），推进游标但停止本轮
    writeState(st);
  }
  const done = st.lhbCursor >= target;
  writeState(st);
  return {
    ok: true, cursor: st.lhbCursor, target, done, windows,
    days: Object.keys(st.days).length, daySeatDays: Object.keys(st.daySeats).length, last: lastResult
  };
}

/** 每日增量：重拉最近 3 天（数据可能在次日有修订）。先删这三天再重建，保证幂等 */
async function refreshRecent() {
  const st = readState();
  const today = beijing();
  const from = addDays(today, -3), to = addDays(today, -1);
  for (let d = from; ; d = addDays(d, 1)) {
    delete st.days[d];
    delete st.daySeats[d];
    if (d >= to) break;
  }
  try {
    const r = await aggregateWindow(st, from, to);
    writeState(st);
    return r;
  } catch (e) {
    writeState(st);
    return { ok: false, error: String(e.message || e) };
  }
}

/* --------------------------------- 两融 --------------------------------- */

/** 单日全市场两融聚合（约 8 页 × 500 行）。无汇总报表，只能全量求和，这是接口现状决定的。 */
async function marginOfDay(dateStr) {
  const f = encodeURIComponent("(DATE>='" + dateStr + "')");
  let rz = 0, rq = 0, n = 0, jme = 0;
  for (let pn = 1; pn <= 10; pn++) {
    const url = DC + '?reportName=RPTA_WEB_RZRQ_GGMX&columns=ALL&pageNumber=' + pn +
      '&pageSize=' + PAGE + '&client=WEB&filter=' + f + '&sortColumns=DATE&sortTypes=1';
    const j = await fetchJson(url).catch(() => null);
    const res = j && j.result;
    if (!res || !Array.isArray(res.data) || !res.data.length) break;
    for (const x of res.data) {
      if (String(x.DATE).slice(0, 10) !== dateStr) continue; // 防止翻页把别的日期带进来
      rz += Number(x.RZYE) || 0;
      rq += Number(x.RQYE) || 0;
      jme += Number(x.RZJME) || 0;
      n++;
    }
    if (res.data.length < PAGE) break;
    await sleep(150);
  }
  return n ? { rz: yi(rz), rq: yi(rq), jme: yi(jme), n } : null;
}

/** 两融历史：按月抽样 + 每日最新，一次补齐缺失月份 */
async function backfillMargin(maxCalls = 3) {
  const st = readState();
  const today = beijing();
  let calls = 0;
  // 历史按月抽样
  for (let i = 12; i >= 1 && calls < maxCalls; i--) {
    const anchor = addDays(today, -i * 30);
    const monthKey = anchor.slice(0, 7);
    if (st.marginMonths.includes(monthKey)) continue;
    const sampleDate = monthKey + '-' + String(MARGIN_SAMPLE_DAY).padStart(2, '0');
    const r = await marginOfDay(sampleDate).catch(() => null);
    calls++;
    if (r) { st.margin[sampleDate] = r; st.marginMonths.push(monthKey); }
    else { st.marginMonths.push(monthKey); } // 拉不到也标记，避免死循环（15 日可能是非交易日）
    await sleep(200);
  }
  // 最新一日（今天数据傍晚才有，取昨天）
  const latest = addDays(today, -1);
  if (!st.margin[latest]) {
    let probe = latest;
    for (let k = 0; k < 4 && calls < maxCalls + 2; k++) {
      const r = await marginOfDay(probe).catch(() => null);
      calls++;
      if (r) { st.margin[probe] = r; break; }
      probe = addDays(probe, -1);
    }
  }
  writeState(st);
  return { ok: true, samples: Object.keys(st.margin).length, months: st.marginMonths.length };
}

/* -------------------------------- 快照指标 -------------------------------- */

async function blockTradeView() {
  const to = beijing();
  const from = addDays(to, -7);
  const rows = await fetchReport('RPT_DATA_BLOCKTRADE',
    encodeURIComponent("(TRADE_DATE>='" + from + "')(TRADE_DATE<='" + to + "')"), 3);
  if (!rows.length) return { ok: false };
  let amt = 0, prem = 0, pn = 0;
  for (const r of rows) {
    amt += Number(r.DEAL_AMT) || 0;
    const p = Number(r.PREMIUM_RATIO);
    if (Number.isFinite(p)) { prem += p; pn++; }
  }
  return {
    ok: true, days: 7, deals: rows.length,
    amtYi: yi(amt), avgPremium: pn ? round(prem / pn, 2) : null,
    top: rows.sort((a, b) => (b.DEAL_AMT || 0) - (a.DEAL_AMT || 0)).slice(0, 6)
      .map(r => ({ code: r.SECURITY_CODE, name: r.SECURITY_NAME_ABBR, amtYi: yi(r.DEAL_AMT), premium: round(Number(r.PREMIUM_RATIO), 2), buyer: r.BUYER_NAME, date: String(r.TRADE_DATE).slice(0, 10) })),
    note: '大宗折价交易是机构间转让的常见形态：溢价>0 说明有对手方愿意加价拿筹码（看好），深度折价则可能是变相减持'
  };
}

async function holderView() {
  const rows = await fetchReport('RPT_HOLDERNUMLATEST', '', 3).catch(() => []);
  // 默认返回的是最新一期全市场快照（按变动排序需要 sortColumns，直接本地处理前 500 条）
  if (!rows.length) return { ok: false };
  const withRatio = rows.filter(r => Number.isFinite(Number(r.HOLDER_NUM_RATIO)))
    .map(r => ({ code: r.SECURITY_CODE, name: r.SECURITY_NAME_ABBR, end: String(r.END_DATE).slice(0, 10), ratio: round(Number(r.HOLDER_NUM_RATIO), 2) }))
    .sort((a, b) => a.ratio - b.ratio);
  return {
    ok: true, sampled: rows.length,
    concentrating: withRatio.slice(0, 8),   // 户数降幅最大 = 筹码集中
    dispersing: withRatio.slice(-4),        // 户数升幅最大 = 筹码扩散（机构派发嫌疑）
    note: '股东户数下降意味着筹码向少数账户集中（收集），上升意味着派发。口径：最新披露期相对上期的环比'
  };
}

/* --------------------------------- 视图 --------------------------------- */

/** 从 daySeats 折算席位画像（一年窗口）。读取时计算而不是存储时累计，保证幂等可重建。 */
function seatProfiles(st) {
  const cut = addDays(beijing(), -LOOKBACK_DAYS);
  const map = new Map();
  for (const [d, seats] of Object.entries(st.daySeats)) {
    if (d < cut) continue;
    for (const [name, s] of Object.entries(seats)) {
      let p = map.get(name);
      if (!p) { p = { name, kind: s.kind, count: 0, buy: 0, net: 0, d1n: 0, d1Sum: 0, d1Win: 0, buckets: {}, first: d, last: d }; map.set(name, p); }
      p.count += s.count; p.buy += s.buy; p.net += s.net;
      p.d1n += s.d1n; p.d1Sum += s.d1Sum; p.d1Win += s.d1Win;
      p.first = p.first < d ? p.first : d;
      p.last = p.last > d ? p.last : d;
      for (const [b, v] of Object.entries(s.buckets || {})) p.buckets[b] = (p.buckets[b] || 0) + v;
    }
  }
  return map;
}

function favBucketOf(buckets) {
  let best = null, v = -Infinity;
  for (const [k, x] of Object.entries(buckets || {})) if (x > v) { v = x; best = k; }
  return best;
}

function seatRow(p) {
  return {
    name: p.name, kind: p.kind,
    count: p.count,
    netYi: yi(p.net),
    avgBuyYi: yi(p.buy / Math.max(1, p.count)),
    d1Avg: p.d1n ? round(p.d1Sum / p.d1n, 2) : null,
    winRate: p.d1n >= 8 ? round((p.d1Win / p.d1n) * 100, 1) : null,
    favBucket: favBucketOf(p.buckets),
    first: p.first, last: p.last
  };
}

function bucketFlow(st, days) {
  const today = beijing();
  const from = addDays(today, -days);
  const agg = { micro: 0, small: 0, mid: 0, large: 0 };
  const byKind = { org: { micro: 0, small: 0, mid: 0, large: 0 }, seat: { micro: 0, small: 0, mid: 0, large: 0 } };
  let n = 0;
  for (const [d, day] of Object.entries(st.days)) {
    if (d < from) continue;
    n++;
    for (const [b, v] of Object.entries(day.buckets || {})) {
      if (!(b in agg)) continue;
      agg[b] += v.net || 0;
      byKind.org[b] += v.org || 0;
      byKind.seat[b] += v.seat || 0;
    }
  }
  const out = {};
  for (const b of Object.keys(agg)) out[b] = { netYi: yi(agg[b]), orgYi: yi(byKind.org[b]), seatYi: yi(byKind.seat[b]) };
  return { days: n, buckets: out };
}

function marginSeries(st) {
  const keys = Object.keys(st.margin).sort();
  return keys.map(d => ({ date: d, rz: st.margin[d].rz, rq: st.margin[d].rq }));
}

function marginTrend(st) {
  const s = marginSeries(st);
  if (s.length < 2) return { ok: false, note: '两融历史样本不足（按月抽样回填中）' };
  const first = s[0], last = s[s.length - 1];
  const rzAll = s.map(x => x.rz).filter(Number.isFinite);
  const max = Math.max(...rzAll), min = Math.min(...rzAll);
  const pos = max > min ? ((last.rz - min) / (max - min)) * 100 : 50;
  return {
    ok: true,
    latest: { date: last.date, rzYi: last.rz, rqYi: last.rq },
    yearChange: round(((last.rz / first.rz) - 1) * 100, 1),
    percentile: round(pos, 0),
    note: '融资余额分位 = 当前值在近一年（月度抽样）区间中的位置；>80% 为杠杆拥挤，<20% 为杠杆出清'
  };
}

/**
 * 汇总视图。风格/量能判断需要两市成交额，由 server.js 传入（复用 marketStyle 结果），
 * 本模块不重复抓取，保证单一数据源。
 */
function buildView(st, opts = {}) {
  const today = beijing();
  const dayList = Object.keys(st.days).sort();
  const latestDay = dayList[dayList.length - 1] || null;
  const flow5 = bucketFlow(st, 5);
  const flow20 = bucketFlow(st, 20);

  // 市值层倾向结论：比较四层 20 日净买
  const f20 = flow20.buckets;
  const entries = Object.entries(f20).filter(([, v]) => v.netYi != null);
  entries.sort((a, b) => (b[1].netYi || 0) - (a[1].netYi || 0));
  const topBucket = entries[0] ? entries[0][0] : null;
  const bottomBucket = entries.length ? entries[entries.length - 1][0] : null;

  const totalDays = dayList.length;
  const margin = marginTrend(st);

  return {
    ok: true, date: today, latestDay,
    coverage: {
      days: totalDays,
      from: dayList[0] || null,
      to: latestDay,
      note: totalDays < 200 ? '回填进行中（目标一年），结论随样本增加而稳定' : '样本已覆盖一年'
    },
    actors: (() => {
      const profiles = [...seatProfiles(st).values()];
      const pick = (kind, label) => {
        const rows = profiles.filter(p => p.kind === kind);
        const agg = rows.reduce((a, p) => ({
          count: a.count + p.count, buy: a.buy + p.buy, net: a.net + p.net,
          d1n: a.d1n + p.d1n, d1Sum: a.d1Sum + p.d1Sum, d1Win: a.d1Win + p.d1Win,
          buckets: a.buckets
        }), { count: 0, buy: 0, net: 0, d1n: 0, d1Sum: 0, d1Win: 0, buckets: {} });
        for (const p of rows) for (const [b, v] of Object.entries(p.buckets || {})) agg.buckets[b] = (agg.buckets[b] || 0) + v;
        const row = seatRow({ ...agg, name: label, kind, first: dayList[0], last: latestDay });
        row.seatCount = rows.length;
        return row;
      };
      return {
        org: pick('org', '机构专用（全席位合并）'),
        north: pick('north', '沪深股通（合并）'),
        lhasa: pick('lhasa', '拉萨系散户通道（合并）'),
        hfSeats: profiles
          .filter(p => p.kind === 'seat' && p.count >= HF_SEAT_MIN)
          .map(seatRow)
          .sort((a, b) => Math.abs(b.netYi) - Math.abs(a.netYi))
          .slice(0, 10)
      };
    })(),
    bucketFlow: { d5: flow5, d20: flow20 },
    tilt: {
      top: topBucket, bottom: bottomBucket,
      text: entries.length < 3 ? '样本不足' :
        '近 20 日龙虎榜净买最高：' + topBucket + '（' + (f20[topBucket].netYi || 0) + ' 亿），最低：' + bottomBucket +
        '（' + (f20[bottomBucket].netYi || 0) + ' 亿）；机构与游资方向' +
        ((f20[topBucket].orgYi || 0) * (f20[topBucket].seatYi || 0) >= 0 ? '一致' : '分歧')
    },
    margin,
    marginSeries: marginSeries(st),
    blockTrade: opts.blockTrade || null,
    holders: opts.holders || null,
    volumeContext: opts.volumeYi != null ? {
      volumeYi: opts.volumeYi,
      note: '两市量能与龙虎榜净买结合看：量能扩张 + 游资净买微盘 = 情绪进攻；量能萎缩 + 机构净买大盘 = 防御抱团'
    } : null,
    methodology: {
      classification: '机构专用 / 沪深股通 / 拉萨系（散户通道）/ 其余营业部；一年上榜 ≥ ' + HF_SEAT_MIN + ' 次定义为高频游资',
      winRate: '胜率口径 = 该席位买入个股的次日涨跌均值（D1），由龙虎榜个股汇总的 D1_CLOSE_ADJCHRATE join 得出',
      buckets: '微盘 <50亿 / 小盘 50-150亿 / 中盘 150-500亿 / 大盘 >500亿（流通市值，与量能风格模块同口径）',
      margin: '两融无汇总报表，历史按月抽样、当前按日聚合；月度粒度用于趋势与分位判断',
      limit: '龙虎榜只覆盖触发披露阈值的交易（涨跌幅偏离、换手异常等），是强势股的子样本，不能代表全部机构行为；社保养老等长线资金仅通过季报十大流通股东可观察（见观察池事件模块），不在龙虎榜体系内'
    }
  };
}

let viewCache = { at: 0, view: null };

async function getView(force = false, opts = {}) {
  if (!force && viewCache.view && Date.now() - viewCache.at < TTL) return viewCache.view;
  const st = readState();
  const [blockTrade, holders] = await Promise.all([
    opts.skipLive ? Promise.resolve(null) : blockTradeView().catch(() => null),
    opts.skipLive ? Promise.resolve(null) : holderView().catch(() => null)
  ]);
  const view = buildView(st, { blockTrade, holders, volumeYi: opts.volumeYi });
  viewCache = { at: Date.now(), view };
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(view), 'utf8'); } catch (_) {}
  return view;
}

function backfillStatus() {
  const st = readState();
  const today = beijing();
  return {
    ok: true,
    cursor: st.lhbCursor, target: addDays(today, -1),
    done: st.lhbCursor ? st.lhbCursor >= addDays(today, -1) : false,
    days: Object.keys(st.days).length,
    daySeatDays: Object.keys(st.daySeats).length,
    marginSamples: Object.keys(st.margin).length,
    lastError: st.lastError
  };
}

module.exports = {
  backfillLhb, refreshRecent, backfillMargin, getView, backfillStatus,
  buildView, seatKind, bucketOf, fetchReport,
  STATE_FILE, CACHE_FILE, HF_SEAT_MIN
};
