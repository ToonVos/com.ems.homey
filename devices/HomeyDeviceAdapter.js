'use strict';

const PowerSource = require('../interfaces/PowerSource');

/**
 * HomeyDeviceAdapter  (A2/A3/A4 — declarative capability-map)
 * ─────────────────────────────────────────────────────────────
 * Generic adapter that reads (and writes) any Homey device using a
 * CapabilityMap instead of brand-specific code.
 *
 * A4 adds three compositing patterns as inline expressions in the map.
 * All three are backwards-compatible: plain string caps still work unchanged.
 *
 * ── calc ──────────────────────────────────────────────────────────────────
 * Derive a numeric value from one or more capabilities.
 *
 *   { calc: 'sub',    sources: ['measure_power.import', 'measure_power.export'] }
 *     → import − export   (handy when net = two separate caps)
 *
 *   { calc: 'add',    sources: ['measure_power.l1', 'measure_power.l2', ...] }
 *     → sum of all sources
 *
 *   { calc: 'scale',  source: 'measure_power', factor: 1000 }
 *     → value × factor   (e.g. kW → W)
 *
 *   { calc: 'negate', source: 'measure_power' }
 *     → −value           (flip sign convention)
 *
 * ── combined ──────────────────────────────────────────────────────────────
 * Derive a status string from a numeric capability.  Useful for generic
 * charge points without a dedicated status capability.
 *
 *   { combined: 'threshold', source: 'measure_power',
 *     threshold: 50, above: 'charging', below: 'idle' }
 *     → 'charging' when power > 50 W, otherwise 'idle'
 *
 * ── sequence ──────────────────────────────────────────────────────────────
 * Execute multiple write actions in a fixed order when a slot is set.
 *
 *   { sequence: ['onoff', 'battery_charging_enabled'] }
 *     → sets both capabilities in order when enable(true/false) is called
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
    this._map     = map;
    this._cache   = null;
    this._cacheTs = 0;
    this._cacheTTL = 5_000;   // ms — reuse capabilitiesObj within same tick
  }

  // ─── PowerSource implementation ──────────────────────────────────────────

  async getPowerW() {
    const caps = await this._getCaps();
    return this._resolveSlot(caps, 'power');
  }

  async getPhasesW() {
    const caps = await this._getCaps();
    return [
      this._resolveSlot(caps, 'power_l1'),
      this._resolveSlot(caps, 'power_l2'),
      this._resolveSlot(caps, 'power_l3'),
    ];
  }

  /** Returns { total, phases, hasPhaseData } — same shape as HomeWizardAdapter */
  async getPowerFull() {
    const total  = await this.getPowerW();
    const phases = await this.getPhasesW();
    return { total, phases, hasPhaseData: phases.some(p => p !== 0) };
  }

  // ─── Role accessor ────────────────────────────────────────────────────────

  get role()     { return this._map.role;     }
  get deviceId() { return this._map.deviceId; }

  // ─── A4: compositing helpers ──────────────────────────────────────────────

  /**
   * Resolve a slot from the cap map to a value.
   * Handles: plain string, calc expression, combined expression.
   *
   * @param {object} caps  capabilitiesObj from Homey device
   * @param {string} slot  semantic slot name (e.g. 'power', 'soc', 'status')
   * @returns {number|string|null}
   */
  _resolveSlot(caps, slot) {
    const def = this._map.caps?.[slot];
    if (!def) return slot.startsWith('power') ? 0 : null;

    // ── plain string ────────────────────────────────────────────────────────
    if (typeof def === 'string') {
      return caps?.[def]?.value ?? (slot.startsWith('power') ? 0 : null);
    }

    // ── calc ────────────────────────────────────────────────────────────────
    if (def.calc) {
      return this._applyCalc(caps, def);
    }

    // ── combined ────────────────────────────────────────────────────────────
    if (def.combined) {
      return this._applyCombined(caps, def);
    }

    return slot.startsWith('power') ? 0 : null;
  }

  /**
   * A4 calc: numeric derivation from one or more capabilities.
   * Supported operations: add, sub, scale, negate
   */
  _applyCalc(caps, def) {
    const read = (capName) => caps?.[capName]?.value ?? 0;

    switch (def.calc) {
      case 'add':
        return (def.sources || []).reduce((s, c) => s + read(c), 0);

      case 'sub': {
        const [a, ...rest] = (def.sources || []);
        return rest.reduce((v, c) => v - read(c), read(a));
      }

      case 'scale':
        return read(def.source) * (def.factor ?? 1);

      case 'negate':
        return -read(def.source);

      default:
        this.app.error(`[HomeyDeviceAdapter] Unknown calc operation: ${def.calc}`);
        return 0;
    }
  }

  /**
   * A4 combined: derive a status string from a numeric value.
   * Currently supports: threshold
   */
  _applyCombined(caps, def) {
    if (def.combined === 'threshold') {
      const value = caps?.[def.source]?.value ?? 0;
      return value > (def.threshold ?? 0) ? def.above : def.below;
    }
    this.app.error(`[HomeyDeviceAdapter] Unknown combined type: ${def.combined}`);
    return null;
  }

  /**
   * A4 sequence: write a value to multiple capabilities in order.
   * Returns true if all writes succeeded, false on first error.
   *
   * @param {string} slot   semantic slot name (e.g. 'enable', 'charge')
   * @param {*}      value  value to write
   */
  async writeSlot(slot, value) {
    const def = this._map.caps?.[slot];
    if (!def) return false;

    try {
      const device = await this.app.getDevice(this._map.deviceId);

      // sequence: list of caps to write in order
      if (def.sequence) {
        for (const capName of def.sequence) {
          await device.setCapabilityValue(capName, value);
        }
        return true;
      }

      // plain string: single write
      if (typeof def === 'string') {
        await device.setCapabilityValue(def, value);
        return true;
      }

    } catch (err) {
      this.app.error(`[HomeyDeviceAdapter:${this.role}] writeSlot(${slot}) error:`, err.message);
    }
    return false;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  async _getCaps() {
    const now = Date.now();
    if (this._cache && (now - this._cacheTs) < this._cacheTTL) return this._cache;
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

}

module.exports = HomeyDeviceAdapter;
