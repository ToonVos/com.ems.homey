'use strict';

const fs   = require('fs');
const path = require('path');

const USERDATA_DIR = '/userdata';
const MAX_DT_MS    = 120 * 1000;   // klem dt na een herstart/gap
const SAVE_KEY     = 'energy_ledger_today';   // live dag-accumulator overleeft herstart

/**
 * EnergyLedger (d08-A, OBSERVE-ONLY) — dagelijkse energie-boekhouding. Zie d08-design.
 *
 * BRUTO energie (geen saldering!): de fiscale P1 (LS120) heeft APARTE registers
 * `meter_power.imported` en `meter_power.exported` — de meter streept import/export
 * nooit tegen elkaar weg. Dag-totaal = middernacht-snapshot-delta van die twee →
 * exact en compleet (vangt o.a. de nacht-laadbeurt), géén minuut-tracking nodig.
 *
 * Verbruik (afgeleid, geen CT op de Envoy):
 *   verbruik = zon + bruto_import − bruto_export − accu_laden + accu_ontladen
 *   huishouden = verbruik − EV
 *
 * €-waardering (uurprijzen): per-tick, import en export APART opgeteld (nooit gesaldeerd),
 * × de slot-prijs uit PricePredictor. Bewust post-saldering (2027) — gelabeld als simulatie.
 *
 * Bronnen: P1 LS120 (net, bruto), Biemond-Zonneplan (accu + daily_earned), Envoy/Σsolar (zon),
 * Tesla-scheduler (EV-vermogen, want state.evW=0 zonder Wall Connector).
 */
class EnergyLedger {
  constructor(app) {
    this.app = app;
    this.homey = app.homey;
    this._lastTs = null;
    this._day = this._loadOrNewDay();
  }

  _devId(key, fallback) { const d = this.homey.settings.get('decisionlog_devices') || {}; return d[key] || fallback; }
  _zonneplanId() { return this._devId('zonneplanBat', 'b3000657-38f3-4079-b309-074d0bc6edd1'); }
  _solarId()     { return this._devId('solarForecast', '0f81e2c1-ccbd-4748-8862-a66d0d0c9acb'); }
  _p1Id()        { return this._devId('p1', 'ec398f63-5125-49d2-95aa-94b822d055b6'); }

  _amsDateStr(d = new Date()) {
    try {
      const tz = this.homey.clock.getTimezone?.() ?? 'Europe/Amsterdam';
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch (_) { return new Date().toISOString().slice(0, 10); }
  }

  _newDay(dateStr) {
    return {
      date: dateStr,
      roll_ts: Date.now(),   // wanneer deze dag begon (≈ middernacht bij rollover; mid-dag bij verse start)
      // Middernacht-baseline van de fiscale P1-registers (gevuld bij eerste tick van de dag).
      p1_base_import: null, p1_base_export: null,
      // Middernacht-baseline van de cumulatieve EV-AC-teller (scheduler, uit measure_charge_energy_added).
      ev_base_ac: null,
      // EV-laadenergie vandaag (AC = netafname), als delta van de monotone teller.
      ev_kwh: 0,
      import_cost_eur: 0, export_value_eur: 0, avoided_import_eur: 0,
      tick_import_kwh: 0, tick_export_kwh: 0, tick_consumption_kwh: 0,
      solar_export_kwh: 0, trade_export_kwh: 0,
      // v5.13 bron-attributie (kWh, per tick opgebouwd): waar ging de PV heen,
      // en waar kwam de stroom voor EV/huis/wp/boiler vandaan (zon direct /
      // zon via accu / net via accu / net). Zie _attribute().
      mix: {
        pv_house: 0, pv_hp: 0, pv_ev: 0, pv_bat: 0, pv_boiler: 0,
        bat_in_sun: 0, bat_in_grid: 0,
        ev_pv: 0, ev_bat_sun: 0, ev_bat_grid: 0, ev_grid: 0,
        house_pv: 0, house_bat_sun: 0, house_bat_grid: 0, house_grid: 0,
        hp_pv: 0, hp_bat_sun: 0, hp_bat_grid: 0, hp_grid: 0,
        boiler_pv: 0, boiler_bat_sun: 0, boiler_bat_grid: 0, boiler_grid: 0,
        hp_kwh: 0, boiler_kwh: 0,
      },
      ticks: 0,
    };
  }

  /**
   * Bron-attributie per tick (v5.13, tegel "EMS Energie").
   * Prioriteit PV → huis → warmtepomp → EV → accu → boiler (overloop) → export.
   * De accu heeft een persistente inhoud-mix (settings `bat_mix`: zon-/net-kWh):
   * bij laden apart ingeboekt, bij ontladen naar rato eruit — zo weten we of
   * "stroom uit de accu" oorspronkelijk zon of gekochte netstroom was.
   * Niet-PV-vraag wordt eerst uit de accu-ontlading gedekt (huis → wp → EV →
   * boiler), de rest komt van het net. Alles in kWh van deze tick.
   */
  _attribute(d, state, dtH) {
    const kwh = (w) => Math.max(0, w) * dtH / 1000;
    const pvK     = kwh(state.pvW ?? 0);
    const evK     = kwh(state.evW ?? 0);
    const hpK     = kwh(state.hpW ?? 0);
    const boilK   = kwh(state.boilerW ?? 0);
    const batInK  = kwh(state.batPowerW ?? 0);
    const batOutK = kwh(-(state.batPowerW ?? 0));
    // huis = sluitende rest van de balans (kan door meet-jitter licht negatief zijn → 0)
    const houseK = Math.max(0, pvK + ((state.gridW ?? 0) * dtH / 1000) - batInK + batOutK - evK - hpK - boilK);

    const m = d.mix;
    m.hp_kwh += hpK; m.boiler_kwh += boilK;

    // 1. PV verdelen
    let pvLeft = pvK;
    const takePv = (need) => { const t = Math.min(pvLeft, need); pvLeft -= t; return t; };
    const pvHouse = takePv(houseK), pvHp = takePv(hpK), pvEv = takePv(evK),
          pvBat = takePv(batInK), pvBoil = takePv(boilK);
    m.pv_house += pvHouse; m.pv_hp += pvHp; m.pv_ev += pvEv; m.pv_bat += pvBat; m.pv_boiler += pvBoil;

    // 2. Accu-inhoud-mix bijwerken (persistent over dagen heen)
    const bm = this.homey.settings.get('bat_mix') || { sun: 0, grid: 0 };
    bm.sun += pvBat; bm.grid += Math.max(0, batInK - pvBat);
    m.bat_in_sun += pvBat; m.bat_in_grid += Math.max(0, batInK - pvBat);
    const bmTot = bm.sun + bm.grid;
    const sunShare = bmTot > 0 ? bm.sun / bmTot : 0;
    if (batOutK > 0) {
      bm.sun = Math.max(0, bm.sun - batOutK * sunShare);
      bm.grid = Math.max(0, bm.grid - batOutK * (1 - sunShare));
    }
    this.homey.settings.set('bat_mix', { sun: +bm.sun.toFixed(3), grid: +bm.grid.toFixed(3) });

    // 3. Niet-PV-vraag dekken: eerst accu-ontlading (huis → wp → EV → boiler), rest net
    let batLeft = batOutK;
    const cover = (need) => {
      const fromBat = Math.min(batLeft, need); batLeft -= fromBat;
      return { batSun: fromBat * sunShare, batGrid: fromBat * (1 - sunShare), grid: need - fromBat };
    };
    const ch = cover(houseK - pvHouse);
    m.house_pv += pvHouse; m.house_bat_sun += ch.batSun; m.house_bat_grid += ch.batGrid; m.house_grid += ch.grid;
    const cp = cover(hpK - pvHp);
    m.hp_pv += pvHp; m.hp_bat_sun += cp.batSun; m.hp_bat_grid += cp.batGrid; m.hp_grid += cp.grid;
    const ce = cover(evK - pvEv);
    m.ev_pv += pvEv; m.ev_bat_sun += ce.batSun; m.ev_bat_grid += ce.batGrid; m.ev_grid += ce.grid;
    const cb = cover(boilK - pvBoil);
    m.boiler_pv += pvBoil; m.boiler_bat_sun += cb.batSun; m.boiler_bat_grid += cb.batGrid; m.boiler_grid += cb.grid;
  }

  _loadOrNewDay() {
    const today = this._amsDateStr();
    const fresh = this._newDay(today);
    const saved = this.homey.settings.get(SAVE_KEY);
    if (saved && saved.date === today) {
      const merged = { ...fresh, ...saved };
      for (const k of Object.keys(fresh)) if (merged[k] == null && typeof fresh[k] === 'number') merged[k] = fresh[k];
      merged.mix = { ...fresh.mix, ...(saved.mix || {}) };   // nieuwe mix-velden na een update
      return merged;
    }
    return fresh;
  }

  _minSinceMidnight(ms) {
    try {
      const tz = this.homey.clock.getTimezone?.() ?? 'Europe/Amsterdam';
      const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
      return (+p.find(x => x.type === 'hour').value) * 60 + (+p.find(x => x.type === 'minute').value);
    } catch (_) { return 0; }
  }

  async _cap(id, cap) {
    try { const dev = await this.app.getDevice(id); return dev?.capabilitiesObj?.[cap]?.value ?? null; }
    catch (_) { return null; }
  }

  /** Huidige slot-prijzen uit de PricePredictor-horizon, of null. */
  _currentPrice() {
    try {
      const h = this.app.pricePredictor?.getHorizon?.() || [];
      if (!h.length) return null;
      const now = Date.now(); const SLOT = 15 * 60_000;
      return h.find(x => { const t = Date.parse(x.ts); return now >= t && now < t + SLOT; }) || null;
    } catch (_) { return null; }
  }

  /** Per EMS-tick. Async (leest 1× per dag de P1-baseline). */
  async accumulate(state) {
    try {
      const now = Date.now();
      const today = this._amsDateStr(new Date(now));
      if (today !== this._day.date) { await this._finalizeDay(this._day); this._day = this._newDay(today); this._lastTs = null; }

      const d = this._day;
      // Middernacht-baseline van de fiscale P1 (bruto import/export-registers).
      if (d.p1_base_import == null || d.p1_base_export == null) {
        const imp = await this._cap(this._p1Id(), 'meter_power.imported');
        const exp = await this._cap(this._p1Id(), 'meter_power.exported');
        if (typeof imp === 'number') d.p1_base_import = imp;
        if (typeof exp === 'number') d.p1_base_export = exp;
      }

      const dtMs = this._lastTs ? Math.min(now - this._lastTs, MAX_DT_MS) : 0;
      this._lastTs = now;
      if (dtMs <= 0) { this.homey.settings.set(SAVE_KEY, d); return; }
      const dtH = dtMs / 3_600_000;

      const pvW = state.pvW ?? 0, gridW = state.gridW ?? 0, batW = state.batPowerW ?? 0;
      const consW = pvW + gridW + batW;

      // EV-laden (AC = netafname): delta van de monotone cumulatieve teller die de scheduler
      // bijhoudt uit measure_charge_energy_added (DC ÷ efficiëntie). Robuust tegen de stale
      // measure_charge_power (die vaak 0 meldt tijdens laden) én tegen herstarts/gaps.
      const sc = this.app.teslaScheduler?.getStatus?.() || null;
      const evTotalAc = (sc && typeof sc.ev_energy_ac_kwh === 'number') ? sc.ev_energy_ac_kwh : null;
      if (evTotalAc != null) {
        if (d.ev_base_ac == null) d.ev_base_ac = evTotalAc;   // middernacht-baseline
        d.ev_kwh = +Math.max(0, evTotalAc - d.ev_base_ac).toFixed(3);
      }

      d.tick_consumption_kwh += (consW * dtH) / 1000;
      // BRUTO import/export per tick — apart opgeteld, NOOIT gesaldeerd.
      let solarExportKwh = 0;
      if (gridW >= 0) d.tick_import_kwh += (gridW * dtH) / 1000;
      else {
        const exportW = -gridW;
        d.tick_export_kwh += (exportW * dtH) / 1000;
        const tradeW = batW > 0 ? Math.min(exportW, batW) : 0;
        d.trade_export_kwh += (tradeW * dtH) / 1000;
        solarExportKwh = ((exportW - tradeW) * dtH) / 1000;
        d.solar_export_kwh += solarExportKwh;
      }

      // €-waardering tegen de huidige slot-prijs.
      const price = this._currentPrice();
      if (price) {
        if (gridW > 0) d.import_cost_eur += (gridW * dtH / 1000) * (price.import_eur ?? 0);
        d.export_value_eur += solarExportKwh * (price.export_eur ?? 0);
        const selfKwh = Math.max(0, consW - Math.max(0, gridW)) * dtH / 1000;
        d.avoided_import_eur += selfKwh * (price.import_eur ?? 0);
      }
      // v5.13: bron-attributie (PV-bestemming + herkomst EV/huis/wp/boiler + accu-mix)
      this._attribute(d, state, dtH);

      d.ticks++;
      this.homey.settings.set(SAVE_KEY, d);
    } catch (e) { this.app.error('[Ledger] accumulate:', e.message); }
  }

  /** Bruto dag-import/export uit de P1-registers (middernacht-delta). null = nog geen baseline. */
  async _p1Daily(d) {
    const imp = await this._cap(this._p1Id(), 'meter_power.imported');
    const exp = await this._cap(this._p1Id(), 'meter_power.exported');
    return {
      import_kwh: (typeof imp === 'number' && d.p1_base_import != null) ? +(imp - d.p1_base_import).toFixed(3) : null,
      export_kwh: (typeof exp === 'number' && d.p1_base_export != null) ? +(exp - d.p1_base_export).toFixed(3) : null,
    };
  }

  async _snapshot() {
    const z = this._zonneplanId();
    const totImp = await this._cap(z, 'meter_power.import');
    const totExp = await this._cap(z, 'meter_power.export');
    return {
      trade_earned_eur: await this._cap(z, 'meter_power.daily_earned'),
      battery_soc:      await this._cap(z, 'measure_battery'),
      battery_charge_kwh: await this._cap(z, 'meter_power.daily_import'),   // in de accu
      battery_discharge_kwh: await this._cap(z, 'meter_power.daily_export'),// uit de accu
      battery_rte_pct:  (totImp > 0 && totExp != null) ? +(totExp / totImp * 100).toFixed(1) : null,
      solar_forecast_tomorrow_kwh: await this._cap(this._solarId(), 'meter_kwh_forecast.tomorrow'),
    };
  }

  /** Stelt het dag-record samen uit autoritatieve meters (bruto) + per-tick (€/EV). */
  async _composeDay(d) {
    const snap = await this._p1Daily(d).then(async (p1) => ({ p1, ...(await this._snapshot()) }));
    const p1 = snap.p1;
    const pvYield = await this._cap(this._solarId(), 'meter_kwh_this_day');
    const batChg = snap.battery_charge_kwh, batDis = snap.battery_discharge_kwh;
    // Partieel? De P1-bruto-dag klopt alleen als de baseline ~middernacht is gezet. Begon de
    // dag mid-dag (verse start/deploy), dan mist de ochtend → import/export + verbruik onbetrouwbaar.
    const partial = this._minSinceMidnight(d.roll_ts || Date.now()) > 15;
    // verbruik = zon + import − export − accu_laden + accu_ontladen (alle bruto/dag)
    let consumption = null;
    if (!partial && pvYield != null && p1.import_kwh != null && p1.export_kwh != null) {
      consumption = +(pvYield + p1.import_kwh - p1.export_kwh - (batChg ?? 0) + (batDis ?? 0)).toFixed(3);
    }
    return {
      date: d.date,
      partial,
      pv_yield_kwh: pvYield,                                          // volledige dag (device-teller)
      grid_import_kwh: partial ? null : p1.import_kwh,                // BRUTO fiscale P1 (null als partieel)
      grid_export_kwh: partial ? null : p1.export_kwh,
      battery_charge_kwh: batChg, battery_discharge_kwh: batDis,      // volledige dag (Zonneplan)
      ev_kwh: +d.ev_kwh.toFixed(3),
      consumption_kwh: consumption,
      household_kwh: consumption != null ? +Math.max(0, consumption - d.ev_kwh).toFixed(3) : null,
      solar_export_kwh: +d.solar_export_kwh.toFixed(3), trade_export_kwh: +d.trade_export_kwh.toFixed(3),
      import_cost_eur: +d.import_cost_eur.toFixed(3),
      export_value_eur: +d.export_value_eur.toFixed(4),
      avoided_import_eur: +d.avoided_import_eur.toFixed(3),
      trade_earned_eur: snap.trade_earned_eur,
      battery_soc: snap.battery_soc,
      battery_rte_pct: snap.battery_rte_pct,
      solar_forecast_tomorrow_kwh: snap.solar_forecast_tomorrow_kwh,
      // v5.13: bron-attributie voor de "EMS Energie"-tegel + huidige accu-mix
      mix: d.mix || null,
      bat_mix: (() => {
        const bm = this.homey.settings.get('bat_mix') || null;
        if (!bm) return null;
        const tot = (bm.sun || 0) + (bm.grid || 0);
        return { ...bm, sun_pct: tot > 0 ? +(100 * bm.sun / tot).toFixed(0) : null };
      })(),
      ticks: d.ticks,
    };
  }

  async _finalizeDay(day) {
    try {
      const rec = { ...(await this._composeDay(day)), ts: new Date().toISOString() };
      fs.appendFileSync(path.join(USERDATA_DIR, 'energy-ledger.jsonl'), JSON.stringify(rec) + '\n');
      this.app.log(`[Ledger] dag ${day.date}: verbruik ${rec.consumption_kwh}kWh (huis ${rec.household_kwh}, EV ${rec.ev_kwh}), zon ${rec.pv_yield_kwh}, import ${rec.grid_import_kwh}, export ${rec.grid_export_kwh}, handel €${rec.trade_earned_eur ?? '?'}`);
    } catch (e) { this.app.error('[Ledger] finalize:', e.message); }
  }

  async getLive() { return this._composeDay(this._day); }
}

module.exports = EnergyLedger;
