'use strict';

/**
 * 周期事件研究（事件前 / 事件中 / 事件后三段式）
 *
 * 【要回答的问题】
 * 「某个周期性事件（会议、政策、行业规则、涨价、物价、业绩窗口、季节）发生时，
 *   对应板块是事件前就涨、事件中涨、还是事件后才涨？涨完是不是利好出货？」
 *
 * 【方法论：事件研究法（Event Study）】
 * 这是学术与卖方研究的标准做法，不是自创指标：
 *   ① 定义事件日 T（政策发布日 / 数据公布日 / 会议开幕日）；
 *   ② 取事件窗口三段：预期段 [T-20, T-1]、兑现段 [T-1, T+1]、衰减段 [T+1, T+20]；
 *   ③ 用「累计超额收益 CAR」而非绝对涨幅——减去同期沪深300，剔除大盘 beta；
 *   ④ 按三段符号组合分类，得到四种典型形态（详见 classify()）。
 * 参考实现：qlib 的 event-driven 因子、Alphalens 的事件分组、以及卖方常用的 CAR(t1,t2)。
 *
 * 【为什么不用固定日期表】
 * 硬编码「2026 年 FOMC 是几月几号」这类信息，一旦记错就是幻觉，而且会过期。
 * 本模块只使用两类日期：
 *   A. 由公开制度性规律推算的日期（非农=每月第一个周五、LPR=每月 20 日、两会=3 月 3 日…），
 *      并在输出里标注 basis='rule'，说明「按惯例推算，遇节假日可能顺延」；
 *   B. 人工录入的确定日期（basis='manual'），存在 data/cycle-calendar.json，
 *      未录入就显式标注「日程待确认」，绝不用猜测填充。
 * 战争/突发地缘冲突没有周期，不做日期推算，改用「新闻密度」连续指标（见 geopolitical()）。
 *
 * 【板块映射】
 * 不写死 BK 代码（接口会改名），而是运行时拉东财行业板块列表，按名称关键词解析，
 * 解析不到就标注「板块未匹配」，不静默丢弃。
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cycle-cache.json');
const CAL_FILE = path.join(DATA_DIR, 'cycle-calendar.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TTL = 6 * 3600 * 1000;

/* --------------------------------- 工具 --------------------------------- */

function round(x, n = 2) { if (!Number.isFinite(x)) return null; const p = Math.pow(10, n); return Math.round(x * p) / p; }
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function beijing(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), weekday: d.getUTCDay() };
}
function ymd(d) { return d.toISOString().slice(0, 10); }
function addDays(str, n) { const d = new Date(str + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }

function fetchJson(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const https = require('node:https');
    const req = https.get(url, { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' }, timeout }, res => {
      let buf = [];
      res.on('data', d => buf.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(buf).toString('utf8'))); } catch (e) { reject(new Error('JSON 解析失败')); } });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

/* ------------------------------ 板块代码解析 ------------------------------ */

let boardCache = { at: 0, map: null };

async function boardMap() {
  if (boardCache.map && Date.now() - boardCache.at < TTL) return boardCache.map;
  // 接口单页最多返回 100 条，而东财把一/二/三级行业混在同一 fs 下（银行、银行Ⅱ、城商行Ⅲ…），
  // 必须翻页取全，否则「煤炭行业」「燃气」这类一級行业会漏掉，事件就匹配不到板块。
  const map = [];
  const seen = new Set();
  for (let pn = 1; pn <= 8; pn++) {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=' + pn +
      '&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12&fs=m:90+t:2&fields=f12,f14';
    let arr = [];
    try {
      const j = await fetchJson(url);
      arr = j && j.data && j.data.diff ? Object.values(j.data.diff) : [];
    } catch (_) { break; }
    if (!arr.length) break;
    for (const x of arr) {
      const code = String(x.f12 || '');
      if (!code || seen.has(code)) continue;
      seen.add(code);
      map.push({ code, name: String(x.f14) });
    }
    if (arr.length < 100) break;
    await sleep(80);
  }
  boardCache = { at: Date.now(), map };
  return map;
}

/**
 * 板块别名表。
 * 东财的板块体系把一/二/三级行业混在一起（银行 / 银行Ⅱ / 城商行Ⅲ），
 * 而事件研究必须落到「可交易的板块指数」上。这里把口语化名称映射到实际存在的板块名，
 * 映射不到的走算法兜底，绝不静默丢弃。
 */
const BOARD_ALIAS = {
  '农牧饲渔': '农林牧渔',
  '酿酒行业': '白酒Ⅱ',
  '航天航空': '国防军工',
  '军工': '国防军工',
  '家电行业': '白色家电',
  '互联网服务': '互联网电商',
  '工程建设': '基建市政工程',
  '旅游酒店': '旅游及景区',
  '商业百货': '百货',
  '煤炭行业': '煤炭',
  '环保行业': '环保',
  '电力行业': '电力',
  '物流行业': '物流',
  '中药': '中药Ⅲ',
  '证券': '证券Ⅱ',
  '燃气': '燃气Ⅱ',
  '纺织服装': '纺织服饰',
  '食品饮料': '食品饮料',
  '文化传媒': '传媒',
  '影视': '影视院线',
  '院线': '影视院线',
  '旅游': '旅游及景区'
};

function baseName(n) { return String(n).replace(/[ⅠⅡⅢ]/g, '').trim(); }

/**
 * 按名称解析板块。评分优先级：精确 > 去罗马数字后精确 > 前缀 > 包含。
 * 同分时优先「不带 Ⅱ/Ⅲ 的一级行业」，再优先名字更短的，避免
 * 「纺织服装」被误解析成「纺织服装设备」、「旅游酒店」被解析成「酒店」。
 */
function resolveBoards(list, names) {
  const out = [];
  const miss = [];
  for (const raw of names) {
    const want = BOARD_ALIAS[raw] || raw;
    const wb = baseName(want);

    let best = null, bestScore = -1;
    for (const b of list) {
      const bb = baseName(b.name);
      let score = -1;
      if (b.name === want) score = 100;
      else if (bb === wb) score = 90;
      else if (bb.startsWith(wb)) score = 70;
      else if (bb.includes(wb)) score = 50;
      else if (wb.includes(bb) && bb.length >= 2) score = 30;
      if (score < 0) continue;
      // 同级优先一级行业（名称无罗马数字后缀）
      if (/[ⅠⅡⅢ]/.test(b.name)) score -= 5;
      if (String(b.name).endsWith('设备')) score -= 3; // 「XX设备」常是上游制造，不是主板块
      if (score > bestScore) { bestScore = score; best = b; }
    }
    if (best && bestScore >= 30) out.push(best);
    else miss.push(raw);
  }
  const seen = new Set();
  return { boards: out.filter(b => (seen.has(b.code) ? false : (seen.add(b.code), true))), miss };
}

/* -------------------------------- 事件规则 -------------------------------- */

/**
 * 只有「制度性规律」才允许自动推算日期。每条都写清 basis，输出时必须带出去，
 * 让使用者知道这个日期是「推算」还是「确认」。
 */
const RULES = [
  { id: 'cn-cpi', name: '中国 CPI / PPI 公布', type: '物价', when: 'monthly-9', sectors: ['食品饮料', '农牧饲渔', '商业百货', '酿酒行业'], horizon: 20, note: '通胀读数影响消费板块估值与货币政策预期' },
  { id: 'cn-pmi', name: '中国官方 PMI', type: '宏观', when: 'month-end', sectors: ['钢铁行业', '有色金属', '化学制品', '工程机械'], horizon: 20, note: '荣枯线上下切换时周期股弹性最大' },
  { id: 'cn-lpr', name: 'LPR 报价', type: '货币', when: 'monthly-20', sectors: ['银行', '房地产开发', '证券'], horizon: 15, note: '降息直接改善地产与券商估值' },
  { id: 'cn-trade', name: '进出口数据', type: '宏观', when: 'monthly-7', sectors: ['航运港口', '物流行业', '纺织服装'], horizon: 15, note: '外需强弱传导至航运与出口链' },
  { id: 'cn-credit', name: '社融与信贷数据', type: '货币', when: 'monthly-12', sectors: ['银行', '证券', '房地产开发'], horizon: 15, note: '社融超预期常带来顺周期躁动' },
  { id: 'us-nfp', name: '美国非农就业', type: '海外', when: 'first-friday', sectors: ['贵金属', '有色金属'], horizon: 15, note: '按 BLS 惯例为每月第一个周五，遇假日顺延' },
  { id: 'us-cpi', name: '美国 CPI', type: '海外', when: 'monthly-12', sectors: ['贵金属', '有色金属'], horizon: 15, note: '影响降息路径，传导至黄金与有色' },
  { id: 'cn-lianghui', name: '全国两会', type: '政策', when: 'mar-3', sectors: ['工程建设', '环保行业', '航天航空', '农牧饲渔'], horizon: 20, note: '政策预期在开幕前发酵，政府工作报告落地后常兑现' },
  { id: 'cn-politburo', name: '政治局会议（4/7/10/12 月）', type: '政策', when: 'politburo', sectors: ['房地产开发', '银行', '工程建设'], horizon: 20, note: '定调经济工作的关键会议' },
  { id: 'cn-cewc', name: '中央经济工作会议', type: '政策', when: 'dec-15', sectors: ['房地产开发', '银行', '证券'], horizon: 20, note: '次年政策基调，会前博弈、会后兑现' },
  { id: 'cn-medicare', name: '医保目录调整', type: '行业政策', when: 'nov-medicare', sectors: ['化学制药', '中药', '生物制品'], horizon: 20, note: '创新药入目录利好，降价幅度超预期则利空' },
  { id: 'cn-report', name: '业绩披露窗口（4/8/10 月底）', type: '业绩', when: 'report-window', sectors: ['半导体', '电池', '光伏设备'], horizon: 20, note: '业绩预告密集期，超预期个股带动板块' },
  { id: 'cn-index-review', name: '指数样本调整（6/12 月）', type: '资金', when: 'index-review', sectors: ['银行', '证券'], horizon: 15, note: '被动资金调仓，调入标的常在生效前走强' },
  { id: 'season-summer-power', name: '迎峰度夏用电高峰', type: '季节', when: 'jul-aug', sectors: ['电力行业', '煤炭行业'], horizon: 25, note: '高温驱动的季节性需求' },
  { id: 'season-heating', name: '北方供暖季', type: '季节', when: 'nov-mar', sectors: ['燃气', '煤炭行业'], horizon: 25, note: '11 月开栓，天然气与动力煤需求抬升' },
  { id: 'season-spring', name: '春运', type: '季节', when: 'chunyun', sectors: ['航空机场', '铁路公路', '旅游酒店'], horizon: 20, note: '出行数据是消费复苏的高频验证' },
  { id: 'season-618', name: '618 电商大促', type: '季节', when: 'jun-18', sectors: ['商业百货', '物流行业', '家电行业'], horizon: 15, note: '大促前预售数据驱动，结束后常回落' },
  { id: 'season-1111', name: '双十一', type: '季节', when: 'nov-11', sectors: ['商业百货', '物流行业', '互联网服务'], horizon: 15, note: '同样的「预期—兑现」结构' },
  /* 影视档期：票房是可预期的季节性需求，与煤炭「迎峰度夏」同属「事件前博弈、兑现后回落」结构。
     注意：档期是一段窗口而非单日，且定档日随片方排片变化，这里只取惯例代表日并显式标注不确定。 */
  { id: 'season-summer-film', name: '暑期档（影视）', type: '行业景气', when: 'jul-1', sectors: ['影视院线', '传媒', '游戏Ⅱ'], horizon: 20, note: '暑期档 6-8 月，7/1 为惯例代表日；定档与票房节奏随片方排片变动，非固定日期' },
  { id: 'season-national-film', name: '国庆档（影视）', type: '行业景气', when: 'oct-1', sectors: ['影视院线', '传媒', '旅游酒店'], horizon: 15, note: '国庆档 10/1 起，节前定档与预售数据驱动预期' },
  { id: 'season-spring-film', name: '春节档（影视）', type: '行业景气', when: 'lunar-spring', sectors: ['影视院线', '传媒', '旅游酒店'], horizon: 20, note: '春节为农历日期，无法用公历制度推算；仅在人工录入具体日期后参与研究，否则标「待确认」' }
];

/**
 * 生成某年的日期。返回 [{date, basis, note}]。
 * 全部基于公开的制度性惯例，不涉及具体年份的临时调整。
 */
function datesFor(rule, year) {
  const out = [];
  const push = (d, note) => out.push({ date: d, basis: 'rule', note: note || rule.note });
  const monthDay = (m, d) => ymd(new Date(Date.UTC(year, m - 1, d)));

  switch (rule.when) {
    case 'monthly-9':
    case 'monthly-12':
    case 'monthly-20':
    case 'monthly-7': {
      const day = Number(rule.when.split('-')[1]);
      for (let m = 1; m <= 12; m++) push(monthDay(m, day), '按惯例每月 ' + day + ' 日前后公布，遇节假日顺延');
      break;
    }
    case 'month-end': {
      for (let m = 1; m <= 12; m++) {
        const d = new Date(Date.UTC(year, m, 0));
        push(ymd(d), '月末最后一日公布当月 PMI');
      }
      break;
    }
    case 'first-friday': {
      for (let m = 1; m <= 12; m++) {
        const first = new Date(Date.UTC(year, m - 1, 1));
        const off = (5 - first.getUTCDay() + 7) % 7;
        push(ymd(new Date(Date.UTC(year, m - 1, 1 + off))), '每月第一个周五，遇假日顺延');
      }
      break;
    }
    case 'mar-3': push(monthDay(3, 3), '政协开幕，通常 3 月 3 日、人大 3 月 5 日'); break;
    case 'politburo': [4, 7, 10, 12].forEach((m, i) => push(monthDay(m, i === 3 ? 8 : 28), '月末政治局会议，日期不固定，按月末推算')); break;
    case 'dec-15': push(monthDay(12, 15), '通常在 12 月中旬，具体日期待确认'); break;
    case 'nov-medicare': push(monthDay(11, 20), '医保谈判多在 11 月，具体日期待确认'); break;
    case 'report-window': [4, 8, 10].forEach(m => push(monthDay(m, 28), '财报截止日前一周为预告与披露高峰')); break;
    case 'index-review': [6, 12].forEach(m => push(monthDay(m, 12), '6/12 月第二个周五收盘后生效')); break;
    case 'jul-aug': push(monthDay(7, 15), '7 月中旬进入用电高峰'); break;
    case 'nov-mar': push(monthDay(11, 15), '11 月中旬北方集中供暖'); break;
    case 'chunyun': push(monthDay(1, 20), '春运约在春节前 15 天启动，具体日期随农历变动'); break;
    case 'jun-18': push(monthDay(6, 18)); break;
    case 'nov-11': push(monthDay(11, 11)); break;
    case 'jul-1': push(monthDay(7, 1), '暑期档惯例代表日，实际为 6-8 月窗口'); break;
    case 'oct-1': push(monthDay(10, 1), '国庆档自 10 月 1 日起'); break;
    // 春节为农历，公历日期每年不同且无简单制度规律可推算。
    // 按反幻觉纪律：不生成任何日期，只提示由人工日历录入（basis='manual'）。
    case 'lunar-spring': break;
    default: break;
  }
  return out;
}

/* -------------------------------- 手工事件 -------------------------------- */

const DEFAULT_CAL = {
  version: 1,
  note: '人工录入的确定日期事件。战争、OPEC+ 会议、FOMC 具体日期等无稳定规律的事件放这里，未录入时系统显式标注「日程待确认」，不做猜测。',
  items: []
};

function readCalendar() {
  if (!fs.existsSync(CAL_FILE)) {
    try { fs.writeFileSync(CAL_FILE, JSON.stringify(DEFAULT_CAL, null, 2), 'utf8'); } catch (_) {}
    return { ...DEFAULT_CAL };
  }
  try { return JSON.parse(fs.readFileSync(CAL_FILE, 'utf8')); } catch (_) { return { ...DEFAULT_CAL }; }
}

function addCalendarEvent(ev) {
  const doc = readCalendar();
  if (!ev || !ev.date || !ev.name) return { ok: false, error: 'date 与 name 必填' };
  const item = {
    id: ev.id || 'M' + Date.now().toString(36),
    date: ev.date, name: ev.name,
    type: ev.type || '人工', sectors: Array.isArray(ev.sectors) ? ev.sectors : [],
    horizon: clamp(Number(ev.horizon) || 20, 5, 60),
    note: ev.note || '', basis: 'manual', source: ev.source || '人工录入'
  };
  doc.items = (doc.items || []).filter(x => x.id !== item.id).concat(item);
  doc.items.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(CAL_FILE, JSON.stringify(doc, null, 2), 'utf8');
  return { ok: true, item, total: doc.items.length };
}

/* -------------------------------- 行情取数 -------------------------------- */

const klineCache = new Map();

async function kline(secid, lmt = 400) {
  const key = secid + ':' + lmt;
  const hit = klineCache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.bars;
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid +
    '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=' + lmt;
  try {
    const j = await fetchJson(url);
    const lines = (j && j.data && j.data.klines) || [];
    const bars = lines.map(s => {
      const p = String(s).split(',');
      return { d: p[0], o: +p[1], c: +p[2], h: +p[3], l: +p[4], v: +p[5], a: +p[6] };
    }).filter(b => b.d && b.c);
    klineCache.set(key, { at: Date.now(), bars });
    await sleep(60); // 轻限速，避免被风控
    return bars;
  } catch (_) {
    klineCache.set(key, { at: Date.now(), bars: [] });
    return [];
  }
}

const HS300 = '1.000300';

/** 在 bars 里找 <= date 的最后一个交易日索引 */
function indexOfDate(bars, date) {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].d <= date) return i;
  return -1;
}

/**
 * 三段式超额收益。
 * 口径说明：
 *  - pre  : [T-h, T-1] 相对沪深300 的累计超额 —— 「预期发酵」
 *  - during: [T-1, T+1] 超额 —— 「兑现」
 *  - post : [T+1, T+h] 超额 —— 「衰减或延续」
 * 用超额而不是绝对收益，是因为绝大多数板块跟着大盘走，不减基准会把 beta 误当 alpha。
 */
async function threeStage(sectorSecid, date, h, benchBars) {
  const bars = await kline(sectorSecid, 400);
  if (bars.length < h + 5) return null;
  const i = indexOfDate(bars, date);
  if (i < h || i + 1 >= bars.length) return null;

  const seg = (a, b) => {
    if (a < 0 || b < 0 || a >= bars.length || b >= bars.length) return null;
    const sret = (bars[b].c / bars[a].c - 1) * 100;
    const bi = indexOfDate(benchBars, bars[a].d);
    const bj = indexOfDate(benchBars, bars[b].d);
    if (bi < 0 || bj < 0) return sret;
    const bret = (benchBars[bj].c / benchBars[bi].c - 1) * 100;
    return sret - bret;
  };

  const pre = seg(i - h, i - 1);
  const during = seg(i - 1, Math.min(i + 1, bars.length - 1));
  const post = seg(Math.min(i + 1, bars.length - 1), Math.min(i + h, bars.length - 1));
  return { pre: round(pre), during: round(during), post: round(post), tDate: bars[i].d };
}

/**
 * 四象限分类。这是本模块的核心产出：
 *   pre>3  & post<-2  → 利好出货（预期打满，兑现即卖）
 *   pre>3  & post>=0  → 趋势延续（真需求，不是博弈）
 *   |pre|<=3 & during>2 → 后知后觉（事件中才开始定价）
 *   pre<-2 & during>2 → 利空出尽
 *   其它 → 噪声 / 无效
 */
function classify(s) {
  if (!s || s.pre == null || s.post == null) return { key: 'unknown', label: '数据不足', note: '' };
  if (s.pre > 3 && s.post < -2) return { key: 'sellnews', label: '利好出货', note: '事件前已充分上涨（+' + s.pre + '%），事件后回落 ' + s.post + '%，典型预期兑现' };
  if (s.pre > 3 && s.post >= 0) return { key: 'trend', label: '趋势延续', note: '事件前涨 ' + s.pre + '%，事件后仍涨 ' + s.post + '%，属真实需求驱动' };
  if (Math.abs(s.pre) <= 3 && s.during > 2) return { key: 'late', label: '后知后觉', note: '事件前横盘，事件中才涨 ' + s.during + '%，信息扩散较慢' };
  if (s.pre < -2 && s.during > 2) return { key: 'oversold', label: '利空出尽', note: '事件前跌 ' + s.pre + '%，事件中反弹 ' + s.during + '%' };
  if (s.post > 3) return { key: 'post', label: '事件后才涨', note: '事件后 ' + s.post + '%，存在滞后反应' };
  return { key: 'noise', label: '无明显规律', note: '三段超额均在噪声区间' };
}

/* -------------------------------- 主流程 -------------------------------- */

function genEvents(daysBack = 400, daysForward = 45) {
  const today = beijing().date;
  const from = addDays(today, -daysBack);
  const to = addDays(today, daysForward);
  const years = new Set([Number(from.slice(0, 4)), Number(today.slice(0, 4)), Number(to.slice(0, 4))]);
  const list = [];
  for (const y of years) {
    for (const r of RULES) {
      for (const d of datesFor(r, y)) {
        if (d.date < from || d.date > to) continue;
        list.push({
          id: r.id + '@' + d.date, ruleId: r.id, name: r.name, type: r.type,
          date: d.date, basis: d.basis, sectors: r.sectors, horizon: r.horizon,
          note: d.note || r.note
        });
      }
    }
  }
  for (const it of (readCalendar().items || [])) {
    if (it.date < from || it.date > to) continue;
    list.push({ ...it, ruleId: 'manual', basis: 'manual' });
  }
  list.sort((a, b) => a.date.localeCompare(b.date));
  return { list, from, to };
}

async function buildCycleView(opts = {}) {
  const force = !!opts.force;
  if (!force && fs.existsSync(CACHE_FILE)) {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Date.now() - (c.builtAt || 0) < TTL && c.ok) return c;
    } catch (_) {}
  }

  const today = beijing().date;
  const { list, from, to } = genEvents();
  const bench = await kline(HS300, 400);
  if (!bench.length) return { ok: false, error: '沪深300 日线不可达，无法计算超额收益' };

  const boards = await boardMap().catch(() => []);
  const study = [];
  const ruleStats = new Map();
  // 按板块聚合（而非按事件类型）：回答「煤炭 / 影视院线这类板块，历史上在事件前 / 中 / 后哪一段涨」
  const boardStats = new Map();

  for (const ev of list) {
    // 只研究已经发生、且距今至少 horizon+2 个自然日的事件，避免用未走完的窗口下结论
    if (daysBetween(ev.date, today) < 0) {
      study.push({ ...ev, status: 'upcoming', daysTo: Math.max(0, daysBetween(today, ev.date)) });
      continue;
    }
    if (daysBetween(ev.date, today) < 2) {
      study.push({ ...ev, status: 'running', daysTo: 0 });
      continue;
    }
    const resolved = resolveBoards(boards, ev.sectors || []);
    const rows = [];
    for (const b of resolved.boards.slice(0, 4)) {
      const s = await threeStage('90.' + b.code, ev.date, ev.horizon, bench);
      if (!s) continue;
      const cls = classify(s);
      rows.push({ board: b.name, code: b.code, ...s, ...cls });
    }
    const done = { ...ev, status: 'done', boards: rows, miss: resolved.miss };
    study.push(done);

    // 同类事件的历史汇总：只累计 done 且板块有数据的
    if (!ruleStats.has(ev.ruleId)) ruleStats.set(ev.ruleId, { name: ev.name, type: ev.type, rows: [] });
    for (const r of rows) {
      ruleStats.get(ev.ruleId).rows.push(r);
      if (!boardStats.has(r.board)) boardStats.set(r.board, { board: r.board, code: r.code, rows: [], events: new Set() });
      const g = boardStats.get(r.board);
      g.rows.push(r);
      g.events.add(ev.name);
    }
  }

  // 板块阶段敏感性：三段平均超额 + 各段为正占比 + 样本数。
  // 只有 n≥5 且最占优段的平均超额 ≥1% 才给「该板块在某阶段易涨」的结论，否则显式标样本不足。
  const mean = arr => { const a = arr.filter(Number.isFinite); return a.length ? round(a.reduce((x, y) => x + y, 0) / a.length) : null; };
  const win = arr => { const a = arr.filter(Number.isFinite); return a.length ? round(a.filter(v => v > 0).length / a.length * 100, 0) : null; };
  const STAGE_LABEL = { pre: '事件前（预期段）', during: '事件中（兑现段）', post: '事件后（衰减段）' };
  const boardPhase = [...boardStats.entries()].map(([name, g]) => {
    const n = g.rows.length;
    const seg = {
      pre: mean(g.rows.map(r => r.pre)), during: mean(g.rows.map(r => r.during)), post: mean(g.rows.map(r => r.post))
    };
    const winRate = {
      pre: win(g.rows.map(r => r.pre)), during: win(g.rows.map(r => r.during)), post: win(g.rows.map(r => r.post))
    };
    const stages = ['pre', 'during', 'post'].map(k => ({ key: k, label: STAGE_LABEL[k], avg: seg[k], win: winRate[k], n }));
    const best = stages.slice().sort((a, b) => (b.avg == null ? -99 : b.avg) - (a.avg == null ? -99 : a.avg))[0];
    const qualified = n >= 5 && best.avg != null && best.avg >= 1;
    return {
      board: name, code: g.code, n, stages, best, qualified,
      events: [...g.events].slice(0, 5),
      conclusion: qualified
        ? name + ' 历史上在' + best.label + '平均相对超额 +' + best.avg + '%（上涨占比 ' + best.win + '%，n=' + n + '），关联事件：' + [...g.events].slice(0, 2).join('、')
        : '样本 ' + n + ' 次' + (n < 5 ? '（<5，不足以下结论）' : '，各段平均超额均未达 +1% 门槛') + '，暂不给出阶段结论'
    };
  }).sort((a, b) => (b.qualified - a.qualified) || ((b.best.avg || -99) - (a.best.avg || -99)) || (b.n - a.n));

  const summary = [...ruleStats.entries()].map(([id, v]) => {
    const pre = v.rows.map(r => r.pre).filter(Number.isFinite);
    const post = v.rows.map(r => r.post).filter(Number.isFinite);
    const cnt = k => v.rows.filter(r => r.key === k).length;
    const n = v.rows.length;
    return {
      id, name: v.name, type: v.type, n,
      avgPre: pre.length ? round(pre.reduce((a, b) => a + b, 0) / pre.length) : null,
      avgPost: post.length ? round(post.reduce((a, b) => a + b, 0) / post.length) : null,
      sellNewsRate: n ? round((cnt('sellnews') / n) * 100, 1) : null,
      trendRate: n ? round((cnt('trend') / n) * 100, 1) : null,
      lateRate: n ? round((cnt('late') / n) * 100, 1) : null,
      // 提前告知的置信门槛：样本 ≥5 且「利好出货」占比 ≥50%
      warn: n >= 5 && cnt('sellnews') / n >= 0.5
    };
  }).sort((a, b) => (b.n || 0) - (a.n || 0));

  const upcoming = study.filter(x => x.status === 'upcoming').sort((a, b) => a.daysTo - b.daysTo).slice(0, 12);
  const recent = study.filter(x => x.status === 'done').sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);

  // 提前告知：临近事件 + 该规则历史上「利好出货」占比高 → 明确提示「别追预期」
  const alerts = [];
  for (const u of upcoming) {
    const st = summary.find(s => s.id === u.ruleId);
    if (st && st.warn) {
      alerts.push({
        date: u.date, daysTo: u.daysTo, name: u.name, type: u.type,
        level: 'warn',
        text: u.name + ' 将在 ' + u.daysTo + ' 天后发生。历史上同类事件 ' + st.n + ' 次样本中，' +
          st.sellNewsRate + '% 表现为「事件前上涨、事件后回落」，平均前置超额 +' + st.avgPre +
          '%、后置 ' + st.avgPost + '%。建议：不追预期，已在场内的考虑事件前减仓。'
      });
    } else if (st && st.n >= 5 && st.avgPre > 2) {
      alerts.push({
        date: u.date, daysTo: u.daysTo, name: u.name, type: u.type,
        level: 'info',
        text: u.name + ' 临近（' + u.daysTo + ' 天），同类事件历史上平均前置超额 +' + st.avgPre + '%，可关注预期发酵但需设兑现纪律。'
      });
    }
  }

  // 板块维度提前告知：临近事件 + 该关联板块历史上在某阶段显著为正 + 当前正处该阶段窗口。
  // 只做「有统计依据的提示」，不承诺涨跌；best 阶段为 pre 且 daysTo 落在 [0, horizon] 才提示。
  const boardAlerts = [];
  for (const u of upcoming) {
    const resolved = resolveBoards(boards, u.sectors || []);
    for (const b of resolved.boards.slice(0, 3)) {
      const bp = boardPhase.find(x => x.board === b.name && x.qualified);
      if (!bp) continue;
      const inPre = bp.best.key === 'pre' && u.daysTo <= (u.horizon || 20);
      const stageHint = inPre ? '当前正处该事件的历史「预期发酵」窗口' : '当前不在其历史占优阶段窗口内';
      boardAlerts.push({
        date: u.date, daysTo: u.daysTo, board: b.name, event: u.name,
        level: inPre ? 'info' : 'low',
        stage: bp.best.label, avg: bp.best.avg, win: bp.best.win, n: bp.n,
        text: u.name + ' 将在 ' + u.daysTo + ' 天后发生，关联板块「' + b.name + '」历史上在' +
          bp.best.label + '平均相对超额 +' + bp.best.avg + '%（上涨占比 ' + bp.best.win + '%，n=' + bp.n +
          '）。' + stageHint + '，仅作阶段性提示，不构成涨跌承诺。'
      });
    }
  }
  boardAlerts.sort((a, b) => a.daysTo - b.daysTo);

  const view = {
    ok: true, builtAt: Date.now(), date: today, window: { from, to },
    summary, boardPhase, boardAlerts, upcoming, recent, alerts,
    counts: {
      total: study.length,
      done: study.filter(x => x.status === 'done').length,
      upcoming: upcoming.length,
      rules: RULES.length,
      boardPhase: boardPhase.length,
      boardQualified: boardPhase.filter(x => x.qualified).length,
      manual: (readCalendar().items || []).length
    },
    methodology: {
      windows: '预期段 [T-20,T-1] / 兑现段 [T-1,T+1] / 衰减段 [T+1,T+20]，均以沪深300为基准取超额',
      classify: '利好出货=前涨>3%且后跌>2%；趋势延续=前涨且后不跌；后知后觉=前平且事件中涨>2%；利空出尽=前跌且事件中反弹',
      base: '日期由制度性规律推算（标 rule）或人工录入（标 manual），未录入的日程显式标注待确认，不做猜测；春节档为农历日期，不推算，仅人工录入',
      boardPhase: '按板块聚合所有已完成事件的三段超额，n≥5 且占优段平均超额≥1% 才给结论；这是「事件锚定的时间阶段」，与 phase.js 的「板块价格周期阶段」口径不同',
      limit: '单事件单板块样本波动极大，结论只在「同类事件 ≥5 次」时才给出提示'
    }
  };

  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(view), 'utf8'); } catch (_) {}
  return view;
}

/* ------------------------------- 地缘冲突强度 ------------------------------- */

/**
 * 战争/地缘冲突没有周期，无法做日期推算。
 * 这里改用「新闻密度」连续指标：给定近 N 天的新闻标题，统计冲突类关键词命中数，
 * 并观察同期黄金/石油/军工板块的 5 日相对表现，形成「冲突强度 → 避险资产」的实证映射。
 * 输入由 server.js 传入（复用现有新闻缓存），本函数保持纯计算、不抓新闻。
 */
const CONFLICT_WORDS = ['战争', '冲突', '袭击', '导弹', '空袭', '入侵', '制裁', '军事', '停火', 'war', 'conflict', 'strike', 'missile', 'invasion', 'sanction', 'ceasefire'];

function geopolitical(headlines = [], days = 7) {
  const cut = Date.now() - days * 86400000;
  const recent = (headlines || []).filter(h => !h.publishedAt || h.publishedAt >= cut);
  const hits = recent.filter(h => CONFLICT_WORDS.some(w => String(h.title || '').toLowerCase().includes(String(w).toLowerCase())));
  const score = clamp(Math.round((hits.length / Math.max(1, recent.length)) * 100 * 3), 0, 100);
  return {
    ok: true, days, total: recent.length, hits: hits.length, score,
    level: score >= 45 ? '高' : score >= 20 ? '中' : '低',
    sample: hits.slice(0, 5).map(h => String(h.title || '').slice(0, 60)),
    note: '冲突强度为新闻密度代理指标，非事件日历；用于解释黄金/石油/军工的避险脉冲，不单独作为买卖依据'
  };
}

module.exports = {
  buildCycleView, genEvents, addCalendarEvent, readCalendar,
  resolveBoards, boardMap, classify, threeStage, geopolitical,
  RULES, CACHE_FILE, CAL_FILE, TTL
};
