'use strict';
/**
 * perception.js — 智能体模块感知快照（P3）
 *
 * 把五个模块与事件研究的结果导出为本地 JSON，Hermes 通过 skill 按需读取，
 * 而不是由 Node 把全部数据塞进 system prompt。这样符合 AI-Hel2 的
 * 「Agent 只存不提取 / 工具按需取数」接口分离模式。
 *
 * 输出：data/agent-perception/{market,sectors,picks,calendar,event-study,knowledge,predictions}.json
 *       data/agent-perception/manifest.json
 */

const fs = require('node:fs');
const path = require('node:path');
const daily = require('./daily');
const cal = require('./calendar');
const knowledge = require('./knowledge');
const predictions = require('./predictions');
const eventStudy = require('./event-study');

const OUT = path.join(__dirname, '..', 'data', 'agent-perception');
const FILES = ['market', 'sectors', 'picks', 'calendar', 'event-study', 'knowledge', 'predictions'];

function ensureDir() { if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true }); }
function write(name, obj) {
  ensureDir();
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(obj, null, 2), 'utf8');
}
function read(name) {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, name + '.json'), 'utf8')); } catch (_) { return null; }
}
function bjNow() { return new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' CST'; }

function refresh() {
  const at = Date.now();
  const payload = {
    market: { generatedAt: bjNow(), data: daily.marketMonitor() },
    sectors: { generatedAt: bjNow(), data: daily.sectorMonitor() },
    picks: { generatedAt: bjNow(), data: daily.picks() },
    calendar: {
      generatedAt: bjNow(),
      data: {
        upcoming: (cal.upcoming({ days: 60 }) || []).slice(0, 30),
        reminders: cal.dueReminders({ aheadDays: 7 }),
        note: 'A=官方确定日期；B=规律推算待核实；C=季节性线索。FOMC/季节性仅月份标记，不进入后验统计。'
      }
    },
    'event-study': { generatedAt: bjNow(), data: (() => {
      const s = eventStudy.study();
      if (!s.ok) return s;
      const d = s.data;
      return {
        ok: true, generatedAt: d.generatedAt, window: d.window,
        method: d.method, note: d.note,
        overall: d.overall, rules: d.rules.slice(0, 20), proxyStats: d.proxyStats.slice(0, 12),
        observationCount: d.observationCount
      };
    })() },
    knowledge: { generatedAt: bjNow(), data: knowledge.status() },
    predictions: { generatedAt: bjNow(), data: predictions.summary() }
  };
  for (const name of FILES) write(name, payload[name]);
  const manifest = {
    ok: true, generatedAt: at, generatedAtText: bjNow(),
    files: Object.fromEntries(FILES.map(n => [n, 'data/agent-perception/' + n + '.json'])),
    wslPath: '/mnt/d/WorkBuddy/projects/GlobalMarketMonitor/data/agent-perception',
    note: 'Hermes 技能 market-modules 按需读取；快照为程序计算结果，不是买卖建议。'
  };
  write('manifest', manifest);
  return { ok: true, generatedAt: manifest.generatedAt, files: FILES.length, wslPath: manifest.wslPath };
}

/** 生成给模型看的紧凑文本（仅在需要一次性注入时使用，默认仍走 skill 按需读取） */
function bundle({ maxChars = 14000, files = FILES } = {}) {
  const parts = [];
  for (const name of files) {
    const j = read(name);
    if (!j) continue;
    const s = JSON.stringify(j.data);
    parts.push('【' + name + '｜' + (j.generatedAt || '') + '】\n' + (s.length > maxChars / files.length ? s.slice(0, Math.floor(maxChars / files.length)) + '…(截断)' : s));
  }
  return parts.join('\n\n');
}

function status() {
  const m = read('manifest');
  return {
    ok: true,
    generatedAt: m ? m.generatedAt : null,
    files: FILES.map(n => ({ name: n, exists: !!read(n) })),
    wslPath: m ? m.wslPath : null
  };
}

module.exports = { refresh, bundle, status, OUT, FILES };
