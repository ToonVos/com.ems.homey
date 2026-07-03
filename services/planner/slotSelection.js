'use strict';

/**
 * Pure slot-selectie voor de TeslaScheduler — GEEN homey-afhankelijkheid, zodat
 * deze kern unit-testbaar is (node --test) zonder een draaiende app of echte auto.
 * De TeslaScheduler delegeert hierheen; gedrag is 1-op-1 de eerdere klasse-methodes.
 *
 * Slots: [{ t: epoch-ms, import_eur: €/kWh }], aangenomen aaneengesloten in de tijd.
 */

/** Goedkoopste slots tot kwhNeeded gedekt is (excl. excludeSet). */
function pickCheapest(slots, kwhNeeded, slotKwh, excludeSet) {
  const set = new Set();
  let count = 0, acc = 0, lastTs = null;
  if (kwhNeeded <= 0 || slotKwh <= 0) return { set, count, lastTs };
  const sorted = slots
    .filter(s => !excludeSet || !excludeSet.has(s.t))
    .sort((a, b) => a.import_eur - b.import_eur);
  for (const s of sorted) {
    if (acc >= kwhNeeded) break;
    set.add(s.t); acc += slotKwh; count++;
  }
  if (set.size) lastTs = Math.max(...set);
  return { set, count, lastTs };
}

/**
 * Aaneengesloten-bewuste keuze die TOTALE kosten minimaliseert:
 *   kosten = Σ(energieprijs van gekozen slots) + n_sessies × C_session
 * Kandidaten: 1 blok, 2 disjuncte blokken (O(n·N) via prefix-minima), en de
 * losse-goedkoopste set met run-penalty (dekt 3+ dips). Zie TeslaScheduler d07/d10.
 */
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
  // k=1: één aaneengesloten blok van n slots
  for (let s = 0; s + n <= N; s++) {
    const c = winCost(s, n) + sessionEur;
    if (c < best.cost) best = { cost: c, idxs: Array.from({ length: n }, (_, k) => s + k) };
  }
  // k=2: twee disjuncte blokken — per lengte-verdeling O(N) via prefix-minimum van het
  // goedkoopste a-venster vóór het b-venster (a-links dekt alles omdat a over 1..n−1 loopt).
  for (let a = 1; a < n; a++) {
    const b = n - a;
    if (a > N || b > N) continue;
    const lastStartA = N - a;
    const bestUpto = new Array(lastStartA + 1);
    let bi = 0;
    for (let s2 = 0; s2 <= lastStartA; s2++) {
      if (winCost(s2, a) < winCost(bi, a)) bi = s2;
      bestUpto[s2] = bi;
    }
    for (let sb = a; sb + b <= N; sb++) {
      const sa = bestUpto[sb - a];
      const c = winCost(sa, a) + winCost(sb, b) + 2 * sessionEur;
      if (c < best.cost) {
        const idxs = [];
        for (let k = 0; k < a; k++) idxs.push(sa + k);
        for (let k = 0; k < b; k++) idxs.push(sb + k);
        best = { cost: c, idxs };
      }
    }
  }
  // losse goedkoopste n slots, met run-penalty (dekt 3+ dips als dat goedkoper is)
  {
    const order = avail.map((s, i) => ({ i, p: price[i] })).sort((x, y) => x.p - y.p).slice(0, n).map(o => o.i);
    const c = order.reduce((acc, i) => acc + price[i] * slotKwh, 0) + runsOf(order) * sessionEur;
    if (c < best.cost) best = { cost: c, idxs: order };
  }

  best.idxs.forEach(i => set.add(avail[i].t));
  count = set.size; lastTs = set.size ? Math.max(...set) : null;
  return { set, count, lastTs };
}

module.exports = { pickCheapest, pickContiguousOptimal };
