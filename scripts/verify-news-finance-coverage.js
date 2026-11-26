'use strict';

/**
 * verify-news-finance-coverage.js — 新闻快讯「金融内容覆盖率」可追溯排查
 *
 * 只读、零联网（仅访问本机 8777）、零副作用：
 *   GET /api/snapshot         → 完整新闻池（采集层截断后的 200 条）
 *   GET /api/v2/news-flash    → 前端展示的 80 条
 * 用 server/finance-relevance.js 的确定性词表标注，输出：
 *   - 池子 / 展示位的金融 vs 非金融占比与来源分布
 *   - 非金融样本（用来确认「综合媒体社会新闻占位」这一缺失）
 *   - feedHealth 里 0 条的失效源
 * 结果写入 preview/data/news-finance-coverage.json，供可视化报告复现。
 *
 * 用法：node scripts/verify-news-finance-coverage.js
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { classify } = require('../server/finance-relevance');

const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.GMM_HOST || '127.0.0.1';
const PORT = Number(process.env.GMM_PORT || 8777);

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path: p, timeout: 12000 }, res => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', d => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(p + ' 解析失败: ' + e.message)); } });
    });
    req.on('timeout', () => { req.destroy(new Error(p + ' 超时')); });
    req.on('error', reject);
  });
}

function tally(items) {
  const out = { total: 0, finance: 0, nonFinance: 0, zh: 0, en: 0, bySource: {}, byTag: {}, nonFinanceSamples: [] };
  for (const n of items) {
    const title = String(n.title || '');
    const desc = String(n.desc || n.description || '');
    const c = classify(title, desc);
    out.total++;
    if (c.isFinance) out.finance++; else {
      out.nonFinance++;
      if (out.nonFinanceSamples.length < 24) {
        out.nonFinanceSamples.push({ title: title.slice(0, 92), source: String(n.source || n.feed || '').slice(0, 40), lang: n.lang || '' });
      }
    }
    if (n.lang === 'en' || /^en$/i.test(String(n.lang || ''))) out.en++; else out.zh++;
    const src = String(n.source || n.feed || '未知');
    if (!out.bySource[src]) out.bySource[src] = { total: 0, finance: 0, nonFinance: 0 };
    out.bySource[src].total++;
    if (c.isFinance) out.bySource[src].finance++; else out.bySource[src].nonFinance++;
    for (const t of c.tags) out.byTag[t] = (out.byTag[t] || 0) + 1;
  }
  return out;
}

(async () => {
  const snap = await get('/api/snapshot');
  const flash = await get('/api/v2/news-flash');
  const newsSnap = (snap.data && snap.data.news) || {};
  const pool = newsSnap.items || [];
  const feedHealth = newsSnap.feedHealth || flash.feedHealth || {};
  const poolStats = newsSnap.poolStats || flash.poolStats || null;
  const feed = flash.feed || [];

  const poolT = tally(pool);
  const feedT = tally(feed);
  const dead = Object.entries(feedHealth).filter(([, v]) => Number(v) === 0).map(([k]) => k);
  const sourceTotal = Object.values(feedHealth).reduce((a, b) => a + (Number(b) || 0), 0);
  const strategy = poolStats ? 'finance-priority' : 'time-only-hard-cut';
  const dropLabel = poolStats ? '按金融优先策略未纳入' : '按时间硬截断丢弃';

  const result = {
    checkedAt: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' (北京时间)',
    collector: {
      feeds: Object.keys(feedHealth).length, sourceTotal, poolKept: pool.length,
      strategy, dropLabel, notIncluded: Math.max(0, sourceTotal - pool.length)
    },
    poolStats,
    feedHealth,
    deadFeeds: dead,
    pool: poolT,
    displayed: feedT,
    flashStats: flash.stats || {},
    conclusion: ''
  };
  result.conclusion =
    `采集层共 ${sourceTotal} 条（${strategy === 'finance-priority' ? '金融优先保底' : '仅按时间截断'}策略），池子保留 ${pool.length} 条，` +
    `${dropLabel} ${result.collector.notIncluded} 条` +
    (poolStats ? `（金融保底 ${poolStats.financeQuota} / 单源上限 ${poolStats.perFeedCap}）` : '') + '；' +
    `池子金融相关 ${poolT.finance}/${poolT.total} (${(poolT.finance / (poolT.total || 1) * 100).toFixed(1)}%)，` +
    `展示位金融相关 ${feedT.finance}/${feedT.total} (${(feedT.finance / (feedT.total || 1) * 100).toFixed(1)}%)；` +
    `失效源 ${dead.length} 个${dead.length ? '：' + dead.join('、') : ''}。`;

  const pct = (a, b) => (a / (b || 1) * 100).toFixed(1) + '%';
  console.log('=== 采集层 ===');
  console.log(`源数 ${result.collector.feeds} · 本轮抓取合计 ${sourceTotal} 条 · 池子保留 ${pool.length} 条 · ${dropLabel} ${result.collector.notIncluded} 条 · 策略 ${strategy}`);
  if (poolStats) console.log('金融优先参数:', JSON.stringify(poolStats));
  console.log('各源条数:', JSON.stringify(feedHealth, null, 1));
  console.log('失效源(0条):', dead.length ? dead.join('、') : '无');
  console.log('\n=== 完整新闻池 (200) ===');
  console.log(`金融 ${poolT.finance}/${poolT.total} ${pct(poolT.finance, poolT.total)} · 非金融 ${poolT.nonFinance} · 中文 ${poolT.zh} / 英文 ${poolT.en}`);
  console.log('主题标签分布:', JSON.stringify(poolT.byTag));
  console.log('\n=== 前端展示位 (80) ===');
  console.log(`金融 ${feedT.finance}/${feedT.total} ${pct(feedT.finance, feedT.total)} · 非金融 ${feedT.nonFinance}`);
  console.log('展示位非金融样本（前 12 条）:');
  feedT.nonFinanceSamples.slice(0, 12).forEach((x, i) => console.log(`  ${i + 1}. [${x.source}] ${x.title}`));
  console.log('\n=== 按源：非金融贡献 ===');
  Object.entries(poolT.bySource).sort((a, b) => b[1].nonFinance - a[1].nonFinance).slice(0, 10)
    .forEach(([k, v]) => console.log(`  ${k.padEnd(26)} 总 ${String(v.total).padStart(3)} / 金融 ${String(v.finance).padStart(3)} / 非金融 ${v.nonFinance}`));
  console.log('\n=== 结论 ===');
  console.log(result.conclusion);

  const outDir = path.join(ROOT, 'preview', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'news-finance-coverage.json');
  fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
  console.log('\n已写入:', path.relative(ROOT, out));
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
