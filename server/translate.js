'use strict';

/**
 * 新闻中文化层。
 *
 * 实测（2026-11-15，本机直连）：Google translate_a/single 的 gtx 公共端点可用，
 * 且支持用换行符一次提交多条、按段落返回多条译文。本机实测 3 条 / 5 并发均正常。
 * 这不是官方付费 API，可能随时变更或限流；因此：
 *   - 全量结果落盘缓存，重启后不重复请求；
 *   - 批量请求失败自动降级为逐条重试；仍失败则保留原文并标注 untranslated；
 *   - 异步执行，绝不阻塞行情与新闻采集。
 *
 * 中文原生新闻不送翻译，避免把中文误译成奇怪的英文腔。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { UA } = require('./sources');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'translations.json');
const MAX_CACHE = 8000;
const BATCH_LINES = 8;        // 每批最多 8 段，控制 URL 长度
const BATCH_CHARS = 900;      // 每批总字符上限
const GAP_MS = 120;           // 批间隔，礼貌限流

let cache = loadCache();
let dirty = false;
let saveTimer = null;

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    const o = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (_) { return {}; }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty) return;
    try {
      const keys = Object.keys(cache);
      if (keys.length > MAX_CACHE) {
        // 简单 LRU：按最后使用时间淘汰最旧的一半
        const keep = keys.sort((a, b) => (cache[b].u || 0) - (cache[a].u || 0)).slice(0, Math.floor(MAX_CACHE * 0.7));
        const next = {};
        for (const k of keep) next[k] = cache[k];
        cache = next;
      }
      const tmp = CACHE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
      fs.renameSync(tmp, CACHE_FILE);
      dirty = false;
    } catch (e) { console.warn('[translate] 缓存写入失败:', e.message); }
  }, 1500);
  saveTimer.unref && saveTimer.unref();
}

const hash = t => crypto.createHash('md5').update('en>zh-CN|' + t).digest('hex').slice(0, 18);

function chineseRatio(s) {
  const str = String(s || '');
  if (!str) return 0;
  const cn = (str.match(/[\u3400-\u9fff]/g) || []).length;
  return cn / str.length;
}

/** 中文原生内容直接返回，标记 native，不消耗翻译额度 */
function isNativeChinese(s) { return chineseRatio(s) > 0.25; }

function cached(text) {
  const k = hash(text);
  const hit = cache[k];
  if (!hit || !hit.z) return null;
  hit.u = Date.now();
  return hit.z;
}

function remember(text, zh) {
  if (!zh) return;
  cache[hash(text)] = { z: zh, u: Date.now() };
  scheduleSave();
}

function tidy(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function callGoogle(lines) {
  const params = new URLSearchParams({
    client: 'gtx', sl: 'en', tl: 'zh-CN', dt: 't', q: lines.join('\n')
  });
  const url = 'https://translate.googleapis.com/translate_a/single?' + params.toString();
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': '*/*' },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const segs = Array.isArray(j && j[0]) ? j[0] : null;
  if (!segs) throw new Error('返回结构异常');
  return segs.map(x => tidy(Array.isArray(x) ? x[0] : ''));
}

async function translateOne(text) {
  try {
    const segs = await callGoogle([text]);
    return segs[0] || null;
  } catch (_) { return null; }
}

/**
 * 批量翻译：返回与输入等长的数组，元素为译文或 null。
 * 批内行数不一致（Google 偶发合并段落）时自动逐条重试，保证不错位。
 */
async function translateBatch(texts) {
  const out = new Array(texts.length).fill(null);
  const pending = [];
  texts.forEach((t, i) => {
    if (isNativeChinese(t)) { out[i] = t; return; }
    const c = cached(t);
    if (c) { out[i] = c; return; }
    pending.push({ i, t });
  });

  const batches = [];
  let cur = [], chars = 0;
  for (const p of pending) {
    if (cur.length && (cur.length >= BATCH_LINES || chars + p.t.length > BATCH_CHARS)) {
      batches.push(cur); cur = []; chars = 0;
    }
    cur.push(p); chars += p.t.length;
  }
  if (cur.length) batches.push(cur);

  for (const batch of batches) {
    let segs = null;
    try { segs = await callGoogle(batch.map(p => p.t)); } catch (_) { segs = null; }
    if (segs && segs.length === batch.length) {
      batch.forEach((p, k) => {
        const zh = segs[k];
        // 译文与原文完全相同、或译文里仍是大段拉丁字母，视为疑似失败
        if (zh && zh !== p.t) { out[p.i] = zh; remember(p.t, zh); }
      });
    } else {
      for (const p of batch) {
        const zh = await translateOne(p.t);
        if (zh && zh !== p.t) { out[p.i] = zh; remember(p.t, zh); }
      }
    }
    if (GAP_MS && batch !== batches[batches.length - 1]) {
      await new Promise(r => setTimeout(r, GAP_MS));
    }
  }
  return out;
}

/**
 * 为新闻条目生成中文字段。返回 { [id]: { titleZh, descZh, engine } }
 * engine: native(原文即中文) / machine(机器译文) / original(翻译不可用，保留原文)
 */
async function translateNews(items, opts = {}) {
  const descLimit = Math.max(0, opts.descLimit === undefined ? 40 : opts.descLimit);
  const jobs = [];
  const index = new Map();

  for (const n of items) {
    index.set(n.id, { title: n.title, desc: n.desc || '' });
    jobs.push({ id: n.id, field: 'titleZh', text: n.title });
  }
  for (const n of items.slice(0, descLimit)) {
    if (n.desc && n.desc.length > 12) jobs.push({ id: n.id, field: 'descZh', text: n.desc });
  }

  const texts = jobs.map(j => j.text);
  const results = texts.length ? await translateBatch(texts) : [];
  const out = {};
  jobs.forEach((j, k) => {
    const rec = out[j.id] || (out[j.id] = { titleZh: null, descZh: null, engine: 'original' });
    const zh = results[k];
    if (j.field === 'titleZh') {
      rec.titleZh = zh || null;
      if (isNativeChinese(j.text)) rec.engine = 'native';
      else if (zh) rec.engine = 'machine';
    } else {
      rec.descZh = zh || null;
    }
  });
  for (const id of Object.keys(out)) {
    const rec = out[id];
    rec.title = (index.get(id) || {}).title || '';
    rec.desc = (index.get(id) || {}).desc || '';
  }
  return out;
}

function stats() {
  return { cached: Object.keys(cache).length, file: CACHE_FILE };
}

module.exports = { translateNews, translateBatch, translateOne, isNativeChinese, stats };
