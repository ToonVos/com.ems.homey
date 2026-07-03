'use strict';

/**
 * ems-curve widget API — de 144 10-min-vermogensslots van vandaag
 * (gevoed door de observe-only sampler; zelfde bron als /getActuals).
 */
module.exports = {
  async getCurve({ homey }) {
    const tz = homey.clock?.getTimezone?.() ?? 'Europe/Amsterdam';
    const local = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const date = `${local.getFullYear()}${String(local.getMonth() + 1).padStart(2, '0')}${String(local.getDate()).padStart(2, '0')}`;
    const slots = [];
    for (let h = 0; h < 24; h++) {
      for (let s = 0; s < 6; s++) {
        const d = homey.settings.get(`actuals_${date}_${h}_${s}`);
        slots.push(d && d.n > 0 ? { pvW: d.pvW, gridW: d.gridW, batW: d.batW, evW: d.evW } : null);
      }
    }
    return { ok: true, date, slots };
  },
};
