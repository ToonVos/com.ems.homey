'use strict';

const Thermostat = require('../interfaces/Thermostat');

/**
 * ThermostatAdapter
 * ─────────────────
 * Controls room thermostats connected to heat pump / airco units.
 *
 * Key behaviours:
 *  - Respects manual OFF: if user turned a thermostat off, never touch it
 *  - Tracks whether EMS or user made the last change
 *  - Applies temperature offset based on solar surplus
 *  - Handles heating vs cooling mode with correct offset direction:
 *      Heating + surplus → setpoint UP   (store more heat)
 *      Cooling + surplus → setpoint DOWN (store more cold)
 *  - Seasonal mode switch based on night/day temperature forecast
 *    (calculated once per day at 05:00, not real-time)
 *
 * Config per thermostat:
 *  { id, name, room, baseTemp, offsetStep, maxOffset, capabilities: [...] }
 */
class ThermostatAdapter extends Thermostat {

  constructor(app) {
    super();
    this.app        = app;
    this.homey      = app.homey;
    this.thermostats = [];
    this._userOffMap = {};
    this._lastSetBy  = {};
    this._activeOffset = 0;
    this._lastOverrideCheck = 0;
    this._overrideCheckIntervalMs = 10 * 60 * 1000; // max 1× per 10 min — Daikin rate limit

    // Mode — loaded from settings so it survives restarts
    this._mode = this.homey.settings.get('thermostat_mode') ?? 'heating';

    // Boost state — anti-chatter: only act on surplus transitions (not every tick)
    this._boostActive      = false;
    this._lastBoostChangeMs = 0;
    this._minBoostChangeMs  = 5 * 60_000; // B4-style guard: min 5 min between changes
  }

  init(config) {
    this.thermostats    = config.thermostats  || [];
    this._heatingNightThreshold = config.heatingNightThreshold ?? 10;
    this._heatingDayThreshold   = config.heatingDayThreshold   ?? 17;
    this._offsetStep    = config.offsetStep   ?? 0.5;
    this._maxOffset     = config.maxOffset    ?? 2.0;

    // Load persisted mode (may have been updated by last night's plan)
    this._mode = this.homey.settings.get('thermostat_mode') ?? this._mode;
    this.app.log(`[Thermostat] ${this.thermostats.length} thermostat(s) | mode: ${this._mode}`);

    this._watchUserChanges();
  }

  // ─── Mode switching (called once per day by PlanningEngine) ───────────────

  /**
   * Determine heating/cooling mode based on forecast temperatures.
   * @param {number} forecastNightMin  — lowest temp tonight (°C)
   * @param {number} forecastDayMax    — highest temp tomorrow (°C)
   * @returns {string} 'heating' | 'cooling'
   */
  evaluateMode(forecastNightMin, forecastDayMax) {
    const shouldCool = forecastNightMin > this._heatingNightThreshold
                    && forecastDayMax   > this._heatingDayThreshold;

    const newMode = shouldCool ? 'cooling' : 'heating';

    if (newMode !== this._mode) {
      this.app.log(`[Thermostat] Mode: ${this._mode} → ${newMode} (night: ${forecastNightMin}°C, day: ${forecastDayMax}°C)`);
      this._mode = newMode;
      // Persist so the mode survives restarts and is available without a plan recalc
      this.homey.settings.set('thermostat_mode', newMode);
      this.homey.emit('ems:heatpumpModeChanged', newMode);
    }

    return newMode;
  }

  getMode() { return this._mode; }

  // ─── Surplus boost (ad-hoc, real-time) ───────────────────────────────────

  /**
   * Apply temperature offset when solar surplus is available.
   * Called by PriorityManager on surplus → non-surplus TRANSITION only.
   * Idempotent: does nothing if boost is already active.
   * B4-style guard prevents rapid on/off cycling.
   */
  async boostTemperature() {
    if (this._boostActive) return;

    const now = Date.now();
    if (this._lastBoostChangeMs > 0 && (now - this._lastBoostChangeMs) < this._minBoostChangeMs) {
      const waitMin = Math.ceil((this._minBoostChangeMs - (now - this._lastBoostChangeMs)) / 60_000);
      this.app.log(`[Thermostat] Boost guard: ${waitMin} min remaining`);
      return;
    }

    if (this.thermostats.length === 0) return;
    await this._checkUserOverridesIfDue();

    this._boostActive       = true;
    this._lastBoostChangeMs = now;
    this.app.log(`[Thermostat] Boost ON (${this._mode}) — applying +${this._offsetStep}°C offset`);

    for (const t of this.thermostats) {
      await this._applyToThermostat(t, this._offsetStep);
    }
    this._activeOffset = this._offsetStep;
  }

  /**
   * Remove temperature offset when surplus is gone.
   * Called by PriorityManager on surplus → non-surplus TRANSITION only.
   * Idempotent: does nothing if boost is already inactive.
   */
  async restoreTemperature() {
    if (!this._boostActive) return;

    const now = Date.now();
    if (this._lastBoostChangeMs > 0 && (now - this._lastBoostChangeMs) < this._minBoostChangeMs) {
      const waitMin = Math.ceil((this._minBoostChangeMs - (now - this._lastBoostChangeMs)) / 60_000);
      this.app.log(`[Thermostat] Restore guard: ${waitMin} min remaining`);
      return;
    }

    if (this.thermostats.length === 0) return;
    await this._checkUserOverridesIfDue();

    this._boostActive       = false;
    this._lastBoostChangeMs = now;
    this._activeOffset      = 0;
    this.app.log(`[Thermostat] Boost OFF — restoring base temperatures`);

    await this.restoreAll();
  }

  /** Rate-limited override check — called before acting on thermostats */
  async _checkUserOverridesIfDue() {
    const now = Date.now();
    if ((now - this._lastOverrideCheck) >= this._overrideCheckIntervalMs) {
      this._lastOverrideCheck = now;
      await this._checkUserOverrides();
    }
  }

  // ─── Offset control (called by EmsManager each tick) ──────────────────────

  /**
   * Apply temperature offset based on current energy state.
   *
   * @param {'surplus'|'normal'|'deficit'} energyState   — total grid energy state
   * @param {number[]|null}               gridPhases      — per-phase grid W (negative = export)
   *                                                        index 0 = L1, 1 = L2, 2 = L3
   *
   * Phase-aware logic:
   *   - t.phase === 0  → use total energyState (no per-phase preference)
   *   - t.phase === 1/2/3 → derive state from gridPhases[phase-1]:
   *       gridW < -threshold  → surplus on that phase  → raise setpoint
   *       gridW >  threshold  → deficit on that phase  → lower setpoint
   *       otherwise           → normal
   */
  /**
   * Legacy per-tick offset (kept for phase-aware per-thermostat logic).
   * Called by EmsManager for per-phase thermostat control.
   * The surplus boost is now handled by boostTemperature/restoreTemperature.
   */
  async applyOffset(energyState, gridPhases = null) {
    if (this.thermostats.length === 0) return;

    await this._checkUserOverridesIfDue();

    const THRESHOLD = this.homey.settings.get('surplus_threshold') ?? 300;

    for (const t of this.thermostats) {
      // Resolve effective energy state for this thermostat
      let effectiveState = energyState;

      if (t.phase > 0 && Array.isArray(gridPhases) && gridPhases[t.phase - 1] != null) {
        const phaseW = gridPhases[t.phase - 1];
        if      (phaseW < -THRESHOLD) effectiveState = 'surplus';
        else if (phaseW >  THRESHOLD) effectiveState = 'deficit';
        else                          effectiveState = 'normal';
        this.app.log(
          `[Thermostat] ${t.name} L${t.phase}: gridW=${phaseW.toFixed(0)}W → ${effectiveState}`
        );
      }

      // Calculate target offset for this thermostat
      let targetOffset = 0;
      if (effectiveState === 'surplus') targetOffset = this._offsetStep;
      else if (effectiveState === 'deficit') targetOffset = -this._offsetStep;
      targetOffset = Math.max(-this._maxOffset, Math.min(this._maxOffset, targetOffset));

      // Per-thermostat offset tracking (avoids unnecessary device calls)
      if ((t._activeOffset ?? null) !== targetOffset) {
        t._activeOffset  = targetOffset;
        await this._applyToThermostat(t, targetOffset);
      }
    }

    // Keep top-level _activeOffset for backwards-compat (getPublicState uses it)
    this._activeOffset = this.thermostats[0]?._activeOffset ?? 0;
  }

  /**
   * Restore all thermostats to their base temperatures.
   * Called when EMS goes to idle or is disabled.
   */
  async restoreAll() {
    this._activeOffset = 0;
    for (const t of this.thermostats) {
      if (this._userOffMap[t.id]) continue;
      await this._setTemp(t, t.baseTemp, 'ems_restore');
    }
  }

  // ─── Per-thermostat logic ─────────────────────────────────────────────────

  async _applyToThermostat(t, offset) {
    // Never touch a thermostat the user turned off
    if (this._userOffMap[t.id]) {
      this.app.log(`[Thermostat] Skipping ${t.name ?? t.id} — user turned off`);
      return;
    }

    // Guard: baseTemp must be a valid number — skip rather than send NaN
    if (typeof t.baseTemp !== 'number' || isNaN(t.baseTemp)) {
      this.app.log(`[Thermostat] ${t.name ?? t.id}: no baseTemp yet — skipping tick`);
      return;
    }

    // Direction depends on heating vs cooling mode
    // Heating + surplus: raise setpoint (use more heat = store thermal energy)
    // Cooling + surplus: lower setpoint (use more cooling = store cold)
    const directedOffset = this._mode === 'cooling' ? -offset : offset;
    const newTemp        = +(t.baseTemp + directedOffset).toFixed(1);

    await this._setTemp(t, newTemp, 'ems');
  }

  async _setTemp(t, temp, setBy = 'ems') {
    // Skip if temperature unchanged — avoids unnecessary cloud calls (Daikin rate limit)
    if (t._lastSentTemp === temp && setBy === 'ems') {
      return;
    }
    try {
      const device = await this.app.getDevice(t.id);
      this._lastSetBy[t.id] = setBy;
      await device.setCapabilityValue('target_temperature', temp);
      t._lastSentTemp = temp;
      this.app.log(`[Thermostat] ${t.name}: setpoint → ${temp}°C (${setBy}, mode: ${this._mode})`);
    } catch (err) {
      this.app.error(`[Thermostat] setTemp error for ${t.name}:`, err.message);
    }
  }

  // ─── User override detection ──────────────────────────────────────────────

  /**
   * Poll thermostat state each tick to detect user overrides.
   * Called from applyOffset() so we stay in sync without event subscriptions
   * (homey-api REST devices don't support device.on() event listeners).
   */
  async _checkUserOverrides() {
    for (const t of this.thermostats) {
      try {
        const device = await this.app.getDevice(t.id);
        const caps   = device.capabilitiesObj;

        // If onoff capability is present and off → user turned it off
        const isOff = caps?.onoff?.value === false;
        if (isOff && !this._userOffMap[t.id] && this._lastSetBy[t.id] !== 'ems') {
          this._userOffMap[t.id] = true;
          this.app.log(`[Thermostat] ${t.name} is off — EMS will not touch it`);
        } else if (!isOff && this._userOffMap[t.id]) {
          this._userOffMap[t.id] = false;
          this.app.log(`[Thermostat] ${t.name} turned back on — EMS resuming control`);
        }

        // Sync baseTemp from device on first tick or after user adjustment
        if (this._lastSetBy[t.id] !== 'ems' && caps?.target_temperature?.value != null) {
          const currentTemp = caps.target_temperature.value;
          // First-time init (baseTemp not yet set or is the fallback default)
          if (typeof t.baseTemp !== 'number' || isNaN(t.baseTemp)) {
            t.baseTemp = currentTemp;
            this.app.log(`[Thermostat] ${t.name ?? t.id}: baseTemp initialised from device → ${currentTemp}°C`);
          } else if (Math.abs(currentTemp - t.baseTemp) > 0.4) {
            this.app.log(`[Thermostat] ${t.name ?? t.id}: base temp updated by user to ${currentTemp}°C`);
            t.baseTemp = currentTemp;
            this._persistBaseTemp(t.id, currentTemp);
          }
        }

        this._lastSetBy[t.id] = null;
      } catch (err) {
        // Non-fatal — just skip this thermostat this tick
      }
    }
  }

  _watchUserChanges() {
    // No-op: user override detection is handled via polling in _checkUserOverrides(),
    // called from applyOffset(). homey-api REST devices don't support device.on().
  }

  _persistBaseTemp(id, temp) {
    const key   = `thermostat_base_${id}`;
    this.homey.settings.set(key, temp);
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  getStatus() {
    return {
      mode:          this._mode,
      activeOffset:  this._activeOffset,
      thermostats:   this.thermostats.map(t => ({
        id:        t.id,
        name:      t.name,
        room:      t.room,
        baseTemp:  t.baseTemp,
        userOff:   this._userOffMap[t.id] || false,
      })),
    };
  }

}

module.exports = ThermostatAdapter;
