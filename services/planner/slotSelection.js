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

/** Kleinste positieve tijdstap tussen opeenvolgende slots (= slot-duur). */
function inferStepMs(sorted) {
  let step = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i].t - sorted[i - 1].t;
    if (d > 0 && d < step) step = d;
  }
  return isFinite(step) ? step : 15 * 60_000;
}

/**
 * Aaneengesloten-bewuste keuze die TOTALE kosten minimaliseert:
 *   kosten = Σ(energieprijs van gekozen slots) + n_sessies × C_session
 *
 * Contiguïteit wordt op de KLOK bepaald, niet op array-index. Dat is wezenlijk zodra
 * `excludeSet` gevuld is (de opportunistische pas krijgt de al geplande slots mee):
 *   - slots met een reeds gepland blok ertussen zijn NIET aaneengesloten, ook al staan
 *     ze na het wegfilteren naast elkaar in de array;
 *   - een run die direct tégen een reeds gepland slot aan ligt is fysiek dezelfde
 *     laadsessie en kost dus GEEN tweede wake/C_session.
 * Zonder dat onderscheid werd opportunistisch laden naast de geplande uren onterecht
 * beboet en vielen er gaten midden in een blok.
 *
 * Kandidaten: 1 blok, 2 disjuncte blokken (O(n·N) via prefix-minima), en de
 * losse-goedkoopste set. Elke kandidaat wordt exact nagerekend met `costOf`.
 * Zie TeslaScheduler d07/d10.
 */
function pickContiguousOptimal(slots, kwhNeeded, slotKwh, excludeSet, sessionEur, opts = {}) {
  const set = new Set(); let count = 0, lastTs = null;
  if (kwhNeeded <= 0 || slotKwh <= 0) return { set, count, lastTs };

  const all = [...slots].sort((a, b) => a.t - b.t);
  const stepMs = opts.stepMs || inferStepMs(all);
  const avail = all.filter(s => !excludeSet || !excludeSet.has(s.t));
  const N = avail.length;
  const n = Math.min(N, Math.ceil(kwhNeeded / slotKwh));
  if (n <= 0) return { set, count, lastTs };
  if (n >= N) { avail.forEach(s => set.add(s.t)); return { set, count: N, lastTs: avail[N - 1].t }; }

  const price = avail.map(s => s.import_eur ?? 0);
  const time  = avail.map(s => s.t);
  const pre = [0];
  for (let i = 0; i < N; i++) pre.push(pre[i] + price[i]);

  // Ligt op tijdstip t een reeds gepland (uitgesloten) slot? Zo ja, dan is een run die
  // daar tegenaan ligt dezelfde laadsessie → geen extra C_session.
  const excluded = new Set();
  if (excludeSet) for (const s of all) if (excludeSet.has(s.t)) excluded.add(s.t);
  const touchesPlanned = (startIdx, endIdx) =>
    excluded.has(time[startIdx] - stepMs) || excluded.has(time[endIdx] + stepMs);

  // Aaneengesloten in tijd? (index i en i+1 volgen elkaar exact op)
  const contiguous = i => i + 1 < N && time[i + 1] - time[i] === stepMs;

  /** Exacte kosten van een keuze (indices in `avail`): energie + sessies. */
  const costOf = (idxs) => {
    const a = [...idxs].sort((x, y) => x - y);
    let energy = 0, sessions = 0;
    for (let i = 0; i < a.length; i++) {
      energy += price[a[i]] * slotKwh;
      const runStart = i === 0 || !(a[i - 1] === a[i] - 1 && contiguous(a[i] - 1));
      if (!runStart) continue;
      // Zoek het einde van deze run om beide randen op aansluiting te toetsen.
      let j = i;
      while (j + 1 < a.length && a[j + 1] === a[j] + 1 && contiguous(a[j])) j++;
      if (!touchesPlanned(a[i], a[j])) sessions++;
    }
    return energy + sessions * sessionEur;
  };

  // Maximale tijd-aaneengesloten segmenten van `avail`, één keer bepaald. Een venster
  // mag nooit over een tijdsprong heen lopen (bv. over een reeds gepland blok).
  const segments = [];
  {
    let lo = 0;
    for (let i = 0; i < N; i++) {
      if (!contiguous(i)) { segments.push([lo, i]); lo = i + 1; }
    }
  }
  /** Startindices van elk time-contiguous venster van lengte L. */
  const windowsOfLength = (L) => {
    const out = [];
    for (const [lo, hi] of segments) for (let s = lo; s + L - 1 <= hi; s++) out.push(s);
    return out;
  };
  const winCost = (s, len) => (pre[s + len] - pre[s]) * slotKwh;
  // Kosten van één venster incl. sessie: sluit het aan op reeds geplande uren, dan is
  // het dezelfde laadsessie en vervalt C_session.
  const winTotal = (s, len) => winCost(s, len) + (touchesPlanned(s, s + len - 1) ? 0 : sessionEur);
  const idxRange = (s, len) => Array.from({ length: len }, (_, k) => s + k);

  // Kandidaten worden als compacte beschrijving bewaard (niet als index-array): bij
  // n=200 en honderdduizenden k=2-kandidaten is per stuk een array bouwen de dominante
  // kostenpost. Alleen de winnaar wordt aan het eind uitgeschreven.
  let best = { cost: Infinity, blocks: null, idxs: null };
  const consider = (cost, blocks, idxs) => {
    if (cost < best.cost) best = { cost, blocks: blocks || null, idxs: idxs || null };
  };

  // k=1: één aaneengesloten blok van n slots
  for (const [lo, hi] of segments) {
    for (let s = lo; s + n - 1 <= hi; s++) consider(winTotal(s, n), [[s, n]]);
  }

  // k=2: twee disjuncte blokken, via prefix-minimum over de vensterkosten. Sluiten de
  // twee blokken in de tijd op elkaar aan, dan zijn ze samen één run → één C_session.
  for (let a = 1; a < n; a++) {
    const b = n - a;
    const wa = windowsOfLength(a);
    if (!wa.length) continue;
    let ai = 0, bestA = null;
    for (const [lo, hi] of segments) {
      for (let sb = lo; sb + b - 1 <= hi; sb++) {
        while (ai < wa.length && wa[ai] + a <= sb) {         // a-venster eindigt vóór b
          if (bestA === null || winTotal(wa[ai], a) < winTotal(bestA, a)) bestA = wa[ai];
          ai++;
        }
        if (bestA === null) continue;
        const merges = time[sb] - time[bestA + a - 1] === stepMs;
        const cost = merges
          ? winCost(bestA, a) + winCost(sb, b)
            + (touchesPlanned(bestA, sb + b - 1) ? 0 : sessionEur)
          : winTotal(bestA, a) + winTotal(sb, b);
        consider(cost, [[bestA, a], [sb, b]]);
      }
    }
  }

  // losse goedkoopste n slots (dekt 3+ dips als dat goedkoper is)
  {
    const order = avail.map((s, i) => ({ i, p: price[i] })).sort((x, y) => x.p - y.p).slice(0, n).map(o => o.i);
    consider(costOf(order), null, order);
  }

  if (!best.idxs) {
    best.idxs = [];
    for (const [s, len] of best.blocks) best.idxs.push(...idxRange(s, len));
  }

  best.idxs.forEach(i => set.add(avail[i].t));
  count = set.size; lastTs = set.size ? Math.max(...set) : null;
  return { set, count, lastTs };
}

module.exports = { pickCheapest, pickContiguousOptimal };
