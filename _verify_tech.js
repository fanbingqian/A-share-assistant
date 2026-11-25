'use strict';
/* P0 技术因子单元验算：构造已知日线 → 手算期望值 → 逐条断言 */
const assert = require('assert');
const fs = require('fs');
const t = require('./server/technical.js');

let pass = 0, fail = 0;
function ck(name, got, exp, tol) {
  const ok = tol != null ? (Number.isFinite(got) && Math.abs(got - exp) <= tol) : got === exp;
  if (ok) { pass++; console.log('  PASS ' + name + ' = ' + got); }
  else { fail++; console.log('  FAIL ' + name + ' got=' + got + ' exp=' + exp); }
}

console.log('=== 1. normalizeBars（字段与 pct 推算） ===');
const b = t.normalizeBars([
  { d: '2026-01-01', o: 10, c: 10, h: 10.5, l: 9.5, v: 100, a: 1000 },
  { d: '2026-01-02', o: 10, c: 11, h: 11.5, l: 9.8, v: 120, a: 1300 },
  { d: '2026-01-03', o: 11, c: 9.9, h: 11.2, l: 9.7, v: 90, a: 900 }
]);
ck('bars len', b.length, 3);
ck('pct[1] = (11-10)/10*100', b[1].pct, 10);
ck('pct[2] = (9.9-11)/11*100', b[2].pct, -10);
ck('high 保留', b[0].high, 10.5);
ck('非法行(c<=0)被过滤', t.normalizeBars([{ d: 'x', o: 1, c: 0, h: 1, l: 1, v: 1, a: 1 }]).length, 0);

console.log('=== 2. maSeries ===');
const flat = Array.from({ length: 30 }, (_, i) => ({ date: 'd' + i, open: 10, close: 10, high: 10.2, low: 9.8, volume: 100, amount: 1000, pct: 0 }));
const m = t.maSeries(flat, 5);
ck('恒定序列 ma5[4]', m[4], 10);
ck('恒定序列 ma5[29]', m[29], 10);
ck('不足 5 根为 null', m[3], null);
const ramp = Array.from({ length: 5 }, (_, i) => ({ date: 'd' + i, open: 1 + i, close: 1 + i, high: 1 + i, low: 1 + i, volume: 1, amount: 1, pct: null }));
ck('1..5 的 ma5 = 3', t.maSeries(ramp, 5)[4], 3);

console.log('=== 3. KDJ(9,3,3) 手算校验 ===');
// 恒定 high=11 / low=9 / close=10 → 任意 9 根窗口 RSV=(10-9)/(11-9)*100=50 恒定 → K=D=J=50
// 注意：若让 high/low 随 i 递增，窗口最低价会取到 9 根前的值，RSV 会变成 90（易错点）。
const k50 = Array.from({ length: 30 }, (_, i) => ({ date: 'd' + i, open: 10, close: 10, high: 11, low: 9, volume: 100, amount: 1000, pct: null }));
const kA = t.kdj(k50);
ck('RSV=50 → K', kA.last.k, 50, 1e-6);
ck('RSV=50 → D', kA.last.d, 50, 1e-6);
ck('RSV=50 → J', kA.last.j, 50, 1e-6);
ck('RSV=50 → 无交叉', kA.cross, 'none');
// 恒定 close=high=10, low=9 → RSV=100 → 首值 K=66.6667 D=55.5556 J=88.8889
const k100 = Array.from({ length: 30 }, (_, i) => ({ date: 'd' + i, open: 10, close: 10, high: 10, low: 9, volume: 100, amount: 1000, pct: null }));
const kB = t.kdj(k100);
ck('RSV=100 → 首值 K', kB.series[8].k, 66.6667, 0.001);
ck('RSV=100 → 首值 D', kB.series[8].d, 55.5556, 0.001);
ck('RSV=100 → 首值 J', kB.series[8].j, 88.8889, 0.001);
ck('RSV=100 → 末值 K 收敛 100', kB.last.k, 100, 0.05);
// 金叉：先 RSV=0 压低 K/D，最后一根 RSV=100 拉升 → K 上穿 D
const kCross = Array.from({ length: 30 }, (_, i) => {
  const hi = i < 29 ? 20 : 30;
  const lo = i < 29 ? 10 : 10;
  const c = i < 29 ? 10 : 30;   // 前段 RSV=0，末段 RSV=100
  return { date: 'd' + i, open: c, close: c, high: hi, low: lo, volume: 100, amount: 1000, pct: null };
});
console.log('   金叉用例 cross =', t.kdj(kCross).cross, '(应 gold)');
ck('K 上穿 D → 金叉', t.kdj(kCross).cross, 'gold');

console.log('=== 4. computeFactors：连续两日破 MA5 ===');
const down = Array.from({ length: 30 }, (_, i) => ({ date: 'd' + i, open: 10, close: 10, high: 10.2, low: 9.8, volume: 100, amount: 1000, pct: 0 }));
down[28] = { date: 'd28', open: 10, close: 8, high: 10.2, low: 7.8, volume: 100, amount: 1000, pct: -20 };
down[29] = { date: 'd29', open: 8.5, close: 8, high: 8.6, low: 7.8, volume: 100, amount: 1000, pct: 0 };
const cf = t.computeFactors(down, { breadth: null, floatCap: 1e9, industry: 'X', industryStats: {} });
const f2 = cf.factors.find(f => f.key === 'breakMa5Two');
ck('连续两日破 MA5 命中', f2.hit, true);
console.log('    value =', JSON.stringify(f2.value));

console.log('=== 5. 不可得项显式标注（反幻觉） ===');
ck('无 breadth → 抗压 hit=null', cf.factors.find(f => f.key === 'resilience').hit, null);
ck('行业样本 n<2 → 市值分位 hit=null', cf.factors.find(f => f.key === 'capPercentile').hit, null);
console.log('    市值分位 note =', cf.factors.find(f => f.key === 'capPercentile').note);

console.log('=== 6. 复盘触发规则（只读） ===');
ck('规则条数', cf.rules.length, 6);
ck('trendEnd 随破 MA5 命中', cf.rules.find(r => r.id === 'trendEnd').hit, true);

(async () => {
  console.log('=== 7. 真实日线交叉校验（联网，失败不阻断） ===');
  try {
    const ic = require('./server/ic.js');
    const raw = await Promise.race([
      ic.fetchKline('002418', 80),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))
    ]);
    const bars = t.normalizeBars(raw);
    const myMa5 = t.maSeries(bars, 5).slice(-1)[0];
    const st = JSON.parse(fs.readFileSync('./data/stocks-cache.json', 'utf8'));
    const ref = (st.items.find(x => x.code === '002418') || {}).indicators;
    console.log('    日线根数 =', bars.length, '| 末日 =', bars.length ? bars[bars.length - 1].date : '-');
    console.log('    本模块 ma5 =', myMa5, '| stocks-cache indicators.ma5 =', ref && ref.ma5);
    if (ref && ref.ma5 != null && myMa5 != null) {
      console.log('    偏差 =', Math.abs(myMa5 - ref.ma5).toFixed(4), '（同为前复权口径，应接近；差异来自快照时点）');
    }
  } catch (e) { console.log('    SKIP:', e.message); }
  console.log('');
  console.log('========== PASS=' + pass + '  FAIL=' + fail + ' ==========');
  process.exit(fail ? 1 : 0);
})();
