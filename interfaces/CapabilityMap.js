'use strict';

/**
 * CapabilityMap
 * ─────────────
 * Type documentation for the declarative device-role map used by HomeyDeviceAdapter.
 *
 * A CapabilityMap tells the generic adapter:
 *   - which physical Homey device to talk to
 *   - which role it fulfils (grid_meter, pv, battery, ev_charger, thermostat, dump_load)
 *   - which Homey capability name maps to each semantic slot
 *
 * Example — P1 grid meter:
 * {
 *   role:     'grid_meter',
 *   deviceId: 'f081316a-b4f6-4df5-b2f3-b480157b9480',
 *   caps: {
 *     power:    'measure_power',         // total W  (+ = import, − = export)
 *     power_l1: 'measure_power.phase_1', // optional per-phase
 *     power_l2: 'measure_power.phase_2',
 *     power_l3: 'measure_power.phase_3',
 *   },
 * }
 *
 * Example — PV kWh meter:
 * {
 *   role:     'pv',
 *   deviceId: 'e1a72db7-ec6a-4505-b868-02093c134b6e',
 *   caps: {
 *     power: 'measure_power',   // W produced (always positive)
 *   },
 * }
 *
 * Example — Home battery (Marstek B2500):
 * {
 *   role:     'battery',
 *   deviceId: 'def...',
 *   caps: {
 *     soc:       'measure_battery',              // 0–100 %
 *     power:     'measure_power',                // W  (+ = charging, − = discharging)
 *     charge:    'marstek_charge_enabled',       // boolean writable
 *     discharge: 'marstek_discharge_enabled',    // boolean writable
 *   },
 * }
 *
 * Semantic slot names (caps keys) per role:
 *
 *   grid_meter : power, power_l1, power_l2, power_l3
 *   pv         : power, power_l1, power_l2, power_l3
 *   battery    : soc, power, charge, discharge
 *   ev_charger : power, status, current_set, onoff
 *   thermostat : temp_set, temp_measure, mode, onoff
 *   dump_load  : onoff, power
 */

// This file is documentation only — no runtime exports needed.
// Import it for JSDoc type hints where desired.
module.exports = {};
