'use strict';

const ControllableBattery = require('../interfaces/ControllableBattery');

// Autonome-handelaar-batterijen: deze sturen zichzelf aan (eigen optimalisatie /
// onbalanshandel). De EMS mag ze NIET aansturen — dat haalt ze uit hun handel en
// kost de gebruiker opbrengst. We lezen ze alleen (SoC + vermogen). Uitbreidbaar.
// Generiek overrulebaar via settings 'battery_autonomous' = true.
const AUTONOMOUS_DRIVER_PATTERNS = ['nl.zonneplan'];

/**
 * BatteryAdapter
 * ──────────────
 * Generic home battery adapter. Reads SoC and power via standard Homey
 * capabilities (measure_battery, measure_power) and controls charging /
 * discharging through a priority-based capability fallback chain:
 *
 *   Charge:    marstek_charge_enabled → onoff
 *   Discharge: marstek_discharge_enabled → (event-based fallback)
 *   Power:     marstek_charge_power / marstek_discharge_power (optional)
 *
 * Works with any battery brand whose Homey app exposes measure_battery +
 * measure_power. For brands with dedicated control capabilities (e.g.
 * Marstek B2500, SolarEdge, Huawei), those are tried first; otherwise
 * standard onoff is used and a Flow-fallback event is emitted.
 *
 * Each battery entry in config:
 *   { id, capacityKwh, maxChargeW, maxDischargeW }
 */
class BatteryAdapter extends ControllableBattery {

  constructor(app) {
    super();
    this.app      = app;
    this.homey    = app.homey;
    this.batteries = [];
    this._socThresholdFired = {};
    this._autonomyCache = {};
  }

  // ─── Autonome-handelaar-detectie (module 1) ────────────────────────────────
  // True → batterij stuurt zichzelf aan; EMS onderdrukt alle laad-/ontlaadsturing.
  async _isAutonomous(bat) {
    if (this.homey.settings.get('battery_autonomous')) return true; // globale override
    if (this._autonomyCache[bat.id] !== undefined) return this._autonomyCache[bat.id];
    let auto = false;
    try {
      const device = await this.app.getDevice(bat.id);
      const uri    = device.driverId || device.driverUri || '';
      auto = AUTONOMOUS_DRIVER_PATTERNS.some(p => uri.includes(p));
    } catch (_) { /* onbekend → niet autonoom aannemen */ }
    this._autonomyCache[bat.id] = auto;
    if (auto) this.app.log(`[Battery] ${bat.id} = autonome handelaar — sturing onderdrukt (read-only)`);
    return auto;
  }

  init(batteryConfigs) {
    this.batteries = batteryConfigs || [];
    this.app.log(`[Battery] Initialised with ${this.batteries.length} unit(s)`);
    this.batteries.forEach(b =>
      this.app.log(`  → ${b.id} | ${b.capacityKwh} kWh | max charge ${b.maxChargeW}W`));
  }

  // ─── Readings ─────────────────────────────────────────────────────────────

  async getState() {
    if (this.batteries.length === 0) {
      return { soc: 50, powerW: 0, totalCapacityKwh: 0, availableKwh: 0, units: [] };
    }

    const units   = [];
    let totalCap  = 0;
    let socSum    = 0;
    let totalPow  = 0;

    for (const bat of this.batteries) {
      try {
        const device = await this.app.getDevice(bat.id);
        const caps   = device.capabilitiesObj;

        const soc   = caps?.measure_battery?.value ?? 50;
        const power = caps?.measure_power?.value   ?? 0;

        units.push({ id: bat.id, soc, powerW: power, capacityKwh: bat.capacityKwh });
        totalCap += bat.capacityKwh;
        socSum   += soc;
        totalPow += power;
      } catch (err) {
        this.app.error(`[Battery] getState error for ${bat.id}:`, err.message);
        units.push({ id: bat.id, soc: 50, powerW: 0, capacityKwh: bat.capacityKwh });
        totalCap += bat.capacityKwh;
        socSum   += 50;
      }
    }

    const avgSoc       = socSum / this.batteries.length;
    const availableKwh = totalCap * (avgSoc / 100);

    this._checkSocThresholds(avgSoc);

    return { soc: avgSoc, powerW: totalPow, totalCapacityKwh: totalCap, availableKwh, units };
  }

  getTotalMaxChargeW()    { return this.batteries.reduce((s, b) => s + (b.maxChargeW    || 2500), 0); }
  getTotalMaxDischargeW() { return this.batteries.reduce((s, b) => s + (b.maxDischargeW || 2500), 0); }

  // ─── Control ──────────────────────────────────────────────────────────────

  async setCharging(enabled, targetW = null) {
    if (this.batteries.length === 0) return;

    const perUnitW = targetW && this.batteries.length > 0
      ? Math.round(targetW / this.batteries.length)
      : null;

    for (const bat of this.batteries) {
      await this._setUnitCharging(bat, enabled, perUnitW);
    }
  }

  async setDischarging(enabled, targetW = null) {
    if (this.batteries.length === 0) return;

    const perUnitW = targetW && this.batteries.length > 0
      ? Math.round(targetW / this.batteries.length)
      : null;

    for (const bat of this.batteries) {
      await this._setUnitDischarging(bat, enabled, perUnitW);
    }
  }

  // ─── Per-unit control ─────────────────────────────────────────────────────

  async _setUnitCharging(bat, enabled, targetW) {
    if (await this._isAutonomous(bat)) return; // module 1: read-only handelaar
    try {
      const device = await this.app.getDevice(bat.id);
      const caps   = device.capabilities || [];

      // Priority: brand-specific → generic onoff
      if (caps.includes('marstek_charge_enabled')) {
        await device.setCapabilityValue('marstek_charge_enabled', enabled);
      } else if (caps.includes('onoff')) {
        await device.setCapabilityValue('onoff', enabled);
      }

      if (enabled && targetW && caps.includes('marstek_charge_power')) {
        await device.setCapabilityValue('marstek_charge_power', Math.min(targetW, bat.maxChargeW || 2500));
      }
      this.app.log(`[Battery] ${bat.id} charge=${enabled}${targetW ? ` ${targetW}W` : ''}`);
    } catch (err) {
      this.app.error(`[Battery] setCharging error for ${bat.id}:`, err.message);
      this.homey.emit('ems:batteryFallback', { id: bat.id, action: 'charge', enabled, targetW });
    }
  }

  async _setUnitDischarging(bat, enabled, targetW) {
    if (await this._isAutonomous(bat)) return; // module 1: read-only handelaar
    try {
      const device = await this.app.getDevice(bat.id);
      const caps   = device.capabilities || [];

      if (caps.includes('marstek_discharge_enabled')) {
        await device.setCapabilityValue('marstek_discharge_enabled', enabled);
      }

      if (enabled && targetW && caps.includes('marstek_discharge_power')) {
        await device.setCapabilityValue('marstek_discharge_power', Math.min(targetW, bat.maxDischargeW || 2500));
      }
      this.app.log(`[Battery] ${bat.id} discharge=${enabled}${targetW ? ` ${targetW}W` : ''}`);
    } catch (err) {
      this.app.error(`[Battery] setDischarging error for ${bat.id}:`, err.message);
      this.homey.emit('ems:batteryFallback', { id: bat.id, action: 'discharge', enabled, targetW });
    }
  }

  // ─── SoC threshold detection ──────────────────────────────────────────────

  _checkSocThresholds(soc) {
    const minSoc = this.homey.settings.get('battery_min_soc') ?? 20;

    if (soc < minSoc && !this._socThresholdFired.min) {
      this._socThresholdFired.min = true;
      this.homey.emit('ems:batteryBelowMinimum', { soc });
    } else if (soc >= minSoc + 5) {
      this._socThresholdFired.min = false;
    }
  }

}

module.exports = BatteryAdapter;
