'use strict';

/**
 * 评分有效性自检（IC / Rank IC）——把观察池从「自嗨」变成「可证伪」。
 *
 * 【为什么要有这个模块】
 * 观察池每天给出 18 只股票的分数与排序，但此前从未验证「分数高的股票后续是否真的更强」。
 * 本模块按 microsoft/qlib 与 quantopian/alphalens 的标准做法，做三件事：
 *   ① 每日定格一次评分快照（可复现的决策时点）；
 *   ② 用冻结后的真实日线计算 T+1 / T+3 / T+5 / T+10 个交易日的前瞻收益；
 *   ③ 逐日计算横截面 Spearman Rank IC，滚动聚合出 IC 均值、ICIR、正比例、分组 IC 与分档收益。
 *
 * 【A 股口径的关键约定】
 *  - 评估单位是「当天那一个横截面」，不是「某只股票入选池子的历史」——池子每天换股票不影响 IC，
 *    因为 IC 衡量的是「同一天、同一批标的」内部排序与后续收益的相关性。
 *  - 定格时点默认 14:50（收盘前决策），前瞻收益基准取「当日收盘价」，即决策→当日收盘成交的近似；
 *  - A 股 T+1，所以最短前瞻窗口为 T+1（次日收盘），不评估日内；
 *  - Rank IC 对同期大盘涨跌天然免疫（减去同一个基准收益不改变秩次），因此不需要额外做基准中性化。
 *  - 18 只样本的单日 IC 标准误约 1/√17 ≈ 0.24，噪声极大，故结论只认滚动 20 日以上的均值。
 *
 * 【零依赖】仅使用 Node 内置模块 + 东方财富公开日线接口。
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const emtx = require('./emtx');

/* 最近一次日线的真实来源（东财 / 腾讯备用源），供上游如实标注，避免把备用源数据说成主源 */
let lastKlineSource = 'eastmoney';
function klineSource() { return lastKlineSource; }

const DATA_DIR = path.join(__dirname, '..', 'data');
const SNAP_DIR = path.join(DATA_DIR, 'score-history');
const LABEL_FILE = path.join(DATA_DIR, 'ic-labels.jsonl');
const REPORT_FILE = path.join(DATA_DIR, 'ic-report.json');
const CAL_FILE = path.join(DATA_DIR, 'trade-calendar.json');
const LESSON_FILE = path.join(DATA_DIR, 'ic-lessons.md');

const EM_KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 safari/537.36';

const DEFAULT_OPTS = {
  enabled: true,
  horizons: [1, 3, 5, 10],
  rollDays: 20,
  minDays: 5,
  snapshots: ['pm'],
  keepDays: 400,
  maxLabelsPerTick: 60
};

/* ---------------------------------- 基础工具 ---------------------------------- */

function round(x, n = 1) {
  if (!Number.isFinite(x)) return null;
  const p = Math.pow(10, n);
  return Math.round(x * p) / p;
}
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function finite(x) { const v = Number(x); return Number.isFinite(v) ? v : null; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function std(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function beijing(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600 * 1000);
  const date = d.toISOString().slice(0, 10);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return { date, minutes, hhmm: d.toISOString().slice(11, 16) };
}

function ensureDir() {
  if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });
}

function fetchJson(url, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
      timeout
    }, res => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let buf = [];
      res.on('data', d => buf.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(buf).toString('utf8'))); }
        catch (e) { reject(new Error('JSON 解析失败')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/**
 * 东财 secid：个股按代码首位判断沪/深；指数必须显式传 market='index'
 * （否则 000001 会被当成平安银行而非上证指数）。
 */
function secidOf(code, market) {
  const c = String(code);
  if (market === 'index') return '1.' + c;
  return (/^6|^9|^688|^5/.test(c) ? '1.' : '0.') + c;
}

/**
 * 拉日线：返回 [{d:'2026-11-17', o:开, c:收, h:高, l:低, v:量, a:额}]，按日期升序。
 * 复用 emtx.fetchKline：主源东财 push2his（前复权），不可达时自动降级腾讯 qfq 前复权，
 * 两者字段顺序一致（日期,开,收,高,低,量,额）；腾讯缺成交额字段，由 emtx 用四价均值×量估算并标注。
 * 实际来源写入 lastKlineSource，供 technical.js 等上游在结果里如实标注，不把备用源说成主源。
 */
async function fetchKline(code, lmt = 140, market) {
  const j = await emtx.fetchKline(secidOf(code, market), lmt);
  const lines = j && j.data && Array.isArray(j.data.klines) ? j.data.klines : [];
  lastKlineSource = (j && j._source) === 'tencent' ? 'tencent-qfq' : 'eastmoney';
  return lines.map(s => {
    const p = String(s).split(',');
    return { d: p[0], o: finite(p[1]), c: finite(p[2]), h: finite(p[3]), l: finite(p[4]), v: finite(p[5]), a: finite(p[6]) };
  }).filter(b => b.d && b.c);
}

/* -------------------------------- 交易日历 -------------------------------- */

let calCache = { at: 0, dates: [] };

async function tradingCalendar(force = false) {
  const TTL = 6 * 3600 * 1000;
  if (!force && calCache.dates.length && Date.now() - calCache.at < TTL) return calCache.dates;
  if (!force) {
    try {
      if (fs.existsSync(CAL_FILE)) {
        const j = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
        if (j && Array.isArray(j.dates) && j.dates.length > 50 && Date.now() - (j.at || 0) < TTL) {
          calCache = { at: j.at, dates: j.dates };
          return j.dates;
        }
      }
    } catch (_) { /* 忽略缓存损坏 */ }
  }
  try {
    const bars = await fetchKline('000001', 480, 'index'); // 上证指数用于导出交易日序列
    const dates = bars.map(b => b.d);
    if (dates.length > 30) {
      ensureDir();
      fs.writeFileSync(CAL_FILE, JSON.stringify({ at: Date.now(), dates }), 'utf8');
      calCache = { at: Date.now(), dates };
      return dates;
    }
  } catch (e) {
    console.warn('[ic] 交易日历获取失败，降级为工作日序列: ' + e.message);
  }
  if (calCache.dates.length) return calCache.dates;
  const out = [];
  const day = new Date();
  for (let i = 0; i < 240; i++) {
    const d = new Date(day.getTime() - i * 86400000);
    const w = d.getDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out.reverse();
}

/* -------------------------------- 快照定格 -------------------------------- */

function snapshotKind(minutes, opts) {
  const kinds = Array.isArray(opts.snapshots) && opts.snapshots.length ? opts.snapshots : ['pm'];
  const windows = {
    am: [625, 645],   // 10:25–10:45
    pm: [885, 905],   // 14:45–15:05（收盘前决策时点，含收盘后 5 分钟容错）
    close: [906, 960] // 15:06–16:00（盘后复盘，默认不启用，避免与 pm 重复计数）
  };
  for (const k of kinds) {
    const w = windows[k];
    if (w && minutes >= w[0] && minutes < w[1]) return k;
  }
  return null;
}

function snapFile(date) { return path.join(SNAP_DIR, date + '.json'); }

function readSnapFile(date) {
  try {
    const p = snapFile(date);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

function writeSnapFile(date, obj) {
  ensureDir();
  const p = snapFile(date);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, p);
}

/**
 * 定格一次评分快照。只在配置的时点窗口内、且当日该类型尚未定格时写入。
 * @returns {{recorded:boolean, reason?:string, kind?:string, date?:string}}
 */
function record(view, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  if (!o.enabled) return { recorded: false, reason: '未启用' };
  if (!view || !Array.isArray(view.items) || !view.items.length) return { recorded: false, reason: '无评分数据' };
  if (view.rescoreOnly) return { recorded: false, reason: '轻量重评分不作为定格依据' };

  const bj = beijing();
  const kind = o.forceKind || snapshotKind(bj.minutes, o);
  if (!kind) return { recorded: false, reason: '不在定格窗口' };

  const tradingDate = view.tradingDate || bj.date;
  const file = readSnapFile(tradingDate) || { date: tradingDate, snapshots: [] };
  if (file.snapshots.some(s => s.kind === kind)) return { recorded: false, reason: '该时点已定格' };

  const items = view.items.map(x => ({
    code: String(x.code), name: x.name, industry: x.industry,
    score: x.score, signal: x.signal, confidence: x.confidence,
    tech: x.groups ? x.groups.technical : null,
    fund: x.groups ? x.groups.capital : null,
    buzz: x.groups ? x.groups.buzz : null,
    sent: x.groups ? x.groups.sentimentIndex : null,
    heat: x.groups ? x.groups.heat : null,
    sectorNews: x.groups ? x.groups.sectorNews : null,
    marketAdj: x.groups ? x.groups.marketAdjust : null,
    styleAdj: x.groups ? x.groups.styleAdjust : null,
    eventAdj: x.groups ? x.groups.eventAdjust : null,
    macroAdj: x.groups ? x.groups.macroAdjust : null,
    penalty: x.groups ? x.groups.riskPenalty : null,
    bucket: x.styleLink ? x.styleLink.bucket : null,
    cap: x.floatCap || null,
    price: x.price
  }));

  file.snapshots.push({
    kind, ts: Date.now(), hhmm: bj.hhmm, tradingDate,
    volumeRegime: view.contextMeta && view.contextMeta.volumeRegime || null,
    riskOff: view.contextMeta && view.contextMeta.riskOffScore != null ? view.contextMeta.riskOffScore : null,
    items
  });
  file.snapshots.sort((a, b) => a.ts - b.ts);
  writeSnapFile(tradingDate, file);
  console.log('[ic] 评分已定格 ' + tradingDate + ' ' + kind + '（' + items.length + ' 只）');
  return { recorded: true, kind, date: tradingDate, count: items.length };
}

function listSnapshotDates(limit = 400) {
  ensureDir();
  return fs.readdirSync(SNAP_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort()
    .slice(-limit);
}

/* --------------------------------- 标注 --------------------------------- */

function readLabels() {
  try {
    if (!fs.existsSync(LABEL_FILE)) return [];
    return fs.readFileSync(LABEL_FILE, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { return []; }
}

function appendLabels(rows) {
  if (!rows.length) return;
  fs.appendFileSync(LABEL_FILE, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function labelKey(date, kind, h, code) { return date + '|' + kind + '|' + h + '|' + code; }

/**
 * 为到期的快照补算前瞻收益。
 * 到期判定：快照交易日 + horizon 个交易日 <= 日历中最新交易日。
 */
async function labelPending(opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  if (!o.enabled) return { added: 0, reason: '未启用' };
  const cal = await tradingCalendar();
  if (!cal.length) return { added: 0, reason: '无交易日历' };
  const idx = new Map(cal.map((d, i) => [d, i]));
  const lastIdx = cal.length - 1;

  const labels = readLabels();
  const done = new Set(labels.map(r => labelKey(r.date, r.kind, r.h, r.code)));
  const dates = listSnapshotDates(o.keepDays);

  const due = []; // {date, kind, h, items}
  for (const date of dates) {
    const i = idx.has(date) ? idx.get(date) : -1;
    if (i < 0) continue;
    const file = readSnapFile(date);
    if (!file || !Array.isArray(file.snapshots)) continue;
    for (const s of file.snapshots) {
      for (const h of o.horizons) {
        if (i + h > lastIdx) continue;
        const need = s.items.filter(it => !done.has(labelKey(date, s.kind, h, it.code)));
        if (need.length) due.push({ date, kind: s.kind, h, targetIdx: i + h, items: need });
      }
    }
  }
  if (!due.length) return { added: 0, pending: 0, reason: '无到期待标注' };

  // 需要拉日线的股票去重，控制单轮请求量（东财接口有限流）
  const codeSet = new Set();
  for (const d of due) d.items.forEach(it => codeSet.add(it.code));
  let codes = [...codeSet];
  if (codes.length > o.maxLabelsPerTick) codes = codes.slice(0, o.maxLabelsPerTick);
  const allowed = new Set(codes);

  const barCache = new Map();
  for (let i = 0; i < codes.length; i += 4) {
    const batch = codes.slice(i, i + 4);
    await Promise.allSettled(batch.map(async code => {
      try { barCache.set(code, await fetchKline(code, 260)); }
      catch (e) { /* 单只失败不影响整体 */ }
    }));
    if (i + 4 < codes.length) await sleep(200);
  }

  const rows = [];
  for (const d of due) {
    const bars = new Map();
    for (const it of d.items) {
      if (!allowed.has(it.code)) continue;
      const b = barCache.get(it.code);
      if (!b) continue;
      const bar = b.find(x => x.d === d.date);
      const fwd = b.find(x => x.d === cal[d.targetIdx]);
      if (!bar || !fwd || !bar.c || !fwd.c) continue;
      bars.set(it.code, round((fwd.c / bar.c - 1) * 100, 3));
    }
    for (const [code, ret] of bars) rows.push({ date: d.date, kind: d.kind, h: d.h, code, ret });
  }
  appendLabels(rows);
  if (rows.length) console.log('[ic] 新增标注 ' + rows.length + ' 条（' + codes.length + ' 只标的）');
  const stillPending = due.reduce((n, d) => n + d.items.length, 0) - rows.length;
  return { added: rows.length, pending: Math.max(0, stillPending), codes: codes.length };
}

/* --------------------------------- IC 计算 --------------------------------- */

/** 平均秩（处理并列），返回 1..n 的秩数组 */
function ranks(xs) {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const r = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k].i] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman Rank IC */
function spearman(xs, ys) {
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    const x = finite(xs[i]), y = finite(ys[i]);
    if (x === null || y === null) continue;
    pairs.push([x, y]);
  }
  if (pairs.length < 5) return null;
  return pearson(ranks(pairs.map(p => p[0])), ranks(pairs.map(p => p[1])));
}

const GROUP_DEFS = [
  { key: 'score', label: '总分', get: it => it.score },
  { key: 'tech', label: '技术组', get: it => it.tech },
  { key: 'fund', label: '资金组', get: it => it.fund },
  { key: 'buzz', label: '舆情热度组', get: it => it.buzz },
  { key: 'sent', label: '个股舆情', get: it => it.sent },
  { key: 'heat', label: '人气热度', get: it => it.heat },
  { key: 'sectorNews', label: '行业消息面', get: it => it.sectorNews },
  { key: 'marketAdj', label: '外围修正', get: it => it.marketAdj },
  { key: 'styleAdj', label: '量能风格修正', get: it => it.styleAdj },
  { key: 'eventAdj', label: '事件修正', get: it => it.eventAdj },
  { key: 'macroAdj', label: '宏观修正', get: it => it.macroAdj },
  { key: 'penalty', label: '风险惩罚（负向）', get: it => (it.penalty == null ? null : -it.penalty) }
];

function aggregate(values) {
  const v = values.filter(x => Number.isFinite(x));
  if (!v.length) return { n: 0, mean: null, std: null, ir: null, pos: null, t: null };
  const m = mean(v), s = std(v);
  return {
    n: v.length,
    mean: round(m, 3),
    std: s === null ? null : round(s, 3),
    ir: s && s > 0 ? round(m / s, 2) : null,
    pos: round(v.filter(x => x > 0).length / v.length * 100, 0),
    t: s && s > 0 ? round(m / (s / Math.sqrt(v.length)), 2) : null
  };
}

function readAllSnapshots(limit) {
  const out = [];
  for (const date of listSnapshotDates(limit)) {
    const f = readSnapFile(date);
    if (f && Array.isArray(f.snapshots)) out.push(f);
  }
  return out;
}

/**
 * 生成自检报告：IC 均值 / ICIR / 分组 IC / 分档收益 / 市场状态分层 / 结论与经验。
 */
function buildReport(opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const snaps = readAllSnapshots(o.keepDays);
  const labels = readLabels();
  const byKey = new Map();
  for (const l of labels) byKey.set(labelKey(l.date, l.kind, l.h, l.code), l.ret);

  const perDay = [];   // {date, kind, h, ic, rets:[{code, score, ret}]}
  let labeledCount = 0;
  for (const f of snaps) {
    for (const s of f.snapshots) {
      for (const h of o.horizons) {
        const pts = [];
        for (const it of s.items) {
          const k = labelKey(f.date, s.kind, h, it.code);
          if (!byKey.has(k)) continue;
          const ret = byKey.get(k);
          if (!Number.isFinite(ret)) continue;
          pts.push({ it, ret });
          labeledCount++;
        }
        if (pts.length < 8) continue;
        perDay.push({
          date: f.date, kind: s.kind, h,
          ic: spearman(pts.map(p => p.it.score), pts.map(p => p.ret)),
          pts, regime: s.volumeRegime || null
        });
      }
    }
  }

  // 只取最近 rollDays 个快照日用于聚合，避免早期样本权重过大
  const daySet = [...new Set(perDay.map(x => x.date))].sort();
  const recent = new Set(daySet.slice(-Math.max(3, o.rollDays)));
  const use = perDay.filter(x => recent.has(x.date));

  const horizons = o.horizons.map(h => {
    const rows = use.filter(x => x.h === h && x.ic !== null);
    const agg = aggregate(rows.map(x => x.ic));
    // 分档：按当次得分三分位（Top/Mid/Bottom），看平均前瞻收益是否单调
    const tiers = { top: [], mid: [], bottom: [] };
    for (const r of rows) {
      const sorted = r.pts.slice().sort((a, b) => b.it.score - a.it.score);
      const third = Math.max(1, Math.round(sorted.length / 3));
      const add = (arr, seg) => { const m = mean(seg.map(p => p.ret)); if (Number.isFinite(m)) arr.push(m); };
      add(tiers.top, sorted.slice(0, third));
      add(tiers.mid, sorted.slice(third, third * 2));
      add(tiers.bottom, sorted.slice(third * 2));
    }
    const tierMean = {
      top: round(mean(tiers.top), 2), mid: round(mean(tiers.mid), 2), bottom: round(mean(tiers.bottom), 2)
    };
    return {
      h, days: agg.n, ...agg,
      tiers: tierMean,
      spread: tierMean.top != null && tierMean.bottom != null ? round(tierMean.top - tierMean.bottom, 2) : null
    };
  });

  const series = daySet.slice(-60).map(d => {
    const row = { date: d };
    for (const h of o.horizons) {
      const r = use.find(x => x.date === d && x.h === h);
      row['ic' + h] = r ? round(r.ic, 3) : null;
    }
    return row;
  });

  const groups = GROUP_DEFS.map(g => {
    const cell = {};
    for (const h of [1, 5, 10]) {
      const rows = use.filter(x => x.h === h);
      const ics = [];
      for (const r of rows) {
        const ic = spearman(r.pts.map(p => g.get(p.it)), r.pts.map(p => p.ret));
        if (ic !== null) ics.push(ic);
      }
      const agg = aggregate(ics);
      cell['ic' + h] = agg.mean;
      if (h === 5) { cell.t = agg.t; cell.n = agg.n; cell.pos = agg.pos; }
    }
    return { key: g.key, label: g.label, ...cell };
  });

  const regimes = [];
  for (const key of ['存量博弈', '增量行情']) {
    const rows = use.filter(x => x.h === 5 && x.regime && String(x.regime).includes(key) && x.ic !== null);
    if (rows.length) {
      const agg = aggregate(rows.map(x => x.ic));
      regimes.push({ key, label: key === '存量博弈' ? '存量博弈·板块轮动' : '增量行情', ...agg });
    }
  }

  const h5 = horizons.find(x => x.h === 5) || horizons[0] || { days: 0, mean: null, ir: null, pos: null, t: null };
  let level = '样本不足';
  if (h5.days >= o.minDays && h5.mean !== null) {
    if (h5.mean >= 0.03 && (h5.t === null || h5.t >= 1.5)) level = '有效';
    else if (h5.mean > 0.01) level = '偏弱有效';
    else if (h5.mean > -0.01) level = '接近随机';
    else level = '反向（需检查）';
  }

  const group5 = groups.filter(g => g.key !== 'score' && g.ic5 !== null)
    .sort((a, b) => b.ic5 - a.ic5);
  const best = group5[0] || null;
  const worst = group5[group5.length - 1] || null;

  const lessons = [];
  if (h5.days) {
    lessons.push('近 ' + h5.days + ' 个快照日：T+5 Rank IC ' + (h5.mean ?? '—') +
      '，ICIR ' + (h5.ir ?? '—') + '，正 IC 占比 ' + (h5.pos ?? '—') + '%，t 值 ' + (h5.t ?? '—') +
      '，判定「' + level + '」');
  } else {
    lessons.push('尚未积累足够的到期标注（需要至少 ' + o.minDays + ' 个交易日、每个快照 T+5 到期），当前结论不可用');
  }
  if (best && worst && best.key !== worst.key) {
    lessons.push('因子组有效性排序：' + group5.slice(0, 3).map(g => g.label + ' ' + (g.ic5 >= 0 ? '+' : '') + g.ic5).join(' > ') +
      '；最弱为「' + worst.label + ' ' + (worst.ic5 >= 0 ? '+' : '') + worst.ic5 + '」');
  }
  const topTier = h5.tiers && h5.tiers.top, botTier = h5.tiers && h5.tiers.bottom;
  if (topTier != null && botTier != null) {
    lessons.push('分档单调性：Top 三分位 T+5 平均 ' + (topTier >= 0 ? '+' : '') + topTier + '%，' +
      'Bottom 三分位 ' + (botTier >= 0 ? '+' : '') + botTier + '%，' +
      '差值 ' + (h5.spread >= 0 ? '+' : '') + h5.spread + ' 个百分点（' +
      (h5.spread > 0 ? '方向一致' : '方向相反，说明高分反而跑输') + '）');
  }
  if (regimes.length === 2) {
    lessons.push('市场状态分层：存量博弈 IC ' + regimes[0].mean + '（' + regimes[0].n + ' 天） vs 增量行情 IC ' +
      regimes[1].mean + '（' + regimes[1].n + ' 天），' +
      (Math.abs(regimes[0].mean) > Math.abs(regimes[1].mean) ? '存量市更依赖本模型' : '增量市更依赖本模型'));
  }

  const suggestions = [];
  if (level === '反向（需检查）') {
    suggestions.push('总分与前瞻收益负相关：优先检查是否有「追高反转」成分（5日涨幅、热度过高）在主导，可临时下调热榜配额或提高风险惩罚');
  } else if (level === '接近随机') {
    suggestions.push('排序接近随机：不要据此调权重；先延长观测到 40 个快照日，再判断是哪一组因子失效');
  } else if (level === '偏弱有效') {
    suggestions.push('方向正确但强度偏弱：可作为观察清单使用，不宜重仓；建议对 IC 最高的因子组小幅加权');
  } else if (level === '有效') {
    suggestions.push('排序具备统计意义上的正向预测力：保持当前权重结构，重点是控制换手与交易成本');
  }
  if (worst && worst.ic5 !== null && worst.ic5 < -0.01) {
    suggestions.push('「' + worst.label + '」IC 为负，建议把该组权重下调 10–20% 后再观察 20 个交易日');
  }
  if (best && best.ic5 !== null && best.ic5 > 0.04) {
    suggestions.push('「' + best.label + '」IC 显著为正，可作为该组权重上调的候选');
  }
  if (h5.spread != null && h5.spread < 0) {
    suggestions.push('分档收益与排序相反，说明总分被修正项或惩罚项挤压：可试运行「仅三组基础分」的对照版本');
  }

  const report = {
    updatedAt: Date.now(),
    status: {
      snapshots: daySet.length,
      labeled: labeledCount,
      pending: pendingCount(snaps, labels, o),
      lastSnapshot: daySet[daySet.length - 1] || null,
      firstSnapshot: daySet[0] || null,
      horizons: o.horizons,
      rollDays: o.rollDays,
      minDays: o.minDays
    },
    horizons,
    series,
    groups,
    regimes,
    verdict: {
      level,
      horizon: 5,
      text: buildVerdictText(level, h5, best, worst, o.minDays),
      suggestions
    },
    lessons,
    note: 'Rank IC 是「当天这批标的里，分数排序与后续 n 个交易日收益排序」的秩相关。18 只样本的单日 IC 标准误约 0.24，单日数字不可当真，只认滚动 20 日以上的均值与 t 值。评估以当日收盘价为基准，隐含「收盘附近成交」的近似，未计入 T+1 与涨跌停无法成交、冲击成本与手续费。'
  };
  return report;
}

function buildVerdictText(level, h5, best, worst, minDays) {
  if (level === '样本不足') {
    return '样本不足：至少需要 ' + (minDays || 5) + ' 个交易日、且 T+5 已到期的快照才能判断，当前可用 ' +
      (h5.days || 0) + ' 天。期间请保持服务在交易日常驻，自检会在 14:50 自动定格。';
  }
  const parts = ['T+5 Rank IC 均值 ' + h5.mean + '（t=' + (h5.t ?? '—') + '），判定「' + level + '」。'];
  if (best && best.ic5 !== null) parts.push('当前最有效的因子组是「' + best.label + '」（IC ' + best.ic5 + '）。');
  if (worst && worst.ic5 !== null && worst.ic5 < 0) parts.push('「' + worst.label + '」出现负 IC，值得复核其计算口径。');
  return parts.join('');
}

function pendingCount(snaps, labels, o) {
  const done = new Set(labels.map(r => labelKey(r.date, r.kind, r.h, r.code)));
  let n = 0;
  for (const f of snaps.slice(-o.rollDays)) {
    for (const s of f.snapshots) {
      for (const h of o.horizons) {
        n += s.items.filter(it => !done.has(labelKey(f.date, s.kind, h, it.code))).length;
      }
    }
  }
  return n;
}

/* --------------------------------- 经验沉淀 -------------------------------- */

function lessonBlock(report) {
  const lines = [];
  lines.push('## ' + beijing().date + ' · 观测 ' + report.status.snapshots + ' 个快照日');
  lines.push('');
  lines.push('- 结论：**' + report.verdict.text + '**');
  for (const l of report.lessons) lines.push('- ' + l);
  if (report.verdict.suggestions.length) {
    lines.push('- 建议：');
    for (const s of report.verdict.suggestions) lines.push('  - ' + s);
  }
  lines.push('');
  return lines.join('\n');
}

function appendLesson(report) {
  try {
    ensureDir();
    if (!fs.existsSync(LESSON_FILE)) {
      fs.writeFileSync(LESSON_FILE,
        '# 评分有效性经验库\n\n' +
        '> 由 `server/ic.js` 自动生成，每次结论变化时追加一段。\n' +
        '> 每条记录包含：观测窗口、Rank IC 与显著性、因子组排序、分档单调性、市场状态分层、可执行建议。\n' +
        '> 历史记录只追加不覆盖，便于回看「当时的判断」是否被后续验证。\n\n', 'utf8');
    }
    const text = fs.readFileSync(LESSON_FILE, 'utf8');
    const lastIdx = text.lastIndexOf('## ');
    const lastBlock = lastIdx >= 0 ? text.slice(lastIdx) : '';
    const today = beijing().date;
    // 同一天且结论未变化则不重复追加，避免日志膨胀
    if (lastBlock.startsWith('## ' + today) && lastBlock.includes(report.verdict.level)) return false;
    fs.appendFileSync(LESSON_FILE, lessonBlock(report), 'utf8');
    return true;
  } catch (e) {
    console.warn('[ic] 经验库写入失败: ' + e.message);
    return false;
  }
}

function readLessons(limit = 20000) {
  try {
    if (!fs.existsSync(LESSON_FILE)) return '';
    const t = fs.readFileSync(LESSON_FILE, 'utf8');
    return t.length > limit ? t.slice(-limit) : t;
  } catch (_) { return ''; }
}

/* ---------------------------------- 对外接口 --------------------------------- */

let reportCache = { at: 0, data: null };

function getReport(opts = {}, useCache = true) {
  if (useCache && reportCache.data && Date.now() - reportCache.at < 60000) return reportCache.data;
  const r = buildReport(opts);
  reportCache = { at: Date.now(), data: r };
  try { fs.writeFileSync(REPORT_FILE, JSON.stringify(r), 'utf8'); } catch (_) { }
  return r;
}

/** 定时任务：先补标注，再重建报告；返回 report */
async function tick(opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const lab = await labelPending(o).catch(e => ({ added: 0, error: e.message }));
  const report = getReport(o, false);
  if (lab.added || lab.pending) report._labelTick = lab;
  appendLesson(report);
  return report;
}

function status() {
  const snaps = listSnapshotDates();
  const labels = readLabels();
  return {
    snapshotDays: snaps.length,
    lastSnapshot: snaps[snaps.length - 1] || null,
    labels: labels.length,
    lessonFile: LESSON_FILE,
    reportFile: REPORT_FILE,
    snapshotDir: SNAP_DIR
  };
}

module.exports = {
  record, tick, getReport, status,
  labelPending, buildReport, readLessons, appendLesson,
  tradingCalendar, fetchKline, klineSource, spearman,
  DEFAULT_OPTS, SNAP_DIR, LABEL_FILE, REPORT_FILE, LESSON_FILE
};
