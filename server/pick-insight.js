'use strict';
/**
 * pick-insight.js — 三类选股的「行业 + 上涨原因 + 板块领跑/跟随」解释层
 *
 * 设计纪律（反幻觉）：
 *  1. 不编造因果。所谓「上涨原因」= 可核验的驱动线索清单，每条带来源（技术面计算结果 / 公告标题 /
 *     新闻标题 / 板块消息面 / 涨停盘口），并显式声明「线索不等于因果认定」。
 *  2. 领跑/跟随是相对排序的程序判定，不是「龙头股」荐股结论；依据写清楚（行业内 5 日收益、连板、
 *     封单、热度、启动迹象），不预测后续涨跌。
 *  3. 行业归属优先取缓存事实字段，其次用概念标签/板块名近似匹配；都取不到标 null，绝不猜。
 *
 * 输入：screener 的三类结果 + 本地素材缓存
 * 输出：data/pick-insight.json（由 daily.picks 聚合读取）
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA, 'pick-insight.json');

function readJson(file) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return null;
}
function bjNow() { return new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function pct(v) { return v == null ? null : (v > 0 ? '+' : '') + v + '%'; }

/* ------------------------------ 素材装载 ------------------------------ */
function loadContext() {
  const att = readJson(path.join(DATA, 'attention-cache.json'));
  const attentionByCode = new Map();
  if (att && att.items) for (const [k, v] of Object.entries(att.items)) attentionByCode.set(k, v);

  const lk = readJson(path.join(DATA, 'limitup-cache.json'));
  const limitUpByCode = new Map();
  for (const x of (lk && lk.zt) || []) limitUpByCode.set(x.code, x);

  const st = readJson(path.join(DATA, 'stocks-cache.json'));
  const stockByCode = new Map();
  for (const x of (st && st.items) || []) stockByCode.set(x.code, x);

  // 全市场名称表（5579 只）：补齐 trend/rebound 股缺失的名称
  const nameByCode = new Map();
  const uni = readJson(path.join(DATA, 'universe-all.json'));
  for (const x of (uni && uni.items) || []) if (x.code && x.name) nameByCode.set(x.code, x.name);

  const attr = readJson(path.join(DATA, 'attribution-cache.json'));
  const attrByCode = new Map();
  for (const x of (attr && attr.items) || []) attrByCode.set(x.code, x);

  const news = readJson(path.join(DATA, 'stock-news-cache.json'));
  const newsByCode = (news && news.items && typeof news.items === 'object') ? news.items : {};

  const pulse = readJson(path.join(DATA, 'news-pulse.json'));
  const sectorBias = new Map();
  for (const s of (pulse && pulse.sectors) || []) sectorBias.set(String(s.sector), s);
  const policyNews = (pulse && pulse.policyNews) || [];

  const strength = readJson(path.join(DATA, 'strength-cache.json'));
  const sectorStrength = new Map();
  for (const x of (strength && strength.leaders) || []) if (x.name) sectorStrength.set(String(x.name), x);

  return { attentionByCode, limitUpByCode, stockByCode, nameByCode, attrByCode, newsByCode, sectorBias, policyNews, sectorStrength };
}

/* ------------------------------ 行业归属 ------------------------------ */
const PLACEHOLDER = new Set(['未分类', '', 'null', 'unknown']);

function industryOf(code, explicit, ctx) {
  if (explicit && !PLACEHOLDER.has(String(explicit))) return String(explicit);
  const st = ctx.stockByCode.get(code);
  if (st && st.industry && !PLACEHOLDER.has(String(st.industry))) return String(st.industry);
  const zt = ctx.limitUpByCode.get(code);
  if (zt && zt.industry && !PLACEHOLDER.has(String(zt.industry))) return String(zt.industry);
  const at = ctx.attrByCode.get(code);
  if (at && at.industry && !PLACEHOLDER.has(String(at.industry))) return String(at.industry);
  // 概念标签与已知板块名近似匹配
  const tags = ((ctx.attentionByCode.get(code) || {}).conceptTags) || [];
  for (const tag of tags) {
    const t = String(tag);
    for (const sec of ctx.sectorStrength.keys()) {
      if (t.includes(sec) || sec.includes(t)) return String(sec);
    }
  }
  // 取第一个具体概念标签作为细分行业近似（标注为近似）
  for (const tag of tags) {
    const t = String(tag);
    if (t && t !== '未分类') return t;
  }
  return null;
}

/* ------------------------------ 上涨驱动线索 ------------------------------ */
/**
 * 返回 [{ type, text, source, ref }]
 * type: technical / capital / news / sector / board
 */
function riseDrivers(code, item, kind, industry, ctx) {
  const out = [];
  // 1) 技术面：直接使用 screener 已算好的 reason（其中是程序计算结果，可溯源到日线）
  if (item.reason) {
    out.push({ type: 'technical', text: String(item.reason), source: '日线技术指标计算' });
  }
  // 2) 涨停/资金盘口事实
  const zt = ctx.limitUpByCode.get(code);
  if (zt) {
    const bits = [];
    if (zt.boards) bits.push(zt.boards + ' 连板');
    if (zt.firstSealLabel) bits.push('首封 ' + zt.firstSealLabel);
    if (zt.sealRatio != null) bits.push('封单/流通 ' + zt.sealRatio + '%');
    if (zt.breakCount != null) bits.push('开板 ' + zt.breakCount + ' 次');
    if (zt.amount) bits.push('成交额 ' + (Math.round(zt.amount / 1e8 * 10) / 10) + ' 亿');
    out.push({ type: 'capital', text: '涨停盘口：' + bits.join('、'), source: '涨停池缓存 ' + ((readJson(path.join(DATA, 'limitup-cache.json')) || {}).date || '') });
  }
  // 3) 归因事实卡：公告规则命中 + 个股新闻标题（只陈述事实，不断言因果）
  const at = ctx.attrByCode.get(code);
  if (at) {
    for (const r of (at.rules || []).slice(0, 3)) {
      out.push({ type: 'news', text: '公告披露「' + r.label + '」（命中词：' + r.kw + '，' + r.date + '）', source: '上市公司公告', ref: r.ref || null });
    }
    for (const nw of (at.news || []).slice(0, 2)) {
      out.push({ type: 'news', text: '个股新闻：' + nw.title, source: '公开新闻 ' + (nw.date || ''), ref: nw.url || null });
    }
  } else {
    const list = (ctx.newsByCode[code] || []).slice(0, 2);
    for (const nw of list) {
      out.push({ type: 'news', text: '个股新闻：' + nw.title, source: '个股资讯 ' + (nw.timeLabel || '') });
    }
  }
  // 4) 板块消息面（政策/新闻情绪方向）
  if (industry && ctx.sectorBias.has(industry)) {
    const b = ctx.sectorBias.get(industry);
    out.push({ type: 'sector', text: industry + '板块消息面：' + b.direction + '（情绪分 ' + b.score + '，主题 ' + (b.themes || []).join('、') + '）', source: '新闻脉冲板块映射' });
  }
  // 5) 政策快讯：命中行业关键词的近期政策（标题级事实）
  if (industry) {
    const hits = ctx.policyNews.filter(p => {
      const t = String(p.title || '');
      return t.includes(industry) || (p.sectors || []).some(s => String(s) === industry);
    }).slice(0, 2);
    for (const p of hits) {
      out.push({ type: 'sector', text: '政策/监管快讯：' + p.title, source: (p.source || '') + ' ' + (p.time || '') });
    }
  }
  return out;
}

function driverSummary(drivers) {
  const byType = {};
  for (const d of drivers) (byType[d.type] = byType[d.type] || []).push(d);
  const label = { technical: '技术面', capital: '资金/盘口', news: '公告/新闻', sector: '板块/政策' };
  const parts = [];
  for (const t of ['technical', 'capital', 'news', 'sector']) {
    if (byType[t] && byType[t].length) parts.push(label[t] + ' ' + byType[t].length + ' 条');
  }
  return parts.join(' + ') || '暂无可核验线索';
}

/* ------------------------------ 主流程 ------------------------------ */
function build() {
  const ctx = loadContext();
  const hot = readJson(path.join(DATA, 'hot-screen.json'));
  const trend = readJson(path.join(DATA, 'trend-screen.json'));
  const rebound = readJson(path.join(DATA, 'rebound-screen.json'));

  const groups = [
    { kind: 'hot', label: '热度/独立行情', data: hot },
    { kind: 'trend', label: '趋势', data: trend },
    { kind: 'rebound', label: '强势反弹', data: rebound }
  ];

  // 先按 code 全局确定唯一行业（优先事实字段：stocks-cache > 涨停池 > 归因卡 > 概念标签近似），
  // 避免同一只股票在不同类别里被判成不同行业、重复当领跑。
  const industryByCode = new Map();
  for (const g of groups) {
    for (const x of (g.data && g.data.items) || []) {
      if (industryByCode.has(x.code)) continue;
      industryByCode.set(x.code, industryOf(x.code, x.industry, ctx));
    }
  }

  const enriched = [];
  for (const g of groups) {
    for (const x of (g.data && g.data.items) || []) {
      const industry = industryByCode.get(x.code) || null;
      const drivers = riseDrivers(x.code, x, g.kind, industry, ctx);
      enriched.push({
        code: x.code,
        name: x.name || ((ctx.stockByCode.get(x.code) || {}).name) || ctx.nameByCode.get(x.code) || ((ctx.limitUpByCode.get(x.code) || {}).name) || null,
        kind: g.kind,
        kindLabel: g.label,
        industry,
        industryApprox: !!industry && !((ctx.stockByCode.get(x.code) || {}).industry && !PLACEHOLDER.has(String((ctx.stockByCode.get(x.code) || {}).industry))),
        score: x.score != null ? x.score : null,
        last: x.last != null ? x.last : ((ctx.stockByCode.get(x.code) || {}).price != null ? (ctx.stockByCode.get(x.code) || {}).price : null),
        ret5: x.ret5 != null ? x.ret5 : null,
        ret20: x.ret20 != null ? x.ret20 : null,
        independent: x.independent != null ? x.independent : null,
        boards: x.boards != null ? x.boards : (ctx.limitUpByCode.get(x.code) || {}).boards || null,
        heat: x.heat != null ? x.heat : null,
        riseDrivers: drivers,
        driverSummary: driverSummary(drivers),
        baseReason: x.reason || null
      });
    }
  }

  // 按行业聚合（每只股票只算一次，按 code 去重），判定领跑股
  const byIndustry = new Map();
  const seen = new Set();
  for (const x of enriched) {
    if (!x.industry || seen.has(x.code)) continue;
    seen.add(x.code);
    if (!byIndustry.has(x.industry)) byIndustry.set(x.industry, []);
    byIndustry.get(x.industry).push(x);
  }
  const leaders = [];
  const followerMap = new Map(); // leaderKey -> followers
  for (const [industry, list] of byIndustry) {
    // 领跑分：行业内 5 日收益 + 连板 + 热度 + 选股评分（可观测事实加权，不是荐股）
    const leadScore = x => {
      let s = 0;
      if (x.ret5 != null) s += Math.max(-20, Math.min(40, x.ret5));
      if (x.boards) s += x.boards * 8;
      if (x.heat != null) s += Math.min(30, x.heat * 0.3);
      if (x.score != null) s += x.score * 0.3;
      return Math.round(s * 10) / 10;
    };
    const ranked = list.slice().sort((a, b) => leadScore(b) - leadScore(a) || (b.score || 0) - (a.score || 0));
    const leader = ranked[0];
    const lk = industry + '::' + leader.code;
    const lb = ctx.sectorBias.get(industry);
    leader.role = 'leader';
    leader.leadScore = leadScore(leader);
    leader.leadBasis = [
      '同行业入选 ' + list.length + ' 只中领先分最高',
      leader.ret5 != null ? ('近5日 ' + pct(leader.ret5)) : null,
      leader.boards ? (leader.boards + ' 连板') : null,
      leader.heat != null ? ('热度 ' + leader.heat) : null,
      leader.score != null ? ('选股评分 ' + leader.score) : null
    ].filter(Boolean).join('；');
    leaders.push({
      industry, code: leader.code, name: leader.name, kind: leader.kind,
      leadScore: leader.leadScore, basis: leader.leadBasis,
      sectorBias: lb ? { direction: lb.direction, score: lb.score } : null,
      followerCount: ranked.length - 1
    });
    // 跟随股：同行业其余标的，按「启动迹象」排序（评分高、涨幅落后但有技术/资金线索）
    const followers = ranked.slice(1).map(x => ({
      code: x.code, name: x.name, kind: x.kind,
      score: x.score, ret5: x.ret5, boards: x.boards,
      leadScore: leadScore(x),
      gapToLeader: Math.round((leader.leadScore - leadScore(x)) * 10) / 10,
      followBasis: [x.score != null ? ('评分 ' + x.score) : null, x.ret5 != null ? ('近5日 ' + pct(x.ret5)) : null,
        x.boards ? (x.boards + ' 连板') : null, x.driverSummary].filter(Boolean).join('；'),
      drivers: x.riseDrivers
    })).sort((a, b) => b.leadScore - a.leadScore);
    followerMap.set(lk, followers);
    for (const f of followers) {
      const orig = list.find(x => x.code === f.code);
      if (orig) { orig.role = 'follower'; orig.leaderCode = leader.code; orig.leaderName = leader.name; orig.gapToLeader = f.gapToLeader; }
    }
  }
  for (const x of enriched) if (!x.role) x.role = 'standalone';

  const out = {
    ok: true,
    generatedAt: bjNow(),
    note: '上涨原因=可核验驱动线索清单（技术面计算/涨停盘口/公告新闻/板块政策），线索不等于因果认定；领跑/跟随为同行业相对排序的程序判定，不是荐股结论，不预测涨跌。',
    sourceMap: {
      technical: 'screener 日线指标计算', capital: '涨停池盘口缓存',
      news: '个股公告/资讯缓存 + 归因事实卡', sector: '新闻脉冲板块映射 + 政策快讯'
    },
    groups: groups.map(g => ({ kind: g.kind, label: g.label, rule: (g.data && g.data.rule) || null })),
    items: enriched,
    leaders: leaders.sort((a, b) => b.leadScore - a.leadScore),
    followers: Object.fromEntries(followerMap)
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  fs.renameSync(tmp, OUT);
  return out;
}

function status() {
  const j = readJson(OUT);
  return j ? { ok: true, generatedAt: j.generatedAt, items: (j.items || []).length, leaders: (j.leaders || []).length } : { ok: false, note: 'pick-insight 尚未生成' };
}

module.exports = { build, status, loadContext, industryOf, riseDrivers, OUT };
