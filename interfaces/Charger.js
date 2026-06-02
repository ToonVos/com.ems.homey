'use strict';

/**
 * Charger
 * ───────
 * Contract for an EV charge point that the EMS can read and command.
 * Implemented by: EvChargeController (which wraps TeslaEvAdapter)
 *
 * Status values:
 *   'disconnected' — no vehicle plugged in
 *   'connected'    — vehicle plugged in, not charging
 *   'charging'     — vehicle charging
 *   'complete'     — vehicle fully charged
 *   'error'        — fault condition
 */
class Charger {

  /**
   * Returns current charger status.
   * @returns {Promise<'disconnected'|'connected'|'charging'|'complete'|'error'>}
   */
  async getStatus() {
    throw new Error('Charger.getStatus() not implemented');
  }

  /**
   * Enable or disable charging.
   * @param {boolean} enabled
   * @returns {Promise<void>}
   */
  async enable(enabled) {
    throw new Error('Charger.enable() not implemented');
  }

  /**
   * Set charge current in Ampères.
   * Must be >= IEC 61851 minimum (5A) or 0 to stop.
   * @param {number} amps
   * @returns {Promise<void>}
   */
  async setCurrentA(amps) {
    throw new Error('Charger.setCurrentA() not implemented');
  }

}

module.exports = Charger;
