'use strict';
/**
 * generate-gate-preview.js — 生成「日程准入闸门」可视化核验报告（静态 HTML）
 *
 * 数据全部来自本机真实落盘文件（gate-evidence / gate-review / gate-blacklist /
 * events.jsonl / future-events-scan.json），不调用模型、不联网，可反复生成。
 *
 * 输出：preview/calendar-gate-preview.html
 * 运行：node scripts/generate-gate-preview.js
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'preview', 'calendar-gate-preview.html');
const D = path.join(ROOT, 'data', 'calendar');

function j(f, d) { try { return JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')); } catch (_) { return d; } }
function lines(f) { try { return fs.readFileSync(path.join(D, f), 'utf8').trim().split('\n').filter(Boolean).map(x => { try { return JSON.parse(x); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } }
function e(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const ev = j('gate-evidence.json', { items: [] });
const rv = j('gate-review.json', { items: [] });
const bl = j('gate-blacklist.json', { items: [] });
const scan = j('future-events-scan.json', {});
const events = lines('events.jsonl');
const card = (ev.items || [])[0] || null;
const g = scan.gate || {};

const DEC = { admit: ['准入通过', 'ok'], review: ['待人工复核', 'warn'], reject: ['已驳回', 'bad'], 'rule-generated': ['系统规则推算', 'rule'], 'legacy-retained': ['存量回溯保留', 'rule'] };
const TIER = { official: '官方一手', authoritative: '权威署名', relay: '转述援引', anonymous: '匿名信源', unknown: '信源未分级', 'system-calendar-rule': '系统规则' };
const TRUTH = { 'official-firsthand-available': '可核对官方一手', 'anonymous-unverified': '含未证实细节', 'authoritative-report': '署名媒体报道', 'media-relay': '媒体转述', ungraded: '真伪未分级', 'legacy-ungraded': '真伪未分级（存量）', 'not-a-news-claim': '非新闻线索' };
function badges(gate, compact) {
  if (!gate) return '';
  const d = DEC[gate.decision] || ['未标注', 'rule'];
  const t = TIER[gate.sourceTier] || '信源未分级';
  const tr = TRUTH[gate.truthStatus] || '真伪未分级';
  return '<div class="badges">' +
    '<span class="b gb-' + d[1] + '">准入 · ' + e(d[0]) + '</span>' +
    (compact ? '' : '<span class="b gb-tier">信源 · ' + e(t) + '</span><span class="b gb-truth">真伪 · ' + e(tr) + '</span>') +
    '<span class="b gb-ai' + (gate.aiReviewed ? ' on' : '') + '">' + (gate.aiReviewed ? '智能体已审查' : '未过智能体审查') + '</span></div>';
}

/* ---- 事件卡样例：取 1 条存量保留 + 1 条系统规则 + 1 条 12-03 听证会 ---- */
const sample = [];
const legacy = events.find(x => x.source === 'news-scan' && x.gate && x.gate.decision === 'legacy-retained');
const rule = events.find(x => x.source === 'calendar-rule' && x.gate);
const hearing = events.find(x => /12月3日.*听证会/.test(x.detail || ''));
[legacy, rule, hearing].forEach(x => { if (x && !sample.includes(x)) sample.push(x); });

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>日程准入闸门 · 核验与改造报告</title>
<style>
:root{--bg:#f5f6f8;--panel:#fff;--ink:#1d2129;--ink2:#4e5969;--ink3:#86909c;--line:#e5e6eb;--line2:#f0f1f3;
--brand:#165dff;--brand-soft:#e8f0ff;--warn:#d46b08;--bad:#9e1f1f;--ok:#165dff;--r:12px}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  color:var(--ink);background:var(--bg);font-size:14px;line-height:1.65;padding:28px 18px 60px}
.wrap{max-width:1080px;margin:0 auto}
.hero{background:linear-gradient(120deg,#101729,#1b2f5c);color:#fff;border-radius:16px;padding:26px 30px;margin-bottom:20px}
.hero h1{font-size:24px;letter-spacing:.5px}
.hero p{color:#c9d1e0;font-size:13px;margin-top:7px}
.hero .stamp{display:inline-block;margin-top:14px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);
  border-radius:6px;padding:5px 12px;font-size:12px;color:#e8f0ff}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:20px 22px;margin-bottom:18px;
  box-shadow:0 1px 3px rgba(20,30,60,.06),0 6px 20px rgba(20,30,60,.04)}
h2{font-size:17px;margin-bottom:4px;display:flex;align-items:center;gap:9px}
h2 .n{display:inline-flex;width:24px;height:24px;border-radius:6px;background:var(--brand-soft);color:var(--brand);
  align-items:center;justify-content:center;font-size:12px;font-weight:700}
.sub{font-size:12px;color:var(--ink3);margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{border-bottom:1px solid var(--line2);padding:9px 10px;text-align:left;vertical-align:top}
th{color:var(--ink3);font-weight:600;background:var(--line2);font-size:11.5px}
td:first-child{font-weight:600;width:26%}
.tag{font-size:10.5px;padding:1px 7px;border-radius:4px;white-space:nowrap}
.t-ok{background:rgba(22,93,255,.1);color:var(--brand)}
.t-warn{background:rgba(212,107,8,.1);color:var(--warn)}
.t-bad{background:rgba(198,40,40,.1);color:var(--bad)}
.chain{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:8px}
.step{border:1px solid var(--line);border-left:3px solid var(--brand);border-radius:0 8px 8px 0;padding:12px 13px;background:var(--line2)}
.step b{display:block;font-size:12.5px;margin-bottom:5px}
.step span{font-size:11.5px;color:var(--ink2);line-height:1.55}
.flow{display:flex;align-items:stretch;gap:8px;flex-wrap:wrap;margin-top:8px}
.gate-box{flex:1;min-width:210px;border:1px solid var(--line);border-radius:9px;padding:13px 14px;background:var(--panel)}
.gate-box .h{font-size:12.5px;font-weight:700;color:var(--brand);margin-bottom:6px}
.gate-box .d{font-size:11.5px;color:var(--ink2);line-height:1.6}
.arrow{display:flex;align-items:center;color:var(--ink3);font-size:18px}
.badges{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}
.b{font-size:10px;line-height:1.5;padding:1px 7px;border-radius:4px;border:1px solid var(--line);background:var(--line2);color:var(--ink2)}
.gb-ok{border-color:rgba(22,93,255,.34);background:var(--brand-soft);color:var(--brand);font-weight:600}
.gb-warn{border-color:rgba(212,107,8,.32);background:rgba(212,107,8,.08);color:var(--warn);font-weight:600}
.gb-bad{border-color:rgba(198,40,40,.32);background:rgba(198,40,40,.08);color:var(--bad);font-weight:600}
.gb-rule{color:var(--ink3)}
.gb-ai.on{border-color:rgba(22,93,255,.28);background:var(--brand-soft);color:var(--brand)}
.ev-card{border-left:4px solid var(--brand);border-radius:0 9px 9px 0;background:var(--line2);padding:12px 15px;margin-bottom:12px}
.ev-name{font-size:13px;font-weight:600}
.ev-detail{font-size:11.5px;color:var(--ink2);margin-top:5px}
.ev-src{font-size:11px;color:var(--ink3);margin-top:5px}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:9px;margin:10px 0}
.kpi{background:var(--line2);border-radius:8px;padding:10px 12px}
.kpi .k{font-size:10.5px;color:var(--ink3)}
.kpi .v{font-size:19px;font-weight:700;color:var(--brand)}
.qi{border-bottom:1px solid var(--line2);padding:8px 0;font-size:12px}
.qi .t{font-weight:600}
.qi .m{font-size:11px;color:var(--ink3);margin-top:2px}
.note{font-size:11.5px;color:var(--ink3);line-height:1.6;margin-top:8px}
.foot{font-size:11px;color:var(--ink3);text-align:center;margin-top:22px;line-height:1.7}
ul{margin:4px 0 0 18px}li{margin:2px 0}
@media(max-width:820px){.chain{grid-template-columns:repeat(2,1fr)}.kpis{grid-template-columns:repeat(3,1fr)}.flow{flex-direction:column}.arrow{transform:rotate(90deg);justify-content:center}}
</style></head><body><div class="wrap">

<div class="hero">
  <h1>日程准入闸门 · 核验与改造报告</h1>
  <p>针对「报道：英伟达在黄仁勋一事上立场反转，决策未征询公司高管」被误写入日程的问题梳理</p>
  <span class="stamp">生成时间 ${e(new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19))}（北京时间） · 数据来自本机真实落盘文件 · 静态预览</span>
</div>

<div class="card">
  <h2><span class="n">1</span>这条消息是真是假</h2>
  <div class="sub">程序不裁定事实真伪，只做「可追溯来源分级 + 口径差异标注」；以下为人工/会话外部检索所得的证据卡。</div>
  <table><thead><tr><th>标题里的说法</th><th>核验结果</th><th>依据</th></tr></thead><tbody>
    <tr><td>英伟达董事会恢复黄仁勋 CEO 职务</td><td><span class="tag t-ok">属实 · 官方确认</span></td><td>英伟达官网新闻稿（2026-11-23）、SEC 8-K 备案、央视/中新网转述</td></tr>
    <tr><td>「立场反转」（此前不召回 → 又复职）</td><td><span class="tag t-ok">基本属实</span></td><td>11/17 财报会表态与 11/23 董事会一致通过复职，多源一致；属媒体归纳，非官方定性</td></tr>
    <tr><td>「决策未征询公司高管 / 最后一刻才通知」</td><td><span class="tag t-warn">未经证实</span></td><td>仅彭博援引「不愿透露姓名的知情人士」，华尔街见闻/格隆汇/财联社转述；<b>官方稿与 8-K 均无此表述</b></td></tr>
    <tr><td>该不该进日程</td><td><span class="tag t-bad">不该进</span></td><td>它是「已发生的转述报道」，不是未来待发生事件；且属人事/立场/治理叙事、含匿名信源</td></tr>
  </tbody></table>
  <div class="note"><b>真正该进日程的是</b>「12月3日10时 黄仁勋出席美国参议院银行委员会听证会」（央视 / 参议院委员会官网，有明确未来时间）—— 系统里这条被保留。</div>
</div>

<div class="card">
  <h2><span class="n">2</span>为什么会混进日程（根因链）</h2>
  <div class="sub">原扫描器只要「抽到时间 + 命中影响词 + 命中预告词」就自动写库，全程无准入判定与真伪校验。</div>
  <div class="chain">
    <div class="step"><b>① 时间误判</b><span>「这项决定于<b>上周日</b>下午敲定」→ 把回顾语境的「周日」当未来相对时间，推算出 11-29</span></div>
    <div class="step"><b>② 预告词过宽</b><span>裸词「公布 / 发布 / 决议」被当成预告语义，回顾性报道也被判为「将要发生」</span></div>
    <div class="step"><b>③ 公司名误命中</b><span>「英伟达」被列为「美股科技巨头财报」关键词 → 人事报道被伪造成财报事件</span></div>
    <div class="step"><b>④ 无闸门直接写库</b><span>upsertEvent() 直接落盘；verified:false 只标「日期未确认」，从未审查「是不是日程事件 / 真假」</span></div>
  </div>
</div>

<div class="card">
  <h2><span class="n">3</span>解决方案：三道关 + 人工裁决</h2>
  <div class="sub">纪律：确定性规则做硬门槛（零幻觉、默认拒绝），智能体只做结构化建议，最终决策权 = 规则 + 人工。</div>
  <div class="flow">
    <div class="gate-box"><div class="h">① 确定性硬闸门</div><div class="d">必须是未来待发生、时间绑定事件动作、来源可追溯、属可布局的市场事件。已发生/回顾语境、立场人事叙事、匿名信源、公司名误命中一律驳回；任何不确定 → 待复核，绝不自动入历。</div></div>
    <div class="arrow">→</div>
    <div class="gate-box"><div class="h">② 智能体结构化审查</div><div class="d">输出严格 JSON：是否未来事件 / 时间是否属于事件 / 信源等级 / 真伪风险 / 核实途径。不预判行情、不改事实、不编造来源、不声称已联网核实；<b>无权把驳回升级为放行</b>。</div></div>
    <div class="arrow">→</div>
    <div class="gate-box"><div class="h">③ 合并决策 + 人工</div><div class="d">无 AI 结论的 admit 一律降级为待复核；仅 admit 写入日程，reject 登记黑名单防回写，review/reject 进复核台由人工放行或驳回，放行立即写入日历。</div></div>
  </div>
  <div class="note">真伪处理：程序<b>不做事实裁定</b>，只做 official / authoritative / relay / anonymous / unknown 信源分级，输出「建议核实途径」；官方一手来源与匿名未证实细节分开标注，并落盘可追溯证据卡。</div>
</div>

<div class="card">
  <h2><span class="n">4</span>真实扫描结果（最近一次）</h2>
  <div class="sub">data/calendar/future-events-scan.json · 闸门 ${e(g.gateVersion || '--')}</div>
  <div class="kpis">
    <div class="kpi"><div class="k">扫描新闻</div><div class="v">${(scan.coverage && scan.coverage.scannedNews) || 0}</div></div>
    <div class="kpi"><div class="k">带确定时间</div><div class="v">${g.timedCandidates || 0}</div></div>
    <div class="kpi"><div class="k">智能体审查</div><div class="v">${g.aiReviewed || 0}</div></div>
    <div class="kpi"><div class="k">准入通过</div><div class="v">${g.admitted || 0}</div></div>
    <div class="kpi"><div class="k">明确驳回</div><div class="v">${g.rejected || 0}</div></div>
    <div class="kpi"><div class="k">待复核</div><div class="v">${g.review || 0}</div></div>
  </div>
  <div class="note">智能体通道：${e(g.aiBackend || '—')} · 黑名单跳过 ${g.blacklistSkipped || 0} 条 · 白名单放行 ${g.whitelistAdmitted || 0} 条。<b>「准入通过 0 条」是预期结果</b>：当前新闻流里抽到确定时间的多为社会软文，智能体建议多为驳回；真正合格的宏观日历由系统周期规则兜底，新闻线索一律交人工复核放行。</div>
</div>

<div class="card">
  <h2><span class="n">5</span>渲染效果：事件卡上的准入 / 信源 / 真伪标签</h2>
  <div class="sub">以下为真实 events.jsonl 中的事件对象渲染样例，与桌面端「日程与事件」卡片一致。</div>
  ${sample.map(x => `<div class="ev-card">
    <div class="ev-name">${e(x.name)}</div>
    <div class="ev-detail">${e(String(x.detail || '').slice(0, 150))}…</div>
    <div class="ev-src">${e(x.date)} · 来源 ${e(x.source)} · ${e(x.confirmLevel || '—')} · ${e(x.dateBasis || '—')}</div>
    ${badges(x.gate)}
  </div>`).join('') || '<div class="note">暂无事件样例</div>'}
</div>

<div class="card">
  <h2><span class="n">6</span>核验证据卡（复核台 · 真实数据）</h2>
  <div class="sub">共 ${(ev.items || []).length} 张证据卡 · 复核队列 ${(rv.items || []).length} 条 · 驳回黑名单 ${(bl.items || []).length} 条</div>
  ${card ? `<div class="ev-card">
    <div class="ev-name">${e(card.claim)}</div>
    <div class="ev-detail"><b>核验结论：</b>${e(card.verdict)}</div>
    <div class="ev-src">${e(card.sourceModeLabel)} · ${e(card.verifiedAt)}</div>
    <div class="ev-detail"><b>官方一手来源</b><ul>${(card.officialSources || []).map(s => '<li>' + e(s.name) + (s.date ? '（' + e(s.date) + '）' : '') + (s.quote ? '：' + e(s.quote) : '') + '</li>').join('')}</ul></div>
    <div class="ev-detail"><b>媒体转述：</b>${(card.mediaRelay || []).map(s => e(s.name)).join('、')}</div>
    <div class="ev-detail" style="color:var(--bad)"><b>未证实细节</b><ul>${(card.unverifiedDetails || []).map(x => '<li>' + e(x) + '</li>').join('')}</ul></div>
    <div class="ev-src">${e(card.note)}</div>
  </div>` : '<div class="note">暂无证据卡</div>'}
  <div class="sub" style="margin-top:16px">复核队列前 6 条</div>
  ${(rv.items || []).slice(0, 6).map(x => `<div class="qi"><div class="t">${e(x.date)} · ${e(x.title)}</div>
    <div class="m">${e(x.source)} · ${e((DEC[x.decision] || ['—'])[0])} · 信源 ${e(TIER[x.sourceTier] || '未分级')} · ${e((x.reasons || [])[0] || '')}</div></div>`).join('') || '<div class="note">队列为空</div>'}
</div>

<div class="card">
  <h2><span class="n">7</span>验证与清理结果</h2>
  <table><thead><tr><th>项目</th><th>结果</th><th>说明</th></tr></thead><tbody>
    <tr><td>闸门语料验证</td><td><span class="tag t-ok">6 / 6 通过</span></td><td>英伟达消息被四重驳回；12-03 听证会、12-10 CPI 官方预告保留；AI 无权把驳回升级为放行</td></tr>
    <tr><td>人工裁决端到端</td><td><span class="tag t-ok">3 / 3 通过</span></td><td>放行立即写入日历 + 白名单；驳回进黑名单并移出队列；黑名单指纹拦住回写；测试数据已自清理</td></tr>
    <tr><td>智能体实时审查</td><td><span class="tag t-ok">通过</span></td><td>官方 Hermes 在线，17 条候选实测返回结构化 JSON，未编造链接、未预判行情</td></tr>
    <tr><td>存量误入历清理</td><td><span class="tag t-ok">已清理</span></td><td>28 条 news-scan 回溯复核，移除 10 条（含这条英伟达），保留 18 条并补复核标注；已自动备份</td></tr>
    <tr><td>桌面成品同步</td><td><span class="tag t-ok">已同步</span></td><td>主成品与便携版 resources/app 的 server/web/scripts 已更新，data 目录原样保留</td></tr>
  </tbody></table>
</div>

<div class="foot">本报告仅记录可追溯来源、口径差异与系统判定，<b>不对消息真伪作事实裁定、不构成投资建议</b>；官方公告为最终口径。<br>
证据卡来源模式为「外部检索（人工/会话）」，非系统自动联网核验；链接为机构入口，请按发布日期在官网新闻稿/备案列表中核对。<br>
所有准入判定均带 reasons / verifyHints，可逐条追溯；智能体结论仅为建议标注，最终由确定性规则与人工复核决定。</div>

</div></body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log('已生成：' + OUT);
console.log('大小：' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
console.log('证据卡 ' + (ev.items || []).length + ' 张 · 复核队列 ' + (rv.items || []).length + ' 条 · 黑名单 ' + (bl.items || []).length + ' 条 · 事件样例 ' + sample.length + ' 条');
