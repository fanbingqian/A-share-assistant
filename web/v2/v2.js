/* ===== v2 简洁外壳逻辑 ===== */
(function(){
'use strict';

const $ = (s, p) => (p||document).querySelector(s);
const $$ = (s, p) => Array.from((p||document).querySelectorAll(s));
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pctClass = v => v>0?'up':v<0?'down':'flat';
const pctText = v => (v==null?'--':(v>0?'+':'')+Number(v).toFixed(2)+'%');

async function api(path, opts){
  try{
    const r = await fetch(path, opts);
    const j = await r.json();
    return j;
  }catch(e){ return {ok:false, error:'网络错误：'+e.message}; }
}
function post(path, body){
  return api(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body||{})});
}
/* agent-ui.js 等在独立 IIFE 中，需通过全局复用这两个请求函数（否则知识图谱加载报 api is not defined） */
window.api = api;
window.post = post;
function fmtTime(ts){
  if(!ts) return '--';
  const d = new Date(ts + (typeof ts==='number' && ts<1e12 ? 0:0));
  const bj = new Date(ts + 8*3600e3);
  return bj.toISOString().slice(11,16);
}

/* ---------------- 导航切换 ---------------- */
let currentView='market';
$$('.nav-item').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const view = btn.dataset.view;
    currentView=view;
    $$('.nav-item').forEach(b=>b.classList.toggle('active', b===btn));
    $$('.view').forEach(v=>v.classList.toggle('active', v.id==='view-'+view));
    if(view==='calendar'){ renderCalendar(); loadUpcoming(); loadEventStudy(); loadGateReview(); }
    if(view==='newsflash'){ loadNewsFlash(); loadPolicyNews().then(()=>markPolicySeen()); loadPolicyTriage(); loadFutureEvents(); }
    if(view==='market'){ loadMarket(); }
    if(view==='portfolio'){ loadPortfolio(); }
    if(view==='knowledge'){
      // 默认 3D 全板块图谱由 agent-ui.js 接管；2D 仍可用工具栏切换
      if(window.AgentUI && typeof window.AgentUI.loadKG==='function') window.AgentUI.loadKG();
      else loadGraph();
      if(typeof loadEntries==='function') loadEntries();
    }
    if(view==='settings'){ loadSettings(); }
    else if(typeof stopGraphLoop==='function') stopGraphLoop(); // 离开知识库停 2D 动画
    if(view==='chat'){ setTimeout(()=>$('#chatInput').focus(), 100); }
    if(view==='chat' && window.innerWidth<=900) $('#chatpanel').classList.add('open');
  });
});
$('#btnLegacy').addEventListener('click', ()=>window.open('/legacy','_blank'));
$('#btnFocusChat').addEventListener('click', ()=>{ $('#chatInput').focus(); window.scrollTo(0,0); });

/* ---------------- 智能体状态 ---------------- */
async function loadAgentStatus(){
  const r = await api('/api/v2/hermes/status');
  const dot = $('.agent-dot');
  if(!r.ok) return;
  const online = !!(r.official && r.official.online);
  const active = r.active || (online?'hermes-official':'deepseek-fallback');
  const label = active==='hermes-official' ? 'Hermes 核心' : 'DeepSeek 驱动';
  if($('#agentBackend')) $('#agentBackend').textContent = label;
  if(dot){
    dot.classList.toggle('online', online);
    dot.title = online
      ? 'Hermes 桥接在线（WSL2 · '+(r.official.hermes||'agent')+'）'
      : 'Hermes 未连接，使用 DeepSeek 兜底';
  }
}

/* ---------------- 对话 / 多会话 ---------------- */
const chatMessages = $('#chatMessages');
let chatHistory = [];
let chatBusy = false;
let currentSessionId = null;
let sessionList = [];

function fmtChatTs(ts){
  if(!ts) return '';
  const d = new Date(ts);
  if(isNaN(d.getTime())) return '';
  const bj = new Date(d.getTime() + 8*3600*1000);
  return bj.toISOString().slice(0,16).replace('T',' ');
}
function backendLabel(backend){
  return backend==='hermes-official' ? 'Hermes 核心' : 'DeepSeek 驱动';
}
function appendMsg(role, text, isErr, meta){
  const wrap = document.createElement('div');
  wrap.className = 'msg '+role;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble'+(isErr?' err':'');
  // 智能体回复走轻量 Markdown 渲染（转义优先、白名单标签）；用户消息与错误保持纯文本
  if(role==='assistant' && !isErr && window.MarkdownLite){
    bubble.classList.add('md-body');
    bubble.innerHTML = window.MarkdownLite.render(text);
  }else{
    bubble.textContent = text;
  }
  if(meta){
    const m = document.createElement('div');
    m.className = 'msg-meta';
    m.textContent = meta;
    bubble.appendChild(m);
  }
  wrap.appendChild(bubble);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}
function fmtSessionDate(ts){
  if(!ts) return '';
  return new Date(Number(ts)+8*3600e3).toISOString().slice(0,16).replace('T',' ');
}
function updateChatContext(){
  const cur = sessionList.find(s=>s.id===currentSessionId);
  const label = cur && cur.title ? '会话「'+cur.title+'」' : '新会话';
  if($('#chatContext')) $('#chatContext').textContent = label+' · 已注入全局数据快照';
}
function renderChatItems(items){
  chatMessages.innerHTML = '';
  chatHistory = [];
  if(!items || !items.length){
    appendMsg('assistant','这是新会话。我能看到两市量能、板块资金、你的股池与事件日历。有什么想了解的？');
    return;
  }
  for(const it of items){
    if(it.role==='assistant'){
      const bits = [fmtChatTs(it.ts), it.module && it.module!=='对话' ? '来自 '+it.module : '', it.backend ? backendLabel(it.backend) : ''].filter(Boolean);
      appendMsg('assistant', it.content, false, bits.join(' · '));
    }else{
      appendMsg('user', it.content);
    }
    chatHistory.push({role:it.role==='assistant'?'assistant':'user', content:it.content});
  }
  if(chatHistory.length>20) chatHistory = chatHistory.slice(-20);
  const lastAssistant = items.slice().reverse().find(x=>x.role==='assistant' && x.backend);
  if(lastAssistant && $('#chatBackend')) $('#chatBackend').textContent = backendLabel(lastAssistant.backend);
}
async function loadSessions(){
  const r = await api('/api/v2/chat/sessions');
  if(!r.ok) return;
  sessionList = r.items||[];
  currentSessionId = r.currentId || (sessionList[0]&&sessionList[0].id) || null;
  renderSessionList();
}
function renderSessionList(){
  const box = $('#csList');
  if(!box) return;
  box.innerHTML = '';
  if(!sessionList.length){ box.innerHTML = '<div class="empty">暂无会话</div>'; return; }
  for(const s of sessionList){
    const el = document.createElement('div');
    el.className = 'cs-item'+(s.id===currentSessionId?' active':'');
    const title = document.createElement('div'); title.className='cs-item-title'; title.textContent = s.title||'未命名会话';
    const meta = document.createElement('div'); meta.className='cs-item-meta'; meta.textContent = (s.messageCount||0)+' 条 · '+fmtSessionDate(s.updatedAt);
    const del = document.createElement('button'); del.className='cs-item-del'; del.textContent='×'; del.title='删除会话';
    el.appendChild(title); el.appendChild(meta); el.appendChild(del);
    el.addEventListener('click', ()=>openSession(s.id));
    el.addEventListener('dblclick', ()=>renameSession(s));
    del.addEventListener('click', async e=>{
      e.stopPropagation();
      if(!window.confirm('删除会话「'+(s.title||'未命名')+'」？原始经验流不会被删除。')) return;
      const rr = await api('/api/v2/chat/sessions/'+encodeURIComponent(s.id), {method:'DELETE'});
      if(rr.ok){ await loadSessions(); if(!getCurrent()) await openSession(sessionList[0]&&sessionList[0].id, true); }
    });
    box.appendChild(el);
  }
}
function getCurrent(){ return sessionList.find(s=>s.id===currentSessionId)||null; }
async function renameSession(s){
  const t = window.prompt('重命名会话', s.title||'');
  if(t==null || !t.trim()) return;
  const r = await post('/api/v2/chat/sessions/'+encodeURIComponent(s.id)+'/rename', {title:t.trim()});
  if(r.ok) await loadSessions();
}
async function openSession(id, keepPanel){
  if(!id) return;
  const r = await api('/api/v2/chat/sessions/'+encodeURIComponent(id)+'/messages?limit=40');
  if(!r.ok) return;
  currentSessionId = id;
  await post('/api/v2/chat/sessions/current', {sessionId:id});
  renderChatItems(r.items||[]);
  const cur = getCurrent();
  if(cur && Array.isArray(r.items)) cur.messageCount = r.items.length;
  renderSessionList();
  updateChatContext();
  if(!keepPanel && $('#chatSessions')) $('#chatSessions').classList.add('hidden');
}
async function loadChatHistory(){
  const sr = await api('/api/v2/chat/sessions');
  if(sr.ok && sr.support){
    sessionList = sr.items||[];
    currentSessionId = sr.currentId || (sessionList[0]&&sessionList[0].id) || null;
    renderSessionList();
    if(currentSessionId){ await openSession(currentSessionId, true); return; }
  }
  const r = await api('/api/v2/chat/history?limit=12'); // 回退旧接口
  renderChatItems((r.ok && r.items)||[]);
  if($('#chatContext')) $('#chatContext').textContent = '已注入全局数据快照（旧模式）';
}
async function sendChat(question, extra){
  question = String(question||'').trim();
  if(!question || chatBusy) return;
  chatBusy = true;
  $('#btnChatSend').disabled = true;
  const module = $('.nav-item.active')?.dataset.view||'对话';
  const stockCode = extra && extra.stockCode ? String(extra.stockCode) : undefined;
  const agentOn = !!($('#chatAgentMode') && $('#chatAgentMode').checked) && !!(window.AgentUI && window.AgentUI.sendStream);

  // === Agent 模式：SSE 流式 agent loop，思考过程与工具调用真实可见 ===
  if(agentOn){
    appendMsg('user', question);
    $('#chatInput').value = '';
    const r = await window.AgentUI.sendStream({ question, history: chatHistory, sessionId: currentSessionId||undefined, module, stockCode }, {
      onMeta(m){
        if(m.sessionId) currentSessionId = m.sessionId;
        if(m.backend) $('#chatBackend').textContent = m.backend && m.backend.indexOf('agent-loop')>=0 ? 'Hermes Agent · 工具取证' : backendLabel(m.backend);
        loadSessions(); updateChatContext();
      }
    });
    if(r.ok && r.text){
      chatHistory.push({role:'user',content:question},{role:'assistant',content:r.text});
      if(chatHistory.length>20) chatHistory = chatHistory.slice(-20);
    } else if(!r.ok){
      appendMsg('assistant', 'Agent 模式未能完成：'+(r.error||'未返回结果')+'。可在顶部关闭「Agent 模式」回退到经典对话。', true);
    }
    chatBusy = false;
    $('#btnChatSend').disabled = false;
    return;
  }

  // === 经典模式：一次注入快照 + 单次 LLM 调用（保留原有稳定链路） ===
  appendMsg('user', question);
  $('#chatInput').value = '';
  const thinking = appendMsg('assistant', '思考中…');
  const r = await post('/api/v2/chat', {
    question,
    history: chatHistory,
    sessionId: currentSessionId || undefined,
    module,
    stockCode
  });
  thinking.remove();
  if(r.ok){
    appendMsg('assistant', r.text);
    chatHistory.push({role:'user',content:question},{role:'assistant',content:r.text});
    if(chatHistory.length>20) chatHistory = chatHistory.slice(-20);
    if(r.backend) $('#chatBackend').textContent = backendLabel(r.backend);
    if(r.sessionId) currentSessionId = r.sessionId;
    await loadSessions();
    updateChatContext();
  }else{
    appendMsg('assistant', '抱歉，暂时无法回答：'+(r.error||'未知错误')+(r.hint?'\n\n'+r.hint:''), true);
  }
  chatBusy = false;
  $('#btnChatSend').disabled = false;
}
$('#btnChatSend').addEventListener('click', ()=>sendChat($('#chatInput').value));
$('#chatInput').addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendChat(e.target.value); }
});
$('#btnChatClear').addEventListener('click', async()=>{
  const r = await post('/api/v2/chat/clear', {sessionId:currentSessionId});
  chatHistory=[]; chatMessages.innerHTML='';
  appendMsg('assistant', r.ok
    ? '当前会话已从界面清空；原始交流记录仍保留在本地经验流中，可继续提问。'
    : '本地对话已清空（服务端清空失败，刷新后可能重新显示历史）。', !r.ok);
  await loadSessions();
  updateChatContext();
});
$('#btnChatSessions').addEventListener('click', async()=>{
  $('#chatSessions').classList.remove('hidden');
  await loadSessions();
});
$('#btnCsClose').addEventListener('click', ()=>$('#chatSessions').classList.add('hidden'));
$('#btnCsNew').addEventListener('click', async()=>{
  const r = await post('/api/v2/chat/sessions', {title:'新会话'});
  if(r.ok){ await loadSessions(); await openSession(r.session.id, true); }
});
let csSearchTimer=null;
$('#csSearch').addEventListener('input', e=>{
  clearTimeout(csSearchTimer);
  const q = e.target.value.trim();
  const list=$('#csList'), results=$('#csResults');
  if(!q){ results.classList.add('hidden'); results.innerHTML=''; list.classList.remove('hidden'); return; }
  csSearchTimer = setTimeout(async()=>{
    const r = await api('/api/v2/chat/search?q='+encodeURIComponent(q)+'&limit=20');
    results.innerHTML='';
    if(r.ok && Array.isArray(r.items) && r.items.length){
      for(const it of r.items){
        const el=document.createElement('div'); el.className='cs-res';
        const t=document.createElement('div'); t.className='cs-res-title';
        t.textContent=(it.sessionTitle||'会话')+' · '+(it.role==='user'?'我':'Hermes')+' · '+fmtChatTs(it.ts);
        const x=document.createElement('div'); x.className='cs-res-text'; x.textContent=it.snippet||it.content;
        el.appendChild(t); el.appendChild(x);
        el.addEventListener('click', ()=>openSession(it.sessionId));
        results.appendChild(el);
      }
    }else{
      results.innerHTML='<div class="empty">没有匹配的对话</div>';
    }
    list.classList.add('hidden'); results.classList.remove('hidden');
  }, 220);
});
$('#btnChatMin').addEventListener('click', ()=>{
  if(window.innerWidth<=900){
    $('#chatpanel').classList.toggle('open');
    return;
  }
  const min = $('.app').classList.toggle('chat-min');
  const btn = $('#btnChatMin');
  btn.textContent = min ? '＋' : '−';
  btn.title = min ? '展开对话' : '最小化对话';
  if(!min) setTimeout(()=>$('#chatInput').focus(), 60);
});
$$('#chatQuick button').forEach(b=>b.addEventListener('click', ()=>sendChat(b.dataset.q)));

/* ---------------- ① 日程与事件 ---------------- */
let calY, calM, calSelDate=null;
/* 日历网格 + 右侧日程列表联动状态 */
/* 日历网格状态（「本月日程列表」板块已取消，日程改由右栏当日事件 + 未来30天承载） */
function initCal(){
  const now = new Date();
  calY = now.getFullYear(); calM = now.getMonth()+1;
  const ys=$('#calYear'), ms=$('#calMonth');
  ys.innerHTML=''; for(let y=calY-3;y<=calY+3;y++){ const o=document.createElement('option'); o.value=y;o.textContent=y+'年'; ys.appendChild(o);}
  ms.innerHTML=''; for(let m=1;m<=12;m++){ const o=document.createElement('option');o.value=m;o.textContent=m+'月'; ms.appendChild(o);}
  ys.value=calY; ms.value=calM;
}
function pad(n){return String(n).padStart(2,'0');}
/* ---- 日历词条：颜色分级、点击详情、跨天行程、当日多事件 ---- */
const CAL_EV_STORE = {}; let calEvSeq = 0;
function calStore(e){ const k='ce'+(++calEvSeq); CAL_EV_STORE[k]=e; return k; }
function calGrade(g){ const x=(g==='自定义'?'user':g); return x||'C'; }
function calGradeLabel(g){ const x=calGrade(g); return ({A:'A 已确认',B:'B 待核实',C:'C 季节性',user:'自定义'})[x]||x; }
/* 美股交易日历专用样式类：与 A/B/C 等级色区分，中性灰蓝 + 虚线，明确是「美股」而非 A 股休市 */
function usMkClass(e){
  if(!e || e.market!=='US') return '';
  if(e.marketStatus==='closed') return ' us-mk us-mk-closed';
  if(e.marketStatus==='early-close') return ' us-mk us-mk-early';
  return '';
}
function fmtDateCN(ds){ const p=String(ds||'').slice(0,10).split('-'); return p.length===3?(Number(p[1])+'月'+Number(p[2])+'日'):String(ds||''); }
function fmtSpanRange(e){ return e.spanStart&&e.spanEnd ? (fmtDateCN(e.spanStart)+'–'+fmtDateCN(e.spanEnd)+'（共'+(e.spanDays||1)+'天）') : fmtDateCN(e.date||e.onDate); }
function calSrcLine(e){
  const parts=[];
  if(e.source&&e.source!=='rule') parts.push('来源：'+srcLabel(e.source));
  if(e.confirmLevel) parts.push('确认级别：'+cfLabel(e.confirmLevel));
  if(e.dateBasis) parts.push('日期依据：'+String(e.dateBasis));
  if(e.endDateInferred) parts.push('结束日：'+String(e.endDateBasis||'文本推断'));
  if(e.verified===false) parts.push('未官方确认');
  return parts.join(' · ');
}
/** 统一的「智能体详细解读」按钮：所有事件卡片（详情 / 当日列表 / 右栏）共用，字段一次带齐 */
function eventAiBtn(e){
  const d={
    id:e.id||'', name:e.name||'', date:e.date||'', grade:e.grade||'',
    rule:e.ruleId||'', detail:e.detail||'', sectors:(e.sectors||[]).join(','),
    confirmed:e.confirmed?'1':'', source:e.source||'', datebasis:e.dateBasis||'',
    category:e.category||'', newsref:(e.newsRef&&(e.newsRef.title||e.newsRef.source))||''
  };
  const attrs=Object.keys(d).map(k=>'data-'+k+'="'+esc(d[k])+'"').join(' ');
  return '<div class="event-ai"><button type="button" class="event-ai-btn" '+attrs+'>'+
    '<span class="event-ai-ico">✦</span>'+
    '<span class="event-ai-label">智能体详细解读</span>'+
    '<span class="event-ai-sub">原因 · 历史涨跌概率 · 证伪条件</span>'+
    '<span class="event-ai-go">→</span></button></div>';
}
/* ===== 日程准入闸门标签：确定性结论 + 信源等级 + 真伪状态 + 智能体审查标记 ===== */
const GATE_DECISION = {
  admit:['准入通过','ok'], review:['待人工复核','warn'], reject:['已驳回','bad'],
  'rule-generated':['系统规则推算','rule'], 'legacy-retained':['存量回溯保留','rule']
};
const GATE_TIER = {
  official:'官方一手', authoritative:'权威署名', relay:'转述援引', anonymous:'匿名信源',
  unknown:'信源未分级', 'system-calendar-rule':'系统规则'
};
const GATE_TRUTH = {
  'official-firsthand-available':'可核对官方一手', 'anonymous-unverified':'含未证实细节',
  'authoritative-report':'署名媒体报道', 'media-relay':'媒体转述', 'ungraded':'真伪未分级',
  'legacy-ungraded':'真伪未分级（存量）', 'not-a-news-claim':'非新闻线索'
};
function gateDecLabel(d){ return (GATE_DECISION[d]||['未标注','rule']); }
function gateBadge(e){
  const g=e && e.gate; if(!g) return '';
  const d=gateDecLabel(g.decision);
  const tier=GATE_TIER[g.sourceTier]||'信源未分级';
  const truth=GATE_TRUTH[g.truthStatus]||'真伪未分级';
  const ai=g.aiReviewed?'智能体已审查':'未过智能体审查';
  return `<div class="gate-badges" title="${esc(g.label||'')}">
    <span class="gate-badge gb-${d[1]}">准入 · ${esc(d[0])}</span>
    <span class="gate-badge gb-tier">信源 · ${esc(tier)}</span>
    <span class="gate-badge gb-truth">真伪 · ${esc(truth)}</span>
    <span class="gate-badge gb-ai${g.aiReviewed?' on':''}">${esc(ai)}</span>
  </div>`;
}
function calEventCard(e, withImpact){
  const g=calGrade(e.grade), title=String(e.name||'（无标题）');
  const when=e.spanStart?('行程 '+fmtSpanRange(e)):fmtDateCN(e.date||e.onDate);
  const src=calSrcLine(e);
  return `<div class="ce-card g-${g}${usMkClass(e)}">
    <div class="ce-card-head"><span class="ce-grade g-${g}">${esc(calGradeLabel(e.grade))}</span><span class="ce-when">${esc(when)}</span></div>
    <div class="ce-name">${esc(title)}</div>
    ${e.category?`<div class="ce-cat">${esc(e.category)}</div>`:''}
    ${e.detail?`<div class="ce-detail">${esc(e.detail)}</div>`:''}
    ${(e.sectors&&e.sectors.length)?`<div class="ce-sectors">相关板块：${e.sectors.map(esc).join(' / ')}</div>`:''}
    ${src?`<div class="ce-src">${esc(src)}</div>`:''}
    ${gateBadge(e)}
    ${(e.newsRef&&e.newsRef.url)?`<div class="ce-link"><a href="${esc(e.newsRef.url)}" target="_blank" rel="noopener">新闻原文 ↗</a></div>`:''}
    ${withImpact?eventAiBtn(e):''}
  </div>`;
}
function openCalModal(html, title){
  $('#ceTitle').textContent=title;
  $('#ceBody').innerHTML=html;
  $('#ceBack').classList.toggle('hidden', !window.__calDayBack);
  openModal('#modalCalEvent');
}
function openCalEvent(e, keepBack){
  if(!keepBack) window.__calDayBack=null;
  openCalModal(calEventCard(e,true), '事件详情');
}
function openCalDay(date, evs){
  window.__calDayBack=null;
  const list=(evs||[]).slice().sort((a,b)=>(a.spanId?0:1)-(b.spanId?0:1)||String(a.grade||'').localeCompare(String(b.grade||'')));
  const html=`<div class="ce-day-h">${esc(date)} 共 ${list.length} 条${list.some(x=>x.spanId)?' · 含跨天行程':''}</div>`+
    (list.length?list.map(e=>`<div class="ce-click" data-evi="${calStore(e)}">${calEventCard(e,true)}</div>`).join(''):'<div class="empty">当日无事件</div>');
  openCalModal(html, '当日全部事件');
  $$('.ce-click', $('#ceBody')).forEach(el=>el.addEventListener('click',()=>{
    const e=CAL_EV_STORE[el.dataset.evi];
    if(!e) return;
    window.__calDayBack={date,evs:list};
    openCalEvent(e,true);
    $('#ceBack').classList.remove('hidden');
  }));
}

async function renderCalendar(focusDate){
  const r = await api(`/api/v2/calendar?year=${calY}&month=${calM}`);
  if(!r.ok){ $('#calGrid').innerHTML='<div class="empty">加载失败</div>'; return; }
  const byDate = r.byDate||{};
  const usClosed = new Set(r.marketClosedDates||[]);
  const usEarly = new Set(r.marketEarlyCloseDates||[]);
  const first = new Date(calY, calM-1, 1);
  let startDow = first.getDay(); startDow = startDow===0?6:startDow-1; // 周一=0
  const total = r.daysInMonth;
  const prevTotal = new Date(calY, calM-1, 0).getDate();
  const today = r.today;

  // 全月跨天行程分配 lane：同一行程在每一格保持同一水平线，重叠行程自动分层（FullCalendar event lane 思路）
  const spanMap = new Map();
  for(const ds of Object.keys(byDate)) for(const e of (byDate[ds]||[])){
    if(e.spanId && !spanMap.has(e.spanId)) spanMap.set(e.spanId,{
      id:e.spanId, start:String(e.spanStart||e.date).slice(0,10), end:String(e.spanEnd||e.date).slice(0,10), lane:0
    });
  }
  const spans=[...spanMap.values()].sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id));
  const laneEnds=[];
  for(const s of spans){
    let li=laneEnds.findIndex(end=>end<s.start);
    if(li<0){ li=laneEnds.length; laneEnds.push(s.end); } else laneEnds[li]=s.end;
    s.lane=li;
  }
  const spanLanes=laneEnds.length;

  let html='';
  const cells = 42;
  for(let i=0;i<cells;i++){
    let d, m=calM, y=calY, other=false;
    if(i<startDow){ d=prevTotal-startDow+1+i; m=calM-1; if(m<1){m=12;y=calY-1;} other=true; }
    else if(i>=startDow+total){ d=i-startDow-total+1; m=calM+1; if(m>12){m=1;y=calY+1;} other=true; }
    else d=i-startDow+1;
    const ds = y+'-'+pad(m)+'-'+pad(d);
    const evs = byDate[ds]||[];
    const spanEvs = evs.filter(e=>e.spanId);
    const normalEvs = evs.filter(e=>!e.spanId).sort((a,b)=>
      String(a.grade||'').localeCompare(String(b.grade||''))||String(a.name||'').localeCompare(String(b.name||'')));
    const isToday = ds===today;
    const sel = ds===calSelDate;

    // 跨天行程：每格一个片段，首/尾/中间段拼成连续横条；跨周围界自然分段
    let spanHtml='';
    if(spanLanes){
      spanHtml='<div class="cal-span-list" style="height:'+(spanLanes*13)+'px">'+spanEvs.map(e=>{
        const meta=spanMap.get(e.spanId)||{lane:0};
        const g=calGrade(e.grade), seg=e.spanSeg||'mid', isStart=seg==='start', k=calStore(e);
        const label=isStart?(String(e.name||'')+' · '+fmtDateCN(e.spanStart)+'–'+fmtDateCN(e.spanEnd)):'';
        const tip=String(e.name||'')+'（'+fmtSpanRange(e)+'）';
        return `<div class="cal-ev cal-span g-${g} seg-${seg}${usMkClass(e)}" style="top:${meta.lane*13}px" data-evi="${k}" title="${esc(tip)}">${isStart?esc(label):'<span class="cal-span-cont">⋯</span>'}</div>`;
      }).join('')+'</div>';
    }
    // 单日事件：每格最多 3 条，超出用「+N 条」折叠，点击查看当日全部
    const evChips = normalEvs.slice(0,3).map(e=>{
      const g = calGrade(e.grade), k = calStore(e);
      const src = (e.source && e.source!=='rule') ? ' · '+srcLabel(e.source)+(e.confirmLevel?(' / '+cfLabel(e.confirmLevel)):'') : '';
      return `<div class="cal-ev g-${g}${usMkClass(e)}" data-evi="${k}" title="${esc(e.name+src)}">${esc(e.name)}</div>`;
    }).join('');
    const more = normalEvs.length>3 ? `<div class="cal-ev-more" data-date="${ds}">+${normalEvs.length-3} 条</div>` : '';
    const usFlag = usClosed.has(ds) ? '<span class="us-mk-flag closed" title="NYSE / Nasdaq 全天休市（A 股照常）">US 休</span>'
      : (usEarly.has(ds) ? '<span class="us-mk-flag early" title="NYSE / Nasdaq 13:00 ET 提前收盘（A 股照常）">US 早收</span>' : '');
    html+=`<div class="cal-cell${other?' other':''}${isToday?' today':''}${sel?' selected':''}${evs.length?' has-ev':''}${usClosed.has(ds)?' us-closed':''}${usEarly.has(ds)?' us-early':''}" id="cell-${ds}" data-date="${ds}">
      <div class="cal-num">${d}</div>${usFlag}
      ${spanHtml}
      <div class="cal-ev-list">${evChips}${more}</div>
    </div>`;
  }
  $('#calGrid').innerHTML=html;
  // 点击日期空白：选中并在右栏展示当日事件
  $$('.cal-cell', $('#calGrid')).forEach(c=>c.addEventListener('click', ()=>{
    calSelDate=c.dataset.date;
    renderDayEvents(calSelDate, byDate);
    renderCalendar(calSelDate);   // 重绘选中态
  }));
  // 点击词条：打开事件详情（阻止冒泡，不触发日期选中）
  $$('.cal-ev[data-evi]', $('#calGrid')).forEach(el=>el.addEventListener('click', ev=>{
    ev.stopPropagation();
    const e=CAL_EV_STORE[el.dataset.evi];
    if(e) openCalEvent(e,false);
  }));
  // 点击「+N 条」：当日全部事件
  $$('.cal-ev-more', $('#calGrid')).forEach(el=>el.addEventListener('click', ev=>{
    ev.stopPropagation();
    openCalDay(el.dataset.date, byDate[el.dataset.date]||[]);
  }));
  // 徽标已改为「自上次查看以来的真实更新条数」，由 update-feed 统一渲染
}

/* 本月日程列表板块已取消：原网格/列表联动逻辑整体移除，日程由右栏「当日事件 + 未来30天」承载。 */

/* ============ 右栏分区折叠：当日事件常驻，未来30天 / 历史统计可折叠 ============
   默认收起，避免把版面拉得太长；展开状态记在 localStorage，切月 / SSE 重绘不打扰。 */
const CAL_SEC_KEYS=['upcoming','gate','study'];
function calSecPref(k){
  try{ const v=localStorage.getItem('gmm.cal.sec.'+k); return v===null?false:v==='1'; }
  catch(e){ return false; }
}
function setCalSec(k, open, persist){
  const head=$('.cal-sec-head[data-sec="'+k+'"]'); if(!head) return;
  const body=document.getElementById(head.dataset.toggle); if(!body) return;
  const sec=head.closest('.cal-sec');
  body.hidden=!open;
  head.setAttribute('aria-expanded', open?'true':'false');
  if(sec) sec.classList.toggle('open', open);
  if(persist!==false){ try{ localStorage.setItem('gmm.cal.sec.'+k, open?'1':'0'); }catch(e){} }
}
function initCalSecs(){
  $$('.cal-sec-head[data-sec]').forEach(h=>h.addEventListener('click',()=>{
    const k=h.dataset.sec, sec=h.closest('.cal-sec');
    const open=!(sec && sec.classList.contains('open'));
    setCalSec(k, open);
  }));
  CAL_SEC_KEYS.forEach(k=>setCalSec(k, calSecPref(k), false));
}

function renderDayEvents(date, byDate){
  const api2 = window.__calData; // 可选缓存
  const evs = byDate ? byDate[date] : null;
  // 若无缓存重新拉
  (async()=>{
    let list = evs;
    if(!list){ const r=await api(`/api/v2/calendar?year=${date.slice(0,4)}&month=${Number(date.slice(5,7))}&date=${date}`); list=(r.events||[]); }
    $('#calDayTitle').textContent = date+' 事件';
    if(!list || !list.length){ $('#calDayEvents').innerHTML='<div class="empty">当日无事件</div>'; return; }
    $('#calDayEvents').innerHTML = list.map(e=>{
      const g = calGrade(e.grade);
      const spanTag = e.spanStart ? `<span class="grade-tag span-tag">行程 ${fmtDateCN(e.spanStart)}–${fmtDateCN(e.spanEnd)}</span>` : '';
      return `<div class="event-item g-${g}${usMkClass(e)}">
        <div class="event-title">${esc(e.name)} <span class="grade-tag">${g==='user'?'自定义':g+'级'}</span>${spanTag}</div>
        ${e.detail?`<div class="event-detail">${esc(e.detail)}</div>`:''}
        ${(e.sectors&&e.sectors.length)?`<div class="event-sectors">相关：${e.sectors.map(esc).join(' / ')}</div>`:''}
        ${(e.source&&['news-scan','calendar-rule','gate-human-admit'].includes(e.source))?`<div class="event-source">来源：${esc(srcLabel(e.source))}${e.confirmLevel?(' · '+esc(cfLabel(e.confirmLevel))):''}${e.dateBasis?(' · '+esc(e.dateBasis)):''}${e.newsRef&&e.newsRef.url?(' <a href="'+esc(e.newsRef.url)+'" target="_blank" rel="noopener">新闻原文 ↗</a>'):''}</div>`:''}
        ${gateBadge(e)}
        ${eventAiBtn(e)}
      </div>`;
    }).join('');
  })();
}
async function eventImpact(btn){
  if(btn.dataset.busy==='1') return;
  const ev={id:btn.dataset.id,name:btn.dataset.name,date:btn.dataset.date,grade:btn.dataset.grade,
    ruleId:btn.dataset.rule||undefined, detail:btn.dataset.detail||undefined,
    sectors:(btn.dataset.sectors||'').split(',').filter(Boolean),
    confirmed:btn.dataset.confirmed==='1', source:btn.dataset.source||undefined,
    dateBasis:btn.dataset.datebasis||undefined, category:btn.dataset.category||undefined,
    newsRef:btn.dataset.newsref?{title:btn.dataset.newsref}:undefined};
  const card=btn.closest('.ce-card')||btn.closest('.event-item')||btn.parentElement.parentElement;
  let box=card.querySelector('.event-ai-result');
  if(!box){ box=document.createElement('div'); box.className='event-ai-result'; card.appendChild(box); }
  const label=btn.querySelector('.event-ai-label');
  btn.dataset.busy='1'; btn.classList.add('loading');
  if(label) label.textContent='正在生成解读…';
  box.innerHTML='<div class="event-ai-loading"><span class="event-ai-spin"></span>智能体正在写详细解读（原因 + 事件前后涨跌百分比 + 证伪条件）…<br><span class="event-ai-hint">走 Hermes 桥接，实测约 30–60 秒，请不要关闭弹框</span></div>';
  try{
    const r=await post('/api/v2/calendar/impact',{event:ev});
    const txt=r.text||r.answer;
    const histHtml = renderEventHistory({eventDetail:r.historical, historical:r.historical&&(r.historical.detail||r.historical.line)});
    if(r.ok && txt){
      const body = window.MarkdownLite
        ? '<div class="ai-text md-body event-ai-text">'+window.MarkdownLite.render(txt)+'</div>'
        : '<div class="ai-text event-ai-text">'+esc(txt)+'</div>';
      const meta = r.promptVersion
        ? '<div class="event-ai-meta">提示词版本 '+esc(r.promptVersion)+' · 后端 '+esc(r.backend||'')+'</div>' : '';
      // 报告整块可折叠：默认展开（刚生成完立即可读），点标题栏一键收起，避免长文把版面拉长
      box.innerHTML='<div class="eai-report open">'+
        '<button type="button" class="eai-report-head" aria-expanded="true">'+
          '<span class="eai-report-ico">▾</span><span>智能体解读报告</span>'+
          '<span class="eai-report-hint">点击折叠 / 展开</span>'+
          '<span class="eai-report-meta">'+esc(r.promptVersion||'')+(r.backend?' · '+esc(r.backend):'')+'</span>'+
        '</button>'+
        '<div class="eai-report-body">'+body+histHtml+meta+'</div>'+
      '</div>';
      const rep=box.querySelector('.eai-report'), rh=rep&&rep.querySelector('.eai-report-head');
      if(rh) rh.addEventListener('click',()=>{
        const open=rep.classList.toggle('open');
        rh.setAttribute('aria-expanded', open?'true':'false');
      });
      if(label) label.textContent='重新解读';
    }else{
      box.innerHTML='<div class="note">解读失败：'+esc(r.error||'未生成')+'</div>'+histHtml;
      if(label) label.textContent='重试解读';
    }
  }catch(err){
    box.innerHTML='<div class="note">解读失败：'+esc((err&&err.message)||'网络错误')+'</div>';
    if(label) label.textContent='重试解读';
  }finally{
    btn.dataset.busy=''; btn.classList.remove('loading');
  }
}
async function loadUpcoming(){
  const r=await api('/api/v2/calendar/upcoming?days=30');
  if(!r.ok) return;
  const box=$('#calUpcoming');
  if($('#calUpcomingSub')) $('#calUpcomingSub').textContent=r.items.length+' 条待发生事件';
  if(!r.items.length){ box.innerHTML='<div class="empty">未来30天无事件</div>'; return; }
  box.innerHTML=r.items.map(e=>{
    const dt=new Date(e.date+'T00:00:00Z'); const days=Math.round((dt-Date.now())/86400e3);
    const tag=(['news-scan','calendar-rule','nyse-official','nyse-rule-projection'].includes(e.source))?`<span class="fe-src-tag">${esc(srcLabel(e.source))}</span>`:'';
    return `<div class="up-item"><span class="up-date">${e.date.slice(5)}</span><span class="up-name">${esc(e.name)}</span>${tag}<span class="up-days">${days<=0?'今日':days+'天'}</span></div>`;
  }).join('');
}
function srcLabel(s){
  const map={'news-scan':'新闻扫描','calendar-rule':'周期规则','gate-human-admit':'人工复核放行','rule':'规则','user':'自定义',
    'official':'官方','policy-calendar':'政策日历','policy-window':'政策窗口',
    'nyse-official':'NYSE 官方','nyse-rule-projection':'NYSE 规则推算'};
  return map[s]||s||'--';
}
function cfLabel(c){
  const map={'news-explicit-date':'新闻明确日期','news-relative-estimate':'新闻相对时间推算',
    'news-window-estimate':'新闻窗口推算','rule-estimate':'规律推算·待官方确认','human-reviewed':'人工复核确认'};
  return map[c]||c||'--';
}
async function loadFutureEvents(force){
  const box=$('#feCoverage'), meta=$('#feMeta'); if(!box) return;
  if(force){ try{ await post('/api/v2/future-events/scan',{}); }catch(_){} }
  const r=await api('/api/v2/future-events');
  if(!r.ok){ box.innerHTML='<div class="empty">扫描报告读取失败</div>'; return; }
  const c=r.coverage||{};
  if(meta) meta.textContent='上次扫描 '+(r.generatedAt||'--')+' · 窗口 '+((r.horizon&&r.horizon.from)||'--')+' ~ '+((r.horizon&&r.horizon.to)||'--');
  const kpis=[
    {k:'扫描新闻',v:c.scannedNews||0},{k:'带确定时间',v:c.timedCandidates||0},
    {k:'准入通过',v:c.relevantMatched||0},{k:'实际入历',v:c.relevantMerged||0},
    {k:'规则兜底',v:c.calendarRules||0},{k:'待复核',v:c.reviewQueue||0}
  ];
  const g=r.gate||{};
  box.innerHTML='<div class="fe-grid">'+kpis.map(x=>
    '<div class="fe-kpi"><div class="fe-k">'+esc(x.k)+'</div><div class="fe-v">'+x.v+'</div></div>').join('')+'</div>'+
    '<div class="note" style="margin-top:8px">本次候选 '+(c.totalUpsertCandidates||0)+' 条（新增 '+(c.created||0)+' / 更新 '+(c.updated||0)+' / 失败 '+(c.failed||0)+'）· 已入历事件 '+(r.events||[]).length+' 条。'+
    '<br><b>准入闸门</b>：智能体审查 '+(g.aiReviewed||0)+' 条（'+esc(g.aiBackend||'—')+'）· 准入通过 '+(g.admitted||0)+' · 驳回 '+(g.rejected||0)+' · 待复核 '+(g.review||0)+' · 黑名单跳过 '+(g.blacklistSkipped||0)+' 条。</div>';
  const q=r.reviewQueue||[], rb=$('#feReview');
  const corp=q.filter(x=>/回购|增持|减持|停牌|复牌|中标|业绩|公告|股份|股东|风险警示|ST|解禁|质押/.test(String(x.title||'')));
  if($('#feCompanyCount')) $('#feCompanyCount').textContent='共 '+q.length+' 条 · 其中公司公告类 '+corp.length+' 条（回购 / 增减持 / 停复牌等）';
  if(rb) rb.innerHTML=q.length? q.slice(0,40).map(x=>{
    const d=gateDecLabel(x.decision);
    return '<div class="fe-q-item"><span class="fe-q-date">'+esc(x.date)+'</span><span class="fe-q-title">'+esc(String(x.title||'').slice(0,72))+'</span>'+
    '<span class="fe-q-src">'+esc(x.source||'')+'</span>'+
    '<span class="fe-src-tag">'+esc(d[0])+'</span>'+
    '<div class="fe-q-why">'+esc((x.reasons||[]).slice(0,2).join('；')||x.reason||'')+' · '+esc(x.dateBasis||'')+'</div></div>';
  }).join('')
    : '<div class="empty">无待复核条目</div>';
}
$('#btnFutureScan')?.addEventListener('click',async()=>{
  const b=$('#btnFutureScan');
  if(b){ b.disabled=true; b.textContent='审查中…'; }
  toast('准入扫描中','确定性闸门 + 智能体结构化审查，约需 1 分钟，请勿关闭页面');
  try{
    await loadFutureEvents(true);
    renderCalendar(); loadUpcoming(); await loadGateReview();
    toast('扫描完成','扫描报告、准入复核台与日历已更新');
  }catch(e){ toast('扫描失败',e.message); }
  finally{ if(b){ b.disabled=false; b.textContent='立即扫描'; } }
});
$('#btnFeReviewToggle')?.addEventListener('click',()=>{
  const b=$('#feReview'); if(!b) return;
  b.style.display = (b.style.display==='none') ? 'block' : 'none';
});

/* ===== 准入复核台：确定性闸门 + 智能体审查 + 人工裁决 ===== */
let GATE_CACHE = { status:null, review:null, evidence:null, blacklist:null };
async function loadGateReview(){
  const st=$('#gateStatus'); if(!st) return;
  const [s,r,ev,bl]=await Promise.all([
    api('/api/v2/calendar/gate/status'),
    api('/api/v2/calendar/gate/review'),
    api('/api/v2/calendar/gate/evidence'),
    api('/api/v2/calendar/gate/blacklist')
  ]);
  GATE_CACHE={ status:s, review:r, evidence:ev, blacklist:bl };
  const note=$('#gateSecNote');
  if(note) note.textContent='待复核 '+((s&&s.reviewPending)||0)+' 条 · 黑名单 '+((s&&s.blacklisted)||0)+' 条 · 证据卡 '+((s&&s.evidenceCards)||0)+' 张';
  const cards=[
    {k:'待复核',v:(s&&s.reviewPending)||0},
    {k:'驳回黑名单',v:(s&&s.blacklisted)||0},
    {k:'核验证据卡',v:(s&&s.evidenceCards)||0},
    {k:'队列生成',v:String((s&&s.reviewGeneratedAt)||'--').slice(5,16)}
  ];
  st.innerHTML='<div class="gr-kpis">'+cards.map(x=>
    '<div class="gr-kpi"><div class="gr-k">'+esc(x.k)+'</div><div class="gr-v">'+esc(x.v)+'</div></div>').join('')+'</div>'+
    '<div class="note" style="margin-top:6px">闸门 '+esc((s&&s.gateVersion)||'--')+' · 默认拒绝 fail-closed · 程序只做来源分级与措辞识别，不裁定事实真伪；智能体结论仅为建议标注。</div>';
  renderGrReview(); renderGrEvidence(); renderGrBlacklist();
}
function renderGrReview(){
  const box=$('#grReview'); if(!box) return;
  const items=(GATE_CACHE.review&&GATE_CACHE.review.items)||[];
  if(!items.length){ box.innerHTML='<div class="empty">当前无待复核条目</div>'; return; }
  box.innerHTML=items.slice(0,60).map(x=>{
    const d=gateDecLabel(x.decision);
    const tier=GATE_TIER[x.sourceTier]||'信源未分级';
    const truth=GATE_TRUTH[x.truthStatus]||'真伪未分级';
    const reasons=(x.reasons||[]).slice(0,4);
    const hints=(x.verifyHints||[]).slice(0,2);
    const ai=x.ai&&x.ai.reviewed
      ? '<div class="gr-ai">智能体建议 <b>'+esc(x.ai.admitSuggestion||'—')+'</b> · 风险 '+esc(x.ai.truthRisk||'—')+' · '+esc(x.ai.reason||'')+(x.ai.backend?' · '+esc(x.ai.backend):'')+'</div>'
      : '<div class="gr-ai muted">智能体未审查（缓存未命中，按 fail-closed 保留在复核队列）</div>';
    return '<div class="gr-item">'+
      '<div class="gr-head"><span class="gr-date">'+esc(x.date||'—')+'</span>'+
        '<span class="gate-badge gb-'+d[1]+'">'+esc(d[0])+'</span>'+
        '<span class="gr-title">'+esc(x.title||'')+'</span></div>'+
      '<div class="gr-meta">来源 '+esc(x.source||'—')+' · 信源 '+esc(tier)+' · 真伪 '+esc(truth)+'</div>'+
      (reasons.length?'<div class="gr-why">'+reasons.map(v=>'<span>'+esc(v)+'</span>').join('')+'</div>':'')+
      (hints.length?'<div class="gr-hint">核实途径：'+hints.map(esc).join('；')+'</div>':'')+
      ai+
      '<div class="gr-actions"><button class="mini-btn gr-admit" data-fp="'+esc(x.fingerprint)+'">人工放行</button>'+
        '<button class="mini-btn gr-reject" data-fp="'+esc(x.fingerprint)+'">驳回并拉黑</button>'+
        (x.url?'<a class="gr-link" href="'+esc(x.url)+'" target="_blank" rel="noopener">原文 ↗</a>':'')+'</div>'+
    '</div>';
  }).join('');
  $$('.gr-admit,.gr-reject', box).forEach(b=>b.addEventListener('click',()=>
    gateDecide(b.dataset.fp, b.classList.contains('gr-admit')?'admit':'reject')));
}
function renderGrEvidence(){
  const box=$('#grEvidence'); if(!box) return;
  const items=(GATE_CACHE.evidence&&GATE_CACHE.evidence.items)||[];
  if(!items.length){ box.innerHTML='<div class="empty">暂无核验证据卡</div>'; return; }
  box.innerHTML=items.slice(0,12).map(x=>{
    const off=(x.officialSources||[]).map(v=>'<li>'+esc(v.name)+(v.date?'（'+esc(v.date)+'）':'')+(v.quote?'：'+esc(v.quote):'')+(v.url?' <a href="'+esc(v.url)+'" target="_blank" rel="noopener">↗</a>':'')+'</li>').join('');
    const relay=(x.mediaRelay||[]).map(v=>esc(v.name)).join('、');
    const unv=(x.unverifiedDetails||[]).map(v=>'<li>'+esc(v)+'</li>').join('');
    return '<div class="gr-ev">'+
      '<div class="gr-ev-claim">'+esc(x.claim||'')+'</div>'+
      '<div class="gr-ev-verdict">核验结论：'+esc(x.verdict||'')+'</div>'+
      '<div class="gr-ev-mode">'+esc(x.sourceModeLabel||'')+' · '+esc(x.verifiedAt||'')+'</div>'+
      (off?'<div class="gr-ev-sub">官方一手来源：<ul>'+off+'</ul></div>':'')+
      (relay?'<div class="gr-ev-sub">媒体转述：'+relay+'</div>':'')+
      (unv?'<div class="gr-ev-sub warn">未证实细节：<ul>'+unv+'</ul></div>':'')+
      (x.note?'<div class="gr-ev-note">'+esc(x.note)+'</div>':'')+
      (x.disclaimer?'<div class="gr-ev-note">'+esc(x.disclaimer)+'</div>':'')+
    '</div>';
  }).join('');
}
function renderGrBlacklist(){
  const box=$('#grBlacklist'); if(!box) return;
  const items=(GATE_CACHE.blacklist&&GATE_CACHE.blacklist.items)||[];
  if(!items.length){ box.innerHTML='<div class="empty">黑名单为空</div>'; return; }
  box.innerHTML=items.slice(0,60).map(x=>
    '<div class="gr-bl"><div><b>'+esc(x.title||'')+'</b><span class="gr-meta"> · '+esc(x.source||'—')+' · '+esc(x.rejectedAt||'')+'</span></div>'+
    '<div class="gr-why"><span>'+esc(x.reason||'')+'</span></div>'+
    '<div class="gr-actions"><button class="mini-btn gr-unblack" data-fp="'+esc(x.fingerprint)+'">移除（可恢复扫描）</button></div></div>').join('');
  $$('.gr-unblack', box).forEach(b=>b.addEventListener('click',async()=>{
    const r=await post('/api/v2/calendar/gate/blacklist/remove',{fingerprint:b.dataset.fp});
    toast(r.ok?'已移除':'移除失败', r.ok?'该条目下次扫描可重新进入准入判定':(r.error||''));
    await loadGateReview();
  }));
}
async function gateDecide(fp, action){
  if(!fp) return;
  const r=await post('/api/v2/calendar/gate/decide',{fingerprint:fp,action});
  toast(r.ok?'已处理':'操作失败', r.note||r.error||'');
  await loadGateReview();
  if(r.ok && action==='admit'){ await loadFutureEvents(); renderCalendar(); }
}
$$('.gr-tab').forEach(b=>b.addEventListener('click',()=>{
  $$('.gr-tab').forEach(t=>t.classList.toggle('active', t===b));
  const k=b.dataset.grtab;
  ['review','evidence','blacklist'].forEach(n=>{ const p=$('#gr'+n.charAt(0).toUpperCase()+n.slice(1)); if(p) p.hidden=(n!==k); });
}));
$('#btnGateRefresh')?.addEventListener('click',()=>loadGateReview());
$('#btnGateRescan')?.addEventListener('click',async()=>{
  const b=$('#btnGateRescan');
  if(b){ b.disabled=true; b.textContent='智能体审查中（约 1 分钟）…'; }
  toast('准入重扫','确定性闸门 + 智能体结构化审查，约需 1 分钟，请勿关闭页面');
  try{
    const r=await post('/api/v2/calendar/gate/rescan',{});
    const g=r.gate||{};
    toast(r.ok?'扫描完成':'扫描失败', r.ok
      ? ('准入通过 '+(g.admitted||0)+' 条 · 驳回 '+(g.rejected||0)+' 条 · 待复核 '+(g.review||0)+' 条 · 智能体审查 '+(g.aiReviewed||0)+' 条'+(g.aiBackend?'（'+g.aiBackend+'）':''))
      : (r.error||''));
    await loadGateReview(); await loadFutureEvents(); renderCalendar();
  }catch(e){ toast('扫描失败',e.message); }
  finally{ if(b){ b.disabled=false; b.textContent='重新扫描（含智能体）'; } }
});

async function loadEventStudy(refresh){
  const box=$('#eventStudyBox');
  if(!box) return;
  if(refresh){
    box.innerHTML='<div class="empty">重新抓取日线并计算中（约 10–20 秒）…</div>';
    const rr=await post('/api/v2/calendar/event-study/refresh',{});
    if(!rr.ok){ box.innerHTML='<div class="empty">刷新失败：'+esc(rr.error||'')+'</div>'; return; }
  }
  const r=await api('/api/v2/calendar/event-study');
  if(!r.ok){ box.innerHTML='<div class="empty">'+(r.error||'统计尚未生成')+'</div>'; return; }
  const rules=(r.rules||[]).slice(0,10);
  if(!rules.length){ box.innerHTML='<div class="empty">暂无有效样本</div>'; return; }
  box.innerHTML=rules.map(x=>{
    const s=x.stats||{};
    const low=(s.samples||0)<8?' es-low':'';
    return `<div class="es-row"><div class="es-name">${esc(x.name||x.ruleId)} <span class="note">${esc(x.ruleId)}</span></div>`+
      `<div class="es-stat${low}">${s.events||0} 次事件 / ${s.samples||0} 次观测 · T+5 超额 ${s.avgAr5==null?'--':(s.avgAr5>0?'+':'')+s.avgAr5+'%'} · 胜率 ${s.win5==null?'--':s.win5+'%'}${low?' · 低样本':''}</div></div>`;
  }).join('')+'<div class="note" style="margin-top:6px">ETF 代理近似口径；历史样本不代表未来。'+esc(r.note||'')+'</div>';
}
$('#btnEventStudyRefresh')?.addEventListener('click', ()=>loadEventStudy(true));
$('#calPrev').addEventListener('click', ()=>{ calM--; if(calM<1){calM=12;calY--;} syncCalSel(); renderCalendar(); });
$('#calNext').addEventListener('click', ()=>{ calM++; if(calM>12){calM=1;calY++;} syncCalSel(); renderCalendar(); });
$('#calToday').addEventListener('click', ()=>{ initCal(); syncCalSel(); renderCalendar(); });
$('#calYear').addEventListener('change',e=>{calY=Number(e.target.value);renderCalendar();});
$('#calMonth').addEventListener('change',e=>{calM=Number(e.target.value);renderCalendar();});
function syncCalSel(){ $('#calYear').value=calY; $('#calMonth').value=calM; }

// 添加事件弹框
$('#btnAddEvent').addEventListener('click', ()=>{ $('#evDate').value=calSelDate||new Date().toISOString().slice(0,10); openModal('#modalEvent'); });
$('#btnSaveEvent').addEventListener('click', async()=>{
  const body={
    date:$('#evDate').value, name:$('#evName').value, category:$('#evCategory').value,
    sectors:$('#evSectors').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean),
    detail:$('#evDetail').value
  };
  const r=await post('/api/v2/calendar/event',body);
  if(r.ok){ closeModals(); $('#evName').value='';$('#evSectors').value='';$('#evDetail').value=''; renderCalendar(); loadUpcoming(); toast('已添加','事件已保存'); }
  else toast('添加失败', r.error||'', true);
});
$('#btnReminders').addEventListener('click', async()=>{
  const r=await api('/api/v2/calendar/reminders');
  if(!r.ok) return;
  if(!r.items.length){ toast('日程提醒','未来7天无重要事件'); return; }
  showEventCard(r.items[0]);
  r.items.slice(1,8).forEach((d,i)=>setTimeout(()=>toast(d.name,d.message,d.daysTo===0),i*120));
});

/* ---------------- ② 每日行情 ---------------- */
$$('#marketTabs .tab').forEach(t=>t.addEventListener('click', ()=>{
  $$('#marketTabs .tab').forEach(x=>x.classList.toggle('active',x===t));
  $$('#marketTabs ~ .tab-panel').forEach(p=>p.classList.remove('active'));
  const map={two:'mtwo',sector:'msector',picks:'mpicks'};
  const panel=$('#'+map[t.dataset.tab]); if(panel) panel.classList.add('active');
}));
async function loadMarket(){
  loadMonitor(); loadGlobalQuotes(); loadSectors(); loadPicks();
}

/* ---------------- 新闻快讯：监控概览 / 今日新闻流 / 智能体单条与整体解读 ---------------- */
let nfData=null, nfKind='all', nfDailyBusy=false;

function nfItemKind(n){
  if(n.isCompany) return 'company';
  if(n.category || (n.importance||0)>=55 || n.alert) return 'policy';
  return 'other';
}
function nfAiBtn(n){
  const d={ title:n.title||'', desc:n.desc||'', source:n.source||'', time:n.time||'',
    category:n.category||'', importance:n.importance||0,
    topics:(n.topics||[]).join(','), sectors:(n.sectors||[]).join(','),
    titleZh:n.titleZh||'', descZh:n.descZh||'', lang:n.lang||'', isEn:n.isEn?'1':'0',
    sentiment:n.sentiment==null?'':n.sentiment, sentimentLabel:n.sentimentLabel||'',
    sentimentHits:JSON.stringify(n.sentimentHits||[]), boards:JSON.stringify(n.boards||[]) };
  const attrs=Object.keys(d).map(k=>'data-'+k+'="'+esc(d[k])+'"').join(' ');
  return '<button type="button" class="nf-ai-btn" '+attrs+'>'+
    '<span class="nf-ai-ico">✦</span><span class="nf-ai-label">智能体解读这条</span>'+
    '<span class="nf-ai-sub">机制 / 板块 / 真实标的 / 证伪条件</span><span class="nf-ai-go">→</span></button>';
}
/* 消息面占比条：用「条数」做 flex 比例，避免百分比四舍五入后条宽不等于 100% */
function nfBiasBarHtml(b){
  const c=(b&&b.counts)||{}, t=(b&&b.total)||0;
  if(!t||(b&&b.degraded)) return '<div class="nf-bias-bar"><span class="nf-bias-seg empty" style="flex:1"></span></div>';
  const seg=(k,label,cls)=>c[k]?'<span class="nf-bias-seg '+cls+'" style="flex:'+c[k]+'" title="'+label+' '+c[k]+' 条"></span>':'';
  return '<div class="nf-bias-bar" role="img" aria-label="利多 '+(c.bull||0)+' 条，中性 '+(c.neutral||0)+' 条，利空 '+(c.bear||0)+' 条">'+
    seg('bull','利多','bull')+seg('neutral','中性','neutral')+seg('bear','利空','bear')+'</div>';
}
/* 服务刚重启、分析周期未跑完时不把「无数据」冒充「中性」 */
function nfDegradedHtml(b){
  if(!b||!b.degraded) return '';
  const c=b.coverage||{};
  return '<div class="nf-degraded">注意：情感标注尚未就绪（已标注 '+(c.scored||0)+' / '+(c.total||0)+
    ' 条），当前占比暂不可用；分析周期完成后会自动刷新。</div>';
}
function nfPctLine(b){
  const c=(b&&b.counts)||{}, p=(b&&b.pct)||{};
  if(b&&b.degraded) return '<div class="nf-bias-legend"><span class="note">占比暂不可用（情感标注生成中）</span></div>';
  return '<div class="nf-bias-legend">'+
    '<span class="bull"><i></i>利多 <b>'+(p.bull||0)+'%</b><em>'+(c.bull||0)+' 条</em></span>'+
    '<span class="neutral"><i></i>中性 <b>'+(p.neutral||0)+'%</b><em>'+(c.neutral||0)+' 条</em></span>'+
    '<span class="bear"><i></i>利空 <b>'+(p.bear||0)+'%</b><em>'+(c.bear||0)+' 条</em></span></div>';
}
/* ============ 股市板块消息面排名（真实东财行业板块 · 贝叶斯收缩 · 实时） ============ */
function nfMoveHtml(r){
  if(r.move==='new') return '<span class="nf-move new" title="本次新进榜">NEW</span>';
  if(r.move==='up') return '<span class="nf-move up" title="名次上升 '+r.moveBy+'">▲'+r.moveBy+'</span>';
  if(r.move==='down') return '<span class="nf-move down" title="名次下降 '+r.moveBy+'">▼'+r.moveBy+'</span>';
  return '<span class="nf-move flat" title="名次不变">—</span>';
}
function nfDirCls(x){
  if(x.direction==='偏多') return 'bull';
  if(x.direction==='偏空') return 'bear';
  return 'flat';
}
function nfChgHtml(v){
  if(v==null) return '<span class="nf-chg na">—</span>';
  const cls=v>0?'up':v<0?'down':'flat';
  return '<span class="nf-chg '+cls+'">'+(v>0?'+':'')+v+'%</span>';
}
/* 侧栏精简榜：利多 / 利空双榜 + 实时戳 */
function nfRankMiniHtml(br, st){
  if(!br) return '<div class="empty">暂无排名数据</div>';
  const p=br.params||{};
  const cap='<div class="nf-rank-cap"><b>股市板块消息面排名</b>'+
    '<span class="note">真实东财行业板块 · 贝叶斯收缩</span></div>';
  if(br.degraded){
    const cv=br.coverage||{};
    return cap+'<div class="nf-degraded">情感标注尚未就绪（已标注 '+(cv.scored||0)+' / '+(cv.total||0)+
      ' 条，非零 '+(cv.nonZero||0)+' 条），本次排名暂不可用；分析周期完成后会自动刷新，不把「无数据」显示成全中性。</div>'+
      '<div class="note nf-rank-foot">排名基于系统真实情感分（server/analysis.js），非智能体生成</div>';
  }
  const meta='<div class="nf-rank-meta">'+
    '新闻池 <b>'+(br.totalNews||0)+'</b> 条 · 命中 <b>'+(br.mappedNews||0)+'</b> 条 · '+
    '进榜 <b>'+(br.rankedCount||0)+'</b> 个板块'+
    '<span class="nf-rank-live"><i></i>实时 · '+esc((br.computedAt||'').slice(11,19))+'</span></div>';
  const row=(x,i)=>'<div class="nf-rank-row '+nfDirCls(x)+'" data-code="'+esc(x.code)+'">'+
    '<span class="nf-rank-no">'+(i+1)+'</span>'+
    '<span class="nf-rank-name">'+esc(x.name)+'</span>'+
    nfMoveHtml(x)+
    '<span class="nf-rank-score '+(x.score>=0?'bull':'bear')+'">'+(x.score>0?'+':'')+x.score+'</span>'+
    '<span class="nf-rank-n">'+x.n+' 条</span></div>';
  const bull=br.bullTop||[], bear=br.bearTop||[];
  const bullHtml=bull.length?bull.slice(0,4).map(row).join(''):
    '<div class="nf-rank-none">本次无「偏多」板块（收缩分 ≥ 8）</div>';
  const bearHtml=bear.length?bear.slice(0,4).map(row).join(''):
    '<div class="nf-rank-none">本次无「偏空」板块（收缩分 ≤ -8）</div>';
  return cap+meta+
    '<div class="nf-rank-two">'+
      '<div class="nf-rank-col"><div class="nf-rank-th bull">利多榜 <span>消息偏多</span></div>'+bullHtml+'</div>'+
      '<div class="nf-rank-col"><div class="nf-rank-th bear">利空榜 <span>消息偏空</span></div>'+bearHtml+'</div>'+
    '</div>'+
    '<div class="note nf-rank-foot">按收缩分（IMDb WR）排名 · 半衰期 '+(p.halfLifeHours||18)+'h · 先验强度 m='+(p.priorM||3)+
      ' · 点板块看消息明细 · 点卡片看完整排名与方法</div>';
}
/* 弹窗完整排名表：一行一板块，可展开看「消息收集」明细（代表新闻 + 命中词） */
function nfRankFullHtml(br){
  if(!br) return '<div class="empty">暂无排名数据</div>';
  const p=br.params||{};
  if(br.degraded){
    const cv=br.coverage||{};
    return '<div class="nf-degraded">情感标注尚未就绪（已标注 '+(cv.scored||0)+' / '+(cv.total||0)+
      ' 条，非零 '+(cv.nonZero||0)+' 条），本次板块排名暂不可用；分析周期完成后会自动刷新。'+
      '程序不会把「无数据」冒充「全中性」，也不硬凑排名。</div>';
  }
  const rows=(br.ranking||[]).map(x=>{
    const cls=nfDirCls(x);
    const samples=(x.samples||[]).map(sn=>{
      const hits=(sn.hits||[]).length?sn.hits.map(h=>'<span class="nf-hit">'+esc(h)+'</span>').join(''):'';
      const unscored=sn.sentiment==null||sn.bias==='unscored';
      const sv=Number(sn.sentiment)||0;
      const sentTxt=unscored?'未标注':(sv>0?'+':'')+sv;
      const biasTxt=unscored?'未标注':(sn.bias==='bull'?'利多':sn.bias==='bear'?'利空':'中性');
      return '<div class="nf-rank-sample"><div class="nf-rank-sample-t">'+
        (sn.isEn?'<span class="nf-lang en tiny">EN</span>':'')+esc(sn.title)+
        (sn.isCompany?'<span class="nf-corp-tag">公司公告</span>':'')+'</div>'+
        (sn.titleZh?'<div class="nf-zh nf-zh-desc"><span class="nf-zh-cap">中译</span>'+esc(sn.titleZh)+'</div>':'')+
        '<div class="nf-rank-sample-m">'+esc(sn.source)+' · '+esc(sn.time)+' · 情感分 <b class="'+(sv>0?'bull':'bear')+'">'+
        sentTxt+'</b> · '+biasTxt+'</div>'+
        (hits?'<div class="nf-rank-sample-h">'+hits+'</div>':'')+'</div>';
    }).join('')||'<div class="empty">该板块暂无留存样本</div>';
    return '<div class="nf-rank-full-item" data-code="'+esc(x.code)+'">'+
      '<div class="nf-rank-full-row '+cls+'" role="button" tabindex="0" aria-expanded="false" title="点击展开该板块收集到的消息">'+
        '<span class="nf-rf-no">'+(x.rank||'—')+'</span>'+nfMoveHtml(x)+
        '<span class="nf-rf-name"><b>'+esc(x.name)+'</b><em>'+esc(x.code)+' · '+esc(x.category||'')+'</em></span>'+
        '<span class="nf-rf-dir '+cls+'">'+esc(x.direction||'')+'</span>'+
        '<span class="nf-rf-score '+(x.score>=0?'bull':'bear')+'">'+(x.score>0?'+':'')+x.score+'</span>'+
        '<span class="nf-rf-bars"><i class="b" style="flex:'+Math.max(0,x.bull)+'"></i><i class="n" style="flex:'+Math.max(0,x.neutral)+'"></i><i class="s" style="flex:'+Math.max(0,x.bear)+'"></i></span>'+
        '<span class="nf-rf-n">'+x.n+' 条<br><em>利多'+x.bull+' / 中性'+x.neutral+' / 利空'+x.bear+'</em></span>'+
        '<span class="nf-rf-z">z '+(x.z==null?'—':x.z)+'<br><em>分位 '+(x.pct==null?'—':x.pct)+'%</em></span>'+
        nfChgHtml(x.chg1)+
        '<span class="nf-rf-go">▾</span>'+
      '</div>'+
      '<div class="nf-rank-full-detail hidden">'+
        '<div class="nf-rf-detail-h">该板块收集到的消息（代表样本，含情感命中词）</div>'+samples+
        (x.realName?'<div class="nf-rf-real">系统真实行情板块：<b>'+esc(x.realName)+'</b>（'+esc(x.code)+'）· 当日涨跌 '+nfChgHtml(x.chg1)+' · 5 日 '+nfChgHtml(x.chg5)+'</div>':'')+
      '</div></div>';
  }).join('');
  const ins=(br.insufficient||[]).map(x=>'<span class="nf-ins-chip">'+esc(x.name)+' <em>'+x.n+' 条</em></span>').join('');
  const method='<div class="nf-rank-method">'+
    '<div class="nf-rf-method-h">排名方法与口径（程序确定性，非智能体生成）</div>'+
    '<div class="nf-rf-ml"><b>方法</b>'+esc(br.method||'')+'</div>'+
    '<div class="nf-rf-ml"><b>公式</b><code>'+esc(br.formula||'')+'</code></div>'+
    '<div class="nf-rf-ml"><b>依据</b>'+esc(br.basis||'')+'</div>'+
    '<div class="nf-rf-ml"><b>为何这样排</b>'+esc(br.why||'')+'</div>'+
    '<div class="nf-rf-ml"><b>参数</b>半衰期 '+(p.halfLifeHours||18)+'h · 先验强度 m='+(p.priorM||3)+
      ' · 全市场先验 C='+(p.priorC==null?'—':p.priorC)+' · 横截面均值 '+(p.crossMean==null?'—':p.crossMean)+
      ' / 标准差 '+(p.crossSd==null?'—':p.crossSd)+' · 参与门槛 ≥'+(p.minScored||1)+' 条真实标注且有效样本 ≥'+(p.minEff||0.4)+
      '（小样本由收缩处理，不叠加硬门槛）· 公司公告降权 ×'+(p.companyWeight||0.6)+'</div>'+
    '<div class="nf-rf-ml"><b>范围</b>'+esc(br.scope||'')+'</div>'+
    '<div class="nf-rf-ml"><b>覆盖</b>新闻池 '+(br.rawNews||br.totalNews||0)+' 条 · 标题去重 '+(br.deduped||0)+
      ' 条后 '+ (br.totalNews||0) +' 条 · 命中股市板块 '+(br.mappedNews||0)+
      ' 条 · 未命中 '+(br.unmappedNews||0)+' 条（宏观 / 海外 / 币圈等无对应 A 股板块，不硬凑） · 参与排名 '+(br.rankedCount||0)+
      ' 个 · 样本不足 '+(br.insufficientCount||0)+' 个 · 已标注 '+(br.coverage&&br.coverage.scored!=null?br.coverage.scored:'—')+
      ' / '+(br.coverage&&br.coverage.total!=null?br.coverage.total:'—')+' 条（未标注新闻只计入收集条数、不参与打分）</div>'+
    '<div class="nf-rf-ml"><b>时点</b>计算于 '+esc(br.computedAt||'--')+'</div>'+
    '<p class="note">'+esc(br.caveat||'')+'</p>'+
    (ins?'<div class="nf-ins-wrap"><span class="note">已收集到消息、但尚无真实情感标注，故不参与排名（不以 0 填充伪中性）：</span><div class="nf-ins-list">'+ins+'</div></div>':'')+
  '</div>';
  return '<div class="nf-rank-full-head">全部 <b>'+(br.rankedCount||0)+'</b> 个参与排名的真实股市板块 · 点任一行展开该板块收集到的消息</div>'+
    '<div class="nf-rank-full-table">'+rows+'</div>'+method;
}
function nfSampleHtml(list, kind){
  if(!list||!list.length) return '<div class="empty">本次无'+(kind==='bull'?'利多':'利空')+'样本</div>';
  return list.map(x=>{
    const hits=(x.hits||[]).length?x.hits.map(h=>'<span class="nf-hit">'+esc(h)+'</span>').join(''):'<span class="note">词典命中词未留存</span>';
    const sv=Number(x.sentiment||0);
    return '<div class="nf-sample '+kind+'">'+
      '<div class="nf-sample-t">'+(x.isEn?'<span class="nf-lang en tiny">EN</span>':'')+esc(x.title)+'</div>'+
      (x.titleZh?'<div class="nf-zh nf-zh-desc"><span class="nf-zh-cap">中译</span>'+esc(x.titleZh)+'</div>':'')+
      '<div class="nf-sample-m">'+esc(x.source)+' · '+esc(x.time)+' · 情感分 <b>'+(sv>0?'+':'')+sv+'</b> · '+esc(x.label||(kind==='bull'?'利多':'利空'))+'</div>'+
      '<div class="nf-sample-h">'+hits+'</div></div>';
  }).join('');
}
/* 弹窗：本板块「全部信息」（侧栏只放精简占比，详情集中在此） */
function renderNfMonitorModal(r){
  const body=$('#nfMonitorBody'); if(!body) return;
  const st=r.stats||{}, b=r.bias||{}, fh=r.feedHealth||{}, secs=r.sectors||[];
  const kpi=[['新闻池',st.pool||0],['今日新闻',st.today||0],['进入新闻流',st.shown||0],
    ['政策快讯',st.policy||0],['公司公告线索',st.company||0],['待复核',st.review||0],['新闻源',st.sources||0]];
  const kindRows=Object.keys(b.byKind||{}).map(k=>{
    const v=b.byKind[k], name={policy:'政策 / 监管',company:'公司公告',other:'其他资讯'}[k]||k, p=v.pct||{};
    return '<div class="nf-kind-row"><div class="nf-kind-cap"><b>'+name+'</b><span>'+(v.total||0)+' 条 · 利多 '+(p.bull||0)+'% / 中性 '+(p.neutral||0)+'% / 利空 '+(p.bear||0)+'%</span></div>'+nfBiasBarHtml(v)+'</div>';
  }).join('');
  const srcRows=(b.bySource||[]).slice(0,8).map(x=>{
    const p=x.pct||{};
    return '<div class="nf-kind-row"><div class="nf-kind-cap"><b>'+esc(x.source)+'</b><span>'+(x.total||0)+' 条 · 利多 '+(p.bull||0)+'% / 利空 '+(p.bear||0)+'%</span></div>'+nfBiasBarHtml(x)+'</div>';
  }).join('');
  const sectorRows=secs.length?secs.map(x=>{
    const sc=Number(x.score||0), cls=sc>=20?'up':sc<=-20?'down':'flat';
    return '<div class="nf-sector"><span class="nf-sector-name">'+esc(x.sector)+'</span>'+
      '<span class="nf-sector-dir '+cls+'">'+esc(x.direction||'')+'</span>'+
      '<span class="nf-sector-score '+cls+'">'+(sc>0?'+':'')+sc+'</span>'+
      '<span class="nf-sector-count">'+(x.count||0)+' 条</span>'+
      '<div class="nf-sector-themes">'+esc((x.themes||[]).join('、')||'—')+'</div></div>';
  }).join(''):'<div class="empty">暂无板块消息面数据</div>';
  const healthKeys=Object.keys(fh);
  const healthRows=healthKeys.length?healthKeys.map(k=>{
    const v=Number(fh[k]||0);
    return '<div class="nf-health"><span class="nf-health-name">'+esc(k)+'</span>'+
      '<span class="nf-health-bar"><i style="width:'+Math.min(100,v)+'%"></i></span>'+
      '<span class="nf-health-v">'+v+'</span></div>';
  }).join(''):'<div class="empty">暂无新闻源健康数据</div>';
  const th=b.threshold||{}, lc=b.langCoverage||{}, len=b.byLang&&b.byLang.en;
  /* 英文消息分析覆盖：证明外媒消息不是「只收集不分析」，且原文与中译都保留 */
  const langCov=lc.en?('<div class="nf-lang-cov">'+
      '<div class="nf-lang-cov-h">英文消息分析覆盖 <span class="note">英文原文完整保留 · 中文译文仅对照 · 事实以原文为准</span></div>'+
      '<div class="nf-lang-cov-n">本次新闻流英文原文 <b>'+lc.en+'</b> 条 · 已标注情感分 <b>'+(lc.enScored||0)+
        '</b> 条 · 近似映射到真实股市板块 <b>'+(lc.enMapped||0)+'</b> 条 · 中文消息 <b>'+(lc.zh||0)+'</b> 条</div>'+
      (len&&len.total?'<div class="nf-kind-row"><div class="nf-kind-cap"><b>英文消息 利多 / 中性 / 利空</b><span>'+
        len.total+' 条 · 利多 '+((len.pct&&len.pct.bull)||0)+'% / 中性 '+((len.pct&&len.pct.neutral)||0)+
        '% / 利空 '+((len.pct&&len.pct.bear)||0)+'%</span></div>'+nfBiasBarHtml(len)+'</div>':'')+
      '<p class="note">英文情感分由 server/analysis.js 双语金融词典对英文原文计算，中文译文不参与打分（避免同义重复计分）；外媒地缘 / 社会等无对应 A 股板块的消息如实不映射，不硬凑。</p>'+
    '</div>'):'';
  const methodAppendix='<div class="nf-modal-sec nf-method nf-method-appendix">'+
      '<div class="nf-method-appendix-head" role="button" tabindex="0" aria-expanded="false" title="点击展开 / 收起">'+
        '<span>附：整体消息面初评口径（程序确定性，非智能体生成）</span><span class="nf-method-appendix-go">展开 ▾</span></div>'+
      '<div class="nf-method-appendix-body hidden">'+
        '<div class="nf-method-line"><b>依据</b>'+esc(b.method||'')+'</div>'+
        '<div class="nf-method-line"><b>分档</b>'+esc(b.basis||'')+'</div>'+
        '<div class="nf-method-line"><b>阈值</b>利多 '+esc(th.bull||'')+' · 中性 '+esc(th.neutral||'')+' · 利空 '+esc(th.bear||'')+'</div>'+
        '<div class="nf-method-line"><b>范围</b>'+esc(b.scope||'')+'</div>'+
        '<div class="nf-method-line"><b>时点</b>计算于 '+esc(b.computedAt||'--')+' · 数据快照 '+esc(r.at||'--')+(r.fallbackToLatest?' · 今日暂无带日期新闻，为最近一批':'')+'</div>'+
        '<p class="note">'+esc(b.caveat||'')+'</p>'+
      '</div></div>';

  body.innerHTML=nfDegradedHtml(b)+
    '<div class="nf-modal-sec nf-modal-sec-rank"><div class="nf-modal-h">一、股市板块消息面排名 <span class="note">真实东财行业板块 · 贝叶斯收缩 · 点行展开消息</span></div>'+
      nfRankFullHtml(r.boardRank)+'</div>'+
    '<div class="nf-modal-sec"><div class="nf-modal-h">二、整体消息面占比 <span class="note">共 '+(b.total||0)+' 条</span></div>'+
      nfBiasBarHtml(b)+nfPctLine(b)+
      '<div class="nf-bias-net">净倾向（利多 − 利空）<b class="'+((b.net||0)>=0?'bull':'bear')+'">'+(b.net>0?'+':'')+(b.net||0)+' 条</b> · 平均情感分 <b>'+(b.avgSentiment==null?'--':(b.avgSentiment>0?'+':'')+b.avgSentiment)+'</b></div>'+
      langCov+
    '</div>'+
    '<div class="nf-modal-sec"><div class="nf-modal-h">三、按类别拆分</div>'+kindRows+'</div>'+
    '<div class="nf-modal-sec"><div class="nf-modal-h">四、按新闻源拆分 <span class="note">前 8 个来源</span></div>'+(srcRows||'<div class="empty">暂无来源数据</div>')+'</div>'+
    '<div class="nf-modal-sec"><div class="nf-modal-h">五、消息条数概览</div><div class="nf-kpi-row nf-kpi-modal">'+kpi.map(x=>'<div class="nf-kpi"><div class="nf-kpi-k">'+esc(x[0])+'</div><div class="nf-kpi-v">'+x[1]+'</div></div>').join('')+'</div></div>'+
    '<div class="nf-modal-sec"><div class="nf-modal-h">六、利多代表新闻 <span class="note">按情感分降序</span></div>'+nfSampleHtml(b.samples&&b.samples.bull,'bull')+'</div>'+
    '<div class="nf-modal-sec"><div class="nf-modal-h">七、利空代表新闻 <span class="note">按情感分升序</span></div>'+nfSampleHtml(b.samples&&b.samples.bear,'bear')+'</div>'+
    '<div class="nf-modal-sec"><div class="nf-modal-h">八、主题词消息面（全部 '+secs.length+' 个 · 关键词近似，供参考）</div>'+sectorRows+'</div>'+
    '<div class="nf-modal-sec"><div class="nf-modal-h">九、新闻源健康（全部 '+healthKeys.length+' 个）</div>'+healthRows+'</div>'+
    methodAppendix+
    '<p class="note nf-modal-disclaimer">'+esc(r.disclaimer||'')+'</p>';
}
/* 右侧辅助栏：概览（占比为主，条数为辅）+ 精简板块/源健康 */
function renderNfMonitor(r){
  const st=r.stats||{}, b=r.bias||{};
  const meta=$('#newsFlashMeta');
  if(meta) meta.textContent='更新于 '+(r.at||'--')+' · 新闻池 '+(st.pool||0)+' 条 · 今日 '+(st.today||0)+' 条'+
    (r.fallbackToLatest?' · 今日暂无带日期新闻':'');
  const mini=$('#nfBiasMini');
  if(mini){
    mini.innerHTML='<div class="nf-bias-cap">消息面初评 <span class="note">程序确定性 · 非涨跌预测</span></div>'+
      nfDegradedHtml(b)+nfBiasBarHtml(b)+nfPctLine(b)+
      '<div class="nf-bias-net">净倾向 <b class="'+((b.net||0)>=0?'bull':'bear')+'">'+(b.net>0?'+':'')+(b.net||0)+' 条</b> · 均值 '+
      (b.avgSentiment==null?'--':(b.avgSentiment>0?'+':'')+b.avgSentiment)+' <span class="note">共 '+(b.total||0)+' 条</span></div>'+
      ((b.langCoverage&&b.langCoverage.en)
        ? '<div class="nf-lang-mini">EN 英文原文 '+b.langCoverage.en+' 条 · 已分析 '+b.langCoverage.enScored+
          ' 条 · 映射板块 '+b.langCoverage.enMapped+' 条 <span class="note">原文保留</span></div>'
        : '');
  }
  const rb=$('#nfBoardRankBox');
  if(rb) rb.innerHTML=nfRankMiniHtml(r.boardRank, st);
  const kpi=$('#newsFlashKpi');
  if(kpi){
    const arr=[['新闻池',st.pool||0],['今日新闻',st.today||0],['政策快讯',st.policy||0],
      ['公司公告线索',st.company||0],['待复核',st.review||0],['新闻源',st.sources||0]];
    kpi.innerHTML=arr.map(x=>'<div class="nf-kpi"><div class="nf-kpi-k">'+esc(x[0])+'</div><div class="nf-kpi-v">'+x[1]+'</div></div>').join('');
  }
  const sb=$('#newsSectorBox');
  if(sb){
    const secs=r.sectors||[];
    sb.innerHTML=secs.length?secs.slice(0,4).map(x=>{
      const sc=Number(x.score||0), cls=sc>=20?'up':sc<=-20?'down':'flat';
      return '<div class="nf-sector"><span class="nf-sector-name">'+esc(x.sector)+'</span>'+
        '<span class="nf-sector-dir '+cls+'">'+esc(x.direction||'')+'</span>'+
        '<span class="nf-sector-score '+cls+'">'+(sc>0?'+':'')+sc+'</span></div>';
    }).join('')+'<div class="note nf-more">仅前 4 个 · 点卡片看全部</div>':'<div class="empty">暂无板块消息面数据</div>';
  }
  const hb=$('#newsHealthBox');
  if(hb){
    const fh=r.feedHealth||{}, keys=Object.keys(fh);
    hb.innerHTML=keys.length?keys.slice(0,4).map(k=>{
      const v=Number(fh[k]||0);
      return '<div class="nf-health"><span class="nf-health-name">'+esc(k)+'</span>'+
        '<span class="nf-health-bar"><i style="width:'+Math.min(100,v)+'%"></i></span>'+
        '<span class="nf-health-v">'+v+'</span></div>';
    }).join('')+'<div class="note nf-more">仅前 4 个 · 点卡片看全部</div>':'<div class="empty">暂无新闻源健康数据</div>';
  }
  renderNfMonitorModal(r);
}
/* 「附：初评口径」折叠展开（弹窗内容会被重渲染，用事件委托） */
document.addEventListener('click', e=>{
  const h=e.target.closest && e.target.closest('.nf-method-appendix-head');
  if(!h) return;
  const body=h.parentElement.querySelector('.nf-method-appendix-body');
  if(!body) return;
  const open=body.classList.toggle('hidden')===false;
  h.setAttribute('aria-expanded', open?'true':'false');
  const go=h.querySelector('.nf-method-appendix-go'); if(go) go.textContent=open?'收起 ▴':'展开 ▾';
});
/* 排名行展开 / 收起该板块收集到的消息（事件委托，弹窗内容会被重渲染） */
document.addEventListener('click', e=>{
  const row=e.target.closest && e.target.closest('.nf-rank-full-row');
  if(!row) return;
  const item=row.closest('.nf-rank-full-item');
  const detail=item && item.querySelector('.nf-rank-full-detail');
  if(!detail) return;
  const open=detail.classList.toggle('hidden')===false;
  row.setAttribute('aria-expanded', open?'true':'false');
  const go=row.querySelector('.nf-rf-go'); if(go) go.textContent=open?'▴':'▾';
});
document.addEventListener('keydown', e=>{
  if(e.key!=='Enter'&&e.key!==' ') return;
  const row=e.target.closest && e.target.closest('.nf-rank-full-row');
  if(!row) return;
  e.preventDefault(); row.click();
});
/* 侧栏点某个板块 → 打开弹窗并展开该板块明细 */
document.addEventListener('click', e=>{
  const r=e.target.closest && e.target.closest('.nf-rank-row[data-code]');
  if(!r) return;
  e.stopPropagation();
  const code=r.dataset.code;
  if(typeof openModal==='function') openModal('#modalNfMonitor');
  setTimeout(()=>{
    const item=document.querySelector('.nf-rank-full-item[data-code="'+CSS.escape(code)+'"]');
    if(!item) return;
    const detail=item.querySelector('.nf-rank-full-detail'), row=item.querySelector('.nf-rank-full-row');
    if(detail){ detail.classList.remove('hidden'); if(row) row.setAttribute('aria-expanded','true'); }
    item.scrollIntoView({block:'center', behavior:'smooth'});
    item.classList.add('nf-rank-flash');
    setTimeout(()=>item.classList.remove('nf-rank-flash'), 1600);
  }, 60);
}, true);
/* 点击右侧辅助栏卡片 → 弹窗显示全部信息 */
function nfOpenMonitor(){
  if(!nfData && typeof loadNewsFlash==='function') loadNewsFlash();
  openModal('#modalNfMonitor');
}
$('#nfMonitorCard')?.addEventListener('click', nfOpenMonitor);
$('#nfMonitorCard')?.addEventListener('keydown', e=>{
  if(e.key==='Enter'||e.key===' '){ e.preventDefault(); nfOpenMonitor(); }
});
/* 按需智能体复核：默认不调用；比例始终由程序算，智能体只解释边界 */
let nfBiasBusy=false;
async function nfInterpretBias(){
  if(nfBiasBusy) return;
  nfBiasBusy=true;
  const btn=$('#btnNfBiasAI'), rep=$('#nfBiasReport'), text=$('#nfBiasText'), meta=$('#nfBiasMeta');
  if(rep){ rep.classList.remove('hidden'); rep.classList.add('open'); }
  if(btn){ btn.disabled=true; btn.textContent='复核中…（约 30–60 秒）'; }
  if(text) text.innerHTML='<div class="nf-ai-loading"><span class="event-ai-spin"></span>'+
    '智能体正在复核程序初评的边界与口径限制（不改写任何比例数字）…<br>'+
    '<span class="event-ai-hint">走 Hermes 桥接，按需调用一次，请勿关闭弹窗</span></div>';
  if(meta) meta.textContent='生成中…';
  try{
    const r=await post('/api/v2/news-flash/interpret',{mode:'bias'});
    if(r.ok && r.text){
      if(text) text.innerHTML=window.MarkdownLite?window.MarkdownLite.render(r.text):esc(r.text);
      if(meta) meta.textContent=esc(r.promptVersion||'news-bias-v1')+' · '+esc(r.backend||'');
    }else{
      if(text) text.innerHTML='<div class="empty">复核失败：'+esc(r.error||'智能体未返回内容')+'</div>';
      if(meta) meta.textContent='生成失败';
    }
  }catch(err){
    if(text) text.innerHTML='<div class="empty">复核失败：'+esc(err.message||err)+'</div>';
    if(meta) meta.textContent='生成失败';
  }finally{
    nfBiasBusy=false;
    if(btn){ btn.disabled=false; btn.textContent='✦ 智能体复核消息面（按需 · 约 30–60 秒）'; }
  }
}
$('#btnNfBiasAI')?.addEventListener('click', nfInterpretBias);
function renderNewsFeed(){
  const box=$('#newsFeedBox'); if(!box||!nfData) return;
  const all=nfData.feed||[];
  /* 「金融」是跨类别的主题筛选（不与政策/公司公告/其他互斥），其余沿用单选分类 */
  const list=nfKind==='all'?all
    :nfKind==='finance'?all.filter(n=>n.finance&&n.finance.isFinance)
    :all.filter(n=>nfItemKind(n)===nfKind);
  const meta=$('#newsFeedMeta');
  const finCount=all.filter(n=>n.finance&&n.finance.isFinance).length;
  const finPct=all.length?Math.round(finCount/all.length*100):0;
  if(meta) meta.textContent='共 '+all.length+' 条 · 金融相关 '+finCount+' 条（'+finPct+'%） · 当前显示 '+
    list.length+' 条 · 英文原文 '+all.filter(n=>n.isEn).length+' 条（保留原文 + 中译对照）';
  if(!list.length){ box.innerHTML='<div class="empty">该分类下暂无新闻</div>'; return; }
  box.innerHTML=list.map((n,i)=>{
    const kind=nfItemKind(n), tag=kind==='company'?'公司公告':kind==='policy'?'政策':'其他';
    const link=n.link?'<a href="'+esc(n.link)+'" target="_blank" rel="noopener">原文 ↗</a>':'';
    const topics=(n.topics||[]).length?'<span class="nf-topic">'+esc(n.topics.slice(0,3).join(' / '))+'</span>':'';
    const secChips=(n.sectors||[]).slice(0,4).map(x=>'<span class="nf-topic nf-sec-chip">'+esc(x)+'</span>').join('');
    /* 金融相关性标签：词表近似标注，只说明主题归属，不代表对 A 股有影响、不构成建议 */
    const finChips=(n.finance&&n.finance.isFinance?(n.finance.tags||[]):[]).slice(0,2)
      .map(x=>'<span class="nf-topic nf-fin-chip" title="金融相关性为双语词表近似标注，仅说明主题归属，不构成投资建议">'+esc(x)+'</span>').join('');
    /* 英文消息：主标题 / 摘要一律保留英文原文，中文译文只作对照，不替换原文 */
    const enTag=n.isEn?'<span class="nf-lang en" title="英文原文消息：事实以原文为准，中译仅辅助理解">EN 原文</span>':'';
    const zhTitle=n.titleZh?'<div class="nf-zh"><span class="nf-zh-cap">中译</span>'+esc(n.titleZh)+'</div>':'';
    const zhDesc=n.descZh?'<div class="nf-zh nf-zh-desc"><span class="nf-zh-cap">摘要中译</span>'+esc(n.descZh)+'</div>':'';
    /* 程序初评结果直接摊在卡片上：情感分 / 方向 / 命中词 / 近似映射板块，英文消息同样展示 */
    const sv=n.sentiment;
    const bcls=n.bias==='bull'?'bull':n.bias==='bear'?'bear':'neutral';
    const bname=n.bias==='bull'?'利多':n.bias==='bear'?'利空':'中性';
    const sentHtml=sv==null
      ? '<span class="nf-ana-sent unscored">未标注（尚未进入分析窗口）</span>'
      : '<span class="nf-ana-sent '+bcls+'">'+bname+' '+(sv>0?'+':'')+sv+'</span>';
    const hits=(n.sentimentHits||[]).slice(0,4).map(h=>'<span class="nf-hit">'+esc(h)+'</span>').join('');
    const boards=(n.boards||[]).slice(0,4).map(b=>
      '<span class="nf-board" title="'+esc(b.code)+' · 关键词近似映射到真实股市板块">'+esc(b.name)+'</span>').join('');
    const analysis='<div class="nf-analysis"><span class="nf-ana-cap">程序初评</span>'+sentHtml+
      (hits?'<span class="nf-ana-hits">'+hits+'</span>':'')+
      (boards?'<span class="nf-ana-boards"><i>板块</i>'+boards+'</span>':'')+
      (!boards&&!hits?'<span class="note">词典未命中 / 无对应 A 股板块，不硬凑</span>':'')+'</div>';
    return '<div class="nf-item'+(n.isEn?' is-en':'')+'">'+
      '<div class="nf-item-top">'+enTag+'<span class="nf-kind '+kind+'">'+tag+'</span>'+
        (n.alert?'<span class="nf-alert">高影响</span>':'')+
        '<span class="nf-time">'+esc(n.time||'时点未注明')+'</span>'+
        '<span class="nf-src">'+esc(n.source||'')+'</span></div>'+
      '<div class="nf-title">'+esc(n.title)+'</div>'+
      zhTitle+
      (n.desc?'<div class="nf-desc">'+esc(n.desc)+'</div>':'')+
      zhDesc+
      analysis+
      '<div class="nf-foot">'+finChips+topics+secChips+'<span>重要性 '+(n.importance||0)+'</span>'+link+'</div>'+
      '<div class="nf-ai-wrap">'+nfAiBtn(n)+'</div>'+
      '<div class="nf-ai-slot"></div>'+
    '</div>';
  }).join('');
}
async function loadNewsFlash(){
  const box=$('#newsFeedBox'); if(!box) return;
  const r=await api('/api/v2/news-flash');
  if(!r.ok){ box.innerHTML='<div class="empty">新闻读取失败：'+esc(r.error||'')+'</div>'; return; }
  nfData=r;
  renderNfMonitor(r);
  renderNewsFeed();
}
/* 单条解读：捕获阶段委托，避免与卡片内其它点击冲突 */
document.addEventListener('click', async e=>{
  const b=e.target.closest && e.target.closest('.nf-ai-btn');
  if(!b) return;
  e.preventDefault(); e.stopPropagation();
  await nfInterpretOne(b);
}, true);
/* 历史同类情形：程序确定性统计卡片（不依赖智能体输出，响应恒返回） */
function renderHistoricalCard(h){
  if(!h) return '';
  const head='<div class="ha-head"><b>历史同类情形（程序统计 · 非预测）</b><span>'+esc(h.scopeLabel||'')+(h.stale?' · 快照陈旧':'')+'</span></div>';
  if(!h.ok){
    return '<div class="ha-card ha-na">'+head+
      '<div class="ha-body">该类事件暂无可核对的 A 股代理样本，按低幻觉纪律不提供历史类比。'+
      (h.unavailableReason?'（'+esc(h.unavailableReason)+'）':'')+'</div></div>';
  }
  const rows=(h.rows||[]).map(r=>'<div class="ha-kpi"><div class="ha-k">'+esc(r.k)+'</div><div class="ha-v">'+esc(r.v)+'</div></div>').join('');
  const prox=(h.proxies||[]).length?'<div class="ha-sub">分板块（ETF 代理近似）：'+h.proxies.map(p=>esc(p.label)+' T+5 '+esc(p.ret5)+' · 上涨概率 '+esc(p.upProb5)).join('；')+'</div>':'';
  const mech=h.mechanism?'<div class="ha-sub">机制：'+esc(h.mechanism)+'</div>':'';
  const cav=(h.caveats||[]).map(c=>'<div class="ha-cav">· '+esc(c)+'</div>').join('');
  return '<div class="ha-card">'+head+
    '<div class="ha-sub">'+esc(h.eventType||'')+' · '+esc(h.sampleLine||'')+
    (h.generatedAt?' · 统计生成于 '+esc(String(h.generatedAt).slice(0,10)):'')+'</div>'+
    '<div class="ha-grid">'+rows+'</div>'+mech+prox+
    (cav?'<div class="ha-cavs">'+cav+'</div>':'')+'</div>';
}
async function nfInterpretOne(btn){
  const jparse=(v,fb)=>{ try{ return JSON.parse(v||'null')||fb; }catch(_){ return fb; } };
  const item={ title:btn.dataset.title||'', desc:btn.dataset.desc||'', source:btn.dataset.source||'',
    time:btn.dataset.time||'', category:btn.dataset.category||'',
    importance:Number(btn.dataset.importance||0),
    topics:(btn.dataset.topics||'').split(',').filter(Boolean),
    sectors:(btn.dataset.sectors||'').split(',').filter(Boolean),
    titleZh:btn.dataset.titleZh||'', descZh:btn.dataset.descZh||'',
    lang:btn.dataset.lang||'', isEn:btn.dataset.isEn==='1',
    sentiment:btn.dataset.sentiment===''?null:Number(btn.dataset.sentiment),
    sentimentLabel:btn.dataset.sentimentLabel||'',
    sentimentHits:jparse(btn.dataset.sentimentHits,[]), boards:jparse(btn.dataset.boards,[]) };
  const wrap=btn.closest('.nf-item'), slot=wrap&&wrap.querySelector('.nf-ai-slot');
  if(!slot) return;
  if(btn.classList.contains('loading')) return;
  btn.classList.add('loading');
  slot.innerHTML='<div class="nf-ai-loading"><span class="event-ai-spin"></span>'+
    '智能体正在解读这条新闻（事件解释 / 二级市场影响判断 / 历史同类情形）…<br>'+
    '<span class="event-ai-hint">走 Hermes 桥接，实测约 30–60 秒，请勿关闭页面</span></div>';
  try{
    const r=await post('/api/v2/news-flash/interpret',{mode:'one',item});
    /* 程序事实恒返回：命中官方指数发布事件时先渲染机构预期 / 跨资产 / 多数方向结构化卡片，
       再放智能体叙述；智能体不可用时该卡片依然可见（不编造、不依赖模型）。 */
    const macroHtml=(r.macro&&r.macro.detected&&window.MacroRender)
      ? window.MacroRender.render(r.macro) : '';
    const haHtml=r.historicalCard?renderHistoricalCard(r.historicalCard):'';
    if(r.ok && r.text){
      const html=window.MarkdownLite?window.MarkdownLite.render(r.text):esc(r.text);
      slot.innerHTML=macroHtml+haHtml+'<div class="nf-report open">'+
        '<div class="nf-report-head" role="button" tabindex="0" aria-expanded="true">'+
          '<span class="nf-report-ico">▾</span><b>智能体解读（事件中心 · 含历史同类情形）'+(macroHtml?' + 官方指数发布增强':'')+'</b>'+
          '<span class="nf-report-meta">'+esc(r.promptVersion||'news-flash-v3-event')+' · '+esc(r.backend||'')+'</span>'+
          '<button type="button" class="nf-fold-btn">收起 ▴</button></div>'+
        '<div class="ai-text nf-report-text md-body">'+html+'</div></div>';
      const lab=btn.querySelector('.nf-ai-label'); if(lab) lab.textContent='重新解读这条';
    }else{
      slot.innerHTML=macroHtml+haHtml+'<div class="empty">解读失败：'+esc(r.error||'智能体未返回内容')+'</div>';
    }
  }catch(err){ slot.innerHTML='<div class="empty">解读失败：'+esc(err.message||err)+'</div>'; }
  finally{ btn.classList.remove('loading'); }
}
/* 今日整体解读 */
async function nfInterpretDaily(){
  if(nfDailyBusy) return;
  nfDailyBusy=true;
  const btn=$('#btnNewsDailyAI'), card=$('#newsDailyCard'), text=$('#newsDailyText'), meta=$('#newsDailyMeta');
  if(card){ card.classList.remove('hidden'); card.classList.add('open'); }
  if(btn){ btn.disabled=true; btn.textContent='解读中…'; }
  if(text) text.innerHTML='<div class="nf-ai-loading"><span class="event-ai-spin"></span>'+
    '智能体正在通读今日新闻并撰写整体解读（核心事件 / 影响判断 / 历史同类情形）…<br>'+
    '<span class="event-ai-hint">走 Hermes 桥接，实测约 30–60 秒，请勿关闭页面</span></div>';
  if(meta) meta.textContent='生成中…';
  try{
    const r=await post('/api/v2/news-flash/interpret',{mode:'daily'});
    const macroHtml=(r.macro&&r.macro.detected&&window.MacroRender)
      ? window.MacroRender.render(r.macro) : '';
    const haHtml=r.historicalCard?renderHistoricalCard(r.historicalCard):'';
    if(r.ok && r.text){
      const body=window.MarkdownLite?window.MarkdownLite.render(r.text):esc(r.text);
      if(text) text.innerHTML=macroHtml+haHtml+body;
      if(meta) meta.textContent='今日新闻 '+(r.newsCount||0)+' 条 · '+esc(r.promptVersion||'news-daily-v3-event')+' · '+esc(r.backend||'')+(macroHtml?' · 含官方指数发布增强':' · 含历史同类统计');
    }else{
      if(text) text.innerHTML=macroHtml+haHtml+'<div class="empty">解读失败：'+esc(r.error||'智能体未返回内容')+'</div>';
      if(meta) meta.textContent='生成失败';
    }
  }catch(err){
    if(text) text.innerHTML='<div class="empty">解读失败：'+esc(err.message||err)+'</div>';
    if(meta) meta.textContent='生成失败';
  }finally{
    nfDailyBusy=false;
    if(btn){ btn.disabled=false; btn.textContent='✦ 智能体解读今日新闻'; }
  }
}
/* 报告折叠：今日卡片与单条解读共用同一交互 */
document.addEventListener('click', e=>{
  const h=e.target.closest && e.target.closest('.nf-report-head');
  if(!h) return;
  const rep=h.closest('.nf-report'); if(!rep) return;
  const open=rep.classList.toggle('open');
  h.setAttribute('aria-expanded',open?'true':'false');
  const ico=h.querySelector('.nf-report-ico'); if(ico) ico.textContent=open?'▾':'▸';
  const f=h.querySelector('.nf-fold-btn'); if(f) f.textContent=open?'收起 ▴':'展开 ▾';
});
document.addEventListener('keydown', e=>{
  if(e.key!=='Enter' && e.key!==' ') return;
  const h=e.target.closest && e.target.closest('.nf-report-head');
  if(h){ e.preventDefault(); h.click(); }
});
$('#btnNewsDailyAI')?.addEventListener('click', nfInterpretDaily);
$('#btnNewsFlashRefresh')?.addEventListener('click', async()=>{
  toast('刷新中','重新读取新闻快照…');
  try{ await post('/api/v2/news-pulse/refresh',{}); }catch(_){}
  await loadNewsFlash();
  if(typeof loadPolicyNews==='function') await loadPolicyNews(true);
  if(typeof loadFutureEvents==='function') await loadFutureEvents();
  toast('已刷新','新闻快讯已更新');
});
$('#newsFeedFilter')?.addEventListener('click', e=>{
  const b=e.target.closest && e.target.closest('.nf-fbtn'); if(!b) return;
  nfKind=b.dataset.kind||'all';
  $$('#newsFeedFilter .nf-fbtn').forEach(x=>x.classList.toggle('active',x===b));
  renderNewsFeed();
});

/* 政策快讯：来源华尔街见闻A股/全球快讯 + 中新网等，按政策关键词权重排序 */
const POLICY_COLLAPSED_COUNT=15;          // 默认只展示前 15 条，其余折叠，避免整页铺开
const POLICY_SEEN_KEY='gmm.policySeenAlerts';
let lastPolicyRenderKey='';
let policyAlertsCache=[];                  // 当前快照里「高影响」政策的唯一 key

function policyAlertKey(n){ return String(n.id||n.title||''); }
function loadPolicySeen(){
  try{ const a=JSON.parse(localStorage.getItem(POLICY_SEEN_KEY)||'[]'); return Array.isArray(a)?a:[]; }
  catch(_){ return []; }
}
function savePolicySeen(keys){
  try{ localStorage.setItem(POLICY_SEEN_KEY,JSON.stringify(keys.slice(-120))); }catch(_){}
}
/* 徽标 = 自上次查看以来「新增」的高影响政策条数（不是快照里的固定总数） */
function updatePolicyBadge(){
  const badge=$('#policyBadge'); if(!badge) return;
  const seen=new Set(loadPolicySeen());
  const unseen=policyAlertsCache.filter(k=>!seen.has(k)).length;
  badge.textContent=unseen;
  badge.style.display=unseen?'inline-block':'none';
  badge.title='自上次查看以来新增 '+unseen+' 条高影响政策';
}
/* 进入政策快讯 → 把当前高影响政策记为已读，徽标立即清零 */
function markPolicySeen(){
  const seen=new Set(loadPolicySeen());
  for(const k of policyAlertsCache) seen.add(k);
  savePolicySeen([...seen]);
  updatePolicyBadge();
}
async function loadPolicyNews(force){
  const box=$('#policyNewsBox');
  if(!box) return;
  const r=await api('/api/v2/news-pulse'+(force?'?force=1':''));
  const d=r.data||{};
  const list=d.policyNews||[];
  const meta=$('#policyMeta');
  if(meta) meta.textContent='更新于 '+(d.at||'--')+' · 共 '+(d.newsCount||0)+' 条新闻 · 政策相关 '+list.length+' 条';
  policyAlertsCache=list.filter(n=>n.alert).map(policyAlertKey).filter(Boolean);
  updatePolicyBadge();
  if(typeof loadPolicyTriage==='function') loadPolicyTriage();
  if(!list.length){ box.innerHTML='<div class="empty">暂无政策相关新闻；可点击「立即刷新」重新抓取。</div>'; return; }
  const key=list.map(x=>x.id||x.title).join('|');
  if(!force && key===lastPolicyRenderKey) return;
  lastPolicyRenderKey=key;
  const expanded=!!window.__policyExpanded;
  const visible=expanded?list.length:Math.min(POLICY_COLLAPSED_COUNT,list.length);
  box.innerHTML=list.slice(0,visible).map(n=>{
    const hot=(n.importance||0)>=85;
    const cls=hot?'policy-item hot':'policy-item';
    const tag=n.category? '<span class="policy-tag">'+esc(n.category)+'</span>':'';
    const al=n.alert?'<span class="policy-alert">高影响</span>':'';
    const link=n.link? '<a href="'+esc(n.link)+'" target="_blank" rel="noopener">原文 ↗</a>':'';
    return '<div class="'+cls+'">'+
      '<div class="policy-line1"><span class="policy-imp">'+(n.importance||0)+'</span>'+tag+al+
      '<span class="policy-time">'+esc(n.time||'时间未标注')+'</span></div>'+
      '<div class="policy-title">'+esc(n.title)+'</div>'+
      (n.desc?'<div class="policy-desc">'+esc(n.desc)+'</div>':'')+
      '<div class="policy-foot"><span>'+esc(n.source||'')+'</span><span>'+esc(n.reason||'')+'</span>'+link+'</div>'+
    '</div>';
  }).join('')+(list.length>POLICY_COLLAPSED_COUNT
      ? '<button class="btn tiny ghost policy-more" id="policyMore">'+
        (expanded?'收起（仅看前 '+POLICY_COLLAPSED_COUNT+' 条）':'展开全部（还有 '+(list.length-POLICY_COLLAPSED_COUNT)+' 条）')+'</button>'
      : '');
  const more=$('#policyMore');
  if(more) more.addEventListener('click',()=>{
    window.__policyExpanded=!window.__policyExpanded;
    lastPolicyRenderKey='';               // 无需请求后端即可重渲染
    loadPolicyNews(false);
  });
}
$('#btnPolicyRefresh')?.addEventListener('click', async()=>{
  toast('正在抓取','重新读取新闻源…');
  try{ await post('/api/v2/news-pulse/refresh',{}); }catch(_){}
  loadPolicyNews(true);
});

/* 智能体价值分级：读取 Hermes「ashare-news-triage」技能写回的标注。
   详细内容默认折叠，只显示一行汇总；无标注时只提示候选集状态，不伪造 AI 结论。 */
async function loadPolicyTriage(){
  const box=$('#policyTriageBox'); if(!box) return;
  let r;
  try{ r=await api('/api/v2/news-triage'); }catch(_){ return; }
  const t=r&&r.triage, c=r&&r.candidates;
  if(!t){
    if(c){
      box.classList.remove('hidden');
      box.innerHTML='<div class="policy-triage-head"><span class="policy-triage-tag">智能体筛选 · 候选集就绪</span>'+
        '<span>已扫描 '+esc(String((c.recall&&c.recall.scannedTotal)||0))+' 条新闻，召回 '+esc(String((c.recall&&c.recall.returned)||0))+
        ' 条待精排 · 生成于 '+esc(c.generatedAt||'--')+'</span></div>'+
        '<div class="note" style="margin-top:6px">让 Hermes 使用 <code>ashare-news-triage</code> 技能对候选集做价值分级，'+
        '结果写回后此处自动显示。当前无智能体标注，界面仍以确定性规则筛选结果为准。</div>';
    }else box.classList.add('hidden');
    return;
  }
  const open=!!window.__policyTriageOpen;
  const hi=t.items.filter(x=>x.tier==='high'), mid=t.items.filter(x=>x.tier==='medium');
  const shown=hi.concat(mid);
  box.classList.remove('hidden');
  box.innerHTML=
    '<div class="policy-triage-head">'+
      '<span class="policy-triage-tag">智能体价值分级 · AI 建议</span>'+
      '<span>高价值 '+hi.length+' · 中等 '+mid.length+' · 低/噪音 '+(t.items.length-shown.length)+' 条 · '+esc(t.generatedAt||'--')+'</span>'+
      '<button class="btn tiny ghost" id="policyTriageToggle">'+(open?'收起 ▴':'展开明细 ▾')+'</button>'+
    '</div>'+
    (open
      ? '<div class="policy-triage-items">'+
          (shown.length?shown.map(x=>
            '<div class="policy-triage-item"><span class="policy-triage-tier tier-'+esc(x.tier)+'">'+
            (x.tier==='high'?'高价值':'中等')+'</span>'+esc(x.citedTitle||x.key)+
            '<div class="note" style="margin-top:3px">'+esc(x.reason||'')+
            (x.sectors&&x.sectors.length?' · 相关：'+esc(x.sectors.join('、')):'')+'</div></div>').join('')
            :'<div class="empty">暂无高价值 / 中等价值条目</div>')+
        '</div>'
      : '')+
    '<div class="note" style="margin-top:6px">仅为智能体基于新闻原文的语义判断，不是事实、不构成买卖建议，'+
    '也不改动规则筛选结果、量化评分与日历事件。</div>';
  const tg=$('#policyTriageToggle');
  if(tg) tg.addEventListener('click',()=>{ window.__policyTriageOpen=!window.__policyTriageOpen; loadPolicyTriage(); });
}
$('#btnPolicyTriage')?.addEventListener('click', async()=>{
  toast('正在生成','重建新闻价值分级候选集…');
  try{
    const r=await post('/api/v2/news-triage/refresh',{});
    toast('候选集已就绪','扫描 '+(r.scannedTotal||0)+' 条 · 召回 '+(r.returned||0)+' 条；可让 Hermes 用 ashare-news-triage 技能精排');
  }catch(e){ toast('生成失败',(e&&e.message)||'',true); }
  loadPolicyTriage();
});
async function loadMonitor(){
  const r=await api('/api/v2/daily/market');
  const box=$('#marketMonitorBox');
  if(!r.ok){ box.innerHTML='<div class="empty">'+(r.note||'暂无数据')+'</div>'; return; }
  const v=r;
  const volCls = /放/.test(v.state)?'up':/缩/.test(v.state)?'down':'flat';
  box.innerHTML=`
    <div class="metric-row">
      <div class="metric"><div class="k">两市成交额</div><div class="v">${v.amountYi!=null?v.amountYi:'--'}<span style="font-size:12px"> 亿</span></div></div>
      <div class="metric"><div class="k">较20日均量</div><div class="v ${volCls}">${v.ratio20!=null?Math.round(v.ratio20*100)+'%':'--'}</div></div>
      <div class="metric"><div class="k">量能状态</div><div class="v ${volCls}" style="font-size:16px">${esc(v.state)}</div></div>
      <div class="metric"><div class="k">沪指 / 深成</div><div class="v" style="font-size:15px"><span class="${pctClass(v.shPct)}">${pctText(v.shPct)}</span> / <span class="${pctClass(v.szPct)}">${pctText(v.szPct)}</span></div></div>
      <div class="metric"><div class="k">上涨占比</div><div class="v">${v.breadth&&v.breadth.upRatio!=null?v.breadth.upRatio+'%':'--'}</div></div>
    </div>
    <div class="monitor-conclusion"><b>整体动力：</b>${esc(v.momentum||v.priceVolume||'--')}</div>
    <div class="note" style="margin-top:10px">数据时点：${esc(v.tradingDate)} ${esc(v.at)} · 量能每15分钟播报一次 · ${esc(v.trading?'交易时段':'非交易时段')}</div>
  `;
  $('#marketStamp').textContent='更新于 '+v.at;
}
/* ---------------- 全球市场监控：消费真实 quotes（红涨绿跌） ----------------
 * 数据来源：/api/snapshot 首帧与 SSE tick（15 秒推送）；服务端 sources.js
 * CNBC + 新浪 + 东财/新浪国际指数 + OKX/CoinGecko。缺数据的源如实留空，不编造。
 */
const GQ_GROUPS = [
  { title:'全球股指',    ids:['dji','spx','ndx','n225','hsi','ftse','ks11'] },
  { title:'比特币',      ids:['btc'] },
  { title:'黄金 / 原油', ids:['gold','xau','wti','brent'] },
  { title:'美债收益率',  ids:['ust10y','ust2y','ust30y','spread'] },
  { title:'美元指数',    ids:['dxy'] }
];
function gqFmt(q){
  const v = q && q.value!=null ? Number(q.value) : NaN;
  if(!Number.isFinite(v)) return '--';
  const d = q && Number.isFinite(q.decimals) ? q.decimals : 2;
  return v.toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d});
}
function gqRow(q){
  const pct = (q.changePct==null || !Number.isFinite(Number(q.changePct))) ? null : Number(q.changePct);
  const cls = pct==null ? 'flat' : pctClass(pct);
  const unit = q.unit ? '<span class="gq-unit">'+esc(q.unit)+'</span>' : '';
  const extra = q.id==='btc' && q.high24h!=null
    ? '<div class="gq-extra">24h 高 '+gqFmt({value:q.high24h,decimals:0})+' · 低 '+gqFmt({value:q.low24h,decimals:0})+'</div>'
    : '';
  return '<div class="gq-item" title="'+esc(q.source||'')+'">'+
    '<div class="gq-name">'+esc(q.short||q.name||q.id)+'</div>'+
    '<div class="gq-val">'+gqFmt(q)+unit+'</div>'+
    '<div class="gq-chg '+cls+'">'+(pct==null?'--':pctText(pct))+'</div>'+
    (q.quality==='delayed'?'<span class="gq-delay" title="延迟报价，非实时">延迟</span>':'')+
    extra+'</div>';
}
function renderGlobalQuotes(quotes, fetchedAt, health){
  const box=$('#globalQuotesBody');
  if(!box) return;
  if(!Array.isArray(quotes) || !quotes.length){
    box.innerHTML='<div class="empty">当前无全球行情数据（数据源不可用时不编造）</div>';
    return;
  }
  const byId=new Map(quotes.map(q=>[q.id,q]));
  let html='', total=0;
  for(const g of GQ_GROUPS){
    const list=g.ids.map(id=>byId.get(id)).filter(Boolean);
    if(!list.length) continue;
    total+=list.length;
    html+='<div class="gq-group"><div class="gq-group-title">'+esc(g.title)+'</div>'+
      '<div class="gq-grid">'+list.map(gqRow).join('')+'</div></div>';
  }
  const known=new Set(GQ_GROUPS.flatMap(g=>g.ids));
  const rest=quotes.filter(q=>!known.has(q.id));
  if(rest.length){
    total+=rest.length;
    html+='<div class="gq-group"><div class="gq-group-title">其他外围</div>'+
      '<div class="gq-grid">'+rest.map(gqRow).join('')+'</div></div>';
  }
  const t=fetchedAt ? new Date(Number(fetchedAt)+8*3600e3).toISOString().slice(0,16).replace('T',' ') : '--';
  const src=health && health.overseasSource ? ' · 股指源 '+(health.overseasSource==='sina'?'新浪备源':'东财') : '';
  box.innerHTML=html+'<div class="gq-foot">共 '+total+' 项 · 采集时点 '+esc(t)+'（北京时间）'+esc(src)+
    ' · 逐项标注来源（悬停查看）· 红涨绿跌</div>';
  const stamp=$('#globalQuotesStamp');
  if(stamp) stamp.textContent='更新于 '+t;
}
async function loadGlobalQuotes(){
  const r=await api('/api/snapshot');
  if(r.ok && r.data) renderGlobalQuotes(r.data.quotes, r.data.quoteFetchedAt, r.data.health);
  else { const b=$('#globalQuotesBody'); if(b) b.innerHTML='<div class="empty">全球行情读取失败：'+esc(r.error||'')+'</div>'; }
}
$('#btnMarketRefresh').addEventListener('click', ()=>{ loadMarket(); toast('已刷新','正在重新读取缓存数据'); });
$('#btnMarketAI').addEventListener('click', async()=>{
  $('#marketForecastText').innerHTML='<span class="note">智能体分析中…</span>';
  $('#forecastStatus').textContent='生成中';
  const r=await api('/api/v2/daily/forecast');
  if(r.ok && r.forecast){ $('#marketForecastText').innerHTML=esc(r.forecast); $('#forecastStatus').textContent=r.backend||'已生成'; }
  else $('#marketForecastText').innerHTML='<div class="note">预测生成失败：'+esc(r.forecastError||r.note||r.error||'未知')+'</div>';
  // 板块解读
  const sr=await api('/api/v2/daily/sectors/brief');
  if(sr.ok && sr.analysis){ $('#sectorAiBox').style.display='block'; $('#sectorAiText').innerHTML=esc(sr.analysis); }
});
async function loadSectors(){
  const r=await api('/api/v2/daily/sectors');
  const box=$('#sectorBox');
  if(!r.ok){ box.innerHTML='<div class="empty">'+(r.note||'暂无数据')+'</div>'; return; }
  const cards = s => `<div class="sector-item">
      <div class="sector-name"><span>${esc(s.name)}</span><span class="${pctClass(s.chg5)}">${pctText(s.chg5)}</span></div>
      <div class="sector-metrics"><span>5日超额 <b class="${pctClass(s.ex5)}">${pctText(s.ex5)}</b></span><span>10日超额 <b class="${pctClass(s.ex10)}">${pctText(s.ex10)}</b></span><span>宽度 <b>${s.breadth!=null?s.breadth+'%':'--'}</b></span><span>拥挤 <b>${s.crowdCross!=null?s.crowdCross:'--'}</b></span></div>
    </div>`;
  let html = '';
  if(r.longGrowth && r.longGrowth.length) html+='<div class="sect-sec-title">长增长候选（中期超额为正 + 宽度强 + 未过热）</div><div class="sector-grid">'+r.longGrowth.map(cards).join('')+'</div>';
  if(r.sustained && r.sustained.length) html+='<div class="sect-sec-title">资金持续流入迹象（5日与10日相对强度同向为正）</div><div class="sector-grid">'+r.sustained.map(cards).join('')+'</div>';
  if(!html) html='<div class="empty">当前无符合条件的板块</div>';
  html+='<div class="note" style="margin-top:12px">'+esc(r.note||'')+'</div>';
  box.innerHTML=html;
}
function screenNote(s, ok){
  const u=s.universe||{};
  return ok ? ((u.fetched||0)+' 只已算 / '+(u.failed||0)+' 只失败 · '+(s.at||'--')) : (s.note||'');
}
function stockRow(x, kind){
  const score = x.scoreAdjusted!=null?x.scoreAdjusted:x.score;
  let metrics='';
  if(kind==='hot') metrics=
    '<span class="stock-metric up">5日 <b>'+pctText(x.ret5)+'</b></span>'+
    '<span class="stock-metric">行业 '+pctText(x.industryRet5)+'</span>'+
    '<span class="stock-metric up">独立超额 <b>'+(x.independent!=null?(x.independent>0?'+':'')+x.independent+'pct':'--')+'</b></span>'+
    '<span class="stock-metric">热度 '+(x.heat!=null?x.heat:'--')+'（'+esc(x.heatSource||'--')+'）</span>';
  else if(kind==='trend') metrics=
    '<span class="stock-metric">规则 <b>'+esc(x.rule||'--')+'</b></span>'+
    '<span class="stock-metric">5日破MA5 <b>'+x.breaks+'</b> 次</span>'+
    '<span class="stock-metric up">创新高 <b>'+(x.newHigh?'是':'否')+'</b></span>'+
    '<span class="stock-metric">近5日 '+pctText(x.ret5)+'</span>'+
    '<span class="stock-metric">现价 '+(x.last!=null?x.last:'--')+' / MA5 '+(x.ma5!=null?x.ma5:'--')+'</span>';
  else metrics=
    '<span class="stock-metric down">20日 <b>'+pctText(x.ret20)+'</b></span>'+
    '<span class="stock-metric">RSI14 <b>'+(x.rsi14!=null?x.rsi14:'--')+'</b></span>'+
    '<span class="stock-metric">偏离MA20 '+pctText(x.dev20)+'</span>'+
    '<span class="stock-metric up">下影 <b>'+(x.shadowPct!=null?x.shadowPct+'%':'--')+'</b></span>'+
    '<span class="stock-metric">收盘位置 '+(x.closePos!=null?x.closePos+'%':'--')+'</span>'+
    '<span class="stock-metric">量能 '+esc(x.volumeState||'--')+'</span>';
  const parts=(x.scoreParts||[]).map(p=>p.label+' '+p.score).join(' · ');
  return '<div class="stock-row">'+
    '<div class="stock-score"><span class="sv">'+(score!=null?score:'--')+'</span><span class="sl">评分</span></div>'+
    '<div class="stock-main"><div class="stock-top"><span class="stock-name">'+esc(x.name||'--')+'</span><span class="stock-code">'+esc(x.code)+'</span>'+
    '<button class="stock-analyze" data-analyze data-code="'+esc(x.code)+'" data-name="'+esc(x.name||'')+'">指标</button>'+'</div>'+
    '<div class="stock-metrics">'+metrics+'</div>'+
    (score!=null?('<div class="score-bar"><i style="width:'+score+'%"></i></div>'):'')+
    (x.reason?('<div class="stock-reason">'+esc(x.reason)+(parts?(' <span style="color:var(--ink3)">['+esc(parts)+']</span>'):'')+'</div>'):'')+
    (x.newsReason?('<div class="stock-news">'+esc(x.newsReason)+'</div>'):'')+
    '</div></div>';
}
function focusHtml(grp){
  const f=(grp&&grp.focus)||[];
  if(!f.length) return '';
  return '<div class="pick-focus"><b>重点关注 · 按量化评分排序：</b>'+
    f.map((x,i)=>('<span style="margin-left:8px;white-space:nowrap">'+(i+1)+'. '+esc(x.name||x.code)+' <b>'+(x.score!=null?x.score:'--')+'分</b></span>')).join('')+'</div>';
}
let pickFilterKind='all';
let unifiedPicks=null;
let techView=null;
let techByCode=new Map();
function kindTag(x){
  const map={hot:['热度独立','k-hot'],trend:['趋势','k-trend'],rebound:['反弹','k-rebound'],
    dip:['低吸','k-dip'],board:['打板','k-board'],breakout:['趋势突破','k-breakout']};
  const labelKey={'趋势':'trend','低吸':'dip','打板':'board','趋势突破':'breakout','热度/独立行情':'hot','强势反弹':'rebound'};
  const labels=(Array.isArray(x.classes)&&x.classes.length)?x.classes:[x.kindLabel||x.kind||''];
  return labels.map(lb=>{
    const key=labelKey[lb]||x.kind;
    const m=map[key]||[lb||'未分类','k-hot'];
    return '<span class="k-tag '+m[1]+'">'+esc(m[0])+'</span>';
  }).join('');
}
function roleTag(x){
  if(x.role==='leader') return '<span class="r-tag r-leader">★ 板块领跑</span>';
  if(x.role==='follower') return '<span class="r-tag r-follower">↳ 跟随 '+(esc(x.leaderName||'')||'')+'</span>';
  return '';
}
function driversHtml(x){
  const ds=x.riseDrivers||[];
  if(!ds.length) return '';
  const label={technical:'技术面',capital:'资金盘口',news:'公告/新闻',sector:'板块政策'};
  const items=ds.slice(0,5).map(d=>'<div class="drv-row"><span class="drv-type t-'+d.type+'">'+(label[d.type]||d.type)+'</span><span class="drv-text">'+esc(d.text)+(d.ref?' <a href="'+esc(d.ref)+'" target="_blank" rel="noopener">原文</a>':'')+'</span><span class="drv-src">'+esc(d.source||'')+'</span></div>').join('');
  return '<div class="drv-list"><div class="drv-head">上涨驱动线索 <span class="note">（可核验事实，非因果认定）</span></div>'+items+'</div>';
}
function unifiedRow(x){
  const score=x.score!=null?x.score:'--';
  const ind=x.industry?('<span class="u-industry">'+esc(x.industry)+(x.industryApprox?'<span class="approx">近似</span>':'')+'</span>'):'<span class="u-industry none">行业待补</span>';
  const metrics=[];
  if(x.ret5!=null) metrics.push('5日 '+pctText(x.ret5));
  if(x.ret20!=null) metrics.push('20日 '+pctText(x.ret20));
  if(x.independent!=null) metrics.push('独立超额 '+(x.independent>0?'+':'')+x.independent+'pct');
  if(x.boards) metrics.push(x.boards+' 连板');
  if(x.last!=null) metrics.push('现价 '+x.last);
  const sig=techSignalBrief(x.code);
  return '<div class="u-row u-row-v2" data-code="'+esc(x.code)+'">'+
    '<div class="u-bar" data-udetail="'+esc(x.code)+'" title="点击展开 / 收起详细指标">'+
      '<div class="u-score"><span class="sv">'+score+'</span><span class="sl">评分</span></div>'+
      '<div class="u-bar-main"><div class="u-bar-line">'+kindTag(x)+roleTag(x)+
        '<span class="stock-name">'+(esc(x.name)||esc(x.code))+'</span><span class="stock-code">'+esc(x.code)+'</span>'+ind+
        '<span class="u-signal">'+sig+'</span>'+
        '<button class="stock-analyze" data-analyze data-code="'+esc(x.code)+'" data-name="'+esc(x.name||'')+'">指标</button>'+
        '<span class="u-caret">▾</span></div>'+
        (x.score!=null?('<div class="score-bar slim"><i style="width:'+score+'%"></i></div>'):'')+
      '</div></div>'+
    '<div class="u-detail" hidden>'+
      '<div class="u-metrics">'+metrics.map(m=>'<span class="stock-metric">'+esc(m)+'</span>').join('')+'</div>'+
      (x.driverSummary?'<div class="u-driver-sum">'+esc(x.driverSummary)+'</div>':'')+
      driversHtml(x)+techDetailHtml(x.code)+
    '</div></div>';
}
/** 条状行上的关键信号摘要：来自服务端确定性技术标注，无可造数据 */
function techSignalBrief(code){
  const t=techByCode.get(String(code));
  if(!t||!t.calc) return '<span class="u-sig-none">技术标注待生成</span>';
  const fs=(t.calc.factors||[]);
  const hits=fs.filter(f=>f.hit===true);
  const pat=(t.calc.patterns&&t.calc.patterns.rules||[]).filter(r=>r.hit===true);
  const tags=[];
  if(t.stale) tags.push('<span class="u-sig warn">日线源不可达 · 沿用上次快照</span>');
  const kdj=fs.find(f=>f.key==='kdj');
  if(kdj&&kdj.value&&kdj.value.cross&&kdj.value.cross!=='none')
    tags.push('<span class="u-sig '+(kdj.value.cross==='gold'?'bull':'bear')+'">KDJ'+(kdj.value.cross==='gold'?'金叉':'死叉')+'</span>');
  const bb=fs.find(f=>f.key==='buybackPrice');
  if(bb&&bb.hit) tags.push('<span class="u-sig warn">回购偏离</span>');
  const mna=fs.find(f=>f.key==='mnaCapRef');
  if(mna&&mna.hit) tags.push('<span class="u-sig warn">收购/重组</span>');
  tags.push('<span class="u-sig count">因子 '+hits.length+'/'+fs.length+' · 形态 '+pat.length+'</span>');
  return tags.join('');
}
/** 折叠区里的完整技术指标详情：10 项确定性因子 + 24 条绝招形态 + 评估口径 */
function techDetailHtml(code){
  const t=techByCode.get(String(code));
  if(!t||!t.calc) return '<div class="tech-empty">该标的暂无确定性技术标注（观察池定向计算，未覆盖全部标的；不臆测）。</div>';
  const c=t.calc;
  const st=f=>f.hit===true?'<span class="tech-hit yes">命中</span>':f.hit===false?'<span class="tech-hit no">未命中</span>':'<span class="tech-hit na">不可得</span>';
  const groups={};
  (c.factors||[]).forEach(f=>{
    const fam=/kdj|breakMa5Two|holdMa5NewHigh|resilience|tightRange|phaseVolume/.test(f.key)?'趋势与量能':
      /capPercentile|longMa/.test(f.key)?'市值与长期均线':'事件与回购';
    (groups[fam]=groups[fam]||[]).push(f);
  });
  let h='<div class="tech-detail"><div class="tech-h">确定性技术因子 <span class="note">真实前复权日线逐条计算 · 只读标注 · 不进评分</span></div>'+
    (t.stale?'<div class="tech-stale">⚠ 本次日线源不可达，以下沿用上一次成功快照（已标 stale），非当日重算结果。</div>':'');
  Object.keys(groups).forEach(g=>{
    h+='<div class="tech-grp"><div class="tech-grp-t">'+esc(g)+'</div>';
    groups[g].forEach(f=>{
      h+='<div class="tech-f"><div class="tech-f-top">'+st(f)+'<b>'+esc(f.label)+'</b></div>'+
        '<div class="tech-f-note">'+esc(f.note||'')+'</div></div>';
    });
    h+='</div>';
  });
  const p=c.patterns;
  if(p&&p.ok){
    const hit=(p.rules||[]).filter(r=>r.hit===true);
    h+='<div class="tech-h">绝招形态库 <span class="note">共 '+p.rules.length+' 条判据 · 命中 '+p.hitCount+' · 不可得 '+p.unavailable+' · 原文买卖点已转为「依据 + 失效条件」</span></div>';
    if(!hit.length) h+='<div class="tech-empty">当日无形态命中（不编造命中项）。</div>';
    else h+=hit.map(r=>'<div class="tech-pat"><div class="tech-pat-t"><span class="tech-hit yes">命中</span><b>'+esc(r.name)+'</b><span class="note">'+esc(r.family)+' · '+esc(r.spec)+'</span></div>'+
      '<div class="tech-pat-b">依据：'+esc(r.basis)+'</div>'+
      '<div class="tech-pat-i">失效条件：'+esc(r.invalid)+'</div></div>').join('');
    const meth=(techView&&techView.patternsMethodology)||[];
    if(meth.length) h+='<details class="tech-meth"><summary>评估口径 · 与市面通用量化指标的对照（'+meth.length+' 条）</summary><ol>'+
      meth.map(m=>'<li>'+esc(m)+'</li>').join('')+'</ol></details>';
  }
  h+='<div class="tech-foot">'+esc(p&&p.note?p.note:'形态命中仅为技术条件标注，不含「必涨 / 买卖点」含义。')+'</div></div>';
  return h;
}
function renderUnified(){
  const box=$('#unifiedBox'); if(!box||!unifiedPicks) return;
  let items=(unifiedPicks.items||[]);
  if(pickFilterKind==='leader') items=items.filter(x=>x.role==='leader');
  else if(pickFilterKind==='follower') items=items.filter(x=>x.role==='follower');
  else if(pickFilterKind!=='all') items=items.filter(x=>x.kind===pickFilterKind ||
    (Array.isArray(x.classes) && x.classes.some(c=>({'趋势':'trend','低吸':'dip','打板':'board','趋势突破':'breakout'})[c]===pickFilterKind)));
  if(!items.length){ box.innerHTML='<div class="empty">当前筛选下无标的</div>'; return; }
  box.innerHTML='<div class="u-list">'+items.slice(0,40).map(unifiedRow).join('')+'</div>'+
    '<div class="note" style="margin-top:10px">'+esc(unifiedPicks.note||'')+'</div>';
  // 指标按钮由 document 级委托统一处理；条状行点击折叠展开详细指标
  $$('.u-bar',box).forEach(bar=>bar.addEventListener('click',e=>{
    if(e.target.closest('[data-analyze]')) return;
    const row=bar.closest('.u-row'), d=row&&row.querySelector('.u-detail');
    if(!d) return;
    d.hidden=!d.hidden;
    row.classList.toggle('open',!d.hidden);
    const c=bar.querySelector('.u-caret'); if(c) c.textContent=d.hidden?'▾':'▴';
  }));
}

/* ---------------- 市场级量化标注（板块带动 / 哑铃 / 经验 / 回购） ---------------- */
function regRow(label,value,note){
  return '<div class="reg-row"><span class="reg-k">'+esc(label)+'</span><span class="reg-v">'+value+'</span>'+
    (note?'<span class="reg-note">'+esc(note)+'</span>':'')+'</div>';
}
function renderRegime(){
  const box=$('#regimeBox'); if(!box) return;
  const r=techView&&techView.regime;
  if(!r||!r.ok){ box.innerHTML='<div class="empty">市场级标注尚未生成（技术标注模块启动后自动计算）。</div>'; return; }
  let h='<div class="reg-wrap"><div class="reg-meta">数据时点 '+esc(r.at||'--')+' · 交易日 '+esc(r.tradingDate||'--')+'</div>';
  const bl=r.boardLeadership||{};
  h+='<div class="reg-sec"><div class="reg-t">① 哪些板块带动指标上涨 <span class="note">贡献度 ≈ 涨跌 × 成交额，非真实指数权重分解</span></div>';
  if(bl.ok){
    h+=regRow('指数当日',bl.indexPct==null?'不可得':(bl.indexPct>0?'+':'')+bl.indexPct+'%',bl.indexUp==null?'':(bl.indexUp?'收涨':'未收涨'));
    h+='<div class="reg-cols"><div><div class="reg-sub">带动板块（按贡献度）</div>'+
      (bl.driving||[]).slice(0,6).map(b=>regRow(esc(b.name),(b.chg1>0?'+':'')+b.chg1+'%','权重 '+(b.weightPct==null?'--':b.weightPct+'%')+' · 贡献 '+(b.contrib==null?'--':b.contrib))).join('')+'</div>'+
      '<div><div class="reg-sub">指标涨 / 板块不涨</div>'+
      ((bl.lagging||[]).length?(bl.lagging||[]).slice(0,6).map(b=>regRow(esc(b.name),(b.chg1>0?'+':'')+b.chg1+'%','跑输或下跌')).join(''):'<div class="reg-none">无（或指数未收涨，口径不适用）</div>')+'</div></div>';
    h+='<div class="reg-note2">'+esc(bl.note||'')+'</div>';
  } else h+='<div class="reg-none">'+esc(bl.note||'不可得')+'</div>';
  h+='</div>';
  const bb=r.barbell||{};
  h+='<div class="reg-sec"><div class="reg-t">② 震荡期哑铃效应 + 大盘哑铃 <span class="note">结合全球市场当下什么最赚钱判别</span></div>';
  if(bb.ok){
    h+=regRow('哑铃特征',bb.isBarbell==null?'不可得':(bb.isBarbell?'命中':'未命中'),'两端−中间：当日 '+(bb.spread1==null?'--':bb.spread1)+'pct / 5日 '+(bb.spread5==null?'--':bb.spread5)+'pct');
    h+='<div class="reg-cols"><div><div class="reg-sub">A 股市值分层</div>'+
      (bb.layers||[]).map(l=>regRow(esc(l.name),(l.pct1==null?'--':(l.pct1>0?'+':'')+l.pct1+'%'),'5日 '+(l.ret5==null?'--':l.ret5))).join('')+'</div>'+
      '<div><div class="reg-sub">全球倾向</div>'+regRow('风险 / 避险',(bb.global&&bb.global.tilt)||'unknown',
        '风险均值 '+(bb.global&&bb.global.riskAvg!=null?bb.global.riskAvg:'--')+' / 避险均值 '+(bb.global&&bb.global.safeAvg!=null?bb.global.safeAvg:'--'))+
      ((bb.global&&bb.global.best||[]).length?'<div class="reg-best">领涨：'+(bb.global.best||[]).map(x=>esc(x.name)+' '+(x.chg>0?'+':'')+x.chg+'%').join(' · ')+'</div>':'')+
      '<div class="reg-note2">'+esc(bb.global&&bb.global.note||'')+'</div></div></div>';
    h+='<div class="reg-note2">'+esc(bb.note||'')+'</div>';
  } else h+='<div class="reg-none">'+esc(bb.note||'不可得')+'</div>';
  h+='</div>';
  const ex=r.experience||{};
  h+='<div class="reg-sec"><div class="reg-t">③ 经验条目事实核对</div>';
  if(ex.ok){
    h+=regRow(esc(ex.userClaim||'用户经验'),'<b>'+esc(ex.claimStatus||'')+'</b>','以本地真实板块快照为准，不把口述写成系统结论');
    h+='<div class="reg-inline">当日领涨：'+(ex.topBoards||[]).slice(0,5).map(b=>esc(b.name)+' '+(b.chg1>0?'+':'')+b.chg1+'%').join(' · ')+'</div>';
    h+='<div class="reg-inline">化学/电子化学相关：'+((ex.chemBoards||[]).length?(ex.chemBoards||[]).slice(0,4).map(b=>esc(b.name)+' '+b.chg1+'%（第'+b.rank+'/'+b.total+'）').join(' · '):'无匹配板块')+'</div>';
  } else h+='<div class="reg-none">'+esc(ex.note||'不可得')+'</div>';
  h+='</div>';
  const by=r.buyback||{};
  h+='<div class="reg-sec"><div class="reg-t">④ 股份回购价格区间 vs 现价 <span class="note">重点标注 · 标题无价格标「待补正文」</span></div>';
  if(by.ok){
    h+=regRow('回购公告',by.count+' 条','重点标注 '+by.highlighted+' 条 · 未含价格 '+by.missingPrice+' 条');
    const hi=(by.items||[]).filter(x=>x.highlight).slice(0,6);
    h+=hi.length?hi.map(x=>'<div class="reg-bb"><b>'+esc(x.name||x.code)+'</b> <span class="stock-code">'+esc(x.code)+'</span> '+
      '<span class="u-sig warn">'+esc((x.tags||[]).join(' / '))+'</span><div class="reg-note2">'+esc((x.notes||[]).join(' '))+'</div>'+
      '<div class="reg-note2">'+esc(x.title||'')+'</div></div>').join(''):'<div class="reg-none">当前无重点偏离标注（不代表无回购公告）。</div>';
    h+='<div class="reg-note2">'+esc(by.disclaimer||'')+'</div>';
  } else h+='<div class="reg-none">回购快照不可得</div>';
  h+='</div>';
  h+='<div class="reg-foot">'+esc(r.disclaimer||'')+'</div></div>';
  box.innerHTML=h;
}

/* ---------------- 盘后复盘专家团（智能体不做预判） ----------------
 * 渲染交给 review-render.js（零依赖 UMD）：把接口返回的结构化 facts
 * 渲染成四角色事实卡 + 分段叙述，可切「原文」逐字对照；预览页共用同一渲染。 */
async function runReviewTeam(noAI){
  const box=$('#reviewTeamBox'); if(!box) return;
  box.innerHTML='<div class="empty">正在汇总四角色事实'+(noAI?'（仅程序事实）':'并调用智能体')+'…</div>';
  try{
    const r=await post('/api/v2/daily/review-team',{noAI:!!noAI});
    if(!r||!r.ok){ box.innerHTML='<div class="empty">复盘接口未返回数据</div>'; return; }
    const RR=window.ReviewRender;
    if(!RR||typeof RR.render!=='function'){ box.innerHTML='<div class="empty">复盘渲染模块未加载</div>'; return; }
    box.innerHTML=RR.render(r);
    const views=$$('[data-rt-view]',box);
    views.forEach(b=>b.addEventListener('click',()=>{
      const v=b.dataset.rtView;
      views.forEach(x=>x.classList.toggle('active',x===b));
      const st=$('[data-rt-struct]',box), raw=$('[data-rt-raw]',box);
      if(st) st.hidden=(v!=='struct');
      if(raw) raw.hidden=(v!=='raw');
    }));
  }catch(e){ box.innerHTML='<div class="empty">复盘失败：'+esc(String(e.message||e))+'</div>'; }
}
function bindAnalyzeButtons(scope){
  $$('[data-analyze]',scope).forEach(b=>b.addEventListener('click',()=>openStockAnalysis(b.dataset.code,b.dataset.name)));
}
function renderLeaderFollow(r){
  const box=$('#leaderFollowBox'); if(!box) return;
  const leaders=r.unified&&r.unified.leaders||[];
  const followers=(r.unified&&r.unified.followers)||{};
  if(!leaders.length){ box.innerHTML='<div class="empty">当前无板块领跑判定</div>'; return; }
  box.innerHTML=leaders.slice(0,12).map(l=>{
    const fl=followers[l.industry+'::'+l.code]||[];
    return '<div class="lf-block"><div class="lf-leader"><span class="lf-badge">领跑</span><b>'+(esc(l.name)||esc(l.code))+'</b><span class="stock-code">'+esc(l.code)+'</span>'+
      '<span class="u-industry">'+esc(l.industry)+'</span><span class="note">'+esc(l.basis||'')+(l.sectorBias?(' · 消息面'+esc(l.sectorBias.direction)+'/'+l.sectorBias.score):'')+'</span></div>'+
      (fl.length?'<div class="lf-followers"><div class="lf-label">同板块跟随候选（按启动迹象排序）：</div>'+fl.slice(0,6).map(f=>
        '<div class="lf-follow"><span class="r-tag r-follower">↳</span><b>'+(esc(f.name)||esc(f.code))+'</b><span class="stock-code">'+esc(f.code)+'</span>'+
        '<span class="note">'+esc(f.followBasis||'')+'</span></div>').join('')+'</div>':'<div class="note lf-none">该板块暂无跟随候选</div>')+'</div>';
  }).join('');
}
async function loadPickPool(){
  const box=$('#pickPoolBox'), note=$('#pickPoolNote'); if(!box) return;
  const r=await api('/api/v2/pick-pool');
  if(!r.ok){ box.innerHTML='<div class="empty">预测池读取失败</div>'; return; }
  if(!r.frozen){ note.textContent='今日尚未定格（09:05 自动执行）'; box.innerHTML='<div class="empty">今日 09:05 尚未定格预测股票池，可点「立即定格」手动生成</div>'; return; }
  const p=r.pool||{};
  note.textContent=(p.frozenAt||'')+' · '+p.count+' 只 · 领跑 '+(p.leaders||[]).length+' 只'+(p.review?(' · 已复盘 '+p.review.reviewed+' 条'):' · 待晚间复盘');
  box.innerHTML='<div class="u-list">'+(p.items||[]).map(x=>
    '<div class="u-row"><div class="u-score"><span class="sv">'+(x.score!=null?x.score:'--')+'</span><span class="sl">评分</span></div>'+
    '<div class="u-main"><div class="u-top">'+kindTag(x)+roleTag(x)+'<span class="stock-name">'+(esc(x.name)||esc(x.code))+'</span><span class="stock-code">'+esc(x.code)+'</span>'+
    (x.industry?'<span class="u-industry">'+esc(x.industry)+'</span>':'')+'<span class="stock-metric">参考价 '+(x.price!=null?x.price:'--')+'</span></div>'+
    '<div class="u-driver-sum">'+esc(x.driverSummary||'')+'</div>'+(x.driverRefs&&x.driverRefs.length?'<div class="drv-row"><span class="drv-text">'+esc(x.driverRefs[0].text.slice(0,120))+'</span></div>':'')+'</div></div>').join('')+'</div>'+
    (r.outcomes&&r.outcomes.length?'<div class="pick-review"><b>当日复盘：</b>'+r.outcomes.slice(0,8).map(o=>esc(o.name||o.code)+' 收益 '+pctText(o.ret)+(o.excess!=null?(' 超额 '+pctText(o.excess)):'')).join('；')+'</div>':'');
}
/** 短线情绪三项卡片：赚钱效应 / 连板高度 / 炸板率 + 市场级提示 */
function renderSentiment(d, pools){
  const box=$('#sentimentBox'); if(!box) return;
  const meta=$('#sentimentMeta'); const p=pools||{};
  if(meta) meta.textContent = d ? ('数据时点 '+esc(d.date||'')+' · '+esc(d.generatedAt||'')) : '情绪数据未生成';
  if(!d){ box.innerHTML='<div class="empty">情绪指标尚未生成，可点「重新计算」。</div>'; return; }
  const me=d.moneyEffect||{}, bh=d.boardHeight||{}, br=d.breakRate||{};
  const moneyCls = me.ok && me.avgRet>0 ? 'up' : (me.ok && me.avgRet<0 ? 'down' : 'flat');
  const cards=[
    {k:'赚钱效应', v:me.ok?((me.avgRet>0?'+':'')+me.avgRet+'%'):'数据不足', cls:moneyCls,
      sub:me.ok?('昨日涨停股今日平均 · 上涨占比 '+me.upRatio+'% · 再涨停 '+me.againLimitRatio+'% · 样本 '+me.sample+'只'):(me.reason||'暂无样本'),
      basis:me.basis||'昨日涨停股次日收益分布'},
    {k:'连板高度', v:(bh.maxBoards!=null?bh.maxBoards+' 板':'--'), cls:'flat',
      sub:(bh.ladderText||'无梯队数据')+' · 高度 '+(bh.heightLevel||'--'), basis:bh.basis||'当日涨停池连板统计'},
    {k:'炸板率', v:(br.rate!=null?br.rate+'%':'--'), cls:'flat',
      sub:(br.level||'无样本')+' · 涨停 '+br.ztCount+' / 炸板 '+br.zbCount+' / 跌停 '+br.dtCount,
      basis:br.basis||'炸板数/(涨停+炸板)'}
  ];
  const alerts=p.alerts||[];
  box.innerHTML='<div class="senti-grid">'+cards.map(c=>
    '<div class="senti-card"><div class="senti-k">'+esc(c.k)+'</div>'+
    '<div class="senti-v '+c.cls+'">'+esc(c.v)+'</div>'+
    '<div class="senti-sub">'+esc(c.sub)+'</div>'+
    '<div class="senti-basis">'+esc(c.basis)+'</div></div>').join('')+'</div>'+
    (alerts.length?'<div class="senti-alerts"><b>市场级情绪提示：</b>'+alerts.map(a=>esc(a)).join(' ')+'</div>':'')+
    '<div class="note" style="margin-top:8px">'+esc(d.disclaimer||'程序按公开行情计算的事实指标，非买卖建议、非涨跌预测。')+'</div>';
}
function poolRow(x, isRisk, conflictCodes){
  const tags=[x.kind||x.riskType,x.industry].filter(Boolean).map(t=>'<span class="pool-tag">'+esc(t)+'</span>').join('');
  const text=isRisk?x.reason:(x.why||'');
  const sub=isRisk?'':('<div class="pool-track">次日观察：'+esc(x.track||'')+'</div>');
  const conflict=(conflictCodes&&conflictCodes.has(x.code))
    ? '<span class="pool-conflict" title="该标的同时出现在备选与规避两池，成因见上方说明">⚠ 双池重叠</span>' : '';
  return '<div class="pool-item"><div class="pool-row">'+
    '<span class="stock-code">'+esc(x.code)+'</span><span class="stock-name">'+esc(x.name||'未识别')+'</span>'+tags+conflict+
    '<button class="stock-analyze" data-analyze data-code="'+esc(x.code)+'" data-name="'+esc(x.name||'')+'">指标</button></div>'+
    '<div class="pool-why">'+esc(text)+'</div>'+sub+
    '<div class="pool-src">来源：'+esc(x.source||'')+'</div></div>';
}
function renderPools(p){
  const w=$('#watchPoolBox'), rk=$('#riskPoolBox'), meta=$('#poolsMeta');
  if(!w||!rk) return;
  if(!p){ w.innerHTML='<div class="empty">观察池未生成</div>'; rk.innerHTML='<div class="empty">风险池未生成</div>'; return; }
  const conflicts=p.conflicts||[];
  const codes=new Set(conflicts.map(c=>c.code));
  if(meta){
    const base='生成于 '+esc(p.generatedAt||'')+' · 备选 '+p.watchCount+' 只 · 规避 '+p.riskCount+' 只（研究清单，非推荐）';
    meta.innerHTML=base+(conflicts.length
      ? '<div class="pool-conflict-note">⚠ 双池重叠 '+conflicts.length+' 只：'+conflicts.map(c=>esc(c.name||c.code)+'('+esc(c.code)+')').join('、')+
        ' —— 同一「≥3 板高位连板」事实同时命中「观察池·连板梯队」与「规避池·高位回归」两条规则，两池独立生成、无互斥裁决；系统如实并列展示，不自动剔除、不给买卖判断。</div>'
      : '');
  }
  if($('#watchPoolCnt')) $('#watchPoolCnt').textContent=(p.watchCount||0)+' 只';
  if($('#riskPoolCnt')) $('#riskPoolCnt').textContent=(p.riskCount||0)+' 只';
  w.innerHTML=(p.watchPool||[]).length?(p.watchPool||[]).map(x=>poolRow(x,false,codes)).join(''):'<div class="empty">本轮无备选观察标的</div>';
  rk.innerHTML=(p.riskPool||[]).length?(p.riskPool||[]).map(x=>poolRow(x,true,codes)).join(''):'<div class="empty">本轮无风险规避标的</div>';
}
async function loadPicks(){
  const [r,sr,tr]=await Promise.all([api('/api/v2/daily/picks'), api('/api/v2/sentiment'), api('/api/technical')]);
  techView=(tr&&tr.ok&&tr.data)?tr.data:null;
  techByCode=new Map((techView&&techView.items||[]).map(x=>[String(x.code),x]));
  if(!r.ok) return;
  const four=(r.fourClass&&r.fourClass.ok)?r.fourClass:null;
  unifiedPicks=four||r.unified||null;
  $('#unifiedNote').textContent = unifiedPicks
    ? (esc(unifiedPicks.generatedAt||unifiedPicks.at||'')+' · '+(unifiedPicks.items||[]).length+' 行 · '+(four?'四类量化策略（趋势/低吸/打板/趋势突破）':'来源 '+esc(unifiedPicks.source||'')))
    : '统一视图未生成';
  renderUnified();
  renderLeaderFollow(four?{unified:four}:r);
  renderSentiment(sr&&sr.ok?sr.data:null, r.pools);
  renderPools(r.pools);
  renderRegime();
  loadPickPool();
}
$('#btnRegimeToggle')?.addEventListener('click',()=>{
  const b=$('#regimeBox'); if(b) b.hidden=!b.hidden;
});
$('#btnReviewTeam')?.addEventListener('click',()=>runReviewTeam(false));
$('#btnReviewTeamNoAI')?.addEventListener('click',()=>runReviewTeam(true));
$('#btnSentimentRefresh')?.addEventListener('click', async()=>{
  toast('计算中','正在重算赚钱效应 / 连板高度 / 炸板率…');
  try{ const r=await post('/api/v2/sentiment/refresh',{}); toast(r.ok?'已更新':'计算失败', r.ok?'情绪指标已重新计算':(r.error||'未知错误'), !r.ok); loadPicks(); }
  catch(e){ toast('计算失败',String(e.message||e),true); }
});
$$('#pickFilter .pf-btn').forEach(b=>b.addEventListener('click',()=>{
  $$('#pickFilter .pf-btn').forEach(x=>x.classList.toggle('active',x===b));
  pickFilterKind=b.dataset.kind; renderUnified();
}));
$('#btnPoolFreeze')?.addEventListener('click',async()=>{
  toast('定格中','正在把今日推荐定格到预测股票池…');
  try{ const r=await post('/api/v2/pick-pool/freeze',{}); toast('已定格',r.count+' 只推荐已写入预测池'); loadPickPool(); }
  catch(e){ toast('定格失败',String(e.message||e),true); }
});
$('#btnPoolReview')?.addEventListener('click',async()=>{
  toast('复盘中','正在复盘预测股票池…');
  try{ const r=await post('/api/v2/pick-pool/review',{}); toast('复盘完成','已复盘 '+r.reviewed+' 条 · 待定 '+r.pending); loadPickPool(); }
  catch(e){ toast('复盘失败',String(e.message||e),true); }
});

/* ---------------- ③ 我的股池 ---------------- */
$$('#portfolioTabs .tab').forEach(t=>t.addEventListener('click', ()=>{
  $$('#portfolioTabs .tab').forEach(x=>x.classList.toggle('active',x===t));
  const panels={morning:'pmorning',mine:'pmine',sold:'psold'};
  $$('#view-portfolio .tab-panel').forEach(p=>p.classList.remove('active'));
  const target=$('#'+panels[t.dataset.tab]);
  if(target) target.classList.add('active');
}));
let portfolioData=null;
function renderMorningPool(pr){
  const box=$('#morningPoolList');
  if(!box) return;
  const pool=pr && pr.pool;
  const items=(pool && Array.isArray(pool.items)) ? pool.items : [];
  if(!items.length){
    box.innerHTML='<div class="empty">今日上午尚未定格预测池。09:05 自动生成，也可在「每日行情」手动定格。</div>';
    if($('#cntMorning')) $('#cntMorning').textContent='0';
    if($('#morningMeta')) $('#morningMeta').textContent='';
    return;
  }
  if($('#cntMorning')) $('#cntMorning').textContent=items.length;
  if($('#morningMeta')) $('#morningMeta').textContent='定格 '+(pool.frozenAt||'--')+' · '+(pool.review?'已晚间复盘':'待晚间复盘');
  box.innerHTML=items.map(x=>{
    const tags=[x.industry,x.signal||x.role,('分 '+(x.score!=null?x.score:'--'))].filter(Boolean).join(' · ');
    const note=x.price!=null ? tags+' · 定格价 '+x.price : tags;
    return '<div class="morning-item">'+
      '<div class="stock-row morning-row">'+
        '<span class="stock-code">'+esc(x.code)+'</span>'+
        '<span class="stock-name">'+esc(x.name||'未识别')+'</span>'+
        '<span class="stock-note">'+esc(note)+'</span>'+
        '<button class="stock-analyze" data-analyze data-code="'+esc(x.code)+'" data-name="'+esc(x.name||'')+'">指标</button>'+
        '<button class="stock-addpick" data-addpick data-code="'+esc(x.code)+'" data-name="'+esc(x.name||'')+'" data-note="'+esc(x.driverSummary||'来自 09:05 预测池')+'" title="加入我的选股">+自选</button>'+
      '</div>'+
      (x.driverSummary?'<div class="morning-driver">上涨线索：'+esc(x.driverSummary)+'</div>':'')+
    '</div>';
  }).join('');
}
async function loadPortfolio(){
  const [r,pr]=await Promise.all([api('/api/v2/portfolio'), api('/api/v2/pick-pool')]);
  if(!r.ok) return;
  portfolioData=r;
  renderMorningPool(pr);
  const w=r.watching||{};
  if($('#cntMine')) $('#cntMine').textContent=((w.picks||[]).length+(w.holdings||[]).length);
  $('#cntSold').textContent=(r.sold||[]).length;
  const pickRows=(w.picks||[]).map(x=>`<div class="stock-row"><span class="stock-code">${x.code}</span><span class="stock-name">${esc(x.name||'未识别')}</span><span class="stock-note">${esc(x.note||'')}</span><button class="stock-analyze" data-analyze data-code="${x.code}" data-name="${esc(x.name||'')}">指标</button><button class="stock-del" data-type="pick" data-code="${x.code}" title="移除">✕</button></div>`).join('');
  $('#watchPicks').innerHTML=pickRows||'<div class="empty">暂无关注股票</div>';
  const holdRows=(w.holdings||[]).map(x=>`<div class="stock-row"><span class="stock-code">${x.code}</span><span class="stock-name">${esc(x.name||'未识别')}</span><span class="stock-note">成本 ${x.cost} × ${x.shares}股</span><button class="stock-analyze" data-analyze data-code="${x.code}" data-name="${esc(x.name||'')}">指标</button><button class="stock-del" data-type="hold" data-code="${x.code}" title="移除">✕</button></div>`).join('');
  $('#watchHoldings').innerHTML=holdRows||'<div class="empty">暂无持仓</div>';
  const sold=(r.sold||[]).map(s=>{
    const pnl=s.pnlPct;
    return `<div class="sold-row"><div class="sold-top"><span class="stock-code">${s.code}</span><span class="stock-name">${esc(s.name||'--')}</span>
      ${pnl!=null?`<span class="sold-pnl ${pctClass(pnl)}">${pctText(pnl)}</span>`:''}
      <button class="stock-del" data-type="sold" data-id="${s.id}" title="删除">✕</button></div>
      ${s.reason?`<div class="sold-reason">${esc(s.reason)}</div>`:''}
      <div class="note">${new Date(s.soldAt).toISOString().slice(0,10)} 卖出${s.sellPrice!=null?' @'+s.sellPrice:''}</div></div>`;
  }).join('');
  $('#soldList').innerHTML=sold||'<div class="empty">暂无卖出记录</div>';
  $$('.stock-del', $('#view-portfolio')).forEach(b=>b.addEventListener('click', ()=>removeStock(b)));
}
async function removeStock(btn){
  const t=btn.dataset.type;
  if(t==='sold'){ await post('/api/v2/portfolio/sold/remove',{id:btn.dataset.id}); loadPortfolio(); return; }
  // pick/hold 复用旧接口
  const path = t==='pick'?'/api/mypicks/remove':'/api/holdings/delete';
  await post(path, t==='pick'?{code:btn.dataset.code}:{code:btn.dataset.code});
  loadPortfolio();
}
$('#btnRefreshQuotes').addEventListener('click',()=>{ loadPortfolio(); toast('已刷新','行情由腾讯行情接口提供'); });
$('#btnAddSold').addEventListener('click', ()=>openModal('#modalSold'));
$('#btnSaveSold').addEventListener('click', async()=>{
  const body={code:$('#soldCode').value,name:$('#soldName').value,
    buyCost:parseFloat($('#soldBuy').value)||null, sellPrice:parseFloat($('#soldSell').value)||null,
    shares:parseInt($('#soldShares').value)||null, heldDays:parseInt($('#soldDays').value)||null,
    reason:$('#soldReason').value};
  const r=await post('/api/v2/portfolio/sold',body);
  if(r.ok){ closeModals(); ['soldCode','soldName','soldBuy','soldSell','soldShares','soldDays','soldReason'].forEach(id=>$('#'+id).value=''); loadPortfolio(); toast('已记录','卖出记录已保存'); }
  else toast('保存失败', r.error||'', true);
});

/* ---------------- ⑥ 设置 ---------------- */
let settingsCfg=null;
const SETTINGS_SPECS=[
  {group:'轮询与告警',icon:'◷',rows:[
    {k:'quoteIntervalSec',label:'行情轮询间隔',type:'number',min:5,max:600,unit:'秒',hint:'外围行情刷新频率'},
    {k:'newsIntervalSec',label:'新闻轮询间隔',type:'number',min:20,max:900,unit:'秒',hint:'政策快讯实时性由此决定'},
    {k:'cooldownSec',label:'告警冷却时间',type:'number',min:0,max:3600,unit:'秒'},
    {k:'staleAfterSec',label:'数据过期阈值',type:'number',min:30,max:3600,unit:'秒'}
  ]},
  {group:'新闻告警关键词',icon:'⚑',rows:[
    {k:'newsAlert.enabled',label:'启用新闻告警',type:'bool'},
    {k:'newsAlert.keywords',label:'自定义高影响关键词',type:'keywords',hint:'逗号分隔；政策类建议用「融资保证金」「沪深北交易所」等完整词，避免单字误报'}
  ]},
  {group:'智能体 · 大模型',icon:'◇',rows:[
    {k:'agent.apiKey',label:'DeepSeek API Key',type:'password',hint:'留空或保持掩码 = 不修改；回显永远脱敏，仅接受新 Key'},
    {k:'agent.baseUrl',label:'模型接口地址',type:'text',hint:'OpenAI 兼容 /chat/completions 基地址'},
    {k:'agent.model',label:'模型 ID',type:'text',hint:'如 deepseek-chat；以服务商官方模型列表为准'},
    {k:'agent.temperature',label:'采样温度',type:'number',min:0,max:2,step:0.1,hint:'0~2，越低越确定'},
    {k:'agent.maxTokens',label:'单次最大 token',type:'number',min:256,max:8192,step:100,unit:'tokens',hint:'单轮模型输出上限'},
    {k:'agent.maxTokensPerDay',label:'每日 token 软上限',type:'number',min:1000,max:10000000,step:10000}
  ]},
  {group:'智能体 · Hermes 桥接',icon:'◈',rows:[
    {k:'agent.hermes.enabled',label:'启用 Hermes',type:'bool'},
    {k:'agent.hermes.backend',label:'Hermes 后端',type:'select',options:['auto','official','deepseek'],hint:'auto=优先官方 Hermes，失败降级 DeepSeek'},
    {k:'agent.hermes.officialUrl',label:'Hermes 桥接地址',type:'text',hint:'WSL2 hermes_bridge.py 监听地址'},
    {k:'agent.hermes.model',label:'Hermes 模型别名',type:'text'},
    {k:'agent.hermes.timeoutMs',label:'Hermes 超时',type:'number',min:5000,max:300000,step:1000,unit:'毫秒'},
    {k:'agent.hermes.fallbackToDeepSeek',label:'失败时降级 DeepSeek',type:'bool'}
  ]},
  {group:'数据模块开关',icon:'▦',rows:[
    {k:'analysis.enabled',label:'新闻解读与综述',type:'bool'},
    {k:'stocks.enabled',label:'当日观察池',type:'bool'},
    {k:'attention.enabled',label:'人气榜与个股舆情',type:'bool'},
    {k:'marketStyle.enabled',label:'大盘量能与风格',type:'bool'},
    {k:'events.enabled',label:'公司事件与宏观',type:'bool'},
    {k:'limitUp.enabled',label:'涨停池与结构因子',type:'bool'},
    {k:'edge.enabled',label:'预期研究层',type:'bool'},
    {k:'cycle.enabled',label:'事件周期研究',type:'bool'},
    {k:'flow.enabled',label:'资金主体行为',type:'bool'},
    {k:'technical.enabled',label:'P0 技术因子',type:'bool'}
  ]},
  {group:'通知与免打扰',icon:'◔',rows:[
    {k:'sound.enabled',label:'声音提醒',type:'bool'},
    {k:'sound.minLevel',label:'声音最低级别',type:'select',options:['info','warning','critical']},
    {k:'notification.enabled',label:'桌面通知',type:'bool'},
    {k:'notification.minLevel',label:'通知最低级别',type:'select',options:['info','warning','critical']},
    {k:'quietHours.enabled',label:'启用免打扰',type:'bool'},
    {k:'quietHours.from',label:'免打扰开始',type:'text'},
    {k:'quietHours.to',label:'免打扰结束',type:'text'}
  ]}
];
function getCfgVal(obj,path){ return path.split('.').reduce((o,k)=>o&&o[k]!==undefined?o[k]:undefined,obj); }
function setCfgVal(obj,path,v){ const ks=path.split('.'); let o=obj; for(let i=0;i<ks.length-1;i++){ if(!o[ks[i]]||typeof o[ks[i]]!=='object')o[ks[i]]={}; o=o[ks[i]]; } o[ks[ks.length-1]]=v; }
async function loadSettings(){
  const r=await api('/api/config');
  if(!r.ok){ $('#settingsGrid').innerHTML='<div class="empty">配置读取失败</div>'; return; }
  settingsCfg=r.data||{};
  const grid=$('#settingsGrid');
  grid.innerHTML=SETTINGS_SPECS.map(g=>{
    const rows=g.rows.map(row=>{
      const v=getCfgVal(settingsCfg,row.k);
      let ctrl='';
      if(row.type==='bool') ctrl=`<label class="sw"><input type="checkbox" data-cfg="${row.k}" ${v?'checked':''}><i></i></label>`;
      else if(row.type==='select') ctrl=`<select class="mini-select" data-cfg="${row.k}">${row.options.map(o=>`<option value="${o}" ${v===o?'selected':''}>${o}</option>`).join('')}</select>`;
      else if(row.type==='number') ctrl=`<input class="set-num" type="number" data-cfg="${row.k}" value="${v==null?'':v}" ${row.min!=null?'min="'+row.min+'"':''} ${row.max!=null?'max="'+row.max+'"':''} ${row.step!=null?'step="'+row.step+'"':''}>${row.unit?`<span class="set-unit">${row.unit}</span>`:''}`;
      else if(row.type==='keywords') ctrl=`<textarea class="set-kw" data-cfg="${row.k}" rows="3" placeholder="逗号分隔">${esc((v||[]).join('、'))}</textarea>`;
      else if(row.type==='password') ctrl=`<input class="mini-input" type="password" data-cfg="${row.k}" value="${esc(v==null?'':v)}" autocomplete="new-password" placeholder="保持掩码即不修改">`;
      else ctrl=`<input class="mini-input" type="text" data-cfg="${row.k}" value="${esc(v==null?'':v)}">`;
      return `<div class="set-row"><div class="set-label">${row.label}<div class="set-hint">${esc(row.hint||'')}</div></div><div class="set-ctrl">${ctrl}</div></div>`;
    }).join('');
    return `<div class="card set-group"><div class="set-group-head"><span class="set-ico">${g.icon}</span><h3>${g.group}</h3></div>${rows}</div>`;
  }).join('');
  // 存储与数据源状态
  try{
    const [status,hermes,pulse]=await Promise.all([
      api('/api/v2/status'), api('/api/v2/hermes/status'), api('/api/v2/news-pulse/status')
    ]);
    $('#settingsStore').innerHTML=`
      <div class="store-row"><span>新闻源</span><b>华尔街见闻 A股/全球 · 中新网 · Google News · BBC · Guardian · Al Jazeera</b></div>
      <div class="store-row"><span>新闻轮询</span><b>${settingsCfg.newsIntervalSec||60} 秒</b> <span class="note">最近脉冲 ${esc(pulse&&pulse.at||'--')}</span></div>
      <div class="store-row"><span>智能体后端</span><b>${esc(hermes&&hermes.backend||'--')}</b> <span class="note">Hermes 状态 ${esc(hermes&&hermes.running?'运行中':'见对话面板')}</span></div>
      <div class="store-row"><span>本机数据目录</span><b>data/ · 知识词条 data/knowledge/entries/*.md</b></div>
      <div class="store-row"><span>运行状态</span><b>${status&&status.ok?'正常':'检查中'}</b></div>`;
    renderAgentDiag(hermes);
  }catch(_){ $('#settingsStore').textContent='状态读取失败'; renderAgentDiag(null); }
}
/* 智能体大模型状态卡：只读展示当前真实配置与后端探测结果，不暴露明文 Key */
function renderAgentDiag(st){
  const box=$('#agentDiagBody');
  if(!box) return;
  const a=(settingsCfg&&settingsCfg.agent)||{};
  const h=a.hermes||{};
  const off=st&&st.official;
  const rows=[
    ['当前后端',(st&&st.backend)||h.backend||'auto'],
    ['实际路径',(st&&st.active)||'--'],
    ['Hermes 桥接',off?(off.online?'在线 · '+(off.service||'hermes-bridge'):'离线 · '+(off.reason||'未连接')):'状态未知'],
    ['DeepSeek Key',(a.apiKey||'未设置')+' · '+(a.apiKeySet?'已配置':'未配置')],
    ['模型 / 接口',(a.model||'deepseek-chat')+' · '+(a.baseUrl||'https://api.deepseek.com')],
    ['温度 / 单次上限',(a.temperature!=null?a.temperature:0.3)+' / '+(a.maxTokens!=null?a.maxTokens:1600)+' tokens'],
    ['Hermes 模型 / 地址',(h.model||'hermes')+' · '+(h.officialUrl||'http://127.0.0.1:8765')],
    ['每日 token 上限',(a.maxTokensPerDay!=null?a.maxTokensPerDay:200000)+' tokens']
  ];
  box.innerHTML='<div class="agent-diag-grid">'+rows.map(r=>
    '<div class="agent-diag-row"><span>'+esc(r[0])+'</span><b>'+esc(r[1])+'</b></div>').join('')+'</div>';
}
/* 连通性检测：真实最小请求（约 16 token），结果如实展示，失败不粉饰 */
$('#btnAgentTest').addEventListener('click', async ()=>{
  const btn=$('#btnAgentTest'), box=$('#agentTestResult');
  if(!btn||!box) return;
  btn.disabled=true; btn.textContent='检测中…';
  box.innerHTML='<span class="note">正在向官方 Hermes 与 DeepSeek 各发起一次真实最小请求…</span>';
  try{
    const r=await post('/api/v2/hermes/test',{});
    const one=x=>x?(x.ok?'✓ 在线':'✗ '+(x.error||'失败')):'未测试';
    box.innerHTML='<div class="agent-test-grid">'+
      '<div><span>官方 Hermes</span><b class="'+(r.official&&r.official.ok?'up':'down')+'">'+esc(one(r.official))+'</b></div>'+
      '<div><span>DeepSeek 兜底</span><b class="'+(r.fallback&&r.fallback.ok?'up':'down')+'">'+esc(one(r.fallback))+'</b></div>'+
      '<div><span>实际可用路径</span><b>'+esc(r.active||'无')+'</b></div>'+
      '<div><span>总体</span><b class="'+(r.ok?'up':'down')+'">'+(r.ok?'连通正常':'未连通')+'</b></div>'+
      '</div>';
    toast(r.ok?'连通性检测完成':'连通性检测未通过',
      r.ok?('可用路径：'+(r.active||'--')):(r.error||'请检查 API Key 与网络'), !r.ok);
  }catch(e){ box.innerHTML='<span class="note">检测失败：'+esc((e&&e.message)||'')+'</span>'; }
  finally{ btn.disabled=false; btn.textContent='发起连通性检测'; }
});
$('#btnSaveConfig').addEventListener('click',async()=>{
  if(!settingsCfg) return;
  const patch={};
  $$('[data-cfg]',$('#settingsGrid')).forEach(el=>{
    const k=el.dataset.cfg;
    if(el.type==='checkbox') setCfgVal(patch,k,el.checked);
    else if(el.classList.contains('set-kw')) setCfgVal(patch,k,el.value.split(/[,，、\n]/).map(s=>s.trim()).filter(Boolean));
    else if(el.tagName==='SELECT') setCfgVal(patch,k,el.value);
    else if(el.type==='number') setCfgVal(patch,k,Number(el.value));
    else if(k==='agent.apiKey'){
      const val=String(el.value||'').trim();
      if(val && !val.includes('****')) setCfgVal(patch,k,val);  // 掩码或留空 = 不修改真实 Key
    }
    else setCfgVal(patch,k,el.value);
  });
  const r=await post('/api/config',patch);
  if(r.ok){ settingsCfg=r.data; toast('已保存','设置已生效，轮询已重新调度'); }
  else toast('保存失败',r.error||'',true);
});
$('#btnResetConfig').addEventListener('click',async()=>{
  if(!confirm('确定恢复默认设置？自定义的告警关键词与模块开关会重置。')) return;
  const r=await post('/api/reset',{});
  if(r.ok){ toast('已恢复默认','设置已重置'); loadSettings(); }
});

/* ---------------- ⑤ 个人知识库 ---------------- */
// 旧版笔记面板（#noteFilter / #noteList）已在双视图改造中移除。
// loadNotes 保留为兼容入口：保存/整理笔记后刷新本地 md 词条列表与图谱，不再访问已删除的 DOM。
async function loadNotes(){
  if(typeof loadEntries==='function') loadEntries();
  if(typeof loadGraph==='function') loadGraph();
}
$('#btnAddNote').addEventListener('click', ()=>openModal('#modalNote'));
$('#btnSaveNote').addEventListener('click', async()=>{
  const body={kind:$('#noteKind').value,title:$('#noteTitle').value,content:$('#noteContent').value,
    tags:$('#noteTags').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean)};
  const r=await post('/api/v2/knowledge/note',body);
  if(r.ok){ closeModals(); ['noteTitle','noteContent','noteTags'].forEach(id=>$('#'+id).value=''); loadNotes(); toast('已保存','笔记已存到本地'); }
  else toast('保存失败', r.error||'', true);
});
$('#btnOrganize').addEventListener('click', async()=>{
  toast('整理中','智能体正在把笔记整理成知识图谱…');
  const r=await post('/api/v2/knowledge/organize',{});
  if(r.ok){ loadGraph(); loadNotes(); toast('整理完成',`新增 ${r.addedNodes} 节点 / ${r.addedEdges} 条边（${r.backend||'规则'}）`); }
  else toast('整理失败', r.error||'', true);
});
$('#kbAskBtn').addEventListener('click', async()=>{
  const q=$('#kbAskInput').value.trim(); if(!q) return;
  $('#kbAnswer').textContent='思考中…';
  const r=await post('/api/v2/knowledge/query',{question:q});
  $('#kbAnswer').textContent=r.ok?r.answer:('失败：'+(r.error||''));
});
$('#kbAskInput').addEventListener('keydown',e=>{if(e.key==='Enter')$('#kbAskBtn').click();});

/* ---- 知识库四视图切换由 agent-ui.js 统一接管（图谱/词条/更新历史/数据质量） ----
 * v2.js 只负责提供 2D 引擎与词条读取接口，见文件末尾 window.* 暴露。
 * 这里保留一个轻量的 currentKbMode 供其他逻辑参考，不再重复绑定按钮。 */
let currentKbMode='graph';
async function loadEntries(){
  const r=await api('/api/v2/knowledge/entries');
  const box=$('#entryList'); if(!box) return;
  if(!r.ok){ box.innerHTML='<div class="empty">词条读取失败</div>'; return; }
  const items=r.items||[];
  $('#entriesMeta').textContent=`${r.total||items.length} 条 · 本地 md · ${r.dir||''}`;
  const typeCls=t=>/question/.test(t)?'q':/event/.test(t)?'e':/factor/.test(t)?'f':'x';
  box.innerHTML=items.map(e=>`<div class="entry-card" data-id="${esc(e.id)}">
    <div class="entry-top"><span class="entry-type ${typeCls(e.type)}">${esc(e.type)}</span>
      <b class="entry-title">${esc(e.title)}</b>
      <span class="entry-status">${esc(e.status)}</span>
      <button class="btn tiny ghost entry-edit" data-id="${esc(e.id)}">编辑</button></div>
    <div class="entry-content">${esc(e.content).slice(0,260)}</div>
    <div class="entry-foot"><span>${esc(e.file)}</span>${(e.tags||[]).length?'<span>'+e.tags.map(t=>'#'+esc(t)).join(' ')+'</span>':''}<span>${e.bytes||0} B</span></div>
  </div>`).join('')||'<div class="empty">还没有词条，先在图谱视图记一条笔记，或点「导出为 md」生成。</div>';
  $$('.entry-edit',box).forEach(b=>b.addEventListener('click',()=>openEntryEditor(b.dataset.id)));
}
async function openEntryEditor(id){
  const r=await api('/api/v2/knowledge/entry/'+encodeURIComponent(id));
  if(!r.ok){ toast('读取失败',r.error||'',true); return; }
  $('#entryEditor').classList.remove('hidden');
  $('#entryEditorTitle').textContent='编辑词条 · '+id;
  $('#entryEditorText').value=r.content||'';
  $('#entryEditor').dataset.id=id;
}
$('#entryEditorClose').addEventListener('click',()=>$('#entryEditor').classList.add('hidden'));
$('#entryEditorSave').addEventListener('click',async()=>{
  const id=$('#entryEditor').dataset.id;
  const r=await post('/api/v2/knowledge/entry/save',{id,content:$('#entryEditorText').value});
  if(r.ok){ toast('已保存','md 词条已写入本地'); $('#entryEditor').classList.add('hidden'); loadEntries(); }
  else toast('保存失败',r.error||'',true);
});
$('#btnExportEntries').addEventListener('click',async()=>{
  toast('导出中','正在把笔记写成 md 词条…');
  const r=await post('/api/v2/knowledge/entries/export',{});
  if(r.ok){ toast('导出完成',`${r.count} 条词条 → ${r.dir}`); loadEntries(); }
  else toast('导出失败',r.error||'',true);
});
$('#btnReloadEntries').addEventListener('click',loadEntries);

/* ============ 力导向知识图谱（移植自 AI-Hel2，零依赖） ============ */
const GRAPH_NS='http://www.w3.org/2000/svg';
const GS_KEY='gmm_graph_settings_v2';
let graphState=null;      // { sim, nodes, links, data, transform, ... }
let graphSettings=loadGraphSettings();
let animFrame=0;

function loadGraphSettings(){
  try{ const s=JSON.parse(localStorage.getItem(GS_KEY)||'{}'); return Object.assign({},window.GraphEngine.DEFAULT_SETTINGS,s); }
  catch(_){ return Object.assign({},window.GraphEngine.DEFAULT_SETTINGS); }
}
function saveGraphSettings(){ try{ localStorage.setItem(GS_KEY,JSON.stringify(graphSettings)); }catch(_){} }

function loadGraph(){
  return api('/api/v2/knowledge/graph').then(r=>{
    if(!r.ok) return;
    const g=r;
    $('#graphStats').textContent=`${g.stats.nodes} 节点 · ${g.stats.edges} 条边`+(g.builtAt?' · '+new Date(g.builtAt).toLocaleString('zh-CN'):'');
    const wrap=$('#graphWrap');
    if(!g.nodes.length){ stopGraphLoop(); wrap.innerHTML='<div class="empty">整理笔记后显示图谱</div>'; return; }
    buildForceGraph(g);
    renderGraphLegend();
    renderSettingsPanel();
  });
}

function buildForceGraph(raw){
  const wrap=$('#graphWrap');
  const W=Math.max(320,wrap.clientWidth||600), H=Math.max(280,wrap.clientHeight||340);
  const {nodes,links}=window.GraphEngine.buildGraphData(raw.nodes,raw.edges,{settings:graphSettings,searchQuery:graphSettings.searchQuery});
  if(!nodes.length){ stopGraphLoop(); wrap.innerHTML='<div class="empty">当前筛选下无节点</div>'; return; }
  const edgePairs=links.map(l=>[l.source,l.target,l.weight]);
  // 复用旧布局坐标（若类型/筛选未变）
  const prevPos={};
  if(graphState && graphState.sim) for(const id in graphState.sim.nodes){
    const n=graphState.sim.nodes[id]; prevPos[id]={x:n.x,y:n.y,radius:n.radius};
  }
  const simCfg={ centerStrength:graphSettings.centerForce, repelBase:Math.pow(graphSettings.repelForce,3),
    linkStrength:graphSettings.attractForce, linkDistance:graphSettings.linkLength*3.5, dragBoost:graphSettings.dragForce };
  const sim=window.GraphEngine.createSimulation(nodes.map(n=>n.id),edgePairs,simCfg,W,H,prevPos);
  // 把真实半径写进 sim（AI-Hel2 physics 用 radius=5+min(deg,20)*0.6）
  nodes.forEach(n=>{ if(sim.nodes[n.id]) sim.nodes[n.id].radius=5+Math.min(n.degree,20)*0.6; });

  // 重建 SVG 静态结构
  wrap.innerHTML='';
  const svg=document.createElementNS(GRAPH_NS,'svg');
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  const gRoot=document.createElementNS(GRAPH_NS,'g');
  const gLinks=document.createElementNS(GRAPH_NS,'g');
  const gRings=document.createElementNS(GRAPH_NS,'g');
  const gNodes=document.createElementNS(GRAPH_NS,'g');
  const gLabels=document.createElementNS(GRAPH_NS,'g');
  gRoot.appendChild(gLinks); gRoot.appendChild(gRings); gRoot.appendChild(gNodes); gRoot.appendChild(gLabels);
  svg.appendChild(gRoot); wrap.appendChild(svg);

  const linkEls={},nodeEls={},ringEls={},labelEls={};
  links.forEach((l,i)=>{
    const p=document.createElementNS(GRAPH_NS,'path');
    p.setAttribute('class','g-edge');
    p.setAttribute('stroke', l.relationTypes.indexOf('contradicts')>=0?'var(--up)':
      l.relationTypes.indexOf('causes')>=0?'var(--brand)':
      l.relationTypes.indexOf('supports')>=0?'var(--down)':'#c9cdd4');
    if(l.relationTypes.indexOf('contradicts')>=0) p.setAttribute('stroke-dasharray','4 3');
    gLinks.appendChild(p); linkEls[i]=p;
  });
  nodes.forEach((n,i)=>{
    const ring=document.createElementNS(GRAPH_NS,'circle');
    ring.setAttribute('class','g-ring'); ring.setAttribute('stroke',n.color);
    gRings.appendChild(ring); ringEls[n.id]=ring;
    const c=document.createElementNS(GRAPH_NS,'circle');
    c.setAttribute('class','g-node'); c.setAttribute('fill',n.color);
    c.dataset.id=n.id; gNodes.appendChild(c); nodeEls[n.id]=c;
    const t=document.createElementNS(GRAPH_NS,'text');
    t.textContent=n.name.length>9?n.name.slice(0,8)+'…':n.name; gLabels.appendChild(t); labelEls[n.id]=t;
  });

  graphState={ sim,nodes,links,wrap,svg,gRoot,linkEls,nodeEls,ringEls,labelEls,
    transform:{x:0,y:0,k:1}, W,H, dragId:null, hoverId:null, selectedId:null,
    autoFitDone:false, posCache:prevPos };

  bindGraphEvents();
  startGraphLoop();
}

function startGraphLoop(){ cancelAnimationFrame(animFrame); loopGraph(); }
function stopGraphLoop(){ cancelAnimationFrame(animFrame); animFrame=0; }

function loopGraph(){
  animFrame=requestAnimationFrame(loopGraph);
  const S=graphState; if(!S) return;
  const {sim,nodes,links,W,H}=S;
  window.GraphEngine.tick(sim,W,H);
  const T=S.transform;
  S.gRoot.setAttribute('transform',`translate(${T.x},${T.y}) scale(${T.k})`);
  // 边
  links.forEach((l,i)=>{
    const a=sim.nodes[l.source], b=sim.nodes[l.target];
    const el=S.linkEls[i];
    if(a&&b){ el.setAttribute('d',`M${a.x},${a.y}L${b.x},${b.y}`); el.setAttribute('opacity',graphSettings.edgeOpacity);
      el.setAttribute('stroke-width',(graphSettings.linkThickness*2)/Math.max(T.k,0.125)); }
    else el.setAttribute('d','');
  });
  // 节点 / 环 / 标签
  const textAlpha=Math.max(0,Math.min(1,Math.log2(T.k)+1-(1-(graphSettings.textOpacity||0.85))));
  nodes.forEach(n=>{
    const nd=sim.nodes[n.id], c=S.nodeEls[n.id], ring=S.ringEls[n.id], t=S.labelEls[n.id];
    if(!nd) return;
    const r=Math.max(5,n._sphereRadius*1.4)*(graphSettings.nodeSize||1.25);
    c.setAttribute('cx',nd.x); c.setAttribute('cy',nd.y); c.setAttribute('r',r);
    ring.setAttribute('cx',nd.x); ring.setAttribute('cy',nd.y); ring.setAttribute('r',r+3);
    ring.setAttribute('opacity',graphSettings.showTypeRing?0.5:0);
    // 悬停高亮：邻居不透明，其余淡化
    if(S.hoverId){
      const related=S.hoverNeighbors && S.hoverNeighbors.has(n.id);
      c.setAttribute('opacity',(n.id===S.hoverId||related)?1:0.15);
      t.setAttribute('opacity',(n.id===S.hoverId||related)?1:0.3);
    } else { c.setAttribute('opacity',1); t.setAttribute('opacity',textAlpha); }
    t.setAttribute('x',nd.x); t.setAttribute('y',nd.y-r-4);
  });
  // 冻结后缓存坐标 + 首次自动适应视图
  if(sim.frozen && !S.dragId){
    const cache={}; for(const id in sim.nodes){const nd=sim.nodes[id];cache[id]={x:nd.x,y:nd.y,radius:nd.radius};}
    S.posCache=cache;
    if(!S.autoFitDone && sim.nodes.size){ S.autoFitDone=true; autoFitGraph(); }
  }
}

function autoFitGraph(){
  const S=graphState; if(!S) return;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const id in S.sim.nodes){const n=S.sim.nodes[id];
    if(n.x<minX)minX=n.x; if(n.y<minY)minY=n.y; if(n.x>maxX)maxX=n.x; if(n.y>maxY)maxY=n.y;}
  const bw=maxX-minX||1, bh=maxY-minY||1, pad=60;
  const scale=Math.min(S.W/(bw+pad*2),S.H/(bh+pad*2),4);
  S.transform.k=scale;
  S.transform.x=(S.W-bw*scale)/2-minX*scale;
  S.transform.y=(S.H-bh*scale)/2-minY*scale;
}

function screenToWorld(evt){
  const S=graphState, rect=S.svg.getBoundingClientRect(), T=S.transform;
  return { x:(evt.clientX-rect.left-T.x)/T.k, y:(evt.clientY-rect.top-T.y)/T.k };
}
function neighborsOf(id){
  const set=new Set([id]);
  graphState.links.forEach(l=>{ if(l.source===id)set.add(l.target); if(l.target===id)set.add(l.source); });
  return set;
}

// 全局拖拽状态与监听（模块级，只绑定一次，避免重建图谱时重复绑定）
let graphPan=null, graphDrag=null;
window.addEventListener('mousemove',e=>{
  const S=graphState; if(!S) return;
  if(graphDrag){
    if(Math.abs(e.clientX-graphDrag.startX)+Math.abs(e.clientY-graphDrag.startY)>3) graphDrag.moved=true;
    const w=screenToWorld(e);
    window.GraphEngine.movePinned(S.sim,graphDrag.id,w.x,w.y);
  } else if(graphPan){
    S.transform.x=graphPan.tx+(e.clientX-graphPan.x);
    S.transform.y=graphPan.ty+(e.clientY-graphPan.y);
  }
});
window.addEventListener('mouseup',()=>{
  const S=graphState;
  if(graphDrag){
    if(!graphDrag.moved && S) window.GraphEngine.unpinNode(S.sim,graphDrag.id); // 点击不 pin
    if(S) S.dragId=null;
    graphDrag=null;
  }
  if(graphPan){ graphPan=null; if(S) S.wrap.classList.remove('grabbing'); }
});

function bindGraphEvents(){
  const S=graphState, svg=S.svg, wrap=S.wrap;
  // 滚轮缩放（保持鼠标位置）—— 对应 AI-Hel2 d3.zoom scaleExtent([1/128,8])
  svg.addEventListener('wheel',e=>{
    e.preventDefault();
    const rect=svg.getBoundingClientRect();
    const sx=e.clientX-rect.left, sy=e.clientY-rect.top;
    const world=screenToWorld(e);
    const k2=Math.max(1/128,Math.min(8,S.transform.k*(e.deltaY>0?0.9:1.1)));
    S.transform.k=k2;
    S.transform.x=sx-world.x*k2; S.transform.y=sy-world.y*k2;
  },{passive:false});
  // 空白拖拽 pan + 节点拖拽 pin/unpin（3px 阈值）—— 全局 move/up 只绑定一次（见模块级）
  svg.addEventListener('mousedown',e=>{
    const nodeEl=e.target.closest('.g-node');
    if(nodeEl){
      const id=nodeEl.dataset.id, w=screenToWorld(e);
      graphDrag={id,startX:e.clientX,startY:e.clientY,moved:false};
      window.GraphEngine.pinNode(S.sim,id,w.x,w.y); S.dragId=id;
    } else {
      graphPan={x:e.clientX,y:e.clientY,tx:S.transform.x,ty:S.transform.y};
      wrap.classList.add('grabbing');
    }
  });
  // 悬停高亮邻居
  S.nodeEls && Object.keys(S.nodeEls).forEach(id=>{
    const el=S.nodeEls[id];
    el.addEventListener('mouseenter',()=>{ S.hoverId=id; S.hoverNeighbors=neighborsOf(id); });
    el.addEventListener('mouseleave',()=>{ S.hoverId=null; S.hoverNeighbors=null; });
    el.addEventListener('click',()=>showNodeDetail(id));
  });
  svg.addEventListener('click',e=>{ if(!e.target.closest('.g-node')) $('#graphDetail').classList.add('hidden'); });
}

function showNodeDetail(id){
  const S=graphState; if(!S) return;
  const n=S.nodes.find(x=>x.id===id); if(!n) return;
  const degree=n.degree, conf=n.confidence==null?'—':Number(n.confidence).toFixed(2);
  const box=$('#graphDetail');
  box.innerHTML=`<span class="gd-close" id="gdClose">×</span>
    <div class="gd-name"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${n.color};margin-right:6px"></span>${esc(n.name)}</div>
    <div class="gd-meta">类型：${esc(window.GraphEngine.TYPE_LABELS[n.entityType]||n.entityType)} · 连接 ${degree} · 置信度 ${conf}</div>`;
  box.classList.remove('hidden');
  $('#gdClose').onclick=()=>box.classList.add('hidden');
}

function renderGraphLegend(){
  const S=graphState; if(!S) return;
  const counts={};
  S.nodes.forEach(n=>{counts[n.entityType]=(counts[n.entityType]||0)+1;});
  const box=$('#graphLegend');
  box.innerHTML=Object.keys(counts).sort((a,b)=>counts[b]-counts[a]).map(t=>
    `<span class="gl-item"><span class="gl-dot" style="background:${window.GraphEngine.TYPE_COLORS[t]||'#86909c'}"></span>${esc(window.GraphEngine.TYPE_LABELS[t]||t)} ${counts[t]}</span>`).join('');
}

function renderSettingsPanel(){
  const grid=$('#gsGrid');
  const specs=[
    ['nodeSize','节点大小',0.3,3,0.05],
    ['edgeOpacity','边透明',0.05,1,0.05],
    ['textOpacity','标签透明',0.1,1,0.05],
    ['linkThickness','边宽',0.1,2.5,0.1],
    ['centerForce','向心力',0,1,0.01],
    ['repelForce','斥力',0,20,1],
    ['attractForce','吸引力',0,1,0.05],
    ['linkLength','边长',30,500,10]
  ];
  grid.innerHTML=specs.map(s=>`<div class="gs-row"><label>${s[1]}</label><input type="range" data-k="${s[0]}" min="${s[2]}" max="${s[3]}" step="${s[4]}" value="${graphSettings[s[0]]}"><span class="gs-val" id="gv-${s[0]}">${graphSettings[s[0]]}</span></div>`).join('');
  grid.querySelectorAll('input[type=range]').forEach(inp=>{
    inp.addEventListener('input',()=>{
      const k=inp.dataset.k, v=Number(inp.value);
      graphSettings[k]=v; $('#gv-'+k).textContent=v; saveGraphSettings();
      applyLiveSettings();
    });
  });
  $('#gsOrphans').checked=!!graphSettings.showOrphans;
  $('#gsArrows').checked=!!graphSettings.showArrows;
}

function applyLiveSettings(){
  const S=graphState; if(!S) return;
  window.GraphEngine.setConfig(S.sim,{ centerStrength:graphSettings.centerForce,
    repelBase:Math.pow(graphSettings.repelForce,3), linkStrength:graphSettings.attractForce,
    linkDistance:graphSettings.linkLength*3.5, dragForce:graphSettings.dragForce });
  S.sim.frozen=false; // 参数变更后重新收敛
}

// 参数面板事件（只绑定一次）
$('#graphSettingsBtn').addEventListener('click',()=>$('#graphSettings').classList.toggle('hidden'));
$('#graphFitBtn').addEventListener('click',()=>{
  if(window.AgentUI && window.AgentUI.KG && window.AgentUI.KG.dim==='3d' && window.AgentUI.KG.instance){
    try{ window.AgentUI.KG.instance.zoomToFit(700,50); }catch(_){}
  } else autoFitGraph();
});
$('#graphResetBtn').addEventListener('click',()=>{
  graphSettings=Object.assign({},window.GraphEngine.DEFAULT_SETTINGS);
  saveGraphSettings();
  if(window.AgentUI && window.AgentUI.KG && window.AgentUI.KG.dim==='3d' && window.AgentUI.KG.instance){
    try{ window.AgentUI.KG.instance.zoomToFit(700,50); }catch(_){}
    toast('已重置视角','3D 图谱视角已复位；2D 参数已恢复默认');
  } else loadGraph();
});
$('#gsOrphans').addEventListener('change',e=>{graphSettings.showOrphans=e.target.checked;saveGraphSettings();if(!(window.AgentUI&&window.AgentUI.KG.dim==='3d'))loadGraph();});
$('#gsArrows').addEventListener('change',e=>{graphSettings.showArrows=e.target.checked;saveGraphSettings();if(!(window.AgentUI&&window.AgentUI.KG.dim==='3d'))loadGraph();});
let gSearchTimer=null;
$('#graphSearch').addEventListener('input',e=>{
  // 3D 全板块图谱由 agent-ui.js 接管，2D 引擎只在 2D 模式下响应
  if(window.AgentUI && window.AgentUI.KG && window.AgentUI.KG.dim==='3d') return;
  clearTimeout(gSearchTimer);
  const v=e.target.value;
  gSearchTimer=setTimeout(()=>{graphSettings.searchQuery=v;saveGraphSettings();loadGraph();},250);
});

/* ---------------- 弹框 & Toast ---------------- */
function openModal(sel){ $(sel).classList.remove('hidden'); const mask=$(sel+'Mask'); if(mask) mask.classList.remove('hidden'); }
function closeModals(){ $$('.modal,.modal-mask').forEach(m=>m.classList.add('hidden')); }
$$('[data-close]').forEach(b=>b.addEventListener('click',closeModals));
$$('.modal-mask').forEach(m=>m.addEventListener('click',closeModals));
const ceBackBtn=$('#ceBack');
if(ceBackBtn) ceBackBtn.addEventListener('click', ()=>{ const b=window.__calDayBack; if(b) openCalDay(b.date,b.evs); });

function toast(title, detail, isWarn){
  const t=document.createElement('div');
  t.className='toast'+(isWarn?' warning':'');
  t.innerHTML='<div class="t-title">'+esc(title)+'</div>'+(detail?'<div class="t-detail">'+esc(detail)+'</div>':'');
  $('#toastWrap').appendChild(t);
  setTimeout(()=>t.remove(), 4500);
}

/* ---------------- 个股分析：量化评分 + 技术指标 ---------------- */
let currentStockCode='', currentStockName='';
function saCell(k,v){
  return '<div class="sa-cell"><span class="sa-cell-k">'+esc(k)+'</span><span class="sa-cell-v">'+(v==null?'--':v)+'</span></div>';
}
/** 技术交易参考：所有价位来自后端固定公式测算，末尾强制附安全提示 */
function renderTradePlan(tp){
  if(!tp) return '';
  const money=(v,p)=> (v==null?'--':v)+(p!=null?' <span class="'+pctClass(p)+'">'+pctText(p)+'</span>':'');
  const chips=arr=> (arr||[]).map(x=>'<span class="tp-chip">'+esc(x.label)+' '+esc(x.price)+' <span class="'+pctClass(x.pct)+'">'+pctText(x.pct)+'</span></span>').join('')||'<span class="note">无明确档位</span>';
  const b=tp.buyZone||{}, br=tp.breakout||{}, sl=tp.stopLoss||{};
  const takes=(tp.takeProfit||[]).map(x=>'<div class="tp-row"><span class="tp-k">'+esc(x.label)+'</span><span class="tp-v">'+money(x.price,x.pct)+'</span><span class="tp-b">'+esc(x.basis||'')+'</span></div>').join('');
  return '<div class="sa-sec"><h4>技术交易参考（公式测算 · 非预测）</h4><div class="tp-box">'+
    '<div class="tp-row"><span class="tp-k">回踩买入参考区</span><span class="tp-v">'+money(b.low,b.pctLow)+' ~ '+money(b.high,b.pctHigh)+'</span><span class="tp-b">'+esc(b.basis||'')+'</span></div>'+
    '<div class="tp-row"><span class="tp-k">突破确认参考位</span><span class="tp-v">'+money(br.price,br.pct)+'</span><span class="tp-b">'+esc(br.basis||'')+'</span></div>'+
    takes+
    '<div class="tp-row"><span class="tp-k">风险控制参考位</span><span class="tp-v">'+money(sl.price,sl.pct)+'</span><span class="tp-b">'+esc(sl.basis||'')+'</span></div>'+
    '<div class="tp-row"><span class="tp-k">单一标的仓位上限参考</span><span class="tp-v">'+(tp.positionMaxPct!=null?esc(tp.positionMaxPct)+'%':'--')+'</span><span class="tp-b">'+esc(tp.positionBasis||'')+'</span></div>'+
    '<div class="tp-lvls"><div class="tp-lvls-k">上方承压位</div><div class="tp-chips">'+chips(tp.pressure)+'</div></div>'+
    '<div class="tp-lvls"><div class="tp-lvls-k">下方支撑位</div><div class="tp-chips">'+chips(tp.support)+'</div></div>'+
    '<div class="tp-safety">'+esc(tp.safetyNotice||'')+'</div>'+
  '</div></div>';
}
function renderStockAnalysis(d){
  const t=d.technical||{};
  const ma=t.ma||{}, macd=t.macd||{}, boll=t.boll||{}, kdj=t.kdj||{}, vol=t.volume||{}, shadow=t.shadow||{};
  const quote=d.quote||{};
  const meta=[
    '<span>'+esc(d.tradingDate||'日期未知')+' 数据</span>',
    quote.price!=null?('<span>现价 '+esc(quote.price)+'</span>'):'',
    quote.changePct!=null?('<span class="'+pctClass(quote.changePct)+'">'+pctText(quote.changePct)+'</span>'):'',
    quote.market?('<span>'+esc(quote.market)+'</span>'):'',
    '<span>'+esc((d.dataQuality&&d.dataQuality.source)||'K线')+'</span>'
  ].filter(Boolean).join('');
  const parts=(d.scoreParts||[]).map(p=>
    '<div class="sa-part"><span class="sa-part-label">'+esc(p.label)+'</span>'+
    '<span class="sa-part-bar"><i style="width:'+Number(p.score||0)+'%"></i></span>'+
    '<span class="sa-part-score">'+esc(p.score)+'</span>'+
    '<span class="sa-part-desc">权重 '+esc(p.weight)+'% · '+esc(p.desc||'')+'</span></div>').join('');
  const cells=[
    saCell('均线（MA5/10/20/60）',[ma.ma5,ma.ma10,ma.ma20,ma.ma60].map(x=>x==null?'--':x).join(' / ')),
    saCell('MACD（DIF/DEA/柱）',[macd.dif,macd.dea,macd.hist].map(x=>x==null?'--':x).join(' / ')),
    saCell('RSI14',t.rsi14),
    saCell('KDJ（K/D/J/交叉）',kdj.k!=null?([kdj.k,kdj.d,kdj.j,kdj.cross||'none'].join(' / ')):null),
    saCell('布林（上/下/位置）',boll.up!=null?([boll.up,boll.low,roundPct(boll.pos)].join(' / ')):null),
    saCell('ATR14 / 占股价',t.atr14!=null?(t.atr14+' / '+(t.atrPct!=null?t.atrPct+'%':'--')):null),
    saCell('年化波动率',t.volatility!=null?(t.volatility+'%'):null),
    saCell('近20日最大回撤',t.maxDD!=null?('<span class="'+pctClass(t.maxDD)+'">'+t.maxDD+'%</span>'):null),
    saCell('量比5',t.volRatio5),
    saCell('5日 / 20日收益',t.mom5!=null?('<span class="'+pctClass(t.mom5)+'">'+pctText(t.mom5)+'</span> / <span class="'+pctClass(t.mom20)+'">'+pctText(t.mom20)+'</span>'):null),
    saCell('60日位置 / Z-score',t.pos60!=null?(t.pos60+'% / '+(t.zScore==null?'--':t.zScore)):null),
    saCell('连续站上MA5',t.holdMa5Days!=null?(t.holdMa5Days+' 日'):null),
    saCell('上影 / 下影',shadow.upperPct!=null?(shadow.upperPct+'% / '+shadow.lowerPct+'%'):null),
    saCell('成交额 / 换手',vol.amount!=null?((vol.amount/1e8).toFixed(2)+'亿'+(vol.turnover!=null?' / '+vol.turnover+'%':'')):null)
  ].join('');
  const signals=(d.signals||[]).map(s=>'<div class="sa-signal '+esc(s.type)+'"><b>'+esc(s.label)+'</b>'+esc(s.detail)+'</div>').join('')||'<div class="note">暂无明确技术信号。</div>';
  const ctx=d.context||{};
  const ctxRows=[];
  if(ctx.systemScore) ctxRows.push('<div class="sa-context-row">观察池原评分：<b>'+esc(ctx.systemScore.score)+'</b>（'+esc(ctx.systemScore.signal||'--')+'）'+esc(ctx.systemScore.reason||'')+'</div>');
  if((ctx.screenTags||[]).length) ctxRows.push('<div class="sa-context-row">三类选股标签：'+ctx.screenTags.map(x=>esc(x.kind)+(x.score!=null?' '+x.score+'分':'')).join('、')+'</div>');
  if(ctx.newsBias) ctxRows.push('<div class="sa-context-row">消息面：'+esc(ctx.newsBias.sector)+' '+esc(ctx.newsBias.direction)+'（'+esc(ctx.newsBias.score)+'）</div>');
  if((ctx.events||[]).length) ctxRows.push('<div class="sa-context-row">公司事件：'+ctx.events.slice(0,3).map(e=>esc(e.label||e.type||'事件')).join('、')+'</div>');
  if(ctx.valuation) ctxRows.push('<div class="sa-context-row">市值重估候选：'+esc(ctx.valuation.type||'')+' '+esc(ctx.valuation.verdict||'')+'（'+esc(ctx.valuation.score)+'分）</div>');
  if((d.p0Factors&&d.p0Factors.factors||[]).length) ctxRows.push('<div class="sa-context-row">用户规则标注：'+d.p0Factors.factors.map(f=>esc(f.label)+'（'+(f.hit===true?'命中':f.hit===false?'未命中':'不可得')+'）').join('、')+'</div>');
  if(!ctxRows.length) ctxRows.push('<div class="sa-context-row">暂无额外上下文；本次评分只使用真实日线计算。</div>');
  return '<div class="sa-meta">'+meta+'</div>'+
    '<div class="sa-hero"><div class="sa-score">'+esc(d.score)+'</div><div><div class="sa-level">100 分制 · '+esc(d.level||'--')+'</div><div class="sa-note">'+esc(d.levelNote||'')+'</div><div class="sa-note">'+esc((d.dataQuality&&d.dataQuality.note)||'')+'</div></div></div>'+
    '<div class="sa-sec"><h4>量化评分分项</h4><div class="sa-parts">'+parts+'</div></div>'+
    '<div class="sa-sec"><h4>技术指标</h4><div class="sa-grid">'+cells+'</div></div>'+
    '<div class="sa-sec"><h4>信号解读</h4><div class="sa-signals">'+signals+'</div></div>'+
    '<div class="sa-sec"><h4>风险提示</h4><div class="sa-risk">'+esc((d.riskNotes||[]).join('；'))+'</div></div>'+
    renderTradePlan(d.tradePlan)+
    '<div class="sa-sec"><h4>系统上下文（不并入本次评分）</h4><div class="sa-context">'+ctxRows.join('')+'</div></div>'+
    '<div class="sa-sec"><h4>口径与边界</h4><div class="sa-context">'+esc((d.methodology&&d.methodology.score)||'')+'<br>'+esc((d.methodology&&d.methodology.boundary)||'')+'</div></div>'+
    '<div class="sa-disclaimer">'+esc(d.disclaimer||'')+'</div>';
}
function roundPct(v){ return v==null?'--':(Number(v)*100).toFixed(1)+'%'; }
async function openStockAnalysis(code,name){
  currentStockCode=String(code||'').trim();
  currentStockName=String(name||'').trim();
  if(!/^\d{6}$/.test(currentStockCode)){ toast('个股分析','需要 6 位股票代码',true); return; }
  $('#stockTitle').textContent='个股分析 · '+(currentStockName||currentStockCode);
  $('#stockBody').innerHTML='<div class="empty">正在读取日线并计算指标…</div>';
  openModal('#modalStock');
  const d=await api('/api/v2/stock/analysis?code='+encodeURIComponent(currentStockCode));
  if(!d.ok){ $('#stockBody').innerHTML='<div class="empty">'+esc(d.error||'分析失败')+'</div>'; return; }
  $('#stockBody').innerHTML=renderStockAnalysis(d);
}
document.addEventListener('click', e=>{
  const btn=e.target.closest && e.target.closest('[data-analyze]');
  if(!btn) return;
  e.preventDefault(); e.stopPropagation();
  openStockAnalysis(btn.dataset.code, btn.dataset.name);
});
document.addEventListener('click', async e=>{
  const btn=e.target.closest && e.target.closest('[data-addpick]');
  if(!btn) return;
  e.preventDefault(); e.stopPropagation();
  const r=await post('/api/mypicks/add', {code:btn.dataset.code, name:btn.dataset.name, note:btn.dataset.note||''});
  if(r.ok){ toast('已加入我的选股', (btn.dataset.name||btn.dataset.code)+' 已保存'); loadPortfolio(); }
  else toast('加入失败', r.error||'', true);
});
/* 事件解读按钮：统一委托（捕获阶段），避免与「当日全部事件」卡片 .ce-click 的冒泡监听冲突 */
document.addEventListener('click', e=>{
  const b=e.target.closest && e.target.closest('.event-ai-btn');
  if(!b) return;
  e.preventDefault(); e.stopPropagation();
  eventImpact(b);
}, true);
$('#btnStockAsk').addEventListener('click', ()=>{
  if(!currentStockCode) return;
  closeModals();
  if(window.innerWidth<=900) $('#chatpanel').classList.add('open');
  sendChat('请基于刚注入的个股量化评分与技术指标，分析'+(currentStockName||currentStockCode)+'（'+currentStockCode+'）当前技术结构、主要矛盾和需要观察的风险点。不要给买卖建议，也不要预测涨跌。', { stockCode: currentStockCode });
});

/* ---------------- SSE 主动提醒卡片 ---------------- */
function pctVal(v){
  if(v==null) return '<span class="pct-val flat">--</span>';
  const c = v>0?'up':(v<0?'down':'flat');
  return '<span class="pct-val '+c+'">'+(v>0?'+':'')+Number(v).toFixed(2)+'%</span>';
}
function renderEventHistory(d){
  const det = d.eventDetail||{};
  const s = det.summary||{};
  if(!det.ok){
    const msg = det.error || d.historical || '该事件暂无 A 股代理样本或仅有月份标记，不做后验统计。';
    return '<div class="ec-mech">'+esc(msg)+(det.mechanism?('<br><br>机制线索：'+esc(det.mechanism)):'')+'</div>';
  }
  let h='<div class="ec-detail">';
  // 原因机制
  if(det.mechanism) h+='<div class="ec-block"><div class="ec-block-title">为什么会受影响（机制链条）</div><div class="ec-mech">'+esc(det.mechanism)+'</div></div>';
  // 事件前 / 事件后 涨跌百分比
  h+='<div class="ec-block"><div class="ec-block-title">事件之前（提前交易预期）</div><div class="pct-strip">'+
     '<div class="pct-item"><span class="pct-label">前5日平均</span>'+pctVal(s.avgPre5)+'</div>'+
     '<div class="pct-item"><span class="pct-label">前3日平均</span>'+pctVal(s.avgPre3)+'</div>'+
     '<div class="pct-item"><span class="pct-label">前5日上涨占比</span><span class="pct-val">'+(s.preUpProb5!=null?s.preUpProb5+'%':'--')+'</span></div>'+
     '</div></div>';
  h+='<div class="ec-block"><div class="ec-block-title">事件之后（历史涨跌概率）</div><div class="pct-strip">'+
     '<div class="pct-item"><span class="pct-label">T+1 平均</span>'+pctVal(s.avgRet1)+'</div>'+
     '<div class="pct-item"><span class="pct-label">T+3 平均</span>'+pctVal(s.avgRet3)+'</div>'+
     '<div class="pct-item"><span class="pct-label">T+5 平均</span>'+pctVal(s.avgRet5)+'</div>'+
     '<div class="pct-item"><span class="pct-label">T+5 超额</span>'+pctVal(s.avgAr5)+'</div>'+
     '<div class="pct-item"><span class="pct-label">T+5 上涨概率</span><span class="pct-val">'+(s.upProb5!=null?s.upProb5+'%':'--')+'</span></div>'+
     '</div>'+(s.dist5?('<div class="ec-mech" style="margin-top:8px">T+5 涨跌分布：上涨 '+s.dist5.up+'% / 下跌 '+s.dist5.down+'% / 持平 '+s.dist5.flat+'%</div>'):'')+'</div>';
  // 分板块明细
  const px = det.proxies||[];
  if(px.length){
    h+='<div class="ec-block"><div class="ec-block-title">分板块表现（ETF 代理 · 近似口径）</div>'+
       '<table class="ec-proxy-table"><thead><tr><th>板块代理</th><th>事件前5日</th><th>T+5涨跌</th><th>超额</th><th>上涨概率</th></tr></thead><tbody>'+
       px.map(p=>'<tr><td>'+esc(p.label)+'</td><td class="'+(p.preRet5>0?'up':p.preRet5<0?'down':'')+'">'+(p.preRet5!=null?(p.preRet5>0?'+':'')+p.preRet5+'%':'--')+'</td>'+
         '<td class="'+(p.ret5>0?'up':p.ret5<0?'down':'')+'">'+(p.ret5!=null?(p.ret5>0?'+':'')+p.ret5+'%':'--')+'</td>'+
         '<td>'+(p.ar5!=null?(p.ar5>0?'+':'')+p.ar5+'%':'--')+'</td><td>'+(p.upProb5!=null?p.upProb5+'%':'--')+'</td></tr>').join('')+
       '</tbody></table></div>';
  }
  if(s.samples<8) h+='<div class="ec-mech" style="color:var(--warn)">样本仅 '+s.samples+' 次观测，低样本不可外推；ETF 代理不等于行业指数，历史不代表未来。</div>';
  h+='</div>';
  return h;
}
/** 提醒卡片：把智能体文字安全地渲染成结构化 HTML。
 *  旧实现用 textContent，导致 event-impact-v3 的五段式文字被压成一大坨 txt；
 *  这里统一走 MarkdownLite（内部先 esc 再解析，XSS 安全），无渲染器时降级纯文本。 */
function ecRich(el, text, fallback){
  if(!el) return;
  const t = String(text==null?'':text).trim();
  if(!t){ el.classList.remove('md-body'); el.innerHTML='<div class="ec-plain">'+esc(fallback||'暂无内容')+'</div>'; return; }
  if(window.MarkdownLite){
    el.classList.add('md-body');
    el.innerHTML = window.MarkdownLite.render(t);
  }else{
    el.classList.remove('md-body');
    el.textContent = t;
  }
}
function showEventCard(d){
  const when = d.daysTo===0 ? '今日' : d.daysTo===1 ? '明日' : (d.daysTo!=null ? d.daysTo+' 天后' : '即将');
  $('#ecTitle').textContent = when + ' · ' + (d.name||'事件提醒');
  $('#ecMeta').innerHTML = ['<span>'+esc(d.date||'日期待核实')+'</span>','<span>'+esc(d.grade||'--')+' 级</span>']
    .concat((d.sectors||[]).slice(0,5).map(s=>'<span>'+esc(s)+'</span>')).join('');
  ecRich($('#ecWhat'), d.message || (when + '：' + (d.name||'事件')), '暂无事件描述');
  ecRich($('#ecAnalysis'), d.analysis, '智能体分析暂不可用；以下仅给出程序计算的历史同类统计。');
  // 来源标注：提示词版本 + 后端；智能体未返回时明确写「仅程序统计」
  const meta = d.analysisMeta||{}, hasAi = !!String(d.analysis||'').trim();
  if($('#ecAnalysisMeta')) $('#ecAnalysisMeta').textContent = hasAi
    ? ['智能体解读', meta.promptVersion||'event-impact-v3', meta.backend||''].filter(Boolean).join(' · ')
    : '智能体未返回 · 仅程序统计';
  // 每次弹出都默认展开，避免用户上次收起后看不到内容
  const sec = document.querySelector('.ec-analysis-sec');
  if(sec){
    sec.classList.remove('collapsed');
    if($('#ecAnalysisFold')) $('#ecAnalysisFold').textContent='收起 ▴';
    if($('#ecAnalysisHead')) $('#ecAnalysisHead').setAttribute('aria-expanded','true');
  }
  // 历史统计：结构化展示「原因机制 / 事件前后涨跌百分比 / 分板块明细」
  if($('#ecHistory')) $('#ecHistory').innerHTML = renderEventHistory(d);
  ecRich($('#ecObservation'), d.observation || '观察点：关注相关板块量能与相对强弱是否同步变化；不把事件本身当作买卖依据。', '暂无观察点');
  openModal('#modalEventCard');
}
/* 智能体解读折叠：点击标题栏或按 Enter / 空格切换 */
(function(){
  const head=$('#ecAnalysisHead'); if(!head) return;
  function toggle(){
    const sec=document.querySelector('.ec-analysis-sec'); if(!sec) return;
    const collapsed=sec.classList.toggle('collapsed');
    if($('#ecAnalysisFold')) $('#ecAnalysisFold').textContent=collapsed?'展开 ▾':'收起 ▴';
    head.setAttribute('aria-expanded', collapsed?'false':'true');
  }
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(); } });
})();
let lastVolToastAt=0;
function subscribeV2Events(){
  if(typeof EventSource==='undefined') return;
  try{
    const es=new EventSource('/api/stream');
    // 真实行情：首帧 snapshot + 每 15 秒 tick，直接刷新「全球市场监控」卡片
    es.addEventListener('snapshot', ev=>{
      try{ const j=JSON.parse(ev.data); if(j && j.quotes) renderGlobalQuotes(j.quotes, j.quoteFetchedAt, j.health); }catch(_){}
    });
    es.addEventListener('tick', ev=>{
      try{ const j=JSON.parse(ev.data); if(j && j.quotes) renderGlobalQuotes(j.quotes, j.fetchedAt, null); }catch(_){}
    });
    es.addEventListener('v2-calendar', ev=>{
      try{
        const j=JSON.parse(ev.data);
        (j.items||[]).slice(0,2).forEach((d,i)=>setTimeout(()=>showEventCard(d), i*400));
      }catch(_){}
    });
    es.addEventListener('news', ev=>{
      try{
        const m=JSON.parse(ev.data);
        const fresh=m.freshPolicyAlerts||[];
        if(fresh.length){
          toast('政策快讯 · '+fresh.length+' 条', fresh[0].title, true);
          fresh.slice(1,3).forEach((n,i)=>setTimeout(()=>toast('政策快讯', n.title, true), (i+1)*600));
          if(typeof loadPolicyNews==='function'){
            post('/api/v2/news-pulse/refresh',{}).then(()=>loadPolicyNews(true));
          }
          if(currentView==='newsflash' && typeof loadNewsFlash==='function') loadNewsFlash();
        }
      }catch(_){}
    });
    es.addEventListener('news-pulse', ev=>{
      try{
        const m=JSON.parse(ev.data);
        toast('消息面已更新', (m.newsCount||0)+' 条新闻 · 政策相关 '+(m.policyCount||0)+' 条');
        if(currentView==='market'){
          if(typeof loadPicks==='function') loadPicks();
        }
        if(currentView==='newsflash' && typeof loadNewsFlash==='function') loadNewsFlash();
      }catch(_){}
    });
    es.addEventListener('v2-volume', ev=>{
      if(Date.now()-lastVolToastAt < 5*60*1000) return;
      lastVolToastAt=Date.now();
      try{
        const m=JSON.parse(ev.data);
        toast('量能播报', (m.amountYi!=null?m.amountYi+'亿 ':'')+(m.state||'')+' · '+(m.momentum||''));
      }catch(_){}
    });
    // 任意真实数据推送后同步刷新各板块更新徽标（函数定义在下方，声明提升可用）
    ['news','news-pulse','stocks','limitup','style','flow','technical','journal','holdings','events','watchers','config'].forEach(name=>{
      es.addEventListener(name, ()=>{ if(typeof loadUpdateSummary==='function') loadUpdateSummary(); });
    });
  }catch(e){ console.warn('SSE subscribe failed', e); }
}

/* ---------------- 对话面板：侧推隐藏 ---------------- */
const CHAT_HIDE_KEY='gmm.chatHidden';
function applyChatHidden(hidden){
  const app=$('.app');
  if(!app) return;
  app.classList.toggle('chat-hidden',!!hidden);
  if(hidden) app.classList.remove('chat-min');
  const bar=$('#btnChatReopen'); if(bar) bar.classList.toggle('hidden',!hidden);
  const minBtn=$('#btnChatMin'); if(minBtn){ minBtn.textContent='−'; minBtn.title='最小化对话（保留竖条）'; }
  try{ localStorage.setItem(CHAT_HIDE_KEY,hidden?'1':'0'); }catch(_){}
}
$('#btnChatHide').addEventListener('click',()=>{
  if(window.innerWidth<=900){ $('#chatpanel').classList.remove('open'); }
  applyChatHidden(true);
});
$('#btnChatReopen').addEventListener('click',()=>{
  applyChatHidden(false);
  if(window.innerWidth<=900){ $('#chatpanel').classList.add('open'); }
  setTimeout(()=>{ const i=$('#chatInput'); if(i) i.focus(); },60);
});
try{ if(localStorage.getItem(CHAT_HIDE_KEY)==='1') applyChatHidden(true); }catch(_){}

/* ---------------- 真实更新事件流 / 导航未读 ---------------- */
const UF_VIEWS=['calendar','newsflash','market','portfolio','chat','knowledge','settings'];
const UF_LABEL={calendar:'日程与事件',market:'每日行情',portfolio:'我的股池',chat:'对话',knowledge:'个人知识库',settings:'设置'};
let ufSummary={}, ufFeedCache=[], ufFilter='all';
let ufJustSeen={};   // 进入板块前记下的未读条目 id，供折叠展开时还原 NEW 高亮
/* 折叠偏好：条带详情按板块记忆；抽屉详情默认收起，只列一行摘要 */
const UF_STRIP_KEY='gmm.ufStripOpen';
const UF_DETAIL_KEY='gmm.ufDetailCollapsed';
let ufStripOpen={};
try{ ufStripOpen=JSON.parse(localStorage.getItem(UF_STRIP_KEY)||'{}')||{}; }catch(_){ ufStripOpen={}; }
let ufDetailCollapsed=true;
try{ ufDetailCollapsed=localStorage.getItem(UF_DETAIL_KEY)!=='0'; }catch(_){}
function saveUfStripOpen(){ try{ localStorage.setItem(UF_STRIP_KEY,JSON.stringify(ufStripOpen)); }catch(_){} }

async function loadUpdateSummary(){
  const r=await api('/api/v2/update-feed/summary');
  if(!r||!r.ok) return;
  ufSummary=r.summary||{};
  let total=0;
  for(const v of UF_VIEWS){
    const s=ufSummary[v]||{unseen:0};
    const b=$('#ufBadge-'+v);
    if(b){ const n=s.unseen||0; b.textContent=n>99?'99+':n; b.classList.toggle('zero',!n); b.title='自上次查看以来 '+n+' 条真实更新'; }
    total+=s.unseen||0;
    renderUfStrip(v,s);
  }
  const eb=$('#ufEntryBadge'); if(eb){ eb.textContent=total>99?'99+':total; eb.classList.toggle('zero',!total); }
  const rd=$('#chatReopenDot'); if(rd) rd.classList.toggle('on',total>0);
  const meta=$('#ufDrawerMeta'); if(meta) meta.textContent='共 '+(r.events||0)+' 条真实更新 · 未读 '+total+' 条';
}

function renderUfStrip(v,s){
  const sec=$('#view-'+v); if(!sec) return;
  let strip=sec.querySelector('.uf-strip');
  if(!strip){
    strip=document.createElement('div');
    strip.className='uf-strip';
    strip.innerHTML='<div class="uf-strip-main"></div><div class="uf-strip-items hidden"></div>';
    sec.insertBefore(strip,sec.firstChild);
  }
  const unseen=s.unseen||0, open=!!ufStripOpen[v];
  strip.classList.toggle('has-new',unseen>0);
  const main=strip.querySelector('.uf-strip-main');
  main.innerHTML=
    '<span class="uf-strip-when">'+(s.lastAt?esc(s.lastAt.slice(11)):'—')+'</span>'+
    '<span>最后更新'+(s.lastAt?'于 '+esc(s.lastAt):'：暂无记录')+'</span>'+
    (s.latest?'<span class="uf-strip-latest">'+esc(s.latest.title)+' · '+esc(s.latest.detail)+'</span>':'<span class="uf-strip-latest">暂无更新记录</span>')+
    (unseen?'<span class="uf-strip-new">新 '+unseen+' 条</span>':'')+
    '<button class="uf-strip-btn" type="button" data-act="detail">'+(open?'收起详情 ▴':'展开详情 ▾')+'</button>'+
    '<button class="uf-strip-btn" type="button" data-act="drawer">查看全部</button>';
  main.querySelector('[data-act="detail"]').addEventListener('click',()=>toggleStripDetail(v,strip));
  main.querySelector('[data-act="drawer"]').addEventListener('click',()=>openUfDrawer(v));
  const box=strip.querySelector('.uf-strip-items');
  if(open){
    box.classList.remove('hidden');
    const mark=s.lastAt||'';
    if(box.dataset.loadedFor!==mark){ box.dataset.loadedFor=mark; renderStripItems(box,v); }
  }else{
    box.classList.add('hidden'); box.innerHTML=''; box.dataset.loadedFor='';
  }
}

/* 用户主动展开/收起本板块的更新明细；默认一律折叠，不自动铺开 */
async function toggleStripDetail(v,strip){
  ufStripOpen[v]=!ufStripOpen[v];
  saveUfStripOpen();
  const box=strip.querySelector('.uf-strip-items');
  const btn=strip.querySelector('[data-act="detail"]');
  if(ufStripOpen[v]){
    box.classList.remove('hidden'); box.dataset.loadedFor='';
    await renderStripItems(box,v);
    if(btn) btn.textContent='收起详情 ▴';
  }else{
    box.classList.add('hidden'); box.innerHTML=''; box.dataset.loadedFor='';
    if(btn) btn.textContent='展开详情 ▾';
  }
}

async function renderStripItems(box,v){
  const r=await api('/api/v2/update-feed?view='+encodeURIComponent(v)+'&limit=30');
  // 用户已收起时忽略迟到的响应，避免「收起后又被异步展开」
  if(!ufStripOpen[v]){ box.classList.add('hidden'); return; }
  const list=(r&&r.items)||[];
  const just=ufJustSeen[v] instanceof Set?ufJustSeen[v]:new Set();
  box.innerHTML=list.length?list.map(x=>{
    const isNew=x.isNew||just.has(x.id);
    return '<div class="uf-strip-item'+(isNew?' is-new':'')+'"><time>'+esc(x.at.slice(11))+'</time>'+
      '<span>'+esc(x.module)+' · '+esc(x.detail)+'</span>'+
      (x.count>1?'<span class="uf-new">×'+x.count+'</span>':'')+
      (isNew?'<span class="uf-new">NEW</span>':'')+'</div>';
  }).join(''):'<div class="empty">暂无更新记录</div>';
  box.classList.remove('hidden');
}

async function loadUfFeed(view){
  const r=await api('/api/v2/update-feed?view='+encodeURIComponent(view||'all')+'&limit=80');
  ufFeedCache=(r&&r.items)||[];
  renderUfDrawer();
  return ufFeedCache;
}

function renderUfDrawer(){
  const box=$('#ufList'); if(!box) return;
  /* 详细内容默认折叠：只留时间 / 模块 / 标题 / NEW，一行一条 */
  box.classList.toggle('compact',ufDetailCollapsed);
  const dt=$('#btnUfDetailToggle'); if(dt) dt.textContent=ufDetailCollapsed?'展开详情':'收起详情';
  const list=ufFeedCache.filter(x=>ufFilter==='all'||x.view===ufFilter);
  if(!list.length){ box.innerHTML='<div class="empty">该板块暂无更新记录</div>'; return; }
  const groups={};
  for(const x of list){ (groups[x.view]=groups[x.view]||[]).push(x); }
  box.innerHTML=Object.keys(groups).map(v=>{
    const just=ufJustSeen[v] instanceof Set?ufJustSeen[v]:new Set();
    return '<div class="uf-group-title">'+esc(UF_LABEL[v]||v)+'</div>'+
      groups[v].map(x=>{
        const isNew=x.isNew||just.has(x.id);
        return '<div class="uf-item'+(isNew?' is-new':'')+'" data-view="'+esc(v)+'">'+
        '<span class="uf-item-time">'+esc(x.at.slice(5,16))+'</span>'+
        '<div class="uf-item-body"><div class="uf-item-title"><span class="uf-item-mod">'+esc(x.module)+'</span>'+
        esc(x.title)+(isNew?'<span class="uf-item-new">NEW</span>':'')+'</div>'+
        '<div class="uf-item-detail">'+esc(x.detail)+'</div>'+
        '<div class="uf-item-src">'+esc(x.source)+(x.count>1?' · 窗口内累计 '+x.count+' 次':'')+'</div></div></div>';
      }).join('');
  }).join('');
  $$('#ufList .uf-item').forEach(el=>el.addEventListener('click',()=>{
    const v=el.dataset.view; closeUfDrawer();
    const btn=$('.nav-item[data-view="'+v+'"]'); if(btn) btn.click();
  }));
}

async function openUfDrawer(v){
  ufFilter=v||'all';
  $$('#ufTabs .uf-tab').forEach(t=>t.classList.toggle('active',t.dataset.view===ufFilter));
  $('#ufDrawer').classList.remove('hidden'); $('#ufMask').classList.remove('hidden');
  await loadUfFeed(ufFilter==='all'?'all':ufFilter);
  await loadUpdateSummary();
}
function closeUfDrawer(){
  $('#ufDrawer').classList.add('hidden'); $('#ufMask').classList.add('hidden');
}
$('#btnUpdateFeed').addEventListener('click',()=>openUfDrawer('all'));
$('#btnUfClose').addEventListener('click',closeUfDrawer);
$('#ufMask').addEventListener('click',closeUfDrawer);
$$('#ufTabs .uf-tab').forEach(t=>t.addEventListener('click',()=>{
  ufFilter=t.dataset.view;
  $$('#ufTabs .uf-tab').forEach(x=>x.classList.toggle('active',x===t));
  loadUfFeed(ufFilter==='all'?'all':ufFilter);
}));
$('#btnUfDetailToggle').addEventListener('click',()=>{
  ufDetailCollapsed=!ufDetailCollapsed;
  try{ localStorage.setItem(UF_DETAIL_KEY,ufDetailCollapsed?'1':'0'); }catch(_){}
  renderUfDrawer();
});
$('#btnUfSeenAll').addEventListener('click',async()=>{
  await post('/api/v2/update-feed/seen',{view:'all'});
  await loadUpdateSummary();
  await loadUfFeed(ufFilter==='all'?'all':ufFilter);
  toast('更新动态','已全部标记为已读');
});
/* 进入某板块：先记住本次「自上次查看以来」的未读条目，再标记已读清零徽标。
   明细默认折叠，用户展开时用 ufJustSeen 还原 NEW 高亮，不因已读而丢失。 */
async function markViewSeen(v){
  if(!UF_VIEWS.includes(v)) return;
  try{
    const r=await api('/api/v2/update-feed?view='+encodeURIComponent(v)+'&limit=80');
    ufJustSeen[v]=new Set(((r&&r.items)||[]).filter(x=>x.isNew).map(x=>x.id));
  }catch(_){ ufJustSeen[v]=new Set(); }
  await post('/api/v2/update-feed/seen',{view:v});
  await loadUpdateSummary();
}
$$('.nav-item').forEach(b=>b.addEventListener('click',()=>markViewSeen(b.dataset.view)));
/* SSE 有真实数据推送时同步刷新徽标（见 subscribeV2Events）；另设 30 秒兜底轮询 */
setInterval(loadUpdateSummary, 30*1000);
/* 股市板块消息面排名「实时更新」：SSE(news / news-pulse) 已即时刷新，
   再设 60 秒兜底轮询；仅当前在「新闻快讯」且页面可见时执行，避免后台无谓请求。 */
let nfAutoBusy=false;
setInterval(async()=>{
  if(currentView!=='newsflash' || document.hidden || nfAutoBusy) return;
  if(typeof loadNewsFlash!=='function') return;
  nfAutoBusy=true;
  try{ await loadNewsFlash(); }catch(_){ }
  finally{ nfAutoBusy=false; }
}, 60*1000);

/* ---------------- 暴露给 agent-ui.js / 控制台调试的接口 ---------------- */
window.toast = toast;
/** 主动重新打开「事件提醒卡片」（SSE 推送之外的手动入口） */
window.showEventCard = showEventCard;
/** 2D 力导向图入口：接受 {nodes:[{id,type,label,confidence}], edges:[{from,to,type}], stats, builtAt} */
window.loadGraph2D = function(g){
  graphState=null;
  const st=$('#graphStats');
  if(st && g.stats) st.textContent=(g.stats.nodeCount||g.stats.nodes||g.nodes.length)+' 节点 · '+
    (g.stats.linkCount||g.stats.edges||g.edges.length)+' 条边'+(g.builtAt?' · '+new Date(g.builtAt).toLocaleString('zh-CN'):'');
  if(!g.nodes.length){ stopGraphLoop(); $('#graphWrap').innerHTML='<div class="empty">当前筛选下无节点</div>'; return; }
  buildForceGraph(g); renderGraphLegend(); renderSettingsPanel();
};
window.applyGraphSearch = function(q){
  graphSettings.searchQuery=q; saveGraphSettings(); loadGraph();
};
window.loadEntriesFn = loadEntries;
window.stopGraphLoopFn = stopGraphLoop;

/* ---------------- 启动 ---------------- */
initCal();
initCalSecs();
loadUpdateSummary();
subscribeV2Events();
loadChatHistory();
loadAgentStatus();
renderCalendar();
loadUpcoming();
loadEventStudy();
loadFutureEvents();
loadGateReview();
loadMarket();
loadPortfolio();
loadNotes();
// 知识库默认展示 3D 全板块图谱（agent-ui.js 在 DOMContentLoaded 时也会再触发一次，幂等）
if(window.AgentUI && typeof window.AgentUI.loadKG==='function') window.AgentUI.loadKG();
else loadGraph();

})();
