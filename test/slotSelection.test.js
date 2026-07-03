'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { pickCheapest, pickContiguousOptimal } = require('../services/planner/slotSelection');

const SLOT_MS = 15 * 60 * 1000;
const mkSlots = (prices, t0 = 1_750_000_000_000) =>
  prices.map((p, i) => ({ t: t0 + i * SLOT_MS, import_eur: p }));

test('pickCheapest: kiest de goedkoopste slots tot kwhNeeded gedekt is', () => {
  const slots = mkSlots([0.30, 0.10, 0.20, 0.05]);
  const r = pickCheapest(slots, 1.6, 0.8625, null);   // 2 slots nodig
  assert.strictEqual(r.count, 2);
  assert.ok(r.set.has(slots[3].t) && r.set.has(slots[1].t));
});

test('pickCheapest: kwhNeeded<=0 of slotKwh<=0 → leeg', () => {
  assert.strictEqual(pickCheapest(mkSlots([0.1]), 0, 0.8, null).count, 0);
  assert.strictEqual(pickCheapest(mkSlots([0.1]), 1, 0, null).count, 0);
});

test('pickCheapest: respecteert excludeSet', () => {
  const slots = mkSlots([0.10, 0.20]);
  const r = pickCheapest(slots, 0.5, 0.8625, new Set([slots[0].t]));
  assert.ok(!r.set.has(slots[0].t) && r.set.has(slots[1].t));
});

test('contiguous: aangrenzende goedkope slots → één blok (geen split om centen)', () => {
  // dip-duur-dip waarbij het prijsverschil kleiner is dan C_session → doorladen
  const slots = mkSlots([0.10, 0.11, 0.10, 0.30, 0.30, 0.30]);
  const r = pickContiguousOptimal(slots, 2.5, 0.8625, null, 0.10);   // 3 slots
  assert.strictEqual(r.count, 3);
  assert.deepStrictEqual([...r.set].sort(), [slots[0].t, slots[1].t, slots[2].t].sort());
});

test('contiguous: splitst wél als de besparing > C_session', () => {
  // twee diepe dips met een duur blok ertussen; besparing ≫ sessie-kost
  const slots = mkSlots([0.05, 0.05, 0.50, 0.50, 0.05, 0.05]);
  const r = pickContiguousOptimal(slots, 3.4, 0.8625, null, 0.10);   // 4 slots
  assert.strictEqual(r.count, 4);
  assert.ok(!r.set.has(slots[2].t) && !r.set.has(slots[3].t));
});

test('contiguous: n >= N → alle beschikbare slots', () => {
  const slots = mkSlots([0.1, 0.2]);
  const r = pickContiguousOptimal(slots, 10, 0.8625, null, 0.10);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.lastTs, slots[1].t);
});

test('contiguous: excludeSet wordt niet gekozen', () => {
  const slots = mkSlots([0.05, 0.10, 0.10, 0.10]);
  const r = pickContiguousOptimal(slots, 1.6, 0.8625, new Set([slots[0].t]), 0.10);
  assert.ok(!r.set.has(slots[0].t));
  assert.strictEqual(r.count, 2);
});

test('contiguous: prefix-minimum k=2 equivalent aan brute-force (property-based)', () => {
  // referentie: naïeve O(N²) brute-force over 1-blok, 2-blok en losse-set kandidaten
  const brute = (slots, kwhNeeded, slotKwh, sessionEur) => {
    const avail = [...slots].sort((a, b) => a.t - b.t);
    const N = avail.length;
    const n = Math.min(N, Math.ceil(kwhNeeded / slotKwh));
    const price = avail.map(s => s.import_eur);
    const pre = [0]; for (let i = 0; i < N; i++) pre.push(pre[i] + price[i]);
    const winCost = (s, len) => (pre[s + len] - pre[s]) * slotKwh;
    let best = Infinity;
    for (let s = 0; s + n <= N; s++) best = Math.min(best, winCost(s, n) + sessionEur);
    for (let a = 1; a < n; a++) {
      const b = n - a;
      for (let sa = 0; sa + a <= N; sa++)
        for (let sb = 0; sb + b <= N; sb++)
          if (sb + b <= sa || sb >= sa + a)
            best = Math.min(best, winCost(sa, a) + winCost(sb, b) + 2 * sessionEur);
    }
    const order = price.map((p, i) => ({ i, p })).sort((x, y) => x.p - y.p).slice(0, n).map(o => o.i);
    const runs = (() => { const a = [...order].sort((x, y) => x - y); let r = 0; for (let i = 0; i < a.length; i++) if (i === 0 || a[i] !== a[i - 1] + 1) r++; return r; })();
    best = Math.min(best, order.reduce((acc, i) => acc + price[i] * slotKwh, 0) + runs * sessionEur);
    return best;
  };
  const cost = (slots, r, slotKwh, sessionEur) => {
    const chosen = slots.filter(s => r.set.has(s.t)).sort((a, b) => a.t - b.t);
    let runs = 0;
    for (let i = 0; i < chosen.length; i++) if (i === 0 || chosen[i].t !== chosen[i - 1].t + SLOT_MS) runs++;
    return chosen.reduce((acc, s) => acc + s.import_eur * slotKwh, 0) + runs * sessionEur;
  };
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  for (let trial = 0; trial < 100; trial++) {
    const N = 5 + Math.floor(rnd() * 40);
    const prices = Array.from({ length: N }, () => +(rnd() * 0.4 - 0.05).toFixed(4));
    const slots = mkSlots(prices);
    const n = 2 + Math.floor(rnd() * (N - 2));
    const kwh = n * 0.8625 - 0.01;
    const r = pickContiguousOptimal(slots, kwh, 0.8625, null, 0.10);
    const got = cost(slots, r, 0.8625, 0.10);
    const want = brute(slots, kwh, 0.8625, 0.10);
    assert.ok(Math.abs(got - want) < 1e-9, `trial ${trial}: got ${got}, brute ${want}`);
  }
});

test('contiguous: is snel op realistische maat (672 slots, 200 nodig)', () => {
  const prices = Array.from({ length: 672 }, (_, i) => 0.10 + 0.15 * Math.abs(Math.sin(i / 7)));
  const slots = mkSlots(prices);
  const t0 = Date.now();
  pickContiguousOptimal(slots, 200 * 0.8625, 0.8625, null, 0.10);
  const ms = Date.now() - t0;
  assert.ok(ms < 500, `duurde ${ms}ms — event-loop-blokkade-risico`);
});
