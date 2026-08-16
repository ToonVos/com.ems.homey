'use strict';

const test = require('node:test');
const assert = require('node:assert');
const PricePredictor = require('../services/PricePredictor');

/** Realistische steekproef, vorm identiek aan de echte /dap-prices-respons (16-08-2026). */
function fakePayload() {
  return {
    generatedAt: '2026-08-16T14:30:00.000Z',
    prices: [
      {
        deviceId: '10YNL----------L_6ca182',
        deviceName: 'NL_Netherlands',
        driverType: 'dap15',
        biddingZone: '10YNL----------L',
        currency: '€',
        priceInterval: 15,
        slots: [
          { time: '2026-08-16T14:30:00.000Z', importPrice: 0.2735437, exportPrice: 0.151767, isForecast: false },
          { time: '2026-08-16T14:45:00.000Z', importPrice: 0.2818, exportPrice: 0.1602, isForecast: false },
        ],
      },
      {
        deviceId: 'gas-1', deviceName: 'Gasprijzen', driverType: 'dapg',
        biddingZone: '', currency: '€', priceInterval: 60,
        slots: [{ time: '2026-08-16T14:00:00.000Z', importPrice: 0.7139, exportPrice: 0.59, isForecast: false }],
      },
    ],
  };
}

function makePredictor(payload) {
  const app = {
    homey: {
      settings: { get: () => undefined },
      api: { getApiApp: () => ({ get: async () => payload }) },
    },
    log: () => {}, error: () => {},
  };
  const pp = Object.create(PricePredictor.prototype);
  pp.app = app;
  pp.homey = app.homey;
  return pp;
}

test('_fetchPbthAppMap: pakt het dap15-device (kwartier), negeert het gas-device', async () => {
  const pp = makePredictor(fakePayload());
  const { map, step } = await pp._fetchPbthAppMap();
  assert.equal(step, 15 * 60_000);
  assert.equal(map.size, 2);
  assert.equal(map.get(new Date('2026-08-16T14:30:00.000Z').getTime()), 0.27354);
});

test('_fetchPbthAppMap: importPrice is al-in, GEEN eigen markup erover', async () => {
  const pp = makePredictor(fakePayload());
  const { map } = await pp._fetchPbthAppMap();
  const v = map.get(new Date('2026-08-16T14:30:00.000Z').getTime());
  assert.equal(v, 0.27354, 'moet exact de al-in importPrice van het device zijn, ongewijzigd');
});

test('_fetchPbthAppMap: expliciete device-keuze via pbth_app_device_id', async () => {
  const payload = fakePayload();
  const pp = makePredictor(payload);
  pp.homey.settings.get = k => (k === 'pbth_app_device_id' ? 'gas-1' : undefined);
  const { map, step } = await pp._fetchPbthAppMap();
  assert.equal(step, 60 * 60_000, 'moet het aangewezen (gas-)device pakken, niet het default dap15-device');
  assert.equal(map.size, 1);
});

test('_fetchPbthAppMap: gooit een fout als er geen devices zijn', async () => {
  const pp = makePredictor({ generatedAt: '', prices: [] });
  await assert.rejects(() => pp._fetchPbthAppMap());
});
