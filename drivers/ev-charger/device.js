'use strict';

const Homey = require('homey');

const POLL_MS  = 30 * 1000;
const MAX_DT_MS = 120 * 1000;   // klem dt na herstart/gap

/**
 * Voedt Homey Energy met de Tesla-thuislaadenergie. Leest het laadvermogen uit de
 * TeslaScheduler (`charge_power_kw` gegate op `charging_actual` — de Tesla-boolean, niet
 * de stale vermogensmeting) en houdt een cumulatieve `meter_power` bij (monotoon, kWh).
 * Onderweg snelladen (DC) telt NIET mee: de scheduler rapporteert dat als away/geen home-laden.
 */
class EvChargerDevice extends Homey.Device {
  async onInit() {
    this._total = this.getStoreValue('meter_total_kwh') || 0;
    this._lastTs = null;
    await this._setSafe('meter_power', +this._total.toFixed(3));
    await this._tick().catch(() => {});
    this._timer = this.homey.setInterval(() => this._tick().catch((e) => this.error('[EvCharger] tick:', e.message)), POLL_MS);
    this.log('[EvCharger] actief — voedt Homey Energy met Tesla-thuislading');
  }

  async _tick() {
    const sc = this.homey.app.teslaScheduler?.getStatus?.() || null;
    const awayDc   = !!(sc && sc.away_dc === true);                 // Supercharger/onderweg → niet meetellen
    const charging = !!(sc && sc.charging_actual === true && !awayDc);
    const powerW = (charging && typeof sc.charge_power_kw === 'number')
      ? Math.max(0, sc.charge_power_kw * 1000) : 0;

    const now = Date.now();
    if (this._lastTs) {
      const dtH = Math.min(now - this._lastTs, MAX_DT_MS) / 3_600_000;
      this._total += (powerW * dtH) / 1000;
      await this.setStoreValue('meter_total_kwh', this._total).catch(() => {});
    }
    this._lastTs = now;

    await this._setSafe('measure_power', Math.round(powerW));
    await this._setSafe('meter_power', +this._total.toFixed(3));
    await this._setSafe('evcharger_charging', charging);
    const connected = !!(sc && sc.connected === true);
    await this._setSafe('evcharger_charging_state',
      charging ? 'plugged_in_charging' : (connected ? 'plugged_in' : 'plugged_out'));
  }

  async _setSafe(cap, val) {
    if (this.hasCapability(cap)) await this.setCapabilityValue(cap, val).catch((e) => this.error(`[EvCharger] set ${cap}:`, e.message));
  }

  async onDeleted() { if (this._timer) this.homey.clearInterval(this._timer); }
}

module.exports = EvChargerDevice;
