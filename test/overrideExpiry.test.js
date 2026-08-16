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

test('verlopen planning vervalt zodra het doel gehaald is', async () => {
  const { sched, store } = makeScheduler({ targetPct: 60, deadlineMs: Date.now() - 2 * HOUR });
  await sched._expireOverride(61);
  assert.equal(store.has('tesla_target_pct'), false);
  assert.equal(store.has('tesla_deadline_iso'), false);
});

test('verlopen planning blijft staan zolang het doel niet gehaald is (SoC-garantie)', async () => {
  const { sched, store } = makeScheduler({ targetPct: 60, deadlineMs: Date.now() - 2 * HOUR });
  await sched._expireOverride(59);
  assert.equal(store.get('tesla_target_pct'), 60);
});

test('onbereikbaar doel vervalt alsnog na 24u', async () => {
  const { sched, store } = makeScheduler({ targetPct: 60, deadlineMs: Date.now() - 25 * HOUR });
  await sched._expireOverride(59);
  assert.equal(store.has('tesla_target_pct'), false);
});

test('toekomstige planning blijft ongemoeid, ook als het doel al gehaald is', async () => {
  const { sched, store } = makeScheduler({ targetPct: 60, deadlineMs: Date.now() + 6 * HOUR });
  await sched._expireOverride(80);
  assert.equal(store.get('tesla_target_pct'), 60);
});

test('onbekende SoC telt niet als "doel gehaald"', async () => {
  const { sched, store } = makeScheduler({ targetPct: 60, deadlineMs: Date.now() - 2 * HOUR });
  await sched._expireOverride(null);
  assert.equal(store.get('tesla_target_pct'), 60);
});

test('zonder planning gebeurt er niets', async () => {
  const { sched } = makeScheduler({});
  await assert.doesNotReject(() => sched._expireOverride(50));
});
