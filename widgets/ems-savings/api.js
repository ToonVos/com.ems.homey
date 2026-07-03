'use strict';

/**
 * ems-savings widget API — indicatieve besparing van slim laden.
 *
 * Per dag: besparing = geladen kWh × (gemiddelde dagprijs − gemiddeld betaalde
 * prijs). "Betaald" = de slot-prijzen tijdens de ticks waarin de Tesla echt
 * laadde (charging_actual); "dagprijs" = het gemiddelde van alle geziene
 * slot-prijzen die dag. Bewust deze robuuste referentie (alleen ring-data
 * nodig) i.p.v. een fragiele "wat als direct bij inplug"-reconstructie —
 * gelabeld als indicatief. Dag-resultaten worden gepersisteerd
 * (`ems_savings_days`) voor het maand-totaal.
 */
module.exports = {
  async getSavings({ homey }) {
    const sched = homey.app.teslaScheduler;
    if (!sched) return { ok: false, error: 'scheduler niet actief' };
    const tz = homey.clock?.getTimezone?.() ?? 'Europe/Amsterdam';
    const dayStr = new Date().toLocaleDateString('sv-SE', { timeZone: tz });

    const ticks = sched.getRecent(2000)
      .filter(r => r.ts && new Date(r.ts).toLocaleDateString('sv-SE', { timeZone: tz }) === dayStr);

    let paidEurKwhSum = 0, paidH = 0, kwh = 0;
    const dayPrices = [];
    for (let i = 0; i < ticks.length; i++) {
      const r = ticks[i];
      if (typeof r.current_price_eur === 'number') dayPrices.push(r.current_price_eur);
      if (r.charging_actual !== true) continue;
      const t0 = new Date(r.ts).getTime();
      const t1 = i + 1 < ticks.length ? new Date(ticks[i + 1].ts).getTime() : Date.now();
      const dtH = Math.min(Math.max(0, t1 - t0), 20 * 60_000) / 3_600_000;
      const rate = (typeof r.eff_rate_kw === 'number' && r.eff_rate_kw > 0) ? r.eff_rate_kw
                 : (typeof r.power_kw === 'number' ? r.power_kw : 0);
      if (rate <= 0 || typeof r.current_price_eur !== 'number') continue;
      kwh += rate * dtH;
      paidEurKwhSum += r.current_price_eur * rate * dtH;
      paidH += rate * dtH;
    }
    const avgPaid = paidH > 0 ? paidEurKwhSum / paidH : null;
    const avgDay = dayPrices.length ? dayPrices.reduce((a, b) => a + b, 0) / dayPrices.length : null;
    const todayEur = (avgPaid != null && avgDay != null) ? +(kwh * (avgDay - avgPaid)).toFixed(2) : 0;

    // Persisteer per dag (write-on-change) en som de lopende maand.
    const days = homey.settings.get('ems_savings_days') || {};
    if (days[dayStr] !== todayEur) {
      days[dayStr] = todayEur;
      const keys = Object.keys(days).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - 90))) delete days[k];
      homey.settings.set('ems_savings_days', days);
    }
    const month = dayStr.slice(0, 7);
    const monthEur = +Object.entries(days)
      .filter(([d]) => d.startsWith(month))
      .reduce((s, [, v]) => s + (v || 0), 0).toFixed(2);
    const totalEur = +Object.values(days).reduce((s, v) => s + (v || 0), 0).toFixed(2);

    return {
      ok: true, day: dayStr,
      kwh_today: +kwh.toFixed(1),
      avg_paid_eur: avgPaid != null ? +avgPaid.toFixed(4) : null,
      avg_day_eur: avgDay != null ? +avgDay.toFixed(4) : null,
      today_eur: todayEur, month_eur: monthEur, total_eur: totalEur,
      days_tracked: Object.keys(days).length,
    };
  },
};
