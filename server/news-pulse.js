'use strict';
/**
 * news-pulse.js — 每小时消息面脉冲（P0-85）
 *
 * 目标：让选股卡片「根据实时新闻/消息更新」——每小时把最近窗口的新闻
 * 聚合成板块消息面评分与解释，并叠加到三类选股的每只标的上，给出「消息面理由」。
 *
 * 数据来源：不重复抓取，直接读 server 内存中已 60 秒轮询的 news + analysis.sectorBias
 *   （由 analysis.buildBriefing 从新闻主题映射到板块，score∈[-100,100]）。
 * 落盘：data/news-pulse.json（含 hourly 聚合结果、板块消息面、时间戳）
 *
 * 纪律：消息面是「新闻情绪的方向性线索」，不是事实涨跌，也不是买卖建议；
 *       板块与个股的映射为关键词/主题近似，明确标注。
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA, 'news-pulse.json');
const HISTORY = path.join(DATA, 'news-pulse-history.jsonl');
const MAX_HISTORY = 24 * 30; // 30 天 * 24 小时

function readJson(f) { try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} return null; }
function writeJson(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2), 'utf8'); fs.renameSync(t, f); }
function bjNow() { return new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); }
function bjHour() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 13); }
/** 政策重要性分：analysis.js 会覆写 importance，故优先读独立的 policyImportance */
function polImp(n) { return n && (n.policyImportance != null ? n.policyImportance : (n.importance || 0)) || 0; }

/** 板块 → 选股标签关键词。用于把 sectorBias 映射到 conceptTags/industry */
const SECTOR_ALIASES = {
  '创新药': ['创新药', '医药', '生物'], '医药': ['医药', '医疗', '中药'], '中药': ['中药', '医药'],
  '科技': ['科技', '半导体', '芯片', 'AI', '人工智能', '算力', '软件'], '半导体': ['半导体', '芯片'],
  '算力': ['算力', 'AI', '人工智能', '数据中心'], '通信': ['通信', '5G', '光模块'],
  '新能源': ['新能源', '光伏', '锂电', '储能'], '汽车': ['汽车', '智能驾驶', '新能源车'],
  '消费': ['消费', '白酒', '食品', '家电', '零售'], '地产': ['地产', '房地产', '建材'],
  '券商': ['券商', '证券', '金融'], '黄金': ['黄金', '贵金属'], '煤炭': ['煤炭', '能源'],
  '电力': ['电力', '电网', '公用事业'], '石油': ['石油', '油气', '原油'],
  '军工': ['军工', '国防', '航天'], '旅游': ['旅游', '酒店', '航空'], '出口链': ['出口', '外贸', '跨境电商']
};

/** 政策标签 → 可能受影响的板块关键词。只用于展示「相关新闻」，不预测涨跌 */
const POLICY_SECTOR_MAP = {
  '资本市场': ['券商', '证券', '金融', '交易所'],
  '监管': ['券商', '证券', '金融'],
  '资金面': ['券商', '证券', '金融', '银行'],
  '货币政策': ['银行', '地产', '券商', '债券'],
  '宏观': ['基建', '消费', '地产']
};

/** 特定高影响政策词直接指定板块（如融资保证金下调主要影响券商业绩预期） */
function policySectorKeywords(n) {
  const kws = (POLICY_SECTOR_MAP[n.category] || []).slice();
  const t = n.title || '';
  if (/融资保证金|保证金比例|两融|融资余额/.test(t)) kws.unshift('券商', '证券', '金融');
  if (/降准|降息|逆回购|公开市场/.test(t)) kws.unshift('银行', '地产');
  if (/印花税/.test(t)) kws.unshift('券商', '证券');
  return kws;
}

function matchSectorBias(tagOrIndustry, biasList) {
  const s = String(tagOrIndustry || '');
  let best = null;
  for (const b of biasList || []) {
    const aliases = SECTOR_ALIASES[b.sector] || [b.sector];
    if (aliases.some(a => s.includes(a) || a.includes(s))) {
      if (!best || Math.abs(b.score) > Math.abs(best.score)) best = b;
    }
  }
  return best;
}

/**
 * 由服务器传入 snapshot 上下文 { news, analysis }，生成每小时消息面脉冲。
 */
function build(ctx = {}) {
  const news = ctx.news || {};
  const analysis = ctx.analysis || {};
  const bias = Array.isArray(analysis.sectorBias) ? analysis.sectorBias : [];
  const items = news.items || [];
  // 时间字段统一：sources.js 产出 publishedText / publishedAt（旧代码误读 pubDate，导致时间全为 null）
  const timeOf = n => {
    const raw = n.publishedText || n.pubDate || n.time;
    // RSS 的时间是 RFC2822（Sun, 22 Nov ...），统一成北京时间 YYYY-MM-DD HH:mm:ss
    if (raw && /^\d{4}-\d{2}-\d{2}[ T]/.test(raw)) return String(raw).slice(0, 19);
    if (n.publishedAt) return new Date(n.publishedAt + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
    return raw || null;
  };
  // 排序权重：同分时 A 股本土监管政策优先，境外/地区市场降权（只影响展示顺序，不改 importance 原值）
  const policyRank = n => polImp(n)
    + (/沪深北|证监会|A股|上交所|深交所|内地/.test(n.title || '') ? 6 : 0)
    - (/台湾地区|台湾|港股|美股|美联储|欧洲|日本|韩国/.test(n.title || '') ? 20 : 0);
  const policyNews = items
    .filter(n => polImp(n) >= 55 || n.category)
    .sort((a, b) => policyRank(b) - policyRank(a) || (b.publishedAt || 0) - (a.publishedAt || 0))
    .slice(0, 40)
    .map(n => ({
      id: n.id || null,
      title: n.title || n.headline || '',
      time: timeOf(n),
      source: n.source || n.feed || '',
      link: n.link || null,
      importance: polImp(n),
      category: n.category || null,
      level: n.level || 'none',
      alert: !!n.policyAlert,
      reason: (n.policyHits || []).length
        ? '政策标签命中：' + (n.policyHits || []).map(h => h.w).join('、')
        : '按新闻主题归类',
      desc: (n.desc || '').slice(0, 160)
    }));
  // 头条序列：政策相关优先，保证用户能看到「融资保证金」这类高影响新闻，而不是海外体育/地缘杂闻
  const headlineSource = policyNews.length
    ? policyNews.concat(items.filter(n => !(polImp(n) >= 55 || n.category)).slice(0, 12))
    : items;
  const headlines = headlineSource.slice(0, 12).map(n => ({
    title: n.title || n.headline || '',
    time: timeOf(n),
    source: n.source || n.feed || '',
    importance: polImp(n),
    category: n.category || null,
    topics: (n.topics || []).map(t => t.label || t.id || t),
    sentiment: n.sentiment != null ? n.sentiment : null
  }));
  // 板块消息面：正分为偏多线索、负分为偏空线索
  const sectors = bias.map(b => ({
    sector: b.sector, score: b.score, count: b.count, themes: b.themes || [],
    direction: b.score >= 20 ? '消息偏多' : b.score <= -20 ? '消息偏空' : '中性偏弱',
    note: '由最近新闻主题经 analysis.buildBriefing 映射得出；score 为消息情绪方向分，非涨跌预测。'
  }));
  return {
    ok: true,
    at: bjNow(), hour: bjHour(),
    newsCount: items.length,
    newsFetchedAt: news.fetchedAt || null,
    analysisAt: analysis.generatedAt || analysis.at || null,
    policyCount: policyNews.length,
    alertCount: policyNews.filter(n => n.alert).length,
    feedHealth: news.feedHealth || {},
    sectors,
    headlines,
    policyNews,
    disclaimer: '消息面为新闻情绪方向性线索（关键词/主题近似映射），政策标签仅表示命中监管/宏观关键词，不代表涨跌方向，不构成买卖建议；已标注来源与时点。'
  };
}

/** 把消息面叠加到选股结果：给每个 item 增加 newsBias 与 newsReason */
function attachToPicks(picks, pulse) {
  const bias = (pulse && pulse.sectors) || [];
  const out = JSON.parse(JSON.stringify(picks || {}));
  // 补充概念标签：从人气榜缓存按代码取 conceptTags，提升「个股→板块」映射覆盖
  const tagsByCode = new Map();
  const att = readJson(path.join(DATA, 'attention-cache.json'));
  if (att && att.items) for (const [code, v] of Object.entries(att.items)) tagsByCode.set(code, v.conceptTags || []);
  // 政策新闻 → 板块关键词索引（同一板块只保留重要性最高的一条，避免刷屏）
  const policyIndex = new Map();
  for (const n of ((pulse && pulse.policyNews) || []).slice().sort((a, b) => (b.importance || 0) - (a.importance || 0))) {
    for (const kw of policySectorKeywords(n)) {
      if (!policyIndex.has(kw)) policyIndex.set(kw, n);
    }
  }
  for (const key of ['hotIndependent', 'trend', 'rebound', 'hotLimit', 'resilient', 'defensive']) {
    const grp = out[key];
    if (!grp || !Array.isArray(grp.items)) continue;
    for (const it of grp.items) {
      const tags = [it.industry, it.name].concat(tagsByCode.get(it.code) || []).filter(Boolean);
      let b = null;
      for (const t of tags) { b = matchSectorBias(t, bias); if (b) break; }
      it.newsBias = b ? { sector: b.sector, score: b.score, direction: b.direction } : null;
      let pol = null;
      for (const t of tags) {
        for (const [kw, news] of policyIndex) {
          if (String(t).includes(kw) || kw.includes(String(t))) { pol = news; break; }
        }
        if (pol) break;
      }
      it.policyNews = pol ? {
        title: pol.title, time: pol.time, source: pol.source,
        importance: pol.importance, category: pol.category, reason: pol.reason
      } : null;
      let reason = b
        ? ('消息面：' + b.sector + ' ' + b.direction + '（新闻情绪分 ' + (b.score > 0 ? '+' : '') + b.score + '；主题：' + (b.themes || []).join('、') + '）')
        : '消息面：该标的暂无明确新闻主题映射（不据此外推）。';
      if (pol) reason += '；相关政策快讯：' + pol.title + '（' + (pol.time || '时间未标注') + '，' + (pol.source || '') + '）';
      it.newsReason = reason;
      if (it.score != null && b) {
        // 消息面只做 ±5 分的温和调整，不主导量化评分
        it.scoreAdjusted = Math.max(0, Math.min(100, it.score + (b.score >= 20 ? 5 : b.score <= -20 ? -5 : 0)));
      } else it.scoreAdjusted = it.score != null ? it.score : null;
    }
    grp.updatedAt = pulse ? pulse.at : null;
  }
  return out;
}

/** 落盘一次脉冲，并写入历史（保留最近 MAX_HISTORY 条） */
function persist(pulse) {
  writeJson(FILE, pulse);
  let rows = [];
  try { if (fs.existsSync(HISTORY)) rows = fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) {}
  rows.push({ at: pulse.at, hour: pulse.hour, newsCount: pulse.newsCount, topSectors: pulse.sectors.slice(0, 5) });
  rows = rows.slice(-MAX_HISTORY);
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  fs.writeFileSync(HISTORY, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return pulse;
}

function latest() { return readJson(FILE); }
function history(limit = 24) {
  let rows = [];
  try { if (fs.existsSync(HISTORY)) rows = fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) {}
  return rows.slice(-Math.max(1, Math.min(168, limit))).reverse();
}

module.exports = { build, attachToPicks, persist, latest, history, matchSectorBias, SECTOR_ALIASES, FILE };
