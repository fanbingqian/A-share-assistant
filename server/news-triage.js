'use strict';
/**
 * news-triage.js — 新闻「规则召回 → 智能体价值分级」的桥接层
 *
 * 关键设计：本模块【不调用大模型】，只做两件确定性的事：
 *  ① 把服务内存中的【全量新闻】按现有规则（政策关键词权重 / 分类 / 告警 / 时点）
 *     召回成候选集快照，落盘到 data/agent-perception/news-candidates.json，
 *     供 Hermes 的 ashare-news-triage 技能按需读取（Pull，非 Push）。
 *  ② 读取 Hermes 技能写回的 data/agent-perception/news-triage.json，做结构校验后
 *     交给前端展示。AI 结果只是「标注 / 建议」，不改写规则事实、不自动入历、
 *     不改动任何量化评分。
 *
 * 为什么要分层：规则层高召回、可追溯、零幻觉；智能体层补语义价值判断
 * （是否真正影响 A 股、是否为旧闻/重复/境外杂闻、影响路径是什么）。
 * 两层分离，LLM 幻觉就无法污染确定性数据与日历。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PERCEPTION = path.join(__dirname, '..', 'data', 'agent-perception');
const F_CANDIDATES = path.join(PERCEPTION, 'news-candidates.json');
const F_TRIAGE = path.join(PERCEPTION, 'news-triage.json');
const MAX_CANDIDATES = 60;   // 只把规则分最高的一批交给智能体精排，控制上下文体积

function readJson(f) { try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} return null; }
function writeJson(f, o) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = f + '.tmp';
  fs.writeFileSync(t, JSON.stringify(o, null, 2), 'utf8');
  fs.renameSync(t, f);
}
function bjNow(ts = Date.now()) { return new Date(ts + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); }
function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 12); }
function polImp(n) { return n && (n.policyImportance != null ? n.policyImportance : (n.importance || 0)) || 0; }
function timeOf(n) {
  const raw = n.publishedText || n.pubDate || n.time;
  if (raw && /^\d{4}-\d{2}-\d{2}[ T]/.test(raw)) return String(raw).slice(0, 19);
  if (n.publishedAt) return new Date(n.publishedAt + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
  return raw || null;
}

/**
 * 生成候选集快照。规则分只用于「召回排序」，不是价值结论，也不冒充智能体判断。
 * @param {{news?:object, pulse?:object}} ctx
 */
function build(ctx = {}) {
  const news = ctx.news || {};
  const pulse = ctx.pulse || {};
  const items = Array.isArray(news.items) ? news.items : [];
  const rows = items.map(n => {
    const imp = polImp(n);
    const hits = (n.policyHits || []).map(h => h.w || h).filter(Boolean);
    const reasons = [];
    if (hits.length) reasons.push('命中政策关键词：' + hits.join('、'));
    if (n.category) reasons.push('规则归类：' + n.category);
    if (n.policyAlert) reasons.push('规则标记：高影响告警');
    if (!reasons.length) reasons.push('未命中政策关键词（由智能体判断是否仍有关联价值）');
    return {
      key: String(n.id || md5(n.title || n.titleZh || '')),
      title: String(n.titleZh || n.title || n.headline || '').slice(0, 180),
      rawTitle: String(n.title || '').slice(0, 180),
      desc: String(n.desc || n.description || n.translation || '').slice(0, 220),
      source: n.source || n.feed || '',
      time: timeOf(n),
      link: n.link || n.url || null,
      rule: {
        score: imp,                       // 0-100，来自 sources.js 的确定性权重
        category: n.category || null,
        alert: !!n.policyAlert,
        level: n.level || 'none',
        hits,
        reasons
      }
    };
  });
  // 规则分降序 → 时间降序；同分时不编造额外权重
  rows.sort((a, b) =>
    (b.rule.score - a.rule.score) ||
    String(b.time || '').localeCompare(String(a.time || ''))
  );
  const candidates = rows.slice(0, MAX_CANDIDATES);
  const snap = {
    ok: true,
    kind: 'news-candidates',
    generatedAt: bjNow(),
    newsFetchedAt: news.fetchedAt || null,
    recall: {
      scannedTotal: rows.length,
      returned: candidates.length,
      criterion: '按 sources.js 政策关键词权重（0-100）降序召回；未命中者保留在尾部供人工/智能体复核，不静默丢弃',
      note: 'rule.score 只是规则召回分，不代表新闻真实价值，也不是涨跌信号'
    },
    sectorBias: (pulse.sectors || []).slice(0, 8).map(s => ({ sector: s.sector, score: s.score, direction: s.direction })),
    outputPath: 'data/agent-perception/news-triage.json',
    outputPathWSL: '/mnt/d/WorkBuddy/projects/GlobalMarketMonitor/data/agent-perception/news-triage.json',
    candidates,
    disclaimer: '候选集来自真实新闻抓取 + 确定性规则召回；不含任何模型生成内容。'
  };
  writeJson(F_CANDIDATES, snap);
  return snap;
}

/** 校验并读取 Hermes 写回的价值分级结果；结构不合法一律视为「无结果」，不把脏数据喂给前端 */
function latestTriage() {
  const t = readJson(F_TRIAGE);
  if (!t || !Array.isArray(t.items)) return null;
  const allowed = new Set(['high', 'medium', 'low', 'noise']);
  const items = t.items.filter(x => x && x.key && allowed.has(x.tier)).map(x => ({
    key: String(x.key).slice(0, 80),
    tier: x.tier,
    reason: String(x.reason || '').slice(0, 240),
    sectors: Array.isArray(x.sectors) ? x.sectors.slice(0, 8).map(String) : [],
    citedTitle: String(x.citedTitle || '').slice(0, 180)
  }));
  if (!items.length) return null;
  return {
    ok: true,
    generatedAt: t.generatedAt || null,
    model: t.model || 'Hermes / DeepSeek',
    candidateSetAt: t.candidateSetAt || null,
    counts: {
      high: items.filter(x => x.tier === 'high').length,
      medium: items.filter(x => x.tier === 'medium').length,
      low: items.filter(x => x.tier === 'low').length,
      noise: items.filter(x => x.tier === 'noise').length
    },
    items,
    disclaimer: '智能体价值分级为 AI 建议（基于候选新闻原文的语义判断），不是事实、不构成买卖建议，也不改动规则筛选结果。'
  };
}

function latestCandidates() { return readJson(F_CANDIDATES); }
function status() {
  const c = latestCandidates();
  const t = latestTriage();
  return {
    ok: true,
    candidates: c ? { generatedAt: c.generatedAt, scannedTotal: c.recall.scannedTotal, returned: c.recall.returned } : null,
    triage: t ? { generatedAt: t.generatedAt, counts: t.counts } : null,
    files: { candidates: F_CANDIDATES, triage: F_TRIAGE }
  };
}

module.exports = { build, latestCandidates, latestTriage, status, F_CANDIDATES, F_TRIAGE };
