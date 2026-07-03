'use strict';

/**
 * ems-why widget API — de huidige scheduler-beslissing in mensentaal,
 * plus de prijs-horizon van de komende 24u met de geplande laadvensters.
 */
module.exports = {
  async getWhy({ homey }) {
    const sched = homey.app.teslaScheduler;
    if (!sched) return { ok: false, error: 'scheduler niet actief' };
    const st = sched.getStatus() || {};
    // Prijs-strip: komende 24u uit de PricePredictor (all-in import, 15-min).
    const now = Date.now();
    const horizon = (homey.app.pricePredictor?.getHorizon?.() || [])
      .map(h => ({ t: Date.parse(h.ts), p: h.import_eur }))
      .filter(h => isFinite(h.t) && h.t >= now - 15 * 60_000 && h.t <= now + 24 * 3_600_000);
    return {
      ok: true,
      decision: st.decision ?? null, reason: st.reason ?? null,
      charge_now: !!st.charge_now, tier: st.tier ?? null,
      soc: st.soc ?? null, target_pct: st.target_pct ?? null, ceiling_pct: st.ceiling_pct ?? null,
      car_limit: st.car_limit ?? null, phase_limit_pct: st.phase_limit_pct ?? null,
      connected: st.connected ?? null, car_state: st.car_state ?? null,
      current_price_eur: st.current_price_eur ?? null,
      next_charge_local: st.next_charge_local ?? null,
      ready_by_local: st.ready_by_local ?? null,
      deadline_local: st.deadline_local ?? null,
      plan_windows: st.plan_windows || [],
      updated_local: st.updated_local ?? null,
      horizon,
    };
  },
};
