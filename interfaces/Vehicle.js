'use strict';

/**
 * Vehicle
 * ───────
 * Contract for an electric vehicle whose state the EMS can query.
 * Implemented by: TeslaEvAdapter
 *
 * Note: write operations (start/stop charging, set current) go through
 * the Charger interface on the charge point, not here. The Vehicle interface
 * is read-only plus the ability to wake the car from sleep.
 */
class Vehicle {

  /**
   * Returns current battery state of charge (0–100 %).
   * May return null if the vehicle is asleep and SoC is not cached.
   * @returns {Promise<number|null>}
   */
  async getSoc() {
    throw new Error('Vehicle.getSoc() not implemented');
  }

  /**
   * Returns estimated remaining range in kilometres.
   * May return null if unknown.
   * @returns {Promise<number|null>}
   */
  async getRangeKm() {
    throw new Error('Vehicle.getRangeKm() not implemented');
  }

  /**
   * Wake the vehicle from deep sleep so it is reachable for commands.
   * No-op if already awake. May take several seconds.
   * @returns {Promise<void>}
   */
  async wake() {
    throw new Error('Vehicle.wake() not implemented');
  }

}

module.exports = Vehicle;
