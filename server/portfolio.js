'use strict';

/**
 * portfolio.js — 「我的股池」模块（v2）
 *
 * 两类：
 *   watching = 正在关注/在选的股票（沿用 my-picks.json + holdings.json 的持仓）
 *   sold     = 已经卖出的股票（新建 sold.jsonl，记录卖出价/日期/原因，供复盘）
 *
 * 【纪律】不参与任何评分、不改规则；仅作人工记录 + 复盘数据。名称自动识别走 emtx.lookupCode（腾讯行情），不编造。
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data');
const F_PICKS = path.join(DATA, 'my-picks.json');
const F_HOLD = path.join(DATA, 'holdings.json');
const F_SOLD = path.join(DATA, 'sold.jsonl');

function readJson(file) { try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {} return null; }
function writeJson(file, obj) { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj, null, 2), 'utf8'); fs.renameSync(t, file); }
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    .map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
}
function appendJsonl(file, obj) { fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8'); }

function view() {
  const picks = readJson(F_PICKS) || { items: [] };
  const hold = readJson(F_HOLD) || { positions: [] };
  const sold = readJsonl(F_SOLD).sort((a, b) => (b.soldAt || 0) - (a.soldAt || 0));
  return {
    ok: true,
    at: new Date().toISOString().slice(11, 16),
    watching: {
      picks: (picks.items || []).map(x => ({ code: x.code, name: x.name || null, note: x.note || '', addedAt: x.addedAt })),
      holdings: (hold.positions || []).map(x => ({ code: x.code, name: x.name || null, cost: x.cost, shares: x.shares, note: x.note || '' }))
    },
    sold,
    note: '关注/持仓来自既有清单；卖出记录新建于 sold.jsonl。均为人工记录，不参与评分。'
  };
}

/** 记录一笔卖出 */
function addSold(ev) {
  if (!/^\d{6}$/.test(String(ev.code || ''))) return { ok: false, error: '代码应为 6 位数字' };
  const row = {
    id: 'S-' + String(ev.code) + '-' + String(Date.now()).slice(-6),
    code: String(ev.code),
    name: ev.name || null,
    buyCost: Number.isFinite(ev.buyCost) ? ev.buyCost : null,
    sellPrice: Number.isFinite(ev.sellPrice) ? ev.sellPrice : null,
    shares: Number.isFinite(ev.shares) ? ev.shares : null,
    heldDays: Number.isFinite(ev.heldDays) ? ev.heldDays : null,
    reason: String(ev.reason || '').slice(0, 300),
    soldAt: ev.soldAt ? Date.parse(ev.soldAt) : Date.now(),
    createdAt: Date.now()
  };
  if (row.sellPrice != null && row.buyCost != null) row.pnlPct = Math.round((row.sellPrice - row.buyCost) / row.buyCost * 10000) / 100;
  appendJsonl(F_SOLD, row);
  // 若该股在持仓里，自动移除（卖出=不再持有）
  const hold = readJson(F_HOLD);
  if (hold && Array.isArray(hold.positions)) {
    const keep = hold.positions.filter(p => p.code !== row.code);
    if (keep.length !== hold.positions.length) { hold.positions = keep; hold.updatedAt = Date.now(); writeJson(F_HOLD, hold); }
  }
  return { ok: true, record: row };
}

function removeSold(id) {
  const rows = readJsonl(F_SOLD).filter(r => r.id !== id);
  writeJson(F_SOLD, rows); // writeJson 落的是 JSON 对象，这里特殊处理为 jsonl
  // 上面 writeJson 会把数组写成 JSON 数组，需要重写为 jsonl
  fs.writeFileSync(F_SOLD, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  return { ok: true, removed: id };
}

module.exports = { view, addSold, removeSold, F_SOLD };
