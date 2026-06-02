'use strict';

/**
 * Thermostat
 * ──────────
 * Contract for a thermostat / heat-pump controller that the EMS can
 * query and nudge based on energy surplus or deficit.
 * Implemented by: ThermostatAdapter
 *
 * Modes:
 *   'heating' — unit is heating the space
 *   'cooling' — unit is cooling the space
 *   'off'     — unit is off (user override)
 */
class Thermostat {

  /**
   * Returns current operating mode.
   * @returns {Promise<'heating'|'cooling'|'off'>}
   */
  async getMode() {
    throw new Error('Thermostat.getMode() not implemented');
  }

  /**
   * Set operating mode.
   * The EMS uses this once per day to switch between heating and cooling
   * based on weather forecast.
   * @param {'heating'|'cooling'|'off'} mode
   * @returns {Promise<void>}
   */
  async setMode(mode) {
    throw new Error('Thermostat.setMode() not implemented');
  }

}

module.exports = Thermostat;
