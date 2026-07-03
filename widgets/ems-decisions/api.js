'use strict';

/**
 * ems-decisions widget API — de beslis-tijdlijn van vandaag.
 * Bron: de ringbuffer van de TeslaScheduler (elke tick: decision + reden +
 * prijs) plus de actuele plan-vensters voor de vooruitblik-arcering.
 */
module.exports = {
  async getTimeline({ homey }) {
    const sched = homey.app.teslaScheduler;
    if (!sched) return { ok: false, error: 'scheduler niet actief' };
    const tz = homey.clock?.getTimezone?.() ?? 'Europe/Amsterdam';
    const dayStr = new Date().toLocaleDateString('sv-SE', { timeZone: tz });
    const ticks = sched.getRecent(2000)
      .filter(r => r.ts && new Date(r.ts).toLocaleDateString('sv-SE', { timeZone: tz }) === dayStr)
      .map(r => ({
        ts: r.ts, decision: r.decision, charge: !!r.charge_now,
        price: r.current_price_eur ?? null, reason: r.reason ?? '',
        soc: r.soc ?? null, commanded: r.commanded ?? null, wake: r.wake_secs != null,
      }));
    const st = sched.getStatus() || {};
    return { ok: true, day: dayStr, tz, ticks, plan_windows: st.plan_windows || [] };
  },
};
