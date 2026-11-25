/* navplan.js — 整合后的交互方案导航层
 *
 * 【边界声明 / 反幻觉】
 *  1. 本文件是纯增量新增，index.html 只追加了 5 处节点，未删除或修改任何原有节点。
 *  2. web/app.js、web/styles.css、server/server.js 本次零改动。
 *  3. 本文件不调用任何 /api/* 接口、不创建 EventSource、不写 localStorage、
 *     不修改 app.js 的状态对象 S、不触发任何评分计算或配置写入。
 *  4. 「原有系统」导航项只做锚点滚动到现有面板；「智能体增量」项只展示
 *     「设计态 · 未接入」说明，不伪装成已实现。
 *  5. 备份：web/_backup_20261118_1849/（改造前 index.html / app.js / styles.css）
 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  /* ① 原有系统：target 用现有 panel 的 h2 前缀定位，绝不新增 id 到原有 DOM */
  var ORIGIN = [
    { ico: '📡', name: '监控总览', target: '核心监测',
      api: '/api/snapshot · /api/quotes · /api/alerts',
      desc: '行情卡片、告警中心、数据源状态与全球新闻，SSE 实时推送' },
    { ico: '🎯', name: '自动选股', target: '当日观察池',
      api: '/api/stocks · /api/journal/picks · /api/journal/live',
      desc: '多因子量化评分、量化指标行 + 一句话看多理由、09:05/22:00 定格与实时池' },
    { ico: '💼', name: '我的持仓', target: '持仓监控',
      api: '/api/holdings',
      desc: '实时盈亏、ATR14×2 止损、七条确定性建议' },
    { ico: '🧭', name: '研究看板', target: '评估数据库与经验库',
      api: '/api/journal · /api/cycle · /api/flow · /api/riskoff · /api/edge',
      desc: '经验库闭环、周期事件、资金主体与避险、预期研究与多因素叠加' }
  ];

  /* ② 智能体增量：全部设计态，点击只出说明 */
  var INC = [
    { ico: '💬', name: '对话入口', skill: '分诊 / 抽取 / 白话',
      desc: '一句话自动区分「可登记为因子」还是「可作为经验」：确定性双层分诊先跑，智能体只给建议不得覆盖；低置信度进「待澄清」不猜。' },
    { ico: '🧮', name: '因子池', skill: '因子登记 / IC 复检',
      desc: '定期更新常用因子 + 自定义因子；状态机 draft→字段白名单校验→影子运行(只算不进分)→Rank IC 复检→人工审核→有界上架。复用现有 ic.js。' },
    { ico: '📚', name: '经验池', skill: '个人 / 自动 / 讨论三类来源',
      desc: '个人经验总结与多智能体复盘讨论产物统一进同一待审队列；可证伪、n≥8 才归纳、被证伪保留记录不删除。' },
    { ico: '🔍', name: '今日复盘', skill: '12 个技能 / 四阶段排布',
      desc: '复盘对象 = 持仓 ∪ 09:05 定格名单 ∪ 实时池 ∪ 观察池；15:10 后冻结事实账本、回填真实超额。fact-audit 为纯确定性代码一票否决闸，排在归纳之前。' },
    { ico: '✅', name: '审核台', skill: '采纳 / 驳回 / 有界回流',
      desc: '所有 AI 产出标注「AI 提案 · 未生效」；人工采纳后沿现有 journal 五段式有界回流（±2 分 / 乘数 [0.8,1.25] / 不翻符号），终点回到 stocks.js 自动选股评分。' }
  ];

  var AI_MARK = 'AI 提案 · 未生效';

  /* ---------- 面板定位：只按 h2 前缀查找现有 section，不做任何猜测 ---------- */
  function findPanel(title) {
    var hs = $$('.panel-head h2');
    for (var i = 0; i < hs.length; i++) {
      var t = (hs[i].textContent || '').trim();
      if (t.indexOf(title) === 0) {
        if (hs[i].closest) {
          var s = hs[i].closest('section');
          if (s) return s;
        }
        var p = hs[i].parentElement;
        return (p && p.parentElement) || null;
      }
    }
    return null;
  }

  function openDrawer() {
    var m = $('#npMask'), d = $('#npDrawer');
    if (m) m.classList.remove('hidden');
    if (d) d.classList.remove('hidden');
  }
  function closeDrawer() {
    var m = $('#npMask'), d = $('#npDrawer');
    if (m) m.classList.add('hidden');
    if (d) d.classList.add('hidden');
  }

  function showNote(title, body) {
    var n = $('#npNote');
    if (!n) return;
    n.innerHTML = '<span class="np-note-title">⚠️ ' + esc(title) + '　<span style="font-weight:700">' +
      esc(AI_MARK) + '</span></span>' +
      '<div><b>设计态 · 未接入 · 不参与任何评分。</b> ' + body + '</div>';
    n.classList.remove('hidden');
    n.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function jumpTo(title, name) {
    var p = findPanel(title);
    closeDrawer();
    if (!p) {
      showNote(name, '未在当前页面定位到对应面板，系统不猜测、不跳转。');
      openDrawer();
      return;
    }
    p.scrollIntoView({ behavior: 'smooth', block: 'start' });
    p.classList.add('np-flash');
    setTimeout(function () { p.classList.remove('np-flash'); }, 2200);
  }

  /* ---------- 生成抽屉（挂在 #npRoot，不触碰任何现有面板） ---------- */
  function itemHtml(o, group) {
    var isLive = group === 'origin';
    var isSet = group === 'set';
    var badge = isLive ? '<span class="np-badge np-b-live">已上线</span>'
      : isSet ? '<span class="np-badge np-b-set">' + esc(o.badge || '设计') + '</span>'
        : '<span class="np-badge np-b-design">增量 · 设计</span>';
    var descHtml = o.raw ? o.desc : esc(o.desc);   /* raw=调用方已自行转义的静态 HTML */
    return '<button class="np-item" data-group="' + group + '" data-name="' + esc(o.name) + '">' +
      '<span class="np-ico">' + o.ico + '</span>' +
      '<span class="np-main"><span class="np-name">' + esc(o.name) + '</span>' +
      '<span class="np-desc">' + descHtml + '</span></span>' + badge + '</button>';
  }

  function build() {
    var root = $('#npRoot');
    if (!root) return;

    var originRows = ORIGIN.map(function (o) {
      return itemHtml({ ico: o.ico, name: o.name, raw: true,
        desc: esc(o.desc) + '　<code>' + esc(o.api) + '</code>' }, 'origin');
    }).join('');
    var incRows = INC.map(function (o) {
      return itemHtml({ ico: o.ico, name: o.name, desc: o.desc }, 'inc');
    }).join('');
    var setRows = [
      itemHtml({ ico: '⚙️', name: '告警设置（现有）', badge: '已上线',
        desc: '直接打开现有设置抽屉：阈值、频率、声音、观察池、闭环四模块全部沿用原功能' }, 'set'),
      itemHtml({ ico: '🤖', name: '智能体设置', badge: '设计',
        desc: 'DeepSeek 配置与隐私开关（设计态）；点击下方「智能体选型结论」查看当前唯一方案' }, 'set')
    ].join('');

    var html = '' +
      '<div id="npMask" class="np-mask hidden"></div>' +
      '<aside id="npDrawer" class="np-drawer hidden" aria-label="整合后的交互方案">' +
        '<div class="np-head">' +
          '<div class="np-head-top"><div><h2>整合后的交互方案</h2>' +
          '<p>原有监控与自动选股为<b>主体</b>；因子池 / 经验池 / 智能体复盘为挂在其上的<b>增量</b>。' +
          '本抽屉只做导航与设计态说明，不改动任何现有数据。</p></div>' +
          '<button id="npClose" class="np-close">关闭</button></div>' +
          '<div class="np-tricolor">' +
            '<span class="np-tc-live">① 原有系统 · 已上线</span>' +
            '<span class="np-tc-design">② 智能体增量 · 设计态未接入</span>' +
            '<span class="np-tc-safe">③ 设置</span>' +
          '</div>' +
        '</div>' +
        '<div class="np-body">' +
          '<div id="npNote" class="np-note hidden"></div>' +

          '<div class="np-group"><div class="np-group-label">① 原有系统 · 已上线' +
            '<small>交互方案的主体，每日在跑；点击平滑滚动到现有面板，不新建视图</small></div>' +
            originRows + '</div>' +

          '<div class="np-group"><div class="np-group-label">② 智能体增量 · 设计态' +
            '<small>挂在原有系统之上的增加；点击仅查看说明，不触发任何后端调用</small></div>' +
            incRows + '</div>' +

          '<div class="np-group"><div class="np-group-label">③ 设置</div>' + setRows + '</div>' +

          /* 智能体选型结论：把「目前采用哪个」直接写进界面 */
          '<div class="np-card" id="npSelectCard">' +
            '<h3>🤖 智能体选型结论（唯一）</h3>' +
            '<div class="np-kv">' +
              '<div class="k">角色范式</div><div class="v"><b>TradingAgents</b> —— 只借鉴角色划分 / 结构化辩论 / 决策记忆，<b>不安装</b></div>' +
              '<div class="k">实现方式</div><div class="v"><b>Agent Skills 技能排布自建</b>：<code>agentBus.js</code> + <code>skillRunner.js</code> + 12 个 <code>SKILL.md</code>，零新增运行时依赖</div>' +
              '<div class="k">模型</div><div class="v">DeepSeek 薄适配器：<code>quick=deepseek-flash</code>（分诊/抽取/白话）、<code>deep=deepseek-v4-pro</code>（辩论/归纳）；模型名配置化、不写死</div>' +
              '<div class="k">判断链路</div><div class="v">现有 <code>stocks.js</code> 确定性评分<b>一行不改</b>，智能体永不进入；产出须过审核队列才有界生效</div>' +
              '<div class="k">降级</div><div class="v">未配置 LLM 时自动降级 <b>L0 纯确定性模式</b>，两池 / 复盘 / 审核照常可用</div>' +
            '</div>' +
            '<p class="np-hint">为什么不是别的：LangGraph / CrewAI / AutoGen / AgentScope / Dify 均为 Python 或需独立部署，装进来会把零依赖 Node 拆成双运行时；TradingAgents 内核是让 LLM 做买卖决策，与「判断链路不放 LLM」冲突。多智能体讨论用 role-as-skill 即可复现，且 <code>fact-audit</code> 可做成纯代码一票否决闸。</p>' +
          '</div>' +

          /* 现有功能保全清单 */
          '<details class="np-preserve"><summary>🛡️ 现有功能保全清单（本次改造零改动边界）</summary>' +
            '<div class="np-preserve-body">' +
              '<ul>' +
                '<li><b>web/app.js</b>（2,182 行）、<b>web/styles.css</b>（714 行）、<b>server/server.js</b> —— <b>一行未改</b></li>' +
                '<li><b>web/index.html</b> 仅追加 5 处节点（新样式引入 / 顶栏按钮 / 状态带 / 空容器 / 新脚本），未删除或修改任何原有 <code>id</code>、panel、表单与按钮</li>' +
                '<li>全部现有 <code>&lt;section class="panel"&gt;</code>、<code>#settings</code> 抽屉、<code>renderAll()</code> 的 21 项调用、SSE 全通道事件监听、全部 <code>/api/*</code> 拉取与配置读写 —— <b>原样保留</b></li>' +
                '<li>本导航层：<b>不调用任何 /api/*、不创建 EventSource、不写 localStorage、不修改 S、不触发任何评分或配置写入</b></li>' +
                '<li>「原有系统」项只做锚点滚动；「智能体增量」项只展示设计态说明，全部标注 <b>' + esc(AI_MARK) + '</b></li>' +
                '<li>改造前备份：<code>web/_backup_20261118_1849/</code>（index.html / app.js / styles.css）</li>' +
              '</ul>' +
            '</div></details>' +
        '</div>' +
      '</aside>';

    root.innerHTML = html;

    /* ---------- 事件绑定（全部只作用于新增节点 / 复用现有按钮） ---------- */
    var bind = function (id, fn) { var el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    bind('btnNavPlan', openDrawer);
    bind('btnPlanOpenBar', openDrawer);
    bind('npClose', closeDrawer);
    bind('npMask', closeDrawer);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });

    $$('.np-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var g = btn.getAttribute('data-group');
        var name = btn.getAttribute('data-name');
        if (g === 'origin') {
          var o = ORIGIN.filter(function (x) { return x.name === name; })[0];
          if (o) jumpTo(o.target, o.name);
          return;
        }
        if (g === 'set') {
          if (name === '告警设置（现有）') {
            closeDrawer();
            var bs = document.getElementById('btnSettings');
            if (bs) {
              bs.click();                      /* 复用现有功能，不重写 */
            } else {
              showNote(name, '未找到现有设置按钮，系统不猜测、不代填。');
              openDrawer();
            }
          } else {
            var card = document.getElementById('npSelectCard');
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            showNote(name, 'DeepSeek 密钥只进环境变量、默认 <code>allowExternal:false</code>；未接入前配置面板不保存、不生效。当前方案见下方「智能体选型结论」。');
          }
          return;
        }
        var it = INC.filter(function (x) { return x.name === name; })[0];
        if (it) {
          showNote(name, esc(it.desc) + '<br><span style="color:var(--text-3)">技能：' +
            esc(it.skill) + '　｜　状态：' + esc(AI_MARK) + '</span>');
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
