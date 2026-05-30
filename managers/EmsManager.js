'use strict';

const DeviceProfiler        = require('../devices/DeviceProfiler');
const HomeWizardAdapter     = require('../devices/HomeWizardAdapter');
const BatteryAdapter        = require('../devices/BatteryAdapter');
const ThermostatAdapter     = require('../devices/ThermostatAdapter');
const TeslaEvAdapter        = require('../devices/TeslaEvAdapter');
const EvChargeController    = require('../devices/EvChargeController');
const DumpLoadAdapter       = require('../devices/DumpLoadAdapter');
const PvCurve               = require('../services/PvCurve');
const OpenMeteoService      = require('../services/OpenMeteoService');
const PlanningEngine        = require('./PlanningEngine');
const PriorityManager       = require('./PriorityManager');
const ConsumptionLearner    = require('../services/ConsumptionLearner');
const TripPlanner           = require('../services/TripPlanner');
const DayAheadPrices        = require('../services/DayAheadPrices');

const LOOP_INTERVAL_MS = 60 * 1000; // 1 minute

class EmsManager {

  constructor(app) {
    this.app   = app;
    this.homey = app.homey;
    this.mode  = 'auto';
    this._loop = null;
    this._lastState = null;
    this._nightEvActive = false;     // EV is being charged from battery at night
    this._batReserveKwh = 0;        // current night reserve target

    // Device adapters
    this.deviceProfiler = new DeviceProfiler(app);
    this.homeWizard     = new HomeWizardAdapter(app);
    this.battery        = new BatteryAdapter(app);
    this.thermostat     = new ThermostatAdapter(app);
    this.tesla          = new TeslaEvAdapter(app);
    this.evController   = null; // created after tripPlanner is ready
    this.dumpLoad       = new DumpLoadAdapter(app);

    // Services
    this.pvCurve     = new PvCurve(app);
    this.openMeteo   = new OpenMeteoService(app);
    this.consumption = new ConsumptionLearner(app);
    this.tripPlanner = new TripPlanner(app);
    this.dayAhead    = new DayAheadPrices(app);

    // Planning engine
    this.planningEngine = new PlanningEngine(app);
  }

  async init() {
    // Config is provided by EmsControllerDevice.onInit() via applyConfig().
    // Nothing to do here — we wait for the paired device to supply its stored config.
    this.app.log('[EMS] EmsManager ready — waiting for device configuration');
  }

  async _initWithConfig(config) {
    this.app.log('[EMS] Initialising with config...');
    this._config = config;

    // Location and solar config come from device settings via _buildConfig in device.js
    const lat      = config.lat      ?? 52.3;
    const lon      = config.lon      ?? 4.9;
    const pvPeakKw = config.pvPeakKw ?? 5.0;

    // Init all adapters with their config slices
    this.homeWizard.init({ gridMeterId: config.gridMeterId, pvMeterIds: config.pvMeterIds });
    this.battery.init(config.batteries || []);
    this.thermostat.init({
      thermostats: config.thermostats || [],
      ...(config.thermostatSettings || {}),
    });
    this.pvCurve.init({ peakKwTotal: pvPeakKw, pvStrings: config.pvStrings ?? null, lat, lon });
    this.openMeteo.init({ lat, lon });
    await this.consumption.init(config);
    this.tripPlanner.init(config);

    // Tesla EV (optional)
    if (config.hasEv && config.ev) {
      this.tesla.init(config);
      this.evController = new EvChargeController(this.app, this.tesla, this.tripPlanner);
      this.evController.init(config);
    }

    // Dump load (prio 3)
    this.dumpLoad = new DumpLoadAdapter(this.app);
    this.dumpLoad.init(config);

    // Priority manager
    this.priorityManager = new PriorityManager(this.app);
    this.priorityManager.init(config);

    if (config.contractType === 'dynamic') {
      await this.dayAhead.init(config.dayAheadProvider);
    }

    // Init planning engine
    this.planningEngine.init({
      pvCurve:            this.pvCurve,
      openMeteo:          this.openMeteo,
      dayAheadPrices:     config.contractType === 'dynamic' ? this.dayAhead : null,
      consumptionLearner: this.consumption,
      tripPlanner:        this.tripPlanner,
      config,
    });

    // Start control loop
    this._loop = this.homey.setInterval(() => this._tick(), LOOP_INTERVAL_MS);
    this.app.log('[EMS] Control loop started');

    // Run planning and first tick
    await this.planningEngine.recalculate('startup');
    await this._tick();
  }

  async destroy() {
    if (this._loop) { this.homey.clearInterval(this._loop); this._loop = null; }
    this.planningEngine.destroy();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  setMode(mode) {
    if (this.mode !== mode) {
      this.app.log(`[EMS] Mode changed: ${this.mode} → ${mode}`);
      this.mode = mode;
      this.homey.emit('ems:modeChanged', mode);
    }
  }
  getMode() { return this.mode; }

  getPublicState() {
    const s = this._lastState;
    if (!s) return { ready: false };
    return {
      ready:       true,
      mode:        this.mode,
      pvW:         s.pvW,
      gridW:       s.gridW,
      batSoc:      this.config?.hasBattery ? s.batSoc : 0,
      batPowerW:   this.config?.hasBattery ? s.batPowerW : 0,
      netW:        s.netW,
      evW:         s.evW ?? 0,
      status:      this._buildStatusMessage(s),
      hpMode:      this.thermostat?.getMode() ?? 'heating',
      hpOffset:    this.thermostat?._activeOffset ?? 0,
      evCharging:  this.tesla?._isChargingByEms ?? false,
      evCurrentA:  this.evController?._currentTargetA ?? 0,
      activeTrip:  this.tripPlanner?.getActiveTrip() ?? null,
      plan:        this.planningEngine.getCurrentPlan()?.summary ?? null,
      updatedAt:   new Date().toISOString(),
    };
  }

  async applyConfig(config) {
    this.app.log('[EMS] Config received, (re)initialising...');
    if (this._loop) { this.homey.clearInterval(this._loop); this._loop = null; }
    this.planningEngine.destroy();
    await this._initWithConfig(config);
  }

  // ─── Main control loop ────────────────────────────────────────────────────

  async _tick() {
    try {
      const state = await this._readState();
      this._lastState = state;

      if (this.mode === 'idle') return;

      const plan     = this.planningEngine.getCurrentPlan();
      const hourSlot = plan?.schedule?.[new Date().getHours()];

      await this._executeTick(state, hourSlot);
      await this._updateConsumptionHistory(state);
      this._recordActuals(state);
    } catch (err) {
      this.app.error('[EMS] tick error:', err);
    }
  }

  async _readState() {
    const [pvPower, gridPower, batState, evState] = await Promise.all([
      this.homeWizard.getPvPower(),
      this.homeWizard.getGridPower(),
      this.battery.getState(),
      this.tesla ? this.tesla.getState().catch(() => null) : Promise.resolve(null),
    ]);

    const pvW    = pvPower.total;
    const gridW  = gridPower.total; // negative = exporting to grid (surplus)
    // surplusW: W being returned to grid (positive = surplus, 0 = no surplus)
    // deficitW: W being drawn from grid  (positive = deficit, 0 = no deficit)
    const surplusW = Math.max(0, -gridW);
    const deficitW = Math.max(0,  gridW);
    // netW kept for backwards compat (plan engine, flow cards): positive = surplus
    const netW = surplusW > 0 ? surplusW : -deficitW;

    // Measured EV charge power (from charger device or Wall Connector)
    const evW = Math.round(evState?.powerW ?? 0);

    return {
      pvW,
      pvPhases:       pvPower.phases,
      pvHasPhaseData: pvPower.hasPhaseData,
      gridW,
      gridPhases:     gridPower.phases,
      batSoc:         batState.soc,
      batPowerW:      batState.powerW,
      batAvailKwh:    batState.availableKwh,
      netW,
      surplusW,
      deficitW,
      evW,
      timestamp:      Date.now(),
    };
  }

  async _executeTick(state, hourSlot) {
    // Determine energy state for thermostat offset
    const SURPLUS_THRESHOLD = this.homey.settings.get('surplus_threshold') ?? 300;
    let energyState = 'normal';
    if (state.surplusW > SURPLUS_THRESHOLD) energyState = 'surplus';
    if (state.deficitW > SURPLUS_THRESHOLD) energyState = 'deficit';

    // ── Peak hour override ────────────────────────────────────────────────────
    // During peak blocks: force battery to max discharge to cover household demand.
    // EV is blocked by EvChargeController.tick() independently (isPeakHour check).
    const isPeak = this.evController?.isPeakHour() ?? false;
    if (isPeak) {
      energyState = 'deficit'; // thermostaat: conserveer warmte
      await this.battery.setCharging(false);
      await this.battery.setDischarging(true); // max ontladen — goedkoopste energie
      // Still run EV controller so it can stop any running session cleanly
      if (this.evController) await this.evController.tick(state, hourSlot);
      this.app.log(`[EMS] tick | PV: ${state.pvW.toFixed(0)}W | Grid: ${state.gridW.toFixed(0)}W | Bat: ${state.batSoc.toFixed(0)}% | PIEKUUR — accu ontlaadt`);
    } else {
      // Follow the hourly plan if available, otherwise fall back to realtime logic
      if (hourSlot) {
        await this._followPlan(hourSlot, state);
      } else {
        await this._realtimeFallback(state);
      }
      this.app.log(`[EMS] tick | PV: ${state.pvW.toFixed(0)}W | Grid: ${state.gridW.toFixed(0)}W | Surplus: ${state.surplusW.toFixed(0)}W | Bat: ${state.batSoc.toFixed(0)}% | ${energyState}`);
    }

    // Thermostat offset — pass per-phase grid values so each HP reacts to its own phase
    if (this.thermostat) {
      await this.thermostat.applyOffset(energyState, state.gridPhases ?? null);
    }

    // Priority manager runs after plan — handles prio 1/2/3 allocation and dump load
    if (this.priorityManager) {
      await this.priorityManager.evaluate(state, hourSlot);
    }

    // Update the EMS Controller device tile
    const statusMsg = this._buildStatusMessage(state);
    await this._updateControllerDevice(state, statusMsg);
  }

  async _followPlan(slot, state) {
    // ── Night EV charging from battery ────────────────────────────────────────
    // When plan schedules EV to charge from battery at night, monitor reserve.
    if (slot.batAction === 'ev_night_discharge') {
      this._nightEvActive = true;
      const plan = this.planningEngine.getCurrentPlan();
      this._batReserveKwh = plan?.summary?.batReserveKwh ?? 0;

      const batKwh = state.batAvailKwh ?? 0;
      if (batKwh > this._batReserveKwh) {
        // Battery still above reserve — discharge to power EV
        await this.battery.setDischarging(true);
        this.app.log(`[EMS] Nacht EV accu: ${batKwh.toFixed(2)} kWh > reserve ${this._batReserveKwh.toFixed(2)} kWh — accu levert`);
      } else {
        // Reserve bereikt — battery naar idle, EV gaat op net verder
        await this.battery.setCharging(false);
        await this.battery.setDischarging(false);
        this.app.log(`[EMS] Nacht EV reserve bereikt (${batKwh.toFixed(2)} kWh) — accu idle, EV op net`);
      }
      if (this.evController) await this.evController.tick(state, slot);
      this.homey.emit('ems:dumpLoadShouldActivate', false);
      return;
    }

    // Reset night EV flag when no longer in night charging slot
    if (this._nightEvActive) {
      this._nightEvActive = false;
      this.app.log('[EMS] Nacht EV klaar — accu terug naar auto');
    }

    // ── Normal plan following ─────────────────────────────────────────────────
    // Battery
    if (slot.batAction === 'charge' || slot.batAction === 'grid_charge') {
      await this.battery.setCharging(true, state.pvW > 0 ? state.netW : null);
    } else if (slot.batAction === 'discharge') {
      await this.battery.setDischarging(true);
    } else {
      await this.battery.setCharging(false);
      await this.battery.setDischarging(false);
    }

    // EV — delegate to EvChargeController with plan slot hint
    if (this.evController) {
      await this.evController.tick(state, slot);
    }

    // Dump load
    this.homey.emit('ems:dumpLoadShouldActivate', slot.dumpLoad);
  }

  async _realtimeFallback(state) {
    // Simple fallback when no plan available — battery manages its own SoC limits
    const threshold = this.homey.settings.get('surplus_threshold') ?? 300;
    if (state.surplusW > threshold) {
      await this.battery.setCharging(true, state.surplusW);
    } else if (state.deficitW > threshold) {
      await this.battery.setDischarging(true);
    } else {
      await this.battery.setCharging(false);
      await this.battery.setDischarging(false);
    }

    // EV fallback — follow solar without a plan
    if (this.evController) {
      await this.evController.tick(state, null);
    }
  }

  async _updateConsumptionHistory(state) {
    // Feed actual consumption into the learner every tick
    if (this.consumption && state.gridW !== undefined) {
      const houseLoadW = state.pvW + Math.max(0, state.gridW) - Math.max(0, state.batPowerW);
      await this.consumption.recordReading(Math.max(0, houseLoadW));
    }
  }

  /**
   * Record 10-minute power averages for the dashboard chart.
   * Called every tick (1 min). Stores running average per 10-min slot in Homey settings.
   * Key format: actuals_YYYYMMDD_HH_S  (S = 0-5, slot within the hour)
   * Uses LOCAL date/time to avoid UTC midnight mismatch.
   * 144 slots per day (24 h × 6 slots).
   */
  _recordActuals(state) {
    const now   = new Date();
    // Local date — avoid toISOString() which gives UTC and can mismatch getHours() at midnight
    const year  = now.getFullYear();
    const mon   = String(now.getMonth() + 1).padStart(2, '0');
    const day   = String(now.getDate()).padStart(2, '0');
    const date  = `${year}${mon}${day}`;
    const hour  = now.getHours();
    const slot  = Math.floor(now.getMinutes() / 10); // 0–5
    const key   = `actuals_${date}_${hour}_${slot}`;

    const cur   = this.homey.settings.get(key) || { n: 0, pvW: 0, gridW: 0, batW: 0, evW: 0 };
    const n     = cur.n + 1;
    const avg   = (old, val) => Math.round((old * cur.n + (val ?? 0)) / n);

    this.homey.settings.set(key, {
      n,
      pvW:   avg(cur.pvW,   state.pvW),
      gridW: avg(cur.gridW,  state.gridW),
      batW:  avg(cur.batW,   state.batPowerW),
      evW:   avg(cur.evW,    state.evW),
    });
  }

  // ─── Night / Day load tracking ───────────────────────────────────────────

  /** Local date string YYYYMMDD */
  _localDateStr(date = new Date()) {
    return `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
  }

  /**
   * Compute last night's house load (kWh) from actuals.
   * Period: yesterday's sunset → today's sunrise.
   * Excludes EV charging. Stores result as night_load_YYYYMMDD.
   */
  computeNightLoad() {
    try {
      const now       = new Date();
      const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
      const sunToday  = this.pvCurve.getSunTimes(now);
      const sunYest   = this.pvCurve.getSunTimes(yesterday);
      const todayStr  = this._localDateStr(now);
      const yestStr   = this._localDateStr(yesterday);

      let totalKwh = 0;
      let slots    = 0;

      // Yesterday: sunset hour → 23:59
      const sunsetH = Math.floor(sunYest.sunsetH);
      for (let h = sunsetH; h < 24; h++) {
        for (let s = 0; s < 6; s++) {
          const d = this.homey.settings.get(`actuals_${yestStr}_${h}_${s}`);
          if (!d || d.n === 0) continue;
          // Night: pvW ≈ 0, house = gridW - evW
          totalKwh += Math.max(0, (d.gridW - (d.evW ?? 0))) * (10 / 60 / 1000);
          slots++;
        }
      }

      // Today: 00:00 → sunrise hour
      const sunriseH = Math.ceil(sunToday.sunriseH);
      for (let h = 0; h < sunriseH; h++) {
        for (let s = 0; s < 6; s++) {
          const d = this.homey.settings.get(`actuals_${todayStr}_${h}_${s}`);
          if (!d || d.n === 0) continue;
          totalKwh += Math.max(0, (d.gridW - (d.evW ?? 0))) * (10 / 60 / 1000);
          slots++;
        }
      }

      if (slots === 0) return null;
      this.homey.settings.set(`night_load_${yestStr}`, +totalKwh.toFixed(3));
      this.app.log(`[EMS] Night load: ${totalKwh.toFixed(2)} kWh (${slots} slots, zonsondergang ${sunsetH}:00 → zonsopkomst ${sunriseH}:00)`);
      return totalKwh;
    } catch (e) {
      this.app.error('[EMS] computeNightLoad error:', e.message);
      return null;
    }
  }

  /**
   * Compute today's hourly house load (kWh per hour) from actuals.
   * Period: sunrise → now (or sunset).
   * Excludes EV charging. Stores result as day_load_YYYYMMDD.
   */
  computeDayLoad() {
    try {
      const now      = new Date();
      const sun      = this.pvCurve.getSunTimes(now);
      const todayStr = this._localDateStr(now);
      const sunriseH = Math.ceil(sun.sunriseH);
      const sunsetH  = Math.floor(sun.sunsetH);
      const nowH     = now.getHours();

      const hourlyKwh = Array(24).fill(0);

      for (let h = sunriseH; h <= Math.min(nowH, sunsetH); h++) {
        for (let s = 0; s < 6; s++) {
          const d = this.homey.settings.get(`actuals_${todayStr}_${h}_${s}`);
          if (!d || d.n === 0) continue;
          // Day: house = pvW + gridW - evW (solar offsets some grid)
          hourlyKwh[h] += Math.max(0, (d.pvW ?? 0) + d.gridW - (d.evW ?? 0)) * (10 / 60 / 1000);
        }
      }

      this.homey.settings.set(`day_load_${todayStr}`, hourlyKwh);
      const total = hourlyKwh.reduce((s, v) => s + v, 0);
      this.app.log(`[EMS] Day load: ${total.toFixed(2)} kWh total`);
      return hourlyKwh;
    } catch (e) {
      this.app.error('[EMS] computeDayLoad error:', e.message);
      return null;
    }
  }

  /** Rolling 3-day average night load (kWh). Fallback: 30% of bat capacity. */
  getRollingNightLoad() {
    const values = [];
    for (let i = 1; i <= 3; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const v = this.homey.settings.get(`night_load_${this._localDateStr(d)}`);
      if (v != null) values.push(v);
    }
    if (values.length === 0) {
      const batCap = this.homey.settings.get('bat_capacity_kwh') ?? 5;
      return batCap * 0.30;  // fallback estimate
    }
    return values.reduce((s, v) => s + v, 0) / values.length;
  }

  /** Rolling 3-day average day load per hour (array[24] kWh). Fallback: null. */
  getRollingDayLoad() {
    const arrays = [];
    for (let i = 1; i <= 3; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const v = this.homey.settings.get(`day_load_${this._localDateStr(d)}`);
      if (Array.isArray(v)) arrays.push(v);
    }
    if (arrays.length === 0) return null;
    return Array.from({ length: 24 }, (_, h) => {
      const vals = arrays.map(a => a[h] ?? 0);
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    });
  }

  // ─── EMS Controller device ────────────────────────────────────────────────

  /**
   * Build a human-readable one-liner describing what the EMS is doing right now.
   *
   * Shows actual energy flows: where surplus goes (battery / EV / dump / export)
   * or where deficit comes from (battery discharge / grid import).
   */
  _buildStatusMessage(state) {
    const pvW     = Math.round(state.pvW       ?? 0);
    const gridW   = Math.round(state.gridW     ?? 0); // negative = export to grid
    const batSoc  = Math.round(state.batSoc    ?? 50);
    const batPowW = Math.round(state.batPowerW ?? 0); // positive = charging, negative = discharging

    // Actual grid flows
    const exportW = Math.max(0, -gridW); // W returned to grid
    const importW = Math.max(0,  gridW); // W drawn from grid

    // EV charge power — use measured value from state (set by _updateControllerDevice)
    const evW = Math.round(state.evW ?? 0);

    // Dump load active?
    const dumpActive = this.priorityManager?._dumpActive ?? false;

    // ── Surplus: producing more than the house needs ──────────────────────
    if (exportW > 100 || (pvW > 100 && importW < 100)) {
      const parts = [];
      if (batPowW  >  50) parts.push(`accu +${batPowW}W`);
      if (evW      >   0) parts.push(`EV +${evW}W`);
      if (dumpActive)     parts.push('dumplast aan');
      if (exportW  > 100) parts.push(`teruglevering ${exportW}W`);

      const dest = parts.length > 0
        ? parts.join(' | ')
        : `teruglevering ${exportW}W`;

      return `Zon ${pvW}W → ${dest}`;
    }

    // ── Deficit: drawing from grid ────────────────────────────────────────
    if (importW > 100) {
      if (batPowW < -50) {
        return `Netafname ${importW}W — accu ontlaadt ${Math.abs(batPowW)}W (${batSoc}%)`;
      }
      if (batSoc <= 22) {
        return `Netafname ${importW}W — accu op minimum (${batSoc}%)`;
      }
      if (pvW > 50) {
        return `Zon ${pvW}W + net ${importW}W → huis`;
      }
      return `Netafname ${importW}W — geen zonne-energie`;
    }

    // ── Near zero: solar covering the house load ──────────────────────────
    if (pvW > 50) return `Zon dekt huisverbruik (${pvW}W)`;
    return `Huis op net (${importW}W)`;
  }

  /**
   * Push the current state to the EMS Controller virtual device (if paired).
   * The device registers itself via app.setEmsControllerDevice() on onInit.
   */
  async _updateControllerDevice(state, statusMsg) {
    try {
      const device = this.app.getEmsControllerDevice();
      if (!device) return; // not paired yet

      // evW is already in state (read in _readState)
      await device.updateState(state, statusMsg, this.mode);
    } catch (err) {
      this.app.error('[EMS] _updateControllerDevice error:', err.message);
    }
  }

  // ─── Config ───────────────────────────────────────────────────────────────

  _loadConfig() {
    try {
      const raw = this.homey.settings.get('ems_config');
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

}

module.exports = EmsManager;
