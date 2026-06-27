'use strict';
// Verificatie van de d10-refactor: _pickContiguousOptimal (ongewijzigd, puur) op
// een effectieve horizon (stroom + aging-premie). Replica van de premie-wiring uit
// TeslaScheduler.js zodat we het gedrag los kunnen asserten.

// ── _pickContiguousOptimal: exacte kopie uit TeslaScheduler.js (puur, geen `this`) ──
function pickContiguousOptimal(slots, kwhNeeded, slotKwh, excludeSet, sessionEur) {
  const set = new Set(); let count = 0, lastTs = null;
  if (kwhNeeded <= 0 || slotKwh <= 0) return { set, count, lastTs };
  const avail = slots.filter(s => !excludeSet || !excludeSet.has(s.t)).sort((a, b) => a.t - b.t);
  const N = avail.length;
  const n = Math.min(N, Math.ceil(kwhNeeded / slotKwh));
  if (n <= 0) return { set, count, lastTs };
  if (n >= N) { avail.forEach(s => set.add(s.t)); return { set, count: N, lastTs: avail[N - 1].t }; }
  const price = avail.map(s => s.import_eur ?? 0);
  const pre = [0];
  for (let i = 0; i < N; i++) pre.push(pre[i] + price[i]);
  const winCost = (s, len) => (pre[s + len] - pre[s]) * slotKwh;
  const runsOf = (idxs) => { const a = [...idxs].sort((x, y) => x - y); let r = 0; for (let i = 0; i < a.length; i++) if (i === 0 || a[i] !== a[i - 1] + 1) r++; return r; };
  let best = { cost: Infinity, idxs: null };
  for (let s = 0; s + n <= N; s++) { const c = winCost(s, n) + sessionEur; if (c < best.cost) best = { cost: c, idxs: Array.from({ length: n }, (_, k) => s + k) }; }
  for (let a = 1; a < n; a++) { const b = n - a; for (let sa = 0; sa + a <= N; sa++) for (let sb = 0; sb + b <= N; sb++) if (sb + b <= sa || sb >= sa + a) { const c = winCost(sa, a) + winCost(sb, b) + 2 * sessionEur; if (c < best.cost) { const idxs = []; for (let k = 0; k < a; k++) idxs.push(sa + k); for (let k = 0; k < b; k++) idxs.push(sb + k); best = { cost: c, idxs }; } } }
  { const order = avail.map((s, i) => ({ i, p: price[i] })).sort((x, y) => x.p - y.p).slice(0, n).map(o => o.i); const c = order.reduce((acc, i) => acc + price[i] * slotKwh, 0) + runsOf(order) * sessionEur; if (c < best.cost) best = { cost: c, idxs: order }; }
  best.idxs.forEach(i => set.add(avail[i].t));
  return { set, count: set.size, lastTs: Math.max(...set) };
}

// ── premie-wiring uit de refactor ──
const SLOT_MS = 15 * 60_000, slotKwh = 2.95, sessionEur = 0.10, agingRate = 0.027;
function plan(prices, soc, mandatory, cap = 75, eff = 0.91) {
  const now = 0;
  const horizon = prices.map((p, i) => ({ t: now + i * SLOT_MS, import_eur: p }));
  const dlMs = horizon[horizon.length - 1].t + SLOT_MS;
  const bandKwh = (lo, hi) => { const f = Math.max(soc, lo), t = Math.min(mandatory, hi); return t > f ? (t - f) / 100 * cap / eff : 0; };
  const HOLD = 80;
  const needTotKwh = bandKwh(0, 100), highKwh = bandKwh(HOLD, 100);
  const fHigh = needTotKwh > 0 ? highKwh / needTotKwh : 0;
  const heightMid = Math.max(0, (Math.min(mandatory, 100) + HOLD) / 2 - HOLD);
  const agingOn = fHigh > 0 && heightMid > 0;
  const premPerKwh = (t) => agingOn ? fHigh * (heightMid / 10) * agingRate * Math.max(0, (dlMs - t) / 3_600_000) / slotKwh : 0;
  const eff2 = horizon.map(h => ({ ...h, import_eur: h.import_eur + premPerKwh(h.t) }));
  const r = pickContiguousOptimal(eff2, needTotKwh, slotKwh, new Set(), sessionEur);
  return [...r.set].map(t => Math.round(t / SLOT_MS)).sort((a, b) => a - b);
}

let pass = 0, fail = 0;
function assert(name, cond, extra = '') { if (cond) { pass++; console.log(`✓ ${name}`); } else { fail++; console.log(`✗ ${name}  ${extra}`); } }

// T1: gelijke prijs overal → aaneengesloten blok (wake-discipline via C_session).
// 8 slots gelijk, behoefte ~4 slots. Verwacht: 4 aaneensluitende indices.
{
  const idx = plan(new Array(8).fill(0.20), 80, 90);  // 10% van 75kWh/.91 ≈ 8.24kWh ≈ 3 slots
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  assert('T1 gelijke prijs → aaneengesloten', contiguous, `idx=${idx}`);
}

// T2: aging-premie duwt hoge band richting deadline. Vlakke prijs, doel 95% vanaf 80%.
// Zonder premie zou de keuze prijs-indifferent vroeg kunnen vallen; mét premie moet het
// blok tegen de deadline (laatste slots) liggen.
{
  const idx = plan(new Array(12).fill(0.20), 80, 95);
  const lastSlot = 11;
  assert('T2 aging duwt naar deadline', Math.max(...idx) === lastSlot, `idx=${idx}`);
}

// T3: doel ≤80% → géén premie (fHigh=0). Vlakke prijs → pure cheapest/aaneengesloten,
// niet naar deadline geforceerd (mag overal). Check: premie-term is 0 dus het blok hoeft
// niet tegen de deadline te liggen → met een goedkope dip vooraan kiest hij die.
{
  const prices = [0.10, 0.10, 0.30, 0.30, 0.30, 0.30, 0.30, 0.30]; // dip vooraan
  const idx = plan(prices, 70, 78);  // doel 78 < 80 → geen aging
  assert('T3 doel<80 geen premie → kiest goedkope dip vooraan', idx[0] === 0, `idx=${idx}`);
}

// T4: echte prijs-tradeoff — premie mag NIET een veel goedkoper vroeg blok overrulen.
// Goedkoop nu (0.15), duur later (0.30). Premie ~centen mag de 15ct-besparing niet wissen.
{
  const prices = [0.15, 0.15, 0.15, 0.30, 0.30, 0.30, 0.30, 0.30];
  const idx = plan(prices, 80, 85);  // kleine hoge band
  assert('T4 premie overruled grote prijskloof niet', idx[0] <= 2, `idx=${idx}`);
}

// T5: prijs-granulariteit 'hourly' → elk uur (4 kwartieren) gemiddeld tot één prijs.
{
  const HOUR = 3_600_000;
  const applyGranularity = (horizon, mode) => {
    if (mode !== 'hourly') return horizon;
    const byHour = new Map();
    for (const s of horizon) { const hs = Math.floor(s.t / HOUR) * HOUR; if (!byHour.has(hs)) byHour.set(hs, []); byHour.get(hs).push(s); }
    for (const g of byHour.values()) { const v = g.map(s => s.import_eur).filter(x => x != null); if (!v.length) continue; const a = v.reduce((x, y) => x + y, 0) / v.length; g.forEach(s => { s.import_eur = a; }); }
    return horizon;
  };
  const h = [0,1,2,3,4,5,6,7].map(i => ({ t: i * 15 * 60_000, import_eur: [0.10,0.20,0.30,0.40, 0.05,0.05,0.05,0.15][i] }));
  applyGranularity(h, 'hourly');
  const hour1 = h.slice(0,4).map(s => s.import_eur);   // verwacht 0.25 ×4 (gem 0.10..0.40)
  const hour2 = h.slice(4,8).map(s => s.import_eur);   // verwacht 0.075 ×4
  assert('T5 hourly middelt per uur', hour1.every(x => Math.abs(x-0.25)<1e-9) && hour2.every(x => Math.abs(x-0.075)<1e-9), `h1=${hour1} h2=${hour2}`);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
