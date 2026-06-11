'use strict';

/**
 * Root API for settings pages.
 * Homey SDK3: settings pages communicate via GET/POST to these endpoints.
 * Called as: Homey.api('GET', '/getState', {}) etc.
 */
module.exports = {

  async getDevices({ homey }) {
    // Route through homey.app so getDevices() runs in the App's context,
    // which has full homey.devices access (api.js handlers are more restricted).
    try {
      return await homey.app.getDeviceList();
    } catch (err) {
      homey.app.error('[EMS] getDevices API error:', err.message);
      return [];
    }
  },

  async getActuals({ homey }) {
    // Use Homey's configured timezone (not hardcoded — works worldwide)
    const tz    = homey.clock?.getTimezone?.() ?? 'Europe/Amsterdam';
    const local = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const year  = local.getFullYear();
    const mon   = String(local.getMonth() + 1).padStart(2, '0');
    const day   = String(local.getDate()).padStart(2, '0');
    const date  = `${year}${mon}${day}`;

    // 144 slots: 24 hours × 6 ten-minute slots
    const result = [];
    for (let h = 0; h < 24; h++) {
      for (let s = 0; s < 6; s++) {
        const d = homey.settings.get(`actuals_${date}_${h}_${s}`);
        if (!d || d.n === 0) {
          result.push(null);
        } else {
          result.push({ pvW: d.pvW, gridW: d.gridW, batW: d.batW, evW: d.evW });
        }
      }
    }
    return result; // 144 elements
  },

  async getState({ homey }) {
    return homey.app.ems.getPublicState();
  },

  async getPlan({ homey }) {
    // Always returns tomorrow's plan for EMS Morgen widget
    return homey.app.ems.planningEngine
      ? homey.app.ems.planningEngine.getCurrentPlan()
      : null;
  },

  async getTodayPlan({ homey }) {
    // Returns today's plan for EMS Vandaag forecast overlay
    return homey.app.ems.planningEngine
      ? homey.app.ems.planningEngine.getTodayPlan()
      : null;
  },

  async saveConfig({ homey, body }) {
    await homey.app.ems.applyConfig(body.config);
    return { ok: true };
  },

  async planTrip({ homey, body }) {
    const { departureTime, targetSoc } = body;
    await homey.app.ems.tripPlanner.setTrip(departureTime, targetSoc);
    await homey.app.ems.planningEngine.recalculate('trip_update');
    return { ok: true };
  },

  async recalculate({ homey }) {
    await homey.app.ems.planningEngine.recalculate('manual');
    return { ok: true };
  },

  async reloadConfig({ homey }) {
    try {
      const device = homey.app.getEmsControllerDevice();
      if (device) await device._startEms();
      else homey.app.log('[EMS] reloadConfig: no device found yet');
      return { ok: true };
    } catch (err) {
      homey.app.error('[EMS] reloadConfig error:', err.message);
      return { ok: false, error: err.message };
    }
  },

  async testWeather({ homey }) {
    // Direct fetch — bypasses cache AND fallback so we see the real error/response
    const lat = homey.app.ems?.openMeteo?.lat ?? homey.geolocation.getLatitude()  ?? 52.3;
    const lon = homey.app.ems?.openMeteo?.lon ?? homey.geolocation.getLongitude() ?? 4.9;

    const params = new URLSearchParams({
      latitude:  lat,
      longitude: lon,
      hourly:    'shortwave_radiation,temperature_2m,cloud_cover',
      daily:     'temperature_2m_max,shortwave_radiation_sum',
      forecast_days: 3,
      timezone:  'Europe/Amsterdam',
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params}`;

    try {
      const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      if (!res.ok) return { ok: false, status: res.status, body: text.slice(0, 300) };

      const data  = JSON.parse(text);
      const times = data.hourly?.time ?? [];

      // Summarize per day
      const summarize = (dateStr) => {
        const hours = times
          .map((t, i) => ({ t, rad: data.hourly.shortwave_radiation[i] }))
          .filter(x => x.t.startsWith(dateStr) && x.rad > 0)
          .map(x => `${x.t.slice(11,16)}: ${x.rad.toFixed(0)} W/m²`);
        const allRad = times
          .map((t, i) => t.startsWith(dateStr) ? (data.hourly.shortwave_radiation[i] ?? 0) : 0);
        return {
          totalRadKwh: +(allRad.reduce((s, v) => s + v, 0) / 1000).toFixed(2),
          solarHours:  hours,
        };
      };

      const today    = new Date().toISOString().slice(0, 10);
      const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate()+1); return d.toISOString().slice(0,10); })();

      return {
        ok:       true,
        location: { lat, lon },
        url:      url.slice(0, 120) + '...',
        daily:    data.daily,
        today:    summarize(today),
        tomorrow: summarize(tomorrow),
      };
    } catch (e) {
      return { ok: false, error: e.message, url };
    }
  },

  async getTuningReport({ homey }) {
    return homey.app.decisionLog ? homey.app.decisionLog.getWeekSummary() : null;
  },

  async getTeslaScheduler({ homey }) {
    return homey.app.teslaScheduler ? homey.app.teslaScheduler.getRecent(300) : [];
  },

  // Diagnose: lijst /userdata-logbestanden, of tail een specifiek bestand.
  async getUserdataFile({ homey, query }) {
    const fs = require('fs'); const path = require('path');
    const dir = '/userdata';
    try {
      if (!query || !query.name) {
        return {
          files: fs.readdirSync(dir).map(f => {
            const st = fs.statSync(path.join(dir, f));
            return { name: f, size: st.size, mtime: st.mtime };
          }),
        };
      }
      const txt   = fs.readFileSync(path.join(dir, query.name), 'utf8').trim();
      const lines = txt ? txt.split('\n') : [];
      const n     = Number(query.tail || 300);
      return { name: query.name, total: lines.length, lines: lines.slice(-n) };
    } catch (e) { return { error: e.message }; }
  },

  // Debug: Tesla state-change-log (date/time per wijziging) + live snapshot.
  // Query: ?date=YYYYMMDD (default vandaag), ?tail=N (default 200).
  async getTeslaStateLog({ homey, query }) {
    const fs = require('fs'); const path = require('path');
    try {
      const tz   = homey.clock?.getTimezone?.() ?? 'Europe/Amsterdam';
      const loc  = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
      const dflt = `${loc.getFullYear()}${String(loc.getMonth() + 1).padStart(2, '0')}${String(loc.getDate()).padStart(2, '0')}`;
      const date = (query && query.date) || dflt;
      const file = path.join('/userdata', `tesla-statelog-${date}.jsonl`);

      let lines = [];
      try {
        const txt = fs.readFileSync(file, 'utf8').trim();
        const all = txt ? txt.split('\n') : [];
        const n   = Number((query && query.tail) || 200);
        lines = all.slice(-n).map(l => { try { return JSON.parse(l); } catch (_) { return l; } });
      } catch (_) { /* nog geen log vandaag */ }

      const live = await homey.app.ems?.tesla?.getState().catch(() => null);
      return { ok: true, date, file, count: lines.length, live, entries: lines };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  // Fase A: lerende parameters (laadsnelheid per temp-bucket, overhead, wektijd) + sessie-log.
  async getTeslaLearn({ homey }) {
    const fs = require('fs'); const path = require('path');
    const s = homey.settings;
    const buckets = ['lt5', '5_15', '15_25', 'gt25', 'unknown'];
    const rates = {};
    buckets.forEach(b => { rates[b] = s.get(`tesla_learn_rate_${b}`) ?? null; });
    let sessions = [];
    try {
      const txt = fs.readFileSync(path.join('/userdata', 'tesla-sessions.jsonl'), 'utf8').trim();
      sessions = (txt ? txt.split('\n') : []).slice(-30).map(l => { try { return JSON.parse(l); } catch (_) { return l; } });
    } catch (_) { /* nog geen sessies */ }
    return {
      ok: true,
      rate_kwh_h_global: s.get('tesla_observed_kwh_per_h') ?? null,
      rate_kwh_h_by_temp: rates,
      overhead_min: s.get('tesla_learn_overhead_min') ?? null,
      wake_secs: s.get('tesla_learn_wake_secs') ?? null,
      session_count: sessions.length,
      sessions,
    };
  },

  // d08-A: dagelijkse energie-boekhouding (live huidige dag + laatste afgeronde dagen).
  async getEnergyLedger({ homey, query }) {
    const fs = require('fs'); const path = require('path');
    try {
      const ledger = homey.app.ems?.energyLedger;
      const live = ledger ? await ledger.getLive() : null;
      let days = [];
      try {
        const txt = fs.readFileSync(path.join('/userdata', 'energy-ledger.jsonl'), 'utf8').trim();
        const n = Number((query && query.tail) || 14);
        days = (txt ? txt.split('\n') : []).slice(-n).map(l => { try { return JSON.parse(l); } catch (_) { return l; } });
      } catch (_) { /* nog geen afgeronde dag */ }
      return { ok: true, today: live, days };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async getEvDiag({ homey }) {
    try {
      const ems   = homey.app.ems;
      const state = ems._lastState;
      const ev    = ems.tesla;
      const ctrl  = ems.evController;

      if (!state) return { ok: false, error: 'Geen state — EMS tick nog niet gedraaid' };

      const gridW  = state.gridW ?? 0;
      const evW    = state.evW  ?? 0;
      const minA   = ctrl?._minCurrentA ?? 5;
      const phases = ctrl?._evPhases    ?? 3;
      const minPowerW = minA * phases * 230;
      const targetImportW = ctrl?._targetImportW ?? 100;
      const surplus = evW - gridW - targetImportW;

      const evState = await ev?.getState().catch(() => null);

      return {
        ok: true,
        ts:            new Date().toLocaleTimeString('nl-NL'),
        solar_W:       Math.round(state.pvW ?? 0),
        grid_W:        Math.round(gridW),
        ev_W:          Math.round(evW),
        surplus_W:     Math.round(surplus),
        threshold_W:   minPowerW,
        surplus_ok:    surplus >= minPowerW,
        ev_connected:  evState?.connected ?? 'onbekend',
        ev_charging:   evState?.charging  ?? 'onbekend',
        ev_soc:        evState?.soc       ?? 'onbekend',
        ev_currentA:   evState?.currentA  ?? 0,
        isChargingByEms: ev?._isChargingByEms ?? false,
        vehiclePresent:  ev?.isVehiclePresent() ?? 'onbekend',
        chargeMode:      ctrl?._mode ?? 'onbekend',
        targetA:         ctrl?._currentTargetA ?? 0,
        lastCommandAgo:  ev ? Math.round((Date.now() - ev._lastCommandTime) / 1000) + 's geleden' : 'n/a',
        inPeakHour:      ctrl?.isPeakHour() ?? false,
        postponedUntil:  ctrl ? (Date.now() < ctrl._evPostponedUntil ? new Date(ctrl._evPostponedUntil).toLocaleTimeString('nl-NL') : 'niet uitgesteld') : 'n/a',
        verdict: ctrl?.isPeakHour()
          ? `🚫 Piekblok actief — EV geblokkeerd tot ${ctrl._peak2End ?? 21}:00`
          : surplus >= minPowerW
            ? (evState?.connected ? '✅ Zou moeten laden — check flows' : '❌ EV niet verbonden')
            : `⏳ Surplus ${Math.round(surplus)}W < drempel ${minPowerW}W — wacht op meer zon`,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async forceRecalculate({ homey }) {
    try {
      // Clear weather cache so fresh data is fetched
      if (homey.app.ems?.openMeteo) homey.app.ems.openMeteo._cache = null;

      const target = new Date().getHours() >= 19 ? 'tomorrow' : 'today';
      await homey.app.ems.planningEngine.recalculate('manual_test', target);
      // Return the plan we just calculated (not always tomorrow's plan)
      const plan = target === 'tomorrow'
        ? homey.app.ems.planningEngine._planTomorrow
        : homey.app.ems.planningEngine._planToday;

      if (!plan) return {
        ok: false,
        error: 'Plan is null na herberekening',
        lastError: homey.app.ems.planningEngine._lastError ?? 'onbekend',
      };

      return {
        ok:       true,
        target,
        date:     plan.date,
        summary:  plan.summary,
        pvSample: plan.schedule?.slice(6, 20).map(s => ({
          h: s.hour,
          pvKwh: s.pvKwh,
          ev: s.evCharging,
        })),
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async testWallConnector({ homey, body }) {
    const { ip } = body;
    try {
      const res = await fetch(`http://${ip}/api/1/vitals`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const EVSE = {
        1: 'opstarten', 2: 'geen EV', 4: 'verbonden, idle',
        6: 'aan het laden', 7: 'laden (gereduceerd)', 8: 'fout',
        9: 'laden klaar', 11: 'verbinden',
      };
      return { ok: true, connected: data.vehicle_connected, evseState: EVSE[data.evse_state] ?? `state ${data.evse_state}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

};
