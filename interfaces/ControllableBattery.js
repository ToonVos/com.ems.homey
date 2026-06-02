'use strict';

/**
 * ControllableBattery
 * ───────────────────
 * Contract for a home battery that the EMS can read and command.
 * Implemented by: BatteryAdapter
 *
 * Modes:
 *   'charge'    — force charge (from grid or PV)
 *   'discharge' — force discharge to house
 *   'auto'      — let the inverter decide (normal operation)
 *   'idle'      — hold current SoC, neither charge nor discharge
 */
class ControllableBattery {

  /**
   * Returns battery state of charge (0–100 %).
   * @returns {Promise<number>}
   */
  async getSoc() {
    throw new Error('ControllableBattery.getSoc() not implemented');
  }

  /**
   * Returns current charge/discharge power in Watts.
   * Positive = charging, negative = discharging.
   * @returns {Promise<number>}
   */
  async getPowerW() {
    throw new Error('ControllableBattery.getPowerW() not implemented');
  }

  /**
   * Set operating mode.
   * @param {'charge'|'discharge'|'auto'|'idle'} mode
   * @returns {Promise<void>}
   */
  async setMode(mode) {
    throw new Error('ControllableBattery.setMode() not implemented');
  }

}

module.exports = ControllableBattery;
