'use strict';

/**
 * TeslaScheduler (fork-module 2/3 — prijs-gestuurde Tesla-laadregie)
 * ──────────────────────────────────────────────────────────────────
 * Pre-saldering (tot 1-1-2027) geldt: export ≈ import (1:1 verrekend), dus
 * zelfverbruik-optimalisatie heeft geen waarde. De ENIGE kostenknop is: wannéér
 * je je netto-import koopt. De Tesla is de grote flexibele last → schuif het
 * laden naar de GOEDKOOPSTE uren in de prijs-horizon, tot een doel-SoC op een
 * deadline gehaald is.
 *
 * Beslissing per cyclus (zie ARCHITECTURE §6.5, vereenvoudigd voor pre-saldering):
 *   kwh_nodig   = max(0,(target%−soc%)/100 × capaciteit) / efficiency
 *   uren_nodig  = kwh_nodig / laadvermogen_kW          (laden op vol vermogen)
 *   horizon     = prijs-slots [nu … deadline] (PricePredictor, 15-min, all-in)
 *   selecteer   = goedkoopste slots tot Σ ≥ kwh_nodig
 *   laad_nu?    = (huidig slot ∈ selectie)
 *                 OR soc ≤ FLOOR (PANIC, prijs negeren)
 *                 OR (deadline voorbij && soc < target)  ← SoC-garantie > tijd
 *
 * Sturing loopt via TeslaEvAdapter (com.ems.homey bestaand): setChargeCurrent /
 * stopCharging / setChargeLimit — die heeft eigen rate-limit + command-queue.
 * Vangrails: 20%-vloer, laad op vol vermogen (geen amp-modulatie), idle-skip,
 * dag-command-teller, dryrun-schakelaar.
 *
 * Modus: settings 'tesla_scheduler_mode' = 'live' | 'dryrun' (default live).
 * Opslag: JSONL /userdata/teslasched-YYYYMMDD.jsonl + ringbuffer (getStatus).
 */

const fs   = require('fs');
const path = require('path');

const USERDATA_DIR = '/userdata';
const RING_MAX     = 4000;
const PERIOD_MS    = 60 * 1000;        // 60s beslis-cyclus
const SLOT_MIN     = 15;               // PricePredictor-resolutie
const SLOT_H       = SLOT_MIN / 60;
const VOLTAGE      = 230;
const EFFICIENCY   = 0.91;             // on-board charger @ vol vermogen (~16A)

class TeslaScheduler {

  constructor(app) {
    this.app   = app;
    this.homey = app.homey;
    this._ring = [];
    this._timer = null;
    this._cmdDay = null;
    this._cmdCount = 0;
    this._last = null;             // laatste beslissing (voor getStatus/projectie)
    this._lastChargingCmd = null;  // true=liet laden, false=liet stoppen (idle-skip)
  }

  async init() {
    try { fs.mkdirSync(USERDATA_DIR, { recursive: true }); } catch (_) {}
    this._tickSafe();
    this._timer = this.homey.setInterval(() => this._tickSafe(), PERIOD_MS);
    this.app.log(`[TeslaSched] actief — prijs-gestuurd, ${this._mode()} | cyclus ${PERIOD_MS / 1000}s`);
  }

  destroy() { if (this._timer) this.homey.clearInterval(this._timer); }

  getRecent(limit = 200) { return this._ring.slice(-limit); }

  /** Compacte status + projectie voor de override-widget. */
  getStatus() { return this._last; }

  // ─── parameters ──────────────────────────────────────────────────────────

  _mode() { return this.homey.settings.get('tesla_scheduler_mode') || 'live'; }
  _isLive() { return this._mode() === 'live'; }

  _params() {
    const cfg    = this.app.ems?.config?.ev || {};
    const maxA   = this.homey.settings.get('ev_max_current_a') ?? cfg.maxAmps ?? 16;
    const phases = this.homey.settings.get('ev_phases') ?? cfg.phases ?? 3;
    const cap    = this.homey.settings.get('ev_capacity_kwh') ?? cfg.capacityKwh ?? 75;
    const floor  = 20;  // EmsApp.FLOOR_PCT — PANIC-vloer
    const powerKw = (maxA * phases * VOLTAGE) / 1000;
    return { maxA, phases, cap, floor, powerKw };
  }

  /** Device-id van de Tesla-batterij (waar de laad-flow-acties op zitten). */
  _teslaBatId() {
    const d = this.homey.settings.get('decisionlog_devices') || {};
    return d.teslaBat || 'd2ffa0cf-3b76-4185-9185-aee51364ce27';
  }

  async _tickSafe() {
    try { await this._tick(); }
    catch (err) { this.app.error('[TeslaSched] fout:', err.message); }
  }

  async _tick() {
    const tesla = this.app.ems?.tesla;
    if (!tesla) return;

    const { maxA, phases, cap, floor, powerKw } = this._params();

    // 1. Auto-toestand
    const st = await tesla.getState();
    const connected = st?.connected ?? false;
    const soc       = st?.soc ?? null;

    // 2. Override of default-doel
    const ov = await this.app.getTeslaOverride();
    const targetPct  = ov.target_pct;
    const deadline   = new Date(ov.deadline_iso);

    // 3. Horizon [nu … deadline]
    const horizon = (this.app.pricePredictor?.getHorizon() || [])
      .map(h => ({ ...h, t: new Date(h.ts).getTime() }));
    const now = Date.now();
    const dlMs = deadline.getTime();

    let decision = 'idle';
    let reason = '';
    let chargeNow = false;
    let kwhNeeded = 0;
    let readyByIso = null;
    let selectedCount = 0;
    let currentPrice = null;

    if (!connected) {
      decision = 'skip_disconnected';
      reason = 'auto niet verbonden';
    } else if (soc == null) {
      decision = 'skip_no_soc';
      reason = 'SoC onbekend';
    } else if (soc >= targetPct) {
      decision = 'at_target';
      reason = `SoC ${soc}% ≥ doel ${targetPct}%`;
    } else {
      // kWh nodig + uren nodig
      kwhNeeded = Math.max(0, (targetPct - soc) / 100 * cap) / EFFICIENCY;
      const slotKwh = powerKw * SLOT_H;

      // PANIC: onder de vloer → laden, prijs negeren
      if (soc <= floor) {
        chargeNow = true;
        decision = 'panic_charge';
        reason = `SoC ${soc}% ≤ vloer ${floor}% — laden ongeacht prijs`;
      } else if (now > dlMs) {
        // Deadline voorbij maar doel niet gehaald → doorladen (SoC-garantie > tijd)
        chargeNow = true;
        decision = 'past_deadline';
        reason = `deadline voorbij, SoC ${soc}% < doel ${targetPct}% — doorladen`;
      } else {
        // Selecteer goedkoopste slots tot deadline tot kWh gedekt
        const slots = horizon
          .filter(h => h.t >= now - SLOT_MIN * 60_000 && h.t <= dlMs)
          .sort((a, b) => a.import_eur - b.import_eur);

        if (slots.length === 0) {
          // Geen prijsdata in venster → niet selectief kunnen zijn → laden
          chargeNow = true;
          decision = 'no_prices';
          reason = 'geen prijs-horizon in venster — laden';
        } else {
          let acc = 0;
          const selected = new Set();
          for (const s of slots) {
            if (acc >= kwhNeeded) break;
            selected.add(s.t);
            acc += slotKwh;
            selectedCount++;
          }
          // Projectie: laatste (chronologisch) geselecteerde slot + 15min = klaar-tijd
          const selTimes = [...selected].sort((a, b) => a - b);
          if (selTimes.length) readyByIso = new Date(selTimes[selTimes.length - 1] + SLOT_MIN * 60_000).toISOString();

          // Huidig slot bepalen
          const cur = horizon.find(h => now >= h.t && now < h.t + SLOT_MIN * 60_000);
          currentPrice = cur ? cur.import_eur : null;
          chargeNow = cur ? selected.has(cur.t) : true;  // geen huidig slot → veilig laden
          decision = chargeNow ? 'charge_cheap_slot' : 'wait_cheaper';
          reason = chargeNow
            ? `goedkoop slot (€${currentPrice?.toFixed(3) ?? '?'}) — ${selectedCount} slots gekozen voor ${kwhNeeded.toFixed(1)}kWh`
            : `nu €${currentPrice?.toFixed(3) ?? '?'} — wacht op goedkopere uren (klaar ~${readyByIso ? this.app.localTime(new Date(readyByIso)) : '?'})`;
        }
      }
    }

    // 4. Sturing (live) of alleen loggen (dryrun) — idle-skip op ongewijzigde wens
    const live = this._isLive();
    let commanded = null;
    if (connected && soc != null && soc < targetPct) {
      const wantCharge = chargeNow;
      if (this._lastChargingCmd !== wantCharge) {
        commanded = wantCharge ? 'start' : 'stop';
        if (live) await this._drive(tesla, wantCharge, maxA, targetPct);
        this._lastChargingCmd = wantCharge;
        this._bumpCmd();
      } else {
        // ongewijzigd → niets sturen (idle-skip), TeslaEvAdapter heeft eigen cooldown
      }
    } else {
      this._lastChargingCmd = null;  // reset bij niet-verbonden / op doel
    }

    // 5. Record
    const rec = {
      ts: new Date().toISOString(),
      ts_local: this.app.localTime(),
      mode: live ? 'live' : 'dryrun',
      connected, soc, target_pct: targetPct,
      deadline_local: this.app.localTime(deadline),
      override_active: ov.active,
      decision, reason, charge_now: chargeNow,
      kwh_needed: +kwhNeeded.toFixed(2),
      power_kw: +powerKw.toFixed(2),
      selected_slots: selectedCount,
      current_price_eur: currentPrice,
      ready_by_local: readyByIso ? this.app.localTime(new Date(readyByIso)) : null,
      commanded, cmd_count_today: this._cmdCount,
    };
    this._last = {
      decision, reason, charge_now: chargeNow,
      kwh_needed: rec.kwh_needed, ready_by_iso: readyByIso,
      ready_by_local: rec.ready_by_local, mode: rec.mode,
      current_price_eur: currentPrice,
    };
    this._ring.push(rec);
    if (this._ring.length > RING_MAX) this._ring.shift();
    this._appendJsonl(rec);

    this.app.log(
      `[TeslaSched] ${decision}${commanded ? ` → ${live ? 'LIVE' : 'DRYRUN'} ${commanded}@${maxA}A` : ''}` +
      ` | SoC ${soc ?? '?'}%→${targetPct}% | ${reason}`
    );
  }

  // Stuurt de Tesla RECHTSTREEKS via de device-flow-acties van de Tesla-app
  // (geen door de gebruiker gekoppelde flow nodig). charge_limit 50–100,
  // charge_current 0–32A, charging_on {start,stop}.
  async _drive(_tesla, wantCharge, maxA, targetPct) {
    const dev = this._teslaBatId();
    try {
      if (wantCharge) {
        // Laadlimiet alleen (her)zetten als die wijzigt — bespaart commando's.
        const limit = Math.max(50, Math.min(100, Math.round(targetPct)));
        if (this._lastLimit !== limit) {
          await this.app.runDeviceAction(dev, 'charge_limit', { limit });
          this._lastLimit = limit;
        }
        const amps = Math.max(1, Math.min(32, Math.round(maxA)));
        if (this._lastAmps !== amps) {
          await this.app.runDeviceAction(dev, 'charge_current', { current: amps });
          this._lastAmps = amps;
        }
        await this.app.runDeviceAction(dev, 'charging_on', { action: 'start' });
      } else {
        await this.app.runDeviceAction(dev, 'charging_on', { action: 'stop' });
      }
    } catch (err) {
      this.app.error('[TeslaSched] sturing-fout:', err.message);
    }
  }

  _bumpCmd() {
    const day = new Date().toISOString().substring(0, 10);
    if (this._cmdDay !== day) { this._cmdDay = day; this._cmdCount = 0; }
    this._cmdCount++;
  }

  _appendJsonl(rec) {
    try {
      const day = rec.ts.substring(0, 10).replace(/-/g, '');
      fs.appendFileSync(path.join(USERDATA_DIR, `teslasched-${day}.jsonl`), JSON.stringify(rec) + '\n');
    } catch (err) { this.app.error('[TeslaSched] schrijffout:', err.message); }
  }

}

module.exports = TeslaScheduler;
