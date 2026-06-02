'use strict';

const PowerSource = require('../interfaces/PowerSource');

/**
 * HomeyDeviceAdapter  (A2 — declarative capability-map)
 * ──────────────────────────────────────────────────────
 * Generic adapter that reads any Homey device using a CapabilityMap instead of
 * brand-specific code.  A new meter or inverter brand only needs a config entry,
 * not a new class.
 *
 * In this release the adapter covers the read-only PowerSource interface for
 * roles 'grid_meter' and 'pv'.  Write-capable roles (battery, ev_charger,
 * thermostat) will be added in subsequent steps once the shadow validation
 * confirms the read side is stable.
 *
 * Usage (shadow mode — A2 only reads, does not steer):
 *   const adapter = new HomeyDeviceAdapter(app, {
 *     role:     'grid_meter',
 *     deviceId: 'f081316a-...',
 *     caps: { power: 'measure_power', power_l1: 'measure_power.phase_1', ... },
 *   });
 *   const gridW = await adapter.getPowerW();
 *
 * @see interfaces/CapabilityMap.js  for the full map format.
 */
class HomeyDeviceAdapter extends PowerSource {

  /**
   * @param {object} app  Homey app instance
   * @param {object} map  CapabilityMap  { role, deviceId, caps }
   */
  constructor(app, map) {
    super();
    this.app      = app;
    this.homey    = app.homey;
    this._map     = map;          // { role, deviceId, caps }
    this._cache   = null;         // last capabilitiesObj from getDevice()
    this._cacheTs = 0;            // timestamp of last cache fill
    this._cacheTTL = 5_000;       // ms — reuse caps within same tick
  }

  // ─── PowerSource implementation ──────────────────────────────────────────

  /**
   * Returns total power in Watts from caps.power.
   * Sign is preserved as-is from the capability value.
   * @returns {Promise<number>}
   */
  async getPowerW() {
    const caps = await this._getCaps();
    const capName = this._map.caps?.power;
    if (!capName) return 0;
    return caps?.[capName]?.value ?? 0;
  }

  /**
   * Returns per-phase power [L1, L2, L3] in Watts.
   * Any missing phase defaults to 0.
   * @returns {Promise<number[]>}
   */
  async getPhasesW() {
    const caps = await this._getCaps();
    return [
      this._readCap(caps, 'power_l1'),
      this._readCap(caps, 'power_l2'),
      this._readCap(caps, 'power_l3'),
    ];
  }

  /**
   * Returns { total, phases } — same shape as HomeWizardAdapter.getGridPower()
   * and HomeWizardAdapter.getPvPower(), making drop-in comparison easy.
   * @returns {Promise<{ total: number, phases: number[], hasPhaseData: boolean }>}
   */
  async getPowerFull() {
    const total  = await this.getPowerW();
    const phases = await this.getPhasesW();
    return {
      total,
      phases,
      hasPhaseData: phases.some(p => p !== 0),
    };
  }

  // ─── Role accessor ────────────────────────────────────────────────────────

  get role()     { return this._map.role;     }
  get deviceId() { return this._map.deviceId; }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Returns capabilitiesObj, cached for _cacheTTL ms so repeated reads
   * within a single tick don't hammer the Homey API.
   */
  async _getCaps() {
    const now = Date.now();
    if (this._cache && (now - this._cacheTs) < this._cacheTTL) {
      return this._cache;
    }
    try {
      const device  = await this.app.getDevice(this._map.deviceId);
      this._cache   = device.capabilitiesObj ?? {};
      this._cacheTs = now;
    } catch (err) {
      this.app.error(`[HomeyDeviceAdapter:${this.role}] getDevice failed:`, err.message);
      this._cache = {};
    }
    return this._cache;
  }

  _readCap(caps, slot) {
    const capName = this._map.caps?.[slot];
    if (!capName) return 0;
    return caps?.[capName]?.value ?? 0;
  }

}

module.exports = HomeyDeviceAdapter;
