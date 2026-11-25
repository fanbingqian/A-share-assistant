'use strict';
/**
 * calendar-gate.js — 日程准入闸门 + 信源/真伪分级 + 智能体审查
 *
 * 【要解决的问题】
 *   future-events.js 原扫描器只要「抽到时间 + 命中影响词 + 命中预告词」就自动写入日历，
 *   导致「报道：英伟达在黄仁勋一事上立场反转，决策未征询公司高管」这类
 *   ① 已发生的转述报道 ② 含匿名信源爆料 ③ 人事/立场八卦 ④ 时间其实是回顾语境
 *   被伪造成「美股科技巨头财报（新闻线索 · 11-29）」塞进日程。
 *
 * 【三道关】
 *   ① 确定性准入闸门（本模块 checkAdmissibility）—— 零幻觉、fail-closed：
 *      必须是「未来待发生、时间绑定事件动作、来源可追溯、属可布局的市场事件」。
 *      任何一条不确定 → 不自动入历（review），明确违规 → 驳回（reject）。
 *   ② 信源 / 真伪分级 —— 程序【不做事实裁定】，只做可追溯分级：
 *      官方一手 / 权威媒体署名 / 转述援引 / 匿名信源 / 未知，
 *      并输出「建议核实途径」；匿名信源与未经证实细节一律标注，绝不冒充已确认。
 *   ③ 智能体审查 —— 只输出结构化【建议】：是否未来事件、时间是否属于事件、
 *      信源措辞、真伪风险、证伪/核实提示。智能体无权把 reject 升级为 admit；
 *      不可用时保留确定性结论并降级为 review。
 *
 * 【纪律】
 *   - 智能体不预判行情、不编造来源、不声称"已联网核实"；
 *   - 决策权 = 确定性规则 + 人工复核，AI 结论只是标注；
 *   - 所有判定都带 reasons / claims / verifyHints，可逐条追溯；
 *   - 驳回指纹落盘黑名单，防止下次定时扫描回写。
 *
 * 落盘：
 *   data/calendar/gate-review.json     待复核队列（含判定详情）
 *   data/calendar/gate-blacklist.json  驳回指纹（防回写）
 *   data/calendar/gate-cache.json      智能体审查结果缓存（按新闻指纹去重，控制成本）
 *   data/calendar/gate-evidence.json   外部核验证据卡（人工/会话检索所得，标注非自动能力）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = path.join(__dirname, '..', 'data', 'calendar');
const F_REVIEW = path.join(DIR, 'gate-review.json');
const F_BLACKLIST = path.join(DIR, 'gate-blacklist.json');
const F_CACHE = path.join(DIR, 'gate-cache.json');
const F_EVIDENCE = path.join(DIR, 'gate-evidence.json');

function readJson(f, d) { try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} return d; }
function writeJson(f, o) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = f + '.tmp';
  fs.writeFileSync(t, JSON.stringify(o, null, 2), 'utf8');
  fs.renameSync(t, f);
}
function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 12); }
function bjNow(ts = Date.now()) { return new Date(ts + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19); }
function s(v, n) { return String(v == null ? '' : v).slice(0, n || 200); }

/* ------------------------------ 词表与信号 ------------------------------ */

/** 已发生 / 回顾语境：出现这些词，说明文本在叙述过去，不是预告未来 */
const PAST_CONTEXT = /(上周|上月|此前|日前|日前|已于|已在|已于|曾经|曾|当时|此前|刚刚|此前|敲定|落定|尘埃落定|宣布了|公布了|发布了|披露了|完成了|结束了|开盘前|收盘后|事后|回顾|复盘|反转|此前|一度|了决定|作出决定|作出|通过了|获得通过|签署了|达成)/;
/** 强预告动词：只有「未来时间 + 这些动词」才算日程事件（时间必须绑定到动作） */
const STRONG_FORECAST = /(将于|定于|拟于|计划于|预计将于|预计在|将在|将召开|将举行|将披露|将公布|将发布|将出炉|将揭晓|将登场|将开幕|将生效|将实施|将上市|将申购|将到期|将于|届时|scheduled\s+to|is\s+due\s+to|set\s+to|will\s+(?:release|publish|report|announce|hold|testify|meet|unveil|launch))/i;
/** 事件动作：构成「可提前布局的日程事件」的动作词 */
const EVENT_ACTION = /(出席|参加|作证|听证|召开|举行|举办|开幕|发布|公布|披露|出炉|揭晓|揭幕|登场|上市|申购|到期|生效|实施|决议|表决|投票|数据|报告|财报|议案|会谈|会晤|签署|会议|论坛|峰会|听证会|表决|审议)/;
/** 传闻 / 未经证实 / 匿名信源 */
const ANONYMOUS = /(知情人士|不愿透露|匿名|消息人士|据.*?援引|据报道|据称|据悉|传闻|传言|网传|爆料|被曝|外媒称|有消息称|据.*?透露|people\s+familiar|sources\s+said|according\s+to\s+people|unnamed|anonymous)/i;
/** 转述 / 援引 / 编译（本身不是假，但需回溯原始出处） */
const RELAY = /(报道：|据.*?报道|援引|转述|编译|综合|据.*?消息|据.*?称|引述|的消息|「报道：」|快讯)/;
/** 观点 / 评论 / 立场 / 人事八卦 / 治理争议 —— 不是「未来确定时间事件」 */
const NON_EVENT = /(立场|反转|反转|未征询|不征求|决策未|改口|态度|表态|回应|否认|澄清|争议|质疑|批评|抗议|反弹|分析称|评论|认为|指出|暗示|料将|或成|恐|恐将|人事|复职|辞职|离职|卸任|任命|回归|重返|上任|婚外|绯闻|道歉|致歉|调查|听证会?质疑|治理|内讧|最后一刻|排除在外|排除|并不知情|不知情)/;
/** 公司公告 / 个股线索（沿用 news-flash.js 口径） */
const COMPANY_KW = /回购|增持|减持|停牌|复牌|中标|业绩预|解禁|分红|质押|重组|收购|公告|股份|股东|风险警示|\bST\b|股东大会|可转债|定增/;
/** 官方一手来源 */
const OFFICIAL_SOURCE = /(证监会|交易所|上交所|深交所|央行|人民银行|统计局|财政部|发改委|国务院|新华社|央视|人民日报|国新办|美联储|federalreserve|BLS|BEA|SEC|EDGAR|公司公告|官网|官方|新闻稿|投资者关系|investor|press\s+release|gov\.cn|sec\.gov|\.gov\b)/i;
/** 权威媒体（署名报道，非匿名转述） */
const AUTHORITATIVE = /(新华社|央视|央视新闻|人民日报|中新社|中国新闻网|路透|路透社|彭博|彭博社|Reuters|Bloomberg|华尔街见闻|财联社|第一财经|证券时报|上海证券报|经济观察|财新|21世纪|界面|每经|每日经济新闻|格隆汇|澎湃|光明网|央视财经)/;

/** 规范化 URL：修正源站常见的重复拼接（https://a.comhttps://a.com/x → https://a.com/x） */
function normalizeUrl(u) {
  if (!u) return null;
  let x = String(u).trim();
  // 形如 https://wallstreetcn.comhttps://wallstreetcn.com/livenews/xxx
  x = x.replace(/^(https?:\/\/[^/\s]+?)(https?:\/\/[^/\s]+)(\/.*)?$/i, (all, a, b, rest) => {
    // 两段主机名相同则只保留一段
    const hostA = a.replace(/^https?:\/\//i, ''), hostB = b.replace(/^https?:\/\//i, '');
    return (hostA === hostB ? a : b) + (rest || '');
  });
  return x || null;
}
/** 域名合法性：明显拼接错误的 URL 视为不可追溯（先规范化再判断） */
function urlUsable(u) {
  const x = normalizeUrl(u);
  if (!x) return false;
  if (!/^https?:\/\//i.test(x)) return false;
  if (/(https?:\/\/[^/\s]+)(https?:\/\/)/i.test(x)) return false;
  return true;
}

/* ------------------------------ 断言分类 ------------------------------ */

/**
 * 把一条新闻文本里出现的「断言类型」识别出来，供真伪分级与理由追溯。
 * 注意：这里识别的是【措辞信号】，不是事实裁定。
 */
function classifyClaims(text) {
  const t = String(text || '');
  const claims = [];
  if (ANONYMOUS.test(t)) claims.push({ type: 'anonymous-claim', label: '匿名信源 / 未经证实细节', weight: -3 });
  if (RELAY.test(t)) claims.push({ type: 'relay', label: '转述 / 援引报道，需回溯原始出处', weight: -1 });
  if (NON_EVENT.test(t)) claims.push({ type: 'opinion-or-personnel', label: '立场 / 表态 / 人事 / 治理叙事', weight: -3 });
  if (PAST_CONTEXT.test(t)) claims.push({ type: 'past-narrative', label: '已发生 / 回顾语境', weight: -2 });
  if (COMPANY_KW.test(t)) claims.push({ type: 'company-filing', label: '个股公告线索（非日程事件）', weight: -2 });
  if (STRONG_FORECAST.test(t) && EVENT_ACTION.test(t)) claims.push({ type: 'scheduled-action', label: '带预告动词的未来事件动作', weight: 3 });
  if (OFFICIAL_SOURCE.test(t)) claims.push({ type: 'official-source', label: '提及官方 / 一手来源', weight: 2 });
  return claims;
}

/** 信源分级：official > authoritative > relay > anonymous > unknown */
function classifySource(item, text) {
  const src = s(item && item.source, 60);
  const t = String(text || '');
  const tiers = [];
  if (ANONYMOUS.test(t)) tiers.push('anonymous');
  if (OFFICIAL_SOURCE.test(t) || OFFICIAL_SOURCE.test(src)) tiers.push('official');
  if (AUTHORITATIVE.test(t) || AUTHORITATIVE.test(src)) tiers.push('authoritative');
  if (RELAY.test(t)) tiers.push('relay');
  // 优先级：匿名 > 转述 > 官方 > 权威 > 未知（匿名措辞压过来源名，保守）
  const order = ['anonymous', 'relay', 'official', 'authoritative'];
  for (const x of order) if (tiers.includes(x)) return x;
  return src ? 'unknown' : 'unknown';
}

/* ------------------------------ 时间绑定判定 ------------------------------ */

/**
 * 判断抽到的时间是否「绑定在未来事件动作上」。
 * 关键：区分「将于12月3日出席听证会」（合格）与「上周日下午敲定 / 周一开盘前公布」（回顾，不合格）。
 * @param {string} text 新闻全文
 * @param {{dateConfidence:string, dateBasis:string, forecast:boolean}} hit
 */
function timeBinding(text, hit) {
  const t = String(text || '');
  const conf = hit && hit.dateConfidence;
  const basis = s(hit && hit.dateBasis, 80);
  const reasons = [];
  // 扫描器已在时间短语的局部窗口标注了时态，优先采信（比全文正则更精确）
  const localPast = !!(hit && hit.past);
  const localForecast = !!(hit && hit.forecastBound);
  // 明确日期（explicit）可信度更高；相对 / 窗口推算需要更严格的预告绑定
  const isExplicit = conf === 'explicit';
  const hasStrong = localForecast || STRONG_FORECAST.test(t);
  const hasAction = EVENT_ACTION.test(t);
  const inPastCtx = localPast || PAST_CONTEXT.test(t);
  // 相对时间词若出现在「上周日 / 此前 / 敲定」等回顾语境 → 判为过去时间
  const relativeInPast = (!isExplicit) && inPastCtx && !localForecast &&
    /周日|周[一二三四五六日天]|星期|明日|下周|月底|月末|下旬|中旬/.test(basis + t);

  let belongs = false, past = false;
  if (localPast) { past = true; reasons.push('时间短语的局部上下文含「上周 / 此前 / 敲定 / 决定」等回顾信号，指向已发生的事'); }
  else if (relativeInPast) { past = true; reasons.push('时间词处于「上周 / 此前 / 敲定」等回顾语境，指向过去而非未来'); }
  else if (isExplicit && hasStrong && hasAction) {
    belongs = true; reasons.push('明确日期 + 预告动词 + 事件动作，时间绑定成立');
  } else if (isExplicit && hasAction && !inPastCtx && !localPast) {
    belongs = true; reasons.push('明确日期 + 事件动作，且无回顾语境');
  } else if (!isExplicit && hasStrong && hasAction && !inPastCtx) {
    belongs = true; reasons.push('相对时间 + 强预告动词 + 事件动作，且无回顾语境');
  } else {
    reasons.push(isExplicit ? '有明确日期但缺少预告动词 / 事件动作绑定' : '相对或窗口推算时间，未绑定到预告动作，不足以构成确定日程');
  }
  return { belongs, past, isExplicit, hasStrong, hasAction, inPastCtx, localPast, localForecast, reasons };
}

/* ------------------------------ 准入判定（确定性硬闸门） ------------------------------ */

/**
 * 日程准入判定 —— 默认拒绝（fail-closed）。
 * @param {object} cand 候选：{ newsId, title, desc, source, url, publishedAt,
 *        date, dateBasis, dateConfidence, forecast, impacts:[], sectors:[], scanKey }
 * @returns {object} { decision:'admit'|'review'|'reject', eligible, isFutureEvent,
 *        timeBelongsToEvent, sourceTier, truthStatus, claims, reasons, verifyHints,
 *        fingerprint, checkedAt }
 */
function checkAdmissibility(cand) {
  const c = cand || {};
  const title = s(c.title, 200);
  const desc = s(c.desc, 400);
  const text = (title + ' ' + desc).trim();
  const source = s(c.source, 60);
  const impacts = Array.isArray(c.impacts) ? c.impacts : [];
  const claims = classifyClaims(text);
  const sourceTier = classifySource(c, text);
  const bind = timeBinding(text, c);
  const reasons = [];
  const verifyHints = [];
  const rejectHits = [];
  const reviewHits = [];
  const fingerprint = md5(title + '|' + source);

  // —— 硬驳回条件（任一命中即 reject）——
  // R1 已发生 / 回顾语境：时间在叙述过去，不是未来事件
  if (bind.past || (claims.some(x => x.type === 'past-narrative') && !bind.belongs)) {
    rejectHits.push('R1 已发生/回顾性报道：时间在叙述过去，不是未来待发生事件');
    reasons.push('文本含「上周 / 此前 / 敲定 / 反转 / 已公布」等回顾信号，不构成未来日程');
  }
  // R2 时间未绑定到未来事件动作（这条英伟达就是「周日」被凭空推算）
  if (!bind.belongs) {
    rejectHits.push('R2 时间未绑定预告动作：日期来自相对时间推算或回顾语境，不可作为日程日期');
    reasons.push(...bind.reasons);
  }
  // R3 立场 / 表态 / 人事 / 治理叙事，不是可提前布局的市场事件
  if (claims.some(x => x.type === 'opinion-or-personnel')) {
    rejectHits.push('R3 立场/表态/人事/治理类叙事：属于新闻评论范畴，不是「有确定时间的市场事件」');
    reasons.push('命中「立场反转 / 未征询 / 复职 / 回应 / 争议」等非事件措辞');
  }
  // R4 匿名信源 / 未经证实细节：真伪未定，禁止自动入历
  if (claims.some(x => x.type === 'anonymous-claim')) {
    rejectHits.push('R4 匿名信源或未经证实细节：官方未确认，真伪未定，不得自动入历');
    verifyHints.push('核对公司官网新闻稿 / SEC EDGAR 8-K / 交易所公告等一手来源；官方口径之外的细节一律标注「未证实」');
  }
  // R5 个股公告 / 公司线索：不是日程事件
  if (claims.some(x => x.type === 'company-filing') && !bind.belongs) {
    rejectHits.push('R5 个股公告线索（回购/增减持/停复牌等）：应在「公司公告」区展示，不入日程');
  }
  // R6 影响主题由「公司名」伪造（"英伟达" ≠ "财报事件"）：
  //   仅在候选被归为财报/业绩类、但全文无财报语义、且时间未绑定预告动作时成立。
  //   不可只看「标题含公司名」，否则会误伤「英伟达CEO将于12月3日出席听证会」这类真实合格事件。
  //   matchImpact() 已用 requireAlso 从源头收紧公司名规则，这里只作二次防御。
  const companyNameOnly = impacts.some(x => /财报|业绩/.test(String(x))) &&
    !/(财报|业绩|earnings|季报|年报|业绩说明会|公布业绩|发布财报)/i.test(text);
  if (companyNameOnly && !bind.belongs) {
    rejectHits.push('R6 影响主题仅由公司名命中：公司名不等于「财报/数据/会议」等事件，禁止据此伪造事件类别');
  }
  // R7 纯转述/援引且无一手来源线索
  if (sourceTier === 'relay' && !bind.belongs) {
    rejectHits.push('R7 转述报道且无一手来源、无未来事件绑定，按未核实线索处理');
  }

  // —— 需复核（不自动入历，但不直接驳回）——
  if (!urlUsable(c.url)) { reviewHits.push('来源链接缺失或格式异常，可追溯性不足'); verifyHints.push('补全可点击的原始新闻链接'); }
  if (!source) reviewHits.push('缺少来源署名');
  if (sourceTier === 'unknown') reviewHits.push('信源无法分级，需人工确认出处');
  if (!c.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(c.date))) reviewHits.push('缺少合法事件日期');
  if (!impacts.length) reviewHits.push('未命中明确的股市影响主题');
  if (c.dateConfidence === 'window' || c.dateConfidence === 'relative') {
    reviewHits.push('日期为相对/窗口推算，需以官方日历校准');
    verifyHints.push('以主办方官网 / 官方日历确认准确日期与时点');
  }

  let decision;
  if (rejectHits.length) decision = 'reject';
  else if (reviewHits.length) decision = 'review';
  else decision = 'admit';

  // 真伪状态：程序只做分级，不做事实裁定
  let truthStatus;
  if (claims.some(x => x.type === 'anonymous-claim')) truthStatus = 'anonymous-unverified';
  else if (claims.some(x => x.type === 'official-source')) truthStatus = 'official-firsthand-available';
  else if (sourceTier === 'authoritative' && claims.some(x => x.type === 'relay') === false) truthStatus = 'authoritative-report';
  else if (claims.some(x => x.type === 'relay')) truthStatus = 'media-relay';
  else truthStatus = 'ungraded';

  if (!verifyHints.length) {
    verifyHints.push('以官方公告 / 主办方日历 / 监管机构文件为最终口径；媒体转述与推算日期仅作线索');
  }

  return {
    decision,
    eligible: decision === 'admit',
    isFutureEvent: bind.belongs && !bind.past,
    timeBelongsToEvent: bind.belongs,
    timeSignals: { isExplicit: bind.isExplicit, hasStrong: bind.hasStrong, hasAction: bind.hasAction, inPastCtx: bind.inPastCtx, past: bind.past },
    sourceTier,
    truthStatus,
    claims,
    rejectHits,
    reviewHits,
    reasons: reasons.length ? reasons : (rejectHits.length ? rejectHits : (reviewHits.length ? reviewHits : ['全部准入检查通过'])),
    verifyHints,
    fingerprint,
    checkedAt: bjNow(),
    gateVersion: 'calendar-gate-v1',
    disclaimer: '程序仅做来源分级与措辞识别，不对消息真伪作事实裁定；匿名信源与推算日期一律标注未证实。'
  };
}

/* ------------------------------ 智能体审查 ------------------------------ */

const AI_SYSTEM_TASK = [
  '你是「日程准入审查员」。下面给你一批【新闻候选】，请逐条判断它是否够格写入股市日程，并给出真伪风险分级。',
  '',
  '【硬约束 · 必须遵守】',
  '1. 只依据给定文本的措辞与来源元数据判断，禁止编造事实、禁止补充你记忆中的外部信息、禁止声称"已联网核实"。',
  '2. 禁止预判行情、禁止给买卖建议或目标价。',
  '3. 你的结论只是【建议标注】，最终决策由确定性规则与人工复核决定；你无权把明确违规的条目判为可入历。',
  '4. 无法从文本判断时一律标 uncertain，不要猜测。',
  '',
  '【逐条输出字段】',
  '  key             : 原样回传候选的 key',
  '  isFutureEvent   : 是否为「未来待发生」事件（true/false/uncertain）',
  '  timeBelongsToEvent : 文本里的时间是否绑定在事件动作上，而非回顾已发生的事（true/false/uncertain）',
  '  sourceTier      : official / authoritative / relay / anonymous / unknown',
  '  truthRisk       : low（有一手来源线索）/ medium（署名媒体转述）/ high（匿名信源、传闻、未证实细节）',
  '  admitSuggestion : admit / review / reject（建议；reject 表示不应入历）',
  '  reason          : 一句话理由，须引用文本里的具体措辞',
  '  verifyHint      : 建议核实途径（官方公告/主办方日历/监管文件等），不要编造具体链接',
  '',
  '【输出格式】只输出一个 JSON 数组，不要任何解释文字、不要 markdown 代码块围栏。'
].join('\n');

function extractJsonArray(text) {
  const t = String(text || '');
  const cleaned = t.replace(/```json/gi, '').replace(/```/g, '').trim();
  let m = cleaned.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a : null; } catch (_) { return null; }
}

/**
 * 智能体批量审查。只审查「确定性规则未直接驳回」的候选，控制 token；
 * 结果按指纹缓存，避免定时扫描重复烧 token。
 * @returns {Promise<{ok:boolean, reviewed:number, backend:string|null, items:object[], error?:string, skipped?:boolean}>}
 */
async function aiReview(cfg, hermes, candidates, opts = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  if (!list.length) return { ok: true, reviewed: 0, backend: null, items: [], skipped: true };
  if (opts.noAI === true) return { ok: true, reviewed: 0, backend: null, items: [], skipped: true, reason: '按请求跳过智能体' };
  if (!hermes || typeof hermes.ask !== 'function') {
    return { ok: false, reviewed: 0, backend: null, items: [], error: '智能体模块不可用' };
  }

  const cache = readJson(F_CACHE, {}) || {};
  const maxAge = 7 * 24 * 3600e3;
  const now = Date.now();
  const fresh = [], cached = [];
  for (const c of list) {
    const fp = c.fingerprint || md5(s(c.title) + '|' + s(c.source));
    const hit = cache[fp];
    if (hit && (now - (hit.ts || 0)) < maxAge) cached.push({ ...hit.value, key: c.key, cached: true });
    else fresh.push({ ...c, fingerprint: fp });
  }
  if (!fresh.length) return { ok: true, reviewed: 0, backend: 'cache', items: cached, skipped: false };

  const payload = fresh.map(c => ({
    key: c.key || c.newsId || c.fingerprint,
    title: s(c.title, 160),
    desc: s(c.desc, 260),
    source: s(c.source, 40),
    hasUrl: urlUsable(c.url),
    publishedAt: c.publishedAt || null,
    extractedDate: c.date || null,
    dateBasis: s(c.dateBasis, 90),
    dateConfidence: c.dateConfidence || null,
    impacts: (c.impacts || []).slice(0, 6),
    ruleDecision: c.rule && c.rule.decision ? c.rule.decision : null,
    ruleRejectHits: c.rule && c.rule.rejectHits ? c.rule.rejectHits.slice(0, 4) : []
  }));

  const q = AI_SYSTEM_TASK + '\n\n【候选 JSON】\n' + JSON.stringify(payload, null, 1);
  let r;
  try {
    r = await hermes.ask(cfg, 'calendar-gate', q, {
      task: '日程候选准入与真伪风险审查（结构化标注，不预判行情）',
      maxTokens: 1600, temperature: 0
    });
  } catch (e) {
    return { ok: false, reviewed: 0, backend: null, items: cached, error: e.message };
  }
  if (!r || !r.ok || !r.text) {
    return { ok: false, reviewed: 0, backend: null, items: cached, error: (r && r.error) || '智能体未返回结果' };
  }
  const arr = extractJsonArray(r.text);
  if (!arr) {
    return { ok: false, reviewed: 0, backend: r.backend || null, items: cached, error: '智能体输出非合法 JSON，已忽略（fail-closed）' };
  }
  const byKey = new Map(arr.map(x => [String(x && x.key), x]));
  const items = [];
  for (const c of fresh) {
    const a = byKey.get(String(c.key || c.newsId || c.fingerprint)) || {};
    const value = {
      key: c.key || c.newsId || c.fingerprint,
      isFutureEvent: a.isFutureEvent === true ? true : (a.isFutureEvent === false ? false : 'uncertain'),
      timeBelongsToEvent: a.timeBelongsToEvent === true ? true : (a.timeBelongsToEvent === false ? false : 'uncertain'),
      sourceTier: ['official', 'authoritative', 'relay', 'anonymous', 'unknown'].includes(a.sourceTier) ? a.sourceTier : 'unknown',
      truthRisk: ['low', 'medium', 'high'].includes(a.truthRisk) ? a.truthRisk : 'high',
      admitSuggestion: ['admit', 'review', 'reject'].includes(a.admitSuggestion) ? a.admitSuggestion : 'review',
      reason: s(a.reason, 200) || '智能体未给出理由',
      verifyHint: s(a.verifyHint, 200),
      reviewedAt: bjNow(),
      backend: r.backend || 'hermes'
    };
    cache[c.fingerprint] = { ts: now, value };
    items.push(value);
  }
  writeJson(F_CACHE, cache);
  return { ok: true, reviewed: items.length, backend: r.backend || 'hermes', items: items.concat(cached), skipped: false };
}

/**
 * 合并「确定性闸门结论」与「智能体建议」，产出最终决策。
 * 纪律：AI 无权把 reject 升级为 admit；AI 判 reject/high-risk 可把 admit 降级为 review。
 */
function mergeDecision(rule, ai) {
  const out = { ...rule, ai: null, finalDecision: rule.decision };
  if (!ai) { out.finalDecision = rule.decision === 'admit' ? 'review' : rule.decision; out.ai = { reviewed: false, note: '智能体未审查，自动入历项保守降级为待复核' }; return out; }
  out.ai = { reviewed: true, ...ai };
  if (rule.decision === 'reject') { out.finalDecision = 'reject'; return out; }
  if (ai.admitSuggestion === 'reject' || ai.truthRisk === 'high' || ai.isFutureEvent === false || ai.timeBelongsToEvent === false) {
    out.finalDecision = 'review';
    out.reviewHits = (out.reviewHits || []).concat('智能体审查：' + (s(ai.reason, 80) || '判定不宜自动入历'));
  } else if (ai.admitSuggestion === 'review') {
    if (out.finalDecision === 'admit') out.finalDecision = 'review';
  }
  return out;
}

/**
 * 同步读取已缓存的智能体审查结论（供每小时定时扫描使用，避免每次都调模型）。
 * 未命中 / 已过期的候选不返回，由调用方按 fail-closed 降级为待复核。
 * 手动扫描走 scanAsync() → aiReview() 实时审查，结果同样写回这份缓存。
 * @param {object[]} list 候选（需带 fingerprint 或 title+source）
 * @returns {object[]} 命中缓存的审查项
 */
function cachedReviews(list, maxAgeMs = 7 * 24 * 3600e3) {
  const cache = readJson(F_CACHE, {}) || {};
  const now = Date.now();
  const items = [];
  for (const c of (Array.isArray(list) ? list : [])) {
    if (!c) continue;
    const fp = c.fingerprint || md5(s(c.title) + '|' + s(c.source));
    const hit = cache[fp];
    if (!hit || !hit.value || (now - (hit.ts || 0)) >= maxAgeMs) continue;
    items.push({ ...hit.value, key: c.key || c.newsId || fp, cached: true });
  }
  return items;
}

/* ------------------------------ 复核队列 / 黑名单 / 证据 ------------------------------ */

function loadBlacklist() { return readJson(F_BLACKLIST, { items: [] }) || { items: [] }; }
function fingerprintOf(c) { return c && (c.fingerprint || md5(s(c.title) + '|' + s(c.source))); }
function isBlacklisted(c) {
  const b = loadBlacklist();
  const fp = fingerprintOf(c);
  return (b.items || []).some(x => x.fingerprint === fp || (x.scanKey && x.scanKey === c.scanKey));
}
function addBlacklist(entries) {
  const b = loadBlacklist();
  const seen = new Set((b.items || []).map(x => x.fingerprint));
  for (const e of (entries || [])) {
    const fp = fingerprintOf(e);
    if (seen.has(fp)) continue;
    seen.add(fp);
    (b.items = b.items || []).push({
      fingerprint: fp, scanKey: e.scanKey || null,
      title: s(e.title, 120), source: s(e.source, 40),
      reason: s((e.rule && e.rule.rejectHits || []).join('；') || e.reason, 240),
      rejectedAt: bjNow(), rejectedBy: e.rejectedBy || 'gate-rule'
    });
  }
  b.updatedAt = bjNow();
  writeJson(F_BLACKLIST, b);
  return b;
}
function removeBlacklist(fp) {
  const b = loadBlacklist();
  const n = (b.items || []).length;
  b.items = (b.items || []).filter(x => x.fingerprint !== fp);
  writeJson(F_BLACKLIST, b);
  return { ok: true, removed: n - b.items.length };
}

function loadReview() { return readJson(F_REVIEW, { items: [] }) || { items: [] }; }
function saveReview(items, summary) {
  const out = {
    ok: true, generatedAt: bjNow(),
    summary: summary || {},
    items: (items || []).slice(0, 120).map(x => ({
      scanKey: x.scanKey || null, key: x.key || null,
      title: s(x.title, 140), source: s(x.source, 40), url: x.url ? s(x.url, 240) : null,
      date: x.date || null, dateBasis: s(x.dateBasis, 90),
      impacts: (x.impacts || []).slice(0, 6), sectors: (x.sectors || []).slice(0, 8),
      decision: x.finalDecision || (x.rule && x.rule.decision) || 'review',
      sourceTier: (x.rule && x.rule.sourceTier) || null,
      truthStatus: (x.rule && x.rule.truthStatus) || null,
      reasons: ((x.rule && x.rule.rejectHits) || []).concat((x.rule && x.rule.reviewHits) || []).slice(0, 8),
      verifyHints: (x.rule && x.rule.verifyHints) || [],
      ai: x.ai || null,
      fingerprint: fingerprintOf(x)
    })),
    disclaimer: '待复核条目均未自动写入日程；智能体结论仅为建议标注，最终由确定性规则与人工复核决定。'
  };
  writeJson(F_REVIEW, out);
  return out;
}

/** 人工复核：放行（加入白名单豁免）或驳回（加入黑名单） */
function decideReview({ fingerprint, action, by }) {
  const rv = loadReview();
  const item = (rv.items || []).find(x => x.fingerprint === fingerprint);
  if (!item) return { ok: false, error: '未找到该复核条目' };
  if (action === 'reject') {
    addBlacklist([{ fingerprint, title: item.title, source: item.source, scanKey: item.scanKey, rule: { rejectHits: item.reasons }, rejectedBy: 'human:' + (by || 'user') }]);
    rv.items = rv.items.filter(x => x.fingerprint !== fingerprint);
    writeJson(F_REVIEW, rv);
    return { ok: true, action: 'reject', fingerprint, note: '已加入驳回黑名单，后续扫描不再回写' };
  }
  if (action === 'admit') {
    // 人工放行：立即写入日历（不等下次扫描 —— 新闻可能已从内存过期），
    // 同时写豁免白名单，保证后续扫描再遇到同一指纹也直接放行。
    const date = String(item.date || '');
    let calendarWritten = false, writeError = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      try {
        const cal = require('./calendar');
        const primary = (Array.isArray(item.impacts) && item.impacts[0]) || '市场事件';
        const scanKey = item.scanKey || ('gate-admit-' + md5(s(item.title) + '|' + date));
        cal.upsertEvent({
          scanKey, id: 'FE-G-' + md5(scanKey), date,
          name: primary + '（人工复核放行 · ' + date.slice(5) + '）',
          grade: 'B', category: '人工复核放行事件',
          detail: '新闻线索：' + s(item.title, 130) + '（来源 ' + s(item.source, 40) + '）。时间依据：' +
            s(item.dateBasis || '见复核记录', 120) + '。' +
            ' 【本条由人工在准入复核台放行；程序不对消息真伪作事实裁定，请以官方公告为最终口径。】',
          sectors: Array.isArray(item.sectors) ? item.sectors.slice(0, 12) : [],
          source: 'gate-human-admit',
          confirmLevel: 'human-reviewed', dateBasis: item.dateBasis || null,
          verified: false,
          newsRef: { title: item.title, source: item.source, url: item.url || null, newsId: null },
          gate: {
            decision: 'admit', ruleDecision: item.decision || 'review',
            sourceTier: item.sourceTier || null, truthStatus: item.truthStatus || null,
            humanAdmitted: true, aiReviewed: !!(item.ai && item.ai.reviewed),
            checkedAt: bjNow(), gateVersion: 'calendar-gate-v1',
            label: '人工复核放行（智能体建议仅作参考）'
          }
        });
        calendarWritten = true;
      } catch (e) { writeError = e.message; }
    } else writeError = '复核条目缺少合法日期，无法写入日历';
    const wl = readJson(path.join(DIR, 'gate-whitelist.json'), { items: [] }) || { items: [] };
    if (!(wl.items || []).some(x => x.fingerprint === fingerprint)) {
      (wl.items = wl.items || []).push({ fingerprint, title: item.title, source: item.source, admittedAt: bjNow(), by: by || 'user' });
      writeJson(path.join(DIR, 'gate-whitelist.json'), wl);
    }
    rv.items = rv.items.filter(x => x.fingerprint !== fingerprint);
    writeJson(F_REVIEW, rv);
    return {
      ok: true, action: 'admit', fingerprint, calendarWritten, writeError,
      note: calendarWritten ? '已由人工复核放行并写入日程，同时加入豁免白名单防再次拦截' : '已加入豁免白名单，但未能写入日历：' + (writeError || '未知原因')
    };
  }
  return { ok: false, error: 'action 应为 admit 或 reject' };
}
function isWhitelisted(c) {
  const wl = readJson(path.join(DIR, 'gate-whitelist.json'), { items: [] }) || { items: [] };
  return (wl.items || []).some(x => x.fingerprint === fingerprintOf(c));
}

/* ------------------------------ 外部核验证据卡 ------------------------------ */

/**
 * 保存一条「外部核验证据卡」。
 * 重要：这类证据来自人工 / 会话中的外部检索，不是系统自动联网能力，必须标注 sourceMode。
 * @param {object} e { claim, verdict, officialSources:[{name,url,date,quote}], mediaRelay:[], unverifiedDetails:[], note }
 */
function saveEvidence(e) {
  const all = readJson(F_EVIDENCE, { items: [] }) || { items: [] };
  const row = {
    id: 'EV-' + md5(s(e && e.claim) + bjNow()),
    claim: s(e && e.claim, 220),
    verdict: s(e && e.verdict, 120),
    officialSources: (e && Array.isArray(e.officialSources) ? e.officialSources : []).slice(0, 8).map(x => ({ name: s(x.name, 80), url: s(x.url, 240), date: s(x.date, 40), quote: s(x.quote, 260) })),
    mediaRelay: (e && Array.isArray(e.mediaRelay) ? e.mediaRelay : []).slice(0, 8).map(x => ({ name: s(x.name, 80), url: s(x.url, 240) })),
    unverifiedDetails: (e && Array.isArray(e.unverifiedDetails) ? e.unverifiedDetails : []).slice(0, 8).map(x => s(x, 200)),
    note: s(e && e.note, 400),
    sourceMode: 'external-human-research',
    sourceModeLabel: '外部检索（人工/会话），非系统自动联网核验',
    verifiedAt: bjNow(),
    disclaimer: '证据卡仅记录可追溯来源与口径差异，不构成投资建议；官方公告为最终口径。'
  };
  (all.items = all.items || []).unshift(row);
  all.items = all.items.slice(0, 60);
  all.updatedAt = bjNow();
  writeJson(F_EVIDENCE, all);
  return row;
}
function listEvidence() { return readJson(F_EVIDENCE, { items: [] }) || { items: [] }; }

/* ------------------------------ 存量误入历清理 ------------------------------ */

/**
 * 回溯清理：对 data/calendar/events.jsonl 里 source==='news-scan' 的事件重新过闸门，
 * 把明确驳回（reject）的移除，并写入黑名单防止下次扫描回写。
 * @param {{dryRun?:boolean, backup?:boolean}} opts
 */
function purgeMisentries(opts = {}) {
  const cal = require('./calendar');
  const USER_FILE = cal.USER_FILE;
  const rows = cal.readUserEvents();
  const scanned = rows.filter(r => r.source === 'news-scan');
  const removed = [], kept = [], rejected = [];
  for (const e of scanned) {
    const ref = e.newsRef || {};
    const cand = {
      newsId: ref.newsId || null,
      title: s(ref.title || e.name, 200),
      desc: s(e.detail, 400),
      source: s(ref.source || e.source, 60),
      url: ref.url || null,
      publishedAt: ref.publishedAt || null,
      date: e.date,
      dateBasis: e.dateBasis || null,
      dateConfidence: /explicit/.test(String(e.confirmLevel || '')) ? 'explicit' : (/window/.test(String(e.confirmLevel || '')) ? 'window' : 'relative'),
      forecast: true,
      impacts: [s(String(e.name || '').replace(/（.*?）/g, ''), 60)].filter(Boolean),
      sectors: e.sectors || [],
      scanKey: e.scanKey || null
    };
    const rule = checkAdmissibility(cand);
    if (rule.decision === 'reject') { removed.push({ id: e.id, scanKey: e.scanKey, name: e.name, date: e.date, reasons: rule.rejectHits }); rejected.push({ ...cand, rule, scanKey: e.scanKey }); }
    else kept.push({ id: e.id, name: e.name, decision: rule.decision });
  }
  const result = {
    ok: true,
    dryRun: !!opts.dryRun,
    scannedNewsEvents: scanned.length,
    toRemove: removed.length,
    removed,
    kept: kept.length,
    keptList: kept.slice(0, 40),
    backup: null
  };
  if (!opts.dryRun) {
    const drop = new Set(removed.map(x => x.id));
    let remain = rows.filter(r => !drop.has(r.id));
    // 给「回溯复核后保留」的存量 news-scan 事件补上标注，避免前端出现无标签的裸数据。
    // 注意：这不改变事件本身，只是如实记录它经过新闸门复核且未命中驳回项。
    const keptDecisions = new Map(kept.map(x => [x.id, x.decision]));
    let annotated = 0;
    remain = remain.map(r => {
      if (r.source !== 'news-scan' || r.gate) return r;
      annotated++;
      return { ...r, gate: {
        decision: 'legacy-retained',
        ruleDecision: keptDecisions.get(r.id) || 'unknown',
        sourceTier: null, truthStatus: 'legacy-ungraded',
        aiReviewed: false, humanAdmitted: false,
        checkedAt: bjNow(), gateVersion: 'calendar-gate-v1',
        label: '存量事件 · 已按新闸门回溯复核（未命中驳回项）'
      } };
    });
    result.annotated = annotated;
    if (removed.length || annotated) {
      // 任何实际改写都先备份
      if (opts.backup !== false && fs.existsSync(USER_FILE)) {
        const bak = USER_FILE + '.bak-' + Date.now();
        fs.copyFileSync(USER_FILE, bak);
        result.backup = path.basename(bak);
      }
      fs.mkdirSync(DIR, { recursive: true });
      const t = USER_FILE + '.tmp';
      fs.writeFileSync(t, remain.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      fs.renameSync(t, USER_FILE);
      if (removed.length) addBlacklist(rejected.map(x => ({ ...x, reason: (x.rule.rejectHits || []).join('；'), rejectedBy: 'purge-rule' })));
      result.applied = true;
    }
  }
  return result;
}

/* ------------------------------ 状态 ------------------------------ */

function status() {
  const rv = loadReview();
  const bl = loadBlacklist();
  const ev = listEvidence();
  return {
    ok: true, gateVersion: 'calendar-gate-v1',
    reviewPending: (rv.items || []).length,
    reviewGeneratedAt: rv.generatedAt || null,
    blacklisted: (bl.items || []).length,
    evidenceCards: (ev.items || []).length,
    files: { review: F_REVIEW, blacklist: F_BLACKLIST, cache: F_CACHE, evidence: F_EVIDENCE }
  };
}

module.exports = {
  checkAdmissibility, classifyClaims, classifySource, timeBinding, urlUsable, normalizeUrl,
  aiReview, cachedReviews, mergeDecision, extractJsonArray,
  isBlacklisted, isWhitelisted, addBlacklist, removeBlacklist,
  loadReview, saveReview, decideReview, loadBlacklist,
  saveEvidence, listEvidence,
  purgeMisentries, status,
  fingerprintOf,
  F_REVIEW, F_BLACKLIST, F_CACHE, F_EVIDENCE
};
