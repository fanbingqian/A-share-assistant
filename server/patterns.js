'use strict';

/* ==========================================================================
 * patterns.js — 「绝招」技术形态量化规则库（只读标注层）
 *
 * 目标：把用户长文本里的民间交易口诀，转译成可复算的 K 线 / 量能 / 指标条件，
 * 并与市面上通用量化指标对齐（唐奇安通道、BIAS 乖离率、斐波那契回撤、
 * MACD 0 轴、均线多头排列、量比 VR / OBV、布林带、K 线吞噬形态、换手率等）。
 *
 * 【口径转换 · 重要】
 *   原文的「买点 / 卖点 / 肯定上涨 / 100% 上涨 / 绝佳进仓点」一律转成
 *   「形态命中 + 量化依据 + 失效条件（证伪）」三项，不做涨跌预测、不给买卖指令。
 *   原因：这些断言无法由历史数据保证，系统一贯的反幻觉纪律是不编造结论。
 *
 * 【不变式】
 *   - 输入只有真实前复权日线（technical.normalizeBars 的输出）与既有缓存字段；
 *   - 数据不可得 → hit=null、basis 写明原因，不用 0 / false 填充；
 *   - 只输出命中与依据，不接入评分、不改选股结果、不认定涨跌原因。
 * ========================================================================== */

const r2 = v => Number.isFinite(Number(v)) ? +Number(v).toFixed(2) : null;
const avg = (a, s, e) => {
  const w = a.slice(s, e);
  return w.length ? w.reduce((x, y) => x + (Number(y) || 0), 0) / w.length : null;
};
const hhv = (a, s, e) => {
  const w = a.slice(s, e).filter(Number.isFinite);
  return w.length ? Math.max(...w) : null;
};
const llv = (a, s, e) => {
  const w = a.slice(s, e).filter(Number.isFinite);
  return w.length ? Math.min(...w) : null;
};

/** 统一结果构造器 */
function R(id, name, family, hit, basis, invalid, spec, trace) {
  return {
    id, name, family, spec: spec || '',
    hit: hit === null ? null : !!hit,
    basis: basis || '',
    invalid: invalid || '条件不满足即不成立；形态失效以「跌破判据中最近的支撑 / 量能不再满足」为准',
    trace: trace || {}
  };
}

/** 每日 MA 序列（不足 n 根为 null） */
function maSeq(closes, n) {
  return closes.map((_, i) => i >= n - 1 ? r2(avg(closes, i - n + 1, i + 1)) : null);
}

/**
 * 主入口：evaluate(bars, ctx)
 * bars: [{date,open,close,high,low,volume,amount,pct}]（真实日线，时间升序）
 * ctx : { floatCap, turnover, events, buyback } 可缺省
 */
function evaluate(bars, ctx = {}) {
  if (!Array.isArray(bars) || bars.length < 25) {
    return { ok: false, note: '日线不足 25 根，形态判据不可得（不编造）', rules: [], hitCount: 0, unavailable: 0 };
  }
  const n = bars.length;
  const C = bars.map(b => b.close), O = bars.map(b => b.open), H = bars.map(b => b.high);
  const L = bars.map(b => b.low), V = bars.map(b => b.volume), P = bars.map(b => b.pct);
  const ma5 = maSeq(C, 5), ma13 = maSeq(C, 13), ma34 = maSeq(C, 34), ma55 = maSeq(C, 55);
  const ma120 = maSeq(C, 120), ma250 = maSeq(C, 250);
  const last = n - 1, b = bars[last];

  const bodyPct = i => O[i] > 0 ? Math.abs(C[i] - O[i]) / O[i] * 100 : null;
  const upperPct = i => C[i] > 0 ? (H[i] - Math.max(O[i], C[i])) / C[i] * 100 : null;
  const lowerPct = i => C[i] > 0 ? (Math.min(O[i], C[i]) - L[i]) / C[i] * 100 : null;
  const isYang = i => C[i] >= O[i];
  const isLimit = i => P[i] != null && P[i] >= 9.5;
  const volR = (i, back = 5) => {
    const prev = avg(V, Math.max(0, i - back), i);
    return prev > 0 ? r2(V[i] / prev) : null;
  };
  const maUp = (seq, i, back = 5) => seq[i] != null && seq[i - back] != null && seq[i] > seq[i - back];
  const bullStack = i => ma13[i] != null && ma34[i] != null && ma55[i] != null &&
    ma13[i] > ma34[i] && ma34[i] > ma55[i] && maUp(ma34, i, 5);
  const bias = (seq, i) => seq[i] > 0 ? r2((C[i] - seq[i]) / seq[i] * 100) : null;
  const prevHigh20 = hhv(H, Math.max(0, n - 21), last);
  const prevLow60 = llv(L, Math.max(0, n - 61), last);
  const maxVolHist = hhv(V, 0, n);
  const vLast = volR(last), vPrev = volR(last - 1);

  const out = [];
  const push = (...args) => out.push(R(...args));

  /* ---------------- A 追涨类（进攻是主动的） ---------------- */

  // 1 攻击临界点：颈线 = 前 20 日最高（唐奇安上轨）；突破幅度 <3% + 有效放量
  const breakNeck = prevHigh20 != null && H[last] > prevHigh20 &&
    (H[last] - prevHigh20) / prevHigh20 * 100 <= 3;
  push('attackNeckline', '攻击临界点（颈线/压力位）', '追涨',
    prevHigh20 != null ? (breakNeck && vLast != null && vLast >= 2) : null,
    prevHigh20 == null ? '前 20 日高点不可得' :
      '颈线（前20日高）' + r2(prevHigh20) + '，当日最高 ' + r2(H[last]) +
      '，突破幅度 ' + r2((H[last] - prevHigh20) / prevHigh20 * 100) + '%（≤3%），量比 ' + vLast + '（≥2 为有效放量）',
    '放量未持续、突破后回落至颈线下方，或突破幅度已 >3% 则形态失效',
    '追涨 #1 攻击临界点', { neck: r2(prevHigh20), todayHigh: r2(H[last]), volRatio: vLast });

  // 2 假阴线：前一日涨停 + 次日放量长上影小阴/十字
  const prevLimit = isLimit(last - 1);
  const smallBody = bodyPct(last) != null && bodyPct(last) <= 1.5;
  const longUpper = upperPct(last) != null && upperPct(last) >= 2.5;
  push('fakeYin', '假阴线（涨停后放量长上影十字）', '追涨',
    (P[last - 1] == null || V[last] == null) ? null :
      (prevLimit && !isYang(last) && smallBody && longUpper && vLast >= 1.5),
    '前日涨停=' + prevLimit + '，当日实体 ' + r2(bodyPct(last)) + '%、上影 ' + r2(upperPct(last)) +
      '%、涨跌幅 ' + r2(P[last]) + '%、量比 ' + vLast,
    '次日未继续放量上攻并跌破前一日涨停收盘价，则假阴线假设失效',
    '追涨 #2 假阴线', { prevPct: P[last - 1], bodyPct: r2(bodyPct(last)), upperPct: r2(upperPct(last)) });

  // 3 放量横盘：近 5 日窄幅 + 均量放大 + 靠近上行 MA13
  const w5 = bars.slice(-5);
  const band5 = llv(L, n - 5, n) > 0 ? r2((hhv(H, n - 5, n) - llv(L, n - 5, n)) / llv(L, n - 5, n) * 100) : null;
  const vol5 = avg(V, n - 5, n), volPrev5 = avg(V, n - 10, n - 5);
  const volExpand5 = volPrev5 > 0 ? r2(vol5 / volPrev5) : null;
  const nearMa13 = ma13[last] != null ? r2((C[last] - ma13[last]) / ma13[last] * 100) : null;
  push('volumePlateau', '放量横盘（颈线位厚积薄发）', '追涨',
    band5 == null || volExpand5 == null ? null :
      (band5 <= 8 && volExpand5 >= 1.5 && maUp(ma13, last) && Math.abs(nearMa13) <= 3),
    '近5日振幅 ' + band5 + '%（≤8%）、5日均量/前5日 ' + volExpand5 + '（≥1.5）、MA13 上行=' + maUp(ma13, last) +
      '、收盘偏离MA13 ' + nearMa13 + '%',
    '横盘向下放量跌破 MA13/MA34，则「吸筹」假设失效（原文亦以跌破 13/34/55 为出货判据）',
    '追涨 #3 放量横盘', { band5, volExpand5, nearMa13 });

  // 4 平量横盘：横盘期量能 ≈ 起涨最大阳线量（±20%）
  const startVol = hhv(V, Math.max(0, n - 15), n - 5);
  const flatVol = startVol > 0 && vol5 != null ? r2(vol5 / startVol) : null;
  push('flatVolumePlateau', '平量横盘（强势调整不缩量）', '追涨',
    flatVol == null ? null : (band5 != null && band5 <= 8 && flatVol >= 0.8 && flatVol <= 1.2 && maUp(ma13, last)),
    '横盘5日均量/起涨段最大量 ' + flatVol + '（0.8–1.2 为平量）、振幅 ' + band5 + '%、MA13 上行=' + maUp(ma13, last),
    '量能显著萎缩（<0.8）后跌破 MA13，则强势调整假设失效',
    '追涨 #4 平量横盘', { flatVol, band5 });

  // 5 追第三板：连续 3 个涨停且第三板未放巨量
  const three = last >= 2 && isLimit(last) && isLimit(last - 1) && isLimit(last - 2);
  push('thirdBoard', '三连板（惯性段）', '追涨',
    (P[last] == null || P[last - 2] == null) ? null : (three && vLast != null && vLast < 3),
    '近三日涨幅 ' + [P[last - 2], P[last - 1], P[last]].map(r2).join(' / ') +
      '，第三板量比 ' + vLast + '（<3 视为未放巨量）',
    '次日高开放巨量下跌 / 开板放天量（换手 >40%）即为主力出货，形态失效',
    '追涨 #5 追涨停板 / 注意篇 首板二板三板', { three, volRatio: vLast });

  /* ---------------- B 回采类（下跌是主动的） ---------------- */

  // 6 小阳放量滞涨：连续 3 根小实体放量 → 随后缩量回调
  const w3 = [last - 2, last - 1, last].filter(i => i >= 0);
  const stall = w3.length === 3 && w3.every(i => bodyPct(i) != null && bodyPct(i) <= 1.5) &&
    w3.every(i => { const x = volR(i); return x != null && x >= 1.5; });
  push('smallYangStall', '小阳放量滞涨（压力位前）', '回采',
    (V[last] == null || V[last - 2] == null) ? null : stall,
    '近3日实体 ' + w3.map(i => r2(bodyPct(i))).join(' / ') + '%，量比 ' + w3.map(i => volR(i)).join(' / '),
    '回调不缩量、或跌破颈线/均线支撑，则「蓄势」假设失效',
    '回采 #1 小阳放量滞涨', { bodies: w3.map(i => r2(bodyPct(i))), volRatios: w3.map(i => volR(i)) });

  // 7 多头形态急跌洗盘：13/34/55 多头 + 缩量回 MA13 + 放量长上影
  const washNear = ma13[last] != null ? r2((C[last] - ma13[last]) / ma13[last] * 100) : null;
  push('washPullback', '多头形态急跌洗盘（长上影）', '回采',
    ma13[last] == null ? null :
      (bullStack(last) && washNear != null && Math.abs(washNear) <= 2 && vLast != null && vLast >= 1.5 &&
        upperPct(last) != null && upperPct(last) >= 2.5),
    '13/34/55 多头排列=' + bullStack(last) + '，收盘偏离MA13 ' + washNear + '%，量比 ' + vLast + '，上影 ' + r2(upperPct(last)) + '%',
    '跌破 MA34 且 34/55 线走平或下行，则洗盘假设失效（转为趋势破坏）',
    '回采 #2 多头形态急跌', { bullStack: bullStack(last), nearMa13: washNear, upperPct: r2(upperPct(last)) });

  // 8 直破多头线：13/34/55 仍上行，跌破 MA13 且 BIAS13 ≤ -5%，接近 MA34
  const bias13 = bias(ma13, last);
  const nearMa34 = ma34[last] != null ? r2((C[last] - ma34[last]) / ma34[last] * 100) : null;
  push('breakMa13', '直破多头线（BIAS13 ≤ -5%）', '回采',
    bias13 == null || ma34[last] == null ? null :
      (maUp(ma34, last, 5) && maUp(ma55, last, 5) && bias13 <= -5 && nearMa34 != null && Math.abs(nearMa34) <= 3),
    'BIAS13 ' + bias13 + '%（≤-5%），MA34/MA55 仍上行=' + maUp(ma34, last, 5) + '/' + maUp(ma55, last, 5) +
      '，偏离MA34 ' + nearMa34 + '%',
    '13/34/55 任一转下行，或跌破 MA34 后未收回，则「双头」假设失效',
    '回采 #3 直破多头线', { bias13, nearMa34 });

  // 9 高位巨量换手：连续巨量阴线不破 MA13 + 跌幅递减 + 缩量阳包阴
  const yinSeq = [last - 2, last - 1].every(i => i >= 0 && !isYang(i) && volR(i) != null && volR(i) >= 2);
  const coverYang = isYang(last) && C[last] >= O[last - 1] && O[last] <= C[last - 1] && vLast != null && vLast < 1;
  push('highVolTurnover', '高位巨量下跌换手（阳包阴）', '回采',
    ma13[last] == null ? null : (yinSeq && coverYang && C[last - 1] >= ma13[last - 1] && maUp(ma13, last)),
    '前两日巨量阴线（量比 ' + volR(last - 2) + ' / ' + volR(last - 1) + '）且未破 MA13；当日缩量阳线覆盖=' + coverYang,
    '跌破 MA13/MA34 或阳线未能覆盖前一根阴线实体，则换手承接假设失效',
    '回采 #4 高位下跌巨量换手', { yinSeq, coverYang });

  // 10 同时突破几个技术位：MA20/MA60/前高/布林上轨聚集
  const ma20 = maSeq(C, 20), ma60 = maSeq(C, 60);
  const cluster = [ma20[last], ma60[last], prevHigh20].filter(Number.isFinite);
  const clusterSpread = cluster.length >= 2 ? r2((Math.max(...cluster) - Math.min(...cluster)) / C[last] * 100) : null;
  push('multiBreak', '同时突破多个技术位', '回采',
    clusterSpread == null ? null : (clusterSpread <= 3 && C[last] > Math.max(...cluster) && vLast != null && vLast >= 1.5),
    'MA20/MA60/前20日高聚集度 ' + clusterSpread + '%（≤3%）、收盘 ' + C[last] + ' 高于聚合区 ' + r2(Math.max(...cluster)) + '、量比 ' + vLast,
    '首次回调跌破该聚合区，则支撑失效',
    '回采 #5 同时突破几个技术位', { clusterSpread, levels: cluster.map(r2) });

  // 11 黄金分割：自中期低点连续上涨 ≥30% 后回调至 0.382/0.5/0.618
  const swingLow = llv(L, Math.max(0, n - 90), n);
  const swingHigh = hhv(H, Math.max(0, n - 90), n);
  const fib = (swingLow != null && swingHigh != null && swingLow > 0)
    ? { r382: r2(swingHigh - (swingHigh - swingLow) * 0.382), r50: r2(swingHigh - (swingHigh - swingLow) * 0.5), r618: r2(swingHigh - (swingHigh - swingLow) * 0.618) }
    : null;
  const swingUp = swingLow != null && swingHigh != null ? r2((swingHigh - swingLow) / swingLow * 100) : null;
  const inFib = fib ? [fib.r382, fib.r50, fib.r618].some(x => Math.abs(C[last] - x) / C[last] * 100 <= 2) : false;
  push('fibRetrace', '黄金分割回调（0.382 / 0.5 / 0.618）', '回采',
    fib == null ? null : (swingUp >= 30 && inFib && vLast != null && vLast < 1),
    '近90日低 ' + r2(swingLow) + ' → 高 ' + r2(swingHigh) + '（涨幅 ' + swingUp + '%≥30%）；回撤位 ' +
      fib.r382 + ' / ' + fib.r50 + ' / ' + fib.r618 + '，现价 ' + C[last] + '，缩量=' + (vLast < 1),
    '跌破 0.618 位且指标走弱，原文亦提示「可能创不了新高」',
    '回采 #6 黄金买点', { swingUp, fib, volRatio: vLast });

  // 12 攻颈线超前量：本次量超前几次攻颈线量但价未破
  const priorAttempts = [];
  for (let i = Math.max(0, n - 30); i < last - 1; i++) {
    const ph = hhv(H, Math.max(0, i - 20), i);
    if (ph != null && H[i] >= ph * 0.995) priorAttempts.push(V[i]);
  }
  const priorMax = priorAttempts.length ? Math.max(...priorAttempts) : null;
  push('necklineVolFront', '攻颈线超前量（量先行价未行）', '回采',
    priorMax == null || prevHigh20 == null ? null :
      (V[last] > priorMax * 1.2 && C[last] < prevHigh20),
    '本次量 ' + V[last] + ' > 前几次攻颈线最大量 ' + priorMax + '×1.2，收盘 ' + C[last] + ' 仍低于颈线 ' + r2(prevHigh20),
    '后续缩量回调不成立、或放量跌破颈线，则假设失效',
    '回采 #7 几次攻颈线位超前量', { priorAttempts: priorAttempts.length, priorMax });

  // 13 堆量上行通道：多头排列 + 3–8 日量能递减不破 MA5 + 下轨放量
  const last6 = bars.slice(-6);
  const volDesc = last6.slice(0, 5).every((x, i) => V[n - 6 + i + 1] <= V[n - 6 + i]);
  const noBreakMa5 = last6.every((x, i) => ma5[n - 6 + i] == null || x.close >= ma5[n - 6 + i]);
  push('volumeChannel', '堆量上行通道（下轨缩量 / 上轨放量）', '回采',
    ma13[last] == null ? null : (bullStack(last) && volDesc && noBreakMa5),
    '13/34/55 多头=' + bullStack(last) + '、近6日量能递减=' + volDesc + '、未破MA5=' + noBreakMa5,
    '放量跌破通道下轨（MA5/13/34/55）即视为上升行情结束；缩量突破上轨为诱多',
    '回采 #8 堆量上行通道', { volDesc, noBreakMa5 });

  // 14 跨越年线 / 半年线：低换手突破并站稳（long MA 单独判可得性）
  const hasLong = ma250[last] != null;
  const crossYear = ma250[last] != null && ma250[last - 1] != null &&
    C[last - 1] <= ma250[last - 1] && C[last] > ma250[last];
  const turnover = Number.isFinite(Number(ctx.turnover)) ? Number(ctx.turnover) : null;
  push('crossYearLine', '跨越年线（250 日线，低换手）', '回采',
    !hasLong ? null : (crossYear && (turnover == null || turnover <= 3)),
    !hasLong ? '日线不足 250 根，年线判据不可得（原文用 233 日线，系统按 A 股常用 250 日）'
      : '昨收 ' + C[last - 1] + ' ≤ 年线 ' + ma250[last - 1] + '，今收 ' + C[last] + ' > 年线 ' + ma250[last] +
        (turnover == null ? '；换手率不可得，未按 ≤3% 收紧' : '；换手率 ' + turnover + '%'),
    '回落跌破年线且 3 日未收回，则突破失效',
    '回采 #9 跨越年线', { ma250: ma250[last], turnover });

  // 15 MACD 穿越 0 轴后首次红柱缩短（DEA 上穿 + 双线仍在 0 上）
  //    用 stock-analysis 已算出的 macd 对象注入，避免此处重复实现
  const macd = ctx.macd || null;
  push('macdZeroAxis', 'MACD 穿 0 轴后首次回调', '回采',
    !macd || macd.dea == null ? null :
      (macd.dea > 0 && macd.dif > 0 && macd.hist != null && macd.hist <= 0),
    !macd || macd.dea == null ? 'MACD 数据不可得（未注入）'
      : 'DIF ' + macd.dif + ' / DEA ' + macd.dea + ' 均在 0 轴上方，柱 ' + macd.hist + '（缩短/转绿）',
    'DIF 或 DEA 跌破 0 轴，则「首次回调后推高」假设失效',
    '回采 #10 MACD 穿越 0 轴', { macd });

  // 16 穿越分水岭：长期在下行 MA55 之下，首次放量上破后回踩
  const belowMa55Long = ma55[last - 10] != null && last - 10 >= 0 &&
    bars.slice(last - 10, last).every((x, i) => ma55[last - 10 + i] == null || x.close < ma55[last - 10 + i]);
  const firstBreak55 = ma55[last] != null && ma55[last - 1] != null &&
    C[last - 1] <= ma55[last - 1] && C[last] > ma55[last];
  push('crossMa55', '穿越分水岭（55 日线）', '回采',
    ma55[last] == null ? null : (belowMa55Long && firstBreak55 && vLast != null && vLast >= 1.5),
    '前10日持续位于 MA55 下=' + belowMa55Long + '，当日放量上破=' + firstBreak55 + '，量比 ' + vLast,
    '回踩跌破 MA55 且未收回，则进入多方市场假设失效',
    '回采 #11 穿越分水岭', { belowMa55Long, firstBreak55, volRatio: vLast });

  // 17 十全十美：四条件同时成立
  const perfect = bullStack(last) && ma13[last] != null && Math.abs(bias(ma13, last)) <= 1 &&
    crossYear === false && (macd && macd.dea > 0) && band5 != null && band5 <= 8 && volExpand5 != null && volExpand5 >= 0.8;
  push('perfectTen', '十全十美（四条件叠加）', '回采',
    ma13[last] == null || !macd ? null : perfect,
    '13/34/55 平行上行=' + bullStack(last) + '、BIAS13 ' + bias(ma13, last) + '%、颈线放量滞涨=' + (band5 <= 8) +
      '、MACD DEA>0=' + (macd.dea > 0),
    '任一条件不再满足即失效；本项仅为多条件叠加标注，不包含「必涨」含义',
    '回采 #12 十全十美', { perfect });

  /* ---------------- C 启涨类（下跌是被动的） ---------------- */

  // 18 旱地拔葱：连续下跌/回调 >5 日后首根 ≥9% 大阳，前一日阴线、换手 ≤10%
  const down5 = last >= 6 && bars.slice(last - 6, last - 1).every(x => x.pct != null && x.pct < 0);
  const firstBigYang = P[last] != null && P[last] >= 9 && isYang(last) && !isYang(last - 1);
  push('dryLandOnion', '旱地拔葱（反转首根大阳）', '启涨',
    P[last] == null ? null : (down5 && firstBigYang && (turnover == null || turnover <= 10)),
    '前5日连续收跌=' + down5 + '，当日涨幅 ' + r2(P[last]) + '%、前一日阴线=' + !isYang(last - 1) +
      (turnover == null ? '；换手率不可得' : '；换手率 ' + turnover + '%'),
    '次日不能延续且跌破该大阳线实体下沿，反转假设失效',
    '启涨 #1 旱地拔葱', { down5, pct: r2(P[last]), turnover });

  // 19 空头承接覆盖：跌幅递减 + 量递增 → 最大量十字企稳 → 缩量阳包阴
  const decFall = P[last - 2] != null && P[last - 1] != null && P[last - 1] > P[last - 2] && P[last - 1] < 0;
  const incVol = V[last - 1] > V[last - 2];
  const crossStar = bodyPct(last - 1) != null && bodyPct(last - 1) <= 1;
  const cover = isYang(last) && C[last] >= O[last - 1] && vLast != null && vLast < 1;
  push('bearCover', '空头承接覆盖（缩量阳包阴）', '启涨',
    P[last - 2] == null ? null : (decFall && incVol && crossStar && cover),
    '跌幅递减=' + decFall + '、量递增=' + incVol + '、前日十字实体 ' + r2(bodyPct(last - 1)) + '%、当日缩量阳包阴=' + cover,
    '跌破最大量十字阴线最低点，则承接假设失效',
    '启涨 #2 空头承接覆盖', { decFall, incVol, crossStar, cover });

  // 20 扭转乾坤：阳线实体盖过最后一根阴线，量 ≥ 2 倍
  const reversal = isYang(last) && !isYang(last - 1) && C[last] >= O[last - 1] && O[last] <= C[last - 1];
  const volDouble = V[last - 1] > 0 ? r2(V[last] / V[last - 1]) : null;
  push('turnaround', '扭转乾坤（放量阳包阴）', '启涨',
    volDouble == null ? null : (reversal && volDouble >= 2),
    '阳线实体覆盖=' + reversal + '，量比前阴线 ' + volDouble + ' 倍（≥2）',
    '回落跌破反转阳线实体下沿，反转假设失效',
    '启涨 #3 扭转乾坤', { reversal, volDouble });

  /* ---------------- D 买跌类 ---------------- */

  // 21 空头强弩之末：BIAS13 ≤ -20%（原文「负乖离 -20%」）
  push('bearEnd', '空头强弩之末（BIAS13 ≤ -20%）', '买跌',
    bias13 == null ? null : (bias13 <= -20),
    'BIAS13 ' + bias13 + '%（≤-20%），近90日低 ' + r2(prevLow60),
    '继续放量下破且乖离未收敛，则反弹假设失效（原文亦强调「越跌越买」需配合资金管理）',
    '买跌 #1 空头强弩之末', { bias13 });

  /* ---------------- E 综合类 ---------------- */

  // 22 螳螂扑蝉黄雀在后：巨量涨停后次日光头阳线（无上影）
  const hugeLimit = isLimit(last - 1) && volR(last - 1) != null && volR(last - 1) >= 3;
  const baldYang = isYang(last) && upperPct(last) != null && upperPct(last) <= 0.15;
  const holdMa13 = ma13[last] != null && C[last] >= ma13[last];
  push('mantis', '螳螂扑蝉（巨量涨停后光头阳线）', '综合',
    P[last - 1] == null ? null : (hugeLimit && baldYang && holdMa13),
    '前日涨停且量比 ' + volR(last - 1) + '（≥3 巨量），当日光头阳线=' + baldYang + '、未破 MA13=' + holdMa13,
    '开板放天量下跌 / 换手 >40% 且后续跌破 MA13，视为无承接，形态失效',
    '综合类 螳螂扑蝉黄雀在后 / 一字板开板', { hugeLimit, baldYang, holdMa13 });

  /* ---------------- F 纪律类（个股级可计算项） ---------------- */

  // 23 三天不创新高（原文纪律 #4）
  const noNewHigh3 = hhv(H, n - 3, n) < hhv(H, n - 21, n - 3);
  push('noNewHigh3', '高位三天未创新高', '纪律',
    hhv(H, n - 21, n - 3) == null ? null : noNewHigh3,
    '近3日最高 ' + r2(hhv(H, n - 3, n)) + ' < 前20日最高 ' + r2(hhv(H, n - 21, n - 3)),
    '重新放量创出新高即解除该标注',
    '纪律篇 #4 三天不创新高减仓、五天清仓', {});

  // 24 放大量 / 巨量（原文纪律 #7、注解的量能分级）
  const volGrade = vLast == null ? null :
    vLast >= 3 ? '巨量' : vLast >= 2 ? '大量/放量' : vLast <= 0.7 ? '缩量' : '常量';
  push('volumeGrade', '量能分级（缩量/放量/巨量）', '纪律',
    vLast == null ? null : (vLast >= 2 || vLast <= 0.7),
    '当日量比 ' + vLast + ' → ' + volGrade + '（注解：缩量≤0.7、放量≥2、巨量≥3）',
    '分级为当日横截面事实，非方向判断',
    '注解 缩量/放量/大量/巨量/天量分级 + 纪律 #7', { volRatio: vLast, grade: volGrade });

  const rules = out;
  const hitCount = rules.filter(x => x.hit === true).length;
  const unavailable = rules.filter(x => x.hit === null).length;
  return {
    ok: true,
    bars: n,
    lastDate: b.date,
    ref: {
      ma13: ma13[last], ma34: ma34[last], ma55: ma55[last],
      ma120: ma120[last], ma250: ma250[last],
      bias13, prevHigh20: r2(prevHigh20), volRatio: vLast, volGrade
    },
    rules, hitCount, unavailable,
    note: '形态命中仅为技术条件标注，不含「必涨 / 买卖点」含义；原文买卖点已转为「触发依据 + 失效条件」。'
  };
}

/** 与市面通用量化指标的对照口径（供前端「评估口径」展示） */
const METHODOLOGY = [
  '颈线 / 压力位 = 唐奇安通道上轨（HHV 前 20 日高）与前高聚合区，突破幅度 ≤3% 对应「攻击临界点」。',
  '放量 / 缩量 / 巨量 = 量比 VR（当日量 / 前 5 日均量）分级，配合 OBV 思想用「量价背离」识别滞涨。',
  '乖离率 BIAS = (收盘 − MA13) / MA13，对应「直破多头线 -5%」「空头强弩之末 -20%」。',
  '多头排列 = MA13 > MA34 > MA55 且 MA34 上行，对应原文 13/34/55 平行 45° 上行。',
  '影线与实体 = 蜡烛形态（长上影十字、阳包阴 bullish engulfing、光头阳线），用 ATR 归一化思路按占收盘价百分比度量。',
  '黄金分割 = 近 90 日低点→高点做 0.382 / 0.5 / 0.618 斐波那契回撤，要求主升段 ≥30%。',
  'MACD 0 轴 = DIF/DEA 上穿 0 后首次柱缩短；均线分水岭 = MA55 首次上破回踩；年线 = MA250（原文 233 日按 A 股常用 250 日）。',
  '堆量上行通道 = 布林带 / 唐奇安通道下轨（MA5/13/34/55）与量能递减的组合判据。',
  '换手率用于「首板/二板/三板」「跨越年线」「巨量换手」的分级；数据不可得时该项标「不可得」，不编造。'
];

module.exports = { evaluate, METHODOLOGY };
