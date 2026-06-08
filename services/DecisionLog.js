'use strict';

/**
 * DecisionLog (fork-module 7)
 * ───────────────────────────
 * Read-only beslis-/snapshot-log voor terugwerkende analyse (ARCHITECTURE §9.0).
 *
 * Legt elke cyclus de volledige beschikbare context vast: P1, PV, Tesla (auto +
 * batterij), Nexus, EPEX-prijzen en solar-forecast. Later kan per record de
 * werkelijke uitkomst worden aangevuld, zodat we met kennis-achteraf op echte
 * data kunnen analyseren of keuzes goed waren en wat alternatieven zouden hebben
 * gekost — sterker dan simuleren.
 *
 * Ontkoppeld van EmsManager: eigen timer, leest devices direct. Werkt dus ook
 * vóór de EMS geconfigureerd is. Geen aansturing — puur lezen.
 *
 * Opslag: append-only JSONL onder /userdata/decisionlog-YYYYMMDD.jsonl + een
 * in-memory ringbuffer (opvraagbaar via api.js → getDecisionLog voor NAS-export).
 */

const fs   = require('fs');
const path = require('path');

const USERDATA_DIR   = '/userdata';
const RING_MAX       = 3000;            // ~10 dagen bij 5-min interval
const DEFAULT_PERIOD = 5 * 60 * 1000;   // 5 minuten

// Device-mapping voor deze Homey ("Homey Pro van Toon"). Overschrijfbaar via
// settings-key 'decisionlog_devices'. Zie docs/devices-inventory.md.
const DEFAULT_DEVICES = {
  p1:        'ec398f63-5125-49d2-95aa-94b822d055b6', // LS120P1 (live net)
  pv:        'ef2cb7fc-ce4c-4235-828b-99eb7cdb091a', // Enphase Envoy (live PV)
  tesla:     '37cdaf85-28d4-41ca-95fb-7591764aa597', // Tesla S (auto)
  teslaBat:  'd2ffa0cf-3b76-4185-9185-aee51364ce27', // Tesla S batterij (laden)
  nexus:     'b3000657-38f3-4079-b309-074d0bc6edd1', // Zonneplan Batterij
  prices:    'cc19fcf6-8f6f-4174-8f9b-6163b630f360', // Stroomprijzen (PbtH dap)
  forecast:  '0f81e2c1-ccbd-4748-8862-a66d0d0c9acb', // Zonne voorspeller (PbtH solar)
};

class DecisionLog {

  constructor(app) {
    this.app   = app;
    this.homey = app.homey;
    this._ring = [];
    this._timer = null;
    this._deviceCache = {};
  }

  async init() {
    this._devices = this.homey.settings.get('decisionlog_devices') || DEFAULT_DEVICES;
    this._period  = this.homey.settings.get('decisionlog_period_ms') || DEFAULT_PERIOD;

    try { fs.mkdirSync(USERDATA_DIR, { recursive: true }); } catch (_) {}

    // Eerste snapshot direct, daarna periodiek.
    this._snapshotSafe();
    this._timer = this.homey.setInterval(() => this._snapshotSafe(), this._period);
    this.app.log(`[DecisionLog] actief — interval ${Math.round(this._period / 1000)}s`);
  }

  destroy() {
    if (this._timer) this.homey.clearInterval(this._timer);
  }

  getRecent(limit = 200) {
    return this._ring.slice(-limit);
  }

  // ─── interne helpers ──────────────────────────────────────────────────────

  async _getDevice(id) {
    // Lichte cache: device-object hergebruiken, capabilitiesObj is live.
    if (!this._deviceCache[id]) {
      this._deviceCache[id] = await this.app.getDevice(id);
    }
    return this._deviceCache[id];
  }

  async _cap(id, capability) {
    try {
      const dev  = await this._getDevice(id);
      const caps = dev?.capabilitiesObj || {};
      const v    = caps[capability]?.value;
      return v === undefined ? null : v;
    } catch (_) {
      // device weg/herstart → cache invalideren zodat volgende poging vers haalt
      delete this._deviceCache[id];
      return null;
    }
  }

  async _snapshotSafe() {
    try { await this._snapshot(); }
    catch (err) { this.app.error('[DecisionLog] snapshot-fout:', err.message); }
  }

  async _snapshot() {
    const D = this._devices;
    const c = (id, cap) => this._cap(id, cap);

    const [
      p1_power, p1_imp, p1_exp,
      pv_power, pv_grid, pv_cons,
      t_soc, t_charge_state, t_car_state, t_odo, t_api_req, t_api_cost, t_api_cmd, t_sentry,
      b_soc, b_cur, b_cur_max, b_limit, b_power, b_temp, b_charging,
      n_power, n_soc, n_state, n_mode, n_earned_total, n_earned_day, n_cycles,
      pr_h0, pr_h0_exp, pr_h1, pr_h2, pr_h3, pr_low_day, pr_high_day, pr_rank, pr_next_low, pr_next_high,
      f_now, f_kwh_day, f_kwh_tom, f_tom_peak,
    ] = await Promise.all([
      c(D.p1,'measure_power'), c(D.p1,'meter_power.imported'), c(D.p1,'meter_power.exported'),
      c(D.pv,'measure_power'), c(D.pv,'measure_power.grid'), c(D.pv,'measure_power.consumption'),
      c(D.tesla,'measure_battery'), c(D.tesla,'ev_charging_state'), c(D.tesla,'car_state'), c(D.tesla,'meter_car_odo'), c(D.tesla,'measure_api_request_count'), c(D.tesla,'measure_api_costs'), c(D.tesla,'measure_api_command_count'), c(D.tesla,'car_sentry_mode'),
      c(D.teslaBat,'measure_soc_level'), c(D.teslaBat,'measure_charge_current'), c(D.teslaBat,'measure_charge_current_max'), c(D.teslaBat,'measure_charge_limit_soc'), c(D.teslaBat,'measure_charge_power'), c(D.teslaBat,'module_temp'), c(D.teslaBat,'charging_state'),
      c(D.nexus,'measure_power'), c(D.nexus,'measure_battery'), c(D.nexus,'battery_charging_state'), c(D.nexus,'control_mode'), c(D.nexus,'meter_power.total_earned'), c(D.nexus,'meter_power.daily_earned'), c(D.nexus,'cycle_count'),
      c(D.prices,'meter_price_h0'), c(D.prices,'meter_price_h0_export'), c(D.prices,'meter_price_h1'), c(D.prices,'meter_price_h2'), c(D.prices,'meter_price_h3'), c(D.prices,'meter_price_this_day_lowest'), c(D.prices,'meter_price_this_day_highest'), c(D.prices,'meter_rank_price_h0_this_day'), c(D.prices,'meter_price_next_day_lowest'), c(D.prices,'meter_price_next_day_highest'),
      c(D.forecast,'measure_power'), c(D.forecast,'meter_kwh_forecast.this_day'), c(D.forecast,'meter_kwh_forecast.tomorrow'), c(D.forecast,'measure_watt_forecast.tomorrow_peak'),
    ]);

    const rec = {
      ts: new Date().toISOString(),
      p1:        { power_w: p1_power, imported_kwh: p1_imp, exported_kwh: p1_exp },
      pv:        { power_w: pv_power, grid_w: pv_grid, consumption_w: pv_cons },
      tesla:     { soc: t_soc, charging_state: t_charge_state, car_state: t_car_state, odo_km: t_odo, api_requests_day: t_api_req, api_costs: t_api_cost, api_commands_month: t_api_cmd, sentry: t_sentry },
      teslaBat:  { soc: b_soc, charge_current_a: b_cur, charge_current_max_a: b_cur_max, charge_limit_soc: b_limit, charge_power_kw: b_power, module_temp_c: b_temp, charging_state: b_charging },
      nexus:     { power_w: n_power, soc: n_soc, charging_state: n_state, control_mode: n_mode, total_earned_eur: n_earned_total, daily_earned_eur: n_earned_day, cycle_count: n_cycles },
      prices:    { h0: pr_h0, h0_export: pr_h0_exp, h1: pr_h1, h2: pr_h2, h3: pr_h3, day_lowest: pr_low_day, day_highest: pr_high_day, rank_h0: pr_rank, next_day_lowest: pr_next_low, next_day_highest: pr_next_high },
      forecast:  { now_w: f_now, kwh_today: f_kwh_day, kwh_tomorrow: f_kwh_tom, tomorrow_peak_w: f_tom_peak },
      // 'decision' en 'outcome' worden later aangevuld door de engine resp. na-meting.
      decision:  null,
      outcome:   null,
    };

    this._ring.push(rec);
    if (this._ring.length > RING_MAX) this._ring.shift();
    this._appendJsonl(rec);

    this.app.log(
      `[DecisionLog] snapshot #${this._ring.length}` +
      ` | P1 ${rec.p1.power_w}W | PV ${rec.pv.power_w}W` +
      ` | Tesla ${rec.tesla.soc}% (${rec.tesla.charging_state})` +
      ` | Nexus ${rec.nexus.soc}% ${rec.nexus.power_w}W` +
      ` | prijs €${rec.prices.h0}`
    );
  }

  _appendJsonl(rec) {
    try {
      const day  = rec.ts.substring(0, 10).replace(/-/g, '');
      const file = path.join(USERDATA_DIR, `decisionlog-${day}.jsonl`);
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    } catch (err) {
      this.app.error('[DecisionLog] schrijffout:', err.message);
    }
  }

}

module.exports = DecisionLog;
