'use strict';

/**
 * 告警规则引擎（零 LLM、纯规则常驻进程）
 * 分级：info（提示）/ warning（警告）/ critical（严重）
 * 通道：声音 + 浏览器桌面通知 + 页内消息，按级别与免打扰设置分流
 * 去重：同一「规则 + 标的」在 cooldownSec 内只报一次；越界/倒挂用状态翻转避免重复刷屏
 */

const crypto = require('node:crypto');
const { NEWS_KEYWORDS, matchConfigured } = require('./sources');

const LEVEL_RANK = { info: 0, warning: 1, critical: 2 };

function inQuietHours(cfg, now) {
  const q = cfg.quietHours || {};
  if (!q.enabled) return false;
  const toMin = s => {
    const p = String(s || '00:00').split(':').map(Number);
    return (p[0] || 0) * 60 + (p[1] || 0);
  };
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  const a = toMin(q.from), b = toMin(q.to);
  return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

function fmtValue(q) {
  if (q.value === null || q.value === undefined || !Number.isFinite(+q.value)) return '--';
  const v = (+q.value).toFixed(q.decimals === undefined ? 2 : q.decimals);
  if (q.kind === 'yield') return v + '%';
  if (q.kind === 'spread') return v + 'bp';
  if (q.unit) return v + ' ' + q.unit;
  return v;
}

function fmtTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN', { hour12: false });
}

function makeAlert(o) {
  return {
    id: crypto.randomUUID(),
    ts: o.now || Date.now(),
    level: o.level || 'warning',
    category: o.category || 'system',
    instrument: o.instrument || null,
    instrumentName: o.instrumentName || null,
    title: o.title,
    message: o.message || '',
    detail: o.detail || '',
    source: o.source || '',
    sourceTime: o.sourceTime || null,
    rule: o.rule || '',
    value: o.value === undefined ? null : o.value,
    link: o.link || null,
    silent: !!o.silent,
    demo: !!o.demo,
    ack: false
  };
}

function createRuntime(saved) {
  const seen = (saved && saved.seenNews) || [];
  const lastNewsAt = (saved && saved.lastNewsAt) || 0;
  // 断档超过 2 小时视为冷启动：重新建立新闻基线，不把积压的旧新闻一次性推送
  const fresh = lastNewsAt > 0 && (Date.now() - lastNewsAt) < 2 * 3600 * 1000;
  return {
    lastValues: {},
    lastAlertAt: {},
    breachState: {},
    seenNews: new Set(seen),
    newsInitialized: seen.length > 0 && fresh,
    failStreak: {},
    dayBase: {},
    lastQuoteSuccessAt: (saved && saved.lastQuoteAt) || 0,
    lastNewsAt,
    alertCount: 0
  };
}

/**
 * @returns {Array} 本轮新产生的告警（已写入 lastAlertAt，由调用方负责广播与落盘）
 */
function evaluate({ quotes, news, health, config, runtime, now = Date.now(), isFirstQuote = false, mode = 'full' }) {
  const out = [];
  const cooldownMs = Math.max(10, (config.cooldownSec || 300)) * 1000;
  const silent = inQuietHours(config, now);
  const byId = new Map(quotes.map(q => [q.id, q]));
  // mode: 'quote' 只跑行情与系统规则，'news' 只跑新闻规则，避免两类轮询互相触发误报

  const fire = (key, o) => {
    const last = runtime.lastAlertAt[key] || 0;
    if (now - last < cooldownMs) return;
    runtime.lastAlertAt[key] = now;
    out.push(makeAlert({ ...o, now, silent }));
  };

  if (mode !== 'news') {
  /* ---------- 1. 数据源健康 / 断连告警 ---------- */
  for (const [name, status] of Object.entries(health || {})) {
    if (status === 'ok') runtime.failStreak[name] = 0;
    else runtime.failStreak[name] = (runtime.failStreak[name] || 0) + 1;
    if (runtime.failStreak[name] === 2) {
      fire('source:' + name, {
        level: 'warning', category: 'system', rule: 'source-down',
        title: '数据源连接异常',
        message: name + ' 连续 2 次请求失败，系统已自动切换备用源；该源提供的指标可能暂停更新。',
        source: name
      });
    }
  }
  if (!quotes.length) {
    fire('system:no-data', {
      level: 'critical', category: 'system', rule: 'no-data',
      title: '全部行情源不可用',
      message: '当前未取得任何报价，请检查网络连接或稍后重试。'
    });
  } else if (runtime.lastQuoteSuccessAt && now - runtime.lastQuoteSuccessAt > (config.staleAfterSec || 180) * 1000) {
    fire('system:stale', {
      level: 'warning', category: 'system', rule: 'stale',
      title: '行情数据陈旧',
      message: '超过 ' + config.staleAfterSec + ' 秒未取得新的有效报价，界面上的数值可能不是最新。'
    });
  }
  if (news && news.ok === false) {
    fire('system:news-down', {
      level: 'warning', category: 'system', rule: 'news-down',
      title: '新闻源全部不可达',
      message: '本轮未抓取到任何新闻，请检查网络连接。'
    });
  }

  /* ---------- 2. 指标规则 ---------- */
  for (const q of quotes) {
    const rule = config.rules[q.id];
    const v = +q.value;
    if (!rule || !rule.enabled || !Number.isFinite(v)) continue;

    const last = runtime.lastValues[q.id];
    const base = runtime.dayBase[q.id];
    if (base === undefined) runtime.dayBase[q.id] = v;

    if (last === undefined || isFirstQuote) {
      runtime.lastValues[q.id] = v;
      // 首轮只建立基线，不产生行情告警，避免启动瞬间刷屏
      if (rule.upper !== null && rule.upper !== undefined && v > rule.upper) runtime.breachState[q.id + ':up'] = true;
      if (rule.lower !== null && rule.lower !== undefined && v < rule.lower) runtime.breachState[q.id + ':down'] = true;
      continue;
    }

    const isYield = q.kind === 'yield';
    const isSpread = q.kind === 'spread';
    const deltaBp = isYield ? (v - last) * 100 : (v - last);   // spread 本身单位已是 bp
    const pct = last !== 0 ? ((v - last) / last) * 100 : 0;
    const common = {
      category: 'price', instrument: q.id, instrumentName: q.short || q.name,
      source: q.source, sourceTime: q.sourceTime, value: v
    };

    // 2.1 绝对价位 / 收益率上下限（状态翻转触发）
    if (rule.upper !== null && rule.upper !== undefined) {
      const over = v > rule.upper, was = !!runtime.breachState[q.id + ':up'];
      if (over && !was) fire('upper:' + q.id, {
        ...common, level: 'critical', rule: 'upper',
        title: (q.short || q.name) + ' 突破上限',
        message: '最新 ' + fmtValue(q) + ' 已上穿预设上限 ' + rule.upper + (isYield ? '%' : ''),
        detail: '触碰关键位不等于趋势确认，请结合成交与后续延续情况判断。'
      });
      runtime.breachState[q.id + ':up'] = over;
    }
    if (rule.lower !== null && rule.lower !== undefined) {
      const under = v < rule.lower, was = !!runtime.breachState[q.id + ':down'];
      if (under && !was) fire('lower:' + q.id, {
        ...common, level: 'critical', rule: 'lower',
        title: (q.short || q.name) + ' 跌破下限',
        message: '最新 ' + fmtValue(q) + ' 已下穿预设下限 ' + rule.lower + (isYield ? '%' : ''),
        detail: '盘中插针、节假日前后异常与消息冲击下的瞬时波动可能造成失真信号。'
      });
      runtime.breachState[q.id + ':down'] = under;
    }

    // 2.2 相邻两轮跳变（短时异动）
    if ((isYield || isSpread) && rule.moveBp !== null && rule.moveBp !== undefined) {
      if (Math.abs(deltaBp) >= rule.moveBp) {
        fire('move:' + q.id, {
          ...common, level: Math.abs(deltaBp) >= rule.moveBp * 2 ? 'critical' : 'warning', rule: 'move',
          title: (q.short || q.name) + ' 短时异动',
          message: '相邻两次采样变动 ' + (deltaBp > 0 ? '+' : '') + deltaBp.toFixed(1) + ' bp，当前 ' + fmtValue(q),
          detail: '采样间隔 ' + config.quoteIntervalSec + ' 秒。'
        });
      }
    } else if (!isYield && !isSpread && rule.movePct !== null && rule.movePct !== undefined) {
      if (Math.abs(pct) >= rule.movePct) {
        fire('move:' + q.id, {
          ...common, level: Math.abs(pct) >= rule.movePct * 2.5 ? 'critical' : 'warning', rule: 'move',
          title: (q.short || q.name) + ' 短时异动',
          message: '相邻两次采样' + (pct > 0 ? '上涨 ' : '下跌 ') + Math.abs(pct).toFixed(2) + '%，当前 ' + fmtValue(q),
          detail: '采样间隔 ' + config.quoteIntervalSec + ' 秒。'
        });
      }
    }

    // 2.3 日内累计变动
    let dayPctValue = null, dayBpValue = null;
    if (isYield && q.prevClose !== null && q.prevClose !== undefined && Number.isFinite(+q.prevClose)) {
      dayBpValue = (v - +q.prevClose) * 100;
    } else if (isSpread && runtime.dayBase[q.id] !== undefined) {
      dayBpValue = v - runtime.dayBase[q.id];
    } else if (!isYield && !isSpread) {
      if (q.changePct !== null && q.changePct !== undefined && Number.isFinite(+q.changePct)) dayPctValue = +q.changePct;
      else if (runtime.dayBase[q.id]) dayPctValue = ((v - runtime.dayBase[q.id]) / runtime.dayBase[q.id]) * 100;
    }

    if (dayBpValue !== null && rule.dayBp !== null && rule.dayBp !== undefined && Math.abs(dayBpValue) >= rule.dayBp) {
      fire('day:' + q.id, {
        ...common, level: Math.abs(dayBpValue) >= rule.dayBp * 2 ? 'critical' : 'warning', rule: 'day',
        title: (q.short || q.name) + ' 日内大幅变动',
        message: '相对' + (isSpread ? '启动基准' : '前收盘') + (dayBpValue > 0 ? '上行 ' : '下行 ') +
          Math.abs(dayBpValue).toFixed(1) + ' bp，当前 ' + fmtValue(q),
        detail: '利率 1bp = 0.01 个百分点。'
      });
    }
    if (dayPctValue !== null && rule.dayPct !== null && rule.dayPct !== undefined && Math.abs(dayPctValue) >= rule.dayPct) {
      fire('day:' + q.id, {
        ...common, level: Math.abs(dayPctValue) >= rule.dayPct * 1.8 ? 'critical' : 'warning', rule: 'day',
        title: (q.short || q.name) + ' 日内大幅波动',
        message: '日内' + (dayPctValue > 0 ? '涨 ' : '跌 ') + Math.abs(dayPctValue).toFixed(2) + '%，当前 ' + fmtValue(q),
        detail: q.prevClose ? ('前收 ' + q.prevClose + '，来源 ' + q.source) : ('相对启动基准计算，来源 ' + q.source)
      });
    }

    // 2.4 收益率曲线倒挂翻转
    if (q.id === 'spread') {
      const prevSign = runtime.lastValues[q.id];
      if (prevSign >= 0 && v < 0) fire('invert:on', {
        ...common, level: 'critical', rule: 'inversion',
        title: '美债收益率曲线倒挂',
        message: '10Y-2Y 利差由正转负（' + v.toFixed(1) + ' bp），历史上常被视为衰退预警信号。',
        detail: '单一指标不构成判断依据，需结合就业、通胀与信用利差交叉验证。'
      });
      if (prevSign < 0 && v >= 0) fire('invert:off', {
        ...common, level: 'warning', rule: 'inversion-off',
        title: '美债收益率曲线倒挂解除',
        message: '10Y-2Y 利差回到 ' + v.toFixed(1) + ' bp（转正）。'
      });
    }

    runtime.lastValues[q.id] = v;
  }

  } // end quote / system scope

  /* ---------- 3. 新闻关键词 ---------- */
  if (mode !== 'quote' && news && Array.isArray(news.items) && config.newsAlert && config.newsAlert.enabled) {
    const configured = (config.newsAlert.keywords || []).map(k => String(k).toLowerCase());
    const criticalSet = new Set(NEWS_KEYWORDS.critical.map(k => k.toLowerCase()));
    const MAX_NEWS_PER_ROUND = 5;
    let newsFired = 0;
    // 首次启动 / 冷启动只建立基线，不把积压的历史新闻一次性全部报警
    for (const item of news.items) {
      if (runtime.seenNews.has(item.id)) continue;
      runtime.seenNews.add(item.id);
      if (!runtime.newsInitialized) continue;
      if (newsFired >= MAX_NEWS_PER_ROUND) continue;
      const text = item.title + ' ' + (item.desc || '');
      const hit = matchConfigured(text, configured);
      if (!hit) continue;
      const level = criticalSet.has(hit) ? 'critical' : 'warning';
      const before = out.length;
      fire('news:' + hit, {
        level, category: 'news', rule: 'news-keyword',
        instrument: 'news', instrumentName: '全球新闻',
        title: (level === 'critical' ? '重大新闻' : '重点新闻') + '：命中「' + hit + '」',
        message: item.title,
        detail: '来源：' + item.source + '（' + (item.feed || '') + '）',
        source: item.source,
        sourceTime: new Date(item.publishedAt).toISOString(),
        link: item.link,
        value: hit
      });
      if (out.length > before) newsFired++;
    }
    // 控制集合大小，避免长时间运行内存增长
    if (runtime.seenNews.size > 1500) {
      const keep = new Set(news.items.slice(0, 200).map(n => n.id));
      runtime.seenNews = keep;
    }
    runtime.newsInitialized = true;
  }

  runtime.alertCount += out.length;
  return out;
}

function makeTestAlert(level = 'critical', now = Date.now()) {
  return makeAlert({
    now, level, category: 'system', rule: 'self-test', demo: true,
    title: '【自检】告警链路测试',
    message: '这是一条模拟告警，仅用于验证声音、桌面通知与消息显示是否正常工作，不代表任何真实行情或新闻事件。',
    detail: '模拟数据 · 非真实行情',
    source: '系统自检', sourceTime: new Date(now).toISOString()
  });
}

module.exports = { evaluate, createRuntime, makeTestAlert, makeAlert, fmtValue, fmtTime, LEVEL_RANK, inQuietHours };
