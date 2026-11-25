'use strict';

/**
 * 行情故障转移适配器（零依赖，2026-11-20）
 *
 * 背景：LetsVPN 等代理以 TUN 模式接管全部流量时，东财行情 CDN（push2 / push2his）
 *       会拒绝海外出口 IP（TLS 层直接复位），而同一时刻腾讯行情（qt.gtimg.cn）、
 *       腾讯日线（web.ifzq.gtimg.cn）、新浪行情中心（vip.stock.finance.sina.com.cn）
 *       均正常。本模块让主链路「东财口径」在东财不可达时自动切到备用源，
 *       并把数据映射回东财字段形状，上游模块（stocks.js 等）无感知。
 *
 * 策略：主源东财（口径与排序规则不变）→ 失败/空数据时切备用源。
 *       连续失败 2 次后熔断 5 分钟（期间直接走备用源，不再等东财超时），到期自动重试东财。
 *
 * 备用源口径差异（已在映射处降级，不编造数据）：
 *   - f62 / f184 主力净流入：腾讯/新浪免费接口均无对应字段 → 置 null，上游资金因子按缺失降级；
 *   - f10 量比、f100 行业：同上置 null；
 *   - 腾讯日 K 无成交额字段 → 用「四价均值 × 成交量」估算（下游为对数尺度评分，误差可容忍），
 *     并在行对象上标注 _src，便于界面与日志说明来源。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const EM_ULIST = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
const EM_CLIST = 'https://push2.eastmoney.com/api/qt/clist/get';
const EM_KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const EM_HEADERS = { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' };

/* ------------------------------ 熔断器与计数 ------------------------------ */

const CB_MS = 5 * 60 * 1000;          // 东财连续失败后的熔断时长
const cb = Object.create(null);       // key → { streak, openUntil }
const stat = {
  emUList: 0, txUList: 0,             // 东财/腾讯 批量行情成功次数
  emCList: 0, sinaCList: 0,           // 东财/新浪 榜单成功次数
  emKline: 0, txKline: 0,             // 东财/腾讯 日K成功次数
  firstFallbackAt: null, lastError: '', lastFallbackKind: ''
};

function cbBroken(key) {
  const s = cb[key];
  return !!s && s.streak >= 2 && Date.now() < s.openUntil;
}
function cbFail(key) {
  const s = cb[key] || (cb[key] = { streak: 0, openUntil: 0 });
  s.streak++;
  if (s.streak >= 2) s.openUntil = Date.now() + CB_MS;
}
function cbOk(key) { if (cb[key]) cb[key].streak = 0; }

function noteFallback(kind, err) {
  if (!stat.firstFallbackAt) stat.firstFallbackAt = Date.now();
  stat.lastFallbackKind = kind;
  stat.lastError = String(err && err.message || err || '').slice(0, 200);
}

/* ------------------------------ 基础网络工具 ------------------------------ */

async function fetchJsonRaw(url, timeoutMs = 9000, headers = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

/** 腾讯行情接口返回 GBK 文本：Node ≥ 12 全 ICU 支持 gbk 解码 */
let gbkDecoder = null;
async function fetchTextGbk(url, timeoutMs = 9000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!gbkDecoder) gbkDecoder = new TextDecoder('gbk');
    return gbkDecoder.decode(buf);
  } finally { clearTimeout(t); }
}

/** 东财 secid（1.600519 / 0.000766）→ 腾讯代码（sh600519 / sz000766） */
function txCode(secid) {
  const m = /^([01])\.(\d{6})$/.exec(String(secid || ''));
  if (!m) throw new Error('非 A 股 secid 不支持备用源: ' + secid);
  return (m[1] === '1' ? 'sh' : 'sz') + m[2];
}

const num = v => { const x = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(x) ? x : null; };

/* ------------------------------ 1) 批量行情 ulist ------------------------------ */

/** 腾讯单行 → 东财 ulist 行形状（字段口径见文件头注释） */
function mapTxRow(f, code) {
  return {
    f12: code, f14: f[1] || '',
    f2: num(f[3]), f18: num(f[4]), f4: num(f[31]), f3: num(f[32]),
    f15: num(f[33]), f16: num(f[34]),
    f5: num(f[6]), f6: num(f[37]) == null ? null : num(f[37]) * 1e4,   // 万 → 元
    f8: num(f[38]), f9: num(f[39]), f23: num(f[46]),
    f20: num(f[45]) == null ? null : num(f[45]) * 1e8,                 // 亿 → 元（总市值）
    f21: num(f[44]) == null ? null : num(f[44]) * 1e8,                 // 亿 → 元（流通市值）
    f10: null, f62: null, f184: null, f100: null,
    _src: 'tx'
  };
}

/**
 * 东财 ulist.np 兼容接口：secids 形如 "1.600519,0.000766"。
 * 返回 { data: { diff: [...] } }（东财原始形状或备用源映射形状）。
 */
async function fetchUList(secidsStr, fields) {
  const key = 'ulist';
  if (!cbBroken(key)) {
    try {
      const j = await fetchJsonRaw(EM_ULIST + '?secids=' + secidsStr + '&fields=' + fields +
        '&fltt=2&invt=2&_=' + Date.now(), 9000, EM_HEADERS);
      if (j && j.data && Array.isArray(j.data.diff) && j.data.diff.length) {
        cbOk(key); stat.emUList++;
        return j;
      }
      throw new Error('东财 ulist 空数据');
    } catch (e) { cbFail(key); noteFallback('ulist→tx', e); }
  }

  const codes = String(secidsStr).split(',').filter(Boolean).map(txCode);
  const out = [];
  for (let i = 0; i < codes.length; i += 60) {
    const batch = codes.slice(i, i + 60);
    const text = await fetchTextGbk('https://qt.gtimg.cn/q=' + batch.join(','));
    for (const line of text.split('\n')) {
      const m = /^v_([a-z]{2}\d{6})="([^"]*)"/.exec(line.trim());
      if (!m) continue;
      const f = m[2].split('~');
      if (f.length < 47) continue;
      out.push(mapTxRow(f, m[1].slice(2)));
    }
  }
  stat.txUList++;
  return { data: { diff: out }, _source: 'tencent' };
}

/* ------------------------------ 2) 榜单 clist ------------------------------ */

/** 东财排序字段 → 新浪行情中心排序字段（f62 主力净流入无替代源） */
const SINA_SORT = { f3: 'changepercent', f6: 'amount' };

function mapSinaRow(r) {
  return {
    f12: String(r.code || (r.symbol || '').slice(2)), f14: r.name || '',
    f2: num(r.trade), f3: num(r.changepercent), f4: num(r.pricechange),
    f15: num(r.high), f16: num(r.low), f18: num(r.settlement),
    f5: num(r.volume) == null ? null : num(r.volume) / 100,            // 股 → 手
    f6: num(r.amount),
    f8: num(r.turnoverratio), f9: num(r.per), f23: num(r.pb),
    f20: num(r.mktcap) == null ? null : num(r.mktcap) * 1e4,           // 万元 → 元（总市值）
    f21: num(r.nmc) == null ? null : num(r.nmc) * 1e4,                 // 万元 → 元（流通市值）
    f10: null, f62: null, f184: null, f100: null,
    _src: 'sina'
  };
}

/**
 * 东财 clist 排行榜兼容接口（涨幅榜 f3 / 成交额榜 f6）。
 * 备用源为新浪行情中心排行页（node=hs_a，含北交所与 ST，由上游 eligible() 过滤）。
 * f62 主力净流入榜无免费替代源：东财不可用时返回空榜单（上游记 got:0，不编造）。
 */
async function fetchCListRank(fid, perRank) {
  const key = 'clist';
  if (!cbBroken(key)) {
    try {
      const j = await fetchJsonRaw(EM_CLIST + '?pn=1&pz=' + perRank + '&po=1&np=1&fltt=2&invt=2&fid=' + fid +
        '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f12,f14,f2,f3,f4,f5,f6,f8,f9,f10,f15,f16,f18,f20,f21,f23,f62,f100,f184&_=' + Date.now(),
        9000, EM_HEADERS);
      if (j && j.data && Array.isArray(j.data.diff) && j.data.diff.length) {
        cbOk(key); stat.emCList++;
        return j;
      }
      throw new Error('东财 clist 空数据');
    } catch (e) { cbFail(key); noteFallback('clist→sina', e); }
  }

  const sort = SINA_SORT[fid];
  if (!sort) { stat.sinaCList++; return { data: { diff: [] }, _source: 'none' }; }
  const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData' +
    '?page=1&num=' + Math.max(1, Math.min(100, perRank)) + '&sort=' + sort + '&asc=0&node=hs_a&symbol=&_s_r_a=page';
  const arr = await fetchJsonRaw(url, 9000, { Referer: 'https://finance.sina.com.cn' });
  const diff = Array.isArray(arr) ? arr.map(mapSinaRow) : [];
  stat.sinaCList++;
  return { data: { diff }, _source: 'sina' };
}

/* ------------------------------ 3) 日线 kline ------------------------------ */

/**
 * 东财 push2his 日 K 兼容接口（前复权，klt=101）。
 * 备用源为腾讯 fqkline（同为前复权、量纲一致）；腾讯无成交额字段，用四价均值估算，
 * 其余 4 个字段（振幅/涨跌幅/涨跌额/换手）上游解析不使用，填 0 占位。
 */
async function fetchKline(secid, lmt) {
  const key = 'kline';
  if (!cbBroken(key)) {
    try {
      const j = await fetchJsonRaw(EM_KLINE + '?secid=' + secid +
        '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
        '&klt=101&fqt=1&end=20500101&lmt=' + lmt + '&_=' + Date.now(), 9000, EM_HEADERS);
      if (j && j.data && Array.isArray(j.data.klines) && j.data.klines.length) {
        cbOk(key); stat.emKline++;
        return j;
      }
      throw new Error('东财 kline 空数据');
    } catch (e) { cbFail(key); noteFallback('kline→tx', e); }
  }

  const c = txCode(secid);
  const j = await fetchJsonRaw('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + c + ',day,,,' + lmt + ',qfq');
  const node = j && j.data && (j.data[c] || {});
  const days = node.qfqday || node.day || [];
  const klines = [];
  for (const d of days) {
    if (!Array.isArray(d) || d.length < 6) continue;
    const [date, open, close, high, low, vol] = d;
    const amt = Math.round(((+open + +close + +high + +low) / 4) * (+vol) * 100);
    klines.push([date, open, close, high, low, vol, amt, 0, 0, 0, 0].join(','));
  }
  stat.txKline++;
  return { data: { name: node.name || '', code: c, klines }, _source: 'tencent' };
}

/* ------------------------------ 4) 代码识别（按 6 位代码查名称/现价） ------------------------------ */

/** 6 位代码 → 腾讯前缀：沪深主板/创业/科创/北交所。规则：6→sh，0/3→sz，4/8→bj */
function txPrefixOf(code) {
  const c = String(code || '');
  if (!/^\d{6}$/.test(c)) return null;
  if (/^6/.test(c)) return 'sh';
  if (/^(0|3)/.test(c)) return 'sz';
  if (/^(4|8)/.test(c)) return 'bj';
  return null;
}

/**
 * 输入任意 6 位 A 股代码，返回 { ok, code, name, price, changePct, market }。
 * 用腾讯行情（qt.gtimg.cn），VPN 下可达；名称来自行情源实时返回，不猜、不编造。
 * 查不到（退市/无效代码）返回 ok:false + reason，绝不返回空壳名称。
 */
async function lookupCode(code) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return { ok: false, reason: '请输入 6 位数字股票代码' };
  const prefix = txPrefixOf(c);
  if (!prefix) return { ok: false, reason: c.slice(0, 1) + ' 开头为 B 股，规则不同，暂不支持识别' };
  try {
    const text = await fetchTextGbk('https://qt.gtimg.cn/q=' + prefix + c, 8000);
    const m = new RegExp('^v_' + prefix + c + '="([^"]*)"', 'm').exec(text);
    if (!m) return { ok: false, reason: '行情源未找到该代码（可能已退市或代码有误）' };
    const f = m[1].split('~');
    const name = String(f[1] || '').trim();
    if (!name) return { ok: false, reason: '行情源返回空名称' };
    return {
      ok: true, code: c, name,
      price: num(f[3]), changePct: num(f[32]),
      market: prefix === 'sh' ? '沪市' : prefix === 'sz' ? '深市' : '北交所',
      source: '腾讯行情（实时）'
    };
  } catch (e) {
    return { ok: false, reason: '行情查询失败：' + (e && e.message || e) };
  }
}

/* ------------------------------ 状态 ------------------------------ */

function status() {
  const breaker = {};
  for (const [k, s] of Object.entries(cb)) {
    breaker[k] = { streak: s.streak, open: Date.now() < s.openUntil, retryInMs: Math.max(0, s.openUntil - Date.now()) };
  }
  return {
    fallback: stat,
    breaker,
    note: '主源东财，东财不可达（如 VPN TUN 接管导致海外出口被 CDN 拒绝）时自动切腾讯/新浪；备用源缺主力净流入（f62）与量比（f10），相关因子按缺失降级。'
  };
}

function resetBreaker() { for (const k of Object.keys(cb)) delete cb[k]; return status(); }

module.exports = { fetchUList, fetchCListRank, fetchKline, lookupCode, status, resetBreaker };
