'use strict';

const Homey                        = require('homey');
const { HomeyAPIV3Local }          = require('homey-api');
const EmsManager                   = require('./managers/EmsManager');
const FlowManager                  = require('./managers/FlowManager');
const NotificationManager          = require('./managers/NotificationManager');
const DecisionLog                  = require('./services/DecisionLog');
const TeslaScheduler               = require('./services/TeslaScheduler');
const PricePredictor               = require('./services/PricePredictor');

class EmsApp extends Homey.App {

  // ─── EMS Controller device registry ──────────────────────────────────────
  // device.js calls setEmsControllerDevice(this) on onInit so EmsManager can
  // push state updates without going through homey.drivers.getDriver().

  setEmsControllerDevice(device) {
    this._emsDevice = device;
  }

  getEmsControllerDevice() {
    return this._emsDevice || null;
  }

  // ─── Device access via HomeyAPIV3Local ────────────────────────────────────
  // In Homey SDK3, this.homey.devices is NOT available in App/Driver context.
  // Use HomeyAPIV3Local.createAppAPI() to get a live device with capability values.

  // Lokale tijd (Amsterdam) voor leesbare logs/records — Homey's eigen [log]-prefix
  // blijft UTC, maar onze eigen timestamps tonen we lokaal.
  localTime(d = new Date()) {
    try {
      return d.toLocaleString('nl-NL', { timeZone: this.homey.clock.getTimezone(), hour12: false });
    } catch (_) {
      return d.toISOString();
    }
  }

  async getDevice(id) {
    if (!this._homeyApi) {
      this._homeyApi = await HomeyAPIV3Local.createAppAPI({ homey: this.homey });
    }
    return this._homeyApi.devices.getDevice({ id });
  }

  // ─── Tesla laaddoel-override (dashboard-widget ems-control) ────────────────
  // Pre-saldering geldt: enige knop = wanneer kopen. Default = 60% gegarandeerd
  // op eerstvolgende 07:00; gebruiker kan dit overschrijven met een hoger %
  // {80,90,95,100} tegen een gekozen datum/tijd (max 168u vooruit). 20% = harde
  // vloer (panic), geen keuze. Opslag in settings; PlanningEngine leest dit.

  static AUTO_TARGET_PCT   = 60;
  static FLOOR_PCT         = 20;
  static MAX_HORIZON_HOURS = 168;

  // Tijdzone-rekenkunde — runtime-TZ-onafhankelijk via Intl.formatToParts
  // (geen Date-string-parsing zonder offset; voorkomt de 2u-fout bij zomertijd).

  /** Hoeveel de wandklok van `tz` vóórloopt op UTC, op het moment `date` (ms). */
  _tzOffsetMs(date, tz) {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
    const h = p.hour === '24' ? 0 : Number(p.hour);
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, h, +p.minute, +p.second);
    return asUTC - date.getTime();
  }

  /** Wandklok-tijd (y, mo[1-12], d, h, min) in `tz` → exacte UTC-Date. */
  _zonedWallToUtc(y, mo, d, h, min, tz) {
    const utcGuess = Date.UTC(y, mo - 1, d, h, min, 0);
    let off = this._tzOffsetMs(new Date(utcGuess), tz);
    let res = new Date(utcGuess - off);
    off = this._tzOffsetMs(res, tz);          // DST-randverfijning
    return new Date(utcGuess - off);
  }

  /** Lokale datumdelen (en-CA, h23) van `date` in `tz`. */
  _tzParts(date, tz) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  }

  /** Eerstvolgende 07:00 (lokaal) in de toekomst, als UTC-Date. */
  _nextSevenAm() {
    const tz = this.homey.clock.getTimezone();
    const P  = this._tzParts(new Date(), tz);
    const day = +P.day + (Number(P.hour) >= 7 ? 1 : 0);
    return this._zonedWallToUtc(+P.year, +P.month, day, 7, 0, tz);
  }

  /** Huidige Tesla-SoC (%) uit de Tesla-batterij-device, of null. */
  async getTeslaSoc() {
    try {
      const devices = this.homey.settings.get('decisionlog_devices') || {};
      const id = devices.teslaBat || 'd2ffa0cf-3b76-4185-9185-aee51364ce27';
      const dev = await this.getDevice(id);
      const v = dev?.capabilitiesObj?.measure_soc_level?.value
        ?? dev?.capabilitiesObj?.measure_battery?.value;
      return v == null ? null : Math.round(v);
    } catch (_) { return null; }
  }

  /** Huidige override-staat + defaults voor de widget. */
  async getTeslaOverride() {
    const pct      = this.homey.settings.get('tesla_target_pct');
    const deadline = this.homey.settings.get('tesla_deadline_iso');
    const active   = !!(pct != null && deadline);
    const defDeadline = this._nextSevenAm().toISOString();
    const soc = await this.getTeslaSoc();
    const sched = this.teslaScheduler?.getStatus?.() || null;
    return {
      active,
      target_pct:      active ? pct : EmsApp.AUTO_TARGET_PCT,
      deadline_iso:    active ? deadline : defDeadline,
      auto_target_pct: EmsApp.AUTO_TARGET_PCT,
      auto_deadline:   defDeadline,
      floor_pct:       EmsApp.FLOOR_PCT,
      max_horizon_h:   EmsApp.MAX_HORIZON_HOURS,
      tesla_soc:       soc,
      tz:              this.homey.clock.getTimezone(),
      // Projectie van de prijs-scheduler (klaar-tijd, beslissing, modus).
      scheduler:       sched,
    };
  }

  /** Zet een override (target% + deadline). Valideert en triggert herberekening. */
  async setTeslaOverride({ target_pct, deadline_iso }) {
    const pct = Math.round(Number(target_pct));
    if (!Number.isFinite(pct) || pct < EmsApp.FLOOR_PCT || pct > 100) {
      throw new Error(`Ongeldig doel-% (${target_pct}); moet ${EmsApp.FLOOR_PCT}–100 zijn`);
    }
    const dl = new Date(deadline_iso);
    if (isNaN(dl.getTime())) throw new Error(`Ongeldige deadline: ${deadline_iso}`);
    const horizonMs = EmsApp.MAX_HORIZON_HOURS * 3600 * 1000;
    if (dl.getTime() - Date.now() > horizonMs) {
      throw new Error(`Deadline > ${EmsApp.MAX_HORIZON_HOURS}u vooruit valt buiten de prijs-horizon`);
    }
    this.homey.settings.set('tesla_target_pct', pct);
    this.homey.settings.set('tesla_deadline_iso', dl.toISOString());
    this.log(`[Override] Tesla-doel ${pct}% tegen ${this.localTime(dl)}`);
    await this._recalcSafe('tesla_override');
    return this.getTeslaOverride();
  }

  /** Wis de override → terug naar auto (60% op eerstvolgende 07:00). */
  async clearTeslaOverride() {
    this.homey.settings.unset('tesla_target_pct');
    this.homey.settings.unset('tesla_deadline_iso');
    this.log('[Override] Tesla-doel terug naar auto (60% / 07:00)');
    await this._recalcSafe('tesla_override_clear');
    return this.getTeslaOverride();
  }

  async _recalcSafe(reason) {
    try {
      if (this.ems?.planningEngine) await this.ems.planningEngine.recalculate(reason);
    } catch (err) { this.error('[Override] recalc-fout:', err.message); }
  }

  // Called by api.js — runs in App context so this.homey has full device access.
  // Uses getDevicesByCapability() which returns cross-app devices (unlike getDevices()
  // which is scoped to this app only in SDK3).
  async getDeviceList() {
    // In Homey SDK3, this.homey.devices is NOT accessible from App/Driver context
    // outside of pair/repair sessions. HomeyAPIV3Local.createAppAPI is the correct
    // SDK3 way to enumerate all installed devices across all apps.
    try {
      const api     = await HomeyAPIV3Local.createAppAPI({ homey: this.homey });
      const devMap  = await api.devices.getDevices();
      const list    = Object.values(devMap || {})
        .map(d => ({
          id:           d.id,
          name:         d.name         || '?',
          driverUri:    d.driverId     || '',
          capabilities: Array.isArray(d.capabilities)
            ? d.capabilities
            : Object.keys(d.capabilities || {}),
        }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      this.log('[EMS] getDeviceList: returning', list.length, 'devices');
      return list;
    } catch (err) {
      this.error('[EMS] getDeviceList error:', err.message);
      return [];
    }
  }

  async onInit() {
    this.log('═══════════════════════════════════');
    this.log('  Home EMS starting up...');
    this.log('═══════════════════════════════════');

    // Core managers
    this.notifications = new NotificationManager(this);
    this.ems           = new EmsManager(this);
    this.flows         = new FlowManager(this);

    await this.ems.init();
    await this.flows.init();

    // Meerdaagse prijs-pipeline (EpexPredictor, read-only). Vóór DecisionLog
    // zodat de log de prijs-samenvatting kan meenemen.
    this.pricePredictor = new PricePredictor(this);
    await this.pricePredictor.init();

    // Fork-module 7: beslis-/snapshot-log voor terugwerkende analyse (read-only).
    this.decisionLog = new DecisionLog(this);
    await this.decisionLog.init();

    // Fork-module 2/3: prijs-gestuurde Tesla-laadregie (pre-saldering: goedkoopste
    // uren tot deadline). Stuurt via TeslaEvAdapter; modus live/dryrun via settings.
    this.teslaScheduler = new TeslaScheduler(this);
    await this.teslaScheduler.init();

    this.log('  Home EMS ready.');
    this.log('═══════════════════════════════════');
  }

  async onUninit() {
    if (this.teslaScheduler) this.teslaScheduler.destroy();
    if (this.decisionLog) this.decisionLog.destroy();
    if (this.pricePredictor) this.pricePredictor.destroy();
    if (this.ems) await this.ems.destroy();
    this.log('Home EMS stopped.');
  }

  // ─── Settings API (called from settings pages via Homey.api()) ────────────

  async onApi(method, args) {
    switch (method) {

      // Setup wizard — get all Homey devices for selection
      case 'getDevices': {
        return await this.getDeviceList();
      }

      // Setup wizard — probe a device and return capability profile
      case 'probeDevice': {
        const { id } = args;
        return this.ems.deviceProfiler.probe(id);
      }

      // Setup wizard — save full configuration
      case 'saveConfig': {
        await this.ems.applyConfig(args.config);
        return { ok: true };
      }

      // Dashboard — get current EMS state
      case 'getState': {
        return this.ems.getPublicState();
      }

      // Fork-module 7 — beslis-log ophalen (voor inspectie / NAS-export)
      case 'getDecisionLog': {
        const limit = args?.limit ?? 200;
        return this.decisionLog ? this.decisionLog.getRecent(limit) : [];
      }

      // Fork-module 2/3 — Tesla-scheduler beslis-log ophalen
      case 'getTeslaScheduler': {
        const limit = args?.limit ?? 200;
        return this.teslaScheduler ? this.teslaScheduler.getRecent(limit) : [];
      }

      // Meerdaagse prijs-pipeline — horizon of samenvatting ophalen
      case 'getPriceHorizon': {
        if (!this.pricePredictor) return null;
        return args?.summary ? this.pricePredictor.getSummary() : this.pricePredictor.getHorizon();
      }

      // Dashboard — get today's plan
      case 'getPlan': {
        return this.ems.planningEngine
          ? this.ems.planningEngine.getCurrentPlan()
          : null;
      }

      // Trip planning
      case 'planTrip': {
        const { departureTime, targetSoc } = args;
        await this.ems.tripPlanner.setTrip(departureTime, targetSoc);
        await this.ems.planningEngine.recalculate('trip_update');
        return { ok: true };
      }

      // Test Wall Connector connection
      case 'testWallConnector': {
        const { ip } = args;
        try {
          const res  = await fetch(`http://${ip}/api/1/vitals`, {
            signal: AbortSignal.timeout(4000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const EVSE = { 1:'opstarten', 2:'geen EV', 4:'verbonden, idle', 6:'aan het laden', 7:'laden (gereduceerd)', 8:'fout', 9:'laden klaar', 11:'verbinden' };
          return { ok: true, connected: data.vehicle_connected, evseState: EVSE[data.evse_state] ?? `state ${data.evse_state}` };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }

      // Force recalculate
      case 'recalculate': {
        await this.ems.planningEngine.recalculate('manual');
        return { ok: true };
      }

      default:
        throw new Error(`Unknown API method: ${method}`);
    }
  }

}

module.exports = EmsApp;
