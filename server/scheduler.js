'use strict';
/**
 * scheduler.js — 每日行情定时快照与复盘（P0）
 *
 * 北京时间（交易日周一至周五）：
 *   09:00  生成方向预测快照 data/daily/YYYY-MM-DD/forecast.json
 *   15:40  刷新三类选股快照（screener.js）
 *   16:30  预测账本复盘 data/daily/YYYY-MM-DD/review.json
 *   18:30  生成 12 节复盘报告 report.md / report.html
 *
 * 同一天同任务只执行一次（data/scheduler-state.json 落盘防重启重复）。
 * 所有任务失败只记日志与状态，不中断服务。
 */

const fs = require('node:fs');
const path = require('node:path');
const daily = require('./daily');
const predictions = require('./predictions');
const screener = require('./screener');
const report = require('./report');
const knowledge = require('./knowledge');
const perception = require('./perception');
const ic = require('./ic');
const pickPool = require('./pick-pool');
const sentiment = require('./sentiment');
const strategy = require('./strategy');
const updateFeed = require('./update-feed');

const DATA = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA, 'scheduler-state.json');
const TASKS = [
  { key: 'forecast', hhmm: '09:00' },
  { key: 'pickpool', hhmm: '09:05' },      // 09:05 定格三类选股推荐到预测股票池
  { key: 'sentiment', hhmm: '15:35' },     // 短线情绪三项（赚钱效应/连板高度/炸板率）
  { key: 'screener', hhmm: '15:40' },      // 四类量化选股快照（趋势/低吸/打板/趋势突破）
  { key: 'strategy', hhmm: '15:45' },      // 四类合并视图 + 次日备选观察池/风险规避池
  { key: 'review', hhmm: '16:30' },
  { key: 'report', hhmm: '18:30' },        // 短线复盘报告
  { key: 'perception', hhmm: '18:35' },
  { key: 'pickpool-review', hhmm: '20:30' } // 晚间复盘当日 09:05 预测池（日线齐备后）
];

function bjDate(ts = Date.now()) { return new Date(ts + 8 * 3600e3).toISOString().slice(0, 10); }
function bjHHmm(ts = Date.now()) { return new Date(ts + 8 * 3600e3).toISOString().slice(11, 16); }
function bjWeekday(ts = Date.now()) { const d = new Date(ts + 8 * 3600e3).getUTCDay(); return d >= 1 && d <= 5; }
function readState() { try { if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) {} return { days: {} }; }
function writeState(s) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); }
function mark(date, key, value) {
  const s = readState();
  s.days = s.days || {};
  s.days[date] = s.days[date] || {};
  s.days[date][key] = { at: new Date().toISOString(), ...value };
  writeState(s);
}
function done(date, key) { const s = readState(); return !!(s.days && s.days[date] && s.days[date][key] && s.days[date][key].ok); }

/* ------------------------------ 具体任务 ------------------------------ */

async function runForecast(cfg, hermes, date = bjDate()) {
  const r = await daily.marketForecast(cfg, hermes);
  let rec = null;
  try { rec = predictions.record(r); } catch (e) { console.warn('[scheduler][forecast] record:', e.message); }
  const dir = report.dayDir(date);
  fs.mkdirSync(dir, { recursive: true });
  const out = {
    ok: !!r.ok, generatedAt: report.bjNow(), date,
    monitor: r.monitor || null, forecast: r.forecast || null,
    forecastError: r.forecastError || null,
    backend: r.backend || null, prediction: rec
  };
  fs.writeFileSync(path.join(dir, 'forecast.json'), JSON.stringify(out, null, 2), 'utf8');
  mark(date, 'forecast', { ok: out.ok, backend: out.backend });
  return out;
}

async function runScreener(date = bjDate()) {
  const r = await screener.refresh();
  mark(date, 'screener', { ok: !!r.ok, counts: r.counts || null });
  return r;
}

async function fetchNextShPctSafe(tradingDate) {
  try {
    const calDates = await ic.tradingCalendar();
    const i = calDates.indexOf(tradingDate);
    if (i < 0 || i + 1 >= calDates.length) return null;
    const nextDate = calDates[i + 1];
    const today = bjDate();
    if (nextDate >= today) return null;
    const bars = await ic.fetchKline('000001', 480, 'index');
    const idx = bars.findIndex(b => b.d === nextDate);
    if (idx <= 0) return null;
    const prev = bars[idx - 1].c, cur = bars[idx].c;
    if (!prev || !cur) return null;
    return { date: nextDate, shPct: Math.round((cur - prev) / prev * 10000) / 100, source: 'fetchKline(000001)' };
  } catch (_) { return null; }
}

async function runReview(cfg, hermes, date = bjDate()) {
  const summary = await predictions.review({ fetchNextShPct: fetchNextShPctSafe });
  const dir = report.dayDir(date);
  fs.mkdirSync(dir, { recursive: true });
  const out = {
    ok: !!summary.ok, generatedAt: report.bjNow(), date,
    summary,
    market: daily.marketMonitor(),
    sector: daily.sectorMonitor(),
    picks: daily.picks()
  };
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify(out, null, 2), 'utf8');
  mark(date, 'review', { ok: out.ok, reviewed: summary.reviewed });
  return out;
}

async function runReport(cfg, hermes, date = bjDate()) {
  const r = await report.generate(cfg, hermes, { date });
  // P2：复盘结论回流知识库（智能体判定价值；失败不阻塞报告交付）
  let reflow = { ok: false, kept: 0, reason: '未执行' };
  try {
    reflow = await knowledge.reflowFromReport(cfg, hermes, { date, candidates: Array.isArray(r.candidatesList) ? r.candidatesList : [] });
  } catch (e) { reflow = { ok: false, kept: 0, error: e.message }; }
  try {
    fs.writeFileSync(path.join(report.dayDir(date), 'knowledge-reflow.json'), JSON.stringify(reflow, null, 2), 'utf8');
    const idxFile = path.join(report.dayDir(date), 'index.json');
    if (fs.existsSync(idxFile)) {
      const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
      idx.reflow = { ok: !!reflow.ok, kept: reflow.kept || 0, backend: reflow.backend || null, reason: reflow.reason || null };
      fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2), 'utf8');
    }
  } catch (e) { console.warn('[scheduler][reflow] write:', e.message); }
  r.reflow = reflow;
  mark(date, 'report', { ok: !!r.ok, html: r.html || null, reflowKept: reflow.kept || 0 });
  return r;
}

async function runPickPool(date = bjDate()) {
  const r = pickPool.freeze({ date });
  mark(date, 'pickpool', { ok: !!r.ok, count: r.count, leaders: r.leaders });
  return r;
}

async function runPickPoolReview(date = bjDate()) {
  const r = await pickPool.review({ date });
  mark(date, 'pickpool-review', { ok: !!r.ok, reviewed: r.reviewed, pending: r.pending });
  return r;
}

/** 短线情绪三项：赚钱效应需逐只取 K 线，故异步；数据缺失只记录不抛错 */
async function runSentiment(date = bjDate()) {
  const r = await sentiment.build();
  mark(date, 'sentiment', {
    ok: !!r.ok, money: !!(r.moneyEffect && r.moneyEffect.ok),
    height: r.boardHeight && r.boardHeight.maxBoards, breakRate: r.breakRate && r.breakRate.rate
  });
  return r;
}

/** 四类合并视图 + 次日双池：纯本地快照聚合，同步即可 */
function runStrategy(date = bjDate()) {
  const r = strategy.build();
  mark(date, 'strategy', {
    ok: !!r.ok, rows: r.fourClass && r.fourClass.totalRows,
    watch: r.pools && r.pools.watchCount, risk: r.pools && r.pools.riskCount
  });
  return r;
}

/** 调度任务 → 真实更新事件（只在任务确实成功产出数据时登记） */
const TASK_FEED = {
  forecast:        ['market',    '次日预测',   '次日行情预测生成',     r => `后端 ${r.backend || '—'}`],
  pickpool:        ['portfolio', '上午定格',   '09:05 预测池定格',     r => `${r.count || 0} 只 · 领跑 ${r.leaders || 0} 只`],
  sentiment:       ['market',    '短线情绪',   '情绪三项定时计算',     r => `赚钱效应 ${r.moneyEffect && r.moneyEffect.avgPct != null ? r.moneyEffect.avgPct + '%' : '—'} · 连板 ${r.boardHeight && r.boardHeight.maxBoards} 板 · 炸板率 ${r.breakRate && r.breakRate.rate}%`],
  screener:        ['market',    '四类选股',   '四类量化选股快照',     r => `四类共 ${Object.values(r.counts || {}).reduce((a, b) => a + (Number(b) || 0), 0)} 只`],
  strategy:        ['market',    '四类策略',   '四类合并与次日双池',   r => `合并 ${r.fourClass && r.fourClass.totalRows} 行 · 观察池 ${r.pools && r.pools.watchCount} 只 · 风险池 ${r.pools && r.pools.riskCount} 只`],
  review:          ['portfolio', '方向复盘',   '预测账本复盘',         r => `复盘 ${r.reviewed != null ? r.reviewed : '—'} 条`],
  report:          ['market',    '短线复盘',   '短线复盘报告生成',     r => r.style ? `${r.style}风格` : '报告已落盘'],
  perception:      ['market',    '模块快照',   '各模块快照刷新',       r => `${(r.files || []).length} 个文件`],
  'pickpool-review':['portfolio','预测池复盘','20:30 预测池复盘',     r => `已复盘 ${r.reviewed != null ? r.reviewed : 0} 条 · 待复盘 ${r.pending != null ? r.pending : 0} 条`],
  all:             ['market',    '全量任务',   '全量调度任务执行',     () => '9 项日频任务已执行']
};

async function runTask(key, cfg, hermes, date) {
  const r = await runTaskInner(key, cfg, hermes, date);
  try {
    const m = TASK_FEED[key];
    if (m && r && r.ok !== false) {
      let detail;
      try { detail = m[3](r); } catch (_) { detail = '任务已完成'; }
      updateFeed.record(m[0], m[1], m[2], detail, 'scheduler:' + key);
    }
  } catch (e) { console.warn('[scheduler][update-feed]', e.message); }
  return r;
}

async function runTaskInner(key, cfg, hermes, date) {
  switch (key) {
    case 'forecast': return runForecast(cfg, hermes, date);
    case 'pickpool': return runPickPool(date);
    case 'pickpool-review': return runPickPoolReview(date);
    case 'sentiment': return runSentiment(date);
    case 'strategy': return runStrategy(date);
    case 'screener': return runScreener(date);
    case 'review': return runReview(cfg, hermes, date);
    case 'report': return runReport(cfg, hermes, date);
    case 'perception': {
      const r = perception.refresh();
      mark(date, 'perception', { ok: !!r.ok, files: r.files || null });
      return r;
    }
    case 'all': {
      const out = {};
      out.sentiment = await runSentiment(date);
      out.screener = await runScreener(date);
      out.strategy = runStrategy(date);
      out.forecast = await runForecast(cfg, hermes, date);
      out.pickpool = runPickPool(date);
      out.review = await runReview(cfg, hermes, date);
      out.report = await runReport(cfg, hermes, date);
      out.perception = perception.refresh();
      out['pickpool-review'] = await runPickPoolReview(date);
      return { ok: true, all: out };
    }
    default: return { ok: false, error: 'unknown task: ' + key };
  }
}

/* ------------------------------ 定时驱动 ------------------------------ */

let timer = null;
let ctxRef = null;

function start(ctx) {
  ctxRef = ctx || {};
  if (timer) return { ok: true, already: true };
  timer = setInterval(() => {
    try {
      const date = bjDate();
      const hhmm = bjHHmm();
      if (!bjWeekday()) return;
      for (const t of TASKS) {
        if (hhmm < t.hhmm) continue;       // 未到时间
        if (hhmm > t.hhmm && hhmm > t.hhmm.slice(0, 2) + ':05') continue; // 错过超过5分钟不补跑
        if (done(date, t.key)) continue;
        const cfg = (ctxRef && typeof ctxRef.getConfig === 'function' ? ctxRef.getConfig() : ctxRef && ctxRef.config) || null;
        const hermes = ctxRef && ctxRef.hermes;
        mark(date, t.key, { ok: false, running: true });
        runTask(t.key, cfg, hermes, date)
          .then(r => { console.log('[scheduler] ' + date + ' ' + t.key + ' ok=' + !!(r && r.ok)); })
          .catch(e => {
            console.warn('[scheduler] ' + date + ' ' + t.key + ' failed:', e.message);
            mark(date, t.key, { ok: false, error: String(e.message || e).slice(0, 200) });
          });
      }
    } catch (e) { console.warn('[scheduler] tick:', e.message); }
  }, 60 * 1000);
  return { ok: true, tasks: TASKS };
}

function status() {
  const s = readState();
  return { ok: true, tasks: TASKS, today: bjDate(), state: s.days[bjDate()] || {}, running: !!timer };
}

module.exports = { start, status, runTask, runForecast, runScreener, runReview, runReport, runPickPool, runPickPoolReview, runSentiment, runStrategy, TASKS, bjDate };
