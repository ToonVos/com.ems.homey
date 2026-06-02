'use strict';

/**
 * PowerSource
 * ───────────
 * Contract for any device that produces or measures power.
 * Implemented by: HomeWizardAdapter (PV side), HomeWizardAdapter (grid side)
 *
 * Sign convention (B1):
 *   +W = power flowing INTO the house (import, PV production, battery discharge)
 *   −W = power flowing OUT of the house (export, battery charge)
 */
class PowerSource {

  /**
   * Returns current power in Watts.
   * @returns {Promise<number>}
   */
  async getPowerW() {
    throw new Error('PowerSource.getPowerW() not implemented');
  }

}

module.exports = PowerSource;
