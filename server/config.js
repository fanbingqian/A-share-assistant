'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { NEWS_KEYWORDS } = require('./sources');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.jsonl');

/** 默认阈值参考 monitor-alert 方法论：分级、去重冷却、避免噪音淹没核心信号 */
const DEFAULT_CONFIG = {
  quoteIntervalSec: 15,
  newsIntervalSec: 60,
  cooldownSec: 300,
  staleAfterSec: 180,
  sound: { enabled: true, volume: 0.55, minLevel: 'warning' },
  notification: { enabled: true, minLevel: 'critical' },
  quietHours: { enabled: false, from: '23:00', to: '07:00' },
  newsAlert: {
    enabled: true,
    keywords: [...NEWS_KEYWORDS.critical, ...NEWS_KEYWORDS.warning]
  },
  analysis: {
    enabled: true,          // 新闻解读与每日综述
    autoTranslate: true,    // 英文标题自动译为中文
    translateDescLimit: 40, // 同时翻译摘要的条数（越多越慢）
    refreshSec: 180         // 解读重算节流
  },
  stocks: {
    enabled: true,          // 当日观察池
    maxStocks: 18,          // 深度分析的候选股数量 8~30
    refreshMin: 15,         // 日线全量重算间隔（分钟）；消息面变化会另行触发轻量重评分
    valueTrapEnabled: true, // 价值陷阱过滤：低估值 + 盈利恶化 → 额外扣分
    stageWeights: true      // 分层权重：微盘/小盘/中盘/大盘使用不同的三组权重结构
  },
  attention: {
    enabled: true,          // 个股关注度热度（东财人气榜 + 同花顺热榜）与个股舆情
    refreshMin: 5           // 热榜轮询间隔（分钟），非交易时段自动放宽 6 倍
  },
  marketStyle: {
    enabled: true,          // A 股大盘量能 + 微盘/小盘/中盘/大盘资金倾向检测
    refreshMin: 5,          // 风格重算间隔（分钟），非交易时段自动放宽 6 倍
    breadthEnabled: true,   // 全市场横截面宽度（约 56 页快照，独立 20 分钟缓存）
    maxAdjust: 12           // 风格因子对个股评分的最大修正幅度（±分）
  },
  events: {
    enabled: true,          // 公司事件 / 业绩超预期 / 宏观状态检测与即时告警
    refreshMin: 5,          // 公告与业绩数据轮询间隔（分钟），非交易时段自动放宽 4 倍
    lookbackDays: 14,       // 业绩预告 / 快报回看天数
    alertEnabled: true,     // 龙头超预期业绩、重组/收购/回购/减持等重点事件即时提醒
    maxAdjust: 12,          // 事件因子对个股评分的最大修正（±分）
    volumeThresholdYi: 25000, // 存量博弈 / 增量行情分界：两市日成交额（亿元）
    leaderCapYi: 500,       // 龙头判定：流通市值下限（亿元）
    riskOffEnabled: true,   // 全球经济不确定性 → 机构避险状态
    macroMaxAdjust: 10,     // 宏观状态因子最大修正（±分）
    maxTotalAdjust: 22      // 外围/风格/事件/宏观/涨停五项方向性修正合计上限（±分）
  },
  limitUp: {
    enabled: true,          // 涨停 / 炸板 / 跌停池采集 + 涨停结构因子 + K 线形态
    refreshMin: 3,          // 涨停池刷新间隔（分钟）；非交易时段当日缓存命中即复用，不发请求
    maxAdjust: 12,          // 涨停结构对个股评分的最大修正（±分）
    cycleEnabled: true      // 情绪周期系数：冰点/退潮期压低涨停强度加成，但不美化烂板
  },
  journal: {
    enabled: true,          // 评估数据库 / 经验库：定格 → 复盘 → 归纳 → 审核 → 回流
    openTime: '09:05',      // 开盘前定格（用于当日观察，09:05 已含美股隔夜收盘与亚太早盘）
    eveTime: '22:00',       // 收盘后定格（用于次日决策）
    reviewTime: '15:10',    // 复盘时点（收盘数据可用后回填 T+1 结果）
    liveEnabled: true,      // 实时观察池：盘中随评分滚动更新（不作为复盘基准）
    liveLimit: 12           // 实时池容量（6-30 只）
  },
  cycle: {
    enabled: true,          // 周期事件研究（事件前/中/后三段式超额收益）
    refreshMin: 360,        // 重建间隔（分钟），事件日历变化不频繁
    alertEnabled: true      // 临近高置信事件推送到告警流
  },
  flow: {
    enabled: true,          // 资金主体行为（龙虎榜席位 / 两融 / 大宗 / 股东户数），一年增量回填
    refreshMin: 5,          // 回填与刷新间隔（分钟）
    hfSeatMin: 20           // 高频游资门槛：一年上榜次数
  },
  riskoff: {
    enabled: true           // 资金避险识别（L1 轮动 / L2 风格 / L3 离场 / L4 离境）
  },
  edge: {
    enabled: true,          // 预期研究层：板块相对强弱 / 市值重估 / 板块阶段 / 多因素叠加
    refreshMin: 10,         // 重建间隔（分钟）；板块日 K 与阶段统计内部另有更长缓存
    valuationLimit: 30      // 市值重估候选展示上限
  },
  attribution: {
    enabled: true,          // 涨停/炸板事实卡：只陈列公告与新闻事实，不认定涨跌原因
    refreshMin: 360,        // 重建间隔（分钟）；内部对同一交易日另有 6 小时缓存
    maxStocks: 30,          // 每次最多扫描的涨停股数量（公告接口有限流，不宜全市场抓）
    gapMs: 1300             // 逐只抓公告的间隔毫秒；实测连发数次即被断开，不可调太小
  },
  technical: {
    enabled: true,          // P0 八项确定性技术因子（只读标注，不进 stocks.js 评分）
    refreshMin: 30          // 重建间隔（分钟）；模块内部另有 30 分钟日线缓存，重复调用不发请求
  },
  agent: {
    enabled: true,          // 智能体总开关：关掉后 8777 主服务照常运行（零 LLM）
    apiKey: '',             // DeepSeek API Key（只存在本文件，不进代码；形如 sk-xxx）
    model: 'deepseek-chat', // 非思考模型（结构化抽取禁用思考模式）；旧 ID 会退役，以官方列表为准
    baseUrl: 'https://api.deepseek.com',
    temperature: 0.3,       // 采样温度 0~2：越低越确定（设置面板可调）
    maxTokens: 1600,        // 单轮模型输出上限 tokens（设置面板可调）
    hermes: {                // v2 核心智能体桥接：Hermes Agent（WSL2）为核，DeepSeek 为底层模型
      enabled: true,
      backend: 'auto',       // auto=优先官方Hermes、失败降级DeepSeek；official=只用Hermes；deepseek=直连兜底
      officialUrl: 'http://127.0.0.1:8765', // WSL2 里 hermes_bridge.py 的监听地址
      model: 'hermes',       // Hermes 侧模型别名（Hermes 内部用 DeepSeek）
      timeoutMs: 60000,
      fallbackToDeepSeek: true, // Hermes 未就绪时自动降级，保证骨架能跑通
      contextModules: null  // null=注入全部数据快照；可指定 ['market','stocks','style'] 等
    },
    maxTokensPerDay: 200000, // 每日 token 软上限（约几毛钱量级），超限拒调防成本失控
    a1: {
      enabled: true,        // A1 公告解读：观察者新增公告 → R1 抽取 → 回写 feed + 高置信利空分流 Flag
      maxPerRun: 4          // 单轮最多解读条数（控制突发成本；公告多时分多轮消化）
    },
    a4: {
      enabled: true,        // A4 复盘二次处理：22:00 统计定格 → 人话日报 + 假说卡（每交易日一次）
      hour: '22:00'
    }
  },
  ic: {
    enabled: true,          // 评分有效性自检（Rank IC）：每日定格 → 前瞻收益 → IC 聚合 → 经验库
    snapshots: ['pm'],      // 定格时点：am(10:30) / pm(14:50) / close(15:05)
    horizons: [1, 3, 5, 10],// 前瞻窗口（交易日）
    rollDays: 20,           // 滚动聚合窗口（快照日数）
    minDays: 5,             // 出结论所需最少快照日
    keepDays: 400,          // 快照与标注保留天数
    maxLabelsPerTick: 60    // 单轮标注最多拉取的标的数（控制东财限流）
  },
  rules: {
    gold:   { enabled: true, upper: null,  lower: null,  movePct: 0.35, dayPct: 1.5,  moveBp: null, dayBp: null },
    xau:    { enabled: true, upper: null,  lower: null,  movePct: 0.35, dayPct: 1.5,  moveBp: null, dayBp: null },
    wti:    { enabled: true, upper: null,  lower: null,  movePct: 0.60, dayPct: 2.5,  moveBp: null, dayBp: null },
    brent:  { enabled: true, upper: null,  lower: null,  movePct: 0.60, dayPct: 2.5,  moveBp: null, dayBp: null },
    ust10y: { enabled: true, upper: null,  lower: null,  movePct: null, dayPct: null, moveBp: 4,    dayBp: 10 },
    ust2y:  { enabled: true, upper: null,  lower: null,  movePct: null, dayPct: null, moveBp: 5,    dayBp: 12 },
    ust30y: { enabled: true, upper: null,  lower: null,  movePct: null, dayPct: null, moveBp: 4,    dayBp: 10 },
    dxy:    { enabled: true, upper: null,  lower: null,  movePct: 0.25, dayPct: 0.8,  moveBp: null, dayBp: null },
    spread: { enabled: true, upper: null,  lower: null,  movePct: null, dayPct: null, moveBp: 6,    dayBp: 15 }
  }
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (patch === null) return null; // 显式 null 用于清空阈值，不能被默认值吞掉
  if (Array.isArray(base)) return Array.isArray(patch) ? patch.slice() : base;
  if (base === null || typeof base !== 'object' || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

function loadConfig() {
  ensureDir();
  try {
    if (!fs.existsSync(CONFIG_FILE)) return structuredClone(DEFAULT_CONFIG);
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return deepMerge(structuredClone(DEFAULT_CONFIG), raw);
  } catch (e) {
    console.error('[config] 配置读取失败，使用默认值:', e.message);
    return structuredClone(DEFAULT_CONFIG);
  }
}

function saveConfig(cfg) {
  ensureDir();
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

function loadState() {
  ensureDir();
  try {
    if (!fs.existsSync(STATE_FILE)) return { history: {}, seenNews: [], lastQuoteAt: 0, lastNewsAt: 0 };
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      history: s.history && typeof s.history === 'object' ? s.history : {},
      seenNews: Array.isArray(s.seenNews) ? s.seenNews : [],
      lastQuoteAt: s.lastQuoteAt || 0,
      lastNewsAt: s.lastNewsAt || 0
    };
  } catch (_) {
    return { history: {}, seenNews: [], lastQuoteAt: 0, lastNewsAt: 0 };
  }
}

function saveState(state) {
  ensureDir();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

function appendAlerts(alerts) {
  if (!alerts.length) return;
  ensureDir();
  try {
    fs.appendFileSync(ALERTS_FILE, alerts.map(a => JSON.stringify(a)).join('\n') + '\n', 'utf8');
  } catch (e) { console.error('[alerts] 日志写入失败:', e.message); }
}

function loadAlertHistory(limit = 200) {
  try {
    if (!fs.existsSync(ALERTS_FILE)) return [];
    const lines = fs.readFileSync(ALERTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

module.exports = {
  DEFAULT_CONFIG, loadConfig, saveConfig, loadState, saveState,
  appendAlerts, loadAlertHistory, deepMerge,
  DATA_DIR, CONFIG_FILE, STATE_FILE, ALERTS_FILE
};
