'use strict';

/**
 * ChargeDryRun (fork-module 2 — dry-run fase)
 * ───────────────────────────────────────────
 * Berekent elke cyclus de gewenste Tesla-laadstroom op zonne-overschot
 * (zero-export), MAAR stuurt NIETS naar de auto. Legt verwachting (wat we
 * zouden doen) naast werkelijkheid (wat de auto/het net feitelijk doet),
 * zodat we een paar dagen kunnen valideren vóór we live gaan sturen.
 *
 * Geen commando's → kost geen Tesla-credits. Puur lezen + rekenen + loggen.
 *
 * Opslag: JSONL /userdata/chargedryrun-YYYYMMDD.jsonl + ringbuffer
 * (API: getChargeDryRun). Per cyclus één samenvattende logregel.
 *
 * Zero-export-principe: grid (P1) = huis + tesla − pv (import +, export −).
 * Om grid → 0 te sturen: gewenste tesla-vermogen = huidige_tesla_w − grid_w.
 * Daarmee verdwijnt zowel huis-baseload als pv-overschot vanzelf in de som.
 */

const fs   = require('fs');
const path = require('path');

const USERDATA_DIR   = '/userdata';
const RING_MAX       = 4000;
const PERIOD_MS      = 60 * 1000;   // 60s — fijne resolutie; kost niets (dry-run)
const VOLTAGE        = 230;
const HYSTERESIS_A   = 2;           // ≥2A verandering vóór we 'zouden' sturen
const COOLDOWN_MS    = 90 * 1000;   // ≥90s tussen 'zou-sturen'-momenten

// Devices voor deze Homey — zie docs/devices-inventory.md. Overschrijfbaar via
// settings 'decisionlog_devices' (gedeeld met DecisionLog).
const DEFAULT_DEVICES = {
  p1:       'ec398f63-5125-49d2-95aa-94b822d055b6',
  pv:       'ef2cb7fc-ce4c-4235-828b-99eb7cdb091a',
  tesla:    '37cdaf85-28d4-41ca-95fb-7591764aa597',
  teslaBat: 'd2ffa0cf-3b76-4185-9185-aee51364ce27',
};

// ev_charging_state-waarden die betekenen: kabel NIET verbonden → niet laden.
const DISCONNECTED_STATES = ['disconnected', 'plugged_out', 'unplugged', null];

class ChargeDryRun {

  constructor(app) {
    this.app   = app;
    this.homey = app.homey;
    this._ring = [];
    this._timer = null;
    this._deviceCache = {};
    this._lastWouldSendTs = 0;
    this._lastDesiredA = 0;
    this._potentialWhToday = 0;     // cumulatief 'onbenut overschot dat in de auto had gekund'
    this._potentialDay = null;
  }

  async init() {
    this._devices = this.homey.settings.get('decisionlog_devices') || DEFAULT_DEVICES;
    this._maxA = this.homey.settings.get('ev_max_current_a') ?? 16;
    this._minA = this.homey.settings.get('ev_min_current_a') ?? 5;
    try { fs.mkdirSync(USERDATA_DIR, { recursive: true }); } catch (_) {}
    this._tickSafe();
    this._timer = this.homey.setInterval(() => this._tickSafe(), PERIOD_MS);
    this.app.log(`[ChargeDryRun] actief (DRY-RUN, stuurt niets) — interval ${PERIOD_MS / 1000}s, ${this._minA}-${this._maxA}A`);
  }

  destroy() { if (this._timer) this.homey.clearInterval(this._timer); }

  getRecent(limit = 200) { return this._ring.slice(-limit); }

  // ─── helpers ───────────────────────────────────────────────────────────────

  async _cap(id, capability) {
    try {
      if (!this._deviceCache[id]) this._deviceCache[id] = await this.app.getDevice(id);
      const v = this._deviceCache[id]?.capabilitiesObj?.[capability]?.value;
      return v === undefined ? null : v;
    } catch (_) { delete this._deviceCache[id]; return null; }
  }

  async _tickSafe() {
    try { await this._tick(); }
    catch (err) { this.app.error('[ChargeDryRun] fout:', err.message); }
  }

  async _tick() {
    const D = this._devices;
    const [
      grid_w, pv_w,
      ev_state, charge_state, charge_a, charge_kw, charge_phases, soc, charge_limit,
    ] = await Promise.all([
      this._cap(D.p1, 'measure_power'), this._cap(D.pv, 'measure_power'),
      this._cap(D.tesla, 'ev_charging_state'),
      this._cap(D.teslaBat, 'charging_state'), this._cap(D.teslaBat, 'measure_charge_current'),
      this._cap(D.teslaBat, 'measure_charge_power'), this._cap(D.teslaBat, 'measure_charge_phases'),
      this._cap(D.teslaBat, 'measure_soc_level'), this._cap(D.teslaBat, 'measure_charge_limit_soc'),
    ]);

    const connected = !DISCONNECTED_STATES.includes(ev_state);
    const phases    = (charge_phases && charge_phases > 0) ? charge_phases : 1;
    const teslaW    = (charge_kw != null ? charge_kw * 1000 : 0);

    // Zero-export: gewenst tesla-vermogen zodat grid → 0.
    // available = huidig tesla-vermogen − grid (export negatief telt op).
    const availableW = teslaW - (grid_w ?? 0);
    const maxW       = this._maxA * phases * VOLTAGE;
    let desiredW     = Math.max(0, Math.min(maxW, availableW));
    let desiredA     = Math.round(desiredW / (phases * VOLTAGE));

    // Onder minimum → niet laden (0A).
    let action;
    if (!connected)                 { desiredA = 0; action = 'skip_disconnected'; }
    else if (soc != null && charge_limit != null && soc >= charge_limit) { desiredA = 0; action = 'skip_at_limit'; }
    else if (desiredA < this._minA) { desiredA = 0; action = 'stop'; }
    else                            { action = 'set'; }

    // Command-budget-discipline: zou-sturen alleen bij ≥2A verschil + cooldown + verandering.
    const now       = Date.now();
    const deltaA    = Math.abs(desiredA - this._lastDesiredA);
    const cooldownOk = (now - this._lastWouldSendTs) >= COOLDOWN_MS;
    const changed   = deltaA >= HYSTERESIS_A;
    const wouldSend = connected && changed && cooldownOk && (action === 'set' || action === 'stop');
    let reason;
    if (!connected)        reason = 'auto niet verbonden';
    else if (!changed)     reason = `idle-skip (Δ${deltaA}A < ${HYSTERESIS_A}A)`;
    else if (!cooldownOk)  reason = `cooldown (${Math.round((COOLDOWN_MS - (now - this._lastWouldSendTs)) / 1000)}s)`;
    else                   reason = action === 'stop' ? 'zou STOPPEN' : `zou zetten @ ${desiredA}A`;

    if (wouldSend) { this._lastWouldSendTs = now; this._lastDesiredA = desiredA; }

    // Onbenut-overschot-teller (alleen wanneer er overschot is dat in de auto had gekund
    // maar de auto laadt niet op dat niveau). Per dag.
    const day = new Date().toISOString().substring(0, 10);
    if (this._potentialDay !== day) { this._potentialDay = day; this._potentialWhToday = 0; }
    const unusedW = connected ? Math.max(0, desiredW - teslaW) : 0;
    this._potentialWhToday += unusedW * (PERIOD_MS / 1000) / 3600;   // Wh

    const rec = {
      ts: new Date().toISOString(),
      connected, ev_state, charge_state,
      inputs:      { pv_w, grid_w, tesla_charge_w: Math.round(teslaW), tesla_charge_a: charge_a, phases, soc, charge_limit },
      expectation: { desired_a: desiredA, desired_w: Math.round(desiredW), action, would_send: wouldSend, reason },
      reality:     { actual_a: charge_a, actual_charge_w: Math.round(teslaW), grid_w },
      unused_surplus_wh_today: Math.round(this._potentialWhToday),
    };
    this._ring.push(rec);
    if (this._ring.length > RING_MAX) this._ring.shift();
    this._appendJsonl(rec);

    this.app.log(
      `[ChargeDryRun] verwacht: ${action === 'set' ? `laden @ ${desiredA}A (${Math.round(desiredW)}W)` : action}` +
      `${wouldSend ? ' [ZOU STUREN]' : ` [${reason}]`}` +
      ` | werkelijk: auto ${charge_a ?? '?'}A ${Math.round(teslaW)}W, grid ${grid_w ?? '?'}W` +
      ` | onbenut vandaag ~${(this._potentialWhToday / 1000).toFixed(2)}kWh`
    );
  }

  _appendJsonl(rec) {
    try {
      const day  = rec.ts.substring(0, 10).replace(/-/g, '');
      fs.appendFileSync(path.join(USERDATA_DIR, `chargedryrun-${day}.jsonl`), JSON.stringify(rec) + '\n');
    } catch (err) { this.app.error('[ChargeDryRun] schrijffout:', err.message); }
  }

}

module.exports = ChargeDryRun;
