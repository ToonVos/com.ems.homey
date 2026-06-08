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
const VERIFY_MS    = 3 * 60 * 1000;    // 3 min na commando: laadt/stopt hij echt?
const MAX_WAKE_RETRIES = 2;            // max keer wakker maken + opnieuw sturen

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
    const floor  = this.homey.settings.get('ev_floor_soc') ?? 20;  // PANIC-vloer (instelbaar)
    const powerKw = (maxA * phases * VOLTAGE) / 1000;
    return { maxA, phases, cap, floor, powerKw };
  }

  /** Device-id van de Tesla-batterij (waar de laad-flow-acties op zitten). */
  _teslaBatId() {
    const d = this.homey.settings.get('decisionlog_devices') || {};
    return d.teslaBat || 'd2ffa0cf-3b76-4185-9185-aee51364ce27';
  }

  /** Device-id van de Tesla-auto (waar car_wake_up op zit). */
  _teslaCarId() {
    const d = this.homey.settings.get('decisionlog_devices') || {};
    return d.tesla || '37cdaf85-28d4-41ca-95fb-7591764aa597';
  }

  /** Leest RECHTSTREEKS of de auto laadt (vers, omzeilt adapter-cache). null=onbekend. */
  async _readActualCharging() {
    try {
      const dev = await this.app.getDevice(this._teslaBatId());
      const c = dev?.capabilitiesObj || {};
      const power = c.measure_charge_power?.value;
      if (power != null) return power > 0.1;                 // kW
      const stateC = c.charging_state?.value;
      if (stateC != null) return String(stateC).toLowerCase() === 'charging';
      return null;
    } catch (_) { return null; }
  }

  /** Maakt de auto wakker en stuurt het gewenste commando opnieuw. */
  async _wakeAndRetry(want, maxA, targetPct) {
    try {
      await this.app.runDeviceAction(this._teslaCarId(), 'car_wake_up', { wait: 'wait' });
    } catch (e) { this.app.error('[TeslaSched] wake-fout:', e.message); }
    this._lastAmps = null; this._lastLimit = null;          // forceer her-sturing
    await this._drive(null, want, maxA, targetPct);
  }

  async _tickSafe() {
    try { await this._tick(); }
    catch (err) { this.app.error('[TeslaSched] fout:', err.message); }
  }

  async _tick() {
    const tesla = this.app.ems?.tesla;
    if (!tesla) return;

    // Alleen actief in laadmodus 'price' — anders beheert Menno's EvController
    // (zon/vast/uit) de auto en doen wij niets (geen dubbele sturing).
    const chargeMode = this.homey.settings.get('ev_charge_mode') || 'solar_only';
    const contract   = this.homey.settings.get('contract_type') || 'fixed';
    // Prijs-scheduler vereist laadmodus 'price' ÉN een dynamisch contract
    // (bij vast tarief bestaat 'goedkoopste uur' niet).
    if (chargeMode !== 'price' || contract !== 'dynamic') {
      this._lastChargingCmd = null;
      this._pending = null;
      const why = chargeMode !== 'price'
        ? `laadmodus '${chargeMode}'`
        : 'vast tarief (geen uurprijzen)';
      this._last = {
        decision: 'inactive', mode: this._mode(), charge_now: false,
        reason: `${why} — prijs-scheduler inactief`,
      };
      return;
    }

    const { maxA, phases, cap, floor, powerKw } = this._params();

    // 1. Auto-toestand
    const st = await tesla.getState();
    const connected = st?.connected ?? false;
    const soc       = st?.soc ?? null;

    // Laadsnelheid-observer: meet echte %/uur tijdens laden en gebruik dat voor
    // "hoeveel uren nodig"; val terug op berekende powerKw tot er data is.
    this._observeRate(st, cap);
    const effRate = this._effectiveRateKw(powerKw);   // kW
    const slotKwh = effRate * SLOT_H;

    // 2. Override of standaard-doel + opportunistisch plafond
    const ov = await this.app.getTeslaOverride();
    const mandatory  = ov.target_pct;                 // override-doel of standaard-doel
    const deadline   = new Date(ov.deadline_iso);
    const oppCeiling = this.homey.settings.get('ev_opportunistic_soc') ?? 85;
    // Bij actieve override geen opportunistisch extra: plafond = het gekozen doel.
    const ceiling = ov.active ? mandatory : Math.max(mandatory, oppCeiling);

    // 3. Horizon
    const horizon = (this.app.pricePredictor?.getHorizon() || [])
      .map(h => ({ ...h, t: new Date(h.ts).getTime() }))
      .sort((a, b) => a.t - b.t);
    const now  = Date.now();
    const dlMs = deadline.getTime();
    const cur  = horizon.find(h => now >= h.t && now < h.t + SLOT_MIN * 60_000);
    const currentPrice = cur ? cur.import_eur : null;

    let decision = 'idle';
    let reason = '';
    let chargeNow = false;
    let kwhNeeded = 0;
    let readyByIso = null;     // klaar-tijd standaard-doel
    let ceilReadyIso = null;   // klaar-tijd plafond
    let selectedCount = 0;
    let tier = null;

    if (!connected) {
      decision = 'skip_disconnected';
      reason = 'auto niet verbonden';
    } else if (soc == null) {
      decision = 'skip_no_soc';
      reason = 'SoC onbekend';
    } else if (soc >= ceiling) {
      decision = 'at_target';
      reason = `SoC ${soc}% ≥ plafond ${ceiling}%`;
    } else if (soc <= floor) {
      chargeNow = true;
      decision = 'panic_charge';
      reason = `SoC ${soc}% ≤ vloer ${floor}% — laden ongeacht prijs`;
    } else {
      // Laag 1 (verplicht): goedkoopste slots in [nu, deadline] tot standaard-doel.
      const need1 = soc < mandatory ? Math.max(0, (mandatory - soc) / 100 * cap) / EFFICIENCY : 0;
      const within = horizon.filter(h => h.t >= now - SLOT_MIN * 60_000 && h.t <= dlMs);
      const sel1 = this._pickCheapest(within, need1, slotKwh, null);

      // Laag 2 (opportunistisch): goedkoopste slots in de HELE horizon (excl. laag 1)
      // om van doel → plafond te gaan; geen deadline → alleen écht goedkope uren.
      const fromOpp = Math.max(soc, mandatory);
      const need2 = soc < ceiling ? Math.max(0, (ceiling - fromOpp) / 100 * cap) / EFFICIENCY : 0;
      const fullWin = horizon.filter(h => h.t >= now - SLOT_MIN * 60_000);
      const sel2 = this._pickCheapest(fullWin, need2, slotKwh, sel1.set);

      kwhNeeded = need1 + need2;
      selectedCount = sel1.count + sel2.count;
      if (sel1.lastTs) readyByIso = new Date(sel1.lastTs + SLOT_MIN * 60_000).toISOString();
      const unionLast = Math.max(sel1.lastTs || 0, sel2.lastTs || 0);
      if (unionLast) ceilReadyIso = new Date(unionLast + SLOT_MIN * 60_000).toISOString();

      if (now > dlMs && soc < mandatory) {
        // SoC-garantie: deadline voorbij, standaard-doel niet gehaald → doorladen.
        chargeNow = true;
        decision = 'past_deadline';
        reason = `deadline voorbij, SoC ${soc}% < doel ${mandatory}% — doorladen`;
      } else if (!cur) {
        chargeNow = true;
        decision = 'no_prices';
        reason = 'geen prijs-horizon — laden';
      } else {
        const inMand = sel1.set.has(cur.t);
        const inOpp  = sel2.set.has(cur.t);
        chargeNow = inMand || inOpp;
        tier = inMand ? 'verplicht' : (inOpp ? 'opportunistisch' : null);
        decision = chargeNow ? (inMand ? 'charge_mandatory' : 'charge_opportunistic') : 'wait_cheaper';
        reason = chargeNow
          ? `${tier} laden (€${currentPrice?.toFixed(3) ?? '?'}) — ${selectedCount} slots voor ${kwhNeeded.toFixed(1)}kWh @ ${effRate.toFixed(1)}kW`
          : `nu €${currentPrice?.toFixed(3) ?? '?'} — wacht (doel ${mandatory}% ~${readyByIso ? this.app.localTime(new Date(readyByIso)) : '?'}, plafond ${ceiling}% ~${ceilReadyIso ? this.app.localTime(new Date(ceilReadyIso)) : '?'})`;
      }
    }

    // 4. Sturing (live) of alleen loggen (dryrun) — idle-skip op ongewijzigde wens
    const live = this._isLive();
    let commanded = null;
    if (connected && soc != null && soc < ceiling) {
      const wantCharge = chargeNow;
      if (this._lastChargingCmd !== wantCharge) {
        commanded = wantCharge ? 'start' : 'stop';
        if (live) {
          // Laadlimiet = plafond zodat de auto tot het plafond kan; de scheduler
          // stopt zelf eerder zodra het doel is gehaald of de uren op zijn.
          await this._drive(tesla, wantCharge, maxA, ceiling);
          this._pending = { want: wantCharge, at: Date.now(), retries: 0 };  // verifieer over 3 min
        }
        this._lastChargingCmd = wantCharge;
        this._bumpCmd();
      } else {
        // ongewijzigd → niets sturen (idle-skip)
      }
    } else {
      this._lastChargingCmd = null;  // reset bij niet-verbonden / op doel
      this._pending = null;
    }

    // 4b. Verificatie-lus: 3 min na een commando checken of de auto echt
    // laadt/gestopt is; zo niet → wakker maken + opnieuw sturen (max 2×).
    let verify = null;
    if (live && this._pending && connected && (Date.now() - this._pending.at) >= VERIFY_MS) {
      const actual = await this._readActualCharging();
      if (actual === null) {
        verify = 'onbekend';                                  // geen meting → volgende cyclus opnieuw
        this._pending.at = Date.now();
      } else if (actual === this._pending.want) {
        verify = 'ok';
        this.app.log(`[TeslaSched] geverifieerd: auto ${actual ? 'laadt' : 'laadt niet'} zoals gewenst`);
        this._pending = null;
      } else if (this._pending.retries < MAX_WAKE_RETRIES) {
        this._pending.retries++;
        verify = `mismatch→wake#${this._pending.retries}`;
        this.app.log(`[TeslaSched] mismatch (wil ${this._pending.want ? 'laden' : 'stoppen'}, auto ${actual ? 'laadt' : 'laadt niet'}) — wakker maken + opnieuw (#${this._pending.retries})`);
        await this._wakeAndRetry(this._pending.want, maxA, ceiling);
        this._pending.at = Date.now();
        this._bumpCmd();
      } else {
        verify = 'opgegeven';
        this.app.error(`[TeslaSched] commando bleef mislukken na ${MAX_WAKE_RETRIES} wake-pogingen — handmatig controleren`);
        this.app.notifications?.send('⚠️ Tesla reageert niet op laad-commando — controleer de auto');
        this._pending = null;
      }
    }

    // 5. Record
    const rec = {
      ts: new Date().toISOString(),
      ts_local: this.app.localTime(),
      mode: live ? 'live' : 'dryrun',
      connected, soc, target_pct: mandatory, ceiling_pct: ceiling, tier,
      deadline_local: this.app.localTime(deadline),
      override_active: ov.active,
      decision, reason, charge_now: chargeNow,
      kwh_needed: +kwhNeeded.toFixed(2),
      power_kw: +powerKw.toFixed(2),
      eff_rate_kw: +effRate.toFixed(2),
      selected_slots: selectedCount,
      current_price_eur: currentPrice,
      ready_by_local: readyByIso ? this.app.localTime(new Date(readyByIso)) : null,
      ceil_ready_local: ceilReadyIso ? this.app.localTime(new Date(ceilReadyIso)) : null,
      commanded, verify, cmd_count_today: this._cmdCount,
    };
    this._last = {
      decision, reason, charge_now: chargeNow, tier,
      target_pct: mandatory, ceiling_pct: ceiling,
      kwh_needed: rec.kwh_needed, ready_by_iso: readyByIso,
      ready_by_local: rec.ready_by_local, mode: rec.mode,
      current_price_eur: currentPrice,
    };
    this._ring.push(rec);
    if (this._ring.length > RING_MAX) this._ring.shift();
    this._appendJsonl(rec);

    this.app.log(
      `[TeslaSched] ${decision}${commanded ? ` → ${live ? 'LIVE' : 'DRYRUN'} ${commanded}@${maxA}A` : ''}` +
      `${verify ? ` [verify:${verify}]` : ''}` +
      ` | SoC ${soc ?? '?'}%→${mandatory}%(plafond ${ceiling}%) | ${reason}`
    );
  }

  /** Goedkoopste slots tot kwhNeeded gedekt is (excl. excludeSet). */
  _pickCheapest(slots, kwhNeeded, slotKwh, excludeSet) {
    const set = new Set();
    let count = 0, acc = 0, lastTs = null;
    if (kwhNeeded <= 0 || slotKwh <= 0) return { set, count, lastTs };
    const sorted = slots
      .filter(s => !excludeSet || !excludeSet.has(s.t))
      .sort((a, b) => a.import_eur - b.import_eur);
    for (const s of sorted) {
      if (acc >= kwhNeeded) break;
      set.add(s.t); acc += slotKwh; count++;
    }
    if (set.size) lastTs = Math.max(...set);   // laatste (chronologisch) gekozen slot
    return { set, count, lastTs };
  }

  /** Observeert echte laadsnelheid (%/uur → kWh/uur) als EWMA in settings. */
  _observeRate(st, cap) {
    const charging = st?.charging ?? false;
    const soc = st?.soc ?? null;
    const now = Date.now();
    if (!charging || soc == null) { this._rateSample = null; return; }
    if (!this._rateSample) { this._rateSample = { ts: now, soc }; return; }
    const dtH  = (now - this._rateSample.ts) / 3_600_000;
    const dSoc = soc - this._rateSample.soc;
    if (dtH >= 0.083 && dSoc > 0) {                 // ≥5 min en SoC gestegen
      const kwhPerH = (dSoc / 100 * cap) / dtH;
      if (kwhPerH > 1 && kwhPerH < 50) {
        const prev = this.homey.settings.get('tesla_observed_kwh_per_h');
        const ewma = prev ? prev * 0.7 + kwhPerH * 0.3 : kwhPerH;
        this.homey.settings.set('tesla_observed_kwh_per_h', +ewma.toFixed(2));
      }
      this._rateSample = { ts: now, soc };
    } else if (dSoc < 0) {
      this._rateSample = { ts: now, soc };          // reset bij daling
    }
  }

  /** Effectieve laadsnelheid (kW): gemeten EWMA indien plausibel, anders berekend. */
  _effectiveRateKw(powerKw) {
    const obs = this.homey.settings.get('tesla_observed_kwh_per_h');
    return (obs && obs > 1 && obs < 50) ? obs : powerKw;
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
