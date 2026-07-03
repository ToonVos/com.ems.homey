'use strict';

const fs = require('fs');
const path = require('path');

/**
 * ems-curve widget API — dagcurves (144 10-min-slots) + periode-totalen.
 * Curve: zelfde bron als /getActuals. Totalen: vandaag = live EnergyLedger;
 * week/maand = afgeronde dagen uit /userdata/energy-ledger.jsonl + vandaag.
 */

function readLedgerDays(n = 31) {
  try {
    const txt = fs.readFileSync(path.join('/userdata', 'energy-ledger.jsonl'), 'utf8').trim();
    return (txt ? txt.split('\n') : []).slice(-n)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(d => d && typeof d === 'object');
  } catch (_) { return []; }
}

function totalsOf(days) {
  const sum = (k) => +days.reduce((s, d) => s + (typeof d[k] === 'number' ? d[k] : 0), 0).toFixed(1);
  return {
    days: days.length,
    pv: sum('pv_yield_kwh'),
    import: sum('grid_import_kwh'),
    export: sum('grid_export_kwh'),
    ev: sum('ev_kwh'),
    huis: sum('household_kwh'),
    accu_in: sum('battery_charge_kwh'),
    accu_uit: sum('battery_discharge_kwh'),
  };
}

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

    // Totalen: vandaag live, week/maand = afgeronde ledger-dagen + vandaag.
    let today = null;
    try {
      const live = await homey.app.ems?.energyLedger?.getLive();
      if (live) {
        today = {
          days: 1,
          pv: live.pv_yield_kwh ?? 0,
          import: live.grid_import_kwh,     // null zolang de dag partieel is
          export: live.grid_export_kwh,
          ev: live.ev_kwh ?? 0,
          huis: live.household_kwh,
          accu_in: live.battery_charge_kwh ?? 0,
          accu_uit: live.battery_discharge_kwh ?? 0,
          partial: !!live.partial,
        };
      }
    } catch (_) { /* ledger optioneel */ }

    const hist = readLedgerDays(31);
    const withToday = (n) => {
      const t = totalsOf(hist.slice(-n));
      if (today) {
        for (const k of ['pv', 'import', 'export', 'ev', 'huis', 'accu_in', 'accu_uit']) {
          if (typeof today[k] === 'number') t[k] = +(t[k] + today[k]).toFixed(1);
        }
        t.days += 1;
      }
      return t;
    };

    return { ok: true, date, slots, totals: { today, week: withToday(6), month: withToday(30) } };
  },
};
