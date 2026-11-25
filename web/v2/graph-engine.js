/* ============================================================
 * graph-engine.js — 知识图谱力导向引擎（零依赖，原生 JS）
 *
 * 移植自 AI-Hel2 项目：
 *   src/components/sphere/physics.ts    （Barnes-Hut 力导向引擎）
 *   src/components/sphere/graphAdapter.ts（数据适配 / 着色 / 边合并）
 *   src/types/knowledge.ts              （DEFAULT_GRAPH_SETTINGS_2D）
 * 算法常量与公式按原文保留，仅做 TS→JS 类型擦除 + 金融知识库类型配色替换。
 *
 * 暴露 window.GraphEngine = { createSimulation, tick, pinNode, movePinned,
 *   unpinNode, setConfig, buildGraphData, DEFAULT_SETTINGS, TYPE_COLORS, TYPE_LABELS }
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 参数默认值（对应 AI-Hel2 DEFAULT_GRAPH_SETTINGS_2D） ---------- */
  var DEFAULT_SETTINGS = {
    searchQuery: '',        // 节点名搜索
    showOrphans: true,      // 显示孤岛节点
    typeFilter: [],         // 类型过滤
    colorGroups: [],        // [{id,name,color,pattern}] 正则着色
    typeColors: {},         // {type:'#hex'} 自定义类型色，优先级最高
    showArrows: false,      // 边箭头
    textOpacity: 0.85,      // 标签透明度
    edgeOpacity: 0.6,       // 边透明度
    nodeSize: 1.25,         // 节点尺寸倍率
    linkThickness: 0.4,     // 边宽
    centerForce: 0.1,       // 向心力 (0-1)
    repelForce: 11,         // 斥力 (0-20, 实际取 ³)
    attractForce: 0.8,      // 吸引力 (0-1)
    linkLength: 70,         // 边长 (30-500)
    dragForce: 4            // 拖拽力 (1-15)
  };

  /* ---------- 类型配色：沿用本项目 v2 既有配色，移植 AI-Hel2 的着色优先级 ---------- */
  var TYPE_COLORS = {
    concept: '#165dff',    // 概念 蓝
    factor: '#722ed1',     // 因子 紫
    experience: '#00b42a', // 经验 绿
    pattern: '#f7ba1e',    // 模式 黄
    event: '#f53f3f',      // 事件 红
    question: '#d46b08'    // 问题 橙
  };
  var TYPE_ORDER = Object.keys(TYPE_COLORS);
  var TYPE_LABELS = {
    concept: '概念', factor: '因子', experience: '经验',
    pattern: '模式', event: '事件', question: '问题'
  };
  var _tcIdx = 0;
  function typeColor(t) {
    if (TYPE_COLORS[t]) return TYPE_COLORS[t];
    return TYPE_ORDER[_tcIdx++ % TYPE_ORDER.length]; // 未知类型循环取色
  }
  function matchColorGroup(name, groups) {
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (!g.pattern || !g.pattern.trim()) continue;
      try { if (new RegExp(g.pattern, 'i').test(name)) return g.color; } catch (_) {}
    }
    return null;
  }

  /* ============================================================
   * 数据适配：把本项目 graph.json 的 {nodes,edges} 映射成渲染用的 FGNode/FGLink
   * 现有数据节点: {id,type,label,confidence,sourceNoteId}
   * 现有数据边:   {from,to,type,sourceNoteId}
   * ============================================================ */
  function buildGraphData(rawNodes, rawEdges, opts) {
    opts = opts || {};
    var settings = opts.settings || DEFAULT_SETTINGS;
    var entities = (rawNodes || []).map(function (n) {
      return {
        id: n.id,
        name: String(n.label || n.name || n.id),
        entity_type: n.type || 'concept',
        confidence: n.confidence == null ? 0.8 : n.confidence,
        hidden: !!n.hidden,
        sourceNoteId: n.sourceNoteId,
        color: n.color
      };
    });
    var relations = (rawEdges || []).map(function (e) {
      return {
        from_id: e.from, to_id: e.to,
        relation_type: e.type || 'relates',
        weight: e.weight == null ? 1 : e.weight,
        bidirectional: !!e.bidirectional
      };
    });

    // 度数统计
    var degMap = Object.create(null);
    relations.forEach(function (r) {
      degMap[r.from_id] = (degMap[r.from_id] || 0) + 1;
      degMap[r.to_id] = (degMap[r.to_id] || 0) + 1;
    });

    var searchLower = String(opts.searchQuery || '').toLowerCase().trim();
    var typeFilter = (settings.typeFilter || []).map(function (t) { return String(t).toLowerCase(); });
    var visibleIds = Object.create(null);
    var nodes = [];

    entities.forEach(function (e) {
      if (e.hidden) return;
      var degree = degMap[e.id] || 0;
      if (!settings.showOrphans && degree === 0) return;
      if (typeFilter.length && typeFilter.indexOf(e.entity_type.toLowerCase()) < 0) return;
      if (searchLower && e.name.toLowerCase().indexOf(searchLower) < 0) return;
      visibleIds[e.id] = true;
      // 着色优先级：自定义色 > 数据自带色 > 正则分组 > 类型内置色
      var color = settings.typeColors[e.entity_type] || e.color ||
        matchColorGroup(e.name, settings.colorGroups || []) || typeColor(e.entity_type);
      nodes.push({
        id: e.id,
        name: e.name,
        entityType: e.entity_type,
        degree: degree,
        val: 1 + Math.min(degree, 12) * 0.4,           // AI-Hel2 nodeVal
        color: color,
        isOrphan: degree === 0,
        _sphereRadius: 4 + Math.min(degree, 12) * 0.5, // AI-Hel2 nodeRadius
        confidence: e.confidence,
        sourceNoteId: e.sourceNoteId
      });
    });

    // 同向多重边合并（AI-Hel2 原文：按 [source,target].sort() 分组，weight 取 max，合并关系类型）
    var edgeGroups = Object.create(null);
    relations.forEach(function (r) {
      if (!visibleIds[r.from_id] || !visibleIds[r.to_id]) return;
      var key = [r.from_id, r.to_id].sort().join('||');
      var g = edgeGroups[key];
      if (g) {
        g.weight = Math.max(g.weight, r.weight);
        if (g.relationTypes.indexOf(r.relation_type) < 0) g.relationTypes.push(r.relation_type);
      } else {
        edgeGroups[key] = {
          source: r.from_id, target: r.to_id, weight: r.weight,
          relationTypes: [r.relation_type]
        };
      }
    });
    var links = Object.keys(edgeGroups).map(function (k) {
      var g = edgeGroups[k];
      return {
        source: g.source, target: g.target, weight: g.weight,
        merged: g.relationTypes.length > 1,
        relationTypes: g.relationTypes
      };
    });

    return { nodes: nodes, links: links };
  }

  /* ============================================================
   * 力导向物理引擎（逐行移植自 physics.ts）
   * ============================================================ */
  var DEFAULT_SIM_CONFIG = {
    centerStrength: 0.1,
    repelBase: 1000,
    linkStrength: 1.0,
    linkDistance: 250,
    dragBoost: 4
  };
  var VELOCITY_DECAY = 0.4;
  var ALPHA_DECAY_FACTOR = 0.9772;
  var ALPHA_MIN = 0.001;
  var SPEED_THRESHOLD = 0.015;
  var ALPHA_THRESHOLD = 0.03;
  var FREEZE_FRAMES = 12;
  var BH_THETA_SQ = 0.81;
  var DISTANCE_MIN = 30;
  var COLLIDE_STRENGTH = 0.5;

  /* ---- Barnes-Hut 四叉树 ---- */
  function qtreeBuild(arr) {
    if (!arr.length) return null;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < arr.length; i++) {
      var n = arr[i];
      if (n.x < x0) x0 = n.x; if (n.y < y0) y0 = n.y;
      if (n.x > x1) x1 = n.x; if (n.y > y1) y1 = n.y;
    }
    var pad = Math.max(x1 - x0, y1 - y0, 1) * 0.01;
    return qtreeInsert(null, arr, x0 - pad, y0 - pad, x1 + pad, y1 + pad);
  }
  function qtreeInsert(_root, arr, x0, y0, x1, y1) {
    if (arr.length === 1) {
      var n = arr[0];
      return { x: n.x, y: n.y, mass: 1, x0: x0, y0: y0, x1: x1, y1: y1 };
    }
    var cx = 0, cy = 0, i;
    for (i = 0; i < arr.length; i++) { cx += arr[i].x; cy += arr[i].y; }
    cx /= arr.length; cy /= arr.length;
    var xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
    var quads = [[], [], [], []];
    for (i = 0; i < arr.length; i++) {
      var q = (arr[i].x >= xm ? 1 : 0) | (arr[i].y >= ym ? 2 : 0);
      quads[q].push(arr[i]);
    }
    var children = [];
    var bounds = [[x0, y0, xm, ym], [xm, y0, x1, ym], [x0, ym, xm, y1], [xm, ym, x1, y1]];
    for (i = 0; i < 4; i++) {
      if (quads[i].length) {
        var b = bounds[i];
        children.push(qtreeInsert(null, quads[i], b[0], b[1], b[2], b[3]));
      }
    }
    return { x: cx, y: cy, mass: arr.length, x0: x0, y0: y0, x1: x1, y1: y1, children: children };
  }
  function qtreeApply(node, body, repelK) {
    if (!node.mass) return;
    if (!node.children && node.x === body.x && node.y === body.y) return;
    var dx = node.x - body.x, dy = node.y - body.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    if (dist < DISTANCE_MIN) dist = DISTANCE_MIN;
    var cellW = node.x1 - node.x0;
    if (!node.children || (cellW * cellW) / (dist * dist) < BH_THETA_SQ) {
      var rf = repelK * node.mass / dist;
      body.vx -= (dx / dist) * rf;
      body.vy -= (dy / dist) * rf;
    } else {
      for (var i = 0; i < node.children.length; i++) qtreeApply(node.children[i], body, repelK);
    }
  }

  /* ---- 仿真创建 ---- */
  function createSimulation(nodeIds, edges, config, width, height, existingNodes) {
    config = config || {};
    var cfg = {};
    Object.keys(DEFAULT_SIM_CONFIG).forEach(function (k) {
      cfg[k] = config[k] == null ? DEFAULT_SIM_CONFIG[k] : config[k];
    });
    var nodes = Object.create(null);
    var cx = width / 2, cy = height / 2;
    var spread = Math.min(width, height) * 0.25;
    nodeIds.forEach(function (id) {
      var prev = existingNodes && existingNodes[id];
      nodes[id] = prev
        ? { id: id, x: prev.x + (Math.random() - 0.5) * 4, y: prev.y + (Math.random() - 0.5) * 4,
            vx: 0, vy: 0, pinned: false, radius: prev.radius }
        : { id: id,
            x: cx + Math.sqrt(Math.random()) * spread * Math.cos(Math.random() * 2 * Math.PI),
            y: cy + Math.sqrt(Math.random()) * spread * Math.sin(Math.random() * 2 * Math.PI),
            vx: 0, vy: 0, pinned: false, radius: 8 };
    });
    return {
      nodes: nodes,
      edges: (edges || []).map(function (e) {
        return { source: e.source, target: e.target, weight: e.weight == null ? 1 : e.weight };
      }),
      alpha: 1.0, frozen: false, convergenceFrames: 0, config: cfg
    };
  }

  /* ---- 单帧推进（AI-Hel2 tick 原文七步） ---- */
  function tick(state, width, height) {
    var nodes = state.nodes, edges = state.edges, config = state.config;
    var arr = Object.keys(nodes).map(function (k) { return nodes[k]; });
    var n = arr.length;
    if (!n) return;
    var cx = width / 2, cy = height / 2, i;
    var dragId = null;
    for (i = 0; i < arr.length; i++) { if (arr[i].pinned) { dragId = arr[i].id; break; } }

    // ① 质心平移（始终生效，参数即时反馈）
    if (config.centerStrength > 0) {
      var sx = 0, sy = 0, cnt = 0;
      for (i = 0; i < arr.length; i++) {
        if (!arr[i].pinned) { sx += arr[i].x; sy += arr[i].y; cnt++; }
      }
      if (cnt) {
        var tx = (cx - sx / cnt) * config.centerStrength;
        var ty = (cy - sy / cnt) * config.centerStrength;
        for (i = 0; i < arr.length; i++) {
          if (!arr[i].pinned) { arr[i].x += tx; arr[i].y += ty; }
        }
      }
    }
    if (state.frozen) return;
    var alpha = state.alpha;

    // ② 逐节点向心
    var centerK = config.centerStrength * alpha;
    for (i = 0; i < arr.length; i++) {
      var nd = arr[i];
      if (nd.pinned) continue;
      nd.vx += (cx - nd.x) * centerK;
      nd.vy += (cy - nd.y) * centerK;
    }
    // ③ Barnes-Hut 斥力
    var repelK = config.repelBase * alpha;
    var root = qtreeBuild(arr);
    if (root) for (i = 0; i < arr.length; i++) { if (!arr[i].pinned) qtreeApply(root, arr[i], repelK); }
    // ④ 圆碰撞
    for (i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var a = arr[i], b = arr[j];
        var dx = b.x - a.x, dy = b.y - a.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var minR = a.radius + b.radius + 4;
        if (dist < minR) {
          var overlap = (minR - dist) * COLLIDE_STRENGTH;
          if (!a.pinned) { a.x -= (dx / dist) * overlap; a.y -= (dy / dist) * overlap; }
          if (!b.pinned) { b.x += (dx / dist) * overlap; b.y += (dy / dist) * overlap; }
        }
      }
    }
    // ⑤ Hooke 弹簧（度数越高，单边越弱）
    var degree = Object.create(null);
    edges.forEach(function (e) {
      degree[e.source] = (degree[e.source] || 0) + 1;
      degree[e.target] = (degree[e.target] || 0) + 1;
    });
    var baseLen = config.linkDistance, baseK = config.linkStrength * alpha;
    edges.forEach(function (e) {
      var sa = nodes[e.source], sb = nodes[e.target];
      if (!sa || !sb) return;
      var springK = baseK / Math.min(degree[e.source] || 1, degree[e.target] || 1);
      var dx2 = sb.x - sa.x, dy2 = sb.y - sa.y;
      var d2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
      var wf = 0.5 + e.weight * 0.5;
      var ideal = baseLen / Math.max(wf, 0.55);
      var sf = (d2 - ideal) * springK;
      if (dragId && (e.source === dragId || e.target === dragId)) sf *= config.dragBoost;
      if (!sa.pinned) { sa.vx += (dx2 / d2) * sf; sa.vy += (dy2 / d2) * sf; }
      if (!sb.pinned) { sb.vx -= (dx2 / d2) * sf; sb.vy -= (dy2 / d2) * sf; }
    });
    // ⑥ 速度积分
    var maxV = 8 + alpha * 25, peak = 0;
    for (i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v.pinned) continue;
      var sp = Math.sqrt(v.vx * v.vx + v.vy * v.vy);
      if (sp > maxV) { v.vx = (v.vx / sp) * maxV; v.vy = (v.vy / sp) * maxV; }
      v.vx *= (1 - VELOCITY_DECAY); v.vy *= (1 - VELOCITY_DECAY);
      v.x += v.vx; v.y += v.vy;
      var sp2 = Math.sqrt(v.vx * v.vx + v.vy * v.vy);
      if (sp2 > peak) peak = sp2;
    }
    // ⑦ alpha 衰减 + 冻结
    if (dragId) {
      if (state.alpha < 0.05) state.alpha = 0.05;
      if (state.alpha < 0.15) state.alpha += 0.01;
      state.alpha *= 0.985;
      state.frozen = false; state.convergenceFrames = 0;
    } else if (!state.frozen) {
      state.alpha *= ALPHA_DECAY_FACTOR;
    }
    if (!dragId) {
      if (state.alpha <= ALPHA_MIN) { state.frozen = true; state.alpha = 0; }
      else if (peak < SPEED_THRESHOLD && state.alpha < ALPHA_THRESHOLD) {
        state.convergenceFrames++;
        if (state.convergenceFrames >= FREEZE_FRAMES) { state.frozen = true; state.alpha = 0; }
      } else if (peak >= SPEED_THRESHOLD) state.convergenceFrames = 0;
    }
  }

  function pinNode(s, id, x, y) {
    var nd = s.nodes[id]; if (!nd) return;
    nd.pinned = true; nd.x = x; nd.y = y; nd.vx = 0; nd.vy = 0;
    s.frozen = false; s.convergenceFrames = 0;
  }
  function movePinned(s, id, x, y) {
    var nd = s.nodes[id]; if (!nd || !nd.pinned) return;
    nd.x = x; nd.y = y;
  }
  function unpinNode(s, id) { var nd = s.nodes[id]; if (nd) nd.pinned = false; }
  function setConfig(s, p) { Object.keys(p).forEach(function (k) { s.config[k] = p[k]; }); }

  global.GraphEngine = {
    createSimulation: createSimulation, tick: tick,
    pinNode: pinNode, movePinned: movePinned, unpinNode: unpinNode, setConfig: setConfig,
    buildGraphData: buildGraphData,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    DEFAULT_SIM_CONFIG: DEFAULT_SIM_CONFIG,
    TYPE_COLORS: TYPE_COLORS, TYPE_LABELS: TYPE_LABELS
  };
})(window);
