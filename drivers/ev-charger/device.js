'use strict';

const Homey = require('homey');

const POLL_MS  = 30 * 1000;

/**
 * Voedt Homey Energy met de Tesla-thuislaadenergie. Spiegelt de cumulatieve AC-teller die de
 * TeslaScheduler bijhoudt uit `measure_charge_energy_added` (DC ÷ laadefficiëntie = netafname) —
 * dé bron van waarheid, gedeeld met de EnergyLedger. Robuust tegen de stale `charge_power_kw`
 * (die vaak 0 meldt tijdens laden). Onderweg snelladen (DC) telt NIET mee (scheduler markeert away).
 * `measure_power` = live laadwaarde (alleen ter info); `meter_power` = monotone kWh-teller.
 */
class EvChargerDevice extends Homey.Device {
  async onInit() {
    this._total = this.getStoreValue('meter_total_kwh') || 0;
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

    // Cumulatieve kWh = de monotone AC-teller van de scheduler. Spiegelen (nooit dalen) zodat
    // Homey Energy een correcte, niet-resettende meter ziet.
    const totalAc = (sc && typeof sc.ev_energy_ac_kwh === 'number') ? sc.ev_energy_ac_kwh : null;
    if (totalAc != null && totalAc > this._total) {
      this._total = totalAc;
      await this.setStoreValue('meter_total_kwh', this._total).catch(() => {});
    }

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
