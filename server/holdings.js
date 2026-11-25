'use strict';

/**
 * 持仓监控（server/holdings.js）
 *
 * 【它解决什么问题】
 * 观察池回答「今天该盯谁」，本模块回答「我手里的票现在怎么样、该不该动」。
 * 用户在界面上录入持仓（代码 / 成本 / 股数），系统实时计算盈亏，
 * 并把持仓与观察池评分、涨停结构、ATR 止损参考联动，给出**确定性建议**。
 *
 * 【反幻觉边界——与全项目一致】
 * 建议全部由规则引擎生成（七条规则，见 adviceOf()），每条建议都标注触发条件；
 * 不预测涨跌、不编造理由。持仓若不在观察池中，系统明确说「无评分意见」，
 * 而不是硬给一个分数。LLM 研究助手（升级方案见《升级方案梳理》）只做
 * 基本面摘要供人参考，永不直接进入本模块的建议链路。
 *
 * 【存储】data/holdings.json —— 持仓由用户录入，属个人数据，
 * 与告警配置同级的持久化文件；删除即从文件移除（不进 JSONL，因为是「状态」不是「事件」）。
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'holdings.json');

const EM_ULIST = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
const UA = 'Mozilla/5.0 (Windows NT 10.0; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const REFRESH_MS = 30 * 1000;        // 行情刷新间隔（交易时段）
const ATR_TTL = 30 * 60 * 1000;      // ATR 止损参考缓存（日线级数据无需频繁重算）

/* ---------------------------------- 工具 ---------------------------------- */

function round(x, n = 2) {
  if (!Number.isFinite(x)) return null;
  const p = Math.pow(10, n);
  return Math.round(x * p) / p;
}

function fetchJson(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' }, timeout }, res => {
      if (res.statusCode && res.statusCode >= 400) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const buf = [];
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

function secidOf(code) {
  const c = String(code);
  return /^6|^9|^5/.test(c) ? '1.' + c : '0.' + c;
}

/* --------------------------------- 持仓存取 --------------------------------- */

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (_) { return { positions: [], updatedAt: 0 }; }
}

function save(doc) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

function validate(code, cost, shares) {
  if (!/^\d{6}$/.test(String(code))) return '代码必须是 6 位数字';
  if (!(cost > 0)) return '成本价必须大于 0';
  if (!(shares > 0)) return '股数必须大于 0';
  if (shares % 1 !== 0) return '股数必须是整数';
  return null;
}

function upsert({ code, cost, shares, note }) {
  const err = validate(code, cost, shares);
  if (err) return { ok: false, error: err };
  const doc = load();
  const c = String(code);
  const exist = doc.positions.find(p => p.code === c);
  if (exist) {
    exist.cost = round(+cost, 3);
    exist.shares = Math.round(+shares);
    exist.note = note || exist.note || '';
    exist.updatedAt = Date.now();
  } else {
    doc.positions.push({ code: c, name: null, cost: round(+cost, 3), shares: Math.round(+shares), note: note || '', addedAt: Date.now(), updatedAt: Date.now() });
  }
  doc.updatedAt = Date.now();
  save(doc);
  return { ok: true, positions: doc.positions.length };
}

function remove(code) {
  const doc = load();
  const before = doc.positions.length;
  doc.positions = doc.positions.filter(p => p.code !== String(code));
  if (doc.positions.length === before) return { ok: false, error: '持仓不存在：' + code };
  doc.updatedAt = Date.now();
  save(doc);
  return { ok: true, positions: doc.positions.length };
}

/* --------------------------------- 行情与 ATR --------------------------------- */

/** 批量实时行情：[{code, name, price, changePct, change, prevClose}] */
async function fetchQuotes(codes) {
  if (!codes.length) return [];
  const secids = codes.map(secidOf).join(',');
  const url = EM_ULIST + '?fltt=2&invt=2&fields=f2,f3,f4,f12,f14,f18&secids=' + secids;
  const j = await fetchJson(url);
  const diff = (j && j.data && j.data.diff) || [];
  return diff.map(d => ({
    code: String(d.f12),
    name: d.f14 || null,
    price: Number.isFinite(+d.f2) ? +d.f2 : null,
    changePct: Number.isFinite(+d.f3) ? +d.f3 : null,
    change: Number.isFinite(+d.f4) ? +d.f4 : null,
    prevClose: Number.isFinite(+d.f18) ? +d.f18 : null
  })).filter(q => q.price);
}

const atrCache = new Map();

/**
 * ATR(14)×2 止损参考：持仓不在观察池时兜底计算（观察池内的直接用池内 atrStopRef，
 * 与评分口径一致）。日线级数据缓存 30 分钟。
 */
async function atrStopOf(code) {
  const hit = atrCache.get(code);
  if (hit && Date.now() - hit.at < ATR_TTL) return hit.stop;
  try {
    const ic = require('./ic');
    const bars = await ic.fetchKline(code, 30);
    if (bars.length < 16) return null;
    const trs = [];
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i], p = bars[i - 1];
      trs.push(Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)));
    }
    const atr = trs.slice(-14).reduce((s, x) => s + x, 0) / Math.min(14, trs.length);
    const stop = round(bars[bars.length - 1].c - 2 * atr, 2);
    atrCache.set(code, { at: Date.now(), stop });
    return stop;
  } catch (_) { return null; }
}

/** 涨跌停幅度：创业板/科创板 20%，北交所 30%，其余 10%（忽略 ST 的 5%，触发判定留 ±0.3% 容差） */
function limitPctOf(code) {
  const c = String(code);
  if (/^(43|83|87|92)/.test(c)) return 30;
  if (/^(30|68)/.test(c)) return 20;
  return 10;
}

/* --------------------------------- 确定性建议 --------------------------------- */

/**
 * 七条规则全部基于「当前数据 + 明确阈值」，每条建议带 level 与触发说明。
 * 不预测涨跌；「系统看多」必须引用观察池当时的真实 thesis，可追溯可证伪。
 */
function adviceOf({ price, changePct, pnlPct, stopRef, poolItem, code }) {
  const out = [];
  const lim = limitPctOf(code);

  if (price != null && stopRef != null && price <= stopRef) {
    out.push({ level: 'warning', text: '价格 ' + price + ' 已跌破止损参考 ' + stopRef + '（ATR×2），建议评估减仓或离场' });
  }
  if (changePct != null && changePct <= -lim + 0.3) {
    out.push({ level: 'critical', text: '已跌停（' + changePct + '%），注意流动性风险，跌停板上卖出可能无法成交' });
  } else if (changePct != null && changePct >= lim - 0.3) {
    out.push({ level: 'info', text: '已涨停（' + changePct + '%）' + (poolItem && poolItem.limitLink && poolItem.limitLink.sealRatio != null ? '，封单占流通市值 ' + poolItem.limitLink.sealRatio + '%' : '') + '，持有观察封板稳定性即可' });
  } else if (changePct != null && changePct <= -5) {
    out.push({ level: 'warning', text: '当日大跌 ' + changePct + '%，先查观察池事件列与新闻是否有实质利空，区分「杀逻辑」与「杀情绪」' });
  }
  if (pnlPct != null && pnlPct >= 15) {
    out.push({ level: 'info', text: '浮盈 ' + round(pnlPct, 1) + '%，可考虑移动止盈（如从成本价 / 阶段高点回撤 8% 内继续持有）' });
  }
  if (pnlPct != null && pnlPct <= -10) {
    out.push({ level: 'warning', text: '浮亏 ' + round(pnlPct, 1) + '%，重新核对买入逻辑是否仍成立（用《升级方案梳理》中的公司研究面板核对基本面是否变化）' });
  }
  if (poolItem) {
    if (poolItem.signal === '重点关注') {
      out.push({ level: 'info', text: '系统看多（' + poolItem.score + ' 分）：' + (poolItem.reasons && poolItem.reasons[0] ? String(poolItem.reasons[0]).slice(0, 60) : '见观察池理由列') });
    } else if (poolItem.score != null && poolItem.score < 55) {
      out.push({ level: 'info', text: '系统评分转弱（' + poolItem.score + ' 分），趋势或资金面出现退潮迹象' });
    }
  } else {
    out.push({ level: 'muted', text: '不在今日观察池（未触发五榜候选），系统无评分意见；仅监控行情与止损参考' });
  }
  return out.slice(0, 3);
}

/* ---------------------------------- 视图 ---------------------------------- */

async function buildView(poolItems = []) {
  const doc = load();
  if (!doc.positions.length) {
    return { ok: true, count: 0, positions: [], summary: null, note: '尚未录入持仓，在下方表单添加（代码 / 成本 / 股数）', updatedAt: doc.updatedAt || null };
  }

  const quotes = await fetchQuotes(doc.positions.map(p => p.code)).catch(() => []);
  const qMap = new Map(quotes.map(q => [q.code, q]));
  const poolMap = new Map((poolItems || []).map(it => [String(it.code), it]));

  let totalCost = 0, totalValue = 0, valuedCount = 0;
  const positions = [];

  for (const p of doc.positions) {
    const q = qMap.get(p.code);
    const poolItem = poolMap.get(p.code) || null;
    const price = q ? q.price : null;
    const value = price != null ? round(price * p.shares, 0) : null;
    const pnl = price != null ? round((price - p.cost) * p.shares, 0) : null;
    const pnlPct = price != null ? round((price / p.cost - 1) * 100, 2) : null;
    if (value != null) { totalValue += value; valuedCount++; }
    totalCost += p.cost * p.shares;

    // 止损参考：优先用观察池口径（与评分一致），池外持仓用本模块 ATR 计算
    let stopRef = (poolItem && poolItem.atrStopRef) || null;
    if (stopRef == null) stopRef = await atrStopOf(p.code).catch(() => null);

    positions.push({
      code: p.code,
      name: q && q.name ? q.name : p.name,
      shares: p.shares,
      cost: p.cost,
      note: p.note || '',
      price,
      changePct: q ? q.changePct : null,
      value,
      pnl,
      pnlPct,
      stopRef,
      // 观察池联动（在池内才有）
      inPool: !!poolItem,
      score: poolItem ? poolItem.score : null,
      signal: poolItem ? poolItem.signal : null,
      boardLabel: (poolItem && poolItem.limitLink && poolItem.limitLink.board && poolItem.limitLink.board.label) || null,
      advice: price != null ? adviceOf({ price, changePct: q ? q.changePct : null, pnlPct, stopRef, poolItem, code: p.code }) : []
    });
  }

  const summary = valuedCount
    ? {
      count: doc.positions.length,
      cost: round(totalCost, 0),
      value: round(totalValue, 0),
      pnl: round(totalValue - totalCost, 0),
      pnlPct: round((totalValue / totalCost - 1) * 100, 2),
      quotedAt: Date.now()
    }
    : { count: doc.positions.length, note: '行情暂不可得（数据源限流或休市）' };

  return { ok: true, count: doc.positions.length, positions, summary, updatedAt: Date.now() };
}

module.exports = { load, save, upsert, remove, buildView, fetchQuotes, adviceOf, limitPctOf, FILE };
