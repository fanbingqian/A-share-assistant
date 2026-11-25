'use strict';
/**
 * event-study.js — 事件历史统计引擎（P1）
 *
 * 目标：把「某类事件发生后相关板块怎么走」从口号变成可核对的样本统计。
 * 方法：
 *   ① 从 calendar.js 的规则 + 用户事件展开近 N 年事件；
 *   ② 用真实日线（新浪日 K，东财被代理拦截时的可用源）取事件日 T 及 T+1/T+3/T+5；
 *   ③ 用可交易 ETF 作为板块代理，benchmark 用上证指数，计算超额 AR 与胜率；
 *   ④ 落盘 data/calendar/event-study.json，供事件提醒卡片与智能体解读调用。
 *
 * 纪律：
 *   - 样本数不足 8 时明确标注「低样本，不可外推」；
 *   - 代理 ETF 是近似口径，不把 ETF 表现冒充行业指数；
 *   - 不做买卖建议，不把历史胜率当未来概率承诺。
 */

const fs = require('node:fs');
const path = require('node:path');
const cal = require('./calendar');

const DIR = path.join(__dirname, '..', 'data', 'calendar');
const F_STUDY = path.join(DIR, 'event-study.json');
const F_SERIES = path.join(DIR, 'series-cache.json');
const BENCH = { code: 'sh000001', label: '上证指数' };
const HORIZONS = [1, 3, 5];
const TTL_SERIES = 12 * 3600e3;
const TTL_STUDY = 12 * 3600e3;

/** 板块关键词 → 可交易 ETF 代理（近似口径，绝不冒充行业指数） */
const SECTOR_PROXY = {
  '黄金': ['sh518880'],
  '创新药': ['sz159992'],
  '医药': ['sh512010'], '中药': ['sh512010'], '医药商业': ['sh512010'],
  '地产': ['sh512200'], '基建': ['sh512200'],
  '消费': ['sz159928'], '扩内需': ['sz159928'],
  '科技': ['sh515000'], '新质生产力': ['sh515000'], '政策主题': ['sh515000'],
  '煤炭': ['sh515220'], '煤化工': ['sh515220'],
  '电力': ['sz159611'], '电网设备': ['sz159611'],
  '业绩': ['sz159949'], '高送转': ['sz159949'], '全市场': ['sh510300'],
  '成长股': ['sz159949'], '北向资金': ['sh510300'],
  '出口链': ['sh512690'], '家居': ['sh512690'], '旅游': ['sh512690'], '交通': ['sh512690'],
  '通信': ['sh515000'], '算力': ['sh515000'], '汽车': ['sh516110'], '新能源': ['sh515790'],
  '石油': ['sh515220'], '化工': ['sh515220'], '煤化工': ['sh515220'], '航运': ['sh515220'],
  '券商': ['sh512000'], '物流': ['sh512690'], '农业': ['sh512690'],
  '美元': [], '美债': []
};
const PROXY_LABEL = {
  sh518880: '黄金ETF', sz159992: '创新药ETF', sh512010: '医药ETF', sh512200: '地产ETF',
  sz159928: '消费ETF', sh515000: '科技ETF', sh515220: '煤炭ETF', sz159611: '电力ETF',
  sz159949: '创业板50ETF', sh510300: '沪深300ETF', sh512690: '酒ETF', sh516110: '汽车ETF',
  sh515790: '光伏ETF', sh512000: '券商ETF'
};

/**
 * 规则机制说明：用于「为什么会影响」的确定性文字（不是编造数字，是公开机制链条）。
 * 智能体在 eventImpact 中被要求以此为基础、结合统计展开详细解释。
 */
const MECHANISM = {
  'cn-lianghui': '政府工作报告设定增长目标、赤字率与专项债规模， 直接决定财政发力方向与产业政策主线；两会前市场常交易政策预期，会后看是否兑现。观察：政策主题、新质生产力、扩内需板块相对强弱。',
  'cn-cewc': '中央经济工作会议定调次年宏观政策总基调（财政/货币/地产/产业），是全年政策预期锚；定调偏宽松或强调某产业时，相关板块预期上修。观察：消费、科技、地产对定调的定价。',
  'cn-politburo': '经济议题政治局会议是季度政策转向窗口，措辞变化（如「适度加力」「防风险」）会影响市场对地产、基建与流动性的判断。',
  'fomc': '美联储利率决定与点阵图改变美债实际利率与美元指数，进而影响全球风险偏好、黄金定价与北向资金流向；降息预期升温通常利好黄金与成长股。',
  'us-nfp': '非农就业强弱决定美联储降息路径预期：就业弱→降息预期升→美元走弱、黄金与成长股受益；就业强→相反。对 A 股主要通过汇率与外资风险偏好传导。',
  'us-cpi': '通胀数据直接影响美债收益率与全球估值，超预期会压制高估值成长股并推升避险；低于预期则相反。',
  'cn-medicare': '医保目录谈判结果是创新药能否放量的关键商业化节点，纳入或续约降幅直接改变销售收入预期；同时影响中药与医药商业的估值。',
  'cn-pmi': 'PMI 是制造业景气先行指标，站上/跌破 50 荣枯线会影响顺周期（煤炭、地产链、消费）与大盘情绪的定价。',
  'cn-cpi-ppi': 'PPI 回升意味着上游涨价与企业盈利修复，利好周期；CPI 高低决定货币政策空间与消费板块弹性。',
  'cn-lpr': 'LPR 下调降低融资成本，利好地产与券商、提升高股息相对吸引力；是观察货币政策取向的直接信号。',
  'cn-gdp': '季度增长数据验证全年目标完成度，超预期提振顺周期与大盘信心，低于预期强化宽松预期。',
  'cn-social-finance': '社融与信贷是流动性宽窄核心观测，超预期利好金融与顺周期，是 A 股中期行情的领先变量之一。',
  'wef-davos': '达沃斯为全球政商议题风向标，AI、能源转型、地缘经济等主题表态会影响相关产业的叙事与风险偏好。',
  'ces': 'CES 展示消费电子/AI/智能驾驶新品，是 A 股科技、智能汽车与消费电子主题的年度催化窗口，靠 mapper 的主题映射传导。',
  'apec': 'APEC 聚焦亚太自贸区、跨境支付与数字经济合作，对外贸、跨境电商与科技出海形成主题催化。',
  'ciiе': '进博会释放扩大进口与开放信号，利好消费、医药与高端制造进口替代相关的主题预期。',
  'canton-fair': '广交会的订单与客商数据是外贸景气的高频验证，影响出口链与家居消费的盈利预期。',
  'waic': '世界人工智能大会集中发布大模型与算力产品，是 A 股 AI 算力与传媒应用的主题催化。',
  'us-earnings': '美股头部企业财报影响全球风险偏好与 A 股映射主题（尤其科技链），是外部情绪输入。'
};

function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }
function readJson(f) { try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} return null; }
function writeJson(f, o) { ensureDir(); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2), 'utf8'); fs.renameSync(t, f); }
function bjDate(ts = Date.now()) { return new Date(ts + 8 * 3600e3).toISOString().slice(0, 10); }
function round(v, n = 2) { return Number.isFinite(v) ? Math.round(v * Math.pow(10, n)) / Math.pow(10, n) : null; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function shiftDate(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------ 日线抓取与缓存 ------------------------------ */

/** 新浪日 K（不复权，已标注）；datalen 足够覆盖近 2 年 */
async function fetchSina(code, datalen = 640) {
  const hasPrefix = /^(sh|sz|bj)/i.test(code);
  const prefix = hasPrefix ? String(code).slice(0, 2).toLowerCase()
    : (/^6/.test(code) ? 'sh' : (/^(4|8)/.test(code) ? 'bj' : 'sz'));
  const symbol = (hasPrefix ? String(code).slice(2) : code);
  const url = 'https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData' +
    '?symbol=' + prefix + symbol + '&scale=240&ma=no&datalen=' + datalen;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn' },
      signal: ac.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) throw new Error('空数据');
    // 入参可能已带 sh/sz 前缀，去掉重复
    const bars = arr.map(x => ({
      d: String(x.day || '').slice(0, 10),
      c: Number(x.close), o: Number(x.open), h: Number(x.high), l: Number(x.low)
    })).filter(x => x.d && Number.isFinite(x.c) && x.c > 0);
    if (!bars.length) throw new Error('解析为空');
    return bars;
  } finally { clearTimeout(timer); }
}

function allCodes() {
  const set = new Set([BENCH.code]);
  for (const codes of Object.values(SECTOR_PROXY)) for (const c of codes) set.add(c);
  return [...set];
}

async function loadSeries({ force = false } = {}) {
  const cached = readJson(F_SERIES);
  if (!force && cached && cached.series && Date.now() - (cached.generatedAt || 0) < TTL_SERIES) {
    return { series: cached.series, source: cached.source || '缓存', cached: true };
  }
  const series = {};
  const errors = [];
  const codes = allCodes();
  for (const code of codes) {
    try {
      const bars = await fetchSina(code);
      if (bars.length > 60) series[code] = bars;
      else errors.push(code + ':样本不足');
    } catch (e) { errors.push(code + ':' + e.message); }
    await sleep(120);
  }
  if (!series[BENCH.code]) throw new Error('基准日线抓取失败：' + errors.join('; '));
  const out = { generatedAt: Date.now(), source: '新浪日K（不复权）', series, errors };
  writeJson(F_SERIES, out);
  return { series, source: out.source, cached: false, errors };
}

/* ------------------------------ 事件与代理 ------------------------------ */

function expandEvents(years = 2, fromDate) {
  const today = fromDate || bjDate();
  const start = shiftDate(today, -Math.round(years * 365));
  const y0 = Number(start.slice(0, 4)), y1 = Number(today.slice(0, 4));
  const events = [], monthOnly = [];
  for (let y = y0; y <= y1; y++) {
    for (const e of cal.expandRules(y, null)) {
      if (e.date < start || e.date > today) continue;
      // 只有月份、没有具体日期的事件（FOMC/季节性）不进入后验统计，避免用月首冒充事件日
      if (e.allMonth) { monthOnly.push(e); continue; }
      events.push(e);
    }
  }
  for (const e of cal.readUserEvents()) if (e.date >= start && e.date <= today) events.push({ ...e, ruleId: e.ruleId || 'user' });
  events.sort((a, b) => a.date.localeCompare(b.date));
  return { events, monthOnly, start, end: today };
}

function proxiesFor(event) {
  const sectors = Array.isArray(event.sectors) ? event.sectors : [];
  const codes = new Set();
  for (const s of sectors) {
    for (const [kw, list] of Object.entries(SECTOR_PROXY)) {
      if (String(s).includes(kw) || kw.includes(String(s))) for (const c of list) codes.add(c);
    }
  }
  // 规则兜底：有明确 A 股映射的规则，避免用户事件未填 sectors 时完全无样本
  if (!codes.size) {
    const fallback = {
      'cn-medicare': ['sz159992', 'sh512010'], 'cn-lianghui': ['sh515000', 'sz159928'],
      'cn-politburo': ['sh515000', 'sz159928'], 'cn-cewc': ['sz159928', 'sh515000'],
      'coal-peak': ['sh515220', 'sz159611'], 'power-demand': ['sz159611']
    }[event.ruleId] || [];
    for (const c of fallback) codes.add(c);
  }
  return [...codes];
}

/* ------------------------------ 统计核心 ------------------------------ */

function statsOf(obs) {
  if (!obs.length) return { samples: 0, events: 0, note: '无有效样本' };
  const n = obs.length;
  const events = new Set(obs.map(o => o.eventId)).size;
  const r = { samples: n, events };
  for (const h of HORIZONS) {
    const ars = obs.map(o => o['ar' + h]).filter(Number.isFinite);
    const raws = obs.map(o => o['ret' + h]).filter(Number.isFinite);
    r['win' + h] = ars.length ? round(ars.filter(x => x > 0).length / ars.length * 100, 1) : null;
    r['avgAr' + h] = round(mean(ars));
    r['avgRet' + h] = round(mean(raws));
    // 绝对上涨概率（不看大盘，仅板块代理自身涨跌>0）
    r['upProb' + h] = raws.length ? round(raws.filter(x => x > 0).length / raws.length * 100, 1) : null;
    // 涨跌分布：上涨/下跌/持平的样本占比
    r['dist' + h] = raws.length ? {
      up: round(raws.filter(x => x > 0).length / raws.length * 100, 1),
      down: round(raws.filter(x => x < 0).length / raws.length * 100, 1),
      flat: round(raws.filter(x => x === 0).length / raws.length * 100, 1)
    } : null;
  }
  // 事件前 T-5/T-3/T-1 的涨跌百分比均值（回答「这件事之前股票通常怎么走」）
  for (const h of [5, 3, 1]) {
    const pre = obs.map(o => o['preRet' + h]).filter(Number.isFinite);
    const preAr = obs.map(o => o['preAr' + h]).filter(Number.isFinite);
    r['avgPre' + h] = round(mean(pre));
    r['avgPreAr' + h] = round(mean(preAr));
    r['preUpProb' + h] = pre.length ? round(pre.filter(x => x > 0).length / pre.length * 100, 1) : null;
  }
  r.confidence = n >= 20 ? '中' : n >= 8 ? '低-中' : '低样本';
  r.note = n < 8 ? '样本不足 8，只作线索，不可外推' : 'ETF 代理近似口径，历史表现不代表未来';
  return r;
}

function compute(events, series) {
  const bench = series[BENCH.code];
  const dates = bench.map(b => b.d);
  const idxOf = new Map(dates.map((d, i) => [d, i]));
  const priceOf = new Map();
  for (const [code, bars] of Object.entries(series)) {
    priceOf.set(code, new Map(bars.map(b => [b.d, b.c])));
  }
  const benchPrice = priceOf.get(BENCH.code);
  const observations = [];
  const noProxy = [];

  for (const e of events) {
    let t = idxOf.get(e.date);
    if (t == null) {
      // 非交易日：取之后第一个交易日作为事件发酵起点，并保留原始日期
      t = dates.findIndex(d => d > e.date);
      if (t < 0) continue;
    }
    const effectiveDate = dates[t];
    const proxies = proxiesFor(e);
    if (!proxies.length) { noProxy.push({ id: e.id, name: e.name, ruleId: e.ruleId || 'user' }); continue; }
    for (const code of proxies) {
      const p = priceOf.get(code);
      if (!p) continue;
      const p0 = p.get(effectiveDate), b0 = benchPrice.get(effectiveDate);
      if (!p0 || !b0) continue;
      const row = {
        eventId: e.id, ruleId: e.ruleId || 'user', name: e.name, grade: e.grade,
        eventDate: e.date, effectiveDate, proxy: code, label: PROXY_LABEL[code] || code,
        sectors: e.sectors || []
      };
      let valid = false;
      for (const h of HORIZONS) {
        const dt = dates[t + h];
        const pH = dt ? p.get(dt) : null, bH = dt ? benchPrice.get(dt) : null;
        if (!pH || !bH) continue;
        const ret = round((pH / p0 - 1) * 100);
        const bRet = round((bH / b0 - 1) * 100);
        row['ret' + h] = ret;
        row['bench' + h] = bRet;
        row['ar' + h] = round(ret - bRet);
        valid = true;
      }
      // 事件「之前」的涨跌百分比（T-5 / T-3 / T-1 收盘对事件日收盘），用于回答「事件前股票涨跌情况」
      for (const h of [5, 3, 1]) {
        const dt = dates[t - h];
        const pPrev = dt ? p.get(dt) : null, bPrev = dt ? benchPrice.get(dt) : null;
        if (pPrev && bPrev) {
          row['preRet' + h] = round((p0 / pPrev - 1) * 100);
          row['preBench' + h] = round((b0 / bPrev - 1) * 100);
          row['preAr' + h] = round(row['preRet' + h] - row['preBench' + h]);
        }
      }
      if (valid) observations.push(row);
    }
  }

  const byRule = {};
  for (const o of observations) (byRule[o.ruleId] = byRule[o.ruleId] || []).push(o);
  const rules = Object.entries(byRule).map(([ruleId, obs]) => ({
    ruleId, name: obs[0].name, grade: obs[0].grade,
    proxies: [...new Set(obs.map(o => o.proxy))],
    stats: statsOf(obs)
  })).sort((a, b) => b.stats.samples - a.stats.samples);

  const byProxy = {};
  for (const o of observations) (byProxy[o.proxy] = byProxy[o.proxy] || []).push(o);
  const proxyStats = Object.entries(byProxy).map(([proxy, obs]) => ({
    proxy, label: PROXY_LABEL[proxy] || proxy, stats: statsOf(obs)
  })).sort((a, b) => b.stats.samples - a.stats.samples);

  const ruleMeta = Object.fromEntries(cal.RULES.map(r => [r.id, { name: r.name, grade: r.grade, sectors: r.sectors }]));
  return {
    observations, rules, proxyStats, ruleMeta, noProxy,
    overall: statsOf(observations)
  };
}

/* ------------------------------ 对外接口 ------------------------------ */

async function refresh({ years = 2, force = false, fromDate } = {}) {
  const s = await loadSeries({ force });
  const { events, monthOnly, start, end } = expandEvents(years, fromDate);
  const c = compute(events, s.series);
  const out = {
    ok: true,
    generatedAt: new Date().toISOString(),
    window: { from: start, to: end },
    method: 'T+1/T+3/T+5 收盘对收盘；AR=板块ETF收益-上证收益；样本为事件×代理ETF',
    benchmark: BENCH,
    source: s.source,
    seriesErrors: s.errors || [],
    eventCount: events.length,
    monthOnlyCount: monthOnly.length,
    observedEventCount: new Set(c.observations.map(o => o.eventId)).size,
    observationCount: c.observations.length,
    noProxy: c.noProxy.concat(monthOnly.slice(0, 20).map(e => ({ id: e.id, name: e.name, ruleId: e.ruleId, reason: '仅有月份无具体日期，不做后验统计' }))),
    rules: c.rules,
    proxyStats: c.proxyStats,
    ruleMeta: c.ruleMeta,
    overall: c.overall,
    observations: c.observations,
    note: '板块用可交易 ETF 近似；美元/美债等无 A 股直接代理、以及只有月份无具体日期的事件不做后验统计。历史统计不构成买卖建议。'
  };
  writeJson(F_STUDY, out);
  return {
    ok: true, generatedAt: out.generatedAt, window: out.window,
    eventCount: out.eventCount, observationCount: out.observationCount,
    rules: out.rules.length, overall: out.overall, seriesErrors: out.seriesErrors.length
  };
}

function study() {
  const j = readJson(F_STUDY);
  return j ? { ok: true, data: j } : { ok: false, error: '事件研究尚未生成，请先执行 refresh' };
}

/** 分板块明细：每个代理 ETF 的涨跌百分比与上涨概率，用于「哪些板块涨跌、多少百分比」 */
function byProxyOf(obs) {
  const g = {};
  for (const o of obs) (g[o.proxy] = g[o.proxy] || []).push(o);
  return Object.entries(g).map(([proxy, rows]) => {
    const s = statsOf(rows);
    return {
      proxy, label: rows[0].label || PROXY_LABEL[proxy] || proxy,
      samples: s.samples,
      preRet5: s.avgPre5, preRet3: s.avgPre3,
      ret1: s.avgRet1, ret3: s.avgRet3, ret5: s.avgRet5,
      ar5: s.avgAr5, upProb5: s.upProb5, dist5: s.dist5
    };
  }).sort((a, b) => (b.ret5 == null ? -999 : b.ret5) - (a.ret5 == null ? -999 : a.ret5));
}

/** 把统计转成给智能体/前端的详细文字：包含原因机制、事件前涨跌、事件后涨跌百分比与上涨概率 */
function formatDetail(name, s, proxies) {
  const low = (s.samples || 0) < 8 ? '（低样本，不可外推）' : '';
  const pct = v => v == null ? '待补充' : (v > 0 ? '+' : '') + v + '%';
  const parts = [];
  parts.push('【' + name + '】历史样本：近2年 ' + s.events + ' 次同类事件、' + s.samples + ' 次板块观测' + low + '。');
  parts.push('事件之前：相关板块 T-5 平均 ' + pct(s.avgPre5) + '、T-3 平均 ' + pct(s.avgPre3) +
    '，事件前5日上涨占比 ' + (s.preUpProb5 == null ? '待补充' : s.preUpProb5 + '%') + '（说明是否存在提前交易预期）。');
  parts.push('事件之后：T+1 平均 ' + pct(s.avgRet1) + '、T+3 平均 ' + pct(s.avgRet3) + '、T+5 平均 ' + pct(s.avgRet5) +
    '；相对上证超额 T+5 平均 ' + pct(s.avgAr5) + '，T+5 上涨概率 ' + (s.upProb5 == null ? '待补充' : s.upProb5 + '%') +
    '，超额为正概率 ' + (s.win5 == null ? '待补充' : s.win5 + '%') + '。');
  if (s.dist5) parts.push('T+5 涨跌分布：上涨 ' + s.dist5.up + '% / 下跌 ' + s.dist5.down + '% / 持平 ' + s.dist5.flat + '%。');
  if (proxies && proxies.length) {
    const seg = proxies.slice(0, 6).map(p => p.label + '：事件前5日 ' + pct(p.preRet5) + '、之后T+5 ' + pct(p.ret5) +
      '、上涨概率 ' + (p.upProb5 == null ? '待补充' : p.upProb5 + '%')).join('；');
    parts.push('分板块（ETF代理，近似口径）：' + seg + '。');
  }
  return parts.join(' ');
}

/** 面向单条事件的详细统计：优先规则级，其次按事件相关板块合并代理观测 */
function forEvent(event, { maxAgeDays = 30 } = {}) {
  const j = readJson(F_STUDY);
  if (!j || !j.ok) return { ok: false, error: '事件研究尚未生成' };
  const ageDays = (Date.now() - new Date(j.generatedAt).getTime()) / 86400e3;
  const ruleId = event && (event.ruleId || String(event.eventId || event.id || '').replace(/-\d{4}-\d{2}-\d{2}.*$/, '').replace(/@.*$/, '') || null);
  // 口径元数据随统计一起返回给智能体：避免模型自行「推断/补写」统计口径（低幻觉纪律）
  const base = {
    generatedAt: j.generatedAt, stale: ageDays > maxAgeDays, ruleId,
    mechanism: MECHANISM[ruleId] || null,
    method: j.method || null,          // T+N 定义、超额基准、样本口径
    window: j.window || null,          // 统计窗口
    benchmark: j.benchmark || null,    // 基准指数
    statNote: j.note || null,          // 「美元/美债无 A 股代理」等限制说明
    statSource: j.source || null       // 日线数据源
  };
  const byRule = j.rules.find(r => r.ruleId === ruleId);
  if (byRule && byRule.stats.samples) {
    const proxies = byProxyOf((j.observations || []).filter(o => o.ruleId === ruleId));
    return {
      ok: true, scope: 'rule', ruleId, name: byRule.name,
      summary: byRule.stats, proxies, ...base,
      line: formatLine(byRule.name, byRule.stats),
      detail: formatDetail(byRule.name, byRule.stats, proxies)
    };
  }
  const excluded = (j.noProxy || []).find(x => x.ruleId === ruleId && /月份/.test(x.reason || ''));
  if (excluded) return { ok: false, error: excluded.reason, ruleId, mechanism: MECHANISM[ruleId] || null };
  const codes = new Set(proxiesFor(event || {}));
  const obs = (j.observations || []).filter(o => codes.has(o.proxy));
  if (!obs.length) return { ok: false, error: '该类事件暂无 A 股代理样本', mechanism: MECHANISM[ruleId] || null };
  const s = statsOf(obs);
  const proxies = byProxyOf(obs);
  return {
    ok: true, scope: 'proxy', ruleId: ruleId || null,
    summary: s, proxies, ...base,
    line: formatLine('相关板块代理', s),
    detail: formatDetail('相关板块代理', s, proxies)
  };
}

function formatLine(name, s) {
  if (!s || !s.samples) return '历史统计：无有效样本';
  const low = s.samples < 8 ? '（低样本，仅供参考）' : '';
  return '历史统计：' + name + ' 近2年 ' + s.events + ' 次事件 / ' + s.samples +
    ' 次观测，T+5 平均超额 ' + (s.avgAr5 == null ? '待补充' : (s.avgAr5 > 0 ? '+' : '') + s.avgAr5 + '%') +
    '，胜率 ' + (s.win5 == null ? '待补充' : s.win5 + '%') + low;
}

function status() {
  const j = readJson(F_STUDY);
  return {
    ok: true,
    generatedAt: j ? j.generatedAt : null,
    window: j ? j.window : null,
    eventCount: j ? j.eventCount : 0,
    observationCount: j ? j.observationCount : 0,
    rules: j ? j.rules.length : 0,
    file: F_STUDY
  };
}

module.exports = { refresh, study, forEvent, formatLine, formatDetail, status, expandEvents, proxiesFor, SECTOR_PROXY, MECHANISM, F_STUDY };
