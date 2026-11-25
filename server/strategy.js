'use strict';
/**
 * strategy.js — 量化策略统一视图 + 次日双池
 *
 * 四类量化选股：趋势(trend) / 低吸(dip) / 打板(board) / 趋势突破(breakout)
 *  - fourClass()：四类合并到一个列表，每行标注类别、行业、上涨/入选原因（带出处）、领跑/跟随角色。
 *  - pools()：次日备选观察池 / 风险规避池，每条都带"为什么"与"看什么"，全部来自可观测快照。
 *
 * 纪律：只做程序可观测的事实归纳与去重，不预测涨跌、不给买卖动作、不编造缺失数据。
 * 落盘：data/strategy.json（供 /api/v2/strategy、每日行情、短线复盘、智能体上下文共用）
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data');
const F = {
  trend: path.join(DATA, 'trend-screen.json'),
  dip: path.join(DATA, 'dip-screen.json'),
  board: path.join(DATA, 'board-screen.json'),
  breakout: path.join(DATA, 'breakout-screen.json')
};
const F_INSIGHT = path.join(DATA, 'pick-insight.json');
const F_SENTIMENT = path.join(DATA, 'sentiment.json');
const F_LIMITUP = path.join(DATA, 'limitup-cache.json');
const F_STOCKS = path.join(DATA, 'stocks-cache.json');
const F_OUT = path.join(DATA, 'strategy.json');

const KINDS = [
  { key: 'trend', label: '趋势' },
  { key: 'dip', label: '低吸' },
  { key: 'board', label: '打板' },
  { key: 'breakout', label: '趋势突破' }
];

function readJson(f) {
  try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  return null;
}
function writeJson(f, o) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = f + '.tmp';
  fs.writeFileSync(t, JSON.stringify(o, null, 2), 'utf8');
  fs.renameSync(t, f);
}
function bjNow() { return new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); }
function cap(s, n) { const x = String(s == null ? '' : s); return x.length > n ? x.slice(0, n) + '…' : x; }

/** 行业兜底表：优先 stocks-cache，其次涨停/炸板缓存，均来自已落盘快照，不联网、不编造 */
function loadIndustryMap() {
  const map = new Map();
  const stocks = readJson(F_STOCKS);
  for (const x of ((stocks && stocks.items) || [])) {
    if (x.code && x.industry && !map.has(String(x.code))) map.set(String(x.code), String(x.industry));
  }
  const lu = readJson(F_LIMITUP);
  for (const x of [].concat((lu && lu.zt) || [], (lu && lu.zb) || [])) {
    if (x.code && x.industry && !map.has(String(x.code))) map.set(String(x.code), String(x.industry));
  }
  return map;
}

/** 把解释层按 code 建索引，用于给四类标的补行业 / 上涨原因 / 领跑跟随角色 */
function loadInsightIndex() {
  const ins = readJson(F_INSIGHT);
  const byCode = new Map();
  if (ins && Array.isArray(ins.items)) for (const x of ins.items) if (x.code) byCode.set(String(x.code), x);
  return { raw: ins, byCode };
}

/**
 * 四类合并视图：一个板块内逐行标注 kind/kindLabel，附行业、上涨/入选原因、角色。
 * 解释层有该 code 时复用其证据链；没有时用该类自身的 rule/reason/scoreParts 构造带出处的原因。
 */
function fourClass() {
  const industryMap = loadIndustryMap();
  const { raw: insight, byCode } = loadInsightIndex();
  const rows = [];
  const counts = {};
  const missing = [];

  for (const k of KINDS) {
    const d = readJson(F[k.key]);
    if (!d || !Array.isArray(d.items)) { counts[k.key] = 0; missing.push(k.label); continue; }
    counts[k.key] = d.items.length;
    for (const it of d.items) {
      const code = String(it.code || '');
      if (!code) continue;
      const ex = byCode.get(code);
      const industry = (ex && ex.industry) || it.industry || industryMap.get(code) || null;
      // 上涨/入选原因：优先解释层的证据链（每条带 source），否则用该类可观测字段构造
      let drivers = (ex && Array.isArray(ex.riseDrivers) && ex.riseDrivers.length) ? ex.riseDrivers : null;
      if (!drivers) {
        drivers = [];
        if (it.reason) drivers.push({ type: 'technical', text: cap(it.reason, 120), source: '日线量化判定（' + k.label + '）' });
        if (k.key === 'board') {
          drivers.push({ type: 'capital', text: ((it.boards || 1) + '连板 · 首封' + (it.firstSealLabel || '待补充') + ' · 封单比' + (it.sealRatio != null ? it.sealRatio + '%' : '待补充')), source: '涨停池快照 ' + ((readJson(F_LIMITUP) || {}).date || '') });
        } else if (k.key === 'breakout') {
          drivers.push({ type: 'technical', text: '放量突破近20日高点' + (it.breakPct != null ? it.breakPct + '%' : '') + '，量比' + (it.volBurst != null ? it.volBurst : '待补充'), source: '日线量价计算' });
        } else if (k.key === 'dip') {
          drivers.push({ type: 'technical', text: cap(it.touch || '回踩均线不破位', 90), source: '日线量价计算' });
        }
        if (d.rule) drivers.push({ type: 'rule', text: cap(d.rule, 140), source: '四类筛选规则' });
      }
      const row = {
        code, name: it.name || (ex && ex.name) || null,
        kind: k.key, kindLabel: k.label,
        score: it.score != null ? it.score : (ex && ex.score != null ? ex.score : null),
        industry: industry || null,
        last: it.last != null ? it.last : null,
        riseDrivers: drivers,
        driverSummary: (ex && ex.driverSummary) || drivers.map(x => x.text).slice(0, 2).join('；'),
        role: (ex && ex.role) || 'standalone',
        leaderCode: (ex && ex.leaderCode) || null,
        leaderName: (ex && ex.leaderName) || null,
        gapToLeader: (ex && ex.gapToLeader) != null ? ex.gapToLeader : null,
        ruleText: d.rule || null,
        dataSource: k.key + '-screen.json'
      };
      rows.push(row);
    }
  }
  // 同一 code 可能同时命中多类：保留评分最高的一条，其余类别合并进 classes 字段（不重复占行）
  const byCodeOut = new Map();
  for (const r of rows) {
    if (!byCodeOut.has(r.code)) { byCodeOut.set(r.code, { ...r, classes: [r.kindLabel] }); continue; }
    const cur = byCodeOut.get(r.code);
    if (!cur.classes.includes(r.kindLabel)) cur.classes.push(r.kindLabel);
    if ((r.score || 0) > (cur.score || 0)) {
      const classes = cur.classes;
      byCodeOut.set(r.code, { ...r, classes });
    }
  }
  const items = [...byCodeOut.values()].sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.code).localeCompare(String(b.code)));

  // 领跑/跟随：沿用解释层的板块梯队，并补上四类里出现但解释层未覆盖的领跑（board 高连板）
  const leaders = (insight && Array.isArray(insight.leaders)) ? insight.leaders.slice() : [];
  const followers = (insight && insight.followers && typeof insight.followers === 'object') ? { ...insight.followers } : {};

  return {
    ok: rows.length > 0,
    generatedAt: bjNow(),
    kinds: KINDS.map(k => ({ key: k.key, label: k.label, count: counts[k.key] || 0 })),
    counts,
    totalRows: items.length,
    items,
    leaders,
    followers,
    missingFiles: missing,
    insightLinked: byCode.size,
    note: '四类合并为同一板块，逐行标注类别；行业/上涨原因优先复用 pick-insight 证据链，未覆盖者用该类日线量价与涨停快照构造，均标注来源。'
  };
}

/**
 * 次日备选观察池：来自四类 focus、连板梯队、板块领跑与跟随，每条给出"为什么观察 / 次日看什么"。
 * 风险规避池：来自炸板未封、高位连板（均值回归）、跌停、市场级情绪恶化信号。
 */
function pools() {
  const four = fourClass();
  const senti = readJson(F_SENTIMENT) || {};
  const lu = readJson(F_LIMITUP) || {};
  const ins = readJson(F_INSIGHT) || {};

  // ---------- 次日备选观察池 ----------
  const fourByCode = new Map(four.items.map(x => [x.code, x]));
  const watchMap = new Map();
  const addWatch = (x, why, track, source, priority) => {
    const code = String((x && x.code) || '');
    if (!code) return;
    const f = fourByCode.get(code);
    const cur = watchMap.get(code);
    if (!cur || priority > cur.priority) {
      watchMap.set(code, {
        code, name: x.name || (f && f.name) || null,
        kind: x.kindLabel || x.kind || (f && f.kindLabel) || null,
        classes: (f && f.classes) || null,
        industry: x.industry || (f && f.industry) || null,
        score: x.score != null ? x.score : (f && f.score != null ? f.score : null),
        why: cap(why, 150), track: cap(track, 150), source,
        priority: priority || 0
      });
    }
  };

  // ① 四类每类 focus 前 3
  for (const k of KINDS) {
    const d = readJson(F[k.key]);
    for (const x of ((d && d.focus) || []).slice(0, 3)) {
      addWatch(x, '入选「' + k.label + '」重点关注：' + (x.keyMetric || x.reason || d.rule || '量化评分靠前'),
        '次日量价是否延续该形态（' + k.label + '口径），不预设方向',
        k.key + '-screen.json focus', 1);
    }
  }
  // ② 连板梯队（>=3板） leaders
  for (const x of ((senti.boardHeight && senti.boardHeight.leaders) || []).slice(0, 8)) {
    addWatch(x, (x.boards || '?') + '连板，处于当日短线高度梯队（最高' + ((senti.boardHeight || {}).maxBoards || '?') + '板）',
      '次日竞价与封板稳定性、是否晋级或断板', 'sentiment.json 连板梯队', 2);
  }
  // ③ 板块领跑股 + 其跟随股
  for (const l of (ins.leaders || []).slice(0, 6)) {
    addWatch({ code: l.code, name: l.name, industry: l.industry }, '判定为「' + (l.industry || '板块') + '」领跑股：' + cap(l.reason || l.driverSummary || '板块内强度领先', 90),
      '次日领跑股能否延续，以及同板块跟随股是否补涨', 'pick-insight.json 领跑判定', 3);
  }
  for (const [lk, arr] of Object.entries(ins.followers || {})) {
    for (const f of (arr || []).slice(0, 2)) {
      addWatch({ code: f.code, name: f.name }, '「' + String(lk).split('::')[0] + '」板块跟随候选，与领跑股存在强度差 ' + (f.gapToLeader != null ? f.gapToLeader : '待补充'),
        '次日是否出现跟随补涨或继续分化', 'pick-insight.json 跟随股', 1);
    }
  }
  const watchPool = [...watchMap.values()].sort((a, b) => b.priority - a.priority || (b.score || 0) - (a.score || 0)).slice(0, 24)
    .map(({ priority, ...r }) => r);

  // ---------- 风险规避池 ----------
  const riskMap = new Map();
  const addRisk = (x, reason, riskType, source, priority) => {
    const code = String((x && x.code) || '');
    if (!code) return;
    const cur = riskMap.get(code);
    if (!cur || priority > cur.priority) {
      riskMap.set(code, {
        code, name: x.name || null, industry: x.industry || null,
        reason: cap(reason, 160), riskType, source, priority: priority || 0
      });
    }
  };
  // ① 炸板未封
  for (const x of (lu.zb || []).slice(0, 14)) {
    addRisk(x, '当日触板未封（炸板），收盘回落' + (x.pct != null ? Number(x.pct).toFixed(1) + '%' : '') +
      (x.failDepth != null ? '，回撤深度' + x.failDepth + '%' : '') + '：封板资金分歧',
      '炸板未回封', 'limitup-cache.json 炸板池', 2);
  }
  // ② 高位连板（>=3板）均值回归风险
  for (const x of (lu.zt || []).filter(z => Number(z.boards) >= 3).slice(0, 10)) {
    addRisk(x, x.boards + '连板高位：A股 ≥3 板候选次日收益存在均值回归经验（历史约 -1.2%~-4.3%），开板即快速回落风险显著',
      '高位连板', 'limitup-cache.json 涨停池 boards', 3);
  }
  // ③ 跌停
  for (const x of (lu.dt || []).slice(0, 10)) {
    addRisk(x, '当日跌停，属明确弱势/风险释放标的', '跌停', 'limitup-cache.json 跌停池', 3);
  }
  const riskPool = [...riskMap.values()].sort((a, b) => b.priority - a.priority).slice(0, 24)
    .map(({ priority, ...r }) => r);

  // ---------- 市场级情绪提示（不是个股，不计入池） ----------
  const alerts = [];
  const br = senti.breakRate || {}, me = senti.moneyEffect || {}, bh = senti.boardHeight || {};
  if (br.rate != null && br.rate >= 30) alerts.push('炸板率 ' + br.rate + '%（' + br.level + '），封板资金稳定性偏弱，短线接力需谨慎。');
  else if (br.rate != null) alerts.push('炸板率 ' + br.rate + '%（' + br.level + '）。');
  if (me.ok && me.avgRet != null && me.avgRet < 0) alerts.push('昨日涨停股今日平均收益 ' + me.avgRet + '%（赚钱效应为负），接力亏钱效应显现。');
  else if (me.ok) alerts.push('昨日涨停股今日平均收益 +' + me.avgRet + '%，上涨占比 ' + me.upRatio + '%，赚钱效应为正。');
  if (bh.maxBoards >= 5) alerts.push('最高连板 ' + bh.maxBoards + ' 板（' + bh.heightLevel + '），梯队处于高位，注意空间板退潮风险。');

  // ---------- 跨池冲突检测：只如实标注，不删成员、不改评分、不做买卖判断 ----------
  // 成因：观察池②取 sentiment.json 的连板梯队 leaders，风险池②取 limitup-cache.json 的 >=3 板涨停；
  //       同一「高位连板」事实被两条规则分别送进语义相反的两个池，且两池各自独立生成、无互斥裁决。
  const riskByCode = new Map(riskPool.map(x => [x.code, x]));
  const conflicts = watchPool.filter(x => riskByCode.has(x.code)).map(x => {
    const r = riskByCode.get(x.code);
    return {
      code: x.code, name: x.name || r.name || null,
      watchReason: x.why, watchSource: x.source,
      riskReason: r.reason, riskType: r.riskType, riskSource: r.source,
      sharedFact: '同一「≥3 板高位连板」事实分别命中观察池连板梯队规则与风险池高位回归规则',
      note: '本系统只如实并列展示，不自动剔除、不给出买卖判断；是否互斥由使用者决定。'
    };
  });

  return {
    ok: true,
    generatedAt: bjNow(),
    asOf: {
      screen: (KINDS.map(k => readJson(F[k.key])).find(Boolean) || {}).generatedAt || null,
      sentiment: senti.date || null,
      limitup: lu.date || null
    },
    watchPool, riskPool, alerts,
    watchCount: watchPool.length, riskCount: riskPool.length,
    conflicts, conflictCount: conflicts.length,
    sentiment: senti.shortTerm ? { money: senti.shortTerm.money, height: senti.shortTerm.height, breakRate: senti.shortTerm.breakRate, summary: senti.shortTerm.summary } : null,
    fourClassCounts: four.counts,
    note: '次日备选观察池=四类重点+连板梯队+领跑/跟随；风险规避池=炸板+高位连板+跌停。均为"值得观察/需留意"的研究清单，非推荐、非买卖指令。若同一标的同时出现在两池，见 conflicts 字段（仅标注成因，不自动剔除）。'
  };
}

function build() {
  const four = fourClass();
  const p = pools();
  const out = {
    ok: true,
    generatedAt: bjNow(),
    fourClass: four,
    pools: p,
    disclaimer: '以上为程序按公开行情与已落盘快照归纳的研究清单，不构成任何证券买卖建议或涨跌预测；投资有风险，决策需独立。'
  };
  writeJson(F_OUT, out);
  return out;
}

function latest() { return readJson(F_OUT); }

module.exports = { build, latest, fourClass, pools, F_OUT };
