'use strict';

/**
 * ems-energy widget API — bron-attributie van vandaag (v5.13).
 * Leest de live dag-mix uit de EnergyLedger (observe-only sampler voedt die
 * elke minuut). Retourneert de kWh-verdelingen voor de horizontale balken.
 */
module.exports = {
  async getMix({ homey }) {
    const ledger = homey.app.ems?.energyLedger;
    if (!ledger) return { ok: false, error: 'ledger niet actief' };
    const day = await ledger.getLive();
    return {
      ok: true,
      date: day.date,
      partial: day.partial,
      mix: day.mix || null,
      bat_mix: day.bat_mix || null,
      pv_yield_kwh: day.pv_yield_kwh ?? null,
      solar_export_kwh: day.solar_export_kwh ?? 0,
    };
  },
};
