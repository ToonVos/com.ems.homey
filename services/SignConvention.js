'use strict';

/**
 * SignConvention  (B1)
 * ────────────────────
 * Single source of truth for the sign convention used throughout the EMS.
 *
 * Convention — from the house's perspective:
 *   +W = power flowing INTO the house
 *   −W = power flowing OUT OF the house
 *
 * Applied per field:
 *
 *   pvW         +  Solar panels produce and send power into the house.
 *                  Always ≥ 0.
 *
 *   gridW       +  House draws power from the grid (grid import / "netafname").
 *               −  House pushes power to the grid (grid export / "teruglevering").
 *
 *   batPowerW   +  Battery discharges into the house  (accu-ontlading).
 *               −  Battery charges from grid/solar    (accu-laden).
 *                  Note: many inverters / Homey apps return the *opposite* sign
 *                  on measure_power. Use normalizeBatPower() to flip if needed.
 *
 *   evW         EV load is tracked as a positive magnitude (Watts consumed by
 *               the car).  It does not follow the ±house convention because the
 *               EV controller uses it as a load component in the surplus formula,
 *               not as a direction.  See EvChargeController._calculateSurplus().
 *
 *   surplusW    Derived. Always ≥ 0. Equal to max(0, −gridW).
 *               Represents watts currently being exported to the grid.
 *
 *   deficitW    Derived. Always ≥ 0. Equal to max(0, +gridW).
 *               Represents watts currently being imported from the grid.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this file exists:
 *   Sign conventions were previously scattered across adapters as implicit
 *   assumptions in comments.  This file makes them explicit so that:
 *     • New adapters know exactly what sign to produce.
 *     • New planners/controllers know what sign to expect.
 *     • Bugs from sign flips are caught at the adapter boundary, not buried
 *       in arithmetic inside the planner.
 */

/**
 * Normalise battery power to EMS convention:
 *   + = discharging (into house)  /  − = charging (from grid/solar)
 *
 * Some inverter Homey apps return + for charging and − for discharging
 * (e.g. certain Growatt/Solis drivers).  Pass `inverted: true` in that case.
 *
 * @param {number}  rawW      Raw measure_power value from the device
 * @param {boolean} inverted  Set true when device uses opposite sign convention
 * @returns {number}  Normalised W in EMS convention
 */
function normalizeBatPower(rawW, inverted = false) {
  return inverted ? -rawW : rawW;
}

/**
 * Derive surplusW and deficitW from gridW.
 * Both are always ≥ 0.
 *
 * @param {number} gridW  Grid power in EMS convention (+import, −export)
 * @returns {{ surplusW: number, deficitW: number }}
 */
function deriveGridBalance(gridW) {
  return {
    surplusW: Math.max(0, -gridW),
    deficitW: Math.max(0,  gridW),
  };
}

/**
 * Assert that a state object follows the EMS sign convention.
 * Logs a warning (non-fatal) if an anomaly is detected.
 * Intended for use in development / debug builds.
 *
 * @param {object} state  EMS state from _readState()
 * @param {object} log    logger with .warn() method (e.g. app)
 */
function assertConvention(state, log) {
  if (state.pvW < 0) {
    log.error?.(`[SignConvention] pvW should be ≥ 0, got ${state.pvW}W`);
  }
  if (state.surplusW < 0) {
    log.error?.(`[SignConvention] surplusW should be ≥ 0, got ${state.surplusW}W`);
  }
  if (state.deficitW < 0) {
    log.error?.(`[SignConvention] deficitW should be ≥ 0, got ${state.deficitW}W`);
  }
  if (state.evW < 0) {
    log.error?.(`[SignConvention] evW should be ≥ 0 (magnitude), got ${state.evW}W`);
  }
}

module.exports = { normalizeBatPower, deriveGridBalance, assertConvention };
