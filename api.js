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
    const now  = new Date();
    // Use local date to match _recordActuals
    const year = now.getFullYear();
    const mon  = String(now.getMonth() + 1).padStart(2, '0');
    const day  = String(now.getDate()).padStart(2, '0');
    const date = `${year}${mon}${day}`;

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
    return homey.app.ems.planningEngine
      ? homey.app.ems.planningEngine.getCurrentPlan()
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
    try {
      // Force fresh fetch (bypass cache)
      homey.app.ems.openMeteo._cache = null;
      const forecast = await homey.app.ems.openMeteo.getForecast();

      const summarize = (day) => ({
        dayMax:       day.dayMax,
        avgCloudPct:  day.avgCloudPct,
        radiationSum: day.radiationSum,
        peakRadW:     Math.max(...day.hourly.map(h => h.radiationW ?? 0)),
        totalRadKwh:  +(day.hourly.reduce((s, h) => s + (h.radiationW ?? 0), 0) / 1000).toFixed(2),
        solarHours:   day.hourly.filter(h => (h.radiationW ?? 0) > 50).map(h => `${String(h.hour).padStart(2,'0')}:00 ${h.radiationW.toFixed(0)}W/m²`),
      });

      return {
        ok:       true,
        today:    summarize(forecast.today),
        tomorrow: summarize(forecast.tomorrow),
        tonight:  forecast.tonight,
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
