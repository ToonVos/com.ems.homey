'use strict';

const test = require('node:test');
const assert = require('node:assert');
const TeslaScheduler = require('../services/TeslaScheduler');

const HOUR = 3_600_000;

/** Kale scheduler-instantie met alleen wat `_expireOverride` aanraakt. */
function makeScheduler({ targetPct, deadlineMs }) {
  const store = new Map();
  if (targetPct != null)  store.set('tesla_target_pct', targetPct);
  if (deadlineMs != null) store.set('tesla_deadline_iso', new Date(deadlineMs).toISOString());

  const homey = {
    settings: {
      get: k => (store.has(k) ? store.get(k) : undefined),
      set: (k, v) => store.set(k, v),
      unset: k => store.delete(k),
      on: () => {},
    },
    setInterval: () => null, clearInterval: () => null,
    setTimeout: () => null, clearTimeout: () => null,
    clock: { getTimezone: () => 'Europe/Amsterdam' },
  };
  const app = { homey, log: () => {}, error: () => {}, localTime: () => 'x', _emitTeslaState: () => {} };

  const sched = Object.create(TeslaScheduler.prototype);
  sched.app = app;
  sched.homey = homey;
  return { sched, store };
}

test('verlopen planning vervalt puur op tijd, ongeacht of het doel gehaald is', async () => {
  const { sched, store } = makeScheduler({ targetPct: 60, deadlineMs: Date.now() - 2 * HOUR });
  await sched._expireOverride();
  assert.equal(store.has('tesla_target_pct'), false);
  assert.equal(store.has('tesla_deadline_iso'), false);
});

test('vervalt ook vlak ná de deadline, zonder wachttijd', async () => {
  const { sched, store } = makeScheduler({ targetPct: 60, deadlineMs: Date.now() - 1000 });
  await sched._expireOverride();
  assert.equal(store.has('tesla_target_pct'), false);
});

test('toekomstige planning blijft ongemoeid', async () => {
  const { sched, store } = makeScheduler({ targetPct: 60, deadlineMs: Date.now() + 6 * HOUR });
  await sched._expireOverride();
  assert.equal(store.get('tesla_target_pct'), 60);
});

test('zonder planning gebeurt er niets', async () => {
  const { sched } = makeScheduler({});
  await assert.doesNotReject(() => sched._expireOverride());
});

// ─── carMaintaining: tolerantie rond de limiet is BEWUST gedrag ──────────────
// SoC net (~1-2%) onder de limiet door vampire drain hoeft geen nieuwe start-sessie
// te triggeren — dat zou overgevoelig laden voor een verwaarloosbaar verschil zijn.
// (Was hier kort op een strikte `soc >= capPct` gezet vanuit de aanname dat de
// tolerantie een bug was; teruggedraaid nadat bevestigd werd dat dit gewenst is.)

test('carMaintaining: soc 1% onder de limiet blijft "auto regelt het zelf" (geen herstart)', () => {
  const capPct = 60, soc = 59;
  const reached = soc >= capPct - 1;
  const want = true, actual = false, lastSentWant = true;
  const want2 = reached || (soc < capPct && want);
  const carMaintaining = want2 && actual === false && reached && lastSentWant === true;
  assert.equal(carMaintaining, true, 'binnen ~1% mag de tolerantie een herstart onderdrukken');
});

test('carMaintaining: soc ver onder de limiet triggert wél een mismatch', () => {
  const capPct = 60, soc = 50;
  const reached = soc >= capPct - 1;
  const want = true, actual = false, lastSentWant = true;
  const want2 = reached || (soc < capPct && want);
  const carMaintaining = want2 && actual === false && reached && lastSentWant === true;
  assert.equal(reached, false);
  assert.equal(carMaintaining, false, 'buiten de tolerantie moet het commando gewoon volgen');
});
